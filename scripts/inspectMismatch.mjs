import 'dotenv/config'
import { createClient } from '@libsql/client'
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })
const r = await db.execute(`SELECT key, value, updated_at FROM system_flags WHERE key = 'last_reconciliation_diff'`)
const row = r.rows[0]
if (!row) { console.log('(no diff)'); process.exit(0) }
console.log('updated_at:', row.updated_at)
const diff = JSON.parse(row.value)
for (const u of diff) {
  console.log(`\nUser ${u.user_name} (id=${u.user_id}) — kalshi=${u.kalshi_count} db=${u.db_count} mismatches=${u.mismatches?.length ?? 0}`)
  if (u.error) console.log('  error:', u.error)
  for (const m of u.mismatches || []) {
    console.log(`  ${m.type}: ${m.ticker}  kalshi_qty=${m.kalshi_qty}  db_qty=${m.db_qty}  side=${m.side}  ks_bet_id=${m.ks_bet_id ?? '-'}`)
  }
}
