// scripts/oracle/dkBlendBacktest.js
//
// Bite 6.3 — DK blend counterfactual backtest harness.
//
// Replays settled placed pre-game bets, sweeps w_dk schedules, and
// produces a Markdown + CSV report for Bite 6.4 review.
//
// Locked design (PARITY_NOTES.md "Bite 6.2 close-out" + Bite 6.3 surface):
//   - Decision replay only — bets the production system PLACED.
//   - Path A reconstruction: probabilities derived from
//     decision_pipeline.lambda_calc_json (production-time view).
//   - Today's pitcher_statcast for r and thinness inputs (with
//     uncertainty flag when today's savant likely diverged from bet-date).
//   - Fixed-size P&L is the primary signal; Kelly-resized P&L reported.
//   - 15 schedules: THIN×{0,0.10,0.20,0.30,0.40} × MID×{0,0.05,0.10}
//     × STABLE×{0}.
//   - Decision-flip gate: YES/NO_MIN_EDGE=0.12, MIN_EDGE_FLOOR=0.04.
//     betting_rules dynamic overrides NOT consulted (documented).
//
// Usage:
//   node scripts/oracle/dkBlendBacktest.js \
//     [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--output PATH]
//
// Defaults: --since today−60d, --until today.

import 'dotenv/config'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import * as db from '../../lib/db.js'
import { parseArgs } from '../../lib/cli-args.js'
import {
  blendBF, classifyThinness, bfSourceTier,
  THINNESS_CLASSES, DEFAULT_W_DK_SCHEDULE, DEFAULT_BF_CAP_K,
} from '../../oracle/layers/1-math/dkBlend.js'
import { archetypeR, nbCDF, pAtLeast } from '../../lib/strikeout-model.js'

// ─── Args ────────────────────────────────────────────────────────────
const today    = new Date().toISOString().slice(0, 10)
const sixtyAgo = new Date(Date.now() - 60 * 86400_000).toISOString().slice(0, 10)
const opts = parseArgs({
  since:  { default: sixtyAgo },
  until:  { default: today },
  output: { default: null },
})
const SINCE  = opts.since
const UNTIL  = opts.until
const OUTBASE = opts.output ?? `oracle/layers/1-math/dkBlend-backtest-${today}`

// ─── Production fire-gate constants (locked from strikeoutEdge.js) ──
const SIDE_MIN_EDGE  = 0.12         // YES_MIN_EDGE === NO_MIN_EDGE
const MIN_EDGE_FLOOR = 0.04
const KELLY_LN_CLIP  = 1e-9         // log clip for log-loss

// ─── Schedule sweep ──────────────────────────────────────────────────
const SCHEDULES = []
for (const t of [0.00, 0.10, 0.20, 0.30, 0.40]) {
  for (const m of [0.00, 0.05, 0.10]) {
    SCHEDULES.push({ thin: t, mid: m, stable: 0.00, label: `T${t.toFixed(2)}_M${m.toFixed(2)}` })
  }
}
const BASELINE_LABEL = 'T0.00_M0.00'   // sanity sentinel

// ─── Strike buckets for the bucketed report ──────────────────────────
function strikeBucket(strike) {
  if (strike <= 4) return '3-4'
  if (strike <= 6) return '5-6'
  if (strike <= 8) return '7-8'
  return '9+'
}

// ─── Statistic helpers ───────────────────────────────────────────────
function brier(p, actual) { return Math.pow(p - actual, 2) }
function logloss(p, actual) {
  const pc = Math.max(KELLY_LN_CLIP, Math.min(1 - KELLY_LN_CLIP, p))
  return -(actual * Math.log(pc) + (1 - actual) * Math.log(1 - pc))
}
function median(arr) {
  if (!arr.length) return null
  const s = [...arr].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
function p95Abs(arr) {
  if (!arr.length) return null
  const s = arr.map(Math.abs).sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]
}

