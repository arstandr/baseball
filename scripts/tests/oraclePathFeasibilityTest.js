// scripts/tests/oraclePathFeasibilityTest.js
//
// Bite L2.2 — unit tests for oracle/layers/2-path/feasibility.js.
//
// Pure-function tests only. No DB, no Layer 1 envelope, no Trace.
// Run standalone:
//   node scripts/tests/oraclePathFeasibilityTest.js

import {
  // math
  requiredBf, requiredBfOuter, bfGap, bfGapRatio,
  gapUnder, requiredPk, bfCeiling,
  // tiers
  capTier, upgradeTier, yesBaseBucket, noBaseBucket,
  // classifiers
  classifyYes, classifyNo,
  // constants
  FEASIBILITY_CLASSES, TIER_ORDER, REASON_CODES,
  BF_GAP_RATIO_STRONG_MAX, BF_GAP_RATIO_VIABLE_MAX, BF_GAP_RATIO_FRAGILE_MAX,
  GAP_UNDER_STRONG_MIN, GAP_UNDER_VIABLE_MIN, GAP_UNDER_FRAGILE_MIN,
  TAIL_STRIKE_FRAGILE_MIN, TAIL_STRIKE_DEAD_MIN, TAIL_DEAD_RATIO,
  PK_EXTREME_FRAGILE, PK_EXTREME_DEAD,
  LEAGUE_PITCHES_PER_BF, SHORT_WORKLOAD_PITCH_MAX,
  HELPER_NAME, HELPER_VERSION,
} from '../../oracle/layers/2-path/feasibility.js'

// ─── Test infra ─────────────────────────────────────────────────────
let _passed = 0, _failed = 0
const ok = (c, l) => c ? _passed++ : (_failed++, console.error(`FAIL [${l}]`))
const eq = (a, b, l) => {
  if (a === b) { _passed++; return }
  if (a == null && b == null) { _passed++; return }
  _failed++; console.error(`FAIL [${l}]: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`)
}
const approxEq = (a, b, tol, l) => {
  if (Math.abs(a - b) <= tol) { _passed++; return }
  _failed++; console.error(`FAIL [${l}]: ${a} !~= ${b} (tol=${tol})`)
}
const arraysEq = (a, b, l) => {
  if (!Array.isArray(a) || !Array.isArray(b)) {
    _failed++; console.error(`FAIL [${l}]: non-array`); return
  }
  if (a.length !== b.length) {
    _failed++; console.error(`FAIL [${l}]: length ${a.length} !== ${b.length} (a=${JSON.stringify(a)} b=${JSON.stringify(b)})`); return
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      _failed++; console.error(`FAIL [${l}]: index ${i} ${a[i]} !== ${b[i]}`); return
    }
  }
  _passed++
}
const throws = (fn, l) => {
  let threw = false
  try { fn() } catch { threw = true }
  ok(threw, l)
}
const section = (n) => console.log(`\n── ${n} ──`)

console.log('═══════════════════════════════════════════')
console.log('  Layer 2 Path — Feasibility Helpers (Bite L2.2)')
console.log('═══════════════════════════════════════════')

// ════════════════════════════════════════════════════════════════════
// Section M — Math helpers
// ════════════════════════════════════════════════════════════════════
section('M — math helpers')
{
  // M1 requiredBf
  approxEq(requiredBf(7, 0.30), 7 / 0.30, 1e-12, 'requiredBf(7, 0.30)')
  approxEq(requiredBf(0, 0.25), 0, 1e-12, 'requiredBf(0, 0.25) = 0')
  throws(() => requiredBf(7, 0),   'requiredBf throws on pK_blended=0')
  throws(() => requiredBf(7, -0.1), 'requiredBf throws on negative pK')
  throws(() => requiredBf(NaN, 0.3), 'requiredBf throws on NaN strike')
  throws(() => requiredBf(-1, 0.3), 'requiredBf throws on negative strike')

  // M2 requiredBfOuter
  approxEq(requiredBfOuter(7, 22, 5.5), 7 * 22 / 5.5, 1e-12, 'requiredBfOuter basic')
  throws(() => requiredBfOuter(7, 0, 5.5), 'requiredBfOuter throws on expectedBf=0')
  throws(() => requiredBfOuter(7, 22, 0), 'requiredBfOuter throws on lambdaFinal=0')
  throws(() => requiredBfOuter(NaN, 22, 5.5), 'requiredBfOuter throws on NaN strike')

  // M3 bfGap, bfGapRatio
  approxEq(bfGap(25, 22), 3, 1e-12, 'bfGap basic')
  approxEq(bfGapRatio(25, 20), 0.25, 1e-12, 'bfGapRatio basic')
  throws(() => bfGapRatio(25, 0), 'bfGapRatio throws on expectedBf=0')
  throws(() => bfGap(NaN, 20), 'bfGap throws on NaN required')

  // M4 gapUnder
  approxEq(gapUnder(7, 5.5), 1.5, 1e-12, 'gapUnder basic')
  approxEq(gapUnder(7, 8.0), -1.0, 1e-12, 'gapUnder negative')
  throws(() => gapUnder(NaN, 5), 'gapUnder throws on NaN strike')

  // M5 requiredPk
  approxEq(requiredPk(7, 22), 7 / 22, 1e-12, 'requiredPk basic')
  throws(() => requiredPk(7, 0), 'requiredPk throws on expectedBf=0')

  // M6 bfCeiling
  approxEq(bfCeiling(95), 95 / LEAGUE_PITCHES_PER_BF, 1e-12, 'bfCeiling 95 pitches')
  eq(bfCeiling(null), null, 'bfCeiling(null) → null')
  eq(bfCeiling(undefined), null, 'bfCeiling(undefined) → null')
  eq(bfCeiling(NaN), null, 'bfCeiling(NaN) → null')
  eq(bfCeiling(0), null, 'bfCeiling(0) → null')
  eq(bfCeiling(-50), null, 'bfCeiling(-50) → null')
}

