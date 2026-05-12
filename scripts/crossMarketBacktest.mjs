// Cross-market backtest: K↔TOTAL consistency.
//
// Hypothesis: pitcher K markets and game TOTAL markets are mathematically tied.
// Each pitcher's K rate implies an expected runs-allowed contribution. Sum
// across both starters + estimated bullpen → predicted_total_K. If this
// diverges materially from the TOTAL market's implied total, one is mispriced.
//
// Pipeline per game:
//   1. Pull both starters' K ladders from market_snapshots (we have these)
//   2. Fit Poisson λ to each → market-implied K rate for the start
//   3. Convert λ → expected runs allowed (ERA = 5.5 − 0.20·K9, runs = ERA·IP/9)
//   4. Add bullpen contribution (fixed 4.0 ERA, fills remaining 9 IP)
//   5. predicted_total_K = sum
//   6. Pull TOTAL ladder via /candlesticks at T-30 → fit total_λ
//   7. Compute divergence = predicted_total_K − market_total_λ
//   8. Resolve actual_total via settled TOTAL market expiration_value
//   9. Score: did divergence sign predict over/under correctly?

import 'dotenv/config'
import { createClient } from '@libsql/client'
import { authedRequest } from '../lib/kalshi.js'
import { fitDistribution, poissonGEqN } from '../lib/crossStrikeCandidates.js'

const FROM_DATE = '2026-04-28'
const TO_DATE   = '2026-05-05'
const PRE_GAME_WINDOW_HRS = 6
const STARTER_IP = 5.5    // assumed avg starter IP — could be model-driven later
const BULLPEN_ERA = 4.00
const REQUEST_DELAY_MS = 150

const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })

const MONTHS = { JAN:'01', FEB:'02', MAR:'03', APR:'04', MAY:'05', JUN:'06', JUL:'07', AUG:'08', SEP:'09', OCT:'10', NOV:'11', DEC:'12' }
function parseGameKey(gameKey) {
  // e.g., 26MAY051940CLEKC → 2026-05-05T19:40:00Z, teams CLE+KC
  const m = /^(\d{2})([A-Z]{3})(\d{2})(\d{2})(\d{2})/.exec(gameKey)
  if (!m) return null
  return {
    iso: `20${m[1]}-${MONTHS[m[2]]}-${m[3]}T${m[4]}:${m[5]}:00.000Z`,
    date: `20${m[1]}-${MONTHS[m[2]]}-${m[3]}`,
  }
}

// Empirical: K9 → ERA. Rough but defensible.
function k9ToEra(k9) { return Math.max(2.0, Math.min(7.5, 5.5 - 0.20 * k9)) }

// Build pitcher's expected runs allowed from K-market λ.
// Assumes starter IP and converts λ to K9 → ERA → runs.
function lambdaToRunsAllowed(lambda, ip = STARTER_IP) {
  const k9 = lambda / ip * 9
  const era = k9ToEra(k9)
  return era * ip / 9
}

// 1) Identify games with KS chains for at least one starter
const gameRows = await db.execute(`
  SELECT DISTINCT
    SUBSTR(ticker, INSTR(ticker, '-')+1,
      CASE WHEN INSTR(SUBSTR(ticker, INSTR(ticker, '-')+1), '-') > 0
           THEN INSTR(SUBSTR(ticker, INSTR(ticker, '-')+1), '-') - 1
           ELSE LENGTH(ticker) END) AS game_key,
    game_date
  FROM market_snapshots
  WHERE game_date BETWEEN '${FROM_DATE}' AND '${TO_DATE}'
    AND ticker LIKE 'KXMLBKS-%'
`)
console.log(`${gameRows.rows.length} candidate game-days`)

