import 'dotenv/config'
import { createClient } from '@libsql/client'
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })
const r = await db.execute(`
  SELECT strategy_mode, live_bet, COUNT(*) AS n,
         SUM(CASE WHEN result='win' THEN 1 ELSE 0 END) AS wins,
         SUM(CASE WHEN result='loss' THEN 1 ELSE 0 END) AS losses,
         ROUND(SUM(pnl), 2) AS pnl,
         ROUND(SUM(capital_at_risk), 2) AS risk
  FROM ks_bets WHERE bet_date = '2026-05-04' AND order_id IS NOT NULL
  GROUP BY strategy_mode, live_bet ORDER BY live_bet, strategy_mode
`)
for (const row of r.rows) {
  const tag = row.live_bet ? '🔴 IN-GAME' : '📋 pregame'
  console.log(`  ${tag}  ${(row.strategy_mode ?? 'unknown').padEnd(28)} n=${row.n}  W${row.wins}/L${row.losses}  pnl=${row.pnl >= 0 ? '+' : ''}$${row.pnl}  risk=$${row.risk}`)
}
