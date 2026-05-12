// scripts/oracle/calibrationBacktest.js
//
// L1.5.2 — Calibration backtest harness. Pure analysis. No artifact write
// to active.json. Produces a Markdown + CSV report and a preview artifact.
//
// Locked design (SPEC.md §1.5):
//   - Source: ks_bets.model_prob (production's logged probability)
//   - Target: side-adjusted win/loss probability
//   - Train/test split: earliest 70% distinct bet_dates / latest 30%
//   - Stratification: strike_bucket × side (8 strata)
//   - Fallback: global if stratum n_train < 30
//   - Methods: hand-rolled PAV isotonic + Platt scaling on logit(raw_prob)
//   - OOD: clip to training endpoints
//   - Gate: fixed-size ROI; Brier; log-loss
//
// Usage:
//   node scripts/oracle/calibrationBacktest.js [--since YYYY-MM-DD] [--until YYYY-MM-DD]

import 'dotenv/config'
import { writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import * as db from '../../lib/db.js'
import { parseArgs } from '../../lib/cli-args.js'

const today    = new Date().toISOString().slice(0, 10)
const sixtyAgo = new Date(Date.now() - 60 * 86400_000).toISOString().slice(0, 10)
const opts = parseArgs({
  since:  { default: sixtyAgo },
  until:  { default: today },
  output: { default: null },
})
const SINCE = opts.since
const UNTIL = opts.until
const OUTBASE = opts.output ?? `oracle/calibration-backtest-${today}`

const SIDE_MIN_EDGE  = 0.12
const MIN_EDGE_FLOOR = 0.04
const STRATUM_MIN_N  = 30
const STRATUM_MIN_TEST_FOR_REGRESSION_GUARD = 10
const FLIP_BAR = {
  delta_brier:   -0.005,
  delta_logloss: -0.02,
  delta_roi:     0,
  test_n:        150,
  strata_with_own_curve_min: 4,
  per_stratum_brier_regression_max: 0.01,
}

console.log(`[calibrationBacktest] window ${SINCE} → ${UNTIL}`)

// ─── Pure helpers ─────────────────────────────────────────────────

function strikeBucket(s) {
  if (s <= 4) return '3-4'
  if (s <= 6) return '5-6'
  if (s <= 8) return '7-8'
  return '9+'
}
function stratumKey(side, strike) { return `${side}_${strikeBucket(strike)}` }
const STRATA_KEYS = []
for (const side of ['YES','NO']) for (const sb of ['3-4','5-6','7-8','9+']) STRATA_KEYS.push(`${side}_${sb}`)

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x))
const sigmoid = (x) => 1 / (1 + Math.exp(-x))
const logit = (p) => Math.log(p / (1 - p))
const safeLogit = (p) => logit(clamp(p, 1e-6, 1 - 1e-6))

function brierScore(predictions, labels) {
  if (predictions.length !== labels.length) throw new Error('len mismatch')
  let s = 0
  for (let i = 0; i < predictions.length; i++) s += (predictions[i] - labels[i]) ** 2
  return s / predictions.length
}
function logLoss(predictions, labels) {
  let s = 0
  for (let i = 0; i < predictions.length; i++) {
    const p = clamp(predictions[i], 1e-9, 1 - 1e-9)
    s += -(labels[i] * Math.log(p) + (1 - labels[i]) * Math.log(1 - p))
  }
  return s / predictions.length
}

// Expected / Maximum Calibration Error (ECE / MCE).
// Bucket predictions into 10 deciles; for each non-empty bucket compute
// |avg_predicted - actual_hit_rate|. Weighted average for ECE; max for MCE.
function calibrationErrors(predictions, labels, nBuckets = 10) {
  const buckets = []
  for (let i = 0; i < nBuckets; i++) buckets.push({ n: 0, sum_pred: 0, sum_lbl: 0 })
  for (let i = 0; i < predictions.length; i++) {
    const idx = Math.min(nBuckets - 1, Math.max(0, Math.floor(predictions[i] * nBuckets)))
    buckets[idx].n++
    buckets[idx].sum_pred += predictions[i]
    buckets[idx].sum_lbl  += labels[i]
  }
  const total = predictions.length
  let ece = 0, mce = 0
  for (const b of buckets) {
    if (!b.n) continue
    const avg_pred = b.sum_pred / b.n
    const actual = b.sum_lbl / b.n
    const err = Math.abs(avg_pred - actual)
    ece += (b.n / total) * err
    if (err > mce) mce = err
  }
  return { ece, mce }
}

