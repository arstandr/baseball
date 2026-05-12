// lib/liveLog.js — live_log table read/write helpers.
// Re-exported from lib/db.js for backward compatibility.

import { run, all } from './db.js'

export async function saveLog({ tag, msg, level = 'info', pitcher = null, strike = null, side = null, edge_cents = null, pnl = null } = {}) {
  const bet_date = new Date().toISOString().slice(0, 10)
  return run(
    `INSERT INTO live_log (bet_date, level, tag, msg, pitcher, strike, side, edge_cents, pnl)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [bet_date, level, tag, msg, pitcher, strike, side, edge_cents, pnl],
  ).catch(() => {})
}

export async function getLiveLogs({ date, limit = 200 } = {}) {
  const d = date || new Date().toISOString().slice(0, 10)
  return all(
    `SELECT * FROM live_log WHERE bet_date = ? ORDER BY ts DESC LIMIT ?`,
    [d, limit],
  )
}
