// scripts/historical/fetchGames.js — fetch every MLB regular-season game
// 2020-2025, extract linescores, and store in SQLite.
//
//   GET /api/v1/schedule?sportId=1&season={year}&gameType=R&hydrate=linescore,
//       probablePitcher,venue
//
// Then per finished game fetch /api/v1/game/{gamePk}/linescore to extract
// total runs (the schedule hydrate doesn't always include inning detail for
// old seasons).

import axios from 'axios'
import 'dotenv/config'
import * as db from '../../lib/db.js'
import { getCached, sleep } from './cache.js'

const MLB_BASE = 'https://statsapi.mlb.com/api/v1'
const THROTTLE_MS = 100 // MLB Stats API politeness

async function mlbGet(url, params) {
  const res = await axios.get(url, {
    params,
    timeout: 30000,
    validateStatus: s => s >= 200 && s < 500,
  })
  if (res.status >= 400) {
    throw new Error(`mlb ${url} ${res.status}: ${JSON.stringify(res.data).slice(0, 200)}`)
  }
  return res.data
}

export async function fetchSeasonSchedule(season) {
  return getCached('games', `schedule-${season}`, async () => {
    const data = await mlbGet(`${MLB_BASE}/schedule`, {
      sportId: 1,
      season,
      gameType: 'R',
      hydrate: 'linescore,probablePitcher,venue',
    })
    return data
  })
}

export async function fetchLinescore(gameId) {
  return getCached('games', `linescore-${gameId}`, async () => {
    try {
      // v1.1 first (richer payload), then fall back to v1
      try {
        const v11 = await axios.get(
          `https://statsapi.mlb.com/api/v1.1/game/${gameId}/linescore`,
          { timeout: 20000, validateStatus: s => s >= 200 && s < 500 },
        )
        if (v11.status < 400) return v11.data
      } catch {
        // fall through
      }
      const v1 = await axios.get(`${MLB_BASE}/game/${gameId}/linescore`, {
        timeout: 20000,
        validateStatus: s => s >= 200 && s < 500,
      })
      if (v1.status < 400) return v1.data
      return null
    } catch (err) {
      return null
    }
  })
}

function parseLinescore(ls) {
  if (!ls) return { home: null, away: null }
  const home = ls.teams?.home?.runs
  const away = ls.teams?.away?.runs
  if (typeof home === 'number' && typeof away === 'number') {
    return { home, away }
  }
  // Fallback: sum innings
  let h = 0, a = 0, hasAny = false
  for (const inn of ls.innings || []) {
    if (typeof inn.home?.runs === 'number') { h += inn.home.runs; hasAny = true }
    if (typeof inn.away?.runs === 'number') { a += inn.away.runs; hasAny = true }
  }
  if (!hasAny) return { home: null, away: null }
  return { home: h, away: a }
}

/**
 * Ingest one season into historical_games. Uses upsert-by-id so reruns are idempotent.
 */
export async function ingestSeason(season) {
  const data = await fetchSeasonSchedule(season)
  let inserted = 0
  let skipped = 0
  const dates = data?.dates || []
  for (const d of dates) {
    for (const g of d.games || []) {
      if (g.status?.abstractGameCode === 'P' || g.status?.abstractGameCode === 'D') {
        skipped++
        continue
      }
      // Get linescore if game is final — otherwise we only store schedule info
      let runsHome = null, runsAway = null
      if (['F', 'O'].includes(g.status?.abstractGameCode)) {
        const ls = await fetchLinescore(g.gamePk)
        const parsed = parseLinescore(ls)
        runsHome = parsed.home
        runsAway = parsed.away
        await sleep(THROTTLE_MS)
      }

      await db.upsert(
        'historical_games',
        {
          id: String(g.gamePk),
          date: g.officialDate || d.date,
          season,
          home_team:
            g.teams?.home?.team?.abbreviation ||
            g.teams?.home?.team?.name ||
            '',
          away_team:
            g.teams?.away?.team?.abbreviation ||
            g.teams?.away?.team?.name ||
            '',
          home_team_id: g.teams?.home?.team?.id ?? null,
          away_team_id: g.teams?.away?.team?.id ?? null,
          venue_id: g.venue?.id ? String(g.venue.id) : null,
          game_time: g.gameDate,
          pitcher_home_id: g.teams?.home?.probablePitcher?.id
            ? String(g.teams.home.probablePitcher.id)
            : null,
          pitcher_away_id: g.teams?.away?.probablePitcher?.id
            ? String(g.teams.away.probablePitcher.id)
            : null,
          actual_runs_home: runsHome,
          actual_runs_away: runsAway,
          actual_runs_total:
            typeof runsHome === 'number' && typeof runsAway === 'number'
              ? runsHome + runsAway
              : null,
        },
        ['id'],
      )
      inserted++
    }
  }
  return { season, inserted, skipped }
}

export async function ingestRange(startSeason, endSeason) {
  const out = []
  for (let s = startSeason; s <= endSeason; s++) {
    process.stderr.write(`[fetchGames] season ${s}…\n`)
    const r = await ingestSeason(s)
    out.push(r)
    process.stderr.write(
      `[fetchGames] season ${s}: ${r.inserted} games inserted, ${r.skipped} skipped\n`,
    )
  }
  return out
}
