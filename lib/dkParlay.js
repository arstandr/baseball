// lib/dkParlay.js — DraftKings parlay intelligence
//
// Builds pre-game Model Lock parlays from ks_bets + live DK odds (fetched fresh).
// Does NOT place bets — outputs parlay objects for Discord notification.
//
// Two parlay types:
//   1. buildPreGameParlay  — top 2 highest-confidence YES legs (≥72%, strike ≤6)
//   2. buildCertaintyParlay — 2+ live crossed-YES situations (threshold already hit)

import { fetchKProps, lookupKProp } from './odds.js'

const MIN_MODEL_PROB = 0.72   // minimum leg confidence to qualify
const MAX_STRIKE     = 6      // Rule G: no YES 7+ or 8+ legs (model miscalibrated)

// implied probability (0–1) → American odds string ("-110", "+130")
export function toAmerican(p) {
  if (!p || p <= 0 || p >= 1) return null
  const n = p >= 0.5
    ? Math.round(-p / (1 - p) * 100)
    : Math.round((1 - p) / p * 100)
  return n >= 0 ? `+${n}` : String(n)
}

// American odds string → decimal multiplier (for parlay math)
function toDecimal(american) {
  const n = Number(String(american).replace('+', ''))
  if (isNaN(n) || n === 0) return null
  return n > 0 ? n / 100 + 1 : 100 / Math.abs(n) + 1
}

// Combine two decimal multipliers → parlay American odds string
function combinedAmericanOdds(dec1, dec2) {
  if (!dec1 || !dec2) return null
  const c = dec1 * dec2
  const n = c >= 2 ? Math.round((c - 1) * 100) : Math.round(-(100 / (c - 1)))
  return n >= 0 ? `+${n}` : String(n)
}


/**
 * Build a pre-game Model Lock 2-leg parlay from today's filled/pending bets.
 * Returns null when fewer than 2 qualifying legs exist.
 */
export async function buildPreGameParlay(db, date) {
  const bets = await db.all(`
    SELECT DISTINCT pitcher_name, pitcher_id, strike, side, model_prob, game
    FROM ks_bets
    WHERE bet_date = ?
      AND side = 'YES'
      AND result IS NULL
      AND live_bet = 0
      AND model_prob >= ?
      AND strike <= ?
      AND paper = 0
    ORDER BY model_prob DESC
  `, [date, MIN_MODEL_PROB, MAX_STRIKE])

  if (bets.length < 2) return null

  // One leg per pitcher (highest confidence wins)
  const seen = new Set()
  const unique = []
  for (const b of bets) {
    if (!seen.has(b.pitcher_name)) { seen.add(b.pitcher_name); unique.push(b) }
  }
  if (unique.length < 2) return null

  // Fetch live DK K-prop odds right now (fresh at alert time)
  const kPropsResult = await fetchKProps().catch(() => ({ ok: false }))
  const liveProps    = kPropsResult.ok ? kPropsResult.props : new Map()

  // Fall back to cached dk_k_props if live fetch fails
  let dkMap = liveProps
  if (!liveProps.size) {
    const dkRows = await db.all(
      `SELECT pitcher_name, dk_line, over_price, book FROM dk_k_props WHERE prop_date = ?`,
      [date],
    )
    dkMap = new Map(dkRows.map(r => [r.pitcher_name.toLowerCase(), { line: r.dk_line, overPrice: r.over_price, book: r.book }]))
  }

  // Prefer legs that have DK data; within that, sort by model_prob desc
  const candidates = [...unique].sort((a, b) => {
    const aDk = lookupKProp(dkMap, a.pitcher_name) ? 1 : 0
    const bDk = lookupKProp(dkMap, b.pitcher_name) ? 1 : 0
    if (bDk !== aDk) return bDk - aDk
    return b.model_prob - a.model_prob
  })

  const legs = []
  for (const b of candidates) {
    if (legs.length >= 2) break
    const dk = lookupKProp(dkMap, b.pitcher_name)
    // DK OVER (strike-0.5) is equivalent to our YES strike+ threshold
    const dkLine    = dk?.line ?? null
    const lineMatch = dkLine !== null && Math.abs(dkLine - (b.strike - 0.5)) <= 0.5
    const dkOdds    = dk?.overPrice ? toAmerican(dk.overPrice) : null
    const dkDec     = dkOdds ? toDecimal(dkOdds) : null
    legs.push({
      pitcherName: b.pitcher_name,
      strike:      b.strike,
      modelProb:   b.model_prob,
      game:        b.game ?? null,
      dkLine:      lineMatch ? dkLine : null,
      dkOdds,
      dkDec,
      book:        dk?.book ?? null,
    })
  }

  if (legs.length < 2) return null

  const combinedProb = legs.reduce((p, l) => p * l.modelProb, 1)
  const parlayOdds   = legs[0].dkDec && legs[1].dkDec
    ? combinedAmericanOdds(legs[0].dkDec, legs[1].dkDec)
    : null

  return { type: 'model-lock', date, legs, combinedProb, parlayOdds }
}

/**
 * Build a live certainty parlay from accumulated crossed-YES events.
 * `legs` is array of { pitcherName, strike, currentKs, game }
 * Returns null if fewer than 2 legs.
 */
export function buildCertaintyParlay(legs) {
  if (!legs || legs.length < 2) return null
  return {
    type:         'certainty',
    legs:         legs.slice(0, 2),
    combinedProb: 0.97 * 0.97,   // each leg ~97% certain (threshold already crossed)
  }
}

/**
 * Stable key for a set of legs — used to prevent duplicate notifications.
 * e.g. "Cole-6|Skenes-7"
 */
export function parlayKey(legs) {
  return legs.map(l => `${l.pitcherName}-${l.strike}`).sort().join('|')
}
