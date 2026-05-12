#!/usr/bin/env node
// scripts/tests/oracleTraceTest.js — Oracle Layer 0 (Trace) test suite
//
// Tests the locked v1.0 spec:
//   - schema migration applies cleanly
//   - validateTraceEvent rejects invalid events
//   - writeSync persists with retry
//   - writeAsync enqueues without blocking, flushes correctly
//   - read() reconstructs per-bet decision documents
//   - upsertBetTrace + recordOutcome populate summary table
//   - disagreements + counterfactual queries return correct shape
//   - replayValidate detects input_hash drift
//   - graceful shutdown drains queue
//
// Uses a temp local SQLite file — no Turso credentials, no production data touched.
// Run: node scripts/tests/oracleTraceTest.js

import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TEST_DB = path.join(os.tmpdir(), `oracle-trace-test-${Date.now()}.db`)

// MUST set env before any module that imports lib/db.js loads
process.env.TURSO_DATABASE_URL  = `file:${TEST_DB}`
process.env.TURSO_AUTH_TOKEN    = 'unused-for-local-file'
process.env.NODE_ENV            = 'test'
process.env.AGENT_ID            = 'test-runner'
process.env.AGENT_VERSION       = 'test-1.0'

let pass = 0, fail = 0
const failures = []

function eq(actual, expected, msg) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail++
    failures.push(`✗ ${msg}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`)
    return false
  }
  pass++
  console.log(`  ✓ ${msg}`)
  return true
}

function ok(cond, msg) {
  if (!cond) {
    fail++
    failures.push(`✗ ${msg}`)
    return false
  }
  pass++
  console.log(`  ✓ ${msg}`)
  return true
}

function section(name) {
  console.log(`\n━━━ ${name} ━━━`)
}

async function expectThrows(fn, matchPattern, msg) {
  try {
    await fn()
    fail++
    failures.push(`✗ ${msg} — expected throw, got success`)
    return false
  } catch (err) {
    if (matchPattern && !matchPattern.test(err.message)) {
      fail++
      failures.push(`✗ ${msg} — threw but message didn't match\n    expected pattern: ${matchPattern}\n    got: ${err.message}`)
      return false
    }
    pass++
    console.log(`  ✓ ${msg}`)
    return true
  }
}

// ════════════════════════════════════════════════════════════════════
// Test fixtures — synthetic event factories
// ════════════════════════════════════════════════════════════════════

function makeBaseEvent(overrides = {}) {
  const decision_id = overrides.decision_id || crypto.randomUUID()
  const ev = {
    id: crypto.randomUUID(),
    decision_id,
    parent_event_id: null,
    trace_schema_version: '1.0.0',
    created_at: new Date().toISOString(),

    layer_name: 'math',
    layer_version: '1.0.0',
    commit_hash: 'test1234',
    agent_id: 'test-runner',
    agent_version: 'test-1.0',
    server_version: null,
    environment: 'test',
    run_id: null,
    request_id: null,

    mode: 'shadow',
    system: 'oracle',
    event_type: 'decision',
    user_id: null,
    bet_id: null,

    game_pk: 'TEST_GAME',
    pitcher_id: 'TEST_PITCHER',
    pitcher_name: 'Test Pitcher',
    market_ticker: 'KXMLBKS-TEST-7',
    bet_date: '2026-04-30',
    strike: 7,
    side: 'YES',

    decision: 'fire',
    reason_code: 'edge_qualified',
    reasoning: { reason: 'high model edge' },
    metrics: { modelProb: 0.78, edge: 0.27, kellySize: 90 },
    evidence_used: [],
    input_hash: 'a'.repeat(64),
    output_hash: 'b'.repeat(64),

    status: 'success',
    severity: 'info',
    latency_ms: 5,
    error_message: null,
    tokens_used: null,
    cost_usd: null,

    would_have_action: null,
    actual_action: null,
    market_snapshot_id: null,
    state_snapshot_id: null,

    ...overrides,
  }
  return ev
}

// ════════════════════════════════════════════════════════════════════
// Tests
// ════════════════════════════════════════════════════════════════════

