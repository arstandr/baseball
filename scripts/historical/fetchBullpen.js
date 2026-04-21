// scripts/historical/fetchBullpen.js — rolling 14-day bullpen features.
//
// Approach: for each (team, date) in historical_games, aggregate all pitching
// performances from that team's game logs (team-level stats endpoint) where
// role != starter. The MLB Stats API team pitching gameLog includes a split
// record per game — we derive team bullpen stats by subtracting the starter's
// line from the team total for each game.

import axios from 'axios'
import 'dotenv/config'
import * as db from '../../lib/db.js'
import { getCached, sleep } from './cache.js'

const MLB_BASE = 'https://statsapi.mlb.com/api/v1'
const THROTTLE_MS = 120

async function fetchTeamPitchingLog(teamId, season) {
  return getCached('bullpen', `team-${teamId}-${season}`, async () => {
    try {
      const res = await axios.get(`${MLB_BASE}/teams/${teamId}/stats`, {
        params: {
          stats: 'gameLog',
          group: 'pitching',
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
        innings: Number(s.stat?.inningsPitched || 0),
        earned_runs: Number(s.stat?.earnedRuns || 0),
        hits: Number(s.stat?.hits || 0),
        walks: Number(s.stat?.baseOnBalls || 0),
        strikeouts: Number(s.stat?.strikeOuts || 0),
        home_runs: Number(s.stat?.homeRuns || 0),
        batters_faced: Number(s.stat?.battersFaced || 0),
      }))
    } catch {
      return []
    }
  })
}

async function fetchStarterLineForGame(teamId, gameId) {
  // Box score has per-pitcher lines; we sum up starter's innings to subtract.
  return getCached('bullpen', `box-${teamId}-${gameId}`, async () => {
    try {
      const res = await axios.get(`${MLB_BASE}/game/${gameId}/boxscore`, {
        timeout: 20000,
        validateStatus: s => s >= 200 && s < 500,
      })
      if (res.status >= 400) return null
      // Identify side
      const home = res.data.teams?.home
      const away = res.data.teams?.away
      const side = String(home?.team?.id) === String(teamId) ? home : away
      if (!side?.players) return null
      // Find the first pitcher (games started > 0)
      let starter = null
      for (const pid of Object.keys(side.players)) {
        const p = side.players[pid]
        if (
          p.stats?.pitching &&
          (Number(p.stats.pitching.gamesStarted) === 1 || p.stats.pitching.gamesStarted === '1')
        ) {
          starter = p
          break
        }
      }
      if (!starter) return null
      const s = starter.stats.pitching
      return {
        innings: Number(s.inningsPitched || 0),
        earned_runs: Number(s.earnedRuns || 0),
        hits: Number(s.hits || 0),
        walks: Number(s.baseOnBalls || 0),
        strikeouts: Number(s.strikeOuts || 0),
        home_runs: Number(s.homeRuns || 0),
        batters_faced: Number(s.battersFaced || 0),
      }
    } catch {
      return null
    }
  })
}

export async function computeBullpenAsOf(teamId, asOfDate, season) {
  const teamLog = await fetchTeamPitchingLog(teamId, season)
  const cutoff = new Date(asOfDate).getTime()
  const windowStart = cutoff - 14 * 24 * 3600 * 1000
  const inWindow = teamLog.filter(r => {
    const t = new Date(r.date).getTime()
    return t && t >= windowStart && t < cutoff
  })
  if (!inWindow.length) {
    return {
      era_14d: null,
      whip_14d: null,
      k_pct_14d: null,
      hr_per_9_14d: null,
      inherited_score_pct: null,
      n: 0,
    }
  }

  // Subtract starter lines from team totals to get bullpen totals
  let innings = 0, er = 0, hits = 0, walks = 0, k = 0, hr = 0, bf = 0
  for (const g of inWindow) {
    const starter = g.game_id
      ? await fetchStarterLineForGame(teamId, g.game_id).catch(() => null)
      : null
    await sleep(30)
    const bpIP = Math.max(0, g.innings - (starter?.innings || 0))
    if (bpIP <= 0) continue
    innings += bpIP
    er += Math.max(0, g.earned_runs - (starter?.earned_runs || 0))
    hits += Math.max(0, g.hits - (starter?.hits || 0))
    walks += Math.max(0, g.walks - (starter?.walks || 0))
    k += Math.max(0, g.strikeouts - (starter?.strikeouts || 0))
    hr += Math.max(0, g.home_runs - (starter?.home_runs || 0))
    bf += Math.max(0, g.batters_faced - (starter?.batters_faced || 0))
  }

  if (innings < 1) {
    return {
      era_14d: null,
      whip_14d: null,
      k_pct_14d: null,
      hr_per_9_14d: null,
      inherited_score_pct: null,
      n: 0,
    }
  }

  return {
    era_14d: Number(((er / innings) * 9).toFixed(2)),
    whip_14d: Number(((hits + walks) / innings).toFixed(3)),
    k_pct_14d: bf > 0 ? Number((k / bf).toFixed(4)) : null,
    hr_per_9_14d: Number(((hr / innings) * 9).toFixed(3)),
    // Not available at team-log level — use league avg as placeholder
    inherited_score_pct: 0.33,
    innings_14d: Number(innings.toFixed(1)),
    n: inWindow.length,
  }
}

export async function ingestTeamAsOf(teamId, asOfDate, season) {
  const stats = await computeBullpenAsOf(teamId, asOfDate, season)
  await db.upsert(
    'historical_bullpen_stats',
    {
      team_id: Number(teamId),
      as_of_date: asOfDate,
      era_14d: stats.era_14d,
      whip_14d: stats.whip_14d,
      k_pct_14d: stats.k_pct_14d,
      hr_per_9_14d: stats.hr_per_9_14d,
      inherited_score_pct: stats.inherited_score_pct,
    },
    ['team_id', 'as_of_date'],
  )
  return stats
}

export async function ingestSeason(season) {
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
        `[bullpen] tid=${r.tid} ${r.date}: ${err.message?.slice(0, 120)}\n`,
      )
    }
    done++
    if (done % 200 === 0) {
      process.stderr.write(
        `[bullpen] season ${season}: ${done}/${rows.length}\n`,
      )
    }
  }
  return { season, processed: done }
}
