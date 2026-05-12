// scripts/oracle/stage3vs4Backtest.js
//
// Test 1 — Stage 3 vs Stage 4 diff backtest.
//
// Single question: did Stage 4 (boost upgrades) add value over Stage 3?
//
// Same historical bets, same chain, ONE Critic call per bet (cached
// across runs). Stage 3 reverts Critic's boost upgrade back to
// size_down; Stage 4 respects it. Diff measured.
//
// Cost: ~$0.30 worst case (assuming critic-cache.json is fresh).
//   Cached calls are free; new bets only pay the Haiku cost.

import 'dotenv/config'
import { writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import * as db from '../../lib/db.js'
import { parseArgs } from '../../lib/cli-args.js'
import crypto from 'node:crypto'

import Anthropic from '@anthropic-ai/sdk'

import { archetypeR, pAtLeast } from '../../lib/strikeout-model.js'
import { run as pathRun }   from '../../oracle/layers/2-path/impl.js'
import { run as trustRun }  from '../../oracle/layers/3-trust/impl.js'
import { run as criticRun } from '../../oracle/layers/4-critic/impl.js'
import { run as judgeRun }  from '../../oracle/layers/5-judge/impl.js'

const today    = new Date().toISOString().slice(0, 10)
const sixtyAgo = new Date(Date.now() - 60 * 86400_000).toISOString().slice(0, 10)
const opts = parseArgs({
  since:    { default: sixtyAgo },
  until:    { default: today },
  bankroll: { type: 'number', default: 1000 },
  costCap:  { flag: 'cost-cap', type: 'number', default: 2.00 },
})
const SINCE = opts.since
const UNTIL = opts.until
const BANKROLL = opts.bankroll
const COST_CAP = opts.costCap
const OUTBASE = `oracle/stage3vs4-backtest-${today}`
const CACHE_PATH = path.resolve('oracle/critic-cache.json')

const STRIKES = [3,4,5,6,7,8,9,10,11,12]
const HAIKU = 'claude-haiku-4-5-20251001'
const COST_INPUT_PER_M  = 0.25
const COST_OUTPUT_PER_M = 1.25

console.log(`[stage3vs4] window ${SINCE} → ${UNTIL}, cost_cap=$${COST_CAP}`)

// ─── Critic cache (file-backed) ──────────────────────────────────
let cacheStore = {}
if (existsSync(CACHE_PATH)) {
  try { cacheStore = JSON.parse(readFileSync(CACHE_PATH, 'utf-8')); console.log(`[cache] loaded ${Object.keys(cacheStore).length} entries`) } catch {}
}
function persistCache() {
  try { mkdirSync(path.dirname(CACHE_PATH), { recursive: true }); writeFileSync(CACHE_PATH, JSON.stringify(cacheStore, null, 0), 'utf-8') } catch {}
}
const cache = {
  get: async (k) => cacheStore[k] ?? null,
  set: async (k, v) => { cacheStore[k] = v },
}

// ─── Anthropic client with cost tracking ─────────────────────────
const anth = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
let totalCost = 0, totalCalls = 0, capExceeded = false

const criticClient = {
  classify: async ({ system, user, model, max_tokens }) => {
    if (totalCost >= COST_CAP) { capExceeded = true; throw new Error('cost cap reached') }
    const res = await anth.messages.create({ model, max_tokens, system, messages: [{ role: 'user', content: user }] })
    const text = res.content?.map(c => c.type === 'text' ? c.text : '').join('') ?? ''
    const ti = res.usage?.input_tokens ?? null
    const to = res.usage?.output_tokens ?? null
    const cost = (ti != null && to != null) ? (ti * COST_INPUT_PER_M + to * COST_OUTPUT_PER_M) / 1_000_000 : null
    if (cost != null) totalCost += cost
    totalCalls++
    return { content: text, model_used: res.model ?? model, tokens_input: ti, tokens_output: to, cost_usd: cost }
  },
}

// ─── Load bets ───────────────────────────────────────────────────
const bets = await db.all(`
  SELECT b.id AS bet_id, b.bet_date, b.pitcher_id, b.pitcher_name, b.strike, b.side,
         b.result, b.actual_ks, b.pnl, b.bet_size, b.market_mid, b.spread, b.user_id,
         dp.lambda_calc_json, dp.model_input_json, dp.preflight_json
  FROM ks_bets b
  LEFT JOIN decision_pipeline dp ON dp.bet_date=b.bet_date AND dp.pitcher_id=b.pitcher_id
  WHERE b.result IN ('win','loss','void')
    AND b.actual_ks IS NOT NULL
    AND b.live_bet = 0
    AND b.bet_date BETWEEN ? AND ?
  ORDER BY b.bet_date ASC, b.id ASC
`, [SINCE, UNTIL])
console.log(`[stage3vs4] loaded ${bets.length} settled placed pre-game bets`)

const pidSet = [...new Set(bets.map(b => String(b.pitcher_id)))]
const savantRows = pidSet.length
  ? await db.all(`SELECT player_id, k_pct, ip, manager_leash_factor, nb_r FROM pitcher_statcast WHERE player_id IN (${pidSet.map(()=>'?').join(',')})`, pidSet)
  : []
const savantMap = new Map(savantRows.map(r => [String(r.player_id), r]))

// ─── Helpers ─────────────────────────────────────────────────────
function buildSyntheticEnvelope(row, savant) {
  const lc = JSON.parse(row.lambda_calc_json)
  const mi = JSON.parse(row.model_input_json)
  const lambda_final = Number(lc.lambda_final)
  const r = archetypeR(savant)
  const prob_at_least = {}
  for (const k of STRIKES) prob_at_least[String(k)] = pAtLeast(lambda_final, k, r)
  const synthMatchup = crypto.createHash('sha256').update(`${row.pitcher_id}|${row.bet_date}|${lambda_final}`).digest('hex')
  const synthInputs  = crypto.createHash('sha256').update(`${synthMatchup}-inputs`).digest('hex')
  return {
    schema_version: '1.0.0', layer: 'math', layer_version: '1.0.0', source: 'oracle_layer_1_math',
    run_id: `synth-${row.bet_id}`, decision_id: null,
    computed_at: '2026-05-01T00:00:00.000Z', commit_hash: 'backtest-synth',
    inputs_hash: synthInputs, output_hash: synthMatchup,
    inner: {
      expectedBF: Number(mi.expected_bf), pK_blended: Number(lc.p_k_blended),
      avgPitches: Number.isFinite(lc.avg_pitches) ? lc.avg_pitches : null,
      leashFlag: !!lc.leash_flag, bfSource: mi.bf_source,
      lambdaBase: Number(lc.lambda_base), nStarts: mi.n_starts, confidence: mi.confidence,
    },
    outer: {
      multipliers: {
        split_adj: Number(lc.split_adj ?? 1), opp_adj: Number(lc.opp_adj ?? 1),
        park_factor: Number(lc.park_factor ?? 1),
        weather_mult: Number(lc.weather_mult ?? 1), ump_factor: Number(lc.ump_factor ?? 1),
      },
      lambda_final,
    },
    nb_r: r,
    nb_r_source: savant?.nb_r != null ? 'fitted' : (savant?.k_pct != null ? 'archetype_kpct' : 'global_default'),
    prob_at_least, status: 'ok', warnings: [],
  }
}

function buildPreflightContext(row) {
  let pj = null
  try { if (row.preflight_json) pj = JSON.parse(row.preflight_json) } catch {}
  const pitcherNews = []
  const opponentNews = []
  const headlines = pj?.headlines ?? []
  if (Array.isArray(headlines)) {
    for (const h of headlines.slice(0, 8)) {
      const text = typeof h === 'string' ? h : (h?.title ?? h?.text ?? '')
      if (!text) continue
      const lower = text.toLowerCase()
      if (lower.includes(row.pitcher_name?.toLowerCase?.() ?? '___')) pitcherNews.push(text)
      else                                                              opponentNews.push(text)
    }
  }
  if (pj?.summary_text && !pj.summary_text.includes('No relevant headlines')) {
    pitcherNews.push(`[summary] ${pj.summary_text}`.slice(0, 200))
  }
  return {
    pitcherNews: pitcherNews.slice(0, 5), opponentNews: opponentNews.slice(0, 3),
    lineupStatus: { home_lineup_posted: true, away_lineup_posted: true, scratch_alert: false },
    lineDirection: { home: 0, away: 0 }, weatherData: null, bullpenData: null, umpireData: null,
    kPropGap: Number.isFinite(pj?.k_prop_gap) ? pj.k_prop_gap : null,
  }
}

function fixedSizePnl(decision, productionPnl) {
  if (decision === 'skip')      return 0
  if (decision === 'size_down') return productionPnl * 0.5
  return productionPnl                // fire
}

// ─── Main loop: ONE chain run per bet, two stage scorings ────────
const skipped = { no_dp: 0, parse_fail: 0, judge_fail: 0 }
const records = []
const startTime = Date.now()
let progress = 0

for (const row of bets) {
  if (!row.lambda_calc_json || !row.model_input_json) { skipped.no_dp++; continue }
  let env, pre
  try {
    env = buildSyntheticEnvelope(row, savantMap.get(String(row.pitcher_id)))
    pre = buildPreflightContext(row)
  } catch { skipped.parse_fail++; continue }

  const ctx = {
    decision_id: `s3v4-${row.bet_id}`,
    pitcher_id: String(row.pitcher_id), pitcher_name: row.pitcher_name,
    bet_date: row.bet_date, strike: Number(row.strike), side: row.side,
  }

  let pathR, trustR, criticR, judgeS4
  try {
    pathR  = await pathRun(env, ctx)
    trustR = await trustRun(env, pathR, ctx)
    criticR = capExceeded
      ? { verdict: 'proceed', confidence: 'low', concerns: [], reason_code: 'critic_unavailable',
          status: 'unavailable', model_used: 'unavailable', cost_usd: null, output_hash: null, inputs_hash: null }
      : await criticRun(env, pathR, trustR, {
          ...ctx, market_mid: Number(row.market_mid)/100, edge: null,
          preflightContext: pre, criticClient, cache, timeout_ms: 15_000,
        })
    judgeS4 = await judgeRun(env, pathR, trustR, {
      ...ctx,
      market_mid: Number(row.market_mid)/100,
      spread: Number.isFinite(Number(row.spread)) ? Number(row.spread)/100 : null,
      bankroll: BANKROLL,
      criticResult: criticR,
    })
  } catch {
    skipped.judge_fail++
    continue
  }

  // Stage 4 decision = whatever Judge said (boost respected)
  const stage4Decision = judgeS4.decision

  // Stage 3 decision: revert Critic boost. If Judge applied boost
  // (decision became fire because Critic boosted size_down), back off
  // to size_down. Otherwise same as Stage 4.
  const boostUpgraded = (judgeS4.critic_applied ?? []).includes('boost')
  const stage3Decision = boostUpgraded ? 'size_down' : stage4Decision

  const productionPnl = Number(row.pnl) || 0
  const stage3Pnl = fixedSizePnl(stage3Decision, productionPnl)
  const stage4Pnl = fixedSizePnl(stage4Decision, productionPnl)

  records.push({
    bet_id: row.bet_id, bet_date: row.bet_date,
    pitcher_id: row.pitcher_id, pitcher_name: row.pitcher_name,
    strike: row.strike, side: row.side, result: row.result,
    actual_ks: row.actual_ks, production_pnl: productionPnl,
    production_size: Number(row.bet_size) || 0,
    user_id: row.user_id,
    feasibility: pathR.feasibility, trust_level: trustR.trust_level,
    trust_score: trustR.trust_score,
    critic_verdict: criticR.verdict, critic_concerns: criticR.concerns,
    critic_status: criticR.status,
    judge_baseline: judgeS4.baseline_decision, judge_baseline_reason: judgeS4.baseline_reason,
    critic_applied: judgeS4.critic_applied,
    boost_upgraded: boostUpgraded,
    stage3_decision: stage3Decision, stage3_pnl: stage3Pnl,
    stage4_decision: stage4Decision, stage4_pnl: stage4Pnl,
    delta_pnl: stage4Pnl - stage3Pnl,
  })
  progress++
  if (progress % 50 === 0) {
    console.log(`  [${progress}/${bets.length}] cost=$${totalCost.toFixed(4)} calls=${totalCalls}`)
    persistCache()
  }
}
persistCache()
console.log(`[stage3vs4] processed ${records.length} bets; skipped no_dp=${skipped.no_dp} parse_fail=${skipped.parse_fail} judge_fail=${skipped.judge_fail}`)
console.log(`[stage3vs4] critic cost: $${totalCost.toFixed(4)} (${totalCalls} new calls; rest cached)`)

await db.close()

// ─── Aggregate ───────────────────────────────────────────────────
const totalProductionPnl = records.reduce((s, r) => s + r.production_pnl, 0)
const totalStage3Pnl = records.reduce((s, r) => s + r.stage3_pnl, 0)
const totalStage4Pnl = records.reduce((s, r) => s + r.stage4_pnl, 0)
const stage4MinusStage3 = totalStage4Pnl - totalStage3Pnl

const boosted = records.filter(r => r.boost_upgraded)
const boostedWins = boosted.filter(r => r.result === 'win').length
const boostedLosses = boosted.filter(r => r.result === 'loss').length
const boostedVoids = boosted.filter(r => r.result === 'void').length
const boostedPnlStage3 = boosted.reduce((s, r) => s + r.stage3_pnl, 0)
const boostedPnlStage4 = boosted.reduce((s, r) => s + r.stage4_pnl, 0)
const boostedDelta = boostedPnlStage4 - boostedPnlStage3   // = sum of boosted productionPnl × 0.5
const boostedWinRate = boostedWins + boostedLosses > 0 ? boostedWins / (boostedWins + boostedLosses) : null

const divergent = records.filter(r => r.stage3_decision !== r.stage4_decision)

// Concentration: top pitchers + top dates among boosted bets
const pitcherDelta = new Map()
const dateDelta = new Map()
for (const r of boosted) {
  const p = r.pitcher_name
  pitcherDelta.set(p, (pitcherDelta.get(p) ?? 0) + r.delta_pnl)
  const d = r.bet_date
  dateDelta.set(d, (dateDelta.get(d) ?? 0) + r.delta_pnl)
}
const topPitchersByAbsDelta = [...pitcherDelta.entries()]
  .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 5)
