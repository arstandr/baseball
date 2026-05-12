// scripts/tests/oracleGatewayOrchestratorTest.js
//
// End-to-end orchestrator tests using injected mocks for every dep.
// Covers spec fixtures: F1 (happy), F19 (shadow), F22 (unknown), F23 (error),
// F24/F25 (replay), F26 (blind halt), DECISION_AGE_HIGH warning, halt fast-path,
// all reject mappings.
//
// Run: node scripts/tests/oracleGatewayOrchestratorTest.js

import crypto from 'node:crypto'
import { executePlaceIntent, GATEWAY_STATUS } from '../../oracle/layers/6-gateway/orchestrator.js'
import { sign, sha256Hex } from '../../oracle/layers/6-gateway/hmac.js'

let _passed = 0, _failed = 0
const ok  = (c, l) => c ? _passed++ : (_failed++, console.error(`FAIL [${l}]`))
const eq  = (a, b, l) => a === b ? _passed++ : (_failed++, console.error(`FAIL [${l}]: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`))
const section = n => console.log(`\n── ${n} ──`)

const SECRET = 'test-secret-closer'
const NOW = 1714499000000
const AGENT = 'closer-legacy'

function defaultBody(o = {}) {
  return {
    decision_id: 'd-' + crypto.randomUUID(),
    decision_input_hash: 'a'.repeat(64),
    trace_event_type: 'closer_legacy_decision',
    account_id: 'adam',
    execution_mode: 'production',
    strategy_mode: 'live_dead_path_no',
    market_ticker: 'KX-MLB-CIN-LORENZEN-5',
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
    bankroll_at_decision_usd: 5000,
    kelly_fraction: 0.05,
    expected_pK_low: 0.5,
    expected_pK_high: 0.7,
    evidence: {
      mlb_state_hash: 'b'.repeat(64),    mlb_state_ts:    NOW - 1000,
      kalshi_quote_hash: 'c'.repeat(64), kalshi_quote_ts: NOW - 500,
      position_hash: 'd'.repeat(64),     position_ts:     NOW - 1000,
      orderbook_hash: 'e'.repeat(64),    orderbook_ts:    NOW - 500,
    },
    ...o,
  }
}

function makeReq(opts = {}) {
  const body = opts.body ?? defaultBody(opts.bodyOverrides)
  const rawBody = opts.rawBody ?? JSON.stringify(body)
  const bodySha = sha256Hex(rawBody)
  const ts = opts.timestamp ?? NOW
  const nonce = opts.nonce ?? 'n-' + crypto.randomUUID()
  const headers = {
    'x-gateway-agent': AGENT,
    'x-gateway-agent-version': '0.7.3',
    'x-gateway-commit': 'a'.repeat(40),
    'x-gateway-timestamp': String(ts),
    'x-gateway-nonce': nonce,
    'x-gateway-body-sha256': bodySha,
    'x-gateway-signature': sign({ secret: SECRET, timestamp: ts, nonce, bodySha256: bodySha }),
  }
  return { headers, rawBody, body, sourceIp: '127.0.0.1', tradingDate: '2026-04-30' }
}

const DEFAULT_KS = {
  gateway_kill_all: false, gateway_kill_agent: [], gateway_kill_mode: [], gateway_kill_account: [],
  min_version_by_agent: {}, monitor_only_stale_agent: {}, allowed_commit_hash_by_agent: {},
  daily_loss_limit_by_account: {}, daily_risk_limit_by_account: {}, max_order_usd_by_mode: {},
}

