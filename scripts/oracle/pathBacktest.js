// scripts/oracle/pathBacktest.js
//
// Layer 2 (Path) backtest — replay every settled placed pre-game bet
// through Layer 2's feasibility classifier, using a synthetic Layer 1
// envelope reconstructed from decision_pipeline JSON snapshots.
//
// Reports:
//   - Verdict distribution
//   - Win rate / avg pnl / total pnl per feasibility class
//   - Counterfactual P&L under three filters:
//       A. skip dead only
//       B. skip dead + fragile
//       C. skip dead, half-size fragile
//   - Buckets by side, archetype proxy, strike bucket, bf_source_tier
//   - Reason-code distribution
//
// Pre-game only (live_bet=0). result IN ('win','loss','void').
// Reads today's pitcher_statcast for nbR (drift caveat per Bite 6.3).
//
// Usage:
//   node scripts/oracle/pathBacktest.js [--since YYYY-MM-DD] [--until YYYY-MM-DD]

import 'dotenv/config'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import * as db from '../../lib/db.js'
import { parseArgs } from '../../lib/cli-args.js'
import crypto from 'node:crypto'

import { archetypeR, nbCDF, pAtLeast } from '../../lib/strikeout-model.js'
import { run as pathRun, FEASIBILITY_CLASSES } from '../../oracle/layers/2-path/impl.js'

const today    = new Date().toISOString().slice(0, 10)
const sixtyAgo = new Date(Date.now() - 60 * 86400_000).toISOString().slice(0, 10)
const opts = parseArgs({
  since:  { default: sixtyAgo },
  until:  { default: today },
  output: { default: null },
})
const SINCE = opts.since
const UNTIL = opts.until
const OUTBASE = opts.output ?? `oracle/layers/2-path/path-backtest-${today}`

const STRIKES = [3,4,5,6,7,8,9,10,11,12]

// ─── Load bets + JSON snapshots ─────────────────────────────────────
console.log(`[pathBacktest] querying ${SINCE} → ${UNTIL}`)
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
    b.model_prob,
    b.lambda        AS lambda_logged,
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
console.log(`[pathBacktest] loaded ${bets.length} settled placed pre-game bets`)

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

// ─── Build synthetic Layer 1 envelope ──────────────────────────────
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

  // Synthetic hashes — Layer 2 uses these only to link evidence,
  // not for replay validation in this backtest. Make them deterministic
  // by hashing the source content.
  const synthMatchup = crypto.createHash('sha256')
    .update(`${row.pitcher_id}|${row.bet_date}|${lambda_final}`)
    .digest('hex')
  const synthInputs  = crypto.createHash('sha256')
    .update(`${synthMatchup}-inputs`).digest('hex')

  return {
    schema_version: '1.0.0',
    layer: 'math',
    layer_version: '1.0.0',
    source: 'oracle_layer_1_math',
    run_id: `synth-${row.bet_id}`,
    decision_id: null,
    computed_at: '2026-05-01T00:00:00.000Z',
    commit_hash: 'backtest-synth',
    inputs_hash: synthInputs,
    output_hash: synthMatchup,
    inner: {
      expectedBF: expected_bf,
      pK_blended,
      avgPitches: Number.isFinite(lc.avg_pitches) ? lc.avg_pitches : null,
      leashFlag:  !!lc.leash_flag,
      bfSource:   mi.bf_source,
      lambdaBase: lambda_base,
      nStarts:    mi.n_starts,
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
    nb_r:         r,
    nb_r_source:  savant?.nb_r != null ? 'fitted' : (savant?.k_pct != null ? 'archetype_kpct' : 'global_default'),
    prob_at_least,
    status: 'ok',
    warnings: [],
  }
}

// ─── Aggregator ─────────────────────────────────────────────────────
const skipped = { no_dp: 0, parse_fail: 0 }
const verdicts = []   // { row, feasibility, reason_code, ... }

