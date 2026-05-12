// scripts/tests/oracleGatewayEnumsTest.js
//
// Tests for oracle/layers/6-gateway/enums.js — the canonical enum registry
// that gates every Gateway field at intent time and at admin time.
//
// Run: node scripts/tests/oracleGatewayEnumsTest.js

import {
  STRATEGY_MODES,
  EXECUTION_MODES,
  ACTIONS,
  CONTRACT_SIDES,
  ORDER_TYPES,
  TIME_IN_FORCE,
  AGENTS,
  REJECT_REASONS,
  INTERNAL_REASONS,
  WARNING_CODES,
  STATUSES,
  EXCHANGE_STATUSES,
  KILLSWITCH_KEYS,
  validateEnum,
  assertEnum,
  listEnum,
  listCategories,
  GATEWAY_ENUMS_VERSION,
} from '../../oracle/layers/6-gateway/enums.js'

let _passed = 0
let _failed = 0

function eq(actual, expected, label) {
  if (actual === expected) _passed++
  else { _failed++; console.error(`FAIL [${label}]: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`) }
}
function ok(cond, label) {
  if (cond) _passed++
  else { _failed++; console.error(`FAIL [${label}]: condition false`) }
}
function expectThrows(fn, code, label) {
  try { fn(); _failed++; console.error(`FAIL [${label}]: expected throw, got none`) }
  catch (err) {
    if (code === undefined || err.code === code) _passed++
    else { _failed++; console.error(`FAIL [${label}]: expected code ${code}, got ${err.code} (${err.message})`) }
  }
}
function section(name) { console.log(`\n── ${name} ──`) }

// ─── Registry membership — known values pass ─────────────────────────────
section('Known values pass validateEnum')
ok(validateEnum('strategy_mode', 'pregame_model').ok, 'strategy_mode pregame_model')
ok(validateEnum('strategy_mode', 'closer_legacy').ok, 'strategy_mode closer_legacy')
ok(validateEnum('strategy_mode', 'oracle_judge').ok, 'strategy_mode oracle_judge')
ok(validateEnum('execution_mode', 'shadow').ok, 'execution_mode shadow')
ok(validateEnum('execution_mode', 'production').ok, 'execution_mode production')
ok(validateEnum('action', 'buy').ok, 'action buy')
ok(validateEnum('action', 'sell').ok, 'action sell')
ok(validateEnum('contract_side', 'yes').ok, 'contract_side yes')
ok(validateEnum('contract_side', 'no').ok, 'contract_side no')
ok(validateEnum('order_type', 'limit').ok, 'order_type limit')
ok(validateEnum('order_type', 'market').ok, 'order_type market')
ok(validateEnum('time_in_force', 'GTC').ok, 'tif GTC')
ok(validateEnum('time_in_force', 'IOC').ok, 'tif IOC')
ok(validateEnum('time_in_force', 'FOK').ok, 'tif FOK')
ok(validateEnum('agent', 'closer-legacy').ok, 'agent closer-legacy')
ok(validateEnum('agent', 'oracle').ok, 'agent oracle')
ok(validateEnum('agent', 'gateway-probe-agent').ok, 'agent gateway-probe-agent')
ok(validateEnum('reject_reason', 'HMAC_INVALID').ok, 'reject HMAC_INVALID')
ok(validateEnum('status', 'accepted').ok, 'status accepted')
ok(validateEnum('exchange_status', 'placed').ok, 'exchange_status placed')
ok(validateEnum('killswitch_key', 'gateway_kill_all').ok, 'killswitch_key gateway_kill_all')

// ─── Unknown values rejected with informative reason ─────────────────────
section('Unknown values rejected')
{
  const r = validateEnum('strategy_mode', 'live_yes')  // common typo
  ok(!r.ok, 'strategy_mode typo "live_yes" rejected')
  ok(r.reason.includes('not_in_enum'), 'reason includes not_in_enum')
}
{
  const r = validateEnum('execution_mode', 'PRODUCTION')  // case mismatch
  ok(!r.ok, 'execution_mode case-mismatch rejected')
}
{
  const r = validateEnum('agent', 'closer')  // missing -legacy suffix
  ok(!r.ok, 'agent partial-match rejected')
}
{
  const r = validateEnum('time_in_force', 'gtc')  // lowercase
  ok(!r.ok, 'tif lowercase rejected')
}

