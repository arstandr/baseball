// scripts/tests/oracleGatewayRouteTest.js
//
// Tests for oracle/layers/6-gateway/route.js — pure function tests for
// status mapping / shape / rate limiter / enum validators / admin HMAC /
// killswitch validator, plus end-to-end handler invocations with mock
// req/res (no real HTTP server) covering /gateway/place, /gateway/healthz,
// /gateway/admin/killswitch, /gateway/admin/unhalt.
//
// Run: node scripts/tests/oracleGatewayRouteTest.js

import crypto from 'node:crypto'
import {
  mapHttpStatus,
  shapeResponse,
  makeRateLimiter,
  extractRawAndParse,
  verifyAdminHmac,
  validateKillswitchValue,
  makeHandlers,
  mountGatewayRoutes,
} from '../../oracle/layers/6-gateway/route.js'
import { sign, sha256Hex } from '../../oracle/layers/6-gateway/hmac.js'

let _passed = 0, _failed = 0
const ok  = (c, l) => c ? _passed++ : (_failed++, console.error(`FAIL [${l}]`))
const eq  = (a, b, l) => a === b ? _passed++ : (_failed++, console.error(`FAIL [${l}]: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`))
const section = n => console.log(`\n── ${n} ──`)

const SECRET       = 'test-secret-closer'
const ADMIN_SECRET = 'test-admin-secret'
const NOW = 1714499000000
const AGENT = 'closer-legacy'

// ════════════════════════════════════════════════════════════════════════
// mapHttpStatus
// ════════════════════════════════════════════════════════════════════════
section('mapHttpStatus — status → HTTP code')
eq(mapHttpStatus({ status: 'accepted' }),         200, 'accepted')
eq(mapHttpStatus({ status: 'shadow_logged' }),    200, 'shadow_logged')
eq(mapHttpStatus({ status: 'replay' }),           200, 'replay')
eq(mapHttpStatus({ status: 'exchange_unknown' }), 202, 'exchange_unknown → 202')
eq(mapHttpStatus({ status: 'exchange_error' }),   502, 'exchange_error → 502')
eq(mapHttpStatus({ status: 'halted' }),           503, 'halted → 503')

section('mapHttpStatus — reject_reason → HTTP code')
eq(mapHttpStatus({ status: 'rejected', reject_reason: 'HMAC_INVALID' }), 401, 'HMAC_INVALID → 401')
eq(mapHttpStatus({ status: 'rejected', reject_reason: 'IP_NOT_ALLOWED' }), 401, 'IP_NOT_ALLOWED → 401')
eq(mapHttpStatus({ status: 'rejected', reject_reason: 'BODY_INVALID' }), 400, 'BODY_INVALID → 400')
eq(mapHttpStatus({ status: 'rejected', reject_reason: 'ENUM_INVALID' }), 400, 'ENUM_INVALID → 400')
eq(mapHttpStatus({ status: 'rejected', reject_reason: 'DB_DOWN' }), 503, 'DB_DOWN → 503')
eq(mapHttpStatus({ status: 'rejected', reject_reason: 'TRACE_DOWN' }), 503, 'TRACE_DOWN → 503')
eq(mapHttpStatus({ status: 'rejected', reject_reason: 'GATEWAY_HALTED' }), 503, 'GATEWAY_HALTED → 503')
eq(mapHttpStatus({ status: 'rejected', reject_reason: 'GATEWAY_INTERNAL_ERROR' }), 500, 'GATEWAY_INTERNAL_ERROR → 500')
// Policy rejects → 200 (business meaning, not transport)
for (const r of ['KILLSWITCH_ALL', 'KILLSWITCH_AGENT', 'KILLSWITCH_MODE', 'KILLSWITCH_ACCOUNT',
                  'VERSION_BELOW_MIN', 'COMMIT_NOT_ALLOWED',
                  'ACCOUNT_UNKNOWN', 'ACCOUNT_STATE_STALE',
                  'ACCOUNT_DAILY_LOSS_BREACHED', 'ACCOUNT_DAILY_RISK_BREACHED',
                  'ORDER_USD_OVER_LIMIT',
                  'DECISION_NOT_FOUND', 'DECISION_STALE', 'DECISION_AGENT_MISMATCH',
                  'STATE_STALE_MLB', 'STATE_STALE_QUOTE',
                  'IDEMPOTENCY_CONFLICT']) {
  eq(mapHttpStatus({ status: 'rejected', reject_reason: r }), 200, `${r} → 200 (policy)`)
}
eq(mapHttpStatus(null), 500, 'null result → 500')

