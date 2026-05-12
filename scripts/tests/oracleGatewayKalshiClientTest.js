// scripts/tests/oracleGatewayKalshiClientTest.js
//
// Unit tests for oracle/layers/6-gateway/kalshiClient.js.
// Mocks lib/kalshi.js methods to exercise outcome classification
// across every error path: 4xx, 5xx, network/timeout, missing creds,
// gateway timeout.
//
// Run: node scripts/tests/oracleGatewayKalshiClientTest.js

import { makeKalshiClient, deriveClientOrderId } from '../../oracle/layers/6-gateway/kalshiClient.js'

let _passed = 0, _failed = 0
const ok  = (c, l) => c ? _passed++ : (_failed++, console.error(`FAIL [${l}]`))
const eq  = (a, b, l) => a === b ? _passed++ : (_failed++, console.error(`FAIL [${l}]: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`))
const section = n => console.log(`\n── ${n} ──`)

const VALID_CREDS = {
  adam:   { KALSHI_API_KEY_ID: 'k-adam',   KALSHI_PRIVATE_KEY_PEM: '-----BEGIN-----\nADAM\n-----END-----' },
  isaiah: { KALSHI_API_KEY_ID: 'k-isaiah', KALSHI_PRIVATE_KEY_PEM: '-----BEGIN-----\nISAIAH\n-----END-----' },
}

function makeStubLib(behavior = {}) {
  return {
    placeOrder:  async (...args) => {
      if (behavior.placeOrder) return behavior.placeOrder(...args)
      throw new Error('no placeOrder behavior')
    },
    cancelOrder: async (...args) => {
      if (behavior.cancelOrder) return behavior.cancelOrder(...args)
      throw new Error('no cancelOrder behavior')
    },
    amendOrder:  async (...args) => {
      if (behavior.amendOrder) return behavior.amendOrder(...args)
      throw new Error('no amendOrder behavior')
    },
  }
}

const ORDER_PARAMS = {
  account_id:        'adam',
  market_ticker:     'KX-MLB-CIN-LORENZEN-5',
  contract_side:     'no',
  action:            'buy',
  quantity:          10,
  limit_price_cents: 30,
  decision_id:       'd-1',
}

// ─── Constructor validation ────────────────────────────────────────────
section('constructor validation')
{
  let threw = false
  try { makeKalshiClient({}) } catch { threw = true }
  ok(threw, 'no kalshiLib → throws')
}
{
  let threw = false
  try { makeKalshiClient({ kalshiLib: { /* missing placeOrder */ } }) } catch { threw = true }
  ok(threw, 'partial kalshiLib → throws')
}

// ─── place: success ────────────────────────────────────────────────────
section('place — success → outcome=success + kalshi_order_id extracted')
{
  const stubLib = makeStubLib({
    placeOrder: async (ticker, side, contracts, price, creds, action) => {
      // Return Kalshi-shaped response
      return { order: { order_id: 'KS-100', status: 'placed', ticker, side, count: contracts, price, action } }
    },
  })
  const client = makeKalshiClient({ kalshiLib: stubLib, credentials: VALID_CREDS })
  const r = await client.place(ORDER_PARAMS)
  eq(r.outcome, 'success', 'outcome=success')
  eq(r.kalshi_order_id, 'KS-100', 'order_id extracted from order.order_id')
  ok(r.raw_response, 'raw_response present')
}
{
  // Alternate response shape: order_id at top level
  const stubLib = makeStubLib({ placeOrder: async () => ({ order_id: 'KS-200', status: 'placed' }) })
  const client = makeKalshiClient({ kalshiLib: stubLib, credentials: VALID_CREDS })
  const r = await client.place(ORDER_PARAMS)
  eq(r.kalshi_order_id, 'KS-200', 'order_id extracted from top-level order_id')
}
{
  // No order_id in response → kalshi_order_id=null but still success
  const stubLib = makeStubLib({ placeOrder: async () => ({ status: 'placed' }) })
  const client = makeKalshiClient({ kalshiLib: stubLib, credentials: VALID_CREDS })
  const r = await client.place(ORDER_PARAMS)
  eq(r.outcome, 'success', 'still success without order_id')
  eq(r.kalshi_order_id, null, 'order_id=null')
}

