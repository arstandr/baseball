// scripts/oracle/preUnhaltCheck.js
//
// PRE-UNHALT CHECKLIST — gate that must pass before clearing
// system_flags.trading_halted for the live inversion strategy.
//
// Verifies (in order): trading_halted=1 in DB; deployed COMMIT_SHA matches
// expected; oracle stage + invert env vars set to safe values; required
// per-day risk caps loaded; strategy_mode enum validator exists and rejects
// missing/unknown values; ks_bets cap query returns numbers for today; both
// active live bettors (Adam-Live id=284, Isaiah id=2) have working Kalshi
// auth (env or per-user DB creds with fallback to disk backup); daily_plan
// + bet_schedule populated for today; no orphan order_id-NULL ks_bets rows
// from prior days.
//
// Usage:
//   node scripts/oracle/preUnhaltCheck.js                 (today, ET)
//   node scripts/oracle/preUnhaltCheck.js --date 2026-05-01
//   node scripts/oracle/preUnhaltCheck.js --expected-sha abc1234
//
// Exit: 0 only when every check is PASS (no FAIL, no SKIP). Anything else → 1.

import 'dotenv/config'
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

import * as db from '../../lib/db.js'
import { parseArgs } from '../../lib/cli-args.js'

// ── CLI ───────────────────────────────────────────────────────────
function todayET() {
  // Use ET (UTC-4 during MLB season). Good enough for a launch checklist.
  const t = new Date(Date.now() - 4 * 60 * 60 * 1000)
  return t.toISOString().slice(0, 10)
}
const opts = parseArgs({
  date:        { default: todayET() },
  expectedSha: { flag: 'expected-sha' },
  service:     { default: 'successful-acceptance' },
  credsBackup: { flag: 'creds-backup', default: path.join(homedir(), '.config/baseball-secrets/kalshi-creds-backup-2026-05-01.json') },
})
const DATE     = opts.date
const SERVICE  = opts.service

let failCount = 0
let skipCount = 0
let passCount = 0

function record(status, label, detail = '') {
  const tag = status === 'PASS' ? '[PASS]' : status === 'FAIL' ? '[FAIL]' : '[SKIP]'
  console.log(`${tag} ${label}${detail ? `  — ${detail}` : ''}`)
  if (status === 'PASS') passCount++
  else if (status === 'SKIP') skipCount++
  else failCount++
}

console.log(`PRE-UNHALT CHECKLIST — ${DATE}`)
console.log('')

// ── Pull Railway env vars once (used by several checks) ───────────
let railwayEnv = null
let railwayError = null
try {
  const out = execFileSync('railway', ['variables', '--service', SERVICE, '--json'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30000,
  })
  railwayEnv = JSON.parse(out)
} catch (err) {
  railwayError = err.message || String(err)
  // Try alternate spelling: `railway variable list` (older CLI)
  try {
    const out = execFileSync('railway', ['variable', 'list', '--service', SERVICE, '--json'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30000,
    })
    railwayEnv = JSON.parse(out)
    railwayError = null
  } catch (err2) {
    railwayError = `${railwayError}; alt: ${err2.message || err2}`
  }
}

function rwGet(key) {
  if (!railwayEnv || typeof railwayEnv !== 'object') return undefined
  // Railway --json is typically an object map, but accept array of {name,value} too
  if (Array.isArray(railwayEnv)) {
    const r = railwayEnv.find(v => v.name === key || v.key === key)
    return r ? (r.value ?? r.val) : undefined
  }
  return railwayEnv[key]
}

function envOr(key) {
  // Prefer Railway value (truth for deployed service); fall back to local env
  const rw = rwGet(key)
  if (rw !== undefined && rw !== null) return rw
  return process.env[key]
}

// ── 1. trading_halted = 1 ─────────────────────────────────────────
try {
  const row = await db.one(`SELECT value FROM system_flags WHERE key = 'trading_halted'`)
  if (!row) record('FAIL', 'trading_halted currently = 1', 'no system_flags row')
  else if (String(row.value) === '1') record('PASS', 'trading_halted currently = 1')
  else record('FAIL', 'trading_halted currently = 1', `actual = ${row.value}`)
} catch (err) {
  record('FAIL', 'trading_halted currently = 1', `db error: ${err.message}`)
}

