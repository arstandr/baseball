// Build raw backtest dataset with full data persistence so model + filter
// tuning can iterate in seconds (no Kalshi/MLB API hits after first run).
//
// Saves:
//   .extendedBacktest.cache.json — MLB game logs + name→id (already exists)
//   .candleCache.json            — per-market closing candles (NEW)
//   .rawBacktestData.json        — final per-pitcher-day records (NEW)
//
// Each record:
//   {
//     pitcher_id, pitcher_name, target_date, game_start_iso,
//     ladder: [{strike, yes_bid, yes_ask, no_bid, no_ask, ticker}],
//     prior_starts: [{date, ks, ip, bf}],   // ALL prior starts (for window tuning)
//     actual_K: number
//   }

import 'dotenv/config'
import fs from 'fs'
import { authedRequest } from '../lib/kalshi.js'

const PRE_GAME_HRS = 6
const REQUEST_DELAY_MS = 100

const CACHE = '/Users/adamstandridge/Documents/projects/baseball/.extendedBacktest.cache.json'
const CANDLES = '/Users/adamstandridge/Documents/projects/baseball/.candleCache.json'
const OUT = '/Users/adamstandridge/Documents/projects/baseball/.rawBacktestData.json'

let nameToId = {}, gameLogCache = {}, candleCache = {}
if (fs.existsSync(CACHE)) {
  const c = JSON.parse(fs.readFileSync(CACHE, 'utf8'))
  nameToId = c.nameToId || {}; gameLogCache = c.gameLogCache || {}
}
if (fs.existsSync(CANDLES)) {
  candleCache = JSON.parse(fs.readFileSync(CANDLES, 'utf8'))
}
console.log(`Cache: ${Object.keys(gameLogCache).length} game logs, ${Object.keys(candleCache).length} candle entries`)

const MONTHS = { JAN:'01', FEB:'02', MAR:'03', APR:'04', MAY:'05', JUN:'06', JUL:'07', AUG:'08', SEP:'09', OCT:'10', NOV:'11', DEC:'12' }
function parseGameKey(k) {
  const m = /^(\d{2})([A-Z]{3})(\d{2})(\d{2})(\d{2})/.exec(k)
  if (!m) return null
  return {
    iso: `20${m[1]}-${MONTHS[m[2]]}-${m[3]}T${m[4]}:${m[5]}:00.000Z`,
    date: `20${m[1]}-${MONTHS[m[2]]}-${m[3]}`,
  }
}
function parseIp(s) {
  if (s == null) return 0
  const [w, f] = String(s).split('.')
  return Number(w) + (Number(f || 0) / 3)
}

async function searchPitcherId(name) {
  if (nameToId[name] !== undefined) return nameToId[name]
  const url = `https://statsapi.mlb.com/api/v1/people/search?names=${encodeURIComponent(name)}&sportIds=1`
  const res = await fetch(url).then(r => r.ok ? r.json() : null).catch(() => null)
  const people = res?.people || []
  const p = people.find(x => x.primaryPosition?.code === 'P') || people[0]
  nameToId[name] = p?.id ?? null
  return nameToId[name]
}
async function fetchGameLog(pid) {
  if (gameLogCache[pid]) return gameLogCache[pid]
  const url = `https://statsapi.mlb.com/api/v1/people/${pid}/stats?stats=gameLog&season=2026&group=pitching`
  const res = await fetch(url).then(r => r.ok ? r.json() : null).catch(() => null)
  const splits = res?.stats?.[0]?.splits || []
  const games = splits.map(s => ({
    date: s.date,
    ks: Number(s.stat?.strikeOuts ?? 0),
    ip: parseIp(s.stat?.inningsPitched),
    bf: Number(s.stat?.battersFaced ?? 0),
  })).filter(g => g.date && g.ip > 0)
  gameLogCache[pid] = games
  return games
}

async function getCandles(ticker, startSec) {
  const cacheKey = `${ticker}|${startSec}`
  if (candleCache[cacheKey]) return candleCache[cacheKey]
  const c = await authedRequest('GET', `/series/KXMLBKS/markets/${ticker}/candlesticks`, null, {
    period_interval: 60,
    start_ts: startSec - PRE_GAME_HRS * 3600,
    end_ts: startSec,
  }).catch(() => null)
  await new Promise(r => setTimeout(r, REQUEST_DELAY_MS))
  const cs = c?.candlesticks || []
  if (!cs.length) { candleCache[cacheKey] = null; return null }
  const last = cs[cs.length - 1]
  const result = {
    yes_bid: parseFloat(last?.yes_bid?.close_dollars ?? '0'),
    yes_ask: parseFloat(last?.yes_ask?.close_dollars ?? '0'),
  }
  candleCache[cacheKey] = result
  return result
}

