#!/usr/bin/env node
// weeklyPkBacktest.js — compare actual P&L vs ML-model P&L for this week's bets.
//
// Uses the pre-trained Ridge weights (models/pk_ridge_weights.json) to recompute
// model_prob and edge for every bet placed this week, then applies the same gate
// rules as production to decide what ML would have bet.
//
// Usage:
//   node scripts/live/weeklyPkBacktest.js
//   node scripts/live/weeklyPkBacktest.js --start 2026-04-22 --end 2026-04-25

import 'dotenv/config'
import * as db from '../../lib/db.js'
import { loadModel, predictPk } from '../../lib/pkModel.js'
import { pAtLeast } from '../../lib/strikeout-model.js'

const args   = process.argv.slice(2)
const flag   = n => { const i = args.indexOf(n); return i >= 0 ? args[i+1] : null }

// Default: this week Mon–today
function weekBounds() {
  const now = new Date()
  const dow = (now.getUTCDay() + 6) % 7
  const mon = new Date(now); mon.setUTCDate(now.getUTCDate() - dow)
  return { start: mon.toISOString().slice(0, 10), end: now.toISOString().slice(0, 10) }
}
const { start: defStart, end: defEnd } = weekBounds()
const START = flag('--start') || defStart
const END   = flag('--end')   || defEnd

const LEAGUE_PA_PER_IP = 4.3
const MIN_EDGE_FLOOR   = 0.04
const YES_MIN_PROB     = 0.25
const YES_MIN_EDGE     = 0.12
const NO_MIN_EDGE      = 0.12

// ── Load model ────────────────────────────────────────────────────────────────
const model = loadModel()
if (!model) {
  console.error('[backtest] No model weights found. Run: node scripts/live/histBacktestPkModel.js')
  process.exit(1)
}

// ── Poisson P(K >= n) ─────────────────────────────────────────────────────────
function modelProb(lambda, strike) {
  return pAtLeast(lambda, strike)
}

// ── Gate rules (mirror production) ───────────────────────────────────────────
function passesGate(prob, edge, side, market_mid, strike) {
  if (Math.abs(edge) < MIN_EDGE_FLOOR) return false
  if (side === 'NO' && (market_mid ?? 50) >= 65 && prob >= 0.50) return false  // Rule A
  if (side === 'YES' && prob < YES_MIN_PROB && edge < 0.18) return false        // Rule D
  if (side === 'NO'  && (market_mid ?? 50) < 15) return false                   // Rule E
  if (side === 'NO'  && (strike ?? 99) <= 4) return false                       // Rule F
  if (side === 'YES' && edge < YES_MIN_EDGE) return false
  if (side === 'NO'  && edge < NO_MIN_EDGE)  return false
  return true
}

