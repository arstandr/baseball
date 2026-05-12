// Continuous IDEAL-fade shadow registry. For each pitcher-day where we have
// market data in `market_snapshots`, capture the COMPLETE candidate space
// across MULTIPLE model variants (Poisson + NB r=8/10/12, l5/l10/career
// windows) and record:
//   - market closing snapshot (latest pre-game per strike)
//   - pitcher K9 features over l3/l5/l7/l10/season/career windows
//   - per-strike model_prob + edge under each variant
//   - would-fire flag + reason under the IDEAL filter
//     (edge ≥5¢, ask ≤50¢, strike ≥6, YES-only, per-pitcher cap = best edge)
//   - actual outcome from `pitcher_recent_starts`
//   - cross-link to ks_bets (fired_actual=1 if a real bet exists)
//
// In 30 days this lets us answer "what would model X have fired and won/lost"
// as a single SQL query — no API hits required.
//
// Usage:
//   node scripts/logFadeShadow.mjs                # backfill all dates from 2026-04-28
//   node scripts/logFadeShadow.mjs 2026-05-05     # specific date

import 'dotenv/config'
import { createClient } from '@libsql/client'
import { getParkFactor } from '../lib/parkFactors.js'

const ARG_DATE   = process.argv[2]
const FROM_DATE  = '2026-04-28'

// ── IDEAL filter constants (mirror fireFadeModel.mjs) ───────────────────────
const MIN_EDGE      = 0.05
const MAX_ASK       = 50
const MIN_ASK       = 3
const MIN_STRIKE    = 6
const IDEAL_VARIANT = 'nb8_l5'   // primary: NB r=8 fit on K9_l5

// ── P&L sizing (default $50 stake, 7% Kalshi fee) ───────────────────────────
const DEFAULT_STAKE_USD = 50
const FEE               = 0.07

const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })

// ── Date / ticker helpers ───────────────────────────────────────────────────
const MONTHS = { JAN:'01', FEB:'02', MAR:'03', APR:'04', MAY:'05', JUN:'06', JUL:'07', AUG:'08', SEP:'09', OCT:'10', NOV:'11', DEC:'12' }
function parseGameStartIso(ticker) {
  const m = /^KXMLBKS-(\d{2})([A-Z]{3})(\d{2})(\d{2})(\d{2})/.exec(ticker || '')
  if (!m) return null
  return `20${m[1]}-${MONTHS[m[2]]}-${m[3]}T${m[4]}:${m[5]}:00.000Z`
}
// Parse "BOS@DET" → { away:'BOS', home:'DET' }
function parseGameLabel(label) {
  const m = /^([A-Z]{2,3})@([A-Z]{2,3})$/.exec(label || '')
  if (!m) return { away: null, home: null }
  return { away: m[1], home: m[2] }
}
// Parse pitcher team abbr from middle ticker segment, e.g. "DETFVALDEZ59" → "DET"
function parsePitcherTeam(ticker) {
  const parts = (ticker || '').split('-')
  if (parts.length < 3) return null
  const m = /^([A-Z]{2,3})/.exec(parts[2])
  return m ? m[1] : null
}

// ── Probability math ────────────────────────────────────────────────────────
function poissonGEqN(lambda, n) {
  if (n <= 0) return 1
  let cum = Math.exp(-lambda), term = cum
  for (let k = 1; k < n; k++) { term = term * lambda / k; cum += term }
  return Math.max(0, Math.min(1, 1 - cum))
}
function nbGEqN(lambda, r, n) {
  if (n <= 0) return 1
  const p = r / (r + lambda)
  let cum = Math.pow(p, r), term = cum
  for (let k = 1; k < n; k++) { term = term * (k + r - 1) / k * (1 - p); cum += term }
  return Math.max(0, Math.min(1, 1 - cum))
}
function parseIp(s) {
  if (s == null) return 0
  const [w, f] = String(s).split('.')
  return Number(w) + (Number(f || 0) / 3)
}