// ─── Load bets + joins ───────────────────────────────────────────────
console.log(`[dkBlendBacktest] querying ${SINCE} → ${UNTIL}`)

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
    dp.model_input_json,
    dk.dk_line,
    dk.over_price   AS dk_over_price,
    dk.book         AS dk_book
  FROM ks_bets b
  LEFT JOIN decision_pipeline dp
    ON dp.bet_date = b.bet_date AND dp.pitcher_id = b.pitcher_id
  LEFT JOIN dk_k_props dk
    ON dk.prop_date = b.bet_date
   AND lower(dk.pitcher_name) = lower(b.pitcher_name)
  WHERE b.result IN ('win','loss','void')
    AND b.actual_ks IS NOT NULL
    AND b.live_bet = 0
    AND b.bet_date BETWEEN ? AND ?
  ORDER BY b.bet_date ASC, b.id ASC
`, [SINCE, UNTIL])
console.log(`[dkBlendBacktest] loaded ${bets.length} settled placed pre-game bets`)

// Pre-fetch today's pitcher_statcast for nbR + thinness inputs
const pidSet = [...new Set(bets.map(b => String(b.pitcher_id)))]
const savantRows = pidSet.length
  ? await db.all(
      `SELECT player_id, k_pct, ip, pa, fb_velo, gb_pct, bb_pct,
              k_pct_vs_l, k_pct_vs_r, swstr_pct, nb_r, manager_leash_factor
       FROM pitcher_statcast WHERE player_id IN (${pidSet.map(() => '?').join(',')})`,
      pidSet,
    )
  : []
const savantMap = new Map(savantRows.map(r => [String(r.player_id), r]))

// ─── Bucketed accumulator ────────────────────────────────────────────
function freshBucket() {
  return {
    n: 0,
    flipped_to_skip: 0,
    same_decision: 0,
    sum_brier_orig: 0,
    sum_brier_blend: 0,
    sum_logloss_orig: 0,
    sum_logloss_blend: 0,
    sum_pnl_orig: 0,
    sum_pnl_blend_fixed: 0,
    sum_pnl_blend_kelly: 0,
    lambda_shifts: [],
    bf_deltas: [],
    by_thinness: {},
    by_strike_bucket: {},
    by_side: {},
    by_bf_tier: {},
    by_account: {},
    calibration: makeCalBuckets(),
  }
}
function makeCalBuckets() {
  // 10 buckets [0,0.1),[0.1,0.2),...,[0.9,1]
  const out = []
  for (let i = 0; i < 10; i++) {
    out.push({
      lo: i / 10, hi: (i + 1) / 10,
      n: 0,
      sum_actual: 0,
      sum_predicted_orig: 0,
      sum_predicted_blend: 0,
      sum_brier_orig: 0,
      sum_brier_blend: 0,
    })
  }
  return out
}
function calBucketIdx(p) {
  if (p < 0) return 0
  if (p >= 1) return 9
  return Math.min(9, Math.floor(p * 10))
}
function bumpSubBucket(map, key) {
  if (!map[key]) map[key] = freshBucket()
  return map[key]
}

// ─── Main per-row loop ───────────────────────────────────────────────
const buckets = {} // key: schedule.label → bucket
for (const sch of SCHEDULES) buckets[sch.label] = freshBucket()

const skipped = { no_dk: 0, no_dp: 0, parse_fail: 0, no_savant_pid: 0 }
const spreadCov = {
  with_spread:           0,
  without_spread:        0,
  spread_adjusted_used:  0,   // spread/2 + 0.04 actually exceeded the 0.12 floor
  floor_used:            0,   // floor (0.12) bound the threshold
}
let processed = 0

for (const row of bets) {
  if (!row.lambda_calc_json || !row.model_input_json) { skipped.no_dp++; continue }
  if (row.dk_line == null || row.dk_over_price == null) { skipped.no_dk++; continue }

  let lc, mi
  try { lc = JSON.parse(row.lambda_calc_json); mi = JSON.parse(row.model_input_json) }
  catch { skipped.parse_fail++; continue }

  const lambdaBaseLogged  = Number(lc.lambda_base)
  const lambdaFinalLogged = Number(lc.lambda_final)
  const pK_blended        = Number(lc.p_k_blended)
  const expectedBF        = Number(mi.expected_bf)
  const bfSource          = mi.bf_source ?? null
  const nStarts           = mi.n_starts != null ? Number(mi.n_starts) : null
  if (![lambdaBaseLogged, lambdaFinalLogged, pK_blended, expectedBF].every(Number.isFinite)) continue

  const multipliers = {
    split_adj:    Number(lc.split_adj    ?? 1),
    opp_adj:      Number(lc.opp_adj      ?? 1),
    park_factor:  Number(lc.park_factor  ?? 1),
    weather_mult: Number(lc.weather_mult ?? 1),
    ump_factor:   Number(lc.ump_factor   ?? 1),
  }
  const mulProduct = multipliers.split_adj * multipliers.opp_adj
                   * multipliers.park_factor * multipliers.weather_mult * multipliers.ump_factor

  // Today's savant for r + classify inputs (with uncertainty caveat)
  const savant = savantMap.get(String(row.pitcher_id)) ?? null
  const r = archetypeR(savant)
  const syntheticInner = { bfSource, nStarts, expectedBF, pK_blended }
  const klass = classifyThinness(syntheticInner, savant)

  const todayIp = savant?.ip
  const tier = bfSourceTier(bfSource)
  const thinnessUncertain =
    (typeof todayIp === 'number' && todayIp >= 30) &&
    (
      (typeof nStarts === 'number' && nStarts < 3) ||
      tier === 'weak'
    )

  // Original side-aware probability + Brier/logloss
  const actualKs        = Number(row.actual_ks)
  const yes_hits        = actualKs >= row.strike ? 1 : 0
  const actual_outcome  = row.side === 'YES' ? yes_hits : (1 - yes_hits)

  // CRITICAL: probOrigSide and probBlendSide must use the SAME r so the
  // delta isolates the blend's marginal effect from pitcher_statcast
  // drift (Bite 6.3.B). We recompute orig from lambdaFinalLogged using
  // today's r — this means probOrig diverges from logged ks_bets.model_prob,
  // but ΔBrier and ΔROI cleanly measure the blend's effect.
  // ks_bets.model_prob is preserved separately if needed for reference.
  const pYesOrig    = Math.max(0, 1 - nbCDF(lambdaFinalLogged, r, row.strike - 1))
  const probOrigSide = row.side === 'YES' ? pYesOrig : 1 - pYesOrig
  const marketSide = Number(row.market_mid) / 100  // market_mid is in cents on the SAME side
  const edgeOrig   = probOrigSide - marketSide
  const spread     = Number.isFinite(Number(row.spread)) ? Number(row.spread) / 100 : null
  // Threshold: max(SIDE_MIN_EDGE, spread/2 + MIN_EDGE_FLOOR) when spread present,
  // else SIDE_MIN_EDGE. Track which path was used for coverage reporting.
  const effThreshold = spread != null
    ? Math.max(SIDE_MIN_EDGE, spread / 2 + MIN_EDGE_FLOOR)
    : SIDE_MIN_EDGE
  const usedSpreadAdjustment = spread != null
                                && (spread / 2 + MIN_EDGE_FLOOR) > SIDE_MIN_EDGE
  if (spread != null) spreadCov.with_spread++; else spreadCov.without_spread++
  if (usedSpreadAdjustment) spreadCov.spread_adjusted_used++; else spreadCov.floor_used++

  const fireGate = (edge) => {
    if (!Number.isFinite(edge)) return false
    return edge >= effThreshold
  }
  const firedOrig  = fireGate(edgeOrig)  // sanity: should usually be true since we placed it

  for (const sch of SCHEDULES) {
    const blend = blendBF({
      expected_bf_ours: expectedBF,
      pK_ours:          pK_blended,
      dk_line:          Number(row.dk_line),
      over_price:       Number(row.dk_over_price),
      r,
      klass,
      schedule:         { thin: sch.thin, mid: sch.mid, stable: sch.stable },
      bf_cap_K:         DEFAULT_BF_CAP_K,
    })

    const lambdaFinalBlend = blend.applied
      ? blend.lambda_base_blended * mulProduct
      : lambdaFinalLogged
    const pYesBlend = Math.max(0, 1 - nbCDF(lambdaFinalBlend, r, row.strike - 1))
    const probBlendSide = row.side === 'YES' ? pYesBlend : 1 - pYesBlend
    const edgeBlend     = probBlendSide - marketSide
    const firedBlend    = fireGate(edgeBlend)

    const pnlOrig = Number(row.pnl) || 0
    // Placed-bets-only contract: production's placement is canonical.
    // Only count a counterfactual flip when the BLEND specifically
    // changes our reconstructed gate from fire→skip RELATIVE to original.
    // If our gate says "wouldn't fire" both before and after blend,
    // that's a gate-reconstruction disagreement (betting_rules overrides
    // we don't replicate), not a blend signal — pnl stays as production.
    const blendChangedDecision = firedOrig && !firedBlend
    let pnlBlendFixed, pnlBlendKelly
    if (blendChangedDecision) {
      pnlBlendFixed = 0
      pnlBlendKelly = 0
    } else {
      pnlBlendFixed = pnlOrig
      const ratio = edgeOrig > 0 && Number.isFinite(edgeOrig)
        ? Math.max(0, edgeBlend / edgeOrig)
        : 1
      pnlBlendKelly = pnlOrig * ratio
    }

    const buc = buckets[sch.label]
    buc.n++
    if (blendChangedDecision) buc.flipped_to_skip++
    else                       buc.same_decision++
    buc.sum_brier_orig    += brier(probOrigSide, actual_outcome)
    buc.sum_brier_blend   += brier(probBlendSide, actual_outcome)
    buc.sum_logloss_orig  += logloss(probOrigSide, actual_outcome)
    buc.sum_logloss_blend += logloss(probBlendSide, actual_outcome)
    buc.sum_pnl_orig      += pnlOrig
    buc.sum_pnl_blend_fixed += pnlBlendFixed
    buc.sum_pnl_blend_kelly += pnlBlendKelly
    buc.lambda_shifts.push(lambdaFinalBlend - lambdaFinalLogged)
    buc.bf_deltas.push(blend.bf_delta ?? 0)

    // Sub-buckets
    const subFor = (key, k) => {
      const m = buc[key]
      if (!m[k]) m[k] = freshBucket()
      const sb = m[k]
      sb.n++
      if (firedBlend === firedOrig) sb.same_decision++
      else if (!firedBlend && firedOrig) sb.flipped_to_skip++
      sb.sum_brier_orig    += brier(probOrigSide, actual_outcome)
      sb.sum_brier_blend   += brier(probBlendSide, actual_outcome)
      sb.sum_logloss_orig  += logloss(probOrigSide, actual_outcome)
      sb.sum_logloss_blend += logloss(probBlendSide, actual_outcome)
      sb.sum_pnl_orig      += pnlOrig
      sb.sum_pnl_blend_fixed += pnlBlendFixed
      sb.sum_pnl_blend_kelly += pnlBlendKelly
      sb.lambda_shifts.push(lambdaFinalBlend - lambdaFinalLogged)
      sb.bf_deltas.push(blend.bf_delta ?? 0)
      return sb
    }
    subFor('by_thinness', thinnessUncertain ? `${klass}_uncertain` : klass)
    subFor('by_strike_bucket', strikeBucket(row.strike))
    subFor('by_side', row.side)
    subFor('by_bf_tier', tier)
    subFor('by_account', String(row.user_id ?? 'unknown'))

    // Calibration table — bucket by blended probability
    const cb = buc.calibration[calBucketIdx(probBlendSide)]
    cb.n++
    cb.sum_actual          += actual_outcome
    cb.sum_predicted_orig  += probOrigSide
    cb.sum_predicted_blend += probBlendSide
    cb.sum_brier_orig      += brier(probOrigSide, actual_outcome)
    cb.sum_brier_blend     += brier(probBlendSide, actual_outcome)
  }
  processed++
}

console.log(`[dkBlendBacktest] processed ${processed} bets across ${SCHEDULES.length} schedules`)
console.log(`[dkBlendBacktest] skipped: no_dp=${skipped.no_dp} no_dk=${skipped.no_dk} parse_fail=${skipped.parse_fail}`)

// ─── HARD SANITY: baseline (T=0, M=0, S=0) must be identity ──────────
// If the baseline produces ANY deltas, the harness is measuring drift,
// not blend effect — fail loudly before writing a misleading report.
{
  const base = buckets[BASELINE_LABEL]
  const TOL_F = 1e-9
  const TOL_M = 1e-6
  const baseBrierDelta = base.sum_brier_blend - base.sum_brier_orig
  const baseLLDelta    = base.sum_logloss_blend - base.sum_logloss_orig
  const baseROIFixDel  = base.sum_pnl_blend_fixed - base.sum_pnl_orig
  const baseROIKelDel  = base.sum_pnl_blend_kelly - base.sum_pnl_orig
  const ok =
    Math.abs(baseBrierDelta) <= TOL_F &&
    Math.abs(baseLLDelta)    <= TOL_F &&
    Math.abs(baseROIFixDel)  <= TOL_M &&
    Math.abs(baseROIKelDel)  <= TOL_M &&
    base.flipped_to_skip === 0
  if (!ok) {
    console.error(`\n❌ HARD SANITY FAIL: baseline ${BASELINE_LABEL} did not produce identity.`)
    console.error(`   ΔBrier=${baseBrierDelta}  ΔLogLoss=${baseLLDelta}`)
    console.error(`   ΔROI_fix=${baseROIFixDel}  ΔROI_kelly=${baseROIKelDel}`)
    console.error(`   flipped_to_skip=${base.flipped_to_skip}`)
    console.error(`   The harness is measuring drift, NOT the DK blend's marginal effect.`)
    console.error(`   Aborting before writing a misleading report.`)
    await db.close()
    process.exit(1)
  }
  console.log(`✓ baseline ${BASELINE_LABEL} sanity passed (zero deltas, zero flips)`)
}

