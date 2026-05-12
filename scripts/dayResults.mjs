import 'dotenv/config'
import { createClient } from '@libsql/client'
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })

const date = process.argv[2] || '2026-05-03'

console.log(`══════════════════════════════════════════════════`)
console.log(`  Day Results — ${date}`)
console.log(`══════════════════════════════════════════════════\n`)

// All settled pre-game bets for the day
const r = await db.execute({
  sql: `SELECT id, user_id, pitcher_name, side, strike, capital_at_risk, result, actual_ks, pnl, paper, order_id, ticker, strategy_mode
        FROM ks_bets
        WHERE bet_date = ? AND live_bet = 0 AND order_id IS NOT NULL
        ORDER BY pitcher_name, strike, user_id`,
  args: [date],
})

const settled = r.rows.filter(b => b.result != null)
const open    = r.rows.filter(b => b.result == null)

const wins   = settled.filter(b => b.result === 'win').length
const losses = settled.filter(b => b.result === 'loss').length
const voids  = settled.filter(b => b.result === 'void').length
const totalPnl   = settled.reduce((s, b) => s + Number(b.pnl ?? 0), 0)
const settledRisk = settled.reduce((s, b) => s + Number(b.capital_at_risk ?? 0), 0)
const totalRisk  = r.rows.reduce((s, b) => s + Number(b.capital_at_risk ?? 0), 0)

console.log(`Total fires: ${r.rows.length}  ($${totalRisk.toFixed(2)} risk)`)
console.log(`Settled:     ${settled.length}  W ${wins} / L ${losses}${voids ? ' / V ' + voids : ''}   P&L ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}  on $${settledRisk.toFixed(2)} risk  (ROI ${settledRisk > 0 ? ((totalPnl/settledRisk)*100).toFixed(1) : '0.0'}%)`)
console.log(`Open:        ${open.length}\n`)

console.log(`Per-bet detail:`)
const usrName = id => id === 1 ? 'Adam' : id === 2 ? 'Isaiah' : id === 284 ? 'Adam-Live' : `u${id}`
for (const b of r.rows) {
  const icon = b.result === 'win' ? '✅' : b.result === 'loss' ? '❌' : b.result === 'void' ? '⚪' : '⏳'
  const paper = b.paper ? ' 📝' : ''
  const ks = b.actual_ks != null ? `K=${b.actual_ks}` : ''
  console.log(`  ${icon} ${b.pitcher_name.padEnd(20)} ${b.side}${b.strike}  ${usrName(b.user_id).padEnd(10)}  ${ks.padEnd(5)}  pnl=${b.pnl != null ? (b.pnl >= 0 ? '+' : '') + '$' + Number(b.pnl).toFixed(2) : '—'}  ${b.strategy_mode ?? ''}${paper}`)
}

// Shadow audit results
console.log(`\n── Shadow inversion (gap thresholds) ──`)
const inv = await db.execute({
  sql: `SELECT threshold, COUNT(*) AS cands,
               SUM(would_fire) AS fires,
               SUM(CASE WHEN would_fire=1 AND result='win' THEN 1 ELSE 0 END) AS wins,
               SUM(CASE WHEN would_fire=1 AND result='loss' THEN 1 ELSE 0 END) AS losses,
               ROUND(SUM(CASE WHEN would_fire=1 THEN shadow_pnl ELSE 0 END), 2) AS pnl
        FROM shadow_inversion WHERE bet_date = ? GROUP BY threshold ORDER BY threshold`,
  args: [date],
})
for (const t of inv.rows) {
  console.log(`  gap≥${t.threshold}: ${t.cands} cands  ${t.fires} fires  ${t.wins}W/${t.losses}L  P&L ${t.pnl >= 0 ? '+' : ''}$${(t.pnl ?? 0).toFixed(2)}`)
}

console.log(`\n── Shadow calibrated YES (edge thresholds) ──`)
const cal = await db.execute({
  sql: `SELECT edge_threshold, COUNT(*) AS cands,
               SUM(would_fire) AS fires,
               SUM(CASE WHEN would_fire=1 AND result='win' THEN 1 ELSE 0 END) AS wins,
               SUM(CASE WHEN would_fire=1 AND result='loss' THEN 1 ELSE 0 END) AS losses,
               ROUND(SUM(CASE WHEN would_fire=1 THEN shadow_pnl ELSE 0 END), 2) AS pnl
        FROM shadow_calibrated_yes WHERE bet_date = ? GROUP BY edge_threshold ORDER BY edge_threshold`,
  args: [date],
})
for (const t of cal.rows) {
  console.log(`  edge≥${t.edge_threshold}: ${t.cands} cands  ${t.fires} fires  ${t.wins}W/${t.losses}L  P&L ${t.pnl >= 0 ? '+' : ''}$${(t.pnl ?? 0).toFixed(2)}`)
}
