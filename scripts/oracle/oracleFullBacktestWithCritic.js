// scripts/oracle/oracleFullBacktestWithCritic.js
//
// Full Oracle pipeline backtest WITH REAL CRITIC (Haiku 4.5).
//
// For every settled placed pre-game bet with a decision_pipeline JSON
// snapshot:
//   1. Reconstruct a synthetic Layer 1 envelope (same as oracleFullBacktest)
//   2. Build a Critic preflight context from production's stored
//      preflight_json (what production saw at bet time)
//   3. Run L1 → L2 → L3 → L4 (real Haiku) → L5
//   4. Compare to baseline production AND to no-Critic Oracle chain
//
// Cost: ~314 Haiku calls × ~$0.001 ≈ $0.31. Hard cap at $2.00 by default.
//
// File-based cache at oracle/critic-cache.json so re-runs are free.
//
// Usage:
//   node scripts/oracle/oracleFullBacktestWithCritic.js [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--cost-cap 2.00] [--limit 50]

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
  limit:    { type: 'number', default: 0 },   // 0 = no limit
  output:   { default: null },
})
const SINCE = opts.since
const UNTIL = opts.until
const BANKROLL = opts.bankroll
const COST_CAP = opts.costCap
const LIMIT = opts.limit
const OUTBASE = opts.output ?? `oracle/oracle-full-backtest-with-critic-${today}`

const CACHE_PATH = path.resolve('oracle/critic-cache.json')
const STRIKES = [3,4,5,6,7,8,9,10,11,12]
const HAIKU = 'claude-haiku-4-5-20251001'
const COST_INPUT_PER_M  = 0.25
const COST_OUTPUT_PER_M = 1.25

console.log(`[oracleFullBacktestWithCritic] window ${SINCE} → ${UNTIL}, bankroll=$${BANKROLL}, cost_cap=$${COST_CAP}`)
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY not set'); process.exit(1)
}

// ─── File-based cache ─────────────────────────────────────────────
let cacheStore = {}
if (existsSync(CACHE_PATH)) {
  try {
    cacheStore = JSON.parse(readFileSync(CACHE_PATH, 'utf-8'))
    console.log(`[cache] loaded ${Object.keys(cacheStore).length} entries from ${CACHE_PATH}`)
  } catch { /* ignore */ }
}
function persistCache() {
  try {
    mkdirSync(path.dirname(CACHE_PATH), { recursive: true })
    writeFileSync(CACHE_PATH, JSON.stringify(cacheStore, null, 0), 'utf-8')
  } catch (e) {
    console.error('cache persist failed:', e.message)
  }
}
const cache = {
  get: async (k) => cacheStore[k] ?? null,
  set: async (k, v) => { cacheStore[k] = v },
}

// ─── Anthropic client with cost tracking ─────────────────────────
const anth = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
let totalCost = 0
let totalCalls = 0
let costCapExceeded = false

const criticClient = {
  classify: async ({ system, user, model, max_tokens }) => {
    if (totalCost >= COST_CAP) {
      costCapExceeded = true
      throw new Error(`cost cap $${COST_CAP} reached`)
    }
    const res = await anth.messages.create({
      model, max_tokens, system,
      messages: [{ role: 'user', content: user }],
    })
    const text = res.content?.map(c => c.type === 'text' ? c.text : '').join('') ?? ''
    const ti = res.usage?.input_tokens ?? null
    const to = res.usage?.output_tokens ?? null
    const cost = (ti != null && to != null)
      ? (ti * COST_INPUT_PER_M + to * COST_OUTPUT_PER_M) / 1_000_000
      : null
    if (cost != null) totalCost += cost
    totalCalls++
    return { content: text, model_used: res.model ?? model, tokens_input: ti, tokens_output: to, cost_usd: cost }
  },
}

