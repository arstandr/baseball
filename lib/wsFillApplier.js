import * as db from './db.js'
import { sseBus } from './sseBus.js'

export async function applyFillEvent(userId, payload) {
  const row = await db.one(
    'SELECT id, side, filled_contracts, fill_price, order_status FROM ks_bets WHERE order_id = ? AND user_id = ?',
    [payload.order_id, userId]
  )
  if (!row) return

  const filledAdd = Math.round(parseFloat(payload.count_fp ?? payload.count ?? '0'))
  const newFilled = (row.filled_contracts ?? 0) + filledAdd
  // Store price from the perspective of the side we purchased (YES price for YES bets, NO price for NO bets)
  const sidePriceDollars = row.side?.toUpperCase() === 'NO'
    ? (payload.no_price_dollars ?? payload.yes_price_dollars)
    : (payload.yes_price_dollars ?? payload.no_price_dollars)
  const priceCents = Math.round(parseFloat(sidePriceDollars ?? '0') * 100) || null

  let newPrice
  if (priceCents && row.fill_price && row.filled_contracts > 0) {
    newPrice = Math.round(
      ((row.fill_price * row.filled_contracts) + (priceCents * filledAdd)) / newFilled
    )
  } else {
    newPrice = priceCents ?? row.fill_price
  }

  await db.run(
    `UPDATE ks_bets
     SET filled_contracts = ?,
         fill_price = ?,
         filled_at = COALESCE(filled_at, ?),
         order_status = 'partial'
     WHERE order_id = ? AND user_id = ?`,
    [newFilled, newPrice, new Date().toISOString(), payload.order_id, userId]
  )

  console.log(`[ws-fill] ${row.id} +${filledAdd} contracts (total ${newFilled}) @ ${newPrice}¢`)
  sseBus.emit('fill_update', { betId: row.id, userId })
}

export async function applyOrderEvent(userId, payload) {
  const statusMap = {
    executed: 'filled',
    canceled: 'cancelled',
    cancelled: 'cancelled',
    partial_fill: 'partial',
  }
  const newStatus = statusMap[payload.status] ?? 'resting'
  const totalFilled = payload.fill_count_fp
    ? Math.round(parseFloat(payload.fill_count_fp))
    : null

  const row = await db.one(
    'SELECT id, order_status FROM ks_bets WHERE order_id = ? AND user_id = ?',
    [payload.order_id, userId]
  )
  if (!row) return

  if (totalFilled != null) {
    await db.run(
      'UPDATE ks_bets SET order_status = ?, filled_contracts = ? WHERE order_id = ? AND user_id = ?',
      [newStatus, totalFilled, payload.order_id, userId]
    )
  } else {
    await db.run(
      'UPDATE ks_bets SET order_status = ? WHERE order_id = ? AND user_id = ?',
      [newStatus, payload.order_id, userId]
    )
  }

  console.log(
    `[ws-order] ${row.id} status → ${newStatus}${totalFilled != null ? ` filled=${totalFilled}` : ''}`
  )
  sseBus.emit('fill_update', { betId: row.id, userId })
}

export async function applyPositionEvent(userId, payload) {
  // Only process fully closed positions — settlement closes position to 0
  if (parseFloat(payload.position_fp ?? '1') !== 0) return
  const pnl = parseFloat(payload.realized_pnl_dollars ?? 'NaN')
  if (isNaN(pnl)) return
  const ticker = payload.market_ticker
  if (!ticker) return

  const date = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })

  // INSERT OR IGNORE — idempotent if WS sends duplicate events
  await db.run(
    `INSERT OR IGNORE INTO daily_pnl_events (user_id, date, ticker, pnl_usd, settled_at)
     VALUES (?, ?, ?, ?, ?)`,
    [userId, date, ticker, pnl, new Date().toISOString()]
  )
  console.log(`[ws-position] user ${userId} settled ${ticker}: ${pnl >= 0 ? '+' : ''}$${Math.abs(pnl).toFixed(2)}`)
  sseBus.emit('pnl_update', { userId, ticker, pnl })
}