// ── Fetch bets and pitcher features ──────────────────────────────────────────
async function main() {
  console.log(`[backtest] ${START} → ${END}  model cv_r²=${model.cv_r2?.toFixed(3)}`)

  // Get all placed bets for the period
  const bets = await db.all(`
    SELECT b.id, b.bet_date, b.pitcher_id, b.pitcher_name,
           b.strike, b.side, b.model_prob, b.market_mid, b.edge,
           b.lambda, b.k9_l5, b.k9_season, b.k9_career,
           b.savant_k_pct, b.savant_whiff, b.savant_fbv,
           b.adj_factor, b.raw_adj_factor, b.opp_k_pct,
           b.park_factor, b.weather_mult, b.ump_factor,
           b.velo_adj, b.bb_penalty,
           b.actual_ks, b.result, b.pnl, b.bet_size
    FROM ks_bets b
    WHERE b.bet_date >= ? AND b.bet_date <= ?
      AND b.live_bet = 0 AND b.paper = 0
      AND b.result IS NOT 'void'
    ORDER BY b.bet_date, b.pitcher_id, b.strike
  `, [START, END])

  if (!bets.length) { console.log('[backtest] No bets found.'); return }

  // Get Statcast features for pitchers (for ML inputs not in ks_bets)
  const pitcherIds = [...new Set(bets.map(b => b.pitcher_id).filter(Boolean))]
  const scRows = pitcherIds.length ? await db.all(`
    SELECT player_id, k_pct, swstr_pct, fb_velo, gb_pct, bb_pct,
           k_pct_vs_l, k_pct_vs_r, ip, pa, manager_leash_factor
    FROM pitcher_statcast
    WHERE player_id IN (${pitcherIds.map(()=>'?').join(',')})
      AND season = 2026
    ORDER BY fetch_date DESC
  `, pitcherIds) : []
  const scMap = new Map()
  for (const sc of scRows) {
    if (!scMap.has(sc.player_id)) scMap.set(sc.player_id, sc)
  }

  // Get expected_BF from pitcher_recent_starts (avg last 5 before each bet_date)
  const recentStarts = pitcherIds.length ? await db.all(`
    SELECT pitcher_id, game_date, bf, ip
    FROM pitcher_recent_starts
    WHERE pitcher_id IN (${pitcherIds.map(()=>'?').join(',')}) AND bf > 0
    ORDER BY pitcher_id, game_date DESC
  `, pitcherIds) : []
  const startsByPitcher = new Map()
  for (const s of recentStarts) {
    if (!startsByPitcher.has(s.pitcher_id)) startsByPitcher.set(s.pitcher_id, [])
    startsByPitcher.get(s.pitcher_id).push(s)
  }

  function getExpectedBF(pitcherId, betDate) {
    const starts = (startsByPitcher.get(pitcherId) || [])
      .filter(s => s.game_date < betDate)
      .slice(0, 5)
    if (!starts.length) return null
    return starts.reduce((s, r) => s + r.bf, 0) / starts.length
  }

  // ── Per-pitcher ML pK (deduped: one per pitcher per date) ─────────────────
  const mlPkCache = new Map()
  for (const b of bets) {
    const cacheKey = `${b.pitcher_id}|${b.bet_date}`
    if (mlPkCache.has(cacheKey)) continue

    const sc          = scMap.get(b.pitcher_id) ?? {}
    const expected_bf = getExpectedBF(b.pitcher_id, b.bet_date) ?? (b.lambda / (b.savant_k_pct ?? 0.22))

    // Reconstruct blend weights from savant_ip
    const ip      = sc.ip ?? 0
    const w_season = Math.min(0.60, ip / 30)
    const w_career = Math.max(0, 0.40 * (1 - ip / 40))
    const w_l5    = Math.max(0, 1 - w_season - w_career)

    // Mirror the production guard: require ≥5 IP of 2026 Statcast data,
    // otherwise log_ip_proxy=0 inflates prediction to the clip ceiling.
    const hasSavantCoverage = sc.ip != null && sc.ip >= 5
    const ml_pK = hasSavantCoverage ? predictPk({
      k9_l5:               b.k9_l5,
      k9_career:           b.k9_career,
      k9_season:           b.k9_season,
      savant_k_pct:        b.savant_k_pct ?? sc.k_pct,
      savant_whiff:        b.savant_whiff ?? sc.swstr_pct,
      savant_fbv:          b.savant_fbv   ?? sc.fb_velo,
      savant_gb_pct:       sc.gb_pct,
      savant_bb_pct:       sc.bb_pct,
      k_pct_vs_l:          sc.k_pct_vs_l,
      k_pct_vs_r:          sc.k_pct_vs_r,
      savant_ip:           sc.ip,
      savant_pa:           sc.pa,
      manager_leash_factor: sc.manager_leash_factor,
      expected_bf,
      w_season, w_career, w_l5,
      opp_k_pct:    b.opp_k_pct,
      adj_factor:   b.adj_factor,
      raw_adj_factor: b.raw_adj_factor,
      park_factor:  b.park_factor,
      weather_mult: b.weather_mult,
      ump_factor:   b.ump_factor,
      velo_adj:     b.velo_adj,
    }, model) : null

    const prod_pK = b.lambda && expected_bf ? b.lambda / expected_bf /
      ((b.park_factor??1) * (b.weather_mult??1) * (b.ump_factor??1) *
       (b.velo_adj??1) * (b.adj_factor??1) * (b.bb_penalty??1)) : (b.savant_k_pct ?? 0.22)

    // When no Statcast coverage, ML falls back to the production formula (no change)
    mlPkCache.set(cacheKey, { ml_pK: ml_pK ?? prod_pK, prod_pK, expected_bf, hasSavantCoverage })
  }

  // ── Per-bet comparison ────────────────────────────────────────────────────
  let prodBets = 0, prodWins = 0, prodLosses = 0, prodPnl = 0
  let mlBets   = 0, mlWins   = 0, mlLosses   = 0, mlPnl   = 0
  let droppedWins = 0, droppedLosses = 0, droppedPnl = 0

  const settled = bets.filter(b => b.result === 'win' || b.result === 'loss')
  const byDate  = new Map()

  for (const b of settled) {
    const cacheKey = `${b.pitcher_id}|${b.bet_date}`
    const { ml_pK, prod_pK, expected_bf } = mlPkCache.get(cacheKey) ?? {}

    // Production: what we actually did
    prodBets++
    prodPnl += b.pnl ?? 0
    if (b.result === 'win') prodWins++; else prodLosses++

    if (!ml_pK || !expected_bf) continue

    // ML: reconstruct lambda with ml_pK, same external multipliers
    const ext_mult = (b.park_factor??1) * (b.weather_mult??1) * (b.ump_factor??1) *
                     (b.velo_adj??1) * (b.adj_factor??1) * (b.bb_penalty??1)
    const ml_lambda = ml_pK * expected_bf * ext_mult
    const ml_prob   = modelProb(ml_lambda, b.strike)
    const ml_edge   = b.side === 'YES'
      ? ml_prob - (b.market_mid ?? 50) / 100
      : (1 - ml_prob) - (1 - (b.market_mid ?? 50) / 100)

    const would_bet = passesGate(ml_prob, ml_edge, b.side, b.market_mid, b.strike)

    if (would_bet) {
      mlBets++
      mlPnl += b.pnl ?? 0
      if (b.result === 'win') mlWins++; else mlLosses++
    } else {
      droppedPnl += b.pnl ?? 0
      if (b.result === 'win') droppedWins++; else droppedLosses++
    }

    // Track per-date for granular view
    if (!byDate.has(b.bet_date)) byDate.set(b.bet_date, { prod: 0, ml: 0, prodPnl: 0, mlPnl: 0, prodW: 0, mlW: 0 })
    const d = byDate.get(b.bet_date)
    d.prod++; d.prodPnl += b.pnl ?? 0; if (b.result==='win') d.prodW++
    if (would_bet) { d.ml++; d.mlPnl += b.pnl ?? 0; if (b.result==='win') d.mlW++ }
  }

  // ── Per-pitcher pK comparison (distinct pitchers) ─────────────────────────
  const pitcherRows = []
  const seen = new Set()
  for (const b of bets) {
    const k = `${b.pitcher_id}|${b.bet_date}`
    if (seen.has(k) || !b.pitcher_id) continue
    seen.add(k)
    const cache = mlPkCache.get(k)
    if (cache) pitcherRows.push({ name: b.pitcher_name, date: b.bet_date, ...cache })
  }
  pitcherRows.sort((a, b) => Math.abs(b.ml_pK - b.prod_pK) - Math.abs(a.ml_pK - a.prod_pK))

  // ── Report ────────────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════════')
  console.log(` ML pK MODEL — WEEKLY P&L BACKTEST  ${START} → ${END}`)
  console.log('═══════════════════════════════════════════════════════════════')

  // Per-pitcher pK deltas
  console.log('\n  PITCHER pK ADJUSTMENTS (largest delta first):')
  console.log(`  ${'Pitcher'.padEnd(22)} ${'Date'.padEnd(12)} ${'Prod%'.padStart(6)} ${'ML%'.padStart(6)} ${'Δ'.padStart(7)}`)
  for (const r of pitcherRows.slice(0, 15)) {
    const delta = (r.ml_pK - r.prod_pK) * 100
    const marker = Math.abs(delta) > 5 ? ' ◀' : ''
    console.log(`  ${r.name.padEnd(22)} ${r.date.padEnd(12)} ${(r.prod_pK*100).toFixed(1).padStart(6)}% ${(r.ml_pK*100).toFixed(1).padStart(5)}% ${(delta>=0?'+':'')+delta.toFixed(1).padStart(5)}%${marker}`)
  }

  // Per-date breakdown
  if (byDate.size > 1) {
    console.log('\n  PER-DAY BREAKDOWN (settled bets):')
    for (const [date, d] of [...byDate.entries()].sort()) {
      const prodRoi = d.prod ? (d.prodPnl / (d.prod * 100) * 100).toFixed(0) : '—'
      const mlRoi   = d.ml   ? (d.mlPnl   / (d.ml   * 100) * 100).toFixed(0) : '—'
      console.log(`  ${date}  prod: ${d.prod}b ${d.prodW}W $${d.prodPnl.toFixed(0).padStart(7)} (${prodRoi}%)  ml: ${d.ml}b ${d.mlW}W $${d.mlPnl.toFixed(0).padStart(7)} (${mlRoi}%)`)
    }
  }

  // Totals
  const prodRoi = prodBets ? (prodPnl / (prodBets * 100) * 100).toFixed(1) : '—'
  const mlRoi   = mlBets   ? (mlPnl   / (mlBets   * 100) * 100).toFixed(1) : '—'
  const swing   = mlPnl - (mlBets / Math.max(prodBets, 1)) * prodPnl

  const droppedBets = droppedWins + droppedLosses
  const droppedRoi  = droppedBets ? (droppedPnl / (droppedBets * 100) * 100).toFixed(1) : '—'
  const pnlDelta    = mlPnl - prodPnl  // negative = ML made less in absolute terms

  console.log('\n───────────────────────────────────────────────────────────────')
  console.log(` PRODUCTION  ${prodBets} bets  ${prodWins}W-${prodLosses}L  P&L=${prodPnl>=0?'+':''}$${prodPnl.toFixed(2)}  ROI=${prodRoi}%`)
  console.log(` ML MODEL    ${mlBets} bets  ${mlWins}W-${mlLosses}L  P&L=${mlPnl>=0?'+':''}$${mlPnl.toFixed(2)}  ROI=${mlRoi}%`)
  console.log(` DROPPED     ${droppedBets} bets  ${droppedWins}W-${droppedLosses}L  P&L=${droppedPnl>=0?'+':''}$${droppedPnl.toFixed(2)}  ROI=${droppedRoi}%`)
  console.log(``)
  console.log(` P&L impact of ML filter: ${pnlDelta>=0?'+':''}$${pnlDelta.toFixed(2)} (ML ${pnlDelta>=0?'added':'cost'} $${Math.abs(pnlDelta).toFixed(2)} vs production)`)
  console.log(` Win-rate: prod=${prodBets?(prodWins/prodBets*100).toFixed(0):'—'}%  ml=${mlBets?(mlWins/mlBets*100).toFixed(0):'—'}%  dropped=${droppedBets?(droppedWins/droppedBets*100).toFixed(0):'—'}%`)
  if (settled.length === 0) console.log(' (No settled bets yet — run after games finish)')
  console.log('═══════════════════════════════════════════════════════════════\n')
}

main().catch(err => { console.error('[backtest] Fatal:', err); process.exit(1) })
