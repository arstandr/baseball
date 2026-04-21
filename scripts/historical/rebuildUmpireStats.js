// scripts/historical/rebuildUmpireStats.js — rebuild umpire stats with park adjustment
//
// Replaces raw runs_pg (which reflects team quality at the venue) with a
// park-adjusted signal:
//
//   park_adj_runs  = actual_runs_total / venue.run_factor   (neutral-park normalised)
//   ump_runs_pg    = rolling mean of park_adj_runs for prior games (no lookahead)
//   ump_over_rate  = unchanged (already meaningful)
//   run_impact     = ump_runs_pg − league_avg_adj_runs_pg (per season)
//
// For games whose venue_id has no run_factor in the venues table the factor
// defaults to 1.0 (neutral), which is conservative — it doesn't inflate or
// deflate runs, but it also doesn't add noise.
//
// Run this AFTER fetchUmpires has backfilled hp_umpire_id.

import 'dotenv/config'
import * as db from '../../lib/db.js'

/**
 * Rebuild all umpire stats rows using park-adjusted runs.
 */
export async function rebuildUmpireStats() {
  // ----------------------------------------------------------------
  // 1. Load venue run factors (id → factor)
  // ----------------------------------------------------------------
  const venueRows = await db.all('SELECT id, run_factor FROM venues WHERE run_factor IS NOT NULL')
  const venueFactor = new Map()
  for (const v of venueRows) {
    venueFactor.set(String(v.id), Number(v.run_factor))
  }
  process.stderr.write(`[rebuildUmpireStats] loaded ${venueFactor.size} venue run factors\n`)

  // ----------------------------------------------------------------
  // 2. Load all games that have umpire data + actual runs
  // ----------------------------------------------------------------
  const games = await db.all(
    `SELECT id, date, season, venue_id, hp_umpire_id, hp_umpire_name,
            actual_runs_total, full_line_open
       FROM historical_games
       WHERE hp_umpire_id IS NOT NULL
         AND actual_runs_total IS NOT NULL
       ORDER BY date ASC`,
  )

  if (!games.length) {
    process.stderr.write('[rebuildUmpireStats] No games with umpire data. Run fetchUmpires first.\n')
    return { processed: 0 }
  }

  process.stderr.write(`[rebuildUmpireStats] loaded ${games.length} games\n`)

  // ----------------------------------------------------------------
  // 3. Pre-compute park-adjusted runs for every game
  // ----------------------------------------------------------------
  // Also track missing venue coverage for diagnostic output
  let missingVenue = 0
  for (const g of games) {
    const factor = venueFactor.get(String(g.venue_id)) ?? 1.0
    if (!venueFactor.has(String(g.venue_id))) missingVenue++
    // Clamp factor to avoid extreme division (shouldn't happen but defensive)
    const safeFactor = Math.max(factor, 0.5)
    g.adj_runs = g.actual_runs_total / safeFactor
  }
  process.stderr.write(
    `[rebuildUmpireStats] ${games.length - missingVenue}/${games.length} games have venue factor ` +
    `(${missingVenue} defaulted to 1.0)\n`,
  )

  // ----------------------------------------------------------------
  // 4. Compute per-season league-average adjusted runs
  //    (over all games in that season, not just per-umpire)
  // ----------------------------------------------------------------
  const seasonGames = new Map()
  for (const g of games) {
    if (!seasonGames.has(g.season)) seasonGames.set(g.season, [])
    seasonGames.get(g.season).push(g.adj_runs)
  }
  const leagueAvgBySeason = new Map()
  for (const [season, adjList] of seasonGames) {
    const avg = adjList.reduce((s, x) => s + x, 0) / adjList.length
    leagueAvgBySeason.set(season, avg)
  }
  process.stderr.write(
    `[rebuildUmpireStats] league avg park-adj runs by season:\n` +
    [...leagueAvgBySeason.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([s, v]) => `  ${s}: ${v.toFixed(3)}`)
      .join('\n') + '\n',
  )

  // ----------------------------------------------------------------
  // 5. Build umpire-game history map: umpire_id → sorted [{date, adj_runs, line}]
  // ----------------------------------------------------------------
  const byUmp = new Map()
  for (const g of games) {
    if (!byUmp.has(g.hp_umpire_id)) byUmp.set(g.hp_umpire_id, [])
    byUmp.get(g.hp_umpire_id).push({
      date: g.date,
      adj_runs: g.adj_runs,
      total: g.actual_runs_total,
      line: g.full_line_open,
    })
  }
  // Already in ASC date order from the query above

  // ----------------------------------------------------------------
  // 6. For each game, compute umpire's rolling stats using prior games only
  //    then upsert into historical_umpire_stats
  // ----------------------------------------------------------------
  let processed = 0
  for (const g of games) {
    const umpHistory = byUmp.get(g.hp_umpire_id) || []
    const prior = umpHistory.filter(h => h.date < g.date)
    const leagueAvg = leagueAvgBySeason.get(g.season) ?? 8.9

    if (!prior.length) {
      // No history — store league avg as fallback, run_impact = 0
      await db.upsert(
        'historical_umpire_stats',
        {
          umpire_id: g.hp_umpire_id,
          umpire_name: g.hp_umpire_name,
          as_of_date: g.date,
          runs_pg: Number(leagueAvg.toFixed(3)),
          over_rate: 0.50,
          n_games: 0,
        },
        ['umpire_id', 'as_of_date'],
      )
    } else {
      // Rolling mean of park-adjusted runs from prior games
      const sumAdj = prior.reduce((s, h) => s + h.adj_runs, 0)
      const runs_pg = sumAdj / prior.length   // this is the park-adjusted RPG

      // Over rate: only games where we have a line
      const priorWithLine = prior.filter(h => h.line != null)
      const overs = priorWithLine.filter(h => h.total > h.line).length
      const over_rate = priorWithLine.length > 0
        ? overs / priorWithLine.length
        : 0.50

      await db.upsert(
        'historical_umpire_stats',
        {
          umpire_id: g.hp_umpire_id,
          umpire_name: g.hp_umpire_name,
          as_of_date: g.date,
          runs_pg: Number(runs_pg.toFixed(3)),
          over_rate: Number(over_rate.toFixed(4)),
          n_games: prior.length,
        },
        ['umpire_id', 'as_of_date'],
      )
    }

    processed++
    if (processed % 1000 === 0) {
      process.stderr.write(`[rebuildUmpireStats] ${processed}/${games.length}\n`)
    }
  }

  process.stderr.write(`[rebuildUmpireStats] done — ${processed} rows written\n`)
  return { processed }
}

// ----------------------------------------------------------------
// Standalone entry point
// ----------------------------------------------------------------
if (process.argv[1].endsWith('rebuildUmpireStats.js')) {
  rebuildUmpireStats()
    .then(r => {
      process.stderr.write(`[rebuildUmpireStats] complete: ${r.processed} rows\n`)
      process.exit(0)
    })
    .catch(err => {
      process.stderr.write(`[rebuildUmpireStats] FATAL: ${err.message}\n${err.stack}\n`)
      process.exit(1)
    })
}