// ─── Load bets ────────────────────────────────────────────────────
const bets = await db.all(`
  SELECT
    b.id            AS bet_id,
    b.bet_date,
    b.pitcher_id,
    b.pitcher_name,
    b.strike,
    b.side,
    b.result,
    b.actual_ks,
    b.pnl,
    b.bet_size,
    b.fill_price,
    b.market_mid,
    b.spread,
    b.user_id,
    dp.lambda_calc_json,
    dp.model_input_json,
    dp.preflight_json
  FROM ks_bets b
  LEFT JOIN decision_pipeline dp
    ON dp.bet_date = b.bet_date AND dp.pitcher_id = b.pitcher_id
  WHERE b.result IN ('win','loss','void')
    AND b.actual_ks IS NOT NULL
    AND b.live_bet = 0
    AND b.bet_date BETWEEN ? AND ?
  ORDER BY b.bet_date ASC, b.id ASC
  ${LIMIT > 0 ? `LIMIT ${LIMIT}` : ''}
`, [SINCE, UNTIL])
console.log(`[oracleFullBacktestWithCritic] loaded ${bets.length} settled placed pre-game bets`)
const projectedCost = bets.length * 0.001
console.log(`[oracleFullBacktestWithCritic] projected cost: ~$${projectedCost.toFixed(2)} at $0.001/call worst case`)
console.log(`[oracleFullBacktestWithCritic] cost cap: $${COST_CAP.toFixed(2)} — calls beyond cap fail open`)

// Pre-fetch today's pitcher_statcast for r derivation
const pidSet = [...new Set(bets.map(b => String(b.pitcher_id)))]
const savantRows = pidSet.length
  ? await db.all(
      `SELECT player_id, k_pct, ip, manager_leash_factor, nb_r
       FROM pitcher_statcast WHERE player_id IN (${pidSet.map(()=>'?').join(',')})`,
      pidSet,
    )
  : []
const savantMap = new Map(savantRows.map(r => [String(r.player_id), r]))

