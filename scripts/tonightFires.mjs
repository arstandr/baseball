import 'dotenv/config'
import { createClient } from '@libsql/client'
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })
const r = await db.execute(`
  SELECT id, user_id, pitcher_name, side, strike, capital_at_risk, strategy_mode, live_bet, paper, result, pnl, logged_at
  FROM ks_bets WHERE bet_date = '2026-05-04' AND order_id IS NOT NULL
  ORDER BY logged_at ASC
`)
for (const b of r.rows) {
  const u = b.user_id === 1 ? 'Adam' : b.user_id === 2 ? 'Isaiah' : b.user_id === 284 ? 'Adam-Live' : `u${b.user_id}`
  const tag = b.live_bet ? '🔴live' : '📋pre'
  const res = b.result ? `${b.result === 'win' ? '✓' : '✗'} ${b.pnl >= 0 ? '+' : ''}$${b.pnl}` : 'open'
  console.log(`  #${b.id}  ${b.logged_at.slice(11,19)}Z  ${tag}  ${b.pitcher_name.padEnd(20)} ${b.side}${b.strike}  ${u.padEnd(10)} $${b.capital_at_risk}  ${b.strategy_mode.padEnd(20)} paper=${b.paper}  ${res}`)
}
