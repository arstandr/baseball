// Extended Single-Pick Fade backtest.
//
// Pulls EVERY settled KXMLBKS market from Kalshi, builds the closing ladder
// via candles, computes a simplified model_prob from MLB game-log K9 history
// (Poisson), evaluates the strategy across the entire season-to-date.
//
// Strategy under test (from the constrained backtest):
//   - top-N per pitcher-day, edge_yes ≥ 5¢, ask ≤ 50¢, YES-only
//   - bet $50 per fire (5% of $1000 bankroll)

import 'dotenv/config'
import fs from 'fs'
import path from 'path'
import { authedRequest } from '../lib/kalshi.js'
import { createClient } from '@libsql/client'

const BET_USD = 50
const FEE = 0.07
const PRE_GAME_HRS = 6
const REQUEST_DELAY_MS = 100

const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })

const MONTHS = { JAN:'01', FEB:'02', MAR:'03', APR:'04', MAY:'05', JUN:'06', JUL:'07', AUG:'08', SEP:'09', OCT:'10', NOV:'11', DEC:'12' }
function parseGameKey(k) {
  const m = /^(\d{2})([A-Z]{3})(\d{2})(\d{2})(\d{2})/.exec(k)
  if (!m) return null
  return {
    iso: `20${m[1]}-${MONTHS[m[2]]}-${m[3]}T${m[4]}:${m[5]}:00.000Z`,
    date: `20${m[1]}-${MONTHS[m[2]]}-${m[3]}`,
  }
}

// Poisson P(X ≥ n) for lambda
function poissonGEqN(lambda, n) {
  if (n <= 0) return 1
  let cum = Math.exp(-lambda), term = cum
  for (let k = 1; k < n; k++) { term = term * lambda / k; cum += term }
  return Math.max(0, Math.min(1, 1 - cum))
}

// Cache file for game logs (avoid re-pulling)
const CACHE_FILE = path.join(process.cwd(), '.extendedBacktest.cache.json')
let nameToId = {}
let gameLogCache = {}
if (fs.existsSync(CACHE_FILE)) {
  try { const c = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); nameToId = c.nameToId || {}; gameLogCache = c.gameLogCache || {} } catch {}
}

async function searchPitcherId(name) {
  if (nameToId[name] != null) return nameToId[name]
  // Use stats API search
  const url = `https://statsapi.mlb.com/api/v1/people/search?names=${encodeURIComponent(name)}&sportIds=1`
  const res = await fetch(url).then(r => r.ok ? r.json() : null).catch(() => null)
  const people = res?.people || []
  // Prefer pitchers
  const pitcher = people.find(p => p.primaryPosition?.code === 'P') || people[0]
  if (pitcher?.id) {
    nameToId[name] = pitcher.id
    return pitcher.id
  }
  nameToId[name] = null
  return null
}

async function fetchGameLog(pitcherId) {
  if (gameLogCache[pitcherId]) return gameLogCache[pitcherId]
  const url = `https://statsapi.mlb.com/api/v1/people/${pitcherId}/stats?stats=gameLog&season=2026&group=pitching`
  const res = await fetch(url).then(r => r.ok ? r.json() : null).catch(() => null)
  const splits = res?.stats?.[0]?.splits || []
  // Normalize: array of { date, ks, ip, bf }
  const games = splits.map(s => ({
    date: s.date,
    ks: Number(s.stat?.strikeOuts ?? 0),
    ip: parseIp(s.stat?.inningsPitched),
    bf: Number(s.stat?.battersFaced ?? 0),
  })).filter(g => g.date && g.ip > 0)
  gameLogCache[pitcherId] = games
  return games
}
function parseIp(ipStr) {
  if (ipStr == null) return 0
  const s = String(ipStr); const [w, f] = s.split('.')
  return Number(w) + (Number(f || 0) / 3)
}

// Compute prior K9 + avg_IP from game log, considering only games before targetDate
function computePriorRates(gameLog, targetDate) {
  const prior = gameLog.filter(g => g.date < targetDate)
  if (prior.length === 0) return null
  // Use last 5 starts if available, else all
  const recent = prior.slice(-5)
  const totalK = recent.reduce((s,g) => s + g.ks, 0)
  const totalIp = recent.reduce((s,g) => s + g.ip, 0)
  if (totalIp <= 0) return null
  const k9 = totalK / totalIp * 9
  const avgIp = totalIp / recent.length
  return { k9, avgIp, n: recent.length }
}

console.log('Pulling all settled KXMLBKS markets...')
const allMarkets = []
let cursor = ''
for (let p = 0; p < 50; p++) {
  const r = await authedRequest('GET', '/markets', null, { status: 'settled', limit: 1000, series_ticker: 'KXMLBKS', cursor }).catch(()=>null)
  if (!r?.markets?.length) break
  allMarkets.push(...r.markets)
  cursor = r.cursor || ''
  console.log(`  page ${p+1}: ${r.markets.length} (total ${allMarkets.length})`)
  if (!cursor) break
}
console.log(`Total settled markets: ${allMarkets.length}`)

