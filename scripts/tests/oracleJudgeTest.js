// scripts/tests/oracleJudgeTest.js
//
// Layer 5 (Judge) v0.1 unit + integration test.

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import url from 'node:url'

import { computeMatchup, STRIKES_DEFAULT } from '../../oracle/layers/1-math/impl.js'
import { run as pathRun } from '../../oracle/layers/2-path/impl.js'
import { run as trustRun } from '../../oracle/layers/3-trust/impl.js'
import {
  run as judgeRun, DECISIONS, REASON_CODES, SCHEMA_VERSION, LAYER_VERSION, SOURCE,
} from '../../oracle/layers/5-judge/impl.js'
import { validateTraceEvent } from '../../oracle/layers/0-trace/validate.js'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const L1_FIXTURES_PATH = path.resolve(__dirname, '../../oracle/layers/1-math/parity-fixtures.json')

let _passed = 0, _failed = 0
const ok = (c, l) => c ? _passed++ : (_failed++, console.error(`FAIL [${l}]`))
const eq = (a, b, l) => {
  if (a === b) { _passed++; return }
  if (a == null && b == null) { _passed++; return }
  _failed++; console.error(`FAIL [${l}]: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`)
}
const approxEq = (a, b, tol, l) => {
  if (Math.abs(a - b) <= tol) { _passed++; return }
  _failed++; console.error(`FAIL [${l}]: ${a} !~= ${b}`)
}
const throws = async (fn, l) => {
  let t = false; try { await fn() } catch { t = true }
  ok(t, l)
}
const section = (n) => console.log(`\n── ${n} ──`)

console.log('═══════════════════════════════════════════')
console.log('  Layer 5 (Judge) — v0.1 Test')
console.log('═══════════════════════════════════════════')

const l1 = JSON.parse(await readFile(L1_FIXTURES_PATH, 'utf-8'))
const f1 = l1.fixtures[0]
const oc = f1.expected_outer_chain_from_production
const env = computeMatchup(f1.inputs, {
  split_adj: oc.split_adj, opp_adj: oc.opp_adj, park_factor: oc.park_factor,
  weather_mult: oc.weather_mult, ump_factor: oc.ump_factor,
})

const baseCtx = {
  decision_id: 'judge-test', strike: 6, side: 'YES',
  pitcher_id: f1.pitcher_id, pitcher_name: f1.pitcher_name, bet_date: f1.bet_date,
  market_mid: 0.50, spread: 0.02, bankroll: 1000,
}

const pathR  = await pathRun(env, baseCtx)
const trustR = await trustRun(env, pathR, baseCtx)

