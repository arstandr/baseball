// scripts/clv/closeOutLines.js — Fill closing line prices for open CLV entries.
//
// Runs 5 minutes before each game's first pitch (wired into the scheduler).
// Also safe to run as a sweep for all open entries on a given date.
//
// For each open clv_log row (paper_price_close IS NULL):
//   1. Fetch current Kalshi F5 market price
//   2. Write paper_price_close
//   3. Compute clv = paper_price_close - paper_price_open
//      positive clv => line moved in our favour after we "bet" => real edge
//
// CLV is computed in Kalshi cents (0-100). A +3 CLV means the market moved
// 3 cents in our direction — equivalent to ~3 cents/contract in expected value.
//
// Usage:
//   node scripts/clv/closeOutLines.js [--date YYYY-MM-DD] [--dry-run]
//   Called directly by the scheduler 5 min before each first pitch.

import 'dotenv/config'
import * as db from '../../lib/db.js'
import * as kalshi from '../../lib/kalshi.js'

// ── CLI args ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const dateArg = args.includes('--date') ? args[args.indexOf('--date') + 1] : null
const DRY_RUN = args.includes('--dry-run')
const TODAY = dateArg || new Date().toISOString().slice(0, 10)

// ── Main ─────────────────────────────────────────────────────────────────

async function fetchCurrentPrice(entry) {
  // Prefer ticker if stored; otherwise reconstruct via getF5MarketPrices
  if (entry.kalshi_ticker) {
    const price = await kalshi.getMarketPrice(entry.kalshi_ticker)
    if (price) {
      // For OVER bets we care about yes_ask (cost to enter); UNDER = no_ask
      const raw = entry.side === 'OVER' ? price.ask : (1 - price.bid)
      // getMarketPrice returns fractions (0.0-1.0); convert to cents
      return Math.round((raw ?? price.price_over) * 100)
    }
  }

  // Fallback: scan event markets to find the matching line
  const game = await db.getGame(entry.game_id)
  if (!game) return null

  const markets = await kalshi.getF5MarketPrices(
    game.team_away,
    game.team_home,
    game.date,
    game.game_time,
  ).catch(() => [])

  for (const m of markets) {
    if (Math.abs(m.line - entry.line) < 0.01) {
      if (entry.side === 'OVER')  return m.yes_ask ?? null
      return m.no_ask ?? (m.yes_ask != null ? 100 - m.yes_ask : null)
    }
  }
  return null
}

async function main() {
  await db.migrate()

  const openEntries = await db.getOpenCLVEntries(TODAY)
  if (!openEntries.length) {
    console.log(`[closeOutLines] no open CLV entries for ${TODAY}`)
    await db.close()
    return
  }

  console.log(`[closeOutLines] ${openEntries.length} open entries for ${TODAY}`)

  let updated = 0
  let failed  = 0

  for (const entry of openEntries) {
    const label = `game=${entry.game_id} ${entry.series} ${entry.side} ${entry.line}`

    let closePrice
    try {
      closePrice = await fetchCurrentPrice(entry)
    } catch (err) {
      console.warn(`  [skip] ${label}: price fetch error — ${err.message}`)
      failed++
      continue
    }

    if (closePrice == null) {
      console.warn(`  [skip] ${label}: no closing price found`)
      failed++
      continue
    }

    const openPrice = entry.paper_price_open
    const clv = closePrice - openPrice   // positive = we beat the market

    const sign = clv > 0 ? '+' : ''
    console.log(
      `  [clv] ${label}` +
      ` | open=${openPrice}¢ close=${closePrice}¢ clv=${sign}${clv}¢` +
      (clv > 0 ? ' ✓ BEAT' : clv === 0 ? ' = FLAT' : ' ✗ LOST') +
      (DRY_RUN ? ' [DRY RUN]' : ''),
    )

    if (!DRY_RUN) {
      await db.updateCLVClose(entry.id, closePrice, { clv })
      updated++
    }
  }

  console.log(`[closeOutLines] done — ${updated} updated, ${failed} failed`)
  await db.close()
}

main().catch(err => {
  console.error('[closeOutLines] fatal:', err.message)
  process.exit(1)
})
