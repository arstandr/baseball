// scripts/nba/fetchNBA3PTStats.js — Fetch player 3PT stats + opponent 3PT defense.
//
// Pulls from NBA Stats API (free, no key):
//   - Player season 3PA/3P% (per game)
//   - Player last-5-game 3PA/3P%
//   - Team opponent 3PA allowed per game (defense)
//
// Usage:
//   node scripts/nba/fetchNBA3PTStats.js [--date YYYY-MM-DD] [--season-type Playoffs]

import 'dotenv/config'
import * as db from '../../lib/db.js'
import { parseArgs } from '../../lib/cli-args.js'

const opts        = parseArgs({ date: { default: new Date().toISOString().slice(0,10) }, 'season-type': { default: 'Playoffs' } })
const TODAY       = opts.date
const SEASON_TYPE = opts['season-type']
const SEASON      = '2025-26'

const BASE = 'https://stats.nba.com/stats'
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Referer':    'https://www.nba.com/stats/players/traditional',
  'Origin':     'https://www.nba.com',
  'Accept':     'application/json',
  'x-nba-stats-origin': 'stats',
  'x-nba-stats-token':  'true',
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

await db.migrate()

async function fetchStats(endpoint, params, attempt = 0) {
  const url = `${BASE}/${endpoint}?` + new URLSearchParams(params).toString()
  try {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(20000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    const rs = data?.resultSets?.[0]
    if (!rs) return []
    return rs.rowSet.map(row => Object.fromEntries(rs.headers.map((h, i) => [h, row[i]])))
  } catch (err) {
    if (attempt < 2) {
      await sleep((attempt + 1) * 3000)
      return fetchStats(endpoint, params, attempt + 1)
    }
    console.warn(`[3pt-stats] fetch failed (${endpoint}):`, err.message)
    return []
  }
}

console.log(`[3pt-stats] Fetching NBA 3PT stats (${SEASON_TYPE}, ${SEASON})…`)

// 1. Season player stats
const seasonRows = await fetchStats('leaguedashplayerstats', {
  Season: SEASON, SeasonType: SEASON_TYPE, MeasureType: 'Base',
  PerMode: 'PerGame', LastNGames: 0,
  PaceAdjust: 'N', PlusMinus: 'N', Rank: 'N',
  Outcome: '', Location: '', Month: 0, SeasonSegment: '',
  DateFrom: '', DateTo: '', OpponentTeamID: 0,
  VsConference: '', VsDivision: '', GameSegment: '', Period: 0,
  ShotClockRange: '', GameScope: '', PlayerExperience: '',
  PlayerPosition: '', StarterBench: '',
})
await sleep(1500)

// 2. Last-5-game player stats
const last5Rows = await fetchStats('leaguedashplayerstats', {
  Season: SEASON, SeasonType: SEASON_TYPE, MeasureType: 'Base',
  PerMode: 'PerGame', LastNGames: 5,
  PaceAdjust: 'N', PlusMinus: 'N', Rank: 'N',
  Outcome: '', Location: '', Month: 0, SeasonSegment: '',
  DateFrom: '', DateTo: '', OpponentTeamID: 0,
  VsConference: '', VsDivision: '', GameSegment: '', Period: 0,
  ShotClockRange: '', GameScope: '', PlayerExperience: '',
  PlayerPosition: '', StarterBench: '',
})
await sleep(1500)

// 3. Opponent 3PT defense (team-level)
const oppRows = await fetchStats('leaguedashteamstats', {
  Season: SEASON, SeasonType: SEASON_TYPE, MeasureType: 'Opponent',
  PerMode: 'PerGame', LastNGames: 0,
  PaceAdjust: 'N', PlusMinus: 'N', Rank: 'N',
  Outcome: '', Location: '', Month: 0, SeasonSegment: '',
  DateFrom: '', DateTo: '', OpponentTeamID: 0,
  VsConference: '', VsDivision: '', GameSegment: '', Period: 0,
  ShotClockRange: '', GameScope: '', PlayerExperience: '',
  PlayerPosition: '', StarterBench: '',
})

const clean = v => {
  if (v == null) return null
  if (typeof v === 'number') return isFinite(v) ? v : null
  if (typeof v === 'string' || typeof v === 'boolean') return v
  return null  // drop objects, arrays, etc.
}

const safeInsertPlayer = async (r, window) => {
  const vals = [
    String(r.PLAYER_ID), String(r.PLAYER_NAME || ''), TODAY, window, SEASON_TYPE,
    clean(r.TEAM_ABBREVIATION), clean(r.GP), clean(r.MIN),
    clean(r.FG3A), clean(r.FG3M), clean(r.FG3_PCT),
  ]
  try {
    await db.run(`
      INSERT INTO nba_player_3pt_stats (player_id, player_name, stat_date, window, season_type, team_id, gp, minutes_pg, fg3a_pg, fg3m_pg, fg3_pct)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(player_id, stat_date, window) DO UPDATE SET
        fg3a_pg=excluded.fg3a_pg, fg3m_pg=excluded.fg3m_pg, fg3_pct=excluded.fg3_pct,
        minutes_pg=excluded.minutes_pg, gp=excluded.gp, team_id=excluded.team_id
    `, vals)
    return true
  } catch (err) {
    console.warn(`[3pt-stats] skip ${r.PLAYER_NAME} (${window}): ${err.message}`)
    return false
  }
}

// Save player season stats
let saved = 0
for (const r of seasonRows) {
  if (await safeInsertPlayer(r, 'season')) saved++
}

// Save last-5 stats
for (const r of last5Rows) { await safeInsertPlayer(r, 'last5') }

// Save opponent defense
for (const r of oppRows) {
  try {
    await db.run(`
      INSERT INTO nba_opp_3pt_defense (team_id, stat_date, season_type, opp_fg3a_pg, opp_fg3m_pg, opp_fg3_pct)
      VALUES (?,?,?,?,?,?)
      ON CONFLICT(team_id, stat_date) DO UPDATE SET
        opp_fg3a_pg=excluded.opp_fg3a_pg, opp_fg3m_pg=excluded.opp_fg3m_pg, opp_fg3_pct=excluded.opp_fg3_pct
    `, [
      String(r.TEAM_ABBREVIATION), TODAY, SEASON_TYPE,
      clean(r.OPP_FG3A), clean(r.OPP_FG3M), clean(r.OPP_FG3_PCT),
    ])
  } catch (err) {
    console.warn(`[3pt-stats] skip opp ${r.TEAM_ABBREVIATION}: ${err.message}`)
  }
}

console.log(`[3pt-stats] Saved ${saved} player season rows, ${last5Rows.length} last-5, ${oppRows.length} team defense rows.`)
await db.close()
