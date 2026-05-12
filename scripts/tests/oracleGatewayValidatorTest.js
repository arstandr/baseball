// scripts/tests/oracleGatewayValidatorTest.js
//
// Tests for oracle/layers/6-gateway/validator.js — validatePlaceIntent.
// Covers every reject_reason path + happy paths (production + shadow + idempotent replay).
//
// Run: node scripts/tests/oracleGatewayValidatorTest.js

import crypto from 'node:crypto'
import { validatePlaceIntent, semverLt } from '../../oracle/layers/6-gateway/validator.js'
import { sign, sha256Hex } from '../../oracle/layers/6-gateway/hmac.js'

let _passed = 0, _failed = 0
const ok  = (c, l) => c ? _passed++ : (_failed++, console.error(`FAIL [${l}]`))
const eq  = (a, b, l) => a === b ? _passed++ : (_failed++, console.error(`FAIL [${l}]: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`))
const section = n => console.log(`\n── ${n} ──`)

const SECRET = 'test-secret-closer-legacy'
const ORACLE_SECRET = 'test-secret-oracle'
const NOW = 1714499000000  // 2024-04-30T...
const AGENT = 'closer-legacy'

// ─── Default valid request + context builders ────────────────────────────
function defaultBody(overrides = {}) {
  return {
    decision_id: 'd-' + crypto.randomUUID(),
    decision_input_hash: 'a'.repeat(64),
    trace_event_type: 'closer_legacy_decision',
    account_id: 'adam',
    execution_mode: 'production',
    strategy_mode: 'live_dead_path_no',
    market_ticker: 'KXMLB-25APR30CINCOL-CIN',
    action: 'buy',
    contract_side: 'no',
    order_type: 'limit',
    time_in_force: 'IOC',
    quantity: 10,
    limit_price_cents: 30,
    pitcher_id: '547179',
    pitcher_name: 'Michael Lorenzen',
    bet_date: '2026-04-30',
    strike: 5,
    bet_amount_usd: 30,
    expected_pK_low: 0.5,
    expected_pK_high: 0.7,
    kelly_fraction: 0.05,
    bankroll_at_decision_usd: 5000,
    evidence: {
      mlb_state_hash:    'b'.repeat(64), mlb_state_ts:    NOW - 1000,
      kalshi_quote_hash: 'c'.repeat(64), kalshi_quote_ts: NOW - 500,
      position_hash:     'd'.repeat(64), position_ts:     NOW - 1000,
      orderbook_hash:    'e'.repeat(64), orderbook_ts:    NOW - 500,
    },
    ...overrides,
  }
}

function makeRequest(opts = {}) {
  const body = opts.body ?? defaultBody(opts.bodyOverrides)
  const rawBody = opts.rawBody ?? JSON.stringify(body)
  const bodySha = opts.bodySha ?? sha256Hex(rawBody)
  const ts = opts.timestamp ?? NOW
  const nonce = opts.nonce ?? 'n-' + crypto.randomUUID()
  const agent = opts.agent ?? AGENT
  const secret = opts.secret ?? (agent === 'oracle' ? ORACLE_SECRET : SECRET)
  const sig = opts.signature ?? sign({ secret, timestamp: ts, nonce, bodySha256: bodySha })
  const headers = {
    'x-gateway-agent': agent,
    'x-gateway-agent-version': opts.version ?? '0.7.3',
    'x-gateway-commit': opts.commit ?? 'a'.repeat(40),
    'x-gateway-timestamp': String(ts),
    'x-gateway-nonce': nonce,
    'x-gateway-body-sha256': bodySha,
    'x-gateway-signature': sig,
    ...opts.extraHeaders,
  }
  return { headers, rawBody, body }
}

const DEFAULT_KILLSWITCH = Object.freeze({
  gateway_kill_all: false,
  gateway_kill_agent: [],
  gateway_kill_mode: [],
  gateway_kill_account: [],
  min_version_by_agent: {},
  monitor_only_stale_agent: {},
  allowed_commit_hash_by_agent: {},
  daily_loss_limit_by_account: {},
  daily_risk_limit_by_account: {},
  max_order_usd_by_mode: {},
  _fetchedAt: NOW,
})

const DEFAULT_ACCOUNT = { account_id: 'adam', enabled: 1, daily_loss_limit_usd: 500, daily_risk_limit_usd: 1000 }
const DEFAULT_ACCOUNT_STATE = {
  account_id: 'adam',
  trading_date: '2026-04-30',
  realized_pnl_usd: 0,
  open_risk_usd: 0,
  submitted_order_usd: 0,
  daily_loss_limit_usd: 500,
  daily_risk_limit_usd: 1000,
  updated_at: new Date(NOW - 5_000).toISOString(),
}
const DEFAULT_DECISION = {
  decision_id: null,  // filled per-test
  agent_name: 'closer-legacy',
  created_at: new Date(NOW - 10_000).toISOString(),
}