// ─── Section A — Decision branches ──────────────────────────────────
section('A — decision branches')
{
  // A1: feasibility=dead → skip
  const fakeDeadPath  = { ...pathR, feasibility: 'dead' }
  const fakeDeadTrust = { ...trustR, trust_score: 0, trust_level: 'low' }
  const r = await judgeRun(env, fakeDeadPath, fakeDeadTrust, baseCtx)
  eq(r.decision, 'skip', 'A1 dead → skip')
  eq(r.reason_code, REASON_CODES.FEASIBILITY_DEAD, 'A1 reason=feasibility_dead')
  eq(r.size_usd, 0, 'A1 size=0')

  // A2: trust_score=0 (non-dead path) → skip
  const fakeTrustZero = { ...trustR, trust_score: 0, trust_level: 'low' }
  const r2 = await judgeRun(env, pathR, fakeTrustZero, baseCtx)
  // depending on path feasibility this may hit feasibility_dead or trust_zero;
  // accept either if pathR.feasibility was already dead
  if (pathR.feasibility === 'dead') {
    eq(r2.reason_code, REASON_CODES.FEASIBILITY_DEAD, 'A2 dead path takes precedence')
  } else {
    eq(r2.reason_code, REASON_CODES.TRUST_ZERO, 'A2 trust_zero')
  }
  eq(r2.decision, 'skip', 'A2 → skip')

  // A3: insufficient edge
  const r3 = await judgeRun(env, pathR, trustR, { ...baseCtx, market_mid: 0.99 })
  eq(r3.decision, 'skip',                            'A3 high market_mid → skip')
  eq(r3.reason_code, REASON_CODES.INSUFFICIENT_EDGE, 'A3 insufficient_edge')

  // A4: fire when everything good (synthetic fakes for control)
  const fakeStrongPath  = { ...pathR, feasibility: 'strong', bf_source_tier: 'strong' }
  const fakeHighTrust   = { ...trustR, trust_score: 1.0, trust_level: 'high' }
  const fakeEnv4        = { ...env, prob_at_least: { ...env.prob_at_least, '6': 0.70 } }
  // edge = 0.70 - 0.50 = 0.20 > 0.12 (threshold) → fire
  const r4 = await judgeRun(fakeEnv4, fakeStrongPath, fakeHighTrust, { ...baseCtx, market_mid: 0.50 })
  eq(r4.decision, 'fire',       'A4 strong+high+edge → fire')
  eq(r4.reason_code, REASON_CODES.FIRE, 'A4 reason=fire')
  ok(r4.size_usd > 0, 'A4 fire → size_usd > 0')

  // A5: fragile feasibility → size_down (with sufficient edge)
  const fakeFragilePath = { ...pathR, feasibility: 'fragile', bf_source_tier: 'strong' }
  const r5 = await judgeRun(fakeEnv4, fakeFragilePath, fakeHighTrust, { ...baseCtx, market_mid: 0.50 })
  eq(r5.decision, 'size_down',                              'A5 fragile (with edge) → size_down')
  eq(r5.reason_code, REASON_CODES.FRAGILE_SIZE_DOWN,        'A5 reason=fragile_size_down')

  // A6: low trust → size_down
  const fakeLowTrust = { ...trustR, trust_score: 0.30, trust_level: 'low' }
  const r6 = await judgeRun(fakeEnv4, fakeStrongPath, fakeLowTrust, { ...baseCtx, market_mid: 0.50 })
  eq(r6.decision, 'size_down',                       'A6 low trust → size_down')
  eq(r6.reason_code, REASON_CODES.LOW_TRUST_SIZE_DOWN, 'A6 reason=low_trust_size_down')
}

// ─── Section B — envelope shape + Trace ─────────────────────────────
section('B — envelope shape + Trace')
{
  const r = await judgeRun(env, pathR, trustR, baseCtx)
  eq(r.schema_version, SCHEMA_VERSION,  'B1 schema_version')
  eq(r.layer,          'judge',         'B1 layer')
  eq(r.layer_version,  LAYER_VERSION,   'B1 layer_version')
  eq(r.source,         SOURCE,          'B1 source')
  eq(r.matchup_output_hash, env.output_hash, 'B1 matchup hash linked')
  eq(r.path_output_hash,    pathR.output_hash, 'B1 path hash linked')
  eq(r.trust_output_hash,   trustR.output_hash, 'B1 trust hash linked')
  ok(['fire','skip','size_down'].includes(r.decision), 'B1 decision valid')

  // size_usd is finite, non-negative
  ok(Number.isFinite(r.size_usd) && r.size_usd >= 0, 'B1 size_usd valid')
  ok(r.size_usd <= 200, 'B1 size_usd respects max_size_usd default')

  // Trace event
  const captured = []
  const traceStub = { writeAsync: (ev) => captured.push(ev) }
  await judgeRun(env, pathR, trustR, { ...baseCtx, decision_id: 'judge-trace', emit_trace: true, trace: traceStub })
  eq(captured.length, 1, 'B2 single trace event')
  let validateThrew = null
  try { validateTraceEvent(captured[0]) } catch (err) { validateThrew = err.message }
  eq(validateThrew, null, 'B2 validateTraceEvent passes')
  eq(captured[0].layer_name, 'judge', 'B2 event.layer_name')
  ok(['fire','skip','size_down'].includes(captured[0].decision), 'B2 event.decision valid')
  eq(captured[0].evidence_used.length, 3, 'B2 evidence has 3 entries (L1+L2+L3)')

  // emit_trace without trace stub throws
  await throws(
    () => judgeRun(env, pathR, trustR, { ...baseCtx, decision_id: 'b3', emit_trace: true }),
    'B3 emit_trace=true without trace stub throws',
  )

  // ctx validation
  await throws(
    () => judgeRun(env, pathR, trustR, { ...baseCtx, market_mid: 1.5 }),
    'B4 throws on market_mid > 1',
  )
  await throws(
    () => judgeRun(env, pathR, trustR, { ...baseCtx, bankroll: -1 }),
    'B5 throws on negative bankroll',
  )
}