function defaultLoaders(opts = {}) {
  return {
    insertNonce: opts.insertNonce ?? (async () => {}),
    loadAccount: opts.loadAccount ?? (async (id) => ({ account_id: id, enabled: 1, daily_loss_limit_usd: 500, daily_risk_limit_usd: 1000 })),
    loadAccountState: opts.loadAccountState ?? (async () => ({
      account_id: 'adam', trading_date: '2026-04-30',
      realized_pnl_usd: 0, open_risk_usd: 0, submitted_order_usd: 0,
      daily_loss_limit_usd: 500, daily_risk_limit_usd: 1000,
      updated_at: new Date(NOW - 5_000).toISOString(),
    })),
    loadDecisionEvent: opts.loadDecisionEvent ?? (async (id) => ({ decision_id: id, agent_name: 'closer-legacy', created_at: new Date(NOW - 5000).toISOString() })),
    loadIdempotency:   opts.loadIdempotency ?? (async () => null),
  }
}

function makeMockTrace() {
  const events = { sync: [], async: [] }
  let throwSync = null      // function to maybe throw
  let throwAsync = null
  return {
    events,
    setSyncFailure(fn) { throwSync = fn },
    setAsyncFailure(fn) { throwAsync = fn },
    api: {
      makeEvent(p) {
        // Mimic Layer 0 makeEvent — return a structurally-valid event
        return {
          id: crypto.randomUUID(),
          decision_id: p.decision_id,
          parent_event_id: null,
          trace_schema_version: '1.0.0',
          created_at: new Date(NOW).toISOString(),
          layer_name: p.layer_name,
          event_type: p.event_type,
          pitcher_id: p.pitcher_id, pitcher_name: p.pitcher_name,
          bet_date: p.bet_date, strike: p.strike, side: p.side,
          decision: p.decision, reason_code: p.reason_code,
          reasoning: p.reasoning, metrics: p.metrics,
        }
      },
      writeSync: async (ev) => {
        if (throwSync && throwSync(ev)) throw new Error('mock_writeSync_failure')
        events.sync.push(ev)
      },
      writeAsync: async (ev) => {
        if (throwAsync && throwAsync(ev)) throw new Error('mock_writeAsync_failure')
        events.async.push(ev)
      },
    },
  }
}

function makeMockKalshi(behavior = { outcome: 'success', kalshi_order_id: 'KS-1' }) {
  let lastCall = null
  return {
    setBehavior(b) { behavior = typeof b === 'function' ? b : b },
    lastCall: () => lastCall,
    api: {
      place: async (params) => {
        lastCall = params
        const b = typeof behavior === 'function' ? behavior(params) : behavior
        if (b.throw) throw new Error(b.throw)
        return b
      },
    },
  }
}

function makeMockIdempotencyStore(initial = null) {
  const rows = new Map()
  if (initial) rows.set(initial.decision_id, initial)
  return {
    rows,
    api: {
      upsert: async (row) => { rows.set(row.decision_id, { ...rows.get(row.decision_id), ...row }) },
      get: async (id) => rows.get(id) ?? null,
    },
  }
}

function makeMockUnknownsStore() {
  const queue = []
  let throwOnEnqueue = false
  return {
    queue,
    setThrow(b) { throwOnEnqueue = b },
    api: {
      enqueue: async (row) => {
        if (throwOnEnqueue) throw new Error('mock_enqueue_failure')
        queue.push(row)
      },
    },
  }
}

function makeMockDeadLetter() {
  const writes = []
  let throwOnWrite = false
  return {
    writes,
    setThrow(b) { throwOnWrite = b },
    api: {
      write: async (record) => {
        if (throwOnWrite) throw new Error('mock_dead_letter_failure')
        writes.push(record)
      },
    },
  }
}

function makeMockHalt() {
  let blind = null
  return {
    isBlind: () => blind != null,
    blindReason: () => blind,
    api: {
      isHalted: () => blind != null,
      setBlind: (info) => { blind = info },
      peekStatus: () => ({ blind }),
    },
  }
}

function makeKsCache(ks = DEFAULT_KS) {
  return { get: async () => ks }
}

