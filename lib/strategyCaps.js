// lib/strategyCaps.js — per-user strategy cap + daily loss enforcement
//
// Hard guardrails that ksBets must consult BEFORE every order placement:
//   1. Per-user, per-pitcher, per-strategy_mode cap on $ at risk and bet count
//   2. Per-user, per-strategy_mode daily realized-loss cap
//   3. Global daily realized-loss cap (real-money rows only)
//
// Caps are inspected against the live ks_bets table; any helpers here are
// READ-ONLY. They never throw — failure is communicated via
// `{ allowed: false, reason }` so the caller can log + halt cleanly.
//
// strategy_mode is NOT NULL in ks_bets after backfill, but every query uses
// COALESCE(strategy_mode, '') for defensive parity with strategyMode.js.

import 'dotenv/config'

// ------------------------------------------------------------------
// Env-driven caps (all dollar values; bet counts are integers)
// ------------------------------------------------------------------
const INVERT_DAILY_LOSS_LIMIT    = Number(process.env.INVERT_DAILY_LOSS_LIMIT    || 150)
const LIVE_DAILY_LOSS_LIMIT      = Number(process.env.LIVE_DAILY_LOSS_LIMIT      || 300)
const GLOBAL_DAILY_LOSS_LIMIT    = Number(process.env.GLOBAL_DAILY_LOSS_LIMIT    || 500)
const MAX_INVERT_RISK_PER_PITCHER = Number(process.env.MAX_INVERT_RISK_PER_PITCHER || 50)
const MAX_LIVE_RISK_PER_PITCHER   = Number(process.env.MAX_LIVE_RISK_PER_PITCHER   || 75)
const MAX_INVERT_BETS_PER_PITCHER = Number(process.env.MAX_INVERT_BETS_PER_PITCHER || 2)
const MAX_LIVE_BETS_PER_PITCHER   = Number(process.env.MAX_LIVE_BETS_PER_PITCHER   || 3)

// Resolve per-strategy thresholds in one place so the rest of the module
// stays mode-agnostic. Unknown modes return nulls → caller gets allowed=true
// (we don't enforce caps for modes we haven't budgeted).
function thresholdsFor(strategy_mode) {
  if (strategy_mode === 'pregame_inversion') {
    return {
      maxRisk:     MAX_INVERT_RISK_PER_PITCHER,
      maxBets:     MAX_INVERT_BETS_PER_PITCHER,
      dailyLoss:   INVERT_DAILY_LOSS_LIMIT,
      label:       'pregame_inversion',
    }
  }
  if (strategy_mode === 'live') {
    return {
      maxRisk:     MAX_LIVE_RISK_PER_PITCHER,
      maxBets:     MAX_LIVE_BETS_PER_PITCHER,
      dailyLoss:   LIVE_DAILY_LOSS_LIMIT,
      label:       'live',
    }
  }
  return null
}

// ------------------------------------------------------------------
// Per-pitcher cap: $ at risk + bet count for one (user, pitcher, day, mode)
// ------------------------------------------------------------------
/**
 * @param {object} args
 * @param {object} args.db             - lib/db.js module (uses db.one)
 * @param {number} args.userId
 * @param {string|number} args.pitcherId
 * @param {string} args.betDate        - 'YYYY-MM-DD'
 * @param {string} args.strategy_mode  - 'pregame_inversion' | 'live'
 * @returns {Promise<{allowed:boolean, reason?:string, current_risk?:number, current_bets?:number}>}
 */
