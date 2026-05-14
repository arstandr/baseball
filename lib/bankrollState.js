// lib/bankrollState.js — Live available pool tracker feeding directly into Kelly sizing.
//
// Architecture: daily singleton row in bankroll_state table.
//   morning_bankroll  = starting balance (set at init from Kalshi or STARTING_BANKROLL env)
//   committed_capital = sum of open position risk (all bets not yet settled)
//   realized_pnl      = net from settled bets today
//   unrealized_pnl    = estimated current value of open positions
//   available_pool    = morning_bankroll + realized_pnl - committed_capital
//
// All writes use atomic SQL UPDATE (no in-memory accumulation) to prevent
// race conditions when Railway and The Closer both run concurrently.
//
// Kelly integration: ksBets reads getAvailablePool() instead of static
// STARTING_BANKROLL env var. This means afternoon bets automatically account
// for what morning bets already committed.
//
// Usage:
//   import { initBankrollState, getAvailablePool, addCommitted, addRealized, releaseCommitted } from './bankrollState.js'

import * as db from './db.js'
import { getBalance as getKalshiBalance } from './kalshi.js'

// ── Init: create or refresh daily row ────────────────────────────────────────
// Called at server startup and at 3am for the new day.
// morningBankroll: if null, fetches live Kalshi balance.

export async function initBankrollState(date, morningBankroll = null) {
  let bankroll = morningBankroll
  // In paper mode, the real Kalshi balance is irrelevant — we want paper-bankroll
  // compounding off prior-day P&L. Earlier behavior (May 13 bug): live-balance fetch
  // returned Isaiah's real $513.54 every morning and stomped the prior day's paper P&L.
  const PAPER = String(process.env.KALSHI_PAPER_MODE || '').toLowerCase() === 'true'
  if (bankroll == null && !PAPER) {
    // 1) Live mode: prefer the active live bettor's real Kalshi balance.
    try {
      const liveUser = await db.one(
        `SELECT kalshi_key_id, kalshi_private_key FROM users
         WHERE active_bettor=1 AND paper=0 AND kalshi_key_id IS NOT NULL LIMIT 1`,
      )
      if (liveUser?.kalshi_key_id) {
        const creds = { keyId: liveUser.kalshi_key_id, privateKey: liveUser.kalshi_private_key }
        const bal = await getKalshiBalance(creds).catch(() => null)
        if (bal?.balance_usd != null) bankroll = bal.balance_usd
      }
    } catch {}
  }
  if (bankroll == null) {

    // 2) Paper mode / no live balance: roll over from the prior day's ending balance
    //    so the bankroll compounds day-to-day with no manual edits.
    //    ending = prior morning_bankroll + net P&L of that day's settled bets.
    if (bankroll == null) {
      try {
        const prev = await db.one(
          `SELECT bet_date, morning_bankroll FROM bankroll_state
           WHERE bet_date < ? ORDER BY bet_date DESC LIMIT 1`,
          [date],
        )
        if (prev?.morning_bankroll != null) {
          const pnlRow = await db.one(
            `SELECT COALESCE(SUM(pnl),0) AS pnl FROM ks_bets
             WHERE bet_date = ? AND result IS NOT NULL AND result != 'void'`,
            [prev.bet_date],
          ).catch(() => ({ pnl: 0 }))
          const dayPnl = Number(pnlRow?.pnl ?? 0)
          bankroll = Number(prev.morning_bankroll) + dayPnl
          console.log(`[bankrollState] rollover ${prev.bet_date} $${Number(prev.morning_bankroll).toFixed(2)} ${dayPnl >= 0 ? '+' : '-'}$${Math.abs(dayPnl).toFixed(2)} → ${date} $${bankroll.toFixed(2)}`)
        }
      } catch {}
    }

    // 3) Last resort: configured starting bankroll, then env default.
    if (bankroll == null) {
      const u = await db.one(
        `SELECT starting_bankroll FROM users ORDER BY (active_bettor=1) DESC, id ASC LIMIT 1`,
      ).catch(() => null)
      bankroll = u?.starting_bankroll ?? Number(process.env.STARTING_BANKROLL || 5000)
    }
  }

  // INSERT if new day; update morning_bankroll if already exists but bankroll changed.
  // NEVER decrease morning_bankroll after init (session-start anchor).
  await db.run(
    `INSERT OR IGNORE INTO bankroll_state (bet_date, morning_bankroll, committed_capital, realized_pnl, unrealized_pnl, available_pool, last_updated)
     VALUES (?, ?, 0, 0, 0, ?, ?)`,
    [date, bankroll, bankroll, Date.now()],
  )

  // Recompute available_pool from current committed+realized to ensure it's fresh
  await _recomputeAvailablePool(date)

  console.log(`[bankrollState] ${date}: morning=$${bankroll.toFixed(2)}  available=${(await getAvailablePool(date)).toFixed(2)}`)
}

