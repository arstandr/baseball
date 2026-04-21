// scripts/clv/logPaperBets.js — Log paper bets for CLV tracking.
//
// Runs every morning after the signal pipeline. For each game where our model
// has >= 3 percentage-point edge (model_probability > 0.53 on F5 total), we
// insert a clv_log row recording the current Kalshi F5 price as the "open"
// price. closeOutLines.js fills in paper_price_close 5min before first pitch.
//
// Usage:
//   node scripts/clv/logPaperBets.js [--date YYYY-MM-DD] [--dry-run]
//
// The 0.53 threshold means we only log bets where our model disagrees with
// the market by 3+ cents on a 50-cent contract — the minimum signal worth
// tracking. Lower the threshold later if volume is too thin.
//
// NOTE: This script logs paper bets ONLY. It does not fire real orders.
// CLV is a side-channel signal — it runs whether or not we actually trade.

import 'dotenv/config'
import * as db from '../../lib/db.js'
import * as kalshi from '../../lib/kalshi.js'
import { runSlate } from '../../pipeline/orchestrate.js'

const EDGE_THRESHOLD = 0.53   // model_probability must exceed this to log
const SERIES = 'f5_total'

// ── CLI args ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const dateArg = args.includes('--date') ? args[args.indexOf('--date') + 1] : null
const DRY_RUN = args.includes('--dry-run')
const TODAY = dateArg || new Date().toISOString().slice(0, 10)

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Extract SHAP-derived signal tags from the judge decision / projection.
 * These become the signal_tags column — used in clvReport.js to break down
 * CLV by signal type.
 */
function extractSignalTags(result) {
  const tags = []
  try {
    const shap = result.projection?.shap || {}
    // Use top-3 SHAP features as tags (feature names are signal proxies)
    const sorted = Object.entries(shap)
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
      .slice(0, 3)
      .map(([k]) => k)
    tags.push(...sorted)

    // Append agent-level qualitative flags if available
    const scout = result.scout || {}
    if (scout.low_k_rate)        tags.push('low_k_stack')
    if (scout.hard_contact_flag) tags.push('hard_contact')

    const park = result.park || {}
    if (park.run_factor != null && park.run_factor > 1.05) tags.push('hitter_park')
    if (park.run_factor != null && park.run_factor < 0.95) tags.push('pitcher_park')

    const storm = result.storm || {}
    if (storm.wind_adjustment > 0.03)  tags.push('wind_out')
    if (storm.wind_adjustment < -0.03) tags.push('wind_in')
    if (storm.temp_f != null && storm.temp_f < 50) tags.push('cold_game')

    const market = result.market || {}
    if (market.sharp_signal === 'over')  tags.push('sharp_over')
    if (market.sharp_signal === 'under') tags.push('sharp_under')
  } catch {
    // Non-fatal
  }
  return [...new Set(tags)] // dedupe
}

/**
 * For a given game result from the orchestrator, determine whether to log
 * an F5-total paper bet and return the entry object if so, else null.
 */
