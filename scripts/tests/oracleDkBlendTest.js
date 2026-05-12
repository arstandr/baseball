// scripts/tests/oracleDkBlendTest.js
//
// Bite 6.1 — unit tests for oracle/layers/1-math/dkBlend.js.
//
// Pure-function tests only. No DB, no fixture files, no Layer 1
// integration. Runs standalone:
//   node scripts/tests/oracleDkBlendTest.js

import {
  invertLambda,
  dkLineToK,
  bfSourceTier,
  classifyThinness,
  wDkForClass,
  blendBF,
  BF_SOURCE_TIERS,
  THINNESS_CLASSES,
  DEFAULT_W_DK_SCHEDULE,
  SKIP_REASONS,
  DEFAULT_BF_CAP_K,
  HELPER_NAME,
  HELPER_VERSION,
} from '../../oracle/layers/1-math/dkBlend.js'
import { pAtLeast, NB_R } from '../../lib/strikeout-model.js'

// ─── Test infra (mirrors oracleMathParityTest.js) ──────────────────────
let _passed = 0, _failed = 0
const ok  = (c, l) => c ? _passed++ : (_failed++, console.error(`FAIL [${l}]`))
const eq  = (a, b, l) => {
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
    else { _failed++; console.error(`FAIL [${l}]: non-finite mismatch (${a} vs ${b})`) }
    return
  }
  if (Math.abs(a - b) <= tol) { _passed++; return }
  _failed++; console.error(`FAIL [${l}]: ${a} !~= ${b} abs_diff=${Math.abs(a - b)} tol=${tol}`)
}
const throws = (fn, l) => {
  let threw = false
  try { fn() } catch { threw = true }
  ok(threw, l)
}
const section = n => console.log(`\n── ${n} ──`)

console.log('═══════════════════════════════════════════')
console.log('  Layer 1 Math — DK Blend Helper (Bite 6.1)')
console.log('═══════════════════════════════════════════')

// ════════════════════════════════════════════════════════════════════════
// 1. invertLambda
// ════════════════════════════════════════════════════════════════════════
section('invertLambda — round-trip + edge cases')
{
  // Round-trip: pick known λ + n + r, compute prob, invert, recover λ.
  for (const lam of [3.5, 5.0, 6.5, 8.2, 10.1]) {
    for (const n of [5, 7, 8, 9]) {
      for (const r of [20, 30, 50]) {
        const p = pAtLeast(lam, n, r)
        if (p < 0.005 || p > 0.995) continue   // skip extremes
        const recovered = invertLambda(p, n, r)
        approxEq(recovered, lam, 0.05,
          `roundtrip λ=${lam} n=${n} r=${r} → p=${p.toFixed(4)} → λ=${recovered.toFixed(3)}`)
      }
    }
  }

  // Extremes clamp to 999 / 0
  eq(invertLambda(0.9999, 8, 30), 999, 'invertLambda clamps high → 999')
  eq(invertLambda(0.0001, 8, 30), 0,   'invertLambda clamps low → 0')

  // Default r argument (NB_R)
  const lam5 = 5.0, n = 7
  const pDefault = pAtLeast(lam5, n, NB_R)
  approxEq(invertLambda(pDefault, n), lam5, 0.05, 'invertLambda uses NB_R when r omitted')

  // Throws on bad inputs
  throws(() => invertLambda(NaN, 8, 30),  'invertLambda throws on NaN targetProb')
  throws(() => invertLambda(0.5, 1.5, 30), 'invertLambda throws on non-integer n')
  throws(() => invertLambda(0.5, -1, 30),  'invertLambda throws on negative n')
  throws(() => invertLambda(0.5, 8, 0),    'invertLambda throws on r=0')
  throws(() => invertLambda(0.5, 8, -1),   'invertLambda throws on r<0')
}

