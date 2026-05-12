// oracle/layers/3-trust/impl.js
//
// Layer 3 (Trust) — per-bet entry: builds a Trust envelope from a
// Layer 1 envelope + Layer 2 result, optionally emits a Trace event.
//
// Pipeline:
//   const matchup    = computeMatchup(inputs, multipliers)
//   const pathResult = await pathRun(matchup, ctx)
//   const trustResult = await trustRun(matchup, pathResult, ctx)

import crypto from 'node:crypto'

import { sha256, makeEvent } from '../0-trace/impl.js'
import { scoreTrust, parseConfidence, TRUST_LEVELS, REASON_CODES } from './trustScore.js'

export const SCHEMA_VERSION = '1.0.0'
export const LAYER_NAME     = 'trust'
export const LAYER_VERSION  = '1.0.0'
export const SOURCE         = 'oracle_layer_3_trust'

export async function run(layer1Envelope, layer2Result, ctx) {
  if (!layer1Envelope) throw new Error('run: layer1Envelope required')
  if (!layer2Result) throw new Error('run: layer2Result required')
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

  // Pull what trust needs from upstream layers.
  const inner          = layer1Envelope.inner
  const matchupHash    = layer1Envelope.output_hash
  const matchupInputsHash = layer1Envelope.inputs_hash
  const pathHash       = layer2Result.output_hash
  const pathInputsHash = layer2Result.inputs_hash
  const dkBlend        = layer1Envelope.dk_blend ?? null
  const dkBlendApplied = !!(dkBlend && dkBlend.applied)
  const dkSkipReason   = dkBlend ? (dkBlend.skip_reason ?? null) : null

  const confidence = parseConfidence(inner.confidence)

  const t0 = Date.now()
  const score = scoreTrust({
    feasibility:      layer2Result.feasibility,
    bf_source_tier:   layer2Result.bf_source_tier,
    confidence,
    dk_blend_applied: dkBlendApplied,
  })

  const inputs_hash = sha256({
    matchup_output_hash: matchupHash,
    path_output_hash:    pathHash,
    strike,
    side,
  })

  const result = {
    schema_version:      SCHEMA_VERSION,
    layer:               LAYER_NAME,
    layer_version:       LAYER_VERSION,
    source:              SOURCE,
    run_id:              run_id ?? crypto.randomUUID(),
    decision_id,
    fixture_id,
    computed_at:         computed_at ?? new Date().toISOString(),
    commit_hash:         commit_hash ?? process.env.COMMIT_HASH ?? 'unknown',
    inputs_hash,
    output_hash:         '',

    matchup_output_hash: matchupHash,
    path_output_hash:    pathHash,

    strike,
    side,

    trust_score:         score.trust_score,
    trust_level:         score.trust_level,

    feasibility_factor:  score.feasibility_factor,
    bf_source_factor:    score.bf_source_factor,
    confidence_factor:   score.confidence_factor,
    dk_blend_factor:     score.dk_blend_factor,

    feasibility:         layer2Result.feasibility,
    bf_source_tier:      layer2Result.bf_source_tier,
    confidence,
    dk_blend_applied:    dkBlendApplied,
    dk_skip_reason:      dkSkipReason,

    reason_code:         score.reason_code,
    reason_codes:        score.reason_codes,
  }

  const { run_id: _r, computed_at: _c, output_hash: _o, ...resultForHash } = result
  result.output_hash = sha256(resultForHash)

  if (emit_trace) {
    if (!trace || typeof trace.writeAsync !== 'function') {
      throw new Error('run: emit_trace=true requires ctx.trace with writeAsync()')
    }
    const evidence_used = [
      {
        name: 'oracle_layer_1_math.matchup',
        id: `${pitcher_id}_${bet_date}`,
        input_hash: matchupInputsHash,
      },
      {
        name: 'oracle_layer_2_path.result',
        id: `${pitcher_id}_${bet_date}_${strike}_${side}`,
        input_hash: pathInputsHash,
      },
    ]
    const event = makeEvent({
      decision_id,
      parent_event_id,
      layer_name: LAYER_NAME,
      layer_version: LAYER_VERSION,
      commit_hash: commit_hash ?? result.commit_hash,
      agent_id, agent_version, server_version, environment,
      run_id: run_id ?? result.run_id,
      request_id, mode, system,
      event_type: 'decision',
      user_id, bet_id, game_pk, pitcher_id, pitcher_name, market_ticker, bet_date,
      strike, side,
      decision: score.trust_level,
      reason_code: score.reason_code,
      reasoning: {
        trust_level:        score.trust_level,
        feasibility:        layer2Result.feasibility,
        bf_source_tier:     layer2Result.bf_source_tier,
        confidence,
        dk_blend_applied:   dkBlendApplied,
        dk_skip_reason:     dkSkipReason,
        secondary_reasons:  score.reason_codes.filter(r => r !== score.reason_code),
      },
      metrics: {
        trust_score:         score.trust_score,
        feasibility_factor:  score.feasibility_factor,
        bf_source_factor:    score.bf_source_factor,
        confidence_factor:   score.confidence_factor,
        dk_blend_factor:     score.dk_blend_factor,
        matchup_output_hash: matchupHash,
        path_output_hash:    pathHash,
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

export { TRUST_LEVELS, REASON_CODES }
