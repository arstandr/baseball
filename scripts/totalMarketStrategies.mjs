// Two strategies on the same TOTAL data pull:
//
//   A) Cross-Strike-Total — apply our existing Poisson-residual arb logic
//      to the TOTAL run-line ladder (Over X.5 markets). Tighter spreads,
//      deeper books, same math.
//
//   B) Inverted-K — use TOTAL market to derive each starter's implied K rate,
//      compare to KS ladder. Bet KS YES/NO when divergence > threshold.
//
// Outcomes:
//   - TOTAL strikes settle to actual game total runs (from settled market metadata)
//   - KS strikes settle to actual pitcher K (from pitcher_recent_starts)
//
// Sizing: 3% bankroll cap + $5 tail cap (same as live Cross-Strike).
// Fill assumption: ask price (taker, worst case).

import 'dotenv/config'
import { createClient } from '@libsql/client'
import { authedRequest } from '../lib/kalshi.js'
import { generateCrossStrikeCandidates, fitDistribution, poissonGEqN } from '../lib/crossStrikeCandidates.js'

const FROM_DATE = '2026-04-28'
const TO_DATE   = '2026-05-05'
const PRE_GAME_HRS = 6
const STARTER_IP = 5.5
const BULLPEN_ERA = 4.00
const REQUEST_DELAY_MS = 150

const BANKROLL = 1000
const PCT_CAP  = 0.03
const TAIL_USD = 5
const TAIL_THRESH = 25
const FEE = 0.07
const MIN_BET_USD = 1

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
function k9ToEra(k9) { return Math.max(2.0, Math.min(7.5, 5.5 - 0.20 * k9)) }
function eraToK9(era) { return Math.max(3.0, Math.min(15.0, (5.5 - era) / 0.20)) }

function sizeBet(askCents) {
  const baseUsd = Math.min(BANKROLL * PCT_CAP, askCents < TAIL_THRESH ? TAIL_USD : Infinity)
  const usd = Math.max(MIN_BET_USD, baseUsd)
  const contracts = Math.max(1, Math.floor(usd / (askCents / 100)))
  return { stake: contracts * (askCents / 100), contracts }
}
function pnl(side, askCents, contracts, won) {
  return won ? contracts * ((100 - askCents) / 100) * (1 - FEE) : -contracts * (askCents / 100)
}

// 1) Identify games with KS data
const games = await db.execute(`
  SELECT DISTINCT
    SUBSTR(ticker, 9, 16) AS game_key,
    game_date
  FROM market_snapshots
  WHERE game_date BETWEEN '${FROM_DATE}' AND '${TO_DATE}'
    AND ticker LIKE 'KXMLBKS-%'
`)
console.log(`${games.rows.length} candidate games`)

// Pull TOTAL ladder candles once per game (cached)
async function pullTotalLadder(gameKey, gameStartIso) {
  const ev = `KXMLBTOTAL-${gameKey}`
  const ms = await authedRequest('GET', '/markets', null, { status: 'settled', limit: 50, event_ticker: ev }).catch(()=>null)
  if (!ms?.markets?.length) return null
  const startSec = Math.floor(Date.parse(gameStartIso) / 1000)
  let actualTotal = null
  const ladder = []
  for (const m of ms.markets) {
    actualTotal ??= m.expiration_value != null ? Number(m.expiration_value) : null
    const c = await authedRequest('GET', `/series/KXMLBTOTAL/markets/${m.ticker}/candlesticks`, null, {
      period_interval: 60,
      start_ts: startSec - PRE_GAME_HRS * 3600,
      end_ts: startSec,
    }).catch(()=>null)
    await new Promise(r => setTimeout(r, REQUEST_DELAY_MS))
    const candles = c?.candlesticks || []
    if (!candles.length) continue
    const last = candles[candles.length - 1]
    const yb = parseFloat(last?.yes_bid?.close_dollars ?? '0')
    const ya = parseFloat(last?.yes_ask?.close_dollars ?? '0')
    if (yb + ya === 0 || yb >= 0.99 || ya <= 0.01) continue
    const x = /Over\s+([\d.]+)/i.exec(m.yes_sub_title || '')
    if (!x) continue
    const strikeFloor = Math.ceil(parseFloat(x[1]))
    ladder.push({
      strike: strikeFloor,
      yes_bid: Math.round(yb * 100), yes_ask: Math.round(ya * 100),
      market_mid: ((yb + ya) / 2) * 100,
      ticker: m.ticker,
    })
  }
  ladder.sort((a, b) => a.strike - b.strike)
  return { ladder, actualTotal }
}

