// Tuning framework. Loads .rawBacktestData.json, applies a configurable
// model+filter+sizing pipeline, returns aggregated metrics. Train/test split
// to avoid future-knowledge contamination.

import fs from 'fs'

const RAW = '/Users/adamstandridge/Documents/projects/baseball/.rawBacktestData.json'
const STARTING_BANKROLL = 5000
const FEE = 0.07

const records = JSON.parse(fs.readFileSync(RAW, 'utf8'))
console.log(`Loaded ${records.length} pitcher-game records`)

const dates = [...new Set(records.map(r => r.target_date))].sort()
const splitIdx = Math.floor(dates.length / 2)
const trainDates = new Set(dates.slice(0, splitIdx))
const testDates = new Set(dates.slice(splitIdx))
console.log(`Train: ${dates.slice(0, splitIdx)[0]} → ${dates.slice(0, splitIdx)[splitIdx-1]} (${trainDates.size} dates)`)
console.log(`Test:  ${dates.slice(splitIdx)[0]} → ${dates.slice(splitIdx).slice(-1)[0]} (${testDates.size} dates)\n`)

// ── Model functions ───────────────────────────────────────────────────────
function poissonGEqN(lambda, n) {
  if (n <= 0) return 1
  let cum = Math.exp(-lambda), term = cum
  for (let k = 1; k < n; k++) { term = term * lambda / k; cum += term }
  return Math.max(0, Math.min(1, 1 - cum))
}
function nbGEqN(lambda, r, n) {
  if (n <= 0) return 1
  const p = r / (r + lambda)
  let cum = Math.pow(p, r), term = cum
  for (let k = 1; k < n; k++) { term = term * (k + r - 1) / k * (1 - p); cum += term }
  return Math.max(0, Math.min(1, 1 - cum))
}

function computeLambda(record, model) {
  const all = record.prior_starts
  if (all.length < (model.minPriorStarts ?? 1)) return null
  // Take last N starts (most recent)
  const window = Math.min(model.window ?? 5, all.length)
  const recent = all.slice(-window)

  let weights
  if (model.weighting === 'exp') {
    weights = recent.map((_, i) => Math.exp(-(recent.length - 1 - i) * 0.2))
  } else {
    weights = recent.map(() => 1)
  }
  const wSum = weights.reduce((a, b) => a + b, 0)
  const totalK = recent.reduce((s, g, i) => s + g.ks * weights[i], 0)
  const totalIp = recent.reduce((s, g, i) => s + g.ip * weights[i], 0)
  if (totalIp <= 0) return null
  const k9 = totalK / totalIp * 9
  const avgIp = totalIp / wSum  // weighted avg IP
  if (k9 < (model.k9_min ?? 4) || k9 > (model.k9_max ?? 18)) return null
  return { lambda: k9 * avgIp / 9, k9, avgIp }
}

