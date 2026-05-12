import 'dotenv/config'
import { createClient } from '@libsql/client'
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })
const r = await db.execute(`SELECT pitcher_name, side, strike, model_prob, market_mid, capital_at_risk, fill_price, paper, strategy_mode, strategy_submode FROM ks_bets WHERE bet_date='2026-05-06' AND strategy_mode='pregame_cross_strike' ORDER BY logged_at`)
for (const b of r.rows) {
  console.log(`  ${b.pitcher_name.padEnd(22)} ${b.side}${b.strike} mp=${Number(b.model_prob).toFixed(3)} mid=${b.market_mid}¢ fill=${b.fill_price}¢ risk=$${b.capital_at_risk} (${b.strategy_submode})`)
}
