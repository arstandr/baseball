// scripts/tests/oraclePathParityTest.js
//
// Bite L2.5 — Layer 2 parity test.
//
// Suites:
//   A. PARITY  — for each of 280 fixture rows, run() output matches
//                fixture.expected exactly (numeric: 1e-12).
//   B. ENVELOPE — schema_version, hash linkage, hash determinism,
//                output_hash exclusion, Trace stub validation.
//   C. PIPELINE SMOKE — Layer 1 computeMatchup → Layer 2 run for
//                       (10 strikes × 2 sides) on a real fixture.
//
// Run standalone:
//   node scripts/tests/oraclePathParityTest.js

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import url from 'node:url'
import crypto from 'node:crypto'

import { computeMatchup, STRIKES_DEFAULT } from '../../oracle/layers/1-math/impl.js'
import {
  run, SCHEMA_VERSION, LAYER_NAME, LAYER_VERSION, SOURCE,
  FEASIBILITY_CLASSES, REASON_CODES,
} from '../../oracle/layers/2-path/impl.js'
import { validateTraceEvent, TRACE_SCHEMA_VERSION } from '../../oracle/layers/0-trace/validate.js'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const FIXTURES_PATH         = path.resolve(__dirname, '../../oracle/layers/2-path/parity-fixtures.json')
const LAYER1_FIXTURES_PATH  = path.resolve(__dirname, '../../oracle/layers/1-math/parity-fixtures.json')
const WEIGHTS_PATH          = path.resolve(__dirname, '../../models/pk_ridge_weights.json')

const FLOAT_TOL = 1e-12
const HEX64 = /^[a-f0-9]{64}$/

// ─── Test infra ──────────────────────────────────────────────────
let _passed = 0, _failed = 0
const ok = (c, l) => c ? _passed++ : (_failed++, console.error(`FAIL [${l}]`))
const eq = (a, b, l) => {
  if (a === b) { _passed++; return }
  if (a == null && b == null) { _passed++; return }
  _failed++; console.error(`FAIL [${l}]: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`)
}
const approxEq = (a, b, tol, l) => {
  if (a == null && b == null) { _passed++; return }
  if (a == null || b == null) {
    _failed++; console.error(`FAIL [${l}]: one side null (a=${a}, b=${b})`); return
  }
  if (typeof a !== 'number' || typeof b !== 'number') {
    _failed++; console.error(`FAIL [${l}]: non-numeric`); return
  }
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    if (a === b) _passed++
    else { _failed++; console.error(`FAIL [${l}]: non-finite mismatch ${a} vs ${b}`) }
    return
  }
  if (Math.abs(a - b) <= tol) { _passed++; return }
  _failed++; console.error(`FAIL [${l}]: ${a} !~= ${b} abs_diff=${Math.abs(a-b)} tol=${tol}`)
}
const arraysEq = (a, b, l) => {
  if (!Array.isArray(a) || !Array.isArray(b)) {
    _failed++; console.error(`FAIL [${l}]: non-array`); return
  }
  if (a.length !== b.length) {
    _failed++; console.error(`FAIL [${l}]: length ${a.length} != ${b.length}`); return
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      _failed++; console.error(`FAIL [${l}]: index ${i} ${a[i]} != ${b[i]}`); return
    }
  }
  _passed++
}
const section = (n) => console.log(`\n── ${n} ──`)

async function sha256File(p) {
  return crypto.createHash('sha256').update(await readFile(p)).digest('hex')
}

console.log('═══════════════════════════════════════════')
console.log('  Layer 2 (Path) — Parity Test (Bite L2.5)')
console.log('═══════════════════════════════════════════')

