// scripts/live/oracleGate.js
//
// Adapter: runs the full Oracle chain (L1 → L2 → L3 → L4 → L5) on a
// single pre-game bet decision and returns the gate verdict.
//
// Used by:
//   - scripts/live/oracleSimulator.js  (shadow / sim mode)
//   - scripts/live/ksBets.js           (production hook, gated by ORACLE_STAGE env)
//
// Returns: { action, stage_applied, baseline, oracle, full_chain }
//   action ∈ 'pass' | 'skip' | 'size_down'
//
// FAIL OPEN on any error: returns 'pass' with logged reason.

import crypto from 'node:crypto'

import Anthropic from '@anthropic-ai/sdk'

import * as db from '../../lib/db.js'
import { archetypeR, pAtLeast } from '../../lib/strikeout-model.js'

import { run as pathRun }   from '../../oracle/layers/2-path/impl.js'
import { run as trustRun }  from '../../oracle/layers/3-trust/impl.js'
import { run as criticRun } from '../../oracle/layers/4-critic/impl.js'
import { run as judgeRun }  from '../../oracle/layers/5-judge/impl.js'

const HAIKU = 'claude-haiku-4-5-20251001'
const COST_INPUT_PER_M  = 0.25
const COST_OUTPUT_PER_M = 1.25
const STRIKES = [3,4,5,6,7,8,9,10,11,12]

// Module-level Anthropic client + critic cache (in-memory; lives for the
// lifetime of the process). Cache key = (pitcher_id, bet_date).
let _anth = null
function anthClient() {
  if (_anth) return _anth
  if (!process.env.ANTHROPIC_API_KEY) return null
  _anth = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  return _anth
}
const _criticCache = new Map()
let _totalCriticCost = 0
let _totalCriticCalls = 0
const COST_CAP_DAILY = 5.00

const criticClient = {
  classify: async ({ system, user, model, max_tokens }) => {
    const c = anthClient()
    if (!c) throw new Error('ANTHROPIC_API_KEY missing')
    if (_totalCriticCost >= COST_CAP_DAILY) {
      const e = new Error('daily cost cap reached')
      e.code = 'cost_cap'
      throw e
    }
    const res = await c.messages.create({ model, max_tokens, system, messages: [{ role: 'user', content: user }] })
    const text = res.content?.map(c => c.type === 'text' ? c.text : '').join('') ?? ''
    const ti = res.usage?.input_tokens ?? null
    const to = res.usage?.output_tokens ?? null
    const cost = (ti != null && to != null) ? (ti * COST_INPUT_PER_M + to * COST_OUTPUT_PER_M) / 1_000_000 : null
    if (cost != null) _totalCriticCost += cost
    _totalCriticCalls++
    return { content: text, model_used: res.model ?? model, tokens_input: ti, tokens_output: to, cost_usd: cost }
  },
}

const cacheAdapter = {
  get: async (k) => _criticCache.get(k) ?? null,
  set: async (k, v) => { _criticCache.set(k, v) },
}