async function runOnce(opts = {}) {
  const trace = makeMockTrace()
  const kalshi = makeMockKalshi(opts.kalshiBehavior)
  const idem = makeMockIdempotencyStore(opts.initialIdempotency ?? null)
  const unk = makeMockUnknownsStore()
  const dl = makeMockDeadLetter()
  const halt = makeMockHalt()
  if (opts.preBlind) halt.api.setBlind({ reason: 'GATEWAY_BLIND', detail: 'pretest', at: new Date(NOW).toISOString() })

  if (opts.traceSyncFail) trace.setSyncFailure(opts.traceSyncFail)
  if (opts.deadLetterThrow) dl.setThrow(true)
  if (opts.unknownsEnqueueThrow) unk.setThrow(true)

  const req = makeReq(opts.req ?? {})
  const ksSnapshot = opts.killswitch ?? DEFAULT_KS

  const result = await executePlaceIntent(req, {
    trace: trace.api,
    kalshi: kalshi.api,
    idempotencyStore: idem.api,
    unknownsStore:    unk.api,
    deadLetter:       dl.api,
    halt:             halt.api,
    killswitchCache:  makeKsCache(ksSnapshot),
    agentSecrets:     { 'closer-legacy': SECRET },
    loaders:          defaultLoaders(opts.loaders ?? {}),
    now:              () => NOW,
  })
  return { result, trace, kalshi, idem, unk, dl, halt, req }
}

// ─── F1: Production happy path ─────────────────────────────────────────
section('F1 — production happy path')
{
  const { result, trace, kalshi, idem, unk } = await runOnce()
  eq(result.status, GATEWAY_STATUS.ACCEPTED, 'status=accepted')
  eq(result.kalshi_order_id, 'KS-1', 'order_id returned')
  eq(result.exchange_status, 'placed', 'exchange_status=placed')
  ok(result.trace_event_id_intent && result.trace_event_id_result, 'both event ids set')
  eq(trace.events.sync.length, 2, '2 sync events (intent + result)')
  eq(trace.events.sync[0].event_type, 'gateway_intent', 'first is intent')
  eq(trace.events.sync[1].event_type, 'gateway_result', 'second is result')
  eq(trace.events.sync[1].parent_event_id, trace.events.sync[0].id, 'result links to intent')
  ok(kalshi.lastCall(), 'kalshi.place was called')
  eq(idem.rows.size, 1, 'idempotency row written')
  const idemRow = [...idem.rows.values()][0]
  eq(idemRow.last_status, 'accepted', 'idempotency last_status=accepted')
  eq(idemRow.exchange_request_sent, 1, 'request_sent=1')
  eq(idemRow.kalshi_order_id, 'KS-1', 'idempotency carries order_id')
  eq(unk.queue.length, 0, 'no unknowns enqueued')
}

// ─── F19: Shadow mode ──────────────────────────────────────────────────
section('F19 — shadow mode skips exchange call')
{
  const { result, trace, kalshi, idem } = await runOnce({
    req: { bodyOverrides: { execution_mode: 'shadow' } },
  })
  eq(result.status, GATEWAY_STATUS.SHADOW_LOGGED, 'status=shadow_logged')
  ok(!kalshi.lastCall(), 'kalshi.place NOT called')
  eq(trace.events.sync.length, 2, 'still wrote intent + result')
  eq(trace.events.sync[1].decision, 'shadow', 'result decision=shadow')
  const idemRow = [...idem.rows.values()][0]
  eq(idemRow.last_status, 'shadow_logged', 'shadow idempotency stored')
  eq(idemRow.exchange_request_sent, 0, 'request_sent=0 in shadow')
}

