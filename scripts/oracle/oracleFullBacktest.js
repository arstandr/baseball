// scripts/oracle/oracleFullBacktest.js
//
// Full Oracle pipeline backtest:
//   Layer 1 (Math) → Layer 2 (Path) → Layer 3 (Trust) → Layer 5 (Judge v0.1)
//
// For every settled placed pre-game bet with a decision_pipeline JSON
// snapshot, reconstruct a synthetic Layer 1 envelope and run the full
// chain. Judge produces fire / skip / size_down. We then compute a
// counterfactual P&L assuming Oracle had been the system that placed
// these bets:
//
//   - skip: Oracle would not have placed → counterfactual pnl = 0
//   - fire: Oracle would have placed at full size → pnl scales with
//           Oracle's size vs production's bet_size
//   - size_down: Oracle would have placed at half-Kelly size
//
// IMPORTANT NUANCE: this uses production fill_price for the
// counterfactual. We're not simulating different fills; we're scaling
// the realized pnl by the size ratio.

import 'dotenv/config'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import * as db from '../../lib/db.js'
import { parseArgs } from '../../lib/cli-args.js'
import crypto from 'node:crypto'

import { archetypeR, pAtLeast } from '../../lib/strikeout-model.js'
import { run as pathRun }  from '../../oracle/layers/2-path/impl.js'
import { run as trustRun } from '../../oracle/layers/3-trust/impl.js'
import { run as judgeRun } from '../../oracle/layers/5-judge/impl.js'

const today    = new Date().toISOString().slice(0, 10)
const sixtyAgo = new Date(Date.now() - 60 * 86400_000).toISOString().slice(0, 10)
const opts = parseArgs({
  since:    { default: sixtyAgo },
  until:    { default: today },
  bankroll: { type: 'number', default: 1000 },
  output:   { default: null },
})
const SINCE = opts.since
const UNTIL = opts.until
const BANKROLL = opts.bankroll
const OUTBASE = opts.output ?? `oracle/oracle-full-backtest-${today}`

const STRIKES = [3,4,5,6,7,8,9,10,11,12]

console.log(`[oracleFullBacktest] window ${SINCE} → ${UNTIL}, bankroll=$${BANKROLL}`)

// ─── Load settled placed pregame bets ───────────────────────────────
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
    dp.model_input_json
  FROM ks_bets b
  LEFT JOIN decision_pipeline dp
    ON dp.bet_date = b.bet_date AND dp.pitcher_id = b.pitcher_id
  WHERE b.result IN ('win','loss','void')
    AND b.actual_ks IS NOT NULL
    AND b.live_bet = 0
    AND b.bet_date BETWEEN ? AND ?
  ORDER BY b.bet_date ASC, b.id ASC
