// oracle/layers/6-gateway/route.js
//
// HTTP route mount for Layer 6 Gateway. Locked design (revision):
//
// Endpoints
//   POST /gateway/place               → executePlaceIntent
//   GET  /gateway/healthz             → liveness probe + halt status
//   POST /gateway/admin/killswitch    → HMAC-protected, enum-validated kill switch updates
//   POST /gateway/admin/unhalt        → HMAC-protected operator unhalt (halt-bypass path)
//
// Locks
//   Q1 — Mounted on the existing baseball Express app. Boundary is credential
//        ownership, not network isolation.
//   Q2 — HTTP status carries transport/security meaning; body carries business:
//          accepted/shadow_logged/replay      → 200
//          policy reject (KILLSWITCH_*, ACCOUNT_*, DECISION_*, STATE_*, IDEMPOTENCY_CONFLICT,
//                         VERSION_BELOW_MIN, COMMIT_NOT_ALLOWED, ORDER_USD_OVER_LIMIT) → 200
//          HMAC_INVALID / IP_NOT_ALLOWED      → 401
//          BODY_INVALID / ENUM_INVALID        → 400
//          exchange_unknown                   → 202
//          exchange_error                     → 502
//          GATEWAY_HALTED / DB_DOWN / TRACE_DOWN → 503
//          uncaught                           → 500
//        Body shape uniform: { ok, status, reject_reason?, decision_id?, trace_event_id?, ... }
//   Q3 — Use express.raw({ type: 'application/json', limit: '1mb' }) on Gateway routes
//        only. Manually JSON.parse after capturing rawBody. Do NOT rely on a global
//        express.json() — it would discard the exact bytes HMAC needs.
//   Q4 — Same HMAC scheme as /gateway/place; separate GATEWAY_ADMIN_SECRET. Admin
//        endpoints reachable while Gateway is halted (halt-bypass).
//   Q5 — Startup readiness gate is the COMPOSER's job (buildGateway / scheduler init);
//        not implemented here.
//   Q6 — Per-component timeouts via the deps (kalshiClient timeoutMs ≤ 2000ms).
//        Route-level deadline is SOFT only in V1 — emits ROUTE_LATENCY_HIGH Trace
//        warn if total > 5s, but does NOT abort the in-flight orchestrator
//        (aborting mid-Kalshi pre-V2 risks double-place; hard abort enabled
//        when client_order_id is plumbed — see spec §10 prereq #10).
//   Q7 — Per-agent rate limit (sliding-window). Default 120/min for traders,
//        20/min for admin. Excess → 429 + ORACLE-HEALTH warn.

import {
  KILLSWITCH_KEYS,
  STRATEGY_MODES,
  AGENTS,
} from './enums.js'
import {
  verifySignature,
  isTimestampFresh,
  checkBodyHash,
} from './hmac.js'
import { executePlaceIntent } from './orchestrator.js'

// ────────────────────────────────────────────────────────────────────────
// HTTP status mapping (spec §3 + Q2)
// ────────────────────────────────────────────────────────────────────────

const POLICY_REJECT_REASONS = new Set([
  'KILLSWITCH_ALL', 'KILLSWITCH_AGENT', 'KILLSWITCH_MODE', 'KILLSWITCH_ACCOUNT',
  'VERSION_BELOW_MIN', 'COMMIT_NOT_ALLOWED',
  'ACCOUNT_UNKNOWN', 'ACCOUNT_STATE_STALE',
  'ACCOUNT_DAILY_LOSS_BREACHED', 'ACCOUNT_DAILY_RISK_BREACHED',
  'ORDER_USD_OVER_LIMIT',
  'DECISION_NOT_FOUND', 'DECISION_STALE', 'DECISION_AGENT_MISMATCH',
  'STATE_STALE_MLB', 'STATE_STALE_QUOTE',
  'IDEMPOTENCY_CONFLICT',
])

