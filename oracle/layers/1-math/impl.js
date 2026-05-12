// oracle/layers/1-math/impl.js
//
// Layer 1: Math — clean Oracle API over the production calibrated lambda
// computation. Composes lower-level math from `lib/strikeout-model.js` and
// `scripts/live/strikeoutEdge.js` (where `computeLambdaBase` lives).
//
// V1.0 scope (Bite 3 lock):
//   - Inner λ via computeLambdaBase (delegated; not rewritten)
//   - Outer chain as multiplier-bundle composition (Layer 1 receives the
//     production-logged multipliers and applies them — see TODO below)
//   - Per-strike P(K ≥ k) via NB(λ_final, archetypeR(savant))
//
// TODO Layer 1 v1.1: reconstruct multiplier inputs (split_adj, opp_adj,
// park_factor, weather_mult, ump_factor) from raw game/savant/lineup/
// weather/ump data instead of receiving the multiplier bundle. This would
// close the "outer chain ownership" gap surfaced in Bite 3 (Q-B3.2).

import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import url from 'node:url'

import { archetypeR, nbCDF } from '../../../lib/strikeout-model.js'
import { computeLambdaBase } from '../../../scripts/live/strikeoutEdge.js'
import { sha256, makeEvent } from '../0-trace/impl.js'
import {
  classifyThinness,
  blendBF,
  bfSourceTier,
  THINNESS_CLASSES,
  SKIP_REASONS as DK_SKIP_REASONS,
  DEFAULT_BF_CAP_K,
} from './dkBlend.js'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const PK_WEIGHTS_PATH = path.resolve(__dirname, '../../../models/pk_ridge_weights.json')

