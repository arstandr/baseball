// scripts/live/fetchSchedule.js — Fetch MLB schedule into the games table.
//
// Pulls today's (or --date) schedule from MLB Stats API and upserts each game
// into the games table with probable pitchers and game time. Safe to re-run —
// upsert on game id only updates fields that have changed (pitchers, time).
//
// Usage:
//   node scripts/live/fetchSchedule.js [--date YYYY-MM-DD] [--days N]
//
// Run this each morning before strikeoutEdge.js. Default: today + tomorrow.

import 'dotenv/config'
import axios from 'axios'
import * as db from '../../lib/db.js'

const args = process.argv.slice(2)
const dateArg  = args.includes('--date') ? args[args.indexOf('--date') + 1] : null
const daysArg  = args.includes('--days') ? Number(args[args.indexOf('--days') + 1]) : 2

const MLB_BASE = 'https://statsapi.mlb.com/api/v1'

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

async function fetchDate(date) {
  const res = await axios.get(`${MLB_BASE}/schedule`, {
    params: {
      date,
      sportId: 1,
      gameType: 'R',
      hydrate: 'probablePitcher,team,venue',
    },
    timeout: 15000,
    validateStatus: s => s >= 200 && s < 500,
  })
  if (res.status >= 400) throw new Error(`MLB API ${res.status}`)
  return res.data?.dates?.[0]?.games || []
}

async function main() {
  await db.migrate()

  const startDate = dateArg || new Date().toISOString().slice(0, 10)
  const dates = Array.from({ length: daysArg }, (_, i) => addDays(startDate, i))

  let total = 0

  for (const date of dates) {
    let games
    try {
      games = await fetchDate(date)
    } catch (err) {
      console.error(`[schedule] fetch failed for ${date}: ${err.message}`)
      continue
    }

    if (!games.length) {
      console.log(`[schedule] ${date}: no games`)
      continue
    }

    let saved = 0
    for (const g of games) {
      // Skip only postponed/cancelled/suspended games
      if (['DR', 'DI', 'DC'].includes(g.status?.statusCode)) continue
      if (g.status?.detailedState?.toLowerCase().includes('postponed')) continue

      const season = new Date(date).getFullYear()
      const homeAbbr = g.teams?.home?.team?.abbreviation || ''
      const awayAbbr = g.teams?.away?.team?.abbreviation || ''

      await db.saveGame({
        id:               String(g.gamePk),
        date,
        season,
        game_time:        g.gameDate || null,
        status:           g.status?.abstractGameState?.toLowerCase() || 'scheduled',
        venue_id:         g.venue?.id ? String(g.venue.id) : null,
        team_home:        homeAbbr,
        team_away:        awayAbbr,
        pitcher_home_id:  g.teams?.home?.probablePitcher?.id
                            ? String(g.teams.home.probablePitcher.id) : null,
        pitcher_away_id:  g.teams?.away?.probablePitcher?.id
                            ? String(g.teams.away.probablePitcher.id) : null,
      })
      saved++
    }

    console.log(`[schedule] ${date}: ${saved} games saved`)
    total += saved
  }

  console.log(`[schedule] done — ${total} total games upserted`)
  await db.close()
}

main().catch(err => {
  console.error('[schedule] fatal:', err.message)
  process.exit(1)
})
