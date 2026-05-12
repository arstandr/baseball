// Continuous cross-strike candidate registry. For each pitcher-day in
// market_snapshots, build the strike chain near game start and record EVERY
// candidate (whether it fires under current rules or not), plus fit metadata
// (Poisson + NB), plus the would-fire flag and reason for non-fires.
//
// Cross-references ks_bets to mark fired_actual=1 for candidates that became
// real bets, and joins pitcher_recent_starts for outcomes (after the harvest
// cron runs).
//
// Usage:
//   node scripts/logCrossStrikeShadow.mjs                # backfill all dates from 2026-04-28
//   node scripts/logCrossStrikeShadow.mjs 2026-05-06     # specific date

import 'dotenv/config'
import { createClient } from '@libsql/client'
import {
  poissonGEqN, fitDistribution, findMispricedStrikes, generateCrossStrikeCandidates,
} from '../lib/crossStrikeCandidates.js'

const ARG_DATE   = process.argv[2]
const FROM_DATE  = '2026-04-28'
const BANKROLL   = Number(process.env.BANKROLL ?? 1000)
const PCT_CAP    = 0.03
const TAIL_CAP   = 5
const TAIL_THRESH = 25
const FEE        = 0.07
const MIN_BET    = 1

// Default-rule filter band (matches betting_rules)
const DEFAULT_MIN_RESID = 0.04
const DEFAULT_MAX_RESID = 0.20
const DEFAULT_MIN_ASK   = 3
const DEFAULT_MAX_ASK   = 88
const DEFAULT_PER_P     = 2

const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })

const MONTHS = { JAN:'01', FEB:'02', MAR:'03', APR:'04', MAY:'05', JUN:'06', JUL:'07', AUG:'08', SEP:'09', OCT:'10', NOV:'11', DEC:'12' }
function parseGameStartIso(ticker) {
  const m = /^KXMLBKS-(\d{2})([A-Z]{3})(\d{2})(\d{2})(\d{2})/.exec(ticker || '')
  if (!m) return null
  return `20${m[1]}-${MONTHS[m[2]]}-${m[3]}T${m[4]}:${m[5]}:00.000Z`
}

// Negative binomial fit: grid search over (lambda, dispersion r). Lower r = fatter tails.
function nbProbGEqN(lambda, r, n) {
  if (n <= 0) return 1
  const p = r / (r + lambda)
  let cumulative = Math.pow(p, r), term = cumulative
  for (let k = 1; k < n; k++) {
    term = term * (k + r - 1) / k * (1 - p)
    cumulative += term
  }
  return Math.max(0, Math.min(1, 1 - cumulative))
}
function fitNb(strikes, marketProbs) {
  let bestL = 5, bestR = 8, bestSse = Infinity
  for (let lambda = 1; lambda <= 12; lambda += 0.1) {
    for (let r = 2; r <= 30; r += 1) {
      let sse = 0
      for (let i = 0; i < strikes.length; i++) {
        const fit = nbProbGEqN(lambda, r, strikes[i])
        sse += (marketProbs[i] - fit) ** 2
      }
      if (sse < bestSse) { bestSse = sse; bestL = lambda; bestR = r }
    }
  }
  return { lambda: bestL, dispersion: bestR, sse: bestSse }
}

function sizeBet(askCents) {
  const baseUsd = Math.min(BANKROLL * PCT_CAP, askCents < TAIL_THRESH ? TAIL_CAP : Infinity)
  const usd = Math.max(MIN_BET, baseUsd)
  const contracts = Math.max(1, Math.floor(usd / (askCents / 100)))
  return { usd: contracts * (askCents / 100), contracts }
}

// Decide why a candidate would NOT fire under default rules
function whyBlocked(c, perPitcherCount) {
  if (c.magnitude < DEFAULT_MIN_RESID) return 'resid_too_low'
  if (c.magnitude > DEFAULT_MAX_RESID) return 'resid_too_high_outlier'
  if (c.askCents == null) return 'no_ask'
  if (c.askCents < DEFAULT_MIN_ASK)  return 'ask_too_low'
  if (c.askCents > DEFAULT_MAX_ASK)  return 'ask_too_high_adverse'
  if (perPitcherCount >= DEFAULT_PER_P) return 'per_pitcher_cap'
  return null
}

