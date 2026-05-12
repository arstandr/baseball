// Backtest CLV using market_snapshots history (Apr 28 onward).
// For every fired bet without closing_line_cents, find the LAST pre-game
// snapshot of that ticker on its bet_date and use its yes_bid/yes_ask as
// the closing line proxy.
//
// Usage: node scripts/backtestCLV.mjs [--dry-run]

import 'dotenv/config'
import { createClient } from '@libsql/client'

const DRY = process.argv.includes('--dry-run')
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })

// Game start time is encoded in the ticker: KXMLBKS-{YY}{MMM}{DD}{HHMM}...
// e.g. KXMLBKS-26MAY061610ATLSEA-...  → 2026-05-06T16:10:00Z
const MONTHS = { JAN:'01', FEB:'02', MAR:'03', APR:'04', MAY:'05', JUN:'06', JUL:'07', AUG:'08', SEP:'09', OCT:'10', NOV:'11', DEC:'12' }
function parseGameStartIso(ticker) {
  const m = /^KXMLBKS-(\d{2})([A-Z]{3})(\d{2})(\d{2})(\d{2})/.exec(ticker || '')
  if (!m) return null
  const [, yy, mmm, dd, hh, mn] = m
  const mo = MONTHS[mmm]
  if (!mo) return null
  return `20${yy}-${mo}-${dd}T${hh}:${mn}:00.000Z`
}

const fires = await db.execute(`
  SELECT id, bet_date, pitcher_name, side, strike, ticker, fill_price, strategy_mode
  FROM ks_bets
  WHERE order_id IS NOT NULL AND ticker IS NOT NULL
    AND bet_date >= '2026-04-28'
    AND closing_line_cents IS NULL
  ORDER BY bet_date, id
`)
console.log(`${fires.rows.length} fires to backfill (${DRY ? 'DRY RUN' : 'LIVE WRITE'})`)
if (fires.rows.length === 0) process.exit(0)

const now = new Date().toISOString()
let updated = 0, skipped = 0, beat = 0, paid = 0, totalCLV = 0
const byStrat = new Map()  // strategy_mode → { n, sumCLV, beats }

for (const f of fires.rows) {
  // Closing line proxy: snapshot whose captured_at is closest to game start
  // (parsed from ticker), preferring at-or-before. Skip post-settlement reads
  // (yes_bid+yes_ask collapsed to ≤2 or ≥98 = market resolved).
  const gameStartIso = parseGameStartIso(f.ticker)
  if (!gameStartIso) { skipped++; continue }
  const snap = await db.execute({
    sql: `SELECT yes_bid, yes_ask, yes_price, captured_at, eval_mode
          FROM market_snapshots
          WHERE ticker = ? AND game_date = ?
            AND yes_bid IS NOT NULL AND yes_ask IS NOT NULL
            AND (yes_bid + yes_ask) > 2 AND (yes_bid + yes_ask) < 198
          ORDER BY
            CASE WHEN captured_at <= ? THEN 0 ELSE 1 END ASC,
            ABS(julianday(captured_at) - julianday(?)) ASC
          LIMIT 1`,
    args: [f.ticker, f.bet_date, gameStartIso, gameStartIso],
  })
  if (snap.rows.length === 0) { skipped++; continue }
  const r = snap.rows[0]

  let closeYesMid = null
  if (r.yes_bid != null && r.yes_ask != null) closeYesMid = (Number(r.yes_bid) + Number(r.yes_ask)) / 2
  else if (r.yes_price != null) closeYesMid = Number(r.yes_price)
  if (closeYesMid == null || !Number.isFinite(closeYesMid)) { skipped++; continue }

  const fillCents = Number(f.fill_price ?? 0)
  // Standardize CLV to "positive = beat the close"
  // YES: clv = closeYesMid - fillCents (close moved up after we bought)
  // NO:  fill_price stored as YES-equiv (100 - noAsk); CLV = fillCents - closeYesMid
  const clvCents = f.side === 'YES' ? (closeYesMid - fillCents) : (fillCents - closeYesMid)

  if (!DRY) {
    await db.execute({
      sql: `UPDATE ks_bets SET closing_line_cents = ?, clv_cents = ?, closing_line_captured_at = ?
            WHERE id = ?`,
      args: [Math.round(closeYesMid * 100) / 100, Math.round(clvCents * 100) / 100, now, f.id],
    })
  }
  updated++
  totalCLV += clvCents
  if (clvCents > 0) beat++; else paid++

  const strat = f.strategy_mode ?? '?'
  const cur = byStrat.get(strat) ?? { n: 0, sumCLV: 0, beats: 0 }
  cur.n++; cur.sumCLV += clvCents; if (clvCents > 0) cur.beats++
  byStrat.set(strat, cur)
}

console.log(`\nUpdated: ${updated} rows`)
console.log(`Skipped: ${skipped} rows (no snapshot data)`)
if (updated > 0) {
  const avgCLV = totalCLV / updated
  console.log(`\n── CLV Summary (backtest) ──`)
  console.log(`  Beat the close: ${beat} bets (${(beat/updated*100).toFixed(1)}%)`)
  console.log(`  Paid retail:    ${paid} bets (${(paid/updated*100).toFixed(1)}%)`)
  console.log(`  Avg CLV:        ${avgCLV >= 0 ? '+' : ''}${avgCLV.toFixed(2)}¢ per bet`)

  console.log(`\n  By strategy:`)
  for (const [strat, s] of [...byStrat.entries()].sort()) {
    const avg = s.sumCLV / s.n
    const beatPct = (s.beats / s.n * 100).toFixed(1)
    console.log(`    ${strat.padEnd(28)} ${String(s.n).padStart(3)} bets · avg CLV ${avg >= 0 ? '+' : ''}${avg.toFixed(2)}¢ · beat ${beatPct}%`)
  }
}
