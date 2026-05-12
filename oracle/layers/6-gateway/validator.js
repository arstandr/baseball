// oracle/layers/6-gateway/validator.js
//
// Layer 6: Gateway — pure validation pipeline for /gateway/place intents.
//
// Runs the full §4 reject ladder in cheap-first order. Returns either
//   { ok: true, agent, decision, account, accountState, idempotency: {state, cached?}, killswitch }
// or
//   { ok: false, reject_reason, context }
//
// IO is injected via the `loaders` object so the validator stays trivially
// unit-testable. The route handler around this is responsible for:
//   * loading the killswitch snapshot from the cache (passed in)
//   * Trace writeSync (intent) AFTER validation succeeds
//   * Exchange call
//   * Trace writeSync (result) and idempotency cache write

import {
  AGENTS,
  validateEnum,
} from './enums.js'

// Sub-reasons for HMAC_INVALID rejects. Public reject_reason is always
// HMAC_INVALID (don't leak which auth check failed); internal Trace event
// carries the sub-cause for debugging. Mirrors INTERNAL_REASONS in enums.js.
const IR = Object.freeze({
  MISSING_HEADER:        'MISSING_HEADER',
  AGENT_UNKNOWN:         'AGENT_UNKNOWN',
  STALE_TIMESTAMP:       'STALE_TIMESTAMP',
  BODY_HASH_MISMATCH:    'BODY_HASH_MISMATCH',
  NO_SECRET_FOR_AGENT:   'NO_SECRET_FOR_AGENT',
  SIG_MISMATCH:          'SIG_MISMATCH',
  NONCE_REPLAYED:        'NONCE_REPLAYED',
})
import {
  sha256Hex,
  verifySignature,
  isTimestampFresh,
  checkBodyHash,
} from './hmac.js'

const REQUIRED_HEADERS = [
  'x-gateway-agent',
  'x-gateway-agent-version',
  'x-gateway-commit',
  'x-gateway-timestamp',
  'x-gateway-nonce',
  'x-gateway-body-sha256',
  'x-gateway-signature',
]

const REQUIRED_BODY_PLACE = [
  'decision_id',
  'decision_input_hash',
  'trace_event_type',
  'account_id',
  'execution_mode',
  'strategy_mode',
  'market_ticker',
  'action',
  'contract_side',
  'order_type',
  'time_in_force',
  'quantity',
  'pitcher_id',
  'pitcher_name',
  'bet_date',
  'strike',
  'bet_amount_usd',
]

const ENUM_BODY_FIELDS = [
  ['execution_mode',  'execution_mode'],
  ['strategy_mode',   'strategy_mode'],
  ['action',          'action'],
  ['contract_side',   'contract_side'],
  ['order_type',      'order_type'],
  ['time_in_force',   'time_in_force'],
]

const STATE_FRESH_LIMIT_MS_MLB    = 20_000
const STATE_FRESH_LIMIT_MS_QUOTE  = 10_000
const DECISION_FRESH_LIMIT_MS_LIVE    = 30_000
const DECISION_FRESH_LIMIT_MS_PREGAME = 5 * 60_000
const DECISION_AGE_WARN_MS_LIVE       = 15_000           // emit DECISION_AGE_HIGH warning
const ACCOUNT_STATE_STALE_LIMIT_MS_LIVE    = 60_000      // 60s for live trades
const ACCOUNT_STATE_STALE_LIMIT_MS_PREGAME = 10 * 60_000 // 10min for pregame trades

function reject(reject_reason, context = {}) {
  return { ok: false, reject_reason, context }
}

// Pure semver compare with prerelease handling.
//   0.7.3 < 0.8.0      → true
//   0.7.3 < 0.7.3      → false
//   0.7.3-rc1 < 0.7.3  → true   (prerelease lower than corresponding GA)
//   0.7.3 < 0.7.3-rc1  → false
//   0.7.3-rc1 < 0.7.3-rc2  → true
//
// Locked: prerelease versions never satisfy a GA version floor — operator
// must allowlist the specific commit_hash to ship an RC against a floor.
export function semverLt(a, b) {
  const parse = s => {
    const [core, pre] = String(s).split('-', 2)
    return {
      parts: core.split('.').map(n => parseInt(n, 10) || 0),
      pre: pre ?? null,
    }
  }
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < Math.max(pa.parts.length, pb.parts.length); i++) {
    const ai = pa.parts[i] ?? 0
    const bi = pb.parts[i] ?? 0
    if (ai < bi) return true
    if (ai > bi) return false
  }
  // Cores equal — prerelease handling
  if (pa.pre === null && pb.pre === null) return false
  if (pa.pre !== null && pb.pre === null) return true   // RC < GA
  if (pa.pre === null && pb.pre !== null) return false  // GA > RC
  // Both have prerelease tags → lexical compare
  return pa.pre < pb.pre
}

