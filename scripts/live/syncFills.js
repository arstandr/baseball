// scripts/live/syncFills.js — Sync Kalshi fill data for all active bettors.
//
// Calls getOrder() for every today's resting/unconfirmed order and updates
// filled_contracts, order_status, fill_price in ks_bets.
//
// Runs from dailyRun.sh in morning, midday, and settle modes so fills are
// accurate before repricing or P&L settlement.
//
// Usage:
//   node scripts/live/syncFills.js [--date YYYY-MM-DD]

import 'dotenv/config'
import * as db from '../../lib/db.js'
import { forceSyncFillsForBettor } from '../../lib/ksFillSync.js'

const args = process.argv.slice(2)
const DATE = args.includes('--date') ? args[args.indexOf('--date') + 1] : new Date().toISOString().slice(0, 10)

async function main() {
  await db.migrate()

  const bettors = await db.all(
    `SELECT id, name, kalshi_key_id, kalshi_private_key
     FROM users
     WHERE active_bettor = 1 AND kalshi_key_id IS NOT NULL AND id != 1
     ORDER BY id`,
  )

  if (!bettors.length) {
    console.log('[sync-fills] No active bettors with Kalshi credentials')
    await db.close()
    return
  }

  // Count how many orders need checking per bettor
  for (const u of bettors) {
    const pending = await db.all(
      `SELECT COUNT(*) as n FROM ks_bets
       WHERE user_id = ? AND bet_date = ? AND order_id IS NOT NULL
         AND result IS NULL
         AND (order_status = 'resting' OR order_status IS NULL OR filled_contracts IS NULL OR filled_contracts = 0)`,
      [u.id, DATE],
    )
    const n = pending[0]?.n ?? 0
    if (!n) {
      console.log(`[sync-fills] ${u.name}: no pending orders to sync`)
      continue
    }

    console.log(`[sync-fills] ${u.name}: syncing ${n} order(s) for ${DATE}...`)

    // forceSyncFillsForBettor bypasses the 15s rate-limit guard
    // but ksFillSync queries date('now') — temporarily override if needed
    if (DATE !== new Date().toISOString().slice(0, 10)) {
      // For non-today dates, run directly without the ksFillSync helper
      // (ksFillSync hardcodes date('now'))
      await syncForDate(u, DATE)
    } else {
      await forceSyncFillsForBettor(u)
    }
  }

  console.log('[sync-fills] Done')
  await db.close()
}

// Direct sync for historical dates (ksFillSync only queries today)
async function syncForDate(user, date) {
  const { getOrder } = await import('../../lib/kalshi.js')
  const creds = { keyId: user.kalshi_key_id, privateKey: user.kalshi_private_key }

  const bets = await db.all(
    `SELECT id, order_id, ticker, filled_contracts, order_status, pitcher_name, strike, side
     FROM ks_bets
     WHERE user_id = ? AND bet_date = ? AND order_id IS NOT NULL AND result IS NULL
       AND (order_status = 'resting' OR order_status IS NULL OR filled_contracts IS NULL OR filled_contracts = 0)`,
    [user.id, date],
  )

  let updated = 0
  for (const bet of bets) {
    try {
      const order = await getOrder(bet.order_id, creds)
      if (!order) continue

      const filledCount    = Math.round(parseFloat(order.fill_count_fp ?? '0'))
      const newStatus      = order.status === 'executed'  ? 'filled'
                           : order.status === 'cancelled' ? 'cancelled'
                           : 'resting'
      const priceDollars   = order.yes_price_dollars ?? order.no_price_dollars ?? null
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
        console.log(`  [sync-fills] ${bet.pitcher_name} ${bet.side} ${bet.strike}+: filled=${filledCount} status=${newStatus}`)
        updated++
      }
    } catch (err) {
      console.error(`  [sync-fills] error bet ${bet.id} (${bet.ticker}): ${err.message}`)
    }
  }
  console.log(`[sync-fills] ${user.name}: ${updated} updated of ${bets.length} checked`)
}

main().catch(err => {
  console.error('[sync-fills] fatal:', err.message)
  process.exit(1)
})
