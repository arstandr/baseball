// lib/mlbapi.js — Official MLB Stats API
// Free, official, no API key required.
// Base: https://statsapi.mlb.com/api/v1

import { fetch } from './http.js'

const BASE = 'https://statsapi.mlb.com/api/v1'

/**
 * Fetch the full schedule for one date. Hydrates probable pitchers and venue.
 * @param {string} date - YYYY-MM-DD
 */
export async function fetchTodaySchedule(date) {
  const url = `${BASE}/schedule`
  const res = await fetch('mlbapi.schedule', {
    method: 'GET',
    url,
    params: {
      sportId: 1,
      date,
      hydrate:
        'probablePitcher,linescore,team,venue,weather,decisions,game(content(summary))',
    },
  })
  if (!res.ok) return []
  const games = []
  for (const d of res.data.dates || []) {
    for (const g of d.games || []) {
      games.push({
        id: String(g.gamePk),
        date: g.officialDate || d.date,
        season: Number(g.season),
        game_time: g.gameDate,
        status: normalizeStatus(g.status),
        venue_id: String(g.venue?.id ?? ''),
        venue_name: g.venue?.name,
        team_home: g.teams?.home?.team?.abbreviation || g.teams?.home?.team?.name,
        team_away: g.teams?.away?.team?.abbreviation || g.teams?.away?.team?.name,
        team_home_id: String(g.teams?.home?.team?.id ?? ''),
        team_away_id: String(g.teams?.away?.team?.id ?? ''),
        pitcher_home_id: g.teams?.home?.probablePitcher?.id
          ? String(g.teams.home.probablePitcher.id)
          : null,
        pitcher_home_name: g.teams?.home?.probablePitcher?.fullName || null,
        pitcher_away_id: g.teams?.away?.probablePitcher?.id
          ? String(g.teams.away.probablePitcher.id)
          : null,
        pitcher_away_name: g.teams?.away?.probablePitcher?.fullName || null,
        double_header: g.doubleHeader && g.doubleHeader !== 'N',
        game_number: g.gameNumber,
      })
    }
  }
  return games
}

function normalizeStatus(s) {
  const code = (s?.abstractGameCode || s?.statusCode || '').toUpperCase()
  if (code === 'F' || code === 'O') return 'final'
  if (code === 'L' || code === 'I') return 'in_progress'
  if (code === 'P' || code === 'D') return 'postponed'
  return 'scheduled'
}

/**
 * Fetch the boxscore / linescore for a completed game — lets us compute F5 totals.
 */
export async function fetchGameResult(gameId) {
  const res = await fetch('mlbapi.linescore', {
    method: 'GET',
    url: `${BASE}.1/game/${gameId}/linescore`,
  })
  // Note: linescore is under v1.1 path
  if (!res.ok) {
    // Fall back to v1
    const v1 = await fetch('mlbapi.linescore', {
      method: 'GET',
      url: `${BASE}/game/${gameId}/linescore`,
    })
    if (!v1.ok) return null
    return parseLinescore(v1.data)
  }
  return parseLinescore(res.data)
}

function parseLinescore(data) {
  if (!data) return null
  const innings = data.innings || []
  let homeF5 = 0
  let awayF5 = 0
  let homeTotal = 0
  let awayTotal = 0
  for (const inn of innings) {
    const hr = inn.home?.runs ?? 0
    const ar = inn.away?.runs ?? 0
    homeTotal += hr
    awayTotal += ar
    if (inn.num <= 5) {
      homeF5 += hr
      awayF5 += ar
    }
  }
  // Prefer top-level teams totals (authoritative) when available
  const homeAuth = data.teams?.home?.runs
  const awayAuth = data.teams?.away?.runs
  if (typeof homeAuth === 'number') homeTotal = homeAuth
  if (typeof awayAuth === 'number') awayTotal = awayAuth

  return {
    innings: innings.length,
    // Full-game fields (primary)
    actual_runs_home: homeTotal,
    actual_runs_away: awayTotal,
    actual_runs_total: homeTotal + awayTotal,
    // F5 fields retained for legacy / backtest compatibility
    actual_f5_runs_home: homeF5,
    actual_f5_runs_away: awayF5,
    actual_f5_total: homeF5 + awayF5,
    is_final: (data.currentInning || 0) >= 9 && !data.isTopInning ? true : false,
  }
}