// ════════════════════════════════════════════════════════════════════════
// shapeResponse
// ════════════════════════════════════════════════════════════════════════
section('shapeResponse — uniform body shape')
{
  const r = shapeResponse({ status: 'accepted', kalshi_order_id: 'KS-1', trace_event_id_intent: 'TEI-1', trace_event_id_result: 'TER-1' }, { decision_id: 'd-1' })
  eq(r.ok, true, 'accepted ok=true')
  eq(r.status, 'accepted', 'status')
  eq(r.decision_id, 'd-1', 'decision_id from body')
  eq(r.trace_event_id, 'TEI-1', 'trace_event_id = intent id')
  eq(r.kalshi_order_id, 'KS-1', 'spread fields preserved')
  eq(r.reject_reason, null, 'no reject_reason')
}
{
  const r = shapeResponse({ status: 'rejected', reject_reason: 'HMAC_INVALID' }, null)
  eq(r.ok, false, 'rejected ok=false')
  eq(r.decision_id, null, 'decision_id null when no body')
}
{
  const r = shapeResponse({ status: 'replay', last_status: 'accepted' }, { decision_id: 'd-replay' })
  eq(r.ok, true, 'replay ok=true')
  eq(r.last_status, 'accepted', 'replay payload preserved')
}

// ════════════════════════════════════════════════════════════════════════
// makeRateLimiter
// ════════════════════════════════════════════════════════════════════════
section('makeRateLimiter — default + per-agent overrides + window expiry')
{
  let nowVal = 1_000_000
  const rl = makeRateLimiter({ defaultLimitPerMin: 3, perAgentLimit: { admin: 1 }, windowMs: 60_000, now: () => nowVal })
  // closer-legacy: limit=3 default
  eq(rl.check('closer-legacy').ok, true,  'closer 1/3')
  eq(rl.check('closer-legacy').ok, true,  'closer 2/3')
  eq(rl.check('closer-legacy').ok, true,  'closer 3/3')
  eq(rl.check('closer-legacy').ok, false, 'closer 4/3 → blocked')
  // admin: limit=1 (override)
  eq(rl.check('admin').ok, true,  'admin 1/1')
  eq(rl.check('admin').ok, false, 'admin 2/1 → blocked')
  // Other agent: still 3
  eq(rl.check('oracle').ok, true, 'oracle independent')
  // After window passes, counters reset
  nowVal += 61_000
  eq(rl.check('closer-legacy').ok, true, 'after 61s closer 1/3 again')
  eq(rl.check('admin').ok,         true, 'after 61s admin 1/1 again')
}

// ════════════════════════════════════════════════════════════════════════
// extractRawAndParse
// ════════════════════════════════════════════════════════════════════════
section('extractRawAndParse — Buffer, string, missing, malformed')
{
  const req = { body: Buffer.from('{"a":1}') }
  const r = extractRawAndParse(req)
  eq(r.rawBody, '{"a":1}', 'rawBody from Buffer')
  eq(r.body.a, 1, 'body parsed')
  eq(req.rawBody, '{"a":1}', 'req.rawBody mutated')
  eq(req.body.a, 1, 'req.body mutated')
}
{
  const req = { body: '{"a":2}' }
  const r = extractRawAndParse(req)
  eq(r.rawBody, '{"a":2}', 'rawBody from string')
  eq(r.body.a, 2, 'body parsed from string')
}
{
  const req = { rawBody: '{"a":3}' }  // express.raw didn't run; rawBody preset by something else
  const r = extractRawAndParse(req)
  eq(r.rawBody, '{"a":3}', 'rawBody preserved')
  eq(r.body.a, 3, 'body parsed')
}
{
  const req = {}
  const r = extractRawAndParse(req)
  eq(r.rawBody, '', 'empty rawBody')
  eq(typeof r.body, 'object', 'empty body = {}')
  eq(Object.keys(r.body).length, 0, 'body has no keys')
}
{
  const req = { body: Buffer.from('not-json') }
  const r = extractRawAndParse(req)
  eq(r.rawBody, 'not-json', 'rawBody preserved on parse fail')
  eq(r.body, null, 'body=null on parse fail')
}