function makeContext(opts = {}) {
  const decisionForId = (id) => ({ ...DEFAULT_DECISION, decision_id: id })
  return {
    agentSecrets: { 'closer-legacy': SECRET, 'oracle': ORACLE_SECRET, ...opts.agentSecrets },
    killswitch: { ...DEFAULT_KILLSWITCH, ...opts.killswitch },
    loaders: {
      insertNonce: opts.insertNonce ?? (async () => {}),
      loadAccount: opts.loadAccount ?? (async (id) => id === 'adam' || id === 'isaiah' ? { ...DEFAULT_ACCOUNT, account_id: id } : null),
      loadAccountState: opts.loadAccountState ?? (async () => ({ ...DEFAULT_ACCOUNT_STATE })),
      loadDecisionEvent: opts.loadDecisionEvent ?? (async (id) => decisionForId(id)),
      loadIdempotency: opts.loadIdempotency ?? (async () => null),
    },
    now: opts.now ?? NOW,
    tradingDate: opts.tradingDate ?? '2026-04-30',
    halted: opts.halted ?? false,
  }
}

async function run(reqOpts = {}, ctxOpts = {}) {
  const { headers, rawBody, body } = makeRequest(reqOpts)
  const ctx = makeContext(ctxOpts)
  return validatePlaceIntent({ headers, rawBody, body, ...ctx })
}

// ─── F0: Happy paths ────────────────────────────────────────────────────
section('Happy paths')
{
  const r = await run()
  ok(r.ok, 'production live happy path')
  eq(r.idempotency.state, 'fresh', 'idempotency=fresh')
  eq(r.agent, AGENT, 'agent returned')
  ok(r.decision, 'decision attached')
  ok(r.account, 'account attached')
  eq(r.warnings.length, 0, 'no warnings on happy path')
}
{
  const r = await run({ bodyOverrides: { execution_mode: 'shadow' } })
  ok(r.ok, 'shadow happy path')
}
{
  // pregame mode skips state freshness checks
  const r = await run({ bodyOverrides: { strategy_mode: 'pregame_model', evidence: { mlb_state_ts: NOW - 100_000, kalshi_quote_ts: NOW - 100_000 } } })
  ok(r.ok, 'pregame ignores live state freshness')
}

