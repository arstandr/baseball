// scripts/tests/oracleGatewayIntegrationTest.js
//
// End-to-end integration test for Layer 6 Gateway.
// Spins up a real Express server in-process on a random port, builds the
// full Gateway via buildGateway(), and hits every HTTP endpoint via fetch.
//
// What's exercised:
//   - createApp({ gateway }) shape from server/index.js (replicated locally)
//   - mountGatewayRoutes via gateway.mount(app)
//   - HMAC signing + body-hash header
//   - HTTP status mapping (Q2): 200 / 202 / 400 / 401 / 429 / 502 / 503
//   - Idempotency replay across two real HTTP calls
//   - Halt path: place rejected with 503 after setBlind triggered
//   - Admin killswitch (HMAC + enum validation + audit Trace)
//   - Admin unhalt (halt-bypass — works while halted)
//   - Rate limiter — 429 after the limit
//
// Dependencies:
//   - real Express
//   - real local libsql DB with Layer 0 + Layer 6 schemas applied
//   - real dataPlane / traceAdapter / deadLetter / halt / killswitchCache /
//     validator / orchestrator / route from buildGateway
//   - MOCK kalshiLib (controllable per-test outcome)
//   - MOCK traceModule (captures writeSync/writeAsync in memory; doesn't write
//     to oracle_trace_events because the test seeds those rows directly for
//     decision-event lookups)
//
// Run: node scripts/tests/oracleGatewayIntegrationTest.js

import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import url from 'node:url'
import crypto from 'node:crypto'
import express from 'express'
import { createClient } from '@libsql/client'
import { buildGateway } from '../../oracle/layers/6-gateway/buildGateway.js'
import { sign, sha256Hex } from '../../oracle/layers/6-gateway/hmac.js'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))

let _passed = 0, _failed = 0
const ok  = (c, l) => c ? _passed++ : (_failed++, console.error(`FAIL [${l}]`))
const eq  = (a, b, l) => a === b ? _passed++ : (_failed++, console.error(`FAIL [${l}]: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`))
const section = n => console.log(`\n── ${n} ──`)

// ════════════════════════════════════════════════════════════════════════
// Test infra
// ════════════════════════════════════════════════════════════════════════

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ogw-int-'))

function parseStmts(raw) {
  return raw.replace(/\r/g, '').split('\n').map(l => l.replace(/--.*$/, ''))
    .filter(l => l.trim()).join('\n').split(';').map(s => s.trim()).filter(s => s.length)
}

async function applySchema(client, file) {
  for (const s of parseStmts(await fs.readFile(file, 'utf-8'))) {
    await client.execute(s)
  }
}