// ════════════════════════════════════════════════════════════════════
// Suite A — Parity vs 280 fixture rows
// ════════════════════════════════════════════════════════════════════
async function runSuiteA() {
  section('Suite A — 280 fixture parity')

  const data = JSON.parse(await readFile(FIXTURES_PATH, 'utf-8'))
  console.log(`Loaded ${data.fixtures.length} fixtures from ${FIXTURES_PATH}`)

  // ML weights drift gate (carried over from Layer 1)
  const weightsHash = await sha256File(WEIGHTS_PATH)
  if (weightsHash !== data.pk_ridge_weights_hash) {
    console.error(`\n❌ ML WEIGHTS DRIFT vs Layer 2 fixtures`)
    console.error(`   fixtures expect: ${data.pk_ridge_weights_hash}`)
    console.error(`   current weights: ${weightsHash}`)
    _failed++; return
  }
  ok(true, 'ml_weights_hash_matches')
  ok(data.fixtures.length === 280, `fixture count = 280 (got ${data.fixtures.length})`)

  // Build a per-fixture synthetic Layer 1 envelope. Reading the
  // Layer 1 fixtures file gives us the inner + multipliers. We
  // construct an envelope-shaped object that Layer 2.run() can read.
  const l1 = JSON.parse(await readFile(LAYER1_FIXTURES_PATH, 'utf-8'))
  const l1ById = new Map(l1.fixtures.map(f => [f.fixture_id, f]))

  // Cache envelopes per source_layer1_fixture_id (one envelope per
  // (pitcher, bet_date), reused across 20 fixture rows).
  const envCache = new Map()
  function envelopeFor(sourceId) {
    if (envCache.has(sourceId)) return envCache.get(sourceId)
    const f1 = l1ById.get(sourceId)
    if (!f1) throw new Error(`Layer 1 fixture not found: ${sourceId}`)
    const oc = f1.expected_outer_chain_from_production
    const mult = {
      split_adj:    oc.split_adj,
      opp_adj:      oc.opp_adj,
      park_factor:  oc.park_factor,
      weather_mult: oc.weather_mult,
      ump_factor:   oc.ump_factor,
    }
    // Use computeMatchup so we get a real envelope with hashes.
    const env = computeMatchup(f1.inputs, mult, {
      run_id:      `fixture-${sourceId}`,
      computed_at: '2026-05-01T00:00:00.000Z',
      commit_hash: 'fixture-test',
    })
    envCache.set(sourceId, env)
    return env
  }

  for (const f of data.fixtures) {
    const env = envelopeFor(f.source_layer1_fixture_id)
    let r
    try {
      r = await run(env, {
        decision_id: `parity-${f.fixture_id}`,
        pitcher_id:  f.pitcher_id ?? '12345',
        pitcher_name: f.pitcher_name ?? 'Test',
        bet_date:    f.bet_date,
        strike:      f.strike,
        side:        f.side,
        run_id:      `r-${f.fixture_id}`,
        computed_at: '2026-05-01T00:00:00.000Z',
        commit_hash: 'fixture-test',
      })
    } catch (err) {
      _failed++
      console.error(`FAIL [${f.fixture_id}]: run threw ${err.message}`)
      continue
    }

    const e = f.expected
    const lbl = (k) => `${f.fixture_id}/${k}`
    eq(r.feasibility,        e.feasibility,        lbl('feasibility'))
    eq(r.reason_code,        e.reason_code,        lbl('reason_code'))
    arraysEq(r.secondary_reasons, e.secondary_reasons, lbl('secondary_reasons'))
    approxEq(r.required_bf,        e.required_bf,        FLOAT_TOL, lbl('required_bf'))
    approxEq(r.required_bf_outer,  e.required_bf_outer,  FLOAT_TOL, lbl('required_bf_outer'))
    approxEq(r.bf_gap,             e.bf_gap,             FLOAT_TOL, lbl('bf_gap'))
    approxEq(r.bf_gap_ratio,       e.bf_gap_ratio,       FLOAT_TOL, lbl('bf_gap_ratio'))
    if (e.bf_ceiling == null) eq(r.bf_ceiling, null, lbl('bf_ceiling'))
    else                       approxEq(r.bf_ceiling, e.bf_ceiling, FLOAT_TOL, lbl('bf_ceiling'))
    approxEq(r.required_pk,        e.required_pk,        FLOAT_TOL, lbl('required_pk'))
    approxEq(r.gap_under,          e.gap_under,          FLOAT_TOL, lbl('gap_under'))
  }
}