// ─── HMAC_INVALID family ────────────────────────────────────────────────
section('HMAC_INVALID — missing/bad headers')
{
  // Drop one header at a time
  const headers = ['x-gateway-agent', 'x-gateway-timestamp', 'x-gateway-nonce', 'x-gateway-body-sha256', 'x-gateway-signature']
  for (const h of headers) {
    const req = makeRequest()
    delete req.headers[h]
    const r = await validatePlaceIntent({ ...req, ...makeContext() })
    eq(r.ok, false, `missing ${h} → reject`)
    eq(r.reject_reason, 'HMAC_INVALID', `missing ${h} → HMAC_INVALID`)
    eq(r.context.internal_reason, 'MISSING_HEADER', `missing ${h} → internal MISSING_HEADER`)
  }
}
{
  const r = await run({ agent: 'evil-agent', secret: 'whatever' })
  eq(r.reject_reason, 'HMAC_INVALID', 'unknown agent → HMAC_INVALID')
  eq(r.context.internal_reason, 'AGENT_UNKNOWN', 'unknown agent → internal AGENT_UNKNOWN')
}
{
  const r = await run({ timestamp: NOW - 60_000 })
  eq(r.reject_reason, 'HMAC_INVALID', 'stale timestamp → HMAC_INVALID')
  eq(r.context.internal_reason, 'STALE_TIMESTAMP', 'internal STALE_TIMESTAMP')
}
{
  const r = await run({ timestamp: NOW + 60_000 })
  eq(r.reject_reason, 'HMAC_INVALID', 'future timestamp beyond skew → HMAC_INVALID')
}
{
  // Body-hash mismatch: sign valid sig but lie about body hash
  const req = makeRequest()
  req.headers['x-gateway-body-sha256'] = 'f'.repeat(64)
  const r = await validatePlaceIntent({ ...req, ...makeContext() })
  eq(r.reject_reason, 'HMAC_INVALID', 'body hash mismatch → HMAC_INVALID')
  eq(r.context.internal_reason, 'BODY_HASH_MISMATCH', 'internal BODY_HASH_MISMATCH')
}
{
  // Signed body differs from rawBody actually sent
  const realBody = defaultBody()
  const altBody = JSON.stringify({ ...realBody, market_ticker: 'TAMPERED' })
  const altSha = sha256Hex(altBody)
  const ts = NOW
  const nonce = 'n-tamper'
  // Sign for ALT body, but submit ORIGINAL rawBody
  const sig = sign({ secret: SECRET, timestamp: ts, nonce, bodySha256: altSha })
  const headers = {
    'x-gateway-agent': AGENT,
    'x-gateway-agent-version': '0.7.3',
    'x-gateway-commit': 'a'.repeat(40),
    'x-gateway-timestamp': String(ts),
    'x-gateway-nonce': nonce,
    'x-gateway-body-sha256': altSha,
    'x-gateway-signature': sig,
  }
  const r = await validatePlaceIntent({ headers, rawBody: JSON.stringify(realBody), body: realBody, ...makeContext() })
  eq(r.reject_reason, 'HMAC_INVALID', 'tampered body bytes → body_hash_mismatch')
  eq(r.context.internal_reason, 'BODY_HASH_MISMATCH', 'internal BODY_HASH_MISMATCH')
}
{
  // Bad signature with otherwise-valid metadata
  const req = makeRequest()
  req.headers['x-gateway-signature'] = 'a'.repeat(64)
  const r = await validatePlaceIntent({ ...req, ...makeContext() })
  eq(r.reject_reason, 'HMAC_INVALID', 'bad signature → HMAC_INVALID')
  eq(r.context.internal_reason, 'SIG_MISMATCH', 'internal SIG_MISMATCH')
}
{
  // Server has no secret for closer-legacy at all
  const req = makeRequest()
  const ctx = makeContext()
  ctx.agentSecrets = { 'oracle': ORACLE_SECRET }  // post-hoc replace, no closer-legacy
  const r = await validatePlaceIntent({ ...req, ...ctx })
  eq(r.reject_reason, 'HMAC_INVALID', 'no secret for agent → HMAC_INVALID')
  eq(r.context.internal_reason, 'NO_SECRET_FOR_AGENT', 'internal NO_SECRET_FOR_AGENT')
}
{
  const r = await run({}, {
    insertNonce: async () => { throw new Error('unique constraint failed') },
  })
  eq(r.reject_reason, 'HMAC_INVALID', 'nonce conflict → HMAC_INVALID')
  eq(r.context.internal_reason, 'NONCE_REPLAYED', 'internal NONCE_REPLAYED')
}

// ─── ENUM_INVALID — bad value provided ─────────────────────────────────
section('ENUM_INVALID — value out of canonical enum')
{
  const r = await run({ bodyOverrides: { strategy_mode: 'live_yes' } })  // typo
  eq(r.reject_reason, 'ENUM_INVALID', 'bad strategy_mode → ENUM_INVALID')
  eq(r.context.category, 'strategy_mode', 'category=strategy_mode')
}
{
  const r = await run({ bodyOverrides: { execution_mode: 'PRODUCTION' } })  // case
  eq(r.reject_reason, 'ENUM_INVALID', 'case-mismatch execution_mode')
}
{
  const r = await run({ bodyOverrides: { action: 'BUY' } })
  eq(r.reject_reason, 'ENUM_INVALID', 'case-mismatch action')
}
{
  const r = await run({ bodyOverrides: { contract_side: 'YES' } })
  eq(r.reject_reason, 'ENUM_INVALID', 'case-mismatch contract_side')
}
{
  const r = await run({ bodyOverrides: { time_in_force: 'gtc' } })
  eq(r.reject_reason, 'ENUM_INVALID', 'lowercase tif')
}

// ─── BODY_INVALID — missing/malformed required fields ──────────────────
section('BODY_INVALID — missing or malformed body')
{
  // Missing required body field
  const body = defaultBody()
  delete body.account_id
  const r = await run({ body })
  eq(r.reject_reason, 'BODY_INVALID', 'missing account_id → BODY_INVALID')
  eq(r.context.field, 'account_id', 'context.field names missing field')
}
{
  // Missing limit_price_cents on a limit order
  const body = defaultBody()
  delete body.limit_price_cents
  const r = await run({ body })
  eq(r.reject_reason, 'BODY_INVALID', 'limit order without price → BODY_INVALID')
  eq(r.context.field, 'limit_price_cents', 'context.field=limit_price_cents')
}
{
  // Body is not an object
  const req = makeRequest()
  const r = await validatePlaceIntent({ ...req, body: 'not-an-object', ...makeContext() })
  eq(r.reject_reason, 'BODY_INVALID', 'non-object body → BODY_INVALID')
}
{
  // Multiple missing fields → first one rejected
  const body = defaultBody()
  delete body.market_ticker
  delete body.pitcher_id
  const r = await run({ body })
  eq(r.reject_reason, 'BODY_INVALID', 'first missing field rejected')
}