/**
 * Fetch confirmed lineup for a team in a given game. Returns null if lineup
 * isn't posted yet (usually available 2-3 hours before first pitch).
 */
export async function fetchLineup(gameId, teamSide = 'home') {
  const res = await fetch('mlbapi.boxscore', {
    method: 'GET',
    url: `${BASE}/game/${gameId}/boxscore`,
  })
  if (!res.ok) return null
  const team = res.data.teams?.[teamSide]
  if (!team?.battingOrder?.length) return null
  const players = team.battingOrder.map(pid => {
    const p = team.players?.[`ID${pid}`]
    return {
      id: String(pid),
      name: p?.person?.fullName,
      pos: p?.position?.abbreviation,
      battingOrder: p?.battingOrder,
    }
  })
  return players
}

/**
 * Fetch pitcher season stats from the official Stats API.
 * Returns null on any failure so callers can fall back to Fangraphs/Savant.
 */
export async function fetchPitcherSeasonStats(pitcherId, season) {
  const res = await fetch('mlbapi.pitcher_stats', {
    method: 'GET',
    url: `${BASE}/people/${pitcherId}/stats`,
    params: {
      stats: 'season',
      group: 'pitching',
      season,
      sportId: 1,
    },
  })
  if (!res.ok) return null
  const splits = res.data.stats?.[0]?.splits?.[0]?.stat
  if (!splits) return null
  return {
    era: Number(splits.era),
    whip: Number(splits.whip),
    innings: Number(splits.inningsPitched),
    strikeOuts: Number(splits.strikeOuts),
    baseOnBalls: Number(splits.baseOnBalls),
    homeRuns: Number(splits.homeRuns),
    k9: Number(splits.strikeoutsPer9Inn),
    bb9: Number(splits.walksPer9Inn),
    gamesStarted: Number(splits.gamesStarted),
  }
}

/**
 * Fetch a pitcher's game log for the current season (for L5 stats, rest days).
 */
export async function fetchPitcherGameLog(pitcherId, season) {
  const res = await fetch('mlbapi.pitcher_gamelog', {
    method: 'GET',
    url: `${BASE}/people/${pitcherId}/stats`,
    params: {
      stats: 'gameLog',
      group: 'pitching',
      season,
      sportId: 1,
    },
  })
  if (!res.ok) return []
  const splits = res.data.stats?.[0]?.splits || []
  return splits.map(s => ({
    date: s.date,
    opponent: s.opponent?.abbreviation || s.opponent?.name,
    venue_id: String(s.venue?.id ?? ''),
    innings: Number(s.stat?.inningsPitched ?? 0),
    runs: Number(s.stat?.runs ?? 0),
    earnedRuns: Number(s.stat?.earnedRuns ?? 0),
    strikeOuts: Number(s.stat?.strikeOuts ?? 0),
    pitches: Number(s.stat?.numberOfPitches ?? 0),
    homeRuns: Number(s.stat?.homeRuns ?? 0),
    hits: Number(s.stat?.hits ?? 0),
    walks: Number(s.stat?.baseOnBalls ?? 0),
  }))
}

/**
 * Simple handedness lookup via /people.
 */
export async function fetchPitcherHand(pitcherId) {
  const res = await fetch('mlbapi.person', {
    method: 'GET',
    url: `${BASE}/people/${pitcherId}`,
  })
  if (!res.ok) return null
  return res.data.people?.[0]?.pitchHand?.code || 'R'
}

/**
 * Pull active injury list entries for pitchers — fed into the Scout news layer.
 * Endpoint shape changes occasionally; we defensively handle empty payloads.
 */
export async function fetchInjuryReport() {
  const res = await fetch('mlbapi.injury', {
    method: 'GET',
    url: `${BASE}/reports/injury`,
  })
  if (!res.ok) return []
  return res.data?.injuries || []
}