// ─── Render ──────────────────────────────────────────────────────────
function fmt(n, d = 4) { return Number.isFinite(n) ? n.toFixed(d) : '—' }
function summaryRow(label, b) {
  const avgBrierO = b.n ? b.sum_brier_orig / b.n : NaN
  const avgBrierB = b.n ? b.sum_brier_blend / b.n : NaN
  const avgLLO    = b.n ? b.sum_logloss_orig / b.n : NaN
  const avgLLB    = b.n ? b.sum_logloss_blend / b.n : NaN
  const dRoiFix   = b.sum_pnl_blend_fixed - b.sum_pnl_orig
  const dRoiKel   = b.sum_pnl_blend_kelly - b.sum_pnl_orig
  return `| ${label} | ${b.n} | ${b.flipped_to_skip} | ${fmt(avgBrierB - avgBrierO)} | ${fmt(avgLLB - avgLLO)} | ${fmt(b.sum_pnl_orig, 2)} | ${fmt(b.sum_pnl_blend_fixed, 2)} | ${fmt(dRoiFix, 2)} | ${fmt(b.sum_pnl_blend_kelly, 2)} | ${fmt(dRoiKel, 2)} | ${fmt(median(b.lambda_shifts), 3)} | ${fmt(p95Abs(b.lambda_shifts), 3)} |`
}