// ════════════════════════════════════════════════════════════════════
// Section T — Tier helpers
// ════════════════════════════════════════════════════════════════════
section('T — tier helpers')
{
  // T1 capTier — every pair from TIER_ORDER
  for (const a of TIER_ORDER) {
    for (const b of TIER_ORDER) {
      const ai = TIER_ORDER.indexOf(a)
      const bi = TIER_ORDER.indexOf(b)
      const expected = TIER_ORDER[Math.min(ai, bi)]
      eq(capTier(a, b), expected, `capTier(${a}, ${b})`)
    }
  }
  throws(() => capTier('strong', 'whatever'), 'capTier throws on bad ceiling')
  throws(() => capTier('whatever', 'strong'), 'capTier throws on bad current')

  // T2 upgradeTier
  eq(upgradeTier('dead', 0), 'dead', 'upgradeTier(dead, 0) = dead')
  eq(upgradeTier('dead', 1), 'fragile', 'upgradeTier(dead, 1) = fragile')
  eq(upgradeTier('dead', 2), 'viable', 'upgradeTier(dead, 2) = viable')
  eq(upgradeTier('dead', 3), 'strong', 'upgradeTier(dead, 3) = strong')
  eq(upgradeTier('dead', 99), 'strong', 'upgradeTier caps at strong')
  eq(upgradeTier('viable', 5), 'strong', 'upgradeTier viable+5 = strong')
  eq(upgradeTier('strong', 1), 'strong', 'upgradeTier strong+1 = strong (already at top)')
  throws(() => upgradeTier('strong', -1), 'upgradeTier throws on negative byCount')
  throws(() => upgradeTier('whatever', 1), 'upgradeTier throws on bad tier')
  throws(() => upgradeTier('strong', 1.5), 'upgradeTier throws on non-integer byCount')

  // T3 yesBaseBucket — boundary tests
  eq(yesBaseBucket(BF_GAP_RATIO_STRONG_MAX),       'strong',  'yesBaseBucket at -0.10 boundary → strong')
  eq(yesBaseBucket(BF_GAP_RATIO_STRONG_MAX + 1e-9), 'viable',  'yesBaseBucket just above -0.10 → viable')
  eq(yesBaseBucket(BF_GAP_RATIO_VIABLE_MAX),       'viable',  'yesBaseBucket at +0.05 boundary → viable')
  eq(yesBaseBucket(BF_GAP_RATIO_VIABLE_MAX + 1e-9), 'fragile', 'yesBaseBucket just above +0.05 → fragile')
  eq(yesBaseBucket(BF_GAP_RATIO_FRAGILE_MAX),      'fragile', 'yesBaseBucket at +0.20 boundary → fragile')
  eq(yesBaseBucket(BF_GAP_RATIO_FRAGILE_MAX + 1e-9), 'dead',   'yesBaseBucket just above +0.20 → dead')
  eq(yesBaseBucket(-1.0), 'strong', 'yesBaseBucket extreme negative → strong')
  eq(yesBaseBucket(2.0),  'dead',   'yesBaseBucket extreme positive → dead')
  throws(() => yesBaseBucket(NaN), 'yesBaseBucket throws on NaN')

  // T4 noBaseBucket — boundary tests
  eq(noBaseBucket(GAP_UNDER_STRONG_MIN),        'strong',  'noBaseBucket at +1.5 → strong')
  eq(noBaseBucket(GAP_UNDER_STRONG_MIN - 1e-9), 'viable',  'noBaseBucket just below +1.5 → viable')
  eq(noBaseBucket(GAP_UNDER_VIABLE_MIN),        'viable',  'noBaseBucket at +0.5 → viable')
  eq(noBaseBucket(GAP_UNDER_VIABLE_MIN - 1e-9), 'fragile', 'noBaseBucket just below +0.5 → fragile')
  eq(noBaseBucket(GAP_UNDER_FRAGILE_MIN),       'fragile', 'noBaseBucket at -0.5 → fragile')
  eq(noBaseBucket(GAP_UNDER_FRAGILE_MIN - 1e-9),'dead',    'noBaseBucket just below -0.5 → dead')
  eq(noBaseBucket(-2.0), 'dead',   'noBaseBucket extreme overrun → dead')
  eq(noBaseBucket(5.0),  'strong', 'noBaseBucket large cushion → strong')
  throws(() => noBaseBucket(NaN), 'noBaseBucket throws on NaN')
}

// ════════════════════════════════════════════════════════════════════
// Section Y — classifyYes branches
// ════════════════════════════════════════════════════════════════════
section('Y — classifyYes branches')

// Helper for clean YES inputs
const yesIn = (overrides) => ({
  strike: 6, expected_bf: 22, pK_blended: 0.30, lambda_final: 6.6,
  bf_source_tier: 'strong',
  ...overrides,
})

// Y1 comfortable_buffer (strong baseline, no overrides)
{
  // strike=5, expected_bf=22, pK=0.30 → required_bf=16.7, ratio=-0.243 → strong
  const r = classifyYes(yesIn({ strike: 5, expected_bf: 22, pK_blended: 0.30 }))
  eq(r.feasibility, 'strong', 'Y1 strong baseline')
  eq(r.reason_code, REASON_CODES.COMFORTABLE_BUFFER, 'Y1 reason=comfortable_buffer')
  arraysEq(r.secondary_reasons, [], 'Y1 no secondary reasons')
}

