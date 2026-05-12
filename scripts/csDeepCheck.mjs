import 'dotenv/config'
import { createClient } from '@libsql/client'
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })
const r = await db.execute(`SELECT id, pitcher_name, side, strike, strategy_mode, strategy_submode, fill_price, market_mid, model_prob, edge, capital_at_risk, paper, order_id FROM ks_bets WHERE bet_date='2026-05-06' AND strategy_mode='pregame_cross_strike'`)
console.log('Cross-strike fires today (full detail):')
for (const f of r.rows) {
  console.log(`  #${f.id} ${f.pitcher_name} ${f.side}${f.strike}  submode=${f.strategy_submode ?? 'null'}`)
  console.log(`     fill=${f.fill_price}¢ market=${f.market_mid}¢ mp=${Number(f.model_prob).toFixed(3)} edge=${Number(f.edge).toFixed(3)} risk=$${f.capital_at_risk}`)
}

// EOD breakdown — does it know about cross-strike?
console.log('\n── EOD report sample (today) ──')
const { buildEodSummary } = await import('../lib/eodSummary.js')
const report = await buildEodSummary({ betDate: '2026-05-06' })
console.log(JSON.stringify(report, null, 2))
