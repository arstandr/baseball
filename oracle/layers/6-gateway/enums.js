// oracle/layers/6-gateway/enums.js
//
// Canonical enums for the Gateway. All string-typed Gateway fields validate
// against these registries — both at intent time (incoming request bodies)
// and at admin time (killswitch DB writes). Unknown values produce
// ENUM_INVALID rejects so a typo in a killswitch row can never silently
// fail to match.
//
// Locked 2026-04-30 with spec v1.0. Adding a value requires a spec bump
// and a CHANGES.md entry adjacent to spec.md.

export const STRATEGY_MODES = Object.freeze([
  'pregame_model',
  'live_model_yes',
  'live_model_no',
  'live_dead_path_no',
  'pulled_no',
  'crossed_yes',
  'free_money',
  'hedge',
  'closer_legacy',
  'oracle_judge',
])

export const EXECUTION_MODES = Object.freeze([
  'shadow',
  'production',
])

export const ACTIONS = Object.freeze(['buy', 'sell'])

export const CONTRACT_SIDES = Object.freeze(['yes', 'no'])

export const ORDER_TYPES = Object.freeze(['limit', 'market'])

export const TIME_IN_FORCE = Object.freeze(['GTC', 'IOC', 'FOK'])

export const AGENTS = Object.freeze([
  'closer-legacy',
  'oracle',
  'gateway-probe-agent',
])

export const REJECT_REASONS = Object.freeze([
  'DB_DOWN',
  'TRACE_DOWN',
  'HMAC_INVALID',
  'IP_NOT_ALLOWED',
  'KILLSWITCH_ALL',
  'KILLSWITCH_AGENT',
  'KILLSWITCH_MODE',
  'KILLSWITCH_ACCOUNT',
  'VERSION_BELOW_MIN',
  'COMMIT_NOT_ALLOWED',
  'BODY_INVALID',
  'ENUM_INVALID',
  'ACCOUNT_UNKNOWN',
  'ACCOUNT_STATE_STALE',
  'ACCOUNT_DAILY_LOSS_BREACHED',
  'ACCOUNT_DAILY_RISK_BREACHED',
  'ORDER_USD_OVER_LIMIT',
  'DECISION_NOT_FOUND',
  'DECISION_STALE',
  'DECISION_AGENT_MISMATCH',
  'STATE_STALE_MLB',
  'STATE_STALE_QUOTE',
  'IDEMPOTENCY_CONFLICT',
  'GATEWAY_HALTED',
])

// Internal-only sub-reason for HMAC_INVALID rejects. The public reject_reason
// is always HMAC_INVALID (don't leak which check failed) but the internal Trace
// reject event carries the specific sub-cause for debugging.
export const INTERNAL_REASONS = Object.freeze([
  'MISSING_HEADER',
  'AGENT_UNKNOWN',
  'STALE_TIMESTAMP',
  'BODY_HASH_MISMATCH',
  'NO_SECRET_FOR_AGENT',
  'SIG_MISMATCH',
  'NONCE_REPLAYED',
])

// Warning codes — emitted on ok=true responses when a budget-burning condition
// is observed but doesn't warrant rejection. Orchestrator writes these to
// Trace as severity=warning events.
export const WARNING_CODES = Object.freeze([
  'DECISION_AGE_HIGH',     // live decision age 15–30s
])

export const STATUSES = Object.freeze([
  'accepted',
  'shadow_logged',
  'rejected',
  'exchange_unknown',
  'exchange_error',
  'replay',
  'conflict',
  'halted',
])

export const EXCHANGE_STATUSES = Object.freeze([
  'placed',
  'rejected',
  'unknown',
  'partially_filled',
  'not_found',
])

export const KILLSWITCH_KEYS = Object.freeze([
  'gateway_kill_all',
  'gateway_kill_agent',
  'gateway_kill_mode',
  'gateway_kill_account',
  'min_version_by_agent',
  'monitor_only_stale_agent',
  'allowed_commit_hash_by_agent',
  'daily_loss_limit_by_account',
  'daily_risk_limit_by_account',
  'max_order_usd_by_mode',
])

const REGISTRY = Object.freeze({
  strategy_mode:    STRATEGY_MODES,
  execution_mode:   EXECUTION_MODES,
  action:           ACTIONS,
  contract_side:    CONTRACT_SIDES,
  order_type:       ORDER_TYPES,
  time_in_force:    TIME_IN_FORCE,
  agent:            AGENTS,
  reject_reason:    REJECT_REASONS,
  internal_reason:  INTERNAL_REASONS,
  warning_code:     WARNING_CODES,
  status:           STATUSES,
  exchange_status:  EXCHANGE_STATUSES,
  killswitch_key:   KILLSWITCH_KEYS,
})

export function validateEnum(category, value) {
  const list = REGISTRY[category]
  if (!list) return { ok: false, reason: `unknown_category:${category}` }
  if (typeof value !== 'string') return { ok: false, reason: `non_string_value:${typeof value}` }
  if (!list.includes(value)) return { ok: false, reason: `not_in_enum:${category}:${value}` }
  return { ok: true }
}

export function assertEnum(category, value) {
  const r = validateEnum(category, value)
  if (!r.ok) {
    const err = new Error(`ENUM_INVALID: ${r.reason}`)
    err.code = 'ENUM_INVALID'
    err.category = category
    err.value = value
    throw err
  }
}

export function listEnum(category) {
  const list = REGISTRY[category]
  if (!list) {
    const err = new Error(`unknown_enum_category:${category}`)
    err.code = 'UNKNOWN_CATEGORY'
    throw err
  }
  return list
}

export function listCategories() {
  return Object.freeze(Object.keys(REGISTRY))
}

export const GATEWAY_ENUMS_VERSION = '1.0.0'
