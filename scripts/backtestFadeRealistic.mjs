// Capacity-aware, no-compounding backtest of the fade model — the "honest" version.
//
// vs scripts/v3HistoricalTest.mjs (which compounds aggressively and models zero
// capacity → fantasy $107k-from-$5k numbers), this one:
//   - FLAT staking off a fixed $5,000 base (no compounding), 1% × edge-mult, hard $/bet cap
//   - models a few realistic per-bet dollar caps ($50 / $100 / $200) standing in for the
//     10%-of-24h-volume liquidity cap in fireFadeModel.mjs (the raw backtest tape has no
//     volume data, so we cap in dollars instead — strikeout markets are thin)
//   - 1¢ slippage on entry (you rarely get the exact ask on cheap tails)
//   - walk-forward weekly breakdown (is the edge stable, or one lucky week?)
//   - per-strike-bucket (K=6 / K=7-9 / K≥10) and per-ask-bucket (≤10¢ / 11-25¢ / 26-50¢) P&L
//   - default config = v1h (v1 + H-I), the OOS-validated live default; --variant v1|v3 to compare
//
// Data: .rawBacktestData.json (Mar 31 – May 6 2026, 858 pitcher-games, candle-reconstructed).
//
// Usage:  railway run node scripts/backtestFadeRealistic.mjs [--variant v1h|v1|v3]

import 'dotenv/config'
import fs from 'fs'
import { createClient } from '@libsql/client'

const RAW = new URL('../.rawBacktestData.json', import.meta.url).pathname
const FEE = 0.07
const FIXED_BASE = 5000          // staking base — fixed, never compounds
const SIZE_PCT = 0.01            // 1% base
const SIZE_EDGE_MAX = 5          // up to 5× on biggest edges
const MIN_EDGE = 0.05
const MAX_EDGE = 0.20
const MAX_ASK = 50
const MIN_STRIKE = 6
const NB_R = 8
const SLIPPAGE_C = 1             // pay ask + 1¢
const PER_BET_CAPS = [50, 100, 200]   // $/bet scenarios (stand-in for the volume cap)

const VARIANT = (() => {
  const i = process.argv.indexOf('--variant')
  return i > 0 ? process.argv[i + 1].toLowerCase() : 'v1h'
})()
const USE_HI = VARIANT === 'v1h' || VARIANT === 'v3'   // H-I confidence filter
const USE_HH = VARIANT === 'v3'                        // H-H avg_innings filter
const STRIKE_SPLIT = VARIANT === 'v3'                  // K=6/K≥10 only (skip 7-9)

function nbGEqN(lambda, r, n) {
  if (n <= 0) return 1
  const p = r / (r + lambda)
  let cum = Math.pow(p, r), term = cum
  for (let k = 1; k < n; k++) { term = term * (k + r - 1) / k * (1 - p); cum += term }
  return Math.max(0, Math.min(1, 1 - cum))
}

const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })
const records = JSON.parse(fs.readFileSync(RAW, 'utf8'))

// pitcher_signals for H-H / H-I (only rows ≤ May 6 — same as the OOS test)
const sigRows = await db.execute(`SELECT pitcher_id, signal_date, confidence, avg_innings_l5 FROM pitcher_signals WHERE signal_date <= '2026-05-06'`)
const sigMap = new Map()
for (const r of sigRows.rows) sigMap.set(`${r.pitcher_id}|${r.signal_date}`, { confidence: r.confidence, avg_innings_l5: r.avg_innings_l5 })

function weekOf(d) {
  // ISO-ish week bucket: Monday-anchored label
  const dt = new Date(d + 'T12:00:00Z')
  const day = (dt.getUTCDay() + 6) % 7   // 0 = Monday
  dt.setUTCDate(dt.getUTCDate() - day)
  return dt.toISOString().slice(0, 10)
}
function strikeBucket(s) { return s === 6 ? 'K=6' : (s <= 9 ? 'K=7-9' : 'K≥10') }
function askBucket(a) { return a <= 10 ? 'ask ≤10¢' : (a <= 25 ? 'ask 11-25¢' : 'ask 26-50¢') }