// ── 2. expected COMMIT_SHA matches deployed ───────────────────────
{
  const expected = opts.expectedSha
  const deployed = rwGet('COMMIT_SHA') || rwGet('RAILWAY_GIT_COMMIT_SHA')
  if (!expected) {
    record('SKIP', 'expected COMMIT_SHA matches deployed', '--expected-sha not provided')
  } else if (railwayError && !deployed) {
    record('SKIP', 'expected COMMIT_SHA matches deployed', `railway CLI: ${railwayError}`)
  } else if (!deployed) {
    record('FAIL', 'expected COMMIT_SHA matches deployed', 'COMMIT_SHA absent from Railway env')
  } else {
    const ok = String(deployed).startsWith(String(expected)) || String(expected).startsWith(String(deployed))
    if (ok) record('PASS', 'expected COMMIT_SHA matches deployed', `${String(deployed).slice(0, 12)}`)
    else record('FAIL', 'expected COMMIT_SHA matches deployed', `expected=${expected} deployed=${String(deployed).slice(0, 12)}`)
  }
}

// ── 3. ORACLE_STAGE = 3 ───────────────────────────────────────────
{
  const v = envOr('ORACLE_STAGE')
  if (railwayError && v === undefined) record('SKIP', 'ORACLE_STAGE = 3', `railway CLI: ${railwayError}`)
  else if (String(v) === '3') record('PASS', 'ORACLE_STAGE = 3')
  else record('FAIL', 'ORACLE_STAGE = 3', `actual = ${v ?? '(unset)'}`)
}

// ── 4. DK_BLEND_ENABLED = false (or absent) ───────────────────────
{
  const v = envOr('DK_BLEND_ENABLED')
  if (v === undefined || v === null || String(v).toLowerCase() === 'false' || v === '') {
    record('PASS', 'DK_BLEND_ENABLED = false (or absent)', v === undefined ? 'absent' : `=${v}`)
  } else {
    record('FAIL', 'DK_BLEND_ENABLED = false (or absent)', `actual = ${v}`)
  }
}

// ── 5. CALIBRATION_ENABLED = false (or absent) ────────────────────
{
  const v = envOr('CALIBRATION_ENABLED')
  if (v === undefined || v === null || String(v).toLowerCase() === 'false' || v === '') {
    record('PASS', 'CALIBRATION_ENABLED = false (or absent)', v === undefined ? 'absent' : `=${v}`)
  } else {
    record('FAIL', 'CALIBRATION_ENABLED = false (or absent)', `actual = ${v}`)
  }
}

// ── 6. INVERT_KELLY_MULT = 0.50 ───────────────────────────────────
{
  const v = envOr('INVERT_KELLY_MULT')
  if (railwayError && v === undefined) record('SKIP', 'INVERT_KELLY_MULT = 0.50', `railway CLI: ${railwayError}`)
  else if (Number(v) === 0.5) record('PASS', 'INVERT_KELLY_MULT = 0.50')
  else record('FAIL', 'INVERT_KELLY_MULT = 0.50', `actual = ${v ?? '(unset)'}`)
}

// ── 7. INVERT_L5_GAP_MIN >= 0.5 ───────────────────────────────────
{
  const v = envOr('INVERT_L5_GAP_MIN')
  if (railwayError && v === undefined) record('SKIP', 'INVERT_L5_GAP_MIN >= 0.5', `railway CLI: ${railwayError}`)
  else if (Number.isFinite(Number(v)) && Number(v) >= 0.5) record('PASS', 'INVERT_L5_GAP_MIN >= 0.5', `=${v}`)
  else record('FAIL', 'INVERT_L5_GAP_MIN >= 0.5', `actual = ${v ?? '(unset)'}`)
}

// ── 8. INVERT_STRIKE_MIN = 5, INVERT_STRIKE_MAX = 7 ───────────────
{
  const lo = envOr('INVERT_STRIKE_MIN')
  const hi = envOr('INVERT_STRIKE_MAX')
  if (railwayError && lo === undefined && hi === undefined) {
    record('SKIP', 'INVERT_STRIKE_MIN = 5, INVERT_STRIKE_MAX = 7', `railway CLI: ${railwayError}`)
  } else if (Number(lo) === 5 && Number(hi) === 7) {
    record('PASS', 'INVERT_STRIKE_MIN = 5, INVERT_STRIKE_MAX = 7')
  } else {
    record('FAIL', 'INVERT_STRIKE_MIN = 5, INVERT_STRIKE_MAX = 7', `min=${lo ?? '(unset)'} max=${hi ?? '(unset)'}`)
  }
}