// ─── Isotonic regression via Pool-Adjacent-Violators ──────────────
//
// Returns { segments: [{ raw_lo, raw_hi, calibrated }], train_min, train_max }.
// Query via isotonicQuery().
function fitIsotonic(rawProbs, labels) {
  if (rawProbs.length !== labels.length) throw new Error('len mismatch')
  if (rawProbs.length === 0) return { segments: [], train_min: NaN, train_max: NaN }
  // Sort by raw prob; break ties on label to make sort stable
  const idx = rawProbs.map((_, i) => i).sort((a, b) => rawProbs[a] - rawProbs[b])
  // Initial blocks: each (x, y) is its own block with weight 1
  const blocks = idx.map(i => ({ x_lo: rawProbs[i], x_hi: rawProbs[i], sum: labels[i], w: 1 }))
  // PAV: merge adjacent violators repeatedly
  let i = 0
  while (i < blocks.length - 1) {
    const a = blocks[i], b = blocks[i + 1]
    if (a.sum / a.w > b.sum / b.w) {
      // violation: merge
      const merged = { x_lo: a.x_lo, x_hi: b.x_hi, sum: a.sum + b.sum, w: a.w + b.w }
      blocks.splice(i, 2, merged)
      if (i > 0) i--                // back up to re-check with previous
    } else {
      i++
    }
  }
  const segments = blocks.map(b => ({
    raw_lo: b.x_lo, raw_hi: b.x_hi, calibrated: b.sum / b.w,
  }))
  return {
    segments,
    train_min: rawProbs.reduce((a, b) => Math.min(a, b), Infinity),
    train_max: rawProbs.reduce((a, b) => Math.max(a, b), -Infinity),
  }
}
function isotonicQuery(model, rawProb) {
  if (!model.segments.length) return { calibrated: rawProb, ood_clipped: false }
  // OOD clip
  let x = rawProb
  let ood = false
  if (rawProb < model.train_min) { x = model.train_min; ood = true }
  if (rawProb > model.train_max) { x = model.train_max; ood = true }
  // Find segment containing x (binary search by raw_lo)
  let lo = 0, hi = model.segments.length - 1
  while (lo < hi) {
    const m = (lo + hi + 1) >> 1
    if (model.segments[m].raw_lo <= x) lo = m
    else hi = m - 1
  }
  return { calibrated: model.segments[lo].calibrated, ood_clipped: ood }
}

// ─── Platt scaling: y ~ sigmoid(a * logit(raw) + b) ──────────────
// Newton-Raphson on log-likelihood. 2 parameters (a, b).
function fitPlatt(rawProbs, labels, maxIter = 50, tol = 1e-7) {
  if (rawProbs.length === 0) return { a: 1, b: 0, train_min: NaN, train_max: NaN }
  const n = rawProbs.length
  const xs = rawProbs.map(safeLogit)
  let a = 1.0, b = 0.0
  for (let iter = 0; iter < maxIter; iter++) {
    let g_a = 0, g_b = 0, h_aa = 0, h_ab = 0, h_bb = 0
    for (let i = 0; i < n; i++) {
      const z = a * xs[i] + b
      const p = sigmoid(z)
      const r = labels[i] - p
      g_a += r * xs[i]
      g_b += r
      const w = p * (1 - p)
      h_aa -= w * xs[i] * xs[i]
      h_ab -= w * xs[i]
      h_bb -= w
    }
    // Newton step: [a,b] -= H^-1 * grad. Note: Hessian is negative-def,
    // gradient is of log-likelihood we want to maximize → descend in grad space.
    const det = h_aa * h_bb - h_ab * h_ab
    if (Math.abs(det) < 1e-18) break
    const da = (h_bb * g_a - h_ab * g_b) / det
    const dbn = (-h_ab * g_a + h_aa * g_b) / det
    a -= da
    b -= dbn
    if (Math.abs(da) + Math.abs(dbn) < tol) break
  }
  return {
    a, b,
    train_min: rawProbs.reduce((x, y) => Math.min(x, y), Infinity),
    train_max: rawProbs.reduce((x, y) => Math.max(x, y), -Infinity),
  }
}
function plattQuery(model, rawProb) {
  let x = rawProb
  let ood = false
  if (rawProb < model.train_min) { x = model.train_min; ood = true }
  if (rawProb > model.train_max) { x = model.train_max; ood = true }
  return { calibrated: sigmoid(model.a * safeLogit(x) + model.b), ood_clipped: ood }
}

