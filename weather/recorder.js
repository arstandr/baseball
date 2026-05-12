// weather/recorder.js — Layer 1 raw-data recorder for Kalshi weather markets.
//
// Records four streams to Turso for offline edge analysis:
//   1. Kalshi weather market metadata (per series, refreshed every 5 min)
//   2. Kalshi orderbook snapshots (per market, every 30 s)
//   3. METAR observations (every 60 s, NWS settlement stations)
//   4. Forecast model outputs from Open-Meteo (every 60 min, GFS/ECMWF/AIFS)
//
// All Kalshi endpoints used here are public — no auth required.
//
// Each poller is an independent loop. Failures are logged and the loop
// continues; one bad cycle never takes down the others.
//
// Run:  node weather/recorder.js
// Stop: SIGINT / Ctrl-C (drains in-flight writes, then exits)

import 'dotenv/config'
import { migrate, run } from '../lib/db.js'

// --------------------------------------------------------------------------
// Configuration
// --------------------------------------------------------------------------

const KALSHI_BASE = 'https://api.elections.kalshi.com/trade-api/v2'

// All weather series we want to track. Most are seasonal (snow Dec-Mar,
// hurricane Jun-Oct) and currently empty in May; the discovery loop
// gracefully skips empty ones, so leaving them in costs nothing.
const WEATHER_SERIES = [
  'KXHIGHNY', 'KXHIGHCHI', 'KXHIGHMIA', 'KXHIGHAUS', 'KXHIGHLAX', 'KXHIGHDEN',
  'KXLOWNY',  'KXLOWCHI',  'KXLOWMIA',  'KXLOWAUS',  'KXLOWLAX',  'KXLOWDEN',
  'KXNYCSNOWM', 'KXSFRAINM', 'KXBOSSNOWM', 'KXCHISNOWM', 'KXDENSNOWM',
  'KXSNOWSTORM', 'KXHURPATHFLA', 'KXATLHURNUM', 'KXNAMEDSTORMS', 'KXGTEMP',
]

// NWS settlement stations + Open-Meteo coordinates.
// Cities mapped to the city code in the Kalshi ticker (NY, CHI, MIA, AUS, LAX, DEN).
const STATIONS = [
  { id: 'KNYC', city: 'NY',  lat: 40.7789, lon: -73.9692 }, // Central Park
  { id: 'KMDW', city: 'CHI', lat: 41.7868, lon: -87.7522 }, // Chicago Midway
  { id: 'KMIA', city: 'MIA', lat: 25.7959, lon: -80.2870 }, // Miami Intl
  { id: 'KAUS', city: 'AUS', lat: 30.1944, lon: -97.6700 }, // Austin-Bergstrom
  { id: 'KLAX', city: 'LAX', lat: 33.9425, lon: -118.4081 }, // LAX
  { id: 'KDEN', city: 'DEN', lat: 39.8617, lon: -104.6731 }, // Denver Intl
]

const POLL = {
  discoverMs:   5 * 60_000,
  orderbookMs: 30_000,
  metarMs:     60_000,
  forecastMs:  60 * 60_000,
  heartbeatMs: 60_000,
}

// --------------------------------------------------------------------------
// Generic helpers
// --------------------------------------------------------------------------

let _shouldStop = false
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const nowIso = () => new Date().toISOString()
const log = (...args) => console.log(`[${nowIso()}]`, ...args)
const logErr = (label, err) => console.error(`[${nowIso()}] [${label}]`, err?.message || err)