// Parse each market: ticker = KXMLBKS-{gameKey}-{pitcherCode}-{strike}
// pitcherCode example: PITPSKENES30 (PIT, P, SKENES, 30) or LADTGLASNOW31
// Title example: "Paul Skenes: 6+ strikeouts?"
const ladders = new Map()  // key: gameKey|pitcherCode → { date, gameKey, pitcherName, markets: [...] }
for (const m of allMarkets) {
  const parts = m.ticker.split('-')
  if (parts.length < 4) continue
  const [, gameKey, pitcherCode, strikeStr] = parts
  const parsed = parseGameKey(gameKey)
  if (!parsed) continue
  const strike = parseInt(strikeStr)
  if (!Number.isFinite(strike)) continue
  // Extract name from title
  const nameMatch = /^(.+?):\s*\d+\+/.exec(m.title || '')
  const pitcherName = nameMatch ? nameMatch[1].trim() : null
  const key = `${gameKey}|${pitcherCode}`
  if (!ladders.has(key)) ladders.set(key, {
    gameKey, pitcherCode, pitcherName, date: parsed.date, gameStartIso: parsed.iso, markets: [],
  })
  ladders.get(key).markets.push({ ticker: m.ticker, strike, market: m })
}
console.log(`${ladders.size} pitcher-games`)

// For each ladder, fetch candles for closing prices
console.log('\nFetching closing-line candles for each ladder...')
let processed = 0
const fires = []

for (const [key, lad] of ladders) {
  if (!lad.pitcherName) continue
  const startSec = Math.floor(Date.parse(lad.gameStartIso) / 1000)

  // Pull closing prices for each strike
  const ladder = []
  let actualK = null
  for (const m of lad.markets) {
    actualK ??= m.market.expiration_value != null ? Number(m.market.expiration_value) : null
    const c = await authedRequest('GET', `/series/KXMLBKS/markets/${m.ticker}/candlesticks`, null, {
      period_interval: 60,
      start_ts: startSec - PRE_GAME_HRS * 3600,
      end_ts: startSec,
    }).catch(() => null)
    await new Promise(r => setTimeout(r, REQUEST_DELAY_MS))
    const cs = c?.candlesticks || []
    if (!cs.length) continue
    const last = cs[cs.length - 1]
    const yb = parseFloat(last?.yes_bid?.close_dollars ?? '0')
    const ya = parseFloat(last?.yes_ask?.close_dollars ?? '0')
    if (yb + ya === 0 || yb >= 0.99 || ya <= 0.01) continue
    ladder.push({ strike: m.strike, yes_bid: Math.round(yb*100), yes_ask: Math.round(ya*100), ticker: m.ticker })
  }
  if (ladder.length < 4 || actualK == null) { processed++; continue }

  // Get pitcher's MLB ID + prior K9
  let pitcherId = await searchPitcherId(lad.pitcherName).catch(() => null)
  if (!pitcherId) { processed++; continue }
  const gameLog = await fetchGameLog(pitcherId)
  const rates = computePriorRates(gameLog, lad.date)
  if (!rates || rates.k9 < 4 || rates.k9 > 18) { processed++; continue }
  const lambda = rates.k9 * rates.avgIp / 9

  // Build candidates: for each strike, compute YES edge
  const candidates = []
  for (const l of ladder) {
    const modelProb = poissonGEqN(lambda, l.strike)
    const edgeYes = modelProb - l.yes_ask / 100
    const edgeNo  = l.yes_bid / 100 - modelProb
    if (edgeYes > 0 && l.yes_ask >= 3 && l.yes_ask <= 88) {
      candidates.push({ side: 'YES', strike: l.strike, ask: l.yes_ask, edge: edgeYes, model_prob: modelProb, ticker: l.ticker })
    }
    if (edgeNo > 0) {
      const noAsk = 100 - l.yes_bid
      if (noAsk >= 3 && noAsk <= 88) {
        candidates.push({ side: 'NO', strike: l.strike, ask: noAsk, edge: edgeNo, model_prob: modelProb, ticker: l.ticker })
      }
    }
  }

  // Settle each candidate with actualK
  for (const c of candidates) {
    const won = c.side === 'YES' ? actualK >= c.strike : actualK < c.strike
    const contracts = Math.max(1, Math.floor(BET_USD / (c.ask / 100)))
    const stake = contracts * (c.ask / 100)
    const pnl = won ? contracts * ((100 - c.ask) / 100) * (1 - FEE) : -stake
    fires.push({
      bet_date: lad.date, pitcher_name: lad.pitcherName, pitcher_id: pitcherId,
      side: c.side, strike: c.strike, ask: c.ask, edge: c.edge,
      model_prob: c.model_prob, market_lambda: lambda, k9: rates.k9, avgIp: rates.avgIp,
      actual_k: actualK, won: won ? 1 : 0, contracts, stake, pnl,
      ticker: c.ticker,
    })
  }
  processed++
  if (processed % 50 === 0) {
    console.log(`  [${processed}/${ladders.size}] ${lad.date} ${lad.pitcherName}: λ=${lambda.toFixed(1)}, ${candidates.length} cands, actual=${actualK}`)
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ nameToId, gameLogCache }))
  }
}
fs.writeFileSync(CACHE_FILE, JSON.stringify({ nameToId, gameLogCache }))

