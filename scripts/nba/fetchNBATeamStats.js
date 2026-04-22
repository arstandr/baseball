// scripts/nba/fetchNBATeamStats.js — Fetch NBA team ratings from NBA Stats API.
//
// Pulls OffRtg, DefRtg, and Pace for every team — season-to-date and last 10 games.
// Stores in nba_team_stats table. No API key required.
//
// Usage:
//   node scripts/nba/fetchNBATeamStats.js [--date YYYY-MM-DD] [--season-type Playoffs|Regular+Season]

import 'dotenv/config'
import axios from 'axios'
import * as db from '../../lib/db.js'
import { parseArgs } from '../../lib/cli-args.js'

const opts       = parseArgs({
  date:        { default: new Date().toISOString().slice(0, 10) },
  'season-type': { default: 'Playoffs' },
})
const TODAY      = opts.date
const SEASON_TYPE = opts['season-type'] || 'Playoffs'
const SEASON     = '2025-26'

const NBA_STATS_BASE = 'https://stats.nba.com/stats'
const HEADERS = {
  'User-Agent':         'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Referer':            'https://www.nba.com/',
  'Origin':             'https://www.nba.com',
  'Accept':             'application/json, text/plain, */*',
  'Accept-Language':    'en-US,en;q=0.9',
  'Accept-Encoding':    'gzip, deflate, br',
  'Connection':         'keep-alive',
  'x-nba-stats-origin': 'stats',
  'x-nba-stats-token':  'true',
  'Cache-Control':      'no-cache',
  'Pragma':             'no-cache',
}

// NBA Stats API throttles hard parallel requests — stagger each call
const sleep = ms => new Promise(r => setTimeout(r, ms))

await db.migrate()
await ensureTable()

console.log(`[nba-team-stats] Fetching team stats (${SEASON_TYPE}, season ${SEASON})…`)

// NBA Stats API blocks parallel requests — fetch sequentially with delay
const seasonAdv  = await fetchTeamStats('Advanced', 0);  await sleep(1500)
const last10Adv  = await fetchTeamStats('Advanced', 10); await sleep(1500)
const seasonBase = await fetchTeamStats('Base', 0);      await sleep(1500)
const last10Base = await fetchTeamStats('Base', 10)

const saved = mergeAndSave(seasonAdv, seasonBase, 'season')
             + mergeAndSave(last10Adv, last10Base, 'last10')

console.log(`[nba-team-stats] Saved ${saved} rows for ${TODAY}.`)
await db.close()

// ── Helpers ─────────────────────────────────────────────────────────────────

async function fetchTeamStats(measureType, lastNGames, attempt = 0) {
  try {
    const res = await axios.get(`${NBA_STATS_BASE}/leaguedashteamstats`, {
      headers: HEADERS,
      timeout: 20000,
      params: {
        Season:        SEASON,
        SeasonType:    SEASON_TYPE,
        MeasureType:   measureType,
        LastNGames:    lastNGames,
        PerMode:       'PerGame',
        PaceAdjust:    'N',
        PlusMinus:     'N',
        Rank:          'N',
        Outcome:       '',
        Location:      '',
        Month:         0,
        SeasonSegment: '',
        DateFrom:      '',
        DateTo:        '',
        OpponentTeamID: 0,
        VsConference:  '',
        VsDivision:    '',
        GameSegment:   '',
        Period:        0,
        ShotClockRange: '',
        GameScope:     '',
        PlayerExperience: '',
        PlayerPosition: '',
        StarterBench:  '',
      },
    })
    const rs = res.data?.resultSets?.[0]
    if (!rs) return []
    const headers = rs.headers
    const rows = rs.rowSet
    return rows.map(row => {
      const obj = {}
      headers.forEach((h, i) => { obj[h] = row[i] })
      return obj
    })
  } catch (err) {
    if (attempt < 2) {
      const delay = (attempt + 1) * 3000
      console.warn(`[nba-team-stats] ${measureType} last${lastNGames} failed (${err.message}) — retry in ${delay/1000}s`)
      await sleep(delay)
      return fetchTeamStats(measureType, lastNGames, attempt + 1)
    }
    console.warn(`[nba-team-stats] fetch failed (${measureType} last${lastNGames}):`, err.message)
    return []
  }
}

function mergeAndSave(advRows, baseRows, window) {
  // Index base rows by TEAM_ID for quick lookup
  const baseByTeam = {}
  for (const r of baseRows) baseByTeam[r.TEAM_ID] = r

  let count = 0
  for (const adv of advRows) {
    const base = baseByTeam[adv.TEAM_ID] || {}
    // Use standard abbreviation from TEAM_ABBREVIATION field
    const teamId = adv.TEAM_ABBREVIATION || String(adv.TEAM_ID)

    db.run(`
      INSERT INTO nba_team_stats (team_id, stat_date, window, season_type, off_rtg, def_rtg, pace, pts_pg, opp_pts_pg)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(team_id, stat_date, window) DO UPDATE SET
        off_rtg = excluded.off_rtg,
        def_rtg = excluded.def_rtg,
        pace    = excluded.pace,
        pts_pg  = excluded.pts_pg,
        opp_pts_pg = excluded.opp_pts_pg
    `, [
      teamId, TODAY, window, SEASON_TYPE,
      adv.OFF_RATING ?? null,
      adv.DEF_RATING ?? null,
      adv.PACE       ?? null,
      base.PTS       ?? null,
      base.OPP_PTS   ?? null,
    ])
    count++
  }
  return count
}

async function ensureTable() {
  await db.run(`
    CREATE TABLE IF NOT EXISTS nba_team_stats (
      team_id     TEXT NOT NULL,
      stat_date   TEXT NOT NULL,
      window      TEXT NOT NULL,
      season_type TEXT DEFAULT 'Playoffs',
      off_rtg     REAL,
      def_rtg     REAL,
      pace        REAL,
      pts_pg      REAL,
      opp_pts_pg  REAL,
      PRIMARY KEY (team_id, stat_date, window)
    )`)
  await db.run(`CREATE INDEX IF NOT EXISTS idx_nba_team_stats ON nba_team_stats(team_id, stat_date)`)
}
