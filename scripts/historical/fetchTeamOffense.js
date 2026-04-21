// scripts/historical/fetchTeamOffense.js — compute team offensive features
// rolling 14 days before each game date from MLB Stats API team game logs.
//
//   GET /api/v1/teams/{team_id}/stats?group=hitting&type=gameLog&season={year}

import axios from 'axios'
import 'dotenv/config'
import * as db from '../../lib/db.js'
import { getCached, sleep } from './cache.js'

const MLB_BASE = 'https://statsapi.mlb.com/api/v1'
const THROTTLE_MS = 100

async function fetchTeamGameLog(teamId, season) {
  return getCached('teams', `gamelog-${teamId}-${season}`, async () => {
    try {
      const res = await axios.get(`${MLB_BASE}/teams/${teamId}/stats`, {
        params: {
          stats: 'gameLog',
          group: 'hitting',
          season,
          sportId: 1,
        },
        timeout: 20000,
        validateStatus: s => s >= 200 && s < 500,
      })
      if (res.status >= 400) return []
      const splits = res.data.stats?.[0]?.splits || []
      return splits.map(s => ({
        date: s.date,
        game_id: s.game?.gamePk ? String(s.game.gamePk) : null,
        plate_appearances: Number(s.stat?.plateAppearances || 0),
        at_bats: Number(s.stat?.atBats || 0),
        hits: Number(s.stat?.hits || 0),
        home_runs: Number(s.stat?.homeRuns || 0),
        strikeouts: Number(s.stat?.strikeOuts || 0),
        walks: Number(s.stat?.baseOnBalls || 0),
        runs: Number(s.stat?.runs || 0),
        obp: Number(s.stat?.obp || 0),
      }))
    } catch {
      return []
    }
  })
}

export function computeRolling(log, asOfDate, windowDays = 14) {
  const cutoff = new Date(asOfDate).getTime()
  const start = cutoff - windowDays * 24 * 3600 * 1000
  const games = (log || []).filter(r => {
    const t = new Date(r.date).getTime()
    return t && t >= start && t < cutoff
  })
  if (!games.length) {
    return {
      runs_pg_14d: null,
      k_pct_14d: null,
      obp_14d: null,
      hr_pg_14d: null,
      n: 0,
    }
  }
  const pa = games.reduce((s, r) => s + r.plate_appearances, 0)
  const k = games.reduce((s, r) => s + r.strikeouts, 0)
  const runs = games.reduce((s, r) => s + r.runs, 0)
  const hr = games.reduce((s, r) => s + r.home_runs, 0)
  const hits = games.reduce((s, r) => s + r.hits, 0)
  const bb = games.reduce((s, r) => s + r.walks, 0)
  const ab = games.reduce((s, r) => s + r.at_bats, 0)
  const obpDenom = ab + bb
  const obp_14d = obpDenom > 0 ? Number(((hits + bb) / obpDenom).toFixed(4)) : null

  return {
    runs_pg_14d: Number((runs / games.length).toFixed(2)),
    k_pct_14d: pa > 0 ? Number((k / pa).toFixed(4)) : null,
    obp_14d,
    hr_pg_14d: Number((hr / games.length).toFixed(3)),
    n: games.length,
  }
}

export async function ingestTeamAsOf(teamId, asOfDate, season, vsHand = 'R') {
  const log = await fetchTeamGameLog(teamId, season)
  const rolling = computeRolling(log, asOfDate)

  await db.upsert(
    'historical_team_offense',
    {
      team_id: Number(teamId),
      as_of_date: asOfDate,
      vs_hand: vsHand,
      runs_pg_14d: rolling.runs_pg_14d,
      k_pct_14d: rolling.k_pct_14d,
      obp_14d: rolling.obp_14d,
      hr_pg_14d: rolling.hr_pg_14d,
    },
    ['team_id', 'as_of_date', 'vs_hand'],
  )

  return rolling
}

export async function ingestSeason(season) {
  // For each (team, game) pair in historical_games, backfill rolling offense.
  const rows = await db.all(
    `SELECT DISTINCT home_team_id AS tid, date FROM historical_games WHERE season = ? AND home_team_id IS NOT NULL
     UNION
     SELECT DISTINCT away_team_id AS tid, date FROM historical_games WHERE season = ? AND away_team_id IS NOT NULL`,
    [season, season],
  )
  let done = 0
  for (const r of rows) {
    if (!r.tid) continue
    try {
      await ingestTeamAsOf(r.tid, r.date, season)
      await sleep(THROTTLE_MS)
    } catch (err) {
      process.stderr.write(
        `[team_offense] tid=${r.tid} ${r.date}: ${err.message?.slice(0, 120)}\n`,
      )
    }
    done++
    if (done % 500 === 0) {
      process.stderr.write(
        `[team_offense] season ${season}: ${done}/${rows.length}\n`,
      )
    }
  }
  return { season, processed: done }
}