function run(capPerBet) {
  const bets = []
  for (const rec of records) {
    if (!rec.prior_starts?.length) continue
    const recent = rec.prior_starts.slice(-5)
    const totalK = recent.reduce((s, g) => s + g.ks, 0)
    const totalIp = recent.reduce((s, g) => s + g.ip, 0)
    if (totalIp <= 0) continue
    const k9 = totalK / totalIp * 9
    const avgIp = totalIp / recent.length
    if (k9 < 4 || k9 > 18) continue
    const lambda = k9 * avgIp / 9

    const sig = sigMap.get(`${rec.pitcher_id}|${rec.target_date}`)
    if (USE_HH && sig?.avg_innings_l5 != null && Number(sig.avg_innings_l5) < 5.0) continue
    if (USE_HI && sig?.confidence != null && Number(sig.confidence) <= 0.3) continue

    // candidate selection
    const pick = []
    if (STRIKE_SPLIT) {
      let f = null, t = null
      for (const lad of rec.ladder) {
        const strike = Number(lad.strike), ask = Number(lad.yes_ask)
        if (ask < 3 || ask > MAX_ASK) continue
        const edge = nbGEqN(lambda, NB_R, strike) - ask / 100
        if (edge < MIN_EDGE || edge > MAX_EDGE) continue
        if (strike === 6) { if (!f || edge > f.edge) f = { strike, ask, edge } }
        else if (strike >= 10) { if (!t || edge > t.edge) t = { strike, ask, edge } }
      }
      if (f) pick.push(f); if (t) pick.push(t)
    } else {
      let best = null
      for (const lad of rec.ladder) {
        const strike = Number(lad.strike), ask = Number(lad.yes_ask)
        if (strike < MIN_STRIKE || ask < 3 || ask > MAX_ASK) continue
        const edge = nbGEqN(lambda, NB_R, strike) - ask / 100
        if (edge < MIN_EDGE || edge > MAX_EDGE) continue
        if (!best || edge > best.edge) best = { strike, ask, edge }
      }
      if (best) pick.push(best)
    }
    if (!pick.length) continue

    for (const c of pick) {
      const entryAsk = Math.min(99, c.ask + SLIPPAGE_C)   // slippage
      const edgeMult = Math.min(SIZE_EDGE_MAX, 1 + (c.edge - MIN_EDGE) / MIN_EDGE)
      const wantUsd = Math.min(capPerBet, FIXED_BASE * SIZE_PCT * edgeMult)
      const contracts = Math.max(1, Math.floor(wantUsd / (entryAsk / 100)))
      const stake = contracts * (entryAsk / 100)
      const won = rec.actual_K >= c.strike
      const pnl = won ? contracts * ((100 - entryAsk) / 100) * (1 - FEE) : -stake
      bets.push({ date: rec.target_date, strike: c.strike, ask: c.ask, won, stake, pnl })
    }
  }
  return bets
}

function summarize(bets, label) {
  const n = bets.length
  const w = bets.filter(b => b.won).length
  const pnl = bets.reduce((s, b) => s + b.pnl, 0)
  const stake = bets.reduce((s, b) => s + b.stake, 0)
  const roi = stake > 0 ? pnl / stake * 100 : 0
  const days = new Set(bets.map(b => b.date)).size
  console.log(`${label}`)
  console.log(`  ${n} bets · ${w}W (${(w/n*100||0).toFixed(0)}% win) · staked $${stake.toFixed(0)} · P&L ${pnl>=0?'+':''}$${pnl.toFixed(0)} · per-bet ROI ${roi>=0?'+':''}${roi.toFixed(0)}% · $${(pnl/days).toFixed(0)}/day over ${days} days`)
  return { n, w, pnl, stake, roi, days }
}

function breakdown(bets, keyFn, title) {
  const m = new Map()
  for (const b of bets) {
    const k = keyFn(b)
    const cur = m.get(k) ?? { n: 0, w: 0, pnl: 0, stake: 0 }
    cur.n++; if (b.won) cur.w++; cur.pnl += b.pnl; cur.stake += b.stake
    m.set(k, cur)
  }
  console.log(`  ${title}`)
  for (const [k, v] of [...m].sort()) {
    const roi = v.stake > 0 ? v.pnl / v.stake * 100 : 0
    console.log(`    ${k.padEnd(12)} ${String(v.n).padStart(4)} bets · ${v.w}W (${(v.w/v.n*100).toFixed(0)}%) · ${v.pnl>=0?'+':''}$${v.pnl.toFixed(0).padStart(6)} · ${roi>=0?'+':''}${roi.toFixed(0)}% ROI`)
  }
}

console.log(`\n═══ Realistic fade backtest — variant=${VARIANT}  (Mar 31 – May 6 2026, ${records.length} pitcher-games) ═══`)
console.log(`Flat staking off fixed $${FIXED_BASE} base (no compounding), 1%×edge-mult, ${SLIPPAGE_C}¢ slippage, 7% fee.\n`)

for (const cap of PER_BET_CAPS) {
  const bets = run(cap)
  const s = summarize(bets, `── per-bet cap $${cap} ──`)
  breakdown(bets, b => weekOf(b.date), 'walk-forward by week:')
  breakdown(bets, b => strikeBucket(b.strike), 'by strike bucket:')
  breakdown(bets, b => askBucket(b.ask), 'by ask bucket:')
  // annualized rough projection
  const seasonDays = 165
  const perDay = s.pnl / s.days
  console.log(`  → naive ${seasonDays}-game-day projection at this run-rate: ${perDay*seasonDays>=0?'+':''}$${(perDay*seasonDays).toFixed(0)} (NOT a forecast — variance + adaptation will erode it)`)
  console.log()
}

console.log('Caveats: candle-reconstructed asks (optimistic — assumes you get filled near the ask);')
console.log('no orderbook depth modeled beyond the flat $/bet cap; pitcher_signals are partly in-sample for H-I.')
console.log('The walk-forward weekly P&L is the thing to look at: stable across weeks = real, one big week = noise.')
process.exit(0)