// ─── Section C — Kelly math sanity ──────────────────────────────────
section('C — Kelly math sanity')
{
  // Build a clean scenario where prob_side is computable
  const p = 0.60, m = 0.50, b = (1 - m) / m
  const expectedKelly = (p * b - (1 - p)) / b      // 0.20

  // Construct fakes: feasibility=strong, trust_score=1, prob=0.60 at strike
  // To get prob=0.60 we'll just override yesAtStrike for the test
  const fakeEnv = {
    ...env,
    prob_at_least: { ...env.prob_at_least, '6': p },
  }
  const fakePath  = { ...pathR, feasibility: 'strong' }
  const fakeTrust = { ...trustR, trust_score: 1.0, trust_level: 'high' }
  const r = await judgeRun(fakeEnv, fakePath, fakeTrust, {
    ...baseCtx, market_mid: m, spread: null, bankroll: 1000,
  })
  approxEq(r.kelly_raw, expectedKelly, 1e-9, 'C kelly_raw matches formula')
  approxEq(r.kelly_eff, expectedKelly * 1.0 * 1.0 * 1.0, 1e-9, 'C kelly_eff = raw × mult × trust × side_factor')
}

// ─── Section D — Judge v0.2 Critic ladder ───────────────────────
section('D — Judge v0.2 Critic ladder')

// Helper: build a fake critic result with the given verdict
function fakeCritic(verdict, extras = {}) {
  return {
    verdict,
    confidence: 'medium',
    concerns: extras.concerns ?? [],
    output_hash: 'a'.repeat(64),
    inputs_hash: 'b'.repeat(64),
    ...extras,
  }
}

// Use the synthetic fakes from Section A — they're known-controllable
const fakeStrongPath  = { ...pathR, feasibility: 'strong', bf_source_tier: 'strong' }
const fakeViablePath  = { ...pathR, feasibility: 'viable', bf_source_tier: 'strong' }
const fakeFragilePath = { ...pathR, feasibility: 'fragile', bf_source_tier: 'strong' }
const fakeHighTrust   = { ...trustR, trust_score: 1.0, trust_level: 'high' }
const fakeLowTrust    = { ...trustR, trust_score: 0.30, trust_level: 'low' }
const fakeMidTrust    = { ...trustR, trust_score: 0.60, trust_level: 'medium' }
const fakeEnvFire     = { ...env, prob_at_least: { ...env.prob_at_least, '6': 0.70 } }
const baseFireCtx = { ...baseCtx, market_mid: 0.50, spread: 0.02, bankroll: 1000 }

// D1 — Critic skip overrides fire
{
  const r = await judgeRun(fakeEnvFire, fakeStrongPath, fakeHighTrust, {
    ...baseFireCtx, criticResult: fakeCritic('skip'),
  })
  eq(r.decision, 'skip', 'D1 critic skip → decision=skip')
  eq(r.reason_code, REASON_CODES.CRITIC_SKIP, 'D1 reason=critic_skip')
  eq(r.baseline_decision, 'fire', 'D1 baseline was fire')
  ok(r.critic_applied.includes('skip'), 'D1 critic_applied has skip')
}

// D2 — Critic skip on already-skip is redundant (no change)
{
  const skipBaseCtx = { ...baseFireCtx, market_mid: 0.95 }  // edge insufficient → baseline skip
  const r = await judgeRun(fakeEnvFire, fakeStrongPath, fakeHighTrust, {
    ...skipBaseCtx, criticResult: fakeCritic('skip'),
  })
  eq(r.decision, 'skip', 'D2 already skip stays skip')
  eq(r.baseline_decision, 'skip', 'D2 baseline was skip')
  // reason_code stays as the baseline reason since critic_skip is redundant
  eq(r.reason_code, REASON_CODES.INSUFFICIENT_EDGE, 'D2 baseline reason preserved')
  ok(r.critic_applied.includes('skip_redundant'), 'D2 critic_applied=skip_redundant')
}