export function mapHttpStatus(result) {
  if (!result) return 500
  const s = result.status
  if (s === 'accepted' || s === 'shadow_logged' || s === 'replay') return 200
  if (s === 'exchange_unknown') return 202
  if (s === 'exchange_error') return 502
  if (s === 'halted') return 503
  if (s === 'rejected') {
    const r = result.reject_reason
    if (r === 'HMAC_INVALID' || r === 'IP_NOT_ALLOWED') return 401
    if (r === 'BODY_INVALID' || r === 'ENUM_INVALID') return 400
    if (r === 'DB_DOWN' || r === 'TRACE_DOWN' || r === 'GATEWAY_HALTED') return 503
    if (r === 'GATEWAY_INTERNAL_ERROR') return 500
    if (POLICY_REJECT_REASONS.has(r)) return 200
    return 200  // unknown reject: prefer 200 over surfacing internal class to caller
  }
  return 200
}

const OK_STATUSES = new Set(['accepted', 'shadow_logged', 'replay'])

export function shapeResponse(result, body) {
  return {
    ok: OK_STATUSES.has(result.status),
    status: result.status,
    reject_reason: result.reject_reason ?? null,
    decision_id: body?.decision_id ?? null,
    trace_event_id: result.trace_event_id_intent ?? result.trace_event_id_result ?? null,
    ...result,
  }
}

// ────────────────────────────────────────────────────────────────────────
// Per-agent sliding-window rate limit (Q7)
// ────────────────────────────────────────────────────────────────────────

export function makeRateLimiter({
  defaultLimitPerMin = 120,
  perAgentLimit = { admin: 20 },
  windowMs = 60_000,
  now = () => Date.now(),
} = {}) {
  // agent_id → array of timestamp ms within window
  const _state = new Map()

  function check(agent_id) {
    const limit = perAgentLimit[agent_id] ?? defaultLimitPerMin
    const t = now()
    const cutoff = t - windowMs
    let stamps = _state.get(agent_id) ?? []
    stamps = stamps.filter(s => s > cutoff)
    if (stamps.length >= limit) {
      _state.set(agent_id, stamps)
      return { ok: false, count: stamps.length, limit }
    }
    stamps.push(t)
    _state.set(agent_id, stamps)
    return { ok: true, count: stamps.length, limit }
  }

  return { check }
}

// ────────────────────────────────────────────────────────────────────────
// Raw-body extraction — express.raw populates req.body as a Buffer.
// Convert to req.rawBody (string) + req.body (parsed object | null).
// ────────────────────────────────────────────────────────────────────────

export function extractRawAndParse(req) {
  let rawBody = ''
  if (req.body instanceof Buffer) {
    rawBody = req.body.toString('utf-8')
  } else if (typeof req.body === 'string') {
    rawBody = req.body
  } else if (typeof req.rawBody === 'string') {
    rawBody = req.rawBody
  }
  let body = null
  if (rawBody.length === 0) {
    body = {}
  } else {
    try { body = JSON.parse(rawBody) }
    catch { body = null }
  }
  req.rawBody = rawBody
  req.body = body
  return { rawBody, body }
}

// ────────────────────────────────────────────────────────────────────────
// Admin HMAC verifier (separate secret, same scheme)
// ────────────────────────────────────────────────────────────────────────

export function verifyAdminHmac(req, secret, now = Date.now()) {
  if (!secret) return { ok: false, internal_reason: 'NO_ADMIN_SECRET_CONFIGURED' }
  const required = ['x-gateway-timestamp', 'x-gateway-nonce', 'x-gateway-body-sha256', 'x-gateway-signature']
  for (const h of required) {
    if (!req.headers[h]) return { ok: false, internal_reason: 'MISSING_HEADER', header: h }
  }
  if (!isTimestampFresh(req.headers['x-gateway-timestamp'], now)) {
    return { ok: false, internal_reason: 'STALE_TIMESTAMP' }
  }
  if (!checkBodyHash(req.rawBody, req.headers['x-gateway-body-sha256'])) {
    return { ok: false, internal_reason: 'BODY_HASH_MISMATCH' }
  }
  const valid = verifySignature({
    secret,
    timestamp: req.headers['x-gateway-timestamp'],
    nonce: req.headers['x-gateway-nonce'],
    bodySha256: req.headers['x-gateway-body-sha256'],
    signature: req.headers['x-gateway-signature'],
  })
  return valid ? { ok: true } : { ok: false, internal_reason: 'SIG_MISMATCH' }
}