// Pre-load actual_ks per pitcher per day
const actuals = await db.execute(`SELECT pitcher_id, game_date, ks FROM pitcher_recent_starts WHERE game_date BETWEEN '${FROM_DATE}' AND '${TO_DATE}'`)
const actualKs = new Map(actuals.rows.map(r => [`${r.pitcher_id}|${r.game_date}`, Number(r.ks)]))

// 2) Run both strategies
const crossStrikeFires = []
const invertedKFires = []

let processed = 0
for (const g of games.rows) {
  const parsed = parseGameKey(g.game_key)
  if (!parsed) continue
  const gameStartIso = parsed.iso
  const winStartIso = new Date(Date.parse(gameStartIso) - PRE_GAME_HRS * 3600 * 1000).toISOString()

  // KS chains per pitcher (closest snapshot per strike before game)
  const sn = await db.execute(`
    SELECT pitcher_id, pitcher_name, strike, yes_bid, yes_ask, captured_at
    FROM market_snapshots
    WHERE ticker LIKE 'KXMLBKS-${g.game_key}-%'
      AND yes_bid IS NOT NULL AND yes_ask IS NOT NULL
      AND captured_at BETWEEN '${winStartIso}' AND '${gameStartIso}'
  `)
  const seen = new Map()
  for (const r of sn.rows) {
    const key = `${r.pitcher_id}|${r.strike}`
    if (!seen.has(key) || seen.get(key).captured_at < r.captured_at) {
      seen.set(key, { ...r, strike: Number(r.strike), yes_bid: Number(r.yes_bid), yes_ask: Number(r.yes_ask) })
    }
  }
  const byPitcher = new Map()
  for (const v of seen.values()) {
    if (!byPitcher.has(v.pitcher_id)) byPitcher.set(v.pitcher_id, { name: v.pitcher_name, ladder: [] })
    byPitcher.get(v.pitcher_id).ladder.push({
      strike: v.strike, yes_bid: v.yes_bid, yes_ask: v.yes_ask,
      market_mid: (v.yes_bid + v.yes_ask) / 2,
      ticker: `KS-${v.pitcher_id}-${v.strike}`,
    })
  }

  // TOTAL ladder
  const tot = await pullTotalLadder(g.game_key, gameStartIso)
  if (!tot || tot.ladder.length < 4 || tot.actualTotal == null) continue

  // ── A) Cross-Strike-Total ──────────────────────────────────────────────
  const totCands = generateCrossStrikeCandidates(tot.ladder)
  for (const c of totCands) {
    const won = c.side === 'YES' ? tot.actualTotal >= c.strike : tot.actualTotal < c.strike
    const ask = c.ask_cents
    const { stake, contracts } = sizeBet(ask)
    crossStrikeFires.push({
      game_date: parsed.date, game_key: g.game_key,
      strike: c.strike, side: c.side, ask, residual_c: Math.round(c.cross_strike_residual * 100),
      contracts, stake, actual: tot.actualTotal,
      won: won ? 1 : 0, pnl: pnl(c.side, ask, contracts, won),
      fit_lambda: c.cross_strike_fit_lambda,
    })
  }

  // ── B) Inverted-K (use TOTAL to derive expected pitcher K, compare to KS) ──
  // Step 1: fit total_lambda from TOTAL ladder
  const totFit = fitDistribution(
    tot.ladder.map(l => l.strike),
    tot.ladder.map(l => l.market_mid / 100),
    { lambdaMin: 3, lambdaMax: 18 },
  )
  const totalRunsLambda = totFit.lambda

  // Step 2: subtract bullpen, split equally between starters
  const bullpenRuns = BULLPEN_ERA * ((9 - STARTER_IP) * 2) / 9
  const starterRunsTotal = totalRunsLambda - bullpenRuns
  const perStarterRuns = starterRunsTotal / 2

  // Step 3: for each pitcher with KS chain, compute expected K λ from TOTAL
  for (const [pid, info] of byPitcher) {
    if (info.ladder.length < 4) continue
    // Each starter's predicted runs allowed → ERA → K9 → λ over assumed IP
    const era = perStarterRuns * 9 / STARTER_IP
    const k9 = eraToK9(era)
    const totalImpliedK = k9 * STARTER_IP / 9

    // Fit KS market λ
    const ksFit = fitDistribution(info.ladder.map(l => l.strike), info.ladder.map(l => l.market_mid / 100))
    const ksMarketK = ksFit.lambda

    const divergence = totalImpliedK - ksMarketK  // + = TOTAL says higher K than KS market
    const actK = actualKs.get(`${pid}|${parsed.date}`)
    if (actK == null) continue

    // Pick a strike to bet: the strike where market disagrees most with TOTAL implication
    // For YES (when TOTAL says higher): bet at a strike where KS market mid is LOW but TOTAL would price it higher
    // For NO (when TOTAL says lower): bet at a strike where KS market mid is HIGH but TOTAL would price it lower
    const side = divergence > 0 ? 'YES' : 'NO'
    let bestStrike = null, bestEdge = 0
    for (const lad of info.ladder) {
      const ksMid = lad.market_mid / 100
      const totMid = poissonGEqN(totalImpliedK, lad.strike)
      const edge = side === 'YES' ? (totMid - ksMid) : (ksMid - totMid)
      const ask = side === 'YES' ? lad.yes_ask : (100 - lad.yes_bid)
      if (ask < 5 || ask > 88) continue  // same ask filter as Cross-Strike
      if (edge > bestEdge) { bestEdge = edge; bestStrike = { ...lad, ask } }
    }
    if (!bestStrike) continue

    const won = side === 'YES' ? actK >= bestStrike.strike : actK < bestStrike.strike
    const { stake, contracts } = sizeBet(bestStrike.ask)
    invertedKFires.push({
      game_date: parsed.date, game_key: g.game_key, pitcher: info.name,
      side, strike: bestStrike.strike, ask: bestStrike.ask,
      divergence: Math.round(divergence * 100) / 100,
      total_implied_k: Math.round(totalImpliedK * 100) / 100,
      ks_market_k:  Math.round(ksMarketK * 100) / 100,
      best_edge_c: Math.round(bestEdge * 100),
      contracts, stake, actual_k: actK,
      won: won ? 1 : 0, pnl: pnl(side, bestStrike.ask, contracts, won),
    })
  }

  processed++
  if (processed % 10 === 0) console.log(`  [${processed}] ${g.game_key}  CS-Total: ${totCands.length} cands  Inv-K: ${byPitcher.size} pitchers`)
}

