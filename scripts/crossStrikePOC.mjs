// Cross-strike arbitrage POC
//
// For each pitcher-day in shadow_full_distribution, extract YES prices across
// all strikes, fit a Poisson lambda, find strikes where market price deviates
// from the fit by > threshold, simulate betting those mispricings using actual_ks
// for outcomes.
//
// Caveats:
// - 2 days of data (May 4-5). Sample size is small, this is a SIGNAL detector
// - Uses yes_mid as fill price proxy (real fills are at yes_ask, slightly worse)
// - Approximates Kalshi fees as 7% of the win amount
// - Poisson fit (negative binomial would be slightly better; check if signal exists first)

import 'dotenv/config'
import { createClient } from '@libsql/client'
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })

const MISPRICING_THRESHOLD = 0.04  // 4 percentage points
const MIN_STRIKES_FOR_FIT  = 4     // need at least 4 strikes to trust the fit
const FEE_FRACTION         = 0.07

function poissonGEqN(lambda, n) {
  // P(K >= n) = 1 - sum_{k=0}^{n-1} (e^-lambda * lambda^k / k!)
  if (n <= 0) return 1
  let cumulative = 0
  let term = Math.exp(-lambda)
  cumulative += term
  for (let k = 1; k < n; k++) {
    term = term * lambda / k
    cumulative += term
  }
  return Math.max(0, Math.min(1, 1 - cumulative))
}

function fitLambda(strikes, marketProbs) {
  let bestLambda = 5, bestSSE = Infinity
  for (let lambda = 1; lambda <= 15; lambda += 0.05) {
    let sse = 0
    for (let i = 0; i < strikes.length; i++) {
      const fit = poissonGEqN(lambda, strikes[i])
      sse += (marketProbs[i] - fit) ** 2
    }
    if (sse < bestSSE) { bestSSE = sse; bestLambda = lambda }
  }
  return { lambda: bestLambda, sse: bestSSE }
}

const rows = await db.execute(`
  SELECT bet_date, pitcher_name, strike, yes_bid, yes_ask, market_mid, actual_ks
  FROM shadow_full_distribution
  WHERE bet_date IN ('2026-05-04', '2026-05-05')
    AND side = 'YES'
    AND yes_bid IS NOT NULL AND yes_ask IS NOT NULL
    AND market_mid IS NOT NULL
    AND actual_ks IS NOT NULL
  ORDER BY bet_date, pitcher_name, strike
`)

const groups = new Map()
for (const r of rows.rows) {
  const key = `${r.bet_date}|${r.pitcher_name}`
  if (!groups.has(key)) groups.set(key, [])
  groups.get(key).push({ ...r, strike: Number(r.strike), market_mid: Number(r.market_mid),
                         yes_bid: Number(r.yes_bid), yes_ask: Number(r.yes_ask),
                         actual_ks: Number(r.actual_ks) })
}

console.log(`═════════════════════════════════════════════════════════════════════════`)
console.log(`  CROSS-STRIKE ARBITRAGE POC`)
console.log(`  Window: May 4-5 (shadow_full_distribution)`)
console.log(`  Threshold: market deviates from Poisson fit by > ${(MISPRICING_THRESHOLD * 100).toFixed(0)}¢`)
console.log(`═════════════════════════════════════════════════════════════════════════\n`)

let pitcherDaysAnalyzed = 0, pitcherDaysSkipped = 0
let totalMispricings = 0, totalFires = 0, totalWins = 0, totalLosses = 0
let totalPnl = 0, totalRisk = 0
const detail = []

for (const [key, strikeRows] of groups) {
  if (strikeRows.length < MIN_STRIKES_FOR_FIT) { pitcherDaysSkipped++; continue }
  pitcherDaysAnalyzed++

  const strikes = strikeRows.map(r => r.strike)
  const marketProbs = strikeRows.map(r => r.market_mid / 100)
  const actualK = strikeRows[0].actual_ks
  const { lambda, sse } = fitLambda(strikes, marketProbs)

  for (const r of strikeRows) {
    const market = r.market_mid / 100
    const fit = poissonGEqN(lambda, r.strike)
    const residual = market - fit

    if (Math.abs(residual) < MISPRICING_THRESHOLD) continue
    totalMispricings++

    // Direction: if market < fit, market UNDERPRICES → buy YES
    //            if market > fit, market OVERPRICES → buy NO
    const side = residual < 0 ? 'YES' : 'NO'
    const won = side === 'YES' ? actualK >= r.strike : actualK < r.strike

    // Realistic fill: pay the ask
    const askCents = side === 'YES' ? r.yes_ask : (100 - r.yes_bid)
    if (askCents <= 0 || askCents >= 100) continue  // skip locked
    const askPrice = askCents / 100

    const stake = 1  // normalize: $1 per bet
    const grossProfit = won ? (1 - askPrice) / askPrice : -1
    const fee = won ? FEE_FRACTION * Math.min(askPrice, 1 - askPrice) : 0
    const pnl = stake * (grossProfit - (won ? fee : 0))

    totalFires++
    if (won) totalWins++
    else totalLosses++
    totalPnl += pnl
    totalRisk += stake

    detail.push({
      date: r.bet_date, pitcher: r.pitcher_name, strike: r.strike, side,
      market: market.toFixed(3), fit: fit.toFixed(3), residual: residual.toFixed(3),
      lambda_fit: lambda.toFixed(2), askCents, actualK, won, pnl: pnl.toFixed(3),
    })
  }
}

console.log(`Pitcher-days analyzed:        ${pitcherDaysAnalyzed}`)
console.log(`Pitcher-days skipped (<4 strikes): ${pitcherDaysSkipped}`)
console.log(`Total candidates evaluated:   ${rows.rows.length}`)
console.log(`Mispricings (>${(MISPRICING_THRESHOLD*100).toFixed(0)}¢ from fit):     ${totalMispricings}`)
console.log(`Fires (after lock filter):    ${totalFires}`)

if (totalFires > 0) {
  const winRate = totalWins / totalFires
  const roi = totalPnl / totalRisk
  console.log(`Wins / Losses:                ${totalWins}W / ${totalLosses}L`)
  console.log(`Win rate:                     ${(winRate * 100).toFixed(1)}%`)
  console.log(`P&L (per $1 normalized):      ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`)
  console.log(`ROI per fire:                 ${(roi * 100).toFixed(1)}%`)

  console.log('\nTop 15 by residual magnitude:')
  detail.sort((a, b) => Math.abs(parseFloat(b.residual)) - Math.abs(parseFloat(a.residual)))
  for (const d of detail.slice(0, 15)) {
    const r = parseFloat(d.residual)
    const sign = r >= 0 ? '+' : ''
    console.log(`  ${d.date} ${d.pitcher.padEnd(22)} K${d.strike} ${d.side.padEnd(3)}  market=${d.market} fit=${d.fit} resid=${sign}${d.residual} ask=${d.askCents}¢ → actual_K=${d.actualK} ${d.won ? '✓ WIN' : '✗ LOSS'} pnl=${d.pnl}`)
  }
}