console.log('Pulling all settled KXMLBKS markets...')
const allMarkets = []
let cursor = ''
for (let p = 0; p < 50; p++) {
  const r = await authedRequest('GET', '/markets', null, { status: 'settled', limit: 1000, series_ticker: 'KXMLBKS', cursor }).catch(()=>null)
  if (!r?.markets?.length) break
  allMarkets.push(...r.markets)
  cursor = r.cursor || ''
  if (!cursor) break
}
console.log(`Total settled markets: ${allMarkets.length}`)

// Group into pitcher-games
const ladders = new Map()
for (const m of allMarkets) {
  const parts = m.ticker.split('-')
  if (parts.length < 4) continue
  const [, gameKey, pitcherCode, strikeStr] = parts
  const parsed = parseGameKey(gameKey)
  if (!parsed) continue
  const strike = parseInt(strikeStr)
  if (!Number.isFinite(strike)) continue
  const nameMatch = /^(.+?):\s*\d+\+/.exec(m.title || '')
  const pitcherName = nameMatch ? nameMatch[1].trim() : null
  const key = `${gameKey}|${pitcherCode}`
  if (!ladders.has(key)) ladders.set(key, {
    gameKey, pitcherCode, pitcherName, date: parsed.date, gameStartIso: parsed.iso, markets: [],
  })
  ladders.get(key).markets.push({ ticker: m.ticker, strike, market: m })
}
console.log(`${ladders.size} pitcher-games`)

const records = []
let i = 0
for (const [key, lad] of ladders) {
  i++
  if (!lad.pitcherName) continue
  const startSec = Math.floor(Date.parse(lad.gameStartIso) / 1000)

  // Fetch closing prices (cached)
  const ladder = []
  let actualK = null
  for (const m of lad.markets) {
    actualK ??= m.market.expiration_value != null ? Number(m.market.expiration_value) : null
    const c = await getCandles(m.ticker, startSec)
    if (!c) continue
    if (c.yes_bid + c.yes_ask === 0 || c.yes_bid >= 0.99 || c.yes_ask <= 0.01) continue
    ladder.push({
      strike: m.strike,
      yes_bid: Math.round(c.yes_bid * 100),
      yes_ask: Math.round(c.yes_ask * 100),
      no_bid:  Math.round((1 - c.yes_ask) * 100),
      no_ask:  Math.round((1 - c.yes_bid) * 100),
      ticker: m.ticker,
    })
  }
  if (ladder.length < 4 || actualK == null) continue

  const pid = await searchPitcherId(lad.pitcherName)
  if (!pid) continue
  const log = await fetchGameLog(pid)
  const priorStarts = log.filter(g => g.date < lad.date)
  if (priorStarts.length === 0) continue

  records.push({
    pitcher_id: pid,
    pitcher_name: lad.pitcherName,
    target_date: lad.date,
    game_start_iso: lad.gameStartIso,
    ladder,
    prior_starts: priorStarts,  // all of them, for window tuning
    actual_K: actualK,
  })

  if (i % 50 === 0) {
    console.log(`  [${i}/${ladders.size}] ${lad.date} ${lad.pitcherName}: ${priorStarts.length} prior starts, ladder=${ladder.length}, actual=${actualK}`)
    fs.writeFileSync(CACHE, JSON.stringify({ nameToId, gameLogCache }))
    fs.writeFileSync(CANDLES, JSON.stringify(candleCache))
  }
}

fs.writeFileSync(CACHE, JSON.stringify({ nameToId, gameLogCache }))
fs.writeFileSync(CANDLES, JSON.stringify(candleCache))
fs.writeFileSync(OUT, JSON.stringify(records))

console.log(`\nSaved ${records.length} records → ${OUT}`)
const dates = [...new Set(records.map(r => r.target_date))].sort()
console.log(`Date range: ${dates[0]} → ${dates[dates.length-1]} (${dates.length} unique dates)`)