const candles_cache = new Map()
async function pullTotalLadder(gameKey, gameStartIso) {
  // Find settled TOTAL markets for this game and grab their candles closest to game start
  const ev = `KXMLBTOTAL-${gameKey}`
  const ms = await authedRequest('GET', '/markets', null, { status: 'settled', limit: 50, event_ticker: ev }).catch(()=>null)
  if (!ms?.markets?.length) return null
  const startSec = Math.floor(Date.parse(gameStartIso) / 1000)
  const ladder = []
  let actualTotal = null
  for (const m of ms.markets) {
    actualTotal ??= m.expiration_value != null ? Number(m.expiration_value) : null
    const cKey = m.ticker
    let candles
    if (candles_cache.has(cKey)) candles = candles_cache.get(cKey)
    else {
      const c = await authedRequest('GET', `/series/KXMLBTOTAL/markets/${m.ticker}/candlesticks`, null, {
        period_interval: 60,
        start_ts: startSec - PRE_GAME_WINDOW_HRS * 3600,
        end_ts: startSec,
      }).catch(()=>null)
      candles = c?.candlesticks || []
      candles_cache.set(cKey, candles)
      await new Promise(r => setTimeout(r, REQUEST_DELAY_MS))
    }
    if (candles.length === 0) continue
    const last = candles[candles.length - 1]
    const yb = parseFloat(last?.yes_bid?.close_dollars ?? '0')
    const ya = parseFloat(last?.yes_ask?.close_dollars ?? '0')
    if (yb + ya === 0 || yb >= 0.99 || ya <= 0.01) continue
    const mid = (yb + ya) / 2
    // Strike "Over X.5" — extract from yes_sub_title
    const xMatch = /Over\s+([\d.]+)/i.exec(m.yes_sub_title || '')
    if (!xMatch) continue
    const strikeOver = parseFloat(xMatch[1])  // e.g., 8.5
    ladder.push({
      strike_floor: Math.ceil(strikeOver),  // P(T ≥ ceil(8.5)) = P(T ≥ 9) for "Over 8.5"
      mid,
      yes_bid: yb, yes_ask: ya,
    })
  }
  ladder.sort((a, b) => a.strike_floor - b.strike_floor)
  return { ladder, actualTotal }
}

// 2) For each game, build the analysis
const results = []
let processedGames = 0

for (const g of gameRows.rows) {
  const gameKey = g.game_key
  const parsed = parseGameKey(gameKey)
  if (!parsed) continue
  const gameStartIso = parsed.iso
  const winStartIso  = new Date(Date.parse(gameStartIso) - PRE_GAME_WINDOW_HRS * 3600 * 1000).toISOString()

  // Get pitchers for this game (latest snapshot per pitcher per strike near game start)
  const sn = await db.execute(`
    SELECT pitcher_id, pitcher_name, strike, yes_bid, yes_ask, captured_at
    FROM market_snapshots
    WHERE ticker LIKE 'KXMLBKS-${gameKey}-%'
      AND yes_bid IS NOT NULL AND yes_ask IS NOT NULL
      AND captured_at BETWEEN '${winStartIso}' AND '${gameStartIso}'
  `)
  const pitcherChains = new Map()
  for (const r of sn.rows) {
    const key = `${r.pitcher_id}|${r.strike}`
    const cur = pitcherChains.get(key)
    if (!cur || cur.captured_at < r.captured_at) {
      pitcherChains.set(key, { ...r, strike: Number(r.strike), yes_bid: Number(r.yes_bid), yes_ask: Number(r.yes_ask) })
    }
  }
  const byPitcher = new Map()
  for (const v of pitcherChains.values()) {
    const id = v.pitcher_id
    if (!byPitcher.has(id)) byPitcher.set(id, { name: v.pitcher_name, ladder: [] })
    // KS yes_bid/yes_ask are stored in cents (0-100) → probability is /100
    byPitcher.get(id).ladder.push({ strike: v.strike, mid: (v.yes_bid + v.yes_ask) / 200 })
  }

  // Fit Poisson λ for each pitcher
  const pitcherLambdas = []
  for (const [pid, info] of byPitcher) {
    if (info.ladder.length < 4) continue
    const strikes = info.ladder.map(l => l.strike)
    const probs = info.ladder.map(l => l.mid)
    const fit = fitDistribution(strikes, probs)
    pitcherLambdas.push({ pid, name: info.name, lambda: fit.lambda, n: info.ladder.length, quality: fit.quality })
  }
  if (pitcherLambdas.length === 0) continue

  // Pull TOTAL ladder + actual
  const tot = await pullTotalLadder(gameKey, gameStartIso)
  if (!tot || tot.ladder.length < 4) continue

  // Fit Poisson to TOTAL ladder (treat as P(T ≥ k) chain)
  const totFit = fitDistribution(
    tot.ladder.map(l => l.strike_floor),
    tot.ladder.map(l => l.mid),
    { lambdaMin: 3, lambdaMax: 18 },
  )
  const marketTotalLambda = totFit.lambda

  // Predicted total from K markets:
  //   Sum each known starter's runs allowed estimate + bullpen for the rest
  let predicted = 0
  for (const p of pitcherLambdas) {
    predicted += lambdaToRunsAllowed(p.lambda, STARTER_IP)
  }
  // If only one starter known, double-count to estimate the other (rough!)
  if (pitcherLambdas.length === 1) predicted *= 2
  // Bullpen contribution: 9 IP - STARTER_IP per side (assumes starters go STARTER_IP each)
  const bullpenIp = (9 - STARTER_IP) * 2
  predicted += BULLPEN_ERA * bullpenIp / 9

  const divergence = predicted - marketTotalLambda
  const actualTotal = tot.actualTotal
  if (actualTotal == null) continue

  // Did predicted-K beat market in MAE?
  const k_mae = Math.abs(predicted - actualTotal)
  const m_mae = Math.abs(marketTotalLambda - actualTotal)
  const k_better = k_mae < m_mae ? 1 : 0

  // Implied bet sides:
  //   divergence > 0: K-side says runs higher than TOTAL says
  //     → if K-side correct: actual > market → bet TOTAL OVER
  //   divergence < 0: K-side says runs lower than TOTAL says
  //     → if K-side correct: actual < market → bet TOTAL UNDER
  // Score: did K-side direction agree with actual?
  const k_predicted_over = predicted > marketTotalLambda
  const actual_over_market = actualTotal > marketTotalLambda
  const direction_correct = k_predicted_over === actual_over_market ? 1 : 0

  results.push({
    game_date: parsed.date, game_key: gameKey,
    pitchers: pitcherLambdas.map(p => `${p.name}(λ=${p.lambda.toFixed(1)})`).join(' / '),
    n_pitchers: pitcherLambdas.length,
    predicted_K: Math.round(predicted * 100) / 100,
    market_total: Math.round(marketTotalLambda * 100) / 100,
    divergence: Math.round(divergence * 100) / 100,
    actual_total: actualTotal,
    k_mae: Math.round(k_mae * 100) / 100,
    m_mae: Math.round(m_mae * 100) / 100,
    k_better,
    direction_correct,
  })
  processedGames++
  if (processedGames % 10 === 0) console.log(`  [${processedGames}] processed ${gameKey} | div=${divergence.toFixed(2)} pred=${predicted.toFixed(1)} mkt=${marketTotalLambda.toFixed(1)} actual=${actualTotal}`)
}

