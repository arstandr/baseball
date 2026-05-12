import 'dotenv/config'
import { createClient } from '@libsql/client'
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })

const before = await db.execute(`SELECT * FROM betting_rules WHERE key = 'min_bet_floor'`)
console.log('Before:', before.rows[0] ?? '(no row)')

await db.execute({
  sql: `INSERT INTO betting_rules (key, value, default_val, label, description, updated_at, updated_by)
        VALUES ('min_bet_floor', 1, 8, 'Min bet floor ($)', 'Drop bets below this dollar size to avoid fee friction on micro-stakes', ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value      = excluded.value,
          updated_at = excluded.updated_at,
          updated_by = excluded.updated_by`,
  args: [new Date().toISOString(), 'sunday-permanent-1usd'],
})

const after = await db.execute(`SELECT * FROM betting_rules WHERE key = 'min_bet_floor'`)
console.log('After: ', after.rows[0])