// ════════════════════════════════════════════════════════════════════════
// verifyAdminHmac
// ════════════════════════════════════════════════════════════════════════
section('verifyAdminHmac — pass/fail paths')
function adminReq({ secretOverride = null, ...overrides } = {}) {
  const body = { key: 'gateway_kill_all', value: 'true', updated_by: 'adam' }
  const rawBody = JSON.stringify(body)
  const ts = NOW
  const nonce = 'nonce-admin-' + crypto.randomUUID()
  const bodySha = sha256Hex(rawBody)
  const secret = secretOverride ?? ADMIN_SECRET
  const sig = sign({ secret, timestamp: ts, nonce, bodySha256: bodySha })
  const headers = {
    'x-gateway-timestamp': String(ts),
    'x-gateway-nonce': nonce,
    'x-gateway-body-sha256': bodySha,
    'x-gateway-signature': sig,
    ...overrides.headers,
  }
  return { headers, rawBody, body }
}
{
  const r = verifyAdminHmac(adminReq(), ADMIN_SECRET, NOW)
  eq(r.ok, true, 'valid admin HMAC ok')
}
{
  const r = verifyAdminHmac(adminReq(), null, NOW)
  eq(r.ok, false, 'no secret → fail')
  eq(r.internal_reason, 'NO_ADMIN_SECRET_CONFIGURED', 'internal_reason')
}
{
  const req = adminReq()
  delete req.headers['x-gateway-signature']
  const r = verifyAdminHmac(req, ADMIN_SECRET, NOW)
  eq(r.ok, false, 'missing signature')
  eq(r.internal_reason, 'MISSING_HEADER', 'internal_reason=MISSING_HEADER')
}
{
  const r = verifyAdminHmac(adminReq(), ADMIN_SECRET, NOW + 60_000)
  eq(r.internal_reason, 'STALE_TIMESTAMP', 'stale ts')
}
{
  const req = adminReq()
  req.headers['x-gateway-body-sha256'] = 'f'.repeat(64)
  const r = verifyAdminHmac(req, ADMIN_SECRET, NOW)
  eq(r.internal_reason, 'BODY_HASH_MISMATCH', 'body hash mismatch')
}
{
  // Wrong secret on server side
  const r = verifyAdminHmac(adminReq(), 'wrong-secret', NOW)
  eq(r.internal_reason, 'SIG_MISMATCH', 'sig mismatch')
}

// ════════════════════════════════════════════════════════════════════════
// validateKillswitchValue — the silent-typo trap closer
// ════════════════════════════════════════════════════════════════════════
section('validateKillswitchValue — happy paths')
ok(validateKillswitchValue('gateway_kill_all', true).ok, 'kill_all=true bool')
ok(validateKillswitchValue('gateway_kill_all', 'true').ok, 'kill_all=true string')
ok(validateKillswitchValue('gateway_kill_all', 'false').ok, 'kill_all=false string')
ok(validateKillswitchValue('gateway_kill_agent', ['closer-legacy']).ok, 'kill_agent valid')
ok(validateKillswitchValue('gateway_kill_mode', ['live_dead_path_no']).ok, 'kill_mode valid')
ok(validateKillswitchValue('gateway_kill_account', ['adam']).ok, 'kill_account valid')
ok(validateKillswitchValue('min_version_by_agent', { 'closer-legacy': '0.7.3' }).ok, 'min_version valid')
ok(validateKillswitchValue('monitor_only_stale_agent', { 'closer-legacy': true }).ok, 'monitor_only valid')
ok(validateKillswitchValue('allowed_commit_hash_by_agent', { 'closer-legacy': ['a'.repeat(40)] }).ok, 'commit allowlist valid')
ok(validateKillswitchValue('daily_loss_limit_by_account', { adam: 500 }).ok, 'loss limit valid')
ok(validateKillswitchValue('daily_risk_limit_by_account', { adam: 1000 }).ok, 'risk limit valid')
ok(validateKillswitchValue('max_order_usd_by_mode', { live_dead_path_no: 100 }).ok, 'order cap valid')

section('validateKillswitchValue — silent-typo cases (the whole point)')
// Unknown key
ok(!validateKillswitchValue('kill_all', true).ok, 'unknown key kill_all (missing prefix)')
ok(!validateKillswitchValue('gateway_killall', true).ok, 'typo gateway_killall')
// kill_all bad value
ok(!validateKillswitchValue('gateway_kill_all', 'TRUE').ok, 'kill_all uppercase string rejected')
ok(!validateKillswitchValue('gateway_kill_all', 1).ok, 'kill_all numeric rejected')
// kill_agent bad value
ok(!validateKillswitchValue('gateway_kill_agent', 'closer-legacy').ok, 'kill_agent must be array, not scalar')
ok(!validateKillswitchValue('gateway_kill_agent', ['closer']).ok, 'kill_agent partial-match rejected')
ok(!validateKillswitchValue('gateway_kill_agent', ['Closer-Legacy']).ok, 'kill_agent case-mismatch rejected')
// kill_mode typo (the whole reason this validator exists)
ok(!validateKillswitchValue('gateway_kill_mode', ['live_yes']).ok, 'kill_mode "live_yes" typo rejected')
ok(!validateKillswitchValue('gateway_kill_mode', ['live_model_yes_x']).ok, 'kill_mode trailing-junk rejected')
ok(!validateKillswitchValue('gateway_kill_mode', 'live_model_yes').ok, 'kill_mode must be array')
// min_version invalid agent / non-semver
ok(!validateKillswitchValue('min_version_by_agent', { 'unknown-agent': '0.7.3' }).ok, 'min_version unknown agent')
ok(!validateKillswitchValue('min_version_by_agent', { 'closer-legacy': '0.7' }).ok, 'min_version not full semver')
ok(!validateKillswitchValue('min_version_by_agent', { 'closer-legacy': 'latest' }).ok, 'min_version "latest" rejected')
// allowed_commit_hash bad sha
ok(!validateKillswitchValue('allowed_commit_hash_by_agent', { 'closer-legacy': ['short'] }).ok, 'short sha rejected')
ok(!validateKillswitchValue('allowed_commit_hash_by_agent', { 'closer-legacy': ['A'.repeat(40)] }).ok, 'uppercase hex rejected')
// negative number caps
ok(!validateKillswitchValue('daily_loss_limit_by_account', { adam: -100 }).ok, 'negative loss limit rejected')
ok(!validateKillswitchValue('max_order_usd_by_mode', { live_dead_path_no: -50 }).ok, 'negative order cap rejected')