// ─── F22: Exchange unknown → reconciliation queued ─────────────────────
section('F22 — exchange_unknown enqueues reconciliation row')
{
  const { result, trace, idem, unk } = await runOnce({
    kalshiBehavior: { outcome: 'unknown', raw_response: { error: 'timeout' } },
  })
  eq(result.status, GATEWAY_STATUS.EXCHANGE_UNKNOWN, 'status=exchange_unknown')
  eq(result.reconciliation_state, 'pending', 'reconciliation pending')
  eq(unk.queue.length, 1, '1 unknown enqueued')
  eq(unk.queue[0].market_ticker, 'KX-MLB-CIN-LORENZEN-5', 'unknown row carries market')
  const idemRow = [...idem.rows.values()][0]
  eq(idemRow.last_status, 'exchange_unknown', 'idempotency last_status=exchange_unknown')
  eq(idemRow.exchange_request_sent, 1, 'request_sent=1 (we did try)')
  eq(idemRow.kalshi_order_id, null, 'order_id null for unknown')
  ok(trace.events.sync.length >= 2, 'intent + result both written')
  eq(trace.events.sync[1].decision, 'unknown', 'result decision=unknown')
}

// ─── F23: Exchange error (4xx, definitive) ─────────────────────────────
section('F23 — exchange_error (definitive 4xx)')
{
  const { result, trace, idem, unk } = await runOnce({
    kalshiBehavior: { outcome: 'error', error_code: 'insufficient_funds', raw_response: { code: 'insufficient_funds' } },
  })
  eq(result.status, GATEWAY_STATUS.EXCHANGE_ERROR, 'status=exchange_error')
  eq(result.error_code, 'insufficient_funds', 'error_code surfaced')
  eq(unk.queue.length, 0, 'NOT enqueued for reconciliation (definitive)')
  const idemRow = [...idem.rows.values()][0]
  eq(idemRow.last_status, 'exchange_error', 'idempotency last_status=exchange_error')
  ok(trace.events.sync.length >= 2, 'intent + result written')
  eq(trace.events.sync[1].decision, 'reject', 'result decision=reject for error')
}

// ─── F24: Replay after exchange_unknown — no second Kalshi call ─────────
section('F24 — replay after exchange_unknown')
{
  const decision_id = 'idem-unk-1'
  const body = defaultBody({ decision_id })
  const rawBody = JSON.stringify(body)
  const cached = {
    decision_id,
    body_hash: sha256Hex(rawBody),
    last_status: 'exchange_unknown',
    exchange_request_sent: 1,
    kalshi_order_id: null,
    exchange_status: 'unknown',
    response_json: '{"status":"exchange_unknown"}',
  }
  const { result, trace, kalshi } = await runOnce({
    req: { body, rawBody },
    loaders: { loadIdempotency: async () => cached },
  })
  eq(result.status, GATEWAY_STATUS.REPLAY, 'status=replay')
  eq(result.last_status, 'exchange_unknown', 'last_status=exchange_unknown')
  ok(!kalshi.lastCall(), 'NO second Kalshi call')
  eq(trace.events.sync.length, 0, 'no Trace writeSync (full short-circuit)')
}

// ─── F25: Replay after accepted ─────────────────────────────────────────
section('F25 — replay after accepted')
{
  const decision_id = 'idem-acc-1'
  const body = defaultBody({ decision_id })
  const rawBody = JSON.stringify(body)
  const cached = {
    decision_id,
    body_hash: sha256Hex(rawBody),
    last_status: 'accepted',
    exchange_request_sent: 1,
    kalshi_order_id: 'KS-CACHED',
    exchange_status: 'placed',
    response_json: '{"status":"accepted","kalshi_order_id":"KS-CACHED"}',
  }
  const { result, kalshi } = await runOnce({
    req: { body, rawBody },
    loaders: { loadIdempotency: async () => cached },
  })
  eq(result.status, GATEWAY_STATUS.REPLAY, 'status=replay')
  eq(result.kalshi_order_id, 'KS-CACHED', 'cached order_id returned')
  eq(result.last_status, 'accepted', 'cached last_status returned')
  ok(!kalshi.lastCall(), 'NO second Kalshi call')
}