// ── MLB game log fetch + cache (per process run) ───────────────────────────
const gameLogMem = new Map()
async function fetchGameLog(pitcherId) {
  if (gameLogMem.has(pitcherId)) return gameLogMem.get(pitcherId)
  // Try 2026 then fall back to career-aware (statsAllSplits gives previous seasons)
  const url = `https://statsapi.mlb.com/api/v1/people/${pitcherId}/stats?stats=gameLog&season=2026&group=pitching`
  const res = await fetch(url).then(r => r.ok ? r.json() : null).catch(() => null)
  const splits = res?.stats?.[0]?.splits || []
  const games = splits.map(s => ({
    date: s.date,
    ks: Number(s.stat?.strikeOuts ?? 0),
    ip: parseIp(s.stat?.inningsPitched),
    bf: Number(s.stat?.battersFaced ?? 0),
  })).filter(g => g.date && g.ip > 0)
  gameLogMem.set(pitcherId, games)
  return games
}
async function fetchCareerKpct(pitcherId) {
  // career strikeout-per-9 from statsApi career split
  const url = `https://statsapi.mlb.com/api/v1/people/${pitcherId}/stats?stats=career&group=pitching`
  const res = await fetch(url).then(r => r.ok ? r.json() : null).catch(() => null)
  const stat = res?.stats?.[0]?.splits?.[0]?.stat
  if (!stat) return null
  const ip = parseIp(stat.inningsPitched), ks = Number(stat.strikeOuts ?? 0)
  if (ip <= 0) return null
  return { k9: ks / ip * 9, ip, ks }
}

// ── K9 over rolling windows ─────────────────────────────────────────────────
function k9OverWindow(prior, n) {
  if (!prior.length) return null
  const recent = n ? prior.slice(-n) : prior
  if (!recent.length) return null
  const totalK = recent.reduce((s, g) => s + g.ks, 0)
  const totalIp = recent.reduce((s, g) => s + g.ip, 0)
  if (totalIp <= 0) return null
  return { k9: totalK / totalIp * 9, avgIp: totalIp / recent.length, n: recent.length }
}

// ── Variant config: each variant produces a (lambda, distribution) pair ─────
function buildVariants(features) {
  const v = {}
  const safe = (windowStat, k9Bound = [3, 18]) => {
    if (!windowStat) return null
    if (windowStat.k9 < k9Bound[0] || windowStat.k9 > k9Bound[1]) return null
    return windowStat
  }
  const l5      = safe(features.l5)
  const l10     = safe(features.l10)
  const season  = safe(features.season)
  const career  = safe(features.career)
  if (l5) {
    v.poisson_l5  = { lambda: l5.k9 * l5.avgIp / 9, dist: 'poisson' }
    v.nb8_l5      = { lambda: l5.k9 * l5.avgIp / 9, dist: 'nb', r: 8 }
    v.nb10_l5     = { lambda: l5.k9 * l5.avgIp / 9, dist: 'nb', r: 10 }
    v.nb12_l5     = { lambda: l5.k9 * l5.avgIp / 9, dist: 'nb', r: 12 }
  }
  if (l10) {
    v.nb8_l10     = { lambda: l10.k9 * l10.avgIp / 9, dist: 'nb', r: 8 }
  }
  if (career) {
    // Use l5.avgIp if available so career-K9 maps onto current workload, else 5.5 IP default
    const ip = features.l5?.avgIp ?? 5.5
    v.poisson_career = { lambda: career.k9 * ip / 9, dist: 'poisson' }
  }
  return v
}
function probFromVariant(variant, strike) {
  if (!variant) return null
  if (variant.dist === 'poisson') return poissonGEqN(variant.lambda, strike)
  if (variant.dist === 'nb')      return nbGEqN(variant.lambda, variant.r, strike)
  return null
}

// ── IDEAL filter: returns block reason or null if it fires ─────────────────
function whyBlocked({ side, strike, askCents, edge, prevFires }) {
  if (side !== 'YES')                           return 'side_not_yes'
  if (strike < MIN_STRIKE)                      return 'strike_too_low'
  if (askCents == null)                         return 'no_ask'
  if (askCents < MIN_ASK)                       return 'ask_too_low'
  if (askCents > MAX_ASK)                       return 'ask_too_high'
  if (edge == null || edge < MIN_EDGE)          return 'edge_too_low'
  if (prevFires >= 1)                           return 'per_pitcher_cap'  // ideal = best-edge only
  return null
}

// ─────────────────────────────────────────────────────────────────────────────
// 1) Pull market_snapshots and reduce to latest pre-game snapshot per strike
// ─────────────────────────────────────────────────────────────────────────────
const dateClause = ARG_DATE ? `= '${ARG_DATE}'` : `>= '${FROM_DATE}'`
const snapRows = await db.execute(`
  SELECT pitcher_id, pitcher_name, game_id, game_date, game_label, ticker, strike,
         yes_bid, yes_ask, no_bid, no_ask, volume, open_interest, spread, captured_at
  FROM market_snapshots
  WHERE game_date ${dateClause}
    AND yes_bid IS NOT NULL AND yes_ask IS NOT NULL
    AND (yes_bid + yes_ask) > 2 AND (yes_bid + yes_ask) < 198
    AND ticker IS NOT NULL AND pitcher_id IS NOT NULL AND strike IS NOT NULL
`)
console.log(`Loaded ${snapRows.rows.length} snapshot rows for date filter ${ARG_DATE ?? '>=' + FROM_DATE}`)