`, [SINCE, UNTIL])
console.log(`[oracleFullBacktest] loaded ${bets.length} settled placed pre-game bets`)

const pidSet = [...new Set(bets.map(b => String(b.pitcher_id)))]
const savantRows = pidSet.length
  ? await db.all(
      `SELECT player_id, k_pct, ip, manager_leash_factor, nb_r
       FROM pitcher_statcast WHERE player_id IN (${pidSet.map(()=>'?').join(',')})`,
      pidSet,
    )
  : []
const savantMap = new Map(savantRows.map(r => [String(r.player_id), r]))

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
  const synthInputs  = crypto.createHash('sha256')
    .update(`${synthMatchup}-inputs`).digest('hex')

  return {
    schema_version: '1.0.0', layer: 'math', layer_version: '1.0.0',
    source: 'oracle_layer_1_math',
    run_id: `synth-${row.bet_id}`,
    decision_id: null, computed_at: '2026-05-01T00:00:00.000Z',
    commit_hash: 'backtest-synth',
    inputs_hash: synthInputs, output_hash: synthMatchup,
    inner: {
      expectedBF: expected_bf, pK_blended,
      avgPitches: Number.isFinite(lc.avg_pitches) ? lc.avg_pitches : null,
      leashFlag: !!lc.leash_flag,
      bfSource: mi.bf_source,
      lambdaBase: lambda_base,
      nStarts: mi.n_starts,
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

// ─── Replay every bet through full pipeline ────────────────────────
const skipped = { no_dp: 0, parse_fail: 0, judge_fail: 0 }
const decisions = []   // per-bet records for analysis

for (const row of bets) {
  if (!row.lambda_calc_json || !row.model_input_json) { skipped.no_dp++; continue }
  let env
  try {
    env = buildSyntheticEnvelope(row, savantMap.get(String(row.pitcher_id)))
  } catch { skipped.parse_fail++; continue }

  const ctx = {
    decision_id: `bt-${row.bet_id}`,
    pitcher_id: String(row.pitcher_id),
    pitcher_name: row.pitcher_name,
    bet_date: row.bet_date,
    strike: Number(row.strike),
    side: row.side,
  }

  let pathR, trustR, judgeR
  try {
    pathR  = await pathRun(env, ctx)
    trustR = await trustRun(env, pathR, ctx)
    judgeR = await judgeRun(env, pathR, trustR, {
      ...ctx,
      market_mid: Number(row.market_mid) / 100,
      spread: Number.isFinite(Number(row.spread)) ? Number(row.spread) / 100 : null,
      bankroll: BANKROLL,
    })
  } catch (err) {
    skipped.judge_fail++
    continue
  }

  const productionSize = Number(row.bet_size) || 0
  const productionPnl  = Number(row.pnl) || 0
  // Counterfactual size: judge.size_usd. Counterfactual pnl scales by size ratio.
  const sizeRatio = productionSize > 0 ? judgeR.size_usd / productionSize : 0
  const oraclePnl = productionPnl * sizeRatio

  decisions.push({
    bet_id: row.bet_id, bet_date: row.bet_date,
    pitcher_id: row.pitcher_id, pitcher_name: row.pitcher_name,
    strike: row.strike, side: row.side,
    result: row.result, actual_ks: row.actual_ks,
    user_id: row.user_id,

    production_pnl:   productionPnl,
    production_size:  productionSize,

    feasibility:    pathR.feasibility,
    path_reason:    pathR.reason_code,
    trust_score:    trustR.trust_score,
    trust_level:    trustR.trust_level,
    decision:       judgeR.decision,
    judge_reason:   judgeR.reason_code,
    edge:           judgeR.edge,
    threshold:      judgeR.threshold,
    kelly_eff:      judgeR.kelly_eff,
    oracle_size:    judgeR.size_usd,
    oracle_pnl:     oraclePnl,
  })
}

console.log(`[oracleFullBacktest] processed ${decisions.length} bets; skipped no_dp=${skipped.no_dp} parse_fail=${skipped.parse_fail} judge_fail=${skipped.judge_fail}`)

// ─── Aggregates ────────────────────────────────────────────────────
function blank() { return { n: 0, wins: 0, losses: 0, voids: 0, prod_pnl: 0, oracle_pnl: 0, prod_size: 0, oracle_size: 0 } }
function bump(b, d) {
  b.n++
  if (d.result === 'win')  b.wins++
  if (d.result === 'loss') b.losses++
  if (d.result === 'void') b.voids++
  b.prod_pnl    += d.production_pnl
  b.oracle_pnl  += d.oracle_pnl
  b.prod_size   += d.production_size
  b.oracle_size += d.oracle_size
}

const byDecision = {}
for (const d of decisions) {
  if (!byDecision[d.decision]) byDecision[d.decision] = blank()
  bump(byDecision[d.decision], d)
}

const byFeas = {}
for (const d of decisions) {
  if (!byFeas[d.feasibility]) byFeas[d.feasibility] = blank()
  bump(byFeas[d.feasibility], d)
}

const byTrust = {}
for (const d of decisions) {
  if (!byTrust[d.trust_level]) byTrust[d.trust_level] = blank()
  bump(byTrust[d.trust_level], d)
}

const byUser = {}
for (const d of decisions) {
  const u = String(d.user_id ?? 'unknown')
  if (!byUser[u]) byUser[u] = blank()
  bump(byUser[u], d)
}

const totalProductionPnl = decisions.reduce((s, d) => s + d.production_pnl, 0)
const totalOraclePnl     = decisions.reduce((s, d) => s + d.oracle_pnl, 0)
const totalProductionSize = decisions.reduce((s, d) => s + d.production_size, 0)
const totalOracleSize     = decisions.reduce((s, d) => s + d.oracle_size, 0)

// Fixed-size counterfactual: hold production size, just apply Oracle's
// fire/skip/size_down decision. Isolates DECISION quality from SIZING.
//   skip      → oracle_pnl_fixed = 0
//   fire      → oracle_pnl_fixed = production_pnl
//   size_down → oracle_pnl_fixed = production_pnl × 0.5
function fixedSizePnl(d) {
  if (d.decision === 'skip')      return 0
  if (d.decision === 'size_down') return d.production_pnl * 0.5
  return d.production_pnl
}
for (const d of decisions) d.oracle_pnl_fixed = fixedSizePnl(d)
const totalOraclePnlFixed = decisions.reduce((s, d) => s + d.oracle_pnl_fixed, 0)

const fired   = decisions.filter(d => d.decision === 'fire')
const sized   = decisions.filter(d => d.decision === 'size_down')
const skippedDecisions = decisions.filter(d => d.decision === 'skip')
const skipPnl = skippedDecisions.reduce((s, d) => s + d.production_pnl, 0)

// Outliers
const skipButWonProduction = skippedDecisions.filter(d => d.result === 'win').length
const fireButLost          = fired.filter(d => d.result === 'loss').length

// ─── Render ────────────────────────────────────────────────────────
const lines = []
const fmt = (n, d=2) => Number.isFinite(n) ? n.toFixed(d) : '—'

lines.push(`# Full Oracle Pipeline Backtest — ${today}`)
lines.push(``)
lines.push(`**Pipeline:** Layer 1 (Math) → Layer 2 (Path) → Layer 3 (Trust) → Layer 5 (Judge v0.1)`)
lines.push(`**Layer 4 (Critic) is NOT included** — Judge v0.1 has a no-AI path. Adding Critic`)
lines.push(`would tighten the fire→skip rate further.`)
lines.push(``)
lines.push(`Window: ${SINCE} → ${UNTIL}`)
lines.push(`Bankroll for sizing: $${BANKROLL}`)
lines.push(``)
lines.push(`## Sample`)
lines.push(``)
lines.push(`| Metric | Value |`)
lines.push(`|---|---:|`)
lines.push(`| Settled placed pre-game bets in window | ${bets.length} |`)
lines.push(`| Replayable through full pipeline | ${decisions.length} |`)
lines.push(`| Skipped (no decision_pipeline JSON) | ${skipped.no_dp} |`)
lines.push(`| Skipped (parse / judge failure) | ${skipped.parse_fail + skipped.judge_fail} |`)
lines.push(``)
lines.push(`## Headline numbers`)
lines.push(``)
lines.push(`| Metric | Production | Oracle (fixed-size) | Oracle (Kelly-resized) |`)
lines.push(`|---|---:|---:|---:|`)
lines.push(`| Total bets fired | ${decisions.length} | ${fired.length} | ${fired.length} |`)
lines.push(`| Total bets sized_down | — | ${sized.length} (×0.5) | ${sized.length} (×Kelly) |`)
lines.push(`| Total bets skipped | 0 | ${skippedDecisions.length} | ${skippedDecisions.length} |`)
lines.push(`| Total size deployed | $${fmt(totalProductionSize)} | $${fmt(totalProductionSize)} (held) | $${fmt(totalOracleSize)} |`)
lines.push(`| Total P&L | $${fmt(totalProductionPnl)} | $${fmt(totalOraclePnlFixed)} | $${fmt(totalOraclePnl)} |`)
lines.push(`| Oracle Δ vs production | — | **$${fmt(totalOraclePnlFixed - totalProductionPnl)}** | $${fmt(totalOraclePnl - totalProductionPnl)} |`)
lines.push(`| P&L on bets Oracle would have skipped | — | $${fmt(skipPnl)} | $${fmt(skipPnl)} |`)
lines.push(``)
lines.push(`> **Fixed-size** holds production's bet_size and just applies Oracle's`)
lines.push(`> decision (skip/fire/half). This isolates decision quality from sizing.`)
lines.push(`> **Kelly-resized** uses Judge v0.1's Kelly-based size at the configured`)
lines.push(`> bankroll, which can differ wildly from production's actual sizes.`)
lines.push(`> The fixed-size column is the cleaner read for whether the chain helps.`)
lines.push(``)

