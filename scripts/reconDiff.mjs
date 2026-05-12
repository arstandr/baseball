import 'dotenv/config'
import { createClient } from '@libsql/client'
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })
const r = await db.execute(`SELECT key, value, updated_at FROM system_flags WHERE key IN ('last_reconciliation_diff','last_reconciliation_pass_at','last_reconciliation_status')`)
for (const row of r.rows) {
  console.log(`${row.key}  (${row.updated_at})`)
  console.log(`  ${row.value}`)
  console.log()
}
