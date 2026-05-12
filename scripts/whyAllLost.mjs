import 'dotenv/config'
import { createClient } from '@libsql/client'
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })

// For each fire today, dig into the model inputs vs actual outcome
const r = await db.execute(`
  SELECT id, pitcher_name, side, strike, model_prob, raw_model_prob, market_mid, edge,
         k9_career, k9_season, k9_l5, n_starts, savant_k_pct, lambda,
         actual_ks, result, pnl, capital_at_risk, logged_at, strategy_mode
  FROM ks_bets
  WHERE bet_date = '2026-05-04' AND order_id IS NOT NULL
  ORDER BY logged_at, pitcher_name
`)

console.log('═'.repeat(95))
console.log('  WHY DID EVERY PICK GO WRONG?')
console.log('═'.repeat(95))

for (const f of r.rows) {
  const fireET = new Date(f.logged_at).toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' })
  console.log(`\n  ${f.pitcher_name} ${f.side}${f.strike} (${fireET} ET, ${f.strategy_mode})`)
  console.log(`     Result: ${f.result === 'win' ? '✓' : '✗'} actual_K=${f.actual_ks} vs strike ${f.strike} → P&L ${f.pnl >= 0 ? '+' : ''}$${f.pnl} on $${f.capital_at_risk}`)
  console.log(`     Model said:  raw_mp=${Number(f.raw_model_prob ?? f.model_prob).toFixed(3)}  market_mid=${f.market_mid}¢  edge=${(Number(f.edge) * 100).toFixed(1)}¢`)
  console.log(`     Pitcher:     career_K9=${f.k9_career ?? 'null'}  season_K9=${f.k9_season ?? 'null'}  L5_K9=${f.k9_l5 ?? 'null'}  n_starts=${f.n_starts ?? 'null'}`)
  console.log(`     Lambda (expected K count today): ${Number(f.lambda).toFixed(2)}  vs actual ${f.actual_ks}`)
  
  const lambda = Number(f.lambda)
  const actual = Number(f.actual_ks)
  const lambdaError = actual - lambda
  console.log(`     Lambda error: ${lambdaError >= 0 ? '+' : ''}${lambdaError.toFixed(2)} ${Math.abs(lambdaError) > 2 ? '⚠️ MODEL FAR OFF' : ''}`)
  
  // Career flag
  if (!f.k9_career || Number(f.k9_career) === 0) {
    console.log(`     🚨 ROOKIE (no career data) — model has no historical baseline`)
  }
}

// Summary
console.log('\n' + '═'.repeat(95))
console.log('  PATTERN SUMMARY')
console.log('═'.repeat(95))

let rookieCount = 0, coldCount = 0, lambdaErrors = []
for (const f of r.rows) {
  if (!f.k9_career || Number(f.k9_career) === 0) rookieCount++
  if (Number(f.k9_career) > 0 && Number(f.k9_l5) < Number(f.k9_career)) coldCount++
  lambdaErrors.push(Math.abs(Number(f.actual_ks) - Number(f.lambda)))
}
const avgError = lambdaErrors.reduce((s,x) => s+x, 0) / lambdaErrors.length
console.log(`  Total fires: ${r.rows.length}`)
console.log(`  Rookies (no career data): ${rookieCount}`)
console.log(`  Cold pitchers (L5 < career): ${coldCount}`)
console.log(`  Average |lambda - actual_K| error: ${avgError.toFixed(2)} strikeouts`)
console.log(`  Max single error: ${Math.max(...lambdaErrors).toFixed(2)}`)

// New engine selection rate
const sched = await db.execute(`SELECT COUNT(*) AS n FROM bet_schedule WHERE bet_date = '2026-05-04'`)
const fired = await db.execute(`SELECT COUNT(DISTINCT pitcher_name) AS n FROM ks_bets WHERE bet_date='2026-05-04' AND order_id IS NOT NULL AND live_bet=0`)
console.log(`\n  Selection rate: ${fired.rows[0].n} pitchers fired / ${sched.rows[0].n} scheduled = ${(fired.rows[0].n / sched.rows[0].n * 100).toFixed(0)}%`)
