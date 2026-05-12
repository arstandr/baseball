// oracle/layers/2-path/feasibility.js
//
// Bite L2.2 — Pure feasibility helpers for Layer 2 (Path).
//
// Translates the locked thresholds and order-of-operations from
// SPEC.md §4-§6 into pure, testable functions.
//
// Scope discipline (locked):
//   - No Layer 1 envelope dependency
//   - No Trace, no hashes, no run()
//   - No DB
//   - L2.4 will wire these into the per-bet run() with envelope/Trace
//     integration. Until then, this module only proves the
//     math/logic branches.
//
// Throw vs. structured:
//   - Required inputs missing/invalid → THROW (caller bug)
//   - Optional inputs (avg_pitches null, leash_flag undefined,
//     dk_blend_applied undefined) → defaults
//   - bfCeiling on invalid avg_pitches → return null (legitimate state,
//     not an error)

// ────────────────────────────────────────────────────────────────────
// Vocabulary
// ────────────────────────────────────────────────────────────────────

export const FEASIBILITY_CLASSES = Object.freeze({
  STRONG:  'strong',
  VIABLE:  'viable',
  FRAGILE: 'fragile',
  DEAD:    'dead',
})

// Worst → best. capTier picks lower index; upgradeTier moves higher.
export const TIER_ORDER = Object.freeze(['dead', 'fragile', 'viable', 'strong'])

export const REASON_CODES = Object.freeze({
  // YES hard-dead drivers
  WORKLOAD_CEILING:                'workload_ceiling',
  PK_EXTREME_DEAD:                 'pk_extreme_dead',
  TAIL_DEAD_HIGH_STRIKE:           'tail_dead_high_strike',
  // YES cap drivers
  PK_EXTREME_FRAGILE:              'pk_extreme_fragile',
  TAIL_FRAGILE_HIGH_STRIKE:        'tail_fragile_high_strike',
  BF_SOURCE_WEAK_CAP:              'bf_source_weak_cap',
  // NO support modifiers
  LEASH_SUPPORTS_NO:               'leash_supports_no',
  WORKLOAD_CEILING_SUPPORTS_NO:    'workload_ceiling_supports_no',
  SHORT_WORKLOAD_SUPPORTS_NO:      'short_workload_supports_no',
  // YES natural-bucket
  COMFORTABLE_BUFFER:              'comfortable_buffer',
  NORMAL_PATH:                     'normal_path',
  BF_GAP_FRAGILE:                  'bf_gap_fragile',
  BF_GAP_DEAD:                     'bf_gap_dead',
  // NO natural-bucket
  NO_PATH_AMPLE_CUSHION:           'no_path_ample_cushion',
  NO_PATH_AT_STRIKE_LAMBDA:        'no_path_at_strike_lambda',
  NO_PATH_THIN:                    'no_path_thin',
  NO_PATH_OVERRUN:                 'no_path_overrun',
})

// ────────────────────────────────────────────────────────────────────
// Threshold constants (mirrors SPEC.md §4)
// ────────────────────────────────────────────────────────────────────

export const BF_GAP_RATIO_STRONG_MAX  = -0.10
export const BF_GAP_RATIO_VIABLE_MAX  = +0.05
export const BF_GAP_RATIO_FRAGILE_MAX = +0.20
export const GAP_UNDER_STRONG_MIN     = +1.5
export const GAP_UNDER_VIABLE_MIN     = +0.5
export const GAP_UNDER_FRAGILE_MIN    = -0.5
export const TAIL_STRIKE_FRAGILE_MIN  = 9
export const TAIL_STRIKE_DEAD_MIN     = 10
export const TAIL_DEAD_RATIO          = 0.10
export const PK_EXTREME_FRAGILE       = 0.38
export const PK_EXTREME_DEAD          = 0.45
export const LEAGUE_PITCHES_PER_BF    = 3.8
export const SHORT_WORKLOAD_PITCH_MAX = 80

const VALID_BF_TIERS = new Set(['strong', 'medium', 'weak', 'unknown'])

// ────────────────────────────────────────────────────────────────────
// Math helpers — pure arithmetic
// ────────────────────────────────────────────────────────────────────

export function requiredBf(strike, pK_blended) {
  if (!Number.isFinite(strike) || strike < 0) {
    throw new Error('requiredBf: strike must be non-negative finite')
  }
  if (!Number.isFinite(pK_blended) || pK_blended <= 0) {
    throw new Error('requiredBf: pK_blended must be > 0 finite')
  }
  return strike / pK_blended
}

