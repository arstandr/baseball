// scripts/tests/oracleGatewayReconcilerTest.js
//
// Tests for oracle/layers/6-gateway/reconciler.js
//
// Strategy: real local libsql DB with both schemas applied + real dataPlane
// (so DB state is truthful), MOCK kalshi (controllable per test), captured
// trace events. Exercises every code path locked in Q-RC1..Q-RC8.
//
// Run: node scripts/tests/oracleGatewayReconcilerTest.js

import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import url from 'node:url'
import crypto from 'node:crypto'
import { createClient } from '@libsql/client'
import { buildDataPlane } from '../../oracle/layers/6-gateway/dataPlane.js'
import { runReconciliation, _resetForTesting, RECONCILER_CONSTANTS } from '../../oracle/layers/6-gateway/reconciler.js'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))

let _passed = 0, _failed = 0
const ok  = (c, l) => c ? _passed++ : (_failed++, console.error(`FAIL [${l}]`))
const eq  = (a, b, l) => a === b ? _passed++ : (_failed++, console.error(`FAIL [${l}]: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`))
const section = n => console.log(`\n── ${n} ──`)

// ─── Test infra ───────────────────────────────────────────────────────
const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ogw-rec-'))

function parseStmts(raw) {
  return raw.replace(/\r/g, '').split('\n').map(l => l.replace(/--.*$/, ''))
    .filter(l => l.trim()).join('\n').split(';').map(s => s.trim()).filter(s => s.length)
}

async function applySchema(client, file) {
  for (const s of parseStmts(await fs.readFile(file, 'utf-8'))) await client.execute(s)
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
  return { db, client }
}

function makeMockTraceAdapter() {
  const events = []
  const api = {
    forSystem: () => ({
      makeEvent: p => ({ id: crypto.randomUUID(), ...p }),
      writeAsync: async ev => { events.push(ev) },
      writeSync:  async ev => { events.push(ev) },
    }),
  }
  return { events, api }
}

function makeMockKalshi(behaviors = {}) {
  // behaviors: client_order_id → result OR function(args) → result
  const calls = []
  return {
    calls,
    setBehavior(coid, behavior) { behaviors[coid] = behavior },
    api: {
      lookupByClientOrderId: async (args) => {
        calls.push(args)
        const b = behaviors[args.client_order_id]
        if (typeof b === 'function') return b(args)
        if (b) return b
        return { found: false, raw: { searched_orders_count: 0 } }
      },
    },
  }
}

async function seedUnknown(db, dataPlane, {
  decision_id = 'd-' + crypto.randomUUID(),
  client_order_id = 'gateway_' + crypto.randomBytes(8).toString('hex'),
  account_id = 'adam',
  market_ticker = 'KX-T',
  ageMs = 30_000,
  body_hash = null,
} = {}) {
  const submitted_at = new Date(Date.now() - ageMs).toISOString()
  await dataPlane.unknownsStore.enqueue({
    decision_id, client_order_id, account_id, market_ticker, submitted_at,
  })
  // Also seed an idempotency row so reconciler resolutions update it
  await dataPlane.idempotencyStore.upsert({
    decision_id,
    body_hash: body_hash ?? 'a'.repeat(64),
    client_order_id,
    last_status: 'exchange_unknown',
    exchange_request_sent: 1,
    kalshi_order_id: null,
    exchange_status: 'unknown',
    response_json: '{"status":"exchange_unknown"}',
  })
  return { decision_id, client_order_id, account_id, market_ticker, submitted_at }
}

// ════════════════════════════════════════════════════════════════════════
// Tests
// ════════════════════════════════════════════════════════════════════════

// ── Constants exposed ───────────────────────────────────────────────
section('RECONCILER_CONSTANTS exported')
eq(RECONCILER_CONSTANTS.PER_ROW_CADENCE_FAST_MS, 15_000, 'fast cadence = 15s')
eq(RECONCILER_CONSTANTS.PER_ROW_CADENCE_SLOW_MS, 60_000, 'slow cadence = 60s')
eq(RECONCILER_CONSTANTS.ROW_AGE_BREAKPOINT_MS, 5 * 60_000, 'breakpoint = 5min')
eq(RECONCILER_CONSTANTS.ROLLUP_WARN_AGE_MS, 60_000, 'warn @ 60s')
eq(RECONCILER_CONSTANTS.ROLLUP_CRITICAL_AGE_MS, 5 * 60_000, 'critical @ 5min')