// ── Atomic available_pool recompute ───────────────────────────────────────────

async function _recomputeAvailablePool(date) {
  await db.run(
    `UPDATE bankroll_state
     SET available_pool = morning_bankroll + realized_pnl - committed_capital,
         last_updated   = ?
     WHERE bet_date = ?`,
    [Date.now(), date],
  ).catch(() => {})
}

// ── Get per-user available pool ───────────────────────────────────────────────
// Uses each user's own Kalshi balance (stored in users.kalshi_balance) minus
// their own committed capital from ks_bets. Avoids shared-pool contamination
// between multi-user accounts.

export async function getPerUserAvailablePool(date, userId) {
  try {
    const user = await db.one(
      `SELECT kalshi_balance, starting_bankroll FROM users WHERE id=?`, [userId],
    ).catch(() => null)
    const base = user?.kalshi_balance ?? user?.starting_bankroll ?? Number(process.env.STARTING_BANKROLL || 5000)
    const committedRow = await db.one(
      `SELECT COALESCE(SUM(capital_at_risk), 0) as c FROM ks_bets
       WHERE bet_date=? AND user_id=? AND result IS NULL AND paper=0
         AND order_status NOT IN ('cancelled','void')`,
      [date, userId],
    ).catch(() => ({ c: 0 }))
    return Math.max(0, base - (committedRow?.c ?? 0))
  } catch {
    return Number(process.env.STARTING_BANKROLL || 5000)
  }
}

// ── Get available pool for Kelly ──────────────────────────────────────────────

export async function getAvailablePool(date) {
  const row = await db.one(
    `SELECT available_pool, morning_bankroll, committed_capital, realized_pnl FROM bankroll_state WHERE bet_date=?`,
    [date],
  ).catch(() => null)
  if (!row) return Number(process.env.STARTING_BANKROLL || 5000)

  // available_pool can go stale if committed/realized updated without recompute
  // Derive fresh value on the fly as safety net
  const fresh = (row.morning_bankroll ?? 0) + (row.realized_pnl ?? 0) - (row.committed_capital ?? 0)
  return Math.max(0, fresh)
}

// ── Add to committed (when bet placed) ───────────────────────────────────────
// Atomic SQL: no race condition even with concurrent writes.

export async function addCommitted(date, amount) {
  if (!amount || amount <= 0) return
  await db.run(
    `UPDATE bankroll_state
     SET committed_capital = committed_capital + ?,
         available_pool    = morning_bankroll + realized_pnl - (committed_capital + ?),
         last_updated      = ?
     WHERE bet_date = ?`,
    [amount, amount, Date.now(), date],
  ).catch(() => {})
}

// ── Release committed (when bet cancelled or void) ────────────────────────────