// ─── place: HTTP 4xx → error (definitive) ──────────────────────────────
section('place — HTTP 4xx → outcome=error with http_NNN code')
{
  const stubLib = makeStubLib({
    placeOrder: async () => { throw new Error('kalshi POST /portfolio/orders -> 400 {"error":"insufficient_balance"}') },
  })
  const client = makeKalshiClient({ kalshiLib: stubLib, credentials: VALID_CREDS })
  const r = await client.place(ORDER_PARAMS)
  eq(r.outcome, 'error', 'outcome=error on 400')
  eq(r.error_code, 'http_400', 'error_code=http_400')
}
{
  const stubLib = makeStubLib({
    placeOrder: async () => { throw new Error('kalshi POST /portfolio/orders -> 422 {"error":"market_closed"}') },
  })
  const client = makeKalshiClient({ kalshiLib: stubLib, credentials: VALID_CREDS })
  const r = await client.place(ORDER_PARAMS)
  eq(r.error_code, 'http_422', 'error_code=http_422')
}
{
  const stubLib = makeStubLib({
    placeOrder: async () => { throw new Error('kalshi POST /portfolio/orders -> 401 {"error":"unauthorized"}') },
  })
  const client = makeKalshiClient({ kalshiLib: stubLib, credentials: VALID_CREDS })
  const r = await client.place(ORDER_PARAMS)
  eq(r.outcome, 'error', '401 → error')
  eq(r.error_code, 'http_401', '401 → http_401')
}

// ─── place: HTTP 5xx → unknown ────────────────────────────────────────
section('place — HTTP 5xx → outcome=unknown')
{
  const stubLib = makeStubLib({
    placeOrder: async () => { throw new Error('kalshi POST /portfolio/orders -> 500 {"error":"internal_error"}') },
  })
  const client = makeKalshiClient({ kalshiLib: stubLib, credentials: VALID_CREDS })
  const r = await client.place(ORDER_PARAMS)
  eq(r.outcome, 'unknown', '500 → unknown')
  ok(!r.error_code, 'no error_code for unknown')
}
{
  const stubLib = makeStubLib({
    placeOrder: async () => { throw new Error('kalshi POST /portfolio/orders -> 502 Bad Gateway') },
  })
  const client = makeKalshiClient({ kalshiLib: stubLib, credentials: VALID_CREDS })
  const r = await client.place(ORDER_PARAMS)
  eq(r.outcome, 'unknown', '502 → unknown')
}
{
  const stubLib = makeStubLib({
    placeOrder: async () => { throw new Error('kalshi POST /portfolio/orders -> 503 Service Unavailable') },
  })
  const client = makeKalshiClient({ kalshiLib: stubLib, credentials: VALID_CREDS })
  const r = await client.place(ORDER_PARAMS)
  eq(r.outcome, 'unknown', '503 → unknown')
}

// ─── place: network errors → unknown ──────────────────────────────────
section('place — network/timeout errors → outcome=unknown')
{
  const stubLib = makeStubLib({ placeOrder: async () => { throw new Error('timeout of 20000ms exceeded') } })
  const client = makeKalshiClient({ kalshiLib: stubLib, credentials: VALID_CREDS })
  const r = await client.place(ORDER_PARAMS)
  eq(r.outcome, 'unknown', 'timeout msg → unknown')
}
{
  const stubLib = makeStubLib({ placeOrder: async () => { throw new Error('connect ECONNREFUSED 1.2.3.4:443') } })
  const client = makeKalshiClient({ kalshiLib: stubLib, credentials: VALID_CREDS })
  const r = await client.place(ORDER_PARAMS)
  eq(r.outcome, 'unknown', 'ECONNREFUSED → unknown')
}
{
  const stubLib = makeStubLib({ placeOrder: async () => { throw new Error('getaddrinfo ENOTFOUND trading-api.kalshi.com') } })
  const client = makeKalshiClient({ kalshiLib: stubLib, credentials: VALID_CREDS })
  const r = await client.place(ORDER_PARAMS)
  eq(r.outcome, 'unknown', 'ENOTFOUND → unknown')
}
{
  const stubLib = makeStubLib({ placeOrder: async () => { throw new Error('socket hang up') } })
  const client = makeKalshiClient({ kalshiLib: stubLib, credentials: VALID_CREDS })
  const r = await client.place(ORDER_PARAMS)
  eq(r.outcome, 'unknown', 'socket hang up → unknown (default)')
}