// ── Shadow mode noop + warn ─────────────────────────────────────────
section('shadow mode: no rows → noop')
{
  _resetForTesting()
  const { db } = await freshDb()
  const dataPlane = buildDataPlane(db)
  const trace = makeMockTraceAdapter()
  const kalshi = makeMockKalshi()
  const r = await runReconciliation({
    kalshi: kalshi.api, dataPlane, traceAdapter: trace.api, mode: 'shadow',
  })
  eq(r.mode, 'shadow', 'mode=shadow')
  eq(r.skipped, true, 'skipped=true')
  eq(r.unresolved_count, 0, 'no unresolved')
  eq(kalshi.calls.length, 0, 'kalshi NOT called in shadow')
  eq(trace.events.length, 0, 'no Trace events when no rows')
}

section('shadow mode: unresolved rows → warn rollup, no kalshi calls')
{
  _resetForTesting()
  const { db } = await freshDb()
  const dataPlane = buildDataPlane(db)
  await seedUnknown(db, dataPlane, { decision_id: 'd-shadow-1', ageMs: 10_000 })
  await seedUnknown(db, dataPlane, { decision_id: 'd-shadow-2', ageMs: 20_000 })

  const trace = makeMockTraceAdapter()
  const kalshi = makeMockKalshi()
  const r = await runReconciliation({
    kalshi: kalshi.api, dataPlane, traceAdapter: trace.api, mode: 'shadow',
  })
  eq(r.skipped, true, 'skipped')
  eq(r.unresolved_count, 2, '2 unresolved')
  eq(kalshi.calls.length, 0, 'kalshi NEVER called in shadow')
  const warn = trace.events.find(e => e.event_type === 'gateway_unknowns_in_shadow_mode')
  ok(warn, 'shadow warn rollup emitted')
  eq(warn.reason_code, 'UNRESOLVED_IN_SHADOW', 'reason_code')
  eq(warn.reasoning.count, 2, 'count surfaced')
  eq(warn.reasoning.sample_decision_ids.length, 2, '2 sample ids')
}

// ── Production: happy path ───────────────────────────────────────────
section('production: row resolves to placed → unknowns + idempotency updated')
{
  _resetForTesting()
  const { db } = await freshDb()
  const dataPlane = buildDataPlane(db)
  const seed = await seedUnknown(db, dataPlane, { decision_id: 'd-prod-1', ageMs: 30_000 })

  const trace = makeMockTraceAdapter()
  const kalshi = makeMockKalshi()
  kalshi.setBehavior(seed.client_order_id, {
    found: true, status: 'placed', kalshi_order_id: 'KS-RES-1', raw: { foo: 'bar' },
  })

  const r = await runReconciliation({
    kalshi: kalshi.api, dataPlane, traceAdapter: trace.api, mode: 'production',
  })
  eq(r.mode, 'production', 'mode=production')
  eq(r.outcomes.resolved, 1, '1 resolved')
  eq(r.outcomes.errored, 0, '0 errored')
  eq(r.total_unresolved_post, 0, 'all unresolved drained')

  // Verify gateway_unknowns row updated
  const unkRow = await db.one(`SELECT resolved_status, resolved_at, resolved_kalshi_order_id FROM gateway_unknowns WHERE decision_id = ?`, [seed.decision_id])
  eq(unkRow.resolved_status, 'placed', 'unknowns.resolved_status')
  ok(unkRow.resolved_at, 'unknowns.resolved_at set')
  eq(unkRow.resolved_kalshi_order_id, 'KS-RES-1', 'unknowns.kalshi_order_id')

  // Verify gateway_idempotency row updated — last_status flipped from exchange_unknown
  const idemRow = await db.one(`SELECT last_status, kalshi_order_id, exchange_status FROM gateway_idempotency WHERE decision_id = ?`, [seed.decision_id])
  eq(idemRow.last_status, 'accepted', 'idempotency.last_status flipped to accepted')
  eq(idemRow.kalshi_order_id, 'KS-RES-1', 'idempotency.kalshi_order_id')
  eq(idemRow.exchange_status, 'placed', 'idempotency.exchange_status')

  // Resolution Trace event
  const resolvedEv = trace.events.find(e => e.event_type === 'gateway_reconciler_resolved')
  ok(resolvedEv, 'gateway_reconciler_resolved emitted')
  eq(resolvedEv.reason_code, 'placed', 'reason_code=placed')
}

