// lib/ksFillSync.js — Sync actual Kalshi fill data into ks_bets.
//
// Called from /api/ks/live and /api/ks/daily on each request for today.
// For each active bettor with Kalshi credentials:
//   1. Fetch today's fills from Kalshi's /portfolio/fills
//   2. Call getOrder for each resting order to get fill_count_fp
//   3. Update filled_contracts + order_status in ks_bets
//
// Kalshi API field names (v2):
//   order.fill_count_fp      — filled contracts (string float, e.g. "149.00")
//   order.remaining_count_fp — remaining on book (string float)
//   order.status             — 'resting' | 'executed' | 'cancelled'
//   order.yes_price_dollars  — fill price in dollars (e.g. "0.18" = 18¢)
//   fill.count_fp            — contracts in this fill event
//   fill.yes_price_dollars   — price in dollars

import * as db from './db.js'
import { getFills, getOrder } from './kalshi.js'

// Dedupe — only sync once per N ms per bettor
const _lastSync = new Map()
const SYNC_INTERVAL = 15_000

// Force sync bypasses the rate-limit guard — use from pipeline scripts, not hot paths
export async function forceSyncFillsForBettor(user) {
  _lastSync.delete(user?.id)
  return syncFillsForBettor(user)
}

export async function syncFillsForBettor(user) {
  if (!user?.kalshi_key_id || !user?.kalshi_private_key) return
  const now = Date.now()
  if (now - (_lastSync.get(user.id) || 0) < SYNC_INTERVAL) return
  _lastSync.set(user.id, now)

  const creds = { keyId: user.kalshi_key_id, privateKey: user.kalshi_private_key }

  // All orders placed today that might need a fill update
  const bets = await db.all(
    `SELECT id, order_id, ticker, filled_contracts, order_status
     FROM ks_bets
     WHERE user_id = ? AND bet_date = date('now') AND order_id IS NOT NULL
       AND (order_status = 'resting' OR order_status IS NULL OR filled_contracts IS NULL OR filled_contracts = 0)`,
    [user.id],
  )
  if (!bets.length) return

  for (const bet of bets) {
    try {
      const order = await getOrder(bet.order_id, creds)
      if (!order) continue

      const filledCount  = Math.round(parseFloat(order.fill_count_fp ?? '0'))
      const remaining    = Math.round(parseFloat(order.remaining_count_fp ?? '0'))
      const newStatus    = order.status === 'executed'  ? 'filled'
                         : order.status === 'cancelled' ? 'cancelled'
                         : 'resting'

      // Price in dollars → cents
      const priceDollars = order.yes_price_dollars ?? order.no_price_dollars ?? null
      const fillPriceCents = priceDollars ? Math.round(parseFloat(priceDollars) * 100) : null

      const changed = filledCount !== (bet.filled_contracts ?? -1) || newStatus !== bet.order_status
      if (changed) {
        await db.run(
          `UPDATE ks_bets
           SET filled_contracts = ?, order_status = ?,
               fill_price = COALESCE(?, fill_price)
           WHERE id = ?`,
          [filledCount, newStatus, fillPriceCents, bet.id],
        )
        console.log(`[fill-sync] bet ${bet.id} ${bet.ticker}: filled=${filledCount} status=${newStatus}`)
      }
    } catch (err) {
      console.error(`[fill-sync] error bet ${bet.id}: ${err.message}`)
    }
  }
}