function parseIsoToMs(iso) {
  const t = new Date(iso).getTime()
  return Number.isFinite(t) ? t : NaN
}

export async function validatePlaceIntent(input) {
  const {
    headers,
    rawBody,
    body,
    agentSecrets = {},
    killswitch,
    loaders,
    now = Date.now(),
    tradingDate,
    halted = false,
  } = input

  if (!killswitch) return reject('DB_DOWN', { reason: 'killswitch_missing' })
  if (!loaders) return reject('DB_DOWN', { reason: 'loaders_missing' })

  // Halt fast-path
  if (halted) return reject('GATEWAY_HALTED', {})

  // ── 1. Required headers ────────────────────────────────────────────────
  for (const h of REQUIRED_HEADERS) {
    if (!headers || !headers[h]) {
      return reject('HMAC_INVALID', { internal_reason: IR.MISSING_HEADER, header: h })
    }
  }

  const agent = headers['x-gateway-agent']

  // ── 2. Agent must be in canonical registry ─────────────────────────────
  // Public reject is HMAC_INVALID (don't leak which agents exist); internal
  // Trace will record AGENT_UNKNOWN for debugging.
  if (!AGENTS.includes(agent)) {
    return reject('HMAC_INVALID', { internal_reason: IR.AGENT_UNKNOWN, agent })
  }

  // ── 3. Timestamp freshness ─────────────────────────────────────────────
  if (!isTimestampFresh(headers['x-gateway-timestamp'], now)) {
    return reject('HMAC_INVALID', { internal_reason: IR.STALE_TIMESTAMP })
  }

  // ── 4. Body hash header matches recomputed sha256(rawBody) ─────────────
  if (!checkBodyHash(rawBody, headers['x-gateway-body-sha256'])) {
    return reject('HMAC_INVALID', { internal_reason: IR.BODY_HASH_MISMATCH })
  }

  // ── 5. HMAC signature ──────────────────────────────────────────────────
  const secret = agentSecrets[agent]
  if (!secret) return reject('HMAC_INVALID', { internal_reason: IR.NO_SECRET_FOR_AGENT, agent })

  const sigOk = verifySignature({
    secret,
    timestamp: headers['x-gateway-timestamp'],
    nonce: headers['x-gateway-nonce'],
    bodySha256: headers['x-gateway-body-sha256'],
    signature: headers['x-gateway-signature'],
  })
  if (!sigOk) return reject('HMAC_INVALID', { internal_reason: IR.SIG_MISMATCH })

  // ── 6. Body shape + required fields ────────────────────────────────────
  if (!body || typeof body !== 'object') {
    return reject('BODY_INVALID', { reason: 'body_not_object' })
  }
  for (const f of REQUIRED_BODY_PLACE) {
    if (body[f] == null) return reject('BODY_INVALID', { reason: 'missing_field', field: f })
  }

  // ── 7. Enum validation on body string fields ───────────────────────────
  for (const [cat, field] of ENUM_BODY_FIELDS) {
    const r = validateEnum(cat, body[field])
    if (!r.ok) {
      return reject('ENUM_INVALID', { category: cat, value: body[field], reason: r.reason })
    }
  }

  // limit_price_cents required for limit orders (it's a missing field, not bad enum)
  if (body.order_type === 'limit' && body.limit_price_cents == null) {
    return reject('BODY_INVALID', { reason: 'missing_field', field: 'limit_price_cents' })
  }

  const isPregame = body.strategy_mode === 'pregame_model'

  // ── 8. State freshness (live modes only — pregame doesn't track MLB/quote ages) ─
  if (!isPregame) {
    const ev = body.evidence ?? {}
    const mlbTs = Number(ev.mlb_state_ts)
    const qTs   = Number(ev.kalshi_quote_ts)
    const mlbAge = Number.isFinite(mlbTs) ? now - mlbTs : Infinity
    const qAge   = Number.isFinite(qTs)   ? now - qTs   : Infinity
    if (mlbAge > STATE_FRESH_LIMIT_MS_MLB) {
      return reject('STATE_STALE_MLB', { age_ms: mlbAge, limit_ms: STATE_FRESH_LIMIT_MS_MLB })
    }
    if (qAge > STATE_FRESH_LIMIT_MS_QUOTE) {
      return reject('STATE_STALE_QUOTE', { age_ms: qAge, limit_ms: STATE_FRESH_LIMIT_MS_QUOTE })
    }
  }

  // ── 9. Nonce uniqueness (DB write — INSERT or fail) ────────────────────
  try {
    await loaders.insertNonce(headers['x-gateway-nonce'], agent, now)
  } catch (err) {
    return reject('HMAC_INVALID', {
      internal_reason: IR.NONCE_REPLAYED,
      detail: err?.message?.slice(0, 100),
    })
  }

  // ── 10. Killswitches (cached) ─────────────────────────────────────────
  if (killswitch.gateway_kill_all === true) return reject('KILLSWITCH_ALL', {})
  if ((killswitch.gateway_kill_agent ?? []).includes(agent)) {
    return reject('KILLSWITCH_AGENT', { agent })
  }
  if ((killswitch.gateway_kill_mode ?? []).includes(body.strategy_mode)) {
    return reject('KILLSWITCH_MODE', { strategy_mode: body.strategy_mode })
  }
  if ((killswitch.gateway_kill_account ?? []).includes(body.account_id)) {
    return reject('KILLSWITCH_ACCOUNT', { account_id: body.account_id })
  }

  // ── 11. Version floor + monitor-only-stale escape hatch ────────────────
  const minV = killswitch.min_version_by_agent?.[agent]
  const agentV = headers['x-gateway-agent-version']
  if (minV && semverLt(agentV, minV)) {
    const monitorOnly = killswitch.monitor_only_stale_agent?.[agent] === true
    const isShadow = body.execution_mode === 'shadow'
    if (!isShadow || !monitorOnly) {
      return reject('VERSION_BELOW_MIN', {
        version: agentV,
        min_version: minV,
        monitor_only_stale_agent: monitorOnly,
        execution_mode: body.execution_mode,
      })
    }
    // shadow + monitor_only=true → allowed despite stale version
  }

  // ── 12. Commit allowlist (when configured for this agent) ──────────────
  const allowedHashes = killswitch.allowed_commit_hash_by_agent?.[agent]
  if (Array.isArray(allowedHashes) && allowedHashes.length > 0) {
    if (!allowedHashes.includes(headers['x-gateway-commit'])) {
      return reject('COMMIT_NOT_ALLOWED', { commit: headers['x-gateway-commit'] })
    }
  }

  // ── 13. Per-mode order USD cap ─────────────────────────────────────────
  const usdLimit = killswitch.max_order_usd_by_mode?.[body.strategy_mode]
  if (typeof usdLimit === 'number' && body.bet_amount_usd > usdLimit) {
    return reject('ORDER_USD_OVER_LIMIT', {
      bet_amount_usd: body.bet_amount_usd,
      limit_usd: usdLimit,
      strategy_mode: body.strategy_mode,
    })
  }

  // ── 14. Account exists + enabled ───────────────────────────────────────
  const account = await loaders.loadAccount(body.account_id)
  if (!account || account.enabled !== 1) {
    return reject('ACCOUNT_UNKNOWN', { account_id: body.account_id })
  }

  // ── 15. Account daily state (materialized; staleness + loss + risk) ────
  // Live trades require <= 60s old state. Pregame allows <= 10min (the
  // settlement updater runs less aggressively pre-game, and we don't want
  // brief lag to false-reject pregame intents). Shadow mirrors the
  // corresponding production window so V1 results stay honest.
  const acctState = await loaders.loadAccountState(body.account_id, tradingDate)
  if (!acctState) return reject('ACCOUNT_STATE_STALE', { reason: 'missing_row' })
  const updatedAtMs = parseIsoToMs(acctState.updated_at)
  const accountStateLimitMs = isPregame
    ? ACCOUNT_STATE_STALE_LIMIT_MS_PREGAME
    : ACCOUNT_STATE_STALE_LIMIT_MS_LIVE
  if (!Number.isFinite(updatedAtMs) || (now - updatedAtMs) > accountStateLimitMs) {
    return reject('ACCOUNT_STATE_STALE', {
      age_ms: Number.isFinite(updatedAtMs) ? now - updatedAtMs : null,
      limit_ms: accountStateLimitMs,
      strategy_mode: body.strategy_mode,
    })
  }

  const lossLimit =
    typeof acctState.daily_loss_limit_usd === 'number'
      ? acctState.daily_loss_limit_usd
      : killswitch.daily_loss_limit_by_account?.[body.account_id]
  if (typeof lossLimit === 'number') {
    const projectedLoss = -((acctState.realized_pnl_usd ?? 0) + (acctState.open_risk_usd ?? 0))
    if (projectedLoss > lossLimit) {
      return reject('ACCOUNT_DAILY_LOSS_BREACHED', {
        realized_pnl_usd: acctState.realized_pnl_usd,
        open_risk_usd: acctState.open_risk_usd,
        limit_usd: lossLimit,
      })
    }
  }

  const riskLimit =
    typeof acctState.daily_risk_limit_usd === 'number'
      ? acctState.daily_risk_limit_usd
      : killswitch.daily_risk_limit_by_account?.[body.account_id]
  if (typeof riskLimit === 'number') {
    if ((acctState.submitted_order_usd ?? 0) + body.bet_amount_usd > riskLimit) {
      return reject('ACCOUNT_DAILY_RISK_BREACHED', {
        submitted_order_usd: acctState.submitted_order_usd,
        adding_usd: body.bet_amount_usd,
        limit_usd: riskLimit,
      })
    }
  }

  // ── 16. Decision Trace event lookup ────────────────────────────────────
  const decision = await loaders.loadDecisionEvent(body.decision_id)
  if (!decision) return reject('DECISION_NOT_FOUND', { decision_id: body.decision_id })

  // ── 17. Decision agent must match submitter ────────────────────────────
  // Layer 0's oracle_trace_events table uses `agent_id`. We accept either
  // `agent_id` (canonical, from real Trace events) or `agent_name` (back-compat
  // for older mocks/tests) to avoid forcing every test fixture to update.
  const decisionAgent = decision.agent_id ?? decision.agent_name
  if (decisionAgent !== agent) {
    return reject('DECISION_AGENT_MISMATCH', {
      decision_agent: decisionAgent,
      request_agent: agent,
    })
  }

  // ── 18. Decision freshness ─────────────────────────────────────────────
  const decisionAt = parseIsoToMs(decision.created_at)
  const decisionAge = Number.isFinite(decisionAt) ? now - decisionAt : Infinity
  const decisionLimit = isPregame ? DECISION_FRESH_LIMIT_MS_PREGAME : DECISION_FRESH_LIMIT_MS_LIVE
  if (decisionAge > decisionLimit) {
    return reject('DECISION_STALE', {
      age_ms: decisionAge,
      limit_ms: decisionLimit,
      strategy_mode: body.strategy_mode,
    })
  }

  // Warning: live decision burned 50%+ of the freshness budget. Doesn't
  // reject — the orchestrator emits a Trace warn event so we can spot
  // callers that consistently submit late-binding intents.
  const warnings = []
  if (!isPregame && decisionAge > DECISION_AGE_WARN_MS_LIVE) {
    warnings.push({
      code: 'DECISION_AGE_HIGH',
      age_ms: decisionAge,
      warn_threshold_ms: DECISION_AGE_WARN_MS_LIVE,
      reject_threshold_ms: decisionLimit,
    })
  }

  // ── 19. Idempotency check ──────────────────────────────────────────────
  const existing = await loaders.loadIdempotency(body.decision_id)
  let idempotency = { state: 'fresh' }
  if (existing) {
    const incomingHash = sha256Hex(rawBody)
    if (existing.body_hash === incomingHash) {
      // Normalize replay payload so orchestrator doesn't infer from raw row
      idempotency = {
        state: 'replay',
        last_status: existing.last_status ?? null,
        kalshi_order_id: existing.kalshi_order_id ?? null,
        exchange_status: existing.exchange_status ?? null,
        response_json: existing.response_json ?? null,
        cached: existing,
      }
    } else {
      return reject('IDEMPOTENCY_CONFLICT', {
        existing_status: existing.last_status,
        existing_body_hash_prefix: String(existing.body_hash).slice(0, 12),
        incoming_body_hash_prefix: incomingHash.slice(0, 12),
      })
    }
  }

  return {
    ok: true,
    agent,
    decision,
    account,
    accountState: acctState,
    idempotency,
    warnings,
    killswitch,
  }
}