// ─── place: gateway-side timeout → unknown ─────────────────────────────
section('place — gateway timeout fires before response → unknown')
{
  const stubLib = makeStubLib({
    placeOrder: async () => new Promise(() => {}),  // hang forever
  })
  const client = makeKalshiClient({ kalshiLib: stubLib, credentials: VALID_CREDS, timeoutMs: 50 })
  const t0 = Date.now()
  const r = await client.place(ORDER_PARAMS)
  const elapsed = Date.now() - t0
  eq(r.outcome, 'unknown', 'gateway timeout → unknown')
  ok(elapsed >= 50 && elapsed < 1000, `timeout fires within bound (got ${elapsed}ms)`)
}

// ─── place: missing/incomplete creds → error before any HTTP ───────────
section('place — missing creds → outcome=error (definitive)')
{
  const stubLib = makeStubLib({ placeOrder: async () => ({ order_id: 'KS-X' }) })  // shouldn't be called
  let calls = 0
  stubLib.placeOrder = async () => { calls++; return { order_id: 'KS-X' } }
  const client = makeKalshiClient({ kalshiLib: stubLib, credentials: { adam: VALID_CREDS.adam } })
  const r = await client.place({ ...ORDER_PARAMS, account_id: 'isaiah' })
  eq(r.outcome, 'error', 'unknown account → error')
  eq(r.error_code, 'NO_CREDENTIALS', 'error_code=NO_CREDENTIALS')
  eq(calls, 0, 'placeOrder NOT called when creds missing')
}
{
  const stubLib = makeStubLib({ placeOrder: async () => ({ order_id: 'KS-X' }) })
  const client = makeKalshiClient({
    kalshiLib: stubLib,
    credentials: { adam: { KALSHI_API_KEY_ID: 'k', KALSHI_PRIVATE_KEY_PEM: null } },  // incomplete
  })
  const r = await client.place(ORDER_PARAMS)
  eq(r.outcome, 'error', 'incomplete creds → error')
  eq(r.error_code, 'INCOMPLETE_CREDENTIALS', 'error_code=INCOMPLETE_CREDENTIALS')
}

// ─── place: credential routing per account ────────────────────────────
section('place — credential routing: lib called with the right creds')
{
  let captured = null
  const stubLib = makeStubLib({
    placeOrder: async (ticker, side, contracts, price, creds, action) => {
      captured = creds
      return { order_id: 'KS-OK' }
    },
  })
  const client = makeKalshiClient({ kalshiLib: stubLib, credentials: VALID_CREDS })

  await client.place({ ...ORDER_PARAMS, account_id: 'adam' })
  eq(captured.KALSHI_API_KEY_ID, 'k-adam', 'adam routes to k-adam')

  await client.place({ ...ORDER_PARAMS, account_id: 'isaiah' })
  eq(captured.KALSHI_API_KEY_ID, 'k-isaiah', 'isaiah routes to k-isaiah')
}

