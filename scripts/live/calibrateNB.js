// scripts/live/calibrateNB.js — NB model calibration diagnostic.
//
// Compares model_prob to actual win rates across settled ks_bets.
// Identifies systematic drift between predicted and realized outcomes.
//
// Usage:
//   node scripts/live/calibrateNB.js [--days 90] [--min-bets 10]
//
// Outputs:
//   - Calibration curve (model bucket vs actual win %)
//   - Per-threshold breakdown (6+ YES, 7+ YES, etc.)
//   - Brier score (0.25 = random, lower is better)
//   - Suggested NB_R adjustment if drift > 5%
//   - Alert flag (exit 1) if miscalibration is severe enough to investigate

import 'dotenv/config'
import * as db from '../../lib/db.js'
import { parseArgs } from '../../lib/cli-args.js'
import { NB_R, nbCDF } from '../../lib/strikeout-model.js'

const opts = parseArgs({
  days:    { type: 'number', default: 90 },
  minBets: { flag: 'min-bets', type: 'number', default: 5 },
})

function pnlSign(v) {
  return `${v >= 0 ? '+' : ''}$${Math.abs(v).toFixed(2)}`
}

function bar(pct, width = 20) {
  const filled = Math.round(pct * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

async function main() {
  const bets = await db.all(`
    SELECT model_prob, lambda, strike, side, actual_ks, result, pnl, fill_price, filled_contracts,
           bet_date, pitcher_name
    FROM ks_bets
    WHERE result IS NOT NULL
      AND model_prob IS NOT NULL
      AND actual_ks IS NOT NULL
      AND paper = 0
      AND live_bet = 0
      AND bet_date >= date('now', '-${opts.days} days')
    ORDER BY model_prob ASC
  `)

  if (!bets.length) {
    console.log('[calibrate] No settled bets found. Run after some games have settled.')
    await db.close()
    return
  }

  const n = bets.length
  const wins = bets.filter(b => b.result === 'win').length
  const totalPnl = bets.reduce((s, b) => s + (b.pnl || 0), 0)

  console.log(`\n${'═'.repeat(70)}`)
  console.log(`  NB MODEL CALIBRATION REPORT  (last ${opts.days} days)`)
  console.log(`${'═'.repeat(70)}`)
  console.log(`  Bets: ${n}  |  W/L: ${wins}/${n - wins}  |  Win%: ${(wins / n * 100).toFixed(1)}%  |  P&L: ${pnlSign(totalPnl)}`)
  console.log(`  Current NB_R = ${NB_R}`)

  // ── Calibration curve (bucket by model_prob) ─────────────────────────────
  console.log(`\n  CALIBRATION CURVE (model probability vs actual win rate)\n`)
  console.log(`  Bucket │ N    │ Model % │ Actual % │ Delta  │ Calibration`)
  console.log(`  ${'─'.repeat(63)}`)

  const buckets = new Map()
  for (const b of bets) {
    const key = (Math.floor(b.model_prob * 10) / 10).toFixed(1)
    if (!buckets.has(key)) buckets.set(key, { n: 0, wins: 0, modelSum: 0 })
    const bkt = buckets.get(key)
    bkt.n++
    bkt.modelSum += b.model_prob
    if (b.result === 'win') bkt.wins++
  }

  let totalBrier = 0
  let totalECE   = 0
  let maxDrift   = 0
  for (const [key, b] of [...buckets.entries()].sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]))) {
    if (b.n < opts.minBets) continue
    const avgModel  = b.modelSum / b.n
    const actualPct = b.wins / b.n
    const delta     = actualPct - avgModel
    const flag      = Math.abs(delta) > 0.05 ? ' ⚠' : ''
    maxDrift = Math.max(maxDrift, Math.abs(delta))
    totalBrier += (avgModel - actualPct) ** 2 * b.n
    totalECE   += Math.abs(delta) * b.n
    const calBar = bar(actualPct)
    console.log(
      `  ${(parseFloat(key) * 100).toFixed(0).padStart(3)}%   │ ${String(b.n).padEnd(4)} │` +
      ` ${(avgModel * 100).toFixed(1).padStart(6)}% │` +
      `  ${(actualPct * 100).toFixed(1).padStart(6)}%  │` +
      ` ${(delta > 0 ? '+' : '') + (delta * 100).toFixed(1).padStart(5)}% │ ${calBar}${flag}`
    )
  }

  const brierScore = totalBrier / n
  const ece        = totalECE / n
  console.log(`\n  Brier Score: ${brierScore.toFixed(4)}  |  ECE: ${(ece * 100).toFixed(1)}%  |  Max bucket drift: ${(maxDrift * 100).toFixed(1)}%`)

  // ── Per-threshold breakdown ───────────────────────────────────────────────
  console.log(`\n  PER-THRESHOLD BREAKDOWN\n`)
  console.log(`  Threshold │  N   │ Avg Model │ Actual W% │ Delta  │ P&L`)
  console.log(`  ${'─'.repeat(56)}`)

  const byThreshold = new Map()
  for (const b of bets) {
    const key = `${b.strike}+ ${b.side}`
    if (!byThreshold.has(key)) byThreshold.set(key, { n: 0, wins: 0, modelSum: 0, pnl: 0 })
    const t = byThreshold.get(key)
    t.n++
    t.modelSum += b.model_prob
    t.pnl += b.pnl || 0
    if (b.result === 'win') t.wins++
  }

  let hasAlarm = false
  for (const [key, t] of [...byThreshold.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (t.n < opts.minBets) continue
    const avgModel  = t.modelSum / t.n
    const actualPct = t.wins / t.n
    const delta     = actualPct - avgModel
    const flag      = Math.abs(delta) > 0.05 ? ' ⚠' : ''
    if (Math.abs(delta) > 0.07 && t.n >= 15) hasAlarm = true
    console.log(
      `  ${key.padEnd(9)} │ ${String(t.n).padEnd(4)} │` +
      `  ${(avgModel * 100).toFixed(1).padStart(6)}%  │` +
      `  ${(actualPct * 100).toFixed(1).padStart(7)}% │` +
      ` ${(delta > 0 ? '+' : '') + (delta * 100).toFixed(1).padStart(5)}% │ ${pnlSign(t.pnl)}${flag}`
    )
  }

  // ── NB_R recalibration suggestion ────────────────────────────────────────
  // If model consistently over-predicts (model says 50% but wins 42%), NB_R is too high.
  // If model under-predicts (model says 40% but wins 48%), NB_R is too low.
  // NB_R controls tail thickness: higher = tighter distribution = higher probability mass near mean.
  const betsWithLambda = bets.filter(b => b.lambda && b.strike)
  if (betsWithLambda.length >= 20) {
    console.log(`\n  NB_R SENSITIVITY (${betsWithLambda.length} bets with lambda stored)\n`)
    const testRs = [15, 20, 25, 30, 35, 40, 50]
    let bestR = NB_R, bestLL = -Infinity
    const llByR = []
    for (const r of testRs) {
      let logLik = 0
      for (const b of betsWithLambda) {
        const prob = 1 - nbCDF(b.lambda, r, b.strike - 1)
        const p    = b.side === 'YES' ? prob : 1 - prob
        const pClamped = Math.max(0.001, Math.min(0.999, p))
        logLik += b.result === 'win' ? Math.log(pClamped) : Math.log(1 - pClamped)
      }
      llByR.push({ r, ll: logLik })
      if (logLik > bestLL) { bestLL = logLik; bestR = r }
    }
    console.log(`  Test r values vs log-likelihood:`)
    for (const { r, ll } of llByR) {
      const mark = r === bestR ? ' ← BEST' : r === NB_R ? ' ← CURRENT' : ''
      console.log(`    r=${String(r).padEnd(3)}  log-likelihood=${ll.toFixed(1)}${mark}`)
    }
    if (bestR !== NB_R) {
      console.log(`\n  ⚡ Suggested update: NB_R = ${NB_R} → ${bestR}`)
      console.log(`     Edit: lib/strikeout-model.js line 12: export const NB_R = ${bestR}`)
    } else {
      console.log(`\n  ✓ NB_R = ${NB_R} appears optimal for current data.`)
    }
    hasAlarm = hasAlarm || (bestR !== NB_R && Math.abs(bestR - NB_R) >= 10)
  }

  // ── Summary verdict ───────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(70)}`)
  if (hasAlarm) {
    console.log(`  ⚠  CALIBRATION WARNING: Model drift detected. Review thresholds above.`)
    console.log(`     Consider retraining or adjusting NB_R before increasing bet size.`)
  } else {
    console.log(`  ✓  Model calibration OK — no significant systematic bias detected.`)
  }
  console.log(`${'═'.repeat(70)}\n`)

  await db.close()
  if (hasAlarm) process.exit(1)
}

main().catch(e => { console.error(e); process.exit(1) })
