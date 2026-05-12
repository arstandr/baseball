// oracle/layers/4-critic/impl.js
//
// L4.3 — Layer 4 (Critic) — per-bet AI second-opinion run().
//
// Contract:
//   - Reads Layer 1 envelope, Layer 2 result, Layer 3 result, plus
//     pre-fetched preflight context.
//   - Builds a prompt via preflightAdapter.
//   - Calls ctx.criticClient.classify({system, user, model, max_tokens})
//     — DEPENDENCY-INJECTED (production wires Anthropic SDK; tests
//     inject a stub).
//   - Optionally caches via ctx.cache.
//   - FAILS OPEN: any failure path returns verdict='proceed' with
//     status='unavailable' and trace event severity='warn'.
//   - Optional Trace event via Layer 0 writeAsync.

import crypto from 'node:crypto'

import { sha256, makeEvent } from '../0-trace/impl.js'
import {
  buildSystemPrompt, buildUserPrompt, computeCacheKey,
  parseCriticResponse, PROMPT_VERSION, CONCERN_VOCAB,
} from './preflightAdapter.js'

export const SCHEMA_VERSION = '1.0.0'
export const LAYER_NAME     = 'critic'
export const LAYER_VERSION  = '1.0.0'
export const SOURCE         = 'oracle_layer_4_critic'

export const VERDICTS = Object.freeze({
  SKIP: 'skip', CONCERN: 'concern', PROCEED: 'proceed', BOOST: 'boost',
})

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001'
const DEFAULT_MAX_INPUT_TOKENS = 10_000  // approximation; client should enforce
const DEFAULT_MAX_OUTPUT_TOKENS = 400
const DEFAULT_TIMEOUT_MS = 15_000