// ─── F26: post-exchange Trace fail + dead-letter fail → blind halt ─────
section('F26 — post-exchange Trace fail + dead-letter fail → GATEWAY_BLIND')
{
  // Make the SECOND writeSync (gateway_result) fail; leave intent successful
  let intentWritten = false
  const opts = {
    traceSyncFail: (ev) => {
      if (ev.event_type === 'gateway_intent') { intentWritten = true; return false }
      if (ev.event_type === 'gateway_result') return true
      return false
    },
    deadLetterThrow: true,
  }
  const { result, halt, dl } = await runOnce(opts)
  ok(intentWritten, 'intent did write')
  ok(result._gateway_blind, '_gateway_blind=true on response')
  ok(halt.isBlind(), 'halt.isBlind() = true')
  eq(dl.writes.length, 0, 'dead-letter write threw, so writes array empty')
}

// ─── F26b: Post-exchange Trace fail BUT dead-letter ok → no halt ───────
section('Post-exchange Trace fail, dead-letter succeeds → no halt + critical alert')
{
  const opts = {
    traceSyncFail: (ev) => ev.event_type === 'gateway_result',
    deadLetterThrow: false,
  }
  const { result, halt, dl, trace } = await runOnce(opts)
  eq(result.status, GATEWAY_STATUS.ACCEPTED, 'response still accepted (order is real)')
  ok(!result._gateway_blind, 'no blind flag')
  ok(!halt.isBlind(), 'no halt')
  eq(dl.writes.length, 1, 'one dead-letter row written')
  // POST_EXCHANGE_TRACE_GAP critical alert via writeAsync
  const postGap = trace.events.async.find(e => e.event_type === 'POST_EXCHANGE_TRACE_GAP')
  ok(postGap, 'POST_EXCHANGE_TRACE_GAP critical async-emitted')
}

// ─── Halt fast-path ────────────────────────────────────────────────────
section('Halt fast-path returns halted')
{
  const { result, kalshi, trace } = await runOnce({ preBlind: true })
  eq(result.status, GATEWAY_STATUS.HALTED, 'status=halted')
  ok(!kalshi.lastCall(), 'no exchange call when halted')
  eq(trace.events.sync.length, 0, 'no sync writes when halted')
}

// ─── Reject mappings ──────────────────────────────────────────────────
section('Reject mapping → status=rejected')
{
  // Force ENUM_INVALID via bad strategy_mode
  const { result, kalshi, trace } = await runOnce({
    req: { bodyOverrides: { strategy_mode: 'live_yes' } },
  })
  eq(result.status, GATEWAY_STATUS.REJECTED, 'status=rejected')
  eq(result.reject_reason, 'ENUM_INVALID', 'reject_reason surfaced')
  ok(!kalshi.lastCall(), 'no exchange on reject')
  // best-effort writeAsync of the reject event
  const ev = trace.events.async.find(e => e.event_type === 'gateway_reject')
  ok(ev, 'gateway_reject Trace event written async')
  eq(ev.reason_code, 'ENUM_INVALID', 'reject event has reason_code')
}
{
  // HMAC failure should also map to rejected with reject_reason=HMAC_INVALID
  const req = makeReq()
  delete req.headers['x-gateway-signature']
  const trace = makeMockTrace()
  const result = await executePlaceIntent(req, {
    trace: trace.api,
    kalshi: makeMockKalshi().api,
    idempotencyStore: makeMockIdempotencyStore().api,
    unknownsStore:    makeMockUnknownsStore().api,
    deadLetter:       makeMockDeadLetter().api,
    halt:             makeMockHalt().api,
    killswitchCache:  makeKsCache(),
    agentSecrets:     { 'closer-legacy': SECRET },
    loaders:          defaultLoaders(),
    now:              () => NOW,
  })
  eq(result.status, GATEWAY_STATUS.REJECTED, 'HMAC fail → rejected')
  eq(result.reject_reason, 'HMAC_INVALID', 'reject_reason=HMAC_INVALID')
}
{
  // IDEMPOTENCY_CONFLICT → rejected with that reject_reason (per spec §3)
  const decision_id = 'idem-conflict'
  const body = defaultBody({ decision_id })
  const rawBody = JSON.stringify(body)
  const { result } = await runOnce({
    req: { body, rawBody },
    loaders: {
      loadIdempotency: async () => ({
        decision_id, body_hash: 'f'.repeat(64), last_status: 'accepted',
      }),
    },
  })
  eq(result.status, GATEWAY_STATUS.REJECTED, 'conflict → rejected')
  eq(result.reject_reason, 'IDEMPOTENCY_CONFLICT', 'reject_reason=IDEMPOTENCY_CONFLICT')
}

