// scripts/tests/oracleTrustParityTest.js
//
// Layer 3 (Trust) parity test.
//
// Suites:
//   A. Pure trustScore parity vs 280 fixture rows
//   B. Envelope shape, hash linkage, Trace stub
//   C. Full pipeline smoke (L1 → L2 → L3) for every archetype × strike × side

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import url from 'node:url'
import crypto from 'node:crypto'

import { computeMatchup, STRIKES_DEFAULT } from '../../oracle/layers/1-math/impl.js'
import { run as pathRun } from '../../oracle/layers/2-path/impl.js'
import {
  run as trustRun, SCHEMA_VERSION, LAYER_NAME, LAYER_VERSION, SOURCE,
  TRUST_LEVELS, REASON_CODES,
} from '../../oracle/layers/3-trust/impl.js'
import {
  scoreTrust, parseConfidence, trustLevelForScore,
  TRUST_HIGH_MIN, TRUST_MEDIUM_MIN,
  FEASIBILITY_FACTOR, BF_SOURCE_FACTOR_NO_DK, BF_SOURCE_FACTOR_DK, CONFIDENCE_FACTOR,
} from '../../oracle/layers/3-trust/trustScore.js'
import { validateTraceEvent } from '../../oracle/layers/0-trace/validate.js'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const FIXTURES_PATH        = path.resolve(__dirname, '../../oracle/layers/3-trust/parity-fixtures.json')
const L1_FIXTURES_PATH     = path.resolve(__dirname, '../../oracle/layers/1-math/parity-fixtures.json')
const WEIGHTS_PATH         = path.resolve(__dirname, '../../models/pk_ridge_weights.json')

const FLOAT_TOL = 1e-12
const HEX64 = /^[a-f0-9]{64}$/

let _passed = 0, _failed = 0
const ok = (c, l) => c ? _passed++ : (_failed++, console.error(`FAIL [${l}]`))
const eq = (a, b, l) => {
  if (a === b) { _passed++; return }
  if (a == null && b == null) { _passed++; return }
  _failed++; console.error(`FAIL [${l}]: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`)
}
const approxEq = (a, b, tol, l) => {
  if (a == null && b == null) { _passed++; return }
  if (a == null || b == null) { _failed++; console.error(`FAIL [${l}]: one null`); return }
  if (Math.abs(a - b) <= tol) { _passed++; return }
  _failed++; console.error(`FAIL [${l}]: ${a} !~= ${b}`)
}
const arraysEq = (a, b, l) => {
  if (!Array.isArray(a) || !Array.isArray(b)) { _failed++; return }
  if (a.length !== b.length) { _failed++; console.error(`FAIL [${l}]: len ${a.length} vs ${b.length}`); return }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) { _failed++; console.error(`FAIL [${l}]: idx ${i}: ${a[i]} vs ${b[i]}`); return }
  }
  _passed++
}
const throws = (fn, l) => {
  let t = false; try { fn() } catch { t = true }
  ok(t, l)
}
const section = (n) => console.log(`\n── ${n} ──`)

async function sha256File(p) {
  return crypto.createHash('sha256').update(await readFile(p)).digest('hex')
}

console.log('═══════════════════════════════════════════')
console.log('  Layer 3 (Trust) — Parity Test')
console.log('═══════════════════════════════════════════')

// ════════════════════════════════════════════════════════════════════
// Suite A — pure trustScore parity vs 280 fixtures
// ════════════════════════════════════════════════════════════════════
async function runSuiteA() {
  section('Suite A — 280 fixtures, pure trustScore parity')
  const data = JSON.parse(await readFile(FIXTURES_PATH, 'utf-8'))

  // ML weights drift gate
  const w = await sha256File(WEIGHTS_PATH)
  if (w !== data.pk_ridge_weights_hash) {
    console.error('ML weights drift'); _failed++; return
  }
  ok(true, 'ML weights hash matches')
  ok(data.fixtures.length === 280, 'fixture count = 280')

  for (const f of data.fixtures) {
    const r = scoreTrust({
      feasibility:       f.inputs.feasibility,
      bf_source_tier:    f.inputs.bf_source_tier,
      confidence:        f.inputs.confidence,
      dk_blend_applied:  f.inputs.dk_blend_applied,
    })
    const e = f.expected
    const lbl = (k) => `${f.fixture_id}/${k}`
    approxEq(r.trust_score,         e.trust_score,        FLOAT_TOL, lbl('trust_score'))
    eq(r.trust_level,               e.trust_level,                   lbl('trust_level'))
    approxEq(r.feasibility_factor,  e.feasibility_factor, FLOAT_TOL, lbl('feasibility_factor'))
    approxEq(r.bf_source_factor,    e.bf_source_factor,   FLOAT_TOL, lbl('bf_source_factor'))
    approxEq(r.confidence_factor,   e.confidence_factor,  FLOAT_TOL, lbl('confidence_factor'))
    approxEq(r.dk_blend_factor,     e.dk_blend_factor,    FLOAT_TOL, lbl('dk_blend_factor'))
    eq(r.reason_code,               e.reason_code,                   lbl('reason_code'))
    arraysEq(r.reason_codes,        e.reason_codes,                  lbl('reason_codes'))
  }
}