// ─── State freshness ──────────────────────────────────────────────────
section('STATE_STALE_MLB / STATE_STALE_QUOTE')
{
  const r = await run({ bodyOverrides: { evidence: { mlb_state_ts: NOW - 25_000, kalshi_quote_ts: NOW - 500 } } })
  eq(r.reject_reason, 'STATE_STALE_MLB', 'mlb_state_ts 25s old')
}
{
  const r = await run({ bodyOverrides: { evidence: { mlb_state_ts: NOW - 500, kalshi_quote_ts: NOW - 15_000 } } })
  eq(r.reject_reason, 'STATE_STALE_QUOTE', 'kalshi_quote_ts 15s old')
}
{
  // Boundary: 20s mlb (allowed); 21s mlb (rejected)
  const ok20 = await run({ bodyOverrides: { evidence: { mlb_state_ts: NOW - 20_000, kalshi_quote_ts: NOW - 500 } } })
  ok(ok20.ok, '20s mlb still fresh (boundary)')
  const r = await run({ bodyOverrides: { evidence: { mlb_state_ts: NOW - 20_001, kalshi_quote_ts: NOW - 500 } } })
  eq(r.reject_reason, 'STATE_STALE_MLB', '20.001s mlb stale')
}
{
  // Pregame mode bypasses state freshness
  const r = await run({ bodyOverrides: { strategy_mode: 'pregame_model', evidence: { mlb_state_ts: NOW - 100_000, kalshi_quote_ts: NOW - 100_000 } } })
  ok(r.ok, 'pregame skips state freshness')
}
{
  // Shadow STILL enforces freshness — confirms decision from spec
  const r = await run({ bodyOverrides: { execution_mode: 'shadow', evidence: { mlb_state_ts: NOW - 25_000, kalshi_quote_ts: NOW - 500 } } })
  eq(r.reject_reason, 'STATE_STALE_MLB', 'shadow still enforces mlb freshness')
}

// ─── Killswitches ────────────────────────────────────────────────────
section('KILLSWITCH_*')
{
  const r = await run({}, { killswitch: { gateway_kill_all: true } })
  eq(r.reject_reason, 'KILLSWITCH_ALL', 'kill_all=true → reject')
}
{
  const r = await run({}, { killswitch: { gateway_kill_agent: ['closer-legacy'] } })
  eq(r.reject_reason, 'KILLSWITCH_AGENT', 'kill_agent → reject')
  eq(r.context.agent, 'closer-legacy', 'context.agent set')
}
{
  // oracle still flows when only closer-legacy is killed
  const r = await run({ agent: 'oracle', secret: ORACLE_SECRET, bodyOverrides: { trace_event_type: 'oracle_judge_decision' } }, {
    killswitch: { gateway_kill_agent: ['closer-legacy'] },
    loadDecisionEvent: async (id) => ({ decision_id: id, agent_name: 'oracle', created_at: new Date(NOW - 5000).toISOString() }),
  })
  ok(r.ok, 'oracle accepted when only closer-legacy killed')
}
{
  const r = await run({}, { killswitch: { gateway_kill_mode: ['live_dead_path_no'] } })
  eq(r.reject_reason, 'KILLSWITCH_MODE', 'kill_mode → reject')
}
{
  const r = await run({}, { killswitch: { gateway_kill_account: ['adam'] } })
  eq(r.reject_reason, 'KILLSWITCH_ACCOUNT', 'kill_account → reject')
  eq(r.context.account_id, 'adam', 'context.account_id set')
}
{
  // isaiah still flows when only adam is killed
  const r = await run({ bodyOverrides: { account_id: 'isaiah' } }, {
    killswitch: { gateway_kill_account: ['adam'] },
  })
  ok(r.ok, 'isaiah accepted when only adam killed')
}

