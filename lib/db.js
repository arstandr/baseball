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
  const url = process.env.TURSO_DATABASE_URL
  if (!url) throw new Error('Missing env var: TURSO_DATABASE_URL')
  // Strip any whitespace/newlines — Railway env vars sometimes embed line breaks
  // which Node v24 rejects as invalid HTTP header values
  const authToken = (process.env.TURSO_AUTH_TOKEN || '').replace(/\s+/g, '')
  if (!authToken) throw new Error('Missing env var: TURSO_AUTH_TOKEN')
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
  // Strip line comments and split on semicolons.
  // .replace(/\r/g,'') normalizes CRLF first — Windows git checkouts have \r which
  // blocks the `--.*$` regex anchor and leaves comment-only chunks that newer
  // @libsql/client rejects as SQL_PARSE_ERROR.
  const stmts = raw
    .replace(/\r/g, '')                       // normalize CRLF → LF
    .split('\n')
    .map(line => line.replace(/--.*$/, ''))   // strip inline comments
    .filter(line => line.trim())              // drop blank lines
    .join('\n')
    .split(';')
    .map(s => s.trim())
    .filter(s => s && !/^--/.test(s))         // drop blank or pure-comment chunks

  for (const stmt of stmts) {
    try {
      await client.execute(stmt)
    } catch (err) {
      const msg = String(err.message || err)
      const isIdempotent = /^CREATE\s+(TABLE|INDEX)\s+IF\s+NOT\s+EXISTS/i.test(stmt.trim())
      const isAddColumn  = /^ALTER\s+TABLE\s+\S+\s+ADD\s+COLUMN/i.test(stmt.trim())
      // ADD COLUMN failures are always "column already exists" — safe to ignore
      if (!isIdempotent && !isAddColumn) {
        throw new Error(`Migration failed on statement:\n${stmt}\n\n${err.message}`)
      }
    }
  }
  return { ok: true, statements: stmts.length }
}

// ------------------------------------------------------------------
// Generic helpers
// ------------------------------------------------------------------
// Apr 29 — self-heal on "Client was closed". A sub-script calling db.close()
// can null the shared singleton in the parent process; without this, every
// subsequent query fails silently and downstream loops (liveMonitor heartbeat)
// stall until killed. Retry once with a freshly created client.
function _isClosedError(err) {
  const msg = String(err?.message || '')
  return msg.includes('Client was closed') || msg.includes('manually closed')
}

export async function run(sql, args = []) {
  try {
    return await getClient().execute({ sql, args })
  } catch (err) {
    if (!_isClosedError(err)) throw err
    _client = null  // force re-init on next getClient()
    return await getClient().execute({ sql, args })
  }
}

export async function all(sql, args = []) {
  try {
    const res = await getClient().execute({ sql, args })
    return res.rows || []
  } catch (err) {
    if (!_isClosedError(err)) throw err
    _client = null
    const res = await getClient().execute({ sql, args })
    return res.rows || []
  }
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

// Kalshi price snapshots + convergence — implemented in lib/clvLog.js
export { saveKalshiSnapshot, saveConvergenceWindow, saveCLVEntry, updateCLVClose, settleCLVEntry, getOpenCLVEntries, getCLVEntries } from './clvLog.js'

// Live log — implemented in lib/liveLog.js
export { saveLog, getLiveLogs } from './liveLog.js'

export async function close() {
  if (_client) {
    _client.close?.()
    _client = null
  }
}