// ─── place: lib called with correct positional args ───────────────────
section('place — lib args match expected positional order')
{
  let captured = null
  const stubLib = makeStubLib({
    placeOrder: async (ticker, side, contracts, price, creds, action) => {
      captured = { ticker, side, contracts, price, creds, action }
      return { order_id: 'KS-OK' }
    },
  })
  const client = makeKalshiClient({ kalshiLib: stubLib, credentials: VALID_CREDS })
  await client.place({
    account_id: 'adam',
    market_ticker:     'KX-FOO',
    contract_side:     'yes',
    action:            'sell',
    quantity:          5,
    limit_price_cents: 70,
    decision_id:       'd-args',
  })
  eq(captured.ticker, 'KX-FOO', 'ticker positional')
  eq(captured.side, 'yes', 'side positional')
  eq(captured.contracts, 5, 'contracts positional')
  eq(captured.price, 70, 'price positional')
  eq(captured.action, 'sell', 'action positional')
}

// ─── cancel ────────────────────────────────────────────────────────────
section('cancel — success')
{
  let cancelArgs = null
  const stubLib = makeStubLib({
    cancelOrder: async (orderId, creds) => { cancelArgs = { orderId, creds }; return { ok: true } },
  })
  const client = makeKalshiClient({ kalshiLib: stubLib, credentials: VALID_CREDS })
  const r = await client.cancel({ account_id: 'adam', kalshi_order_id: 'KS-100' })
  eq(r.outcome, 'success', 'cancel success')
  eq(cancelArgs.orderId, 'KS-100', 'lib received order_id')
  eq(cancelArgs.creds.KALSHI_API_KEY_ID, 'k-adam', 'lib received adam creds')
}

section('cancel — missing kalshi_order_id → error')
{
  const stubLib = makeStubLib({ cancelOrder: async () => ({ ok: true }) })
  const client = makeKalshiClient({ kalshiLib: stubLib, credentials: VALID_CREDS })
  const r = await client.cancel({ account_id: 'adam', kalshi_order_id: null })
  eq(r.outcome, 'error', 'missing order_id → error')
  eq(r.error_code, 'missing_kalshi_order_id', 'specific error_code')
}

section('cancel — 404 → error')
{
  const stubLib = makeStubLib({
    cancelOrder: async () => { throw new Error('kalshi DELETE -> 404 {"error":"not_found"}') },
  })
  const client = makeKalshiClient({ kalshiLib: stubLib, credentials: VALID_CREDS })
  const r = await client.cancel({ account_id: 'adam', kalshi_order_id: 'KS-MISS' })
  eq(r.outcome, 'error', '404 → error')
  eq(r.error_code, 'http_404', 'http_404')
}

// ─── amend ────────────────────────────────────────────────────────────
section('amend — success and arg shape')
{
  let amendArgs = null
  const stubLib = makeStubLib({
    amendOrder: async (orderId, args, creds) => { amendArgs = { orderId, args, creds }; return { ok: true } },
  })
  const client = makeKalshiClient({ kalshiLib: stubLib, credentials: VALID_CREDS })
  const r = await client.amend({
    account_id: 'adam',
    kalshi_order_id: 'KS-100',
    contract_side: 'yes',
    action: 'buy',
    quantity: 7,
    limit_price_cents: 45,
  })
  eq(r.outcome, 'success', 'amend success')
  eq(amendArgs.orderId, 'KS-100', 'order_id passed')
  eq(amendArgs.args.side, 'yes', 'args.side')
  eq(amendArgs.args.action, 'buy', 'args.action')
  eq(amendArgs.args.count, 7, 'args.count')
  eq(amendArgs.args.price, 45, 'args.price')
}

section('amend — missing kalshi_order_id → error')
{
  const stubLib = makeStubLib({ amendOrder: async () => ({ ok: true }) })
  const client = makeKalshiClient({ kalshiLib: stubLib, credentials: VALID_CREDS })
  const r = await client.amend({ account_id: 'adam', kalshi_order_id: null })
  eq(r.error_code, 'missing_kalshi_order_id', 'specific code')
}

