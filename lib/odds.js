// lib/odds.js — The Odds API
//
// MLB: F5 + full game totals.
// NBA: game totals (consensus Vegas line from DK/FD/MGM).
//
// The Odds API returns a per-bookmaker list; we compute the consensus line
// and a per-bookmaker median as market_consensus.

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

// ===========================================================================
// NBA helpers
// ===========================================================================

/**
 * Fetch NBA game totals from The Odds API.
 * Returns consensus Vegas line (median across bookmakers) per game.
 */
export async function fetchNBALines({
  bookmakers = ['draftkings', 'fanduel', 'betmgm'],
} = {}) {
  const key = process.env.ODDS_API_KEY
  if (!key) return { ok: false, error: 'missing_api_key' }
  const res = await fetch('odds_api.nba', {
    method: 'GET',
    url: `${BASE}/sports/basketball_nba/odds`,
    params: {
      apiKey:     key,
      regions:    'us',
      markets:    'totals,h2h',
      oddsFormat: 'american',
      bookmakers: bookmakers.join(','),
      dateFormat: 'iso',
    },
  })
  if (!res.ok) return { ok: false, error: res.error || res.reason }
  const games = (res.data || []).map(normalizeNBAOddsGame)
  return { ok: true, games, remaining: res.headers?.['x-requests-remaining'] }
}

function normalizeNBAOddsGame(g) {
  const totalLines = []
  for (const bk of g.bookmakers || []) {
    for (const m of bk.markets || []) {
      if (m.key === 'totals') {
        const over  = m.outcomes?.find(o => o.name === 'Over')
        const under = m.outcomes?.find(o => o.name === 'Under')
        if (over && under) {
          totalLines.push({
            book:        bk.key,
            line:        over.point,
            over_price:  over.price,    // American odds e.g. -110
            under_price: under.price,
            ts:          m.last_update || bk.last_update,
          })
        }
      }
    }
  }

  const consensusLine = median(totalLines.map(x => x.line))

  // Convert American odds to implied probability (vig-free)
  const toImplied = american => {
    if (american == null) return 0.5
    return american < 0
      ? Math.abs(american) / (Math.abs(american) + 100)
      : 100 / (american + 100)
  }

  // Average vig-free over probability at consensus line
  const overProbs = totalLines
    .filter(x => Math.abs(x.line - consensusLine) < 0.1)
    .map(x => toImplied(x.over_price))
  const overProb = overProbs.length
    ? overProbs.reduce((a, b) => a + b, 0) / overProbs.length
    : 0.5

  return {
    id:            g.id,
    commence_time: g.commence_time,
    home_team:     g.home_team,
    away_team:     g.away_team,
    total_line:    consensusLine,     // Vegas consensus total
    over_prob:     overProb,          // vig-free P(over) at consensus line
    total_lines:   totalLines,
  }
}

/**
 * Map The Odds API NBA games to our nba_games table rows by team name.
 * The Odds API uses full names ("Denver Nuggets"); we use abbreviations ("DEN").
 */
export function matchNBAOddsToGames(oddsGames, nbaGames) {
  const NBA_NAME_TO_ABBR = {
    'Atlanta Hawks': 'ATL', 'Boston Celtics': 'BOS', 'Brooklyn Nets': 'BKN',
    'Charlotte Hornets': 'CHA', 'Chicago Bulls': 'CHI', 'Cleveland Cavaliers': 'CLE',
    'Dallas Mavericks': 'DAL', 'Denver Nuggets': 'DEN', 'Detroit Pistons': 'DET',
    'Golden State Warriors': 'GSW', 'Houston Rockets': 'HOU', 'Indiana Pacers': 'IND',
    'LA Clippers': 'LAC', 'Los Angeles Clippers': 'LAC', 'Los Angeles Lakers': 'LAL',
    'Memphis Grizzlies': 'MEM', 'Miami Heat': 'MIA', 'Milwaukee Bucks': 'MIL',
    'Minnesota Timberwolves': 'MIN', 'New Orleans Pelicans': 'NOP',
    'New York Knicks': 'NYK', 'Oklahoma City Thunder': 'OKC', 'Orlando Magic': 'ORL',
    'Philadelphia 76ers': 'PHI', 'Phoenix Suns': 'PHX', 'Portland Trail Blazers': 'POR',
    'Sacramento Kings': 'SAC', 'San Antonio Spurs': 'SAS', 'Toronto Raptors': 'TOR',
    'Utah Jazz': 'UTA', 'Washington Wizards': 'WSH',
  }
  const toAbbr = name => NBA_NAME_TO_ABBR[name] ?? name?.split(' ').pop().slice(0, 3).toUpperCase()

  const matches = new Map()   // nba_game.id → oddsGame
  for (const og of oddsGames) {
    const awayAbbr = toAbbr(og.away_team)
    const homeAbbr = toAbbr(og.home_team)
    const match = nbaGames.find(g => g.team_away === awayAbbr && g.team_home === homeAbbr)
    if (match) matches.set(match.id, og)
  }
  return matches
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