// ════════════════════════════════════════════════════════════════════
// Suite B — envelope shape, hash determinism, Trace integration
// ════════════════════════════════════════════════════════════════════
async function runSuiteB() {
  section('Suite B — envelope + hash + Trace integration')

  // Build a real envelope from a Layer 1 fixture
  const l1 = JSON.parse(await readFile(LAYER1_FIXTURES_PATH, 'utf-8'))
  const f1 = l1.fixtures[0]
  const oc = f1.expected_outer_chain_from_production
  const mult = {
    split_adj: oc.split_adj, opp_adj: oc.opp_adj,
    park_factor: oc.park_factor, weather_mult: oc.weather_mult,
    ump_factor: oc.ump_factor,
  }
  const env = computeMatchup(f1.inputs, mult)

  const baseCtx = {
    decision_id:  'b-test-1',
    pitcher_id:   f1.pitcher_id,
    pitcher_name: f1.pitcher_name,
    bet_date:     f1.bet_date,
    strike:       6,
    side:         'YES',
  }

  // B1: result envelope shape
  section('B — B1 envelope shape')
  const r = await run(env, baseCtx)
  eq(r.schema_version, SCHEMA_VERSION,         'B1 schema_version')
  eq(r.layer,          'path',                 'B1 layer')
  eq(r.layer_version,  LAYER_VERSION,          'B1 layer_version')
  eq(r.source,         SOURCE,                 'B1 source')
  ok(typeof r.run_id === 'string' && r.run_id.length === 36, 'B1 run_id is uuid')
  ok(HEX64.test(r.inputs_hash),  'B1 inputs_hash is sha256 hex')
  ok(HEX64.test(r.output_hash),  'B1 output_hash is sha256 hex')
  eq(r.matchup_output_hash, env.output_hash,    'B1 matchup_output_hash linked to L1 envelope')
  eq(r.strike, 6,                                'B1 strike echoed')
  eq(r.side,   'YES',                            'B1 side echoed')
  ok(['strong','viable','fragile','dead'].includes(r.feasibility), 'B1 feasibility valid')
  ok(typeof r.reason_code === 'string',          'B1 reason_code is string')
  ok(Array.isArray(r.secondary_reasons),         'B1 secondary_reasons is array')

  // B2: hash determinism (same envelope + ctx → same output_hash)
  section('B — B2 hash determinism')
  const r2 = await run(env, baseCtx)
  eq(r.output_hash, r2.output_hash, 'B2 same env+ctx → same output_hash')
  eq(r.inputs_hash, r2.inputs_hash, 'B2 same env+ctx → same inputs_hash')
  ok(r.run_id !== r2.run_id, 'B2 run_id differs across calls (uuid)')

  // B3: output_hash excludes run_id / computed_at / output_hash
  section('B — B3 output_hash exclusion')
  const rA = await run(env, { ...baseCtx, run_id: 'a-id', computed_at: '2026-01-01T00:00:00Z' })
  const rB = await run(env, { ...baseCtx, run_id: 'b-id', computed_at: '2026-01-02T00:00:00Z' })
  eq(rA.output_hash, rB.output_hash, 'B3 forced run_id+computed_at differ → output_hash same')

  // B4: different (strike, side) → different per-bet hashes; same matchup hash
  section('B — B4 per-bet hash distinctness')
  const rNo = await run(env, { ...baseCtx, side: 'NO', decision_id: 'b-test-no' })
  ok(rNo.matchup_output_hash === r.matchup_output_hash, 'B4 shared matchup_output_hash')
  ok(rNo.inputs_hash !== r.inputs_hash, 'B4 YES vs NO → different inputs_hash')
  ok(rNo.output_hash !== r.output_hash, 'B4 YES vs NO → different output_hash')

  // B5: Trace event via stub — single emit, validateTraceEvent passes
  section('B — B5 Trace event via stub')
  const captured = []
  const traceStub = { writeAsync: (ev) => { captured.push(ev); return ev.id } }
  await run(env, { ...baseCtx, decision_id: 'b-test-trace', emit_trace: true, trace: traceStub })
  eq(captured.length, 1, 'B5 exactly one trace event emitted')
  let validateThrew = null
  try { validateTraceEvent(captured[0]) } catch (err) { validateThrew = err.message }
  eq(validateThrew, null, `B5 validateTraceEvent passes (err: ${validateThrew})`)
  const ev = captured[0]
  eq(ev.layer_name, 'path',                  'B5 event.layer_name')
  eq(ev.layer_version, LAYER_VERSION,        'B5 event.layer_version')
  eq(ev.event_type,    'decision',           'B5 event.event_type')
  eq(ev.trace_schema_version, TRACE_SCHEMA_VERSION, 'B5 trace_schema_version')
  eq(ev.strike, 6, 'B5 event.strike')
  eq(ev.side,   'YES', 'B5 event.side')
  eq(ev.pitcher_id, f1.pitcher_id, 'B5 event.pitcher_id')
  ok(['strong','viable','fragile','dead'].includes(ev.decision), 'B5 event.decision valid')
  ok(typeof ev.reason_code === 'string', 'B5 event.reason_code is string')
  // reasoning carries the path-specific fields
  ok(ev.reasoning.feasibility,        'B5 reasoning.feasibility')
  ok(ev.reasoning.workload_signal,    'B5 reasoning.workload_signal')
  ok(ev.reasoning.bf_source_tier,     'B5 reasoning.bf_source_tier')
  ok(Array.isArray(ev.reasoning.secondary_reasons), 'B5 reasoning.secondary_reasons array')
  // metrics
  ok(typeof ev.metrics.required_bf === 'number', 'B5 metrics.required_bf')
  eq(ev.metrics.matchup_output_hash, env.output_hash, 'B5 metrics.matchup_output_hash linked')
  // evidence_used links to Layer 1 matchup
  eq(ev.evidence_used.length, 1, 'B5 single evidence entry')
  eq(ev.evidence_used[0].name, 'oracle_layer_1_math.matchup', 'B5 evidence name')
  eq(ev.evidence_used[0].input_hash, env.inputs_hash, 'B5 evidence input_hash = envelope.inputs_hash')

  // B6: emit_trace=true without trace stub throws
  section('B — B6 emit_trace=true without stub throws')
  let threw = false
  try {
    await run(env, { ...baseCtx, decision_id: 'b6', emit_trace: true })
  } catch { threw = true }
  ok(threw, 'B6 throws when emit_trace=true and ctx.trace missing')

  // B7: ctx validation
  section('B — B7 ctx validation')
  for (const [missing, badCtx] of [
    ['decision_id', { ...baseCtx, decision_id: '' }],
    ['strike',      { ...baseCtx, strike: 'six' }],
    ['side',        { ...baseCtx, side: 'MAYBE' }],
    ['pitcher_id',  { ...baseCtx, pitcher_id: null }],
    ['pitcher_name', { ...baseCtx, pitcher_name: null }],
    ['bet_date',    { ...baseCtx, bet_date: null }],
  ]) {
    let t = false
    try { await run(env, badCtx) } catch { t = true }
    ok(t, `B7 throws when ctx.${missing} invalid`)
  }

  // B8: re-export checks
  section('B — B8 re-exports')
  ok(Object.isFrozen(FEASIBILITY_CLASSES), 'B8 FEASIBILITY_CLASSES frozen (re-exported)')
  ok(Object.isFrozen(REASON_CODES),        'B8 REASON_CODES frozen (re-exported)')
}

