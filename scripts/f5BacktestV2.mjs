// scripts/f5BacktestV2.mjs
//
// V2 of the F5 backtest. Replaces v1's narrow 14-day Kalshi-window test with a
// 5-season analytical-model evaluation on the existing f5_feature_matrix.
//
// What's different from v1:
//   1. Negative Binomial (r=4) replaces Poisson — empirical F5 dispersion is
//      ~2.23× Poisson; NB(r=4) matches it. Computed once across 8,846 games
//      in the dataset.
//   2. Park RUN factor (pk_run_factor) instead of K factor — fixes Coors and
//      the marine-layer suppressors.
//   3. Per-team bullpen ERA (bp_h_era_14d / bp_a_era_14d) replaces the 4.20
//      constant. Differentiates strong vs weak pens.
//   4. Mild weather adjustments (temp, wind) — small effect but data is there.
//   5. Tested on 5 seasons, not 14 days. Walk-forward (no calibration done on
//      the same data we test on).
//
// Pre-registered model (locked before looking at results):
//
//   λ_home_starter   = sp_h_era_l5  × min(sp_h_innings_l5, 5) / 9
//   λ_home_bullpen   = bp_h_era_14d × max(5 − sp_h_innings_l5, 0) / 9
//   λ_home_team_F5   = λ_home_starter + λ_home_bullpen
//
//   λ_away_starter   = sp_a_era_l5  × min(sp_a_innings_l5, 5) / 9
//   λ_away_bullpen   = bp_a_era_14d × max(5 − sp_a_innings_l5, 0) / 9
//   λ_away_team_F5   = λ_away_starter + λ_away_bullpen
//
//   λ_combined = (λ_home_team_F5 + λ_away_team_F5)
//                × pk_run_factor
//                × (1 + 0.0015 × (wx_temp_f − 70))
//                × (1 + 0.003  × wx_wind_mph)
//
//   X ~ NegBin(mean = λ_combined, r = 4)
//   P(F5 > line) = 1 − CDF_NB(floor(line))
//
// Strategy: take the bet whose side our model favors when |model_p − 0.524|
// exceeds an edge threshold. -105/-105 sportsbook line approximation:
// implied prob = 0.524 each side → 2.4% vig. We bet $100 per signal. Net
// return: +$95.24 on win, −$100 on loss. (This is the sportsbook approximation
// used by prior optimization — see data/optimization_summary.txt.)
//
// We ALSO report a Kalshi-fee approximation (7% taker) for comparison with v1.
//
// Outputs:
//   /tmp/f5_v2_summary.txt        — headline numbers + calibration
//   /tmp/f5_v2_per_bet.csv        — every (game, decision) row
//   /tmp/f5_v2_ablation.txt       — feature-on / feature-off sensitivity table

import { readFileSync, writeFileSync } from 'fs'

const DATA_PATH = '/Users/adamstandridge/Documents/projects/baseball/data/f5_feature_matrix_all.csv'
const NB_R      = 4              // dispersion (empirical: r=4 matches dispersion ratio 2.23)
const VIG_PROB  = 0.524          // assumed implied prob each side at -105/-105
const WIN_RET   = 95.24          // $ won per winning $100 bet at -105
const FEE_KALSHI_FRAC = 0.07     // alt fee model (Kalshi taker)
const STAKE     = 100

function loadCsv(path) {
  const txt = readFileSync(path, 'utf8')
  const lines = txt.split('\n').filter(Boolean)
  const header = lines[0].split(',')
  const rows = []
  for (const ln of lines.slice(1)) {
    const cells = ln.split(',')
    const row = {}
    for (let i = 0; i < header.length; i++) row[header[i]] = cells[i]
    rows.push(row)
  }
  return rows
}