// Y2 normal_path (viable baseline)
{
  // strike=6, expected_bf=21, pK=0.30 → required=20, ratio=-0.048 → viable
  const r = classifyYes(yesIn({ strike: 6, expected_bf: 21, pK_blended: 0.30 }))
  eq(r.feasibility, 'viable', 'Y2 viable baseline')
  eq(r.reason_code, REASON_CODES.NORMAL_PATH, 'Y2 reason=normal_path')
}

// Y3 bf_gap_fragile (fragile baseline)
{
  // strike=7, expected_bf=22, pK=0.30 → required=23.33, ratio=+0.061 → fragile
  const r = classifyYes(yesIn({ strike: 7, expected_bf: 22, pK_blended: 0.30 }))
  eq(r.feasibility, 'fragile', 'Y3 fragile baseline')
  eq(r.reason_code, REASON_CODES.BF_GAP_FRAGILE, 'Y3 reason=bf_gap_fragile')
}

// Y4 bf_gap_dead (dead baseline)
{
  // strike=8, expected_bf=22, pK=0.28 → required=28.57, ratio=+0.30 → dead
  const r = classifyYes(yesIn({ strike: 8, expected_bf: 22, pK_blended: 0.28 }))
  eq(r.feasibility, 'dead', 'Y4 dead baseline')
  eq(r.reason_code, REASON_CODES.BF_GAP_DEAD, 'Y4 reason=bf_gap_dead')
}

// Y5 workload_ceiling hard-dead
{
  // strike=8, expected_bf=20, pK=0.30 → required=26.67, ratio=+0.333 (dead-ish anyway)
  // avg_pitches=85 → bf_ceiling=85/3.8=22.37 < 26.67 → workload_ceiling fires
  const r = classifyYes(yesIn({
    strike: 8, expected_bf: 20, pK_blended: 0.30, avg_pitches: 85,
  }))
  eq(r.feasibility, 'dead', 'Y5 feasibility=dead')
  eq(r.reason_code, REASON_CODES.WORKLOAD_CEILING, 'Y5 primary=workload_ceiling')
}

// Y6 pk_extreme_dead
{
  // strike=10, expected_bf=20 → required_pk=0.50 > 0.45 → pk_extreme_dead
  // ratio: with pK=0.30 required_bf=33.3, gap=13.3, ratio=0.665. Both fire; precedence pk_extreme_dead.
  // Force avg_pitches large so workload_ceiling doesn't pre-empt.
  const r = classifyYes(yesIn({
    strike: 10, expected_bf: 20, pK_blended: 0.30, avg_pitches: 200,
  }))
  eq(r.feasibility, 'dead', 'Y6 feasibility=dead')
  // workload_ceiling: 200/3.8=52.6 > 33.3 → does NOT fire. pk_extreme_dead fires.
  // tail_dead_high_strike (strike=10, ratio=0.665 > 0.10): also fires.
  // Precedence: pk_extreme_dead before tail_dead_high_strike
  eq(r.reason_code, REASON_CODES.PK_EXTREME_DEAD, 'Y6 primary=pk_extreme_dead')
  ok(r.secondary_reasons.includes(REASON_CODES.TAIL_DEAD_HIGH_STRIKE),
    'Y6 secondary includes tail_dead_high_strike')
}

// Y7 tail_dead_high_strike (strike=10 ratio>0.10 but no pk_extreme)
{
  // strike=10, expected_bf=27, pK=0.40 → required=25, ratio=-0.074 (negative — strong baseline)
  // tail_dead_high_strike requires ratio > 0.10 → does NOT fire here.
  // Need ratio > 0.10 without pk_extreme. required_pk = 10/27 = 0.37 (< 0.38, below cap).
  // Try expected_bf=27, pK=0.32 → required=31.25, ratio=+0.157 → tail_dead fires.
  const r = classifyYes(yesIn({
    strike: 10, expected_bf: 27, pK_blended: 0.32, avg_pitches: 200,
  }))
  eq(r.feasibility, 'dead', 'Y7 dead from tail_dead')
  // required_pk=10/27=0.370 (<0.38), pk_extreme caps don't fire
  eq(r.reason_code, REASON_CODES.TAIL_DEAD_HIGH_STRIKE, 'Y7 primary=tail_dead_high_strike')
}

// Y8 pk_extreme_fragile cap from strong baseline
{
  // Want strong baseline (ratio ≤ -0.10) AND required_pk > 0.38 AND not hit dead.
  // strike=8, expected_bf=21 → required_pk=0.381 (>0.38, < 0.45). pK=0.50 → required_bf=16, ratio=-0.238 (strong).
  const r = classifyYes(yesIn({
    strike: 8, expected_bf: 21, pK_blended: 0.50, lambda_final: 10.5,
    avg_pitches: 200,
  }))
  eq(r.feasibility, 'fragile', 'Y8 fragile cap from strong')
  eq(r.reason_code, REASON_CODES.PK_EXTREME_FRAGILE, 'Y8 primary=pk_extreme_fragile')
}

// Y9 tail_fragile_high_strike cap (strike=9, bf_gap > 0)
{
  // strike=9, expected_bf=22, pK=0.39 → required=23.08, ratio=+0.049 → viable; bf_gap=+1.08 > 0 → tail cap.
  // required_pk=9/22=0.409 → pk_extreme_fragile also fires (>0.38).
  // Both cap at fragile; pk_extreme_fragile takes primary.
  const r = classifyYes(yesIn({
    strike: 9, expected_bf: 22, pK_blended: 0.39, avg_pitches: 200,
  }))
  eq(r.feasibility, 'fragile', 'Y9 fragile cap from viable')
  eq(r.reason_code, REASON_CODES.PK_EXTREME_FRAGILE, 'Y9 primary=pk_extreme_fragile (precedence)')
  ok(r.secondary_reasons.includes(REASON_CODES.TAIL_FRAGILE_HIGH_STRIKE),
    'Y9 secondary includes tail_fragile')
}