export function requiredBfOuter(strike, expectedBf, lambdaFinal) {
  if (!Number.isFinite(strike) || strike < 0) {
    throw new Error('requiredBfOuter: strike must be non-negative finite')
  }
  if (!Number.isFinite(expectedBf) || expectedBf <= 0) {
    throw new Error('requiredBfOuter: expectedBf must be > 0 finite')
  }
  if (!Number.isFinite(lambdaFinal) || lambdaFinal <= 0) {
    throw new Error('requiredBfOuter: lambdaFinal must be > 0 finite')
  }
  return strike * expectedBf / lambdaFinal
}

export function bfGap(requiredBfVal, expectedBf) {
  if (!Number.isFinite(requiredBfVal)) throw new Error('bfGap: requiredBf must be finite')
  if (!Number.isFinite(expectedBf))    throw new Error('bfGap: expectedBf must be finite')
  return requiredBfVal - expectedBf
}

export function bfGapRatio(requiredBfVal, expectedBf) {
  if (!Number.isFinite(requiredBfVal)) {
    throw new Error('bfGapRatio: requiredBf must be finite')
  }
  if (!Number.isFinite(expectedBf) || expectedBf === 0) {
    throw new Error('bfGapRatio: expectedBf must be non-zero finite')
  }
  return (requiredBfVal - expectedBf) / expectedBf
}

export function gapUnder(strike, lambdaFinal) {
  if (!Number.isFinite(strike))      throw new Error('gapUnder: strike must be finite')
  if (!Number.isFinite(lambdaFinal)) throw new Error('gapUnder: lambdaFinal must be finite')
  return strike - lambdaFinal
}

export function requiredPk(strike, expectedBf) {
  if (!Number.isFinite(strike) || strike < 0) {
    throw new Error('requiredPk: strike must be non-negative finite')
  }
  if (!Number.isFinite(expectedBf) || expectedBf <= 0) {
    throw new Error('requiredPk: expectedBf must be > 0 finite')
  }
  return strike / expectedBf
}

// avg_pitches null/undefined/NaN/<=0 → no ceiling (legitimate state).
export function bfCeiling(avgPitches) {
  if (!Number.isFinite(avgPitches) || avgPitches <= 0) return null
  return avgPitches / LEAGUE_PITCHES_PER_BF
}

// ────────────────────────────────────────────────────────────────────
// Tier helpers
// ────────────────────────────────────────────────────────────────────

const _tierIdx = (t) => TIER_ORDER.indexOf(t)

export function capTier(currentTier, ceilingTier) {
  const a = _tierIdx(currentTier)
  const b = _tierIdx(ceilingTier)
  if (a < 0 || b < 0) {
    throw new Error(`capTier: invalid tier(s): "${currentTier}", "${ceilingTier}"`)
  }
  return TIER_ORDER[Math.min(a, b)]
}

export function upgradeTier(currentTier, byCount = 1) {
  const a = _tierIdx(currentTier)
  if (a < 0) throw new Error(`upgradeTier: invalid tier "${currentTier}"`)
  if (!Number.isInteger(byCount) || byCount < 0) {
    throw new Error('upgradeTier: byCount must be non-negative integer')
  }
  const newIdx = Math.min(TIER_ORDER.length - 1, a + byCount)
  return TIER_ORDER[newIdx]
}

// Boundary semantics from SPEC §4b:
//   ratio ≤ -0.10        → strong
//   -0.10 < ratio ≤ +0.05 → viable
//   +0.05 < ratio ≤ +0.20 → fragile
//   ratio > +0.20         → dead
export function yesBaseBucket(bfGapRatioVal) {
  if (!Number.isFinite(bfGapRatioVal)) {
    throw new Error('yesBaseBucket: bfGapRatio must be finite')
  }
  if (bfGapRatioVal <= BF_GAP_RATIO_STRONG_MAX)  return FEASIBILITY_CLASSES.STRONG
  if (bfGapRatioVal <= BF_GAP_RATIO_VIABLE_MAX)  return FEASIBILITY_CLASSES.VIABLE
  if (bfGapRatioVal <= BF_GAP_RATIO_FRAGILE_MAX) return FEASIBILITY_CLASSES.FRAGILE
  return FEASIBILITY_CLASSES.DEAD
}