// ════════════════════════════════════════════════════════════════════
// Suite B — envelope shape, hash linkage, Trace
// ════════════════════════════════════════════════════════════════════
async function runSuiteB() {
  section('Suite B — envelope + Trace integration')

  const l1 = JSON.parse(await readFile(L1_FIXTURES_PATH, 'utf-8'))
  const f1 = l1.fixtures[0]
  const oc = f1.expected_outer_chain_from_production
  const mult = {
    split_adj: oc.split_adj, opp_adj: oc.opp_adj, park_factor: oc.park_factor,
    weather_mult: oc.weather_mult, ump_factor: oc.ump_factor,
  }
  const env = computeMatchup(f1.inputs, mult)
  const baseCtx = {
    decision_id: 'b-trust', pitcher_id: f1.pitcher_id, pitcher_name: f1.pitcher_name,
    bet_date: f1.bet_date, strike: 6, side: 'YES',
  }
  const pathR = await pathRun(env, baseCtx)
  const r = await trustRun(env, pathR, baseCtx)

  // B1 envelope shape
  eq(r.schema_version, SCHEMA_VERSION,         'B1 schema_version')
  eq(r.layer,          'trust',                 'B1 layer')
  eq(r.layer_version,  LAYER_VERSION,           'B1 layer_version')
  eq(r.source,         SOURCE,                  'B1 source')
  ok(typeof r.run_id === 'string' && r.run_id.length === 36, 'B1 run_id is uuid')
  ok(HEX64.test(r.inputs_hash),  'B1 inputs_hash is sha256 hex')
  ok(HEX64.test(r.output_hash),  'B1 output_hash is sha256 hex')
  eq(r.matchup_output_hash, env.output_hash,    'B1 matchup_output_hash linked')
  eq(r.path_output_hash,    pathR.output_hash,  'B1 path_output_hash linked')
  ok(typeof r.trust_score === 'number' && r.trust_score >= 0 && r.trust_score <= 1, 'B1 trust_score in [0,1]')
  ok(['high','medium','low'].includes(r.trust_level), 'B1 trust_level valid')

  // B2 hash determinism
  const r2 = await trustRun(env, pathR, baseCtx)
  eq(r.output_hash, r2.output_hash, 'B2 same env+path+ctx → same output_hash')
  eq(r.inputs_hash, r2.inputs_hash, 'B2 same → same inputs_hash')
  ok(r.run_id !== r2.run_id, 'B2 run_id differs')

  // B3 different (strike, side) → different per-bet hashes
  const baseCtxNo = { ...baseCtx, side: 'NO', decision_id: 'b-trust-no' }
  const pathRno = await pathRun(env, baseCtxNo)
  const rNo = await trustRun(env, pathRno, baseCtxNo)
  ok(rNo.matchup_output_hash === r.matchup_output_hash, 'B3 shared matchup hash')
  ok(rNo.path_output_hash !== r.path_output_hash,        'B3 different path hash YES vs NO')
  ok(rNo.inputs_hash !== r.inputs_hash, 'B3 different per-bet inputs_hash')
  ok(rNo.output_hash !== r.output_hash, 'B3 different per-bet output_hash')

  // B4 Trace event via stub
  const captured = []
  const traceStub = { writeAsync: (ev) => captured.push(ev) }
  await trustRun(env, pathR, { ...baseCtx, decision_id: 'b-trust-trace', emit_trace: true, trace: traceStub })
  eq(captured.length, 1, 'B4 one trace event')
  let validateThrew = null
  try { validateTraceEvent(captured[0]) } catch (err) { validateThrew = err.message }
  eq(validateThrew, null, 'B4 validateTraceEvent passes')
  const ev = captured[0]
  eq(ev.layer_name, 'trust',          'B4 event.layer_name')
  eq(ev.event_type, 'decision',       'B4 event_type=decision')
  ok(['high','medium','low'].includes(ev.decision), 'B4 decision is trust_level')
  ok(typeof ev.metrics.trust_score === 'number', 'B4 metrics.trust_score')
  eq(ev.metrics.matchup_output_hash, env.output_hash, 'B4 metrics.matchup_output_hash linked')
  eq(ev.metrics.path_output_hash,    pathR.output_hash, 'B4 metrics.path_output_hash linked')
  eq(ev.evidence_used.length, 2, 'B4 evidence_used has 2 entries (L1 + L2)')
  eq(ev.evidence_used[0].name, 'oracle_layer_1_math.matchup', 'B4 evidence[0]')
  eq(ev.evidence_used[1].name, 'oracle_layer_2_path.result',  'B4 evidence[1]')

  // B5 emit_trace=true without trace stub throws
  let threw = false
  try { await trustRun(env, pathR, { ...baseCtx, decision_id: 'b5', emit_trace: true }) } catch { threw = true }
  ok(threw, 'B5 throws when emit_trace=true and trace missing')

  // B6 ctx validation
  for (const [missing, badCtx] of [
    ['decision_id', { ...baseCtx, decision_id: '' }],
    ['strike',      { ...baseCtx, strike: 'six' }],
    ['side',        { ...baseCtx, side: 'X' }],
  ]) {
    let t = false; try { await trustRun(env, pathR, badCtx) } catch { t = true }
    ok(t, `B6 throws when ctx.${missing} invalid`)
  }
}

