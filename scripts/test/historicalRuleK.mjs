// Test C — Historical P&L: simulate Rule K against ALL settled YES bets
// Filter: pre-game YES (live_bet=0, side='YES') with model_prob and market_mid
// For each bet, compute would Rule K BLOCK it. Aggregate per-day:
//   blockedWins, blockedLosses, blockedPnl
//   keptWins, keptLosses, keptPnl
// Show dates where Rule K REMOVED more wins than losses (downside).

import 'dotenv/config'
import * as db from '../../lib/db.js'

const yesPregameMinProb   = 0.45
const yesPregameMinProbHi = 0.65
const yesPregameMaxMid    = 35

function ruleKBlocks(prob, mid) {
  if (prob == null) return false
  const m = mid ?? 50
  if (prob < yesPregameMinProb) return true
  if (prob < yesPregameMinProbHi && m > yesPregameMaxMid) return true
  return false
}

const rows = await db.all(`
  SELECT bet_date, side, strike, model_prob, market_mid, pnl, result
  FROM ks_bets
  WHERE result IN ('win','loss')
    AND side = 'YES'
    AND live_bet = 0
  ORDER BY bet_date, strike
`)

const byDate = new Map()
for (const r of rows) {
  if (!byDate.has(r.bet_date)) byDate.set(r.bet_date, {
    date: r.bet_date,
    blockedWins: 0, blockedLosses: 0, blockedPnl: 0,
    keptWins: 0, keptLosses: 0, keptPnl: 0,
    totalRows: 0, ruleKApplicable: 0,
  })
  const e = byDate.get(r.bet_date)
  e.totalRows++
  // Skip rows missing required columns
  if (r.model_prob == null) continue
  e.ruleKApplicable++
  const blocked = ruleKBlocks(r.model_prob, r.market_mid)
  const pnl = Number(r.pnl ?? 0)
  if (blocked) {
    if (r.result === 'win') e.blockedWins++; else e.blockedLosses++
    e.blockedPnl += pnl
  } else {
    if (r.result === 'win') e.keptWins++; else e.keptLosses++
    e.keptPnl += pnl
  }
}

let agg = { blockedWins: 0, blockedLosses: 0, blockedPnl: 0, keptWins: 0, keptLosses: 0, keptPnl: 0 }
const downsideDates = []
for (const [, d] of byDate) {
  agg.blockedWins   += d.blockedWins
  agg.blockedLosses += d.blockedLosses
  agg.blockedPnl    += d.blockedPnl
  agg.keptWins      += d.keptWins
  agg.keptLosses    += d.keptLosses
  agg.keptPnl       += d.keptPnl
  // Rule K is "worse" on a date when removed bets had positive aggregate pnl
  if (d.blockedPnl > 0) downsideDates.push(d)
}

console.log('=== Per-date breakdown (only dates with blocks) ===')
const sorted = [...byDate.values()].filter(d => d.blockedWins + d.blockedLosses > 0)
                .sort((a,b) => a.date.localeCompare(b.date))
for (const d of sorted) {
  console.log(`${d.date}: ${d.totalRows} YES rows, blocked=${d.blockedWins}W/${d.blockedLosses}L pnl=$${d.blockedPnl.toFixed(2)}, kept=${d.keptWins}W/${d.keptLosses}L pnl=$${d.keptPnl.toFixed(2)}`)
}

console.log('\n=== Downside dates (Rule K removed positive-PnL bets) ===')
if (downsideDates.length === 0) {
  console.log('None — Rule K never removed net-positive bets')
} else {
  for (const d of downsideDates) {
    console.log(`${d.date}: blocked pnl=+$${d.blockedPnl.toFixed(2)} (${d.blockedWins}W/${d.blockedLosses}L)`)
  }
}

console.log('\n=== Aggregate ===')
console.log(`Pre-game YES bets total (with model_prob): rows=${rows.length}`)
console.log(`Rule K BLOCKED: ${agg.blockedWins} wins, ${agg.blockedLosses} losses, pnl=$${agg.blockedPnl.toFixed(2)}`)
console.log(`Rule K KEPT:    ${agg.keptWins} wins, ${agg.keptLosses} losses, pnl=$${agg.keptPnl.toFixed(2)}`)
console.log(`Net effect of running Rule K: spared ${agg.blockedLosses} losses, lost ${agg.blockedWins} wins, $$ delta = -${(agg.blockedPnl).toFixed(2)} (positive = Rule K cost us money)`)

process.exit(0)
