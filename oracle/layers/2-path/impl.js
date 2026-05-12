// oracle/layers/2-path/impl.js
//
// Bite L2.4 — Layer 2 (Path) module: per-(strike, side) feasibility
// envelope + Trace integration.
//
// Design contract (locked SPEC.md v1.0):
//   - Single per-bet entry: run(layer1Envelope, ctx)
//   - Reads Layer 1 envelope; never recomputes λ or probabilities
//   - Returns a structured envelope (schema_version=1.0.0) with
//     hashes that link back to Layer 1 (matchup_output_hash).
//   - Optional Trace event via Layer 0 writeAsync.
//   - inner is never mutated; Layer 1's envelope is read-only.
//
// Pipeline pattern (mirrors Bite 4):
//   const matchup = computeMatchup(inputs, multipliers)
//   const result  = await run(matchup, { decision_id, strike, side, ... })

import crypto from 'node:crypto'

import { sha256, makeEvent } from '../0-trace/impl.js'
import { bfSourceTier } from '../1-math/dkBlend.js'
import {
  classifyYes, classifyNo,
  FEASIBILITY_CLASSES, REASON_CODES,
} from './feasibility.js'

// ─── Module metadata ─────────────────────────────────────────────────

export const SCHEMA_VERSION = '1.0.0'
export const LAYER_NAME     = 'path'
export const LAYER_VERSION  = '1.0.0'
export const SOURCE         = 'oracle_layer_2_path'

// ─── Workload signal derivation ──────────────────────────────────────
// SPEC §3a: workload_signal ∈ {normal, short_leash, deep, capped, thin}
//
//   thin           → bf_source_tier='weak'
//   short_leash    → leashFlag === true OR avgPitches < 80
//   deep           → avgPitches > 100
//   capped         → bf_source string includes "→capped(" suffix
//   normal         → otherwise
function workloadSignal(inner) {
  const tier = bfSourceTier(inner.bfSource)
  if (tier === 'weak') return 'thin'
  if (typeof inner.bfSource === 'string' && inner.bfSource.includes('→capped(')) return 'capped'
  if (inner.leashFlag === true) return 'short_leash'
  if (typeof inner.avgPitches === 'number' && inner.avgPitches < 80)  return 'short_leash'
  if (typeof inner.avgPitches === 'number' && inner.avgPitches > 100) return 'deep'
  return 'normal'
}

// ─── run: per-(strike, side) entry ──────────────────────────────────

