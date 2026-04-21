// scripts/historical/buildF5PitcherSplits.js
//
// Computes first-5-innings ERA splits for every starter in the historical dataset.
// Reads linescore cache from disk (no API calls), matches game logs by date, and
// writes era_f5_l5 / avg_f5_ip_l5 / f5_starts_available into historical_pitcher_stats.
//
// Usage:
//   node scripts/historical/buildF5PitcherSplits.js [--season 2024] [--force]

import 'dotenv/config'
import * as db from '../../lib/db.js'
import { fetchPitcherGameLog } from './fetchPitcherStats.js'
import { readCache } from './cache.js'

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2)
const seasonArg = (() => {
  const idx = args.indexOf('--season')
  return idx !== -1 ? Number(args[idx + 1]) : null
})()
const force = args.includes('--force')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert baseball innings notation (float) to true decimal innings.
 * 5.2 means 5⅔ innings → 5 + 2/3 = 5.6667
 */
function ipToDecimal(ip) {
  const whole = Math.floor(ip)
  const frac = ip % 1
  // frac can be 0.0, 0.1, 0.2 (representing 0, 1, 2 outs in the partial inning)
  return whole + (Math.round(frac * 10) / 3)
}

/**
 * Return the sum of runs scored by `side` ('home' or 'away') in innings 1-5
 * from a linescore object.  Returns null if the linescore is unusable.
 */
function f5RunsFromLinescore(linescore, side) {
  if (!linescore || !Array.isArray(linescore.innings)) return null
  let total = 0
  for (const inning of linescore.innings) {
    const num = Number(inning.num)
    if (num < 1 || num > 5) continue
    const half = inning[side]
    if (!half || half.runs == null) return null // incomplete inning data
    total += Number(half.runs)
  }
  return total
}

/**
 * For a game-log entry array, find the entry whose date matches gameDate.
 * Dates are stored as 'YYYY-MM-DD' strings in both tables and game logs.
 */
function findLogEntry(log, gameDate) {
  if (!Array.isArray(log)) return null
  return log.find(r => r.date === gameDate) || null
}

// ---------------------------------------------------------------------------
// Step 1 — Add columns (idempotent)
// ---------------------------------------------------------------------------
async function addColumns() {
  const alterations = [
    'ALTER TABLE historical_pitcher_stats ADD COLUMN era_f5_l5 REAL',
    'ALTER TABLE historical_pitcher_stats ADD COLUMN avg_f5_ip_l5 REAL',
    'ALTER TABLE historical_pitcher_stats ADD COLUMN f5_starts_available INTEGER',
  ]
  for (const sql of alterations) {
    try {
      await db.run(sql)
    } catch (err) {
      const msg = String(err.message || err)
      if (!msg.includes('duplicate column') && !msg.includes('already exists')) {
        throw err
      }
    }
  }
  console.log('[F5] Columns ensured.')
}

