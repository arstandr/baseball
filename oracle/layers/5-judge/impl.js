// oracle/layers/5-judge/impl.js
//
// Layer 5 (Judge) v0.2 — supports optional criticResult.
//
// Decides fire / skip / size_down per (strike, side) from upstream
// Layer 1/2/3 outputs plus market values, with an optional Layer 4
// (Critic) verdict that can veto-or-upgrade the decision per the
// 4-rung ladder (skip / concern / proceed / boost).
//
// v0.2 backward-compatible: ctx.criticResult is OPTIONAL. When
// absent, behavior is identical to v0.1.

import crypto from 'node:crypto'
import { sha256, makeEvent } from '../0-trace/impl.js'

export const SCHEMA_VERSION = '1.0.0'
export const LAYER_NAME     = 'judge'
export const LAYER_VERSION  = '0.2.0'
export const SOURCE         = 'oracle_layer_5_judge'

export const DECISIONS = Object.freeze({
  FIRE:       'fire',
  SKIP:       'skip',
  SIZE_DOWN:  'size_down',
})

export const REASON_CODES = Object.freeze({
  FEASIBILITY_DEAD:        'feasibility_dead',
  TRUST_ZERO:              'trust_zero',
  INSUFFICIENT_EDGE:       'insufficient_edge',
  FRAGILE_SIZE_DOWN:       'fragile_size_down',
  LOW_TRUST_SIZE_DOWN:     'low_trust_size_down',
  FIRE:                    'fire',
  // v0.2 critic-driven reason codes
  CRITIC_SKIP:             'critic_skip',
  CRITIC_CONCERN_DOWNGRADE: 'critic_concern_downgrade',
  CRITIC_BOOST:            'critic_boost',
})

export const BOOST_BLOCKED_CODES = Object.freeze({
  FRAGILE:               'boost_blocked_fragile',
  FRAGILE_SIZE_DOWN:     'boost_blocked_fragile_size_down',
  LOW_TRUST:             'boost_blocked_low_trust',
  INSUFFICIENT_EDGE:     'boost_blocked_insufficient_edge',
  SKIP_FLOOR:            'boost_blocked_skip_floor',
})

const TRUST_BOOST_MIN = 0.50

const DEFAULT_SIDE_MIN_EDGE  = 0.12
const DEFAULT_MIN_EDGE_FLOOR = 0.04
const DEFAULT_KELLY_MULT     = 1.0
const DEFAULT_MAX_SIZE_USD   = 200