// ─── Load data ────────────────────────────────────────────────────
console.log('[calibrationBacktest] loading bets…')
const bets = await db.all(`
  SELECT
    id AS bet_id, bet_date, pitcher_id, pitcher_name, strike, side, result,
    actual_ks, pnl, bet_size, fill_price, market_mid, spread, model_prob, user_id
  FROM ks_bets
  WHERE result IN ('win','loss','void')
    AND actual_ks IS NOT NULL
    AND live_bet = 0
    AND bet_date BETWEEN ? AND ?
    AND model_prob IS NOT NULL
    AND market_mid IS NOT NULL
  ORDER BY bet_date ASC, id ASC
`, [SINCE, UNTIL])
console.log(`[calibrationBacktest] loaded ${bets.length} bets`)

// Filter to result IN (win, loss) for training (voids carry no calibration signal)
// but keep voids in test set ROI replay (their pnl is 0; no impact on the metric)
const trainable = bets.filter(b => b.result === 'win' || b.result === 'loss')
console.log(`[calibrationBacktest] trainable rows (win/loss): ${trainable.length}`)

// Time-split by distinct bet_dates: earliest 70% of dates → train, latest 30% → test.
const distinctDates = [...new Set(bets.map(b => b.bet_date))].sort()
const cutoffIdx = Math.max(1, Math.floor(distinctDates.length * 0.70))
const cutoffDate = distinctDates[cutoffIdx - 1]
const trainDates = new Set(distinctDates.slice(0, cutoffIdx))
const testDates  = new Set(distinctDates.slice(cutoffIdx))
console.log(`[calibrationBacktest] split cutoff: ${cutoffDate}; train_dates=${trainDates.size}; test_dates=${testDates.size}`)

const trainBets = trainable.filter(b => trainDates.has(b.bet_date))
const testBets  = bets.filter(b => testDates.has(b.bet_date))
console.log(`[calibrationBacktest] train bets (win/loss only): ${trainBets.length}`)
console.log(`[calibrationBacktest] test bets (all settled): ${testBets.length}`)

// ─── Fit calibrators ──────────────────────────────────────────────
console.log('[calibrationBacktest] fitting calibrators…')

const trainAll = {
  raw:    trainBets.map(b => Number(b.model_prob)),
  label:  trainBets.map(b => b.result === 'win' ? 1 : 0),
}
const isoGlobal = fitIsotonic(trainAll.raw, trainAll.label)
const plattGlobal = fitPlatt(trainAll.raw, trainAll.label)

const isoStrata = {}
const plattStrata = {}
const strataNTrain = {}
for (const key of STRATA_KEYS) {
  const sub = trainBets.filter(b => stratumKey(b.side, b.strike) === key)
  strataNTrain[key] = sub.length
  if (sub.length >= STRATUM_MIN_N) {
    isoStrata[key]   = fitIsotonic(sub.map(b => Number(b.model_prob)), sub.map(b => b.result === 'win' ? 1 : 0))
    plattStrata[key] = fitPlatt(sub.map(b => Number(b.model_prob)), sub.map(b => b.result === 'win' ? 1 : 0))
  } else {
    isoStrata[key] = null
    plattStrata[key] = null
  }
}

// ─── Apply to test set ────────────────────────────────────────────
console.log('[calibrationBacktest] applying to test set…')

function applyIsotonic(rawProb, key) {
  const m = isoStrata[key] ?? isoGlobal
  return isotonicQuery(m, rawProb)
}
function applyPlatt(rawProb, key) {
  const m = plattStrata[key] ?? plattGlobal
  return plattQuery(m, rawProb)
}

const testRows = testBets.map(b => {
  const raw = Number(b.model_prob)
  const key = stratumKey(b.side, b.strike)
  const isoOut = applyIsotonic(raw, key)
  const plattOut = applyPlatt(raw, key)
  const isStrictBet = b.result === 'win' || b.result === 'loss'
  const label = b.result === 'win' ? 1 : (b.result === 'loss' ? 0 : null)
  const market_frac = Number(b.market_mid) / 100
  const spread_frac = Number.isFinite(Number(b.spread)) ? Number(b.spread) / 100 : null
  const threshold = (Number.isFinite(spread_frac) && spread_frac > 0)
    ? Math.max(SIDE_MIN_EDGE, spread_frac / 2 + MIN_EDGE_FLOOR)
    : SIDE_MIN_EDGE
  const edge_raw   = raw - market_frac
  const edge_iso   = isoOut.calibrated - market_frac
  const edge_platt = plattOut.calibrated - market_frac
  const fire_raw   = edge_raw   >= threshold
  const fire_iso   = edge_iso   >= threshold
  const fire_platt = edge_platt >= threshold
  const pnl = Number(b.pnl) || 0
  return {
    bet_id: b.bet_id, bet_date: b.bet_date, pitcher_name: b.pitcher_name,
    strike: b.strike, side: b.side, stratum: key,
    result: b.result, label, isStrictBet,
    raw, calibrated_iso: isoOut.calibrated, calibrated_platt: plattOut.calibrated,
    iso_used_global: !isoStrata[key],
    platt_used_global: !plattStrata[key],
    iso_ood: isoOut.ood_clipped, platt_ood: plattOut.ood_clipped,
    market_frac, spread_frac, threshold,
    edge_raw, edge_iso, edge_platt,
    fire_raw, fire_iso, fire_platt,
    pnl_raw_replay:   fire_raw   ? pnl : 0,
    pnl_iso_replay:   fire_iso   ? pnl : 0,
    pnl_platt_replay: fire_platt ? pnl : 0,
    pnl_production:   pnl,
    bet_size: Number(b.bet_size) || 0,
  }
})