// ─── Version + monitor_only_stale_agent ─────────────────────────────
section('VERSION_BELOW_MIN + monitor_only')
{
  const r = await run({ version: '0.5.0' }, {
    killswitch: { min_version_by_agent: { 'closer-legacy': '0.7.0' } },
  })
  eq(r.reject_reason, 'VERSION_BELOW_MIN', 'production stale version → reject')
  ok(r.context.monitor_only_stale_agent === false, 'monitor_only=false in context')
}
{
  const r = await run({ version: '0.7.0' }, {
    killswitch: { min_version_by_agent: { 'closer-legacy': '0.7.0' } },
  })
  ok(r.ok, 'equal version is fine')
}
{
  const r = await run({ version: '0.7.5' }, {
    killswitch: { min_version_by_agent: { 'closer-legacy': '0.7.0' } },
  })
  ok(r.ok, 'newer version is fine')
}
{
  // shadow + monitor_only=true → allow despite stale version
  const r = await run({
    version: '0.5.0',
    bodyOverrides: { execution_mode: 'shadow' },
  }, {
    killswitch: {
      min_version_by_agent: { 'closer-legacy': '0.7.0' },
      monitor_only_stale_agent: { 'closer-legacy': true },
    },
  })
  ok(r.ok, 'shadow + monitor_only=true allows stale version')
}
{
  // production + monitor_only=true → still reject (monitor_only is shadow-only)
  const r = await run({ version: '0.5.0' }, {
    killswitch: {
      min_version_by_agent: { 'closer-legacy': '0.7.0' },
      monitor_only_stale_agent: { 'closer-legacy': true },
    },
  })
  eq(r.reject_reason, 'VERSION_BELOW_MIN', 'production blocked even with monitor_only=true')
}

// ─── COMMIT_NOT_ALLOWED ─────────────────────────────────────────────
section('COMMIT_NOT_ALLOWED')
{
  const r = await run({ commit: 'b'.repeat(40) }, {
    killswitch: { allowed_commit_hash_by_agent: { 'closer-legacy': ['a'.repeat(40)] } },
  })
  eq(r.reject_reason, 'COMMIT_NOT_ALLOWED', 'unauthorized commit → reject')
  eq(r.context.commit, 'b'.repeat(40), 'context.commit set')
}
{
  // Empty allowlist = no enforcement
  const r = await run({ commit: 'b'.repeat(40) }, {
    killswitch: { allowed_commit_hash_by_agent: { 'closer-legacy': [] } },
  })
  ok(r.ok, 'empty allowlist = no enforcement')
}

// ─── ORDER_USD_OVER_LIMIT ──────────────────────────────────────────
section('ORDER_USD_OVER_LIMIT')
{
  const r = await run({ bodyOverrides: { bet_amount_usd: 200 } }, {
    killswitch: { max_order_usd_by_mode: { live_dead_path_no: 100 } },
  })
  eq(r.reject_reason, 'ORDER_USD_OVER_LIMIT', '200 > 100 → reject')
  eq(r.context.bet_amount_usd, 200, 'context.bet_amount_usd')
  eq(r.context.limit_usd, 100, 'context.limit_usd')
}
{
  const r = await run({ bodyOverrides: { bet_amount_usd: 100 } }, {
    killswitch: { max_order_usd_by_mode: { live_dead_path_no: 100 } },
  })
  ok(r.ok, '100 == 100 → ok')
}

