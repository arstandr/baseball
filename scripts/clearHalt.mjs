import 'dotenv/config'
import { createClient } from '@libsql/client'
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })

const before = await db.execute(`SELECT key, value, updated_at, updated_by FROM system_flags WHERE key = 'trading_halted'`)
console.log('Before:', before.rows[0] ?? '(no row)')

await db.execute({
  sql: `INSERT INTO system_flags (key,value,updated_at,updated_by) VALUES ('trading_halted','0',?,?)
        ON CONFLICT(key) DO UPDATE SET value='0', updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
  args: [new Date().toISOString(), 'sunday-dryrun-clear'],
})

const after = await db.execute(`SELECT key, value, updated_at, updated_by FROM system_flags WHERE key = 'trading_halted'`)
console.log('After: ', after.rows[0])
