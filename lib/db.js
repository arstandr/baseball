// lib/db.js — Turso/libSQL client + migration + query helpers
//
// Single shared client, lazy-initialised. All queries go through this file so
// we can add logging/retry centrally later.

import { createClient } from '@libsql/client'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import 'dotenv/config'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

let _client = null

export function getClient() {
  if (_client) return _client
  const url = process.env.TURSO_DATABASE_URL || 'file:./mlbie.db'
  const authToken = process.env.TURSO_AUTH_TOKEN || undefined
  _client = createClient({ url, authToken })
  return _client
}

// ------------------------------------------------------------------
// Migration — run schema.sql at startup (idempotent CREATE IF NOT EXISTS)
// ------------------------------------------------------------------
export async function migrate() {
  const client = getClient()
  const schemaPath = path.resolve(__dirname, '..', 'db', 'schema.sql')
  const raw = await fs.readFile(schemaPath, 'utf-8')
  // Strip line comments and split on semicolons (naive but fine for our schema)
  const stmts = raw
    .split('\n')
    .map(line => line.replace(/--.*$/, ''))   // strip inline comments
    .filter(line => line.trim())              // drop blank lines
    .join('\n')
    .split(';')
    .map(s => s.trim())
    .filter(Boolean)

  for (const stmt of stmts) {
    try {
      await client.execute(stmt)
    } catch (err) {
      // libSQL throws on CREATE INDEX duplicates in some cases even with IF NOT EXISTS — tolerate
      if (!String(err.message || err).includes('already exists')) {
        throw new Error(`Migration failed on statement:\n${stmt}\n\n${err.message}`)
      }
    }
  }
  return { ok: true, statements: stmts.length }
}

// ------------------------------------------------------------------
// Generic helpers
// ------------------------------------------------------------------
export async function run(sql, args = []) {
  return getClient().execute({ sql, args })
}

export async function all(sql, args = []) {
  const res = await getClient().execute({ sql, args })
  return res.rows || []
}

export async function one(sql, args = []) {
  const rows = await all(sql, args)
  return rows[0] || null
}