const lines = []
lines.push(`# DK Blend Backtest — ${today}`)
lines.push(``)
lines.push(`**STATUS:** PRELIMINARY — DK overlap only starts 2026-04-24; THIN sample may be insufficient.`)
lines.push(``)
lines.push(`## Run config`)
lines.push(``)
lines.push(`- Window:                 ${SINCE} → ${UNTIL}`)
lines.push(`- Settled placed pregame bets loaded: ${bets.length}`)
lines.push(`- Replayable (DK match + JSONs):       ${processed}`)
lines.push(`- Skipped:                 no_dp=${skipped.no_dp}, no_dk=${skipped.no_dk}, parse_fail=${skipped.parse_fail}`)
lines.push(``)
lines.push(`### Backtest limitation: dynamic betting_rules table values are not time-traveled in v1.`)
lines.push(`This replay uses current static production thresholds from strikeoutEdge.js:`)
lines.push(`YES_MIN_EDGE=0.12, NO_MIN_EDGE=0.12, MIN_EDGE_FLOOR=0.04, plus spread/2 when spread is available.`)
lines.push(``)
lines.push(`**Decision-flip gate per row:**`)
lines.push(`-   spread present  → threshold = max(0.12, spread/2 + 0.04)`)
lines.push(`-   spread missing  → threshold = 0.12  (and row is marked spread_unavailable)`)
lines.push(``)
lines.push(`**Spread coverage in this run:**`)
lines.push(`-   spread_available_rows:           ${spreadCov.with_spread}`)
lines.push(`-   spread_unavailable_rows:         ${spreadCov.without_spread}`)
lines.push(`-   spread_adjusted_threshold_used: ${spreadCov.spread_adjusted_used}  (spread/2+0.04 > 0.12)`)
lines.push(`-   floor_threshold_used:            ${spreadCov.floor_used}            (0.12 binding)`)
lines.push(``)
lines.push(`**Probability reconstruction:** orig and blend probs are BOTH recomputed from`)
lines.push(`logged lambda_final using TODAY's archetypeR(savant). This isolates the blend's`)
lines.push(`marginal effect from pitcher_statcast drift (Bite 6.3.B). Logged ks_bets.model_prob`)
lines.push(`may differ from probOrig in this report; that's expected.`)
lines.push(``)
lines.push(`**Placed-bet replay treats production placement as canonical.**`)
lines.push(`The reconstructed edge gate is used only to detect fire→skip changes caused by`)
lines.push(`DK blending. If both baseline and blended gates disagree with production`)
lines.push(`(common when betting_rules dynamic overrides differ from our static gate),`)
lines.push(`the row is counted as unchanged, not as a skipped bet. Hard baseline assertion`)
lines.push(`enforces this: T0.00_M0.00 must produce zero deltas or the script aborts.`)
lines.push(``)
lines.push(`- DK over_price:           includes vig (under_price not stored)`)
lines.push(`- pitcher_statcast:        TODAY's snapshot (drift caveat)`)
lines.push(`- Thinness uncertainty flagged when today.savant.ip ≥ 30 AND (n_starts<3 OR bfSource weak)`)
lines.push(`- Schedules swept:         ${SCHEDULES.length} (THIN × {0,0.10,0.20,0.30,0.40} × MID × {0,0.05,0.10})`)
lines.push(`- Production candidate:    THIN=0.20 MID=0.05 STABLE=0.00`)
lines.push(``)