export async function checkPitcherCap({ db, userId, pitcherId, betDate, strategy_mode }) {
  const t = thresholdsFor(strategy_mode)
  if (!t) return { allowed: true }   // mode not capped — let it through

  const row = await db.one(
    `SELECT COUNT(*) AS n,
            COALESCE(SUM(capital_at_risk), 0) AS risk
     FROM ks_bets
     WHERE bet_date = ?
       AND user_id  = ?
       AND pitcher_id = ?
       AND COALESCE(strategy_mode, '') = ?
       AND order_id IS NOT NULL
       AND COALESCE(order_status, '') NOT IN ('cancelled', 'void')`,
    [betDate, userId, pitcherId, strategy_mode],
  )

  const current_bets = Number(row?.n    ?? 0)
  const current_risk = Number(row?.risk ?? 0)

  if (current_bets >= t.maxBets) {
    return {
      allowed: false,
      reason: `pitcher_cap_bets_exceeded: ${t.label} user=${userId} pitcher=${pitcherId} bets=${current_bets}/${t.maxBets}`,
      current_risk,
      current_bets,
    }
  }
  if (current_risk >= t.maxRisk) {
    return {
      allowed: false,
      reason: `pitcher_cap_risk_exceeded: ${t.label} user=${userId} pitcher=${pitcherId} risk=$${current_risk.toFixed(2)}/$${t.maxRisk}`,
      current_risk,
      current_bets,
    }
  }
  return { allowed: true, current_risk, current_bets }
}

// ------------------------------------------------------------------
// Per-user, per-strategy daily realized-loss cap
// ------------------------------------------------------------------
/**
 * pnl is negative when losing — we block when SUM(pnl) <= -limit.
 *
 * @param {object} args
 * @param {object} args.db
 * @param {number} args.userId
 * @param {string} args.betDate
 * @param {string} args.strategy_mode
 * @returns {Promise<{allowed:boolean, reason?:string, lossSoFar?:number, limit?:number}>}
 */
export async function checkDailyLossCap({ db, userId, betDate, strategy_mode }) {
  const t = thresholdsFor(strategy_mode)
  if (!t) return { allowed: true }

  const row = await db.one(
    `SELECT COALESCE(SUM(pnl), 0) AS pnl
     FROM ks_bets
     WHERE bet_date = ?
       AND user_id  = ?
       AND COALESCE(strategy_mode, '') = ?
       AND result IN ('win', 'loss')`,
    [betDate, userId, strategy_mode],
  )

  const pnl       = Number(row?.pnl ?? 0)
  const lossSoFar = pnl < 0 ? -pnl : 0   // express loss as positive number

  if (pnl <= -t.dailyLoss) {
    return {
      allowed: false,
      reason: `daily_loss_cap_exceeded: ${t.label} user=${userId} loss=$${lossSoFar.toFixed(2)}/$${t.dailyLoss}`,
      lossSoFar,
      limit: t.dailyLoss,
    }
  }
  return { allowed: true, lossSoFar, limit: t.dailyLoss }
}

// ------------------------------------------------------------------
// Global daily realized-loss cap — real-money rows only (paper=0)
// ------------------------------------------------------------------
/**
 * @param {object} args
 * @param {object} args.db
 * @param {string} args.betDate
 * @returns {Promise<{allowed:boolean, reason?:string, lossSoFar?:number, limit?:number}>}
 */
export async function checkGlobalDailyLossCap({ db, betDate }) {
  const row = await db.one(
    `SELECT COALESCE(SUM(pnl), 0) AS pnl
     FROM ks_bets
     WHERE bet_date = ?
       AND result IN ('win', 'loss')
       AND COALESCE(paper, 0) = 0`,
    [betDate],
  )

  const pnl       = Number(row?.pnl ?? 0)
  const lossSoFar = pnl < 0 ? -pnl : 0

  if (pnl <= -GLOBAL_DAILY_LOSS_LIMIT) {
    return {
      allowed: false,
      reason: `global_daily_loss_cap_exceeded: loss=$${lossSoFar.toFixed(2)}/$${GLOBAL_DAILY_LOSS_LIMIT}`,
      lossSoFar,
      limit: GLOBAL_DAILY_LOSS_LIMIT,
    }
  }
  return { allowed: true, lossSoFar, limit: GLOBAL_DAILY_LOSS_LIMIT }
}