// ─── Account checks ────────────────────────────────────────────────
section('ACCOUNT_UNKNOWN / ACCOUNT_STATE_STALE / ACCOUNT_DAILY_LOSS_BREACHED / RISK_BREACHED')
{
  const r = await run({ bodyOverrides: { account_id: 'evil' } }, {
    loadAccount: async () => null,
  })
  eq(r.reject_reason, 'ACCOUNT_UNKNOWN', 'unknown account → reject')
}
{
  const r = await run({}, {
    loadAccount: async () => ({ ...DEFAULT_ACCOUNT, enabled: 0 }),
  })
  eq(r.reject_reason, 'ACCOUNT_UNKNOWN', 'disabled account → reject')
}
{
  const r = await run({}, {
    loadAccountState: async () => null,
  })
  eq(r.reject_reason, 'ACCOUNT_STATE_STALE', 'missing account state → reject')
}
{
  const r = await run({}, {
    loadAccountState: async () => ({ ...DEFAULT_ACCOUNT_STATE, updated_at: new Date(NOW - 90_000).toISOString() }),
  })
  eq(r.reject_reason, 'ACCOUNT_STATE_STALE', '90s stale (live) → reject')
  eq(r.context.limit_ms, 60_000, 'live limit = 60s')
}
{
  // Pregame allows up to 10min staleness
  const r = await run({ bodyOverrides: { strategy_mode: 'pregame_model' } }, {
    loadAccountState: async () => ({ ...DEFAULT_ACCOUNT_STATE, updated_at: new Date(NOW - 5 * 60_000).toISOString() }),
    loadDecisionEvent: async (id) => ({ decision_id: id, agent_name: 'closer-legacy', created_at: new Date(NOW - 60_000).toISOString() }),
  })
  ok(r.ok, '5min stale state on pregame → ok')
}
{
  // Pregame past 10min → reject
  const r = await run({ bodyOverrides: { strategy_mode: 'pregame_model' } }, {
    loadAccountState: async () => ({ ...DEFAULT_ACCOUNT_STATE, updated_at: new Date(NOW - 11 * 60_000).toISOString() }),
    loadDecisionEvent: async (id) => ({ decision_id: id, agent_name: 'closer-legacy', created_at: new Date(NOW - 60_000).toISOString() }),
  })
  eq(r.reject_reason, 'ACCOUNT_STATE_STALE', '11min stale on pregame → reject')
  eq(r.context.limit_ms, 600_000, 'pregame limit = 10min')
}
{
  // Shadow live mirrors production live: 60s window
  const r = await run({
    bodyOverrides: { execution_mode: 'shadow' },
  }, {
    loadAccountState: async () => ({ ...DEFAULT_ACCOUNT_STATE, updated_at: new Date(NOW - 90_000).toISOString() }),
  })
  eq(r.reject_reason, 'ACCOUNT_STATE_STALE', 'shadow live still 60s window')
}
{
  // Shadow pregame mirrors production pregame: 10min window
  const r = await run({
    bodyOverrides: { execution_mode: 'shadow', strategy_mode: 'pregame_model' },
  }, {
    loadAccountState: async () => ({ ...DEFAULT_ACCOUNT_STATE, updated_at: new Date(NOW - 5 * 60_000).toISOString() }),
    loadDecisionEvent: async (id) => ({ decision_id: id, agent_name: 'closer-legacy', created_at: new Date(NOW - 60_000).toISOString() }),
  })
  ok(r.ok, 'shadow pregame: 5min stale state ok')
}
{
  const r = await run({}, {
    loadAccountState: async () => ({ ...DEFAULT_ACCOUNT_STATE, updated_at: 'not-a-date' }),
  })
  eq(r.reject_reason, 'ACCOUNT_STATE_STALE', 'invalid updated_at → reject')
}
{
  // Realized loss already at limit, open risk pushes over
  const r = await run({}, {
    loadAccountState: async () => ({
      ...DEFAULT_ACCOUNT_STATE,
      realized_pnl_usd: -300,
      open_risk_usd: -300,
      daily_loss_limit_usd: 500,
    }),
  })
  eq(r.reject_reason, 'ACCOUNT_DAILY_LOSS_BREACHED', '600 > 500 → reject')
}
{
  // No loss limit set on row, falls back to killswitch
  const r = await run({}, {
    loadAccountState: async () => ({
      ...DEFAULT_ACCOUNT_STATE,
      realized_pnl_usd: -300, open_risk_usd: -300,
      daily_loss_limit_usd: null,
    }),
    killswitch: { daily_loss_limit_by_account: { adam: 200 } },
  })
  eq(r.reject_reason, 'ACCOUNT_DAILY_LOSS_BREACHED', 'killswitch fallback applies')
}
{
  const r = await run({ bodyOverrides: { bet_amount_usd: 600 } }, {
    loadAccountState: async () => ({
      ...DEFAULT_ACCOUNT_STATE,
      submitted_order_usd: 500,
      daily_risk_limit_usd: 1000,
    }),
  })
  eq(r.reject_reason, 'ACCOUNT_DAILY_RISK_BREACHED', '500+600 > 1000 → reject')
}