console.log(`\nProcessed ${processed} games\n`)

// 3) Reports
function summarize(fires, label) {
  const w = fires.filter(f => f.won).length
  const stake = fires.reduce((s,f) => s + f.stake, 0)
  const pnlT = fires.reduce((s,f) => s + f.pnl, 0)
  const winPct = fires.length ? (w/fires.length*100).toFixed(1) : 0
  const roi = stake ? (pnlT/stake*100).toFixed(1) : 0
  console.log(`═══ ${label} ═══`)
  console.log(`  fires=${fires.length}  W=${w}  L=${fires.length-w}  win%=${winPct}  staked=$${stake.toFixed(0)}  P&L=${pnlT >= 0 ? '+' : ''}$${pnlT.toFixed(0)}  ROI=${roi}%\n`)
}

summarize(crossStrikeFires, 'A) Cross-Strike-Total')

// CS-Total filter sweep
console.log('─── A) Cross-Strike-Total filter sweep ───')
const csTests = [
  ['baseline (all)',                   () => true],
  ['resid ≥ 6¢',                        f => Math.abs(f.residual_c) >= 6],
  ['ask ≤ 65¢',                         f => f.ask <= 65],
  ['ask ≤ 50¢',                         f => f.ask <= 50],
  ['NO side only',                      f => f.side === 'NO'],
  ['YES side only',                     f => f.side === 'YES'],
  ['ask ≤ 50 + resid ≥ 6',              f => f.ask <= 50 && Math.abs(f.residual_c) >= 6],
]
for (const [label, fn] of csTests) {
  const sub = crossStrikeFires.filter(fn)
  const w = sub.filter(f => f.won).length
  const stake = sub.reduce((s,f) => s + f.stake, 0)
  const pn = sub.reduce((s,f) => s + f.pnl, 0)
  console.log(`  ${label.padEnd(35)} n=${String(sub.length).padStart(4)}  win%=${(sub.length?w/sub.length*100:0).toFixed(0).padStart(3)}%  P&L=${pn >= 0 ? '+' : ''}$${pn.toFixed(0).padStart(5)}  ROI=${stake ? (pn/stake*100).toFixed(1) : 0}%`)
}