export async function releaseCommitted(date, amount) {
  if (!amount || amount <= 0) return
  await db.run(
    `UPDATE bankroll_state
     SET committed_capital = MAX(0, committed_capital - ?),
         available_pool    = morning_bankroll + realized_pnl - MAX(0, committed_capital - ?),
         last_updated      = ?
     WHERE bet_date = ?`,
    [amount, amount, Date.now(), date],
  ).catch(() => {})
}

// ── Add realized P&L (when bet settles) ──────────────────────────────────────

export async function addRealized(date, pnl, committedToRelease = 0) {
  // On settlement: add P&L to realized, release the committed capital for that bet
  await db.run(
    `UPDATE bankroll_state
     SET realized_pnl      = realized_pnl + ?,
         committed_capital = MAX(0, committed_capital - ?),
         available_pool    = morning_bankroll + (realized_pnl + ?) - MAX(0, committed_capital - ?),
         last_updated      = ?
     WHERE bet_date = ?`,
    [pnl, committedToRelease, pnl, committedToRelease, Date.now(), date],
  ).catch(() => {})
}

// ── Update unrealized P&L estimate ───────────────────────────────────────────
// Estimates open position value from current Kalshi mid vs entry price.
// Called periodically (not on every API call) — this is an estimate only.

export async function refreshUnrealizedPnl(date) {
  try {
    const openBets = await db.all(
      `SELECT fill_price, filled_contracts, market_mid, side, strike
       FROM ks_bets
       WHERE bet_date=? AND result IS NULL AND paper=0
         AND filled_contracts IS NOT NULL AND filled_contracts > 0`,
      [date],
    )
    if (!openBets.length) {
      await db.run(`UPDATE bankroll_state SET unrealized_pnl=0 WHERE bet_date=?`, [date])
      return 0
    }

    // We can't easily fetch all market mids without individual API calls.
    // Use a rough heuristic: if bet was filled at X¢ and market moved,
    // estimate unrealized = filled_contracts * (current_mid - fill_price) / 100.
    // Without live Kalshi price we skip this and show 0 — caller should fetch.
    // This is an informational metric, not used in Kelly sizing.
    return 0
  } catch { return 0 }
}

// ── Reconcile: recompute from ks_bets on demand ───────────────────────────────
// Call this after a crash-restart to ensure bankroll_state is accurate.

export async function reconcileBankrollState(date) {
  try {
    // Committed = sum of capital_at_risk for unsettled bets
    const committedRow = await db.one(
      `SELECT COALESCE(SUM(capital_at_risk),0) AS committed
       FROM ks_bets WHERE bet_date=? AND result IS NULL AND paper=0
         AND (order_status IS NULL OR order_status NOT IN ('cancelled','void'))`,
      [date],
    ).catch(() => ({ committed: 0 }))

    // Realized = sum of pnl for settled bets
    const realizedRow = await db.one(
      `SELECT COALESCE(SUM(pnl),0) AS realized
       FROM ks_bets WHERE bet_date=? AND result IN ('win','loss') AND paper=0`,
      [date],
    ).catch(() => ({ realized: 0 }))

    const committed = committedRow?.committed ?? 0
    const realized  = realizedRow?.realized  ?? 0

    await db.run(
      `UPDATE bankroll_state
       SET committed_capital=?, realized_pnl=?,
           available_pool=morning_bankroll + ? - ?,
           last_updated=?
       WHERE bet_date=?`,
      [committed, realized, realized, committed, Date.now(), date],
    )

    console.log(`[bankrollState] reconciled ${date}: committed=$${committed.toFixed(2)} realized=${realized >= 0 ? '+' : ''}$${realized.toFixed(2)}`)
  } catch (err) {
    console.error(`[bankrollState] reconcile error: ${err.message}`)
  }
}

// ── Get full state snapshot ───────────────────────────────────────────────────

export async function getBankrollState(date) {
  return db.one(`SELECT * FROM bankroll_state WHERE bet_date=?`, [date]).catch(() => null)
}
