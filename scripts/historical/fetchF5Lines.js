// scripts/historical/fetchF5Lines.js — fetch historical F5 (first-5-innings) total
// run lines from The Odds API and store them in the `lines` table.
//
//   GET /v4/historical/sports/baseball_mlb/odds
//     ?apiKey=...&regions=us&markets=<f5_market_key>&date={ISO_Z}
//
// F5 market keys tried in order (API support varies by snapshot date):
//   1. baseball_mlb_first_5_innings
//   2. totals_first_5_innings
//   3. h2h_h1  (half-time totals — fallback)
//
// Usage:
//   node scripts/historical/fetchF5Lines.js [--season 2023] [--date 2023-07-04] [--force]
//
// Flags:
//   --season YYYY     ingest one season (default: all seasons 2020-2025)
//   --date YYYY-MM-DD ingest a single date
//   --force           bypass disk cache and re-fetch from API

import axios from 'axios'
import 'dotenv/config'
import * as db from '../../lib/db.js'
import { getCached, sleep } from './cache.js'

const BASE = 'https://api.the-odds-api.com/v4'
const THROTTLE_MS = 500 // historical endpoint is lower-rate than live
const CACHE_NS = 'odds_f5'

// F5 market keys to try in order of preference
const F5_MARKET_KEYS = [
  'baseball_mlb_first_5_innings',
  'totals_first_5_innings',
  'h2h_h1',
]

// -----------------------------------------------------------------------
// Ensure the f5_line_open column exists on historical_games (idempotent)
// -----------------------------------------------------------------------
async function ensureF5Column() {
  try {
    await db.run(`ALTER TABLE historical_games ADD COLUMN f5_line_open REAL`)
  } catch (err) {
    // Column already exists — that's fine
    const msg = String(err.message || err)
    if (!msg.includes('duplicate') && !msg.includes('already exists')) {
      throw err
    }
  }
}

// -----------------------------------------------------------------------
// Fetch one F5 snapshot for a given date, trying market keys in order
// -----------------------------------------------------------------------
async function fetchF5Snapshot(date, { force = false } = {}) {
  const key = process.env.ODDS_API_KEY
  if (!key) throw new Error('ODDS_API_KEY not set')

  return getCached(CACHE_NS, `f5-${date}`, async () => {
    const iso = `${date}T12:00:00Z`

    for (const market of F5_MARKET_KEYS) {
      let res
      try {
        res = await axios.get(`${BASE}/historical/sports/baseball_mlb/odds`, {
          params: {
            apiKey: key,
            regions: 'us',
            markets: market,
            date: iso,
            oddsFormat: 'american',
            bookmakers: 'draftkings,fanduel,betmgm,caesars,pointsbetus',
          },
          timeout: 30000,
          validateStatus: s => s >= 200 && s < 500,
        })
      } catch (err) {
        process.stderr.write(`[fetchF5Lines] ${date} market=${market} network error: ${err.message}\n`)
        continue
      }

      if (res.status >= 400) {
        process.stderr.write(`[fetchF5Lines] ${date} market=${market} -> HTTP ${res.status}\n`)
        continue
      }

      // Historical endpoint wraps data under .data[]
      const games = Array.isArray(res.data) ? res.data : (res.data?.data || [])
      if (!games.length) {
        process.stderr.write(`[fetchF5Lines] ${date} market=${market} -> 0 games, trying next key\n`)
        continue
      }

      // Annotate which market key succeeded so we can use it in extraction
      return { _marketKey: market, data: games }
    }

    // No market key returned data
    return { _marketKey: null, data: [] }
  }, { force })
}

// -----------------------------------------------------------------------
// Median helper
// -----------------------------------------------------------------------
function median(arr) {
  const v = arr.filter(x => typeof x === 'number' && !Number.isNaN(x)).sort((a, b) => a - b)
  if (!v.length) return null
  const mid = Math.floor(v.length / 2)
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2
}