// ════════════════════════════════════════════════════════════════════════
// 2. dkLineToK
// ════════════════════════════════════════════════════════════════════════
section('dkLineToK — line → K threshold')
{
  eq(dkLineToK(7.5),  8, 'line 7.5 → 8')
  eq(dkLineToK(7.0),  8, 'line 7.0 → 8 (push convention)')
  eq(dkLineToK(0.5),  1, 'line 0.5 → 1')
  eq(dkLineToK(0.0),  1, 'line 0   → 1')
  eq(dkLineToK(10.5), 11, 'line 10.5 → 11')
  eq(dkLineToK(12.0), 13, 'line 12   → 13')
  throws(() => dkLineToK(-1),     'throws on negative line')
  throws(() => dkLineToK(NaN),    'throws on NaN line')
  throws(() => dkLineToK(undefined), 'throws on undefined line')
}

// ════════════════════════════════════════════════════════════════════════
// 3. bfSourceTier
// ════════════════════════════════════════════════════════════════════════
section('bfSourceTier — strong / medium / weak / unknown')
{
  // strong (BF×N family, including modifier suffixes)
  eq(bfSourceTier('BF×5'),                                 'strong', 'BF×5 → strong')
  eq(bfSourceTier('BF×5(92pc)'),                           'strong', 'BF×5(92pc) → strong')
  eq(bfSourceTier('BF×3(78pc)→capped(20.5BF)'),           'strong', 'capped modifier preserves strong')
  eq(bfSourceTier('BF×5(92pc)×leash(0.85)'),              'strong', 'leash modifier preserves strong')
  eq(bfSourceTier('BF×5(92pc)→capped(20.5BF)×leash(0.85)'),'strong', 'both modifiers preserve strong')

  // medium (logBF×N)
  eq(bfSourceTier('logBF×3'),    'medium', 'logBF×3 → medium')
  eq(bfSourceTier('logBF×4×leash(0.90)'), 'medium', 'logBF with leash modifier → medium')

  // weak (ip×PA/IP, career_ip×PA/IP)
  eq(bfSourceTier('ip×PA/IP'),                'weak', 'ip×PA/IP → weak')
  eq(bfSourceTier('ip×PA/IP×leash(0.90)'),   'weak', 'ip×PA/IP+leash → weak')
  eq(bfSourceTier('career_ip×PA/IP'),         'weak', 'career_ip×PA/IP → weak')
  eq(bfSourceTier('career_ip×PA/IP×leash(0.85)'), 'weak', 'career_ip+leash → weak')

  // unknown
  eq(bfSourceTier(null),             'unknown', 'null → unknown')
  eq(bfSourceTier(undefined),        'unknown', 'undefined → unknown')
  eq(bfSourceTier(''),               'unknown', 'empty string → unknown')
  eq(bfSourceTier('something_new'),  'unknown', 'unrecognized prefix → unknown')
  eq(bfSourceTier(42),               'unknown', 'non-string → unknown')

  // Constants
  ok(Object.isFrozen(BF_SOURCE_TIERS), 'BF_SOURCE_TIERS frozen')
  eq(BF_SOURCE_TIERS.STRONG,  'strong',  'BF_SOURCE_TIERS.STRONG')
  eq(BF_SOURCE_TIERS.MEDIUM,  'medium',  'BF_SOURCE_TIERS.MEDIUM')
  eq(BF_SOURCE_TIERS.WEAK,    'weak',    'BF_SOURCE_TIERS.WEAK')
  eq(BF_SOURCE_TIERS.UNKNOWN, 'unknown', 'BF_SOURCE_TIERS.UNKNOWN')
}