// ---------------------------------------------------------------------------
// Step 2 — Build per-pitcher F5 start records from game cache + game logs
//
// Returns a Map:  pitcherId → [ { date, f5_runs, f5_ip }, ... ]  (sorted asc)
// ---------------------------------------------------------------------------
async function buildF5StartMap(games) {
  // Gather unique pitcher/season combos we need game logs for
  const pitcherSeasons = new Map() // `${pitcherId}:${season}` → { pitcherId, season }
  for (const g of games) {
    if (g.pitcher_home_id) {
      const key = `${g.pitcher_home_id}:${g.season}`
      if (!pitcherSeasons.has(key)) pitcherSeasons.set(key, { pitcherId: g.pitcher_home_id, season: g.season })
    }
    if (g.pitcher_away_id) {
      const key = `${g.pitcher_away_id}:${g.season}`
      if (!pitcherSeasons.has(key)) pitcherSeasons.set(key, { pitcherId: g.pitcher_away_id, season: g.season })
    }
  }

  console.log(`[F5] Pre-loading game logs for ${pitcherSeasons.size} pitcher/season combos…`)

  // Pre-load all game logs to avoid repeated async fetches inside the game loop
  const logCache = new Map() // `${pitcherId}:${season}` → log array
  let logCount = 0
  for (const [key, { pitcherId, season }] of pitcherSeasons) {
    const log = await fetchPitcherGameLog(pitcherId, season)
    logCache.set(key, log || [])
    logCount++
    if (logCount % 500 === 0) {
      console.log(`[F5]   … loaded ${logCount}/${pitcherSeasons.size} logs`)
    }
  }
  console.log(`[F5] Game logs loaded. Processing ${games.length} games…`)

  // pitcherId → [ { date, f5_runs, f5_ip } ] (only starts where IP >= 5)
  const f5Map = new Map()
  // pitcherId → [ { date, completed_f5: bool } ] (all starts, for early exit rate)
  const allStartsMap = new Map()

  const addStart = (pitcherId, record) => {
    const id = String(pitcherId)
    if (!f5Map.has(id)) f5Map.set(id, [])
    f5Map.get(id).push(record)
  }
  const recordStart = (pitcherId, date, completedF5) => {
    const id = String(pitcherId)
    if (!allStartsMap.has(id)) allStartsMap.set(id, [])
    allStartsMap.get(id).push({ date, completedF5 })
  }

  let processed = 0
  let linescoreMissed = 0
  let logMissed = 0
  let earlyExit = 0

  for (const game of games) {
    processed++
    if (processed % 2000 === 0) {
      console.log(`[F5]   … ${processed}/${games.length} games (linescore miss=${linescoreMissed}, log miss=${logMissed}, early exit=${earlyExit})`)
    }

    // Load linescore from disk cache — readCache returns null if not on disk
    const linescore = await readCache('games', `linescore-${game.id}`)
    if (!linescore) {
      linescoreMissed++
      continue
    }

    // Process home starter — they face the AWAY team batting in innings 1-5
    if (game.pitcher_home_id) {
      const logKey = `${game.pitcher_home_id}:${game.season}`
      const log = logCache.get(logKey) || []
      const entry = findLogEntry(log, game.date)

      if (!entry || entry.innings < 1) {
        logMissed++
      } else {
        const ipDecimal = ipToDecimal(entry.innings)
        const completedF5 = Math.floor(ipDecimal) >= 5
        recordStart(game.pitcher_home_id, game.date, completedF5)
        if (!completedF5) {
          earlyExit++
        } else {
          const runsAgainst = f5RunsFromLinescore(linescore, 'away')
          if (runsAgainst !== null) {
            addStart(game.pitcher_home_id, { date: game.date, f5_runs: runsAgainst, f5_ip: 5 })
          }
        }
      }
    }

    // Process away starter — they face the HOME team batting in innings 1-5
    if (game.pitcher_away_id) {
      const logKey = `${game.pitcher_away_id}:${game.season}`
      const log = logCache.get(logKey) || []
      const entry = findLogEntry(log, game.date)

      if (!entry || entry.innings < 1) {
        logMissed++
      } else {
        const ipDecimal = ipToDecimal(entry.innings)
        const completedF5 = Math.floor(ipDecimal) >= 5
        recordStart(game.pitcher_away_id, game.date, completedF5)
        if (!completedF5) {
          earlyExit++
        } else {
          const runsAgainst = f5RunsFromLinescore(linescore, 'home')
          if (runsAgainst !== null) {
            addStart(game.pitcher_away_id, { date: game.date, f5_runs: runsAgainst, f5_ip: 5 })
          }
        }
      }
    }
  }

  console.log(`[F5] Games processed: ${processed}. Linescore misses: ${linescoreMissed}, log misses: ${logMissed}, early exits (IP < 5): ${earlyExit}`)
  console.log(`[F5] Pitchers with F5 data: ${f5Map.size}`)

  // Sort starts ascending by date
  for (const starts of f5Map.values()) {
    starts.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  }
  for (const starts of allStartsMap.values()) {
    starts.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  }

  return { f5Map, allStartsMap }
}