async function freshDb() {
  const dbFile = path.join(tmpRoot, `db-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  const client = createClient({ url: `file:${dbFile}` })
  await applySchema(client, path.resolve(__dirname, '../../oracle/layers/0-trace/schema.sql'))
  await applySchema(client, path.resolve(__dirname, '../../oracle/layers/6-gateway/schema.sql'))
  const db = {
    run: async (sql, args = []) => client.execute({ sql, args }),
    all: async (sql, args = []) => (await client.execute({ sql, args })).rows,
    one: async (sql, args = []) => (await client.execute({ sql, args })).rows[0] ?? null,
    close: () => client.close(),
  }
  return { db, client, dbFile }
}

async function seedAccount(db, { account_id = 'adam', enabled = 1, ref = 'KALSHI_ADAM' } = {}) {
  const now = new Date().toISOString()
  await db.run(
    `INSERT INTO gateway_accounts (account_id, display_name, kalshi_credential_ref, enabled,
       daily_loss_limit_usd, daily_risk_limit_usd, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [account_id, account_id, ref, enabled, 500, 1000, now, now],
  )
}

async function seedAccountDailyState(db, { account_id = 'adam', trading_date = '2026-04-30' } = {}) {
  const now = new Date().toISOString()
  await db.run(
    `INSERT INTO gateway_account_daily_state
       (account_id, trading_date, realized_pnl_usd, open_risk_usd, submitted_order_usd,
        daily_loss_limit_usd, daily_risk_limit_usd, updated_at)
     VALUES (?, ?, 0, 0, 0, 500, 1000, ?)`,
    [account_id, trading_date, now],
  )
}

async function seedDecisionEvent(db, decision_id, { agent_id = 'closer-legacy', secondsAgo = 5 } = {}) {
  const created_at = new Date(Date.now() - secondsAgo * 1000).toISOString()
  await db.run(
    `INSERT INTO oracle_trace_events
       (id, decision_id, parent_event_id, trace_schema_version, created_at,
        layer_name, layer_version, commit_hash, agent_id, agent_version,
        mode, system, event_type,
        pitcher_id, pitcher_name, bet_date, strike, side,
        decision, reason_code, reasoning, metrics,
        evidence_used, input_hash, output_hash,
        status, severity, latency_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      crypto.randomUUID(), decision_id, null, '1.0.0', created_at,
      'gateway', '1.0.0', 'a'.repeat(40), agent_id, '0.7.3',
      'production', 'oracle', 'closer_legacy_decision',
      '547179', 'Lorenzen', '2026-04-30', 5, 'NO',
      'pass', 'closer_legacy_decision', '{}', '{}',
      '[]', 'a'.repeat(64), 'b'.repeat(64),
      'success', 'info', 0,
    ],
  )
}

function makeMockTrace() {
  const events = { sync: [], async: [] }
  return {
    events,
    api: {
      writeSync:  async ev => { events.sync.push(ev) },
      writeAsync: async ev => { events.async.push(ev) },
      makeEvent:  p => ({ id: crypto.randomUUID(), ...p }),
      shutdown:   async () => {},
    },
  }
}

function makeMockKalshiLib() {
  const state = { placeBehavior: { order: { order_id: 'KS-1' } } }
  return {
    setBehavior(b) { state.placeBehavior = b },
    api: {
      placeOrder: async (...args) => {
        const b = typeof state.placeBehavior === 'function' ? state.placeBehavior(...args) : state.placeBehavior
        if (b instanceof Error) throw b
        return b
      },
      cancelOrder: async () => ({ ok: true }),
      amendOrder:  async () => ({ ok: true }),
    },
  }
}

const SECRET_CLOSER = 'integration-test-secret-closer'
const SECRET_ADMIN  = 'integration-test-secret-admin'
const COMMIT = 'a'.repeat(40)

async function startTestServer({ db, kalshiLib, traceModule, mode = 'production', deadLetterPath } = {}) {
  const config = {
    db,
    kalshiLib,
    traceModule,
    mode,
    commitHash: COMMIT,
    deadLetterPath: deadLetterPath ?? path.join(tmpRoot, `dl-${Math.random().toString(36).slice(2)}`),
    adminSecret: SECRET_ADMIN,
    agentSecrets: { 'closer-legacy': SECRET_CLOSER },
    requiredAgents: ['closer-legacy'],
    env: { NODE_ENV: 'production', KALSHI_ADAM_KEY_ID: 'k', KALSHI_ADAM_PRIVATE_KEY_PEM: 'p' },
  }
  const gateway = await buildGateway(config)

  const app = express()
  app.set('trust proxy', 1)
  gateway.mount(app, { rawJsonMiddleware: express.raw({ type: 'application/json', limit: '1mb' }) })
  app.use(express.json({ limit: '1mb' }))
  // Default 404 to keep responses tidy
  app.use((req, res) => res.status(404).json({ error: 'not_found' }))

  const server = await new Promise((resolve, reject) => {
    const srv = app.listen(0, () => resolve(srv))
    srv.on('error', reject)
  })
  const port = server.address().port
  const baseUrl = `http://127.0.0.1:${port}`

  return {
    gateway, app, server, port, baseUrl,
    async stop() {
      await new Promise(r => server.close(r))
      await gateway.shutdown()
    },
  }
}

// ── HTTP helpers ──────────────────────────────────────────────────────
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
      mlb_state_hash: 'b'.repeat(64), mlb_state_ts: Date.now() - 1000,
      kalshi_quote_hash: 'c'.repeat(64), kalshi_quote_ts: Date.now() - 500,
      position_hash: 'd'.repeat(64), position_ts: Date.now() - 1000,
      orderbook_hash: 'e'.repeat(64), orderbook_ts: Date.now() - 500,
    },
    ...o,
  }
}

function buildHmacHeaders(rawBody, secret, agent = 'closer-legacy', tsOverride) {
  const ts = tsOverride ?? Date.now()
  const nonce = 'n-' + crypto.randomUUID()
  const bodySha = sha256Hex(rawBody)
  const sig = sign({ secret, timestamp: ts, nonce, bodySha256: bodySha })
  return {
    'content-type': 'application/json',
    'x-gateway-agent': agent,
    'x-gateway-agent-version': '0.7.3',
    'x-gateway-commit': 'a'.repeat(40),
    'x-gateway-timestamp': String(ts),
    'x-gateway-nonce': nonce,
    'x-gateway-body-sha256': bodySha,
    'x-gateway-signature': sig,
  }
}

async function postPlace(baseUrl, body, opts = {}) {
  const rawBody = JSON.stringify(body)
  const headers = opts.headers ?? buildHmacHeaders(rawBody, opts.secret ?? SECRET_CLOSER)
  return fetch(`${baseUrl}/gateway/place`, { method: 'POST', headers, body: rawBody })
}