// ─── Unknown categories ─────────────────────────────────────────────────
section('Unknown categories')
{
  const r = validateEnum('side', 'yes')  // there is no 'side' — only contract_side
  ok(!r.ok, 'unknown category "side" rejected')
  ok(r.reason.includes('unknown_category'), 'reason includes unknown_category')
}

// ─── Non-string values ──────────────────────────────────────────────────
section('Non-string values rejected')
{
  const r = validateEnum('action', 1)
  ok(!r.ok, 'numeric value rejected')
  ok(r.reason.includes('non_string'), 'reason mentions non-string')
}
ok(!validateEnum('action', null).ok, 'null rejected')
ok(!validateEnum('action', undefined).ok, 'undefined rejected')
ok(!validateEnum('action', { a: 1 }).ok, 'object rejected')
ok(!validateEnum('action', ['buy']).ok, 'array rejected')

// ─── assertEnum throws with code=ENUM_INVALID ───────────────────────────
section('assertEnum behavior')
expectThrows(() => assertEnum('strategy_mode', 'live_yes'), 'ENUM_INVALID', 'assert throws on typo')
expectThrows(() => assertEnum('action', 'BUY'), 'ENUM_INVALID', 'assert throws on case mismatch')
expectThrows(() => assertEnum('side', 'yes'), 'ENUM_INVALID', 'assert throws on bad category')
let didThrow = false
try { assertEnum('action', 'buy') } catch { didThrow = true }
ok(!didThrow, 'assertEnum does not throw on valid')

// Confirm the err includes category + value (for downstream alert context)
try { assertEnum('strategy_mode', 'oops') }
catch (err) {
  eq(err.category, 'strategy_mode', 'err.category set')
  eq(err.value, 'oops', 'err.value set')
  eq(err.code, 'ENUM_INVALID', 'err.code set')
}

// ─── listEnum + listCategories ──────────────────────────────────────────
section('listEnum + listCategories')
ok(listEnum('strategy_mode').includes('closer_legacy'), 'listEnum returns members')
ok(Object.isFrozen(listEnum('action')), 'listEnum result is frozen')
{
  const cats = listCategories()
  ok(cats.includes('strategy_mode'), 'listCategories has strategy_mode')
  ok(cats.includes('reject_reason'), 'listCategories has reject_reason')
  ok(cats.includes('killswitch_key'), 'listCategories has killswitch_key')
  ok(Object.isFrozen(cats), 'listCategories result is frozen')
}
expectThrows(() => listEnum('nonexistent'), 'UNKNOWN_CATEGORY', 'listEnum throws on bad category')

// ─── Lists are immutable ────────────────────────────────────────────────
section('Lists are immutable')
ok(Object.isFrozen(STRATEGY_MODES), 'STRATEGY_MODES frozen')
ok(Object.isFrozen(EXECUTION_MODES), 'EXECUTION_MODES frozen')
ok(Object.isFrozen(ACTIONS), 'ACTIONS frozen')
ok(Object.isFrozen(CONTRACT_SIDES), 'CONTRACT_SIDES frozen')
ok(Object.isFrozen(ORDER_TYPES), 'ORDER_TYPES frozen')
ok(Object.isFrozen(TIME_IN_FORCE), 'TIME_IN_FORCE frozen')
ok(Object.isFrozen(AGENTS), 'AGENTS frozen')
ok(Object.isFrozen(REJECT_REASONS), 'REJECT_REASONS frozen')
ok(Object.isFrozen(STATUSES), 'STATUSES frozen')
ok(Object.isFrozen(EXCHANGE_STATUSES), 'EXCHANGE_STATUSES frozen')
ok(Object.isFrozen(KILLSWITCH_KEYS), 'KILLSWITCH_KEYS frozen')

// ─── Spec §4 coverage — every documented reject_reason is in the enum ──
section('Spec §4 coverage — all reject_reasons present')
const specRejects = [
  'DB_DOWN', 'TRACE_DOWN', 'HMAC_INVALID', 'IP_NOT_ALLOWED',
  'KILLSWITCH_ALL', 'KILLSWITCH_AGENT', 'KILLSWITCH_MODE', 'KILLSWITCH_ACCOUNT',
  'VERSION_BELOW_MIN', 'COMMIT_NOT_ALLOWED', 'BODY_INVALID', 'ENUM_INVALID',
  'ACCOUNT_UNKNOWN', 'ACCOUNT_STATE_STALE',
  'ACCOUNT_DAILY_LOSS_BREACHED', 'ACCOUNT_DAILY_RISK_BREACHED',
  'ORDER_USD_OVER_LIMIT',
  'DECISION_NOT_FOUND', 'DECISION_STALE', 'DECISION_AGENT_MISMATCH',
  'STATE_STALE_MLB', 'STATE_STALE_QUOTE',
  'IDEMPOTENCY_CONFLICT', 'GATEWAY_HALTED',
]
for (const r of specRejects) ok(REJECT_REASONS.includes(r), `spec §4 reject_reason "${r}" present`)