// Y9b tail_fragile_high_strike alone (no pk_extreme)
{
  // strike=9, expected_bf=27, pK=0.34 → required=26.47, ratio=-0.020 (viable boundary)
  // Actually -0.020 falls in the viable bucket (between -0.10 and +0.05).
  // bf_gap=-0.53 → tail_fragile DOES NOT fire (needs bf_gap > 0).
  // Try expected_bf=25, pK=0.34 → required=26.47, ratio=+0.059 (fragile baseline, bf_gap=+1.47).
  // Tail_fragile fires but tier already fragile so no change.
  // For tail_fragile to be PRIMARY, need: viable baseline AND tail caps to fragile AND no other fragile cap.
  // expected_bf=25, pK=0.36 → required=25, ratio=0.0 (viable). bf_gap=0 → tail_fragile NOT fire.
  // expected_bf=24, pK=0.36 → required=25, ratio=+0.042 (viable). bf_gap=+1 → tail_fragile fires.
  // required_pk=9/24=0.375 (<0.38). pk_extreme_fragile NOT fire. Good.
  const r = classifyYes(yesIn({
    strike: 9, expected_bf: 24, pK_blended: 0.36, avg_pitches: 200,
  }))
  eq(r.feasibility, 'fragile', 'Y9b fragile from tail-only cap')
  eq(r.reason_code, REASON_CODES.TAIL_FRAGILE_HIGH_STRIKE, 'Y9b primary=tail_fragile_high_strike')
}

// Y10 bf_source_weak_cap from strong → viable (no dk_blend)
{
  // Strong baseline + weak source → cap at viable.
  // strike=5, expected_bf=22, pK=0.30 → strong. weak source → viable cap.
  const r = classifyYes(yesIn({
    strike: 5, expected_bf: 22, pK_blended: 0.30, bf_source_tier: 'weak',
  }))
  eq(r.feasibility, 'viable', 'Y10 viable after weak cap')
  eq(r.reason_code, REASON_CODES.BF_SOURCE_WEAK_CAP, 'Y10 primary=bf_source_weak_cap')
}

// Y11 bf_source_weak_cap NOT applied when dk_blend_applied=true
{
  const r = classifyYes(yesIn({
    strike: 5, expected_bf: 22, pK_blended: 0.30, bf_source_tier: 'weak',
    dk_blend_applied: true,
  }))
  eq(r.feasibility, 'strong', 'Y11 stays strong when dk_blend_applied')
  eq(r.reason_code, REASON_CODES.COMFORTABLE_BUFFER, 'Y11 primary=comfortable_buffer')
  ok(!r.secondary_reasons.includes(REASON_CODES.BF_SOURCE_WEAK_CAP),
    'Y11 weak cap not in secondary either')
}

// Y12 multiple hard-dead trigger: precedence workload > pk > tail
{
  // strike=10, expected_bf=20, pK=0.30 → required=33.3, required_pk=0.50, ratio=0.667
  // avg_pitches=85 → bf_ceiling=22.37 < 33.3 → workload_ceiling
  // pk=0.50 > 0.45 → pk_extreme_dead
  // strike>=10 + ratio=0.667 > 0.10 → tail_dead_high_strike
  // All three fire; primary = workload_ceiling
  const r = classifyYes(yesIn({
    strike: 10, expected_bf: 20, pK_blended: 0.30, avg_pitches: 85,
  }))
  eq(r.feasibility, 'dead', 'Y12 dead')
  eq(r.reason_code, REASON_CODES.WORKLOAD_CEILING, 'Y12 primary=workload_ceiling (precedence)')
  ok(r.secondary_reasons.includes(REASON_CODES.PK_EXTREME_DEAD), 'Y12 secondary has pk_extreme_dead')
  ok(r.secondary_reasons.includes(REASON_CODES.TAIL_DEAD_HIGH_STRIKE), 'Y12 secondary has tail_dead')
}

// Y13 multiple cap trigger: pk_extreme_fragile beats tail_fragile (already tested in Y9)
// Y14 cap + weak combination (most-restrictive wins)
{
  // strong baseline + pk_extreme_fragile + weak source.
  // tier: strong → fragile (pk cap) → fragile (weak cap stays at fragile)
  // primary: PK_EXTREME_FRAGILE (fragile cap takes precedence over viable cap)
  // weakCapLowered: false (already at fragile, weak cap caps at viable; fragile < viable)
  const r = classifyYes(yesIn({
    strike: 8, expected_bf: 21, pK_blended: 0.50, lambda_final: 10.5,
    bf_source_tier: 'weak', avg_pitches: 200,
  }))
  eq(r.feasibility, 'fragile', 'Y14 fragile (pk cap most restrictive)')
  eq(r.reason_code, REASON_CODES.PK_EXTREME_FRAGILE, 'Y14 primary=pk_extreme_fragile')
  ok(r.secondary_reasons.includes(REASON_CODES.BF_SOURCE_WEAK_CAP), 'Y14 weak cap in secondary')
}