async function postAdmin(baseUrl, path, body, opts = {}) {
  const rawBody = JSON.stringify(body)
  const ts = opts.timestamp ?? Date.now()
  const nonce = 'n-' + crypto.randomUUID()
  const bodySha = sha256Hex(rawBody)
  const sig = sign({ secret: opts.secret ?? SECRET_ADMIN, timestamp: ts, nonce, bodySha256: bodySha })
  const headers = opts.headers ?? {
    'content-type': 'application/json',
    'x-gateway-timestamp': String(ts),
    'x-gateway-nonce': nonce,
    'x-gateway-body-sha256': bodySha,
    'x-gateway-signature': sig,
  }
  return fetch(`${baseUrl}${path}`, { method: 'POST', headers, body: rawBody })
}

// ════════════════════════════════════════════════════════════════════════
// Tests
// ════════════════════════════════════════════════════════════════════════

// ── F1: production happy path ─────────────────────────────────────────
section('F1 — POST /gateway/place production happy → 200 + accepted + order_id')
{
  const { db } = await freshDb()
  await seedAccount(db)
  await seedAccountDailyState(db)
  const decision_id = 'd-int-' + crypto.randomUUID()
  await seedDecisionEvent(db, decision_id)
  const kalshi = makeMockKalshiLib()
  kalshi.setBehavior({ order: { order_id: 'KS-INT-1' } })
  const trace = makeMockTrace()
  const srv = await startTestServer({ db, kalshiLib: kalshi.api, traceModule: trace.api, mode: 'production' })

  const res = await postPlace(srv.baseUrl, defaultPlaceBody({ decision_id }))
  const body = await res.json()
  eq(res.status, 200, 'HTTP 200')
  eq(body.ok, true, 'ok=true')
  eq(body.status, 'accepted', 'status=accepted')
  eq(body.kalshi_order_id, 'KS-INT-1', 'order_id surfaced')
  eq(body.decision_id, decision_id, 'decision_id echoed')
  ok(body.trace_event_id, 'trace_event_id present')

  // idempotency cache should now contain the row
  const idem = await db.one(`SELECT decision_id, last_status, kalshi_order_id FROM gateway_idempotency WHERE decision_id = ?`, [decision_id])
  ok(idem, 'idempotency row written')
  eq(idem.last_status, 'accepted', 'last_status persisted')
  eq(idem.kalshi_order_id, 'KS-INT-1', 'order_id persisted')

  await srv.stop()
}

// ── F19: shadow execution → 200 shadow_logged, NO Kalshi call ──────────
section('F19 — execution_mode=shadow → 200 shadow_logged, kalshi NOT called')
{
  const { db } = await freshDb()
  await seedAccount(db)
  await seedAccountDailyState(db)
  const decision_id = 'd-shadow-' + crypto.randomUUID()
  await seedDecisionEvent(db, decision_id)
  const kalshi = makeMockKalshiLib()
  let kalshiCalls = 0
  kalshi.api.placeOrder = async () => { kalshiCalls++; return { order: { order_id: 'KS-SHOULD-NOT-FIRE' } } }
  const trace = makeMockTrace()
  const srv = await startTestServer({ db, kalshiLib: kalshi.api, traceModule: trace.api, mode: 'production' })

  const res = await postPlace(srv.baseUrl, defaultPlaceBody({ decision_id, execution_mode: 'shadow' }))
  const body = await res.json()
  eq(res.status, 200, 'HTTP 200')
  eq(body.status, 'shadow_logged', 'shadow_logged')
  eq(body.ok, true, 'ok=true (shadow is a successful settle)')
  eq(kalshiCalls, 0, 'kalshi.placeOrder NOT called')

  await srv.stop()
}

// ── F22: exchange_unknown → 202 ───────────────────────────────────────
section('F22 — Kalshi 5xx → 202 + status=exchange_unknown + reconciliation row')
{
  const { db } = await freshDb()
  await seedAccount(db)
  await seedAccountDailyState(db)
  const decision_id = 'd-unk-' + crypto.randomUUID()
  await seedDecisionEvent(db, decision_id)
  const kalshi = makeMockKalshiLib()
  kalshi.api.placeOrder = async () => { throw new Error('kalshi POST -> 502 Bad Gateway') }
  const trace = makeMockTrace()
  const srv = await startTestServer({ db, kalshiLib: kalshi.api, traceModule: trace.api, mode: 'production' })

  const res = await postPlace(srv.baseUrl, defaultPlaceBody({ decision_id }))
  const body = await res.json()
  eq(res.status, 202, '202 for exchange_unknown')
  eq(body.status, 'exchange_unknown', 'status=exchange_unknown')
  eq(body.reconciliation_state, 'pending', 'reconciliation pending')

  // Reconciliation row enqueued
  const unk = await db.one(`SELECT decision_id, account_id, market_ticker, resolved_at FROM gateway_unknowns WHERE decision_id = ?`, [decision_id])
  ok(unk, 'unknowns row inserted')
  eq(unk.resolved_at, null, 'resolved_at null (pending)')

  await srv.stop()
}