// D3 — Critic concern downgrades fire → size_down
{
  const r = await judgeRun(fakeEnvFire, fakeStrongPath, fakeHighTrust, {
    ...baseFireCtx, criticResult: fakeCritic('concern'),
  })
  eq(r.decision, 'size_down', 'D3 concern → size_down')
  eq(r.reason_code, REASON_CODES.CRITIC_CONCERN_DOWNGRADE, 'D3 reason=critic_concern_downgrade')
  eq(r.baseline_decision, 'fire', 'D3 baseline was fire')
}

// D4 — Critic concern on size_down is no-op
{
  const r = await judgeRun(fakeEnvFire, fakeFragilePath, fakeHighTrust, {
    ...baseFireCtx, criticResult: fakeCritic('concern'),
  })
  eq(r.decision, 'size_down', 'D4 already size_down stays size_down')
  eq(r.baseline_decision, 'size_down', 'D4 baseline was size_down')
  eq(r.reason_code, REASON_CODES.FRAGILE_SIZE_DOWN, 'D4 baseline reason preserved')
  ok(r.critic_applied.includes('no_change'), 'D4 critic_applied=no_change')
}

// D5 — Critic proceed is no-op
{
  const r = await judgeRun(fakeEnvFire, fakeStrongPath, fakeHighTrust, {
    ...baseFireCtx, criticResult: fakeCritic('proceed'),
  })
  eq(r.decision, 'fire', 'D5 proceed → unchanged fire')
  eq(r.reason_code, REASON_CODES.FIRE, 'D5 reason=fire')
}

// D6 — Boost upgrades size_down → fire (when caused by LOW_TRUST)
{
  // Low trust path causes baseline=size_down with reason=LOW_TRUST_SIZE_DOWN.
  // Boost should upgrade to fire because trust_score=0.60 ≥ 0.50, edge OK,
  // not fragile, baseline reason was low_trust.
  const r = await judgeRun(fakeEnvFire, fakeStrongPath, fakeMidTrust, {
    ...baseFireCtx, criticResult: fakeCritic('boost'),
  })
  // mid trust still size_down? Need trust_level='low' for size_down. trust_level='medium' fires.
  // So this is actually fire baseline. Boost no-op.
  ok(['fire', 'size_down'].includes(r.baseline_decision), 'D6 baseline computed')
  if (r.baseline_decision === 'size_down') {
    eq(r.decision, 'fire', 'D6 boost upgraded')
    eq(r.reason_code, REASON_CODES.CRITIC_BOOST, 'D6 reason=critic_boost')
  }
}

// D6b — Boost actually fires on low_trust size_down (force baseline)
{
  // trust_level='low' causes LOW_TRUST_SIZE_DOWN with trust_score=0.55 (≥ 0.50)
  const fakeLowButBoostable = { ...trustR, trust_score: 0.55, trust_level: 'low' }
  const r = await judgeRun(fakeEnvFire, fakeStrongPath, fakeLowButBoostable, {
    ...baseFireCtx, criticResult: fakeCritic('boost'),
  })
  eq(r.baseline_decision, 'size_down',           'D6b baseline=size_down (low trust)')
  eq(r.baseline_reason, REASON_CODES.LOW_TRUST_SIZE_DOWN, 'D6b baseline reason=low_trust_size_down')
  eq(r.decision, 'fire',                          'D6b boost upgraded → fire')
  eq(r.reason_code, REASON_CODES.CRITIC_BOOST,    'D6b reason=critic_boost')
  ok(r.critic_applied.includes('boost'), 'D6b critic_applied=boost')
}

// D7 — Boost blocked by fragile baseline
{
  const r = await judgeRun(fakeEnvFire, fakeFragilePath, fakeHighTrust, {
    ...baseFireCtx, criticResult: fakeCritic('boost'),
  })
  eq(r.baseline_decision, 'size_down', 'D7 fragile path baseline=size_down')
  eq(r.decision, 'size_down',           'D7 fragile path → boost blocked, stays size_down')
  eq(r.reason_code, REASON_CODES.FRAGILE_SIZE_DOWN, 'D7 baseline reason preserved')
  ok(r.critic_applied.some(c => c === 'boost_blocked_fragile' || c === 'boost_blocked_fragile_size_down'),
    'D7 boost_blocked logged')
}