// Schedule summary table
lines.push(`## Per-schedule summary`)
lines.push(``)
lines.push(`| schedule | n | flipped→skip | ΔBrier | ΔLogLoss | ΣPnL_orig | ΣPnL_fix | ΔROI_fix | ΣPnL_kelly | ΔROI_kelly | medianΔλ | p95\\|Δλ\\| |`)
lines.push(`|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|`)
for (const sch of SCHEDULES) {
  const b = buckets[sch.label]
  const star = sch.label === 'T0.20_M0.05' ? ' ★' : sch.label === BASELINE_LABEL ? ' (baseline)' : ''
  lines.push(summaryRow(sch.label + star, b))
}
lines.push(``)

// Per-bucket detail for production candidate
function buildBucketSection(scheduleLabel, header) {
  const b = buckets[scheduleLabel]
  if (!b) return
  lines.push(`## ${header}`)
  lines.push(``)

  function dumpSub(title, m) {
    const keys = Object.keys(m).sort()
    if (!keys.length) return
    lines.push(`**${title}**`)
    lines.push(``)
    lines.push(`| key | n | flipped→skip | ΔBrier | ΔLogLoss | ΣPnL_orig | ΣPnL_fix | ΔROI_fix | medianΔλ |`)
    lines.push(`|---|---:|---:|---:|---:|---:|---:|---:|---:|`)
    for (const k of keys) {
      const sb = m[k]
      const avgBrierO = sb.n ? sb.sum_brier_orig / sb.n : NaN
      const avgBrierB = sb.n ? sb.sum_brier_blend / sb.n : NaN
      const avgLLO    = sb.n ? sb.sum_logloss_orig / sb.n : NaN
      const avgLLB    = sb.n ? sb.sum_logloss_blend / sb.n : NaN
      const dRoi      = sb.sum_pnl_blend_fixed - sb.sum_pnl_orig
      lines.push(`| ${k} | ${sb.n} | ${sb.flipped_to_skip} | ${fmt(avgBrierB - avgBrierO)} | ${fmt(avgLLB - avgLLO)} | ${fmt(sb.sum_pnl_orig, 2)} | ${fmt(sb.sum_pnl_blend_fixed, 2)} | ${fmt(dRoi, 2)} | ${fmt(median(sb.lambda_shifts), 3)} |`)
    }
    lines.push(``)
  }
  dumpSub('by thinness class (suffix _uncertain = today\'s savant likely diverges from bet-date)', b.by_thinness)
  dumpSub('by side', b.by_side)
  dumpSub('by strike bucket', b.by_strike_bucket)
  dumpSub('by bfSource tier', b.by_bf_tier)
  dumpSub('by account (user_id)', b.by_account)

  // Calibration table
  lines.push(`**probability calibration (blended-prob bucket)**`)
  lines.push(``)
  lines.push(`| bucket | n | actual hit rate | avg P_orig | avg P_blend | Brier_orig | Brier_blend |`)
  lines.push(`|---|---:|---:|---:|---:|---:|---:|`)
  for (const cb of b.calibration) {
    if (!cb.n) continue
    lines.push(`| [${cb.lo.toFixed(1)}, ${cb.hi.toFixed(1)}) | ${cb.n} | ${fmt(cb.sum_actual / cb.n)} | ${fmt(cb.sum_predicted_orig / cb.n)} | ${fmt(cb.sum_predicted_blend / cb.n)} | ${fmt(cb.sum_brier_orig / cb.n)} | ${fmt(cb.sum_brier_blend / cb.n)} |`)
  }
  lines.push(``)
}
buildBucketSection('T0.20_M0.05', `Detail for production candidate (THIN=0.20, MID=0.05, STABLE=0)`)