export async function run(layer1Envelope, layer2Result, layer3Result, ctx) {
  if (!layer1Envelope) throw new Error('run: layer1Envelope required')
  if (!layer2Result)   throw new Error('run: layer2Result required')
  if (!layer3Result)   throw new Error('run: layer3Result required')
  if (!ctx) throw new Error('run: ctx required')

  const {
    decision_id, strike, side,
    pitcher_id, pitcher_name, bet_date,
    // spread is a FRACTION in [0, 1] — caller converts cents → fraction
    // (e.g. ks_bets.spread is in cents, divide by 100 before passing).
    market_mid, spread = null, bankroll,
    side_min_edge = DEFAULT_SIDE_MIN_EDGE,
    min_edge_floor = DEFAULT_MIN_EDGE_FLOOR,
    kelly_multiplier = DEFAULT_KELLY_MULT,
    max_size_usd = DEFAULT_MAX_SIZE_USD,
    // v0.2: optional Critic verdict to apply 4-rung ladder
    criticResult = null,
    game_pk = null, market_ticker = null,
    emit_trace = false, trace = null,
    mode = 'shadow', system = 'oracle',
    parent_event_id = null, request_id = null, run_id = null,
    commit_hash = null, agent_id, agent_version,
    server_version = null, environment, user_id = null, bet_id = null,
    computed_at = null, fixture_id = null,
  } = ctx

  if (typeof decision_id !== 'string' || !decision_id) {
    throw new Error('run: ctx.decision_id required')
  }
  if (!Number.isInteger(strike)) throw new Error('run: ctx.strike must be integer')
  if (side !== 'YES' && side !== 'NO') throw new Error("run: ctx.side must be 'YES' or 'NO'")
  if (!pitcher_id) throw new Error('run: ctx.pitcher_id required')
  if (!pitcher_name) throw new Error('run: ctx.pitcher_name required')
  if (!bet_date) throw new Error('run: ctx.bet_date required')
  if (!Number.isFinite(market_mid) || market_mid <= 0 || market_mid >= 1) {
    throw new Error(`run: ctx.market_mid must be in (0,1) got ${market_mid}`)
  }
  if (!Number.isFinite(bankroll) || bankroll <= 0) {
    throw new Error(`run: ctx.bankroll must be > 0 got ${bankroll}`)
  }

  const t0 = Date.now()

  // Probability for this side
  const yesAtStrike = layer1Envelope.prob_at_least?.[String(strike)]
  if (!Number.isFinite(yesAtStrike)) {
    throw new Error(`run: envelope.prob_at_least missing strike=${strike}`)
  }
  const prob_side = side === 'YES' ? yesAtStrike : 1 - yesAtStrike
  const edge      = prob_side - market_mid
  const threshold = (Number.isFinite(spread) && spread > 0)
    ? Math.max(side_min_edge, spread / 2 + min_edge_floor)
    : side_min_edge

  // ── Stage 1: Deterministic baseline decision (v0.1 logic) ─────
  let baseline_decision = null
  let baseline_reason   = null

  if (layer2Result.feasibility === 'dead') {
    baseline_decision = DECISIONS.SKIP
    baseline_reason   = REASON_CODES.FEASIBILITY_DEAD
  } else if (layer3Result.trust_score === 0) {
    baseline_decision = DECISIONS.SKIP
    baseline_reason   = REASON_CODES.TRUST_ZERO
  } else if (edge < threshold) {
    baseline_decision = DECISIONS.SKIP
    baseline_reason   = REASON_CODES.INSUFFICIENT_EDGE
  } else if (layer2Result.feasibility === 'fragile') {
    baseline_decision = DECISIONS.SIZE_DOWN
    baseline_reason   = REASON_CODES.FRAGILE_SIZE_DOWN
  } else if (layer3Result.trust_level === 'low') {
    baseline_decision = DECISIONS.SIZE_DOWN
    baseline_reason   = REASON_CODES.LOW_TRUST_SIZE_DOWN
  } else {
    baseline_decision = DECISIONS.FIRE
    baseline_reason   = REASON_CODES.FIRE
  }

  // ── Stage 2: Critic ladder (v0.2; only if criticResult provided) ──
  let decision = baseline_decision
  let reason_code = baseline_reason
  const critic_applied = []  // list of effects: 'skip', 'concern_downgrade',
                              // 'boost', 'boost_blocked_<reason>', 'no_change'
  let critic_verdict = null
  if (criticResult && typeof criticResult === 'object' && criticResult.verdict) {
    critic_verdict = criticResult.verdict
    if (critic_verdict === 'skip') {
      // skip overrides anything
      if (decision !== DECISIONS.SKIP) {
        decision = DECISIONS.SKIP
        reason_code = REASON_CODES.CRITIC_SKIP
        critic_applied.push('skip')
      } else {
        critic_applied.push('skip_redundant')
      }
    } else if (critic_verdict === 'concern') {
      if (decision === DECISIONS.FIRE) {
        decision = DECISIONS.SIZE_DOWN
        reason_code = REASON_CODES.CRITIC_CONCERN_DOWNGRADE
        critic_applied.push('concern_downgrade')
      } else {
        critic_applied.push('no_change')
      }
    } else if (critic_verdict === 'boost') {
      // Boost can ONLY upgrade size_down → fire, with strict guards.
      if (decision === DECISIONS.SKIP) {
        critic_applied.push(BOOST_BLOCKED_CODES.SKIP_FLOOR)
      } else if (decision === DECISIONS.FIRE) {
        critic_applied.push('no_change')   // already at fire; boost no-op
      } else {
        // decision === SIZE_DOWN → check guards
        if (layer2Result.feasibility === 'fragile') {
          critic_applied.push(BOOST_BLOCKED_CODES.FRAGILE)
        } else if (baseline_reason === REASON_CODES.FRAGILE_SIZE_DOWN) {
          critic_applied.push(BOOST_BLOCKED_CODES.FRAGILE_SIZE_DOWN)
        } else if (layer3Result.trust_score < TRUST_BOOST_MIN) {
          critic_applied.push(BOOST_BLOCKED_CODES.LOW_TRUST)
        } else if (edge < threshold) {
          critic_applied.push(BOOST_BLOCKED_CODES.INSUFFICIENT_EDGE)
        } else {
          // All guards passed: upgrade size_down → fire
          decision = DECISIONS.FIRE
          reason_code = REASON_CODES.CRITIC_BOOST
          critic_applied.push('boost')
        }
      }
    } else if (critic_verdict === 'proceed') {
      critic_applied.push('no_change')
    }
  }

  // ── Stage 3: Kelly sizing (uses final decision after Critic) ──
  const b = (1 - market_mid) / market_mid
  const kelly_raw_unclamped = (prob_side * b - (1 - prob_side)) / b
  const kelly_raw = Math.max(0, kelly_raw_unclamped)
  const sizeDownFactor = decision === DECISIONS.SIZE_DOWN ? 0.5 : 1.0
  const kelly_eff_unclamped = kelly_raw * kelly_multiplier * layer3Result.trust_score * sizeDownFactor
  const kelly_eff = Math.max(0, Math.min(1, kelly_eff_unclamped))
  const size_usd  = decision === DECISIONS.SKIP
    ? 0
    : Math.max(0, Math.min(max_size_usd, bankroll * kelly_eff))

  const matchupHash = layer1Envelope.output_hash
  const matchupInputsHash = layer1Envelope.inputs_hash
  const pathHash = layer2Result.output_hash
  const pathInputsHash = layer2Result.inputs_hash
  const trustHash = layer3Result.output_hash
  const trustInputsHash = layer3Result.inputs_hash

  const criticHash = criticResult?.output_hash ?? null
  const criticInputsHash = criticResult?.inputs_hash ?? null

  const inputs_hash = sha256({
    matchup_output_hash: matchupHash,
    path_output_hash:    pathHash,
    trust_output_hash:   trustHash,
    critic_output_hash:  criticHash,
    strike, side, market_mid, spread, bankroll,
    side_min_edge, min_edge_floor, kelly_multiplier, max_size_usd,
  })

  const result = {
    schema_version:      SCHEMA_VERSION,
    layer:               LAYER_NAME,
    layer_version:       LAYER_VERSION,
    source:              SOURCE,
    run_id:              run_id ?? crypto.randomUUID(),
    decision_id, fixture_id,
    computed_at:         computed_at ?? new Date().toISOString(),
    commit_hash:         commit_hash ?? process.env.COMMIT_HASH ?? 'unknown',
    inputs_hash,
    output_hash:         '',

    matchup_output_hash: matchupHash,
    path_output_hash:    pathHash,
    trust_output_hash:   trustHash,
    critic_output_hash:  criticHash,

    strike, side,

    prob_side, market_mid, edge, threshold, spread,

    baseline_decision,
    baseline_reason,
    critic_verdict,
    critic_applied,
    decision,
    reason_code,

    kelly_raw, kelly_eff, size_usd,

    feasibility:  layer2Result.feasibility,
    trust_score:  layer3Result.trust_score,
    trust_level:  layer3Result.trust_level,
  }

  const { run_id: _r, computed_at: _c, output_hash: _o, ...resultForHash } = result
  result.output_hash = sha256(resultForHash)

  if (emit_trace) {
    if (!trace || typeof trace.writeAsync !== 'function') {
      throw new Error('run: emit_trace=true requires ctx.trace with writeAsync()')
    }
    const evidence_used = [
      { name: 'oracle_layer_1_math.matchup', id: `${pitcher_id}_${bet_date}`,
        input_hash: matchupInputsHash },
      { name: 'oracle_layer_2_path.result',  id: `${pitcher_id}_${bet_date}_${strike}_${side}`,
        input_hash: pathInputsHash },
      { name: 'oracle_layer_3_trust.result', id: `${pitcher_id}_${bet_date}_${strike}_${side}`,
        input_hash: trustInputsHash },
    ]
    if (criticInputsHash) {
      evidence_used.push({
        name: 'oracle_layer_4_critic.result',
        id: `${pitcher_id}_${bet_date}_${strike}_${side}`,
        input_hash: criticInputsHash,
      })
    }
    const event = makeEvent({
      decision_id, parent_event_id,
      layer_name: LAYER_NAME, layer_version: LAYER_VERSION,
      commit_hash: commit_hash ?? result.commit_hash,
      agent_id, agent_version, server_version, environment,
      run_id: run_id ?? result.run_id,
      request_id, mode, system,
      event_type: 'decision',
      user_id, bet_id, game_pk, pitcher_id, pitcher_name, market_ticker, bet_date,
      strike, side,
      decision, reason_code,
      reasoning: {
        feasibility:  layer2Result.feasibility,
        trust_level:  layer3Result.trust_level,
        threshold_used: threshold,
        baseline_decision,
        baseline_reason,
        critic_verdict,
        critic_applied,
      },
      metrics: {
        prob_side, market_mid, edge, threshold,
        kelly_raw, kelly_eff, size_usd,
        trust_score: layer3Result.trust_score,
        matchup_output_hash: matchupHash,
        path_output_hash:    pathHash,
        trust_output_hash:   trustHash,
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