// ════════════════════════════════════════════════════════════════════════
// 4. classifyThinness
// ════════════════════════════════════════════════════════════════════════
section('classifyThinness — every branch + edge cases')
{
  // THIN — savant null
  eq(classifyThinness({ bfSource: 'BF×5', nStarts: 5 }, null),
     'thin', 'savant null → thin')

  // THIN — savant.ip < 5
  eq(classifyThinness({ bfSource: 'BF×5', nStarts: 5 },
       { ip: 4.9, k_pct: 0.25 }),
     'thin', 'savant.ip < 5 → thin')

  // THIN — nStarts < 3
  eq(classifyThinness({ bfSource: 'BF×5', nStarts: 2 },
       { ip: 32, k_pct: 0.25 }),
     'thin', 'nStarts < 3 → thin')

  // THIN — leash < 0.95
  eq(classifyThinness({ bfSource: 'BF×5', nStarts: 5 },
       { ip: 32, k_pct: 0.25, manager_leash_factor: 0.85 }),
     'thin', 'leash < 0.95 → thin')

  // THIN — bfSourceTier === weak
  eq(classifyThinness({ bfSource: 'ip×PA/IP', nStarts: 5 },
       { ip: 32, k_pct: 0.25 }),
     'thin', 'weak BF source → thin')
  eq(classifyThinness({ bfSource: 'career_ip×PA/IP', nStarts: 5 },
       { ip: 32, k_pct: 0.25 }),
     'thin', 'career_ip BF source → thin')

  // STABLE — happy path
  eq(classifyThinness({ bfSource: 'BF×5(92pc)', nStarts: 5 },
       { ip: 32, k_pct: 0.25 }),
     'stable', 'savant.ip>=30 + nStarts>=5 + strong → stable')

  // STABLE — leash null (allowed)
  eq(classifyThinness({ bfSource: 'BF×5', nStarts: 6 },
       { ip: 40, k_pct: 0.27 }),
     'stable', 'leash null OK in stable')

  // STABLE — leash >= 0.95 (allowed)
  eq(classifyThinness({ bfSource: 'BF×5', nStarts: 6 },
       { ip: 40, k_pct: 0.27, manager_leash_factor: 0.95 }),
     'stable', 'leash exactly 0.95 → stable-eligible')
  eq(classifyThinness({ bfSource: 'BF×5', nStarts: 6 },
       { ip: 40, k_pct: 0.27, manager_leash_factor: 1.05 }),
     'stable', 'leash 1.05 → stable')

  // STABLE — ip exactly 30
  eq(classifyThinness({ bfSource: 'BF×5', nStarts: 5 },
       { ip: 30, k_pct: 0.25 }),
     'stable', 'savant.ip exactly 30 → stable-eligible')

  // MID — savant.ip in [5, 30) AND nStarts >= 3 AND strong
  eq(classifyThinness({ bfSource: 'BF×5', nStarts: 5 },
       { ip: 20, k_pct: 0.25 }),
     'mid', 'ip 20 (between 5 and 30) → mid')

  // MID — medium BF source disqualifies stable, no thin trigger
  eq(classifyThinness({ bfSource: 'logBF×3', nStarts: 5 },
       { ip: 32, k_pct: 0.25 }),
     'mid', 'logBF source → mid (not stable)')

  // MID — unknown BF source neither thin nor stable
  eq(classifyThinness({ bfSource: 'mystery_source', nStarts: 5 },
       { ip: 32, k_pct: 0.25 }),
     'mid', 'unknown BF source → mid (conservative default)')
  eq(classifyThinness({ bfSource: null, nStarts: 5 },
       { ip: 32, k_pct: 0.25 }),
     'mid', 'null BF source → mid')

  // Boundary: nStarts === 3 not thin, not stable on its own
  eq(classifyThinness({ bfSource: 'BF×3', nStarts: 3 },
       { ip: 32, k_pct: 0.25 }),
     'mid', 'nStarts exactly 3 + ip>=30 + strong → mid (need nStarts>=5 for stable)')

  // Constants
  ok(Object.isFrozen(THINNESS_CLASSES), 'THINNESS_CLASSES frozen')
  eq(THINNESS_CLASSES.THIN,   'thin',   'THIN')
  eq(THINNESS_CLASSES.MID,    'mid',    'MID')
  eq(THINNESS_CLASSES.STABLE, 'stable', 'STABLE')
}