// SPEC §4c:
//   gap_under ≥ +1.5            → strong
//   +0.5 ≤ gap_under < +1.5     → viable
//   -0.5 ≤ gap_under < +0.5     → fragile
//   gap_under < -0.5            → dead
export function noBaseBucket(gapUnderVal) {
  if (!Number.isFinite(gapUnderVal)) {
    throw new Error('noBaseBucket: gapUnder must be finite')
  }
  if (gapUnderVal >= GAP_UNDER_STRONG_MIN)  return FEASIBILITY_CLASSES.STRONG
  if (gapUnderVal >= GAP_UNDER_VIABLE_MIN)  return FEASIBILITY_CLASSES.VIABLE
  if (gapUnderVal >= GAP_UNDER_FRAGILE_MIN) return FEASIBILITY_CLASSES.FRAGILE
  return FEASIBILITY_CLASSES.DEAD
}

// ────────────────────────────────────────────────────────────────────
// Input validation (shared between classifyYes and classifyNo)
// ────────────────────────────────────────────────────────────────────

function validateRequiredInputs(input, fnName) {
  if (!input || typeof input !== 'object') {
    throw new Error(`${fnName}: input object required`)
  }
  const { strike, expected_bf, pK_blended, lambda_final, bf_source_tier } = input
  if (!Number.isFinite(strike)) {
    throw new Error(`${fnName}: strike must be finite (got ${strike})`)
  }
  if (!Number.isInteger(strike)) {
    throw new Error(`${fnName}: strike must be integer (got ${strike})`)
  }
  if (strike < 0) {
    throw new Error(`${fnName}: strike must be non-negative (got ${strike})`)
  }
  if (!Number.isFinite(expected_bf) || expected_bf <= 0) {
    throw new Error(`${fnName}: expected_bf must be > 0 finite (got ${expected_bf})`)
  }
  if (!Number.isFinite(pK_blended) || pK_blended <= 0) {
    throw new Error(`${fnName}: pK_blended must be > 0 finite (got ${pK_blended})`)
  }
  if (!Number.isFinite(lambda_final) || lambda_final <= 0) {
    throw new Error(`${fnName}: lambda_final must be > 0 finite (got ${lambda_final})`)
  }
  if (!VALID_BF_TIERS.has(bf_source_tier)) {
    throw new Error(`${fnName}: bf_source_tier must be one of strong/medium/weak/unknown (got ${JSON.stringify(bf_source_tier)})`)
  }
}

// ────────────────────────────────────────────────────────────────────
// classifyYes — SPEC §4i YES order of operations
// ────────────────────────────────────────────────────────────────────
//
// Input:
//   { strike, expected_bf, pK_blended, lambda_final, bf_source_tier,
//     avg_pitches?, dk_blend_applied? }
//
// Output:
//   { feasibility, reason_code, secondary_reasons,
//     required_bf, required_bf_outer, bf_gap, bf_gap_ratio,
//     bf_ceiling, required_pk, gap_under }
// ────────────────────────────────────────────────────────────────────

