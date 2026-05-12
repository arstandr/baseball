import 'dotenv/config'
import { createClient } from '@libsql/client'
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })

// Last 7 days breakdown by side + strategy_mode
const r = await db.execute(`
  SELECT bet_date, side, strategy_mode, paper, COUNT(*) AS n,
         ROUND(SUM(capital_at_risk), 2) AS risk
  FROM ks_bets
  WHERE bet_date >= date('now','-7 days') AND live_bet = 0
  GROUP BY bet_date, side, strategy_mode, paper
  ORDER BY bet_date DESC, side, strategy_mode
`)
console.log('Last 7 days, side × strategy_mode × paper:')
for (const r2 of r.rows) {
  console.log(`  ${r2.bet_date}  ${r2.side.padEnd(3)} ${r2.strategy_mode.padEnd(20)} paper=${r2.paper}  n=${r2.n}  risk=$${r2.risk}`)
}

// Today breakdown
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
console.log(`\n── Today (${today}) summary ──`)
const t = await db.execute({
  sql: `SELECT side, COUNT(*) AS n FROM ks_bets WHERE bet_date = ? AND live_bet = 0 GROUP BY side`,
  args: [today],
})
for (const r2 of t.rows) console.log(`  ${r2.side}: ${r2.n}`)
