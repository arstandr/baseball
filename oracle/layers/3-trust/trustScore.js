// oracle/layers/3-trust/trustScore.js
//
// Layer 3 (Trust) — pure helpers.
//
// Translates SPEC.md §4 into deterministic functions. No I/O.
// L3.4 wires these into a per-bet run() with Trace integration.

// ─── Vocabulary ──────────────────────────────────────────────────────

export const TRUST_LEVELS = Object.freeze({
  HIGH:   'high',
  MEDIUM: 'medium',
  LOW:    'low',
})

export const REASON_CODES = Object.freeze({
  HIGH_TRUST:                   'high_trust',
  FEASIBILITY_DEAD:             'feasibility_dead',
  FEASIBILITY_FRAGILE:          'feasibility_fragile',
  FEASIBILITY_VIABLE:           'feasibility_viable',
  BF_SOURCE_WEAK:               'bf_source_weak',
  BF_SOURCE_WEAK_DK_PROTECTED:  'bf_source_weak_dk_protected',
  BF_SOURCE_MEDIUM:             'bf_source_medium',
  BF_SOURCE_UNKNOWN:            'bf_source_unknown',
  CONFIDENCE_LOW:               'confidence_low',
  CONFIDENCE_MEDIUM:            'confidence_medium',
  CONFIDENCE_UNKNOWN:           'confidence_unknown',
})

// ─── Threshold constants (mirrors SPEC.md §4) ────────────────────────

export const TRUST_HIGH_MIN   = 0.70
export const TRUST_MEDIUM_MIN = 0.40
export const HIGH_TRUST_BONUS_MIN = 0.85   // raw score above this with no
                                            // downgrades → reason='high_trust'

export const FEASIBILITY_FACTOR = Object.freeze({
  strong:  1.00,
  viable:  0.80,
  fragile: 0.40,
  dead:    0.00,
})

export const BF_SOURCE_FACTOR_NO_DK = Object.freeze({
  strong:  1.00,
  medium:  0.85,
  weak:    0.60,
  unknown: 0.70,
})

export const BF_SOURCE_FACTOR_DK = Object.freeze({
  strong:  1.00,
  medium:  0.90,
  weak:    0.85,
  unknown: 0.85,
})

export const CONFIDENCE_FACTOR = Object.freeze({
  high:    1.00,
  medium:  0.85,
  low:     0.70,
  unknown: 0.70,
})

const VALID_FEASIBILITIES = new Set(['strong', 'viable', 'fragile', 'dead'])
const VALID_BF_TIERS      = new Set(['strong', 'medium', 'weak', 'unknown'])

// ─── Helpers ─────────────────────────────────────────────────────────

// Parse confidence prefix from inner.confidence string like
// 'high(career+savant+l5)' → 'high'.
export function parseConfidence(confidenceStr) {
  if (!confidenceStr || typeof confidenceStr !== 'string') return 'unknown'
  const lower = confidenceStr.toLowerCase()
  if (lower.startsWith('high'))   return 'high'
  if (lower.startsWith('medium')) return 'medium'
  if (lower.startsWith('low'))    return 'low'
  return 'unknown'
}

export function trustLevelForScore(score) {
  if (!Number.isFinite(score)) throw new Error('trustLevelForScore: score must be finite')
  if (score >= TRUST_HIGH_MIN)   return TRUST_LEVELS.HIGH
  if (score >= TRUST_MEDIUM_MIN) return TRUST_LEVELS.MEDIUM
  return TRUST_LEVELS.LOW
}

// ─── Main scorer ─────────────────────────────────────────────────────

/**
 * scoreTrust(input)
 *
 * input:
 *   feasibility:        'strong'|'viable'|'fragile'|'dead'    (required)
 *   bf_source_tier:     'strong'|'medium'|'weak'|'unknown'    (required)
 *   confidence:         'high'|'medium'|'low'|'unknown'       (required)
 *   dk_blend_applied:   boolean                                (default false)
 *
 * Returns:
 *   { trust_score, trust_level,
 *     feasibility_factor, bf_source_factor, confidence_factor, dk_blend_factor,
 *     reason_code, reason_codes }
 */
