// scripts/live/collectF5Lines.js — Collect and store Kalshi F5 line prices for today's slate.
//
// Run this once in the morning after the schedule is fetched (after 9am ET).
// Stores all 7 Kalshi F5 strikes (0.5-6.5) per game into the f5_lines table.
// Over time this builds a real historical record of F5 opening prices that can
// replace the 0.529 proxy in training.
//
// Usage:
//   node scripts/live/collectF5Lines.js [--date YYYY-MM-DD] [--dry-run]
//
// Table created automatically: f5_lines (see ensureTable below)

import 'dotenv/config'
import * as db from '../../lib/db.js'
import * as kalshi from '../../lib/kalshi.js'

const args = process.argv.slice(2)
const dateArg = args.includes('--date') ? args[args.indexOf('--date') + 1] : null
const DRY_RUN = args.includes('--dry-run')
const TODAY = dateArg || new Date().toISOString().slice(0, 10)

async function ensureTable() {
  await db.run(`
    CREATE TABLE IF NOT EXISTS f5_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id TEXT NOT NULL,
      game_date TEXT NOT NULL,
      away_team TEXT,
      home_team TEXT,
      strike REAL NOT NULL,
      yes_ask INTEGER,
      yes_bid INTEGER,
      no_ask INTEGER,
      no_bid INTEGER,
      volume INTEGER,
      ticker TEXT,
      collected_at TEXT DEFAULT (datetime('now')),
      UNIQUE(game_id, strike, collected_at)
    )
  `)
  await db.run(`CREATE INDEX IF NOT EXISTS idx_f5_lines_game ON f5_lines(game_id)`)
  await db.run(`CREATE INDEX IF NOT EXISTS idx_f5_lines_date ON f5_lines(game_date)`)
}

async function main() {
  await db.migrate()
  await ensureTable()

  const games = await db.getGamesByDate(TODAY)
  if (!games.length) {
    console.log(`[collectF5Lines] no games found for ${TODAY}`)
    await db.close()
    return
  }
  console.log(`[collectF5Lines] ${games.length} games on ${TODAY}`)

  let collected = 0
  let failed = 0
  let noMarket = 0

  for (const game of games) {
    const label = `${game.team_away}@${game.team_home}`

    let markets
    try {
      markets = await kalshi.getF5MarketPrices(
        game.team_away,
        game.team_home,
        game.date,
        game.game_time,
      )
    } catch (err) {
      console.warn(`  [fail] ${label}: ${err.message}`)
      failed++
      continue
    }

    if (!markets || !markets.length) {
      console.log(`  [none] ${label}: no F5 markets found`)
      noMarket++
      continue
    }

    console.log(`  [ok] ${label}: ${markets.length} strikes`)
    if (DRY_RUN) {
      for (const m of markets) {
        console.log(`       strike=${m.line} yes_ask=${m.yes_ask} no_ask=${m.no_ask} vol=${m.volume ?? 'n/a'}`)
      }
      continue
    }

    const now = new Date().toISOString()
    for (const m of markets) {
      await db.run(
        `INSERT OR IGNORE INTO f5_lines
          (game_id, game_date, away_team, home_team, strike, yes_ask, yes_bid, no_ask, no_bid, volume, ticker, collected_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          game.id,
          game.date,
          game.team_away,
          game.team_home,
          m.line,
          m.yes_ask ?? null,
          m.yes_bid ?? null,
          m.no_ask ?? null,
          m.no_bid ?? null,
          m.volume ?? null,
          m.ticker ?? null,
          now,
        ],
      )
      collected++
    }
  }

  console.log(`[collectF5Lines] done — ${collected} prices saved, ${failed} failed, ${noMarket} no market`)

  // Print a summary of the implied over rates to sanity-check the ratio
  if (!DRY_RUN && collected > 0) {
    const rows = await db.all(
      `SELECT strike, AVG(yes_ask) as avg_yes_ask, COUNT(*) as n
         FROM f5_lines WHERE game_date = ?
         GROUP BY strike ORDER BY strike`,
      [TODAY],
    )
    console.log('\nImplied over rates by strike:')
    for (const r of rows) {
      const implied = r.avg_yes_ask != null ? `${r.avg_yes_ask.toFixed(1)}¢` : 'n/a'
      console.log(`  ${r.strike}: ${implied} (n=${r.n})`)
    }
  }

  await db.close()
}

main().catch(err => {
  console.error('[collectF5Lines] fatal:', err.message)
  process.exit(1)
})