// ─── _classifyThrow exhaustive sanity ─────────────────────────────────
section('_classifyThrow — every documented case')
{
  const client = makeKalshiClient({ kalshiLib: makeStubLib({ placeOrder: async () => ({}) }), credentials: VALID_CREDS })
  const cases = [
    [new Error('kalshi POST -> 400 x'), 'error', 'http_400'],
    [new Error('kalshi POST -> 401 x'), 'error', 'http_401'],
    [new Error('kalshi POST -> 403 x'), 'error', 'http_403'],
    [new Error('kalshi POST -> 404 x'), 'error', 'http_404'],
    [new Error('kalshi POST -> 422 x'), 'error', 'http_422'],
    [new Error('kalshi POST -> 429 x'), 'error', 'http_429'],
    [new Error('kalshi POST -> 500 x'), 'unknown', undefined],
    [new Error('kalshi POST -> 502 x'), 'unknown', undefined],
    [new Error('kalshi POST -> 503 x'), 'unknown', undefined],
    [new Error('kalshi POST -> 504 x'), 'unknown', undefined],
    [new Error('timeout of 20000ms exceeded'), 'unknown', undefined],
    [new Error('connect ECONNREFUSED'), 'unknown', undefined],
    [new Error('socket ECONNRESET'), 'unknown', undefined],
    [new Error('getaddrinfo ENOTFOUND'), 'unknown', undefined],
    [new Error('Network Error: ENETUNREACH'), 'unknown', undefined],
    [new Error('gateway timeout: placeOrder > 100ms'), 'unknown', undefined],
    [new Error('mystery exception'), 'unknown', undefined],
  ]
  for (const [err, expectedOutcome, expectedCode] of cases) {
    const c = client._classifyThrow(err)
    eq(c.outcome, expectedOutcome, `${err.message.slice(0, 30)}... → ${expectedOutcome}`)
    if (expectedCode !== undefined) eq(c.error_code, expectedCode, `error_code = ${expectedCode}`)
  }
  // Pre-flight credential errors
  const credErr = Object.assign(new Error('no creds'), { code: 'NO_CREDENTIALS' })
  const c = client._classifyThrow(credErr)
  eq(c.outcome, 'error', 'NO_CREDENTIALS → error')
  eq(c.error_code, 'NO_CREDENTIALS', 'error_code preserved')
}

// ─── _extractOrderId variants ────────────────────────────────────────
section('_extractOrderId — common shapes')
{
  const client = makeKalshiClient({ kalshiLib: makeStubLib({ placeOrder: async () => ({}) }), credentials: VALID_CREDS })
  eq(client._extractOrderId({ order: { order_id: 'A' } }), 'A', 'order.order_id')
  eq(client._extractOrderId({ order_id: 'B' }), 'B', 'top-level order_id')
  eq(client._extractOrderId({ data: { order: { order_id: 'C' } } }), 'C', 'nested data.order.order_id')
  eq(client._extractOrderId({ status: 'placed' }), null, 'no order_id present → null')
  eq(client._extractOrderId(null), null, 'null response → null')
}

// ════════════════════════════════════════════════════════════════════════
// client_order_id plumbing (Bite 1)
// ════════════════════════════════════════════════════════════════════════

section('deriveClientOrderId — deterministic + format')
{
  const a = deriveClientOrderId('decision-abc')
  const b = deriveClientOrderId('decision-abc')
  eq(a, b, 'same input → same id')
  ok(a.startsWith('gateway_'), 'starts with gateway_')
  eq(a.length, 'gateway_'.length + 16, 'fixed length: prefix + 16-char hash')
  ok(/^gateway_[a-f0-9]{16}$/.test(a), 'hex format')

  // Different inputs → different ids
  const c = deriveClientOrderId('decision-xyz')
  ok(a !== c, 'different inputs → different ids')

  // Throws on missing
  let threw = false
  try { deriveClientOrderId('') } catch { threw = true }
  ok(threw, 'empty string throws')
  threw = false
  try { deriveClientOrderId(null) } catch { threw = true }
  ok(threw, 'null throws')
}