for (const row of bets) {
  if (!row.lambda_calc_json || !row.model_input_json) { skipped.no_dp++; continue }
  let env
  try {
    env = buildSyntheticEnvelope(row, savantMap.get(String(row.pitcher_id)))
  } catch { skipped.parse_fail++; continue }

  let result
  try {
    result = await pathRun(env, {
      decision_id: `bt-${row.bet_id}`,
      pitcher_id:  String(row.pitcher_id),
      pitcher_name: row.pitcher_name,
      bet_date:    row.bet_date,
      strike:      Number(row.strike),
      side:        row.side,
    })
  } catch (err) {
    skipped.parse_fail++
    continue
  }

  verdicts.push({
    bet_id:       row.bet_id,
    bet_date:     row.bet_date,
    pitcher_id:   row.pitcher_id,
    pitcher_name: row.pitcher_name,
    strike:       row.strike,
    side:         row.side,
    result:       row.result,
    actual_ks:    row.actual_ks,
    pnl:          Number(row.pnl) || 0,
    bet_size:     Number(row.bet_size) || 0,
    user_id:      row.user_id,
    feasibility:  result.feasibility,
    reason_code:  result.reason_code,
    secondary_reasons: result.secondary_reasons,
    bf_source_tier: result.bf_source_tier,
    workload_signal: result.workload_signal,
    required_bf:  result.required_bf,
    expected_bf:  result.expected_bf,
    bf_gap:       result.bf_gap,
    bf_gap_ratio: result.bf_gap_ratio,
    gap_under:    result.gap_under,
    lambda_final: result.lambda_final,
  })
}
console.log(`[pathBacktest] processed ${verdicts.length} bets; skipped no_dp=${skipped.no_dp} parse_fail=${skipped.parse_fail}`)

// ─── Aggregate ──────────────────────────────────────────────────────
function blank() {
  return { n: 0, wins: 0, losses: 0, voids: 0, sum_pnl: 0, sum_size: 0 }
}
function bump(b, v) {
  b.n++
  if (v.result === 'win')  b.wins++
  if (v.result === 'loss') b.losses++
  if (v.result === 'void') b.voids++
  b.sum_pnl  += v.pnl
  b.sum_size += v.bet_size
}
function bucketed(field) {
  const map = {}
  for (const v of verdicts) {
    const k = String(v[field])
    if (!map[k]) map[k] = blank()
    bump(map[k], v)
  }
  return map
}
function strikeBucket(s) {
  if (s <= 4) return '3-4'
  if (s <= 6) return '5-6'
  if (s <= 8) return '7-8'
  return '9+'
}

const byFeas    = bucketed('feasibility')
const byReason  = bucketed('reason_code')
const bySide    = bucketed('side')
const byTier    = bucketed('bf_source_tier')
const byUser    = bucketed('user_id')
const byStrikeBucket = {}
for (const v of verdicts) {
  const k = strikeBucket(v.strike)
  if (!byStrikeBucket[k]) byStrikeBucket[k] = blank()
  bump(byStrikeBucket[k], v)
}

// Counterfactual filters
const baselinePnl   = verdicts.reduce((s, v) => s + v.pnl, 0)
const baselineSize  = verdicts.reduce((s, v) => s + v.bet_size, 0)
const totalBets     = verdicts.length

const filterA = { name: 'skip_dead', n: 0, sum_pnl: 0, skipped_pnl: 0 }
const filterB = { name: 'skip_dead+fragile', n: 0, sum_pnl: 0, skipped_pnl: 0 }
const filterC = { name: 'skip_dead+halfsize_fragile', n: 0, sum_pnl: 0, skipped_pnl: 0 }
for (const v of verdicts) {
  // A: skip dead only
  if (v.feasibility === 'dead') {
    filterA.skipped_pnl += v.pnl
  } else {
    filterA.n++
    filterA.sum_pnl += v.pnl
  }
  // B: skip dead + fragile
  if (v.feasibility === 'dead' || v.feasibility === 'fragile') {
    filterB.skipped_pnl += v.pnl
  } else {
    filterB.n++
    filterB.sum_pnl += v.pnl
  }
  // C: skip dead, half-size fragile
  if (v.feasibility === 'dead') {
    filterC.skipped_pnl += v.pnl
  } else if (v.feasibility === 'fragile') {
    filterC.n++
    filterC.sum_pnl += v.pnl * 0.5  // pnl scales with size; half-size halves pnl
    filterC.skipped_pnl += v.pnl * 0.5  // and we save (or forgo) half
  } else {
    filterC.n++
    filterC.sum_pnl += v.pnl
  }
}

