import 'dotenv/config'
import { createClient } from '@libsql/client'
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })
const r = await db.execute({
  sql: `SELECT pitcher_name, strike, side, ROUND(raw_model_prob, 3) AS mp, ROUND(calibrated_edge, 3) AS cal_edge, production_allowed, production_filter_reason, proposed_kelly_size
        FROM shadow_full_distribution
        WHERE bet_date = ? AND production_allowed = 0 AND proposed_kelly_size > 0
        ORDER BY proposed_kelly_size DESC LIMIT 30`,
  args: ['2026-05-04'],
})
const total = await db.execute({ sql: `SELECT COUNT(*) AS n FROM shadow_full_distribution WHERE bet_date = ?`, args: ['2026-05-04'] })
console.log(`Total full-distribution rows for today: ${total.rows[0].n}`)
console.log(`Blocked WITH positive calibrated edge: ${r.rows.length}\n`)
console.log(`pitcher                strike side  mp     cal_edge  size    blocked_by`)
console.log('─'.repeat(95))
for (const row of r.rows) {
  const ce = (row.cal_edge * 100).toFixed(1).padStart(5) + '%'
  const sz = ('$' + Number(row.proposed_kelly_size).toFixed(2)).padStart(7)
  console.log(`${String(row.pitcher_name).padEnd(22)} K${row.strike}     ${row.side.padEnd(4)} ${String(row.mp).padEnd(5)}  ${ce}    ${sz}   ${row.production_filter_reason ?? ''}`)
}