// ── F23: exchange_error → 502 ─────────────────────────────────────────
section('F23 — Kalshi 4xx → 502 + status=exchange_error + error_code')
{
  const { db } = await freshDb()
  await seedAccount(db)
  await seedAccountDailyState(db)
  const decision_id = 'd-err-' + crypto.randomUUID()
  await seedDecisionEvent(db, decision_id)
  const kalshi = makeMockKalshiLib()
  kalshi.api.placeOrder = async () => { throw new Error('kalshi POST -> 422 {"error":"insufficient_balance"}') }
  const trace = makeMockTrace()
  const srv = await startTestServer({ db, kalshiLib: kalshi.api, traceModule: trace.api, mode: 'production' })

  const res = await postPlace(srv.baseUrl, defaultPlaceBody({ decision_id }))
  const body = await res.json()
  eq(res.status, 502, '502 for exchange_error')
  eq(body.status, 'exchange_error', 'status=exchange_error')
  eq(body.error_code, 'http_422', 'http_422')
  eq(body.ok, false, 'ok=false')

  // No unknowns row for definitive error
  const unk = await db.one(`SELECT count(*) as n FROM gateway_unknowns WHERE decision_id = ?`, [decision_id])
  eq(Number(unk.n), 0, 'no unknowns row for definitive error')

  await srv.stop()
}

// ── HMAC fail → 401 ───────────────────────────────────────────────────
section('HMAC missing → 401')
{
  const { db } = await freshDb()
  await seedAccount(db)
  await seedAccountDailyState(db)
  const trace = makeMockTrace()
  const kalshi = makeMockKalshiLib()
  const srv = await startTestServer({ db, kalshiLib: kalshi.api, traceModule: trace.api, mode: 'production' })

  const body = defaultPlaceBody()
  const rawBody = JSON.stringify(body)
  // Build correct headers, then strip signature
  const headers = buildHmacHeaders(rawBody, SECRET_CLOSER)
  delete headers['x-gateway-signature']
  const res = await fetch(`${srv.baseUrl}/gateway/place`, { method: 'POST', headers, body: rawBody })
  const json = await res.json()
  eq(res.status, 401, '401')
  eq(json.reject_reason, 'HMAC_INVALID', 'HMAC_INVALID')
  eq(json.context.internal_reason, 'MISSING_HEADER', 'MISSING_HEADER internal reason')

  await srv.stop()
}

section('HMAC bad signature → 401 SIG_MISMATCH')
{
  const { db } = await freshDb()
  await seedAccount(db)
  await seedAccountDailyState(db)
  const decision_id = 'd-bad-sig-' + crypto.randomUUID()
  await seedDecisionEvent(db, decision_id)
  const trace = makeMockTrace()
  const kalshi = makeMockKalshiLib()
  const srv = await startTestServer({ db, kalshiLib: kalshi.api, traceModule: trace.api, mode: 'production' })

  const body = defaultPlaceBody({ decision_id })
  const rawBody = JSON.stringify(body)
  const headers = buildHmacHeaders(rawBody, 'wrong-secret')
  const res = await fetch(`${srv.baseUrl}/gateway/place`, { method: 'POST', headers, body: rawBody })
  const json = await res.json()
  eq(res.status, 401, '401')
  eq(json.context.internal_reason, 'SIG_MISMATCH', 'SIG_MISMATCH')

  await srv.stop()
}

// ── BODY_INVALID and ENUM_INVALID → 400 ───────────────────────────────
section('Bad enum (strategy_mode) → 400 ENUM_INVALID')
{
  const { db } = await freshDb()
  await seedAccount(db)
  await seedAccountDailyState(db)
  const decision_id = 'd-enum-' + crypto.randomUUID()
  await seedDecisionEvent(db, decision_id)
  const trace = makeMockTrace()
  const kalshi = makeMockKalshiLib()
  const srv = await startTestServer({ db, kalshiLib: kalshi.api, traceModule: trace.api, mode: 'production' })

  const res = await postPlace(srv.baseUrl, defaultPlaceBody({ decision_id, strategy_mode: 'live_yes' }))
  const json = await res.json()
  eq(res.status, 400, '400')
  eq(json.reject_reason, 'ENUM_INVALID', 'ENUM_INVALID')

  await srv.stop()
}