lines.push(`## By Judge decision`)
lines.push(``)
lines.push(`| decision | n | wins | losses | win_rate | production_pnl | oracle_pnl |`)
lines.push(`|---|---:|---:|---:|---:|---:|---:|`)
for (const k of ['fire','size_down','skip']) {
  const b = byDecision[k] ?? blank()
  const wr = b.wins + b.losses > 0 ? (b.wins / (b.wins + b.losses) * 100).toFixed(1) + '%' : '—'
  lines.push(`| ${k} | ${b.n} | ${b.wins} | ${b.losses} | ${wr} | $${fmt(b.prod_pnl)} | $${fmt(b.oracle_pnl)} |`)
}
lines.push(``)

lines.push(`## By Layer 2 feasibility`)
lines.push(``)
lines.push(`| feasibility | n | wins | losses | win_rate | production_pnl |`)
lines.push(`|---|---:|---:|---:|---:|---:|`)
for (const k of ['strong','viable','fragile','dead']) {
  const b = byFeas[k] ?? blank()
  const wr = b.wins + b.losses > 0 ? (b.wins / (b.wins + b.losses) * 100).toFixed(1) + '%' : '—'
  lines.push(`| ${k} | ${b.n} | ${b.wins} | ${b.losses} | ${wr} | $${fmt(b.prod_pnl)} |`)
}
lines.push(``)

