// pipeline/fetch.js — master data ingestion (full-game totals).
//
// Pulls:
//   1. MLB schedule + probable starters (authoritative)
//   2. Park data (static, seeded from agents/park/venues.js)
//   3. Full-game total line snapshot (odds_api)
//   4. Confirmed lineups (rotowire, once they're posted 2hr pre-game)
//   5. Weather forecast (per venue, 30min cadence on game day)
//
// Writes rows to `games`, `venues`, `lines`, (indirectly) `weather` and
// `lineup_signals` via the agent runs.

import { fetchTodaySchedule } from '../lib/mlbapi.js'
import * as db from '../lib/db.js'
import { seedVenues } from '../agents/park/index.js'
import { ingestSlate } from '../agents/market/index.js'
import { alertPipelineFailure } from '../lib/telegram.js'
import { getMarketPrice, findMarket, toKalshiAbbr } from '../lib/kalshi.js'

export async function fetch({ date, types = ['schedule', 'starters', 'lines'] } = {}) {
  const actualDate = date === 'today' || !date
    ? new Date().toISOString().slice(0, 10)
    : date

  const report = { date: actualDate, ok: true, steps: {} }

  // Ensure schema exists
  await db.migrate()

  // ---- 1. Park seed (idempotent) ----
  if (types.includes('schedule') || types.includes('park')) {
    try {
      const seeded = await seedVenues()
      report.steps.park = seeded
    } catch (err) {
      report.ok = false
      report.steps.park = { error: err.message }
      await alertPipelineFailure({ source: 'park_seed', error: err })
    }
  }

  // ---- 2. Schedule + starters ----
  let games = []
  if (types.includes('schedule') || types.includes('starters')) {
    try {
      games = await fetchTodaySchedule(actualDate)
      for (const g of games) {
        await db.saveGame({
          id: g.id,
          date: g.date,
          season: g.season,
          game_time: g.game_time,
          status: g.status,
          venue_id: g.venue_id,
          team_home: g.team_home,
          team_away: g.team_away,
          pitcher_home_id: g.pitcher_home_id,
          pitcher_away_id: g.pitcher_away_id,
        })
      }
      report.steps.schedule = { games: games.length }
    } catch (err) {
      report.ok = false
      report.steps.schedule = { error: err.message }
      await alertPipelineFailure({ source: 'mlb_schedule', error: err })
    }
  }

  // ---- 3. Lines ingestion ----
  if (types.includes('lines')) {
    try {
      const lines = await ingestSlate(games)
      report.steps.lines = { games_with_lines: Object.keys(lines).length }
    } catch (err) {
      report.steps.lines = { error: err.message }
      await alertPipelineFailure({ source: 'odds_api', error: err })
    }
  }

  // ---- 4. Kalshi price snapshots (convergence data collection) ----
  if (types.includes('convergence') || types.includes('kalshi')) {
    const snaps = []
    for (const g of games) {
      try {
        const away = toKalshiAbbr(g.team_away)
        const home = toKalshiAbbr(g.team_home)
        const mkt = await findMarket(away, home, g.date, null, g.game_time)
        if (!mkt?.ticker) continue
        const price = await getMarketPrice(mkt.ticker)
        if (!price) continue
        // Save 15-min snapshot
        await db.saveKalshiSnapshot({
          game_id: g.id,
          kalshi_ticker: mkt.ticker,
          price_over: price.price_over,
          price_under: price.price_under,
          bid: price.bid,
          ask: price.ask,
          depth_over_contracts: price.depth_over_contracts,
          depth_under_contracts: price.depth_under_contracts,
        })
        // Save to convergence_log at the appropriate window
        const window = types.includes('convergence_window')
          ? (report.convergence_window || 'open')
          : 'open'
        // Get sportsbook consensus implied prob from lines table
        const sbLine = await db.getCurrentLine(g.id, 'full_game_total')
        const sbImplied = sbLine?.over_price ?? null
        await db.saveConvergenceWindow(g.id, window, price.price_over, sbImplied)
        snaps.push({ game_id: g.id, ticker: mkt.ticker, price_over: price.price_over })
      } catch {
        // Non-fatal — Kalshi may not have market for every game
      }
    }
    report.steps.convergence = { snapshots: snaps.length }
  }

  return report
}