const testStrict = testRows.filter(r => r.isStrictBet)

// ─── Metrics ──────────────────────────────────────────────────────

const labels = testStrict.map(r => r.label)
const rawPreds = testStrict.map(r => r.raw)
const isoPreds = testStrict.map(r => r.calibrated_iso)
const plattPreds = testStrict.map(r => r.calibrated_platt)

const brier_test_raw   = brierScore(rawPreds,   labels)
const brier_test_iso   = brierScore(isoPreds,   labels)
const brier_test_platt = brierScore(plattPreds, labels)
const ll_test_raw   = logLoss(rawPreds,   labels)
const ll_test_iso   = logLoss(isoPreds,   labels)
const ll_test_platt = logLoss(plattPreds, labels)
const ece_raw   = calibrationErrors(rawPreds,   labels)
const ece_iso   = calibrationErrors(isoPreds,   labels)
const ece_platt = calibrationErrors(plattPreds, labels)

const sumPnl_production = testRows.reduce((s, r) => s + r.pnl_production, 0)
const sumPnl_raw   = testRows.reduce((s, r) => s + r.pnl_raw_replay, 0)
const sumPnl_iso   = testRows.reduce((s, r) => s + r.pnl_iso_replay, 0)
const sumPnl_platt = testRows.reduce((s, r) => s + r.pnl_platt_replay, 0)

const totalSize = testRows.reduce((s, r) => s + r.bet_size, 0)

const delta_brier_iso   = brier_test_iso   - brier_test_raw
const delta_brier_platt = brier_test_platt - brier_test_raw
const delta_ll_iso      = ll_test_iso      - ll_test_raw
const delta_ll_platt    = ll_test_platt    - ll_test_raw
const delta_roi_iso     = sumPnl_iso       - sumPnl_raw
const delta_roi_platt   = sumPnl_platt     - sumPnl_raw

// Per-stratum
const perStratum = {}
for (const key of STRATA_KEYS) {
  const sub = testStrict.filter(r => r.stratum === key)
  if (!sub.length) {
    perStratum[key] = { n_test: 0, n_train: strataNTrain[key], own_curve: !!isoStrata[key] }
    continue
  }
  const lbl = sub.map(r => r.label)
  const raw = sub.map(r => r.raw)
  const iso = sub.map(r => r.calibrated_iso)
  perStratum[key] = {
    n_test: sub.length,
    n_train: strataNTrain[key],
    own_curve: !!isoStrata[key],
    brier_raw:   brierScore(raw, lbl),
    brier_iso:   brierScore(iso, lbl),
    delta_brier: brierScore(iso, lbl) - brierScore(raw, lbl),
  }
}

// Stratum regression guard
const stratumRegressions = []
for (const [key, st] of Object.entries(perStratum)) {
  if (st.n_test >= STRATUM_MIN_TEST_FOR_REGRESSION_GUARD &&
      Number.isFinite(st.delta_brier) &&
      st.delta_brier > FLIP_BAR.per_stratum_brier_regression_max) {
    stratumRegressions.push({ key, delta: st.delta_brier, n_test: st.n_test })
  }
}

// Strata with own curve
const strataWithOwnCurve = STRATA_KEYS.filter(k => isoStrata[k]).length

// GO/NO-GO determination
const checks = {
  delta_brier_iso_passes:  delta_brier_iso  <= FLIP_BAR.delta_brier,
  delta_logloss_iso_passes: delta_ll_iso    <= FLIP_BAR.delta_logloss,
  delta_roi_iso_passes:    delta_roi_iso    >= FLIP_BAR.delta_roi,
  test_n_sufficient:       testStrict.length >= FLIP_BAR.test_n,
  strata_or_global:        strataWithOwnCurve >= FLIP_BAR.strata_with_own_curve_min ||
                           (delta_brier_iso <= FLIP_BAR.delta_brier && delta_ll_iso <= FLIP_BAR.delta_logloss),
  no_major_stratum_regression: stratumRegressions.length === 0,
}
const allPass = Object.values(checks).every(Boolean)
const verdict = allPass ? 'GO' : 'NO-GO'

