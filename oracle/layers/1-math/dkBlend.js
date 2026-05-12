// oracle/layers/1-math/dkBlend.js
//
// Bite 6.1 — DK line workload-prior helpers (pure functions, no I/O).
//
// PURPOSE
//   Convert a DK over/under K line + over implied probability into a
//   bounded BF (workload) adjustment. Wired to be called from a future
//   Layer 1 v1.1 path, AFTER computeInner() and BEFORE composeOuter().
//   No integration into impl.js yet (that is Bite 6.2).
//
// DESIGN (locked Bite 6 v1)
//   - Blend at E[BF], not at λ_base or pK. DK is interpreted as a
//     workload/leash sanity prior, not a skill correction.
//   - Bounded: |BF_dk - BF_ours| > bf_cap_K  →  SKIP (do not clip).
//   - Class-gated: weight schedule by THIN / MID / STABLE thinness class.
//   - Stable veterans get w=0; do not let DK move our number.
//   - Helper is OBSERVATIONAL — it always returns counterfactual fields
//     (dk_lambda, bf_dk, bf_delta) even when applied:false. Caller
//     decides whether to use the blended values, and Bite 6.2 will
//     gate the decision on a flag (DK_BLEND_ENABLED, default false).
//
// VIG CAVEAT
//   dk_k_props.over_price is the BOOK's implied probability — it
//   includes vig. The fetcher does not store under_price, so we cannot
//   vig-adjust by the standard renormalization. Direction of bias:
//   over_price overstates fair P(over) by 2-3 percentage points, which
//   biases λ_dk upward by a few tenths of a K. v1 accepts this; the
//   backtest in Bite 6.3 will show whether the signal survives the
//   bias. v1.1 may add under_price to the schema and vig-adjust.
//
// PIPELINE
//   inner = computeInner(inputs)
//   blend = blendBF({
//     expected_bf_ours: inner.expectedBF,
//     pK_ours:          inner.pK_blended,    // pK_final, post-everything
//     dk_line, over_price,
//     r:                archetypeR(savant),
//     klass:            classifyThinness(inner, savant),
//   })
//   if blend.applied: pass blend.lambda_base_blended to composeOuter
//   else:             pass inner.lambdaBase to composeOuter (unchanged)

import { nbCDF, pAtLeast, NB_R } from '../../../lib/strikeout-model.js'