// ════════════════════════════════════════════════════════════════════
// Suite C — Full Layer 1 → Layer 2 pipeline smoke
// ════════════════════════════════════════════════════════════════════
async function runSuiteC() {
  section('Suite C — Full pipeline smoke (L1 → L2)')

  const l1 = JSON.parse(await readFile(LAYER1_FIXTURES_PATH, 'utf-8'))
  // Use a fixture from each archetype to exercise the chain
  const archetypes = [...new Set(l1.fixtures.map(f => f.archetype))]

  const captured = []
  const traceStub = { writeAsync: (ev) => { captured.push(ev); return ev.id } }

  let totalCalls = 0
  for (const arch of archetypes) {
    const f1 = l1.fixtures.find(f => f.archetype === arch)
    const oc = f1.expected_outer_chain_from_production
    const mult = {
      split_adj: oc.split_adj, opp_adj: oc.opp_adj,
      park_factor: oc.park_factor, weather_mult: oc.weather_mult,
      ump_factor: oc.ump_factor,
    }
    const env = computeMatchup(f1.inputs, mult)
    ok(env && env.output_hash, `C ${arch}: L1 envelope built with output_hash`)
    eq(typeof env.outer.lambda_final, 'number', `C ${arch}: L1 lambda_final is number`)

    // Iterate every (strike, side) for this fixture
    for (const strike of STRIKES_DEFAULT) {
      for (const side of ['YES', 'NO']) {
        const r = await run(env, {
          decision_id: `pipeline-${arch}-${strike}-${side}`,
          pitcher_id:  f1.pitcher_id,
          pitcher_name: f1.pitcher_name,
          bet_date:    f1.bet_date,
          strike, side,
          emit_trace: true,
          trace: traceStub,
        })
        totalCalls++
        ok(r.matchup_output_hash === env.output_hash,
          `C ${arch} ${strike}${side}: matchup_output_hash linked`)
        ok(['strong','viable','fragile','dead'].includes(r.feasibility),
          `C ${arch} ${strike}${side}: feasibility valid`)
      }
    }
  }
  ok(totalCalls === archetypes.length * 10 * 2, `C total calls = ${archetypes.length}×10×2 = ${archetypes.length * 20}`)
  ok(captured.length === totalCalls, `C trace events = ${captured.length} (one per run)`)
  // All trace events validate
  let traceErrs = 0
  for (const ev of captured) {
    try { validateTraceEvent(ev) } catch { traceErrs++ }
  }
  eq(traceErrs, 0, `C all ${captured.length} trace events validate`)
}

// ─── Main ───────────────────────────────────────────────────────────
await runSuiteA()
await runSuiteB()
await runSuiteC()

console.log(`\n═══════════════════════════════════════════`)
console.log(`  ${_passed} passed, ${_failed} failed`)
console.log('═══════════════════════════════════════════')
process.exit(_failed > 0 ? 1 : 0)
