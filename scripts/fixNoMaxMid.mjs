import 'dotenv/config'
import { createClient } from '@libsql/client'
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })
const before = await db.execute(`SELECT key, value FROM betting_rules WHERE key = 'no_max_market_mid'`)
console.log('Before:', before.rows[0])
await db.execute({
  sql: `UPDATE betting_rules SET value=?, updated_at=?, updated_by=? WHERE key=?`,
  args: [65, new Date().toISOString(), 'rules-1to6-deploy-mid-fix', 'no_max_market_mid'],
})
const after = await db.execute(`SELECT key, value FROM betting_rules WHERE key = 'no_max_market_mid'`)
console.log('After: ', after.rows[0])