console.log()
summarize(invertedKFires, 'B) Inverted-K')

console.log('─── B) Inverted-K filter sweep ───')
const invTests = [
  ['baseline (all)',                       () => true],
  ['|div| ≥ 1.0 K',                         f => Math.abs(f.divergence) >= 1.0],
  ['|div| ≥ 1.5 K',                         f => Math.abs(f.divergence) >= 1.5],
  ['|div| ≥ 2.0 K',                         f => Math.abs(f.divergence) >= 2.0],
  ['edge ≥ 8¢',                             f => f.best_edge_c >= 8],
  ['edge ≥ 12¢',                            f => f.best_edge_c >= 12],
  ['ask ≤ 50¢',                             f => f.ask <= 50],
  ['YES side only',                         f => f.side === 'YES'],
  ['NO side only',                          f => f.side === 'NO'],
  ['edge ≥ 8 + ask ≤ 50',                   f => f.best_edge_c >= 8 && f.ask <= 50],
  ['|div|≥1.5 + edge≥10',                   f => Math.abs(f.divergence) >= 1.5 && f.best_edge_c >= 10],
]
for (const [label, fn] of invTests) {
  const sub = invertedKFires.filter(fn)
  const w = sub.filter(f => f.won).length
  const stake = sub.reduce((s,f) => s + f.stake, 0)
  const pn = sub.reduce((s,f) => s + f.pnl, 0)
  console.log(`  ${label.padEnd(35)} n=${String(sub.length).padStart(4)}  win%=${(sub.length?w/sub.length*100:0).toFixed(0).padStart(3)}%  P&L=${pn >= 0 ? '+' : ''}$${pn.toFixed(0).padStart(5)}  ROI=${stake ? (pn/stake*100).toFixed(1) : 0}%`)
}

// Sample big-edge fires
console.log('\n─── Sample biggest Inverted-K edges ───')
invertedKFires.sort((a,b) => b.best_edge_c - a.best_edge_c)
console.log('  date         pitcher                 side  K  ask  div   edge   actual_K  W/L')
for (const f of invertedKFires.slice(0, 15)) {
  console.log(`  ${f.game_date}  ${(f.pitcher ?? '').padEnd(22).slice(0,22)}  ${f.side.padEnd(3)}  ${String(f.strike).padStart(2)}  ${String(f.ask).padStart(3)}¢  ${(f.divergence>=0?'+':'') + f.divergence.toFixed(1).padStart(4)}  ${String(f.best_edge_c).padStart(3)}c   ${String(f.actual_k).padStart(2)}        ${f.won ? 'W' : 'L'}`)
}