export function scoreTrust(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('scoreTrust: input object required')
  }
  const { feasibility, bf_source_tier, confidence } = input
  const dk_blend_applied = !!input.dk_blend_applied

  if (!VALID_FEASIBILITIES.has(feasibility)) {
    throw new Error(`scoreTrust: invalid feasibility "${feasibility}"`)
  }
  if (!VALID_BF_TIERS.has(bf_source_tier)) {
    throw new Error(`scoreTrust: invalid bf_source_tier "${bf_source_tier}"`)
  }
  if (!CONFIDENCE_FACTOR[confidence]) {
    throw new Error(`scoreTrust: invalid confidence "${confidence}"`)
  }

  const feasibility_factor = FEASIBILITY_FACTOR[feasibility]
  const bf_source_factor   = (dk_blend_applied ? BF_SOURCE_FACTOR_DK : BF_SOURCE_FACTOR_NO_DK)[bf_source_tier]
  const confidence_factor  = CONFIDENCE_FACTOR[confidence]
  const dk_blend_factor    = 1.00   // reserved for future tuning

  const trust_score_raw = feasibility_factor * bf_source_factor * confidence_factor * dk_blend_factor
  const trust_score = feasibility === 'dead' ? 0 : Math.max(0, Math.min(1, trust_score_raw))
  const trust_level = trustLevelForScore(trust_score)

  // Collect reason codes in trigger-evaluation order.
  const reasons = []
  const add = (c) => { if (!reasons.includes(c)) reasons.push(c) }

  if (feasibility === 'dead')         add(REASON_CODES.FEASIBILITY_DEAD)
  else if (feasibility === 'fragile') add(REASON_CODES.FEASIBILITY_FRAGILE)
  else if (feasibility === 'viable')  add(REASON_CODES.FEASIBILITY_VIABLE)

  if (bf_source_tier === 'weak') {
    add(dk_blend_applied
      ? REASON_CODES.BF_SOURCE_WEAK_DK_PROTECTED
      : REASON_CODES.BF_SOURCE_WEAK)
  } else if (bf_source_tier === 'medium') {
    add(REASON_CODES.BF_SOURCE_MEDIUM)
  } else if (bf_source_tier === 'unknown') {
    add(REASON_CODES.BF_SOURCE_UNKNOWN)
  }

  if (confidence === 'low')          add(REASON_CODES.CONFIDENCE_LOW)
  else if (confidence === 'medium')  add(REASON_CODES.CONFIDENCE_MEDIUM)
  else if (confidence === 'unknown') add(REASON_CODES.CONFIDENCE_UNKNOWN)

  // Primary reason = the factor that did the most damage. Pick the
  // factor with the lowest value among non-1.0 factors (ties broken
  // by category priority: feasibility > bf_source > confidence).
  let primary
  if (feasibility === 'dead') {
    primary = REASON_CODES.FEASIBILITY_DEAD
  } else if (reasons.length === 0 && trust_score_raw >= HIGH_TRUST_BONUS_MIN) {
    primary = REASON_CODES.HIGH_TRUST
    reasons.push(REASON_CODES.HIGH_TRUST)
  } else if (reasons.length === 0) {
    // Score is below high-trust threshold but no factors fired.
    // Shouldn't happen with this formula (all factors at 1.0 → score=1.0
    // ≥ 0.85). But guard anyway.
    primary = REASON_CODES.HIGH_TRUST
    reasons.push(REASON_CODES.HIGH_TRUST)
  } else {
    // Find the lowest-impact factor in priority order.
    const factorImpact = [
      ['feasibility', feasibility_factor, reasons.find(r => r.startsWith('feasibility_'))],
      ['bf_source',   bf_source_factor,   reasons.find(r => r.startsWith('bf_source_'))],
      ['confidence',  confidence_factor,  reasons.find(r => r.startsWith('confidence_'))],
    ].filter(([, , code]) => code != null)
    factorImpact.sort((a, b) => a[1] - b[1])
    primary = factorImpact[0][2]
  }

  return {
    trust_score,
    trust_level,
    feasibility_factor,
    bf_source_factor,
    confidence_factor,
    dk_blend_factor,
    reason_code:   primary,
    reason_codes:  reasons,
  }
}

// Module metadata
export const HELPER_NAME    = 'oracle_layer_3_trust.trustScore'
export const HELPER_VERSION = '1.0.0'
