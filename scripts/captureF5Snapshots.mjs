// scripts/captureF5Snapshots.mjs
//
// Polls Kalshi for all open + recently-closed KXMLBF5TOTAL markets, writes
// one row per (ticker × poll) into f5_market_snapshots. Read-only on Kalshi
// — does not place orders. Paper test data collection only.
//
// Run schedule (in server/scheduler.js):
//   - Every 10 min from 11:00 ET to 23:30 ET
//
// Inputs:  Kalshi public API (no auth needed for /markets and /events)
// Outputs: f5_market_snapshots table in Turso
//
// Discord: silent unless an error trips the catch block (DISCORD_ERRORS_ONLY=true).

import 'dotenv/config'
import { createClient } from '@libsql/client'

const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })

const KALSHI_BASE = 'https://api.elections.kalshi.com/trade-api/v2'
const SERIES = 'KXMLBF5TOTAL'

async function ensureTable() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS f5_market_snapshots (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      captured_at     TEXT    NOT NULL DEFAULT (datetime('now')),
      game_date       TEXT    NOT NULL,
      ticker          TEXT    NOT NULL,
      event_ticker    TEXT    NOT NULL,
      away_abbr       TEXT,
      home_abbr       TEXT,
      game_time_et    TEXT,
      game_start_utc  TEXT,
      strike          REAL    NOT NULL,
      yes_bid         REAL,
      yes_ask         REAL,
      no_bid          REAL,
      no_ask          REAL,
      yes_bid_size    REAL,
      yes_ask_size    REAL,
      spread          REAL,
      volume_24h      REAL,
      volume_total    REAL,
      open_interest   REAL,
      status          TEXT,
      result          TEXT,
      actual_f5_runs  INTEGER,
      resolved_at     TEXT,
      UNIQUE(ticker, captured_at)
    )
  `)
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_f5snap_date   ON f5_market_snapshots(game_date)`)
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_f5snap_event  ON f5_market_snapshots(event_ticker)`)
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_f5snap_ticker ON f5_market_snapshots(ticker)`)
}

async function fetchJson(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(15_000) })
      if (!r.ok) { await new Promise(r => setTimeout(r, 500)); continue }
      return await r.json()
    } catch { await new Promise(r => setTimeout(r, 500)) }
  }
  return null
}

// List all KXMLBF5TOTAL markets that are open OR closed-today.
// We paginate via cursor.
async function listAllF5Markets() {
  const all = []
  for (const status of ['open', 'closed']) {
    let cursor = ''
    let pages = 0
    do {
      const url = `${KALSHI_BASE}/markets?series_ticker=${SERIES}&status=${status}&limit=200${cursor ? `&cursor=${cursor}` : ''}`
      const data = await fetchJson(url)
      if (!data?.markets?.length) break
      all.push(...data.markets)
      cursor = data.cursor ?? ''
      pages++
      if (pages > 10) break  // safety
    } while (cursor)
  }
  return all
}

