// Liquidity-presence profile by hour-of-day (UTC + ET)
import 'dotenv/config'
import { run } from '../lib/db.js'

async function main() {
  console.log('\n=== Liquidity by hour ===')
  console.log('  hour_UTC  hour_ET   snapshots   has_bid%   has_ask%   med_spread   med_top_qty')
  const r = await run(`
    SELECT
      strftime('%H', ts) as hour_utc,
      COUNT(*) total,
      SUM(CASE WHEN best_yes_bid IS NOT NULL THEN 1 ELSE 0 END) has_bid,
      SUM(CASE WHEN best_yes_ask IS NOT NULL THEN 1 ELSE 0 END) has_ask,
      AVG(CASE WHEN best_yes_bid IS NOT NULL AND best_yes_ask IS NOT NULL
              THEN best_yes_ask - best_yes_bid END) avg_spread,
      AVG(CASE WHEN best_yes_bid_qty IS NOT NULL THEN best_yes_bid_qty END) avg_top_qty
    FROM weather_orderbook_snapshots
    WHERE ts >= datetime('now','-24 hours')
    GROUP BY hour_utc
    ORDER BY hour_utc`)
  for (const row of r.rows) {
    const utc = parseInt(row.hour_utc)
    const et = (utc - 4 + 24) % 24  // EDT
    const bidPct = (100 * row.has_bid / row.total).toFixed(0)
    const askPct = (100 * row.has_ask / row.total).toFixed(0)
    const sp = row.avg_spread != null ? row.avg_spread.toFixed(1) : '-'
    const qty = row.avg_top_qty != null ? row.avg_top_qty.toFixed(0) : '-'
    console.log(`  ${row.hour_utc}        ${String(et).padStart(2)}        ${String(row.total).padStart(6)}    ${bidPct.padStart(5)}%    ${askPct.padStart(5)}%   ${sp.padStart(8)}   ${qty.padStart(7)}`)
  }

  console.log('\n=== Right now (last 5 min) — NYC ladder ===')
  const r2 = await run(`
    WITH latest AS (SELECT ticker, MAX(ts) ts FROM weather_orderbook_snapshots GROUP BY ticker)
    SELECT s.ticker, m.no_sub_title, s.best_yes_bid, s.best_yes_ask,
           s.best_yes_bid_qty, s.best_yes_ask_qty,
           s.open_interest, s.last_price_cents,
           ROUND((julianday('now') - julianday(s.ts))*86400, 0) as age_s
    FROM weather_orderbook_snapshots s
    JOIN latest l ON l.ticker=s.ticker AND l.ts=s.ts
    JOIN weather_markets m ON m.ticker=s.ticker
    WHERE s.ticker LIKE 'KXHIGHNY-%'
    ORDER BY m.event_ticker, m.floor_strike`)
  console.log(`  ${'ticker'.padEnd(35)} ${'cond'.padEnd(15)} ybid yask qty_bid qty_ask    OI  last age_s`)
  for (const row of r2.rows) {
    console.log(
      `  ${row.ticker.padEnd(35)} ${(row.no_sub_title||'').padEnd(15)} ` +
      `${String(row.best_yes_bid??'-').padStart(4)} ${String(row.best_yes_ask??'-').padStart(4)} ` +
      `${String(row.best_yes_bid_qty??'-').padStart(7)} ${String(row.best_yes_ask_qty??'-').padStart(7)} ` +
      `${String(Math.round(row.open_interest||0)).padStart(6)} ${String(row.last_price_cents??'-').padStart(5)} ${String(row.age_s).padStart(5)}`
    )
  }

  console.log('\n=== Cross-city right-now ===')
  const r3 = await run(`
    WITH latest AS (SELECT ticker, MAX(ts) ts FROM weather_orderbook_snapshots GROUP BY ticker)
    SELECT m.series_ticker,
           COUNT(*) n,
           SUM(CASE WHEN s.best_yes_bid IS NOT NULL THEN 1 ELSE 0 END) with_bid,
           SUM(CASE WHEN s.best_yes_ask IS NOT NULL THEN 1 ELSE 0 END) with_ask,
           AVG(CASE WHEN s.best_yes_bid IS NOT NULL AND s.best_yes_ask IS NOT NULL
                THEN s.best_yes_ask - s.best_yes_bid END) avg_spread,
           SUM(s.open_interest) total_oi
    FROM weather_orderbook_snapshots s
    JOIN latest l ON l.ticker=s.ticker AND l.ts=s.ts
    JOIN weather_markets m ON m.ticker=s.ticker
    GROUP BY m.series_ticker
    ORDER BY m.series_ticker`)
  console.log(`  series          n with_bid with_ask avg_spread total_OI`)
  for (const row of r3.rows) {
    console.log(`  ${row.series_ticker.padEnd(15)} ${String(row.n).padStart(2)}   ${String(row.with_bid).padStart(2)}/${row.n}    ${String(row.with_ask).padStart(2)}/${row.n}   ${(row.avg_spread??0).toFixed(2).padStart(6)}   ${String(Math.round(row.total_oi||0)).padStart(8)}`)
  }

  console.log('\n=== Trade activity proxy: last_price changes per ticker last 12h ===')
  const r4 = await run(`
    SELECT ticker,
      COUNT(DISTINCT last_price_cents) distinct_prices,
      MIN(last_price_cents) lo, MAX(last_price_cents) hi,
      COUNT(*) snaps
    FROM weather_orderbook_snapshots
    WHERE ts >= datetime('now','-12 hours')
      AND last_price_cents IS NOT NULL
    GROUP BY ticker
    HAVING distinct_prices > 1
    ORDER BY distinct_prices DESC LIMIT 20`)
  console.log(`  ${'ticker'.padEnd(35)} distinct  range   snaps`)
  for (const row of r4.rows) {
    console.log(`  ${row.ticker.padEnd(35)} ${String(row.distinct_prices).padStart(7)}    ${String(row.lo).padStart(2)}-${String(row.hi).padEnd(3)} ${String(row.snaps).padStart(5)}`)
  }

  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