const topDatesByAbsDelta = [...dateDelta.entries()]
  .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 3)

// Top 5 helped (delta_pnl > 0) and top 5 hurt (delta_pnl < 0) by absolute magnitude.
const helped = boosted.filter(r => r.delta_pnl > 0).sort((a, b) => b.delta_pnl - a.delta_pnl).slice(0, 5)
const hurt   = boosted.filter(r => r.delta_pnl < 0).sort((a, b) => a.delta_pnl - b.delta_pnl).slice(0, 5)

// Concentration check: does one pitcher/date dominate?
const totalAbsDelta = boosted.reduce((s, r) => s + Math.abs(r.delta_pnl), 0)
const concentrationByPitcher = topPitchersByAbsDelta[0]
  ? Math.abs(topPitchersByAbsDelta[0][1]) / Math.max(1, totalAbsDelta)
  : 0

// ─── Verdict ─────────────────────────────────────────────────────
let verdict, verdictReason
if (boosted.length === 0) {
  verdict = 'INCONCLUSIVE — no boost activations'
  verdictReason = 'Critic never produced boost verdicts on this sample; Stage 3 and Stage 4 produced identical decisions everywhere.'
} else if (boosted.length < 5) {
  verdict = 'INCONCLUSIVE — too few activations'
  verdictReason = `Only ${boosted.length} boost activation(s); sample too thin to judge.`
} else if (concentrationByPitcher > 0.50) {
  verdict = 'NO-GO on Stage 4 — concentrated'
  verdictReason = `One pitcher accounts for ${(concentrationByPitcher*100).toFixed(0)}% of the absolute Stage 4 delta. Not robust enough to ship.`
} else if (stage4MinusStage3 > 0 && (boostedWinRate ?? 0) >= 0.50) {
  verdict = 'GO Stage 4 — boost adds value'
  verdictReason = `Stage 4 outperformed Stage 3 by $${stage4MinusStage3.toFixed(2)} on ${boosted.length} boost activations; win rate on boosted bets ${((boostedWinRate ?? 0)*100).toFixed(1)}%.`
} else if (stage4MinusStage3 < 0) {
  verdict = 'NO-GO on Stage 4 — boost hurts'
  verdictReason = `Stage 4 underperformed Stage 3 by $${Math.abs(stage4MinusStage3).toFixed(2)}. Boost activations were net losers.`
} else {
  verdict = 'INCONCLUSIVE — small effect'
  verdictReason = `Stage 4 delta vs Stage 3 = $${stage4MinusStage3.toFixed(2)}; boosted win rate ${((boostedWinRate ?? 0)*100).toFixed(1)}%. Not enough signal to ship.`
}