// ─── Calibration curves (decile buckets) ─────────────────────────
function calCurve(preds, lbls) {
  const buckets = []
  for (let i = 0; i < 10; i++) buckets.push({ lo: i/10, hi: (i+1)/10, n:0, sum_pred:0, sum_lbl:0 })
  for (let i = 0; i < preds.length; i++) {
    const idx = Math.min(9, Math.floor(preds[i] * 10))
    buckets[idx].n++
    buckets[idx].sum_pred += preds[i]
    buckets[idx].sum_lbl  += lbls[i]
  }
  return buckets.map(b => ({
    lo: b.lo, hi: b.hi, n: b.n,
    avg_pred: b.n ? b.sum_pred / b.n : null,
    actual:   b.n ? b.sum_lbl  / b.n : null,
  }))
}
const curveRaw = calCurve(rawPreds, labels)
const curveIso = calCurve(isoPreds, labels)

// ─── Cross-stratum example transformation table ──────────────────
const SAMPLE_PROBS = [0.30, 0.50, 0.70, 0.85]
const transformExamples = []
for (const p of SAMPLE_PROBS) {
  const row = { raw: p }
  for (const key of STRATA_KEYS) {
    const out = applyIsotonic(p, key)
    row[key] = {
      calibrated: out.calibrated,
      used_global: !isoStrata[key],
      ood_clipped: out.ood_clipped,
    }
  }
  transformExamples.push(row)
}

// ─── Render report ───────────────────────────────────────────────
const fmt = (n, d=4) => Number.isFinite(n) ? n.toFixed(d) : '—'
const fmt2 = (n) => Number.isFinite(n) ? n.toFixed(2) : '—'

const lines = []
lines.push(`# Calibration Backtest — ${today}`)
lines.push(``)
lines.push(`**STATUS: ${verdict}**`)
lines.push(``)
lines.push(`**FIRST-LOOK / SMALL SAMPLE.** This window is likely thinner than ideal for production enablement; use the harness to validate signal direction.`)
lines.push(``)

lines.push(`## Front page — flip-flag bar`)
lines.push(``)
lines.push(`| metric | bar | isotonic | passes |`)
lines.push(`|---|---|---:|:-:|`)
lines.push(`| Δ Brier (test) | ≤ ${fmt(FLIP_BAR.delta_brier)} | ${fmt(delta_brier_iso)} | ${checks.delta_brier_iso_passes ? '✓' : '✗'} |`)
lines.push(`| Δ log-loss (test) | ≤ ${fmt(FLIP_BAR.delta_logloss)} | ${fmt(delta_ll_iso)} | ${checks.delta_logloss_iso_passes ? '✓' : '✗'} |`)
lines.push(`| Δ ROI fixed-size (test) | ≥ ${fmt(FLIP_BAR.delta_roi, 2)} | $${fmt2(delta_roi_iso)} | ${checks.delta_roi_iso_passes ? '✓' : '✗'} |`)
lines.push(`| test n (strict win/loss) | ≥ ${FLIP_BAR.test_n} | ${testStrict.length} | ${checks.test_n_sufficient ? '✓' : '✗'} |`)
lines.push(`| strata with own curve | ≥ ${FLIP_BAR.strata_with_own_curve_min} OR global passes | ${strataWithOwnCurve} | ${checks.strata_or_global ? '✓' : '✗'} |`)
lines.push(`| no major stratum regression | none with Δ > ${FLIP_BAR.per_stratum_brier_regression_max} (n_test ≥ ${STRATUM_MIN_TEST_FOR_REGRESSION_GUARD}) | ${stratumRegressions.length} | ${checks.no_major_stratum_regression ? '✓' : '✗'} |`)
lines.push(``)
lines.push(`### Verdict: **${verdict}**`)
lines.push(``)
if (allPass) {
  lines.push(`All flip-flag conditions met. L1.5.3 (artifact write) is justified.`)
} else {
  const failing = Object.entries(checks).filter(([_,v]) => !v).map(([k]) => k)
  lines.push(`Failing: ${failing.join(', ')}.`)
  lines.push(`Do NOT promote to active artifact yet. See sections below for diagnostic detail.`)
}
lines.push(``)