export function classifyYes(input) {
  validateRequiredInputs(input, 'classifyYes')
  const { strike, expected_bf, pK_blended, lambda_final, bf_source_tier } = input
  const avg_pitches      = Number.isFinite(input.avg_pitches) ? input.avg_pitches : null
  const dk_blend_applied = !!input.dk_blend_applied

  // Diagnostics
  const r_bf       = requiredBf(strike, pK_blended)
  const r_bf_outer = requiredBfOuter(strike, expected_bf, lambda_final)
  const r_pk       = requiredPk(strike, expected_bf)
  const _bfGap     = r_bf - expected_bf
  const _bfRatio   = _bfGap / expected_bf
  const _bfCeiling = bfCeiling(avg_pitches)
  const _gapUnder  = strike - lambda_final

  // Trigger order is preserved by appending in evaluation order.
  const triggered = []
  const addReason = (c) => { if (!triggered.includes(c)) triggered.push(c) }

  // ── Step 1: Hard-dead checks (precedence: workload > pk > tail) ──
  let hardDead = null
  if (_bfCeiling != null && r_bf > _bfCeiling) {
    addReason(REASON_CODES.WORKLOAD_CEILING)
    if (!hardDead) hardDead = REASON_CODES.WORKLOAD_CEILING
  }
  if (r_pk > PK_EXTREME_DEAD) {
    addReason(REASON_CODES.PK_EXTREME_DEAD)
    if (!hardDead) hardDead = REASON_CODES.PK_EXTREME_DEAD
  }
  if (strike >= TAIL_STRIKE_DEAD_MIN && _bfRatio > TAIL_DEAD_RATIO) {
    addReason(REASON_CODES.TAIL_DEAD_HIGH_STRIKE)
    if (!hardDead) hardDead = REASON_CODES.TAIL_DEAD_HIGH_STRIKE
  }
  if (hardDead) {
    return {
      feasibility:        FEASIBILITY_CLASSES.DEAD,
      reason_code:        hardDead,
      secondary_reasons:  triggered.filter(c => c !== hardDead),
      required_bf:        r_bf,
      required_bf_outer:  r_bf_outer,
      bf_gap:             _bfGap,
      bf_gap_ratio:       _bfRatio,
      bf_ceiling:         _bfCeiling,
      required_pk:        r_pk,
      gap_under:          _gapUnder,
    }
  }

  // ── Step 2: Baseline tier from bf_gap_ratio ──
  const baseTier = yesBaseBucket(_bfRatio)
  const baseReason =
    baseTier === FEASIBILITY_CLASSES.STRONG  ? REASON_CODES.COMFORTABLE_BUFFER
  : baseTier === FEASIBILITY_CLASSES.VIABLE  ? REASON_CODES.NORMAL_PATH
  : baseTier === FEASIBILITY_CLASSES.FRAGILE ? REASON_CODES.BF_GAP_FRAGILE
                                              : REASON_CODES.BF_GAP_DEAD
  let tier = baseTier

  // ── Step 3: Apply caps (each lowers tier toward fragile/viable) ──
  // pk_extreme_fragile (cap at fragile)
  if (r_pk > PK_EXTREME_FRAGILE) {
    addReason(REASON_CODES.PK_EXTREME_FRAGILE)
    tier = capTier(tier, FEASIBILITY_CLASSES.FRAGILE)
  }
  // tail_fragile_high_strike (cap at fragile, when strike ≥ 9 AND bf_gap > 0)
  if (strike >= TAIL_STRIKE_FRAGILE_MIN && _bfGap > 0) {
    addReason(REASON_CODES.TAIL_FRAGILE_HIGH_STRIKE)
    tier = capTier(tier, FEASIBILITY_CLASSES.FRAGILE)
  }
  // bf_source_weak_cap (cap at viable; SKIPPED when dk_blend_applied)
  let weakCapLowered = false
  if (bf_source_tier === 'weak' && !dk_blend_applied) {
    const before = tier
    tier = capTier(tier, FEASIBILITY_CLASSES.VIABLE)
    addReason(REASON_CODES.BF_SOURCE_WEAK_CAP)
    weakCapLowered = (tier !== before)
  }

  // ── Step 4: Determine primary reason_code ──
  // Precedence:
  //   1) most-restrictive cap that ACTUALLY lowered the tier (i.e. a
  //      fragile-level cap when baseline was strong/viable, with
  //      pk_extreme_fragile beating tail_fragile_high_strike)
  //   2) weak-source cap if it actually lowered the tier
  //   3) natural-bucket reason
  let primary = baseReason
  const fragileCapsActive =
    _tierIdx(baseTier) > _tierIdx(FEASIBILITY_CLASSES.FRAGILE) &&
    (triggered.includes(REASON_CODES.PK_EXTREME_FRAGILE) ||
     triggered.includes(REASON_CODES.TAIL_FRAGILE_HIGH_STRIKE))
  if (fragileCapsActive) {
    primary = triggered.includes(REASON_CODES.PK_EXTREME_FRAGILE)
      ? REASON_CODES.PK_EXTREME_FRAGILE
      : REASON_CODES.TAIL_FRAGILE_HIGH_STRIKE
  } else if (weakCapLowered) {
    primary = REASON_CODES.BF_SOURCE_WEAK_CAP
  }

  return {
    feasibility:        tier,
    reason_code:        primary,
    secondary_reasons:  triggered.filter(c => c !== primary),
    required_bf:        r_bf,
    required_bf_outer:  r_bf_outer,
    bf_gap:             _bfGap,
    bf_gap_ratio:       _bfRatio,
    bf_ceiling:         _bfCeiling,
    required_pk:        r_pk,
    gap_under:          _gapUnder,
  }
}

// ────────────────────────────────────────────────────────────────────
// classifyNo — SPEC §4i NO order of operations
//
// Dead-baseline cap (Q-L2.2.I lock):
//   A NO baseline = dead can climb at most one tier (to fragile),
//   regardless of how many modifiers fire. Non-dead baselines stack
//   modifiers normally with cap at strong.
// ────────────────────────────────────────────────────────────────────

