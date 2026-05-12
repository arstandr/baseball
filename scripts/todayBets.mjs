import 'dotenv/config'
import { createClient } from '@libsql/client'
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })
const cols = await db.execute(`PRAGMA table_info(ks_bets)`)
console.log('ks_bets cols:', cols.rows.map(r=>r.name).join(','))
console.log()
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
const r = await db.execute({ sql: `SELECT * FROM ks_bets WHERE bet_date = ? ORDER BY ROWID ASC LIMIT 10`, args: [today] })
console.log(`ks_bets rows for ${today}: ${r.rows.length}`)
for (const b of r.rows) {
  console.log(`  #${b.id ?? b.ROWID} u${b.user_id} ${b.pitcher_name} ${b.side}${b.strike ?? '?'} mode=${b.strategy_mode} paper=${b.paper} order_id=${b.order_id} status=${b.status} created=${b.created_at}`)
}