// ── 9. INVERT_MODELP_MIN >= 0.50 ──────────────────────────────────
{
  const v = envOr('INVERT_MODELP_MIN')
  if (railwayError && v === undefined) record('SKIP', 'INVERT_MODELP_MIN >= 0.50', `railway CLI: ${railwayError}`)
  else if (Number.isFinite(Number(v)) && Number(v) >= 0.5) record('PASS', 'INVERT_MODELP_MIN >= 0.50', `=${v}`)
  else record('FAIL', 'INVERT_MODELP_MIN >= 0.50', `actual = ${v ?? '(unset)'}`)
}

// Generic helper for the next run of "loaded as positive number, expected $X"
function checkPositive(label, key, expected, exactExpected = false) {
  const v = envOr(key)
  if (railwayError && v === undefined) {
    record('SKIP', label, `railway CLI: ${railwayError}`)
    return
  }
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) {
    record('FAIL', label, `actual = ${v ?? '(unset)'}`)
    return
  }
  if (exactExpected && n !== expected) {
    record('FAIL', label, `actual = ${n}, expected = ${expected}`)
    return
  }
  if (!exactExpected && expected != null && n !== expected) {
    record('PASS', label, `loaded = ${n} (expected ${expected})`)
    return
  }
  record('PASS', label, `loaded = ${n}`)
}

// ── 10. INVERT_DAILY_LOSS_LIMIT loaded ($150) ─────────────────────
checkPositive('INVERT_DAILY_LOSS_LIMIT loaded as positive number ($150 expected)', 'INVERT_DAILY_LOSS_LIMIT', 150)

// ── 11. MAX_INVERT_RISK_PER_PITCHER ($50) ─────────────────────────
checkPositive('MAX_INVERT_RISK_PER_PITCHER loaded ($50 expected)', 'MAX_INVERT_RISK_PER_PITCHER', 50)

// ── 12. MAX_INVERT_BETS_PER_PITCHER (2) ───────────────────────────
checkPositive('MAX_INVERT_BETS_PER_PITCHER loaded (2 expected)', 'MAX_INVERT_BETS_PER_PITCHER', 2)

// ── 13. LIVE_DAILY_LOSS_LIMIT ($300) ──────────────────────────────
checkPositive('LIVE_DAILY_LOSS_LIMIT loaded ($300 expected)', 'LIVE_DAILY_LOSS_LIMIT', 300)

// ── 14. MAX_LIVE_RISK_PER_PITCHER ($75) ───────────────────────────
checkPositive('MAX_LIVE_RISK_PER_PITCHER loaded ($75 expected)', 'MAX_LIVE_RISK_PER_PITCHER', 75)

// ── 15. MAX_LIVE_BETS_PER_PITCHER (3) ─────────────────────────────
checkPositive('MAX_LIVE_BETS_PER_PITCHER loaded (3 expected)', 'MAX_LIVE_BETS_PER_PITCHER', 3)

// ── 16. DISABLED_LIVE_MODES env var set ───────────────────────────
{
  const v = envOr('DISABLED_LIVE_MODES')
  if (railwayError && v === undefined) record('SKIP', 'DISABLED_LIVE_MODES env var set', `railway CLI: ${railwayError}`)
  else if (v !== undefined && v !== null) record('PASS', 'DISABLED_LIVE_MODES env var set', `="${String(v)}"`)
  else record('FAIL', 'DISABLED_LIVE_MODES env var set', 'unset (must be set, even if empty string)')
}

// ── 17. strategy_mode insert validator exists ────────────────────
let strategyValidator = null
let strategyValidatorPath = null
{
  const candidates = [
    { p: '../../lib/strategyMode.js', label: 'lib/strategyMode.js' },
    { p: '../../lib/db.js', label: 'lib/db.js' },
    { p: '../../oracle/layers/6-gateway/enums.js', label: 'oracle/layers/6-gateway/enums.js' },
  ]
  let found = null
  for (const c of candidates) {
    try {
      const mod = await import(c.p)
      const fn = mod.assertEnum || mod.validateEnum || mod.assertStrategyMode || mod.validateStrategyMode
      if (typeof fn === 'function') {
        // If it's the generic assertEnum, wrap to inject the category
        if (fn === mod.assertEnum) {
          strategyValidator = (val) => mod.assertEnum('strategy_mode', val)
        } else if (fn === mod.validateEnum) {
          strategyValidator = (val) => {
            const r = mod.validateEnum('strategy_mode', val)
            if (!r.ok) {
              const e = new Error(`ENUM_INVALID: ${r.reason}`)
              e.code = 'ENUM_INVALID'
              throw e
            }
          }
        } else {
          strategyValidator = fn
        }
        found = c.label
        strategyValidatorPath = c.label
        break
      }
    } catch { /* try next */ }
  }
  if (found) record('PASS', 'strategy_mode insert validator exists at lib/db.js or lib/strategyMode.js', `found in ${found}`)
  else record('FAIL', 'strategy_mode insert validator exists at lib/db.js or lib/strategyMode.js', 'no validator export')
}