// ════════════════════════════════════════════════════════════════════
// Suite C — full pipeline smoke (L1 → L2 → L3)
// ════════════════════════════════════════════════════════════════════
async function runSuiteC() {
  section('Suite C — full pipeline smoke')
  const l1 = JSON.parse(await readFile(L1_FIXTURES_PATH, 'utf-8'))
  const archetypes = [...new Set(l1.fixtures.map(f => f.archetype))]
  const captured = []
  const traceStub = { writeAsync: (ev) => captured.push(ev) }
  let total = 0
  for (const arch of archetypes) {
    const f1 = l1.fixtures.find(f => f.archetype === arch)
    const oc = f1.expected_outer_chain_from_production
    const env = computeMatchup(f1.inputs, {
      split_adj: oc.split_adj, opp_adj: oc.opp_adj, park_factor: oc.park_factor,
      weather_mult: oc.weather_mult, ump_factor: oc.ump_factor,
    })
    for (const strike of STRIKES_DEFAULT) {
      for (const side of ['YES', 'NO']) {
        const ctx = {
          decision_id: `pipe-${arch}-${strike}-${side}`,
          pitcher_id: f1.pitcher_id, pitcher_name: f1.pitcher_name,
          bet_date: f1.bet_date, strike, side,
          emit_trace: true, trace: traceStub,
        }
        const pathR = await pathRun(env, ctx)
        const trustR = await trustRun(env, pathR, ctx)
        total++
        ok(trustR.matchup_output_hash === env.output_hash, `C ${arch} ${strike}${side}: matchup linked`)
        ok(trustR.path_output_hash === pathR.output_hash,  `C ${arch} ${strike}${side}: path linked`)
        ok(['high','medium','low'].includes(trustR.trust_level), `C ${arch} ${strike}${side}: trust_level valid`)
        // Trust score consistency: dead → 0; non-dead → > 0
        if (pathR.feasibility === 'dead') {
          eq(trustR.trust_score, 0, `C ${arch} ${strike}${side}: dead → trust_score=0`)
        } else {
          ok(trustR.trust_score > 0, `C ${arch} ${strike}${side}: non-dead → trust_score>0`)
        }
      }
    }
  }
  ok(total === archetypes.length * 20, `C total calls = ${archetypes.length * 20}`)
  // Each pipeline call produced 2 trace events (L2 + L3)
  ok(captured.length === total * 2, `C trace events captured = ${total*2}`)
  let traceErrs = 0
  for (const ev of captured) { try { validateTraceEvent(ev) } catch { traceErrs++ } }
  eq(traceErrs, 0, `C all ${captured.length} events validate`)
}