async function runTests() {
  console.log(`Running tests against temp DB: ${TEST_DB}\n`)

  // Dynamic import AFTER env is set so lib/db.js picks up TURSO_DATABASE_URL
  const trace = await import('../../oracle/layers/0-trace/impl.js')
  const { validateTraceEvent, tryValidateTraceEvent, ValidationError } =
    await import('../../oracle/layers/0-trace/validate.js')
  const db = await import('../../lib/db.js')

  // ── Setup: migrate schema ──────────────────────────────────────────
  section('Setup — schema migration')
  const migration = await trace.migrate()
  ok(migration.statements > 0, `migration applied ${migration.statements} statements`)

  // ── Validation tests ────────────────────────────────────────────────
  section('Validation — required fields')
  await expectThrows(
    () => validateTraceEvent({}),
    /required field missing/i,
    'empty object throws',
  )
  await expectThrows(
    () => validateTraceEvent(null),
    /must be an object/i,
    'null throws',
  )
  await expectThrows(
    () => validateTraceEvent(makeBaseEvent({ id: '' })),
    /id/i,
    'empty id throws',
  )
  await expectThrows(
    () => validateTraceEvent(makeBaseEvent({ trace_schema_version: '999.0.0' })),
    /trace_schema_version/i,
    'wrong schema version throws',
  )
  await expectThrows(
    () => validateTraceEvent(makeBaseEvent({ layer_name: 'unknown' })),
    /layer_name/i,
    'invalid layer_name throws',
  )
  await expectThrows(
    () => validateTraceEvent(makeBaseEvent({ mode: 'live' })),
    /mode/i,
    'invalid mode throws',
  )
  await expectThrows(
    () => validateTraceEvent(makeBaseEvent({ side: 'BOTH' })),
    /side/i,
    'invalid side throws',
  )
  await expectThrows(
    () => validateTraceEvent(makeBaseEvent({ status: 'partial' })),
    /status/i,
    'invalid status throws',
  )
  await expectThrows(
    () => validateTraceEvent(makeBaseEvent({ severity: 'fatal' })),
    /severity/i,
    'invalid severity throws',
  )
  await expectThrows(
    () => validateTraceEvent(makeBaseEvent({ event_type: 'decision', pitcher_id: null })),
    /pitcher_id/i,
    'decision event without pitcher_id throws',
  )
  await expectThrows(
    () => validateTraceEvent(makeBaseEvent({ input_hash: 'short' })),
    /input_hash/i,
    'short input_hash throws',
  )
  await expectThrows(
    () => validateTraceEvent(makeBaseEvent({ input_hash: 'A'.repeat(64) })),
    /input_hash/i,
    'uppercase hash throws (must be lowercase)',
  )
  await expectThrows(
    () => validateTraceEvent(makeBaseEvent({ evidence_used: 'not-array' })),
    /evidence_used/i,
    'evidence_used must be array',
  )
  await expectThrows(
    () => validateTraceEvent(makeBaseEvent({
      evidence_used: [{ name: 'x' }],  // missing id and input_hash
    })),
    /evidence_used\[0\]/i,
    'evidence item missing fields throws',
  )
  await expectThrows(
    () => validateTraceEvent(makeBaseEvent({ created_at: 'not-a-date' })),
    /created_at/i,
    'invalid created_at throws',
  )

  section('Validation — valid events pass')
  const valid = makeBaseEvent()
  const validated = validateTraceEvent(valid)
  ok(validated === valid, 'valid event returned unchanged')

  const r1 = tryValidateTraceEvent(valid)
  eq(r1.valid, true, 'tryValidate returns valid=true for good event')

  const r2 = tryValidateTraceEvent({})
  eq(r2.valid, false, 'tryValidate returns valid=false for bad event')
  ok(r2.error.length > 0, 'tryValidate provides error message')

  // ── sha256 helper ───────────────────────────────────────────────────
  section('sha256 helper')
  const h1 = trace.sha256({ a: 1, b: 2 })
  const h2 = trace.sha256({ b: 2, a: 1 })  // different order, same content
  eq(h1, h2, 'sha256 is order-independent (key-sorted)')
  ok(/^[a-f0-9]{64}$/.test(h1), 'sha256 returns 64 hex chars')
  const h3 = trace.sha256('plain string')
  ok(/^[a-f0-9]{64}$/.test(h3), 'sha256 of string works')
  ok(h1 !== h3, 'different inputs produce different hashes')

  // ── makeEvent factory ───────────────────────────────────────────────
  section('makeEvent factory')
  const built = trace.makeEvent({
    decision_id: 'd1',
    layer_name: 'math',
    decision: 'fire',
    pitcher_id: 'p1',
    pitcher_name: 'Builder Test',
    bet_date: '2026-04-30',
    strike: 5,
    side: 'YES',
  })
  ok(built.id, 'id auto-generated')
  ok(built.created_at, 'created_at auto-set')
  eq(built.trace_schema_version, '1.0.0', 'trace_schema_version locked to 1.0.0')
  eq(built.mode, 'shadow', 'mode defaults to shadow')
  eq(built.system, 'oracle', 'system defaults to oracle')
  ok(/^[a-f0-9]{64}$/.test(built.input_hash), 'input_hash auto-computed (sha256)')
  ok(/^[a-f0-9]{64}$/.test(built.output_hash), 'output_hash auto-computed')
  // The factory output must validate
  validateTraceEvent(built)
  pass++
  console.log('  ✓ factory output passes validation')

  // ── F1: writeSync roundtrip ────────────────────────────────────────
  section('F1: writeSync roundtrip')
  const ev1 = trace.makeEvent({
    decision_id: 'F1_decision',
    layer_name: 'math',
    decision: 'fire',
    pitcher_id: 'F1_pitcher',
    pitcher_name: 'F1 Test',
    bet_date: '2026-04-30',
    strike: 6,
    side: 'YES',
    metrics: { modelProb: 0.7, edge: 0.18 },
  })
  const writtenId = await trace.writeSync(ev1)
  eq(writtenId, ev1.id, 'writeSync returns the event id')

  await trace.upsertBetTrace({
    decision_id: 'F1_decision',
    system: 'oracle',
    pitcher_id: 'F1_pitcher',
    bet_date: '2026-04-30',
    strike: 6,
    side: 'YES',
    final_decision: 'fire',
    final_size_usd: 50,
    would_have_executed: true,
    executed: false,
  })

  const back = await trace.read({ decision_id: 'F1_decision' })
  ok(back, 'read() returns trace document')
  eq(back.decision_id, 'F1_decision', 'decision_id matches')
  ok(back.systems.oracle, 'oracle system present')
  eq(back.systems.oracle.events.length, 1, 'oracle has 1 event')
  eq(back.systems.oracle.events[0].decision, 'fire', 'event decision preserved')
  eq(back.systems.oracle.final_decision, 'fire', 'final_decision in summary')

  // Verify JSON columns hydrated
  eq(back.systems.oracle.events[0].metrics.modelProb, 0.7, 'metrics JSON hydrated')

  // ── F2: Two systems disagree ───────────────────────────────────────
  section('F2: Two systems disagree')
  const F2_did = 'F2_decision'
  await trace.writeSync(trace.makeEvent({
    decision_id: F2_did, system: 'oracle',
    layer_name: 'judge', decision: 'skip',
    pitcher_id: 'F2_p', pitcher_name: 'F2 Test',
    bet_date: '2026-04-30', strike: 7, side: 'YES',
  }))
  await trace.writeSync(trace.makeEvent({
    decision_id: F2_did, system: 'current',
    layer_name: 'judge', decision: 'fire',
    pitcher_id: 'F2_p', pitcher_name: 'F2 Test',
    bet_date: '2026-04-30', strike: 7, side: 'YES',
  }))
  await trace.upsertBetTrace({
    decision_id: F2_did, system: 'oracle', pitcher_id: 'F2_p',
    bet_date: '2026-04-30', strike: 7, side: 'YES',
    final_decision: 'skip', final_size_usd: 0,
    would_have_executed: false,
  })
  await trace.upsertBetTrace({
    decision_id: F2_did, system: 'current', pitcher_id: 'F2_p',
    bet_date: '2026-04-30', strike: 7, side: 'YES',
    final_decision: 'fire', final_size_usd: 35,
    would_have_executed: true,
  })

  const dis = await trace.disagreements({ bet_date: '2026-04-30' })
  ok(dis.length >= 1, 'disagreements query returns rows')
  const f2Row = dis.find(r => r.decision_id === F2_did)
  ok(f2Row, 'F2 disagreement found')
  eq(f2Row.oracle_decision, 'skip', 'oracle decision recorded')
  eq(f2Row.current_decision, 'fire', 'current decision recorded')

  // ── F3: Outcome backfill ───────────────────────────────────────────
  section('F3: Outcome backfill')
  const F3_did = 'F3_decision'
  await trace.writeSync(trace.makeEvent({
    decision_id: F3_did, system: 'oracle',
    layer_name: 'judge', decision: 'fire',
    pitcher_id: 'F3_p', pitcher_name: 'F3 Test',
    bet_date: '2026-04-30', strike: 5, side: 'YES',
  }))
  await trace.upsertBetTrace({
    decision_id: F3_did, system: 'oracle', pitcher_id: 'F3_p',
    bet_date: '2026-04-30', strike: 5, side: 'YES',
    final_decision: 'fire', final_size_usd: 22.5,
  })
  await trace.recordOutcome({
    decision_id: F3_did, system: 'oracle',
    result: 'loss', pnl_usd: -22.50,
  })
  const F3 = await trace.read({ decision_id: F3_did })
  eq(F3.outcome.pnl_usd, -22.5, 'outcome pnl_usd backfilled')
  eq(F3.outcome.result, 'loss', 'outcome result backfilled')

  // ── F5: Replay integrity ───────────────────────────────────────────
  section('F5: Replay integrity (input_hash drift)')
  const F5_did = 'F5_decision'
  const stableValue = { x: 42, y: 'stable' }
  const stableHash = trace.sha256(stableValue)
  await trace.writeSync(trace.makeEvent({
    decision_id: F5_did,
    layer_name: 'math',
    decision: 'fire',
    pitcher_id: 'F5_p', pitcher_name: 'F5 Test',
    bet_date: '2026-04-30', strike: 5, side: 'YES',
    evidence_used: [
      { name: 'src1', id: 'row42', input_hash: stableHash },
    ],
  }))
  // First validation: source unchanged → match
  const r5a = await trace.replayValidate({
    decision_id: F5_did,
    recompute: async (e) => {
      if (e.id === 'row42') return stableValue
      return null
    },
  })
  eq(r5a.integrity, 'match', 'unchanged source → match')

  // Second validation: source changed → mismatch
  const r5b = await trace.replayValidate({
    decision_id: F5_did,
    recompute: async (e) => {
      if (e.id === 'row42') return { x: 999, y: 'changed' }
      return null
    },
  })
  eq(r5b.integrity, 'mismatch', 'changed source → mismatch')
  ok(r5b.changed_evidence.includes('src1'), 'changed evidence reported')

  // ── F6/F7: Async write performance ──────────────────────────────────
  section('F6/F7: writeAsync vs writeSync timing')
  const asyncEv = trace.makeEvent({
    decision_id: 'async_test',
    layer_name: 'math',
    decision: 'fire',
    pitcher_id: 'AT', pitcher_name: 'Async Test',
    bet_date: '2026-04-30', strike: 5, side: 'YES',
  })
  const start = Date.now()
  trace.writeAsync(asyncEv)  // fire-and-forget enqueue
  const elapsed = Date.now() - start
  ok(elapsed < 10, `writeAsync returned in ${elapsed}ms (<10ms target)`)

  // Flush so the event lands
  const flushed = await trace.flushNow()
  ok(flushed.flushed >= 1, `flushNow flushed ${flushed.flushed} events`)

  const asyncBack = await trace.read({ decision_id: 'async_test' })
  ok(asyncBack && asyncBack.systems.oracle.events.length === 1, 'async event persisted after flush')

  // ── F8: Sync write retries on failure ──────────────────────────────
  // Hard to mock the libsql client; we test that writeSync at least handles
  // the success path correctly. Failure-path retry will be covered by
  // integration tests against a controlled DB.
  section('F8: writeSync success path')
  const F8 = trace.makeEvent({
    decision_id: 'F8',
    layer_name: 'gateway',
    decision: 'pass',
    event_type: 'decision',
    pitcher_id: 'F8_p', pitcher_name: 'F8 Test',
    bet_date: '2026-04-30', strike: 5, side: 'YES',
  })
  await trace.writeSync(F8)
  const F8back = await trace.read({ decision_id: 'F8' })
  ok(F8back, 'writeSync persisted F8 event')

  // ── Counterfactual query ────────────────────────────────────────────
  section('counterfactual query')
  const cf = await trace.counterfactual({
    start_date: '2026-04-30', end_date: '2026-04-30',
  })
  ok(Array.isArray(cf), 'counterfactual returns array')
  ok(cf.length >= 1, 'counterfactual returns at least one row')
  ok('oracle_pnl' in (cf[0] ?? {}), 'counterfactual rows have oracle_pnl')

  // ── Queue stats ─────────────────────────────────────────────────────
  section('Queue stats')
  const qs = trace.queueStats()
  eq(typeof qs.length, 'number', 'queueStats.length is a number')
  eq(typeof qs.oldest_age_ms, 'number', 'queueStats.oldest_age_ms is a number')

  // ── Critical failure handler ────────────────────────────────────────
  section('Critical failure handler')
  let handlerCalled = false
  let handlerArg = null
  trace.setCriticalFailureHandler((arg) => {
    handlerCalled = true
    handlerArg = arg
  })
  // Trigger a bogus event that fails persistence by manually calling a private path
  // We can't easily force a write failure with a temp file DB.
  // Instead, verify the handler is wired; actual failure-path coverage in integration tests.
  ok(typeof trace.setCriticalFailureHandler === 'function', 'critical handler API exists')

  // ── Decision events with full evidence_used ────────────────────────
  section('Full evidence_used roundtrip')
  const evidEv = trace.makeEvent({
    decision_id: 'evid_test',
    layer_name: 'math',
    decision: 'fire',
    pitcher_id: 'E_p', pitcher_name: 'Evidence Test',
    bet_date: '2026-04-30', strike: 6, side: 'YES',
    evidence_used: [
      { name: 'pitcher_recent_starts', id: 'p_E_start_1', input_hash: trace.sha256({ ks: [5,6,4] }) },
      { name: 'dk_k_props', id: 'snap_T-90_E', input_hash: trace.sha256({ line: 5.5 }) },
    ],
  })
  await trace.writeSync(evidEv)
  const evidBack = await trace.read({ decision_id: 'evid_test' })
  eq(evidBack.systems.oracle.events[0].evidence_used.length, 2, 'evidence_used roundtrip')
  eq(evidBack.systems.oracle.events[0].evidence_used[0].name, 'pitcher_recent_starts',
     'evidence name preserved')

  // ── Reasoning + metrics roundtrip ───────────────────────────────────
  section('reasoning + metrics roundtrip')
  const richEv = trace.makeEvent({
    decision_id: 'rich_test',
    layer_name: 'critic',
    decision: 'size_down',
    pitcher_id: 'R_p', pitcher_name: 'Rich Test',
    bet_date: '2026-04-30', strike: 7, side: 'YES',
    reasoning: {
      primary_risk: 'workload_bf_risk',
      objection: 'rookie leash limits BF to ~17',
      evidence_basis: ['recent_pitch_counts', 'manager_tendency'],
    },
    metrics: {
      modelProb: 0.78,
      requiredBF: 25,
      expectedBF: 17,
      bfMargin: -8,
    },
  })
  await trace.writeSync(richEv)
  const richBack = await trace.read({ decision_id: 'rich_test' })
  eq(richBack.systems.oracle.events[0].reasoning.primary_risk, 'workload_bf_risk',
     'reasoning JSON roundtrip')
  eq(richBack.systems.oracle.events[0].metrics.bfMargin, -8,
     'metrics numeric roundtrip')

  // ── Graceful shutdown ──────────────────────────────────────────────
  section('Graceful shutdown')
  trace.writeAsync(trace.makeEvent({
    decision_id: 'shutdown_test',
    layer_name: 'math',
    decision: 'fire',
    pitcher_id: 'S_p', pitcher_name: 'Shutdown Test',
    bet_date: '2026-04-30', strike: 5, side: 'YES',
  }))
  await trace.shutdown(2000)
  const shutBack = await trace.read({ decision_id: 'shutdown_test' })
  ok(shutBack && shutBack.systems.oracle.events.length === 1,
     'shutdown drained queued event')

  // ════════════════════════════════════════════════════════════════════
  // PASS 2: alerts + queue backlog detector
  // ════════════════════════════════════════════════════════════════════

  // Force webhook URL to something that will fail — we test dedup, not Discord delivery
  process.env.ORACLE_HEALTH_WEBHOOK_URL = 'http://invalid.localhost.test/webhook-that-will-fail'
  const alerts = await import('../../oracle/layers/0-trace/alerts.js')
  alerts._clearDedupForTesting()

  section('Alerts — basic send (webhook intentionally invalid)')
  const a1 = await alerts.alertOracleHealth({
    trigger: 'test_trigger_1',
    severity: 'critical',
    title: 'Test alert',
    detail: 'first',
  })
  // We expect sent=false because the URL is invalid, but the function should return gracefully
  ok(a1.sent === false, 'alert with invalid webhook returns sent=false (no throw)')
  ok(a1.reason, 'alert returns reason on failure')

  section('Alerts — dedup within hour bucket')
  alerts._clearDedupForTesting()
  const d1 = await alerts.alertOracleHealth({
    trigger: 'dedup_test', severity: 'warn', title: 'first',
  })
  const d2 = await alerts.alertOracleHealth({
    trigger: 'dedup_test', severity: 'warn', title: 'second',
  })
  ok(d2.reason === 'deduped', 'second alert with same trigger in same hour is deduped')
  // bypassDedup should override
  const d3 = await alerts.alertOracleHealth({
    trigger: 'dedup_test', severity: 'warn', title: 'forced',
    bypassDedup: true,
  })
  ok(d3.reason !== 'deduped', 'bypassDedup forces send attempt')

  section('Alerts — required args')
  await expectThrows(
    () => alerts.alertOracleHealth({ severity: 'warn' }),
    /trigger and title/i,
    'alert without trigger/title throws',
  )

  section('Alerts — critical handler maps trace failures correctly')
  alerts._clearDedupForTesting()
  const handler = alerts.makeTraceCriticalHandler()
  let alertCalled = 0
  const origAlert = alerts.alertOracleHealth
  // We can't trivially mock the export; just verify handler runs without throwing
  await handler({
    reason: 'write_failed',
    event: trace.makeEvent({
      decision_id: 'handler_test', layer_name: 'math', decision: 'fire',
      pitcher_id: 'h_p', pitcher_name: 'Handler Test',
      bet_date: '2026-04-30', strike: 5, side: 'YES',
    }),
    error: new Error('fake DB error'),
  })
  pass++
  console.log('  ✓ critical handler runs without throwing')

  section('Queue backlog detector')
  alerts._clearDedupForTesting()
  // Synthetic stats — 501 events triggers length alert
  const bl1 = await alerts.checkQueueBacklog({ length: 501, oldest_age_ms: 1000 })
  eq(bl1.alerted, 'length', 'queue length > 500 triggers length alert')
  // Synthetic stats — 60s old triggers age alert (clear dedup since checks share a hour bucket)
  alerts._clearDedupForTesting()
  const bl2 = await alerts.checkQueueBacklog({ length: 100, oldest_age_ms: 65_000 })
  eq(bl2.alerted, 'age', 'oldest > 60s triggers age alert')
  // Healthy state
  alerts._clearDedupForTesting()
  const bl3 = await alerts.checkQueueBacklog({ length: 50, oldest_age_ms: 5000 })
  eq(bl3.alerted, null, 'healthy queue does not alert')

  // ════════════════════════════════════════════════════════════════════
  // PASS 3: health probe + stress tests
  // ════════════════════════════════════════════════════════════════════

  section('Health probe — successful roundtrip')
  const probe = await import('../../oracle/layers/0-trace/healthProbe.js')
  probe._resetFailureCounter()
  const p1 = await probe.traceHealthProbe()
  eq(p1.healthy, true, 'probe healthy on clean DB')
  ok(typeof p1.latency_ms === 'number', 'probe reports latency_ms')
  eq(probe._getFailureCounter(), 0, 'failure counter reset on success')

  // Probe cleans up after itself — verify no leftover probe event
  const probeRow = await db.all(
    `SELECT id FROM oracle_trace_events WHERE decision_id = ?`,
    [p1.probeId],
  )
  eq(probeRow.length, 0, 'probe event cleaned up after success')

  // ════════════════════════════════════════════════════════════════════
  // STRESS / BUG-HUNT — additional edge cases
  // ════════════════════════════════════════════════════════════════════

  section('Stress: large reasoning + metrics roundtrip')
  const bigEvent = trace.makeEvent({
    decision_id: 'big_test',
    layer_name: 'critic',
    decision: 'size_down',
    pitcher_id: 'B_p', pitcher_name: 'Big Test',
    bet_date: '2026-04-30', strike: 7, side: 'YES',
    reasoning: {
      objection_text: 'a'.repeat(2000),  // 2KB objection
      sub_object: { nested: { deeply: { values: Array(20).fill({ x: 1, y: 2 }) } } },
      arr: Array(50).fill('item'),
    },
    metrics: {
      values: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`m${i}`, i * 1.5])),
    },
  })
  await trace.writeSync(bigEvent)
  const bigBack = await trace.read({ decision_id: 'big_test' })
  ok(bigBack && bigBack.systems.oracle.events[0].reasoning.objection_text.length === 2000,
     'large reasoning roundtrips intact')
  eq(bigBack.systems.oracle.events[0].metrics.values.m29, 43.5, 'large metrics roundtrip')

  section('Stress: special characters in fields')
  const specialEv = trace.makeEvent({
    decision_id: 'special_test',
    layer_name: 'math',
    decision: 'fire',
    pitcher_id: 'sp_p', pitcher_name: `O'Hearn "the Quote" McSpécial`,
    bet_date: '2026-04-30', strike: 5, side: 'YES',
    reasoning: {
      text: `Line 1\nLine 2\t"quoted"  'apostrophe' \\ é emoji 🎯`,
    },
  })
  await trace.writeSync(specialEv)
  const specBack = await trace.read({ decision_id: 'special_test' })
  ok(specBack.systems.oracle.events[0].pitcher_name.includes(`O'Hearn`),
     'special chars in pitcher_name roundtrip')
  ok(specBack.systems.oracle.events[0].reasoning.text.includes('🎯'),
     'unicode emoji roundtrip')

  section('Stress: same event ID written twice (INSERT OR REPLACE behavior)')
  const dupEv = trace.makeEvent({
    decision_id: 'dup_test',
    layer_name: 'math',
    decision: 'fire',
    pitcher_id: 'D_p', pitcher_name: 'Dup Test',
    bet_date: '2026-04-30', strike: 5, side: 'YES',
    reasoning: { v: 1 },
  })
  await trace.writeSync(dupEv)
  // Now write another event with the same ID but different decision
  const dupEv2 = { ...dupEv, decision: 'skip', reasoning: { v: 2 } }
  await trace.writeSync(dupEv2)
  // Verify only ONE row exists with that id, and it has the latest values
  const dupRow = await db.all(
    `SELECT decision FROM oracle_trace_events WHERE id = ?`,
    [dupEv.id],
  )
  eq(dupRow.length, 1, 'INSERT OR REPLACE keeps single row on id collision')
  eq(dupRow[0].decision, 'skip', 'updated value persisted on REPLACE')

  section('Stress: read on non-existent decision_id returns null')
  const notFound = await trace.read({ decision_id: 'does-not-exist' })
  eq(notFound, null, 'read returns null for missing decision_id')

  section('Stress: read requires decision_id')
  await expectThrows(
    () => trace.read({}),
    /decision_id/i,
    'read({}) throws',
  )

  section('Stress: recordOutcome requires fields')
  await expectThrows(
    () => trace.recordOutcome({ decision_id: 'x' }),
    /requires/i,
    'recordOutcome without system/result throws',
  )

  section('Stress: counterfactual with no data returns empty array')
  const cfEmpty = await trace.counterfactual({
    start_date: '2099-01-01', end_date: '2099-12-31',
  })
  eq(cfEmpty.length, 0, 'counterfactual returns empty for unused date range')

  section('Stress: disagreements with no data returns empty array')
  const disEmpty = await trace.disagreements({ bet_date: '2099-01-01' })
  eq(disEmpty.length, 0, 'disagreements returns empty for unused date')

  section('Stress: shutdown idempotency')
  await trace.shutdown(1000)
  await trace.shutdown(1000)  // calling twice shouldn't crash
  pass++
  console.log('  ✓ shutdown is idempotent (second call succeeds)')

  section('Stress: replayValidate on missing decision_id returns match (no events)')
  const replayMissing = await trace.replayValidate({
    decision_id: 'does-not-exist',
    recompute: async () => null,
  })
  eq(replayMissing.integrity, 'match', 'replayValidate on empty returns match')
  eq(replayMissing.mismatches.length, 0, 'no mismatches for empty events')

  section('Stress: many events for one decision_id')
  const manyId = 'many_test'
  for (let i = 0; i < 6; i++) {
    await trace.writeSync(trace.makeEvent({
      decision_id: manyId,
      layer_name: ['math', 'path', 'trust', 'critic', 'judge', 'gateway'][i],
      decision: 'pass',
      pitcher_id: 'm_p', pitcher_name: 'Many Test',
      bet_date: '2026-04-30', strike: 6, side: 'YES',
    }))
  }
  const manyBack = await trace.read({ decision_id: manyId })
  eq(manyBack.systems.oracle.events.length, 6, 'all 6 layer events for one decision')

  section('Stress: events ordered by created_at ASC on read')
  // Write events with explicit timestamps out of order
  const orderId = 'order_test'
  const t1 = '2026-04-30T10:00:00.000Z'
  const t2 = '2026-04-30T10:00:01.000Z'
  const t3 = '2026-04-30T10:00:02.000Z'
  await trace.writeSync({
    ...trace.makeEvent({
      decision_id: orderId, layer_name: 'judge', decision: 'fire',
      pitcher_id: 'o', pitcher_name: 'Order Test',
      bet_date: '2026-04-30', strike: 5, side: 'YES',
    }),
    created_at: t3,  // last in order
  })
  await trace.writeSync({
    ...trace.makeEvent({
      decision_id: orderId, layer_name: 'math', decision: 'fire',
      pitcher_id: 'o', pitcher_name: 'Order Test',
      bet_date: '2026-04-30', strike: 5, side: 'YES',
    }),
    created_at: t1,  // first
  })
  await trace.writeSync({
    ...trace.makeEvent({
      decision_id: orderId, layer_name: 'trust', decision: 'pass',
      pitcher_id: 'o', pitcher_name: 'Order Test',
      bet_date: '2026-04-30', strike: 5, side: 'YES',
    }),
    created_at: t2,  // middle
  })
  const orderBack = await trace.read({ decision_id: orderId })
  const orderedLayers = orderBack.systems.oracle.events.map(e => e.layer_name)
  eq(orderedLayers, ['math', 'trust', 'judge'], 'events ordered by created_at ASC')

  section('Stress: writeAsync with 100-event burst flushes correctly')
  // Restart the flusher since shutdown stopped it
  trace.startAsyncFlusher()
  for (let i = 0; i < 100; i++) {
    trace.writeAsync(trace.makeEvent({
      decision_id: `burst_${i}`,
      layer_name: 'math',
      decision: 'fire',
      pitcher_id: 'burst', pitcher_name: 'Burst Test',
      bet_date: '2026-04-30', strike: 5, side: 'YES',
    }))
  }
  // Drain the queue
  let totalFlushed = 0
  for (let i = 0; i < 10; i++) {
    const result = await trace.flushNow()
    totalFlushed += result.flushed
    if (trace.queueStats().length === 0) break
  }
  eq(totalFlushed, 100, 'all 100 burst events flushed')
  eq(trace.queueStats().length, 0, 'queue drained after burst')

  // Clean shutdown for end of tests
  trace.stopAsyncFlusher()

  // ── Done ───────────────────────────────────────────────────────────
  console.log('\n━━━ Results ━━━')
  console.log(`  PASS: ${pass}`)
  console.log(`  FAIL: ${fail}`)
  if (failures.length) {
    console.log('\nFailures:')
    for (const f of failures) console.log(f)
  }

  // Cleanup
  try { await fs.unlink(TEST_DB) } catch {}

  process.exit(fail > 0 ? 1 : 0)
}

runTests().catch(err => {
  console.error('Test runner crashed:', err)
  process.exit(1)
})