// Pick latest pre-game (or closest) snapshot per (pitcher, day, strike)
const closest = new Map()
for (const r of snapRows.rows) {
  const startIso = parseGameStartIso(r.ticker)
  if (!startIso) continue
  const captured = Date.parse(r.captured_at)
  const start = Date.parse(startIso)
  const isBefore = captured <= start
  const dt = Math.abs(captured - start)
  const score = (isBefore ? 0 : 1e15) + dt
  const key = `${r.pitcher_id}|${r.game_date}|${r.strike}`
  const cur = closest.get(key)
  if (!cur || score < cur.score) {
    closest.set(key, {
      pitcher_id: String(r.pitcher_id), pitcher_name: r.pitcher_name,
      game_id: r.game_id, game_date: r.game_date, game_label: r.game_label, ticker: r.ticker,
      strike: Number(r.strike),
      yes_bid: Number(r.yes_bid), yes_ask: Number(r.yes_ask),
      no_bid:  r.no_bid != null ? Number(r.no_bid) : null,
      no_ask:  r.no_ask != null ? Number(r.no_ask) : null,
      spread:  r.spread != null ? Number(r.spread) : null,
      volume:  r.volume != null ? Number(r.volume) : null,
      open_interest: r.open_interest != null ? Number(r.open_interest) : null,
      captured_at: r.captured_at,
      market_mid: (Number(r.yes_bid) + Number(r.yes_ask)) / 2,
      gameStartIso: startIso,
      score,
    })
  }
}
const byPitcherDay = new Map()
for (const v of closest.values()) {
  const k = `${v.pitcher_id}|${v.game_date}`
  if (!byPitcherDay.has(k)) byPitcherDay.set(k, [])
  byPitcherDay.get(k).push(v)
}
console.log(`${byPitcherDay.size} pitcher-day chains`)

// ─────────────────────────────────────────────────────────────────────────────
// 2) Pre-load outcomes from pitcher_recent_starts
// ─────────────────────────────────────────────────────────────────────────────
const outRows = await db.execute(`
  SELECT pitcher_id, game_date, ks, ip, bf
  FROM pitcher_recent_starts WHERE game_date ${dateClause}
`)
const outcomes = new Map(outRows.rows.map(r =>
  [`${r.pitcher_id}|${r.game_date}`, { ks: Number(r.ks), ip: Number(r.ip), bf: Number(r.bf) }]
))
console.log(`Outcomes loaded: ${outcomes.size}`)

// ─────────────────────────────────────────────────────────────────────────────
// 3) Pre-load actual fade fires from ks_bets
// ─────────────────────────────────────────────────────────────────────────────
const fireRows = await db.execute(`
  SELECT id, pitcher_id, bet_date, strike, side, fill_price, filled_contracts, filled_at
  FROM ks_bets WHERE strategy_mode='pregame_fade_yes' AND bet_date ${dateClause}
`)
const fires = new Map(fireRows.rows.map(r =>
  [`${r.pitcher_id}|${r.bet_date}|${r.strike}|${r.side}`, r]
))
console.log(`Fade fires loaded: ${fires.size}`)

// ─────────────────────────────────────────────────────────────────────────────
// 4) Process each pitcher-day → write candidate rows
// ─────────────────────────────────────────────────────────────────────────────
const evaluatedAt = new Date().toISOString()
let written = 0, skipped = 0, errored = 0