// D8 — Boost blocked by low trust score (< 0.50)
{
  const fakeVeryLowTrust = { ...trustR, trust_score: 0.30, trust_level: 'low' }
  const r = await judgeRun(fakeEnvFire, fakeStrongPath, fakeVeryLowTrust, {
    ...baseFireCtx, criticResult: fakeCritic('boost'),
  })
  eq(r.baseline_decision, 'size_down', 'D8 baseline=size_down (low trust)')
  eq(r.decision, 'size_down',           'D8 boost blocked → stays size_down')
  ok(r.critic_applied.includes('boost_blocked_low_trust'), 'D8 boost_blocked_low_trust logged')
}

// D9 — Boost cannot upgrade skip
{
  const skipCtx = { ...baseFireCtx, market_mid: 0.95 }  // insufficient edge
  const r = await judgeRun(fakeEnvFire, fakeStrongPath, fakeHighTrust, {
    ...skipCtx, criticResult: fakeCritic('boost'),
  })
  eq(r.baseline_decision, 'skip', 'D9 baseline=skip (insufficient edge)')
  eq(r.decision, 'skip',           'D9 skip stays skip even with boost')
  ok(r.critic_applied.includes('boost_blocked_skip_floor'), 'D9 boost_blocked_skip_floor logged')
}

// D10 — Boost on already-fire is no-op (no benefit)
{
  const r = await judgeRun(fakeEnvFire, fakeStrongPath, fakeHighTrust, {
    ...baseFireCtx, criticResult: fakeCritic('boost'),
  })
  eq(r.baseline_decision, 'fire', 'D10 baseline=fire')
  eq(r.decision, 'fire',           'D10 stays fire')
  ok(r.critic_applied.includes('no_change'), 'D10 boost on fire = no_change')
}

// D11 — No criticResult → behaves like v0.1 (back-compat)
{
  const r = await judgeRun(fakeEnvFire, fakeStrongPath, fakeHighTrust, baseFireCtx)
  eq(r.decision, 'fire', 'D11 no critic → fire')
  eq(r.reason_code, REASON_CODES.FIRE, 'D11 reason=fire')
  eq(r.critic_verdict, null, 'D11 critic_verdict=null')
  eq(r.critic_applied.length, 0, 'D11 critic_applied empty')
  eq(r.critic_output_hash, null, 'D11 critic_output_hash=null')
}

// D12 — Critic hash propagates into Judge envelope
{
  const r = await judgeRun(fakeEnvFire, fakeStrongPath, fakeHighTrust, {
    ...baseFireCtx, criticResult: fakeCritic('proceed'),
  })
  eq(r.critic_output_hash, 'a'.repeat(64), 'D12 critic_output_hash linked')
}

// D13 — Trace event reflects critic info
{
  const captured = []
  const traceStub = { writeAsync: (ev) => captured.push(ev) }
  await judgeRun(fakeEnvFire, fakeStrongPath, fakeHighTrust, {
    ...baseFireCtx, criticResult: fakeCritic('concern'),
    decision_id: 'd13', emit_trace: true, trace: traceStub,
  })
  eq(captured.length, 1, 'D13 trace event emitted')
  let validateThrew = null
  try { validateTraceEvent(captured[0]) } catch (e) { validateThrew = e.message }
  eq(validateThrew, null, 'D13 validateTraceEvent passes')
  eq(captured[0].decision, 'size_down', 'D13 event decision=size_down (after critic)')
  eq(captured[0].reasoning.critic_verdict, 'concern', 'D13 reasoning.critic_verdict')
  eq(captured[0].reasoning.baseline_decision, 'fire', 'D13 reasoning.baseline_decision')
  // evidence_used has 4 entries (L1+L2+L3+L4)
  eq(captured[0].evidence_used.length, 4, 'D13 evidence has 4 entries (incl. critic)')
  eq(captured[0].evidence_used[3].name, 'oracle_layer_4_critic.result', 'D13 critic evidence linked')
}

console.log(`\n═══════════════════════════════════════════`)
console.log(`  ${_passed} passed, ${_failed} failed`)
console.log('═══════════════════════════════════════════')
process.exit(_failed > 0 ? 1 : 0)
