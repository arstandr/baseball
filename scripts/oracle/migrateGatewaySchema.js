// scripts/oracle/migrateGatewaySchema.js
//
// One-shot migration runner for Layer 6 (Gateway).
// Applies oracle/layers/6-gateway/schema.sql against the configured DB
// (Turso production by default).
//
// All CREATE TABLE / CREATE INDEX statements are idempotent (IF NOT EXISTS),
// so this is safe to re-run.
//
// Usage:
//   node scripts/oracle/migrateGatewaySchema.js
//
// Dry run (print statements without executing):
//   node scripts/oracle/migrateGatewaySchema.js --dry

import fs from 'node:fs/promises'
import path from 'node:path'
import url from 'node:url'
import * as db from '../../lib/db.js'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const SCHEMA_PATH = path.resolve(__dirname, '../../oracle/layers/6-gateway/schema.sql')

const DRY = process.argv.includes('--dry')

function parseStatements(raw) {
  // Same pattern as oracle/layers/0-trace/impl.js migrate() and lib/db.js:
  //   1. normalize line endings
  //   2. strip line comments per line (handles inline comments cleanly)
  //   3. drop empty lines
  //   4. split on ; and trim
  return raw
    .replace(/\r/g, '')
    .split('\n')
    .map(line => line.replace(/--.*$/, ''))
    .filter(line => line.trim())
    .join('\n')
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0)
}

async function main() {
  console.log(`[gateway-migrate] reading ${SCHEMA_PATH}`)
  const raw = await fs.readFile(SCHEMA_PATH, 'utf-8')
  const stmts = parseStatements(raw)
  console.log(`[gateway-migrate] parsed ${stmts.length} statements`)

  if (DRY) {
    for (let i = 0; i < stmts.length; i++) {
      const head = stmts[i].slice(0, 80).replace(/\s+/g, ' ')
      console.log(`  [${i + 1}] ${head}…`)
    }
    console.log('[gateway-migrate] dry run complete (no DB writes)')
    return
  }

  let applied = 0
  for (let i = 0; i < stmts.length; i++) {
    const stmt = stmts[i]
    try {
      await db.run(stmt)
      applied++
    } catch (err) {
      console.error(`[gateway-migrate] FAILED on statement ${i + 1}:`)
      console.error(stmt)
      console.error(`error: ${err.message}`)
      process.exit(1)
    }
  }
  console.log(`[gateway-migrate] ✅ applied ${applied}/${stmts.length} statements`)

  // Verify each table exists
  const tables = [
    'gateway_accounts',
    'gateway_killswitch',
    'gateway_idempotency',
    'gateway_unknowns',
    'gateway_nonces',
    'gateway_account_daily_state',
    'gateway_admin_audit',
  ]
  for (const t of tables) {
    const row = await db.one(
      `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
      [t],
    )
    if (!row) {
      console.error(`[gateway-migrate] table missing after migration: ${t}`)
      process.exit(1)
    }
    console.log(`  table ${t}`)
  }

  // Index spot-check
  const idxRow = await db.one(
    `SELECT count(*) AS n FROM sqlite_master WHERE type='index' AND name LIKE 'idx_gw_%'`,
  )
  console.log(`[gateway-migrate] gateway indexes present: ${idxRow.n}`)

  console.log('[gateway-migrate] done')
}

main().catch(err => {
  console.error('[gateway-migrate] FATAL:', err)
  process.exit(1)
})
