import 'dotenv/config'
import { createClient } from '@libsql/client'
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })
const r = await db.execute(`SELECT key, value, updated_at, updated_by FROM system_flags WHERE key IN ('trading_halted','last_reconciliation_pass_at')`)
for (const row of r.rows) console.log(`  ${row.key}: value=${row.value} updated_at=${row.updated_at} by=${row.updated_by}`)