// ════════════════════════════════════════════════════════════════════════
// Handlers — end-to-end with mock req/res
// ════════════════════════════════════════════════════════════════════════

function mockRes() {
  let code = null
  let body = null
  return {
    status(c) { code = c; return this },
    json(b) { body = b; return this },
    _code: () => code,
    _body: () => body,
  }
}

function makeMockTrace() {
  const events = { sync: [], async: [] }
  return {
    events,
    api: {
      makeEvent: p => ({ id: crypto.randomUUID(), ...p }),
      writeSync: async ev => { events.sync.push(ev) },
      writeAsync: async ev => { events.async.push(ev) },
    },
    forRequest: () => ({
      makeEvent: p => ({ id: crypto.randomUUID(), ...p }),
      writeSync: async ev => { events.sync.push(ev) },
      writeAsync: async ev => { events.async.push(ev) },
    }),
    forSystem: () => ({
      makeEvent: p => ({ id: crypto.randomUUID(), ...p }),
      writeSync: async ev => { events.sync.push(ev) },
      writeAsync: async ev => { events.async.push(ev) },
    }),
  }
}

const DEFAULT_KS = {
  gateway_kill_all: false, gateway_kill_agent: [], gateway_kill_mode: [], gateway_kill_account: [],
  min_version_by_agent: {}, monitor_only_stale_agent: {}, allowed_commit_hash_by_agent: {},
  daily_loss_limit_by_account: {}, daily_risk_limit_by_account: {}, max_order_usd_by_mode: {},
}

function makeMockKalshi(b = { outcome: 'success', kalshi_order_id: 'KS-1' }) {
  return { place: async () => b, cancel: async () => b, amend: async () => b }
}

function makeFreshHandlers(overrides = {}) {
  const trace = makeMockTrace()
  const idemRows = new Map()
  const ksRows = { ...DEFAULT_KS }
  const halt = (() => {
    let blind = null
    return {
      isHalted: () => blind != null,
      setBlind: x => { blind = x },
      markUnhalt: (by, reason) => {
        if (!blind) return { cleared: false, reason: 'not_halted' }
        const c = blind
        blind = null
        return { cleared: true, trigger: 'manual_unhalt', cleared_at: c.at, by, reason }
      },
      peekStatus: () => ({ blind, consecutiveProbeSuccesses: 0 }),
    }
  })()

  const deps = {
    trace: trace.api,
    traceAdapter: { forRequest: trace.forRequest, forSystem: trace.forSystem },
    kalshi: makeMockKalshi(overrides.kalshiBehavior),
    idempotencyStore: {
      upsert: async row => idemRows.set(row.decision_id, row),
      get: async id => idemRows.get(id) ?? null,
    },
    unknownsStore: { enqueue: async () => {} },
    deadLetter: { write: async () => {} },
    halt,
    killswitchCache: {
      get: async () => ksRows,
      invalidate: () => {},
    },
    killswitchStore: {
      set: async (k, v) => { ksRows[k] = v },
    },
    agentSecrets: { 'closer-legacy': SECRET },
    loaders: {
      insertNonce: async () => {},
      loadAccount: async () => ({ account_id: 'adam', enabled: 1 }),
      loadAccountState: async () => ({
        account_id: 'adam', trading_date: '2026-04-30',
        realized_pnl_usd: 0, open_risk_usd: 0, submitted_order_usd: 0,
        daily_loss_limit_usd: 500, daily_risk_limit_usd: 1000,
        updated_at: new Date(NOW - 5_000).toISOString(),
      }),
      loadDecisionEvent: async id => ({ decision_id: id, agent_id: 'closer-legacy', created_at: new Date(NOW - 5000).toISOString() }),
      loadIdempotency: async id => idemRows.get(id) ?? null,
    },
    adminSecret: ADMIN_SECRET,
    tradingDateFn: () => '2026-04-30',
    now: () => NOW,
    rateLimiter: overrides.rateLimiter,
    gatewayMode: overrides.gatewayMode ?? 'production',  // tests exercise production by default; shadow override has its own section
    ...overrides.depsOverrides,
  }
  return { handlers: makeHandlers(deps), trace, halt, deps, idemRows }
}

