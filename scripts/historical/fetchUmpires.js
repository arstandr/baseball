// scripts/historical/fetchUmpires.js — bulk-fetch HP umpire assignments via
// the MLB schedule endpoint (hydrate=officials), then backfill historical_games.
//
//   GET /api/v1/schedule?sportId=1&season={y}&gameType=R&hydrate=officials
//     → dates[].games[].officials[] where officialType === "Home Plate"
//
// One API call per season (5 total) instead of one per game.
// Results cached in scripts/historical/cache/umpires/

import axios from 'axios'
import 'dotenv/config'
import * as db from '../../lib/db.js'
import { getCached } from './cache.js'

const MLB_BASE = 'https://statsapi.mlb.com/api/v1'

async function fetchSeasonWithOfficials(season) {
  return getCached('umpires', `season-officials-${season}`, async () => {
    try {
      const res = await axios.get(`${MLB_BASE}/schedule`, {
        params: {
          sportId: 1,
          season,
          gameType: 'R',
          hydrate: 'officials',
        },
        timeout: 60000,
        validateStatus: s => s >= 200 && s < 500,
      })
      if (res.status >= 400) return null
      return res.data
    } catch {
      return null
    }
  })
}

function extractHPUmpire(officials) {
  if (!Array.isArray(officials)) return null
  const hp = officials.find(
    o => (o.officialType || '').toLowerCase().includes('home plate') ||
         (o.officialType || '').toLowerCase() === 'hp',
  )
  if (!hp?.official?.id) return null
  return {
    id: String(hp.official.id),
    name: hp.official.fullName || String(hp.official.id),
  }
}

/**
 * Ingest umpire data for a single season using the schedule bulk endpoint.
 * Backfills hp_umpire_id / hp_umpire_name on historical_games.
 */
export async function ingestUmpiresForSeason(season) {
  const schedule = await fetchSeasonWithOfficials(season)
  if (!schedule?.dates?.length) {
    process.stderr.write(`[fetchUmpires] season ${season}: no schedule data\n`)
    return { season, processed: 0, found: 0 }
  }

  // Build a map: gamePk → HP umpire
  const umpMap = new Map()
  for (const d of schedule.dates) {
    for (const g of d.games || []) {
      const ump = extractHPUmpire(g.officials)
      if (ump) umpMap.set(String(g.gamePk), ump)
    }
  }

  process.stderr.write(
    `[fetchUmpires] season ${season}: ${umpMap.size} HP umpire assignments from schedule\n`,
  )

  // Match against DB games that need umpire data
  const games = await db.all(
    `SELECT id FROM historical_games
       WHERE season = ?
         AND actual_runs_total IS NOT NULL
         AND hp_umpire_id IS NULL`,
    [season],
  )

  let found = 0
  for (const g of games) {
    const ump = umpMap.get(g.id)
    if (ump) {
      await db.run(
        `UPDATE historical_games SET hp_umpire_id = ?, hp_umpire_name = ? WHERE id = ?`,
        [ump.id, ump.name, g.id],
      )
      found++
    }
  }

  process.stderr.write(
    `[fetchUmpires] season ${season}: backfilled ${found}/${games.length} games\n`,
  )
  return { season, processed: games.length, found }
}

export async function ingestUmpiresAll() {
  const seasons = (await db.all(
    `SELECT DISTINCT season FROM historical_games ORDER BY season ASC`,
  )).map(r => r.season)

  const results = []
  for (const s of seasons) {
    const r = await ingestUmpiresForSeason(s)
    results.push(r)
  }
  return results
}