export function classifyNo(input) {
  validateRequiredInputs(input, 'classifyNo')
  const { strike, expected_bf, pK_blended, lambda_final, bf_source_tier } = input
  const avg_pitches      = Number.isFinite(input.avg_pitches) ? input.avg_pitches : null
  const dk_blend_applied = !!input.dk_blend_applied
  const leash_flag       = !!input.leash_flag

  // Diagnostics
  const r_bf       = requiredBf(strike, pK_blended)
  const r_bf_outer = requiredBfOuter(strike, expected_bf, lambda_final)
  const r_pk       = requiredPk(strike, expected_bf)
  const _bfGap     = r_bf - expected_bf
  const _bfRatio   = _bfGap / expected_bf
  const _bfCeiling = bfCeiling(avg_pitches)
  const _gapUnder  = strike - lambda_final

  const triggered = []
  const addReason = (c) => { if (!triggered.includes(c)) triggered.push(c) }

  // ── Step 1: Baseline tier from gap_under ──
  const baseTier = noBaseBucket(_gapUnder)
  const baseReason =
    baseTier === FEASIBILITY_CLASSES.STRONG  ? REASON_CODES.NO_PATH_AMPLE_CUSHION
  : baseTier === FEASIBILITY_CLASSES.VIABLE  ? REASON_CODES.NO_PATH_AT_STRIKE_LAMBDA
  : baseTier === FEASIBILITY_CLASSES.FRAGILE ? REASON_CODES.NO_PATH_THIN
                                              : REASON_CODES.NO_PATH_OVERRUN
  let tier = baseTier

  // ── Step 2: Support modifiers (precedence: leash > ceiling > short_workload) ──
  let upgradesApplied = 0
  if (leash_flag) {
    addReason(REASON_CODES.LEASH_SUPPORTS_NO)
    upgradesApplied++
  }
  if (_bfCeiling != null && _bfCeiling < r_bf) {
    addReason(REASON_CODES.WORKLOAD_CEILING_SUPPORTS_NO)
    upgradesApplied++
  }
  if (avg_pitches != null && avg_pitches < SHORT_WORKLOAD_PITCH_MAX) {
    addReason(REASON_CODES.SHORT_WORKLOAD_SUPPORTS_NO)
    upgradesApplied++
  }

  // Apply with dead-cap rule: dead baseline upgrades at most one tier.
  if (upgradesApplied > 0) {
    const isDeadBaseline = (baseTier === FEASIBILITY_CLASSES.DEAD)
    const cappedUpgrades = isDeadBaseline ? Math.min(1, upgradesApplied) : upgradesApplied
    tier = upgradeTier(tier, cappedUpgrades)
  }

  // ── Step 3: Weak-source cap (SKIPPED when dk_blend_applied) ──
  let weakCapLowered = false
  if (bf_source_tier === 'weak' && !dk_blend_applied) {
    const before = tier
    tier = capTier(tier, FEASIBILITY_CLASSES.VIABLE)
    addReason(REASON_CODES.BF_SOURCE_WEAK_CAP)
    weakCapLowered = (tier !== before)
  }

  // ── Step 4: Primary reason_code ──
  // Precedence:
  //   1) weak-source cap if it actually lowered the tier
  //   2) highest-priority modifier (leash > ceiling > short) that
  //      caused an upgrade vs baseline (i.e. tier changed)
  //   3) natural-bucket reason
  let primary = baseReason
  if (weakCapLowered) {
    primary = REASON_CODES.BF_SOURCE_WEAK_CAP
  } else if (upgradesApplied > 0 && tier !== baseTier) {
    if (triggered.includes(REASON_CODES.LEASH_SUPPORTS_NO)) {
      primary = REASON_CODES.LEASH_SUPPORTS_NO
    } else if (triggered.includes(REASON_CODES.WORKLOAD_CEILING_SUPPORTS_NO)) {
      primary = REASON_CODES.WORKLOAD_CEILING_SUPPORTS_NO
    } else if (triggered.includes(REASON_CODES.SHORT_WORKLOAD_SUPPORTS_NO)) {
      primary = REASON_CODES.SHORT_WORKLOAD_SUPPORTS_NO
    }
  }

  return {
    feasibility:        tier,
    reason_code:        primary,
    secondary_reasons:  triggered.filter(c => c !== primary),
    required_bf:        r_bf,
    required_bf_outer:  r_bf_outer,
    bf_gap:             _bfGap,
    bf_gap_ratio:       _bfRatio,
    bf_ceiling:         _bfCeiling,
    required_pk:        r_pk,
    gap_under:          _gapUnder,
  }
}

// ────────────────────────────────────────────────────────────────────
// Module metadata
// ────────────────────────────────────────────────────────────────────

export const HELPER_NAME    = 'oracle_layer_2_path.feasibility'
export const HELPER_VERSION = '1.0.0'