// Parse event ticker into structured components.
// Pattern: KXMLBF5TOTAL-{YY}{MMM}{DD}{HHMM}{AWAY}{HOME}
function parseEventTicker(eventTicker) {
  const m = eventTicker.match(/^KXMLBF5TOTAL-(\d{2})([A-Z]{3})(\d{2})(\d{4})([A-Z]+?)([A-Z]+)$/)
  if (!m) return null
  const [, yy, mmm, dd, hhmm, away, home] = m
  // Split AWAY+HOME — both are 2-3 chars. Try 3+3 first, then 2+3, then 3+2, then 2+2.
  const lump = `${away}${home}`
  const splits = []
  for (const al of [3, 2]) {
    if (lump.length >= al + 2) {
      splits.push({ a: lump.slice(0, al), h: lump.slice(al) })
    }
  }
  const months = { JAN:0, FEB:1, MAR:2, APR:3, MAY:4, JUN:5, JUL:6, AUG:7, SEP:8, OCT:9, NOV:10, DEC:11 }
  const year = 2000 + Number(yy)
  const month = months[mmm]
  const day = Number(dd)
  return {
    year, month, day,
    game_date: `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    game_time_et: hhmm,
    candidates: splits,  // try each candidate to find the right away/home split
  }
}

// Best-effort away/home split — Kalshi joins both abbreviations directly so
// the field given by regex match is the concatenation. Use a known abbr list
// to pick the correct split.
const MLB_ABBRS = new Set(['ARI','ATL','BAL','BOS','CHC','CWS','CHW','CIN','CLE','COL','DET','HOU','KC','LAA','LAD','MIA','MIL','MIN','NYM','NYY','OAK','ATH','PHI','PIT','SD','SEA','SF','STL','TB','TEX','TOR','WSH','WAS'])
function splitTeams(parsed) {
  if (!parsed) return { away_abbr: null, home_abbr: null }
  for (const c of parsed.candidates) {
    if (MLB_ABBRS.has(c.a) && MLB_ABBRS.has(c.h)) return { away_abbr: c.a, home_abbr: c.h }
  }
  // Fallback: first candidate
  if (parsed.candidates[0]) return { away_abbr: parsed.candidates[0].a, home_abbr: parsed.candidates[0].h }
  return { away_abbr: null, home_abbr: null }
}

function etToUtc({ year, month, day, hhmm }) {
  const hh = Number(hhmm.slice(0, 2)), mm = Number(hhmm.slice(2))
  // ET to UTC. May-Nov: ET = UTC-4 (EDT). Other: UTC-5 (EST).
  // For our window (May+) use UTC-4.
  return new Date(Date.UTC(year, month, day, hh + 4, mm)).toISOString()
}

async function main() {
  await ensureTable()
  const markets = await listAllF5Markets()
  if (!markets.length) {
    console.log('[captureF5Snapshots] No F5 markets returned.')
    return
  }
  const capturedAt = new Date().toISOString()
  const rows = []
  let parseErrors = 0
  for (const m of markets) {
    const parsed = parseEventTicker(m.event_ticker)
    if (!parsed) { parseErrors++; continue }
    const { away_abbr, home_abbr } = splitTeams(parsed)
    const game_start_utc = etToUtc({ year: parsed.year, month: parsed.month, day: parsed.day, hhmm: parsed.game_time_et })

    const yes_bid = Number(m.yes_bid_dollars)
    const yes_ask = Number(m.yes_ask_dollars)
    const no_bid  = Number.isFinite(yes_ask) ? 1 - yes_ask : null
    const no_ask  = Number.isFinite(yes_bid) ? 1 - yes_bid : null

    rows.push({
      captured_at:    capturedAt,
      game_date:      parsed.game_date,
      ticker:         m.ticker,
      event_ticker:   m.event_ticker,
      away_abbr,
      home_abbr,
      game_time_et:   parsed.game_time_et,
      game_start_utc,
      strike:         Number(m.floor_strike),
      yes_bid:        Number.isFinite(yes_bid) ? yes_bid : null,
      yes_ask:        Number.isFinite(yes_ask) ? yes_ask : null,
      no_bid:         no_bid,
      no_ask:         no_ask,
      yes_bid_size:   Number(m.yes_bid_size_fp) || null,
      yes_ask_size:   Number(m.yes_ask_size_fp) || null,
      spread:         (Number.isFinite(yes_ask) && Number.isFinite(yes_bid)) ? yes_ask - yes_bid : null,
      volume_24h:     Number(m.volume_24h_fp) || null,
      volume_total:   Number(m.volume_fp) || null,
      open_interest:  Number(m.open_interest_fp) || null,
      status:         m.status ?? null,
      result:         m.result || null,
      actual_f5_runs: null,
      resolved_at:    null,
    })
  }
  console.log(`[captureF5Snapshots] markets=${markets.length}, parsed=${rows.length}, parseErrors=${parseErrors}`)

  // Batch insert
  const CHUNK = 100
  let inserted = 0, dupes = 0
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK)
    const cols = Object.keys(chunk[0])
    const placeholders = `(${cols.map(() => '?').join(',')})`
    const sql = `INSERT OR IGNORE INTO f5_market_snapshots (${cols.join(',')}) VALUES ${chunk.map(() => placeholders).join(',')}`
    const args = chunk.flatMap(r => cols.map(c => r[c]))
    const res = await db.execute({ sql, args })
    inserted += Number(res.rowsAffected ?? 0)
  }
  dupes = rows.length - inserted
  console.log(`[captureF5Snapshots] inserted=${inserted}, ignored_dupes=${dupes}`)
}

main().catch(err => {
  console.error(`[captureF5Snapshots] ERROR: ${err.message}`)
  process.exit(1)
})