section('production: status mapping placed/partially_filled/rejected → idempotency last_status')
{
  for (const [resolvedStatus, expectedLastStatus, expectedExchangeStatus] of [
    ['placed',           'accepted',       'placed'],
    ['partially_filled', 'accepted',       'partially_filled'],
    ['rejected',         'exchange_error', 'rejected'],
  ]) {
    _resetForTesting()
    const { db } = await freshDb()
    const dataPlane = buildDataPlane(db)
    const seed = await seedUnknown(db, dataPlane, { decision_id: `d-status-${resolvedStatus}`, ageMs: 20_000 })
    const trace = makeMockTraceAdapter()
    const kalshi = makeMockKalshi()
    kalshi.setBehavior(seed.client_order_id, { found: true, status: resolvedStatus, kalshi_order_id: 'KS-X' })
    await runReconciliation({ kalshi: kalshi.api, dataPlane, traceAdapter: trace.api, mode: 'production' })

    const idem = await db.one(`SELECT last_status, exchange_status FROM gateway_idempotency WHERE decision_id = ?`, [seed.decision_id])
    eq(idem.last_status,     expectedLastStatus,     `${resolvedStatus} → last_status=${expectedLastStatus}`)
    eq(idem.exchange_status, expectedExchangeStatus, `${resolvedStatus} → exchange_status=${expectedExchangeStatus}`)
  }
}

// ── Production: not-found path ───────────────────────────────────────
section('production: not found → bump attempt, leave unresolved, no idempotency change')
{
  _resetForTesting()
  const { db } = await freshDb()
  const dataPlane = buildDataPlane(db)
  const seed = await seedUnknown(db, dataPlane, { decision_id: 'd-nf', ageMs: 30_000 })

  const trace = makeMockTraceAdapter()
  const kalshi = makeMockKalshi()  // default = not found
  await runReconciliation({ kalshi: kalshi.api, dataPlane, traceAdapter: trace.api, mode: 'production' })

  const unk = await db.one(`SELECT attempts, resolved_at FROM gateway_unknowns WHERE decision_id = ?`, [seed.decision_id])
  eq(Number(unk.attempts), 1, 'attempts=1')
  eq(unk.resolved_at, null, 'still unresolved')
  // idempotency unchanged
  const idem = await db.one(`SELECT last_status FROM gateway_idempotency WHERE decision_id = ?`, [seed.decision_id])
  eq(idem.last_status, 'exchange_unknown', 'idempotency last_status untouched')
}

// ── Production: lookup error categorization ─────────────────────────
section('production: lookup_5xx → bump attempt, error_code recorded, row unresolved')
{
  _resetForTesting()
  const { db } = await freshDb()
  const dataPlane = buildDataPlane(db)
  const seed = await seedUnknown(db, dataPlane, { decision_id: 'd-5xx', ageMs: 30_000 })
  const trace = makeMockTraceAdapter()
  const kalshi = makeMockKalshi()
  kalshi.setBehavior(seed.client_order_id, { error: true, error_code: 'lookup_5xx', detail: 'http 503' })

  const r = await runReconciliation({ kalshi: kalshi.api, dataPlane, traceAdapter: trace.api, mode: 'production' })
  eq(r.outcomes.errored, 1, 'errored=1')
  eq(r.outcomes.by_error.lookup_5xx, 1, 'lookup_5xx counted')
  const unk = await db.one(`SELECT attempts, last_check_error_code, resolved_at FROM gateway_unknowns WHERE decision_id = ?`, [seed.decision_id])
  eq(Number(unk.attempts), 1, 'attempts++')
  eq(unk.last_check_error_code, 'lookup_5xx', 'error_code recorded')
  eq(unk.resolved_at, null, 'unresolved')
}

section('production: lookup_auth_error → critical alert THIS cycle, no threshold delay')
{
  _resetForTesting()
  const { db } = await freshDb()
  const dataPlane = buildDataPlane(db)
  const seed = await seedUnknown(db, dataPlane, { decision_id: 'd-auth', ageMs: 5_000 })  // young row
  const trace = makeMockTraceAdapter()
  const kalshi = makeMockKalshi()
  kalshi.setBehavior(seed.client_order_id, { error: true, error_code: 'lookup_auth_error', detail: 'http 401' })

  await runReconciliation({ kalshi: kalshi.api, dataPlane, traceAdapter: trace.api, mode: 'production' })
  const authEv = trace.events.find(e => e.event_type === 'gateway_reconciler_auth_error')
  ok(authEv, 'auth error critical alert emitted')
  eq(authEv.decision, 'critical', 'severity=critical')
  eq(authEv.reasoning.account_id, seed.account_id, 'account surfaced')
}

