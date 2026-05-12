// scripts/live/captureClosingLines.js
//
// Reads oracle/oracle-sim-<DATE>.jsonl, extracts the unique tickers that the
// Oracle saw today, queries the Kalshi orderbook for each, and writes a
// closing-lines-<DATE>.csv snapshot.
//
// Use this at slate close (~30 min after last first pitch) to capture CLV
// (closing line value) for the bets the Oracle ENFORCED-SKIPPED — those
// bets aren't in ks_bets, so without a snapshot we have no way to ask
// "what would the line have been if we held?".
//
// Usage:
//   node scripts/live/captureClosingLines.js                 (today)
//   node scripts/live/captureClosingLines.js --date 2026-04-30
//
// Output:
//   oracle/closing-lines-<DATE>.csv with columns:
//     bet_id, source, ticker, side, market_mid_at_decision,
//     close_yes_bid, close_yes_ask, close_no_bid, close_no_ask,
//     close_mid_yes, close_mid_no, captured_at, error

import 'dotenv/config'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'

import { getOrderbook } from '../../lib/kalshi.js'
import { parseArgs } from '../../lib/cli-args.js'

const today = new Date().toISOString().slice(0, 10)
const opts = parseArgs({
  date: { default: today },
  depth: { type: 'number', default: 10 },
  delay_ms: { type: 'number', default: 250 },   // pace requests
})
const DATE = opts.date
const DEPTH = opts.depth
const DELAY = opts.delay_ms

const LOG_PATH = path.resolve(`oracle/oracle-sim-${DATE}.jsonl`)
const CSV_PATH = path.resolve(`oracle/closing-lines-${DATE}.csv`)

if (!existsSync(LOG_PATH)) {
  console.error(`[captureClosingLines] no log at ${LOG_PATH}`)
  process.exit(1)
}

console.log(`[captureClosingLines] reading ${LOG_PATH}`)
const raw = readFileSync(LOG_PATH, 'utf-8')
const records = []
for (const line of raw.split('\n')) {
  if (!line.trim()) continue
  try { records.push(JSON.parse(line)) } catch { /* skip */ }
}
console.log(`[captureClosingLines] ${records.length} records loaded`)

// One row per (bet_id, ticker) — but if no ticker, we can't fetch closing line
const tickerRows = []
const tickerSet = new Set()
for (const r of records) {
  const ticker = r.ticker ?? null
  if (!ticker) continue
  tickerRows.push({
    bet_id: r.bet_id ?? null,
    source: r.source ?? 'simulator',
    ticker,
    side: r.side,
    market_mid: r.market_mid ?? null,
    oracle_action: r.oracle_action ?? null,
    effective_action: r.effective_action ?? r.oracle_action ?? null,
  })
  tickerSet.add(ticker)
}
console.log(`[captureClosingLines] ${tickerSet.size} unique tickers across ${tickerRows.length} rows`)

if (tickerSet.size === 0) {
  console.warn('[captureClosingLines] no tickers found — exiting (records may pre-date ticker logging)')
  process.exit(0)
}

const bookByTicker = new Map()
let i = 0
for (const ticker of tickerSet) {
  i++
  try {
    const ob = await getOrderbook(ticker, DEPTH)
    if (ob) {
      bookByTicker.set(ticker, {
        yes_bid:  ob.best_yes_bid,
        yes_ask:  ob.best_yes_ask,
        no_bid:   ob.best_no_bid,
        no_ask:   ob.best_no_ask,
        fetched_at: ob.fetched_at,
        error: null,
      })
    } else {
      bookByTicker.set(ticker, { yes_bid: null, yes_ask: null, no_bid: null, no_ask: null, fetched_at: Date.now(), error: 'no_orderbook' })
    }
  } catch (err) {
    bookByTicker.set(ticker, { yes_bid: null, yes_ask: null, no_bid: null, no_ask: null, fetched_at: Date.now(), error: String(err?.message ?? err) })
  }
  if (i % 25 === 0) console.log(`  [progress] ${i}/${tickerSet.size}`)
  await new Promise(r => setTimeout(r, DELAY))
}
console.log(`[captureClosingLines] fetched ${bookByTicker.size} orderbooks`)

const escape = v => {
  if (v == null) return ''
  const s = String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
const cols = [
  'bet_id','source','ticker','side','market_mid_at_decision',
  'oracle_action','effective_action',
  'close_yes_bid','close_yes_ask','close_no_bid','close_no_ask',
  'close_mid_yes','close_mid_no','captured_at','error',
]
const lines = [cols.join(',')]
const capturedIso = new Date().toISOString()
for (const row of tickerRows) {
  const b = bookByTicker.get(row.ticker) ?? {}
  const yesMid = (b.yes_bid != null && b.yes_ask != null) ? (b.yes_bid + b.yes_ask) / 2 : null
  const noMid  = (b.no_bid  != null && b.no_ask  != null) ? (b.no_bid  + b.no_ask)  / 2 : null
  lines.push([
    row.bet_id, row.source, row.ticker, row.side, row.market_mid,
    row.oracle_action, row.effective_action,
    b.yes_bid, b.yes_ask, b.no_bid, b.no_ask,
    yesMid, noMid, capturedIso, b.error ?? '',
  ].map(escape).join(','))
}
writeFileSync(CSV_PATH, lines.join('\n') + '\n', 'utf-8')
console.log(`[captureClosingLines] wrote ${lines.length - 1} rows → ${CSV_PATH}`)
