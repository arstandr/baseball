// Backward retrospective: for every settled YES bet over a date range,
// compute what the same-dollar-risk reallocated NO bet would have returned
// under (a) BLANKET inversion (every YES → NO) and (b) CONDITIONAL
// inversion (K5-7 + model_prob≥0.5 + (career=0 OR l5-career≥0.5)).
//
// Math: same dollar risk reallocated to NO at the reconstructed NO ask.
//   yesAsk = market_mid + spread/2  (taker price)
//   noAsk  = 100 - market_mid + spread/2  (taker NO price)
//   IF YES.result = 'win'   → NO loses   → pnl_no = -capital_at_risk
//   IF YES.result = 'loss'  → NO wins    → pnl_no = capital × (1-noAsk)/noAsk × (1 - fee)
//   IF YES.result = 'void'  → NO voids   → pnl_no = 0
//
// Run:
//   node scripts/inversionRetrospective.mjs                # last 7 days
//   node scripts/inversionRetrospective.mjs 14             # last 14 days
//   node scripts/inversionRetrospective.mjs 2026-04-26 2026-05-02

import 'dotenv/config'
import { createClient } from '@libsql/client'
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })

const KALSHI_FEE = 0.07

const args = process.argv.slice(2)
const dateArgs = args.filter(a => /^\d{4}-\d{2}-\d{2}$/.test(a))
const numArg   = args.find(a => /^\d+$/.test(a))

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
let startDate, endDate
if (dateArgs.length === 2) {
  startDate = dateArgs[0]; endDate = dateArgs[1]
} else if (dateArgs.length === 1) {
  startDate = dateArgs[0]; endDate = today
} else {
  const days = numArg ? Number(numArg) : 7
  const d = new Date()
  d.setDate(d.getDate() - days)
  startDate = d.toISOString().slice(0, 10)
  endDate   = today
}

const r = await db.execute({
  sql: `SELECT id, bet_date, user_id, pitcher_name, strike, side, model_prob,
               market_mid, spread, k9_l5, k9_career, capital_at_risk,
               actual_ks, result, pnl, paper, order_id
        FROM ks_bets
        WHERE bet_date BETWEEN ? AND ?
          AND live_bet = 0 AND side = 'YES'
          AND result IN ('win','loss','void')
          AND capital_at_risk > 0
        ORDER BY bet_date, pitcher_name`,
  args: [startDate, endDate],
})

console.log(`\nInversion retrospective — ${startDate} to ${endDate}`)
console.log(`${r.rows.length} settled YES bet(s) found\n`)

function isInversionEligible(b) {
  const k = Number(b.strike)
  if (k < 5 || k > 7) return false
  if (Number(b.model_prob) < 0.50) return false
  const career = Number(b.k9_career ?? 0)
  const l5 = Number(b.k9_l5 ?? 0)
  if (career > 0 && (l5 - career) < 0.5) return false
  return true
}

function blanketInvertedPnl(b) {
  const cap = Number(b.capital_at_risk ?? 0)
  if (cap <= 0) return 0
  if (b.result === 'void') return 0
  const yesMid = Number(b.market_mid ?? 50)
  const halfSpread = Number(b.spread ?? 4) / 2
  const noAskCents = Math.min(99, Math.max(1, 100 - yesMid + halfSpread))
  const noAsk = noAskCents / 100
  if (b.result === 'win') {
    // YES won → NO loses → -capital
    return -cap
  }
  // YES lost → NO wins → profit
  const profitFraction = (1 - noAsk) / noAsk * (1 - KALSHI_FEE)
  return Math.round(cap * profitFraction * 100) / 100
}

// Per-day aggregation (per user too, so the report mirrors the Friday table)
const byDate = new Map()
const byUserDate = new Map()

let totalActual = 0
let totalBlanket = 0
let totalCondActual = 0  // sum of actual pnl ON eligible picks
let totalCondInverted = 0  // sum of inverted pnl ON eligible picks
let blanketWins = 0, blanketLosses = 0, blanketVoids = 0
let condEligibleCount = 0, condIneligibleCount = 0

for (const b of r.rows) {
  const actualPnl = Number(b.pnl ?? 0)
  const blanketPnl = blanketInvertedPnl(b)
  const eligible = isInversionEligible(b)

  totalActual += actualPnl
  totalBlanket += blanketPnl
  if (eligible) {
    condEligibleCount++
    totalCondActual += actualPnl
    totalCondInverted += blanketPnl
  } else {
    condIneligibleCount++
  }

  if (b.result === 'void') blanketVoids++
  else if (blanketPnl >= 0) blanketWins++
  else blanketLosses++

  const dKey = b.bet_date
  if (!byDate.has(dKey)) byDate.set(dKey, { date: dKey, n: 0, actual: 0, blanket: 0, condEligible: 0, condInverted: 0, condActual: 0 })
  const dRow = byDate.get(dKey)
  dRow.n++
  dRow.actual += actualPnl
  dRow.blanket += blanketPnl
  if (eligible) { dRow.condEligible++; dRow.condInverted += blanketPnl; dRow.condActual += actualPnl }
}

function $(n) { return (n >= 0 ? '+' : '') + '$' + Math.abs(n).toFixed(2).replace(/^/, n < 0 ? '-' : '') }

console.log('── Per-day comparison ──────────────────────────────────────────────────')
console.log('date         n   actual_YES   blanket_NO   blanket_swing   cond_n   cond_actual   cond_NO   cond_swing')
console.log('─'.repeat(115))
const sorted = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
for (const d of sorted) {
  const blanketSwing = d.blanket - d.actual
  const condSwing    = d.condInverted - d.condActual
  console.log(
    `${d.date}   ${String(d.n).padEnd(3)} ` +
    `${$(d.actual).padStart(11)}  ${$(d.blanket).padStart(11)}  ${$(blanketSwing).padStart(13)}     ` +
    `${String(d.condEligible).padEnd(6)} ${$(d.condActual).padStart(11)}  ${$(d.condInverted).padStart(9)}  ${$(condSwing).padStart(11)}`
  )
}

console.log('─'.repeat(115))
console.log(
  `TOTAL        ${String(r.rows.length).padEnd(3)} ` +
  `${$(totalActual).padStart(11)}  ${$(totalBlanket).padStart(11)}  ${$(totalBlanket - totalActual).padStart(13)}     ` +
  `${String(condEligibleCount).padEnd(6)} ${$(totalCondActual).padStart(11)}  ${$(totalCondInverted).padStart(9)}  ${$(totalCondInverted - totalCondActual).padStart(11)}`
)

console.log('\n── Summary ──────────────────────────────────────────────────────────────')
console.log(`Total YES bets:         ${r.rows.length}`)
console.log(`  Eligible for cond:    ${condEligibleCount}`)
console.log(`  NOT eligible:         ${condIneligibleCount}`)
console.log(`Blanket NO outcomes:    ${blanketWins} would-win / ${blanketLosses} would-lose / ${blanketVoids} void`)
console.log()
console.log(`Actual YES P&L:         ${$(totalActual)}`)
console.log(`Blanket inversion P&L:  ${$(totalBlanket)}    swing: ${$(totalBlanket - totalActual)}`)
console.log(`Conditional P&L (only on eligible picks, others stay YES):`)
const totalNonEligibleActual = totalActual - totalCondActual
const condFinal = totalCondInverted + totalNonEligibleActual
console.log(`  cond_inverted + non_eligible_actual = ${$(totalCondInverted)} + ${$(totalNonEligibleActual)} = ${$(condFinal)}`)
console.log(`  swing vs actual:      ${$(condFinal - totalActual)}`)