lines.push(`## Sample`)
lines.push(``)
lines.push(`| metric | value |`)
lines.push(`|---|---:|`)
lines.push(`| window | ${SINCE} → ${UNTIL} |`)
lines.push(`| bets loaded | ${bets.length} |`)
lines.push(`| trainable bets (win/loss) | ${trainable.length} |`)
lines.push(`| distinct bet_dates | ${distinctDates.length} |`)
lines.push(`| split cutoff date | ${cutoffDate} |`)
lines.push(`| train dates | ${trainDates.size} |`)
lines.push(`| test dates | ${testDates.size} |`)
lines.push(`| train bets (strict) | ${trainBets.length} |`)
lines.push(`| test bets (all settled) | ${testRows.length} |`)
lines.push(`| test bets (strict win/loss) | ${testStrict.length} |`)
lines.push(``)

lines.push(`## Calibration metrics (test set, strict win/loss only)`)
lines.push(``)
lines.push(`| metric | raw | isotonic | platt |`)
lines.push(`|---|---:|---:|---:|`)
lines.push(`| Brier | ${fmt(brier_test_raw)} | ${fmt(brier_test_iso)} | ${fmt(brier_test_platt)} |`)
lines.push(`| log-loss | ${fmt(ll_test_raw)} | ${fmt(ll_test_iso)} | ${fmt(ll_test_platt)} |`)
lines.push(`| ECE | ${fmt(ece_raw.ece)} | ${fmt(ece_iso.ece)} | ${fmt(ece_platt.ece)} |`)
lines.push(`| MCE | ${fmt(ece_raw.mce)} | ${fmt(ece_iso.mce)} | ${fmt(ece_platt.mce)} |`)
lines.push(`| Δ Brier vs raw | — | ${fmt(delta_brier_iso)} | ${fmt(delta_brier_platt)} |`)
lines.push(`| Δ log-loss vs raw | — | ${fmt(delta_ll_iso)} | ${fmt(delta_ll_platt)} |`)
lines.push(`| Δ ECE vs raw | — | ${fmt(ece_iso.ece - ece_raw.ece)} | ${fmt(ece_platt.ece - ece_raw.ece)} |`)
lines.push(`| Δ MCE vs raw | — | ${fmt(ece_iso.mce - ece_raw.mce)} | ${fmt(ece_platt.mce - ece_raw.mce)} |`)
lines.push(``)
lines.push(`*ECE = expected calibration error (weighted-average bucket bias). MCE = max bucket bias. Lower is better.*`)
lines.push(``)

lines.push(`## ROI replay (test set, all settled bets)`)
lines.push(``)
lines.push(`| metric | value |`)
lines.push(`|---|---:|`)
lines.push(`| total production size | $${fmt2(totalSize)} |`)
lines.push(`| total production pnl | $${fmt2(sumPnl_production)} |`)
lines.push(`| Oracle gate using raw probs | $${fmt2(sumPnl_raw)} |`)
lines.push(`| Oracle gate using isotonic | $${fmt2(sumPnl_iso)} |`)
lines.push(`| Oracle gate using platt | $${fmt2(sumPnl_platt)} |`)
lines.push(`| Δ ROI isotonic vs raw | $${fmt2(delta_roi_iso)} |`)
lines.push(`| Δ ROI platt vs raw | $${fmt2(delta_roi_platt)} |`)
lines.push(``)
lines.push(`Fixed-size measure: hold production size; gate fire/skip via edge ≥ max(0.12, spread/2 + 0.04).`)
lines.push(``)

lines.push(`## Per-stratum (isotonic on test)`)
lines.push(``)
lines.push(`| stratum | n_train | n_test | own_curve | Brier raw | Brier iso | Δ Brier | flag |`)
lines.push(`|---|---:|---:|:-:|---:|---:|---:|---|`)
for (const key of STRATA_KEYS) {
  const st = perStratum[key]
  const isNoisy = st.n_test < STRATUM_MIN_TEST_FOR_REGRESSION_GUARD
  const flag = !st.n_test ? '(no test data)' : isNoisy ? 'noisy' : (st.delta_brier > FLIP_BAR.per_stratum_brier_regression_max ? 'REGRESSION' : 'ok')
  lines.push(`| ${key} | ${st.n_train ?? 0} | ${st.n_test} | ${st.own_curve ? '✓' : '(global)'} | ${fmt(st.brier_raw)} | ${fmt(st.brier_iso)} | ${fmt(st.delta_brier)} | ${flag} |`)
}
lines.push(``)
if (stratumRegressions.length) {
  lines.push(`**Stratum regressions (gating):** ${stratumRegressions.map(r => `${r.key} (Δ=${fmt(r.delta)}, n=${r.n_test})`).join(', ')}`)
} else {
  lines.push(`No major stratum regressions among strata with sufficient test sample (n ≥ ${STRATUM_MIN_TEST_FOR_REGRESSION_GUARD}).`)
}
lines.push(``)