for (const [key, chain] of byPitcherDay) {
  const [pitcherId, betDate] = key.split('|')
  const pitcherName = chain[0].pitcher_name
  if (chain.length < 1) { skipped++; continue }

  // Pull MLB game log + career
  let log = []
  try { log = await fetchGameLog(pitcherId) } catch {}
  const prior = log.filter(g => g.date < betDate)
  const career = await fetchCareerKpct(pitcherId).catch(() => null)

  const features = {
    l3:     k9OverWindow(prior, 3),
    l5:     k9OverWindow(prior, 5),
    l7:     k9OverWindow(prior, 7),
    l10:    k9OverWindow(prior, 10),
    season: k9OverWindow(prior, 0),  // 0 = all prior 2026 starts
    career,
  }
  const variants = buildVariants(features)

  // Pre-compute lambdas_json (universal across strikes)
  const lambdasJson = {}
  for (const [name, v] of Object.entries(variants)) {
    lambdasJson[name] = { lambda: Number(v.lambda.toFixed(4)), dist: v.dist, r: v.r ?? null }
  }

  // Game / park context
  const { home, away } = parseGameLabel(chain[0].game_label)
  const pitcherTeam = parsePitcherTeam(chain[0].ticker)
  const homeAway = pitcherTeam ? (pitcherTeam === home ? 'home' : 'away') : null
  const oppTeam = pitcherTeam ? (pitcherTeam === home ? away : home) : null
  const park = home || null
  const parkFactor = park ? getParkFactor(park) : null

  const outcome = outcomes.get(key) ?? null

  // Sort strikes ascending for stable per-pitcher fire ordering
  const sortedChain = [...chain].sort((a, b) => a.strike - b.strike)

  // Pass 1: compute IDEAL edges so we can pick the single best strike for the cap
  const idealStrikeEdges = []
  const idealVar = variants[IDEAL_VARIANT]
  for (const c of sortedChain) {
    if (!idealVar) break
    const p = probFromVariant(idealVar, c.strike)
    const askCents = c.yes_ask
    if (p == null || askCents == null) continue
    idealStrikeEdges.push({ strike: c.strike, ask: askCents, edge: p - askCents / 100 })
  }
  // Best strike under the ideal config (for per-pitcher-cap=1 logic)
  let bestIdealStrike = null
  if (idealVar) {
    const candidates = idealStrikeEdges
      .filter(x => x.strike >= MIN_STRIKE && x.ask >= MIN_ASK && x.ask <= MAX_ASK && x.edge >= MIN_EDGE)
    candidates.sort((a, b) => b.edge - a.edge)
    bestIdealStrike = candidates[0]?.strike ?? null
  }

  // Pass 2: emit one row per strike × side (YES + NO) so backtests can flip side
  let prevFiresThisPitcher = 0
  for (const c of sortedChain) {
    for (const side of ['YES', 'NO']) {
      // model_probs + edges across all variants for this (strike, side)
      const modelProbsJson = {}
      const edgesJson = {}
      for (const [name, v] of Object.entries(variants)) {
        const pYes = probFromVariant(v, c.strike)
        if (pYes == null) continue
        const probSide = side === 'YES' ? pYes : (1 - pYes)
        const askCents = side === 'YES' ? c.yes_ask : (c.yes_bid != null ? 100 - c.yes_bid : null)
        modelProbsJson[name] = Number(probSide.toFixed(4))
        if (askCents != null) edgesJson[name] = Number((probSide - askCents / 100).toFixed(4))
      }

      // IDEAL would_fire decision (only for the best-edge strike, YES-only)
      const askCentsIdeal = side === 'YES' ? c.yes_ask : (c.yes_bid != null ? 100 - c.yes_bid : null)
      const idealEdge = edgesJson[IDEAL_VARIANT]
      let blocked = whyBlocked({
        side,
        strike: c.strike,
        askCents: askCentsIdeal,
        edge: idealEdge,
        prevFires: prevFiresThisPitcher,
      })
      if (blocked == null && c.strike !== bestIdealStrike) blocked = 'not_best_edge_strike'
      const wouldFire = blocked == null ? 1 : 0
      if (wouldFire) prevFiresThisPitcher++

      // would_fire across configs (compact JSON for downstream backtests)
      const wouldFireJson = {}
      for (const name of Object.keys(variants)) {
        const e = edgesJson[name]
        const ask = askCentsIdeal
        wouldFireJson[name] = (
          side === 'YES'
          && c.strike >= MIN_STRIKE
          && ask != null && ask >= MIN_ASK && ask <= MAX_ASK
          && e != null && e >= MIN_EDGE
        ) ? 1 : 0
      }

      // Outcome math for this (strike, side)
      let wonUnderIdeal = null
      let pnlAtDefault = null
      if (outcome && outcome.ks != null) {
        const won = side === 'YES' ? outcome.ks >= c.strike : outcome.ks < c.strike
        wonUnderIdeal = wouldFire ? (won ? 1 : 0) : null
        if (askCentsIdeal != null && askCentsIdeal >= MIN_ASK) {
          const contracts = Math.max(1, Math.floor(DEFAULT_STAKE_USD / (askCentsIdeal / 100)))
          const stake = contracts * (askCentsIdeal / 100)
          pnlAtDefault = won
            ? contracts * ((100 - askCentsIdeal) / 100) * (1 - FEE)
            : -stake
        }
      }

      // Cross-link to actual fire
      const fireKey = `${pitcherId}|${betDate}|${c.strike}|${side}`
      const actualFire = fires.get(fireKey)
      const ksBetId = actualFire?.id ?? null
      const firedActual = actualFire ? 1 : 0
      const askAtFire = actualFire ? askCentsIdeal : null
      const fillPriceCents = actualFire?.fill_price != null ? Number(actualFire.fill_price) : null
      const contractsFilled = actualFire?.filled_contracts ?? null
      const fillTimestamp = actualFire?.filled_at ?? null

      try {
        await db.execute({
          sql: `INSERT OR REPLACE INTO fade_paper_test_candidates (
            evaluated_at, target_date, pitcher_id, pitcher_name,
            game_pk, game_start_iso, game_label, ticker,
            strike, side, yes_bid, yes_ask, no_bid, no_ask,
            market_mid, spread, volume_24h, open_interest, ask_cents,
            k9_l3, k9_l5, k9_l7, k9_l10, k9_season, k9_career,
            avg_ip_l5, prior_starts_count,
            opp_team, park, park_k_factor, home_away,
            lambdas_json, model_probs_json, edges_json, would_fire_json,
            ideal_filter_reason,
            ks_bet_id, fired_actual, ask_at_fire_cents, fill_price_cents,
            contracts_filled, fill_timestamp,
            actual_ks, actual_ip, actual_bf,
            won_under_ideal, pnl_at_default_size
          ) VALUES (
            ?,?,?,?, ?,?,?,?, ?,?,?,?,?,?, ?,?,?,?,?,
            ?,?,?,?,?,?, ?,?, ?,?,?,?, ?,?,?,?, ?,
            ?,?,?,?, ?,?, ?,?,?, ?,?
          )`,
          args: [
            evaluatedAt, betDate, pitcherId, pitcherName,
            chain[0].game_id ? String(chain[0].game_id) : null, chain[0].gameStartIso, chain[0].game_label, c.ticker,
            c.strike, side, c.yes_bid, c.yes_ask, c.no_bid, c.no_ask,
            c.market_mid, c.spread, c.volume, c.open_interest, askCentsIdeal,
            features.l3?.k9 ?? null, features.l5?.k9 ?? null, features.l7?.k9 ?? null,
            features.l10?.k9 ?? null, features.season?.k9 ?? null, features.career?.k9 ?? null,
            features.l5?.avgIp ?? null, prior.length,
            oppTeam, park, parkFactor, homeAway,
            JSON.stringify(lambdasJson),
            JSON.stringify(modelProbsJson),
            JSON.stringify(edgesJson),
            JSON.stringify(wouldFireJson),
            blocked,
            ksBetId, firedActual, askAtFire, fillPriceCents,
            contractsFilled, fillTimestamp,
            outcome?.ks ?? null, outcome?.ip ?? null, outcome?.bf ?? null,
            wonUnderIdeal, pnlAtDefault,
          ],
        })
        written++
      } catch (err) {
        errored++
        if (errored < 10) {
          console.warn(`  insert error ${pitcherId}/${betDate}/${c.strike}/${side}: ${err.message}`)
        }
      }
    }
  }
}