async function buildCLVEntry(result) {
  const { game, projection } = result
  if (!projection) return null

  const overProb  = projection.over_probability ?? 0.5
  const underProb = 1 - overProb

  // Check if either side clears the threshold
  const side = overProb >= underProb ? 'OVER' : 'UNDER'
  const modelProb = side === 'OVER' ? overProb : underProb
  if (modelProb < EDGE_THRESHOLD) return null

  // Fetch F5 market prices — find the line with the highest edge
  let markets
  try {
    markets = await kalshi.getF5MarketPrices(
      game.team_away,
      game.team_home,
      game.date,
      game.game_time,
    )
  } catch {
    markets = []
  }

  if (!markets.length) {
    // Fall back to findBestF5Market which also handles the line search
    const best = await kalshi.findBestF5Market(
      game.team_away,
      game.team_home,
      game.date,
      overProb,
      game.game_time,
    ).catch(() => null)
    if (!best) return null
    markets = [best]
  }

  // Find best-edge market among available F5 lines
  let bestEntry = null
  let bestEdge  = 0

  for (const m of markets) {
    if (m.yes_ask == null) continue
    const lineOverProb = kalshi.resolveModelProb != null
      ? overProb  // resolveModelProb is not exported; use top-level prob as approx
      : overProb
    const yesPrice   = m.yes_ask / 100   // yes_ask is in cents (0-100)
    const noPrice    = (m.no_ask ?? (100 - m.yes_ask)) / 100
    const overEdge   = lineOverProb - yesPrice
    const underEdge  = (1 - lineOverProb) - noPrice
    const edge       = Math.max(overEdge, underEdge)
    const thisSide   = overEdge >= underEdge ? 'OVER' : 'UNDER'
    const thisProb   = overEdge >= underEdge ? lineOverProb : 1 - lineOverProb
    if (thisProb < EDGE_THRESHOLD) continue
    if (edge > bestEdge) {
      bestEdge = edge
      bestEntry = {
        game_id: game.id,
        series: SERIES,
        line: m.line,
        side: thisSide,
        model_probability: thisProb,
        paper_price_open: thisSide === 'OVER' ? m.yes_ask : (m.no_ask ?? 100 - m.yes_ask),
        paper_price_close: null,
        clv: null,
        result: null,
        actual_f5_total: null,
        game_date: game.date,
        signal_tags: JSON.stringify(extractSignalTags(result)),
        kalshi_ticker: m.ticker || null,
      }
    }
  }

  return bestEntry
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  await db.migrate()

  const games = await db.getGamesByDate(TODAY)
  if (!games.length) {
    console.log(`[logPaperBets] no games found for ${TODAY}`)
    return
  }
  console.log(`[logPaperBets] ${games.length} games on ${TODAY}`)

  // Run the full orchestrator slate to get model probabilities
  console.log('[logPaperBets] running signal pipeline...')
  let results
  try {
    results = await runSlate(games, { concurrency: 4 })
  } catch (err) {
    console.error('[logPaperBets] runSlate failed:', err.message)
    process.exit(1)
  }

  // Check for existing CLV entries today to avoid duplicates
  const existing = await db.all(
    `SELECT game_id, series, side, line FROM clv_log WHERE game_date = ?`,
    [TODAY],
  )
  const existingKeys = new Set(existing.map(e => `${e.game_id}:${e.series}:${e.side}:${e.line}`))

  let logged = 0
  let skipped = 0

  for (const result of results) {
    if (result.error) {
      console.warn(`[logPaperBets] skipping ${result.game?.id}: ${result.error}`)
      continue
    }

    const entry = await buildCLVEntry(result)
    if (!entry) {
      skipped++
      continue
    }

    const key = `${entry.game_id}:${entry.series}:${entry.side}:${entry.line}`
    if (existingKeys.has(key)) {
      console.log(`  [dup] ${entry.game_id} ${entry.series} ${entry.side} ${entry.line} — already logged`)
      skipped++
      continue
    }

    const game = result.game
    const tag = `${game.team_away}@${game.team_home}`
    console.log(
      `  [bet] ${tag} | F5 ${entry.side} ${entry.line} ` +
      `| model=${(entry.model_probability * 100).toFixed(1)}% ` +
      `| open=${entry.paper_price_open}¢ ` +
      `| ticker=${entry.kalshi_ticker || 'n/a'}` +
      (DRY_RUN ? ' [DRY RUN]' : ''),
    )

    if (!DRY_RUN) {
      const id = await db.saveCLVEntry(entry)
      console.log(`    -> saved clv_log id=${id}`)
      logged++
    }
  }

  console.log(`[logPaperBets] done — ${logged} logged, ${skipped} skipped`)
  await db.close()
}

main().catch(err => {
  console.error('[logPaperBets] fatal:', err.message)
  process.exit(1)
})