// Upsert convenience — libSQL supports standard SQLite ON CONFLICT
export async function upsert(table, row, conflictKeys) {
  const cols = Object.keys(row)
  const placeholders = cols.map(() => '?').join(',')
  const values = cols.map(c => row[c])
  const updates = cols
    .filter(c => !conflictKeys.includes(c))
    .map(c => `${c}=excluded.${c}`)
    .join(',')
  const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES (${placeholders})
               ON CONFLICT(${conflictKeys.join(',')}) DO UPDATE SET ${updates}`
  return run(sql, values)
}

// ------------------------------------------------------------------
// Domain helpers — keep per-table mutation logic here for auditability
// ------------------------------------------------------------------
export async function saveGame(game) {
  return upsert('games', game, ['id'])
}

export async function saveVenue(venue) {
  return upsert('venues', venue, ['id'])
}

export async function saveWeather(w) {
  return upsert('weather', w, ['game_id'])
}

export async function savePitcherSignal(sig) {
  return upsert('pitcher_signals', sig, ['pitcher_id', 'signal_date'])
}

export async function saveLineupSignal(sig) {
  return upsert('lineup_signals', sig, ['team_id', 'game_id'])
}

export async function saveLine(line) {
  // lines table has no unique key — append-only movement log
  const cols = Object.keys(line)
  const placeholders = cols.map(() => '?').join(',')
  return run(
    `INSERT INTO lines (${cols.join(',')}) VALUES (${placeholders})`,
    cols.map(c => line[c]),
  )
}

export async function saveAgentOutput(gameId, agent, output) {
  return upsert(
    'agent_outputs',
    { game_id: gameId, agent, output_json: JSON.stringify(output) },
    ['game_id', 'agent'],
  )
}

export async function saveProjection(proj) {
  return upsert('projections', proj, ['game_id', 'model_version'])
}

export async function saveTrade(trade) {
  const cols = Object.keys(trade)
  const placeholders = cols.map(() => '?').join(',')
  const res = await run(
    `INSERT INTO trades (${cols.join(',')}) VALUES (${placeholders})`,
    cols.map(c => trade[c]),
  )
  return Number(res.lastInsertRowid)
}

export async function saveOutcome(outcome) {
  return upsert('outcomes', outcome, ['trade_id'])
}

export async function saveModelVersion(version) {
  return upsert('model_versions', version, ['id'])
}

export async function getActiveModelVersion() {
  return one(`SELECT * FROM model_versions WHERE is_active = 1 ORDER BY trained_at DESC LIMIT 1`)
}

export async function getGame(id) {
  return one(`SELECT * FROM games WHERE id = ?`, [id])
}

export async function getGamesByDate(date) {
  return all(`SELECT * FROM games WHERE date = ? ORDER BY game_time ASC`, [date])
}

export async function getVenue(id) {
  return one(`SELECT * FROM venues WHERE id = ?`, [id])
}

export async function getLinesForGame(gameId) {
  return all(
    `SELECT * FROM lines WHERE game_id = ? ORDER BY fetched_at ASC`,
    [gameId],
  )
}

export async function getOpeningLine(gameId, market = 'full_game_total') {
  return one(
    `SELECT * FROM lines WHERE game_id = ? AND market_type = ? AND is_opening = 1 ORDER BY fetched_at ASC LIMIT 1`,
    [gameId, market],
  )
}

export async function getCurrentLine(gameId, market = 'full_game_total') {
  return one(
    `SELECT * FROM lines WHERE game_id = ? AND market_type = ? ORDER BY fetched_at DESC LIMIT 1`,
    [gameId, market],
  )
}

export async function getAgentOutput(gameId, agent) {
  const row = await one(
    `SELECT output_json FROM agent_outputs WHERE game_id = ? AND agent = ?`,
    [gameId, agent],
  )
  if (!row) return null
  try {
    return JSON.parse(row.output_json)
  } catch {
    return null
  }
}

export async function getTradesByDate(date, mode = null) {
  if (mode) {
    return all(
      `SELECT * FROM trades WHERE trade_date = ? AND mode = ? ORDER BY created_at DESC`,
      [date, mode],
    )
  }
  return all(
    `SELECT * FROM trades WHERE trade_date = ? ORDER BY created_at DESC`,
    [date],
  )
}

export async function getOpenTrades() {
  return all(`
    SELECT t.* FROM trades t
    LEFT JOIN outcomes o ON o.trade_id = t.id
    WHERE o.id IS NULL
    ORDER BY t.created_at ASC
  `)
}

export async function getPnLSince(date, mode = 'paper') {
  return one(
    `SELECT
       COUNT(*) AS n,
       SUM(CASE WHEN o.result = 'WIN'  THEN 1 ELSE 0 END) AS wins,
       SUM(CASE WHEN o.result = 'LOSS' THEN 1 ELSE 0 END) AS losses,
       SUM(CASE WHEN o.result = 'PUSH' THEN 1 ELSE 0 END) AS pushes,
       SUM(o.pnl_usd) AS pnl
     FROM trades t
     INNER JOIN outcomes o ON o.trade_id = t.id
     WHERE t.trade_date >= ? AND t.mode = ?`,
    [date, mode],
  )
}

export async function saveKalshiSnapshot(snap) {
  const cols = Object.keys(snap)
  const placeholders = cols.map(() => '?').join(',')
  return run(
    `INSERT INTO kalshi_price_snapshots (${cols.join(',')}) VALUES (${placeholders})`,
    cols.map(c => snap[c]),
  )
}

export async function saveConvergenceWindow(gameId, window, kalshiPrice, sbImplied) {
  // window: 'open' | '6hr' | '2hr' | '30min' | 'start'
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

// ------------------------------------------------------------------
// CLV log helpers
// ------------------------------------------------------------------

/**
 * Insert a new paper-bet CLV entry.
 * paper_price_close and clv are intentionally left NULL — filled by closeOutLines.
 */
export async function saveCLVEntry(entry) {
  const cols = Object.keys(entry)
  const placeholders = cols.map(() => '?').join(',')
  const res = await run(
    `INSERT INTO clv_log (${cols.join(',')}) VALUES (${placeholders})`,
    cols.map(c => entry[c]),
  )
  return Number(res.lastInsertRowid)
}

/**
 * Fill in paper_price_close and compute clv for an open entry.
 * clv = paper_price_close - paper_price_open  (positive = we beat the market)
 * Also accepts an optional `result` (1|0) when settling simultaneously.
 */
export async function updateCLVClose(id, paperPriceClose, extra = {}) {
  const clv = extra.clv != null
    ? extra.clv
    : null // will be computed in SQL if open price is available
  if (clv != null) {
    const sets = [`paper_price_close = ?`, `clv = ?`]
    const vals = [paperPriceClose, clv]
    if (extra.result != null) { sets.push('result = ?'); vals.push(extra.result) }
    if (extra.settled_at != null) { sets.push('settled_at = ?'); vals.push(extra.settled_at) }
    if (extra.actual_f5_total != null) { sets.push('actual_f5_total = ?'); vals.push(extra.actual_f5_total) }
    vals.push(id)
    return run(`UPDATE clv_log SET ${sets.join(', ')} WHERE id = ?`, vals)
  }
  // Compute clv inline from stored paper_price_open
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

/**
 * Settle a CLV entry with a win/loss result.
 */
export async function settleCLVEntry(id, result, actualTotal) {
  return run(
    `UPDATE clv_log SET result = ?, actual_f5_total = ?, settled_at = datetime('now') WHERE id = ?`,
    [result, actualTotal, id],
  )
}

/**
 * Open CLV entries (paper_price_close IS NULL) for a given date.
 */
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

/**
 * All CLV entries for a date range (for reporting).
 */
export async function getCLVEntries({ since, until, series } = {}) {
  const conditions = []
  const vals = []
  if (since)  { conditions.push('game_date >= ?'); vals.push(since) }
  if (until)  { conditions.push('game_date <= ?'); vals.push(until) }
  if (series) { conditions.push('series = ?'); vals.push(series) }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  return all(`SELECT * FROM clv_log ${where} ORDER BY game_date ASC, logged_at ASC`, vals)
}

export async function close() {
  if (_client) {
    _client.close?.()
    _client = null
  }
}