// ────────────────────────────────────────────────────────────────────────
// Killswitch value validator — closes the silent-typo trap (spec §8)
// ────────────────────────────────────────────────────────────────────────

function isHexSha40(s) { return typeof s === 'string' && /^[a-f0-9]{40}$/.test(s) }
function isSemver(s)   { return typeof s === 'string' && /^\d+\.\d+\.\d+(-[a-z0-9.]+)?$/i.test(s) }

export function validateKillswitchValue(key, value) {
  if (!KILLSWITCH_KEYS.includes(key)) return { ok: false, reason: `unknown_key:${key}` }

  switch (key) {
    case 'gateway_kill_all':
      if (typeof value === 'boolean') return { ok: true }
      if (value === 'true' || value === 'false') return { ok: true }
      return { ok: false, reason: 'value_must_be_boolean_or_string_true_false' }

    case 'gateway_kill_agent':
      if (!Array.isArray(value)) return { ok: false, reason: 'value_must_be_array' }
      for (const a of value) if (!AGENTS.includes(a)) return { ok: false, reason: `not_in_agents:${a}` }
      return { ok: true }

    case 'gateway_kill_mode':
      if (!Array.isArray(value)) return { ok: false, reason: 'value_must_be_array' }
      for (const m of value) if (!STRATEGY_MODES.includes(m)) return { ok: false, reason: `not_in_strategy_modes:${m}` }
      return { ok: true }

    case 'gateway_kill_account':
      if (!Array.isArray(value)) return { ok: false, reason: 'value_must_be_array' }
      for (const a of value) if (typeof a !== 'string' || !a.length) return { ok: false, reason: 'account_must_be_non_empty_string' }
      return { ok: true }

    case 'min_version_by_agent':
      if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: 'value_must_be_object' }
      for (const [a, v] of Object.entries(value)) {
        if (!AGENTS.includes(a))   return { ok: false, reason: `not_in_agents:${a}` }
        if (!isSemver(v))          return { ok: false, reason: `not_semver:${v}` }
      }
      return { ok: true }

    case 'monitor_only_stale_agent':
      if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: 'value_must_be_object' }
      for (const [a, b] of Object.entries(value)) {
        if (!AGENTS.includes(a)) return { ok: false, reason: `not_in_agents:${a}` }
        if (typeof b !== 'boolean') return { ok: false, reason: `not_boolean:${a}` }
      }
      return { ok: true }

    case 'allowed_commit_hash_by_agent':
      if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: 'value_must_be_object' }
      for (const [a, list] of Object.entries(value)) {
        if (!AGENTS.includes(a)) return { ok: false, reason: `not_in_agents:${a}` }
        if (!Array.isArray(list)) return { ok: false, reason: `value_for_${a}_must_be_array` }
        for (const h of list) if (!isHexSha40(h)) return { ok: false, reason: `not_sha40:${h}` }
      }
      return { ok: true }

    case 'daily_loss_limit_by_account':
    case 'daily_risk_limit_by_account':
      if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: 'value_must_be_object' }
      for (const [acct, n] of Object.entries(value)) {
        if (typeof acct !== 'string' || !acct.length) return { ok: false, reason: 'account_must_be_non_empty_string' }
        if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return { ok: false, reason: `not_positive_number:${acct}` }
      }
      return { ok: true }

    case 'max_order_usd_by_mode':
      if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: 'value_must_be_object' }
      for (const [m, n] of Object.entries(value)) {
        if (!STRATEGY_MODES.includes(m)) return { ok: false, reason: `not_in_strategy_modes:${m}` }
        if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return { ok: false, reason: `not_positive_number:${m}` }
      }
      return { ok: true }

    default:
      return { ok: false, reason: `unhandled_key:${key}` }
  }
}

// ────────────────────────────────────────────────────────────────────────
// Handlers — exported so tests can call them without HTTP
// ────────────────────────────────────────────────────────────────────────

const ROUTE_LATENCY_HIGH_MS = 5_000