// ─── Render markdown ─────────────────────────────────────────────
const lines = []
const fmt = (n, d=2) => Number.isFinite(n) ? n.toFixed(d) : '—'

lines.push(`# Stage 3 vs Stage 4 Backtest — ${today}`)
lines.push(``)
lines.push(`**One question:** did Stage 4 (boost upgrade) add value over Stage 3 (boost reverted)?`)
lines.push(``)
lines.push(`Window: ${SINCE} → ${UNTIL}`)
lines.push(`Bankroll: $${BANKROLL}`)
lines.push(``)
lines.push(`## Verdict`)
lines.push(``)
lines.push(`**${verdict}**`)
lines.push(``)
lines.push(verdictReason)
lines.push(``)
lines.push(`## Headline`)
lines.push(``)
lines.push(`| Metric | Value |`)
lines.push(`|---|---:|`)
lines.push(`| Sample (replayable bets) | ${records.length} |`)
lines.push(`| Production P&L | $${fmt(totalProductionPnl)} |`)
lines.push(`| Oracle Stage 3 P&L (fixed-size) | $${fmt(totalStage3Pnl)} |`)
lines.push(`| Oracle Stage 4 P&L (fixed-size) | $${fmt(totalStage4Pnl)} |`)
lines.push(`| **Stage 4 minus Stage 3** | **$${fmt(stage4MinusStage3)}** |`)
lines.push(`| Divergent decisions | ${divergent.length} of ${records.length} |`)
lines.push(``)
lines.push(`## Boost activation summary`)
lines.push(``)
lines.push(`| Metric | Value |`)
lines.push(`|---|---:|`)
lines.push(`| Boost activations | ${boosted.length} |`)
lines.push(`| - wins | ${boostedWins} |`)
lines.push(`| - losses | ${boostedLosses} |`)
lines.push(`| - voids | ${boostedVoids} |`)
lines.push(`| Boosted win rate (excl. voids) | ${boostedWinRate != null ? (boostedWinRate*100).toFixed(1) + '%' : '—'} |`)
lines.push(`| Boosted P&L Stage 3 (size_down) | $${fmt(boostedPnlStage3)} |`)
lines.push(`| Boosted P&L Stage 4 (fire) | $${fmt(boostedPnlStage4)} |`)
lines.push(`| Stage 4 boost delta | $${fmt(boostedDelta)} |`)
lines.push(``)
lines.push(`Boost only fires when ALL of: feasibility != fragile, baseline reason was LOW_TRUST_SIZE_DOWN, trust_score >= 0.50, edge >= threshold. So all guards passed for these activations.`)
lines.push(``)

