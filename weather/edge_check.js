// Quick edge check across captured data:
//  (a) ladder overround — sum of YES asks per event vs $1.00
//  (b) forecast-vs-market — GEFS ensemble implied prob vs market mid per bracket
//  (c) spread distribution by bracket position (modal vs tail)

import 'dotenv/config'
import { run } from '../lib/db.js'

const CITY_TO_STATION = { NY: 'KNYC', CHI: 'KMDW', MIA: 'KMIA', AUS: 'KAUS', LAX: 'KLAX', DEN: 'KDEN' }

function eventCity(eventTicker) {
  const m = eventTicker.match(/^KXHIGH([A-Z]+)-/)
  return m ? m[1] : null
}
function eventDate(eventTicker) {
  // KXHIGHNY-26MAY05  →  2026-05-05
  const m = eventTicker.match(/^KXHIGH[A-Z]+-(\d{2})([A-Z]{3})(\d{2})$/)
  if (!m) return null
  const months = { JAN:'01',FEB:'02',MAR:'03',APR:'04',MAY:'05',JUN:'06',JUL:'07',AUG:'08',SEP:'09',OCT:'10',NOV:'11',DEC:'12' }
  return `20${m[1]}-${months[m[2]]}-${m[3]}`
}

// Bracket parser: T70 = >70 (≥70.5 in fact, "70° or below")
//                 B70.5 = 70 to 71 (range covering [70.5, 72.5))
//                 T77 = "78° or above" (>=77.5)
// Kalshi convention: floor_strike is the actual numeric floor in °F.
// no_sub_title gives the human-readable resolution rule.
function bracketRange(ticker, noSubTitle, floorStrike) {
  // We'll lean on the ticker letter prefix and floor_strike.
  // Format examples we've seen on KXHIGHNY:
  //   T70  -> "69° or below"     (yes if <= 69)
  //   B70.5 -> "70° to 71°"      (yes if 70 or 71)
  //   T77  -> "78° or above"     (yes if >= 78)
  //
  // We model each bracket as a numeric range [lo, hi]:
  //   "X° or below"  → [-inf, X]
  //   "A° to B°"     → [A, B]   (inclusive both ends)
  //   "X° or above"  → [X, +inf]
  if (!noSubTitle) return null
  const below = noSubTitle.match(/^(-?\d+)°\s*or\s*below/i)
  if (below) return { lo: -Infinity, hi: Number(below[1]) }
  const above = noSubTitle.match(/^(-?\d+)°\s*or\s*above/i)
  if (above) return { lo: Number(above[1]), hi: Infinity }
  const between = noSubTitle.match(/^(-?\d+)°\s*to\s*(-?\d+)°/i)
  if (between) return { lo: Number(between[1]), hi: Number(between[2]) }
  return null
}

// Compute fraction of GEFS ensemble members whose forecast high falls inside [lo, hi]
function ensembleProb(highs, lo, hi) {
  if (!highs.length) return null
  let n = 0
  for (const h of highs) if (h >= lo && h <= hi) n += 1
  return n / highs.length
}