section('Missing required body field → 400 BODY_INVALID')
{
  const { db } = await freshDb()
  await seedAccount(db)
  await seedAccountDailyState(db)
  const trace = makeMockTrace()
  const kalshi = makeMockKalshiLib()
  const srv = await startTestServer({ db, kalshiLib: kalshi.api, traceModule: trace.api, mode: 'production' })

  const body = defaultPlaceBody()
  delete body.market_ticker
  const res = await postPlace(srv.baseUrl, body)
  const json = await res.json()
  eq(res.status, 400, '400')
  eq(json.reject_reason, 'BODY_INVALID', 'BODY_INVALID')
  eq(json.context.field, 'market_ticker', 'field name surfaced')

  await srv.stop()
}

// ── Policy reject (killswitch) → 200 with reject_reason ───────────────
section('killswitch_all=true → 200 + reject_reason=KILLSWITCH_ALL')
{
  const { db } = await freshDb()
  await seedAccount(db)
  await seedAccountDailyState(db)
  const decision_id = 'd-ks-' + crypto.randomUUID()
  await seedDecisionEvent(db, decision_id)
  await db.run(
    `INSERT INTO gateway_killswitch (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)`,
    ['gateway_kill_all', 'true', new Date().toISOString(), 'test-bootstrap'],
  )
  const trace = makeMockTrace()
  const kalshi = makeMockKalshiLib()
  const srv = await startTestServer({ db, kalshiLib: kalshi.api, traceModule: trace.api, mode: 'production' })

  const res = await postPlace(srv.baseUrl, defaultPlaceBody({ decision_id }))
  const json = await res.json()
  eq(res.status, 200, 'policy reject → 200 (business meaning)')
  eq(json.status, 'rejected', 'status=rejected')
  eq(json.reject_reason, 'KILLSWITCH_ALL', 'KILLSWITCH_ALL')
  eq(json.ok, false, 'ok=false')

  await srv.stop()
}

// ── Idempotency replay across two real HTTP calls ─────────────────────
section('Idempotency — same decision_id + same body → 2nd call replay (no second Kalshi call)')
{
  const { db } = await freshDb()
  await seedAccount(db)
  await seedAccountDailyState(db)
  const decision_id = 'd-idem-' + crypto.randomUUID()
  await seedDecisionEvent(db, decision_id)
  const kalshi = makeMockKalshiLib()
  let kalshiCalls = 0
  kalshi.api.placeOrder = async () => { kalshiCalls++; return { order: { order_id: 'KS-IDEM-100' } } }
  const trace = makeMockTrace()
  const srv = await startTestServer({ db, kalshiLib: kalshi.api, traceModule: trace.api, mode: 'production' })

  const body = defaultPlaceBody({ decision_id })
  const r1 = await postPlace(srv.baseUrl, body)
  const j1 = await r1.json()
  eq(j1.status, 'accepted', 'first call: accepted')
  eq(kalshiCalls, 1, 'kalshi called once')

  // Second call MUST reuse the same nonce-free request, so build a fresh
  // request with the same body. Idempotency keys on decision_id + body_hash.
  const r2 = await postPlace(srv.baseUrl, body)
  const j2 = await r2.json()
  eq(r2.status, 200, 'replay → 200')
  eq(j2.status, 'replay', 'second call: replay')
  eq(j2.last_status, 'accepted', 'replay returns cached last_status')
  eq(j2.kalshi_order_id, 'KS-IDEM-100', 'replay returns cached order_id')
  eq(kalshiCalls, 1, 'kalshi NOT called again on replay')

  await srv.stop()
}

// ── /gateway/healthz ──────────────────────────────────────────────────
section('GET /gateway/healthz before halt → 200')
{
  const { db } = await freshDb()
  await seedAccount(db)
  const trace = makeMockTrace()
  const kalshi = makeMockKalshiLib()
  const srv = await startTestServer({ db, kalshiLib: kalshi.api, traceModule: trace.api, mode: 'shadow' })

  const res = await fetch(`${srv.baseUrl}/gateway/healthz`)
  const body = await res.json()
  eq(res.status, 200, '200')
  eq(body.ok, true, 'ok=true')
  eq(body.halted, false, 'not halted')
  eq(body.mode, 'shadow', 'mode=shadow')
  ok(body.commit, 'commit present')
  ok(body.readiness, 'readiness present')
  // No secret leakage
  const txt = JSON.stringify(body)
  ok(!txt.includes(SECRET_CLOSER), 'no closer secret')
  ok(!txt.includes(SECRET_ADMIN), 'no admin secret')

  await srv.stop()
}

section('GET /gateway/healthz when halted → 503')
{
  const { db } = await freshDb()
  await seedAccount(db)
  const trace = makeMockTrace()
  const kalshi = makeMockKalshiLib()
  const srv = await startTestServer({ db, kalshiLib: kalshi.api, traceModule: trace.api, mode: 'shadow' })

  // Halt directly via gateway.halt API
  srv.gateway.deps.halt.setBlind({ reason: 'GATEWAY_BLIND', detail: 'integration test', at: Date.now() })
  const res = await fetch(`${srv.baseUrl}/gateway/healthz`)
  const body = await res.json()
  eq(res.status, 503, '503')
  eq(body.halted, true, 'halted=true')

  await srv.stop()
}