// ── Per-row cadence ─────────────────────────────────────────────────
section('per-row cadence: young row checked every 15s')
{
  _resetForTesting()
  const { db } = await freshDb()
  const dataPlane = buildDataPlane(db)
  const seed = await seedUnknown(db, dataPlane, { decision_id: 'd-young', ageMs: 30_000 })
  // Set last_check_at to 5s ago — under 15s cadence → SKIP
  await db.run(`UPDATE gateway_unknowns SET last_check_at = ? WHERE decision_id = ?`, [
    new Date(Date.now() - 5_000).toISOString(),
    seed.decision_id,
  ])
  const trace = makeMockTraceAdapter()
  const kalshi = makeMockKalshi()
  kalshi.setBehavior(seed.client_order_id, { found: true, status: 'placed', kalshi_order_id: 'KS' })

  const r = await runReconciliation({ kalshi: kalshi.api, dataPlane, traceAdapter: trace.api, mode: 'production' })
  eq(r.cadence_skipped_count, 1, 'row skipped due to cadence')
  eq(kalshi.calls.length, 0, 'kalshi NOT called for skipped row')

  // Now bump last_check_at to 16s ago → ELIGIBLE
  await db.run(`UPDATE gateway_unknowns SET last_check_at = ? WHERE decision_id = ?`, [
    new Date(Date.now() - 16_000).toISOString(),
    seed.decision_id,
  ])
  _resetForTesting()
  await runReconciliation({ kalshi: kalshi.api, dataPlane, traceAdapter: trace.api, mode: 'production' })
  eq(kalshi.calls.length, 1, 'kalshi called now that cadence elapsed')
}

section('per-row cadence: old row (>5min) uses 60s cadence')
{
  _resetForTesting()
  const { db } = await freshDb()
  const dataPlane = buildDataPlane(db)
  const seed = await seedUnknown(db, dataPlane, { decision_id: 'd-old', ageMs: 6 * 60_000 })  // 6min old
  // last_check_at 30s ago — under 60s cadence (since age > breakpoint) → SKIP
  await db.run(`UPDATE gateway_unknowns SET last_check_at = ? WHERE decision_id = ?`, [
    new Date(Date.now() - 30_000).toISOString(),
    seed.decision_id,
  ])
  const trace = makeMockTraceAdapter()
  const kalshi = makeMockKalshi()
  kalshi.setBehavior(seed.client_order_id, { found: true, status: 'placed', kalshi_order_id: 'KS' })

  const r = await runReconciliation({ kalshi: kalshi.api, dataPlane, traceAdapter: trace.api, mode: 'production' })
  eq(r.cadence_skipped_count, 1, 'old row at 30s last-check → skipped (slow cadence requires 60s)')

  // last_check_at 65s ago → ELIGIBLE
  await db.run(`UPDATE gateway_unknowns SET last_check_at = ? WHERE decision_id = ?`, [
    new Date(Date.now() - 65_000).toISOString(),
    seed.decision_id,
  ])
  _resetForTesting()
  await runReconciliation({ kalshi: kalshi.api, dataPlane, traceAdapter: trace.api, mode: 'production' })
  eq(kalshi.calls.length, 1, 'old row eligible after 65s')
}

// ── Rollup alerts ───────────────────────────────────────────────────
section('rollup alerts: warn at >60s, critical at >5min, mutually exclusive (critical wins)')
{
  _resetForTesting()
  const { db } = await freshDb()
  const dataPlane = buildDataPlane(db)
  // 1 row 90s old (warn-eligible), 1 row 6min old (critical-eligible)
  await seedUnknown(db, dataPlane, { decision_id: 'd-warn',  ageMs: 90_000 })
  await seedUnknown(db, dataPlane, { decision_id: 'd-crit',  ageMs: 6 * 60_000 })
  const trace = makeMockTraceAdapter()
  const kalshi = makeMockKalshi()  // not-found

  await runReconciliation({ kalshi: kalshi.api, dataPlane, traceAdapter: trace.api, mode: 'production' })
  // Critical present, warn suppressed (rollup chooses critical when any row qualifies)
  ok(trace.events.find(e => e.event_type === 'gateway_unknowns_critical'), 'critical rollup emitted')
  ok(!trace.events.find(e => e.event_type === 'gateway_unknowns_warn'), 'warn NOT emitted when critical fires')
}

