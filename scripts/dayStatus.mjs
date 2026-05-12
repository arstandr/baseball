import 'dotenv/config'
import { createClient } from '@libsql/client'
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })

const r = await db.execute({
  sql: `SELECT id, user_id, pitcher_name, side, strike, capital_at_risk, result, actual_ks, pnl, order_id, ticker
        FROM ks_bets
        WHERE bet_date = ? AND live_bet = 0 AND order_id IS NOT NULL
        ORDER BY pitcher_name, strike, user_id`,
  args: [today],
})

const settled = r.rows.filter(b => b.result != null)
const open    = r.rows.filter(b => b.result == null)

const wins   = settled.filter(b => b.result === 'win').length
const losses = settled.filter(b => b.result === 'loss').length
const totalPnl   = settled.reduce((s, b) => s + Number(b.pnl ?? 0), 0)
const totalRisk  = r.rows.reduce((s, b) => s + Number(b.capital_at_risk ?? 0), 0)
const settledRisk = settled.reduce((s, b) => s + Number(b.capital_at_risk ?? 0), 0)
const openRisk   = open.reduce((s, b) => s + Number(b.capital_at_risk ?? 0), 0)

console.log(`Today (${today}) paper-mode status:`)
console.log(`  Total fires: ${r.rows.length}  ($${totalRisk.toFixed(2)} risk)`)
console.log(`  Settled:     ${settled.length}  W ${wins} / L ${losses}   P&L ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}  on $${settledRisk.toFixed(2)} risk  (ROI ${((totalPnl/settledRisk)*100).toFixed(1)}%)`)
console.log(`  Open:        ${open.length}  ($${openRisk.toFixed(2)} risk)`)

if (settled.length) {
  console.log(`\nSettled:`)
  for (const b of settled) {
    const userTag = b.user_id === 2 ? 'Isaiah' : b.user_id === 284 ? 'Adam-Live' : `u${b.user_id}`
    const icon = b.result === 'win' ? '✅' : '❌'
    console.log(`  ${icon} ${b.pitcher_name.padEnd(20)} ${b.side}${b.strike}  ${userTag.padEnd(10)}  K=${b.actual_ks}  pnl=${b.pnl >= 0 ? '+' : ''}$${Number(b.pnl).toFixed(2)}`)
  }
}

if (open.length) {
  console.log(`\nOpen:`)
  // Group by pitcher to show pending count
  const byPitcher = new Map()
  for (const b of open) {
    const k = `${b.pitcher_name} ${b.side}${b.strike}`
    if (!byPitcher.has(k)) byPitcher.set(k, [])
    byPitcher.get(k).push(b)
  }
  for (const [k, rows] of byPitcher) {
    const totalRiskHere = rows.reduce((s, r) => s + Number(r.capital_at_risk ?? 0), 0)
    console.log(`  ⏳ ${k.padEnd(28)} × ${rows.length} bettor(s)  $${totalRiskHere.toFixed(2)} at risk`)
  }
}
