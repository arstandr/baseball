// scripts/historical/fetchOdds.js — fetch opening full-game totals from
// The Odds API historical snapshot endpoint.
//
//   GET /v4/historical/sports/baseball_mlb/odds
//     ?apiKey=...&regions=us&markets=totals&date={ISO_Z}
//
// Historical credits are precious. We cache one snapshot per date, then
// match that snapshot's games to our `historical_games` table by team
// names + commence_time.

import axios from 'axios'
import 'dotenv/config'
import * as db from '../../lib/db.js'
import { getCached, sleep } from './cache.js'

const BASE = 'https://api.the-odds-api.com/v4'

async function fetchSnapshot(date) {
  const key = process.env.ODDS_API_KEY
  if (!key) throw new Error('ODDS_API_KEY not set')
  // Fetch noon ET snapshot — most books have opened by then
  return getCached('odds', `snap-${date}`, async () => {
    const iso = `${date}T12:00:00Z`
    const res = await axios.get(`${BASE}/historical/sports/baseball_mlb/odds`, {
      params: {
        apiKey: key,
        regions: 'us',
        markets: 'totals',
        date: iso,
        oddsFormat: 'decimal',
        bookmakers: 'draftkings,fanduel,betmgm,caesars,pointsbetus',
      },
      timeout: 30000,
      validateStatus: s => s >= 200 && s < 500,
    })
    if (res.status >= 400) {
      process.stderr.write(`[fetchOdds] ${date} -> HTTP ${res.status}\n`)
      return { data: [] }
    }
    return res.data
  })
}

function median(arr) {
  const v = arr.filter(x => typeof x === 'number' && !Number.isNaN(x)).sort((a, b) => a - b)
  if (!v.length) return null
  const mid = Math.floor(v.length / 2)
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2
}

function extractTotals(snap) {
  // Historical endpoint wraps payload under `.data[]`; current endpoint returns array directly
  const games = Array.isArray(snap) ? snap : (snap?.data || [])
  const out = []
  for (const g of games) {
    const lines = []
    for (const bk of g.bookmakers || []) {
      for (const m of bk.markets || []) {
        if (m.key === 'totals') {
          const [over] = m.outcomes || []
          if (over?.point != null) lines.push(over.point)
        }
      }
    }
    out.push({
      id: g.id,
      commence_time: g.commence_time,
      home_team: g.home_team,
      away_team: g.away_team,
      total: median(lines),
      bookmaker_count: (g.bookmakers || []).length,
    })
  }
  return out
}

/**
 * Normalise team name for fuzzy matching. Strips "the ", punctuation,
 * collapses whitespace.
 */
function normalizeTeam(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[.'"]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function teamsMatch(oddsTeam, gameTeam, gameTeamName) {
  const a = normalizeTeam(oddsTeam)
  const b = normalizeTeam(gameTeam)
  const c = normalizeTeam(gameTeamName)
  if (!a) return false
  // Check full abbreviation or common suffix (e.g. "yankees")
  if (a === b) return true
  if (c && a === c) return true
  const tail = a.split(' ').pop()
  if (tail && (tail === b || tail === c)) return true
  // Substring either direction
  if (a.includes(b) || b.includes(a)) return true
  if (c && (a.includes(c) || c.includes(a))) return true
  return false
}

/**
 * Ingest all opening lines for a single date — matches snapshot games to our
 * historical_games table and backfills `full_line_open`.
 */
export async function ingestDate(date) {
  const snap = await fetchSnapshot(date)
  const totals = extractTotals(snap)
  if (!totals.length) return { date, matched: 0, total: 0 }

  // Match by commence_time ± 24h window — opening lines are often posted days
  // before the game, so we can't restrict to games on the snapshot date.
  const gameDate = (iso) => iso ? iso.slice(0, 10) : null
  const uniqueDates = [...new Set(totals.map(og => gameDate(og.commence_time)).filter(Boolean))]

  // Fetch all candidate games whose game date matches any commence_time date in the snapshot
  let games = []
  for (const d of uniqueDates) {
    const rows = await db.all(
      `SELECT id, home_team, away_team, game_time FROM historical_games WHERE date = ?`,
      [d],
    )
    games = games.concat(rows)
  }
  if (!games.length) return { date, matched: 0, total: totals.length, _no_games_in_db: true }

  let matched = 0
  for (const og of totals) {
    if (og.total == null) continue
    const t = new Date(og.commence_time).getTime()
    let best = null
    let bestDelta = Infinity
    for (const g of games) {
      if (!teamsMatch(og.home_team, g.home_team, null)) continue
      if (!teamsMatch(og.away_team, g.away_team, null)) continue
      const delta = g.game_time ? Math.abs(new Date(g.game_time).getTime() - t) : 1e12
      if (delta > 12 * 3600 * 1000) continue
      if (delta < bestDelta) {
        best = g
        bestDelta = delta
      }
    }
    if (!best) continue
    await db.run(
      `UPDATE historical_games SET full_line_open = ? WHERE id = ?`,
      [og.total, best.id],
    )
    matched++
  }
  return { date, matched, total: totals.length }
}

export async function ingestDateRange(startDate, endDate, { throttleMs = 1200 } = {}) {
  const results = []
  let cur = new Date(startDate)
  const end = new Date(endDate)
  while (cur <= end) {
    const iso = cur.toISOString().slice(0, 10)
    try {
      const r = await ingestDate(iso)
      process.stderr.write(
        `[fetchOdds] ${iso}: matched ${r.matched}/${r.total}\n`,
      )
      results.push(r)
    } catch (err) {
      process.stderr.write(`[fetchOdds] ${iso}: ${err.message}\n`)
      results.push({ date: iso, error: err.message })
    }
    await sleep(throttleMs)
    cur.setUTCDate(cur.getUTCDate() + 1)
  }
  return results
}

/**
 * Post-2020 every regular-season MLB day — convenience wrapper.
 */
export async function ingestSeason(season) {
  // Regular season April through September (safe window)
  return ingestDateRange(`${season}-03-20`, `${season}-10-05`)
}