// Vig sanity
const allBfDeltas = buckets['T0.20_M0.05'].bf_deltas
const allLamShifts = buckets['T0.20_M0.05'].lambda_shifts
lines.push(`## Vig + drift sanity (T=0.20 M=0.05)`)
lines.push(``)
lines.push(`- median bf_delta:    ${fmt(median(allBfDeltas), 3)}    (DK over_price has vig → expect slightly positive)`)
lines.push(`- p95 |bf_delta|:     ${fmt(p95Abs(allBfDeltas), 3)}`)
lines.push(`- median Δλ:          ${fmt(median(allLamShifts), 3)}`)
lines.push(`- p95 |Δλ|:           ${fmt(p95Abs(allLamShifts), 3)}`)
lines.push(``)

// Bar check (illustrative)
lines.push(`## Bar check — illustrative thresholds (you set the real ones in 6.4)`)
lines.push(``)
const cand = buckets['T0.20_M0.05']
const thinByName = cand.by_thinness['thin'] ?? freshBucket()
const thinUncByName = cand.by_thinness['thin_uncertain'] ?? freshBucket()
const thinTotal = freshBucket()
thinTotal.n = thinByName.n + thinUncByName.n
thinTotal.sum_brier_orig    = thinByName.sum_brier_orig + thinUncByName.sum_brier_orig
thinTotal.sum_brier_blend   = thinByName.sum_brier_blend + thinUncByName.sum_brier_blend
thinTotal.sum_logloss_orig  = thinByName.sum_logloss_orig + thinUncByName.sum_logloss_orig
thinTotal.sum_logloss_blend = thinByName.sum_logloss_blend + thinUncByName.sum_logloss_blend
thinTotal.sum_pnl_orig         = thinByName.sum_pnl_orig + thinUncByName.sum_pnl_orig
thinTotal.sum_pnl_blend_fixed  = thinByName.sum_pnl_blend_fixed + thinUncByName.sum_pnl_blend_fixed
thinTotal.lambda_shifts = [...thinByName.lambda_shifts, ...thinUncByName.lambda_shifts]