lines.push(`## Concentration`)
lines.push(``)
lines.push(`Top pitchers by absolute Stage 4 delta on boosted bets:`)
lines.push(``)
lines.push(`| pitcher | delta | % of |delta| total |`)
lines.push(`|---|---:|---:|`)
for (const [p, d] of topPitchersByAbsDelta) {
  const pct = totalAbsDelta > 0 ? Math.abs(d) / totalAbsDelta * 100 : 0
  lines.push(`| ${p} | $${fmt(d)} | ${pct.toFixed(1)}% |`)
}
lines.push(``)
lines.push(`Top dates by absolute Stage 4 delta on boosted bets:`)
lines.push(``)
lines.push(`| date | delta |`)
lines.push(`|---|---:|`)
for (const [d, v] of topDatesByAbsDelta) lines.push(`| ${d} | $${fmt(v)} |`)
lines.push(``)
if (concentrationByPitcher > 0.40) {
  lines.push(`⚠ **${(concentrationByPitcher*100).toFixed(0)}% of |delta| comes from a single pitcher.** Stage 4's signal is fragile.`)
}
lines.push(``)

lines.push(`## Top 5 helped (Stage 4 won where Stage 3 sized down)`)
lines.push(``)
lines.push(`| date | pitcher | strike-side | result | actual_ks | production_pnl | Stage 3 pnl | Stage 4 pnl | delta |`)
lines.push(`|---|---|---|---|---:|---:|---:|---:|---:|`)
for (const r of helped) {
  lines.push(`| ${r.bet_date} | ${r.pitcher_name} | ${r.strike}${r.side} | ${r.result} | ${r.actual_ks} | $${fmt(r.production_pnl)} | $${fmt(r.stage3_pnl)} | $${fmt(r.stage4_pnl)} | +$${fmt(r.delta_pnl)} |`)
}
lines.push(``)