// Y15 strike thresholds: 8 vs 9 (tail trigger) and 9 vs 10 (tail_dead trigger)
{
  // strike=8 with bf_gap>0 → tail_fragile does NOT fire (needs strike>=9)
  const r8 = classifyYes(yesIn({
    strike: 8, expected_bf: 22, pK_blended: 0.34, avg_pitches: 200,
  }))
  ok(!r8.secondary_reasons.includes(REASON_CODES.TAIL_FRAGILE_HIGH_STRIKE),
    'Y15 strike=8: tail_fragile not triggered')
  ok(r8.reason_code !== REASON_CODES.TAIL_FRAGILE_HIGH_STRIKE,
    'Y15 strike=8: tail_fragile not primary')

  // strike=9, ratio>0.10, no pk_extreme: tail_dead does NOT fire (needs strike>=10)
  const r9 = classifyYes(yesIn({
    strike: 9, expected_bf: 22, pK_blended: 0.32, avg_pitches: 200,
  }))
  ok(!r9.secondary_reasons.includes(REASON_CODES.TAIL_DEAD_HIGH_STRIKE),
    'Y15 strike=9: tail_dead not triggered')
}

// Y17 dk_blend_applied=true preserves strong even with weak source (already in Y11)

// Y18 secondary_reasons trigger-evaluation order
{
  // workload_ceiling AND pk_extreme_dead AND tail_dead all fire (Y12 case).
  // Trigger evaluation order: workload_ceiling first, then pk_extreme_dead, then tail_dead.
  const r = classifyYes(yesIn({
    strike: 10, expected_bf: 20, pK_blended: 0.30, avg_pitches: 85,
  }))
  // primary=workload_ceiling, secondary preserves order [pk_extreme_dead, tail_dead]
  arraysEq(r.secondary_reasons,
    [REASON_CODES.PK_EXTREME_DEAD, REASON_CODES.TAIL_DEAD_HIGH_STRIKE],
    'Y18 secondary preserves trigger order')
}

// ════════════════════════════════════════════════════════════════════
// Section N — classifyNo branches
// ════════════════════════════════════════════════════════════════════
section('N — classifyNo branches')

const noIn = (overrides) => ({
  strike: 6, expected_bf: 22, pK_blended: 0.25, lambda_final: 5.5,
  bf_source_tier: 'strong',
  ...overrides,
})

// N1 no_path_ample_cushion (strong baseline)
{
  // strike=8, lambda_final=5.5 → gap_under=2.5 ≥ 1.5 → strong
  const r = classifyNo(noIn({ strike: 8, lambda_final: 5.5 }))
  eq(r.feasibility, 'strong', 'N1 strong baseline')
  eq(r.reason_code, REASON_CODES.NO_PATH_AMPLE_CUSHION, 'N1 reason=ample_cushion')
}

// N2 no_path_at_strike_lambda (viable baseline)
{
  // strike=7, lambda_final=6.0 → gap_under=1.0 → viable
  const r = classifyNo(noIn({ strike: 7, lambda_final: 6.0 }))
  eq(r.feasibility, 'viable', 'N2 viable baseline')
  eq(r.reason_code, REASON_CODES.NO_PATH_AT_STRIKE_LAMBDA, 'N2 reason=at_strike_lambda')
}

// N3 no_path_thin (fragile baseline)
{
  // strike=6, lambda_final=5.8 → gap_under=0.2 → fragile
  const r = classifyNo(noIn({ strike: 6, lambda_final: 5.8 }))
  eq(r.feasibility, 'fragile', 'N3 fragile baseline')
  eq(r.reason_code, REASON_CODES.NO_PATH_THIN, 'N3 reason=path_thin')
}

// N4 no_path_overrun (dead baseline)
{
  // strike=6, lambda_final=7.5 → gap_under=-1.5 → dead
  const r = classifyNo(noIn({ strike: 6, lambda_final: 7.5 }))
  eq(r.feasibility, 'dead', 'N4 dead baseline')
  eq(r.reason_code, REASON_CODES.NO_PATH_OVERRUN, 'N4 reason=overrun')
}

// N5 leash_supports_no upgrade fragile → viable
{
  const r = classifyNo(noIn({ strike: 6, lambda_final: 5.8, leash_flag: true }))
  eq(r.feasibility, 'viable', 'N5 fragile→viable via leash')
  eq(r.reason_code, REASON_CODES.LEASH_SUPPORTS_NO, 'N5 primary=leash_supports_no')
}

// N6 workload_ceiling_supports_no upgrade
{
  // baseline fragile, set avg_pitches so bf_ceiling < required_bf (no leash)
  // strike=6, expected_bf=22, pK=0.25 → required_bf=24
  // avg_pitches=85 → ceiling=22.37 < 24 → ceiling supports no
  // gap_under = 6 - 5.8 = 0.2 → fragile baseline
  const r = classifyNo(noIn({
    strike: 6, expected_bf: 22, pK_blended: 0.25, lambda_final: 5.8,
    avg_pitches: 85,
  }))
  // avg_pitches < 80? 85 NOT < 80 → short_workload does NOT fire
  // ceiling fires only.
  eq(r.feasibility, 'viable', 'N6 fragile→viable via ceiling')
  eq(r.reason_code, REASON_CODES.WORKLOAD_CEILING_SUPPORTS_NO,
    'N6 primary=workload_ceiling_supports_no')
}

