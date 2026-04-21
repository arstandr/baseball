// scripts/historical/backfillWeather.js — standalone weather backfill for all seasons.
//
// The VENUES static array uses IDs 1-30 but historical_games.venue_id uses MLB API IDs
// (3313, 2394, etc.) that don't match.  This script resolves venues by home_team name
// instead, building a weather cache entry for every unique lat/lng/date combination.
//
// Usage:
//   node scripts/historical/backfillWeather.js [--season 2021]

import * as db from '../../lib/db.js'
import { fetchGameWeather } from './fetchWeather.js'
import { VENUES } from '../../agents/park/venues.js'
import { sleep } from './cache.js'

// Map full team names (as stored in historical_games.home_team) to VENUES entry
const TEAM_NAME_TO_VENUE = {
  'Arizona Diamondbacks': 'ARI',
  'Atlanta Braves':        'ATL',
  'Baltimore Orioles':     'BAL',
  'Boston Red Sox':        'BOS',
  'Chicago Cubs':          'CHC',
  'Chicago White Sox':     'CWS',
  'Cincinnati Reds':       'CIN',
  'Cleveland Guardians':   'CLE',
  'Cleveland Indians':     'CLE',   // pre-2022 name
  'Colorado Rockies':      'COL',
  'Detroit Tigers':        'DET',
  'Houston Astros':        'HOU',
  'Kansas City Royals':    'KC',
  'Los Angeles Angels':    'LAA',
  'Los Angeles Dodgers':   'LAD',
  'Miami Marlins':         'MIA',
  'Milwaukee Brewers':     'MIL',
  'Minnesota Twins':       'MIN',
  'New York Mets':         'NYM',
  'New York Yankees':      'NYY',
  'Oakland Athletics':     'OAK',
  'Athletics':             'OAK',   // post-relocation name
  'Philadelphia Phillies': 'PHI',
  'Pittsburgh Pirates':    'PIT',
  'San Diego Padres':      'SD',
  'San Francisco Giants':  'SF',
  'Seattle Mariners':      'SEA',
  'St. Louis Cardinals':   'STL',
  'Tampa Bay Rays':        'TB',
  'Texas Rangers':         'TEX',
  'Toronto Blue Jays':     'TOR',
  'Washington Nationals':  'WSH',
}

const byTeam = new Map(VENUES.map(v => [v.team, v]))

function venueForHomeTeam(homeTeamName) {
  const abbr = TEAM_NAME_TO_VENUE[homeTeamName]
  if (!abbr) return null
  return byTeam.get(abbr) || null
}

async function ingestSeason(season) {
  const games = await db.all(
    `SELECT id, date, game_time, home_team FROM historical_games WHERE season = ? ORDER BY date ASC`,
    [season],
  )
  let skipped = 0
  const start = Date.now()

  // Deduplicate by cache key (lat_lng_date) — many games share the same venue+date.
  // The cache key in fetchWeather.js is `${lat.toFixed(3)}_${lng.toFixed(3)}_${date}`
  const seen = new Set()
  const unique = []
  for (const g of games) {
    const venue = venueForHomeTeam(g.home_team)
    if (!venue || venue.lat == null || venue.lng == null) {
      skipped++
      continue
    }
    const key = `${venue.lat.toFixed(3)}_${venue.lng.toFixed(3)}_${g.date}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push({ venue, date: g.date, gameTime: g.game_time })
  }

  process.stderr.write(
    `[backfillWeather] season ${season}: ${games.length} games → ${unique.length} unique lat/lng/date combos, ${skipped} skipped (no venue)\n`,
  )

  // Process in parallel batches of 10 to stay polite to the API
  const BATCH = 10
  let done = 0
  for (let i = 0; i < unique.length; i += BATCH) {
    const batch = unique.slice(i, i + BATCH)
    await Promise.all(batch.map(({ venue, date, gameTime }) =>
      fetchGameWeather({ lat: venue.lat, lng: venue.lng, date, gameTime }),
    ))
    done += batch.length
    if (done % 200 === 0 || done === unique.length) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(0)
      process.stderr.write(
        `[backfillWeather] season ${season}: ${done}/${unique.length} (${elapsed}s)\n`,
      )
    }
    // Small pause between batches to avoid overwhelming the API
    if (i + BATCH < unique.length) await sleep(50)
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1)
  return { season, total: games.length, matched: unique.length, skipped, elapsed }
}

async function main() {
  const seasonArg = process.argv.includes('--season')
    ? [Number(process.argv[process.argv.indexOf('--season') + 1])]
    : null

  const seasons = seasonArg ?? (
    await db.all(`SELECT DISTINCT season FROM historical_games WHERE season >= 2021 ORDER BY season ASC`, [])
  ).map(r => r.season)

  console.log('[backfillWeather] seasons to process:', seasons)

  for (const season of seasons) {
    const result = await ingestSeason(season)
    console.log(
      `[backfillWeather] season ${result.season} done: ${result.matched} fetched, ${result.skipped} skipped (no venue), elapsed ${result.elapsed}s`,
    )
  }

  console.log('[backfillWeather] all seasons complete')
  process.exit(0)
}

main().catch(err => { console.error(err); process.exit(1) })