console.log(`\nTotal candidates: ${fires.length} from ${processed} pitcher-games`)

// Date range
const dates = [...new Set(fires.map(f => f.bet_date))].sort()
console.log(`Date range: ${dates[0]} → ${dates[dates.length-1]} (${dates.length} game days)`)

function run(label, opts) {
  const { topN = 5, minEdge = 0.05, minStrike = 0, maxAsk = 50, sideOnly = 'YES', scoreFn = c => c.edge } = opts
  const byDate = new Map()
  for (const c of fires) {
    if (sideOnly && c.side !== sideOnly) continue
    if (c.edge < minEdge) continue
    if (c.strike < minStrike) continue
    if (c.ask > maxAsk) continue
    if (!byDate.has(c.bet_date)) byDate.set(c.bet_date, [])
    byDate.get(c.bet_date).push(c)
  }
  const out = []
  for (const [d, arr] of byDate) {
    arr.sort((a, b) => scoreFn(b) - scoreFn(a))
    for (let i = 0; i < Math.min(topN, arr.length); i++) out.push(arr[i])
  }
  const w = out.filter(f => f.won).length
  const stake = out.reduce((s, f) => s + f.stake, 0)
  const pnl = out.reduce((s, f) => s + f.pnl, 0)
  const winPct = out.length ? (w/out.length*100).toFixed(1) : '0.0'
  const roi = stake ? (pnl/stake*100).toFixed(1) : '0.0'
  console.log(`  ${label.padEnd(45)} n=${String(out.length).padStart(4)}  W=${String(w).padStart(3)}  win=${winPct.padStart(5)}%  stake=$${stake.toFixed(0).padStart(6)}  P&L=${pnl >= 0 ? '+' : ''}$${pnl.toFixed(0).padStart(6)}  ROI=${roi.padStart(7)}%`)
  return out
}

console.log('\n═══ Strategy sweep on extended dataset ═══')
console.log('config'.padEnd(47) + 'fires  W   win%   stake     P&L     ROI')
console.log('─'.repeat(105))
run('top-5/day, edge≥5c, ask≤50c, YES (validated)', { topN: 5, minEdge: 0.05, maxAsk: 50, sideOnly: 'YES' })
run('top-3/day, edge≥5c, ask≤50c, YES',              { topN: 3, minEdge: 0.05, maxAsk: 50, sideOnly: 'YES' })
run('top-1/day, edge≥5c, ask≤50c, YES',              { topN: 1, minEdge: 0.05, maxAsk: 50, sideOnly: 'YES' })
run('top-5/day, edge≥8c, ask≤50c, YES',              { topN: 5, minEdge: 0.08, maxAsk: 50, sideOnly: 'YES' })
run('top-5/day, edge≥10c, ask≤50c, YES',             { topN: 5, minEdge: 0.10, maxAsk: 50, sideOnly: 'YES' })
run('top-5/day, edge≥5c, ask≤40c, YES',              { topN: 5, minEdge: 0.05, maxAsk: 40, sideOnly: 'YES' })
run('top-5/day, edge≥5c, ask≤30c, YES (longshot)',   { topN: 5, minEdge: 0.05, maxAsk: 30, sideOnly: 'YES' })
run('top-5/day, edge≥5c, ask≤50c, strike≥6, YES',    { topN: 5, minEdge: 0.05, maxAsk: 50, minStrike: 6, sideOnly: 'YES' })
run('top-5/day, edge≥5c, ask≤50c, strike≥7, YES',    { topN: 5, minEdge: 0.05, maxAsk: 50, minStrike: 7, sideOnly: 'YES' })
run('top-3/day, score=edge/ask, edge≥5c, YES',       { topN: 3, minEdge: 0.05, maxAsk: 88, sideOnly: 'YES', scoreFn: c => c.edge / (c.ask/100) })
run('all, edge≥5c, ask≤50c, YES',                    { topN: 999, minEdge: 0.05, maxAsk: 50, sideOnly: 'YES' })

// Per-day breakdown for the validated config
console.log('\n═══ Per-day breakdown: top-5/day, edge≥5c, ask≤50c, YES-only ═══')
const validated = run('VALIDATED', { topN: 5, minEdge: 0.05, maxAsk: 50, sideOnly: 'YES' })
const byD = new Map()
for (const f of validated) {
  const cur = byD.get(f.bet_date) ?? { n: 0, w: 0, pnl: 0 }
  cur.n++; cur.w += f.won; cur.pnl += f.pnl; byD.set(f.bet_date, cur)
}
for (const d of [...byD.keys()].sort()) {
  const s = byD.get(d)
  console.log(`  ${d}: ${String(s.n).padStart(2)} bets, ${s.w}W/${s.n-s.w}L (${(s.w/s.n*100).toFixed(0)}%), P&L=${s.pnl>=0?'+':''}$${s.pnl.toFixed(0)}`)
}