// N7 short_workload_supports_no upgrade
{
  // baseline fragile, leash=false, ceiling check fails (ceiling >= required), avg_pitches < 80
  // strike=6, pK=0.25, expected_bf=22 → required=24
  // avg_pitches=78 → ceiling=78/3.8=20.5 < 24 → ceiling ALSO fires
  // Need ceiling to NOT fire. avg_pitches=78, expected_bf=30, pK=0.20 → required=30, ceiling=78/3.8=20.5<30 → still fires.
  // To avoid ceiling firing, need ceiling >= required. avg_pitches=120 → ceiling=31.6, but 120>80 so short_workload doesn't fire.
  // The issue: short_workload requires avg<80 BUT ceiling=avg/3.8 < 30 always when avg<80.
  // So short_workload alone (without ceiling firing) requires required_bf < avg/3.8.
  // avg_pitches=79, required_bf=20 → ceiling=79/3.8=20.79 > 20 → ceiling DOES NOT fire (ceiling >= required).
  // strike=4, pK=0.20, expected_bf=22 → required=20, gap_under=4-5.8=-1.8 → dead baseline. No good.
  // Try: strike=6, pK=0.30, expected_bf=22 → required=20, gap_under=6-5.8=0.2 fragile.
  // avg_pitches=79 → ceiling=20.79 > 20 → ceiling DOES NOT fire.
  // avg_pitches=79 < 80 → short_workload fires. Good.
  const r = classifyNo(noIn({
    strike: 6, expected_bf: 22, pK_blended: 0.30, lambda_final: 5.8,
    avg_pitches: 79,
  }))
  eq(r.feasibility, 'viable', 'N7 fragile→viable via short_workload')
  eq(r.reason_code, REASON_CODES.SHORT_WORKLOAD_SUPPORTS_NO,
    'N7 primary=short_workload_supports_no')
}

// N8 multiple modifiers stacking, cap at strong (non-dead baseline)
{
  // baseline viable + leash + ceiling + short_workload → upgradesApplied=3
  // upgradeTier(viable, 3) = strong (capped)
  const r = classifyNo(noIn({
    strike: 7, expected_bf: 22, pK_blended: 0.30, lambda_final: 6.0,
    leash_flag: true, avg_pitches: 75,
  }))
  // gap_under = 7 - 6.0 = 1.0 → viable baseline
  // required_bf = 7/0.30 = 23.33; ceiling = 75/3.8 = 19.74 < 23.33 → ceiling fires
  // avg_pitches=75 < 80 → short_workload fires
  // leash → leash fires
  eq(r.feasibility, 'strong', 'N8 viable + 3 modifiers → strong')
  eq(r.reason_code, REASON_CODES.LEASH_SUPPORTS_NO, 'N8 primary=leash (highest priority)')
  ok(r.secondary_reasons.includes(REASON_CODES.WORKLOAD_CEILING_SUPPORTS_NO),
    'N8 secondary has workload_ceiling_supports_no')
  ok(r.secondary_reasons.includes(REASON_CODES.SHORT_WORKLOAD_SUPPORTS_NO),
    'N8 secondary has short_workload_supports_no')
}

// N9 modifier precedence: leash > ceiling > short_workload
{
  // baseline fragile, only ceiling fires (no leash, no short_workload)
  // strike=6, pK=0.25, expected_bf=22 → required=24
  // avg_pitches=85 → ceiling=22.37 < 24 fires. avg=85 not < 80 → short does NOT fire.
  const r = classifyNo(noIn({
    strike: 6, lambda_final: 5.8, avg_pitches: 85,
  }))
  eq(r.feasibility, 'viable', 'N9 fragile→viable via ceiling alone')
  eq(r.reason_code, REASON_CODES.WORKLOAD_CEILING_SUPPORTS_NO, 'N9 primary=ceiling alone')

  // baseline fragile, only short_workload fires (no leash, no ceiling)
  const r2 = classifyNo(noIn({
    strike: 6, expected_bf: 22, pK_blended: 0.30, lambda_final: 5.8,
    avg_pitches: 79,
  }))
  // required=20, ceiling=20.79>20 NOT fire. short fires.
  eq(r2.reason_code, REASON_CODES.SHORT_WORKLOAD_SUPPORTS_NO, 'N9 primary=short alone')
}

// N10 bf_source_weak_cap from strong → viable
{
  // strong baseline + weak source → cap at viable
  const r = classifyNo(noIn({
    strike: 8, lambda_final: 5.5, bf_source_tier: 'weak',
  }))
  eq(r.feasibility, 'viable', 'N10 strong→viable via weak cap')
  eq(r.reason_code, REASON_CODES.BF_SOURCE_WEAK_CAP, 'N10 primary=bf_source_weak_cap')
}

// N11 bf_source_weak_cap NOT applied when dk_blend_applied=true
{
  const r = classifyNo(noIn({
    strike: 8, lambda_final: 5.5, bf_source_tier: 'weak',
    dk_blend_applied: true,
  }))
  eq(r.feasibility, 'strong', 'N11 stays strong with dk_blend')
  eq(r.reason_code, REASON_CODES.NO_PATH_AMPLE_CUSHION, 'N11 primary=ample_cushion')
}

// N12 weak-cap + modifier interaction (cap applies AFTER upgrades)
{
  // baseline fragile + leash → upgrades to viable. Then weak cap → viable (no change).
  // weakCapLowered=false. primary=leash (caused upgrade vs baseline).
  const r = classifyNo(noIn({
    strike: 6, lambda_final: 5.8, leash_flag: true, bf_source_tier: 'weak',
  }))
  eq(r.feasibility, 'viable', 'N12 viable (leash up + weak holds at viable)')
  eq(r.reason_code, REASON_CODES.LEASH_SUPPORTS_NO,
    'N12 primary=leash (cap did not lower)')
  ok(r.secondary_reasons.includes(REASON_CODES.BF_SOURCE_WEAK_CAP),
    'N12 weak cap in secondary')

  // baseline strong + leash + weak source → leash upgrade no-op (already strong),
  // weak cap → viable. weakCapLowered=true. primary=weak.
  const r2 = classifyNo(noIn({
    strike: 8, lambda_final: 5.5, leash_flag: true, bf_source_tier: 'weak',
  }))
  eq(r2.feasibility, 'viable', 'N12b strong→viable via weak after leash no-op')
  eq(r2.reason_code, REASON_CODES.BF_SOURCE_WEAK_CAP,
    'N12b primary=bf_source_weak_cap (lowered the tier)')
}