// ── Run backtest with config ──────────────────────────────────────────────
function backtest(records, config, dateFilter = null) {
  const { model, filter, sizing, risk } = config
  // Build all candidates
  const candsByDate = new Map()
  for (const r of records) {
    if (dateFilter && !dateFilter(r.target_date)) continue
    const lam = computeLambda(r, model)
    if (!lam) continue
    for (const l of r.ladder) {
      if (l.strike < (filter.minStrike ?? 0) || l.strike > (filter.maxStrike ?? 99)) continue
      const modelProb = model.distribution === 'nb'
        ? nbGEqN(lam.lambda, model.nbDispersion ?? 8, l.strike)
        : poissonGEqN(lam.lambda, l.strike)
      if (filter.side === 'YES' || filter.side === 'BOTH') {
        const ask = l.yes_ask
        if (ask >= 3 && ask <= (filter.maxAsk ?? 88)) {
          const edge = modelProb - ask / 100
          if (edge >= (filter.minEdge ?? 0)) {
            const cand = {
              date: r.target_date, pid: r.pitcher_id, name: r.pitcher_name,
              strike: l.strike, side: 'YES', ask, edge, model_prob: modelProb,
              actualK: r.actual_K, ticker: l.ticker, lambda: lam.lambda,
            }
            if (!candsByDate.has(r.target_date)) candsByDate.set(r.target_date, [])
            candsByDate.get(r.target_date).push(cand)
          }
        }
      }
      if (filter.side === 'NO' || filter.side === 'BOTH') {
        const ask = l.no_ask
        if (ask >= 3 && ask <= (filter.maxAsk ?? 88)) {
          const edge = (1 - modelProb) - ask / 100
          if (edge >= (filter.minEdge ?? 0)) {
            const cand = {
              date: r.target_date, pid: r.pitcher_id, name: r.pitcher_name,
              strike: l.strike, side: 'NO', ask, edge, model_prob: modelProb,
              actualK: r.actual_K, ticker: l.ticker, lambda: lam.lambda,
            }
            if (!candsByDate.has(r.target_date)) candsByDate.set(r.target_date, [])
            candsByDate.get(r.target_date).push(cand)
          }
        }
      }
    }
  }

  // Apply per-day filters: top-N, per-pitcher cap, skip-no-conviction
  const fires = []
  let bankroll = STARTING_BANKROLL
  let peak = bankroll
  let maxDD = 0
  let consecutiveLosingDays = 0
  let daysSkippedByStopLoss = 0

  const sortedDates = [...candsByDate.keys()].sort()
  for (const d of sortedDates) {
    const arr = candsByDate.get(d)
    arr.sort((a, b) => b.edge - a.edge)

    // Skip-no-conviction
    if (filter.minConvictionEdgeForDay != null && arr[0].edge < filter.minConvictionEdgeForDay) continue
    // Stop-loss
    if (risk.stopLossAfterStreak > 0 && consecutiveLosingDays >= risk.stopLossAfterStreak) {
      daysSkippedByStopLoss++
      consecutiveLosingDays = 0
      continue
    }

    // Per-pitcher cap
    const perPitcher = new Map()
    const dayPicks = []
    for (const c of arr) {
      if (dayPicks.length >= (filter.topN ?? 5)) break
      const pCount = perPitcher.get(c.pid) ?? 0
      if (pCount >= (filter.perPitcherCap ?? 99)) continue
      perPitcher.set(c.pid, pCount + 1)
      dayPicks.push(c)
    }

    // Compute bet sizes for the day (off START-of-day bankroll)
    let dayPnl = 0
    const dayBetSize = bankroll * (sizing.pctBase ?? 0.01)
    for (const c of dayPicks) {
      let betSize = dayBetSize
      if (sizing.method === 'edge') {
        // Linear edge weighting: edge=5c → 1×, edge=20c → 3×
        const minEdge = filter.minEdge ?? 0.05
        const mult = Math.min(sizing.edgeMultiplierMax ?? 3,
          1 + (c.edge - minEdge) / minEdge)
        betSize = dayBetSize * Math.max(1, mult)
      }
      betSize = Math.min(betSize, sizing.capPerBet ?? 200)
      betSize = Math.max(1, betSize)

      const won = c.side === 'YES' ? c.actualK >= c.strike : c.actualK < c.strike
      const contracts = Math.max(1, Math.floor(betSize / (c.ask / 100)))
      const stake = contracts * (c.ask / 100)
      const pnl = won ? contracts * ((100 - c.ask) / 100) * (1 - FEE) : -stake
      dayPnl += pnl
      fires.push({ ...c, betSize, contracts, stake, won: won ? 1 : 0, pnl, date: d })
    }

    bankroll += dayPnl
    if (bankroll > peak) peak = bankroll
    const dd = (peak - bankroll) / peak
    if (dd > maxDD) maxDD = dd

    if (dayPnl < 0) consecutiveLosingDays++
    else consecutiveLosingDays = 0

    if (bankroll < (risk.bankrupt ?? 500)) break
  }

  const w = fires.filter(f => f.won).length
  const stake = fires.reduce((s, f) => s + f.stake, 0)
  const pnl = fires.reduce((s, f) => s + f.pnl, 0)
  return {
    fires: fires.length, wins: w, winPct: fires.length ? w/fires.length*100 : 0,
    stake, pnl, roi: stake ? pnl/stake*100 : 0,
    bankroll, peak, maxDD: maxDD * 100, return: (bankroll/STARTING_BANKROLL - 1) * 100,
    daysSkippedByStopLoss,
  }
}

// ── Baseline config ───────────────────────────────────────────────────────
const baseline = {
  model: { window: 5, weighting: 'flat', minPriorStarts: 1, distribution: 'poisson', k9_min: 4, k9_max: 18 },
  filter: {
    side: 'YES', minEdge: 0.05, maxAsk: 50, minStrike: 0, maxStrike: 99,
    topN: 5, perPitcherCap: 99, minConvictionEdgeForDay: null,
  },
  sizing: { method: 'flat', pctBase: 0.01, capPerBet: 200, edgeMultiplierMax: 3 },
  risk: { bankrupt: 500, stopLossAfterStreak: 0 },
}

function clone(o) { return JSON.parse(JSON.stringify(o)) }
function withChange(base, path, value) {
  const c = clone(base)
  const parts = path.split('.')
  let n = c
  for (let i = 0; i < parts.length - 1; i++) n = n[parts[i]]
  n[parts[parts.length - 1]] = value
  return c
}

const trainFilter = d => trainDates.has(d)
const testFilter = d => testDates.has(d)

