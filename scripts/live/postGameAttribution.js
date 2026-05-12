// scripts/live/postGameAttribution.js — Silent post-game attribution.
//
// Runs after ksBets.js settle + syncSettlements. Reads today's resolved bets,
// computes per-pitcher lambda accuracy and model calibration, and logs a
// structured summary to the console (no Claude, no Discord).
//
// Also triggers calibrationEngine if cumulative resolved bets reach the
// MIN_PITCHER_BETS threshold for any pitcher — keeping reliability scores fresh.
//
// Usage:
//   node scripts/live/postGameAttribution.js [--date YYYY-MM-DD]

import 'dotenv/config'
import * as db from '../../lib/db.js'
import { runCalibration } from '../../lib/calibrationEngine.js'

const args  = process.argv.slice(2)
const TODAY = args.includes('--date') ? args[args.indexOf('--date') + 1] : new Date().toISOString().slice(0, 10)

// ── helpers ───────────────────────────────────────────────────────────────────

function pct(n, d) { return d > 0 ? ((n / d) * 100).toFixed(1) + '%' : 'n/a' }
function sign(n)    { return n >= 0 ? `+$${n.toFixed(2)}` : `-$${Math.abs(n).toFixed(2)}` }

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  await db.migrate()

  const bets = await db.all(
    `SELECT id, pitcher_id, pitcher_name, strike, side, model_prob, lambda,
            fill_price, bet_size, pnl, result, actual_ks, live_bet, mode,
            edge, market_mid, bet_date
     FROM ks_bets
     WHERE bet_date = ?
       AND result IS NOT NULL
       AND result != 'void'
       AND (paper = 0 OR paper IS NULL)
     ORDER BY pitcher_name, strike`,
    [TODAY],
  )

  if (!bets.length) {
    console.log(`[attribution] No settled bets found for ${TODAY}`)
    return
  }

  console.log(`\n[attribution] ${TODAY}  —  ${bets.length} resolved bet(s)\n`)

  // ── Group by pitcher ──────────────────────────────────────────────────────
  const byPitcher = new Map()
  for (const b of bets) {
    const key = b.pitcher_id ?? b.pitcher_name
    if (!byPitcher.has(key)) byPitcher.set(key, { name: b.pitcher_name, bets: [] })
    byPitcher.get(key).bets.push(b)
  }

  let totalPnl  = 0
  let totalWins = 0

  for (const [, { name, bets: pb }] of byPitcher) {
    const wins    = pb.filter(b => b.result === 'win').length
    const losses  = pb.filter(b => b.result === 'loss').length
    const pnl     = pb.reduce((s, b) => s + (b.pnl ?? 0), 0)
    totalPnl     += pnl
    totalWins    += wins

    // Lambda accuracy — compare our pre-game λ to actual Ks
    const lambdaRows = pb.filter(b => b.lambda != null && b.actual_ks != null && b.live_bet === 0)
    const lambdaErr  = lambdaRows.length
      ? lambdaRows.reduce((s, b) => s + (b.actual_ks - b.lambda), 0) / lambdaRows.length
      : null

    // Prob calibration — for resolved YES bets compare model_prob to outcome
    const probRows = pb.filter(b => b.model_prob != null && b.side === 'YES')
    const avgProb  = probRows.length ? probRows.reduce((s, b) => s + b.model_prob, 0) / probRows.length : null
    const winRate  = probRows.length ? probRows.filter(b => b.result === 'win').length / probRows.length : null

    const actualKs = pb[0]?.actual_ks != null ? `${pb[0].actual_ks}K actual` : ''

    const lambdaTag = lambdaErr != null
      ? ` | λ err ${lambdaErr >= 0 ? '+' : ''}${lambdaErr.toFixed(1)}`
      : ''
    const calTag = avgProb != null && winRate != null
      ? ` | prob cal ${(avgProb * 100).toFixed(0)}% pred → ${pct(wins, probRows.length)} win`
      : ''

    console.log(
      `  ${name.padEnd(22)} ${wins}W-${losses}L  ${sign(pnl).padStart(8)}` +
      `  ${actualKs}${lambdaTag}${calTag}`,
    )

    // Per-bet detail for any outlier (model vs actual differ by >= 3 Ks)
    for (const b of pb) {
      if (b.actual_ks != null && b.lambda != null && Math.abs(b.actual_ks - b.lambda) >= 3) {
        console.log(
          `    ⚠  ${b.strike}+ ${b.side} @ ${b.market_mid}¢  model=${(b.model_prob * 100).toFixed(0)}%` +
          `  λ=${b.lambda.toFixed(1)} actual=${b.actual_ks}K  ${b.result}  ${sign(b.pnl ?? 0)}`,
        )
      }
    }
  }

  const overallWinRate = pct(totalWins, bets.length)
  console.log(`\n  ── Total: ${bets.length} bets  ${overallWinRate} win rate  ${sign(totalPnl)} P&L ──\n`)

  // ── Trigger calibration if we have newly resolved data ───────────────────
  // Run calibration silently — it logs its own output; any error is non-fatal.
  try {
    const resolvedCount = await db.one(
      `SELECT COUNT(*) as n FROM ks_bets
       WHERE result IS NOT NULL AND result != 'void' AND (paper = 0 OR paper IS NULL)`,
    )
    const n = Number(resolvedCount?.n ?? 0)
    if (n >= 30) {
      console.log(`[attribution] ${n} resolved bets — running calibration engine...`)
      const calResult = await runCalibration({ trigger: 'post-game', dryRun: false })
      console.log(`[attribution] calibration: ${calResult?.summary ?? 'done'}`)
    } else {
      console.log(`[attribution] ${n} resolved bets — calibration deferred (need 30+)`)
    }
  } catch (err) {
    console.warn(`[attribution] calibration skipped: ${err.message}`)
  }
}

main().catch(err => {
  console.error('[attribution] fatal:', err.message)
  process.exit(1)
})