// ─── Build synthetic Layer 1 envelope from decision_pipeline JSON ──
async function buildSyntheticEnvelope(pitcher_id, bet_date) {
  const dp = await db.one(
    `SELECT lambda_calc_json, model_input_json
     FROM decision_pipeline
     WHERE pitcher_id = ? AND bet_date = ?
       AND lambda_calc_json IS NOT NULL AND model_input_json IS NOT NULL
     LIMIT 1`,
    [String(pitcher_id), bet_date],
  )
  if (!dp) return null
  let lc, mi
  try { lc = JSON.parse(dp.lambda_calc_json); mi = JSON.parse(dp.model_input_json) }
  catch { return null }

  const sav = await db.one(
    `SELECT k_pct, ip, manager_leash_factor, nb_r FROM pitcher_statcast WHERE player_id = ? LIMIT 1`,
    [String(pitcher_id)],
  )
  const r = archetypeR(sav)

  const lambda_final = Number(lc.lambda_final)
  const prob_at_least = {}
  for (const k of STRIKES) prob_at_least[String(k)] = pAtLeast(lambda_final, k, r)

  const synthMatchup = crypto.createHash('sha256')
    .update(`${pitcher_id}|${bet_date}|${lambda_final}`).digest('hex')
  const synthInputs = crypto.createHash('sha256').update(`${synthMatchup}-inputs`).digest('hex')

  return {
    schema_version: '1.0.0', layer: 'math', layer_version: '1.0.0',
    source: 'oracle_layer_1_math',
    run_id: `gate-${pitcher_id}-${bet_date}`, decision_id: null,
    computed_at: new Date().toISOString(), commit_hash: 'oracle-gate',
    inputs_hash: synthInputs, output_hash: synthMatchup,
    inner: {
      expectedBF: Number(mi.expected_bf),
      pK_blended: Number(lc.p_k_blended),
      avgPitches: Number.isFinite(lc.avg_pitches) ? lc.avg_pitches : null,
      leashFlag:  !!lc.leash_flag,
      bfSource:   mi.bf_source,
      lambdaBase: Number(lc.lambda_base),
      nStarts:    mi.n_starts,
      confidence: mi.confidence,
    },
    outer: {
      multipliers: {
        split_adj:    Number(lc.split_adj    ?? 1),
        opp_adj:      Number(lc.opp_adj      ?? 1),
        park_factor:  Number(lc.park_factor  ?? 1),
        weather_mult: Number(lc.weather_mult ?? 1),
        ump_factor:   Number(lc.ump_factor   ?? 1),
      },
      lambda_final,
    },
    nb_r: r,
    nb_r_source: sav?.nb_r != null ? 'fitted' : (sav?.k_pct != null ? 'archetype_kpct' : 'global_default'),
    prob_at_least,
    status: 'ok', warnings: [],
  }
}

// ─── Pull preflight context from decision_pipeline.preflight_json ─
async function buildPreflightContext(pitcher_id, bet_date, pitcher_name) {
  const dp = await db.one(
    `SELECT preflight_json FROM decision_pipeline WHERE pitcher_id = ? AND bet_date = ? LIMIT 1`,
    [String(pitcher_id), bet_date],
  )
  let pj = null
  try { if (dp?.preflight_json) pj = JSON.parse(dp.preflight_json) } catch { /* ignore */ }
  const pitcherNews = []
  const opponentNews = []
  const headlines = pj?.headlines ?? []
  if (Array.isArray(headlines)) {
    for (const h of headlines.slice(0, 8)) {
      const text = typeof h === 'string' ? h : (h?.title ?? h?.text ?? '')
      if (!text) continue
      const lower = text.toLowerCase()
      if (lower.includes(pitcher_name?.toLowerCase?.() ?? '___')) pitcherNews.push(text)
      else                                                          opponentNews.push(text)
    }
  }
  if (pj?.summary_text && !pj.summary_text.includes('No relevant headlines')) {
    pitcherNews.push(`[summary] ${pj.summary_text}`.slice(0, 200))
  }
  return {
    pitcherNews: pitcherNews.slice(0, 5),
    opponentNews: opponentNews.slice(0, 3),
    lineupStatus: { home_lineup_posted: true, away_lineup_posted: true, scratch_alert: false },
    lineDirection: { home: 0, away: 0 },
    weatherData: null, bullpenData: null, umpireData: null,
    kPropGap: Number.isFinite(pj?.k_prop_gap) ? pj.k_prop_gap : null,
  }
}