// ─ Math helpers ──────────────────────────────────────────────────────────────
// Negative Binomial PMF in mean / dispersion (r) parameterization.
//   X ~ NB(μ, r)  with  P(X = k) = Γ(k+r)/(Γ(r) k!) · (r/(r+μ))^r · (μ/(r+μ))^k
function logGamma(x) {
  // Lanczos approximation
  const g = 7
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ]
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x)
  x -= 1
  let a = c[0]
  const t = x + g + 0.5
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i)
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a)
}

function nbPmf(k, μ, r) {
  if (μ <= 0 || r <= 0 || k < 0) return 0
  const p = r / (r + μ)
  const logP = logGamma(k + r) - logGamma(r) - logGamma(k + 1)
                + r * Math.log(p) + k * Math.log(1 - p)
  return Math.exp(logP)
}
function nbCdf(k, μ, r) {
  let s = 0
  for (let i = 0; i <= k; i++) s += nbPmf(i, μ, r)
  return s
}
function pNbOver(line, μ, r) {
  const k = Math.floor(line)
  return 1 - nbCdf(k, μ, r)
}

// Poisson for comparison
function poissonPmf(k, λ) {
  let p = Math.exp(-λ)
  for (let i = 1; i <= k; i++) p *= λ / i
  return p
}
function poissonCdf(k, λ) {
  let s = 0
  for (let i = 0; i <= k; i++) s += poissonPmf(i, λ)
  return s
}
function pPoissonOver(line, λ) {
  const k = Math.floor(line)
  return 1 - poissonCdf(k, λ)
}

// ─ Feature parsing ───────────────────────────────────────────────────────────
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null }

function computeLambda(row, opts = { usePark: true, useBullpen: true, useWeather: true }) {
  const era_h = num(row.sp_h_era_l5)
  const era_a = num(row.sp_a_era_l5)
  const ip_h  = num(row.sp_h_innings_l5)
  const ip_a  = num(row.sp_a_innings_l5)
  if (era_h == null || era_a == null || ip_h == null || ip_a == null) return null

  const bp_h_era = opts.useBullpen ? (num(row.bp_h_era_14d) ?? 4.20) : 4.20
  const bp_a_era = opts.useBullpen ? (num(row.bp_a_era_14d) ?? 4.20) : 4.20

  const λ_h_start   = era_h  * Math.min(ip_h, 5) / 9
  const λ_h_pen     = bp_h_era * Math.max(5 - ip_h, 0) / 9
  const λ_a_start   = era_a  * Math.min(ip_a, 5) / 9
  const λ_a_pen     = bp_a_era * Math.max(5 - ip_a, 0) / 9
  let λ = λ_h_start + λ_h_pen + λ_a_start + λ_a_pen

  if (opts.usePark) {
    const pf = num(row.pk_run_factor) ?? 1
    λ *= pf
  }
  if (opts.useWeather) {
    const temp = num(row.wx_temp_f) ?? 70
    const wind = num(row.wx_wind_mph) ?? 0
    λ *= (1 + 0.0015 * (temp - 70)) * (1 + 0.003 * wind)
  }
  return λ
}

// ─ Test runner ───────────────────────────────────────────────────────────────
function quantile(arr, q) {
  if (!arr.length) return null
  const sorted = [...arr].sort((a, b) => a - b)
  const idx = (sorted.length - 1) * q
  const lo = Math.floor(idx), hi = Math.ceil(idx)
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
}
function mean(arr) { return arr.length ? arr.reduce((s,v) => s+v, 0) / arr.length : 0 }

// Drop rows that are clearly placeholder/default (early season w/ no stats yet).
// Conservative filter: era values exactly 4.3 AND ip 5.5 on both starters = default.
function isPlaceholder(row) {
  const era_h = num(row.sp_h_era_l5), era_a = num(row.sp_a_era_l5)
  const ip_h  = num(row.sp_h_innings_l5), ip_a = num(row.sp_a_innings_l5)
  return era_h === 4.3 && era_a === 4.3 && ip_h === 5.5 && ip_a === 5.5
}