// ─── Decision lookup ──────────────────────────────────────────────
section('DECISION_NOT_FOUND / DECISION_AGENT_MISMATCH / DECISION_STALE')
{
  const r = await run({}, { loadDecisionEvent: async () => null })
  eq(r.reject_reason, 'DECISION_NOT_FOUND', 'decision missing → reject')
}
{
  const r = await run({}, {
    loadDecisionEvent: async (id) => ({ decision_id: id, agent_name: 'oracle', created_at: new Date(NOW - 5000).toISOString() }),
  })
  eq(r.reject_reason, 'DECISION_AGENT_MISMATCH', 'agent mismatch → reject')
  eq(r.context.decision_agent, 'oracle', 'context.decision_agent')
  eq(r.context.request_agent, 'closer-legacy', 'context.request_agent')
}
{
  // 45s old live-mode decision → stale
  const r = await run({}, {
    loadDecisionEvent: async (id) => ({ decision_id: id, agent_name: 'closer-legacy', created_at: new Date(NOW - 45_000).toISOString() }),
  })
  eq(r.reject_reason, 'DECISION_STALE', '45s live decision → stale')
}
{
  // 4min old pregame decision → fresh (under 5min cap)
  const r = await run({ bodyOverrides: { strategy_mode: 'pregame_model' } }, {
    loadDecisionEvent: async (id) => ({ decision_id: id, agent_name: 'closer-legacy', created_at: new Date(NOW - 4 * 60_000).toISOString() }),
  })
  ok(r.ok, '4min pregame decision still fresh')
}
{
  // 6min old pregame decision → stale
  const r = await run({ bodyOverrides: { strategy_mode: 'pregame_model' } }, {
    loadDecisionEvent: async (id) => ({ decision_id: id, agent_name: 'closer-legacy', created_at: new Date(NOW - 6 * 60_000).toISOString() }),
  })
  eq(r.reject_reason, 'DECISION_STALE', '6min pregame decision → stale')
}

// ─── DECISION_AGE_HIGH warning ─────────────────────────────────────
section('Warnings — DECISION_AGE_HIGH on live decisions 15-30s old')
{
  // 18s old live decision → ok with DECISION_AGE_HIGH warning
  const r = await run({}, {
    loadDecisionEvent: async (id) => ({ decision_id: id, agent_name: 'closer-legacy', created_at: new Date(NOW - 18_000).toISOString() }),
  })
  ok(r.ok, '18s live decision → ok')
  eq(r.warnings.length, 1, 'one warning')
  eq(r.warnings[0].code, 'DECISION_AGE_HIGH', 'warning code')
  ok(r.warnings[0].age_ms >= 17_000 && r.warnings[0].age_ms <= 19_000, 'age_ms in warning')
  eq(r.warnings[0].warn_threshold_ms, 15_000, 'warn threshold')
  eq(r.warnings[0].reject_threshold_ms, 30_000, 'reject threshold')
}
{
  // 10s old → ok with NO warning
  const r = await run({}, {
    loadDecisionEvent: async (id) => ({ decision_id: id, agent_name: 'closer-legacy', created_at: new Date(NOW - 10_000).toISOString() }),
  })
  ok(r.ok, '10s live decision → ok')
  eq(r.warnings.length, 0, 'no warning under 15s')
}
{
  // Pregame doesn't emit DECISION_AGE_HIGH (different budget)
  const r = await run({ bodyOverrides: { strategy_mode: 'pregame_model' } }, {
    loadDecisionEvent: async (id) => ({ decision_id: id, agent_name: 'closer-legacy', created_at: new Date(NOW - 60_000).toISOString() }),
  })
  ok(r.ok, '60s pregame decision → ok')
  eq(r.warnings.length, 0, 'no DECISION_AGE_HIGH for pregame')
}

// ─── Idempotency ──────────────────────────────────────────────────
section('Idempotency: replay + conflict')
{
  const body = defaultBody({ decision_id: 'idem-1' })
  const rawBody = JSON.stringify(body)
  const cached = {
    decision_id: 'idem-1',
    body_hash: sha256Hex(rawBody),
    last_status: 'accepted',
    kalshi_order_id: 'KS-100',
    response_json: '{"order_id":"KS-100"}',
  }
  const r = await run({ body }, { loadIdempotency: async () => cached })
  ok(r.ok, 'idempotent retry → ok')
  eq(r.idempotency.state, 'replay', 'state=replay')
  eq(r.idempotency.last_status, 'accepted', 'normalized last_status')
  eq(r.idempotency.kalshi_order_id, 'KS-100', 'normalized kalshi_order_id')
  ok(r.idempotency.cached, 'raw cached row also present')
}
{
  const body = defaultBody({ decision_id: 'idem-2' })
  const rawBody = JSON.stringify(body)
  const r = await run({ body, rawBody }, {
    loadIdempotency: async () => ({
      decision_id: 'idem-2',
      body_hash: 'f'.repeat(64),  // different hash
      last_status: 'accepted',
    }),
  })
  eq(r.reject_reason, 'IDEMPOTENCY_CONFLICT', 'different body → conflict')
  eq(r.context.existing_status, 'accepted', 'existing_status surfaced')
}
{
  // Replay an exchange_unknown → caller gets exchange_unknown back, no second exchange call
  const body = defaultBody({ decision_id: 'idem-unk' })
  const rawBody = JSON.stringify(body)
  const cached = {
    decision_id: 'idem-unk',
    body_hash: sha256Hex(rawBody),
    last_status: 'exchange_unknown',
    exchange_request_sent: 1,
    response_json: '{"status":"exchange_unknown"}',
  }
  const r = await run({ body, rawBody }, { loadIdempotency: async () => cached })
  ok(r.ok, 'replay of exchange_unknown still returns ok with replay state')
  eq(r.idempotency.state, 'replay', 'state=replay')
  eq(r.idempotency.last_status, 'exchange_unknown', 'normalized last_status preserved')
}