// ─── DECISION_AGE_HIGH warning ────────────────────────────────────────
section('DECISION_AGE_HIGH warning written to Trace as severity=warn')
{
  const { result, trace } = await runOnce({
    loaders: {
      loadDecisionEvent: async (id) => ({
        decision_id: id, agent_name: 'closer-legacy',
        created_at: new Date(NOW - 18_000).toISOString(),
      }),
    },
  })
  eq(result.status, GATEWAY_STATUS.ACCEPTED, 'still accepted')
  const warnEv = trace.events.async.find(e => e.event_type === 'gateway_warning')
  ok(warnEv, 'gateway_warning event emitted async')
  eq(warnEv.reason_code, 'DECISION_AGE_HIGH', 'warning code surfaced')
  ok(warnEv.metrics.age_ms >= 17_000, 'warning carries age_ms')
}

// ─── Killswitch load failure → DB_DOWN ────────────────────────────────
section('Killswitch cache failure → DB_DOWN reject')
{
  const trace = makeMockTrace()
  const result = await executePlaceIntent(makeReq(), {
    trace: trace.api,
    kalshi: makeMockKalshi().api,
    idempotencyStore: makeMockIdempotencyStore().api,
    unknownsStore:    makeMockUnknownsStore().api,
    deadLetter:       makeMockDeadLetter().api,
    halt:             makeMockHalt().api,
    killswitchCache:  { get: async () => { throw new Error('Turso down') } },
    agentSecrets:     { 'closer-legacy': SECRET },
    loaders:          defaultLoaders(),
    now:              () => NOW,
  })
  eq(result.status, GATEWAY_STATUS.REJECTED, 'killswitch fetch fail → rejected')
  eq(result.reject_reason, 'DB_DOWN', 'reject_reason=DB_DOWN')
}

// ─── Trace intent writeSync fail → TRACE_DOWN, no exchange ──────────
section('Trace intent writeSync fails → TRACE_DOWN, no exchange call')
{
  const { result, kalshi } = await runOnce({
    traceSyncFail: (ev) => ev.event_type === 'gateway_intent',
  })
  eq(result.status, GATEWAY_STATUS.REJECTED, 'TRACE_DOWN → rejected')
  eq(result.reject_reason, 'TRACE_DOWN', 'reject_reason=TRACE_DOWN')
  ok(!kalshi.lastCall(), 'no exchange call after trace_down')
}

// ─── Unknown enqueue fail → critical alert, response still returned ──
section('unknownsStore.enqueue throws → critical alert + response still returned')
{
  const { result, trace } = await runOnce({
    kalshiBehavior: { outcome: 'unknown', raw_response: { error: 'timeout' } },
    unknownsEnqueueThrow: true,
  })
  eq(result.status, GATEWAY_STATUS.EXCHANGE_UNKNOWN, 'status still exchange_unknown')
  const alert = trace.events.async.find(e => e.event_type === 'gateway_unknown_enqueue_failed')
  ok(alert, 'gateway_unknown_enqueue_failed critical event emitted')
}

// ─── Latency reporting ────────────────────────────────────────────────
section('Latency object on every response')
{
  const { result } = await runOnce()
  ok(result.latency_ms, 'latency_ms set')
  ok(typeof result.latency_ms.total === 'number', 'latency_ms.total is number')
}

// ─── Summary ──────────────────────────────────────────────────────────
console.log(`\n${_passed} passed, ${_failed} failed`)
process.exit(_failed > 0 ? 1 : 0)