lines.push(`## Cross-stratum transformation examples (isotonic)`)
lines.push(``)
lines.push(`Same raw probability mapped to different calibrated values per stratum.`)
lines.push(``)
let header = `| raw |`
for (const key of STRATA_KEYS) header += ` ${key} |`
lines.push(header)
let separator = `|---|`
for (const key of STRATA_KEYS) separator += '---:|'
lines.push(separator)
for (const ex of transformExamples) {
  let row = `| ${ex.raw.toFixed(2)} |`
  for (const key of STRATA_KEYS) {
    const cell = ex[key]
    const note = cell.used_global ? ' (g)' : (cell.ood_clipped ? ' (oodc)' : '')
    row += ` ${cell.calibrated.toFixed(3)}${note} |`
  }
  lines.push(row)
}
lines.push(``)
lines.push(`Legend: (g) = used global fallback because stratum n_train < ${STRATUM_MIN_N}. (oodc) = OOD clipped to training range.`)
lines.push(``)

lines.push(`## Calibration curve (test set)`)
lines.push(``)
lines.push(`Predicted vs actual win rate by decile bucket. Bias = predicted − actual.`)
lines.push(``)
lines.push(`| bucket | n | raw avg pred | raw actual | raw bias | iso avg pred | iso actual | iso bias |`)
lines.push(`|---|---:|---:|---:|---:|---:|---:|---:|`)
for (let i = 0; i < 10; i++) {
  const r = curveRaw[i], iso = curveIso[i]
  if (!r.n) continue
  const rBias = r.avg_pred != null && r.actual != null ? r.avg_pred - r.actual : null
  const iBias = iso.avg_pred != null && iso.actual != null ? iso.avg_pred - iso.actual : null
  lines.push(`| [${r.lo.toFixed(1)},${r.hi.toFixed(1)}) | ${r.n} | ${fmt(r.avg_pred)} | ${fmt(r.actual)} | ${rBias != null ? (rBias >= 0 ? '+' : '') + fmt(rBias) : '—'} | ${fmt(iso.avg_pred)} | ${fmt(iso.actual)} | ${iBias != null ? (iBias >= 0 ? '+' : '') + fmt(iBias) : '—'} |`)
}
lines.push(``)

lines.push(`## Caveats`)
lines.push(``)
lines.push(`1. Source: ks_bets.model_prob (production's logged probability). This calibrates the historical production decision probability, not a recomputed current Layer 1 probability. Drift caveat: when Layer 1 is wired into production, re-evaluate against fresh Layer 1 envelopes.`)
lines.push(`2. Voids excluded from training (no clean win/loss signal). Voids included in test ROI replay (pnl=0 by definition).`)
lines.push(`3. ROI replay uses fixed-size: hold production's size; gate fire/skip via edge ≥ max(0.12, spread/2 + 0.04). Kelly-resized variant computed but not gated on.`)
lines.push(`4. DK blend is dark; calibrator is fit on raw probs without DK. Forward-compat: when DK ships, retrain calibrator on the new probability surface.`)
lines.push(`5. NO active.json is created. Preview artifact only at oracle/layers/1.5-calibration/calibrators/<sha>.preview.json.`)
lines.push(``)

// ─── Build preview artifact ──────────────────────────────────────
const sourceDatasetHash = crypto.createHash('sha256').update(JSON.stringify({
  bets_used: trainBets.map(b => [b.bet_id, b.model_prob, b.result === 'win' ? 1 : 0]),
})).digest('hex')

