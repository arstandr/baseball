// lib/kalshiPositionSync.js — Full Kalshi ↔ ks_bets reconciliation.
//
// Kalshi is the source of truth. On each run:
//
//   1. Fetch open positions  — what contracts are actually held right now
//   2. Fetch resting orders  — what orders are still live on the book
//   3. For each ks_bets row (today, paper=0, not yet settled):
//        - Position found → sync filled_contracts to Kalshi's count
//        - No position but resting order → still pending, leave alone
//        - No position, no resting order, filled_contracts=0 → cancelled/unfilled
//          → flip back to paper=1 so it stops appearing as a real bet
//   4. For each Kalshi position with no matching ks_bets row:
//        - Fetch market title to parse pitcher name + strike threshold
//        - Get average fill price from fills API
//        - Insert new ks_bets row (paper=0)

import * as db from './db.js'
import { getMarketPositions, getMarket, getFills, listOrders } from './kalshi.js'

const MONTHS = { JAN:1, FEB:2, MAR:3, APR:4, MAY:5, JUN:6, JUL:7, AUG:8, SEP:9, OCT:10, NOV:11, DEC:12 }

const _lastSync = new Map()
const SYNC_INTERVAL = 60_000

export async function reconcilePositionsForBettor(user) {
  if (!user?.kalshi_key_id || !user?.kalshi_private_key) return
  const now = Date.now()
  if (now - (_lastSync.get(user.id) || 0) < SYNC_INTERVAL) return
  _lastSync.set(user.id, now)

  const creds   = { keyId: user.kalshi_key_id, privateKey: user.kalshi_private_key }
  const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })

  // ── 1. Pull Kalshi state in parallel ────────────────────────────────────────
  let allPositions = null, allOrders = null
  try {
    ;[allPositions, allOrders] = await Promise.all([
      getMarketPositions(creds),
      listOrders({ status: 'resting', limit: 200 }, creds),
    ])
  } catch (err) {
    // Either API failed — abort entirely; never reconcile with incomplete data
    // (an empty resting-order list would falsely cancel pending bets)
    console.warn(`[pos-sync] Kalshi API error for user ${user.id}, skipping reconciliation: ${err.message}`)
    return
  }

  // Filter to today's KXMLBKS positions (net non-zero)
  const todayPositions = allPositions.filter(p => _isTodayKs(p.ticker, todayET) && Number(p.position_fp ?? 0) !== 0)

  // Resting-order tickers for today (used to protect pending orders from cancellation)
  const restingTickers = new Set(
    allOrders
      .filter(o => _isTodayKs(o.ticker, todayET))
      .map(o => o.ticker)
  )

  // Build a map: ticker → { side, contracts } for quick lookup
  const posMap = new Map()
  for (const p of todayPositions) {
    const netPos    = Number(p.position_fp ?? 0)
    const side      = netPos > 0 ? 'YES' : 'NO'
    const contracts = Math.round(Math.abs(netPos))
    posMap.set(p.ticker, { side, contracts })
  }

  // ── 2. Existing ks_bets rows for today ─────────────────────────────────────
  const dbBets = await db.all(
    `SELECT id, ticker, pitcher_name, strike, side, filled_contracts, paper, order_id, order_status
     FROM ks_bets
     WHERE bet_date = ? AND live_bet = 0 AND result IS NULL AND user_id = ?`,
    [todayET, user.id],
  ).catch(() => [])

  const matchedTickers = new Set()

  for (const bet of dbBets) {
    const ticker = bet.ticker

    if (ticker && posMap.has(ticker)) {
      // ── Case A: position exists — sync contract count ──────────────────────
      matchedTickers.add(ticker)
      const { contracts } = posMap.get(ticker)
      const needsUpdate = bet.paper !== 0 || (bet.filled_contracts ?? 0) !== contracts
      if (needsUpdate) {
        await db.run(
          `UPDATE ks_bets
           SET paper = 0,
               filled_contracts = ?,
               order_status = CASE WHEN order_status IS NULL OR order_status = 'resting'
                              THEN 'filled' ELSE order_status END
           WHERE id = ?`,
          [contracts, bet.id],
        )
        console.log(`[pos-sync] synced ${bet.pitcher_name} ${bet.side} ${bet.strike}+: filled_contracts=${contracts}`)
      }
    } else if (bet.paper === 0 && (bet.filled_contracts ?? 0) === 0) {
      // ── Case B: no position and nothing filled ─────────────────────────────
      // Check if there's still a resting order for this ticker (it just hasn't filled yet)
      const isResting = ticker ? restingTickers.has(ticker) : false
      if (!isResting) {
        // Order cancelled or never placed — flip back to paper so it's hidden from real bets
        await db.run(
          `UPDATE ks_bets SET paper = 1, order_status = 'cancelled' WHERE id = ?`,
          [bet.id],
        )
        console.log(`[pos-sync] cancelled unfilled bet ${bet.id}: ${bet.pitcher_name} ${bet.side} ${bet.strike}+`)
      }
    }
    // Case C: paper=0, filled_contracts>0, no position → game may have settled
    // (position vanishes after settlement); leave alone — result/pnl logic handles it
  }

  // ── 3. New positions not in DB ─────────────────────────────────────────────
  const newPositions = todayPositions.filter(p => !matchedTickers.has(p.ticker))
  if (!newPositions.length) return

  console.log(`[pos-sync] ${newPositions.length} new position(s) to create for user ${user.id}`)

  for (const pos of newPositions) {
    try {
      await _createRowForPosition(pos, user, creds, todayET)
    } catch (err) {
      console.warn(`[pos-sync] ${pos.ticker}: ${err.message}`)
    }
  }
}

