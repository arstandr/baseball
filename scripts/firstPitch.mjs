import 'dotenv/config'
import { createClient } from '@libsql/client'
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })
const cols = await db.execute(`PRAGMA table_info(bet_schedule)`)
console.log('bet_schedule cols:', cols.rows.map(r => r.name).join(','))
console.log()
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
const r = await db.execute({ sql: `SELECT * FROM bet_schedule WHERE bet_date = ? ORDER BY ROWID LIMIT 5`, args: [today] })
for (const row of r.rows) console.log(row)