function defaultPlaceBody(o = {}) {
  return {
    decision_id: 'd-' + crypto.randomUUID(),
    decision_input_hash: 'a'.repeat(64),
    trace_event_type: 'closer_legacy_decision',
    account_id: 'adam',
    execution_mode: 'production',
    strategy_mode: 'live_dead_path_no',
    market_ticker: 'KX-MKT',
    action: 'buy', contract_side: 'no',
    order_type: 'limit', time_in_force: 'IOC',
    quantity: 10, limit_price_cents: 30,
    pitcher_id: '547179', pitcher_name: 'Lorenzen',
    bet_date: '2026-04-30', strike: 5,
    bet_amount_usd: 30,
    bankroll_at_decision_usd: 5000,
    kelly_fraction: 0.05,
    expected_pK_low: 0.5, expected_pK_high: 0.7,
    evidence: {
      mlb_state_hash: 'b'.repeat(64), mlb_state_ts: NOW - 1000,
      kalshi_quote_hash: 'c'.repeat(64), kalshi_quote_ts: NOW - 500,
      position_hash: 'd'.repeat(64), position_ts: NOW - 1000,
      orderbook_hash: 'e'.repeat(64), orderbook_ts: NOW - 500,
    },
    ...o,
  }
}

function buildPlaceReq(opts = {}) {
  const body = opts.body ?? defaultPlaceBody(opts.bodyOverrides)
  const rawBody = opts.rawBody ?? JSON.stringify(body)
  const bodySha = sha256Hex(rawBody)
  const ts = opts.timestamp ?? NOW
  const nonce = 'n-' + crypto.randomUUID()
  const sig = sign({ secret: SECRET, timestamp: ts, nonce, bodySha256: bodySha })
  return {
    headers: {
      'x-gateway-agent': AGENT,
      'x-gateway-agent-version': '0.7.3',
      'x-gateway-commit': 'a'.repeat(40),
      'x-gateway-timestamp': String(ts),
      'x-gateway-nonce': nonce,
      'x-gateway-body-sha256': bodySha,
      'x-gateway-signature': sig,
    },
    body: Buffer.from(rawBody),  // simulate express.raw
    ip: '127.0.0.1',
  }
}

// ─── handlers.place ────────────────────────────────────────────────────
section('handlers.place — happy production path')
{
  const { handlers } = makeFreshHandlers()
  const req = buildPlaceReq()
  const res = mockRes()
  await handlers.place(req, res)
  eq(res._code(), 200, '200 for accepted')
  eq(res._body().ok, true, 'ok=true')
  eq(res._body().status, 'accepted', 'status=accepted')
  eq(res._body().kalshi_order_id, 'KS-1', 'order_id surfaced')
  ok(res._body().decision_id, 'decision_id present')
  ok(res._body().trace_event_id, 'trace_event_id present')
}

section('handlers.place — shadow → 200 + ok=true')
{
  const { handlers } = makeFreshHandlers()
  const res = mockRes()
  await handlers.place(buildPlaceReq({ bodyOverrides: { execution_mode: 'shadow' } }), res)
  eq(res._code(), 200, 'shadow → 200')
  eq(res._body().status, 'shadow_logged', 'status=shadow_logged')
  eq(res._body().ok, true, 'ok=true')
}

section('handlers.place — exchange_unknown → 202')
{
  const { handlers } = makeFreshHandlers({ kalshiBehavior: { outcome: 'unknown', raw_response: { error: 'timeout' } } })
  const res = mockRes()
  await handlers.place(buildPlaceReq(), res)
  eq(res._code(), 202, 'exchange_unknown → 202')
  eq(res._body().status, 'exchange_unknown', 'status=exchange_unknown')
  eq(res._body().ok, false, 'ok=false (not a successful settle)')
}

section('handlers.place — exchange_error → 502')
{
  const { handlers } = makeFreshHandlers({ kalshiBehavior: { outcome: 'error', error_code: 'http_400', raw_response: { code: '400' } } })
  const res = mockRes()
  await handlers.place(buildPlaceReq(), res)
  eq(res._code(), 502, 'exchange_error → 502')
  eq(res._body().status, 'exchange_error', 'status=exchange_error')
  eq(res._body().error_code, 'http_400', 'error_code surfaced')
}