console.log('═══ Baseline (top-5/day, edge≥5c, ask≤50c, YES, K9-l5, 1% per bet) ═══')
const b = backtest(records, baseline, trainFilter)
console.log(`  TRAIN  fires=${b.fires}  win=${b.winPct.toFixed(1)}%  ROI=${b.roi.toFixed(1)}%  bankroll=$${b.bankroll.toFixed(0)}  ret=${b.return.toFixed(1)}%  maxDD=${b.maxDD.toFixed(1)}%`)
console.log()

// ── Hypothesis tests on TRAIN only ────────────────────────────────────────
function compareOnTrain(label, change) {
  const cfg = clone(baseline)
  for (const [path, val] of Object.entries(change)) {
    const parts = path.split('.')
    let n = cfg; for (let i = 0; i < parts.length - 1; i++) n = n[parts[i]]
    n[parts[parts.length - 1]] = val
  }
  const r = backtest(records, cfg, trainFilter)
  const delta = r.roi - b.roi
  const sig = delta > 0 ? '✓' : ' '
  console.log(`  ${sig} ${label.padEnd(45)} fires=${String(r.fires).padStart(3)}  win=${r.winPct.toFixed(1).padStart(4)}%  ROI=${r.roi.toFixed(1).padStart(6)}%  ret=${r.return.toFixed(1).padStart(6)}%  Δ=${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%`)
  return { cfg, result: r, delta }
}

console.log('═══ Hypothesis tests (training period only) ═══\n')

console.log('H1 — K9 window size:')
const h1a = compareOnTrain('window=7 starts',  { 'model.window': 7 })
const h1b = compareOnTrain('window=10 starts', { 'model.window': 10 })
const h1c = compareOnTrain('window=3 starts',  { 'model.window': 3 })

console.log('\nH2 — Weighting:')
compareOnTrain('exponential decay weighting', { 'model.weighting': 'exp' })

console.log('\nH3 — Skip rookies:')
compareOnTrain('minPriorStarts=3', { 'model.minPriorStarts': 3 })
compareOnTrain('minPriorStarts=5', { 'model.minPriorStarts': 5 })

console.log('\nH4 — Distribution:')
compareOnTrain('Negative Binomial (r=8)', { 'model.distribution': 'nb', 'model.nbDispersion': 8 })
compareOnTrain('Negative Binomial (r=15)', { 'model.distribution': 'nb', 'model.nbDispersion': 15 })

console.log('\nH5 — Edge threshold:')
compareOnTrain('edge≥3c',  { 'filter.minEdge': 0.03 })
compareOnTrain('edge≥8c',  { 'filter.minEdge': 0.08 })
compareOnTrain('edge≥10c', { 'filter.minEdge': 0.10 })
compareOnTrain('edge≥12c', { 'filter.minEdge': 0.12 })

console.log('\nH6 — Ask cap:')
compareOnTrain('ask≤30c', { 'filter.maxAsk': 30 })
compareOnTrain('ask≤40c', { 'filter.maxAsk': 40 })
compareOnTrain('ask≤60c', { 'filter.maxAsk': 60 })

console.log('\nH7 — Strike floor:')
compareOnTrain('strike≥6', { 'filter.minStrike': 6 })
compareOnTrain('strike≥7', { 'filter.minStrike': 7 })

console.log('\nH8 — Top-N per day:')
compareOnTrain('top-1', { 'filter.topN': 1 })
compareOnTrain('top-3', { 'filter.topN': 3 })
compareOnTrain('top-10', { 'filter.topN': 10 })

console.log('\nH9 — Per-pitcher cap:')
compareOnTrain('per-pitcher cap=1', { 'filter.perPitcherCap': 1 })
compareOnTrain('per-pitcher cap=2', { 'filter.perPitcherCap': 2 })
compareOnTrain('per-pitcher cap=3', { 'filter.perPitcherCap': 3 })

console.log('\nH10 — Sizing method:')
compareOnTrain('edge-weighted, max 3×', { 'sizing.method': 'edge' })
compareOnTrain('edge-weighted, max 5×', { 'sizing.method': 'edge', 'sizing.edgeMultiplierMax': 5 })

console.log('\nH11 — Skip-no-conviction days:')
compareOnTrain('skip if max edge < 8c',  { 'filter.minConvictionEdgeForDay': 0.08 })
compareOnTrain('skip if max edge < 10c', { 'filter.minConvictionEdgeForDay': 0.10 })
compareOnTrain('skip if max edge < 12c', { 'filter.minConvictionEdgeForDay': 0.12 })

console.log('\nH12 — Stop-loss:')
compareOnTrain('stop-loss after 2 consec losing days', { 'risk.stopLossAfterStreak': 2 })
compareOnTrain('stop-loss after 3 consec losing days', { 'risk.stopLossAfterStreak': 3 })

