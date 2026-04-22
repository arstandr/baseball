// scripts/nba/fetchNBASchedule.js — Discover today's NBA games from Kalshi KXNBATOTAL events.
//
// Kalshi is the authoritative source: if a market exists, we can bet on it.
// Stores games in nba_games table (upsert).
//
// Usage:
//   node scripts/nba/fetchNBASchedule.js [--date YYYY-MM-DD]

import 'dotenv/config'
import * as db from '../../lib/db.js'
import { listNBAGamesFromKalshi, getNBATotalMarkets } from '../../lib/kalshi.js'
import { parseArgs } from '../../lib/cli-args.js'

const opts  = parseArgs({ date: { default: new Date().toISOString().slice(0, 10) } })
const TODAY = opts.date

await db.migrate()
await ensureTable()

console.log(`[nba-schedule] Fetching NBA games from Kalshi for ${TODAY}…`)

const games = await listNBAGamesFromKalshi(TODAY)
if (!games.length) {
  console.log('[nba-schedule] No NBA total markets found for today.')
  process.exit(0)
}

console.log(`[nba-schedule] Found ${games.length} game(s):`)

for (const g of games) {
  // Fetch a sample market to learn the matchup
  // The matchupCode is like 'DENMIN' — we need to reverse-engineer away/home.
  // The event title from Kalshi is e.g. "DEN @ MIN Total Points"
  const title = g.title || ''
  const teamMatch = title.match(/([A-Z]+)\s+@\s+([A-Z]+)/)
  const away = teamMatch?.[1] ?? g.matchupCode.slice(0, 3)
  const home = teamMatch?.[2] ?? g.matchupCode.slice(3)

  const id = `${g.eventTicker.split('-').slice(1).join('-')}`

  await db.run(`
    INSERT INTO nba_games (id, game_date, team_away, team_home, kalshi_event, season)
    VALUES (?, ?, ?, ?, ?, '2025-26')
    ON CONFLICT(id) DO UPDATE SET
      team_away = excluded.team_away,
      team_home = excluded.team_home,
      kalshi_event = excluded.kalshi_event
  `, [id, TODAY, away, home, g.eventTicker])

  console.log(`  ${away} @ ${home}  →  ${g.eventTicker}`)
}

console.log(`[nba-schedule] Done. ${games.length} game(s) saved.`)
await db.close()

async function ensureTable() {
  await db.run(`
    CREATE TABLE IF NOT EXISTS nba_games (
      id TEXT PRIMARY KEY,
      game_date TEXT NOT NULL,
      game_time TEXT,
      team_away TEXT NOT NULL,
      team_home TEXT NOT NULL,
      kalshi_event TEXT,
      season TEXT DEFAULT '2025-26',
      status TEXT DEFAULT 'scheduled',
      actual_total INTEGER
    )`)
  await db.run(`CREATE INDEX IF NOT EXISTS idx_nba_games_date ON nba_games(game_date)`)
}