// Bets that would have been filtered as dead but actually WON (false dead?)
const deadButWon = verdicts.filter(v => v.feasibility === 'dead' && v.result === 'win')
const fragileButWon = verdicts.filter(v => v.feasibility === 'fragile' && v.result === 'win')
const strongButLost = verdicts.filter(v => v.feasibility === 'strong' && v.result === 'loss')

// ─── Render Markdown ────────────────────────────────────────────────
const lines = []
const fmt = (n, d=2) => Number.isFinite(n) ? n.toFixed(d) : '—'
lines.push(`# Layer 2 (Path) Backtest — ${today}`)
lines.push(``)
lines.push(`**STATUS:** PRELIMINARY — Layer 2 was just built; this is the first replay.`)
lines.push(`**Window:** ${SINCE} → ${UNTIL}`)
lines.push(``)
lines.push(`## Sample`)
lines.push(``)
lines.push(`| Metric | Value |`)
lines.push(`|---|---:|`)
lines.push(`| Settled placed pre-game bets in window | ${bets.length} |`)
lines.push(`| Replayable through Layer 2 (with decision_pipeline JSON) | ${verdicts.length} |`)
lines.push(`| Skipped (no decision_pipeline) | ${skipped.no_dp} |`)
lines.push(`| Skipped (parse / replay failure) | ${skipped.parse_fail} |`)
lines.push(`| Total baseline P&L | $${fmt(baselinePnl)} |`)
lines.push(`| Total baseline size | $${fmt(baselineSize)} |`)
lines.push(``)
lines.push(`> Reconstruction caveat: Layer 1 envelopes are synthesized from`)
lines.push(`> decision_pipeline.lambda_calc_json + model_input_json. Today's`)
lines.push(`> pitcher_statcast is used for r (archetypeR). This may diverge`)
lines.push(`> from production-time r if the pitcher pitched after bet_date.`)
lines.push(`> Layer 2 verdicts are based on production-logged inner math.`)
lines.push(``)

// Distribution by feasibility
lines.push(`## Distribution by feasibility class`)
lines.push(``)
lines.push(`| class | n | wins | losses | voids | win_rate | total_pnl | avg_pnl | sum_size | roi_on_size |`)
lines.push(`|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|`)
for (const k of ['strong','viable','fragile','dead']) {
  const b = byFeas[k] ?? blank()
  const wr = b.wins + b.losses > 0 ? b.wins / (b.wins + b.losses) : null
  const roi = b.sum_size > 0 ? b.sum_pnl / b.sum_size : null
  lines.push(`| ${k} | ${b.n} | ${b.wins} | ${b.losses} | ${b.voids} | ${wr != null ? (wr*100).toFixed(1)+'%' : '—'} | $${fmt(b.sum_pnl)} | $${fmt(b.n ? b.sum_pnl/b.n : 0)} | $${fmt(b.sum_size)} | ${roi != null ? (roi*100).toFixed(2)+'%' : '—'} |`)
}
lines.push(``)

// Counterfactual P&L
lines.push(`## Counterfactual P&L under feasibility filters`)
lines.push(``)
lines.push(`| filter | bets fired | bets skipped | counterfactual P&L | Δ vs baseline | skipped P&L (forgone or saved) |`)
lines.push(`|---|---:|---:|---:|---:|---:|`)
const baselineDesc = `baseline (production)`
lines.push(`| ${baselineDesc} | ${totalBets} | 0 | $${fmt(baselinePnl)} | — | — |`)
for (const f of [filterA, filterB, filterC]) {
  const delta = f.sum_pnl - baselinePnl
  lines.push(`| ${f.name} | ${f.n} | ${totalBets - f.n} | $${fmt(f.sum_pnl)} | ${delta >= 0 ? '+' : ''}$${fmt(delta)} | $${fmt(f.skipped_pnl)} |`)
}
lines.push(``)
lines.push(`> "skipped P&L" = sum of pnl on the bets we would NOT have placed.`)
lines.push(`> Negative skipped P&L = filter would have SAVED that money (skipped losing bets).`)
lines.push(`> Positive skipped P&L = filter would have FORGONE that money (skipped winning bets).`)
lines.push(``)