// ─── Internal reasons (HMAC sub-causes) ────────────────────────────────
section('INTERNAL_REASONS — HMAC sub-causes registered')
const specInternal = [
  'MISSING_HEADER', 'AGENT_UNKNOWN', 'STALE_TIMESTAMP',
  'BODY_HASH_MISMATCH', 'NO_SECRET_FOR_AGENT', 'SIG_MISMATCH', 'NONCE_REPLAYED',
]
for (const ir of specInternal) ok(INTERNAL_REASONS.includes(ir), `internal_reason "${ir}" present`)
ok(Object.isFrozen(INTERNAL_REASONS), 'INTERNAL_REASONS frozen')
ok(validateEnum('internal_reason', 'STALE_TIMESTAMP').ok, 'validateEnum supports internal_reason')
ok(!validateEnum('internal_reason', 'NOT_A_REASON').ok, 'unknown internal_reason rejected')

// ─── Warning codes ──────────────────────────────────────────────────────
section('WARNING_CODES')
ok(WARNING_CODES.includes('DECISION_AGE_HIGH'), 'DECISION_AGE_HIGH present')
ok(Object.isFrozen(WARNING_CODES), 'WARNING_CODES frozen')
ok(validateEnum('warning_code', 'DECISION_AGE_HIGH').ok, 'validateEnum supports warning_code')

// ─── Spec §3 coverage — every documented status is in the enum ─────────
section('Spec §3 coverage — all statuses present')
const specStatuses = [
  'accepted', 'shadow_logged', 'rejected',
  'exchange_unknown', 'exchange_error',
  'replay', 'conflict', 'halted',
]
for (const s of specStatuses) ok(STATUSES.includes(s), `spec §3 status "${s}" present`)

// ─── Spec §8 coverage — every killswitch key is in the enum ────────────
section('Spec §8 coverage — all killswitch keys present')
const specKsKeys = [
  'gateway_kill_all', 'gateway_kill_agent', 'gateway_kill_mode', 'gateway_kill_account',
  'min_version_by_agent', 'monitor_only_stale_agent', 'allowed_commit_hash_by_agent',
  'daily_loss_limit_by_account', 'daily_risk_limit_by_account', 'max_order_usd_by_mode',
]
for (const k of specKsKeys) ok(KILLSWITCH_KEYS.includes(k), `spec §8 killswitch key "${k}" present`)

// ─── Version constant ──────────────────────────────────────────────────
section('Version constant')
eq(typeof GATEWAY_ENUMS_VERSION, 'string', 'GATEWAY_ENUMS_VERSION is string')
ok(/^\d+\.\d+\.\d+$/.test(GATEWAY_ENUMS_VERSION), 'GATEWAY_ENUMS_VERSION semver-shaped')

// ─── Realistic admin-typo scenario — silent killswitch bypass blocked ──
section('Admin-typo scenarios — what would have silently no-op\'d before')
// Old failure mode: admin sets gateway_kill_mode='live_yes' meaning to kill live_model_yes
// but the canonical name is live_model_yes — silent miss, kill never triggered
const realTypos = [
  ['strategy_mode', 'live_yes'],
  ['strategy_mode', 'free-money'],   // hyphen vs underscore
  ['strategy_mode', 'pulled-no'],
  ['strategy_mode', 'liveModelYes'], // camelCase
  ['agent', 'Closer-Legacy'],
  ['agent', 'closer_legacy'],         // underscore vs hyphen
  ['killswitch_key', 'kill_all'],     // missing prefix
  ['killswitch_key', 'gateway_killall'],
]
for (const [cat, val] of realTypos) {
  ok(!validateEnum(cat, val).ok, `typo "${val}" in ${cat} rejected`)
}

// ─── Summary ──────────────────────────────────────────────────────────
console.log(`\n${_passed} passed, ${_failed} failed`)
process.exit(_failed > 0 ? 1 : 0)
