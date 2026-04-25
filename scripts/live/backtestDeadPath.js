// scripts/live/backtestDeadPath.js — Dead-path bet performance analysis
//
// Scans all settled dead-path bets from ks_bets and reports:
//   - Win rate, ROI, edge claimed vs edge realized
//   - Breakdown by pitch-count tier and K gap size
//   - Optimal entry thresholds based on historical data
//
// Usage: node scripts/live/backtestDeadPath.js [--date YYYY-MM-DD]
//        node scripts/live/backtestDeadPath.js --all     (all time)
//        node scripts/live/backtestDeadPath.js --days 60 (last N days)

import 'dotenv/config'
import * as db from '../../lib/db.js'
import { parseArgs } from '../../lib/cli-args.js'

const opts = parseArgs({
  date: { default: null },
  all:  { type: 'boolean', default: false },
  days: { type: 'number', default: 30 },
})

function fmtPct(n, d) {
  if (!d) return 'n/a'
  return (n / d * 100).toFixed(1) + '%'
}
function fmtUsd(n) { return '$' + (n ?? 0).toFixed(2) }

async function main() {
  await db.migrate()

  let dateFilter
  if (opts.date) {
    dateFilter = `AND bet_date = '${opts.date}'`
  } else if (opts.all) {
    dateFilter = ''
  } else {
    dateFilter = `AND bet_date >= date('now', '-${opts.days} days')`
  }

  const bets = await db.all(
    `SELECT id, bet_date, pitcher_name, strike, side, model_prob, market_mid,
            edge, lambda, fill_price, filled_contracts, capital_at_risk,
            actual_ks, result, pnl, paper
     FROM ks_bets
     WHERE bet_mode = 'dead-path' AND result IN ('win','loss') ${dateFilter}
     ORDER BY bet_date DESC, pitcher_name, strike`,
  )

  if (!bets.length) {
    console.log(`No settled dead-path bets found ${opts.date ? `for ${opts.date}` : `in last ${opts.days} days`}.`)
    await db.close()
    return
  }

  const real  = bets.filter(b => !b.paper)
  const paper = bets.filter(b =>  b.paper)

  function stats(arr) {
    const n     = arr.length
    const wins  = arr.filter(b => b.result === 'win').length
    const inv   = arr.reduce((s, b) => s + (b.capital_at_risk ?? 0), 0)
    const ret   = arr.reduce((s, b) => s + (b.pnl ?? 0), 0)
    const roi   = inv > 0 ? ret / inv : null
    const avgEdge = arr.reduce((s, b) => s + (b.edge ?? 0), 0) / (n || 1)
    const winRate = n > 0 ? wins / n : null
    const edgeDiff = winRate != null ? winRate - (0.5 - avgEdge / 2) : null
    return { n, wins, inv, ret, roi, avgEdge, winRate, edgeDiff }
  }

  function printStats(label, arr) {
    const s = stats(arr)
    if (!s.n) return
    console.log(`  ${label.padEnd(20)} n=${String(s.n).padStart(3)}  wins=${String(s.wins).padStart(3)} (${fmtPct(s.wins, s.n).padStart(6)})  invested=${fmtUsd(s.inv).padStart(8)}  ret=${fmtUsd(s.ret).padStart(8)}  ROI=${s.roi != null ? (s.roi * 100).toFixed(1).padStart(6) + '%' : '   n/a'}  edge=${(s.avgEdge * 100).toFixed(1)}¢`)
  }

  const dateLabel = opts.date ? opts.date : opts.all ? 'all time' : `last ${opts.days} days`
  console.log(`\n${'═'.repeat(70)}`)
  console.log(`DEAD-PATH BET BACKTEST  (${dateLabel})`)
  console.log(`${'═'.repeat(70)}`)

  console.log(`\nOVERALL:`)
  printStats('Real money', real)
  printStats('Paper', paper)
  printStats('Combined', bets)

  // ── By K gap (strike - lambda) ──────────────────────────────────────────────
  // Dead-path triggers when pitcher can't reach the threshold from current count.
  // Larger gap = easier NO win. Check edge by gap size.
  console.log(`\nBY K GAP (strike - actual_ks at time of bet):`)
  const gapBuckets = [
    ['gap ≥5',  bets.filter(b => b.lambda != null && (b.strike - b.lambda) >= 5)],
    ['gap 3-4', bets.filter(b => b.lambda != null && (b.strike - b.lambda) >= 3 && (b.strike - b.lambda) < 5)],
    ['gap 1-2', bets.filter(b => b.lambda != null && (b.strike - b.lambda) >= 1 && (b.strike - b.lambda) < 3)],
    ['gap ≤0',  bets.filter(b => b.lambda != null && (b.strike - b.lambda) < 1)],
    ['gap unknown', bets.filter(b => b.lambda == null)],
  ]
  for (const [label, arr] of gapBuckets) printStats(label, arr)

  // ── By model prob bucket ─────────────────────────────────────────────────────
  console.log(`\nBY MODEL PROB:`)
  const probBuckets = [
    ['≥90%',   bets.filter(b => b.model_prob >= 0.90)],
    ['80-89%', bets.filter(b => b.model_prob >= 0.80 && b.model_prob < 0.90)],
    ['70-79%', bets.filter(b => b.model_prob >= 0.70 && b.model_prob < 0.80)],
    ['<70%',   bets.filter(b => b.model_prob < 0.70)],
  ]
  for (const [label, arr] of probBuckets) printStats(label, arr)

  // ── By fill price ────────────────────────────────────────────────────────────
  console.log(`\nBY FILL PRICE (NO entry price):`)
  const priceBuckets = [
    ['entry ≤10¢',  bets.filter(b => b.fill_price != null && b.fill_price <= 0.10)],
    ['entry 11-20¢',bets.filter(b => b.fill_price != null && b.fill_price > 0.10 && b.fill_price <= 0.20)],
    ['entry 21-35¢',bets.filter(b => b.fill_price != null && b.fill_price > 0.20 && b.fill_price <= 0.35)],
    ['entry >35¢',  bets.filter(b => b.fill_price != null && b.fill_price > 0.35)],
    ['no fill data',bets.filter(b => b.fill_price == null)],
  ]
  for (const [label, arr] of priceBuckets) printStats(label, arr)

  // ── Recent bets detail ───────────────────────────────────────────────────────
  if (real.length > 0) {
    console.log(`\nRECENT REAL-MONEY DEAD-PATH BETS (last 20):`)
    console.log(`  ${'Date'.padEnd(11)} ${'Pitcher'.padEnd(22)} ${'Strike'.padEnd(8)} ${'λ'.padEnd(6)} ${'Fill'.padEnd(7)} ${'AK'.padEnd(5)} ${'Result'.padEnd(8)} PnL`)
    for (const b of real.slice(0, 20)) {
      const fp  = b.fill_price != null ? (b.fill_price * 100).toFixed(0) + '¢' : '?'
      const ak  = b.actual_ks != null ? String(b.actual_ks) : '?'
      const lam = b.lambda    != null ? b.lambda.toFixed(1) : '?'
      const pnl = b.pnl       != null ? (b.pnl >= 0 ? '+' : '') + fmtUsd(b.pnl) : '?'
      console.log(`  ${b.bet_date.padEnd(11)} ${b.pitcher_name.padEnd(22)} NO ${String(b.strike).padEnd(6)} ${lam.padEnd(6)} ${fp.padEnd(7)} ${ak.padEnd(5)} ${(b.result||'?').padEnd(8)} ${pnl}`)
    }
  }

  // ── Key insight ──────────────────────────────────────────────────────────────
  const s = stats(real)
  if (s.n > 0) {
    console.log(`\nINSIGHT:`)
    if (s.winRate != null && s.roi != null) {
      const sentiment = s.roi > 0.05 ? '✓ profitable strategy' : s.roi > 0 ? '~ marginally profitable' : '✗ losing strategy'
      console.log(`  ${sentiment}: ${fmtPct(s.wins, s.n)} win rate, ${(s.roi * 100).toFixed(1)}% ROI on real money`)
    }
    const highConfBets = real.filter(b => b.model_prob >= 0.85)
    if (highConfBets.length > 0) {
      const hs = stats(highConfBets)
      console.log(`  High-confidence (≥85% prob): ${fmtPct(hs.wins, hs.n)} wins, ${hs.roi != null ? (hs.roi*100).toFixed(1) + '% ROI' : ''}`)
    }
  }
  console.log('')

  await db.close()
}

main().catch(err => { console.error(err); process.exit(1) })