const bar = []
const thinDelBrier = thinTotal.n ? (thinTotal.sum_brier_blend - thinTotal.sum_brier_orig) / thinTotal.n : NaN
const thinDelLL    = thinTotal.n ? (thinTotal.sum_logloss_blend - thinTotal.sum_logloss_orig) / thinTotal.n : NaN
const thinDelROI   = thinTotal.sum_pnl_blend_fixed - thinTotal.sum_pnl_orig
bar.push([`THIN n ≥ 30`, thinTotal.n >= 30 ? 'PASS' : `WARN (${thinTotal.n})`])
bar.push([`THIN ΔBrier ≤ −0.005`, Number.isFinite(thinDelBrier) && thinDelBrier <= -0.005 ? 'PASS' : 'FAIL'])
bar.push([`THIN ΔLogLoss ≤ −0.02`, Number.isFinite(thinDelLL)    && thinDelLL    <= -0.02 ? 'PASS' : 'FAIL'])
bar.push([`THIN ΔROI_fix > 0`, Number.isFinite(thinDelROI) && thinDelROI > 0 ? 'PASS' : 'FAIL'])
bar.push([`median |Δλ| (overall) ≤ 0.5 K`, Math.abs(median(cand.lambda_shifts) ?? 0) <= 0.5 ? 'PASS' : 'FAIL'])
bar.push([`p95 |Δλ| (overall) ≤ 1.5 K`, (p95Abs(cand.lambda_shifts) ?? 0) <= 1.5 ? 'PASS' : 'FAIL'])
lines.push(`| check | result |`)
lines.push(`|---|---|`)
for (const [label, val] of bar) lines.push(`| ${label} | ${val} |`)
lines.push(``)
lines.push(`> **Reminder:** small sample. Do not use this preliminary run alone to enable/disable.`)
lines.push(``)

