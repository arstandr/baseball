// lib/backtester.js — Zero-look-ahead backtesting engine.
// Replays market_snapshots tape through a configurable strategy.
// actual_ks is never consulted for bet decisions, only for resolution.

import * as db from './db.js'
import { applyCalibration } from './calibrationEngine.js'

const FEE     = 0.07
const DEFAULTS = {
  minEdge:          0.05,
  kellyFraction:    0.25,
  maxPctBankroll:   0.05,
  useCalibration:   true,
  sidesAllowed:     'both',
  gameStatusFilter: 'both',
  minIp:            null,
  maxIp:            null,
  minSamplesFilter: 0,
  startingBankroll: 5000,
  label:            null,
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function runBacktest(userConfig, userId = null) {
  const config = { ...DEFAULTS, ...userConfig }
  if (!config.dateStart || !config.dateEnd) throw new Error('dateStart and dateEnd required')

  const tape   = await loadTape(config)
  if (!tape.length) {
    return { totalBets: 0, winRate: 0, roi: 0, totalPnl: 0, sharpe: 0, maxDrawdown: 0,
             equityCurve: [], perPitcher: [], perStrike: [], calibrationCurve: [], message: 'No resolved snapshots in date range' }
  }

  // Build pitcher sample-count map for minSamplesFilter
  const pitcherBetCount = {}
  if (config.minSamplesFilter > 0) {
    const rows = await db.all(
      `SELECT pitcher_id, COUNT(*) as n FROM ks_bets WHERE paper=0 AND result IN ('win','loss') GROUP BY pitcher_id`
    ).catch(() => [])
    for (const r of rows) pitcherBetCount[r.pitcher_id] = r.n
  }

  const results = await simulate(tape, config, pitcherBetCount)
  const metrics = computeMetrics(results.bets, results.equityCurve)
  const output  = {
    ...metrics,
    equityCurve:       results.equityCurve,
    perPitcher:        buildPerPitcher(results.bets),
    perStrike:         buildPerStrike(results.bets),
    calibrationCurve:  buildCalibrationCurve(results.bets),
    comparison:        buildComparison(results.bets, tape),
    config,
  }

  const runId = await persistRun(config, output, userId)
  return { runId, ...output }
}

export async function runWalkForward(userConfig, userId = null, { trainWeeks = 8, testWeeks = 2, stepWeeks = 1 } = {}) {
  const config    = { ...DEFAULTS, ...userConfig }
  const tape      = await loadTape(config)
  const allDates  = [...new Set(tape.map(r => r.game_date))].sort()
  if (allDates.length < trainWeeks * 7 + testWeeks * 7) {
    return { windows: [], message: 'Insufficient date range for walk-forward' }
  }

  const windows = []
  let trainStart = allDates[0]

  while (true) {
    const trainEnd = addDays(trainStart, trainWeeks * 7)
    const testEnd  = addDays(trainEnd, testWeeks * 7)
    if (testEnd > allDates[allDates.length - 1]) break

    const testTape = tape.filter(r => r.game_date >= trainEnd && r.game_date < testEnd)
    if (testTape.length === 0) { trainStart = addDays(trainStart, stepWeeks * 7); continue }

    const results = await simulate(testTape, config, {})
    const metrics = computeMetrics(results.bets, results.equityCurve)
    windows.push({ trainStart, trainEnd, testStart: trainEnd, testEnd, ...metrics, bets: results.bets.length })

    trainStart = addDays(trainStart, stepWeeks * 7)
  }

  const runId = await persistRun(config, { walkforward: windows, config }, userId)
  return { runId, windows }
}

// ── Core simulation ─────────────────────────────────────────────────────────���─

async function simulate(tape, config, pitcherBetCount) {
  let bankroll = config.startingBankroll
  const bets   = []
  const equityCurve = []
  let peak = bankroll

  for (const row of tape) {
    // Destructure: decisions use only pre-resolution fields; actual_ks used only at resolve step
    const { actual_ks, resolved_at, ...preResolution } = row

    // Filters
    if (config.gameStatusFilter !== 'both' && preResolution.game_status !== config.gameStatusFilter) continue
    if (config.minIp != null && (preResolution.live_ip ?? 0) < config.minIp) continue
    if (config.maxIp != null && (preResolution.live_ip ?? 99) > config.maxIp) continue
    if (config.minSamplesFilter > 0) {
      const n = pitcherBetCount[preResolution.pitcher_id] ?? 0
      if (n < config.minSamplesFilter) continue
    }
    if (!preResolution.best_side || !preResolution.model_prob) continue
    if (config.sidesAllowed !== 'both' && preResolution.best_side !== config.sidesAllowed) continue

    // Probability (optionally calibration-corrected)
    const rawProb  = preResolution.model_prob
    const adjProb  = config.useCalibration ? await applyCalibration(rawProb) : rawProb
    const yesPrice = (preResolution.yes_price ?? 50) / 100
    const noPrice  = 1 - yesPrice

    const edgeYes  = adjProb - yesPrice
    const edgeNo   = (1 - adjProb) - noPrice
    const bestSide = edgeYes >= edgeNo ? 'YES' : 'NO'
    const bestEdge = bestSide === 'YES' ? edgeYes : edgeNo

    if (bestEdge < config.minEdge) continue
    if (config.sidesAllowed !== 'both' && bestSide !== config.sidesAllowed) continue

    // Kelly sizing
    const price     = bestSide === 'YES' ? yesPrice : noPrice
    const kellyFull = price > 0 ? (adjProb - price) / (1 - price) : 0
    const kellySized = Math.max(0, kellyFull * config.kellyFraction)
    const betDollars = Math.min(
      bankroll * config.maxPctBankroll,
      bankroll * kellySized,
    )
    if (betDollars < 0.01) continue

    // Resolve using actual_ks (the only place it's consumed)
    const won    = bestSide === 'YES' ? actual_ks >= row.strike : actual_ks < row.strike
    const fillFrac = price
    const pnl    = won
      ? betDollars * (1 - fillFrac) * (1 - FEE)
      : -(betDollars * fillFrac)

    bankroll += pnl
    peak = Math.max(peak, bankroll)

    bets.push({
      game_date:    preResolution.game_date,
      ticker:       preResolution.ticker,
      pitcher_id:   preResolution.pitcher_id,
      pitcher_name: preResolution.pitcher_name,
      strike:       preResolution.strike,
      side:         bestSide,
      model_prob:   rawProb,
      adj_prob:     adjProb,
      edge:         bestEdge,
      price:        fillFrac,
      bet_size:     betDollars,
      pnl:          Math.round(pnl * 100) / 100,
      won,
      bankroll:     Math.round(bankroll * 100) / 100,
      actual_ks,
      bet_id:       preResolution.bet_id,
      drawdown:     bankroll < peak ? peak - bankroll : 0,
    })

    equityCurve.push({ date: preResolution.game_date, bankroll: Math.round(bankroll * 100) / 100 })
  }

  return { bets, equityCurve }
}

// ── Metrics ───────────────────────────────────────────────────────────────────

function computeMetrics(bets, equityCurve) {
  if (!bets.length) return { totalBets: 0, winRate: 0, roi: 0, totalPnl: 0, sharpe: 0, maxDrawdown: 0 }
  const wins      = bets.filter(b => b.won).length
  const totalPnl  = bets.reduce((a, b) => a + b.pnl, 0)
  const totalSize = bets.reduce((a, b) => a + b.bet_size, 0)
  const roi       = totalSize > 0 ? totalPnl / totalSize : 0

  // Daily Sharpe
  const dailyMap = {}
  for (const b of bets) dailyMap[b.game_date] = (dailyMap[b.game_date] ?? 0) + b.pnl
  const daily    = Object.values(dailyMap)
  const mean     = daily.reduce((a, v) => a + v, 0) / daily.length
  const std      = Math.sqrt(daily.reduce((a, v) => a + (v - mean) ** 2, 0) / daily.length)
  const sharpeVal = std === 0 ? 0 : mean / std

  const maxDrawdown = bets.reduce((max, b) => Math.max(max, b.drawdown), 0)

  return {
    totalBets:   bets.length,
    winRate:     Math.round((wins / bets.length) * 1000) / 1000,
    roi:         Math.round(roi * 10000) / 10000,
    totalPnl:    Math.round(totalPnl * 100) / 100,
    sharpe:      Math.round(sharpeVal * 1000) / 1000,
    maxDrawdown: Math.round(maxDrawdown * 100) / 100,
  }
}

function buildPerPitcher(bets) {
  const map = {}
  for (const b of bets) {
    const k = b.pitcher_id || b.pitcher_name
    if (!map[k]) map[k] = { pitcher_id: b.pitcher_id, pitcher_name: b.pitcher_name, bets: 0, wins: 0, pnl: 0, size: 0 }
    map[k].bets++
    if (b.won) map[k].wins++
    map[k].pnl  += b.pnl
    map[k].size += b.bet_size
  }
  return Object.values(map).map(p => ({
    ...p,
    winRate: p.bets > 0 ? Math.round((p.wins / p.bets) * 1000) / 1000 : 0,
    roi:     p.size > 0 ? Math.round((p.pnl / p.size) * 10000) / 10000 : 0,
    pnl:     Math.round(p.pnl * 100) / 100,
  })).sort((a, b) => b.pnl - a.pnl)
}

function buildPerStrike(bets) {
  const map = {}
  for (const b of bets) {
    if (!map[b.strike]) map[b.strike] = { strike: b.strike, bets: 0, wins: 0, pnl: 0, size: 0 }
    map[b.strike].bets++
    if (b.won) map[b.strike].wins++
    map[b.strike].pnl  += b.pnl
    map[b.strike].size += b.bet_size
  }
  return Object.values(map).map(s => ({
    ...s,
    winRate: s.bets > 0 ? Math.round((s.wins / s.bets) * 1000) / 1000 : 0,
    roi:     s.size > 0 ? Math.round((s.pnl / s.size) * 10000) / 10000 : 0,
    pnl:     Math.round(s.pnl * 100) / 100,
  })).sort((a, b) => a.strike - b.strike)
}

function buildCalibrationCurve(bets) {
  const WIDTH   = 0.05
  const buckets = {}
  for (const b of bets) {
    const lo  = Math.floor(b.model_prob / WIDTH) * WIDTH
    const key = `${lo.toFixed(2)}`
    if (!buckets[key]) buckets[key] = { lo, wins: 0, total: 0 }
    buckets[key].total++
    if (b.won) buckets[key].wins++
  }
  return Object.values(buckets)
    .filter(b => b.total >= 5)
    .map(b => ({
      predicted: Math.round((b.lo + WIDTH / 2) * 100) / 100,
      actual:    Math.round((b.wins / b.total) * 1000) / 1000,
      n:         b.total,
    }))
    .sort((a, b) => a.predicted - b.predicted)
}

function buildComparison(bets, tape) {
  const realSnaps  = tape.filter(r => r.bet_id)
  const realBetIds = new Set(realSnaps.map(r => r.bet_id))
  const simRealBets = bets.filter(b => b.bet_id && realBetIds.has(b.bet_id))
  const realPnl  = simRealBets.reduce((a, b) => a + b.pnl, 0)
  const simPnl   = bets.reduce((a, b) => a + b.pnl, 0)
  return {
    simBets:    bets.length,
    realBets:   realSnaps.length,
    overlap:    simRealBets.length,
    simPnl:     Math.round(simPnl * 100) / 100,
    realPnl:    Math.round(realPnl * 100) / 100,
  }
}

// ── Storage ───────────────────────────────────────────────────────────────────

async function loadTape(config) {
  let sql = `SELECT * FROM market_snapshots WHERE game_date BETWEEN ? AND ? AND actual_ks IS NOT NULL AND model_prob IS NOT NULL`
  const args = [config.dateStart, config.dateEnd]
  if (config.gameStatusFilter !== 'both') { sql += ` AND game_status = ?`; args.push(config.gameStatusFilter) }
  if (config.minIp != null)               { sql += ` AND live_ip >= ?`;    args.push(config.minIp) }
  if (config.maxIp != null)               { sql += ` AND live_ip <= ?`;    args.push(config.maxIp) }
  sql += ` ORDER BY captured_at ASC`
  return db.all(sql, args).catch(() => [])
}

async function persistRun(config, output, userId) {
  // Trim equity curve to daily points if > 500 entries
  let curve = output.equityCurve ?? []
  if (curve.length > 500) {
    const step = Math.ceil(curve.length / 500)
    curve = curve.filter((_, i) => i % step === 0)
  }
  const res = await db.run(`
    INSERT INTO backtest_runs
      (user_id, label, date_start, date_end, config_json, summary_json,
       equity_curve_json, per_pitcher_json, per_strike_json, calibration_json,
       walkforward_json, total_bets, win_rate, roi, total_pnl, sharpe, max_drawdown, status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'success')
  `, [
    userId ?? null,
    config.label ?? null,
    config.dateStart,
    config.dateEnd,
    JSON.stringify(config),
    JSON.stringify({ totalBets: output.totalBets, winRate: output.winRate, roi: output.roi, totalPnl: output.totalPnl, sharpe: output.sharpe, maxDrawdown: output.maxDrawdown }),
    JSON.stringify(curve),
    JSON.stringify(output.perPitcher ?? []),
    JSON.stringify(output.perStrike ?? []),
    JSON.stringify(output.calibrationCurve ?? []),
    JSON.stringify(output.walkforward ?? null),
    output.totalBets ?? 0,
    output.winRate   ?? 0,
    output.roi       ?? 0,
    output.totalPnl  ?? 0,
    output.sharpe    ?? 0,
    output.maxDrawdown ?? 0,
  ]).catch(() => null)
  return res ? Number(res.lastInsertRowid) : null
}

function addDays(dateStr, days) {
  const d = new Date(dateStr)
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}
