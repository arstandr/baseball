import 'dotenv/config'
import { createClient } from '@libsql/client'
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })
// All rows logged in the last 24h regardless of bet_date
const r = await db.execute(`SELECT id, bet_date, logged_at, pitcher_name, side, strike, paper, order_id, order_status, strategy_mode, user_id, capital_at_risk FROM ks_bets WHERE logged_at >= datetime('now','-12 hours') ORDER BY id DESC LIMIT 20`)
console.log(`Rows logged in last 12h: ${r.rows.length}`)
for (const b of r.rows) {
  console.log(`  #${b.id} bet_date=${b.bet_date} logged=${b.logged_at} u${b.user_id} ${b.pitcher_name} ${b.side}${b.strike} risk=$${b.capital_at_risk} mode=${b.strategy_mode} paper=${b.paper} order=${b.order_id} status=${b.order_status}`)
}
