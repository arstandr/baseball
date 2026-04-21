// lib/odds.js — The Odds API
//
// We fetch F5 (first 5 innings) + full game totals for all MLB games. The
// Odds API returns a per-bookmaker list; we compute the consensus line and
// a per-bookmaker median as market_consensus. First time we see a game
// id we store the line as opening; subsequent calls append movement history.

import { fetch } from './http.js'
import 'dotenv/config'

const BASE = 'https://api.the-odds-api.com/v4'

/**
 * Fetch current lines for all MLB games. Default markets: totals + h2h.
 * Regions: us. Bookmakers default to DK, FD, MGM.
 */
export async function fetchCurrentLines({
  bookmakers = ['draftkings', 'fanduel', 'betmgm'],
  markets = ['totals', 'h2h'],
} = {}) {
  const key = process.env.ODDS_API_KEY
  if (!key) return { ok: false, error: 'missing_api_key' }
  const res = await fetch('odds_api.current', {
    method: 'GET',
    url: `${BASE}/sports/baseball_mlb/odds`,
    params: {
      apiKey: key,
      regions: 'us',
      markets: markets.join(','),
      oddsFormat: 'decimal',
      bookmakers: bookmakers.join(','),
      dateFormat: 'iso',
    },
  })
  if (!res.ok) return { ok: false, error: res.error || res.reason }
  const games = (res.data || []).map(normalizeOddsGame)
  return { ok: true, games, remaining: res.headers?.['x-requests-remaining'] }
}

/**
 * Fetch First 5 Innings (F5) lines specifically via alternates market.
 * The Odds API exposes F5 under market key `totals_1st_5_innings`.
 */
export async function fetchF5Lines({
  bookmakers = ['draftkings', 'fanduel', 'betmgm'],
} = {}) {
  const key = process.env.ODDS_API_KEY
  if (!key) return { ok: false, error: 'missing_api_key' }
  const res = await fetch('odds_api.f5', {
    method: 'GET',
    url: `${BASE}/sports/baseball_mlb/odds`,
    params: {
      apiKey: key,
      regions: 'us',
      markets: 'totals_1st_5_innings,h2h_1st_5_innings',
      oddsFormat: 'decimal',
      bookmakers: bookmakers.join(','),
      dateFormat: 'iso',
    },
  })
  if (!res.ok) return { ok: false, error: res.error || res.reason }
  const games = (res.data || []).map(normalizeOddsGame)
  return { ok: true, games, remaining: res.headers?.['x-requests-remaining'] }
}

/**
 * Historical lines for backtesting. The Odds API historical endpoint is
 * paid-tier; we expose it for completeness.
 */
export async function fetchHistoricalLines(date, {
  bookmakers = ['draftkings', 'fanduel'],
} = {}) {
  const key = process.env.ODDS_API_KEY
  if (!key) return { ok: false, error: 'missing_api_key' }
  const res = await fetch('odds_api.historical', {
    method: 'GET',
    url: `${BASE}/historical/sports/baseball_mlb/odds`,
    params: {
      apiKey: key,
      regions: 'us',
      markets: 'totals,totals_1st_5_innings',
      date: `${date}T12:00:00Z`,
      oddsFormat: 'decimal',
      bookmakers: bookmakers.join(','),
    },
  })
  if (!res.ok) return { ok: false, error: res.error || res.reason }
  return { ok: true, snapshot: res.data }
}

/**
 * Normalise a single odds-api game into the shape our pipeline expects.
 * The api returns an array of bookmakers each with their own markets. We
 * median the over/under lines across books and compute consensus.
 */
function normalizeOddsGame(g) {
  const f5Lines = []
  const fullLines = []
  const mls = []
  for (const bk of g.bookmakers || []) {
    for (const m of bk.markets || []) {
      if (m.key === 'totals_1st_5_innings') {
        const [over, under] = m.outcomes || []
        if (over && under) {
          f5Lines.push({
            book: bk.key,
            line: over.point,
            over_price: 1 / (over.price || 1),
            under_price: 1 / (under.price || 1),
            ts: m.last_update || bk.last_update,
          })
        }
      } else if (m.key === 'totals') {
        const [over, under] = m.outcomes || []
        if (over && under) {
          fullLines.push({
            book: bk.key,
            line: over.point,
            over_price: 1 / (over.price || 1),
            under_price: 1 / (under.price || 1),
            ts: m.last_update || bk.last_update,
          })
        }
      } else if (m.key === 'h2h' || m.key === 'h2h_1st_5_innings') {
        mls.push({ book: bk.key, outcomes: m.outcomes, ts: m.last_update })
      }
    }
  }
  return {
    id: g.id,
    commence_time: g.commence_time,
    home_team: g.home_team,
    away_team: g.away_team,
    f5_total: median(f5Lines.map(x => x.line)),
    full_total: median(fullLines.map(x => x.line)),
    f5_lines: f5Lines,
    full_lines: fullLines,
    mls,
  }
}

function median(arr) {
  const v = arr.filter(x => typeof x === 'number').sort((a, b) => a - b)
  if (!v.length) return null
  const mid = Math.floor(v.length / 2)
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2
}

/**
 * Map The Odds API game (home/away team names) to our internal game id.
 * Matching is a best-effort fuzzy join on commence_time + team names.
 */
export function matchOddsToSchedule(oddsGames, scheduleGames) {
  const matches = new Map()
  for (const og of oddsGames) {
    const t = new Date(og.commence_time).getTime()
    let best = null
    let bestDelta = Infinity
    for (const sg of scheduleGames) {
      if (!sg.game_time) continue
      const delta = Math.abs(new Date(sg.game_time).getTime() - t)
      if (delta > 3 * 3600 * 1000) continue
      // team name match via substring (team_home/away are abbreviations,
      // odds-api uses full names)
      const homeMatch =
        og.home_team?.toLowerCase().includes(sg.team_home?.toLowerCase() || '_none_') ||
        sg.team_home?.toLowerCase().includes(og.home_team?.toLowerCase().split(' ').pop())
      if (!homeMatch) continue
      if (delta < bestDelta) {
        best = sg
        bestDelta = delta
      }
    }
    if (best) matches.set(best.id, og)
  }
  return matches
}