// By side
lines.push(`## By side`)
lines.push(``)
lines.push(`| side | n | wins | losses | win_rate | total_pnl |`)
lines.push(`|---|---:|---:|---:|---:|---:|`)
for (const k of Object.keys(bySide).sort()) {
  const b = bySide[k]
  const wr = b.wins + b.losses > 0 ? b.wins / (b.wins + b.losses) : null
  lines.push(`| ${k} | ${b.n} | ${b.wins} | ${b.losses} | ${wr != null ? (wr*100).toFixed(1)+'%' : '—'} | $${fmt(b.sum_pnl)} |`)
}
lines.push(``)

// By strike bucket
lines.push(`## By strike bucket`)
lines.push(``)
lines.push(`| strike bucket | n | wins | losses | win_rate | total_pnl |`)
lines.push(`|---|---:|---:|---:|---:|---:|`)
for (const k of ['3-4','5-6','7-8','9+']) {
  const b = byStrikeBucket[k] ?? blank()
  const wr = b.wins + b.losses > 0 ? b.wins / (b.wins + b.losses) : null
  lines.push(`| ${k} | ${b.n} | ${b.wins} | ${b.losses} | ${wr != null ? (wr*100).toFixed(1)+'%' : '—'} | $${fmt(b.sum_pnl)} |`)
}
lines.push(``)

// By bf_source_tier
lines.push(`## By bf_source_tier`)
lines.push(``)
lines.push(`| tier | n | wins | losses | win_rate | total_pnl |`)
lines.push(`|---|---:|---:|---:|---:|---:|`)
for (const k of Object.keys(byTier).sort()) {
  const b = byTier[k]
  const wr = b.wins + b.losses > 0 ? b.wins / (b.wins + b.losses) : null
  lines.push(`| ${k} | ${b.n} | ${b.wins} | ${b.losses} | ${wr != null ? (wr*100).toFixed(1)+'%' : '—'} | $${fmt(b.sum_pnl)} |`)
}
lines.push(``)

// By account
lines.push(`## By account`)
lines.push(``)
lines.push(`| user_id | n | wins | losses | total_pnl |`)
lines.push(`|---|---:|---:|---:|---:|`)
for (const k of Object.keys(byUser).sort()) {
  const b = byUser[k]
  lines.push(`| ${k} | ${b.n} | ${b.wins} | ${b.losses} | $${fmt(b.sum_pnl)} |`)
}
lines.push(``)

// Reason code distribution
lines.push(`## Reason-code distribution (top 15)`)
lines.push(``)
lines.push(`| reason_code | n | wins | losses | win_rate | total_pnl |`)
lines.push(`|---|---:|---:|---:|---:|---:|`)
const sortedReasons = Object.entries(byReason).sort((a,b) => b[1].n - a[1].n).slice(0, 15)
for (const [k, b] of sortedReasons) {
  const wr = b.wins + b.losses > 0 ? b.wins / (b.wins + b.losses) : null
  lines.push(`| ${k} | ${b.n} | ${b.wins} | ${b.losses} | ${wr != null ? (wr*100).toFixed(1)+'%' : '—'} | $${fmt(b.sum_pnl)} |`)
}
lines.push(``)

