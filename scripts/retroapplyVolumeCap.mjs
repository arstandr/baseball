// One-time retroactive volume cap on Day 1 fade fires (2026-05-07).
//
// Pre-deploy of the 10% volume cap, several fires went out at unrealistic
// contract counts (e.g., Lugo 1631c on a market with $227 daily volume).
// This script:
//   1. For each fade fire on the target date, pulls market's 24h volume
//   2. Computes max_realistic_contracts = 10% × (volume_24h / ask_price)
//   3. Caps each fire's contracts at that limit
//   4. Recomputes filled_contracts, fill_price (unchanged), and pnl
//      proportional to the new contract count, preserving win/loss outcome
//   5. Updates ks_bets rows in place
//
// Idempotent: if contracts already <= cap, no change.

import 'dotenv/config'
import { createClient } from '@libsql/client'
import { authedRequest } from '../lib/kalshi.js'

const TARGET_DATE = process.argv[2] ?? '2026-05-07'
const FEE = 0.07
const MAX_PCT_OF_VOLUME = 0.10
const MIN_FILLABLE = 50

const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })

const fires = await db.execute({
  sql: `SELECT id, pitcher_name, ticker, side, strike, fill_price, filled_contracts, result, pnl, actual_ks
        FROM ks_bets WHERE strategy_mode='pregame_fade_yes' AND bet_date=?
        ORDER BY logged_at`,
  args: [TARGET_DATE],
})
console.log(`Re-capping ${fires.rows.length} fires from ${TARGET_DATE} at ${MAX_PCT_OF_VOLUME * 100}% of 24h volume\n`)

console.log('pitcher              K≥  ask  orig_c  vol24$    daily_c  cap@10%  new_c  orig_pnl  new_pnl  delta')
console.log('─'.repeat(115))
let totalDeltaPnl = 0
for (const f of fires.rows) {
  const ask = Number(f.fill_price)
  const origC = Number(f.filled_contracts)
  const won = f.result === 'win'
  const lost = f.result === 'loss'

  // Pull market 24h volume
  const md = await authedRequest('GET', `/markets/${f.ticker}`).catch(() => null)
  const vol24Usd = parseFloat(md?.market?.volume_24h_fp ?? 0)
  const dailyContracts = vol24Usd > 0 ? Math.floor(vol24Usd / (ask / 100)) : 0
  const cap = Math.floor(dailyContracts * MAX_PCT_OF_VOLUME)

  let newC = origC
  if (cap > 0 && origC > cap) newC = Math.max(MIN_FILLABLE, cap)

  const origPnl = Number(f.pnl ?? 0)
  let newPnl = origPnl
  if (newC !== origC) {
    if (won) newPnl = newC * ((100 - ask) / 100) * (1 - FEE)
    else if (lost) newPnl = -newC * (ask / 100)
  }
  const deltaPnl = newPnl - origPnl
  totalDeltaPnl += deltaPnl

  console.log(`  ${(f.pitcher_name ?? '?').padEnd(20)} ${String(f.strike).padStart(2)}  ${String(ask).padStart(2)}c  ${String(origC).padStart(5)}c  $${Math.round(vol24Usd).toString().padStart(5)}  ${String(dailyContracts).padStart(5)}c   ${String(cap).padStart(5)}c    ${String(newC).padStart(5)}c   ${origPnl >= 0 ? '+' : ''}$${origPnl.toFixed(0)}    ${newPnl >= 0 ? '+' : ''}$${newPnl.toFixed(0)}    ${deltaPnl >= 0 ? '+' : ''}$${deltaPnl.toFixed(0)}`)

  if (newC !== origC) {
    await db.execute({
      sql: `UPDATE ks_bets SET filled_contracts = ?, pnl = ? WHERE id = ?`,
      args: [newC, Math.round(newPnl * 100) / 100, f.id],
    })
  }
}

console.log()
console.log(`Total Δ P&L: ${totalDeltaPnl >= 0 ? '+' : ''}$${totalDeltaPnl.toFixed(2)}`)

// Recompute new bankroll
const r = await db.execute(`SELECT ROUND(SUM(pnl), 2) AS total FROM ks_bets WHERE strategy_mode='pregame_fade_yes' AND result IN ('win','loss')`)
const newBank = 5000 + Number(r.rows[0].total ?? 0)
console.log(`Updated bankroll: $${newBank.toFixed(2)} (${newBank >= 5000 ? '+' : ''}${((newBank - 5000) / 5000 * 100).toFixed(1)}% from $5K start)`)