// 1) Pull market_snapshots and build per-pitcher-day strike chains
const dateClause = ARG_DATE ? `= '${ARG_DATE}'` : `>= '${FROM_DATE}'`
const groupRows = await db.execute(`
  SELECT pitcher_id, pitcher_name, game_id, game_date, ticker, strike,
         yes_bid, yes_ask, no_bid, no_ask, volume, captured_at
  FROM market_snapshots
  WHERE game_date ${dateClause}
    AND yes_bid IS NOT NULL AND yes_ask IS NOT NULL
    AND (yes_bid + yes_ask) > 2 AND (yes_bid + yes_ask) < 198
    AND ticker IS NOT NULL AND pitcher_id IS NOT NULL AND strike IS NOT NULL
`)
console.log(`Loaded ${groupRows.rows.length} snapshot rows for date filter ${ARG_DATE ?? '>=' + FROM_DATE}`)

const closest = new Map()
for (const r of groupRows.rows) {
  const startIso = parseGameStartIso(r.ticker)
  if (!startIso) continue
  const dt = Math.abs(Date.parse(r.captured_at) - Date.parse(startIso))
  const isBefore = Date.parse(r.captured_at) <= Date.parse(startIso)
  const score = (isBefore ? 0 : 1e15) + dt
  const key = `${r.pitcher_id}|${r.game_date}|${r.strike}`
  const cur = closest.get(key)
  if (!cur || score < cur.score) {
    closest.set(key, {
      pitcher_id: String(r.pitcher_id), pitcher_name: r.pitcher_name,
      game_id: r.game_id, game_date: r.game_date, ticker: r.ticker,
      strike: Number(r.strike),
      yes_bid: Number(r.yes_bid), yes_ask: Number(r.yes_ask),
      no_bid:  r.no_bid != null ? Number(r.no_bid) : null,
      no_ask:  r.no_ask != null ? Number(r.no_ask) : null,
      volume:  r.volume != null ? Number(r.volume) : null,
      market_mid: (Number(r.yes_bid) + Number(r.yes_ask)) / 2,
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

// 2) Pre-load actual_ks lookup
const outcomeRows = await db.execute(`SELECT pitcher_id, game_date, ks FROM pitcher_recent_starts WHERE game_date ${dateClause}`)
const outcomes = new Map(outcomeRows.rows.map(r => [`${r.pitcher_id}|${r.game_date}`, Number(r.ks)]))

// 3) Pre-load actual cross-strike fires from ks_bets to set fired_actual flag
const fireRows = await db.execute(
  `SELECT id, pitcher_id, bet_date, strike, side, fill_price
   FROM ks_bets WHERE strategy_mode='pregame_cross_strike' AND bet_date ${dateClause}`
)
const fires = new Map(fireRows.rows.map(r => [`${r.pitcher_id}|${r.bet_date}|${r.strike}|${r.side}`, r]))

// 4) Process each pitcher-day → write candidates
const evaluatedAt = new Date().toISOString()
let written = 0, dups = 0

for (const [key, chain] of byPitcherDay) {
  const [pitcherId, betDate] = key.split('|')
  const pitcherName = chain[0].pitcher_name
  if (chain.length < 4) continue

  // Build inputs
  const valid = chain.filter(c =>
    c.market_mid > 1 && c.market_mid < 99 && c.yes_ask != null && c.yes_bid != null
  )
  if (valid.length < 4) continue
  const strikes     = valid.map(m => Number(m.strike))
  const marketProbs = valid.map(m => Number(m.market_mid) / 100)

  // Poisson fit
  const pFit = fitDistribution(strikes, marketProbs)
  // NB fit (more compute-heavy; only run on backfill, can skip for nightly speed)
  const nbFit = fitNb(strikes, marketProbs)

  // Find ALL mispricings (no threshold floor — capture everything ≥ 1¢)
  const all = findMispricedStrikes(strikes, marketProbs, pFit, 0.01)

  // Compute ask for each candidate so we know what side+ask
  const dataByStrike = new Map(valid.map(m => [Number(m.strike), m]))
  const enriched = all.map(c => {
    const md = dataByStrike.get(c.strike)
    const askCents = c.side === 'YES' ? md.yes_ask : (md.yes_bid != null ? 100 - md.yes_bid : null)
    return { ...c, askCents, md }
  }).filter(c => c.askCents != null)

  // Track per-pitcher fire count (for default-cap filter reason)
  let perPitcherFireCount = 0
  // Sort by magnitude descending so per-pitcher cap reflects what fires first
  enriched.sort((a, b) => b.magnitude - a.magnitude)

  const actualKs = outcomes.get(key) ?? null
  const gameStartIso = parseGameStartIso(chain[0].ticker)

  for (const c of enriched) {
    const blocked = whyBlocked(c, perPitcherFireCount)
    const wouldFire = blocked == null ? 1 : 0
    if (wouldFire) perPitcherFireCount++

    // Outcome
    let won = null, pnl = null
    if (actualKs != null) {
      won = (c.side === 'YES' ? actualKs >= c.strike : actualKs < c.strike) ? 1 : 0
      const { contracts } = sizeBet(c.askCents)
      pnl = won ? contracts * ((100 - c.askCents) / 100) * (1 - FEE) : -contracts * (c.askCents / 100)
    }

    // Cross-link to actual fire
    const fireKey = `${pitcherId}|${betDate}|${c.strike}|${c.side}`
    const actualFire = fires.get(fireKey)
    const firedActual = actualFire ? 1 : 0
    const ksBetId = actualFire?.id ?? null
    const fillPrice = actualFire?.fill_price != null ? Number(actualFire.fill_price) : null

    try {
      await db.execute({
        sql: `INSERT OR REPLACE INTO shadow_cross_strike (
          evaluated_at, bet_date, pitcher_id, pitcher_name, game_pk, game_start_iso,
          n_strikes_in_chain, poisson_lambda, poisson_quality, poisson_sse, poisson_avg_residual,
          nb_lambda, nb_dispersion, nb_sse,
          strike, side, residual_cents, market_prob, fit_prob,
          yes_bid, yes_ask, no_bid, no_ask, market_mid, ask_cents, ticker, snapshot_volume,
          would_fire_default, filter_reason,
          ks_bet_id, fired_actual, fill_price_cents,
          actual_ks, won, pnl_at_default_size
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        args: [
          evaluatedAt, betDate, pitcherId, pitcherName,
          chain[0].game_id ? String(chain[0].game_id) : null,
          gameStartIso,
          valid.length, pFit.lambda, pFit.quality, pFit.sse, pFit.avgResidual,
          nbFit.lambda, nbFit.dispersion, nbFit.sse,
          c.strike, c.side,
          Math.round(c.residual * 1000) / 10,  // residual in cents (1 decimal)
          c.marketProb, c.fitProb,
          c.md.yes_bid, c.md.yes_ask, c.md.no_bid, c.md.no_ask,
          c.md.market_mid, c.askCents, c.md.ticker, c.md.volume,
          wouldFire, blocked,
          ksBetId, firedActual, fillPrice,
          actualKs, won, pnl,
        ],
      })
      written++
    } catch (err) {
      if (/UNIQUE/.test(err.message)) dups++
      else console.warn(`  insert error ${pitcherId}/${betDate}/${c.strike}/${c.side}: ${err.message}`)
    }
  }
}

console.log(`\nWrote ${written} candidate rows  (${dups} duplicates skipped)`)

// Summary
const sum = await db.execute(`
  SELECT bet_date, COUNT(*) AS candidates,
         SUM(would_fire_default) AS would_fire,
         SUM(fired_actual) AS actual_fires,
         SUM(CASE WHEN actual_ks IS NOT NULL THEN 1 ELSE 0 END) AS settled
  FROM shadow_cross_strike
  WHERE bet_date ${dateClause}
  GROUP BY bet_date ORDER BY bet_date
`)
console.log('\nshadow_cross_strike summary:')
console.log('date         candidates  would-fire  actual-fires  settled')
for (const r of sum.rows) {
  console.log(`  ${r.bet_date}  ${String(r.candidates).padStart(10)}  ${String(r.would_fire).padStart(10)}  ${String(r.actual_fires).padStart(12)}  ${String(r.settled).padStart(7)}`)
}
