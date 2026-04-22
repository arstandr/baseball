// lib/analytics.js — Computed analytics functions for trading metrics.
// Extracted from server/api.js to keep route handlers thin.

import * as db from './db.js'
import { roundTo, winRate, todayISO } from './utils.js'

const STARTING_BANKROLL = Number(process.env.BANKROLL || 5000)

export async function computeModeSummary(mode) {
  const row = await db.one(
    `SELECT
       COUNT(*)                                                     AS n,
       SUM(CASE WHEN o.result = 'WIN'  THEN 1 ELSE 0 END)            AS wins,
       SUM(CASE WHEN o.result = 'LOSS' THEN 1 ELSE 0 END)            AS losses,
       SUM(CASE WHEN o.result = 'PUSH' THEN 1 ELSE 0 END)            AS pushes,
       SUM(COALESCE(o.pnl_usd, 0))                                   AS pnl,
       SUM(t.position_size_usd)                                      AS wagered,
       AVG(t.adjusted_edge)                                          AS avg_edge
     FROM trades t
     LEFT JOIN outcomes o ON o.trade_id = t.id
     WHERE t.mode = ?`,
    [mode],
  ) || {}
  const wins    = Number(row.wins    || 0)
  const losses  = Number(row.losses  || 0)
  const pushes  = Number(row.pushes  || 0)
  const pnl     = Number(row.pnl     || 0)
  const wagered = Number(row.wagered || 0)
  return {
    trades:   Number(row.n || 0),
    wins, losses, pushes,
    signals:  Number(row.n || 0),
    winRate:  roundTo(winRate(wins, losses), 4),
    pnl:      roundTo(pnl, 2),
    wagered:  roundTo(wagered, 2),
    roi:      wagered > 0 ? roundTo(pnl / wagered, 4) : 0,
    avgEdge:  row.avg_edge != null ? roundTo(row.avg_edge, 4) : 0,
  }
}

export async function computeCalibration(mode) {
  const rows = await db.all(
    `SELECT t.model_probability, t.side, o.result
     FROM trades t INNER JOIN outcomes o ON o.trade_id = t.id
     WHERE t.mode = ? AND o.result IN ('WIN','LOSS')`,
    [mode],
  )
  if (!rows.length) return []

  const bands = [
    { label: '50-55%', lo: 0.50, hi: 0.55 },
    { label: '55-60%', lo: 0.55, hi: 0.60 },
    { label: '60-65%', lo: 0.60, hi: 0.65 },
    { label: '65-70%', lo: 0.65, hi: 0.70 },
    { label: '70%+',   lo: 0.70, hi: 1.01 },
  ]
  const buckets = bands.map(b => ({ ...b, n: 0, wins: 0, predSum: 0 }))

  for (const r of rows) {
    // model_probability is for the OVER side; convert to probability of the side taken
    const pOver  = Number(r.model_probability || 0)
    const pSide  = r.side === 'OVER' ? pOver : 1 - pOver
    const bucket = buckets.find(b => pSide >= b.lo && pSide < b.hi)
    if (!bucket) continue
    bucket.n       += 1
    bucket.predSum += pSide
    if (r.result === 'WIN') bucket.wins += 1
  }

  return buckets
    .filter(b => b.n > 0)
    .map(b => ({
      band:      b.label,
      predicted: roundTo(b.predSum / b.n, 4),
      actual:    roundTo(b.wins    / b.n, 4),
      n:         b.n,
    }))
}

export async function computeBankrollRollup() {
  const rows = await db.all(
    `SELECT t.trade_date, o.pnl_usd, o.result
     FROM trades t INNER JOIN outcomes o ON o.trade_id = t.id
     WHERE t.mode = 'live' ORDER BY t.trade_date ASC, t.id ASC`,
  )
  if (!rows.length) {
    return {
      bankroll:       STARTING_BANKROLL,
      startBankroll:  STARTING_BANKROLL,
      totalPnl:       0,
      todayPnl:       0,
      weekPnl:        0,
      monthPnl:       0,
      maxDrawdown:    0,
      longestStreak:  0,
    }
  }

  const today    = todayISO()
  const now      = new Date()
  const weekAgo  = new Date(now.getTime() -  7 * 86400 * 1000).toISOString().slice(0, 10)
  const monthAgo = new Date(now.getTime() - 30 * 86400 * 1000).toISOString().slice(0, 10)

  let running = STARTING_BANKROLL, peak = STARTING_BANKROLL, maxDd = 0
  let streak = 0, bestWinStreak = 0
  let total = 0, todayP = 0, weekP = 0, monthP = 0

  for (const r of rows) {
    const p = Number(r.pnl_usd || 0)
    running += p; total += p
    if (r.trade_date === today)    todayP += p
    if (r.trade_date >= weekAgo)   weekP  += p
    if (r.trade_date >= monthAgo)  monthP += p
    peak  = Math.max(peak, running)
    maxDd = Math.min(maxDd, running - peak)
    if (r.result === 'WIN')       { streak = streak >= 0 ? streak + 1 : 1;  bestWinStreak = Math.max(bestWinStreak, streak) }
    else if (r.result === 'LOSS') { streak = streak <= 0 ? streak - 1 : -1 }
  }

  return {
    bankroll:       roundTo(running, 2),
    startBankroll:  STARTING_BANKROLL,
    totalPnl:       roundTo(total,   2),
    todayPnl:       roundTo(todayP,  2),
    weekPnl:        roundTo(weekP,   2),
    monthPnl:       roundTo(monthP,  2),
    maxDrawdown:    roundTo(maxDd,   2),
    longestStreak:  bestWinStreak,
  }
}

// Running bankroll series helper: takes rows with a pnl column.
export function runningBankroll(rows) {
  let br = STARTING_BANKROLL
  return rows.map(r => {
    br += Number(r.pnl || 0)
    return br
  })
}