// Outliers
lines.push(`## Notable outliers`)
lines.push(``)
lines.push(`### Bets classified DEAD that actually WON (n=${deadButWon.length})`)
lines.push(`If non-zero, these are bets Layer 2 would have skipped but were profitable.`)
lines.push(``)
lines.push(`| date | pitcher | strike-side | actual_ks | pnl | reason_code |`)
lines.push(`|---|---|---|---:|---:|---|`)
for (const v of deadButWon.slice(0, 20)) {
  lines.push(`| ${v.bet_date} | ${v.pitcher_name} | ${v.strike}${v.side} | ${v.actual_ks} | $${fmt(v.pnl)} | ${v.reason_code} |`)
}
lines.push(``)
lines.push(`### Bets classified STRONG that LOST (n=${strongButLost.length})`)
lines.push(`If non-zero, these are bets Layer 2 was confident on but lost.`)
lines.push(``)
lines.push(`| date | pitcher | strike-side | actual_ks | pnl | reason_code |`)
lines.push(`|---|---|---|---:|---:|---|`)
for (const v of strongButLost.slice(0, 20)) {
  lines.push(`| ${v.bet_date} | ${v.pitcher_name} | ${v.strike}${v.side} | ${v.actual_ks} | $${fmt(v.pnl)} | ${v.reason_code} |`)
}
lines.push(``)
lines.push(`### Bets classified FRAGILE that won (n=${fragileButWon.length})`)
lines.push(``)

// Write Markdown
const mdPath = path.resolve(`${OUTBASE}.md`)
writeFileSync(mdPath, lines.join('\n'), 'utf-8')

// CSV side-car: per-bet
const csvLines = ['bet_id,bet_date,pitcher_id,pitcher_name,strike,side,result,actual_ks,pnl,bet_size,feasibility,reason_code,bf_source_tier,workload_signal,required_bf,expected_bf,bf_gap,bf_gap_ratio,gap_under,lambda_final']
for (const v of verdicts) {
  const safe = (s) => String(s ?? '').replace(/,/g, ';').replace(/"/g, "'")
  csvLines.push([
    v.bet_id, v.bet_date, v.pitcher_id, safe(v.pitcher_name),
    v.strike, v.side, v.result, v.actual_ks,
    v.pnl.toFixed(2), v.bet_size.toFixed(2),
    v.feasibility, v.reason_code, v.bf_source_tier, v.workload_signal,
    v.required_bf?.toFixed(3), v.expected_bf?.toFixed(2),
    v.bf_gap?.toFixed(3), v.bf_gap_ratio?.toFixed(4),
    v.gap_under?.toFixed(3), v.lambda_final?.toFixed(3),
  ].join(','))
}
const csvPath = path.resolve(`${OUTBASE}.csv`)
writeFileSync(csvPath, csvLines.join('\n'), 'utf-8')

// Stdout summary
console.log('\n═══ STDOUT SUMMARY ═══')
console.log(`Markdown: ${mdPath}`)
console.log(`CSV:      ${csvPath}`)
console.log(`\nFeasibility distribution:`)
for (const k of ['strong','viable','fragile','dead']) {
  const b = byFeas[k] ?? blank()
  const wr = b.wins + b.losses > 0 ? (b.wins / (b.wins + b.losses) * 100).toFixed(1) : '—'
  console.log(`  ${k.padEnd(8)} n=${String(b.n).padStart(4)}  win_rate=${wr}%  pnl=$${b.sum_pnl.toFixed(2)}`)
}
console.log(`\nCounterfactuals:`)
console.log(`  baseline                       n=${totalBets}  pnl=$${baselinePnl.toFixed(2)}`)
console.log(`  skip_dead                      n=${filterA.n}  pnl=$${filterA.sum_pnl.toFixed(2)}  Δ=${(filterA.sum_pnl - baselinePnl).toFixed(2)}`)
console.log(`  skip_dead+fragile              n=${filterB.n}  pnl=$${filterB.sum_pnl.toFixed(2)}  Δ=${(filterB.sum_pnl - baselinePnl).toFixed(2)}`)
console.log(`  skip_dead+halfsize_fragile     n=${filterC.n}  pnl=$${filterC.sum_pnl.toFixed(2)}  Δ=${(filterC.sum_pnl - baselinePnl).toFixed(2)}`)
console.log(`\nOutliers: ${deadButWon.length} dead-but-won; ${strongButLost.length} strong-but-lost; ${fragileButWon.length} fragile-but-won`)

await db.close()
