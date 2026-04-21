// scripts/historical/backfillF5Actuals.js
// Backfill first-5-innings run totals for every historical game.
//
// The MLB linescore API already returns per-inning breakdown. This script
// re-reads those linescores (using the disk cache from fetchGames.js — no
// extra API calls for already-fetched games) and writes:
//
//   historical_games.f5_runs_home    — runs scored by home team through inning 5
//   historical_games.f5_runs_away    — runs scored by away team through inning 5
//   historical_games.f5_runs_total   — combined F5 total
//   historical_games.f5_winner       — 'home' | 'away' | 'tie' | null
//   historical_games.f5_innings_played — innings actually played (to filter short games)
//
// Usage:
//   node scripts/historical/backfillF5Actuals.js [--season 2024] [--force]
//
// --season: restrict to one season (default: all)
// --force:  re-process games that already have f5_runs_home set

import axios from 'axios'
import 'dotenv/config'
import * as db from '../../lib/db.js'
import { getCached, sleep } from './cache.js'

const MLB_BASE = 'https://statsapi.mlb.com/api/v1'
const THROTTLE_MS = 120   // polite delay when we actually hit the API
const CONCURRENCY = 4     // parallel linescore fetches (all cached = fast)

const args = process.argv.slice(2)
const seasonFilter = args.includes('--season')
  ? Number(args[args.indexOf('--season') + 1])
  : null
const force = args.includes('--force')

// ── schema migration ──────────────────────────────────────────────────────────
// SQLite doesn't support ALTER TABLE ADD COLUMN IF NOT EXISTS, so try each
// column and swallow "duplicate column" errors.

async function addColumnIfMissing(table, column, type) {
  try {
    await db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
  } catch (err) {
    if (!err.message?.includes('duplicate column')) throw err
  }
}

async function ensureColumns() {
  for (const table of ['historical_games', 'games']) {
    await addColumnIfMissing(table, 'f5_runs_home', 'INTEGER')
    await addColumnIfMissing(table, 'f5_runs_away', 'INTEGER')
    await addColumnIfMissing(table, 'f5_runs_total', 'INTEGER')
    await addColumnIfMissing(table, 'f5_winner', 'TEXT')          // 'home'|'away'|'tie'
    await addColumnIfMissing(table, 'f5_innings_played', 'INTEGER')
  }
}

// ── linescore fetch (cache-first) ─────────────────────────────────────────────

async function fetchLinescore(gameId) {
  return getCached('games', `linescore-${gameId}`, async () => {
    await sleep(THROTTLE_MS)
    try {
      const v11 = await axios.get(
        `https://statsapi.mlb.com/api/v1.1/game/${gameId}/linescore`,
        { timeout: 20_000, validateStatus: s => s < 500 },
      )
      if (v11.status < 400) return v11.data
    } catch { /* fall through */ }
    try {
      const v1 = await axios.get(`${MLB_BASE}/game/${gameId}/linescore`, {
        timeout: 20_000,
        validateStatus: s => s < 500,
      })
      if (v1.status < 400) return v1.data
    } catch { /* fall through */ }
    return null
  })
}

// ── F5 extraction ─────────────────────────────────────────────────────────────

function extractF5(ls) {
  if (!ls) return null
  const innings = ls.innings || []
  if (innings.length === 0) return null

  let home = 0, away = 0
  let inningsPlayed = 0

  for (const inn of innings) {
    // Only count through inning 5
    if (inn.num > 5) continue
    home += inn.home?.runs ?? 0
    away += inn.away?.runs ?? 0
    inningsPlayed = Math.max(inningsPlayed, inn.num)
  }

  // If game was shortened before inning 5 we still record what happened,
  // but flag it so the backtest can filter these out.
  const winner = home > away ? 'home' : away > home ? 'away' : 'tie'

  return {
    f5_runs_home: home,
    f5_runs_away: away,
    f5_runs_total: home + away,
    f5_winner: winner,
    f5_innings_played: inningsPlayed,
  }
}

// ── batch processor ───────────────────────────────────────────────────────────

async function processChunk(games) {
  await Promise.all(
    games.map(async game => {
      const ls = await fetchLinescore(game.id)
      const f5 = extractF5(ls)
      if (!f5) return

      await db.run(
        `UPDATE historical_games
            SET f5_runs_home      = ?,
                f5_runs_away      = ?,
                f5_runs_total     = ?,
                f5_winner         = ?,
                f5_innings_played = ?
          WHERE id = ?`,
        [
          f5.f5_runs_home,
          f5.f5_runs_away,
          f5.f5_runs_total,
          f5.f5_winner,
          f5.f5_innings_played,
          game.id,
        ],
      )
    }),
  )
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  await db.migrate()
  await ensureColumns()

  // Load games that need F5 data
  let where = 'actual_runs_total IS NOT NULL'
  if (!force) where += ' AND f5_runs_home IS NULL'
  if (seasonFilter) where += ` AND season = ${seasonFilter}`

  const games = await db.all(`SELECT id, date, season FROM historical_games WHERE ${where} ORDER BY date ASC`)

  if (games.length === 0) {
    console.log('Nothing to backfill — all games already have F5 data.')
    console.log('Run with --force to reprocess.')
    return
  }

  console.log(`Backfilling F5 actuals for ${games.length} games…`)

  let done = 0
  let failed = 0
  const start = Date.now()

  for (let i = 0; i < games.length; i += CONCURRENCY) {
    const chunk = games.slice(i, i + CONCURRENCY)
    try {
      await processChunk(chunk)
      done += chunk.length
    } catch (err) {
      failed += chunk.length
      process.stderr.write(`[backfillF5] chunk error at offset ${i}: ${err.message}\n`)
    }

    // Progress line every 100 games
    if (done % 100 < CONCURRENCY || i + CONCURRENCY >= games.length) {
      const pct = ((done / games.length) * 100).toFixed(1)
      const elapsed = ((Date.now() - start) / 1000).toFixed(0)
      process.stdout.write(`\r  ${done}/${games.length} (${pct}%) — ${elapsed}s elapsed   `)
    }
  }

  console.log(`\n\nDone. ${done} updated, ${failed} failed.`)

  // Quick sanity check
  const [counts] = await db.all(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN f5_runs_home IS NOT NULL THEN 1 ELSE 0 END) AS with_f5,
      SUM(CASE WHEN f5_winner = 'home' THEN 1 ELSE 0 END) AS home_wins,
      SUM(CASE WHEN f5_winner = 'away' THEN 1 ELSE 0 END) AS away_wins,
      SUM(CASE WHEN f5_winner = 'tie'  THEN 1 ELSE 0 END) AS ties
    FROM historical_games
    WHERE actual_runs_total IS NOT NULL
  `)

  console.log('\nHistorical games summary:')
  console.log(`  Total final games : ${counts.total}`)
  console.log(`  With F5 data      : ${counts.with_f5}`)
  console.log(`  Home wins F5      : ${counts.home_wins}`)
  console.log(`  Away wins F5      : ${counts.away_wins}`)
  console.log(`  Ties (F5)         : ${counts.ties}`)
  if (counts.with_f5 > 0) {
    const tieRate = ((counts.ties / counts.with_f5) * 100).toFixed(1)
    const homeRate = ((counts.home_wins / counts.with_f5) * 100).toFixed(1)
    console.log(`\n  Home win rate F5  : ${homeRate}%`)
    console.log(`  Tie rate F5       : ${tieRate}%  (Kalshi Yes ~18¢ = 18% implied)`)
  }
}

main().catch(err => {
  console.error('[backfillF5] fatal:', err)
  process.exit(1)
})