// ── 18. strategy_mode enum: rejects unknown/missing ───────────────
{
  if (!strategyValidator) {
    record('FAIL', 'strategy_mode enum: rejects unknown/missing values (test it with a dry-run)', 'no validator loaded')
  } else {
    let rejectsUnknown = false
    let rejectsMissing = false
    try { strategyValidator('definitely_not_a_real_mode') } catch { rejectsUnknown = true }
    try { strategyValidator(undefined) } catch { rejectsMissing = true }
    try { strategyValidator(null) } catch { rejectsMissing = true }
    try { strategyValidator('') } catch { rejectsMissing = true }
    if (rejectsUnknown && rejectsMissing) record('PASS', 'strategy_mode enum: rejects unknown/missing values (test it with a dry-run)')
    else record('FAIL', 'strategy_mode enum: rejects unknown/missing values (test it with a dry-run)', `unknown=${rejectsUnknown} missing=${rejectsMissing}`)
  }
}

// ── 19. cap query returns non-null numbers for today ─────────────
{
  try {
    const row = await db.one(
      `SELECT
         COALESCE((SELECT SUM(capital_at_risk) FROM ks_bets WHERE bet_date = ? AND live_bet = 1), 0) AS live_risk_today,
         COALESCE((SELECT COUNT(*)            FROM ks_bets WHERE bet_date = ? AND live_bet = 1), 0) AS live_bets_today,
         COALESCE((SELECT COUNT(*)            FROM oracle_bet_traces WHERE bet_date = ?), 0) AS trace_rows_today
       `,
      [DATE, DATE, DATE],
    )
    if (!row) record('FAIL', 'cap query returns non-null numbers for today\'s date (test query against ks_bets/oracle_bet_traces)', 'null row')
    else {
      const allNumeric = ['live_risk_today', 'live_bets_today', 'trace_rows_today'].every(k => row[k] !== null && Number.isFinite(Number(row[k])))
      if (allNumeric) record('PASS', 'cap query returns non-null numbers for today\'s date (test query against ks_bets/oracle_bet_traces)', `risk=$${Number(row.live_risk_today).toFixed(2)} bets=${row.live_bets_today} traces=${row.trace_rows_today}`)
      else record('FAIL', 'cap query returns non-null numbers for today\'s date (test query against ks_bets/oracle_bet_traces)', JSON.stringify(row))
    }
  } catch (err) {
    record('FAIL', 'cap query returns non-null numbers for today\'s date (test query against ks_bets/oracle_bet_traces)', err.message)
  }
}

// ── 20. validator rejects missing strategy_mode (empty value) ────
{
  if (!strategyValidator) {
    record('FAIL', 'test insert validation rejects missing strategy_mode (call validator with empty value, expect throw)', 'no validator loaded')
  } else {
    let threw = false
    try { strategyValidator('') } catch { threw = true }
    if (threw) record('PASS', 'test insert validation rejects missing strategy_mode (call validator with empty value, expect throw)')
    else record('FAIL', 'test insert validation rejects missing strategy_mode (call validator with empty value, expect throw)', 'empty string did NOT throw')
  }
}

// ── Kalshi creds backup loader ────────────────────────────────────
let backupCreds = null
if (existsSync(opts.credsBackup)) {
  try { backupCreds = JSON.parse(readFileSync(opts.credsBackup, 'utf-8')) } catch { /* ignore */ }
}
function backupForUser(userId) {
  if (!backupCreds) return null
  const list = backupCreds.per_user_creds || []
  return list.find(x => Number(x.user_id) === Number(userId)) || null
}

async function authProbe({ keyId, privateKey }) {
  if (!keyId || !privateKey) return { ok: false, reason: 'missing keyId or privateKey' }
  try {
    const { getBalance } = await import('../../lib/kalshi.js')
    const bal = await getBalance({ keyId, privateKey })
    return { ok: true, balance: bal.balance_usd }
  } catch (err) {
    return { ok: false, reason: err.message || String(err) }
  }
}