export const STRIKES_DEFAULT = Object.freeze([3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
export const SCHEMA_VERSION = '1.0.0'
export const LAYER_NAME = 'math'
export const LAYER_VERSION = '1.0.0'
export const SOURCE = 'oracle_layer_1_math'

// ────────────────────────────────────────────────────────────────────────
// NB_R_SOURCES — provenance vocabulary for the dispersion choice.
// Returned by nbRSource(). Downstream layers should switch on these
// constants rather than string-matching.
//
//   FITTED          pitcher had enough start sample for fitDispersion.js
//                   to write a per-pitcher nb_r into pitcher_statcast.
//                   Highest fidelity. Rare early in season.
//   ARCHETYPE_KPCT  pitcher has savant.k_pct but no fitted nb_r;
//                   bucketed by k_pct cuts (≥0.28 → 20 / ≤0.19 → 50 / else 30).
//                   Default for most pitchers with current-season Statcast.
//   GLOBAL_DEFAULT  no savant data at all (career-only or no data).
//                   Falls back to NB_R = 30 from lib/strikeout-model.js.
// ────────────────────────────────────────────────────────────────────────
export const NB_R_SOURCES = Object.freeze({
  FITTED:         'fitted',
  ARCHETYPE_KPCT: 'archetype_kpct',
  GLOBAL_DEFAULT: 'global_default',
})

// ────────────────────────────────────────────────────────────────────────
// computeInner: produces the same structured object computeLambdaBase
// returns. Layer 1's contract is that this output shape is stable; downstream
// layers (Path/Trust/Critic/Judge) read from it.
// ────────────────────────────────────────────────────────────────────────
export function computeInner(inputs) {
  if (!inputs) throw new Error('computeInner: inputs required')
  const { log, gameDate, savant, career, recentStartsData, careerAvgFbVelo } = inputs
  if (!Array.isArray(log)) throw new Error('computeInner: inputs.log must be an array')
  if (typeof gameDate !== 'string') throw new Error('computeInner: inputs.gameDate must be a string (YYYY-MM-DD)')
  if (!Array.isArray(recentStartsData)) throw new Error('computeInner: inputs.recentStartsData must be an array')

  return computeLambdaBase(log, gameDate, savant, career, recentStartsData, careerAvgFbVelo ?? null)
}

// ────────────────────────────────────────────────────────────────────────
// composeOuter: applies the outer multiplier chain to lambda_base.
// V1.0 receives the multipliers as a bundle (typically pulled from the
// production log of the original decision). V1.1 will reconstruct these
// from raw game/savant/lineup data — see TODO above.
// ────────────────────────────────────────────────────────────────────────
export function composeOuter(lambda_base, multipliers) {
  if (!Number.isFinite(lambda_base)) throw new Error('composeOuter: lambda_base must be finite')
  if (!multipliers) throw new Error('composeOuter: multipliers bundle required')
  const { split_adj, opp_adj, park_factor, weather_mult, ump_factor } = multipliers
  for (const [k, v] of Object.entries({ split_adj, opp_adj, park_factor, weather_mult, ump_factor })) {
    if (!Number.isFinite(v)) throw new Error(`composeOuter: multipliers.${k} must be finite (got ${v})`)
  }
  return lambda_base * split_adj * opp_adj * park_factor * weather_mult * ump_factor
}

// ────────────────────────────────────────────────────────────────────────
// probAtLeastByStrike: per-strike P(K ≥ k) under NB(lambda_final, archetypeR(savant)).
// Layer 1 owns this math so downstream layers don't reinvent it.
// ────────────────────────────────────────────────────────────────────────
export function probAtLeastByStrike(lambda_final, savant, strikes = STRIKES_DEFAULT) {
  if (!Number.isFinite(lambda_final)) throw new Error('probAtLeastByStrike: lambda_final must be finite')
  const r = nbR(savant)
  const out = {}
  for (const k of strikes) {
    out[String(k)] = Math.max(0, 1 - nbCDF(lambda_final, r, k - 1))
  }
  return out
}

// ────────────────────────────────────────────────────────────────────────
// nbR / nbRSource: expose the dispersion choice + its provenance for
// downstream layers. Mirrors archetypeR's branch logic.
// ────────────────────────────────────────────────────────────────────────
export function nbR(savant) {
  return archetypeR(savant)
}

export function nbRSource(savant) {
  if (!savant) return NB_R_SOURCES.GLOBAL_DEFAULT
  if (savant.nb_r != null) return NB_R_SOURCES.FITTED
  if (savant.k_pct != null) return NB_R_SOURCES.ARCHETYPE_KPCT
  return NB_R_SOURCES.GLOBAL_DEFAULT
}

// ────────────────────────────────────────────────────────────────────────
// pk_ridge_weights_hash: read+sha256 once at module load. Process restart
// picks up retrains, matching how lib/pkModel.js loads weights at startup.
// ────────────────────────────────────────────────────────────────────────
let _pkWeightsHashCache = null
export function pkRidgeWeightsHash() {
  if (_pkWeightsHashCache == null) {
    _pkWeightsHashCache = sha256(readFileSync(PK_WEIGHTS_PATH, 'utf-8'))
  }
  return _pkWeightsHashCache
}

// ────────────────────────────────────────────────────────────────────────
// resolveDkBlendFlag: ctx peer field overrides env. Test ergonomics +
// production deployment toggle (Bite 6 v1; default OFF).
// ────────────────────────────────────────────────────────────────────────
function resolveDkBlendFlag(ctx) {
  if (ctx.dk_blend_enabled !== undefined) return !!ctx.dk_blend_enabled
  return process.env.DK_BLEND_ENABLED === 'true'
}

// Orchestrator-level skip vocabulary extends helper's SKIP_REASONS with
// 'flag_off' to record "blend would have applied but was running dark".
const ORCH_SKIP_FLAG_OFF = 'flag_off'

// Build envelope.dk_blend block. Always returns a complete block; field
// values reflect what the orchestrator observed and what the helper
// would-have-done. See PARITY_NOTES.md "Bite 6.2" for shape contract.
function buildDkBlendBlock({ inner, savant, dkContext, blend, klass, flagOn,
                              orchestratorApplied, orchestratorSkipReason }) {
  return {
    dk_line:                dkContext.dk_line ?? null,
    dk_over_price:          dkContext.dk_over_price ?? null,
    dk_source:              dkContext.dk_source ?? null,

    dk_thinness_class:      klass,
    bf_source_tier:         bfSourceTier(inner.bfSource),

    dk_lambda:              blend.dk_lambda,
    expected_bf_dk:         blend.bf_dk,
    bf_delta:               blend.bf_delta,

    expected_bf_current:    inner.expectedBF,
    expected_bf_dk_blended: blend.expected_bf_blended,
    lambda_base_current:    inner.lambdaBase,
    lambda_base_dk_blended: blend.lambda_base_blended,

    w_dk:                   blend.w_dk,
    applied:                orchestratorApplied,
    skip_reason:            orchestratorSkipReason,
    flag_dk_blend_enabled:  flagOn,
    bf_cap_K:               dkContext.bf_cap_K ?? DEFAULT_BF_CAP_K,
  }
}

// ────────────────────────────────────────────────────────────────────────
// computeMatchup: pure matchup-grain math artifact.
//
//   inputs       — same shape as computeInner accepts
//   multipliers  — same shape as composeOuter accepts
//   ctx (opt)    — pass-through identity/timing fields:
//                    decision_id?, fixture_id?, commit_hash?,
//                    run_id?, computed_at?
//                  DK blend (Bite 6.2):
//                    dkContext?         { dk_line, dk_over_price, dk_source,
//                                         bf_cap_K?, schedule? }
//                    dk_blend_enabled?  ctx peer override; falls back to
//                                       process.env.DK_BLEND_ENABLED==='true'.
//
// Bite 6 v1 contract:
//   - ctx.dkContext absent  → no envelope.dk_blend; byte-for-byte
//                              identical to pre-Bite-6.2 behavior.
//   - ctx.dkContext present + flag false → envelope.dk_blend present,
//                              applied=false, skip_reason='flag_off' (when
//                              blend would otherwise have applied), but
//                              math UNCHANGED.
//   - ctx.dkContext present + flag true + blend.applied → λ_base flows
//                              through blend.lambda_base_blended; outer
//                              chain + prob_at_least reflect blended math.
//   - inner is NEVER mutated. inner.lambdaBase always equals the pre-blend
//                              value. envelope.dk_blend.lambda_base_current
//                              points at it.
// ────────────────────────────────────────────────────────────────────────
export function computeMatchup(inputs, multipliers, ctx = {}) {
  if (!inputs) throw new Error('computeMatchup: inputs required')
  if (!multipliers) throw new Error('computeMatchup: multipliers required')

  const inner = computeInner(inputs)
  const nb_r_value = nbR(inputs.savant)
  const nb_r_src = nbRSource(inputs.savant)
  const pk_ridge_weights_hash = pkRidgeWeightsHash()

  // ── Bite 6.2: optional DK blend ─────────────────────────────────────
  // Compute blend FIRST so we can decide effective λ_base before composing
  // the outer chain.
  let dkBlendBlock = null
  let effectiveLambdaBase = inner.lambdaBase
  const dkContext = ctx.dkContext

  if (dkContext) {
    const flagOn = resolveDkBlendFlag(ctx)
    const klass = classifyThinness(inner, inputs.savant)
    const blend = blendBF({
      expected_bf_ours: inner.expectedBF,
      pK_ours:          inner.pK_blended,
      dk_line:          dkContext.dk_line,
      over_price:       dkContext.dk_over_price,
      r:                nb_r_value,
      klass,
      schedule:         dkContext.schedule,
      bf_cap_K:         dkContext.bf_cap_K ?? DEFAULT_BF_CAP_K,
    })

    const orchestratorApplied = flagOn && blend.applied
    let orchestratorSkipReason = null
    if (!orchestratorApplied) {
      // Helper said "would apply" but flag is off → flag_off. Otherwise,
      // surface the helper's own reason.
      if (!flagOn && blend.applied) orchestratorSkipReason = ORCH_SKIP_FLAG_OFF
      else                          orchestratorSkipReason = blend.skip_reason
    }

    if (orchestratorApplied) {
      effectiveLambdaBase = blend.lambda_base_blended
    }

    dkBlendBlock = buildDkBlendBlock({
      inner, savant: inputs.savant, dkContext, blend, klass,
      flagOn, orchestratorApplied, orchestratorSkipReason,
    })
  }

  const lambda_final = composeOuter(effectiveLambdaBase, multipliers)
  const prob_at_least = probAtLeastByStrike(lambda_final, inputs.savant)

  // inputs_hash includes ctx.dkContext when present (replay integrity).
  // ctx.dk_blend_enabled is NOT in inputs_hash — it is a behavior toggle,
  // not external data.
  const inputs_hash = sha256({
    inputs,
    multipliers,
    pk_ridge_weights_hash,
    layer_version: LAYER_VERSION,
    ...(dkContext ? { dkContext } : {}),
  })

  const envelope = {
    schema_version: SCHEMA_VERSION,
    layer: LAYER_NAME,
    layer_version: LAYER_VERSION,
    source: SOURCE,
    run_id: ctx.run_id ?? crypto.randomUUID(),
    decision_id: ctx.decision_id ?? null,
    fixture_id: ctx.fixture_id ?? null,
    computed_at: ctx.computed_at ?? new Date().toISOString(),
    commit_hash: ctx.commit_hash ?? process.env.COMMIT_HASH ?? 'unknown',
    inputs_hash,
    output_hash: '',
    pk_ridge_weights_hash,
    inner,
    outer: {
      multipliers: {
        split_adj:    multipliers.split_adj,
        opp_adj:      multipliers.opp_adj,
        park_factor:  multipliers.park_factor,
        weather_mult: multipliers.weather_mult,
        ump_factor:   multipliers.ump_factor,
      },
      lambda_final,
    },
    nb_r: nb_r_value,
    nb_r_source: nb_r_src,
    prob_at_least,
    status: 'ok',
    warnings: [],
    ...(dkBlendBlock ? { dk_blend: dkBlendBlock } : {}),
  }

  // output_hash excludes run_id, computed_at, output_hash itself.
  // Includes inputs_hash, layer_version, pk_ridge_weights_hash so identity
  // tracks both content + ML weights version. envelope.dk_blend (when
  // present) is automatically included in the payload by this rule.
  const { run_id: _r, computed_at: _c, output_hash: _o, ...envForHash } = envelope
  envelope.output_hash = sha256(envForHash)
  return envelope
}

// ────────────────────────────────────────────────────────────────────────
// run: per-(strike, side) entry. Reads from a matchup envelope, returns
// the per-bet result, optionally emits one Trace event via Layer 0's
// writeAsync.
//
//   envelope — output of computeMatchup
//   ctx — required:
//     decision_id, strike, side ('YES'|'NO'),
//     pitcher_id, pitcher_name, bet_date
//   ctx — optional (Trace defaults filled by Layer 0's makeEvent):
//     emit_trace (default false), trace (required when emit_trace=true),
//     game_pk, market_ticker, mode ('shadow'|'production'),
//     system ('oracle'|'current'|'old'),
//     parent_event_id, request_id, run_id, commit_hash, agent_id,
//     agent_version, server_version, environment, user_id, bet_id
// ────────────────────────────────────────────────────────────────────────
export async function run(envelope, ctx) {
  if (!envelope) throw new Error('run: envelope required')
  if (!ctx) throw new Error('run: ctx required')
  const {
    decision_id, strike, side,
    pitcher_id, pitcher_name, bet_date,
    game_pk = null, market_ticker = null,
    emit_trace = false, trace = null,
    mode = 'shadow', system = 'oracle',
    parent_event_id = null, request_id = null, run_id = null,
    commit_hash = null, agent_id, agent_version,
    server_version = null, environment, user_id = null, bet_id = null,
  } = ctx

  if (typeof decision_id !== 'string' || !decision_id) {
    throw new Error('run: ctx.decision_id required (string)')
  }
  if (!Number.isFinite(strike)) throw new Error('run: ctx.strike required (number)')
  if (side !== 'YES' && side !== 'NO') {
    throw new Error(`run: ctx.side must be 'YES' or 'NO' (got ${JSON.stringify(side)})`)
  }
  if (!pitcher_id) throw new Error('run: ctx.pitcher_id required')
  if (!pitcher_name) throw new Error('run: ctx.pitcher_name required')
  if (!bet_date) throw new Error('run: ctx.bet_date required')

  const t0 = Date.now()

  const p_yes_raw = envelope.prob_at_least?.[String(strike)]
  if (!Number.isFinite(p_yes_raw)) {
    throw new Error(`run: envelope.prob_at_least missing or non-finite for strike=${strike}`)
  }
  const p_yes = p_yes_raw
  const p_no = 1 - p_yes
  const probability = side === 'YES' ? p_yes : p_no

  const inputs_hash = sha256({
    matchup_output_hash: envelope.output_hash,
    strike,
    side,
  })

  const result = {
    decision_id,
    layer: LAYER_NAME,
    decision: 'computed',
    strike,
    side,
    lambda_final: envelope.outer.lambda_final,
    nb_r: envelope.nb_r,
    p_yes,
    p_no,
    probability,
    matchup_output_hash: envelope.output_hash,
    inputs_hash,
    output_hash: '',
  }
  const { output_hash: _ph, ...resultForHash } = result
  result.output_hash = sha256(resultForHash)

  if (emit_trace) {
    if (!trace || typeof trace.writeAsync !== 'function') {
      throw new Error('run: emit_trace=true requires ctx.trace with writeAsync()')
    }
    const evidence_used = [{
      name: 'oracle_layer_1_math.matchup',
      id: `${pitcher_id}_${bet_date}`,
      input_hash: envelope.inputs_hash,
    }]
    const event = makeEvent({
      decision_id,
      parent_event_id,
      layer_name: LAYER_NAME,
      layer_version: LAYER_VERSION,
      commit_hash: commit_hash ?? envelope.commit_hash,
      agent_id,
      agent_version,
      server_version,
      environment,
      run_id: run_id ?? envelope.run_id,
      request_id,
      mode,
      system,
      event_type: 'decision',
      user_id,
      bet_id,
      game_pk,
      pitcher_id,
      pitcher_name,
      market_ticker,
      bet_date,
      strike,
      side,
      decision: 'computed',
      reason_code: 'math_computed',
      reasoning: {
        nb_r_source: envelope.nb_r_source,
        pk_ridge_weights_hash: envelope.pk_ridge_weights_hash,
        matchup_run_id: envelope.run_id,
        // Bite 6.2: when a DK blend was considered, surface the audit
        // outcome in reasoning. Always present when envelope.dk_blend exists,
        // regardless of applied/skip status.
        ...(envelope.dk_blend ? {
          dk_blend: {
            applied:        envelope.dk_blend.applied,
            skip_reason:    envelope.dk_blend.skip_reason,
            thinness_class: envelope.dk_blend.dk_thinness_class,
            source:         envelope.dk_blend.dk_source,
          },
        } : {}),
      },
      metrics: {
        lambda_final: envelope.outer.lambda_final,
        nb_r: envelope.nb_r,
        p_yes,
        p_no,
        probability,
        matchup_output_hash: envelope.output_hash,
        // Bite 6.2: numeric DK blend values (only when envelope carries them).
        ...(envelope.dk_blend ? {
          dk_lambda:              envelope.dk_blend.dk_lambda,
          expected_bf_dk:         envelope.dk_blend.expected_bf_dk,
          lambda_base_dk_blended: envelope.dk_blend.lambda_base_dk_blended,
        } : {}),
      },
      evidence_used,
      input_hash: inputs_hash,
      output_hash: result.output_hash,
      status: 'success',
      severity: 'info',
      latency_ms: Date.now() - t0,
    })
    trace.writeAsync(event)
  }

  return result
}