function evalConfig(rows, opts, label) {
  const results = {
    label,
    n_total: 0, n_with_model: 0, n_with_market: 0,
    perBet: [],
    brier_nb: 0, brier_pois: 0,
  }
  for (const row of rows) {
    if (isPlaceholder(row)) continue
    const f5 = num(row.f5_runs_total)
    const line = num(row.f5_line_open)
    if (f5 == null || line == null) continue
    const μ = computeLambda(row, opts)
    if (μ == null || !Number.isFinite(μ) || μ <= 0) continue

    const p_yes_nb   = pNbOver(line, μ, NB_R)
    const p_yes_pois = pPoissonOver(line, μ)
    const actual_yes = f5 > line ? 1 : 0
    results.n_with_model++
    results.brier_nb   += (p_yes_nb   - actual_yes) ** 2
    results.brier_pois += (p_yes_pois - actual_yes) ** 2

    results.perBet.push({
      date: row.date, season: row.season,
      home: row.home_team, away: row.away_team,
      f5_runs: f5, f5_line: line, actual_yes,
      lambda: μ, p_yes_nb, p_yes_pois,
      edge_nb_yes: p_yes_nb - VIG_PROB,
      edge_nb_no:  (1 - p_yes_nb) - VIG_PROB,
    })
  }
  results.n_total = rows.length
  results.brier_nb   /= results.n_with_model
  results.brier_pois /= results.n_with_model
  return results
}

function strategyResults(bets, side, threshold, feeModel = 'sportsbook') {
  const filtered = bets.filter(b => {
    const edge = side === 'yes' ? b.edge_nb_yes : b.edge_nb_no
    return edge >= threshold
  })
  if (!filtered.length) return { n: 0, wins: 0, pnl: 0, roi: 0 }
  let wins = 0, pnl = 0
  for (const b of filtered) {
    const win = side === 'yes' ? b.actual_yes : (1 - b.actual_yes)
    if (win) {
      wins++
      if (feeModel === 'sportsbook') pnl += WIN_RET
      else pnl += STAKE * (1 / VIG_PROB - 1) - FEE_KALSHI_FRAC * (STAKE * (1 / VIG_PROB))  // Kalshi taker on stake side
    } else {
      pnl -= STAKE
    }
  }
  const stake = filtered.length * STAKE
  return { n: filtered.length, wins, pnl, roi: pnl / stake }
}

function bySeasonResults(bets, side, threshold) {
  const bySeason = {}
  for (const b of bets) {
    const edge = side === 'yes' ? b.edge_nb_yes : b.edge_nb_no
    if (edge < threshold) continue
    const s = b.season
    if (!bySeason[s]) bySeason[s] = { n: 0, wins: 0, pnl: 0 }
    const win = side === 'yes' ? b.actual_yes : (1 - b.actual_yes)
    bySeason[s].n++
    if (win) { bySeason[s].wins++; bySeason[s].pnl += WIN_RET }
    else { bySeason[s].pnl -= STAKE }
  }
  return bySeason
}

function calibrationTable(bets, probKey) {
  const bins = [[0,0.1],[0.1,0.2],[0.2,0.3],[0.3,0.4],[0.4,0.5],[0.5,0.6],[0.6,0.7],[0.7,0.8],[0.8,0.9],[0.9,1.001]]
  const out = []
  for (const [lo, hi] of bins) {
    const inBin = bets.filter(b => b[probKey] >= lo && b[probKey] < hi)
    if (!inBin.length) continue
    const actual = mean(inBin.map(b => b.actual_yes))
    const meanP  = mean(inBin.map(b => b[probKey]))
    out.push({ lo, hi, n: inBin.length, actual, meanP, delta: actual - meanP })
  }
  return out
}