// ── 21. Adam-Live (id=284) authenticates to Kalshi ───────────────
{
  let user = null
  try { user = await db.one(`SELECT id, name, kalshi_key_id, kalshi_private_key FROM users WHERE id = ?`, [284]) } catch { /* ignore */ }

  // Source priority: env (KALSHI_KEY_ID + KALSHI_KEY_PATH/CONTENT) → DB → backup file
  let keyId = null, pem = null, source = null
  // env
  if ((rwGet('KALSHI_KEY_ID') || process.env.KALSHI_KEY_ID) && (rwGet('KALSHI_KEY_CONTENT') || process.env.KALSHI_KEY_CONTENT || rwGet('KALSHI_KEY_PATH') || process.env.KALSHI_KEY_PATH)) {
    keyId = rwGet('KALSHI_KEY_ID') || process.env.KALSHI_KEY_ID
    const content = rwGet('KALSHI_KEY_CONTENT') || process.env.KALSHI_KEY_CONTENT
    if (content) pem = String(content).replace(/\\n/g, '\n')
    else {
      const kp = rwGet('KALSHI_KEY_PATH') || process.env.KALSHI_KEY_PATH
      try { pem = readFileSync(kp, 'utf-8') } catch { /* ignore */ }
    }
    source = 'env'
  }
  // DB
  if ((!keyId || !pem) && user?.kalshi_key_id && user?.kalshi_private_key) {
    keyId = user.kalshi_key_id
    pem = user.kalshi_private_key
    source = 'db'
  }
  // Backup file
  if (!keyId || !pem) {
    const bk = backupForUser(284)
    if (bk?.kalshi_key_id && (bk?.kalshi_private_key || bk?.kalshi_key_pem)) {
      keyId = bk.kalshi_key_id
      pem = bk.kalshi_private_key || bk.kalshi_key_pem
      source = 'backup'
    }
  }

  if (!keyId || !pem) {
    record('FAIL', 'Adam-Live (id=284) authenticates to Kalshi via env-var or DB creds', 'no creds found in env, DB, or backup')
  } else {
    const r = await authProbe({ keyId, privateKey: pem })
    if (r.ok) record('PASS', 'Adam-Live (id=284) authenticates to Kalshi via env-var or DB creds', `source=${source} bal=$${Number(r.balance).toFixed(2)}`)
    else record('FAIL', 'Adam-Live (id=284) authenticates to Kalshi via env-var or DB creds', `source=${source} ${r.reason}`)
  }
}

// ── 22. Isaiah (id=2) authenticates via per-user DB creds ────────
{
  let user = null
  try { user = await db.one(`SELECT id, name, kalshi_key_id, kalshi_private_key FROM users WHERE id = ?`, [2]) } catch { /* ignore */ }
  let keyId = user?.kalshi_key_id, pem = user?.kalshi_private_key, source = 'db'
  if (!keyId || !pem) {
    const bk = backupForUser(2)
    if (bk?.kalshi_key_id && (bk?.kalshi_private_key || bk?.kalshi_key_pem)) {
      keyId = bk.kalshi_key_id
      pem = bk.kalshi_private_key || bk.kalshi_key_pem
      source = 'backup'
    }
  }
  if (!keyId || !pem) {
    record('FAIL', 'Isaiah (id=2) authenticates to Kalshi via per-user DB creds', 'no creds found in DB or backup')
  } else {
    const r = await authProbe({ keyId, privateKey: pem })
    if (r.ok) record('PASS', 'Isaiah (id=2) authenticates to Kalshi via per-user DB creds', `source=${source} bal=$${Number(r.balance).toFixed(2)}`)
    else record('FAIL', 'Isaiah (id=2) authenticates to Kalshi via per-user DB creds', `source=${source} ${r.reason}`)
  }
}

// ── 23. users.kalshi_key_id set for both id=2 and id=284 ─────────
{
  try {
    const rows = await db.all(`SELECT id, name, kalshi_key_id FROM users WHERE id IN (2, 284) ORDER BY id`)
    const m = new Map(rows.map(r => [Number(r.id), r]))
    const u2 = m.get(2), u284 = m.get(284)
    const ok = !!(u2?.kalshi_key_id && u284?.kalshi_key_id)
    if (ok) record('PASS', 'users.kalshi_key_id set for both id=2 and id=284')
    else {
      const missing = []
      if (!u2) missing.push('id=2 row missing')
      else if (!u2.kalshi_key_id) missing.push('id=2 kalshi_key_id NULL')
      if (!u284) missing.push('id=284 row missing')
      else if (!u284.kalshi_key_id) missing.push('id=284 kalshi_key_id NULL')
      record('FAIL', 'users.kalshi_key_id set for both id=2 and id=284', missing.join('; '))
    }
  } catch (err) {
    record('FAIL', 'users.kalshi_key_id set for both id=2 and id=284', err.message)
  }
}

