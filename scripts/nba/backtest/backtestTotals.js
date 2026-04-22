// scripts/nba/backtest/backtestTotals.js
//
// Full season backtest of the NBA totals strategy.
// Uses calibrated σ (from calibrateSigma.js output or --sigma flag) to
// simulate betting decisions across 2024-25 games.
//
// Strategy:
//   For each game: compute P(total > N) using Normal(vegas_line, σ) for
//   N = vegas_line ± {3, 6, 9, 12, 15} pts. Simulate a "synthetic Kalshi"
//   price using Normal(vegas_line, σ_market). When edge ≥ threshold, bet.
//
//   σ_market is what Kalshi implicitly uses — we estimate this from the
//   live data where Kalshi priced PHX@OKC 227.5+ at 23¢ when Vegas=215.5.
//   That implies Kalshi uses σ≈14-15 (fatter tails than reality).
//   We test multiple σ_market assumptions to find the most profitable.
//
// Requires: nba_backtest_games table populated by calibrateSigma.js
//
// Usage:
//   node scripts/nba/backtest/backtestTotals.js [--sigma 12.5] [--min-edge 0.05]

import 'dotenv/config'
import * as db from '../../../lib/db.js'
import { parseArgs } from '../../../lib/cli-args.js'

const opts     = parseArgs({
  sigma:      { type: 'number', default: 12.5 },
  'min-edge': { type: 'number', default: 0.05 },
  'sigma-market': { type: 'number', default: 0 },  // 0 = sweep
})
const SIGMA      = opts.sigma
const MIN_EDGE   = opts['min-edge']
const SIG_MARKET = opts['sigma-market']   // 0 = sweep all values

await db.migrate()

const games = await db.all(`
  SELECT * FROM nba_backtest_games
  WHERE vegas_line IS NOT NULL AND actual_total IS NOT NULL
  ORDER BY game_date ASC`)

if (!games.length) {
  console.log('No backtest data found. Run calibrateSigma.js first.')
  process.exit(0)
}

console.log('══════════════════════════════════════════════════')
console.log(` NBA Totals Backtest — σ=${SIGMA}  min_edge=${MIN_EDGE*100}¢`)
console.log(`  ${games.length} games  (${games[0].game_date} → ${games[games.length-1].game_date})`)
console.log('══════════════════════════════════════════════════\n')

// ── σ_market sweep ────────────────────────────────────────────────────────────
const sigMarkets = SIG_MARKET > 0
  ? [SIG_MARKET]
  : [10, 11, 12, 12.5, 13, 14, 15, 16, 17]

console.log('σ_market sweep — which Kalshi σ assumption yields most edge?\n')
console.log('σ_mkt  | Bets | Win%  | P&L     | ROI    | AvgEdge | Best strategy')
console.log('-------|------|-------|---------|--------|---------|---------------')

let bestConfig = null

for (const sigMkt of sigMarkets) {
  const result = runBacktest(games, SIGMA, sigMkt, MIN_EDGE)
  const wr     = result.bets ? (result.wins / result.bets * 100).toFixed(1) : '—'
  const pnl    = result.pnl.toFixed(2)
  const roi    = result.wagered ? (result.pnl / result.wagered * 100).toFixed(1) : '—'
  const avgEdge = result.bets ? (result.totalEdge / result.bets * 100).toFixed(1) : '—'
  const flag   = result.pnl > 0 ? ' ✓' : ''
  console.log(
    `${String(sigMkt).padEnd(6)} | ${String(result.bets).padStart(4)} | ${wr.padStart(5)}% | ${pnl.padStart(7)} | ${roi.padStart(6)}% | ${avgEdge.padStart(7)}¢ | ${result.topStrategy}${flag}`)
  if (!bestConfig || result.roi > bestConfig.roi) bestConfig = { sigMkt, ...result }
}

// ── Detailed breakdown for best config ───────────────────────────────────────
if (!bestConfig) { console.log('\nNo bets found at this edge threshold.'); process.exit(0) }

console.log(`\n── Detailed breakdown: σ_market=${bestConfig.sigMkt} ──────────────────`)
const detailed = runBacktest(games, SIGMA, bestConfig.sigMkt, MIN_EDGE, true)

console.log('\nBy delta bucket (Kalshi line - Vegas line):')
console.log('Delta    | Bets | Win%  | P&L     | Avg Edge')
console.log('---------|------|-------|---------|----------')
for (const [bucket, stats] of Object.entries(detailed.buckets)) {
  if (!stats.bets) continue
  const wr  = (stats.wins / stats.bets * 100).toFixed(1)
  const pnl = stats.pnl.toFixed(2)
  const ae  = (stats.totalEdge / stats.bets * 100).toFixed(1)
  console.log(`${bucket.padEnd(8)} | ${String(stats.bets).padStart(4)} | ${wr.padStart(5)}% | ${pnl.padStart(7)} | ${ae.padStart(8)}¢`)
}

console.log('\nBy side (YES over / NO under):')
for (const [side, stats] of Object.entries(detailed.bySide)) {
  if (!stats.bets) continue
  const wr  = (stats.wins / stats.bets * 100).toFixed(1)
  const pnl = stats.pnl.toFixed(2)
  console.log(`  ${side}: ${stats.bets} bets  ${wr}% WR  ${pnl >= 0 ? '+' : ''}$${pnl}`)
}