section('place — passes deterministic client_order_id to lib/kalshi')
{
  let captured = null
  const stubLib = makeStubLib({
    placeOrder: async (ticker, side, contracts, price, creds, action, opts) => {
      captured = { ticker, side, contracts, price, action, opts }
      return { order: { order_id: 'KS-COID-1' } }
    },
  })
  const client = makeKalshiClient({ kalshiLib: stubLib, credentials: VALID_CREDS })

  const r = await client.place({ ...ORDER_PARAMS, decision_id: 'd-deterministic' })
  eq(r.outcome, 'success', 'success')
  ok(r.client_order_id, 'client_order_id surfaced in result')
  eq(r.client_order_id, deriveClientOrderId('d-deterministic'), 'matches deriveClientOrderId')
  ok(captured.opts, 'opts passed to lib/kalshi')
  eq(captured.opts.client_order_id, r.client_order_id, 'same id sent to lib/kalshi')
}

section('place — missing decision_id → error before any HTTP')
{
  const stubLib = makeStubLib({ placeOrder: async () => ({ order_id: 'should not be called' }) })
  const client = makeKalshiClient({ kalshiLib: stubLib, credentials: VALID_CREDS })
  const params = { ...ORDER_PARAMS }
  delete params.decision_id
  const r = await client.place(params)
  eq(r.outcome, 'error', 'error')
  eq(r.error_code, 'missing_decision_id', 'specific code')
  eq(r.client_order_id, null, 'no client_order_id returned')
}

section('place — error path still surfaces client_order_id')
{
  const stubLib = makeStubLib({ placeOrder: async () => { throw new Error('kalshi POST -> 422 boom') } })
  const client = makeKalshiClient({ kalshiLib: stubLib, credentials: VALID_CREDS })
  const r = await client.place({ ...ORDER_PARAMS, decision_id: 'd-err-coid' })
  eq(r.outcome, 'error', 'error')
  eq(r.error_code, 'http_422', 'http_422')
  eq(r.client_order_id, deriveClientOrderId('d-err-coid'), 'client_order_id still surfaced for reconciler')
}

section('place — unknown path also surfaces client_order_id')
{
  const stubLib = makeStubLib({ placeOrder: async () => { throw new Error('kalshi POST -> 503 boom') } })
  const client = makeKalshiClient({ kalshiLib: stubLib, credentials: VALID_CREDS })
  const r = await client.place({ ...ORDER_PARAMS, decision_id: 'd-unk-coid' })
  eq(r.outcome, 'unknown', 'unknown')
  eq(r.client_order_id, deriveClientOrderId('d-unk-coid'), 'client_order_id surfaced (reconciler will use it)')
}

// ── lookupByClientOrderId ──────────────────────────────────────────────
section('lookupByClientOrderId — found in open orders, status mapping')
{
  const COID = deriveClientOrderId('d-look-1')
  const stubLib = {
    placeOrder: async () => ({}),
    listOrders: async ({ ticker }, creds) => [
      { client_order_id: 'gateway_someoneelse', order_id: 'KS-OTHER', status: 'resting' },
      { client_order_id: COID, order_id: 'KS-FOUND', status: 'executed', ticker },
    ],
    getFills: async () => [],
  }
  const client = makeKalshiClient({ kalshiLib: stubLib, credentials: VALID_CREDS })
  const r = await client.lookupByClientOrderId({
    account_id: 'adam', market_ticker: 'KX-T', client_order_id: COID,
  })
  eq(r.found, true, 'found=true')
  eq(r.status, 'placed', 'executed → placed')
  eq(r.kalshi_order_id, 'KS-FOUND', 'order_id surfaced')
}

section('lookupByClientOrderId — Kalshi status → reconciler status mapping')
{
  for (const [ksStatus, expected] of [
    ['executed', 'placed'],
    ['filled',  'placed'],
    ['fully_filled', 'placed'],
    ['partially_filled', 'partially_filled'],
    ['partial', 'partially_filled'],
    ['cancelled', 'rejected'],
    ['canceled', 'rejected'],
    ['rejected', 'rejected'],
    ['resting', 'placed'],
    ['open', 'placed'],
    ['pending', 'placed'],
  ]) {
    const COID = deriveClientOrderId(`d-status-${ksStatus}`)
    const stubLib = {
      placeOrder: async () => ({}),
      listOrders: async () => [{ client_order_id: COID, order_id: 'KS-X', status: ksStatus }],
      getFills:   async () => [],
    }
    const client = makeKalshiClient({ kalshiLib: stubLib, credentials: VALID_CREDS })
    const r = await client.lookupByClientOrderId({ account_id: 'adam', market_ticker: 'KX', client_order_id: COID })
    eq(r.status, expected, `Kalshi "${ksStatus}" → "${expected}"`)
  }
}

