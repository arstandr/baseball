// scripts/oracle/migrateGatewayClientOrderId.js
//
// One-shot migration: add client_order_id (and last_check_error_code) columns
// to existing gateway_idempotency / gateway_unknowns tables.
//
// CREATE TABLE IF NOT EXISTS won't add columns to a table that already exists,
// so a separate ALTER TABLE pass is required for any DB that ran the
// previous schema. Each ALTER is wrapped — duplicate-column errors are swallowed
// so the script is safe to re-run.
//
// Usage:
//   node scripts/oracle/migrateGatewayClientOrderId.js
//   node scripts/oracle/migrateGatewayClientOrderId.js --dry

// Load .env from the project root before importing lib/db (which reads
// TURSO_DATABASE_URL at module init).
import dotenv from 'dotenv'
import path from 'node:path'
import url from 'node:url'
const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
dotenv.config({ path: path.resolve(__dirname, '../../.env') })

import * as db from '../../lib/db.js'

const DRY = process.argv.includes('--dry')

const COLS = [
  ['gateway_idempotency', 'client_order_id', 'TEXT'],
  ['gateway_unknowns',    'client_order_id', 'TEXT'],
  ['gateway_unknowns',    'last_check_error_code', 'TEXT'],
]

async function columnExists(table, column) {
  // PRAGMA table_info works on libsql/SQLite
  const rows = await db.all(`PRAGMA table_info(${table})`)
  return rows.some(r => String(r.name) === column)
}

async function main() {
  let added = 0
  let skipped = 0
  for (const [table, col, type] of COLS) {
    const have = await columnExists(table, col)
    if (have) {
      console.log(`  ✓ ${table}.${col} already present`)
      skipped++
      continue
    }
    if (DRY) {
      console.log(`  [dry] ALTER TABLE ${table} ADD COLUMN ${col} ${type}`)
      continue
    }
    try {
      await db.run(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`)
      console.log(`  + ${table}.${col} added`)
      added++
    } catch (err) {
      // Duplicate-column error → already exists (race against another runner)
      if (/duplicate column/i.test(err.message)) {
        console.log(`  ✓ ${table}.${col} present (caught race)`)
        skipped++
      } else {
        console.error(`  FAILED ${table}.${col}: ${err.message}`)
        process.exit(1)
      }
    }
  }
  console.log(`[gateway-coid-migrate] ${DRY ? '[dry] ' : ''}${added} added, ${skipped} already present`)
}

main().catch(err => {
  console.error('[gateway-coid-migrate] FATAL:', err)
  process.exit(1)
})