// -----------------------------------------------------------------------
// Extract F5 total lines from a snapshot payload
// -----------------------------------------------------------------------
function extractF5Totals(snap) {
  const { _marketKey, data: games } = snap
  if (!_marketKey || !games?.length) return []

  const out = []
  for (const g of games) {
    const lines = []
    const overPrices = []
    const underPrices = []

    for (const bk of g.bookmakers || []) {
      for (const m of bk.markets || []) {
        if (m.key !== _marketKey) continue
        const outcomes = m.outcomes || []
        const overO = outcomes.find(o => o.name === 'Over')
        const underO = outcomes.find(o => o.name === 'Under')
        if (overO?.point != null) {
          lines.push(overO.point)
          if (overO.price != null) overPrices.push(overO.price)
          if (underO?.price != null) underPrices.push(underO.price)
        }
      }
    }

    out.push({
      id: g.id,
      commence_time: g.commence_time,
      home_team: g.home_team,
      away_team: g.away_team,
      f5_total: median(lines),
      over_price: median(overPrices),
      under_price: median(underPrices),
      bookmaker_count: (g.bookmakers || []).length,
      market_key: _marketKey,
    })
  }
  return out
}

// -----------------------------------------------------------------------
// Team-name normalisation + fuzzy matching (mirrors fetchOdds.js)
// -----------------------------------------------------------------------
function normalizeTeam(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[.'"]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function teamsMatch(oddsTeam, gameTeam) {
  const a = normalizeTeam(oddsTeam)
  const b = normalizeTeam(gameTeam)
  if (!a || !b) return false
  if (a === b) return true
  const tailA = a.split(' ').pop()
  const tailB = b.split(' ').pop()
  if (tailA && tailA === tailB) return true
  if (a.includes(b) || b.includes(a)) return true
  return false
}

// -----------------------------------------------------------------------
// Check whether a game already has an f5_total line recorded
// -----------------------------------------------------------------------
async function hasExistingF5Line(gameId) {
  const row = await db.one(
    `SELECT 1 FROM lines WHERE game_id = ? AND market_type = 'f5_total' AND is_opening = 1 LIMIT 1`,
    [gameId],
  )
  return !!row
}

// -----------------------------------------------------------------------
// Core per-date ingestion
// -----------------------------------------------------------------------
export async function ingestDate(date, { force = false } = {}) {
  const snap = await fetchF5Snapshot(date, { force })
  const f5Games = extractF5Totals(snap)

  if (!f5Games.length) {
    return { date, matched: 0, total: 0, _no_f5_data: true }
  }

  // Collect unique game-dates from the snapshot's commence_times
  const uniqueDates = [
    ...new Set(
      f5Games
        .map(og => og.commence_time?.slice(0, 10))
        .filter(Boolean),
    ),
  ]

  // Load candidate historical_games rows
  let games = []
  for (const d of uniqueDates) {
    const rows = await db.all(
      `SELECT id, home_team, away_team, game_time FROM historical_games WHERE date = ?`,
      [d],
    )
    games = games.concat(rows)
  }

  if (!games.length) {
    return { date, matched: 0, total: f5Games.length, _no_games_in_db: true }
  }

  const now = new Date().toISOString()
  let matched = 0

  for (const og of f5Games) {
    if (og.f5_total == null) continue

    const t = new Date(og.commence_time).getTime()

    // Find best-matching historical game
    let best = null
    let bestDelta = Infinity
    for (const g of games) {
      if (!teamsMatch(og.home_team, g.home_team)) continue
      if (!teamsMatch(og.away_team, g.away_team)) continue
      const delta = g.game_time
        ? Math.abs(new Date(g.game_time).getTime() - t)
        : 1e12
      if (delta > 12 * 3600 * 1000) continue
      if (delta < bestDelta) {
        best = g
        bestDelta = delta
      }
    }
    if (!best) continue

    // Skip if already recorded (unless --force)
    if (!force && (await hasExistingF5Line(best.id))) {
      matched++ // count as matched even if skipped
      continue
    }

    // Upsert into lines table
    await db.run(
      `INSERT INTO lines
         (game_id, source, market_type, line_value, over_price, under_price,
          is_opening, movement_from_open, fetched_at)
       VALUES (?, 'odds_api', 'f5_total', ?, ?, ?, 1, 0, ?)
       ON CONFLICT(game_id, source, market_type, is_opening)
       DO UPDATE SET
         line_value = excluded.line_value,
         over_price = excluded.over_price,
         under_price = excluded.under_price,
         fetched_at = excluded.fetched_at`,
      [best.id, og.f5_total, og.over_price, og.under_price, now],
    )

    // Also update historical_games.f5_line_open
    await db.run(
      `UPDATE historical_games SET f5_line_open = ? WHERE id = ?`,
      [og.f5_total, best.id],
    )

    matched++
  }

  return { date, matched, total: f5Games.length }
}

// -----------------------------------------------------------------------
// Date range runner
// -----------------------------------------------------------------------
export async function ingestDateRange(startDate, endDate, { force = false } = {}) {
  const results = []
  let cur = new Date(startDate)
  const end = new Date(endDate)

  while (cur <= end) {
    const iso = cur.toISOString().slice(0, 10)
    try {
      const r = await ingestDate(iso, { force })
      const flag = r._no_f5_data ? ' [no F5 data]' : r._no_games_in_db ? ' [no games in DB]' : ''
      process.stderr.write(`[fetchF5Lines] ${iso}: matched ${r.matched}/${r.total}${flag}\n`)
      results.push(r)
    } catch (err) {
      process.stderr.write(`[fetchF5Lines] ${iso}: ERROR ${err.message}\n`)
      results.push({ date: iso, error: err.message })
    }
    await sleep(THROTTLE_MS)
    cur.setUTCDate(cur.getUTCDate() + 1)
  }
  return results
}

// -----------------------------------------------------------------------
// Season convenience wrapper (April 1 – October 5 is a safe MLB window)
// -----------------------------------------------------------------------
export async function ingestSeason(season, opts = {}) {
  return ingestDateRange(`${season}-04-01`, `${season}-10-05`, opts)
}

// -----------------------------------------------------------------------
// CLI entry point
// -----------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2)
  const force = args.includes('--force')

  const seasonIdx = args.indexOf('--season')
  const dateIdx = args.indexOf('--date')

  await ensureF5Column()

  let results = []

  if (dateIdx !== -1) {
    // Single date mode
    const date = args[dateIdx + 1]
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      process.stderr.write('Usage: --date YYYY-MM-DD\n')
      process.exit(1)
    }
    process.stderr.write(`[fetchF5Lines] Fetching F5 lines for ${date}...\n`)
    try {
      const r = await ingestDate(date, { force })
      results.push(r)
    } catch (err) {
      process.stderr.write(`[fetchF5Lines] ${date}: ERROR ${err.message}\n`)
      results.push({ date, error: err.message })
    }
  } else if (seasonIdx !== -1) {
    // Single season mode
    const season = parseInt(args[seasonIdx + 1], 10)
    if (!season || season < 2010 || season > 2030) {
      process.stderr.write('Usage: --season YYYY (e.g. 2023)\n')
      process.exit(1)
    }
    process.stderr.write(`[fetchF5Lines] Ingesting F5 lines for ${season} season...\n`)
    results = await ingestSeason(season, { force })
  } else {
    // All seasons 2020-2025
    const seasons = [2020, 2021, 2022, 2023, 2024, 2025]
    process.stderr.write(`[fetchF5Lines] Ingesting F5 lines for seasons ${seasons.join(', ')}...\n`)
    for (const season of seasons) {
      process.stderr.write(`[fetchF5Lines] === Season ${season} ===\n`)
      const r = await ingestSeason(season, { force })
      results = results.concat(r)
    }
  }

  // Summary
  const totalGames = results.reduce((s, r) => s + (r.total || 0), 0)
  const totalMatched = results.reduce((s, r) => s + (r.matched || 0), 0)
  const errors = results.filter(r => r.error).length
  const noData = results.filter(r => r._no_f5_data).length
  const noDb = results.filter(r => r._no_games_in_db).length

  console.log('\n=== F5 Lines Ingestion Summary ===')
  console.log(`Dates processed : ${results.length}`)
  console.log(`Games matched   : ${totalMatched} / ${totalGames}`)
  console.log(`Errors          : ${errors}`)
  console.log(`No F5 API data  : ${noData} dates`)
  console.log(`No DB games     : ${noDb} dates`)

  await db.close()
}

main().catch(err => {
  process.stderr.write(`[fetchF5Lines] Fatal: ${err.message}\n${err.stack}\n`)
  process.exit(1)
})