async function _createRowForPosition(pos, user, creds, betDate) {
  const ticker    = pos.ticker
  const netPos    = Number(pos.position_fp ?? 0)
  const side      = netPos > 0 ? 'YES' : 'NO'
  const contracts = Math.round(Math.abs(netPos))

  // Market title → pitcher name + strike
  const market = await getMarket(ticker, creds)
  const title  = market?.title ?? null
  const tm     = title?.match(/^(.+?):\s*(\d+)\+\s*strikeouts?/i)
  if (!tm) {
    console.warn(`[pos-sync] unparseable title for ${ticker}: "${title}"`)
    return
  }
  const pitcherName = tm[1].trim()
  const strike      = parseInt(tm[2], 10)

  // Average fill price from fills API
  let fillPriceCents = null
  try {
    const fills = await getFills({ ticker, limit: 50 }, creds)
    if (fills.length) {
      let totalCost = 0, totalQty = 0
      for (const f of fills) {
        const qty   = Math.abs(Number(f.count ?? f.count_fp ?? 1))
        const prStr = side === 'YES' ? f.yes_price_dollars : f.no_price_dollars
        const price = prStr != null ? parseFloat(prStr) * 100 : 50
        totalCost += price * qty
        totalQty  += qty
      }
      if (totalQty > 0) fillPriceCents = Math.round(totalCost / totalQty)
    }
  } catch { /* optional */ }

  // Pitcher ID from any existing bet with that name
  const pitcherRow = await db.one(
    `SELECT pitcher_id FROM ks_bets WHERE pitcher_name = ? AND pitcher_id IS NOT NULL LIMIT 1`,
    [pitcherName],
  ).catch(() => null)

  // Insert or patch on conflict (e.g. row exists but ticker column was NULL)
  await db.run(
    `INSERT INTO ks_bets
       (bet_date, logged_at, pitcher_id, pitcher_name, strike, side,
        model_prob, edge, ticker, filled_contracts, fill_price,
        market_mid, paper, live_bet, order_status, user_id)
     VALUES (?, ?, ?, ?, ?, ?, 0.5, 0, ?, ?, ?, ?, 0, 0, 'filled', ?)
     ON CONFLICT(bet_date, pitcher_name, strike, side, live_bet, user_id) DO UPDATE SET
       paper            = 0,
       filled_contracts = MAX(excluded.filled_contracts, COALESCE(filled_contracts, 0)),
       fill_price       = COALESCE(fill_price, excluded.fill_price),
       ticker           = COALESCE(ticker, excluded.ticker),
       order_status     = CASE WHEN order_status IS NULL OR order_status = 'resting'
                          THEN 'filled' ELSE order_status END`,
    [betDate, new Date().toISOString(), pitcherRow?.pitcher_id ?? null,
     pitcherName, strike, side,
     ticker, contracts, fillPriceCents, fillPriceCents, user.id],
  )

  console.log(`[pos-sync] created: ${pitcherName} ${side} ${strike}+ (${contracts} contracts, fill=${fillPriceCents}¢, ticker=${ticker})`)
}

function _isTodayKs(ticker, todayET) {
  if (!ticker?.startsWith('KXMLBKS-')) return false
  const datePart = ticker.split('-')[1]
  const m = datePart?.match(/^(\d{2})([A-Z]{3})(\d{2})/)
  if (!m) return false
  const month = MONTHS[m[2]]
  if (!month) return false
  const year = 2000 + parseInt(m[1])
  const day  = parseInt(m[3])
  const ds   = `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`
  return ds === todayET
}