// ════════════════════════════════════════════════════════════════════════
// 5. wDkForClass + DEFAULT_W_DK_SCHEDULE
// ════════════════════════════════════════════════════════════════════════
section('wDkForClass — default + override schedules')
{
  ok(Object.isFrozen(DEFAULT_W_DK_SCHEDULE), 'default schedule frozen')
  approxEq(DEFAULT_W_DK_SCHEDULE.thin,   0.20, 1e-12, 'default THIN=0.20')
  approxEq(DEFAULT_W_DK_SCHEDULE.mid,    0.05, 1e-12, 'default MID=0.05')
  approxEq(DEFAULT_W_DK_SCHEDULE.stable, 0.00, 1e-12, 'default STABLE=0.00')

  // Default schedule
  approxEq(wDkForClass('thin'),   0.20, 1e-12, 'wDkForClass(thin) default')
  approxEq(wDkForClass('mid'),    0.05, 1e-12, 'wDkForClass(mid) default')
  approxEq(wDkForClass('stable'), 0.00, 1e-12, 'wDkForClass(stable) default')

  // Unknown class → 0
  eq(wDkForClass('something_else'), 0, 'unknown class → 0')
  eq(wDkForClass(null),             0, 'null class → 0')
  eq(wDkForClass(undefined),        0, 'undefined class → 0')

  // Override schedule
  const sweep = { thin: 0.30, mid: 0.10, stable: 0.00 }
  approxEq(wDkForClass('thin', sweep), 0.30, 1e-12, 'override THIN=0.30')
  approxEq(wDkForClass('mid',  sweep), 0.10, 1e-12, 'override MID=0.10')

  // Schedule with bad value → 0
  eq(wDkForClass('thin', { thin: 'high' }), 0, 'non-numeric weight → 0')
  eq(wDkForClass('thin', { thin: -0.5 }),    0, 'negative weight → 0')
  eq(wDkForClass('thin', { thin:  1.5 }),    0, 'weight > 1 → 0')
  eq(wDkForClass('thin', null),               0, 'schedule=null → 0')
}

// ════════════════════════════════════════════════════════════════════════
// 6. blendBF
// ════════════════════════════════════════════════════════════════════════
section('blendBF — happy path, cap skip, identity, invalid inputs')

// Helper to build a baseline DK scenario (close enough to model that it
// passes the cap and yields a meaningful blend).
function scenario(overrides = {}) {
  return {
    expected_bf_ours: 22.0,
    pK_ours:          0.25,         // → λ_base_ours = 5.5
    dk_line:          5.5,          // P(K ≥ 6) = over_price
    over_price:       0.55,
    r:                30,
    klass:            'thin',
    ...overrides,
  }
}

// 6a. Happy path — THIN class with default w_dk=0.20
{
  const s = scenario()
  const result = blendBF(s)

  eq(result.applied, true, 'applied=true on happy thin path')
  eq(result.skip_reason, null, 'skip_reason=null when applied')
  approxEq(result.w_dk, 0.20, 1e-12, 'w_dk=0.20 for thin (default)')
  ok(Number.isFinite(result.dk_lambda) && result.dk_lambda > 0, 'dk_lambda finite > 0')
  ok(Number.isFinite(result.bf_dk)     && result.bf_dk > 0,     'bf_dk finite > 0')

  // Roundtrip check: dk_lambda should invert back to over_price (within tolerance)
  const recovered = pAtLeast(result.dk_lambda, dkLineToK(s.dk_line), s.r)
  approxEq(recovered, s.over_price, 0.005, 'dk_lambda inverts to over_price')

  // bf_dk = dk_lambda / pK_ours
  approxEq(result.bf_dk, result.dk_lambda / s.pK_ours, 1e-9, 'bf_dk = dk_lambda / pK_ours')

  // bf_delta = bf_dk - expected_bf_ours
  approxEq(result.bf_delta, result.bf_dk - s.expected_bf_ours, 1e-9, 'bf_delta is bf_dk - expected_bf_ours')

  // Blended formula
  const expectedBlended = (1 - 0.20) * s.expected_bf_ours + 0.20 * result.bf_dk
  approxEq(result.expected_bf_blended, expectedBlended, 1e-9, 'expected_bf_blended formula')
  approxEq(result.lambda_base_blended, expectedBlended * s.pK_ours, 1e-9, 'lambda_base_blended = blended_BF × pK_ours')
}