// N13 gap_under threshold boundaries (already covered in T4)

// N14 dead baseline cannot climb past fragile
{
  // baseline dead + ALL THREE modifiers
  // gap_under = 6 - 8.0 = -2.0 → dead baseline
  const r = classifyNo(noIn({
    strike: 6, expected_bf: 22, pK_blended: 0.40, lambda_final: 8.0,
    leash_flag: true, avg_pitches: 70,
  }))
  // required=15, ceiling=70/3.8=18.4 NOT < 15 → ceiling does NOT fire
  // Wait: ceiling fires when ceiling < required. 18.4 < 15? No (18.4 > 15). Doesn't fire.
  // short fires (70 < 80). leash fires. So 2 modifiers.
  // Dead baseline → cap at 1 upgrade → fragile.
  eq(r.feasibility, 'fragile', 'N14 dead climbs at most one tier (to fragile)')
  eq(r.reason_code, REASON_CODES.LEASH_SUPPORTS_NO, 'N14 primary=leash')
  ok(r.secondary_reasons.includes(REASON_CODES.SHORT_WORKLOAD_SUPPORTS_NO),
    'N14 secondary has short_workload')
}

// N14b dead baseline + ALL three modifiers fire still capped at fragile
{
  // gap_under=-2.0 (dead). required_bf=24 (strike=6, pK=0.25). ceiling=70/3.8=18.4<24 → fires.
  // Also leash + short.
  const r = classifyNo(noIn({
    strike: 6, expected_bf: 22, pK_blended: 0.25, lambda_final: 8.0,
    leash_flag: true, avg_pitches: 70,
  }))
  eq(r.feasibility, 'fragile', 'N14b dead+3 modifiers still capped at fragile')
  eq(r.reason_code, REASON_CODES.LEASH_SUPPORTS_NO, 'N14b primary=leash')
}

// N15 secondary_reasons trigger-evaluation order
{
  // viable baseline, leash + ceiling + short all fire.
  // Trigger order: leash, ceiling, short
  const r = classifyNo(noIn({
    strike: 7, expected_bf: 22, pK_blended: 0.30, lambda_final: 6.0,
    leash_flag: true, avg_pitches: 75,
  }))
  // primary = leash. secondary = [ceiling, short] in trigger order.
  arraysEq(r.secondary_reasons,
    [REASON_CODES.WORKLOAD_CEILING_SUPPORTS_NO, REASON_CODES.SHORT_WORKLOAD_SUPPORTS_NO],
    'N15 secondary preserves trigger order')
}

// ════════════════════════════════════════════════════════════════════
// Section E — Error handling
// ════════════════════════════════════════════════════════════════════
section('E — error handling (throw on bad required, not on optional)')
{
  // E1 missing strike
  throws(() => classifyYes({ expected_bf: 22, pK_blended: 0.30, lambda_final: 5.5, bf_source_tier: 'strong' }),
    'E1 classifyYes throws on missing strike')

  // E2 missing expected_bf
  throws(() => classifyYes({ strike: 6, pK_blended: 0.30, lambda_final: 5.5, bf_source_tier: 'strong' }),
    'E2 classifyYes throws on missing expected_bf')

  // E3 missing pK_blended
  throws(() => classifyYes({ strike: 6, expected_bf: 22, lambda_final: 5.5, bf_source_tier: 'strong' }),
    'E3 classifyYes throws on missing pK_blended')

  // E4 missing lambda_final
  throws(() => classifyYes({ strike: 6, expected_bf: 22, pK_blended: 0.30, bf_source_tier: 'strong' }),
    'E4 classifyYes throws on missing lambda_final')

  // E5 missing bf_source_tier
  throws(() => classifyYes({ strike: 6, expected_bf: 22, pK_blended: 0.30, lambda_final: 5.5 }),
    'E5 classifyYes throws on missing bf_source_tier')

  // E6 invalid bf_source_tier
  throws(() => classifyYes({ strike: 6, expected_bf: 22, pK_blended: 0.30, lambda_final: 5.5, bf_source_tier: 'garbage' }),
    'E6 classifyYes throws on invalid bf_source_tier')

  // E7 expected_bf=0
  throws(() => classifyYes(yesIn({ expected_bf: 0 })), 'E7 classifyYes throws on expected_bf=0')

  // E8 pK_blended=0
  throws(() => classifyYes(yesIn({ pK_blended: 0 })), 'E8 classifyYes throws on pK_blended=0')

  // E9 lambda_final=0
  throws(() => classifyYes(yesIn({ lambda_final: 0 })), 'E9 classifyYes throws on lambda_final=0')

  // E10 non-integer strike
  throws(() => classifyYes(yesIn({ strike: 6.5 })), 'E10 classifyYes throws on non-integer strike')

  // E11 negative strike
  throws(() => classifyYes(yesIn({ strike: -1 })), 'E11 classifyYes throws on negative strike')

  // E12 same checks for classifyNo (sample)
  throws(() => classifyNo({ expected_bf: 22, pK_blended: 0.30, lambda_final: 5.5, bf_source_tier: 'strong' }),
    'E12 classifyNo throws on missing strike')
  throws(() => classifyNo(noIn({ pK_blended: -0.1 })), 'E12b classifyNo throws on negative pK')

  // E13 optional fields are accepted as defaults (no throw)
  let didNotThrow = true
  try {
    classifyYes(yesIn({ avg_pitches: undefined, dk_blend_applied: undefined }))
  } catch { didNotThrow = false }
  ok(didNotThrow, 'E13 classifyYes accepts undefined optionals')

  let didNotThrow2 = true
  try {
    classifyNo(noIn({ leash_flag: undefined, avg_pitches: null }))
  } catch { didNotThrow2 = false }
  ok(didNotThrow2, 'E13 classifyNo accepts undefined optionals')

  // E14 input not an object
  throws(() => classifyYes(null), 'E14 classifyYes throws on null')
  throws(() => classifyYes('hello'), 'E14b classifyYes throws on string')

  // E15 math helpers throw on bad inputs (sample)
  throws(() => requiredBf(7, NaN), 'E15 requiredBf throws on NaN pK')
  throws(() => requiredPk(-1, 22), 'E15b requiredPk throws on negative strike')
  throws(() => bfGapRatio(20, 0), 'E15c bfGapRatio throws on zero expectedBf')

  // E16 bfCeiling does NOT throw on invalid (returns null)
  let bfCeilThrew = false
  try { bfCeiling(NaN); bfCeiling(null); bfCeiling(-50) } catch { bfCeilThrew = true }
  ok(!bfCeilThrew, 'E16 bfCeiling does not throw on invalid avg_pitches')
}