section('handlers.place — HMAC fail → 401')
{
  const { handlers } = makeFreshHandlers()
  const req = buildPlaceReq()
  delete req.headers['x-gateway-signature']
  const res = mockRes()
  await handlers.place(req, res)
  eq(res._code(), 401, 'HMAC missing → 401')
  eq(res._body().reject_reason, 'HMAC_INVALID', 'HMAC_INVALID')
  eq(res._body().ok, false, 'ok=false')
}

section('handlers.place — bad enum → 400')
{
  const { handlers } = makeFreshHandlers()
  const req = buildPlaceReq({ bodyOverrides: { strategy_mode: 'live_yes' } })
  // Re-sign for the modified body
  req.body = Buffer.from(JSON.stringify(JSON.parse(req.body.toString()).constructor === Object
    ? defaultPlaceBody({ strategy_mode: 'live_yes' })
    : defaultPlaceBody({ strategy_mode: 'live_yes' })))
  // simpler: rebuild
  const body = defaultPlaceBody({ strategy_mode: 'live_yes' })
  const rawBody = JSON.stringify(body)
  const bodySha = sha256Hex(rawBody)
  const ts = NOW
  const nonce = 'n-enum'
  const sig = sign({ secret: SECRET, timestamp: ts, nonce, bodySha256: bodySha })
  const req2 = {
    headers: {
      'x-gateway-agent': AGENT, 'x-gateway-agent-version': '0.7.3',
      'x-gateway-commit': 'a'.repeat(40), 'x-gateway-timestamp': String(ts),
      'x-gateway-nonce': nonce, 'x-gateway-body-sha256': bodySha, 'x-gateway-signature': sig,
    },
    body: Buffer.from(rawBody),
    ip: '127.0.0.1',
  }
  const res = mockRes()
  await handlers.place(req2, res)
  eq(res._code(), 400, 'ENUM_INVALID → 400')
  eq(res._body().reject_reason, 'ENUM_INVALID', 'ENUM_INVALID')
}

section('handlers.place — policy reject (kill_all) → 200 with ok=false')
{
  const ks = { ...DEFAULT_KS, gateway_kill_all: true }
  const { handlers } = makeFreshHandlers({
    depsOverrides: { killswitchCache: { get: async () => ks, invalidate: () => {} } },
  })
  const res = mockRes()
  await handlers.place(buildPlaceReq(), res)
  eq(res._code(), 200, 'policy reject → 200 (business meaning)')
  eq(res._body().reject_reason, 'KILLSWITCH_ALL', 'KILLSWITCH_ALL')
  eq(res._body().ok, false, 'ok=false')
}

section('handlers.place — halt → 503')
{
  const { handlers, halt } = makeFreshHandlers()
  halt.setBlind({ reason: 'GATEWAY_BLIND', detail: 'pretest', at: NOW - 1000 })
  const res = mockRes()
  await handlers.place(buildPlaceReq(), res)
  eq(res._code(), 503, 'halted → 503')
  eq(res._body().status, 'halted', 'status=halted')
}

section('handlers.place — GATEWAY_MODE=shadow forces production requests to shadow_logged')
{
  // Explicitly construct with gatewayMode='shadow' (overriding the test default)
  const { handlers } = makeFreshHandlers({ gatewayMode: 'shadow' })
  const res = mockRes()
  // Caller sends execution_mode='production'; route should override to shadow
  await handlers.place(buildPlaceReq({ bodyOverrides: { execution_mode: 'production' } }), res)
  eq(res._code(), 200, 'still 200')
  eq(res._body().status, 'shadow_logged', 'GATEWAY_MODE=shadow forced shadow_logged')
  eq(res._body().ok, true, 'ok=true')
}
{
  // GATEWAY_MODE=shadow + caller-sent execution_mode='shadow' → shadow path natively
  const { handlers } = makeFreshHandlers({ gatewayMode: 'shadow' })
  const res = mockRes()
  await handlers.place(buildPlaceReq({ bodyOverrides: { execution_mode: 'shadow' } }), res)
  eq(res._body().status, 'shadow_logged', 'shadow→shadow no override needed')
}

section('handlers.place — rate limit → 429')
{
  const { handlers, trace } = makeFreshHandlers({
    rateLimiter: makeRateLimiter({ defaultLimitPerMin: 1, now: () => NOW }),
  })
  // First call: ok
  await handlers.place(buildPlaceReq(), mockRes())
  // Second call: rate limited
  const res = mockRes()
  await handlers.place(buildPlaceReq(), res)
  eq(res._code(), 429, 'rate limit → 429')
  eq(res._body().reject_reason, 'RATE_LIMIT_EXCEEDED', 'RATE_LIMIT_EXCEEDED')
  ok(trace.events.async.find(e => e.event_type === 'gateway_rate_limit'), 'rate-limit warn Trace emitted')
}