// ────────────────────────────────────────────────────────────────────────
// invertLambda — binary-search invert of pAtLeast.
//
//   targetProb  P(K ≥ n) in (0,1)
//   n           integer K threshold
//   r           NB dispersion (positive finite)
//
// Returns lambda such that pAtLeast(lambda, n, r) ≈ targetProb.
// Mirrors the helper at scripts/clv/validate-apr28-fixes.js:10 so
// behavior is consistent across the repo.
// ────────────────────────────────────────────────────────────────────────
export function invertLambda(targetProb, n, r = NB_R) {
  if (!Number.isFinite(targetProb)) {
    throw new Error('invertLambda: targetProb must be finite')
  }
  if (targetProb >= 0.999) return 999
  if (targetProb <= 0.001) return 0
  if (!Number.isInteger(n) || n < 0) {
    throw new Error('invertLambda: n must be non-negative integer')
  }
  if (!Number.isFinite(r) || r <= 0) {
    throw new Error('invertLambda: r must be positive finite')
  }
  let lo = 0.01, hi = 30
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2
    const p = pAtLeast(mid, n, r)
    if (p < targetProb) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

// ────────────────────────────────────────────────────────────────────────
// dkLineToK — DK over/under line → K threshold whose probability is
// represented by over_price.
//
//   line=7.5 → 8 (Over 7.5 = K ≥ 8)
//   line=7   → 8 (Over 7 = K ≥ 8 in practice; pushes on exact 7)
//   line=0.5 → 1
// ────────────────────────────────────────────────────────────────────────
export function dkLineToK(dkLine) {
  if (!Number.isFinite(dkLine) || dkLine < 0) {
    throw new Error('dkLineToK: dkLine must be a non-negative finite number')
  }
  return Math.floor(dkLine) + 1
}

// ────────────────────────────────────────────────────────────────────────
// bfSourceTier — classify inner.bfSource string into a quality tier.
//
// Tiers reflect data quality of the workload (E[BF]) source. Modifiers
// like "(NNpc)", "→capped(...)", "×leash(...)" are ignored — only the
// prefix matters.
// ────────────────────────────────────────────────────────────────────────
export const BF_SOURCE_TIERS = Object.freeze({
  STRONG:  'strong',
  MEDIUM:  'medium',
  WEAK:    'weak',
  UNKNOWN: 'unknown',
})

export function bfSourceTier(bfSource) {
  if (!bfSource || typeof bfSource !== 'string') return BF_SOURCE_TIERS.UNKNOWN
  if (bfSource.startsWith('BF×'))             return BF_SOURCE_TIERS.STRONG
  if (bfSource.startsWith('logBF×'))          return BF_SOURCE_TIERS.MEDIUM
  if (bfSource.startsWith('ip×PA/IP'))        return BF_SOURCE_TIERS.WEAK
  if (bfSource.startsWith('career_ip×PA/IP')) return BF_SOURCE_TIERS.WEAK
  return BF_SOURCE_TIERS.UNKNOWN
}

// ────────────────────────────────────────────────────────────────────────
// classifyThinness — produce one of THIN | MID | STABLE.
//
// THIN if any of:
//   savant == null
//   savant.ip < 5
//   inner.nStarts < 3
//   savant.manager_leash_factor < 0.95
//   bfSourceTier(inner.bfSource) === 'weak'
//
// STABLE if all of:
//   savant != null
//   savant.ip >= 30
//   inner.nStarts >= 5
//   savant.manager_leash_factor null OR >= 0.95
//   bfSourceTier(inner.bfSource) === 'strong'
//
// Else MID.
//
// Edge cases (locked):
//   ip === 30                   stable-eligible (>=)
//   leash === 0.95              stable-eligible (>=)
//   leash absent (null)         stable-eligible
//   bfSourceTier 'medium'       neither thin nor stable → mid
//   bfSourceTier 'unknown'      neither thin nor stable → mid
// ────────────────────────────────────────────────────────────────────────
export const THINNESS_CLASSES = Object.freeze({
  THIN:   'thin',
  MID:    'mid',
  STABLE: 'stable',
})

export function classifyThinness(inner, savant) {
  const tier    = bfSourceTier(inner?.bfSource)
  const nStarts = inner?.nStarts
  const ip      = savant?.ip
  const leash   = savant?.manager_leash_factor

  // THIN if any of:
  if (savant == null) return THINNESS_CLASSES.THIN
  if (typeof ip      === 'number' && ip < 5)         return THINNESS_CLASSES.THIN
  if (typeof nStarts === 'number' && nStarts < 3)    return THINNESS_CLASSES.THIN
  if (typeof leash   === 'number' && leash < 0.95)   return THINNESS_CLASSES.THIN
  if (tier === BF_SOURCE_TIERS.WEAK)                 return THINNESS_CLASSES.THIN

  // STABLE if all of:
  if (
    savant != null
    && typeof ip      === 'number' && ip >= 30
    && typeof nStarts === 'number' && nStarts >= 5
    && (leash == null || (typeof leash === 'number' && leash >= 0.95))
    && tier === BF_SOURCE_TIERS.STRONG
  ) {
    return THINNESS_CLASSES.STABLE
  }

  return THINNESS_CLASSES.MID
}

// ────────────────────────────────────────────────────────────────────────
// w_dk schedule — production candidate (pending Bite 6.3 backtest).
// Bite 6.3 will sweep:
//   THIN   : {0.00, 0.10, 0.20, 0.30, 0.40}
//   MID    : {0.00, 0.05, 0.10}
//   STABLE : {0.00}
// ────────────────────────────────────────────────────────────────────────
export const DEFAULT_W_DK_SCHEDULE = Object.freeze({
  thin:   0.20,
  mid:    0.05,
  stable: 0.00,
})

export function wDkForClass(klass, schedule = DEFAULT_W_DK_SCHEDULE) {
  if (!schedule) return 0
  const w = schedule[klass]
  if (typeof w !== 'number') return 0
  if (!Number.isFinite(w) || w < 0 || w > 1) return 0
  return w
}

// ────────────────────────────────────────────────────────────────────────
// SKIP_REASONS — vocabulary for blend skip outcomes.
//
//   no_dk_line     dk_line missing or invalid
//   no_over_price  over_price missing, ≤0, or ≥1
//   no_pk          pK_ours missing or ≤0
//   invalid_inputs other input failed validation (BF, r)
//   cap            BF delta exceeded bf_cap_K → skip (not clip)
//   stable         classified stable; w_dk = 0 by design
//   zero_weight    schedule resolved w_dk to 0 for non-stable class
// ────────────────────────────────────────────────────────────────────────
export const SKIP_REASONS = Object.freeze({
  NO_DK_LINE:     'no_dk_line',
  NO_OVER_PRICE:  'no_over_price',
  NO_PK:          'no_pk',
  INVALID_INPUTS: 'invalid_inputs',
  CAP:            'cap',
  STABLE:         'stable',
  ZERO_WEIGHT:    'zero_weight',
})

export const DEFAULT_BF_CAP_K = 3.0

// ────────────────────────────────────────────────────────────────────────
// blendBF — apply the DK BF blend with cap-skip.
//
// Inputs:
//   expected_bf_ours  E[BF] from inner.expectedBF (>0)
//   pK_ours           inner.pK_blended (>0)
//   dk_line           DK over/under line (e.g. 7.5)
//   over_price        DK over implied probability in (0,1) (vig included)
//   r                 NB dispersion, archetypeR(savant) (>0)
//   klass             classifyThinness output: 'thin'|'mid'|'stable'
//   schedule          (optional) w_dk schedule override
//   bf_cap_K          (optional) cap for |bf_delta|; default 3.0
//
// Returns:
//   {
//     applied:               boolean — whether the blend changed E[BF]
//     skip_reason:           null | <one of SKIP_REASONS>
//     w_dk:                  number — weight that resolved (0 when skipped)
//     dk_lambda:             number | null — λ_dk implied by DK
//     bf_dk:                 number | null — λ_dk / pK_ours
//     bf_delta:              number | null — bf_dk - expected_bf_ours
//     expected_bf_blended:   number — equals expected_bf_ours when not applied
//     lambda_base_blended:   number — equals expected_bf_ours * pK_ours when not applied
//   }
//
// Counterfactual fields (dk_lambda, bf_dk, bf_delta) are populated as
// far as inputs allow, even when applied:false, so callers (Bite 6.2)
// can log shadow values without changing money decisions.
// ────────────────────────────────────────────────────────────────────────
export function blendBF({
  expected_bf_ours,
  pK_ours,
  dk_line,
  over_price,
  r,
  klass,
  schedule = DEFAULT_W_DK_SCHEDULE,
  bf_cap_K = DEFAULT_BF_CAP_K,
}) {
  const safeProduct = Number.isFinite(expected_bf_ours) && Number.isFinite(pK_ours)
    ? expected_bf_ours * pK_ours
    : NaN

  const out = {
    applied:             false,
    skip_reason:         null,
    w_dk:                0,
    dk_lambda:           null,
    bf_dk:               null,
    bf_delta:            null,
    expected_bf_blended: expected_bf_ours,
    lambda_base_blended: safeProduct,
  }

  // Validate model inputs first
  if (!Number.isFinite(expected_bf_ours) || expected_bf_ours <= 0) {
    out.skip_reason = SKIP_REASONS.INVALID_INPUTS
    return out
  }
  if (!Number.isFinite(pK_ours) || pK_ours <= 0) {
    out.skip_reason = SKIP_REASONS.NO_PK
    return out
  }
  if (!Number.isFinite(r) || r <= 0) {
    out.skip_reason = SKIP_REASONS.INVALID_INPUTS
    return out
  }

  // No DK data → no blend
  if (!Number.isFinite(dk_line) || dk_line < 0) {
    out.skip_reason = SKIP_REASONS.NO_DK_LINE
    return out
  }
  if (!Number.isFinite(over_price) || over_price <= 0 || over_price >= 1) {
    out.skip_reason = SKIP_REASONS.NO_OVER_PRICE
    return out
  }

  // Compute λ_dk and BF_dk regardless of weight (counterfactual visibility)
  const n = dkLineToK(dk_line)
  const lambda_dk = invertLambda(over_price, n, r)
  const bf_dk = lambda_dk / pK_ours
  const bf_delta = bf_dk - expected_bf_ours
  out.dk_lambda = lambda_dk
  out.bf_dk = bf_dk
  out.bf_delta = bf_delta

  // Cap check — SKIP, not clip
  if (Math.abs(bf_delta) > bf_cap_K) {
    out.skip_reason = SKIP_REASONS.CAP
    return out
  }

  // Resolve weight by class
  const w_dk = wDkForClass(klass, schedule)
  out.w_dk = w_dk

  if (w_dk === 0) {
    out.skip_reason = klass === THINNESS_CLASSES.STABLE
      ? SKIP_REASONS.STABLE
      : SKIP_REASONS.ZERO_WEIGHT
    return out
  }

  // Apply
  const bf_blended = (1 - w_dk) * expected_bf_ours + w_dk * bf_dk
  out.expected_bf_blended = bf_blended
  out.lambda_base_blended = bf_blended * pK_ours
  out.applied = true
  return out
}

// Module metadata
export const HELPER_NAME = 'oracle_layer_1_math.dkBlend'
export const HELPER_VERSION = '1.0.0'