console.log('\nBy edge bucket:')
for (const [bucket, stats] of Object.entries(detailed.byEdge)) {
  if (!stats.bets) continue
  const wr  = (stats.wins / stats.bets * 100).toFixed(1)
  const pnl = stats.pnl.toFixed(2)
  console.log(`  ${bucket}: ${stats.bets} bets  ${wr}% WR  ${pnl >= 0 ? '+' : ''}$${pnl}`)
}

console.log('\nMonthly P&L:')
for (const [month, stats] of Object.entries(detailed.byMonth)) {
  if (!stats.bets) continue
  const wr  = (stats.wins / stats.bets * 100).toFixed(1)
  const pnl = stats.pnl.toFixed(2)
  console.log(`  ${month}: ${stats.bets} bets  ${wr}% WR  ${pnl >= 0 ? '+' : ''}$${pnl}`)
}

console.log('\n── Summary ─────────────────────────────────────────────')
console.log(`  Best σ_market: ${bestConfig.sigMkt}  (our model σ: ${SIGMA})`)
console.log(`  Interpretation: Kalshi uses wider tails → we profit buying NO at extremes`)
console.log(`  Recommended σ to use in nbaTotalsEdge.js: ${SIGMA}`)
console.log(`  Recommended NBA_TOTAL_SIGMA env var: ${SIGMA}`)

await db.close()

// ── Backtest engine ───────────────────────────────────────────────────────────

function runBacktest(games, sigma, sigmaMarket, minEdge, detailed = false) {
  let bets = 0, wins = 0, pnl = 0, wagered = 0, totalEdge = 0
  const strategies = {}
  const buckets = {}
  const bySide  = { YES: { bets:0,wins:0,pnl:0,totalEdge:0 }, NO: { bets:0,wins:0,pnl:0,totalEdge:0 } }
  const byEdge  = {}
  const byMonth = {}

  // Kalshi-style ladder: Vegas line ± {3,6,9,12,15} pts
  const OFFSETS = [-15, -12, -9, -6, -3, 0, 3, 6, 9, 12, 15]

  for (const game of games) {
    const vegasLine   = game.vegas_line
    const actualTotal = game.actual_total
    const month       = game.game_date.slice(0, 7)

    for (const offset of OFFSETS) {
      const line = vegasLine + offset

      // Our model's probability
      const modelProb = pOver(line, vegasLine, sigma)

      // Synthetic Kalshi price (what Kalshi would price using sigmaMarket)
      const kalshiYes = pOver(line, vegasLine, sigmaMarket)
      const kalshiNo  = 1 - pOver(line, vegasLine, sigmaMarket)

      const overEdge  = modelProb - kalshiYes
      const underEdge = (1 - modelProb) - kalshiNo
      const edge      = Math.max(overEdge, underEdge)

      if (edge < minEdge) continue

      const side    = overEdge >= underEdge ? 'YES' : 'NO'
      const price   = side === 'YES' ? kalshiYes : kalshiNo
      const betSize = 100  // flat $100 for calibration
      const won     = side === 'YES' ? actualTotal > line : actualTotal <= line
      const gamePnl = won ? betSize * (1 - price) / price : -betSize

      bets++
      if (won) wins++
      pnl     += gamePnl
      wagered += betSize
      totalEdge += edge

      const stratKey = `${side} @ +${offset > 0 ? '+' : ''}${offset}`
      strategies[stratKey] = strategies[stratKey] || { bets:0,wins:0,pnl:0 }
      strategies[stratKey].bets++
      if (won) strategies[stratKey].wins++
      strategies[stratKey].pnl += gamePnl

      if (detailed) {
        const bucketKey = offset === 0 ? 'At money' : offset > 0 ? `+${offset}` : `${offset}`
        buckets[bucketKey] = buckets[bucketKey] || { bets:0,wins:0,pnl:0,totalEdge:0 }
        buckets[bucketKey].bets++
        if (won) buckets[bucketKey].wins++
        buckets[bucketKey].pnl += gamePnl
        buckets[bucketKey].totalEdge += edge

        bySide[side].bets++
        if (won) bySide[side].wins++
        bySide[side].pnl += gamePnl
        bySide[side].totalEdge += edge

        const edgeBucket = edge >= 0.10 ? '10¢+' : edge >= 0.08 ? '8-10¢' : edge >= 0.06 ? '6-8¢' : '5-6¢'
        byEdge[edgeBucket] = byEdge[edgeBucket] || { bets:0,wins:0,pnl:0 }
        byEdge[edgeBucket].bets++
        if (won) byEdge[edgeBucket].wins++
        byEdge[edgeBucket].pnl += gamePnl

        byMonth[month] = byMonth[month] || { bets:0,wins:0,pnl:0 }
        byMonth[month].bets++
        if (won) byMonth[month].wins++
        byMonth[month].pnl += gamePnl
      }
    }
  }

  // Find top strategy
  const topEntry = Object.entries(strategies)
    .sort((a, b) => b[1].pnl - a[1].pnl)[0]
  const topStrategy = topEntry
    ? `${topEntry[0]} (${topEntry[1].bets}bets $${topEntry[1].pnl.toFixed(0)})`
    : '—'

  const roi = wagered ? pnl / wagered : 0

  return { bets, wins, pnl, wagered, totalEdge, roi, topStrategy,
           buckets, bySide, byEdge, byMonth }
}

function pOver(line, mu, sigma) {
  return 1 - normalCDF((line - mu) / sigma)
}

function normalCDF(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z))
  const d = 0.3989423 * Math.exp(-z * z / 2)
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.7814779 + t * (-1.8212560 + t * 1.3302744))))
  return z > 0 ? 1 - p : p
}