export function makeHandlers(deps) {
  for (const k of [
    'trace', 'kalshi', 'idempotencyStore', 'unknownsStore',
    'deadLetter', 'halt', 'killswitchCache', 'killswitchStore',
    'agentSecrets', 'loaders', 'traceAdapter',
  ]) {
    if (!deps[k]) throw new Error(`makeHandlers: deps.${k} required`)
  }
  const adminSecret = deps.adminSecret ?? process.env.GATEWAY_ADMIN_SECRET ?? null
  const tradingDateFn = deps.tradingDateFn ?? (() => new Date().toISOString().slice(0, 10))
  const now = deps.now ?? Date.now
  const rateLimiter = deps.rateLimiter ?? makeRateLimiter()
  const gatewayMode = deps.gatewayMode ?? 'shadow'
  const readiness = deps.readiness ?? null
  const startedAt = deps.startedAt ?? now()
  const commitHash = deps.commitHash ?? process.env.COMMIT_HASH ?? 'unknown'

  // ── /gateway/place ──────────────────────────────────────────────────
  async function place(req, res) {
    const t0 = now()
    extractRawAndParse(req)

    // Rate limit BEFORE any heavy work, keyed by agent header
    const agent = req.headers['x-gateway-agent'] ?? 'unknown'
    const rl = rateLimiter.check(agent)
    if (!rl.ok) {
      const body = {
        ok: false,
        status: 'rejected',
        reject_reason: 'RATE_LIMIT_EXCEEDED',
        decision_id: null,
        trace_event_id: null,
        context: { agent, count: rl.count, limit: rl.limit },
      }
      // Best-effort warn alert
      try {
        const sysT = deps.traceAdapter.forSystem({ agent_id: agent, mode: 'production' })
        deps.trace.writeAsync(sysT.makeEvent({
          decision_id: `rl-${now()}`,
          event_type: 'gateway_rate_limit',
          decision: 'reject',
          reason_code: 'RATE_LIMIT_EXCEEDED',
          reasoning: { agent, count: rl.count, limit: rl.limit },
          metrics: {},
          pitcher_id: '0', pitcher_name: 'rate_limit', bet_date: '', strike: 0, side: 'YES',
        })).catch(() => {})
      } catch { /* best-effort */ }
      return res.status(429).json(body)
    }

    try {
      // V1 shadow guard (Q-C5): if Gateway is in shadow mode, force any
      // production-execution request into shadow before the orchestrator
      // sees it. The orchestrator's shadow path then runs naturally and
      // never reaches the Kalshi client. rawBody (and HMAC body_hash) are
      // unchanged — only the parsed body's execution_mode flips.
      let bodyForOrchestrator = req.body
      if (gatewayMode === 'shadow' && req.body && req.body.execution_mode === 'production') {
        bodyForOrchestrator = { ...req.body, execution_mode: 'shadow', _shadow_forced_by_gateway_mode: true }
      }

      const reqTrace = deps.traceAdapter.forRequest({
        headers: req.headers,
        body: bodyForOrchestrator ?? {},
      })

      const result = await executePlaceIntent(
        {
          headers:     req.headers,
          rawBody:     req.rawBody,
          body:        bodyForOrchestrator,
          sourceIp:    req.ip ?? req.headers['x-forwarded-for'] ?? null,
          tradingDate: tradingDateFn(),
        },
        {
          trace:            reqTrace,
          kalshi:           deps.kalshi,
          idempotencyStore: deps.idempotencyStore,
          unknownsStore:    deps.unknownsStore,
          deadLetter:       deps.deadLetter,
          halt:             deps.halt,
          killswitchCache:  deps.killswitchCache,
          agentSecrets:     deps.agentSecrets,
          loaders:          deps.loaders,
          now,
        },
      )

      const elapsed = now() - t0
      if (elapsed > ROUTE_LATENCY_HIGH_MS) {
        try {
          const sysT = deps.traceAdapter.forSystem({ agent_id: agent, mode: 'production' })
          deps.trace.writeAsync(sysT.makeEvent({
            decision_id: req.body?.decision_id ?? `latency-${now()}`,
            event_type: 'gateway_route_latency_high',
            decision: 'warn',
            reason_code: 'ROUTE_LATENCY_HIGH',
            reasoning: { elapsed_ms: elapsed, threshold_ms: ROUTE_LATENCY_HIGH_MS },
            metrics: { latency_ms: elapsed },
            pitcher_id: String(req.body?.pitcher_id ?? '0'),
            pitcher_name: req.body?.pitcher_name ?? 'unknown',
            bet_date: req.body?.bet_date ?? '',
            strike: req.body?.strike ?? 0,
            side: (req.body?.contract_side ?? 'yes').toUpperCase(),
          })).catch(() => {})
        } catch { /* best-effort */ }
      }

      const status = mapHttpStatus(result)
      const shaped = shapeResponse(result, req.body)
      return res.status(status).json(shaped)
    } catch (err) {
      console.error('[gateway/place] uncaught:', err)
      return res.status(500).json({
        ok: false,
        status: 'rejected',
        reject_reason: 'GATEWAY_INTERNAL_ERROR',
        decision_id: req.body?.decision_id ?? null,
        trace_event_id: null,
        context: { detail: err?.message?.slice(0, 200) },
      })
    }
  }

  // ── /gateway/healthz ────────────────────────────────────────────────
  // Reports readiness state without leaking secret material. Includes mode,
  // commit, started-at, halt status, and per-component readiness flags.
  function healthz(req, res) {
    const halted = deps.halt.isHalted?.() === true
    const ready = (readiness?.ready ?? true) && !halted
    const status = ready ? 200 : 503
    return res.status(status).json({
      ok: ready,
      ready,
      halted,
      mode: gatewayMode,
      commit: commitHash,
      started_at: new Date(startedAt).toISOString(),
      now: new Date(now()).toISOString(),
      uptime_ms: now() - startedAt,
      halt_status: deps.halt.peekStatus?.() ?? null,
      readiness: readiness ?? { ready: true },  // composer fills this; default = always-ready for tests
    })
  }

  // ── /gateway/admin/killswitch ───────────────────────────────────────
  async function adminKillswitch(req, res) {
    extractRawAndParse(req)

    const rl = rateLimiter.check('admin')
    if (!rl.ok) {
      return res.status(429).json({
        ok: false, status: 'rejected', reject_reason: 'RATE_LIMIT_EXCEEDED',
        decision_id: null, trace_event_id: null,
        context: { agent: 'admin', count: rl.count, limit: rl.limit },
      })
    }

    const auth = verifyAdminHmac(req, adminSecret, now())
    if (!auth.ok) {
      return res.status(401).json({
        ok: false, status: 'rejected', reject_reason: 'HMAC_INVALID',
        decision_id: null, trace_event_id: null,
        context: { internal_reason: auth.internal_reason },
      })
    }

    const { key, value, updated_by, reason } = req.body ?? {}
    if (!key || updated_by == null) {
      return res.status(400).json({
        ok: false, status: 'rejected', reject_reason: 'BODY_INVALID',
        decision_id: null, trace_event_id: null,
        context: { reason: 'missing_field', missing: !key ? 'key' : 'updated_by' },
      })
    }

    const valid = validateKillswitchValue(key, value)
    if (!valid.ok) {
      return res.status(400).json({
        ok: false, status: 'rejected', reject_reason: 'ENUM_INVALID',
        decision_id: null, trace_event_id: null,
        context: { key, reason: valid.reason },
      })
    }

    try {
      const priorRows = await deps.killswitchCache.get()
      const priorValue = priorRows?.[key] ?? null

      await deps.killswitchStore.set(key, value, updated_by)
      deps.killswitchCache.invalidate?.()

      try {
        const sysT = deps.traceAdapter.forSystem({ agent_id: 'gateway-admin', mode: 'production' })
        deps.trace.writeAsync(sysT.makeEvent({
          decision_id:  `admin-${now()}`,
          event_type:   'gateway_admin_killswitch_change',
          decision:     'accept',
          reason_code:  'admin_killswitch_set',
          reasoning:    { key, prior_value: priorValue, new_value: value, updated_by, reason },
          metrics:      {},
          pitcher_id:   '0', pitcher_name: 'admin',
          bet_date:     tradingDateFn(), strike: 0, side: 'YES',
        })).catch(() => {})
      } catch { /* best-effort */ }

      return res.status(200).json({
        ok: true, status: 'accepted',
        key, prior_value: priorValue, new_value: value,
      })
    } catch (err) {
      return res.status(503).json({
        ok: false, status: 'rejected', reject_reason: 'DB_DOWN',
        decision_id: null, trace_event_id: null,
        context: { detail: err?.message?.slice(0, 200) },
      })
    }
  }

  // ── /gateway/admin/unhalt — halt-bypass path ────────────────────────
  async function adminUnhalt(req, res) {
    extractRawAndParse(req)

    const rl = rateLimiter.check('admin')
    if (!rl.ok) {
      return res.status(429).json({
        ok: false, status: 'rejected', reject_reason: 'RATE_LIMIT_EXCEEDED',
        decision_id: null, trace_event_id: null,
        context: { agent: 'admin', count: rl.count, limit: rl.limit },
      })
    }

    const auth = verifyAdminHmac(req, adminSecret, now())
    if (!auth.ok) {
      return res.status(401).json({
        ok: false, status: 'rejected', reject_reason: 'HMAC_INVALID',
        decision_id: null, trace_event_id: null,
        context: { internal_reason: auth.internal_reason },
      })
    }

    const { by, reason } = req.body ?? {}
    if (!by) {
      return res.status(400).json({
        ok: false, status: 'rejected', reject_reason: 'BODY_INVALID',
        decision_id: null, trace_event_id: null,
        context: { reason: 'missing_field', missing: 'by' },
      })
    }

    const r = deps.halt.markUnhalt(by, reason ?? null)

    try {
      const sysT = deps.traceAdapter.forSystem({ agent_id: 'gateway-admin', mode: 'production' })
      deps.trace.writeAsync(sysT.makeEvent({
        decision_id:  `admin-unhalt-${now()}`,
        event_type:   'gateway_admin_unhalt',
        decision:     r.cleared ? 'accept' : 'noop',
        reason_code:  r.cleared ? 'manual_unhalt' : 'noop_not_halted',
        reasoning:    { by, reason, result: r },
        metrics:      {},
        pitcher_id:   '0', pitcher_name: 'admin',
        bet_date:     tradingDateFn(), strike: 0, side: 'YES',
      })).catch(() => {})
    } catch { /* best-effort */ }

    return res.status(200).json({
      ok: r.cleared,
      status: r.cleared ? 'accepted' : 'noop',
      cleared: r.cleared,
      trigger: r.trigger ?? null,
      reason: r.reason ?? null,
    })
  }

  return { place, healthz, adminKillswitch, adminUnhalt }
}

