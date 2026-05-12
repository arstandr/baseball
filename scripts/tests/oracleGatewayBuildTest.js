// scripts/tests/oracleGatewayBuildTest.js
//
// Tests for oracle/layers/6-gateway/buildGateway.js — the production composer.
//
// Spins up a temp libsql DB with both schemas applied, exercises the full
// readiness gate (success + every documented failure path), confirms
// shadow-vs-production differences, mount/shutdown lifecycle.
//
// Run: node scripts/tests/oracleGatewayBuildTest.js

import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import url from 'node:url'
import crypto from 'node:crypto'
import { createClient } from '@libsql/client'
import { buildGateway, resolveConfigFromEnv } from '../../oracle/layers/6-gateway/buildGateway.js'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))

let _passed = 0, _failed = 0
const ok  = (c, l) => c ? _passed++ : (_failed++, console.error(`FAIL [${l}]`))
const eq  = (a, b, l) => a === b ? _passed++ : (_failed++, console.error(`FAIL [${l}]: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`))
const expectThrows = async (fn, l, matcher) => {
  try { await fn(); _failed++; console.error(`FAIL [${l}]: expected throw`) }
  catch (err) {
    if (matcher && !matcher(err)) { _failed++; console.error(`FAIL [${l}]: throw didn't match — ${err.message}`) }
    else _passed++
  }
}
const section = n => console.log(`\n── ${n} ──`)

// ─── Test infra: temp DB, schema, fresh state per test ─────────────────
const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ogw-build-'))

function parseStmts(raw) {
  return raw.replace(/\r/g, '').split('\n').map(l => l.replace(/--.*$/, ''))
    .filter(l => l.trim()).join('\n').split(';').map(s => s.trim()).filter(s => s.length)
}

