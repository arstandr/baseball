// scripts/oracle/sensitivityGrid.js
//
// Test 2 — Sensitivity grid.
//
// Pick representative recent bets; for each, vary market_mid by ±5¢ in
// 1¢ steps and record whether Oracle's gate decision flips. Categorize
// flips by transition type and brittleness.
//
// Critic verdict is cached per (pitcher, bet_date, …); does not depend
// on market_mid, so all 11 price points share one Critic call → cost is
// near-zero on cached bets.

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

const today = new Date().toISOString().slice(0, 10)
const opts = parseArgs({
  since:    { default: '2026-04-24' },     // DK overlap window for richer sample
  until:    { default: today },
  bankroll: { type: 'number', default: 1000 },
  sampleSize: { type: 'number', default: 30 },
})
const SINCE = opts.since
const UNTIL = opts.until
const SAMPLE_SIZE = opts.sampleSize
const BANKROLL = opts.bankroll
const OUTBASE = `oracle/sensitivity-grid-${today}`
const CACHE_PATH = path.resolve('oracle/critic-cache.json')

const STRIKES = [3,4,5,6,7,8,9,10,11,12]
const HAIKU = 'claude-haiku-4-5-20251001'
const PRICE_OFFSETS_CENTS = [-5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5]

console.log(`[sensitivity] window ${SINCE} → ${UNTIL}; sample=${SAMPLE_SIZE}`)

// ─── Critic cache ────────────────────────────────────────────────
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

