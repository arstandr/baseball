// scripts/historical/buildUmpireStats.js — compute per-umpire run-impact
// metrics AS-OF each game date with no lookahead.
//
// For each game g with an HP umpire:
//   - Find all prior games with the same umpire (date < g.date)
//   - Compute: runs_pg, over_rate, n_games
//   - Upsert into historical_umpire_stats (umpire_id, as_of_date)
//
// The league-average total is ~9.0 runs/game.  A run_impact of +0.5 means
// this umpire's games average 0.5 runs above league.
//
// This must be run AFTER fetchUmpires has backfilled hp_umpire_id.

import 'dotenv/config'
import * as db from '../../lib/db.js'

const LEAGUE_AVG_RUNS = 9.0  // used for run_impact calculation

/**
 * Build umpire stats for every game that has an HP umpire assigned.
 * No external calls — pure DB computation.
 */
export async function buildAllUmpireStats() {
  // Load all games with umpire data (including actual runs + line)
  const games = await db.all(
    `SELECT id, date, hp_umpire_id, hp_umpire_name,
            actual_runs_total, full_line_open
       FROM historical_games
       WHERE hp_umpire_id IS NOT NULL
         AND actual_runs_total IS NOT NULL
       ORDER BY date ASC`,
  )

  if (!games.length) {
    process.stderr.write('[buildUmpireStats] No games with umpire data found. Run fetchUmpires first.\n')
    return { processed: 0 }
  }

  // Build a map: umpire_id → sorted list of {date, total, line}
  const byUmp = new Map()
  for (const g of games) {
    if (!byUmp.has(g.hp_umpire_id)) byUmp.set(g.hp_umpire_id, [])
    byUmp.get(g.hp_umpire_id).push({
      date: g.date,
      total: g.actual_runs_total,
      line: g.full_line_open,
      name: g.hp_umpire_name,
    })
  }
  // Each list is already in ASC date order since we sorted above

  let processed = 0
  for (const g of games) {
    const umpGames = byUmp.get(g.hp_umpire_id) || []
    // Prior games only (strictly before this game's date)
    const prior = umpGames.filter(h => h.date < g.date)

    if (!prior.length) {
      // No history — store league average as fallback
      await db.upsert(
        'historical_umpire_stats',
        {
          umpire_id: g.hp_umpire_id,
          umpire_name: g.hp_umpire_name,
          as_of_date: g.date,
          runs_pg: LEAGUE_AVG_RUNS,
          over_rate: 0.50,
          n_games: 0,
        },
        ['umpire_id', 'as_of_date'],
      )
    } else {
      const totalRuns = prior.reduce((s, h) => s + (h.total || 0), 0)
      const runs_pg = totalRuns / prior.length

      // Over rate: need a line — skip games where line is null
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
      process.stderr.write(`[buildUmpireStats] ${processed}/${games.length}\n`)
    }
  }

  process.stderr.write(`[buildUmpireStats] done — ${processed} rows written\n`)
  return { processed }
}
