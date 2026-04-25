// scripts/live/calibrationReport.js — Full calibration + breakdown report.
//
// Reads all settled pre-game bets and reports:
//   1. Probability bucket calibration table (actual vs expected win rate)
//   2. Brier score
//   3. Win rate by bet_mode (normal, pulled, dead-path)
//   4. Win rate by side (YES/NO)
//   5. Win rate by strike threshold
//
// Usage:
//   node scripts/live/calibrationReport.js [--days 30] [--user-id N]
//
// Filters: result IS NOT NULL AND result != 'void' AND live_bet = 0 AND paper = 0
//          AND model_prob IS NOT NULL

import 'dotenv/config'
import * as db from '../../lib/db.js'
import { parseArgs } from '../../lib/cli-args.js'

const opts = parseArgs({
  days:   { type: 'number', default: 30 },
  userId: { flag: 'user-id', type: 'number', default: null },
})

const { days, userId } = opts

// ── Calibration buckets (lower inclusive, upper exclusive) ────────────────
const BUCKETS = [
  { lo: 0.50, hi: 0.55, label: '[0.50, 0.55)' },
  { lo: 0.55, hi: 0.60, label: '[0.55, 0.60)' },
  { lo: 0.60, hi: 0.65, label: '[0.60, 0.65)' },
  { lo: 0.65, hi: 0.70, label: '[0.65, 0.70)' },
  { lo: 0.70, hi: 0.75, label: '[0.70, 0.75)' },
  { lo: 0.75, hi: 0.80, label: '[0.75, 0.80)' },
  { lo: 0.80, hi: 1.01, label: '[0.80+)' },
]

function bar(frac, width = 20) {
  const filled = Math.round(frac * width)
  return '[' + '█'.repeat(filled) + '░'.repeat(width - filled) + ']'
}

function pctStr(n, d) {
  if (!d) return '  n/a '
  return `${(n / d * 100).toFixed(1).padStart(5)}%`
}

function calibrationError(actual, expected) {
  const err = actual - expected
  const sign = err >= 0 ? '+' : ''
  return `${sign}${(err * 100).toFixed(1)}¢`
}

async function main() {
  const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString().slice(0, 10)

  const userClause  = userId != null ? `AND user_id = ${userId}` : ''
  const rows = await db.all(
    `SELECT model_prob, result, side, strike, bet_mode, fill_price, market_mid, bet_size
     FROM ks_bets
     WHERE result IN ('win','loss')
       AND live_bet = 0
       AND paper = 0
       AND model_prob IS NOT NULL
       AND bet_date >= ?
       ${userClause}
     ORDER BY bet_date ASC`,
    [since],
  )

  if (!rows.length) {
    console.log(`No settled pre-game bets found in the last ${days} days.`)
    await db.close()
    return
  }

  console.log(`\n${'═'.repeat(72)}`)
  console.log(`  CALIBRATION REPORT — last ${days} days  (n=${rows.length} settled pre-game bets)`)
  console.log(`${'═'.repeat(72)}\n`)

  // ── 1. Probability bucket table ──────────────────────────────────────────
  const bucketData = BUCKETS.map(b => ({
    ...b,
    bets: [],
    wins: 0,
  }))

  let brierSum = 0

  for (const row of rows) {
    const prob = row.model_prob
    const won  = row.result === 'win' ? 1 : 0

    // Brier score: (prob - outcome)^2
    brierSum += (prob - won) ** 2

    const bucket = bucketData.find(b => prob >= b.lo && prob < b.hi)
    if (bucket) {
      bucket.bets.push(row)
      if (won) bucket.wins++
    }
  }

  const brierScore = brierSum / rows.length

  console.log('── Probability Bucket Calibration ──────────────────────────────────────')
  console.log(
    `${'Bucket'.padEnd(14)} ${'N'.padStart(5)} ${'Actual'.padStart(8)} ${'Expected'.padStart(9)} ${'Cal Error'.padStart(10)}  Bar`,
  )
  console.log('─'.repeat(72))

  for (const b of bucketData) {
    const n      = b.bets.length
    const actual = n ? b.wins / n : 0
    const mid    = (b.lo + Math.min(b.hi, 1.0)) / 2
    const label  = b.label.padEnd(14)
    const calErr = n ? calibrationError(actual, mid) : '   n/a'
    console.log(
      `${label} ${String(n).padStart(5)} ${pctStr(b.wins, n).padStart(8)} ${(mid * 100).toFixed(1).padStart(7)}% ${calErr.padStart(10)}  ${n ? bar(actual) : ''}`,
    )
  }

  console.log('─'.repeat(72))
  console.log(`Overall Brier score: ${brierScore.toFixed(4)}  (random=0.2500, perfect=0.0000, lower is better)`)
  console.log()

  // ── 2. Win rate by bet_mode ──────────────────────────────────────────────
  const modes = {}
  for (const row of rows) {
    const m = row.bet_mode ?? 'normal'
    if (!modes[m]) modes[m] = { n: 0, wins: 0 }
    modes[m].n++
    if (row.result === 'win') modes[m].wins++
  }

  console.log('── Win Rate by bet_mode ─────────────────────────────────────────────────')
  for (const [mode, s] of Object.entries(modes)) {
    console.log(`  ${mode.padEnd(14)} n=${String(s.n).padStart(4)}  win=${pctStr(s.wins, s.n)}`)
  }
  console.log()

  // ── 3. Win rate by side ──────────────────────────────────────────────────
  const sides = {}
  for (const row of rows) {
    const s = row.side
    if (!sides[s]) sides[s] = { n: 0, wins: 0 }
    sides[s].n++
    if (row.result === 'win') sides[s].wins++
  }

  console.log('── Win Rate by Side ─────────────────────────────────────────────────────')
  for (const [side, s] of Object.entries(sides)) {
    console.log(`  ${side.padEnd(6)} n=${String(s.n).padStart(4)}  win=${pctStr(s.wins, s.n)}`)
  }
  console.log()

  // ── 4. Win rate by strike threshold ─────────────────────────────────────
  const strikes = {}
  for (const row of rows) {
    const k = row.strike
    if (!strikes[k]) strikes[k] = { n: 0, wins: 0 }
    strikes[k].n++
    if (row.result === 'win') strikes[k].wins++
  }

  console.log('── Win Rate by Strike Threshold ─────────────────────────────────────────')
  for (const k of Object.keys(strikes).sort((a, b) => Number(a) - Number(b))) {
    const s = strikes[k]
    console.log(`  K≥${String(k).padEnd(3)} n=${String(s.n).padStart(4)}  win=${pctStr(s.wins, s.n)}`)
  }
  console.log()

  console.log(`${'═'.repeat(72)}\n`)

  await db.close()
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
