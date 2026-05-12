// lib/clvLog.js — CLV log + Kalshi price snapshot helpers.
// Re-exported from lib/db.js for backward compatibility.

import { run, all } from './db.js'

export async function saveKalshiSnapshot(snap) {
  const cols = Object.keys(snap)
  const placeholders = cols.map(() => '?').join(',')
  return run(
    `INSERT INTO kalshi_price_snapshots (${cols.join(',')}) VALUES (${placeholders})`,
    cols.map(c => snap[c]),
  )
}

export async function saveConvergenceWindow(gameId, window, kalshiPrice, sbImplied) {
  const colK = `kalshi_price_${window}`
  const colS = `sportsbook_implied_${window}`
  await run(
    `INSERT INTO convergence_log (game_id, game_date, full_line)
     VALUES (?, date('now'), 0)
     ON CONFLICT(game_id) DO NOTHING`,
    [gameId],
  ).catch(() => {})
  return run(
    `UPDATE convergence_log SET ${colK} = ?, ${colS} = ? WHERE game_id = ?`,
    [kalshiPrice, sbImplied, gameId],
  )
}

export async function saveCLVEntry(entry) {
  const cols = Object.keys(entry)
  const placeholders = cols.map(() => '?').join(',')
  const res = await run(
    `INSERT INTO clv_log (${cols.join(',')}) VALUES (${placeholders})`,
    cols.map(c => entry[c]),
  )
  return Number(res.lastInsertRowid)
}

export async function updateCLVClose(id, paperPriceClose, extra = {}) {
  const clv = extra.clv != null ? extra.clv : null
  if (clv != null) {
    const sets = [`paper_price_close = ?`, `clv = ?`]
    const vals = [paperPriceClose, clv]
    if (extra.result != null) { sets.push('result = ?'); vals.push(extra.result) }
    if (extra.settled_at != null) { sets.push('settled_at = ?'); vals.push(extra.settled_at) }
    if (extra.actual_f5_total != null) { sets.push('actual_f5_total = ?'); vals.push(extra.actual_f5_total) }
    vals.push(id)
    return run(`UPDATE clv_log SET ${sets.join(', ')} WHERE id = ?`, vals)
  }
  const sets = [
    `paper_price_close = ?`,
    `clv = ? - paper_price_open`,
  ]
  const vals = [paperPriceClose, paperPriceClose]
  if (extra.result != null) { sets.push('result = ?'); vals.push(extra.result) }
  if (extra.settled_at != null) { sets.push('settled_at = ?'); vals.push(extra.settled_at) }
  if (extra.actual_f5_total != null) { sets.push('actual_f5_total = ?'); vals.push(extra.actual_f5_total) }
  vals.push(id)
  return run(`UPDATE clv_log SET ${sets.join(', ')} WHERE id = ?`, vals)
}

export async function settleCLVEntry(id, result, actualTotal) {
  return run(
    `UPDATE clv_log SET result = ?, actual_f5_total = ?, settled_at = datetime('now') WHERE id = ?`,
    [result, actualTotal, id],
  )
}

export async function getOpenCLVEntries(date) {
  const d = date || new Date().toISOString().slice(0, 10)
  return all(
    `SELECT cl.*, g.game_time, g.team_away, g.team_home
     FROM clv_log cl
     LEFT JOIN games g ON g.id = cl.game_id
     WHERE cl.game_date = ? AND cl.paper_price_close IS NULL
     ORDER BY g.game_time ASC`,
    [d],
  )
}

export async function getCLVEntries({ since, until, series } = {}) {
  const conditions = []
  const vals = []
  if (since)  { conditions.push('game_date >= ?'); vals.push(since) }
  if (until)  { conditions.push('game_date <= ?'); vals.push(until) }
  if (series) { conditions.push('series = ?'); vals.push(series) }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  return all(`SELECT * FROM clv_log ${where} ORDER BY game_date ASC, logged_at ASC`, vals)
}