section('rollup: warn-only when no row exceeds critical threshold')
{
  _resetForTesting()
  const { db } = await freshDb()
  const dataPlane = buildDataPlane(db)
  await seedUnknown(db, dataPlane, { decision_id: 'd-w1', ageMs: 90_000 })
  await seedUnknown(db, dataPlane, { decision_id: 'd-w2', ageMs: 120_000 })
  const trace = makeMockTraceAdapter()
  const kalshi = makeMockKalshi()
  await runReconciliation({ kalshi: kalshi.api, dataPlane, traceAdapter: trace.api, mode: 'production' })
  ok(trace.events.find(e => e.event_type === 'gateway_unknowns_warn'), 'warn rollup emitted')
  ok(!trace.events.find(e => e.event_type === 'gateway_unknowns_critical'), 'no critical')
}

section('rollup: no warn or critical when all rows under 60s')
{
  _resetForTesting()
  const { db } = await freshDb()
  const dataPlane = buildDataPlane(db)
  await seedUnknown(db, dataPlane, { decision_id: 'd-fresh', ageMs: 30_000 })
  const trace = makeMockTraceAdapter()
  const kalshi = makeMockKalshi()
  await runReconciliation({ kalshi: kalshi.api, dataPlane, traceAdapter: trace.api, mode: 'production' })
  ok(!trace.events.find(e => e.event_type === 'gateway_unknowns_warn'), 'no warn for young row')
  ok(!trace.events.find(e => e.event_type === 'gateway_unknowns_critical'), 'no critical')
}

// ── Concurrency: overlapping ticks skipped ──────────────────────────
section('overlapping ticks: second call skipped, trace event emitted')
{
  _resetForTesting()
  const { db } = await freshDb()
  const dataPlane = buildDataPlane(db)
  const seed = await seedUnknown(db, dataPlane, { decision_id: 'd-overlap', ageMs: 30_000 })
  const trace = makeMockTraceAdapter()

  // Slow lookup to keep first call in-flight
  const kalshi = {
    lookupByClientOrderId: async () => {
      await new Promise(r => setTimeout(r, 100))
      return { found: true, status: 'placed', kalshi_order_id: 'KS-OVR' }
    },
  }
  const p1 = runReconciliation({ kalshi, dataPlane, traceAdapter: trace.api, mode: 'production' })
  // Immediately fire second tick
  const r2 = await runReconciliation({ kalshi, dataPlane, traceAdapter: trace.api, mode: 'production' })
  eq(r2.skipped, true, 'second call skipped')
  eq(r2.reason, 'overlap', 'reason=overlap')
  ok(trace.events.find(e => e.event_type === 'gateway_reconciler_tick_skipped'), 'skip Trace emitted')
  await p1  // wait for first to finish
}

// ── Sample id cap ───────────────────────────────────────────────────
section('rollup payload truncates to SAMPLE_DECISION_IDS (5)')
{
  _resetForTesting()
  const { db } = await freshDb()
  const dataPlane = buildDataPlane(db)
  for (let i = 0; i < 8; i++) {
    await seedUnknown(db, dataPlane, { decision_id: `d-many-${i}`, ageMs: 90_000 })
  }
  const trace = makeMockTraceAdapter()
  const kalshi = makeMockKalshi()
  await runReconciliation({ kalshi: kalshi.api, dataPlane, traceAdapter: trace.api, mode: 'production' })
  const warn = trace.events.find(e => e.event_type === 'gateway_unknowns_warn')
  ok(warn, 'warn emitted')
  eq(warn.reasoning.count, 8, 'count=8')
  eq(warn.reasoning.sample_decision_ids.length, 5, 'sample capped at 5')
}

// ── Error: missing deps ─────────────────────────────────────────────
section('runReconciliation throws on missing deps')
{
  _resetForTesting()
  let threw = false
  try { await runReconciliation({}) } catch { threw = true }
  ok(threw, 'empty deps throws')
}

// ─── Cleanup ──────────────────────────────────────────────────────────
console.log(`\n${_passed} passed, ${_failed} failed`)
await fs.rm(tmpRoot, { recursive: true, force: true })
process.exit(_failed > 0 ? 1 : 0)