// 6b. Identity — w_dk=0 schedule produces no change (and skip_reason='zero_weight')
{
  const s = scenario({ schedule: { thin: 0, mid: 0, stable: 0 } })
  const result = blendBF(s)

  eq(result.applied, false, 'applied=false when w_dk=0')
  eq(result.skip_reason, 'zero_weight', 'skip_reason=zero_weight for thin with w=0')
  eq(result.expected_bf_blended, s.expected_bf_ours, 'expected_bf unchanged')
  approxEq(result.lambda_base_blended, s.expected_bf_ours * s.pK_ours, 1e-12, 'lambda_base unchanged')
  // counterfactual fields still populated
  ok(result.dk_lambda != null, 'dk_lambda populated even on skip')
  ok(result.bf_dk != null,     'bf_dk populated even on skip')
}

// 6c. STABLE class — defaults to w=0 with skip_reason='stable'
{
  const s = scenario({ klass: 'stable' })
  const result = blendBF(s)
  eq(result.applied, false, 'STABLE not applied')
  eq(result.skip_reason, 'stable', 'skip_reason=stable for stable class')
  eq(result.w_dk, 0, 'w_dk=0 for stable (default schedule)')
  ok(result.dk_lambda != null, 'dk_lambda populated even on STABLE skip')
}

// 6d. CAP skip — DK implies BF wildly different than ours
{
  // expected_bf_ours=22, very low over_price → very low λ_dk → BF_dk near 0 → bf_delta < -3
  const s = scenario({ expected_bf_ours: 22, over_price: 0.05, dk_line: 5.5 })
  const result = blendBF(s)
  eq(result.applied, false, 'cap blocks application')
  eq(result.skip_reason, 'cap', 'skip_reason=cap when |bf_delta| > bf_cap_K')
  ok(Math.abs(result.bf_delta) > DEFAULT_BF_CAP_K,
    `bf_delta exceeded cap (|${result.bf_delta?.toFixed(2)}| > ${DEFAULT_BF_CAP_K})`)
  // Not clipped — expected_bf_blended unchanged
  eq(result.expected_bf_blended, s.expected_bf_ours, 'expected_bf unchanged on cap skip')
  approxEq(result.lambda_base_blended, s.expected_bf_ours * s.pK_ours, 1e-12, 'lambda_base unchanged on cap skip')
}

// 6e. CAP override — larger cap allows the same scenario through
{
  const s = scenario({ expected_bf_ours: 22, over_price: 0.05, dk_line: 5.5, bf_cap_K: 50 })
  const result = blendBF(s)
  eq(result.applied, true, 'larger cap → applied')
  eq(result.skip_reason, null, 'no skip when cap relaxed')
}

// 6f. Missing DK data
{
  const r1 = blendBF(scenario({ dk_line: null }))
  eq(r1.applied, false, 'no dk_line → not applied')
  eq(r1.skip_reason, 'no_dk_line', 'skip_reason=no_dk_line')

  const r2 = blendBF(scenario({ dk_line: -1 }))
  eq(r2.applied, false, 'negative dk_line → not applied')
  eq(r2.skip_reason, 'no_dk_line', 'negative dk_line skip')

  const r3 = blendBF(scenario({ over_price: null }))
  eq(r3.applied, false, 'no over_price → not applied')
  eq(r3.skip_reason, 'no_over_price', 'skip_reason=no_over_price')

  const r4 = blendBF(scenario({ over_price: 0 }))
  eq(r4.skip_reason, 'no_over_price', 'over_price=0 → no_over_price')

  const r5 = blendBF(scenario({ over_price: 1 }))
  eq(r5.skip_reason, 'no_over_price', 'over_price=1 → no_over_price')

  const r6 = blendBF(scenario({ over_price: 1.5 }))
  eq(r6.skip_reason, 'no_over_price', 'over_price>1 → no_over_price')
}