lines.push(`## Top 5 hurt (Stage 4 amplified loss where Stage 3 half-saved)`)
lines.push(``)
lines.push(`| date | pitcher | strike-side | result | actual_ks | production_pnl | Stage 3 pnl | Stage 4 pnl | delta |`)
lines.push(`|---|---|---|---|---:|---:|---:|---:|---:|`)
for (const r of hurt) {
  lines.push(`| ${r.bet_date} | ${r.pitcher_name} | ${r.strike}${r.side} | ${r.result} | ${r.actual_ks} | $${fmt(r.production_pnl)} | $${fmt(r.stage3_pnl)} | $${fmt(r.stage4_pnl)} | $${fmt(r.delta_pnl)} |`)
}
lines.push(``)

lines.push(`## All boost activations`)
lines.push(``)
lines.push(`| date | pitcher | strike-side | result | concerns | Stage 3 pnl | Stage 4 pnl | delta |`)
lines.push(`|---|---|---|---|---|---:|---:|---:|`)
for (const r of boosted.sort((a,b) => Math.abs(b.delta_pnl) - Math.abs(a.delta_pnl))) {
  const concerns = (r.critic_concerns ?? []).join('; ') || '—'
  lines.push(`| ${r.bet_date} | ${r.pitcher_name} | ${r.strike}${r.side} | ${r.result} | ${concerns} | $${fmt(r.stage3_pnl)} | $${fmt(r.stage4_pnl)} | ${r.delta_pnl >= 0 ? '+' : ''}$${fmt(r.delta_pnl)} |`)
}
lines.push(``)