// ---------------------------------------------------------------------------
// Step 3 — Compute rolling F5 stats for each historical_pitcher_stats row
// ---------------------------------------------------------------------------
function computeF5Rolling(f5Starts, allStarts, asOfDate) {
  const priorF5 = (f5Starts || []).filter(s => s.date < asOfDate)
  const priorAll = (allStarts || []).filter(s => s.date < asOfDate)

  // Early exit rate from last 5 total starts (including early exits)
  const last5All = priorAll.slice(-5)
  const early_exit_rate_l5 = last5All.length > 0
    ? Number((last5All.filter(s => !s.completedF5).length / last5All.length).toFixed(3))
    : null

  if (!priorF5.length) {
    return { era_f5_l5: null, avg_f5_ip_l5: null, f5_starts_available: 0, early_exit_rate_l5 }
  }

  const last5F5 = priorF5.slice(-5)
  const f5_starts_available = last5F5.length

  if (f5_starts_available < 2) {
    return { era_f5_l5: null, avg_f5_ip_l5: null, f5_starts_available, early_exit_rate_l5 }
  }

  const totalRuns = last5F5.reduce((s, r) => s + r.f5_runs, 0)
  const totalIp = last5F5.reduce((s, r) => s + r.f5_ip, 0)
  const era_f5_l5 = totalIp > 0 ? Number(((totalRuns / totalIp) * 9).toFixed(2)) : null
  const avg_f5_ip_l5 = Number((totalIp / f5_starts_available).toFixed(2))

  return { era_f5_l5, avg_f5_ip_l5, f5_starts_available, early_exit_rate_l5 }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  await db.migrate()
  await addColumns()

  // Load historical_pitcher_stats rows
  let statsQuery = 'SELECT id, pitcher_id, as_of_date, season FROM historical_pitcher_stats'
  const statsArgs = []
  if (!force) {
    statsQuery += ' WHERE era_f5_l5 IS NULL'
  }
  if (seasonArg) {
    statsQuery += force ? ' WHERE season = ?' : ' AND season = ?'
    statsArgs.push(seasonArg)
  }

  console.log(`[F5] Loading historical_pitcher_stats rows…`)
  const statsRows = await db.all(statsQuery, statsArgs)
  console.log(`[F5] ${statsRows.length} rows to process.`)

  if (!statsRows.length) {
    console.log('[F5] Nothing to do.')
    await db.close()
    return
  }

  // Load historical_games (filtered by season if requested)
  let gamesQuery = 'SELECT id, date, season, pitcher_home_id, pitcher_away_id FROM historical_games WHERE pitcher_home_id IS NOT NULL OR pitcher_away_id IS NOT NULL'
  const gamesArgs = []
  if (seasonArg) {
    gamesQuery += ' AND season = ?'
    gamesArgs.push(seasonArg)
  }

  console.log('[F5] Loading historical_games…')
  const games = await db.all(gamesQuery, gamesArgs)
  console.log(`[F5] ${games.length} games loaded.`)

  // Build per-pitcher F5 start records
  const { f5Map, allStartsMap } = await buildF5StartMap(games)

  // Now iterate through stats rows and compute rolling metrics
  console.log(`[F5] Computing rolling F5 stats for ${statsRows.length} rows…`)

  let updated = 0
  let skipped = 0

  for (let i = 0; i < statsRows.length; i++) {
    const row = statsRows[i]

    if ((i + 1) % 500 === 0) {
      console.log(`[F5]   … ${i + 1}/${statsRows.length} rows (updated=${updated}, skipped=${skipped})`)
    }

    const pitcherId = String(row.pitcher_id)
    const f5Starts = f5Map.get(pitcherId)
    const allStarts = allStartsMap.get(pitcherId)

    if (!f5Starts?.length && !allStarts?.length) {
      skipped++
      await db.run(
        'UPDATE historical_pitcher_stats SET f5_starts_available = 0 WHERE id = ?',
        [row.id]
      )
      continue
    }

    const { era_f5_l5, avg_f5_ip_l5, f5_starts_available, early_exit_rate_l5 } = computeF5Rolling(f5Starts, allStarts, row.as_of_date)

    await db.run(
      `UPDATE historical_pitcher_stats
          SET era_f5_l5 = ?,
              avg_f5_ip_l5 = ?,
              f5_starts_available = ?,
              early_exit_rate_l5 = ?
        WHERE id = ?`,
      [era_f5_l5, avg_f5_ip_l5, f5_starts_available, early_exit_rate_l5, row.id]
    )
    updated++
  }

  console.log(`[F5] Done. Updated=${updated}, skipped (no F5 data)=${skipped}.`)
  await db.close()
}

main().catch(err => {
  console.error('[F5] Fatal error:', err)
  process.exit(1)
})