// ════════════════════════════════════════════════════════════════════
// Suite D — pure helper unit branches
// ════════════════════════════════════════════════════════════════════
function runSuiteD() {
  section('Suite D — pure helper unit branches')

  // parseConfidence
  eq(parseConfidence('high(career+savant+l5)'), 'high',   'parseConfidence high(...)')
  eq(parseConfidence('medium(savant+l5)'),      'medium', 'parseConfidence medium(...)')
  eq(parseConfidence('low(l5)'),                'low',    'parseConfidence low(...)')
  eq(parseConfidence(null),                     'unknown','parseConfidence null')
  eq(parseConfidence(''),                       'unknown','parseConfidence empty')
  eq(parseConfidence('weird'),                  'unknown','parseConfidence unrecognized')
  eq(parseConfidence('HIGH(...)'),              'high',   'parseConfidence case-insensitive')

  // trustLevelForScore
  eq(trustLevelForScore(0.85), 'high',   'trustLevelForScore 0.85')
  eq(trustLevelForScore(TRUST_HIGH_MIN), 'high',   'trustLevelForScore at high min')
  eq(trustLevelForScore(TRUST_HIGH_MIN - 1e-9), 'medium', 'trustLevelForScore just below')
  eq(trustLevelForScore(TRUST_MEDIUM_MIN), 'medium', 'trustLevelForScore at medium min')
  eq(trustLevelForScore(TRUST_MEDIUM_MIN - 1e-9), 'low', 'trustLevelForScore just below')
  eq(trustLevelForScore(0), 'low', 'trustLevelForScore zero')

  // Throw cases
  throws(() => scoreTrust({ feasibility: 'X', bf_source_tier: 'strong', confidence: 'high' }), 'scoreTrust throws on bad feasibility')
  throws(() => scoreTrust({ feasibility: 'strong', bf_source_tier: 'X', confidence: 'high' }), 'scoreTrust throws on bad bf_source_tier')
  throws(() => scoreTrust({ feasibility: 'strong', bf_source_tier: 'strong', confidence: 'X' }), 'scoreTrust throws on bad confidence')
  throws(() => scoreTrust(null), 'scoreTrust throws on null')

  // dead-feasibility forces 0
  const dead = scoreTrust({ feasibility: 'dead', bf_source_tier: 'strong', confidence: 'high' })
  eq(dead.trust_score, 0, 'dead → trust_score=0')
  eq(dead.trust_level, 'low', 'dead → trust_level=low')
  eq(dead.reason_code, 'feasibility_dead', 'dead → primary=feasibility_dead')

  // strong/strong/high → max trust
  const top = scoreTrust({ feasibility: 'strong', bf_source_tier: 'strong', confidence: 'high' })
  approxEq(top.trust_score, 1.0, 1e-12, 'top trust = 1.0')
  eq(top.trust_level, 'high', 'top trust → high')
  eq(top.reason_code, 'high_trust', 'top trust → high_trust reason')

  // weak source with DK protection
  const weakDk = scoreTrust({ feasibility: 'strong', bf_source_tier: 'weak', confidence: 'high', dk_blend_applied: true })
  approxEq(weakDk.bf_source_factor, BF_SOURCE_FACTOR_DK.weak, 1e-12, 'weak source w/ DK → 0.85 factor')
  ok(weakDk.reason_codes.includes('bf_source_weak_dk_protected'), 'weak source w/ DK → reason includes protected')

  // weak source without DK
  const weakNoDk = scoreTrust({ feasibility: 'strong', bf_source_tier: 'weak', confidence: 'high' })
  approxEq(weakNoDk.bf_source_factor, BF_SOURCE_FACTOR_NO_DK.weak, 1e-12, 'weak source no DK → 0.60 factor')
  ok(weakNoDk.reason_codes.includes('bf_source_weak'), 'weak source no DK → reason')

  // Constants frozen
  ok(Object.isFrozen(TRUST_LEVELS), 'TRUST_LEVELS frozen')
  ok(Object.isFrozen(REASON_CODES), 'REASON_CODES frozen')
  ok(Object.isFrozen(FEASIBILITY_FACTOR), 'FEASIBILITY_FACTOR frozen')
  ok(Object.isFrozen(BF_SOURCE_FACTOR_NO_DK), 'BF_SOURCE_FACTOR_NO_DK frozen')
  ok(Object.isFrozen(BF_SOURCE_FACTOR_DK), 'BF_SOURCE_FACTOR_DK frozen')
  ok(Object.isFrozen(CONFIDENCE_FACTOR), 'CONFIDENCE_FACTOR frozen')
}

// ─── main ─────────────────────────────────────────────────────────
await runSuiteA()
await runSuiteB()
await runSuiteC()
runSuiteD()

console.log(`\n═══════════════════════════════════════════`)
console.log(`  ${_passed} passed, ${_failed} failed`)
console.log('═══════════════════════════════════════════')
process.exit(_failed > 0 ? 1 : 0)