async function main() {
  // Pull latest snapshot per ticker, joined to event/series + GEFS ensemble
  const r = await run(`
    WITH latest AS (
      SELECT ticker, MAX(ts) ts FROM weather_orderbook_snapshots
      WHERE ts >= datetime('now','-15 minutes')
      GROUP BY ticker
    )
    SELECT s.ticker, m.event_ticker, m.no_sub_title, m.floor_strike,
           s.best_yes_bid, s.best_yes_ask, s.best_yes_bid_qty, s.best_yes_ask_qty,
           s.last_price_cents, s.open_interest
    FROM weather_orderbook_snapshots s
    JOIN latest l ON l.ticker = s.ticker AND l.ts = s.ts
    JOIN weather_markets m ON m.ticker = s.ticker
    WHERE s.ticker LIKE 'KXHIGH%'
    ORDER BY m.event_ticker, m.floor_strike`)

  // Group by event
  const events = new Map()
  for (const row of r.rows) {
    if (!events.has(row.event_ticker)) events.set(row.event_ticker, [])
    events.get(row.event_ticker).push(row)
  }

  console.log('\n=== (a) Ladder overround test ===')
  console.log('   event             n  sum_yes_asks  sum_yes_bids  overround   max_qty_short')
  let arbCount = 0, arbTotal = 0
  for (const [evt, brackets] of events) {
    const sumAsk = brackets.reduce((s, b) => s + (b.best_yes_ask || 0), 0)
    const sumBid = brackets.reduce((s, b) => s + (b.best_yes_bid || 0), 0)
    const allHaveAsk = brackets.every(b => b.best_yes_ask != null)
    const minAskQty = allHaveAsk ? Math.min(...brackets.map(b => b.best_yes_ask_qty || 0)) : 0
    const overround = sumAsk - 100  // cents
    if (allHaveAsk && overround > 1) { arbCount++; arbTotal += overround }
    console.log(
      `   ${evt.padEnd(20)} ${String(brackets.length).padStart(2)}  ` +
      `${String(sumAsk).padStart(6)}¢       ${String(sumBid).padStart(6)}¢      ` +
      `${(overround>0?'+':'')+overround}¢`.padStart(8) + '   ' +
      `${allHaveAsk ? String(minAskQty)+' contracts' : 'INCOMPLETE'}`
    )
  }
  console.log(`   summary: ${arbCount} ladders showed +overround; total=${arbTotal}¢`)

  console.log('\n=== (b) GEFS ensemble vs market — biggest residuals ===')
  // Pull most recent GEFS members per station/date
  const gefs = await run(`
    SELECT station, target_date, predicted_high_f, ensemble_member,
           ROW_NUMBER() OVER (PARTITION BY station, target_date, ensemble_member
                              ORDER BY ts_fetched DESC) rn
    FROM weather_forecasts
    WHERE source='open-meteo-gefs-ensemble'
      AND target_date >= date('now')`)
  const ens = new Map()  // key=`${station}|${date}` → array of highs (1 per member, latest cycle)
  for (const row of gefs.rows) {
    if (row.rn !== 1) continue
    const k = `${row.station}|${row.target_date}`
    if (!ens.has(k)) ens.set(k, [])
    ens.get(k).push(row.predicted_high_f)
  }

  // For each bracket, compute GEFS implied prob vs market mid
  const residuals = []
  for (const [evt, brackets] of events) {
    const city = eventCity(evt)
    const date = eventDate(evt)
    if (!city || !date) continue
    const station = CITY_TO_STATION[city]
    const highs = ens.get(`${station}|${date}`) || []
    if (highs.length < 10) continue  // need real ensemble
    for (const b of brackets) {
      const range = bracketRange(b.ticker, b.no_sub_title, b.floor_strike)
      if (!range) continue
      const gefsProb = ensembleProb(highs, range.lo, range.hi)
      if (gefsProb == null) continue
      const askC = b.best_yes_ask, bidC = b.best_yes_bid
      if (askC == null || bidC == null) continue
      const mid = (askC + bidC) / 2  // cents
      const residual = gefsProb * 100 - mid  // positive = GEFS thinks more likely than market
      residuals.push({ ticker: b.ticker, cond: b.no_sub_title, gefsProb: gefsProb*100, mid, askC, bidC, residual,
                       highs_n: highs.length })
    }
  }
  residuals.sort((a, b) => Math.abs(b.residual) - Math.abs(a.residual))
  console.log(`   ${'ticker'.padEnd(35)} ${'cond'.padEnd(15)} GEFS%  mid    bid-ask    Δ(GEFS-mid)`)
  for (const r of residuals.slice(0, 15)) {
    const sign = r.residual > 0 ? '+' : ''
    console.log(
      `   ${r.ticker.padEnd(35)} ${(r.cond||'').padEnd(15)} ` +
      `${r.gefsProb.toFixed(0).padStart(4)}%  ${r.mid.toFixed(1).padStart(4)}¢  ${String(r.bidC).padStart(2)}-${String(r.askC).padEnd(3)}    ${sign}${r.residual.toFixed(1)}¢`
    )
  }

  console.log('\n=== (c) Spread by bracket position ===')
  console.log('   pos_in_ladder  n  median_spread  median_top_qty  bid_coverage')
  // For each event, rank brackets by floor_strike and bucket by position
  const buckets = {}
  for (const [evt, brackets] of events) {
    const sorted = brackets.slice().sort((a, b) => (a.floor_strike||0) - (b.floor_strike||0))
    sorted.forEach((b, i) => {
      const pos = i  // 0..5
      if (!buckets[pos]) buckets[pos] = []
      const sp = (b.best_yes_bid != null && b.best_yes_ask != null)
        ? b.best_yes_ask - b.best_yes_bid : null
      buckets[pos].push({ sp, qty: b.best_yes_bid_qty, hasBid: b.best_yes_bid != null })
    })
  }
  for (const pos of Object.keys(buckets)) {
    const arr = buckets[pos]
    const sps = arr.map(x => x.sp).filter(x => x != null).sort((a, b) => a - b)
    const qtys = arr.map(x => x.qty).filter(x => x != null).sort((a, b) => a - b)
    const median = (a) => a.length ? a[Math.floor(a.length/2)] : null
    const cov = arr.filter(x => x.hasBid).length / arr.length
    console.log(
      `   pos=${pos}          ${String(arr.length).padStart(2)} ` +
      `${String(median(sps)??'-').padStart(6)}¢       ${String(median(qtys)??'-').padStart(6)}        ${(cov*100).toFixed(0)}%`
    )
  }

  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
