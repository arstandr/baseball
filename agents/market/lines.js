// agents/market/lines.js — line fetcher + tracker (full-game totals)
//
// Pulls current full-game total lines from The Odds API, records them in
// the `lines` table, and computes opening / current / movement / efficiency
// for a given game. (Pivoted from F5 per DEC-016.)

import { fetchCurrentLines } from '../../lib/odds.js'
import { getF5MarketPrices } from '../../lib/kalshi.js'
import * as db from '../../lib/db.js'

/**
 * Fetch current lines for every game on today's slate and persist.
 * Returns a map of game_id -> line record.
 */
export async function fetchAndPersistAllLines(scheduleGames) {
  const res = await fetchCurrentLines()
  if (!res.ok) return {}
  const lines = {}

  // Fuzzy-match odds-api games to our schedule by team name + time
  for (const og of res.games) {
    const t = new Date(og.commence_time).getTime()
    let best = null
    let bestDelta = Infinity
    for (const sg of scheduleGames) {
      if (!sg.game_time) continue
      const delta = Math.abs(new Date(sg.game_time).getTime() - t)
      if (delta > 3 * 3600 * 1000) continue
      const homeMatch =
        og.home_team?.toLowerCase().includes(sg.team_home?.toLowerCase() || 'xxxxxxxx') ||
        (sg.team_home || '').toLowerCase() === og.home_team?.toLowerCase().split(' ').pop()
      if (!homeMatch) continue
      if (delta < bestDelta) {
        best = sg
        bestDelta = delta
      }
    }
    if (!best) continue

    // Figure out whether we already have an opening row for this game
    const existingOpen = await db.getOpeningLine(best.id, 'full_total')
    const isOpening = !existingOpen

    // Compute consensus (median) line + median prices from full-game totals
    const fullLines = og.full_lines || []
    if (!fullLines.length) continue
    const line = og.full_total
    const overPrice = median(fullLines.map(l => l.over_price))
    const underPrice = median(fullLines.map(l => l.under_price))

    const movementFromOpen =
      existingOpen && line != null ? Number((line - existingOpen.line_value).toFixed(3)) : 0

    const efficiency = efficiencyScore(movementFromOpen)

    await db.saveLine({
      game_id: best.id,
      source: 'odds_api',
      market_type: 'full_total',
      line_value: line,
      over_price: overPrice,
      under_price: underPrice,
      is_opening: isOpening ? 1 : 0,
      movement_from_open: movementFromOpen,
      efficiency_score: efficiency,
      sharp_signal: null,
    })

    lines[best.id] = {
      game_id: best.id,
      opening_line: existingOpen?.line_value ?? line,
      current_line: line,
      over_price: overPrice,
      under_price: underPrice,
      movement: movementFromOpen,
      efficiency_score: efficiency,
      per_book: fullLines,
    }

    // Mirror full-game total to games table
    if (isOpening) {
      await db.run(
        `UPDATE games SET full_line_open = ?, full_line_current = ?, updated_at = datetime('now') WHERE id = ?`,
        [line, line, best.id],
      )
    } else {
      await db.run(
        `UPDATE games SET full_line_current = ?, updated_at = datetime('now') WHERE id = ?`,
        [line, best.id],
      )
    }
  }
  return lines
}

/**
 * Build market_raw structure for a single game from the stored line history.
 * Includes sharp_signal heuristic (reverse line movement proxy).
 */
export async function getMarketRaw(game) {
  // Support legacy callers that pass gameId directly
  const gameId = typeof game === 'object' ? game.id : game
  const teamAway = typeof game === 'object' ? game.team_away : null
  const teamHome = typeof game === 'object' ? game.team_home : null
  const gameDate = typeof game === 'object' ? game.date : null
  const gameTime = typeof game === 'object' ? game.game_time : null

  const opening = await db.getOpeningLine(gameId, 'full_total')
  const current = await db.getCurrentLine(gameId, 'full_total')

  // Fetch live Kalshi F5 prices — this is what we're actually betting on
  let f5Markets = []
  if (teamAway && teamHome) {
    f5Markets = await getF5MarketPrices(teamAway, teamHome, gameDate, gameTime).catch(() => [])
  }

  // Use the most-traded F5 line as market reference (highest volume, or fallback to middle strike)
  const f5Ref = f5Markets.length
    ? (f5Markets.reduce((best, m) => (m.volume ?? 0) > (best.volume ?? 0) ? m : best, f5Markets[Math.floor(f5Markets.length / 2)]))
    : null

  if (!current && !f5Ref) {
    return {
      game_id: gameId,
      opening_line: null,
      current_line: null,
      movement: 0,
      efficiency_score: 0.7,
      over_price: null,
      under_price: null,
      disqualify: false,
      sharp_signal: null,
      platform_line: null,
      platform_gap: 0,
      f5_markets: [],
      _missing: true,
    }
  }
  // normalizeMarket renames floor_strike → line
  const currentLine = current?.line_value ?? f5Ref?.line ?? null
  const movement = opening && currentLine != null ? currentLine - opening.line_value : 0
  const efficiency = efficiencyScore(movement)

  // Prices: prefer live Kalshi F5 ask prices (API returns cents 0-100 → normalize to 0-1)
  const f5OverPrice = f5Ref?.yes_ask != null ? f5Ref.yes_ask / 100 : null
  const f5UnderPrice = f5Ref?.no_ask != null ? f5Ref.no_ask / 100 : null
  const overPrice = f5OverPrice ?? current?.over_price ?? null
  const underPrice = f5UnderPrice ?? current?.under_price ?? null

  // sharp_signal proxy: reverse-line-movement heuristic
  let sharp = null
  if (movement <= -0.3 && (underPrice ?? 0) >= 0.53) sharp = 'under'
  else if (movement >= 0.3 && (overPrice ?? 0) >= 0.53) sharp = 'over'

  const disqualify = Math.abs(movement) > 0.5

  const platformLine = f5Ref?.line ?? current?.line_value ?? null
  const platformGap = platformLine != null && currentLine != null
    ? Number((currentLine - platformLine).toFixed(2))
    : 0

  return {
    game_id: gameId,
    opening_line: opening?.line_value ?? currentLine,
    current_line: currentLine,
    movement: Number((movement || 0).toFixed(3)),
    movement_direction: movement > 0.05 ? 'up' : movement < -0.05 ? 'down' : 'none',
    efficiency_score: efficiency,
    over_price: overPrice,
    under_price: underPrice,
    sharp_signal: sharp,
    platform_line: platformLine,
    platform_gap: platformGap,
    disqualify,
    disqualify_reason: disqualify ? 'line_movement_gt_0.5' : null,
    f5_markets: f5Markets,
  }
}

export function efficiencyScore(movement) {
  const mag = Math.abs(movement || 0)
  if (mag > 0.5) return 0.5 // (disqualify anyway but keep numeric value sane)
  if (mag >= 0.3) return 0.7
  if (mag >= 0.1) return 0.9
  return 1.0
}

function median(arr) {
  const v = arr.filter(x => typeof x === 'number' && !Number.isNaN(x)).sort((a, b) => a - b)
  if (!v.length) return null
  const mid = Math.floor(v.length / 2)
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2
}