async function fetchJson(url, { timeoutMs = 15_000 } = {}) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: ctl.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`)
    return await res.json()
  } finally { clearTimeout(t) }
}

// Tally counters surfaced by the heartbeat.
const counters = {
  markets: 0, orderbooks: 0, orderbookErrs: 0,
  metar: 0, metarErrs: 0,
  forecasts: 0, forecastErrs: 0,
  cycles: 0,
}

// --------------------------------------------------------------------------
// Kalshi market discovery — refreshes the weather_markets table.
// --------------------------------------------------------------------------

async function discoverWeatherMarkets() {
  let total = 0
  for (const series of WEATHER_SERIES) {
    if (_shouldStop) return total
    let cursor = null
    do {
      const url = new URL(`${KALSHI_BASE}/markets`)
      url.searchParams.set('series_ticker', series)
      url.searchParams.set('status', 'open')
      url.searchParams.set('limit', '200')
      if (cursor) url.searchParams.set('cursor', cursor)

      let data
      try { data = await fetchJson(url.toString()) }
      catch (err) { logErr(`discover ${series}`, err); break }

      for (const m of data.markets || []) {
        await run(
          `INSERT INTO weather_markets
             (ticker, series_ticker, event_ticker, status, floor_strike, cap_strike,
              no_sub_title, open_time, close_time, expiration_time,
              occurrence_datetime, rules_primary, last_seen_at, raw_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
           ON CONFLICT(ticker) DO UPDATE SET
             status              = excluded.status,
             floor_strike        = excluded.floor_strike,
             cap_strike          = excluded.cap_strike,
             no_sub_title        = excluded.no_sub_title,
             open_time           = excluded.open_time,
             close_time          = excluded.close_time,
             expiration_time     = excluded.expiration_time,
             occurrence_datetime = excluded.occurrence_datetime,
             rules_primary       = excluded.rules_primary,
             last_seen_at        = datetime('now'),
             raw_json            = excluded.raw_json`,
          [
            m.ticker, series, m.event_ticker, m.status,
            m.floor_strike ?? null, m.cap_strike ?? null,
            m.no_sub_title ?? null, m.open_time ?? null, m.close_time ?? null,
            m.expiration_time ?? null, m.occurrence_datetime ?? null,
            m.rules_primary ?? null, JSON.stringify(m),
          ]
        )
        total += 1
      }
      cursor = data.cursor || null
    } while (cursor)
  }
  counters.markets = total
  return total
}

// --------------------------------------------------------------------------
// Orderbook snapshots — pulls each open market's L2 book.
// --------------------------------------------------------------------------

async function loadActiveTickers() {
  const r = await run(
    `SELECT ticker FROM weather_markets
     WHERE status = 'active' OR status = 'open'
        OR last_seen_at >= datetime('now','-10 minutes')`
  )
  return r.rows.map(row => row.ticker)
}

async function snapshotOrderbook(ticker) {
  const url = `${KALSHI_BASE}/markets/${ticker}/orderbook?depth=20`
  const data = await fetchJson(url, { timeoutMs: 10_000 })
  // Kalshi returns `orderbook_fp` with prices as dollar strings ("0.6100", "31.00").
  // Older docs/clients reference `orderbook` with int cents — keep the fallback.
  const book = data?.orderbook_fp || data?.orderbook || {}
  const yesRaw = book.yes_dollars || book.yes || []
  const noRaw  = book.no_dollars  || book.no  || []
  const toCents = (v) => {
    const n = typeof v === 'string' ? parseFloat(v) : Number(v)
    if (!Number.isFinite(n)) return null
    return n < 1 ? Math.round(n * 100) : Math.round(n)
  }
  const toQty = (v) => {
    const n = typeof v === 'string' ? parseFloat(v) : Number(v)
    return Number.isFinite(n) ? Math.round(n) : null
  }
  const yesLevels = yesRaw.map(([p, q]) => [toCents(p), toQty(q)])
                          .filter(([p, q]) => p > 0 && q > 0)
  const noLevels  = noRaw.map(([p, q])  => [toCents(p), toQty(q)])
                         .filter(([p, q]) => p > 0 && q > 0)
  // Best bid (descending price) for YES; best ask = 100 - best NO bid.
  yesLevels.sort((a, b) => b[0] - a[0])
  noLevels .sort((a, b) => b[0] - a[0])
  const bestYesBid    = yesLevels[0]?.[0] ?? null
  const bestYesBidQty = yesLevels[0]?.[1] ?? null
  const bestNoBid     = noLevels[0]?.[0] ?? null
  const bestNoBidQty  = noLevels[0]?.[1] ?? null
  // Convert NO best bid to YES best ask: yes_ask_cents = 100 - no_bid_cents
  const bestYesAsk    = bestNoBid != null ? 100 - bestNoBid : null
  const bestYesAskQty = bestNoBidQty
  // Mirror for NO ask:
  const bestNoAsk     = bestYesBid != null ? 100 - bestYesBid : null
  const bestNoAskQty  = bestYesBidQty

  // Pull market metadata in same call cycle for OI/liquidity/last/volume.
  let mkt = null
  try { mkt = await fetchJson(`${KALSHI_BASE}/markets/${ticker}`, { timeoutMs: 10_000 }) }
  catch { /* non-fatal — orderbook still recorded */ }
  const m = mkt?.market || {}

  await run(
    `INSERT INTO weather_orderbook_snapshots
       (ts, ticker,
        best_yes_bid, best_yes_bid_qty, best_yes_ask, best_yes_ask_qty,
        best_no_bid, best_no_bid_qty, best_no_ask, best_no_ask_qty,
        yes_book_json, no_book_json,
        open_interest, liquidity_dollars, volume_lifetime, last_price_cents)
     VALUES (datetime('now'), ?, ?,?,?,?, ?,?,?,?, ?, ?, ?, ?, ?, ?)`,
    [
      ticker,
      bestYesBid, bestYesBidQty, bestYesAsk, bestYesAskQty,
      bestNoBid,  bestNoBidQty,  bestNoAsk,  bestNoAskQty,
      JSON.stringify(yesLevels), JSON.stringify(noLevels),
      m.open_interest_fp != null ? Number(m.open_interest_fp) : null,
      m.liquidity_dollars  != null ? Number(m.liquidity_dollars)  : null,
      m.volume             != null ? Number(m.volume)             : null,
      m.last_price_dollars != null ? Math.round(Number(m.last_price_dollars) * 100) : null,
    ]
  )
}

async function pollAllOrderbooks() {
  const tickers = await loadActiveTickers()
  if (!tickers.length) return 0
  let n = 0, errs = 0
  for (const t of tickers) {
    if (_shouldStop) break
    try { await snapshotOrderbook(t); n += 1 }
    catch (err) { errs += 1; logErr(`orderbook ${t}`, err) }
    // 50ms spacing keeps total request rate <20/s, well under any reasonable cap
    await sleep(50)
  }
  counters.orderbooks  += n
  counters.orderbookErrs += errs
  return n
}

// --------------------------------------------------------------------------
// METAR — aviationweather.gov public JSON.
// Fields: temp/dewp in °C, wspd in kt, altim in hPa, rawOb is the source.
// --------------------------------------------------------------------------

function cToF(c) { return c == null ? null : c * 9 / 5 + 32 }

// Parse Tx/Tn (6-hour max/min) and 4-group (24-hour max/min) from METAR remarks.
// Format: "4xxxx" or "1snnn 2snnn" in remarks. We only pull what's cleanly available.
function parseRemarks(raw) {
  if (!raw || typeof raw !== 'string') return {}
  const out = {}
  // 6-hour max: 1snnn   (s = sign 0/1, nnn = tenths °C)
  const m1 = raw.match(/(?:^|\s)1(\d)(\d{3})(?=\s|$)/)
  if (m1) { const sign = m1[1] === '1' ? -1 : 1; out.six_hr_max_f = cToF(sign * parseInt(m1[2], 10) / 10) }
  // 6-hour min: 2snnn
  const m2 = raw.match(/(?:^|\s)2(\d)(\d{3})(?=\s|$)/)
  if (m2) { const sign = m2[1] === '1' ? -1 : 1; out.six_hr_min_f = cToF(sign * parseInt(m2[2], 10) / 10) }
  // 24-hour max/min: 4snnnsnnn (max then min, both in tenths °C)
  const m4 = raw.match(/(?:^|\s)4(\d)(\d{3})(\d)(\d{3})(?=\s|$)/)
  if (m4) {
    const maxSign = m4[1] === '1' ? -1 : 1
    out.daily_max_f = cToF(maxSign * parseInt(m4[2], 10) / 10)
  }
  return out
}

async function pollMetar() {
  const ids = STATIONS.map(s => s.id).join(',')
  const url = `https://aviationweather.gov/api/data/metar?ids=${ids}&format=json&hours=2`
  let obs
  try { obs = await fetchJson(url, { timeoutMs: 15_000 }) }
  catch (err) { counters.metarErrs += 1; logErr('metar', err); return 0 }
  let n = 0
  for (const o of obs || []) {
    const remarks = parseRemarks(o.rawOb)
    try {
      await run(
        `INSERT OR IGNORE INTO weather_metar
           (ts_fetched, station, obs_time, raw, temp_c, temp_f, dewpoint_c,
            wind_kt, altimeter, six_hr_max_f, six_hr_min_f, daily_max_f)
         VALUES (datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          o.icaoId, o.obsTime || o.reportTime, o.rawOb,
          o.temp ?? null, cToF(o.temp), o.dewp ?? null,
          o.wspd ?? null, o.altim ?? null,
          remarks.six_hr_max_f ?? null,
          remarks.six_hr_min_f ?? null,
          remarks.daily_max_f ?? null,
        ]
      )
      n += 1
    } catch (err) { counters.metarErrs += 1; logErr(`metar insert ${o.icaoId}`, err) }
  }
  counters.metar += n
  return n
}

// --------------------------------------------------------------------------
// Forecast — Open-Meteo deterministic + ensemble.
// We pull GFS, ECMWF IFS, ECMWF AIFS (where available), and GEFS members.
// --------------------------------------------------------------------------

const FORECAST_MODELS = ['gfs_seamless', 'ecmwf_ifs025', 'ecmwf_aifs025_single']

async function pollForecastsForStation(st) {
  let total = 0
  // Deterministic models (one row per model per target_date)
  for (const model of FORECAST_MODELS) {
    if (_shouldStop) break
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${st.lat}&longitude=${st.lon}` +
                `&daily=temperature_2m_max,temperature_2m_min&temperature_unit=fahrenheit` +
                `&timezone=America/New_York&forecast_days=3&models=${model}`
    let data
    try { data = await fetchJson(url, { timeoutMs: 15_000 }) }
    catch (err) { counters.forecastErrs += 1; logErr(`fc ${model} ${st.id}`, err); continue }
    const days  = data?.daily?.time || []
    const highs = data?.daily?.temperature_2m_max || []
    const lows  = data?.daily?.temperature_2m_min || []
    for (let i = 0; i < days.length; i++) {
      try {
        await run(
          `INSERT INTO weather_forecasts
             (ts_fetched, source, station, target_date, predicted_high_f, predicted_low_f, raw_json)
           VALUES (datetime('now'), ?, ?, ?, ?, ?, ?)`,
          [`open-meteo-${model}`, st.id, days[i], highs[i] ?? null, lows[i] ?? null, JSON.stringify({day: days[i], high: highs[i], low: lows[i]})]
        )
        total += 1
      } catch (err) { counters.forecastErrs += 1; logErr(`fc insert ${st.id}`, err) }
    }
  }
  // GEFS ensemble (31 members)
  try {
    const url = `https://ensemble-api.open-meteo.com/v1/ensemble?latitude=${st.lat}&longitude=${st.lon}` +
                `&hourly=temperature_2m&temperature_unit=fahrenheit&timezone=America/New_York&forecast_days=3&models=gfs_seamless`
    const data = await fetchJson(url, { timeoutMs: 20_000 })
    // Each member is a key like temperature_2m_member01 .. member30
    const hours = data?.hourly?.time || []
    const memberKeys = Object.keys(data?.hourly || {}).filter(k => k.startsWith('temperature_2m'))
    // Reduce hourly → per-day max for each member
    const dayMax = new Map()  // key=`${member}|${day}` → max
    for (let i = 0; i < hours.length; i++) {
      const day = hours[i].slice(0, 10)
      for (const k of memberKeys) {
        const memberIdx = k === 'temperature_2m' ? 0 : Number(k.split('_member')[1] || 0)
        const t = data.hourly[k][i]
        if (t == null) continue
        const key = `${memberIdx}|${day}`
        const prev = dayMax.get(key)
        if (prev == null || t > prev) dayMax.set(key, t)
      }
    }
    for (const [key, max] of dayMax) {
      const [memberIdx, day] = key.split('|')
      await run(
        `INSERT INTO weather_forecasts
           (ts_fetched, source, station, target_date, predicted_high_f, ensemble_member, raw_json)
         VALUES (datetime('now'), 'open-meteo-gefs-ensemble', ?, ?, ?, ?, ?)`,
        [st.id, day, max, Number(memberIdx), null]
      )
      total += 1
    }
  } catch (err) { counters.forecastErrs += 1; logErr(`fc ensemble ${st.id}`, err) }
  return total
}

async function pollAllForecasts() {
  let total = 0
  for (const st of STATIONS) {
    if (_shouldStop) break
    total += await pollForecastsForStation(st)
    await sleep(200) // gentle on Open-Meteo
  }
  counters.forecasts += total
  return total
}

// --------------------------------------------------------------------------
// Loops
// --------------------------------------------------------------------------

async function runLoop(name, fn, intervalMs) {
  while (!_shouldStop) {
    const t0 = Date.now()
    try { await fn() }
    catch (err) { logErr(`loop ${name}`, err) }
    const elapsed = Date.now() - t0
    const remaining = Math.max(500, intervalMs - elapsed)
    // Sleep in 500ms chunks so SIGINT can break us out fast.
    let waited = 0
    while (waited < remaining && !_shouldStop) {
      const step = Math.min(500, remaining - waited)
      await sleep(step); waited += step
    }
  }
}

function startHeartbeat() {
  setInterval(() => {
    counters.cycles += 1
    log(
      `hb cycles=${counters.cycles}`,
      `markets=${counters.markets}`,
      `ob=${counters.orderbooks}`, `obErr=${counters.orderbookErrs}`,
      `metar=${counters.metar}`, `metarErr=${counters.metarErrs}`,
      `fc=${counters.forecasts}`, `fcErr=${counters.forecastErrs}`,
    )
  }, POLL.heartbeatMs).unref()
}

// --------------------------------------------------------------------------
// CLI entry
// --------------------------------------------------------------------------

async function main() {
  log('weather/recorder starting…')
  await migrate()
  log('schema migrated')

  // First-pass discovery so the orderbook loop has something to poll immediately
  const n = await discoverWeatherMarkets()
  log(`initial discovery: ${n} active weather markets`)

  startHeartbeat()

  // Run all four loops in parallel; orchestrator awaits them but they never resolve
  // until SIGINT toggles _shouldStop.
  process.on('SIGINT',  () => { log('SIGINT received, stopping…'); _shouldStop = true })
  process.on('SIGTERM', () => { log('SIGTERM received, stopping…'); _shouldStop = true })

  await Promise.all([
    runLoop('discover',   discoverWeatherMarkets, POLL.discoverMs),
    runLoop('orderbooks', pollAllOrderbooks,      POLL.orderbookMs),
    runLoop('metar',      pollMetar,              POLL.metarMs),
    runLoop('forecasts',  pollAllForecasts,       POLL.forecastMs),
  ])

  log('all loops stopped, exiting cleanly')
  process.exit(0)
}

main().catch(err => { logErr('fatal', err); process.exit(1) })