// ─── Helpers ──────────────────────────────────────────────────────
function buildSyntheticEnvelope(row, savant) {
  const lc = JSON.parse(row.lambda_calc_json)
  const mi = JSON.parse(row.model_input_json)
  const lambda_base  = Number(lc.lambda_base)
  const lambda_final = Number(lc.lambda_final)
  const pK_blended   = Number(lc.p_k_blended)
  const expected_bf  = Number(mi.expected_bf)
  const r            = archetypeR(savant)

  const prob_at_least = {}
  for (const k of STRIKES) {
    prob_at_least[String(k)] = pAtLeast(lambda_final, k, r)
  }
  const synthMatchup = crypto.createHash('sha256')
    .update(`${row.pitcher_id}|${row.bet_date}|${lambda_final}`)
    .digest('hex')
  const synthInputs = crypto.createHash('sha256').update(`${synthMatchup}-inputs`).digest('hex')

  return {
    schema_version: '1.0.0', layer: 'math', layer_version: '1.0.0',
    source: 'oracle_layer_1_math',
    run_id: `synth-${row.bet_id}`, decision_id: null,
    computed_at: '2026-05-01T00:00:00.000Z', commit_hash: 'backtest-synth',
    inputs_hash: synthInputs, output_hash: synthMatchup,
    inner: {
      expectedBF: expected_bf, pK_blended,
      avgPitches: Number.isFinite(lc.avg_pitches) ? lc.avg_pitches : null,
      leashFlag: !!lc.leash_flag,
      bfSource: mi.bf_source,
      lambdaBase: lambda_base, nStarts: mi.n_starts,
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
    nb_r_source: savant?.nb_r != null ? 'fitted' : (savant?.k_pct != null ? 'archetype_kpct' : 'global_default'),
    prob_at_least,
    status: 'ok', warnings: [],
  }
}

function buildPreflightContext(row) {
  let pj = null
  try { if (row.preflight_json) pj = JSON.parse(row.preflight_json) } catch { /* ignore */ }
  const pitcherNews = []
  const opponentNews = []
  const headlines = pj?.headlines ?? []
  if (Array.isArray(headlines)) {
    for (const h of headlines.slice(0, 8)) {
      const text = typeof h === 'string' ? h : (h?.title ?? h?.text ?? '')
      if (!text) continue
      const lower = text.toLowerCase()
      if (lower.includes(row.pitcher_name?.toLowerCase?.() ?? '___')) {
        pitcherNews.push(text)
      } else {
        opponentNews.push(text)
      }
    }
  }
  if (pj?.summary_text && !pj.summary_text.includes('No relevant headlines')) {
    // Add summary as additional pitcher context
    pitcherNews.push(`[summary] ${pj.summary_text}`.slice(0, 200))
  }
  return {
    pitcherNews:  pitcherNews.slice(0, 5),
    opponentNews: opponentNews.slice(0, 3),
    lineupStatus: { home_lineup_posted: true, away_lineup_posted: true, scratch_alert: false },  // assume posted (settled bet)
    lineDirection: { home: 0, away: 0 },
    weatherData:   null,
    bullpenData:   null,
    umpireData:    null,
    kPropGap:      Number.isFinite(pj?.k_prop_gap) ? pj.k_prop_gap : null,
  }
}

// ─── Main loop ────────────────────────────────────────────────────
const skipped = { no_dp: 0, parse_fail: 0, judge_fail: 0, cost_cap: 0 }
const decisions = []
const startTime = Date.now()
let progress = 0

for (const row of bets) {
  if (!row.lambda_calc_json || !row.model_input_json) { skipped.no_dp++; continue }
  let env, preflightContext
  try {
    env = buildSyntheticEnvelope(row, savantMap.get(String(row.pitcher_id)))
    preflightContext = buildPreflightContext(row)
  } catch { skipped.parse_fail++; continue }

  const ctx = {
    decision_id: `bt-critic-${row.bet_id}`,
    pitcher_id: String(row.pitcher_id),
    pitcher_name: row.pitcher_name,
    bet_date: row.bet_date,
    strike: Number(row.strike),
    side: row.side,
  }

  let pathR, trustR, criticR_full, criticR_off, judgeR_off, judgeR_full
  try {
    pathR  = await pathRun(env, ctx)
    trustR = await trustRun(env, pathR, ctx)
    // Run Critic with cost cap awareness
    if (costCapExceeded) {
      criticR_full = { verdict: 'proceed', confidence: 'low', concerns: [], reason_code: 'critic_unavailable',
                       status: 'unavailable', model_used: 'unavailable', cost_usd: null, output_hash: null, inputs_hash: null }
      skipped.cost_cap++
    } else {
      criticR_full = await criticRun(env, pathR, trustR, {
        ...ctx,
        market_mid: Number(row.market_mid) / 100,
        edge: null,
        preflightContext,
        criticClient,
        cache,
        timeout_ms: 15_000,
      })
    }
    // Judge WITHOUT critic (baseline Oracle, matches existing oracleFullBacktest)
    judgeR_off = await judgeRun(env, pathR, trustR, {
      ...ctx,
      market_mid: Number(row.market_mid) / 100,
      spread: Number.isFinite(Number(row.spread)) ? Number(row.spread) / 100 : null,
      bankroll: BANKROLL,
    })
    // Judge WITH critic
    judgeR_full = await judgeRun(env, pathR, trustR, {
      ...ctx,
      market_mid: Number(row.market_mid) / 100,
      spread: Number.isFinite(Number(row.spread)) ? Number(row.spread) / 100 : null,
      bankroll: BANKROLL,
      criticResult: criticR_full,
    })
  } catch (err) {
    skipped.judge_fail++
    continue
  }

  decisions.push({
    bet_id: row.bet_id, bet_date: row.bet_date,
    pitcher_id: row.pitcher_id, pitcher_name: row.pitcher_name,
    strike: row.strike, side: row.side,
    result: row.result, actual_ks: row.actual_ks,
    user_id: row.user_id,

    production_pnl:   Number(row.pnl) || 0,
    production_size:  Number(row.bet_size) || 0,

    feasibility:    pathR.feasibility,
    trust_level:    trustR.trust_level,
    trust_score:    trustR.trust_score,

    // No-critic Oracle
    decision_off:   judgeR_off.decision,
    reason_off:     judgeR_off.reason_code,

    // Critic + with-critic Oracle
    critic_verdict: criticR_full.verdict,
    critic_concerns: criticR_full.concerns,
    critic_status:  criticR_full.status,
    decision_full:  judgeR_full.decision,
    reason_full:    judgeR_full.reason_code,
    critic_applied: judgeR_full.critic_applied,
  })
  progress++
  if (progress % 25 === 0) {
    const elapsed = (Date.now() - startTime) / 1000
    console.log(`  [${progress}/${bets.length}] cost=$${totalCost.toFixed(4)} calls=${totalCalls} elapsed=${elapsed.toFixed(0)}s`)
    persistCache()
  }
}
persistCache()
console.log(`[oracleFullBacktestWithCritic] processed ${decisions.length} bets; skipped no_dp=${skipped.no_dp} parse_fail=${skipped.parse_fail} judge_fail=${skipped.judge_fail} cost_cap=${skipped.cost_cap}`)
console.log(`[oracleFullBacktestWithCritic] total Critic cost: $${totalCost.toFixed(4)} (${totalCalls} calls)`)

await db.close()

// ─── Aggregate ────────────────────────────────────────────────────
function fixedSizePnl(d, dec) {
  if (dec === 'skip')      return 0
  if (dec === 'size_down') return d.production_pnl * 0.5
  return d.production_pnl
}

let prodPnl = 0, oracleNoPnl = 0, oracleFullPnl = 0
const verdictCounts = { skip: 0, concern: 0, proceed: 0, boost: 0, unavailable: 0 }
const decisionDelta = { off: { fire: 0, skip: 0, size_down: 0 }, full: { fire: 0, skip: 0, size_down: 0 } }
let criticChangedDecision = 0
let criticDowngraded = 0, criticUpgraded = 0, criticForcedSkip = 0

for (const d of decisions) {
  prodPnl       += d.production_pnl
  oracleNoPnl   += fixedSizePnl(d, d.decision_off)
  oracleFullPnl += fixedSizePnl(d, d.decision_full)
  verdictCounts[d.critic_verdict] = (verdictCounts[d.critic_verdict] ?? 0) + 1
  decisionDelta.off[d.decision_off]   = (decisionDelta.off[d.decision_off] ?? 0) + 1
  decisionDelta.full[d.decision_full] = (decisionDelta.full[d.decision_full] ?? 0) + 1
  if (d.decision_off !== d.decision_full) {
    criticChangedDecision++
    if (d.decision_full === 'skip')      criticForcedSkip++
    else if (d.decision_off === 'fire' && d.decision_full === 'size_down') criticDowngraded++
    else if (d.decision_off === 'size_down' && d.decision_full === 'fire') criticUpgraded++
  }
}

// ─── Render Markdown ─────────────────────────────────────────────
const lines = []
const fmt = (n, d=2) => Number.isFinite(n) ? n.toFixed(d) : '—'
lines.push(`# Full Oracle Pipeline + Critic Backtest — ${today}`)
lines.push(``)
lines.push(`**Pipeline:** L1 Math → L2 Path → L3 Trust → L4 Critic (real Haiku 4.5) → L5 Judge v0.2`)
lines.push(``)
lines.push(`Window: ${SINCE} → ${UNTIL}`)
lines.push(`Bankroll: $${BANKROLL}`)
lines.push(``)
lines.push(`## Sample`)
lines.push(``)
lines.push(`| Metric | Value |`)
lines.push(`|---|---:|`)
lines.push(`| Settled placed pre-game bets in window | ${bets.length} |`)
lines.push(`| Replayable through full pipeline | ${decisions.length} |`)
lines.push(`| Skipped (no decision_pipeline) | ${skipped.no_dp} |`)
lines.push(`| Skipped (cost cap reached) | ${skipped.cost_cap} |`)
lines.push(``)
lines.push(`## Cost`)
lines.push(``)
lines.push(`| Metric | Value |`)
lines.push(`|---|---:|`)
lines.push(`| Total Critic cost | $${fmt(totalCost, 4)} |`)
lines.push(`| Total API calls | ${totalCalls} |`)
lines.push(`| Avg cost per call | $${fmt(totalCost / Math.max(1, totalCalls), 5)} |`)
lines.push(`| Cost cap | $${fmt(COST_CAP, 2)} |`)
lines.push(``)
lines.push(`## Headline P&L`)
lines.push(``)
lines.push(`| Strategy | P&L | Δ vs production |`)
lines.push(`|---|---:|---:|`)
lines.push(`| Production (baseline) | $${fmt(prodPnl)} | — |`)
lines.push(`| Oracle (L1-L3-L5, no Critic) — fixed-size | $${fmt(oracleNoPnl)} | $${fmt(oracleNoPnl - prodPnl)} |`)
lines.push(`| **Oracle FULL (L1-L4-L5 with Critic) — fixed-size** | **$${fmt(oracleFullPnl)}** | **$${fmt(oracleFullPnl - prodPnl)}** |`)
lines.push(``)
lines.push(`## Critic verdict distribution`)
lines.push(``)
lines.push(`| verdict | n |`)
lines.push(`|---|---:|`)
for (const v of ['skip','concern','proceed','boost','unavailable']) {
  lines.push(`| ${v} | ${verdictCounts[v] ?? 0} |`)
}
lines.push(``)
lines.push(`## Decision distribution (Oracle vs Critic-on)`)
lines.push(``)
lines.push(`| decision | no Critic | with Critic | Δ |`)
lines.push(`|---|---:|---:|---:|`)
for (const k of ['fire','size_down','skip']) {
  const a = decisionDelta.off[k] ?? 0
  const b = decisionDelta.full[k] ?? 0
  lines.push(`| ${k} | ${a} | ${b} | ${b - a >= 0 ? '+' : ''}${b - a} |`)
}
lines.push(``)
lines.push(`## Critic effect on Oracle decisions`)
lines.push(``)
lines.push(`- Total bets where Critic changed Oracle decision: **${criticChangedDecision}** of ${decisions.length}`)
lines.push(`- Forced fire/size_down → skip:  ${criticForcedSkip}`)
lines.push(`- Downgraded fire → size_down:    ${criticDowngraded}`)
lines.push(`- Upgraded size_down → fire:      ${criticUpgraded}`)
lines.push(``)

// Per-Critic-verdict ROI breakdown
lines.push(`## ROI by Critic verdict (with-Critic chain, fixed-size)`)
lines.push(``)
lines.push(`| verdict | n | wins | losses | win_rate | Oracle pnl | production pnl |`)
lines.push(`|---|---:|---:|---:|---:|---:|---:|`)
for (const v of ['skip','concern','proceed','boost']) {
  const ds = decisions.filter(d => d.critic_verdict === v)
  const wins = ds.filter(d => d.result === 'win').length
  const losses = ds.filter(d => d.result === 'loss').length
  const wr = wins + losses > 0 ? (wins / (wins + losses) * 100).toFixed(1) + '%' : '—'
  const oraPnl = ds.reduce((s, d) => s + fixedSizePnl(d, d.decision_full), 0)
  const prdPnl = ds.reduce((s, d) => s + d.production_pnl, 0)
  lines.push(`| ${v} | ${ds.length} | ${wins} | ${losses} | ${wr} | $${fmt(oraPnl)} | $${fmt(prdPnl)} |`)
}
lines.push(``)

// Notable transitions
const notableSkips = decisions.filter(d => d.decision_off !== 'skip' && d.decision_full === 'skip')
const notableUpgrades = decisions.filter(d => d.decision_off === 'size_down' && d.decision_full === 'fire')
const notableDowngrades = decisions.filter(d => d.decision_off === 'fire' && d.decision_full === 'size_down')
lines.push(`## Notable Critic effects`)
lines.push(``)
lines.push(`### Critic forced SKIP on bets Oracle would have fired/size_downed (n=${notableSkips.length})`)
lines.push(`Were these wins or losses?`)
const skipsWon = notableSkips.filter(d => d.result === 'win').length
const skipsLost = notableSkips.filter(d => d.result === 'loss').length
lines.push(`- wins: ${skipsWon} (loss avoided ≠ ✓ — these were forgone wins)`)
lines.push(`- losses: ${skipsLost} (loss avoided = ✓ Critic helped)`)
const skipsPnlSaved = notableSkips.reduce((s, d) => s + d.production_pnl, 0)
lines.push(`- production pnl on these bets: $${fmt(skipsPnlSaved)} (Critic skipping all of them removes this from Oracle)`)
lines.push(``)
lines.push(`### Critic upgraded size_down → fire (n=${notableUpgrades.length})`)
const upWon = notableUpgrades.filter(d => d.result === 'win').length
const upLost = notableUpgrades.filter(d => d.result === 'loss').length
lines.push(`- wins: ${upWon}`)
lines.push(`- losses: ${upLost}`)
lines.push(``)
lines.push(`### Critic downgraded fire → size_down (n=${notableDowngrades.length})`)
const dnWon = notableDowngrades.filter(d => d.result === 'win').length
const dnLost = notableDowngrades.filter(d => d.result === 'loss').length
lines.push(`- wins: ${dnWon}`)
lines.push(`- losses: ${dnLost}`)
lines.push(``)

lines.push(`## Caveats`)
lines.push(``)
lines.push(`1. preflight_json from production is what production saw at decision time`)
lines.push(`   (headlines + summary). NOT full live news; production may have used`)
lines.push(`   richer context that wasn't persisted.`)
lines.push(`2. Today's pitcher_statcast used for r — drift caveat carries over.`)
lines.push(`3. Synthetic Layer 1 envelope hashes are not validated against true`)
lines.push(`   production envelopes (Layer 1 wasn't running in production).`)
lines.push(`4. Sample is small; one weather window is not enough to ship.`)
lines.push(`5. Cost cap at $${COST_CAP} per run; if exceeded, remaining bets get verdict=proceed.`)
lines.push(``)

// Write Markdown + CSV
const mdPath = path.resolve(`${OUTBASE}.md`)
writeFileSync(mdPath, lines.join('\n'), 'utf-8')

const csvLines = ['bet_id,bet_date,pitcher,strike,side,result,production_pnl,production_size,feasibility,trust_level,decision_off,decision_full,critic_verdict,critic_status,critic_concerns']
for (const d of decisions) {
  const safe = (s) => String(s ?? '').replace(/,/g, ';')
  csvLines.push([
    d.bet_id, d.bet_date, safe(d.pitcher_name), d.strike, d.side, d.result,
    d.production_pnl.toFixed(2), d.production_size.toFixed(2),
    d.feasibility, d.trust_level, d.decision_off, d.decision_full,
    d.critic_verdict, d.critic_status, safe((d.critic_concerns ?? []).join('|')),
  ].join(','))
}
const csvPath = path.resolve(`${OUTBASE}.csv`)
writeFileSync(csvPath, csvLines.join('\n'), 'utf-8')

// ─── Stdout summary ──────────────────────────────────────────────
console.log('\n═══ STDOUT SUMMARY ═══')
console.log(`Markdown: ${mdPath}`)
console.log(`CSV:      ${csvPath}`)
console.log(`\nProduction P&L:                 $${prodPnl.toFixed(2)}`)
console.log(`Oracle (no Critic) fixed-size:  $${oracleNoPnl.toFixed(2)}  Δ=$${(oracleNoPnl - prodPnl).toFixed(2)}`)
console.log(`Oracle (with Critic) fixed-size: $${oracleFullPnl.toFixed(2)}  Δ=$${(oracleFullPnl - prodPnl).toFixed(2)}`)
console.log(`\nCritic verdict counts:`)
for (const v of ['skip','concern','proceed','boost','unavailable']) {
  console.log(`  ${v.padEnd(12)}  ${verdictCounts[v] ?? 0}`)
}
console.log(`\nCritic changed Oracle decision on ${criticChangedDecision} bets`)
console.log(`  forced skip:       ${criticForcedSkip}`)
console.log(`  downgrade fire→sd: ${criticDowngraded}`)
console.log(`  upgrade sd→fire:   ${criticUpgraded}`)
console.log(`\nTotal Critic cost: $${totalCost.toFixed(4)} across ${totalCalls} API calls`)