export async function run(layer1Envelope, layer2Result, layer3Result, ctx) {
  if (!layer1Envelope) throw new Error('run: layer1Envelope required')
  if (!layer2Result)   throw new Error('run: layer2Result required')
  if (!layer3Result)   throw new Error('run: layer3Result required')
  if (!ctx) throw new Error('run: ctx required')

  const {
    decision_id, strike, side,
    pitcher_id, pitcher_name, bet_date,
    layer3JudgeBaseDecision = null,    // optional — what Judge would have decided absent Critic
    market_mid = null, edge = null,    // for context, not authoritative
    preflightContext = {},
    criticClient = null,
    cache = null,
    model = DEFAULT_MODEL,
    max_input_tokens = DEFAULT_MAX_INPUT_TOKENS,
    max_output_tokens = DEFAULT_MAX_OUTPUT_TOKENS,
    timeout_ms = DEFAULT_TIMEOUT_MS,
    game_pk = null, market_ticker = null,
    emit_trace = false, trace = null,
    mode = 'shadow', system = 'oracle',
    parent_event_id = null, request_id = null, run_id = null,
    commit_hash = null, agent_id, agent_version,
    server_version = null, environment, user_id = null, bet_id = null,
    computed_at = null, fixture_id = null,
  } = ctx

  if (typeof decision_id !== 'string' || !decision_id) throw new Error('run: ctx.decision_id required')
  if (!Number.isInteger(strike)) throw new Error('run: ctx.strike must be integer')
  if (side !== 'YES' && side !== 'NO') throw new Error("run: ctx.side must be 'YES' or 'NO'")
  if (!pitcher_id) throw new Error('run: ctx.pitcher_id required')
  if (!pitcher_name) throw new Error('run: ctx.pitcher_name required')
  if (!bet_date) throw new Error('run: ctx.bet_date required')

  const t0 = Date.now()

  const matchupHash = layer1Envelope.output_hash
  const matchupInputsHash = layer1Envelope.inputs_hash
  const pathHash    = layer2Result.output_hash
  const pathInputsHash = layer2Result.inputs_hash
  const trustHash   = layer3Result.output_hash
  const trustInputsHash = layer3Result.inputs_hash

  const chainSummary = {
    feasibility:      layer2Result.feasibility,
    trust_level:      layer3Result.trust_level,
    trust_score:      layer3Result.trust_score,
    edge,
    market_mid,
    decision_so_far:  layer3JudgeBaseDecision ?? '(unknown)',
  }

  const systemPrompt = buildSystemPrompt()
  const userPrompt   = buildUserPrompt({
    chainSummary, preflightContext,
    betMeta: { pitcher_name, strike, side, bet_date },
  })

  const cacheKey = computeCacheKey({ pitcher_id, bet_date, preflightContext })

  // Pre-flight: prompt size estimate (approximation: 4 chars/token)
  const promptCharLen = systemPrompt.length + userPrompt.length
  const approxInputTokens = Math.ceil(promptCharLen / 4)
  if (approxInputTokens > max_input_tokens) {
    return finalize({
      verdict: 'proceed', confidence: 'low',
      concerns: [], reason_code: 'critic_too_large',
      model_used: 'unavailable', tokens_input: null, tokens_output: null,
      cost_usd: null, cache_hit: false, status: 'too_large',
      error_message: `prompt too large (~${approxInputTokens} tokens > ${max_input_tokens})`,
    })
  }

  // Cache lookup
  if (cache && typeof cache.get === 'function') {
    try {
      const hit = await cache.get(cacheKey)
      if (hit && hit.verdict) {
        return finalize({
          verdict: hit.verdict, confidence: hit.confidence ?? 'medium',
          concerns: Array.isArray(hit.concerns) ? hit.concerns : [],
          reason_code: hit.reason_code ?? 'cache_hit',
          model_used: 'cache',
          tokens_input: hit.tokens_input ?? null,
          tokens_output: hit.tokens_output ?? null,
          cost_usd: hit.cost_usd ?? null,
          cache_hit: true, status: 'ok',
          error_message: null,
        })
      }
    } catch {
      // cache failure is non-fatal; proceed to API
    }
  }

  // Live call (or stub)
  if (!criticClient || typeof criticClient.classify !== 'function') {
    return finalize({
      verdict: 'proceed', confidence: 'low',
      concerns: [], reason_code: 'critic_unavailable',
      model_used: 'unavailable', tokens_input: null, tokens_output: null,
      cost_usd: null, cache_hit: false, status: 'unavailable',
      error_message: 'criticClient not provided',
    })
  }

  let apiResult
  try {
    apiResult = await callWithTimeout(
      criticClient.classify({ system: systemPrompt, user: userPrompt, model, max_tokens: max_output_tokens }),
      timeout_ms,
    )
  } catch (err) {
    return finalize({
      verdict: 'proceed', confidence: 'low',
      concerns: [], reason_code: err?.code === 'timeout' ? 'critic_timeout' : 'critic_unavailable',
      model_used: 'unavailable', tokens_input: null, tokens_output: null,
      cost_usd: null, cache_hit: false, status: err?.code === 'timeout' ? 'timeout' : 'unavailable',
      error_message: String(err?.message ?? err),
    })
  }

  // apiResult is expected to be:
  // { content: <raw string>, model_used, tokens_input, tokens_output, cost_usd }
  // OR an already-parsed { verdict, confidence, concerns, reason, raw, ... }
  let parsed
  let raw_response = ''
  if (apiResult && typeof apiResult === 'object' && apiResult.verdict) {
    // Already parsed (e.g. test stubs)
    const v = apiResult
    parsed = { verdict: v.verdict, confidence: v.confidence, concerns: v.concerns ?? [], reason: v.reason ?? '' }
  } else {
    const raw = typeof apiResult?.content === 'string' ? apiResult.content : (typeof apiResult === 'string' ? apiResult : '')
    raw_response = raw
    const out = parseCriticResponse(raw)
    if (!out.ok) {
      return finalize({
        verdict: 'proceed', confidence: 'low',
        concerns: [], reason_code: 'critic_parse_error',
        model_used: apiResult?.model_used ?? model, tokens_input: apiResult?.tokens_input ?? null,
        tokens_output: apiResult?.tokens_output ?? null, cost_usd: apiResult?.cost_usd ?? null,
        cache_hit: false, status: 'parse_error',
        error_message: out.error,
      })
    }
    parsed = out.parsed
  }

  const reason_code = primaryReasonCode(parsed)

  // Cache write
  const tokensIn  = apiResult?.tokens_input ?? null
  const tokensOut = apiResult?.tokens_output ?? null
  const costUsd   = apiResult?.cost_usd ?? null
  const modelUsed = apiResult?.model_used ?? model

  if (cache && typeof cache.set === 'function') {
    try {
      await cache.set(cacheKey, {
        verdict: parsed.verdict, confidence: parsed.confidence,
        concerns: parsed.concerns, reason_code,
        tokens_input: tokensIn, tokens_output: tokensOut, cost_usd: costUsd,
      })
    } catch {
      // cache write failure is non-fatal
    }
  }

  return finalize({
    verdict: parsed.verdict, confidence: parsed.confidence,
    concerns: parsed.concerns, reason_code,
    reason_text: parsed.reason ?? '',
    raw_response,
    model_used: modelUsed, tokens_input: tokensIn, tokens_output: tokensOut,
    cost_usd: costUsd, cache_hit: false, status: 'ok',
    error_message: null,
  })

  // ─── Inner helper: build envelope + optionally emit trace ──────
  async function finalize(parts) {
    const inputs_hash = sha256({
      matchup_output_hash: matchupHash, path_output_hash: pathHash,
      trust_output_hash: trustHash,
      strike, side, prompt_version: PROMPT_VERSION,
      cache_key: cacheKey,
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

      strike, side,

      verdict:        parts.verdict,
      confidence:     parts.confidence,
      concerns:       parts.concerns,
      reason_code:    parts.reason_code,
      reason_text:    parts.reason_text ?? '',
      raw_response:   parts.raw_response ?? '',

      model_used:     parts.model_used,
      tokens_input:   parts.tokens_input,
      tokens_output:  parts.tokens_output,
      cost_usd:       parts.cost_usd,
      cache_hit:      parts.cache_hit,

      status:         parts.status,
      error_message:  parts.error_message,
    }
    const { run_id: _r, computed_at: _c, output_hash: _o, ...resultForHash } = result
    result.output_hash = sha256(resultForHash)

    if (emit_trace) {
      if (!trace || typeof trace.writeAsync !== 'function') {
        throw new Error('run: emit_trace=true requires ctx.trace with writeAsync()')
      }
      const evidence_used = [
        { name: 'oracle_layer_1_math.matchup', id: `${pitcher_id}_${bet_date}`, input_hash: matchupInputsHash },
        { name: 'oracle_layer_2_path.result',  id: `${pitcher_id}_${bet_date}_${strike}_${side}`, input_hash: pathInputsHash },
        { name: 'oracle_layer_3_trust.result', id: `${pitcher_id}_${bet_date}_${strike}_${side}`, input_hash: trustInputsHash },
        { name: 'oracle_critic.preflight_ctx', id: `${pitcher_id}_${bet_date}`,
          input_hash: sha256(preflightContext ?? {}) },
      ]
      const severity = parts.status === 'ok' ? 'info' : 'warn'
      const traceStatus = parts.status === 'ok' ? 'success'
                       : parts.status === 'timeout' ? 'timeout'
                       : 'error'
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
        decision: parts.verdict,
        reason_code: parts.reason_code,
        reasoning: {
          verdict: parts.verdict, confidence: parts.confidence,
          concerns: parts.concerns,
          feasibility: layer2Result.feasibility,
          trust_level: layer3Result.trust_level,
          judge_base_decision: layer3JudgeBaseDecision,
          cache_hit: parts.cache_hit, model_used: parts.model_used,
        },
        metrics: {
          tokens_input: parts.tokens_input, tokens_output: parts.tokens_output,
          cost_usd: parts.cost_usd,
          matchup_output_hash: matchupHash, path_output_hash: pathHash,
          trust_output_hash: trustHash,
        },
        evidence_used,
        input_hash:  inputs_hash,
        output_hash: result.output_hash,
        status:   traceStatus,
        severity,
        latency_ms: Date.now() - t0,
        error_message: parts.error_message,
      })
      trace.writeAsync(event)
    }

    return result
  }
}

// ─── Pure helpers ─────────────────────────────────────────────────

function primaryReasonCode(parsed) {
  if (parsed.verdict === 'proceed' && parsed.concerns.length === 0) return 'clean_proceed'
  if (parsed.verdict === 'boost'   && parsed.concerns.length > 0)   return 'clean_boost'
  if (parsed.concerns.length > 0)  return parsed.concerns[0]
  return parsed.verdict === 'proceed' ? 'clean_proceed' : 'mixed_signals'
}

function callWithTimeout(promise, ms) {
  let to
  const timeout = new Promise((_, reject) => {
    to = setTimeout(() => {
      const err = new Error(`critic call timed out after ${ms}ms`)
      err.code = 'timeout'
      reject(err)
    }, ms)
  })
  return Promise.race([promise.finally(() => clearTimeout(to)), timeout])
}

export { CONCERN_VOCAB }