// ─── handlers.healthz ──────────────────────────────────────────────────
section('handlers.healthz — ok / halted')
{
  const { handlers } = makeFreshHandlers()
  const res = mockRes()
  handlers.healthz({}, res)
  eq(res._code(), 200, 'ok=true → 200')
  eq(res._body().ok, true, 'ok=true')
  eq(res._body().halted, false, 'halted=false')
}
{
  const { handlers, halt } = makeFreshHandlers()
  halt.setBlind({ reason: 'GATEWAY_BLIND', detail: 'x', at: NOW })
  const res = mockRes()
  handlers.healthz({}, res)
  eq(res._code(), 503, 'halted → 503')
  eq(res._body().halted, true, 'halted=true')
}

// ─── handlers.adminKillswitch ──────────────────────────────────────────
section('handlers.adminKillswitch — auth fail → 401')
{
  const { handlers } = makeFreshHandlers()
  const req = adminReq()
  delete req.headers['x-gateway-signature']
  // simulate express.raw populating body as Buffer
  req.body = Buffer.from(req.rawBody)
  const res = mockRes()
  await handlers.adminKillswitch(req, res)
  eq(res._code(), 401, 'no sig → 401')
  eq(res._body().reject_reason, 'HMAC_INVALID', 'HMAC_INVALID')
}

section('handlers.adminKillswitch — body invalid → 400')
{
  const { handlers } = makeFreshHandlers()
  const body = { value: 'true' }  // missing key + updated_by
  const rawBody = JSON.stringify(body)
  const bodySha = sha256Hex(rawBody)
  const ts = NOW, nonce = 'n-aks-1'
  const sig = sign({ secret: ADMIN_SECRET, timestamp: ts, nonce, bodySha256: bodySha })
  const req = {
    headers: {
      'x-gateway-timestamp': String(ts), 'x-gateway-nonce': nonce,
      'x-gateway-body-sha256': bodySha, 'x-gateway-signature': sig,
    },
    body: Buffer.from(rawBody),
  }
  const res = mockRes()
  await handlers.adminKillswitch(req, res)
  eq(res._code(), 400, 'missing key → 400')
  eq(res._body().reject_reason, 'BODY_INVALID', 'BODY_INVALID')
}

section("handlers.adminKillswitch — typo value → 400 + ENUM_INVALID")
{
  const { handlers } = makeFreshHandlers()
  const body = { key: 'gateway_kill_mode', value: ['live_yes'], updated_by: 'adam' }
  const rawBody = JSON.stringify(body)
  const bodySha = sha256Hex(rawBody)
  const ts = NOW, nonce = 'n-aks-2'
  const sig = sign({ secret: ADMIN_SECRET, timestamp: ts, nonce, bodySha256: bodySha })
  const req = {
    headers: {
      'x-gateway-timestamp': String(ts), 'x-gateway-nonce': nonce,
      'x-gateway-body-sha256': bodySha, 'x-gateway-signature': sig,
    },
    body: Buffer.from(rawBody),
  }
  const res = mockRes()
  await handlers.adminKillswitch(req, res)
  eq(res._code(), 400, 'typo "live_yes" → 400')
  eq(res._body().reject_reason, 'ENUM_INVALID', 'ENUM_INVALID')
  ok(res._body().context.reason.includes('not_in_strategy_modes'), 'reason names the catch')
}

section('handlers.adminKillswitch — happy path → 200 + audit Trace')
{
  const { handlers, trace, deps } = makeFreshHandlers()
  const body = { key: 'gateway_kill_mode', value: ['live_dead_path_no'], updated_by: 'adam', reason: 'safety drill' }
  const rawBody = JSON.stringify(body)
  const bodySha = sha256Hex(rawBody)
  const ts = NOW, nonce = 'n-aks-3'
  const sig = sign({ secret: ADMIN_SECRET, timestamp: ts, nonce, bodySha256: bodySha })
  const req = {
    headers: {
      'x-gateway-timestamp': String(ts), 'x-gateway-nonce': nonce,
      'x-gateway-body-sha256': bodySha, 'x-gateway-signature': sig,
    },
    body: Buffer.from(rawBody),
  }
  const res = mockRes()
  await handlers.adminKillswitch(req, res)
  eq(res._code(), 200, 'admin set → 200')
  eq(res._body().status, 'accepted', 'status=accepted')
  eq(res._body().key, 'gateway_kill_mode', 'key echoed')
  ok(trace.events.async.find(e => e.event_type === 'gateway_admin_killswitch_change'), 'audit Trace emitted')
}