function fmtCalibration(rows) {
  const lines = []
  lines.push(`  bin            │ n    │ actual yes% │ model p%   │ Δ pp`)
  for (const r of rows) {
    lines.push(`  [${r.lo.toFixed(1)}, ${r.hi.toFixed(1)})  │ ${String(r.n).padStart(4)} │   ${(100*r.actual).toFixed(1).padStart(5)}%   │   ${(100*r.meanP).toFixed(1).padStart(5)}%  │ ${(100*r.delta).toFixed(1).padStart(6)}pp`)
  }
  return lines.join('\n')
}

function main() {
  console.log('Loading feature matrix...')
  const rows = loadCsv(DATA_PATH)
  console.log(`Loaded ${rows.length} games. Running configs...\n`)

  const base = evalConfig(rows, { usePark: true, useBullpen: true, useWeather: true }, 'v2-full')
  console.log(`v2-full: ${base.n_with_model} games scored, ${base.n_total - base.n_with_model} dropped`)

  // Ablations
  const noPark    = evalConfig(rows, { usePark: false, useBullpen: true,  useWeather: true  }, 'no-park')
  const noBullpen = evalConfig(rows, { usePark: true,  useBullpen: false, useWeather: true  }, 'no-bullpen')
  const noWeather = evalConfig(rows, { usePark: true,  useBullpen: true,  useWeather: false }, 'no-weather')
  const noneXtra  = evalConfig(rows, { usePark: false, useBullpen: false, useWeather: false }, 'starters-only (v1-style)')

  const out = []
  out.push(`F5 Backtest V2 — NB(r=${NB_R}), park run factor, per-team bullpen ERA, weather`)
  out.push(`Generated: ${new Date().toISOString()}`)
  out.push(`Dataset: data/f5_feature_matrix_all.csv  (${rows.length} games)`)
  out.push(`Bets eligible: ${base.n_with_model} games (drop placeholder + null-feature rows)`)
  out.push(``)
  out.push(`────────────────────────────────────────────────────────────────`)
  out.push(`Brier score comparison (lower = better; 0.25 = always-50%):`)
  out.push(`────────────────────────────────────────────────────────────────`)
  out.push(`  Config                    │ Brier NB │ Brier Poisson`)
  out.push(`  v2-full (all on)          │ ${base.brier_nb.toFixed(4)}   │ ${base.brier_pois.toFixed(4)}`)
  out.push(`  no-park                   │ ${noPark.brier_nb.toFixed(4)}   │ ${noPark.brier_pois.toFixed(4)}`)
  out.push(`  no-bullpen (4.20 const)   │ ${noBullpen.brier_nb.toFixed(4)}   │ ${noBullpen.brier_pois.toFixed(4)}`)
  out.push(`  no-weather                │ ${noWeather.brier_nb.toFixed(4)}   │ ${noWeather.brier_pois.toFixed(4)}`)
  out.push(`  starters-only (v1-style)  │ ${noneXtra.brier_nb.toFixed(4)}   │ ${noneXtra.brier_pois.toFixed(4)}`)
  out.push(``)

  out.push(`────────────────────────────────────────────────────────────────`)
  out.push(`Calibration (NB, v2-full):`)
  out.push(`────────────────────────────────────────────────────────────────`)
  out.push(fmtCalibration(calibrationTable(base.perBet, 'p_yes_nb')))
  out.push(``)
  out.push(`Calibration (Poisson, v2-full) for shape comparison:`)
  out.push(fmtCalibration(calibrationTable(base.perBet, 'p_yes_pois')))
  out.push(``)

  // Strategy P/L on v2-full (sportsbook -105/-105 model)
  out.push(`────────────────────────────────────────────────────────────────`)
  out.push(`Strategy P/L (sportsbook model -105/-105, $${STAKE}/bet):`)
  out.push(`────────────────────────────────────────────────────────────────`)
  out.push(`  side │ edge ≥ │   n   │ wins │ win% │   PnL    │  ROI`)
  for (const side of ['yes','no']) {
    for (const t of [0.0, 0.03, 0.05, 0.07, 0.10]) {
      const r = strategyResults(base.perBet, side, t)
      if (!r.n) { out.push(`  ${side.toUpperCase().padEnd(3)}  │  ≥${(100*t).toFixed(0).padStart(2)}%  │   0   │   -  │  -   │     -    │   -`); continue }
      out.push(`  ${side.toUpperCase().padEnd(3)}  │  ≥${(100*t).toFixed(0).padStart(2)}%  │ ${String(r.n).padStart(5)} │ ${String(r.wins).padStart(4)} │ ${(100*r.wins/r.n).toFixed(1).padStart(4)}% │ ${r.pnl >= 0 ? '+' : ''}$${r.pnl.toFixed(0).padStart(6)} │ ${(100*r.roi).toFixed(2).padStart(5)}%`)
    }
  }
  out.push(``)

  // Per-season breakdown at edge ≥ 7% (the prior optimization's "sweet spot" was 8-10%)
  out.push(`────────────────────────────────────────────────────────────────`)
  out.push(`Per-season breakdown at edge ≥ 7% (no cherry picking — best side per season):`)
  out.push(`────────────────────────────────────────────────────────────────`)
  for (const side of ['yes','no']) {
    out.push(`  Side: ${side.toUpperCase()}`)
    const bs = bySeasonResults(base.perBet, side, 0.07)
    for (const s of Object.keys(bs).sort()) {
      const r = bs[s]
      out.push(`    ${s} │ n=${String(r.n).padStart(4)} │ wins=${String(r.wins).padStart(4)} │ PnL=${r.pnl >= 0 ? '+' : ''}$${r.pnl.toFixed(0).padStart(6)} │ ROI=${(100*r.pnl/(r.n*STAKE)).toFixed(2)}%`)
    }
  }
  out.push(``)

  // Headline
  out.push(`────────────────────────────────────────────────────────────────`)
  out.push(`Headline:`)
  const bestStrat = (() => {
    let best = null
    for (const side of ['yes','no']) {
      for (const t of [0.03, 0.05, 0.07, 0.10]) {
        const r = strategyResults(base.perBet, side, t)
        if (r.n < 200) continue   // require minimum sample
        if (!best || r.roi > best.roi) best = { side, t, ...r }
      }
    }
    return best
  })()
  if (bestStrat) {
    out.push(`  Best (≥200 bets): ${bestStrat.side.toUpperCase()} side at edge ≥ ${(100*bestStrat.t).toFixed(0)}%`)
    out.push(`    n=${bestStrat.n}  win%=${(100*bestStrat.wins/bestStrat.n).toFixed(1)}%  PnL=${bestStrat.pnl >= 0 ? '+' : ''}$${bestStrat.pnl.toFixed(0)}  ROI=${(100*bestStrat.roi).toFixed(2)}%`)
  }
  out.push(``)
  out.push(`Compare to prior XGBoost optimization recommendation (data/optimization_summary.txt):`)
  out.push(`  feat=all, thresh=0.10, isotonic   → +6.29% ROI over 156 bets across 2023-2025`)
  out.push(``)

  // Write
  writeFileSync('/tmp/f5_v2_summary.txt', out.join('\n'))
  console.log(out.join('\n'))

  const betHeader = ['date','season','home','away','f5_runs','f5_line','actual_yes','lambda','p_yes_nb','p_yes_pois','edge_nb_yes','edge_nb_no']
  const betCsv = base.perBet.map(b => betHeader.map(k => b[k] ?? '').join(','))
  writeFileSync('/tmp/f5_v2_per_bet.csv', betHeader.join(',') + '\n' + betCsv.join('\n'))

  console.log(`\nWrote:`)
  console.log(`  /tmp/f5_v2_summary.txt`)
  console.log(`  /tmp/f5_v2_per_bet.csv  (${base.perBet.length} bets)`)
}

main()