/**
 * runOracleGate(args) — main entry.
 *
 * args:
 *   bet_date        'YYYY-MM-DD'
 *   pitcher_id      string
 *   pitcher_name    string
 *   strike          number
 *   side            'YES' | 'NO'
 *   market_mid      number in cents (production stores this in cents)
 *   spread          number in cents (optional)
 *   bankroll        number (defaults 1000)
 *   bet_id          string/number (optional, for logging)
 *   ticker          string (optional, for closing-line capture later)
 *   decision_id     string (optional; defaults to a deterministic id)
 *
 * returns { action, stage_applied, baseline, oracle, error? }
 */
export async function runOracleGate(args) {
  const {
    bet_date, pitcher_id, pitcher_name, strike, side,
    market_mid, spread = null, bankroll = 1000, bet_id = null,
    ticker = null,
    decision_id: customDecisionId = null,
  } = args

  const decision_id = customDecisionId ?? `gate-${bet_id ?? `${pitcher_id}-${bet_date}-${strike}-${side}`}`
  const out = {
    action: 'pass',          // default: production decides
    stage_applied: null,
    baseline: null,
    oracle: null,
    error: null,
    ticker: ticker,
    timing: { started_at: new Date().toISOString(), elapsed_ms: null },
  }
  const t0 = Date.now()
  try {
    const env = await buildSyntheticEnvelope(pitcher_id, bet_date)
    if (!env) {
      out.action = 'pass'
      out.error  = 'no_decision_pipeline_json'
      out.timing.elapsed_ms = Date.now() - t0
      return out
    }
    const pre = await buildPreflightContext(pitcher_id, bet_date, pitcher_name)

    const ctx = {
      decision_id,
      pitcher_id: String(pitcher_id),
      pitcher_name,
      bet_date,
      strike: Number(strike),
      side,
    }

    const pathR  = await pathRun(env, ctx)
    const trustR = await trustRun(env, pathR, ctx)
    const criticR = await criticRun(env, pathR, trustR, {
      ...ctx,
      market_mid: Number(market_mid) / 100,
      edge: null,
      preflightContext: pre,
      criticClient,
      cache: cacheAdapter,
      timeout_ms: 15_000,
    })
    const judgeR = await judgeRun(env, pathR, trustR, {
      ...ctx,
      market_mid: Number(market_mid) / 100,
      spread: Number.isFinite(Number(spread)) ? Number(spread) / 100 : null,
      bankroll,
      criticResult: criticR,
    })

    out.action = judgeR.decision === 'fire' ? 'pass'
                : judgeR.decision === 'skip' ? 'skip'
                : 'size_down'
    out.stage_applied = 3   // we always run the full chain incl. critic
    out.baseline = {
      decision: judgeR.baseline_decision,
      reason:   judgeR.baseline_reason,
    }
    out.oracle = {
      feasibility:   pathR.feasibility,
      path_reason:   pathR.reason_code,
      trust_score:   trustR.trust_score,
      trust_level:   trustR.trust_level,
      critic_verdict: criticR.verdict,
      critic_concerns: criticR.concerns,
      critic_reason_text: criticR.reason_text ?? '',
      critic_raw_response: criticR.raw_response ?? '',
      critic_status:  criticR.status,
      critic_cost:    criticR.cost_usd,
      decision:      judgeR.decision,
      reason:        judgeR.reason_code,
      critic_applied: judgeR.critic_applied,
      edge:          judgeR.edge,
      threshold:     judgeR.threshold,
      kelly_eff:     judgeR.kelly_eff,
      size_usd:      judgeR.size_usd,
      lambda_final:  env.outer.lambda_final,
      prob_side:     judgeR.prob_side,
    }
    out.timing.elapsed_ms = Date.now() - t0
    return out
  } catch (err) {
    out.action = 'pass'    // FAIL OPEN
    out.error = String(err?.message ?? err)
    out.timing.elapsed_ms = Date.now() - t0
    return out
  }
}

// Diagnostic getters — used by simulator end-of-run reports
export function gateStats() {
  return {
    critic_calls: _totalCriticCalls,
    critic_cost_usd: _totalCriticCost,
    cache_size: _criticCache.size,
  }
}