// ════════════════════════════════════════════════════════════════════
// Section C — Constants / metadata
// ════════════════════════════════════════════════════════════════════
section('C — constants + metadata')
{
  ok(Object.isFrozen(FEASIBILITY_CLASSES), 'FEASIBILITY_CLASSES frozen')
  eq(FEASIBILITY_CLASSES.STRONG,  'strong',  'FEASIBILITY_CLASSES.STRONG')
  eq(FEASIBILITY_CLASSES.VIABLE,  'viable',  'FEASIBILITY_CLASSES.VIABLE')
  eq(FEASIBILITY_CLASSES.FRAGILE, 'fragile', 'FEASIBILITY_CLASSES.FRAGILE')
  eq(FEASIBILITY_CLASSES.DEAD,    'dead',    'FEASIBILITY_CLASSES.DEAD')

  ok(Object.isFrozen(TIER_ORDER), 'TIER_ORDER frozen')
  eq(TIER_ORDER.length, 4, 'TIER_ORDER length=4')
  eq(TIER_ORDER[0], 'dead',    'TIER_ORDER[0]=dead (worst)')
  eq(TIER_ORDER[3], 'strong',  'TIER_ORDER[3]=strong (best)')

  ok(Object.isFrozen(REASON_CODES), 'REASON_CODES frozen')
  // Spot-check vocabulary completeness
  const expectedReasons = [
    'workload_ceiling', 'pk_extreme_dead', 'tail_dead_high_strike',
    'pk_extreme_fragile', 'tail_fragile_high_strike', 'bf_source_weak_cap',
    'leash_supports_no', 'workload_ceiling_supports_no', 'short_workload_supports_no',
    'comfortable_buffer', 'normal_path', 'bf_gap_fragile', 'bf_gap_dead',
    'no_path_ample_cushion', 'no_path_at_strike_lambda', 'no_path_thin', 'no_path_overrun',
  ]
  const reasonValues = new Set(Object.values(REASON_CODES))
  for (const r of expectedReasons) ok(reasonValues.has(r), `REASON_CODES contains "${r}"`)

  // Threshold constants
  approxEq(BF_GAP_RATIO_STRONG_MAX,  -0.10, 1e-12, 'BF_GAP_RATIO_STRONG_MAX')
  approxEq(BF_GAP_RATIO_VIABLE_MAX,  +0.05, 1e-12, 'BF_GAP_RATIO_VIABLE_MAX')
  approxEq(BF_GAP_RATIO_FRAGILE_MAX, +0.20, 1e-12, 'BF_GAP_RATIO_FRAGILE_MAX')
  approxEq(GAP_UNDER_STRONG_MIN,     +1.5,  1e-12, 'GAP_UNDER_STRONG_MIN')
  approxEq(GAP_UNDER_VIABLE_MIN,     +0.5,  1e-12, 'GAP_UNDER_VIABLE_MIN')
  approxEq(GAP_UNDER_FRAGILE_MIN,    -0.5,  1e-12, 'GAP_UNDER_FRAGILE_MIN')
  eq(TAIL_STRIKE_FRAGILE_MIN, 9,    'TAIL_STRIKE_FRAGILE_MIN=9')
  eq(TAIL_STRIKE_DEAD_MIN,    10,   'TAIL_STRIKE_DEAD_MIN=10')
  approxEq(TAIL_DEAD_RATIO,   0.10, 1e-12, 'TAIL_DEAD_RATIO=0.10')
  approxEq(PK_EXTREME_FRAGILE, 0.38, 1e-12, 'PK_EXTREME_FRAGILE=0.38')
  approxEq(PK_EXTREME_DEAD,    0.45, 1e-12, 'PK_EXTREME_DEAD=0.45')
  approxEq(LEAGUE_PITCHES_PER_BF, 3.8, 1e-12, 'LEAGUE_PITCHES_PER_BF=3.8')
  eq(SHORT_WORKLOAD_PITCH_MAX, 80, 'SHORT_WORKLOAD_PITCH_MAX=80')

  // Module metadata
  eq(HELPER_NAME, 'oracle_layer_2_path.feasibility', 'HELPER_NAME')
  eq(HELPER_VERSION, '1.0.0', 'HELPER_VERSION')
}

// ─── Done ───────────────────────────────────────────────────────────
console.log(`\n═══════════════════════════════════════════`)
console.log(`  ${_passed} passed, ${_failed} failed`)
console.log('═══════════════════════════════════════════')
process.exit(_failed > 0 ? 1 : 0)