console.log(`\nWrote ${written} candidate rows  (${skipped} pitcher-days skipped, ${errored} errors)`)

// ── Summary ────────────────────────────────────────────────────────────────
const sum = await db.execute(`
  SELECT target_date,
         COUNT(*) AS candidates,
         SUM(CASE WHEN ideal_filter_reason IS NULL THEN 1 ELSE 0 END) AS would_fire,
         SUM(fired_actual) AS actual_fires,
         SUM(CASE WHEN actual_ks IS NOT NULL THEN 1 ELSE 0 END) AS settled,
         SUM(CASE WHEN ideal_filter_reason IS NULL AND won_under_ideal=1 THEN 1 ELSE 0 END) AS ideal_wins,
         SUM(CASE WHEN ideal_filter_reason IS NULL AND won_under_ideal=0 THEN 1 ELSE 0 END) AS ideal_losses
  FROM fade_paper_test_candidates
  WHERE target_date ${dateClause}
  GROUP BY target_date ORDER BY target_date
`)
console.log('\nfade_paper_test_candidates summary:')
console.log('date         cands   would-fire  actual-fires  settled  ideal W/L')
for (const r of sum.rows) {
  console.log(
    `  ${r.target_date}  ${String(r.candidates).padStart(5)}  ${String(r.would_fire).padStart(10)}  `
    + `${String(r.actual_fires).padStart(12)}  ${String(r.settled).padStart(7)}  `
    + `${String(r.ideal_wins ?? 0).padStart(3)}W/${String(r.ideal_losses ?? 0).padStart(2)}L`
  )
}