async function applySchema(client, file) {
  const raw = await fs.readFile(file, 'utf-8')
  for (const s of parseStmts(raw)) await client.execute(s)
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

function makeMockTrace(behavior = {}) {
  const written = { sync: [], async: [] }
  return {
    written,
    api: {
      makeEvent: p => ({ id: crypto.randomUUID(), ...p }),
      writeSync: async ev => {
        if (behavior.writeSyncFails) throw new Error('mock_writeSync_fails')
        written.sync.push(ev)
      },
      writeAsync: async ev => { written.async.push(ev) },
      shutdown:  async () => {},
    },
  }
}

function makeMockKalshiLib() {
  return {
    placeOrder:  async () => ({ order: { order_id: 'KS-1' } }),
    cancelOrder: async () => ({ ok: true }),
    amendOrder:  async () => ({ ok: true }),
  }
}

const COMMIT = 'a'.repeat(40)

function baseConfig({ db, traceModule, mode = 'shadow', overrides = {}, env = {} } = {}) {
  return {
    db,
    traceModule,
    kalshiLib: makeMockKalshiLib(),
    mode,
    commitHash: COMMIT,
    deadLetterPath: path.join(tmpRoot, `dl-${Math.random().toString(36).slice(2)}`),
    adminSecret: 'admin-secret',
    agentSecrets: { 'closer-legacy': 'cl-secret', 'oracle': 'or-secret' },
    requiredAgents: ['closer-legacy'],
    env: { NODE_ENV: 'production', ...env },
    ...overrides,
  }
}

// ════════════════════════════════════════════════════════════════════════
// resolveConfigFromEnv
// ════════════════════════════════════════════════════════════════════════
section('resolveConfigFromEnv')
{
  const env = {
    GATEWAY_MODE: 'production',
    COMMIT_HASH: 'b'.repeat(40),
    GATEWAY_DEAD_LETTER_PATH: '/data/dl',
    GATEWAY_ADMIN_SECRET: 'asec',
    GATEWAY_SECRET_CLOSER_LEGACY: 'cl-sec',
    GATEWAY_SECRET_ORACLE: 'or-sec',
    GATEWAY_REQUIRED_AGENTS: 'closer-legacy,oracle',
    GATEWAY_KALSHI_TIMEOUT_MS: '1500',
    GATEWAY_DEFAULT_RATE_LIMIT: '90',
  }
  const c = resolveConfigFromEnv({ env, db: { run: () => {}, all: () => {}, one: () => {} } })
  eq(c.mode, 'production', 'mode=production')
  eq(c.commitHash, 'b'.repeat(40), 'commitHash')
  eq(c.deadLetterPath, '/data/dl', 'deadLetterPath')
  eq(c.adminSecret, 'asec', 'adminSecret')
  eq(c.agentSecrets['closer-legacy'], 'cl-sec', 'cl secret')
  eq(c.agentSecrets['oracle'], 'or-sec', 'oracle secret')
  eq(c.requiredAgents.length, 2, 'requiredAgents=2')
  eq(c.kalshiTimeoutMs, 1500, 'timeout')
  eq(c.defaultRateLimit, 90, 'rate limit')
}
{
  const env = { NODE_ENV: 'production' }  // no GATEWAY_MODE
  const c = resolveConfigFromEnv({ env, db: { run: () => {}, all: () => {}, one: () => {} } })
  eq(c.mode, 'shadow', 'defaults to shadow')
  eq(c.modeDefaultedFromEnv, true, 'modeDefaultedFromEnv=true (warn signal)')
}
{
  const env = { NODE_ENV: 'development' }
  const c = resolveConfigFromEnv({ env, db: { run: () => {}, all: () => {}, one: () => {} } })
  eq(c.mode, 'shadow', 'shadow in dev')
  eq(c.modeDefaultedFromEnv, false, 'no warn outside production')
}

// ════════════════════════════════════════════════════════════════════════
// buildGateway — happy paths
// ════════════════════════════════════════════════════════════════════════
section('buildGateway — happy shadow boot')
{
  const { db } = await freshDb()
  await seedAccount(db, { account_id: 'adam', enabled: 1 })
  const trace = makeMockTrace()
  const g = await buildGateway(baseConfig({ db, traceModule: trace.api, mode: 'shadow' }))
  eq(g.mode, 'shadow', 'mode=shadow')
  eq(g.readiness.ready, true, 'ready=true')
  eq(g.readiness.db, 'ok', 'db ok')
  eq(g.readiness.trace, 'ok', 'trace ok')
  eq(g.readiness.killswitch, 'ok', 'killswitch ok')
  ok(g.readiness.deadLetter.startsWith('ok'), 'deadLetter ok-ish')
  eq(g.readiness.halt, 'ok', 'halt ok')
  eq(g.readiness.env, 'ok', 'env ok')
  ok(g.readiness.accounts.startsWith('ok'), 'accounts ok')
  eq(g.readiness.kalshi, 'skipped:shadow', 'kalshi skipped in shadow')
  ok(g.deps.kalshi, 'kalshi stub provided in shadow')
  eq(g.deps.gatewayMode, 'shadow', 'deps.gatewayMode')
  // Trace round-trip wrote a probe
  ok(trace.written.sync.find(e => e.event_type === 'gateway_init_probe'), 'init probe wrote to Trace')
  await g.shutdown()
}

section('buildGateway — happy production boot')
{
  const { db } = await freshDb()
  await seedAccount(db, { account_id: 'adam', enabled: 1, ref: 'KALSHI_ADAM' })
  const trace = makeMockTrace()
  const env = {
    NODE_ENV: 'production',
    KALSHI_ADAM_KEY_ID: 'keyid',
    KALSHI_ADAM_PRIVATE_KEY_PEM: '-----BEGIN-----\nPEM\n-----END-----',
  }
  const g = await buildGateway(baseConfig({ db, traceModule: trace.api, mode: 'production', env }))
  eq(g.mode, 'production', 'mode=production')
  eq(g.readiness.ready, true, 'ready')
  ok(g.readiness.kalshi.startsWith('ok:'), `kalshi ok (got ${g.readiness.kalshi})`)
  // Kalshi client's `place` should now be the real wrapper, not the shadow stub
  const stubResult = await g.deps.kalshi.place({
    account_id: 'adam',
    market_ticker: 'KX', contract_side: 'no', action: 'buy',
    quantity: 1, limit_price_cents: 30,
    decision_id: 'd-build-test-' + crypto.randomUUID(),
  })
  eq(stubResult.outcome, 'success', 'production kalshi → success')
  ok(stubResult.client_order_id?.startsWith('gateway_'), 'production kalshi returns deterministic client_order_id')
  await g.shutdown()
}

section('buildGateway — shadow stub kalshi returns error if reached')
{
  const { db } = await freshDb()
  await seedAccount(db)
  const trace = makeMockTrace()
  const g = await buildGateway(baseConfig({ db, traceModule: trace.api, mode: 'shadow' }))
  const r = await g.deps.kalshi.place({ account_id: 'adam' })
  eq(r.outcome, 'error', 'shadow stub returns error if reached')
  eq(r.error_code, 'shadow_mode_should_not_call_kalshi', 'specific marker')
}

section('buildGateway — modeDefaultedFromEnv emits warn Trace')
{
  const { db } = await freshDb()
  await seedAccount(db)
  const trace = makeMockTrace()
  const g = await buildGateway({
    ...baseConfig({ db, traceModule: trace.api, mode: 'shadow' }),
    modeDefaultedFromEnv: true,
  })
  ok(trace.written.async.find(e => e.event_type === 'gateway_mode_defaulted'),
     'gateway_mode_defaulted async event emitted')
}

// ════════════════════════════════════════════════════════════════════════
// buildGateway — readiness failures (one each)
// ════════════════════════════════════════════════════════════════════════

section('buildGateway — missing db throws synchronously')
await expectThrows(
  () => buildGateway({ traceModule: makeMockTrace().api, mode: 'shadow' }),
  'no db',
  err => err.message.includes('config.db required'),
)

section('buildGateway — missing traceModule throws')
await expectThrows(
  async () => {
    const { db } = await freshDb()
    return buildGateway({ db, mode: 'shadow' })
  },
  'no traceModule',
  err => err.message.includes('config.traceModule required'),
)

section('buildGateway — missing kalshiLib in production throws')
await expectThrows(
  async () => {
    const { db } = await freshDb()
    return buildGateway({
      db, traceModule: makeMockTrace().api, mode: 'production',
      kalshiLib: undefined,
      adminSecret: 's', agentSecrets: { 'closer-legacy': 's' }, requiredAgents: ['closer-legacy'],
    })
  },
  'no kalshiLib in production',
  err => err.message.includes('kalshiLib required in production'),
)

section('buildGateway — missing GATEWAY_ADMIN_SECRET fails ENV check')
{
  const { db } = await freshDb()
  await seedAccount(db)
  const trace = makeMockTrace()
  let caught = null
  try {
    await buildGateway({
      ...baseConfig({ db, traceModule: trace.api, mode: 'shadow' }),
      adminSecret: null,
    })
  } catch (err) { caught = err }
  ok(caught, 'threw')
  ok(caught.message.includes('GATEWAY_ADMIN_SECRET'), 'mentions admin secret')
}

section('buildGateway — missing required agent secret fails')
{
  const { db } = await freshDb()
  await seedAccount(db)
  const trace = makeMockTrace()
  let caught = null
  try {
    await buildGateway({
      ...baseConfig({ db, traceModule: trace.api, mode: 'shadow' }),
      agentSecrets: {},  // missing closer-legacy
      requiredAgents: ['closer-legacy'],
    })
  } catch (err) { caught = err }
  ok(caught, 'threw')
  ok(caught.message.includes('CLOSER_LEGACY'), 'mentions agent secret')
}

section('buildGateway — DB unreachable fails')
{
  const trace = makeMockTrace()
  const brokenDb = {
    run: async () => { throw new Error('db down') },
    all: async () => { throw new Error('db down') },
    one: async () => { throw new Error('db down') },
  }
  let caught = null
  try {
    await buildGateway(baseConfig({ db: brokenDb, traceModule: trace.api, mode: 'shadow' }))
  } catch (err) { caught = err }
  ok(caught, 'threw')
  ok(caught.message.includes('DB unreachable'), 'mentions DB')
}

section('buildGateway — Trace writeSync fail aborts boot')
{
  const { db } = await freshDb()
  await seedAccount(db)
  const trace = makeMockTrace({ writeSyncFails: true })
  let caught = null
  try {
    await buildGateway(baseConfig({ db, traceModule: trace.api, mode: 'shadow' }))
  } catch (err) { caught = err }
  ok(caught, 'threw')
  ok(caught.message.includes('Trace round-trip'), 'mentions Trace')
}

section('buildGateway — production: missing Kalshi creds fails')
{
  const { db } = await freshDb()
  await seedAccount(db, { ref: 'KALSHI_ADAM' })
  const trace = makeMockTrace()
  let caught = null
  try {
    await buildGateway(baseConfig({
      db, traceModule: trace.api, mode: 'production',
      env: { NODE_ENV: 'production' /* no KALSHI_ADAM_KEY_ID */ },
    }))
  } catch (err) { caught = err }
  ok(caught, 'threw')
  ok(caught.message.includes('Kalshi credentials'), 'mentions creds')
}

section('buildGateway — production: missing credential_ref on enabled account fails')
{
  const { db } = await freshDb()
  // Insert account with NULL credential_ref
  await db.run(
    `INSERT INTO gateway_accounts (account_id, display_name, kalshi_credential_ref, enabled,
       daily_loss_limit_usd, daily_risk_limit_usd, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ['noref', 'noref', '', 1, 500, 1000, new Date().toISOString(), new Date().toISOString()],
  )
  const trace = makeMockTrace()
  let caught = null
  try {
    await buildGateway(baseConfig({
      db, traceModule: trace.api, mode: 'production',
      env: { NODE_ENV: 'production' },
    }))
  } catch (err) { caught = err }
  ok(caught, 'threw')
  ok(caught.message.includes('account'), 'mentions account')
}

section('buildGateway — disabled accounts are skipped (no fail)')
{
  const { db } = await freshDb()
  await seedAccount(db, { account_id: 'adam', enabled: 1, ref: 'KALSHI_ADAM' })
  await seedAccount(db, { account_id: 'isaiah', enabled: 0, ref: '' })  // disabled, missing ref
  const trace = makeMockTrace()
  const env = {
    NODE_ENV: 'production',
    KALSHI_ADAM_KEY_ID: 'k', KALSHI_ADAM_PRIVATE_KEY_PEM: 'p',
  }
  const g = await buildGateway(baseConfig({ db, traceModule: trace.api, mode: 'production', env }))
  eq(g.readiness.ready, true, 'ok despite disabled-account-with-no-ref')
  ok(g.readiness.accounts.includes('1_enabled'), 'only 1 enabled account')
  await g.shutdown()
}

section('buildGateway — dead-letter unwritable: production fails, shadow warns')
{
  const { db: db1 } = await freshDb()
  await seedAccount(db1)
  const trace1 = makeMockTrace()
  // Use a path under /etc that can't be created (read-only on macOS for non-root)
  let caught = null
  try {
    await buildGateway({
      ...baseConfig({ db: db1, traceModule: trace1.api, mode: 'production' }),
      kalshiLib: makeMockKalshiLib(),
      env: { NODE_ENV: 'production', KALSHI_ADAM_KEY_ID: 'k', KALSHI_ADAM_PRIVATE_KEY_PEM: 'p' },
      deadLetterPath: '/etc/no-write-here-please/dl',
    })
  } catch (err) { caught = err }
  ok(caught, 'production: dead-letter probe failure → throw')
  ok(caught.message.includes('dead-letter'), 'mentions dead-letter')
}
{
  const { db: db2 } = await freshDb()
  await seedAccount(db2)
  const trace2 = makeMockTrace()
  const g = await buildGateway({
    ...baseConfig({ db: db2, traceModule: trace2.api, mode: 'shadow' }),
    deadLetterPath: '/etc/no-write-here-please/dl',
  })
  eq(g.mode, 'shadow', 'shadow boots')
  ok(g.readiness.deadLetter.startsWith('warn:') || g.readiness.deadLetter.startsWith('fail:'),
     `shadow records warn/fail (got ${g.readiness.deadLetter})`)
  ok(g.readiness.ready, 'ready=true even with deadLetter warn')
  await g.shutdown()
}

// ════════════════════════════════════════════════════════════════════════
// mount() lifecycle
// ════════════════════════════════════════════════════════════════════════
section('mount() — requires rawJsonMiddleware')
{
  const { db } = await freshDb()
  await seedAccount(db)
  const trace = makeMockTrace()
  const g = await buildGateway(baseConfig({ db, traceModule: trace.api, mode: 'shadow' }))
  let threw = false
  try { g.mount({ post: () => {}, get: () => {} }) } catch { threw = true }
  ok(threw, 'mount without rawJsonMiddleware throws')
  await g.shutdown()
}

section('mount() — registers all 4 routes')
{
  const { db } = await freshDb()
  await seedAccount(db)
  const trace = makeMockTrace()
  const g = await buildGateway(baseConfig({ db, traceModule: trace.api, mode: 'shadow' }))
  const calls = []
  const fakeApp = {
    post: (p) => calls.push({ method: 'POST', path: p }),
    get:  (p) => calls.push({ method: 'GET',  path: p }),
  }
  const r = g.mount(fakeApp, { rawJsonMiddleware: (req, res, next) => next() })
  eq(r.mounted.length, 4, '4 routes mounted')
  ok(calls.find(c => c.path === '/gateway/place' && c.method === 'POST'), 'place')
  ok(calls.find(c => c.path === '/gateway/healthz' && c.method === 'GET'), 'healthz')
  ok(calls.find(c => c.path === '/gateway/admin/killswitch' && c.method === 'POST'), 'admin killswitch')
  ok(calls.find(c => c.path === '/gateway/admin/unhalt' && c.method === 'POST'), 'admin unhalt')
  await g.shutdown()
}

// ════════════════════════════════════════════════════════════════════════
// Healthz reflects readiness without leaking secrets
// ════════════════════════════════════════════════════════════════════════
section('healthz — reflects readiness, no secrets')
{
  const { db } = await freshDb()
  await seedAccount(db)
  const trace = makeMockTrace()
  const g = await buildGateway(baseConfig({ db, traceModule: trace.api, mode: 'shadow' }))

  // Call the healthz handler directly via mount + a fake app
  let healthRes = null
  const fakeApp = {
    post: () => {},
    get: (p, h) => { if (p === '/gateway/healthz') healthRes = h },
  }
  g.mount(fakeApp, { rawJsonMiddleware: (req, res, next) => next() })
  let body = null
  let code = null
  healthRes({}, { status(c) { code = c; return this }, json(b) { body = b; return this } })
  eq(code, 200, 'ready → 200')
  eq(body.ok, true, 'ok=true')
  eq(body.mode, 'shadow', 'mode')
  eq(body.commit, COMMIT, 'commit')
  ok(body.readiness, 'readiness object present')
  ok(body.started_at, 'started_at present')
  // Ensure no secret material
  const json = JSON.stringify(body)
  ok(!json.includes('cl-secret'), 'no agent secret leaked')
  ok(!json.includes('admin-secret'), 'no admin secret leaked')
  ok(!json.includes('PRIVATE_KEY'), 'no PEM leaked')
  await g.shutdown()
}

// ─── Cleanup ──────────────────────────────────────────────────────────
console.log(`\n${_passed} passed, ${_failed} failed`)
await fs.rm(tmpRoot, { recursive: true, force: true })
process.exit(_failed > 0 ? 1 : 0)
