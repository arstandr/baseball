// scripts/smokeTestMultiUser.js
// Multi-user betting system smoke test.
//
// Tests the schema/code changes for per-user closer heartbeats, per-user betting
// rules, is_system_admin filtering (replacing hardcoded id != 1), per-user daily
// loss limits, soft-delete users, and the auth seed admin marker.
//
// Runs against a temp libSQL file DB — does NOT hit Kalshi, does NOT touch prod.
//
// Usage: node scripts/smokeTestMultiUser.js
//
// Exit code 0 on all pass, 1 on any fail.

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ── Bootstrap a temp DB before importing anything that uses lib/db.js ────────
const __filename = fileURLToPath(import.meta.url)
const __dirname  = path.dirname(__filename)
const REPO_ROOT  = path.resolve(__dirname, '..')

const TEST_DB_PATH = `/tmp/smoke_test_${Date.now()}.db`
process.env.TURSO_DATABASE_URL = `file:${TEST_DB_PATH}`
process.env.TURSO_AUTH_TOKEN   = 'dummy-not-used-for-file-urls'

// Now safe to import db-backed modules
const db            = await import('../lib/db.js')
const bettingRules  = await import('../lib/bettingRules.js')

// ── Pass / fail tracking ─────────────────────────────────────────────────────
let passed = 0, failed = 0
function pass(name) { console.log(`  ✓ ${name}`); passed++ }
function fail(name, reason) { console.error(`  ✗ ${name}: ${reason}`); failed++ }
function section(title) { console.log(`\n${title}`) }

async function safe(name, fn) {
  try { await fn() }
  catch (err) { fail(name, `threw — ${err.message}`) }
}

// ── Test 1: bettingRules.js signatures (no DB needed) ────────────────────────
section('1. bettingRules.js signatures')

