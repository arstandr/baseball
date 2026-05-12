// Cross-strike POC, Option B: pull today's PRE-GAME prices, identify mispricings,
// save predictions to evaluate tomorrow when games settle.

import 'dotenv/config'
import { createClient } from '@libsql/client'
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })

const TODAY = '2026-05-05'
const MISPRICING_THRESHOLD = 0.04
const MIN_STRIKES_FOR_FIT  = 4
const FEE_FRACTION         = 0.07

function poissonGEqN(lambda, n) {
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

const rows = await db.execute({
  sql: `SELECT bet_date, pitcher_name, strike, yes_bid, yes_ask, market_mid, lambda
        FROM shadow_full_distribution
        WHERE bet_date = ? AND side = 'YES'
          AND yes_bid IS NOT NULL AND yes_ask IS NOT NULL
          AND market_mid IS NOT NULL
          -- Filter out resolved markets (post-game settlement at 0/100)
          AND market_mid > 1 AND market_mid < 99
        ORDER BY pitcher_name, strike`,
  args: [TODAY],
})

console.log(`═════════════════════════════════════════════════════════════════════════`)
console.log(`  CROSS-STRIKE POC — Option B`)
console.log(`  ${TODAY} pre-game data (will settle tomorrow)`)
console.log(`═════════════════════════════════════════════════════════════════════════\n`)

if (rows.rows.length === 0) {
  console.log(`No pre-game shadow data for ${TODAY} yet. Either:`)
  console.log(`  1. Today's strikeoutEdge.js hasn't run (lineups posting later)`)
  console.log(`  2. shadow_full_distribution recording isn't triggering`)
  console.log('\nCheck back after 4 PM ET when games approach.')
  process.exit(0)
}

const groups = new Map()
for (const r of rows.rows) {
  const key = `${r.bet_date}|${r.pitcher_name}`
  if (!groups.has(key)) groups.set(key, [])
  groups.get(key).push({
    ...r,
    strike: Number(r.strike),
    market_mid: Number(r.market_mid),
    yes_bid: Number(r.yes_bid),
    yes_ask: Number(r.yes_ask),
    lambda_engine: Number(r.lambda),
  })
}

console.log(`Total pitcher-days with pre-game data: ${groups.size}`)
console.log(`Total (pitcher × strike) data points:  ${rows.rows.length}\n`)

let analyzed = 0, skipped = 0, mispricingsFound = 0, fires = 0
const predictions = []

for (const [key, strikeRows] of groups) {
  if (strikeRows.length < MIN_STRIKES_FOR_FIT) { skipped++; continue }
  analyzed++

  const strikes = strikeRows.map(r => r.strike)
  const marketProbs = strikeRows.map(r => r.market_mid / 100)
  const { lambda, sse } = fitLambda(strikes, marketProbs)
  const engineLambda = strikeRows[0].lambda_engine

  let pitcherMispricings = 0
  for (const r of strikeRows) {
    const market = r.market_mid / 100
    const fit = poissonGEqN(lambda, r.strike)
    const residual = market - fit

    if (Math.abs(residual) < MISPRICING_THRESHOLD) continue
    pitcherMispricings++
    mispricingsFound++

    const side = residual < 0 ? 'YES' : 'NO'
    const askCents = side === 'YES' ? r.yes_ask : (100 - r.yes_bid)
    if (askCents <= 0 || askCents >= 100) continue

    fires++
    predictions.push({
      pitcher: r.pitcher_name, strike: r.strike, side,
      market: market.toFixed(3), fit: fit.toFixed(3), residual: residual.toFixed(3),
      askCents, fitLambda: lambda, engineLambda,
    })
  }
}

console.log(`Pitchers analyzed:           ${analyzed}`)
console.log(`Skipped (<${MIN_STRIKES_FOR_FIT} strikes):           ${skipped}`)
console.log(`Mispricings found (>4¢):     ${mispricingsFound}`)
console.log(`Would-fire predictions:      ${fires}`)

if (fires === 0) {
  console.log('\n⚠️ Zero would-fire mispricings. Either:')
  console.log('  - Markets are tight and internally consistent (good market efficiency)')
  console.log('  - Threshold (4¢) too strict — try 2¢')
  console.log('  - Poisson fit too rigid — needs negative binomial')
  process.exit(0)
}

console.log(`\n── Top predictions by residual magnitude ──`)
predictions.sort((a, b) => Math.abs(parseFloat(b.residual)) - Math.abs(parseFloat(a.residual)))
console.log(`pitcher              K  side  market  fit    resid    ask    fit_λ  engine_λ`)
for (const p of predictions.slice(0, 20)) {
  const sign = parseFloat(p.residual) >= 0 ? '+' : ''
  console.log(`  ${p.pitcher.padEnd(20)} ${p.strike}  ${p.side.padEnd(3)}   ${p.market}   ${p.fit}  ${sign}${p.residual}  ${String(p.askCents).padStart(3)}¢   ${p.fitLambda.toFixed(2)}    ${p.engineLambda.toFixed(2)}`)
}

// Save predictions to a new tracking table for settlement tomorrow
console.log(`\n── Saving predictions to crossstrike_poc_predictions table ──`)
await db.execute(`
  CREATE TABLE IF NOT EXISTS crossstrike_poc_predictions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bet_date TEXT NOT NULL,
    pitcher_name TEXT NOT NULL,
    strike INTEGER NOT NULL,
    side TEXT NOT NULL,
    market_implied REAL,
    fit_implied REAL,
    residual REAL,
    ask_cents INTEGER,
    fit_lambda REAL,
    engine_lambda REAL,
    actual_ks INTEGER,
    won INTEGER,
    pnl REAL,
    created_at TEXT NOT NULL,
    settled_at TEXT,
    UNIQUE (bet_date, pitcher_name, strike, side)
  )
`)
let saved = 0
for (const p of predictions) {
  await db.execute({
    sql: `INSERT INTO crossstrike_poc_predictions
            (bet_date, pitcher_name, strike, side, market_implied, fit_implied, residual,
             ask_cents, fit_lambda, engine_lambda, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT DO UPDATE SET market_implied=excluded.market_implied,
            fit_implied=excluded.fit_implied, residual=excluded.residual,
            ask_cents=excluded.ask_cents, fit_lambda=excluded.fit_lambda`,
    args: [TODAY, p.pitcher, p.strike, p.side, parseFloat(p.market), parseFloat(p.fit),
           parseFloat(p.residual), p.askCents, p.fitLambda, p.engineLambda, new Date().toISOString()],
  }).catch(() => {})
  saved++
}
console.log(`Saved ${saved} predictions. Tomorrow morning we settle and check PnL.`)