console.log('\nH13 — Sizing percentage:')
compareOnTrain('2% per bet', { 'sizing.pctBase': 0.02 })
compareOnTrain('3% per bet', { 'sizing.pctBase': 0.03 })

console.log('\n═══ Final TEST run will be done after combining winners. Re-run with --combined to see. ═══')

// ── Combined configs — winners stacked, validated on BOTH train and test ──
console.log('\n═══ Combined configs (winners stacked) ═══')
console.log('Each combo tested on BOTH train AND test (test = lock-box, never tuned on)\n')
function evalCombo(label, changes) {
  const cfg = clone(baseline)
  for (const [path, val] of Object.entries(changes)) {
    const parts = path.split('.')
    let n = cfg; for (let i = 0; i < parts.length - 1; i++) n = n[parts[i]]
    n[parts[parts.length - 1]] = val
  }
  const tr = backtest(records, cfg, trainFilter)
  const te = backtest(records, cfg, testFilter)
  console.log(`  ${label.padEnd(45)} TRAIN: n=${String(tr.fires).padStart(3)} ROI=${tr.roi.toFixed(1).padStart(6)}% ret=${tr.return.toFixed(1).padStart(6)}% DD=${tr.maxDD.toFixed(1).padStart(4)}%   |   TEST: n=${String(te.fires).padStart(3)} ROI=${te.roi.toFixed(1).padStart(6)}% ret=${te.return.toFixed(1).padStart(6)}% DD=${te.maxDD.toFixed(1).padStart(4)}%`)
  return { cfg, tr, te }
}

evalCombo('baseline',                      {})
evalCombo('per-pitcher cap=1',              { 'filter.perPitcherCap': 1 })
evalCombo('per-pitcher cap=2',              { 'filter.perPitcherCap': 2 })
evalCombo('NB r=8',                         { 'model.distribution': 'nb', 'model.nbDispersion': 8 })
evalCombo('NB r=8 + cap=1',                 { 'model.distribution': 'nb', 'model.nbDispersion': 8, 'filter.perPitcherCap': 1 })
evalCombo('cap=1 + ask≤30c',                { 'filter.perPitcherCap': 1, 'filter.maxAsk': 30 })
evalCombo('cap=1 + strike≥6',               { 'filter.perPitcherCap': 1, 'filter.minStrike': 6 })
evalCombo('cap=1 + strike≥7',               { 'filter.perPitcherCap': 1, 'filter.minStrike': 7 })
evalCombo('cap=1 + edge≥10c',               { 'filter.perPitcherCap': 1, 'filter.minEdge': 0.10 })
evalCombo('cap=1 + edge≥12c',               { 'filter.perPitcherCap': 1, 'filter.minEdge': 0.12 })
evalCombo('cap=1 + NB + edge≥10c + strike≥6', { 'filter.perPitcherCap': 1, 'model.distribution': 'nb', 'model.nbDispersion': 8, 'filter.minEdge': 0.10, 'filter.minStrike': 6 })
evalCombo('cap=1 + NB + edge≥10c + ask≤30c',  { 'filter.perPitcherCap': 1, 'model.distribution': 'nb', 'model.nbDispersion': 8, 'filter.minEdge': 0.10, 'filter.maxAsk': 30 })
evalCombo('cap=1 + NB + strike≥6 + ask≤30c',  { 'filter.perPitcherCap': 1, 'model.distribution': 'nb', 'model.nbDispersion': 8, 'filter.minStrike': 6, 'filter.maxAsk': 30 })
evalCombo('cap=1 + NB + strike≥6 + edge-weighted', { 'filter.perPitcherCap': 1, 'model.distribution': 'nb', 'model.nbDispersion': 8, 'filter.minStrike': 6, 'sizing.method': 'edge', 'sizing.edgeMultiplierMax': 5 })
evalCombo('cap=1 + NB + strike≥6 + 2% per bet',    { 'filter.perPitcherCap': 1, 'model.distribution': 'nb', 'model.nbDispersion': 8, 'filter.minStrike': 6, 'sizing.pctBase': 0.02 })
evalCombo('cap=1 + NB + strike≥6 + 3% per bet',    { 'filter.perPitcherCap': 1, 'model.distribution': 'nb', 'model.nbDispersion': 8, 'filter.minStrike': 6, 'sizing.pctBase': 0.03 })
evalCombo('cap=2 + NB + strike≥6 + 3% per bet',    { 'filter.perPitcherCap': 2, 'model.distribution': 'nb', 'model.nbDispersion': 8, 'filter.minStrike': 6, 'sizing.pctBase': 0.03 })
