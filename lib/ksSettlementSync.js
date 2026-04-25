// lib/ksSettlementSync.js — Kalshi settlement reconciliation.
//
// Each user has their own Kalshi account (separate kalshi_key_id/kalshi_private_key).
// P&L is computed from fills + settlements directly so it always matches the actual
// Kalshi balance change, even for bets placed outside the system.
//
// All-time P&L → users.kalshi_pnl
// Daily P&L    → daily_pnl_events (keyed by fill date = day the bet was placed)
//
// Settlement fields:
//   ticker       — matches ks_bets.ticker
//   revenue      — cents paid out (e.g. 44700 = $447.00)
//   fee_cost     — Kalshi fees in dollars
//   settled_time — ISO timestamp

import * as db from './db.js'
import { getAllSettlements, getFills, getBalance } from './kalshi.js'

const _lastSync = new Map()
const SYNC_INTERVAL = 60_000  // max once per minute per user

function toETDate(isoTs) {
  return new Date(isoTs).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
}

export async function syncSettlementsForUser(user) {
  if (!user?.kalshi_key_id || !user?.kalshi_private_key) return
  const now = Date.now()
  if (now - (_lastSync.get(user.id) || 0) < SYNC_INTERVAL) return
  _lastSync.set(user.id, now)

  const creds = { keyId: user.kalshi_key_id, privateKey: user.kalshi_private_key }

  const [settlements, fills, bal] = await Promise.all([
    getAllSettlements(creds).catch(() => null),
    getFills({ limit: 1000 }, creds).catch(() => []),
    getBalance(creds).catch(() => null),
  ])
  if (!settlements?.length) return

  // Store current balance
  if (bal) {
    await db.run(
      `UPDATE users SET kalshi_balance = ?, kalshi_cash = ?, kalshi_exposure = ? WHERE id = ?`,
      [bal.balance_usd, bal.cash_usd, bal.exposure_usd, user.id],
    ).catch(() => {})
  }

  // Build cost and fill-date per ticker from actual fills
  const fillCostByTicker = {}
  const fillDateByTicker = {}
  for (const f of fills) {
    if (!f.ticker || !f.created_time) continue
    // For sell fills (e.g. closing a NO position), Kalshi records side='yes' action='sell'.
    // The actual proceeds received = no_price_dollars (opposite of the recorded side).
    // Subtract sell proceeds from fillCost so cost basis reflects net cash spent.
    const isBuy = f.action === 'buy'
    const price = isBuy
      ? (f.side === 'yes' ? parseFloat(f.yes_price_dollars || 0) : parseFloat(f.no_price_dollars || 0))
      : (f.side === 'yes' ? parseFloat(f.no_price_dollars || 0) : parseFloat(f.yes_price_dollars || 0))
    const cost = parseFloat(f.count_fp || 0) * price
    fillCostByTicker[f.ticker] = (fillCostByTicker[f.ticker] || 0) + (isBuy ? cost : -cost)
    // Use earliest fill date as the bet date for this ticker
    const fillDate = toETDate(f.created_time)
    if (!fillDateByTicker[f.ticker] || fillDate < fillDateByTicker[f.ticker]) {
      fillDateByTicker[f.ticker] = fillDate
    }
  }

  // Aggregate P&L by date and all-time
  let kalshiPnl = 0
  const dailyPnl = {}  // { 'YYYY-MM-DD': { pnlByTicker: { ticker: pnl } } }

  for (const s of settlements) {
    if (!s.ticker) continue
    // Kalshi REST API returns revenue=0 when account holds both YES+NO of the same market.
    // Use yes_count × value + no_count × (1-value) which matches the API for all normal cases
    // and correctly computes the payout for the mixed-holdings edge case.
    const valueFrac = Number(s.value || 0) / 100
    const revenue   = parseFloat(s.yes_count_fp || 0) * valueFrac
                    + parseFloat(s.no_count_fp  || 0) * (1 - valueFrac)
    const fees     = parseFloat(s.fee_cost || 0)
    const fillCost = fillCostByTicker[s.ticker] || 0
    const pnl      = Math.round((revenue - fillCost - fees) * 100) / 100

    kalshiPnl += pnl

    // Attribute to fill date (day bet was placed) — falls back to settlement date
    const date = fillDateByTicker[s.ticker] || toETDate(s.settled_time)
    if (!dailyPnl[date]) dailyPnl[date] = {}
    dailyPnl[date][s.ticker] = pnl
  }

  kalshiPnl = Math.round(kalshiPnl * 100) / 100
  await db.run(`UPDATE users SET kalshi_pnl = ? WHERE id = ?`, [kalshiPnl, user.id]).catch(() => {})

  // Rebuild daily_pnl_events from scratch — clear old rows first to avoid stale date groupings
  await db.run(`DELETE FROM daily_pnl_events WHERE user_id = ?`, [user.id]).catch(() => {})
  for (const [date, tickers] of Object.entries(dailyPnl)) {
    for (const [ticker, pnl] of Object.entries(tickers)) {
      await db.run(
        `INSERT INTO daily_pnl_events (user_id, date, ticker, pnl_usd, settled_at) VALUES (?, ?, ?, ?, ?)`,
        [user.id, date, ticker, pnl, null],
      ).catch(() => {})
    }
  }

  // Set result for bets that Kalshi has settled but our live-game detector hasn't caught yet
  let newSettled = 0
  const nowIso = new Date().toISOString()
  for (const s of settlements) {
    if (!s.ticker || s.value == null) continue
    const valueFrac = Number(s.value) / 100
    if (valueFrac !== 0 && valueFrac !== 1) continue  // skip non-binary markets

    const unsettledBets = await db.all(
      `SELECT id, side, bet_size, fill_price, filled_contracts, spread, market_mid
       FROM ks_bets WHERE ticker = ? AND user_id = ? AND result IS NULL AND paper = 0`,
      [s.ticker, user.id],
    ).catch(() => [])

    for (const b of unsettledBets) {
      const won      = b.side === 'YES' ? valueFrac === 1 : valueFrac === 0
      const FEE      = 0.07
      const contracts = b.filled_contracts || 0
      if (!contracts) {
        // No fill data yet — can't compute accurate P&L. reconcileLiveFills will backfill
        // filled_contracts; ksSettlementSync will pick it up on the next run.
        console.warn(`[kalshi-settle] bet ${b.id} (${b.side} ${s.ticker}): no filled_contracts — skipping until reconciled`)
        continue
      }
      const mid      = (b.market_mid ?? 50) / 100
      const hs       = (b.spread ?? 4) / 200
      const fill     = b.side === 'YES' ? mid + hs : (1 - mid) + hs
      const fillFrac = b.fill_price != null ? b.fill_price / 100 : fill
      const size     = contracts
      const pnl      = won
        ? Math.round(size * (1 - fillFrac) * (1 - FEE) * 100) / 100
        : -Math.round(size * fillFrac * 100) / 100
      const rows = await db.run(
        `UPDATE ks_bets SET result=?, pnl=?, settled_at=? WHERE id=? AND result IS NULL`,
        [won ? 'win' : 'loss', pnl, nowIso, b.id],
      ).catch(() => null)
      if (rows?.rowsAffected ?? 1) {
        console.log(`[kalshi-settle] user ${user.id} ${b.side} on ${s.ticker}: ${won ? 'WIN' : 'LOSS'} $${pnl.toFixed(2)}`)
        newSettled++
      }
    }
  }

  // Update per-bet P&L in ks_bets for individual row display
  let updated = 0, unmatched = 0
  for (const s of settlements) {
    if (!s.ticker) continue
    const bets = await db.all(
      `SELECT id, filled_contracts, pnl
       FROM ks_bets WHERE ticker = ? AND user_id = ? AND result IS NOT NULL AND result != 'void'`,
      [s.ticker, user.id],
    )
    if (!bets.length) { unmatched++; continue }

    const valueFrac2 = Number(s.value || 0) / 100
    const revenue2   = parseFloat(s.yes_count_fp || 0) * valueFrac2
                     + parseFloat(s.no_count_fp  || 0) * (1 - valueFrac2)
    const fees     = parseFloat(s.fee_cost || 0)
    const fillCost = fillCostByTicker[s.ticker] || 0
    const tickerPnl = revenue2 - fillCost - fees

    const totalContracts = bets.reduce((sum, b) => sum + (b.filled_contracts || 0), 0)
    for (const bet of bets) {
      const share  = totalContracts > 0 ? (bet.filled_contracts || 0) / totalContracts : 1 / bets.length
      const betPnl = Math.round(tickerPnl * share * 100) / 100
      if (Math.abs(betPnl - (bet.pnl || 0)) > 0.01) {
        await db.run(`UPDATE ks_bets SET pnl = ? WHERE id = ?`, [betPnl, bet.id])
        updated++
      }
    }
  }

  if (updated > 0 || unmatched > 0) {
    console.log(`[settlement-sync] user ${user.id}: kalshi_pnl=$${kalshiPnl} updated=${updated} unmatched=${unmatched}`)
  }

  return { updated, unmatched, newSettled, kalshiPnl, totalSettlements: settlements.length }
}

// Force sync regardless of rate limit — for reconcile endpoint
export async function forceSync(user) {
  _lastSync.delete(user.id)
  return syncSettlementsForUser(user)
}