// ─── handlers.adminUnhalt ──────────────────────────────────────────────
section('handlers.adminUnhalt — auth fail → 401')
{
  const { handlers } = makeFreshHandlers()
  const body = { by: 'adam' }
  const rawBody = JSON.stringify(body)
  const req = {
    headers: {
      'x-gateway-timestamp': String(NOW), 'x-gateway-nonce': 'n-x',
      'x-gateway-body-sha256': sha256Hex(rawBody),
      // missing signature
    },
    body: Buffer.from(rawBody),
  }
  const res = mockRes()
  await handlers.adminUnhalt(req, res)
  eq(res._code(), 401, '401 on missing sig')
}

section('handlers.adminUnhalt — happy path while halted → 200, halt cleared')
{
  const { handlers, halt, trace } = makeFreshHandlers()
  halt.setBlind({ reason: 'GATEWAY_BLIND', detail: 'x', at: NOW - 5000 })
  ok(halt.isHalted(), 'halted before')

  const body = { by: 'adam', reason: 'manual override' }
  const rawBody = JSON.stringify(body)
  const bodySha = sha256Hex(rawBody)
  const ts = NOW, nonce = 'n-uh-1'
  const sig = sign({ secret: ADMIN_SECRET, timestamp: ts, nonce, bodySha256: bodySha })
  const req = {
    headers: {
      'x-gateway-timestamp': String(ts), 'x-gateway-nonce': nonce,
      'x-gateway-body-sha256': bodySha, 'x-gateway-signature': sig,
    },
    body: Buffer.from(rawBody),
  }
  const res = mockRes()
  await handlers.adminUnhalt(req, res)
  eq(res._code(), 200, 'unhalt → 200')
  eq(res._body().cleared, true, 'cleared=true')
  ok(!halt.isHalted(), 'halted=false after')
  ok(trace.events.async.find(e => e.event_type === 'gateway_admin_unhalt'), 'unhalt audit Trace emitted')
}

section('handlers.adminUnhalt — noop when not halted → 200 noop')
{
  const { handlers } = makeFreshHandlers()
  const body = { by: 'adam' }
  const rawBody = JSON.stringify(body)
  const bodySha = sha256Hex(rawBody)
  const ts = NOW, nonce = 'n-uh-2'
  const sig = sign({ secret: ADMIN_SECRET, timestamp: ts, nonce, bodySha256: bodySha })
  const req = {
    headers: {
      'x-gateway-timestamp': String(ts), 'x-gateway-nonce': nonce,
      'x-gateway-body-sha256': bodySha, 'x-gateway-signature': sig,
    },
    body: Buffer.from(rawBody),
  }
  const res = mockRes()
  await handlers.adminUnhalt(req, res)
  eq(res._code(), 200, '200')
  eq(res._body().status, 'noop', 'noop')
  eq(res._body().cleared, false, 'cleared=false')
}

// ════════════════════════════════════════════════════════════════════════
// mountGatewayRoutes — verifies registration shape
// ════════════════════════════════════════════════════════════════════════
section('mountGatewayRoutes — registers expected routes')
{
  const calls = []
  const fakeApp = {
    post: (path, ...rest) => calls.push({ method: 'POST', path, args: rest.length }),
    get:  (path, ...rest) => calls.push({ method: 'GET',  path, args: rest.length }),
  }
  const { handlers } = makeFreshHandlers()
  const r = mountGatewayRoutes(fakeApp, {
    trace: handlers.place._fakeDep ?? {},
    kalshi: {}, idempotencyStore: {}, unknownsStore: {}, deadLetter: {},
    halt: { isHalted: () => false }, killswitchCache: { get: async () => DEFAULT_KS },
    killswitchStore: {}, agentSecrets: {}, loaders: {},
    traceAdapter: { forRequest: () => ({}), forSystem: () => ({}) },
  }, { rawJsonMiddleware: (req, res, next) => next() })
  eq(r.mounted.length, 4, '4 routes mounted')
  ok(calls.find(c => c.method === 'POST' && c.path === '/gateway/place'), 'POST /gateway/place')
  ok(calls.find(c => c.method === 'GET'  && c.path === '/gateway/healthz'), 'GET  /gateway/healthz')
  ok(calls.find(c => c.method === 'POST' && c.path === '/gateway/admin/killswitch'), 'POST /gateway/admin/killswitch')
  ok(calls.find(c => c.method === 'POST' && c.path === '/gateway/admin/unhalt'), 'POST /gateway/admin/unhalt')
}
{
  let threw = false
  try { mountGatewayRoutes({ post: () => {}, get: () => {} }, {}, {}) } catch { threw = true }
  ok(threw, 'missing rawJsonMiddleware throws')
}
{
  let threw = false
  try { mountGatewayRoutes(null, {}, {}) } catch { threw = true }
  ok(threw, 'null app throws')
}

// ─── Summary ──────────────────────────────────────────────────────────
console.log(`\n${_passed} passed, ${_failed} failed`)
process.exit(_failed > 0 ? 1 : 0)