lines.push(`## Method`)
lines.push(``)
lines.push(`- One Critic call per bet (real Haiku 4.5; cached per (pitcher, bet_date)).`)
lines.push(`- Judge v0.2 produces final decision incorporating Critic ladder.`)
lines.push(`- Stage 3 = revert Critic boost (size_down stays size_down even if Critic said boost).`)
lines.push(`- Stage 4 = respect Critic boost (size_down → fire when guards pass).`)
lines.push(`- Both scored on fixed-size P&L: skip→0, size_down→0.5×production_pnl, fire→production_pnl.`)
lines.push(`- Boost guards (must ALL pass): feasibility != fragile, baseline_reason = LOW_TRUST_SIZE_DOWN, trust_score >= 0.50, edge >= threshold.`)
lines.push(``)

lines.push(`## Caveats`)
lines.push(``)
lines.push(`1. Sample is the same ~7-10 day window of replayable settled pre-game bets.`)
lines.push(`2. Today's pitcher_statcast used for r — drift caveat carries over.`)
lines.push(`3. Critic prompt and guards locked at v1; future tuning may change boost behavior.`)
lines.push(`4. Calibration is OFF (NO-GO from L1.5.2). Probability bias may distort edge calc.`)
lines.push(``)

const mdPath = path.resolve(`${OUTBASE}.md`)
writeFileSync(mdPath, lines.join('\n'), 'utf-8')