// ────────────────────────────────────────────────────────────────────────
// Mount onto an Express-style app
// ────────────────────────────────────────────────────────────────────────

export function mountGatewayRoutes(app, deps, opts = {}) {
  if (!app || typeof app.post !== 'function' || typeof app.get !== 'function') {
    throw new Error('mountGatewayRoutes: app must expose post() and get()')
  }
  // express.raw is the right middleware here. The caller injects it (so we
  // don't have a hard `import express` in this module — Express is only
  // present in the production composer, not in test imports).
  const rawJsonMiddleware = opts.rawJsonMiddleware
  if (typeof rawJsonMiddleware !== 'function') {
    throw new Error('mountGatewayRoutes: opts.rawJsonMiddleware required (use express.raw({ type: \'application/json\', limit: \'1mb\' }))')
  }
  const handlers = makeHandlers(deps)

  app.post('/gateway/place',              rawJsonMiddleware, handlers.place)
  app.get( '/gateway/healthz',                                   handlers.healthz)
  app.post('/gateway/admin/killswitch',   rawJsonMiddleware, handlers.adminKillswitch)
  app.post('/gateway/admin/unhalt',       rawJsonMiddleware, handlers.adminUnhalt)

  return {
    mounted: ['POST /gateway/place', 'GET /gateway/healthz', 'POST /gateway/admin/killswitch', 'POST /gateway/admin/unhalt'],
    handlers,
  }
}