// ─── halt + DB_DOWN sentinels ─────────────────────────────────────
section('GATEWAY_HALTED + DB_DOWN sentinels')
{
  const r = await run({}, { halted: true })
  eq(r.reject_reason, 'GATEWAY_HALTED', 'halted → reject')
}
{
  const req = makeRequest()
  const r = await validatePlaceIntent({ ...req, killswitch: null, loaders: {} })
  eq(r.reject_reason, 'DB_DOWN', 'missing killswitch → DB_DOWN')
}
{
  const req = makeRequest()
  const r = await validatePlaceIntent({ ...req, killswitch: DEFAULT_KILLSWITCH, loaders: null })
  eq(r.reject_reason, 'DB_DOWN', 'missing loaders → DB_DOWN')
}

// ─── semverLt unit tests ─────────────────────────────────────────
section('semverLt — core semantics')
ok(semverLt('0.7.3', '0.8.0'),  '0.7.3 < 0.8.0')
ok(semverLt('0.7.3', '1.0.0'),  '0.7.3 < 1.0.0')
ok(semverLt('0.7.3', '0.7.4'),  '0.7.3 < 0.7.4')
ok(!semverLt('0.7.3', '0.7.3'), '0.7.3 not < 0.7.3')
ok(!semverLt('0.8.0', '0.7.3'), '0.8.0 not < 0.7.3')
ok(!semverLt('1.0.0', '0.7.3'), '1.0.0 not < 0.7.3')
ok(semverLt('0.7', '0.7.1'),    '0.7 < 0.7.1 (missing parts = 0)')
ok(!semverLt('0.7.0', '0.7'),   '0.7.0 not < 0.7')

section('semverLt — prerelease handling (locked)')
ok(semverLt('0.7.3-rc1', '0.7.3'), '0.7.3-rc1 < 0.7.3 (RC < GA)')
ok(!semverLt('0.7.3', '0.7.3-rc1'), '0.7.3 not < 0.7.3-rc1 (GA > RC)')
ok(semverLt('0.7.3-rc1', '0.7.4'),  '0.7.3-rc1 < 0.7.4 (core wins)')
ok(semverLt('0.7.3-rc1', '0.7.3-rc2'), 'rc1 < rc2 (lexical)')
ok(!semverLt('0.7.3-rc2', '0.7.3-rc1'), 'rc2 not < rc1')

section('Prerelease + version floor: RC blocked unless commit allowlisted')
{
  // RC against GA floor → blocked
  const r = await run({ version: '0.7.3-rc1' }, {
    killswitch: { min_version_by_agent: { 'closer-legacy': '0.7.3' } },
  })
  eq(r.reject_reason, 'VERSION_BELOW_MIN', 'RC against GA floor → reject')
}
{
  // RC against same RC floor → ok
  const r = await run({ version: '0.7.3-rc1' }, {
    killswitch: { min_version_by_agent: { 'closer-legacy': '0.7.3-rc1' } },
  })
  ok(r.ok, 'RC at the same RC floor → ok')
}

// ─── Order: cheap rejects fire before DB calls ──────────────────────
section('Cheap rejects do not reach DB loaders')
{
  let dbHits = 0
  const r = await validatePlaceIntent({
    ...makeRequest({ timestamp: NOW - 60_000 }),  // stale ts
    ...makeContext({
      loadAccount:        async () => { dbHits++; return DEFAULT_ACCOUNT },
      loadAccountState:   async () => { dbHits++; return DEFAULT_ACCOUNT_STATE },
      loadDecisionEvent:  async () => { dbHits++; return DEFAULT_DECISION },
      loadIdempotency:    async () => { dbHits++; return null },
    }),
  })
  eq(r.reject_reason, 'HMAC_INVALID', 'stale ts rejected')
  eq(dbHits, 0, 'no DB hits when HMAC fails fast')
}

// ─── Summary ───────────────────────────────────────────────────────
console.log(`\n${_passed} passed, ${_failed} failed`)
process.exit(_failed > 0 ? 1 : 0)