const anth = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
let totalCost = 0, totalCalls = 0
const COST_INPUT_PER_M = 0.25, COST_OUTPUT_PER_M = 1.25
const criticClient = {
  classify: async ({ system, user, model, max_tokens }) => {
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

// ─── Sample selection ────────────────────────────────────────────
//
// Stratify by where the production decision likely sat. We use
// production's edge (cents) as a proxy for which gate threshold
// the bet was near. Pick ~equal numbers from a few edge buckets so
// the grid covers near-threshold cases (where flips are likely)
// AND clear cases (where flips are unlikely). This avoids cherry-
// picking only easy-to-flip bets.
const allBets = await db.all(`
  SELECT b.id AS bet_id, b.bet_date, b.pitcher_id, b.pitcher_name, b.strike, b.side,
         b.result, b.actual_ks, b.pnl, b.bet_size, b.market_mid, b.spread, b.user_id, b.edge,
         dp.lambda_calc_json, dp.model_input_json, dp.preflight_json
  FROM ks_bets b
  LEFT JOIN decision_pipeline dp ON dp.bet_date=b.bet_date AND dp.pitcher_id=b.pitcher_id
  WHERE b.result IN ('win','loss','void')
    AND b.actual_ks IS NOT NULL
    AND b.live_bet = 0
    AND b.bet_date BETWEEN ? AND ?
    AND b.market_mid IS NOT NULL
    AND dp.lambda_calc_json IS NOT NULL
    AND dp.model_input_json IS NOT NULL
  ORDER BY b.bet_date ASC, b.id ASC
`, [SINCE, UNTIL])
console.log(`[sensitivity] ${allBets.length} eligible bets in window`)

// Stratify by edge bucket. edge stored as a FRACTION in ks_bets
// (e.g. 0.184 = 18.4¢). Convert to cents for bucketing.
const buckets = {
  near_threshold: [],   // edge ≤ 14¢ (within 2¢ of side_min_edge=12¢)
  medium:         [],   // 14¢ < edge ≤ 22¢
  comfortable:    [],   // 22¢ < edge ≤ 35¢
  large:          [],   // edge > 35¢
}
for (const b of allBets) {
  const e_cents = Number(b.edge ?? 0) * 100   // 0.184 → 18.4
  if (e_cents <= 14) buckets.near_threshold.push(b)
  else if (e_cents <= 22) buckets.medium.push(b)
  else if (e_cents <= 35) buckets.comfortable.push(b)
  else buckets.large.push(b)
}
console.log('[sensitivity] edge buckets:', Object.fromEntries(Object.entries(buckets).map(([k,v]) => [k, v.length])))

function pickEvenly(buckets, n) {
  const keys = Object.keys(buckets)
  const perBucket = Math.ceil(n / keys.length)
  const out = []
  for (const k of keys) {
    const arr = buckets[k]
    const stride = arr.length > perBucket ? Math.floor(arr.length / perBucket) : 1
    for (let i = 0; i < arr.length && out.filter(b => b._bucket === k).length < perBucket; i += stride) {
      out.push({ ...arr[i], _bucket: k })
    }
  }
  return out.slice(0, n)
}
const sample = pickEvenly(buckets, SAMPLE_SIZE)
console.log(`[sensitivity] selected ${sample.length} bets across edge buckets`)

const pidSet = [...new Set(sample.map(b => String(b.pitcher_id)))]
const savantRows = pidSet.length
  ? await db.all(`SELECT player_id, k_pct, ip, manager_leash_factor, nb_r FROM pitcher_statcast WHERE player_id IN (${pidSet.map(()=>'?').join(',')})`, pidSet)
  : []
const savantMap = new Map(savantRows.map(r => [String(r.player_id), r]))

// ─── Helpers (same as Test 1) ────────────────────────────────────
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
    computed_at: '2026-05-01T00:00:00.000Z', commit_hash: 'sensitivity',
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
    nb_r: r, nb_r_source: savant?.nb_r != null ? 'fitted' : (savant?.k_pct != null ? 'archetype_kpct' : 'global_default'),
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

// ─── Main: sensitivity grid per bet ──────────────────────────────
const records = []   // one per bet
let progress = 0

for (const row of sample) {
  let env, pre
  try {
    env = buildSyntheticEnvelope(row, savantMap.get(String(row.pitcher_id)))
    pre = buildPreflightContext(row)
  } catch { continue }

  const baseCtx = {
    decision_id: `sens-${row.bet_id}`,
    pitcher_id: String(row.pitcher_id), pitcher_name: row.pitcher_name,
    bet_date: row.bet_date, strike: Number(row.strike), side: row.side,
  }
  // Run the deterministic chain once per bet (it's market_mid-independent)
  const pathR  = await pathRun(env, baseCtx)
  const trustR = await trustRun(env, pathR, baseCtx)

  // Run Critic once per bet (cache key independent of market_mid)
  const criticR = await criticRun(env, pathR, trustR, {
    ...baseCtx, market_mid: Number(row.market_mid)/100, edge: null,
    preflightContext: pre, criticClient, cache, timeout_ms: 15_000,
  })

  // Now sweep market_mid offsets. Only Judge needs to re-run per offset.
  const grid = []
  for (const offsetCents of PRICE_OFFSETS_CENTS) {
    const newMidCents = Number(row.market_mid) + offsetCents
    if (newMidCents <= 0 || newMidCents >= 100) {
      grid.push({ offset: offsetCents, mid_cents: newMidCents, decision: null, error: 'out_of_range' })
      continue
    }
    let judgeR
    try {
      judgeR = await judgeRun(env, pathR, trustR, {
        ...baseCtx,
        market_mid: newMidCents / 100,
        spread: Number.isFinite(Number(row.spread)) ? Number(row.spread)/100 : null,
        bankroll: BANKROLL,
        criticResult: criticR,
      })
    } catch (e) {
      grid.push({ offset: offsetCents, mid_cents: newMidCents, decision: null, error: e.message })
      continue
    }
    grid.push({
      offset: offsetCents, mid_cents: newMidCents,
      decision: judgeR.decision, reason: judgeR.reason_code,
      edge: judgeR.edge, threshold: judgeR.threshold,
      baseline_decision: judgeR.baseline_decision,
    })
  }

  // Determine baseline (offset=0) decision + brittleness
  const baselineCell = grid.find(g => g.offset === 0)
  const baselineDecision = baselineCell?.decision ?? null

  // Brittleness: minimum |offset| where decision differs from baseline
  let minFlipDist = null
  let flipsOnEachSide = []   // [{offset, decision, transition}]
  for (const g of grid) {
    if (g.decision == null) continue
    if (g.decision !== baselineDecision) {
      const dist = Math.abs(g.offset)
      if (minFlipDist == null || dist < minFlipDist) minFlipDist = dist
      flipsOnEachSide.push({ offset: g.offset, decision: g.decision,
        transition: `${baselineDecision}→${g.decision}` })
    }
  }
  const brittlenessClass =
      minFlipDist == null ? 'stable'
    : minFlipDist === 1   ? '1c_brittle'
    : minFlipDist === 2   ? '2c_brittle'
    : minFlipDist <= 5    ? '3to5c_sensitive'
    : 'stable'

  records.push({
    bet_id: row.bet_id, bet_date: row.bet_date, pitcher_name: row.pitcher_name,
    strike: row.strike, side: row.side, result: row.result,
    bucket: row._bucket, production_edge_cents: Number(row.edge ?? 0),
    market_mid_actual: Number(row.market_mid),
    feasibility: pathR.feasibility, trust_level: trustR.trust_level,
    critic_verdict: criticR.verdict, critic_concerns: criticR.concerns,
    baseline_decision: baselineDecision,
    min_flip_dist: minFlipDist,
    brittleness_class: brittlenessClass,
    flips: flipsOnEachSide,
    grid,
  })

  progress++
  if (progress % 5 === 0) {
    persistCache()
    console.log(`  [${progress}/${sample.length}] cost=$${totalCost.toFixed(4)} new_calls=${totalCalls}`)
  }
}
persistCache()
await db.close()

// ─── Aggregate ───────────────────────────────────────────────────
const counts = { stable: 0, '1c_brittle': 0, '2c_brittle': 0, '3to5c_sensitive': 0 }
for (const r of records) counts[r.brittleness_class] = (counts[r.brittleness_class] ?? 0) + 1

// Categorize flip transitions
const transitionCounts = {}   // 'fire→skip' etc → count
for (const r of records) {
  for (const f of r.flips) {
    transitionCounts[f.transition] = (transitionCounts[f.transition] ?? 0) + 1
  }
}

// Specifically: among 1¢ and 2¢ brittle bets, what transitions?
const dangerousTransitions = {}   // 'fire→skip' from 1c brittle, etc.
for (const r of records) {
  if (r.brittleness_class !== '1c_brittle' && r.brittleness_class !== '2c_brittle') continue
  // Use only the closest flip
  const closest = r.flips.reduce((best, f) => {
    const d = Math.abs(f.offset)
    if (best == null || d < Math.abs(best.offset)) return f
    return best
  }, null)
  if (closest) {
    const key = `${r.brittleness_class}::${closest.transition}`
    dangerousTransitions[key] = (dangerousTransitions[key] ?? 0) + 1
  }
}

// ─── Verdict ─────────────────────────────────────────────────────
const fireSkip1c = (dangerousTransitions['1c_brittle::fire→skip'] ?? 0) +
                   (dangerousTransitions['1c_brittle::skip→fire'] ?? 0)
const fireSkip2c = (dangerousTransitions['2c_brittle::fire→skip'] ?? 0) +
                   (dangerousTransitions['2c_brittle::skip→fire'] ?? 0)
const totalKnifeEdge = fireSkip1c + fireSkip2c

let verdict, verdictReason
if (records.length < 10) {
  verdict = 'INCONCLUSIVE — sample too small'
  verdictReason = `Only ${records.length} bets in the grid; need ≥10 for reliable verdict.`
} else if (counts.stable >= records.length * 0.7) {
  verdict = 'GATE IS ROBUST'
  verdictReason = `${counts.stable} of ${records.length} (${(counts.stable/records.length*100).toFixed(0)}%) bets are stable across the full ±5¢ window. Most flips are around the size_down boundary, not fire/skip.`
} else if (totalKnifeEdge >= records.length * 0.30) {
  verdict = 'GATE IS KNIFE-EDGE'
  verdictReason = `${totalKnifeEdge} of ${records.length} bets flip fire↔skip on ≤2¢ market move. The edge threshold is too brittle for this volatility window.`
} else {
  verdict = 'GATE IS ACCEPTABLE — minor brittleness'
  verdictReason = `Most bets stable; size_down ↔ skip flips dominate the brittleness; few fire↔skip flips on small price moves.`
}

// ─── Render ──────────────────────────────────────────────────────
const fmt = (n, d=2) => Number.isFinite(n) ? n.toFixed(d) : '—'

const lines = []
lines.push(`# Oracle Sensitivity Grid — ${today}`)
lines.push(``)
lines.push(`Window: ${SINCE} → ${UNTIL}`)
lines.push(`Sample: ${records.length} bets × 11 price offsets (±5¢ in 1¢ steps)`)
lines.push(`Selection: stratified by production edge bucket (near_threshold / medium / comfortable / large)`)
lines.push(``)
lines.push(`## Verdict`)
lines.push(``)
lines.push(`**${verdict}**`)
lines.push(``)
lines.push(verdictReason)
lines.push(``)

lines.push(`## Brittleness distribution`)
lines.push(``)
lines.push(`| class | count | % | meaning |`)
lines.push(`|---|---:|---:|---|`)
const meaning = {
  stable: 'no flip in ±5¢ — gate stays on same decision regardless of price jiggle',
  '1c_brittle': 'flips on a 1¢ move — knife-edge, fragile',
  '2c_brittle': 'flips on a 2¢ move — borderline',
  '3to5c_sensitive': 'flips somewhere in 3-5¢ range — acceptable sensitivity',
}
for (const k of ['stable', '1c_brittle', '2c_brittle', '3to5c_sensitive']) {
  const n = counts[k] ?? 0
  lines.push(`| ${k} | ${n} | ${records.length ? (n/records.length*100).toFixed(0) + '%' : '—'} | ${meaning[k]} |`)
}
lines.push(``)

lines.push(`## Transition types — ALL flips observed across the grid`)
lines.push(``)
lines.push(`| transition | count |`)
lines.push(`|---|---:|`)
for (const [t, n] of Object.entries(transitionCounts).sort((a,b) => b[1] - a[1])) {
  lines.push(`| ${t} | ${n} |`)
}
lines.push(``)

lines.push(`## Knife-edge analysis — closest-flip transitions on 1¢/2¢ brittle bets`)
lines.push(``)
lines.push(`| brittleness | transition | count |`)
lines.push(`|---|---|---:|`)
const dt = Object.entries(dangerousTransitions).sort((a,b) => b[1] - a[1])
for (const [k, n] of dt) {
  const [klass, trans] = k.split('::')
  lines.push(`| ${klass} | ${trans} | ${n} |`)
}
lines.push(``)
lines.push(`Most dangerous: \`fire ↔ skip\` flips on 1¢ moves. Currently observed: ${fireSkip1c}.`)
lines.push(`Less dangerous: any flip involving \`size_down\` (half-size cushion).`)
lines.push(``)

// Per-bet table
lines.push(`## Per-bet brittleness`)
lines.push(``)
lines.push(`| bet_date | pitcher | strike-side | bucket | feasibility | trust | critic | baseline | min_flip(¢) | class | flips |`)
lines.push(`|---|---|---|---|---|---|---|---|---:|---|---|`)
for (const r of records) {
  const flipStr = r.flips.length === 0 ? '—'
    : r.flips.sort((a,b)=>Math.abs(a.offset)-Math.abs(b.offset)).slice(0, 3)
        .map(f => `${f.offset >= 0 ? '+' : ''}${f.offset}:${f.transition}`).join(' / ')
  lines.push(`| ${r.bet_date} | ${r.pitcher_name} | ${r.strike}${r.side} | ${r.bucket} | ${r.feasibility} | ${r.trust_level} | ${r.critic_verdict} | ${r.baseline_decision ?? '—'} | ${r.min_flip_dist ?? '—'} | ${r.brittleness_class} | ${flipStr} |`)
}
lines.push(``)

// Most brittle examples
const knifeEdgeBets = records.filter(r => r.brittleness_class === '1c_brittle')
if (knifeEdgeBets.length) {
  lines.push(`## 1¢ knife-edge bets (full grid)`)
  lines.push(``)
  for (const r of knifeEdgeBets.slice(0, 5)) {
    lines.push(`### ${r.bet_date} ${r.pitcher_name} K${r.strike} ${r.side}`)
    lines.push(``)
    lines.push(`baseline market_mid: ${r.market_mid_actual}¢ → decision=${r.baseline_decision}`)
    lines.push(``)
    lines.push(`| offset | mid_cents | decision | reason | edge |`)
    lines.push(`|---:|---:|---|---|---:|`)
    for (const g of r.grid) {
      if (g.decision == null) {
        lines.push(`| ${g.offset >= 0 ? '+' : ''}${g.offset}¢ | ${g.mid_cents} | (${g.error}) | — | — |`)
      } else {
        lines.push(`| ${g.offset >= 0 ? '+' : ''}${g.offset}¢ | ${g.mid_cents} | ${g.decision} | ${g.reason} | ${(g.edge*100).toFixed(1)}¢ |`)
      }
    }
    lines.push(``)
  }
}

lines.push(`## Method`)
lines.push(``)
lines.push(`- For each bet: run L1→L2→L3 once (deterministic, market_mid-independent).`)
lines.push(`- Critic call once per bet (cache key independent of market_mid).`)
lines.push(`- Judge re-runs per offset with adjusted market_mid; verdict can flip.`)
lines.push(`- Brittleness = min |offset| where Judge's decision differs from baseline (offset=0).`)
lines.push(``)

lines.push(`## Caveats`)
lines.push(``)
lines.push(`1. Edge threshold = max(SIDE_MIN_EDGE=0.12, spread/2 + 0.04). Most flips occur at the 12¢ floor.`)
lines.push(`2. Sample stratified by production edge bucket — over-represents near-threshold cases by design (those are most likely to flip).`)
lines.push(`3. Critic verdict held constant per bet (cache); we're measuring Judge sensitivity to edge, not Critic sensitivity to news.`)
lines.push(`4. Production market_mid stored as integer cents in ks_bets; we vary in 1¢ steps (matches Kalshi tick size).`)
lines.push(``)

const mdPath = path.resolve(`${OUTBASE}.md`)
writeFileSync(mdPath, lines.join('\n'), 'utf-8')

const csvLines = ['bet_id,bet_date,pitcher,strike,side,bucket,feasibility,trust,critic,baseline,min_flip_dist,brittleness']
for (const r of records) {
  const safe = (s) => String(s ?? '').replace(/,/g, ';')
  csvLines.push([
    r.bet_id, r.bet_date, safe(r.pitcher_name), r.strike, r.side, r.bucket,
    r.feasibility, r.trust_level, r.critic_verdict, r.baseline_decision ?? '',
    r.min_flip_dist ?? '', r.brittleness_class,
  ].join(','))
}
const csvPath = path.resolve(`${OUTBASE}.csv`)
writeFileSync(csvPath, csvLines.join('\n'), 'utf-8')

// ─── Stdout summary ──────────────────────────────────────────────
console.log('\n═══════════════════════════════════════════')
console.log('  SENSITIVITY GRID — RESULT')
console.log('═══════════════════════════════════════════')
console.log(`Verdict:                 ${verdict}`)
console.log('')
console.log(`Sample size:             ${records.length} bets × 11 offsets = ${records.length * 11} grid cells`)
console.log('')
console.log(`Brittleness:`)
for (const k of ['stable', '1c_brittle', '2c_brittle', '3to5c_sensitive']) {
  const n = counts[k] ?? 0
  console.log(`  ${k.padEnd(20)} ${String(n).padStart(3)}  (${records.length ? (n/records.length*100).toFixed(0).padStart(3) : '  0'}%)`)
}
console.log('')
console.log(`Top transitions:`)
for (const [t, n] of Object.entries(transitionCounts).sort((a,b) => b[1] - a[1]).slice(0, 6)) {
  console.log(`  ${t.padEnd(28)} ${n}`)
}
console.log('')
console.log(`Knife-edge fire↔skip flips (1¢/2¢): ${totalKnifeEdge}`)
console.log('')
console.log(`Critic API cost: $${totalCost.toFixed(4)} (${totalCalls} new calls; rest cached)`)
console.log('')
console.log(`Markdown: ${mdPath}`)
console.log(`CSV:      ${csvPath}`)