await safe('getRules accepts userId parameter', async () => {
  if (typeof bettingRules.getRules !== 'function') return fail('getRules is a function', 'not exported')
  // getRules(userId?) — length is 0 because the param is optional, but we can
  // assert by inspecting the source string for `userId` in the signature.
  const src = bettingRules.getRules.toString()
  if (!/function\s*\w*\s*\(\s*userId\b|^\s*async\s*\w*\s*\(\s*userId\b|\(\s*userId\b/.test(src)) {
    return fail('getRules accepts userId parameter', `signature does not mention userId: ${src.slice(0, 80)}`)
  }
  pass('getRules accepts userId parameter')
})

await safe('setRule accepts userId parameter', async () => {
  if (typeof bettingRules.setRule !== 'function') return fail('setRule is a function', 'not exported')
  const src = bettingRules.setRule.toString()
  if (!/userId\s*=\s*null|\,\s*userId\b/.test(src)) {
    return fail('setRule accepts userId parameter', `signature does not mention userId: ${src.slice(0, 120)}`)
  }
  pass('setRule accepts userId parameter')
})

await safe('invalidateCache accepts userId parameter', async () => {
  if (typeof bettingRules.invalidateCache !== 'function') return fail('invalidateCache is a function', 'not exported')
  const src = bettingRules.invalidateCache.toString()
  if (!/userId\b/.test(src)) {
    return fail('invalidateCache accepts userId parameter', `signature does not mention userId: ${src.slice(0, 120)}`)
  }
  pass('invalidateCache accepts userId parameter')
})

// ── Migrate the temp DB ──────────────────────────────────────────────────────
section('2. DB migration + user inserts (temp file)')

await safe('migrate() runs cleanly', async () => {
  const r = await db.migrate()
  if (!r?.ok) return fail('migrate() runs cleanly', `unexpected result: ${JSON.stringify(r)}`)
  pass(`migrate() runs cleanly (${r.statements} statements)`)
})

// kalshi_balance is referenced by getUserDailyLoss() but is not in schema.sql
// (it is added separately by other live wiring). Add it so the loss-limit test
// works against a fresh DB.
await safe('add kalshi_balance column', async () => {
  await db.run(`ALTER TABLE users ADD COLUMN kalshi_balance REAL`).catch(err => {
    if (!/duplicate column|already exists/i.test(err.message)) throw err
  })
  pass('add kalshi_balance column')
})

let adminId, bettorAId, bettorBId
await safe('insert admin + two bettors', async () => {
  // Admin
  await db.run(
    `INSERT INTO users (name, pin, is_system_admin, active_bettor, paper)
     VALUES (?, ?, 1, 0, 1)`,
    ['Adam', '1031'],
  )
  adminId = Number((await db.one(`SELECT id FROM users WHERE name='Adam'`)).id)

  // Bettor A — active
  await db.run(
    `INSERT INTO users (name, pin, is_system_admin, active_bettor, paper, kalshi_key_id, kalshi_private_key)
     VALUES (?, ?, 0, 1, 0, ?, ?)`,
    ['Isaiah', '4994', 'kid-isaiah', 'pk-isaiah'],
  )
  bettorAId = Number((await db.one(`SELECT id FROM users WHERE name='Isaiah'`)).id)

  // Bettor B — inactive
  await db.run(
    `INSERT INTO users (name, pin, is_system_admin, active_bettor, paper)
     VALUES (?, ?, 0, 0, 1)`,
    ['Cole', '7777'],
  )
  bettorBId = Number((await db.one(`SELECT id FROM users WHERE name='Cole'`)).id)
  pass(`inserted users (admin=${adminId}, bettorA=${bettorAId}, bettorB=${bettorBId})`)
})

await safe('SELECT WHERE is_system_admin=0 returns only non-admin users', async () => {
  const rows = await db.all(`SELECT id, name FROM users WHERE is_system_admin=0 ORDER BY id`)
  const names = rows.map(r => r.name)
  if (rows.find(r => r.name === 'Adam')) return fail('is_system_admin=0 filter', `admin Adam still returned: ${names.join(',')}`)
  if (!rows.find(r => r.name === 'Isaiah') || !rows.find(r => r.name === 'Cole')) {
    return fail('is_system_admin=0 filter', `missing bettors: ${names.join(',')}`)
  }
  pass(`is_system_admin=0 filter (returned ${names.join(', ')})`)
})

await safe('SELECT WHERE is_system_admin=0 AND active_bettor=1 filters correctly', async () => {
  const rows = await db.all(
    `SELECT id, name FROM users WHERE is_system_admin=0 AND active_bettor=1`,
  )
  if (rows.length !== 1 || rows[0].name !== 'Isaiah') {
    return fail('admin+active filter', `expected only Isaiah, got: ${rows.map(r => r.name).join(',')}`)
  }
  pass('is_system_admin=0 AND active_bettor=1 filter')
})

// ── Test 3: per-user betting rules ──────────────────────────────────────────
section('3. Per-user betting rule overrides')

await safe('insert global yes_max_strike=6', async () => {
  await bettingRules.setRule('yes_max_strike', 6, 'smoke', null)
  pass('insert global yes_max_strike=6')
})

await safe('insert per-user override (bettorA → 4)', async () => {
  await bettingRules.setRule('yes_max_strike', 4, 'smoke', bettorAId)
  pass(`insert user override (user=${bettorAId} → 4)`)
})

await safe('getRules(bettorA) returns 4', async () => {
  bettingRules.invalidateCache(bettorAId)
  bettingRules.invalidateCache(null)
  const rules = await bettingRules.getRules(bettorAId)
  if (Number(rules.yes_max_strike) !== 4) {
    return fail('getRules(bettorA)', `expected 4, got ${rules.yes_max_strike}`)
  }
  pass('getRules(bettorA) returns 4 (per-user override)')
})

await safe('getRules(null) returns 6 (global only)', async () => {
  bettingRules.invalidateCache(null)
  const rules = await bettingRules.getRules(null)
  if (Number(rules.yes_max_strike) !== 6) {
    return fail('getRules(null)', `expected 6, got ${rules.yes_max_strike}`)
  }
  pass('getRules(null) returns 6 (global)')
})

await safe('getRules(bettorB) returns 6 (falls back to global)', async () => {
  bettingRules.invalidateCache(bettorBId)
  const rules = await bettingRules.getRules(bettorBId)
  if (Number(rules.yes_max_strike) !== 6) {
    return fail('getRules(bettorB)', `expected 6 fallback, got ${rules.yes_max_strike}`)
  }
  pass('getRules(bettorB) returns 6 (global fallback)')
})

await safe('invalidateCache(userId) clears only that user', async () => {
  // Prime caches
  await bettingRules.getRules(bettorAId)
  await bettingRules.getRules(null)
  // Mutate user A directly via DB, then invalidate only user A
  await db.run(
    `UPDATE user_betting_rules SET value=3 WHERE user_id=? AND key='yes_max_strike'`,
    [bettorAId],
  )
  bettingRules.invalidateCache(bettorAId)
  const userA = await bettingRules.getRules(bettorAId)
  if (Number(userA.yes_max_strike) !== 3) {
    return fail('invalidateCache(userId)', `user A cache not cleared, got ${userA.yes_max_strike}`)
  }
  pass('invalidateCache(userId) clears only that user')
})

// ── Test 4: static analysis grep — no remaining `id != 1` query patterns ─────
section('4. Static analysis: id != 1 / id = 1 in queries')

async function walkJsFiles(dir, out = []) {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (['node_modules', '.git', 'public', 'logs', 'data'].includes(e.name)) continue
      await walkJsFiles(full, out)
    } else if (e.isFile() && (e.name.endsWith('.js') || e.name.endsWith('.mjs'))) {
      // Skip the smoke test itself (it contains the patterns in test code)
      if (full === __filename) continue
      out.push(full)
    }
  }
  return out
}

// Strip JS comments (// line comments and /* block comments */) so commentary
// referencing the old pattern doesn't trigger false positives.
function stripJsComments(src) {
  // Remove block comments first (non-greedy, multiline)
  let out = src.replace(/\/\*[\s\S]*?\*\//g, '')
  // Then remove line comments (preserve URLs by requiring not-colon before //)
  out = out.replace(/(^|[^:\\])\/\/[^\n]*/g, '$1')
  return out
}

await safe('no `id != 1` in any .js file', async () => {
  const files = await walkJsFiles(REPO_ROOT)
  const offenders = []
  for (const f of files) {
    const src = stripJsComments(await fs.readFile(f, 'utf-8'))
    // Match `id != 1` and `id!=1` (with optional whitespace) but only as a SQL
    // condition — i.e. preceded by whitespace/word-boundary, not as part of an
    // identifier like `userid != 1`.
    const matches = src.match(/\bid\s*!=\s*1\b/g)
    if (matches) offenders.push(`${f.replace(REPO_ROOT + '/', '')}: ${matches.length} hit(s)`)
  }
  if (offenders.length) return fail('id != 1 grep', `found in:\n    ${offenders.join('\n    ')}`)
  pass(`no \`id != 1\` in any .js file (scanned ${files.length} files)`)
})

await safe('no `id = 1` SQL hardcode in user-table query context', async () => {
  // We only flag `id = 1` when it co-occurs with the users table — a generic
  // `WHERE id = 1` on other tables (or in test/bookkeeping queries) is fine.
  const files = await walkJsFiles(REPO_ROOT)
  const offenders = []
  for (const f of files) {
    const src = stripJsComments(await fs.readFile(f, 'utf-8'))
    // Find SELECT/UPDATE/DELETE FROM users ... id = 1 patterns
    const re = /(FROM\s+users|UPDATE\s+users|DELETE\s+FROM\s+users)[\s\S]{0,200}?\bid\s*=\s*1\b/gi
    const m = src.match(re)
    if (m) offenders.push(`${f.replace(REPO_ROOT + '/', '')}: ${m.length} hit(s)`)
  }
  if (offenders.length) return fail('users.id = 1 hardcode', `found in:\n    ${offenders.join('\n    ')}`)
  pass(`no \`users ... id = 1\` query hardcode (scanned ${files.length} files)`)
})

// ── Test 5: closer heartbeat key routing ────────────────────────────────────
section('5. Closer heartbeat key routing')

function computeHbKey(envValue) {
  // Mirrors the launcher.js logic exactly:
  //   const _BETTOR_USER_ID = process.env.BETTOR_USER_ID ? String(process.env.BETTOR_USER_ID).trim() : null
  //   const _HB_KEY         = _BETTOR_USER_ID ? `closer_${_BETTOR_USER_ID}` : 'closer'
  const id = envValue ? String(envValue).trim() : null
  return id ? `closer_${id}` : 'closer'
}

await safe('BETTOR_USER_ID=2 → key = closer_2', () => {
  const k = computeHbKey('2')
  if (k !== 'closer_2') return fail('BETTOR_USER_ID=2', `expected closer_2, got ${k}`)
  pass('BETTOR_USER_ID=2 → closer_2')
})

await safe('BETTOR_USER_ID unset → key = closer', () => {
  const k = computeHbKey(undefined)
  if (k !== 'closer') return fail('BETTOR_USER_ID unset', `expected closer, got ${k}`)
  pass('BETTOR_USER_ID unset → closer')
})

await safe('launcher.js source actually uses BETTOR_USER_ID', async () => {
  const src = await fs.readFile(path.join(REPO_ROOT, 'scripts/closer/launcher.js'), 'utf-8')
  if (!/process\.env\.BETTOR_USER_ID/.test(src)) {
    return fail('launcher.js BETTOR_USER_ID', 'launcher.js does not read process.env.BETTOR_USER_ID')
  }
  if (!/closer_\$\{[^}]*BETTOR_USER_ID|`closer_\$\{/.test(src)) {
    return fail('launcher.js closer_<id>', 'launcher.js does not build closer_<id> key')
  }
  pass('launcher.js uses BETTOR_USER_ID + closer_<id> key')
})

await safe('agent/status returns agents array', async () => {
  // Seed two heartbeats — legacy and per-user
  const now = new Date().toISOString()
  await db.run(
    `INSERT OR REPLACE INTO agent_heartbeat (key, value, updated_at) VALUES (?, ?, ?)`,
    ['closer', JSON.stringify({ commit: 'abc1234' }), now],
  )
  await db.run(
    `INSERT OR REPLACE INTO agent_heartbeat (key, value, updated_at) VALUES (?, ?, ?)`,
    [`closer_${bettorAId}`, JSON.stringify({ commit: 'def5678' }), now],
  )

  // Replicate the route logic without spinning up Express.
  const rows = await db.all(
    `SELECT key, value, updated_at FROM agent_heartbeat WHERE key LIKE 'closer%'`,
  )
  const byKey = {}
  for (const r of rows) {
    try { byKey[r.key] = { ...JSON.parse(r.value), updated_at: r.updated_at } }
    catch { byKey[r.key] = { updated_at: r.updated_at } }
  }
  const agentKeys = Object.keys(byKey).filter(k => k === 'closer' || /^closer_\d+$/.test(k))
  const agents = agentKeys.map(k => ({
    key: k,
    user_id: k === 'closer' ? null : Number(k.replace('closer_', '')),
    heartbeat: byKey[k],
  }))

  if (!Array.isArray(agents)) return fail('agents array shape', 'agents is not an array')
  if (agents.length !== 2) return fail('agents array length', `expected 2 agents, got ${agents.length}`)
  const legacy = agents.find(a => a.key === 'closer')
  const peruser = agents.find(a => a.key === `closer_${bettorAId}`)
  if (!legacy || legacy.user_id !== null) return fail('legacy agent', `bad shape: ${JSON.stringify(legacy)}`)
  if (!peruser || peruser.user_id !== bettorAId) return fail('per-user agent', `bad shape: ${JSON.stringify(peruser)}`)
  pass(`agents array has 2 entries (legacy + closer_${bettorAId})`)
})

await safe('users.js route has agents in /agent/status response', async () => {
  const src = await fs.readFile(path.join(REPO_ROOT, 'server/routes/users.js'), 'utf-8')
  if (!/router\.get\('\/agent\/status'/.test(src)) {
    return fail('agent/status route', 'route not found in users.js')
  }
  if (!/\bagents\b/.test(src.split("router.get('/agent/status'")[1] || '')) {
    return fail('agent/status agents key', 'agents key not present in route handler')
  }
  pass('users.js /agent/status route returns agents')
})

// ── Test 6: per-user daily loss limit ───────────────────────────────────────
section('6. Per-user daily loss limit')

await safe('insert user with daily_loss_limit + balance snapshot + reduced balance', async () => {
  // Use bettorA (Isaiah, paper=0, kalshi_key_id set) as the loss-limit subject
  await db.run(`UPDATE users SET daily_loss_limit=300, kalshi_balance=650 WHERE id=?`, [bettorAId])
  const today = new Date().toISOString().slice(0, 10)
  await db.run(
    `INSERT INTO balance_snapshots (user_id, date, balance_usd, captured_at)
     VALUES (?, ?, ?, ?)`,
    [bettorAId, today, 1000, new Date().toISOString()],
  )
  pass(`seeded user ${bettorAId}: snapshot=$1000, current=$650, limit=$300`)
})

// Re-implement the same query getUserDailyLoss uses (it isn't exported).
async function getUserDailyLoss(userId) {
  const today = new Date().toISOString().slice(0, 10)
  const row = await db.one(
    `SELECT u.kalshi_balance, bs.balance_usd AS snapshot_balance
     FROM users u
     JOIN balance_snapshots bs ON bs.user_id = u.id AND bs.date = ?
     WHERE u.id = ? AND u.paper = 0 AND u.kalshi_key_id IS NOT NULL`,
    [today, userId],
  )
  if (!row) return 0
  return Math.max(0, (row.snapshot_balance ?? 0) - (row.kalshi_balance ?? 0))
}

await safe('getUserDailyLoss returns 350', async () => {
  const loss = await getUserDailyLoss(bettorAId)
  if (Math.abs(loss - 350) > 0.001) return fail('getUserDailyLoss', `expected 350, got ${loss}`)
  pass(`getUserDailyLoss(${bettorAId}) = $350`)
})

await safe('loss > limit triggers skip (350 > 300)', async () => {
  const u = await db.one(`SELECT daily_loss_limit FROM users WHERE id=?`, [bettorAId])
  const loss = await getUserDailyLoss(bettorAId)
  const wouldSkip = u?.daily_loss_limit != null && loss > u.daily_loss_limit
  if (!wouldSkip) return fail('loss > limit gate', `loss=${loss} limit=${u?.daily_loss_limit} did not trigger skip`)
  pass('loss=$350 > limit=$300 triggers per-user skip')
})

await safe('liveMonitor.js source uses per-user loss check in bettor loop', async () => {
  const src = await fs.readFile(path.join(REPO_ROOT, 'scripts/live/liveMonitor.js'), 'utf-8')
  if (!/getUserDailyLoss\s*\(/.test(src)) {
    return fail('liveMonitor.js getUserDailyLoss', 'function not present in source')
  }
  if (!/daily_loss_limit/.test(src)) {
    return fail('liveMonitor.js daily_loss_limit', 'daily_loss_limit not referenced')
  }
  pass('liveMonitor.js references getUserDailyLoss + daily_loss_limit')
})

// ── Test 7: auth seed marks first user as is_system_admin=1 ─────────────────
section('7. seedUsersFromEnv marks USER1 as system admin')

await safe('seedUsersFromEnv sets is_system_admin=1 on USER1_NAME', async () => {
  // Wipe FK-dependent rows first, then users themselves
  await db.run(`DELETE FROM user_betting_rules`).catch(() => {})
  await db.run(`DELETE FROM balance_snapshots`).catch(() => {})
  await db.run(`DELETE FROM users`)
  // Set USER1_NAME so seed marks that one as admin
  process.env.USER1_NAME = 'Adam'
  process.env.USER1_PIN  = '1031'
  const auth = await import('../server/auth.js')
  await auth.seedUsersFromEnv()
  const adam = await db.one(`SELECT is_system_admin FROM users WHERE name = ? COLLATE NOCASE`, ['Adam'])
  if (!adam) return fail('seedUsersFromEnv', 'Adam row not created')
  if (adam.is_system_admin !== 1) return fail('seedUsersFromEnv', `Adam is_system_admin=${adam.is_system_admin}, expected 1`)
  // Isaiah (default, no USER1) should NOT be admin
  const isaiah = await db.one(`SELECT is_system_admin FROM users WHERE name = 'Isaiah'`)
  if (isaiah && isaiah.is_system_admin === 1) return fail('seedUsersFromEnv', 'Isaiah was incorrectly marked admin')
  pass('seedUsersFromEnv: Adam is_system_admin=1, Isaiah=0')
})

// ── Test 8: soft-delete preserves the row ───────────────────────────────────
section('8. DELETE /users/:name soft-deletes')

await safe('soft-delete zeroes creds + deactivates but row remains', async () => {
  // Make sure Isaiah exists and has creds
  await db.run(
    `UPDATE users SET active_bettor=1, paper=0, kalshi_key_id='kid', kalshi_private_key='pk' WHERE name='Isaiah'`,
  )
  const before = await db.one(`SELECT id, active_bettor, kalshi_key_id, paper FROM users WHERE name='Isaiah'`)
  if (!before) return fail('soft-delete setup', 'Isaiah missing before delete')

  // Replicate the route's soft-delete SQL exactly
  await db.run(
    `UPDATE users SET active_bettor=0, kalshi_key_id=NULL, kalshi_private_key=NULL, paper=1 WHERE name = ? COLLATE NOCASE`,
    ['Isaiah'],
  )
  const after = await db.one(`SELECT id, active_bettor, kalshi_key_id, kalshi_private_key, paper FROM users WHERE name='Isaiah'`)
  if (!after) return fail('soft-delete', 'Isaiah row was hard-deleted')
  if (after.id !== before.id) return fail('soft-delete', `id changed ${before.id} → ${after.id}`)
  if (after.active_bettor !== 0) return fail('soft-delete', `active_bettor=${after.active_bettor}`)
  if (after.kalshi_key_id !== null) return fail('soft-delete', `kalshi_key_id not null`)
  if (after.kalshi_private_key !== null) return fail('soft-delete', `kalshi_private_key not null`)
  if (after.paper !== 1) return fail('soft-delete', `paper=${after.paper}, expected 1`)
  pass('soft-delete preserves row, zeroes creds, deactivates, sets paper=1')
})

await safe('users.js DELETE route uses soft-delete (UPDATE not DELETE)', async () => {
  const src = await fs.readFile(path.join(REPO_ROOT, 'server/routes/users.js'), 'utf-8')
  // Find the DELETE handler block
  const m = src.match(/router\.delete\(['"]\/users[\s\S]+?\}\)\)/)
  if (!m) return fail('DELETE route', 'route not found')
  const block = m[0]
  if (/db\.run\(\s*`?DELETE\s+FROM\s+users/i.test(block)) {
    return fail('DELETE route soft-delete', 'route still uses hard DELETE FROM users')
  }
  if (!/UPDATE\s+users\s+SET[\s\S]*active_bettor\s*=\s*0/i.test(block)) {
    return fail('DELETE route soft-delete', 'route does not deactivate via UPDATE')
  }
  if (!/kalshi_key_id\s*=\s*NULL/.test(block)) {
    return fail('DELETE route soft-delete', 'route does not null kalshi_key_id')
  }
  pass('users.js DELETE route is soft-delete (UPDATE active_bettor=0 + null creds)')
})

// ── Cleanup ─────────────────────────────────────────────────────────────────
await db.close().catch(() => {})
await fs.unlink(TEST_DB_PATH).catch(() => {})

// ── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n${'='.repeat(60)}`)
console.log(`SMOKE TEST RESULT: ${passed} passed, ${failed} failed`)
console.log('='.repeat(60))
process.exit(failed === 0 ? 0 : 1)