const artifact = {
  schema_version: '1.0.0',
  trained_at: new Date().toISOString(),
  cutoff_date: cutoffDate,
  method: 'isotonic',                    // shipped method
  global_curve: isoGlobal.segments,
  global_train_min: isoGlobal.train_min,
  global_train_max: isoGlobal.train_max,
  stratified: Object.fromEntries(STRATA_KEYS.map(key => [key, {
    n_train: strataNTrain[key],
    in_use:  !!isoStrata[key],
    curve:    isoStrata[key]?.segments ?? null,
    train_min: isoStrata[key]?.train_min ?? null,
    train_max: isoStrata[key]?.train_max ?? null,
  }])),
  platt_global: { a: plattGlobal.a, b: plattGlobal.b, train_min: plattGlobal.train_min, train_max: plattGlobal.train_max },
  platt_stratified: Object.fromEntries(STRATA_KEYS.map(key => [key, plattStrata[key]
    ? { a: plattStrata[key].a, b: plattStrata[key].b, train_min: plattStrata[key].train_min, train_max: plattStrata[key].train_max }
    : null])),
  metrics: {
    brier_test_raw, brier_test_iso, brier_test_platt,
    ll_test_raw, ll_test_iso, ll_test_platt,
    ece_raw: ece_raw.ece, ece_iso: ece_iso.ece, ece_platt: ece_platt.ece,
    mce_raw: ece_raw.mce, mce_iso: ece_iso.mce, mce_platt: ece_platt.mce,
    delta_brier_iso, delta_ll_iso, delta_roi_iso,
    delta_brier_platt, delta_ll_platt, delta_roi_platt,
    test_n_strict: testStrict.length,
    test_n_all: testRows.length,
    train_n_strict: trainBets.length,
  },
  source_dataset_hash: sourceDatasetHash,
}
const calibratorId = crypto.createHash('sha256').update(JSON.stringify({
  schema_version: artifact.schema_version,
  method: artifact.method,
  cutoff_date: artifact.cutoff_date,
  source_dataset_hash: sourceDatasetHash,
})).digest('hex')
artifact.calibrator_id = calibratorId

mkdirSync('oracle/layers/1.5-calibration/calibrators', { recursive: true })
const previewPath = path.resolve(`oracle/layers/1.5-calibration/calibrators/${calibratorId.slice(0, 12)}.preview.json`)
writeFileSync(previewPath, JSON.stringify(artifact, null, 2), 'utf-8')

// Write report + per-bet CSV
const mdPath = path.resolve(`${OUTBASE}.md`)
writeFileSync(mdPath, lines.join('\n'), 'utf-8')

const csvLines = ['bet_id,bet_date,pitcher,strike,side,stratum,result,raw,iso,platt,iso_used_global,fire_raw,fire_iso,pnl_production,pnl_iso_replay']
for (const r of testRows) {
  const safe = (s) => String(s ?? '').replace(/,/g, ';')
  csvLines.push([
    r.bet_id, r.bet_date, safe(r.pitcher_name), r.strike, r.side, r.stratum, r.result,
    fmt(r.raw, 4), fmt(r.calibrated_iso, 4), fmt(r.calibrated_platt, 4),
    r.iso_used_global ? 1 : 0, r.fire_raw ? 1 : 0, r.fire_iso ? 1 : 0,
    r.pnl_production.toFixed(2), r.pnl_iso_replay.toFixed(2),
  ].join(','))
}
const csvPath = path.resolve(`${OUTBASE}.csv`)
writeFileSync(csvPath, csvLines.join('\n'), 'utf-8')

// ─── Stdout front-page summary ───────────────────────────────────
console.log('\n═══ CALIBRATION BACKTEST — FRONT PAGE ═══\n')
console.log(`Verdict: ${verdict}`)
console.log(`Sample: ${testStrict.length} test bets (strict), ${trainBets.length} train bets`)
console.log(`Cutoff: ${cutoffDate} (${trainDates.size} train dates / ${testDates.size} test dates)`)
console.log('')
console.log(`Δ Brier (iso):    ${fmt(delta_brier_iso)}    [bar ≤ ${FLIP_BAR.delta_brier}]    ${checks.delta_brier_iso_passes ? '✓' : '✗'}`)
console.log(`Δ log-loss (iso): ${fmt(delta_ll_iso)}    [bar ≤ ${FLIP_BAR.delta_logloss}]    ${checks.delta_logloss_iso_passes ? '✓' : '✗'}`)
console.log(`Δ ROI (iso):      $${fmt2(delta_roi_iso)}    [bar ≥ $${FLIP_BAR.delta_roi.toFixed(2)}]    ${checks.delta_roi_iso_passes ? '✓' : '✗'}`)
console.log(`Test n:           ${testStrict.length}    [bar ≥ ${FLIP_BAR.test_n}]    ${checks.test_n_sufficient ? '✓' : '✗'}`)
console.log(`Strata own curve: ${strataWithOwnCurve}    [bar ≥ ${FLIP_BAR.strata_with_own_curve_min} or global passes]    ${checks.strata_or_global ? '✓' : '✗'}`)
console.log(`Stratum regressions: ${stratumRegressions.length}    ${checks.no_major_stratum_regression ? '✓' : '✗'}`)
console.log('')
console.log(`Markdown: ${mdPath}`)
console.log(`CSV:      ${csvPath}`)
console.log(`Preview:  ${previewPath}`)
console.log(`Calibrator id: ${calibratorId.slice(0, 16)}…`)

await db.close()