// 6g. Invalid model inputs
{
  const r1 = blendBF(scenario({ pK_ours: 0 }))
  eq(r1.skip_reason, 'no_pk', 'pK_ours=0 → no_pk')

  const r2 = blendBF(scenario({ pK_ours: null }))
  eq(r2.skip_reason, 'no_pk', 'pK_ours=null → no_pk')

  const r3 = blendBF(scenario({ expected_bf_ours: 0 }))
  eq(r3.skip_reason, 'invalid_inputs', 'expected_bf_ours=0 → invalid_inputs')

  const r4 = blendBF(scenario({ r: -1 }))
  eq(r4.skip_reason, 'invalid_inputs', 'r=-1 → invalid_inputs')

  const r5 = blendBF(scenario({ r: NaN }))
  eq(r5.skip_reason, 'invalid_inputs', 'r=NaN → invalid_inputs')
}

// 6h. Counterfactual visibility — fields populated as far as inputs allow
{
  // pK_ours missing → no_pk skip, dk_lambda NOT computed (we exited before it)
  const r1 = blendBF(scenario({ pK_ours: null }))
  eq(r1.dk_lambda, null, 'no pK → dk_lambda null (cannot compute BF_dk anyway)')

  // Cap exceeded → all counterfactual fields populated
  const r2 = blendBF(scenario({ expected_bf_ours: 22, over_price: 0.05, dk_line: 5.5 }))
  ok(r2.dk_lambda != null, 'cap skip → dk_lambda populated for shadow logging')
  ok(r2.bf_dk != null,     'cap skip → bf_dk populated')
  ok(r2.bf_delta != null,  'cap skip → bf_delta populated')

  // Stable skip → fully populated
  const r3 = blendBF(scenario({ klass: 'stable' }))
  ok(r3.dk_lambda != null, 'stable skip → dk_lambda populated')
  ok(r3.bf_dk != null,     'stable skip → bf_dk populated')
  ok(r3.bf_delta != null,  'stable skip → bf_delta populated')
}

// 6i. SKIP_REASONS constants
{
  ok(Object.isFrozen(SKIP_REASONS), 'SKIP_REASONS frozen')
  eq(SKIP_REASONS.NO_DK_LINE,     'no_dk_line',     'SKIP_REASONS.NO_DK_LINE')
  eq(SKIP_REASONS.NO_OVER_PRICE,  'no_over_price',  'SKIP_REASONS.NO_OVER_PRICE')
  eq(SKIP_REASONS.NO_PK,          'no_pk',          'SKIP_REASONS.NO_PK')
  eq(SKIP_REASONS.INVALID_INPUTS, 'invalid_inputs', 'SKIP_REASONS.INVALID_INPUTS')
  eq(SKIP_REASONS.CAP,            'cap',            'SKIP_REASONS.CAP')
  eq(SKIP_REASONS.STABLE,         'stable',         'SKIP_REASONS.STABLE')
  eq(SKIP_REASONS.ZERO_WEIGHT,    'zero_weight',    'SKIP_REASONS.ZERO_WEIGHT')
}

// 6j. DEFAULT_BF_CAP_K
{
  approxEq(DEFAULT_BF_CAP_K, 3.0, 1e-12, 'DEFAULT_BF_CAP_K = 3.0')
}

// ════════════════════════════════════════════════════════════════════════
// 7. Module metadata
// ════════════════════════════════════════════════════════════════════════
section('Module metadata')
{
  eq(HELPER_NAME,    'oracle_layer_1_math.dkBlend', 'HELPER_NAME')
  eq(HELPER_VERSION, '1.0.0',                        'HELPER_VERSION')
}

// ────────────────────────────────────────────────────────────────────────
console.log(`\n═══════════════════════════════════════════`)
console.log(`  ${_passed} passed, ${_failed} failed`)
console.log('═══════════════════════════════════════════')
process.exit(_failed > 0 ? 1 : 0)