console.log(`\nProcessed ${results.length} games\n`)

// 3) Report
const meanK_mae = results.reduce((s,r)=>s+r.k_mae, 0) / results.length
const meanM_mae = results.reduce((s,r)=>s+r.m_mae, 0) / results.length
const k_better_count = results.filter(r => r.k_better).length
const dir_correct = results.filter(r => r.direction_correct).length

console.log('═══ Aggregate accuracy ═══')
console.log(`  K-prediction MAE:    ${meanK_mae.toFixed(2)} runs`)
console.log(`  Market total MAE:    ${meanM_mae.toFixed(2)} runs`)
console.log(`  K-side beats market: ${k_better_count}/${results.length} = ${(k_better_count/results.length*100).toFixed(1)}%`)
console.log(`  Direction correct:   ${dir_correct}/${results.length} = ${(dir_correct/results.length*100).toFixed(1)}%`)

console.log('\n═══ By divergence magnitude (does big divergence → better signal?) ═══')
const buckets = [
  ['|div| < 0.5',   r => Math.abs(r.divergence) < 0.5],
  ['0.5–1.0',        r => Math.abs(r.divergence) >= 0.5 && Math.abs(r.divergence) < 1.0],
  ['1.0–1.5',        r => Math.abs(r.divergence) >= 1.0 && Math.abs(r.divergence) < 1.5],
  ['1.5–2.0',        r => Math.abs(r.divergence) >= 1.5 && Math.abs(r.divergence) < 2.0],
  ['≥ 2.0',          r => Math.abs(r.divergence) >= 2.0],
]
console.log('  bucket          n   dir_correct  K_better  avg_actual_vs_market')
for (const [label, fn] of buckets) {
  const sub = results.filter(fn)
  if (!sub.length) { console.log(`  ${label.padEnd(15)} 0`); continue }
  const dc = sub.filter(r => r.direction_correct).length
  const kb = sub.filter(r => r.k_better).length
  const avgActMinusMkt = sub.reduce((s,r)=> s + (r.actual_total - r.market_total), 0) / sub.length
  console.log(`  ${label.padEnd(15)} ${String(sub.length).padStart(3)}   ${(dc/sub.length*100).toFixed(0)}%`.padEnd(45) + `  ${(kb/sub.length*100).toFixed(0)}%      avg(actual−market)=${avgActMinusMkt >= 0 ? '+' : ''}${avgActMinusMkt.toFixed(2)}`)
}

console.log('\n═══ Sample game detail ═══')
results.sort((a, b) => Math.abs(b.divergence) - Math.abs(a.divergence))
console.log('  date         game             pitchers                                    pred  mkt   div    actual  dir')
for (const r of results.slice(0, 25)) {
  console.log(`  ${r.game_date}  ${r.game_key.padEnd(16)}  ${r.pitchers.slice(0,40).padEnd(40)}  ${r.predicted_K.toFixed(2).padStart(5)}  ${r.market_total.toFixed(2).padStart(5)}  ${r.divergence >= 0 ? '+' : ''}${r.divergence.toFixed(2).padStart(5)}  ${String(r.actual_total).padStart(2)}     ${r.direction_correct ? '✓' : '✗'}`)
}