lines.push(`## By Layer 3 trust level`)
lines.push(``)
lines.push(`| trust_level | n | wins | losses | win_rate | production_pnl |`)
lines.push(`|---|---:|---:|---:|---:|---:|`)
for (const k of ['high','medium','low']) {
  const b = byTrust[k] ?? blank()
  const wr = b.wins + b.losses > 0 ? (b.wins / (b.wins + b.losses) * 100).toFixed(1) + '%' : '—'
  lines.push(`| ${k} | ${b.n} | ${b.wins} | ${b.losses} | ${wr} | $${fmt(b.prod_pnl)} |`)
}
lines.push(``)

lines.push(`## By account (user_id)`)
lines.push(``)
lines.push(`| user_id | n | wins | losses | production_pnl | oracle_pnl |`)
lines.push(`|---|---:|---:|---:|---:|---:|`)
for (const k of Object.keys(byUser).sort()) {
  const b = byUser[k]
  lines.push(`| ${k} | ${b.n} | ${b.wins} | ${b.losses} | $${fmt(b.prod_pnl)} | $${fmt(b.oracle_pnl)} |`)
}
lines.push(``)

lines.push(`## Outliers`)
lines.push(``)
lines.push(`- ${skipButWonProduction} bets that Oracle would SKIP but production WON`)
lines.push(`- ${fireButLost} bets that Oracle would FIRE but production LOST`)
lines.push(`- ${sized.filter(d => d.result === 'win').length} sized_down bets that won`)
lines.push(`- ${sized.filter(d => d.result === 'loss').length} sized_down bets that lost`)
lines.push(``)

lines.push(`## Caveats`)
lines.push(``)
lines.push(`1. Layer 1 envelope is synthetic (rebuilt from decision_pipeline JSON).`)
lines.push(`2. Today's pitcher_statcast used for r — may diverge from production-time r.`)
lines.push(`3. Judge sizing assumes \\$${BANKROLL} bankroll uniformly. Real production used`)
lines.push(`   varying bankroll per account; Oracle size shown is theoretical at this bankroll.`)
lines.push(`4. \`production_size\` reflects the actual size production placed; \`oracle_size\` is`)
lines.push(`   what Judge v0.1 would size at the configured bankroll.`)
lines.push(`5. Counterfactual pnl = production pnl × (oracle_size / production_size). This`)
lines.push(`   assumes the same fill at the same price — does not simulate liquidity changes.`)
lines.push(`6. **Layer 4 (Critic / AI) is NOT in this run.** Adding Critic typically tightens`)
lines.push(`   fire→skip and would change these numbers.`)
lines.push(`7. Production data only goes back to 2026-04-20 in this DB; effective replay`)
lines.push(`   coverage is shorter due to decision_pipeline JSON capture cutover.`)
lines.push(``)

const mdPath = path.resolve(`${OUTBASE}.md`)
writeFileSync(mdPath, lines.join('\n'), 'utf-8')

// CSV
const csvLines = ['bet_id,bet_date,pitcher,strike,side,result,production_pnl,production_size,feasibility,trust_level,decision,judge_reason,edge,kelly_eff,oracle_size,oracle_pnl']
for (const d of decisions) {
  const safe = (s) => String(s ?? '').replace(/,/g, ';')
  csvLines.push([
    d.bet_id, d.bet_date, safe(d.pitcher_name), d.strike, d.side, d.result,
    d.production_pnl.toFixed(2), d.production_size.toFixed(2),
    d.feasibility, d.trust_level, d.decision, d.judge_reason,
    d.edge?.toFixed(4), d.kelly_eff?.toFixed(4),
    d.oracle_size.toFixed(2), d.oracle_pnl.toFixed(2),
  ].join(','))
}
const csvPath = path.resolve(`${OUTBASE}.csv`)
writeFileSync(csvPath, csvLines.join('\n'), 'utf-8')

// Stdout
console.log('\n═══ STDOUT SUMMARY ═══')
console.log(`Markdown: ${mdPath}`)
console.log(`CSV:      ${csvPath}`)
console.log(`\nProduction P&L:           $${totalProductionPnl.toFixed(2)}`)
console.log(`Oracle P&L (fixed-size):  $${totalOraclePnlFixed.toFixed(2)}  Δ=$${(totalOraclePnlFixed - totalProductionPnl).toFixed(2)}`)
console.log(`Oracle P&L (Kelly-sized): $${totalOraclePnl.toFixed(2)}  Δ=$${(totalOraclePnl - totalProductionPnl).toFixed(2)}`)
console.log(`\nDecision counts:`)
console.log(`  fire       ${(byDecision.fire ?? blank()).n}`)
console.log(`  size_down  ${(byDecision.size_down ?? blank()).n}`)
console.log(`  skip       ${(byDecision.skip ?? blank()).n}`)
console.log(`\nP&L if Oracle had filtered: oracle pnl = $${totalOraclePnl.toFixed(2)} vs production $${totalProductionPnl.toFixed(2)}`)
console.log(`P&L on bets Oracle would have skipped: $${skipPnl.toFixed(2)}`)

await db.close()
