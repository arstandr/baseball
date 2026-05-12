// Retroactive backfill of shadow_calibrate_kelly for already-settled YES bets.
// For days that fired before recordCalibrateKellyShadow() was wired in, walk
// the ks_bets rows and compute shadow rows as if the recorder had run.
//
// Run:
//   node scripts/backfillCalibrateKelly.mjs                # last 14 days
//   node scripts/backfillCalibrateKelly.mjs 2026-05-03     # specific date

import 'dotenv/config'
import { createClient } from '@libsql/client'
const turso = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })

const SHADOW_KELLY_FRACTION = 0.25
const KALSHI_FEE_FRACTION = 0.07

function calibrateYesProb(p) {
  if (p < 0.42) return 0.06
  if (p < 0.52) return 0.24
  if (p < 0.65) return 0.33
  return 0.42
}

const arg = process.argv[2]
let dateClause, args
if (arg && /^\d{4}-\d{2}-\d{2}$/.test(arg)) {
  dateClause = `bet_date = ?`
  args = [arg]
} else {
  dateClause = `bet_date >= date('now','-14 days')`
  args = []
}

const r = await turso.execute({
  sql: `SELECT id AS ks_bet_id, bet_date, user_id, pitcher_name, strike, side,
               model_prob, market_mid, spread, capital_at_risk, kelly_fraction,
               actual_ks, result, pnl
        FROM ks_bets
        WHERE ${dateClause}
          AND live_bet = 0 AND side = 'YES'
          AND capital_at_risk > 0`,
  args,
})

console.log(`Backfilling ${r.rows.length} YES bet(s)...`)

let inserted = 0
for (const b of r.rows) {
  // Bankroll lookup: we don't have a snapshot, so use the user's current Kalshi
  // balance as a proxy. Actual sizing was based on day-of balance which we
  // can't reconstruct exactly. This produces a reasonable approximation.
  const u = await turso.execute({ sql: `SELECT kalshi_pnl FROM users WHERE id = ?`, args: [b.user_id] }).catch(() => ({ rows: [] }))
  // Estimate bankroll from capital_at_risk and kelly_fraction (reverse-engineer)
  // bankroll = capital / (kelly_fraction * SHADOW_KELLY_FRACTION) approximately
  // but this is fragile. Use a flat $400 reference if we can't infer.
  let bankroll = 400
  if (b.kelly_fraction && b.kelly_fraction > 0) {
    bankroll = Number(b.capital_at_risk) / Number(b.kelly_fraction)
  }

  const halfSpread = Number(b.spread ?? 4) / 2
  const yesAskCents = Math.min(99, Math.max(1, Number(b.market_mid ?? 50) + halfSpread))
  const yesAsk = yesAskCents / 100
  const calProb = calibrateYesProb(Number(b.model_prob))
  const bRatio = (1 - yesAsk) / yesAsk
  const fullKelly = (bRatio * calProb - (1 - calProb)) / bRatio

  let calibratedKellyFraction = 0
  let calibratedSize = 0
  if (fullKelly > 0) {
    calibratedKellyFraction = fullKelly * SHADOW_KELLY_FRACTION
    calibratedSize = Math.round(calibratedKellyFraction * bankroll * 100) / 100
  }

  // Shadow PnL using actual outcome
  let calPnl = 0
  if (calibratedSize <= 0) calPnl = 0
  else if (b.result === 'win') {
    calPnl = Math.round(calibratedSize * (1 - yesAsk) / yesAsk * (1 - KALSHI_FEE_FRACTION) * 100) / 100
  } else if (b.result === 'loss') {
    calPnl = -calibratedSize
  }

  await turso.execute({
    sql: `INSERT INTO shadow_calibrate_kelly
            (ks_bet_id, bet_date, user_id, pitcher_name, strike, side,
             bankroll_used, raw_model_prob, calibrated_yes_prob, yes_ask,
             raw_kelly_fraction, raw_size,
             calibrated_kelly_fraction, calibrated_size,
             actual_ks, result, raw_pnl, calibrated_pnl,
             created_at, settled_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(ks_bet_id) DO UPDATE SET
             raw_model_prob = excluded.raw_model_prob,
             calibrated_yes_prob = excluded.calibrated_yes_prob,
             yes_ask = excluded.yes_ask,
             raw_kelly_fraction = excluded.raw_kelly_fraction,
             raw_size = excluded.raw_size,
             calibrated_kelly_fraction = excluded.calibrated_kelly_fraction,
             calibrated_size = excluded.calibrated_size,
             actual_ks = excluded.actual_ks,
             result = excluded.result,
             raw_pnl = excluded.raw_pnl,
             calibrated_pnl = excluded.calibrated_pnl,
             settled_at = excluded.settled_at`,
    args: [b.ks_bet_id, b.bet_date, b.user_id, b.pitcher_name, b.strike, b.side,
           bankroll, b.model_prob, calProb, yesAsk,
           b.kelly_fraction, b.capital_at_risk,
           calibratedKellyFraction, calibratedSize,
           b.actual_ks, b.result, b.pnl, calPnl,
           new Date().toISOString(),
           b.result != null ? new Date().toISOString() : null],
  }).catch(err => console.warn(`row ${b.ks_bet_id}: ${err.message}`))
  inserted++
}

console.log(`✓ Backfilled ${inserted} row(s)`)

// Quick summary
const summary = await turso.execute(`
  SELECT bet_date, COUNT(*) AS fires,
         SUM(CASE WHEN calibrated_size = 0 THEN 1 ELSE 0 END) AS skipped,
         ROUND(SUM(raw_size), 2) AS raw_risk, ROUND(SUM(calibrated_size), 2) AS cal_risk,
         ROUND(SUM(raw_pnl), 2) AS raw_pnl, ROUND(SUM(calibrated_pnl), 2) AS cal_pnl
  FROM shadow_calibrate_kelly
  WHERE result IS NOT NULL
  GROUP BY bet_date ORDER BY bet_date
`)
console.log('\nDate          fires  skipped   raw_risk → raw_pnl   cal_risk → cal_pnl   swing')
console.log('─'.repeat(85))
let trRaw = 0, trCal = 0
for (const s of summary.rows) {
  const swing = Number(s.cal_pnl) - Number(s.raw_pnl)
  trRaw += Number(s.raw_pnl); trCal += Number(s.cal_pnl)
  const swingStr = swing >= 0 ? `+$${swing.toFixed(2)}` : `-$${Math.abs(swing).toFixed(2)}`
  console.log(`${s.bet_date}     ${String(s.fires).padEnd(4)}  ${String(s.skipped).padEnd(7)}  $${Number(s.raw_risk).toFixed(2).padStart(7)} → ${Number(s.raw_pnl) >= 0 ? '+' : '-'}$${Math.abs(s.raw_pnl).toFixed(2).padStart(6)}   $${Number(s.cal_risk).toFixed(2).padStart(7)} → ${Number(s.cal_pnl) >= 0 ? '+' : '-'}$${Math.abs(s.cal_pnl).toFixed(2).padStart(6)}   ${swingStr}`)
}
console.log('─'.repeat(85))
const totSwing = trCal - trRaw
console.log(`Cumulative swing (cal-Kelly vs raw-Kelly): ${totSwing >= 0 ? '+' : '-'}$${Math.abs(totSwing).toFixed(2)}`)