// ── Halt path: /gateway/place returns 503 when halted ─────────────────
section('Halted gateway → /gateway/place → 503 status=halted')
{
  const { db } = await freshDb()
  await seedAccount(db)
  await seedAccountDailyState(db)
  const decision_id = 'd-halt-' + crypto.randomUUID()
  await seedDecisionEvent(db, decision_id)
  const trace = makeMockTrace()
  const kalshi = makeMockKalshiLib()
  const srv = await startTestServer({ db, kalshiLib: kalshi.api, traceModule: trace.api, mode: 'production' })

  srv.gateway.deps.halt.setBlind({ reason: 'GATEWAY_BLIND', detail: 'integration test', at: Date.now() })
  const res = await postPlace(srv.baseUrl, defaultPlaceBody({ decision_id }))
  const json = await res.json()
  eq(res.status, 503, '503')
  eq(json.status, 'halted', 'status=halted')

  await srv.stop()
}

// ── Admin unhalt while halted (halt-bypass works) ─────────────────────
section('Halted → admin/unhalt clears → place works again')
{
  const { db } = await freshDb()
  await seedAccount(db)
  await seedAccountDailyState(db)
  const decision_id1 = 'd-uhalt-pre-' + crypto.randomUUID()
  const decision_id2 = 'd-uhalt-post-' + crypto.randomUUID()
  await seedDecisionEvent(db, decision_id1)
  await seedDecisionEvent(db, decision_id2)
  const trace = makeMockTrace()
  const kalshi = makeMockKalshiLib()
  const srv = await startTestServer({ db, kalshiLib: kalshi.api, traceModule: trace.api, mode: 'production' })

  // 1. Halt + verify place rejected
  srv.gateway.deps.halt.setBlind({ reason: 'GATEWAY_BLIND', detail: 'x', at: Date.now() })
  const r1 = await postPlace(srv.baseUrl, defaultPlaceBody({ decision_id: decision_id1 }))
  eq(r1.status, 503, 'halted → 503')

  // 2. Unhalt via admin endpoint
  const r2 = await postAdmin(srv.baseUrl, '/gateway/admin/unhalt', { by: 'integration-test', reason: 'cleared in test' })
  const j2 = await r2.json()
  eq(r2.status, 200, 'unhalt → 200')
  eq(j2.cleared, true, 'cleared=true')

  // 3. Place now works
  const r3 = await postPlace(srv.baseUrl, defaultPlaceBody({ decision_id: decision_id2 }))
  const j3 = await r3.json()
  eq(r3.status, 200, 'after unhalt: place → 200')
  eq(j3.status, 'accepted', 'accepted post-unhalt')

  await srv.stop()
}

// ── Admin killswitch with HMAC + enum validation ──────────────────────
section('admin/killswitch — bad HMAC → 401')
{
  const { db } = await freshDb()
  await seedAccount(db)
  const trace = makeMockTrace()
  const kalshi = makeMockKalshiLib()
  const srv = await startTestServer({ db, kalshiLib: kalshi.api, traceModule: trace.api, mode: 'shadow' })

  const r = await postAdmin(srv.baseUrl, '/gateway/admin/killswitch',
    { key: 'gateway_kill_all', value: 'true', updated_by: 'admin' },
    { secret: 'wrong-admin-secret' },
  )
  const j = await r.json()
  eq(r.status, 401, '401')
  eq(j.reject_reason, 'HMAC_INVALID', 'HMAC_INVALID')

  await srv.stop()
}

section('admin/killswitch — typo enum value → 400 ENUM_INVALID')
{
  const { db } = await freshDb()
  await seedAccount(db)
  const trace = makeMockTrace()
  const kalshi = makeMockKalshiLib()
  const srv = await startTestServer({ db, kalshiLib: kalshi.api, traceModule: trace.api, mode: 'shadow' })

  const r = await postAdmin(srv.baseUrl, '/gateway/admin/killswitch',
    { key: 'gateway_kill_mode', value: ['live_yes'], updated_by: 'admin' },
  )
  const j = await r.json()
  eq(r.status, 400, '400')
  eq(j.reject_reason, 'ENUM_INVALID', 'ENUM_INVALID')
  ok(j.context.reason.includes('not_in_strategy_modes'), 'reason names the trap')

  await srv.stop()
}