// ------------------------------------------------------------------
// Combined check — pitcher + per-user daily + global, all in parallel.
// Returns the FIRST failure (priority: global → daily → pitcher) when
// multiple gates trip in the same tick, since global is the broadest.
// ------------------------------------------------------------------
/**
 * @param {object} args
 * @param {object} args.db
 * @param {number} args.userId
 * @param {string|number} args.pitcherId
 * @param {string} args.betDate
 * @param {string} args.strategy_mode
 * @returns {Promise<{allowed:boolean, reason?:string}>}
 */
export async function checkAllCaps({ db, userId, pitcherId, betDate, strategy_mode }) {
  const [pitcher, daily, global] = await Promise.all([
    checkPitcherCap({ db, userId, pitcherId, betDate, strategy_mode }),
    checkDailyLossCap({ db, userId, betDate, strategy_mode }),
    checkGlobalDailyLossCap({ db, betDate }),
  ])

  if (!global.allowed)  return { allowed: false, reason: global.reason }
  if (!daily.allowed)   return { allowed: false, reason: daily.reason }
  if (!pitcher.allowed) return { allowed: false, reason: pitcher.reason }
  return { allowed: true }
}

// ------------------------------------------------------------------
// Pre-unhalt checklist support: how much room is left in each bucket?
// ------------------------------------------------------------------
// Hard-coded user IDs match the deployment: Adam-Live=284, Isaiah=2.
// Returned numbers are remaining $ before the daily-loss cap trips
// (i.e. limit + currentPnl, floored at 0). global_remaining uses the
// same convention against GLOBAL_DAILY_LOSS_LIMIT.
//
// @returns {Promise<{adam_inv:number, isaiah_inv:number, adam_live:number,
//                    isaiah_live:number, global_remaining:number}>}
export async function getRemainingCaps({ db, betDate }) {
  const ADAM = 284
  const ISAIAH = 2

  const [adamInv, isaiahInv, adamLive, isaiahLive, global] = await Promise.all([
    checkDailyLossCap({ db, userId: ADAM,   betDate, strategy_mode: 'pregame_inversion' }),
    checkDailyLossCap({ db, userId: ISAIAH, betDate, strategy_mode: 'pregame_inversion' }),
    checkDailyLossCap({ db, userId: ADAM,   betDate, strategy_mode: 'live' }),
    checkDailyLossCap({ db, userId: ISAIAH, betDate, strategy_mode: 'live' }),
    checkGlobalDailyLossCap({ db, betDate }),
  ])

  // Remaining = limit - lossSoFar, floored at 0. When `allowed=false` the
  // bucket is already blown, so headroom is 0.
  const remaining = (r) => {
    if (!r.allowed) return 0
    const limit = Number(r.limit ?? 0)
    const loss  = Number(r.lossSoFar ?? 0)
    return Math.max(0, limit - loss)
  }

  return {
    adam_inv:        remaining(adamInv),
    isaiah_inv:      remaining(isaiahInv),
    adam_live:       remaining(adamLive),
    isaiah_live:     remaining(isaiahLive),
    global_remaining: remaining(global),
  }
}

export const config = {
  INVERT_DAILY_LOSS_LIMIT,
  LIVE_DAILY_LOSS_LIMIT,
  GLOBAL_DAILY_LOSS_LIMIT,
  MAX_INVERT_RISK_PER_PITCHER,
  MAX_LIVE_RISK_PER_PITCHER,
  MAX_INVERT_BETS_PER_PITCHER,
  MAX_LIVE_BETS_PER_PITCHER,
}

// Smoke test (commented out):
// import * as db from './db.js'
// const r = await checkAllCaps({ db, userId: 284, pitcherId: '519242', betDate: '2026-05-03', strategy_mode: 'pregame_inversion' })
// console.log(r)
