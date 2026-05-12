import 'dotenv/config'
import { createClient } from '@libsql/client'
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })
const r = await db.execute(`
  SELECT id, pitcher_name, side, strike, capital_at_risk, result, actual_ks, pnl, live_bet
  FROM ks_bets WHERE bet_date = '2026-05-04' AND order_id IS NOT NULL ORDER BY id ASC
`)
let settled = 0, open = 0, totalPnl = 0
for (const b of r.rows) {
  if (b.result) { settled++; totalPnl += Number(b.pnl ?? 0) } else open++
  const tag = b.live_bet ? '🔴' : '📋'
  const s = b.result ? `${b.result === 'win' ? '✓' : '✗'} K=${b.actual_ks} ${b.pnl >= 0 ? '+' : ''}$${b.pnl}` : 'open'
  console.log(`  ${tag} #${b.id} ${b.pitcher_name.padEnd(20)} ${b.side}${b.strike}  $${b.capital_at_risk}  ${s}`)
}
console.log(`\nSettled: ${settled}, Open: ${open}, P&L so far: ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`)