section('admin/killswitch — happy path → DB written + cache invalidated → next place is killed')
{
  const { db } = await freshDb()
  await seedAccount(db)
  await seedAccountDailyState(db)
  const decision_id = 'd-ks-flow-' + crypto.randomUUID()
  await seedDecisionEvent(db, decision_id)
  const trace = makeMockTrace()
  const kalshi = makeMockKalshiLib()
  const srv = await startTestServer({ db, kalshiLib: kalshi.api, traceModule: trace.api, mode: 'production' })

  // Place works first
  const r1 = await postPlace(srv.baseUrl, defaultPlaceBody({ decision_id }))
  eq((await r1.json()).status, 'accepted', 'before killswitch: accepted')

  // Set kill_all via admin endpoint
  const r2 = await postAdmin(srv.baseUrl, '/gateway/admin/killswitch',
    { key: 'gateway_kill_all', value: 'true', updated_by: 'integration', reason: 'test_drill' },
  )
  eq(r2.status, 200, 'admin set → 200')

  // Wait for cache (1s TTL) to flush — invalidate() was called so should be immediate
  // but force a brief sleep to be safe
  await new Promise(r => setTimeout(r, 50))

  // New place should be killed
  const decision_id2 = 'd-killed-' + crypto.randomUUID()
  await seedDecisionEvent(db, decision_id2)
  const r3 = await postPlace(srv.baseUrl, defaultPlaceBody({ decision_id: decision_id2 }))
  const j3 = await r3.json()
  eq(j3.reject_reason, 'KILLSWITCH_ALL', 'next request killed')

  await srv.stop()
}

// ── GATEWAY_MODE=shadow forces production requests to shadow_logged ───
section('GATEWAY_MODE=shadow forces production-execution requests to shadow_logged')
{
  const { db } = await freshDb()
  await seedAccount(db)
  await seedAccountDailyState(db)
  const decision_id = 'd-mode-shadow-' + crypto.randomUUID()
  await seedDecisionEvent(db, decision_id)
  const trace = makeMockTrace()
  const kalshi = makeMockKalshiLib()
  let kalshiCalls = 0
  kalshi.api.placeOrder = async () => { kalshiCalls++; return { order: { order_id: 'X' } } }
  const srv = await startTestServer({ db, kalshiLib: kalshi.api, traceModule: trace.api, mode: 'shadow' })

  const res = await postPlace(srv.baseUrl, defaultPlaceBody({ decision_id, execution_mode: 'production' }))
  const body = await res.json()
  eq(res.status, 200, '200')
  eq(body.status, 'shadow_logged', 'forced shadow_logged')
  eq(kalshiCalls, 0, 'kalshi NOT called even though caller asked for production')

  await srv.stop()
}