const csvLines = ['bet_id,bet_date,pitcher,strike,side,result,actual_ks,production_pnl,feasibility,trust_level,trust_score,critic_verdict,boost_upgraded,judge_baseline,stage3_decision,stage4_decision,stage3_pnl,stage4_pnl,delta_pnl']
for (const r of records) {
  const safe = (s) => String(s ?? '').replace(/,/g, ';')
  csvLines.push([
    r.bet_id, r.bet_date, safe(r.pitcher_name), r.strike, r.side, r.result, r.actual_ks,
    r.production_pnl.toFixed(2), r.feasibility, r.trust_level, r.trust_score?.toFixed(3),
    r.critic_verdict, r.boost_upgraded ? 1 : 0, r.judge_baseline,
    r.stage3_decision, r.stage4_decision,
    r.stage3_pnl.toFixed(2), r.stage4_pnl.toFixed(2), r.delta_pnl.toFixed(2),
  ].join(','))
}
const csvPath = path.resolve(`${OUTBASE}.csv`)
writeFileSync(csvPath, csvLines.join('\n'), 'utf-8')

// ─── Stdout summary ──────────────────────────────────────────────
console.log('\n═══════════════════════════════════════════')
console.log('  STAGE 3 vs STAGE 4 — RESULT')
console.log('═══════════════════════════════════════════')
console.log(`Verdict:                 ${verdict}`)
console.log(``)
console.log(`Sample:                  ${records.length} replayable bets`)
console.log(`Production P&L:          $${totalProductionPnl.toFixed(2)}`)
console.log(`Stage 3 P&L:             $${totalStage3Pnl.toFixed(2)}`)
console.log(`Stage 4 P&L:             $${totalStage4Pnl.toFixed(2)}`)
console.log(`Stage 4 minus Stage 3:   $${stage4MinusStage3.toFixed(2)}`)
console.log(`Divergent decisions:     ${divergent.length}`)
console.log(``)
console.log(`Boost activations:       ${boosted.length}`)
console.log(`  wins / losses / voids: ${boostedWins} / ${boostedLosses} / ${boostedVoids}`)
console.log(`  win rate (excl void):  ${boostedWinRate != null ? (boostedWinRate*100).toFixed(1) + '%' : '—'}`)
console.log(`  Stage 3 boosted P&L:   $${boostedPnlStage3.toFixed(2)}`)
console.log(`  Stage 4 boosted P&L:   $${boostedPnlStage4.toFixed(2)}`)
console.log(`  delta:                 $${boostedDelta.toFixed(2)}`)
console.log(``)
if (boosted.length > 0) {
  console.log(`Top concentration: ${topPitchersByAbsDelta[0]?.[0]} → ${(concentrationByPitcher*100).toFixed(0)}% of |delta|`)
}
console.log(``)
console.log(`Critic API cost: $${totalCost.toFixed(4)} (${totalCalls} new calls; rest cached)`)
console.log(``)
console.log(`Markdown: ${mdPath}`)
console.log(`CSV:      ${csvPath}`)
