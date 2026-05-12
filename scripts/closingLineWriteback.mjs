// Closing-line writeback. Pulls current Kalshi orderbook for every fired bet
// today and writes closing prices + CLV back to ks_bets.
// Run nightly after games settle (or anytime to capture latest book state).
//
// Usage:
//   node scripts/closingLineWriteback.mjs                # today
//   node scripts/closingLineWriteback.mjs 2026-05-06     # specific date
//
// Writes:
//   ks_bets.closing_line_cents       — closing midpoint (yes-frame)
//   ks_bets.clv_cents                — entry vs close in cents (positive = beat the close)
//   ks_bets.closing_line_captured_at — ISO timestamp of capture

import 'dotenv/config'
import { authedRequest } from '../lib/kalshi.js'
import { createClient } from '@libsql/client'

// NOTE: lib/kalshi.js getOrderbook() can't parse the current Kalshi response
// shape ({ orderbook_fp: { yes_dollars, no_dollars } }) and silently returns
// null bids. Until that's fixed, parse the response directly here.
async function fetchYesMid(ticker) {
  const data = await authedRequest('GET', `/markets/${ticker}/orderbook`, null, { depth: 5 }).catch(() => null)
  const fp = data?.orderbook_fp ?? data?.orderbook ?? data
  if (!fp) return null
  const yes = (fp.yes_dollars || fp.yes || []).map(([p,q]) => [parseFloat(p), parseFloat(q)]).filter(([p]) => Number.isFinite(p))
  const no  = (fp.no_dollars  || fp.no  || []).map(([p,q]) => [parseFloat(p), parseFloat(q)]).filter(([p]) => Number.isFinite(p))
  // values are in dollars (e.g. 0.39); convert to cents
  const toCents = p => p < 1 ? Math.round(p * 100) : Math.round(p)
  const bestYesBid = yes.length ? toCents(Math.max(...yes.map(([p]) => p))) : null
  const bestNoBid  = no.length  ? toCents(Math.max(...no.map(([p]) => p)))  : null
  if (bestYesBid == null || bestNoBid == null) return null
  const bestYesAsk = 100 - bestNoBid
  return (bestYesBid + bestYesAsk) / 2
}
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })

const DATE = process.argv[2] || new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
const REQUEST_DELAY_MS = 200  // be nice to Kalshi API

console.log(`Closing line writeback for ${DATE}`)

const fires = await db.execute({
  sql: `SELECT id, pitcher_name, side, strike, ticker, fill_price, strategy_mode
        FROM ks_bets
        WHERE bet_date = ? AND order_id IS NOT NULL AND ticker IS NOT NULL
          AND closing_line_cents IS NULL
        ORDER BY logged_at`,
  args: [DATE],
})
console.log(`Found ${fires.rows.length} fires needing closing-line capture\n`)

if (fires.rows.length === 0) {
  console.log('Nothing to capture.')
  process.exit(0)
}

const tickerToCloseMid = new Map()
const uniqueTickers = [...new Set(fires.rows.map(f => f.ticker))]
console.log(`${uniqueTickers.length} unique tickers to fetch\n`)

let i = 0
for (const ticker of uniqueTickers) {
  i++
  try {
    const yesMid = await fetchYesMid(ticker)
    tickerToCloseMid.set(ticker, yesMid)
  } catch (err) {
    console.warn(`  fetch failed for ${ticker}: ${err.message}`)
    tickerToCloseMid.set(ticker, null)
  }
  if (i % 25 === 0) console.log(`  [progress] ${i}/${uniqueTickers.length}`)
  await new Promise(r => setTimeout(r, REQUEST_DELAY_MS))
}
console.log(`\nFetched ${[...tickerToCloseMid.values()].filter(v => v != null).length}/${uniqueTickers.length} closing prices\n`)

let updated = 0, skipped = 0, beat = 0, paid = 0, totalCLV = 0
const now = new Date().toISOString()

for (const f of fires.rows) {
  const closeYesMid = tickerToCloseMid.get(f.ticker)
  if (closeYesMid == null) { skipped++; continue }

  // CLV calculation:
  //   For YES: clv = (closeYesMid - fill_price) — positive if close moved up after we bought
  //   For NO:  bet_price_yes_frame = 100 - fill_price (since fill was paid for NO)
  //            clv = (bet_price_yes_frame - closeYesMid) — positive if close moved down (NO got more likely)
  //
  // Standardize CLV to "positive = we beat the closing line"
  const fillCents = Number(f.fill_price ?? 0)
  let clvCents
  if (f.side === 'YES') {
    clvCents = closeYesMid - fillCents
  } else {
    // NO: fill_price is stored as YES-equiv (100 - noAsk). So:
    //   noAsk_we_paid = 100 - fillCents
    //   close_no_mid  = 100 - closeYesMid
    //   CLV = (close_no_mid - noAsk) — positive if NO got more expensive (correct direction)
    const noAsk = 100 - fillCents
    const closeNoMid = 100 - closeYesMid
    clvCents = closeNoMid - noAsk
    // Equivalent: clvCents = -(closeYesMid - fillCents) ... no wait, it's = fillCents - closeYesMid
    // Let me redo: closeNoMid - noAsk = (100 - closeYesMid) - (100 - fillCents) = fillCents - closeYesMid
    clvCents = fillCents - closeYesMid
  }

  await db.execute({
    sql: `UPDATE ks_bets SET closing_line_cents = ?, clv_cents = ?, closing_line_captured_at = ? WHERE id = ?`,
    args: [Math.round(closeYesMid * 100) / 100, Math.round(clvCents * 100) / 100, now, f.id],
  }).catch(() => { skipped++ })
  updated++
  totalCLV += clvCents
  if (clvCents > 0) beat++
  else paid++
}

console.log(`Updated: ${updated} rows`)
console.log(`Skipped: ${skipped} rows (no close data)`)
if (updated > 0) {
  const avgCLV = totalCLV / updated
  console.log(`\n── CLV Summary ──`)
  console.log(`  Beat the close: ${beat} bets (${(beat/updated*100).toFixed(1)}%)`)
  console.log(`  Paid retail:    ${paid} bets (${(paid/updated*100).toFixed(1)}%)`)
  console.log(`  Avg CLV:        ${avgCLV >= 0 ? '+' : ''}${avgCLV.toFixed(2)}¢ per bet`)
  console.log(`\n  Verdict:`)
  if (avgCLV > 1) console.log(`  ✓ SHARP (avg CLV > 1¢ — beating the close)`)
  else if (avgCLV > 0) console.log(`  ⚠ Marginal (avg CLV positive but < 1¢)`)
  else console.log(`  ✗ Paying retail (avg CLV negative — variance, not edge)`)

  // By strategy
  const byStrat = await db.execute({
    sql: `SELECT strategy_mode, COUNT(*) AS n, ROUND(AVG(clv_cents), 2) AS avg_clv,
                 SUM(CASE WHEN clv_cents > 0 THEN 1 ELSE 0 END) AS beats
          FROM ks_bets WHERE bet_date = ? AND clv_cents IS NOT NULL
          GROUP BY strategy_mode`,
    args: [DATE],
  })
  console.log(`\n  By strategy:`)
  for (const r of byStrat.rows) {
    const beatPct = (Number(r.beats) / Number(r.n) * 100).toFixed(1)
    console.log(`    ${(r.strategy_mode ?? '?').padEnd(28)} ${r.n} bets · avg CLV ${Number(r.avg_clv) >= 0 ? '+' : ''}${r.avg_clv}¢ · beat ${beatPct}%`)
  }
}