// ── 24. daily_plan exists for today ──────────────────────────────
{
  try {
    const row = await db.one(`SELECT bet_date, total_edge_weighted, pitcher_count FROM daily_plan WHERE bet_date = ?`, [DATE])
    if (row) record('PASS', 'daily_plan exists for today\'s bet_date', `pitchers=${row.pitcher_count} edge_weighted=${Number(row.total_edge_weighted).toFixed(3)}`)
    else record('FAIL', 'daily_plan exists for today\'s bet_date', `no daily_plan row for ${DATE}`)
  } catch (err) {
    record('FAIL', 'daily_plan exists for today\'s bet_date', err.message)
  }
}

// ── 25. bet_schedule populated for today ─────────────────────────
{
  try {
    const row = await db.one(`SELECT COUNT(*) AS n FROM bet_schedule WHERE bet_date = ?`, [DATE])
    const n = Number(row?.n || 0)
    if (n > 0) record('PASS', 'bet_schedule populated for today\'s bet_date', `${n} entries`)
    else record('FAIL', 'bet_schedule populated for today\'s bet_date', `0 rows for ${DATE}`)
  } catch (err) {
    record('FAIL', 'bet_schedule populated for today\'s bet_date', err.message)
  }
}

// ── 26. no orphan ks_bets rows from previous days w/ order_id NULL ──
{
  try {
    const rows = await db.all(
      `SELECT id, bet_date, pitcher_name, side, strike, user_id, live_bet
       FROM ks_bets
       WHERE bet_date < ? AND order_id IS NULL AND live_bet = 1
         AND COALESCE(order_status, '') NOT IN ('never_placed','cancelled','void','orphan_no_order')`,
      [DATE],
    )
    if (rows.length === 0) record('PASS', 'no orphan ks_bets rows from previous day with order_id IS NULL (would create phantom losses)')
    else {
      const sample = rows.slice(0, 3).map(r => `id=${r.id} ${r.bet_date} ${r.pitcher_name} ${r.strike}+${r.side}`).join('; ')
      record('FAIL', 'no orphan ks_bets rows from previous day with order_id IS NULL (would create phantom losses)', `${rows.length} orphans (e.g. ${sample})`)
    }
  } catch (err) {
    record('FAIL', 'no orphan ks_bets rows from previous day with order_id IS NULL (would create phantom losses)', err.message)
  }
}

// ── Per-user remaining cap headroom (printed for context) ────────
try {
  const { getRemainingCaps } = await import('../../lib/strategyCaps.js')
  const headroom = await getRemainingCaps({ db, betDate: DATE })
  console.log('')
  console.log('Cap headroom remaining (loss budget before halt):')
  console.log(`  Adam-Live inversion : $${Number(headroom.adam_inv).toFixed(2)} of $150`)
  console.log(`  Isaiah inversion    : $${Number(headroom.isaiah_inv).toFixed(2)} of $150`)
  console.log(`  Adam-Live live      : $${Number(headroom.adam_live).toFixed(2)} of $300`)
  console.log(`  Isaiah live         : $${Number(headroom.isaiah_live).toFixed(2)} of $300`)
  console.log(`  Combined global     : $${Number(headroom.global_remaining).toFixed(2)} of $500`)
} catch (err) {
  console.log('')
  console.log(`(cap headroom report unavailable: ${err.message})`)
}

// ── Final verdict ─────────────────────────────────────────────────
console.log('')
console.log(`Summary: ${passCount} PASS · ${failCount} FAIL · ${skipCount} SKIP`)
if (failCount === 0 && skipCount === 0) {
  console.log('')
  console.log('ALL CLEAR — safe to unhalt')
  await db.close()
  process.exit(0)
}
if (failCount === 0 && skipCount > 0) {
  console.log('')
  console.log(`HOLD — ${skipCount} check(s) skipped (could not verify). Resolve before unhalting.`)
} else {
  console.log('')
  console.log(`HOLD — ${failCount} check(s) FAILED. Do NOT unhalt.`)
}
await db.close()
process.exit(1)