export async function run(layer1Envelope, ctx) {
  if (!layer1Envelope) throw new Error('run: layer1Envelope required')
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
    computed_at = null, fixture_id = null,
  } = ctx

  if (typeof decision_id !== 'string' || !decision_id) {
    throw new Error('run: ctx.decision_id required (string)')
  }
  if (!Number.isInteger(strike)) throw new Error('run: ctx.strike must be an integer')
  if (side !== 'YES' && side !== 'NO') {
    throw new Error(`run: ctx.side must be 'YES' or 'NO' (got ${JSON.stringify(side)})`)
  }
  if (!pitcher_id) throw new Error('run: ctx.pitcher_id required')
  if (!pitcher_name) throw new Error('run: ctx.pitcher_name required')
  if (!bet_date) throw new Error('run: ctx.bet_date required')

  // Pull what we need from Layer 1's envelope. Path never recomputes math.
  const inner        = layer1Envelope.inner
  const lambdaFinal  = layer1Envelope.outer.lambda_final
  const probAtLeast  = layer1Envelope.prob_at_least
  const dkBlend      = layer1Envelope.dk_blend ?? null
  const matchupHash  = layer1Envelope.output_hash
  const matchupInputsHash = layer1Envelope.inputs_hash

  // bf_source_tier from raw bfSource string
  const tier = bfSourceTier(inner.bfSource)

  // dk_blend_applied: read directly from envelope (Bite 6.2)
  const dkBlendApplied = !!(dkBlend && dkBlend.applied)
  const dkSkipReason   = dkBlend ? (dkBlend.skip_reason ?? null) : null

  // Build classifier input
  const classifyInput = {
    strike,
    expected_bf:      inner.expectedBF,
    pK_blended:       inner.pK_blended,
    lambda_final:     lambdaFinal,
    bf_source_tier:   tier,
    avg_pitches:      Number.isFinite(inner.avgPitches) ? inner.avgPitches : null,
    leash_flag:       inner.leashFlag === true,
    dk_blend_applied: dkBlendApplied,
  }
  const classifyResult = side === 'YES'
    ? classifyYes(classifyInput)
    : classifyNo(classifyInput)

  const probKeyForStrike = String(strike)
  const probAtStrikeYes = Number.isFinite(probAtLeast?.[probKeyForStrike])
    ? probAtLeast[probKeyForStrike] : null
  const probAtStrike = probAtStrikeYes != null
    ? (side === 'YES' ? probAtStrikeYes : 1 - probAtStrikeYes)
    : null
  const probNo = probAtStrikeYes != null ? 1 - probAtStrikeYes : null

  const t0 = Date.now()

  const inputs_hash = sha256({
    matchup_output_hash: matchupHash,
    strike,
    side,
  })

  const result = {
    schema_version:        SCHEMA_VERSION,
    layer:                 LAYER_NAME,
    layer_version:         LAYER_VERSION,
    source:                SOURCE,
    run_id:                run_id ?? crypto.randomUUID(),
    decision_id,
    fixture_id,
    computed_at:           computed_at ?? new Date().toISOString(),
    commit_hash:           commit_hash ?? process.env.COMMIT_HASH ?? 'unknown',
    inputs_hash,
    output_hash:           '',
    matchup_output_hash:   matchupHash,

    strike,
    side,

    feasibility:           classifyResult.feasibility,

    // Numeric diagnostics
    required_bf:           classifyResult.required_bf,
    required_bf_outer:     classifyResult.required_bf_outer,
    expected_bf:           inner.expectedBF,
    bf_gap:                classifyResult.bf_gap,
    bf_gap_ratio:          classifyResult.bf_gap_ratio,
    bf_ceiling:            classifyResult.bf_ceiling,
    required_pk:           classifyResult.required_pk,
    gap_under:             classifyResult.gap_under,
    prob_at_strike:        probAtStrike,
    prob_no:               probNo,
    lambda_final:          lambdaFinal,

    // Categorical
    bf_source_tier:        tier,
    workload_signal:       workloadSignal(inner),

    // Reason codes
    reason_code:           classifyResult.reason_code,
    secondary_reasons:     classifyResult.secondary_reasons,

    // DK blend audit
    dk_blend_applied:      dkBlendApplied,
    dk_skip_reason:        dkSkipReason,
  }

  // output_hash excludes run_id, computed_at, output_hash itself.
  const { run_id: _r, computed_at: _c, output_hash: _o, ...resultForHash } = result
  result.output_hash = sha256(resultForHash)

  if (emit_trace) {
    if (!trace || typeof trace.writeAsync !== 'function') {
      throw new Error('run: emit_trace=true requires ctx.trace with writeAsync()')
    }
    const evidence_used = [{
      name: 'oracle_layer_1_math.matchup',
      id: `${pitcher_id}_${bet_date}`,
      input_hash: matchupInputsHash,
    }]
    const event = makeEvent({
      decision_id,
      parent_event_id,
      layer_name: LAYER_NAME,
      layer_version: LAYER_VERSION,
      commit_hash: commit_hash ?? result.commit_hash,
      agent_id,
      agent_version,
      server_version,
      environment,
      run_id: run_id ?? result.run_id,
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
      decision: classifyResult.feasibility,
      reason_code: classifyResult.reason_code,
      reasoning: {
        feasibility:        classifyResult.feasibility,
        workload_signal:    result.workload_signal,
        bf_source_tier:     tier,
        secondary_reasons:  classifyResult.secondary_reasons,
        dk_blend_applied:   dkBlendApplied,
        dk_skip_reason:     dkSkipReason,
      },
      metrics: {
        required_bf:        classifyResult.required_bf,
        required_bf_outer:  classifyResult.required_bf_outer,
        expected_bf:        inner.expectedBF,
        bf_gap:             classifyResult.bf_gap,
        bf_gap_ratio:       classifyResult.bf_gap_ratio,
        bf_ceiling:         classifyResult.bf_ceiling,
        required_pk:        classifyResult.required_pk,
        gap_under:          classifyResult.gap_under,
        lambda_final:       lambdaFinal,
        prob_at_strike:     probAtStrike,
        prob_no:            probNo,
        matchup_output_hash: matchupHash,
      },
      evidence_used,
      input_hash:  inputs_hash,
      output_hash: result.output_hash,
      status: 'success',
      severity: 'info',
      latency_ms: Date.now() - t0,
    })
    trace.writeAsync(event)
  }

  return result
}

// Re-export feasibility constants for callers who want to switch on them.
export {
  FEASIBILITY_CLASSES, REASON_CODES,
}