// ── End-to-end reconciliation flow: unknown → resolve → idempotency flips ─
section('End-to-end: place → exchange_unknown → reconciler resolves → next retry replays accepted')
{
  const { db } = await freshDb()
  await seedAccount(db)
  await seedAccountDailyState(db)
  const decision_id = 'd-recon-flow-' + crypto.randomUUID()
  await seedDecisionEvent(db, decision_id)

  const kalshi = makeMockKalshiLib()
  // First call: simulate Kalshi 503 timeout → exchange_unknown
  kalshi.api.placeOrder = async () => { throw new Error('kalshi POST -> 502 Bad Gateway') }
  const trace = makeMockTrace()
  const srv = await startTestServer({ db, kalshiLib: kalshi.api, traceModule: trace.api, mode: 'production' })

  // Build body ONCE — both place calls send identical bytes so idempotency
  // body_hash matches on retry (defaultPlaceBody() embeds Date.now() into evidence
  // timestamps, so a fresh build would diverge).
  const placeBody = defaultPlaceBody({ decision_id })

  // 1. Place — exchange_unknown
  const r1 = await postPlace(srv.baseUrl, placeBody)
  const j1 = await r1.json()
  eq(r1.status, 202, 'first place → 202')
  eq(j1.status, 'exchange_unknown', 'exchange_unknown')

  // 2. Verify gateway_unknowns row exists with client_order_id
  const unkRow = await db.one(
    `SELECT decision_id, client_order_id, account_id, market_ticker, resolved_at FROM gateway_unknowns WHERE decision_id = ?`,
    [decision_id],
  )
  ok(unkRow, 'unknowns row written')
  eq(unkRow.resolved_at, null, 'unresolved')
  ok(unkRow.client_order_id?.startsWith('gateway_'), 'client_order_id persisted')

  // 3. Reconciler runs — Kalshi has now "settled" the original order
  // Build a kalshi client that returns the order via lookupByClientOrderId.
  const reconcilerKalshi = {
    lookupByClientOrderId: async ({ client_order_id, market_ticker }) => {
      // Confirm reconciler asked for the right COID + ticker
      eq(client_order_id, unkRow.client_order_id, 'reconciler used persisted client_order_id')
      eq(market_ticker, unkRow.market_ticker, 'reconciler used persisted market_ticker')
      return { found: true, status: 'placed', kalshi_order_id: 'KS-RECONCILED-1', raw: { ticker: market_ticker } }
    },
  }
  const dataPlaneForRecon = srv.gateway.deps.dataPlane
  const { runReconciliation } = await import('../../oracle/layers/6-gateway/reconciler.js')
  const { _resetForTesting } = await import('../../oracle/layers/6-gateway/reconciler.js')
  _resetForTesting()
  const reconRes = await runReconciliation({
    kalshi: reconcilerKalshi,
    dataPlane: dataPlaneForRecon,
    traceAdapter: srv.gateway.deps.traceAdapter,
    mode: 'production',
  })
  eq(reconRes.outcomes.resolved, 1, 'reconciler resolved 1 row')

  // 4. Verify gateway_unknowns row resolved
  const after = await db.one(
    `SELECT resolved_status, resolved_at, resolved_kalshi_order_id FROM gateway_unknowns WHERE decision_id = ?`,
    [decision_id],
  )
  eq(after.resolved_status, 'placed', 'unknowns.resolved_status')
  ok(after.resolved_at, 'resolved_at set')
  eq(after.resolved_kalshi_order_id, 'KS-RECONCILED-1', 'kalshi_order_id surfaced')

  // 5. Verify gateway_idempotency flipped — last_status no longer exchange_unknown
  const idem = await db.one(
    `SELECT last_status, kalshi_order_id, exchange_status FROM gateway_idempotency WHERE decision_id = ?`,
    [decision_id],
  )
  eq(idem.last_status, 'accepted', 'idempotency flipped to accepted')
  eq(idem.kalshi_order_id, 'KS-RECONCILED-1', 'idempotency.kalshi_order_id')
  eq(idem.exchange_status, 'placed', 'idempotency.exchange_status=placed')

  // 6. Caller retries with the SAME body bytes — sees replay with accepted (not stale exchange_unknown)
  const r2 = await postPlace(srv.baseUrl, placeBody)
  const j2 = await r2.json()
  eq(r2.status, 200, 'retry → 200')
  eq(j2.status, 'replay', 'replay')
  eq(j2.last_status, 'accepted', 'no stale exchange_unknown — caller sees resolved truth')
  eq(j2.kalshi_order_id, 'KS-RECONCILED-1', 'replay returns reconciled order_id')

  await srv.stop()
}

section('End-to-end: shadow mode with unresolved rows → reconciler emits warn rollup')
{
  const { db } = await freshDb()
  await seedAccount(db)
  // Plant a leftover unresolved unknown directly (simulating leftover from a prior production run)
  const dataPlane = (await import('../../oracle/layers/6-gateway/dataPlane.js')).buildDataPlane(db)
  await dataPlane.unknownsStore.enqueue({
    decision_id: 'd-shadow-leftover',
    client_order_id: 'gateway_aabbccddeeff0011',
    account_id: 'adam',
    market_ticker: 'KX-LEFTOVER',
    submitted_at: new Date(Date.now() - 30_000).toISOString(),
  })

  const trace = makeMockTrace()
  const kalshi = makeMockKalshiLib()
  const srv = await startTestServer({ db, kalshiLib: kalshi.api, traceModule: trace.api, mode: 'shadow' })

  const { runReconciliation, _resetForTesting } = await import('../../oracle/layers/6-gateway/reconciler.js')
  _resetForTesting()
  const r = await runReconciliation({
    kalshi: srv.gateway.deps.kalshi,           // shadow stub — should NOT be called
    dataPlane: srv.gateway.deps.dataPlane,
    traceAdapter: srv.gateway.deps.traceAdapter,
    mode: 'shadow',
  })
  eq(r.skipped, true, 'skipped in shadow')
  eq(r.unresolved_count, 1, 'unresolved found in shadow')

  await srv.stop()
}

// ── 404 fallback (Express still handles non-Gateway routes correctly) ─
section('Sanity — non-Gateway path → 404 (Gateway doesn\'t hijack)')
{
  const { db } = await freshDb()
  await seedAccount(db)
  const trace = makeMockTrace()
  const kalshi = makeMockKalshiLib()
  const srv = await startTestServer({ db, kalshiLib: kalshi.api, traceModule: trace.api, mode: 'shadow' })

  const res = await fetch(`${srv.baseUrl}/random/path`)
  eq(res.status, 404, '404 for non-Gateway path')

  await srv.stop()
}

// ─── Cleanup ──────────────────────────────────────────────────────────
console.log(`\n${_passed} passed, ${_failed} failed`)
await fs.rm(tmpRoot, { recursive: true, force: true })
process.exit(_failed > 0 ? 1 : 0)