// Write Markdown
const mdPath = path.resolve(`${OUTBASE}.md`)
writeFileSync(mdPath, lines.join('\n'), 'utf-8')

// CSV side-car: schedule × thinness rollups
const csvLines = ['schedule,thinness_class,n,flipped_to_skip,delta_brier,delta_logloss,sum_pnl_orig,sum_pnl_blend_fixed,delta_roi_fixed,sum_pnl_blend_kelly,delta_roi_kelly,median_lambda_shift']
for (const sch of SCHEDULES) {
  const b = buckets[sch.label]
  for (const klass of Object.keys(b.by_thinness).sort()) {
    const sb = b.by_thinness[klass]
    const dBrier = sb.n ? (sb.sum_brier_blend - sb.sum_brier_orig) / sb.n : 0
    const dLL    = sb.n ? (sb.sum_logloss_blend - sb.sum_logloss_orig) / sb.n : 0
    const dRoiF  = sb.sum_pnl_blend_fixed - sb.sum_pnl_orig
    const dRoiK  = sb.sum_pnl_blend_kelly - sb.sum_pnl_orig
    const medSh  = median(sb.lambda_shifts) ?? 0
    csvLines.push(`${sch.label},${klass},${sb.n},${sb.flipped_to_skip},${dBrier.toFixed(6)},${dLL.toFixed(6)},${sb.sum_pnl_orig.toFixed(2)},${sb.sum_pnl_blend_fixed.toFixed(2)},${dRoiF.toFixed(2)},${sb.sum_pnl_blend_kelly.toFixed(2)},${dRoiK.toFixed(2)},${medSh.toFixed(4)}`)
  }
}
const csvPath = path.resolve(`${OUTBASE}.csv`)
writeFileSync(csvPath, csvLines.join('\n'), 'utf-8')

// Stdout summary
console.log('\n═══ STDOUT SUMMARY ═══')
console.log(`Markdown: ${mdPath}`)
console.log(`CSV:      ${csvPath}`)
console.log(`\n  schedule       n  flip→skip  ΔBrier   ΔLL     ΔROI_fix  ΔROI_kelly  med|Δλ|`)
for (const sch of SCHEDULES) {
  const b = buckets[sch.label]
  const dBrier = b.n ? (b.sum_brier_blend - b.sum_brier_orig) / b.n : 0
  const dLL    = b.n ? (b.sum_logloss_blend - b.sum_logloss_orig) / b.n : 0
  const dRoiF  = b.sum_pnl_blend_fixed - b.sum_pnl_orig
  const dRoiK  = b.sum_pnl_blend_kelly - b.sum_pnl_orig
  const medSh  = median(b.lambda_shifts) ?? 0
  const star = sch.label === 'T0.20_M0.05' ? ' ★' : sch.label === BASELINE_LABEL ? '  '   : '  '
  console.log(`  ${sch.label}${star}  ${String(b.n).padStart(4)}  ${String(b.flipped_to_skip).padStart(8)}  ${dBrier.toFixed(4).padStart(7)} ${dLL.toFixed(4).padStart(7)} ${dRoiF.toFixed(2).padStart(9)} ${dRoiK.toFixed(2).padStart(11)} ${medSh.toFixed(3).padStart(8)}`)
}

await db.close()