section('lookupByClientOrderId — not found in orders, fills probe (best-effort)')
{
  const COID = deriveClientOrderId('d-fills')
  const stubLib = {
    placeOrder: async () => ({}),
    listOrders: async () => [],
    getFills:   async () => [{ ticker: 'KX-T', count: 5, side: 'no', created_time: 't' }],
  }
  const client = makeKalshiClient({ kalshiLib: stubLib, credentials: VALID_CREDS })
  const r = await client.lookupByClientOrderId({ account_id: 'adam', market_ticker: 'KX-T', client_order_id: COID })
  eq(r.found, false, 'not found in open orders (no client_order_id on fills)')
  eq(r.raw.fills_count, 1, 'fills probe surfaces count for operator triage')
}

section('lookupByClientOrderId — error classification')
{
  const COID = deriveClientOrderId('d-errs')
  const cases = [
    [new Error('kalshi GET /portfolio/orders -> 401 unauthorized'), 'lookup_auth_error'],
    [new Error('kalshi GET /portfolio/orders -> 403 forbidden'),    'lookup_auth_error'],
    [new Error('kalshi GET /portfolio/orders -> 429 rate limit'),   'lookup_rate_limited'],
    [new Error('kalshi GET /portfolio/orders -> 503 down'),         'lookup_5xx'],
    [new Error('kalshi GET /portfolio/orders -> 502 down'),         'lookup_5xx'],
    [new Error('timeout of 20000ms exceeded'),                      'lookup_timeout'],
    [new Error('connect ECONNREFUSED 1.2.3.4:443'),                 'lookup_5xx'],
  ]
  for (const [err, expected] of cases) {
    const stubLib = {
      placeOrder: async () => ({}),
      listOrders: async () => { throw err },
      getFills:   async () => [],
    }
    const client = makeKalshiClient({ kalshiLib: stubLib, credentials: VALID_CREDS })
    const r = await client.lookupByClientOrderId({ account_id: 'adam', market_ticker: 'KX', client_order_id: COID })
    eq(r.error, true, `${err.message.slice(0, 30)}: error=true`)
    eq(r.error_code, expected, `${err.message.slice(0, 30)}: ${expected}`)
  }
}

section('lookupByClientOrderId — missing creds → lookup_auth_error')
{
  const stubLib = {
    placeOrder: async () => ({}),
    listOrders: async () => [],
    getFills:   async () => [],
  }
  const client = makeKalshiClient({ kalshiLib: stubLib, credentials: { adam: VALID_CREDS.adam } })
  const r = await client.lookupByClientOrderId({
    account_id: 'unknown-acct', market_ticker: 'KX',
    client_order_id: deriveClientOrderId('d-noauth'),
  })
  eq(r.error, true, 'error=true')
  eq(r.error_code, 'lookup_auth_error', 'lookup_auth_error')
}

section('lookupByClientOrderId — missing client_order_id → not_found')
{
  const stubLib = makeStubLib()
  const client = makeKalshiClient({ kalshiLib: stubLib, credentials: VALID_CREDS })
  const r = await client.lookupByClientOrderId({
    account_id: 'adam', market_ticker: 'KX', client_order_id: null,
  })
  eq(r.error, true, 'error=true')
  eq(r.error_code, 'lookup_not_found', 'lookup_not_found')
}

// ─── Summary ──────────────────────────────────────────────────────────
console.log(`\n${_passed} passed, ${_failed} failed`)
process.exit(_failed > 0 ? 1 : 0)
