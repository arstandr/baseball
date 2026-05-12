// Cross-Strike-Total candidate registry. Same pattern as
// logCrossStrikeShadow.mjs but for KXMLBTOTAL ladders. Pulls each game's
// closing TOTAL ladder via candles, runs generateCrossStrikeCandidates,
// logs every candidate (would-fire or not) with outcome.
//
// Usage:
//   node scripts/logCrossStrikeTotalShadow.mjs                # backfill since 2026-04-28
//   node scripts/logCrossStrikeTotalShadow.mjs 2026-05-05     # specific date

import 'dotenv/config'
import { createClient } from '@libsql/client'
import { authedRequest } from '../lib/kalshi.js'
import {
  fitDistribution, findMispricedStrikes, generateCrossStrikeCandidates,
} from '../lib/crossStrikeCandidates.js'

const ARG_DATE = process.argv[2]
const FROM_DATE = '2026-04-28'
const PRE_GAME_HRS = 6
const REQUEST_DELAY_MS = 150

const BANKROLL = 1000
const PCT_CAP = 0.03
const TAIL_USD = 5
const TAIL_THRESH = 25
const FEE = 0.07
const MIN_BET = 1

const DEFAULT_MIN_RESID = 0.04
const DEFAULT_MAX_RESID = 0.20
const DEFAULT_MIN_ASK = 3
const DEFAULT_MAX_ASK = 88
const DEFAULT_PER_EVENT = 2

const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })

const MONTHS = { JAN:'01', FEB:'02', MAR:'03', APR:'04', MAY:'05', JUN:'06', JUL:'07', AUG:'08', SEP:'09', OCT:'10', NOV:'11', DEC:'12' }
function parseGameKey(k) {
  const m = /^(\d{2})([A-Z]{3})(\d{2})(\d{2})(\d{2})([A-Z]+)$/.exec(k)
  if (!m) return null
  return {
    iso: `20${m[1]}-${MONTHS[m[2]]}-${m[3]}T${m[4]}:${m[5]}:00.000Z`,
    date: `20${m[1]}-${MONTHS[m[2]]}-${m[3]}`,
    label: m[6],
  }
}

function sizeBet(askCents) {
  const baseUsd = Math.min(BANKROLL * PCT_CAP, askCents < TAIL_THRESH ? TAIL_USD : Infinity)
  const usd = Math.max(MIN_BET, baseUsd)
  const contracts = Math.max(1, Math.floor(usd / (askCents / 100)))
  return { stake: contracts * (askCents / 100), contracts }
}
function whyBlocked(c, perEventCount) {
  if (c.magnitude < DEFAULT_MIN_RESID) return 'resid_too_low'
  if (c.magnitude > DEFAULT_MAX_RESID) return 'resid_too_high_outlier'
  if (c.askCents == null) return 'no_ask'
  if (c.askCents < DEFAULT_MIN_ASK)  return 'ask_too_low'
  if (c.askCents > DEFAULT_MAX_ASK)  return 'ask_too_high_adverse'
  if (perEventCount >= DEFAULT_PER_EVENT) return 'per_event_cap'
  return null
}

// 1) Discover games with settled TOTAL markets
async function discoverGames() {
  const out = []
  let cursor = ''
  for (let p = 0; p < 50; p++) {
    const r = await authedRequest('GET', '/markets', null, { status: 'settled', limit: 500, series_ticker: 'KXMLBTOTAL', cursor }).catch(()=>null)
    const ms = r?.markets || []
    if (!ms.length) break
    for (const m of ms) {
      const ev = m.event_ticker || ''
      const gKey = ev.replace(/^KXMLBTOTAL-/, '')
      const parsed = parseGameKey(gKey)
      if (!parsed) continue
      if (ARG_DATE && parsed.date !== ARG_DATE) continue
      if (!ARG_DATE && parsed.date < FROM_DATE) continue
      out.push({ event_ticker: ev, gameKey: gKey, ...parsed, market: m })
    }
    cursor = r?.cursor || ''
    if (!cursor) break
  }
  // Group by event_ticker (one entry per game)
  const byGame = new Map()
  for (const o of out) {
    if (!byGame.has(o.event_ticker)) byGame.set(o.event_ticker, { ...o, markets: [] })
    byGame.get(o.event_ticker).markets.push(o.market)
  }
  return [...byGame.values()]
}

const games = await discoverGames()
console.log(`Found ${games.length} settled-TOTAL games for ${ARG_DATE ?? '>=' + FROM_DATE}`)
if (!games.length) process.exit(0)

const evaluatedAt = new Date().toISOString()
let written = 0, skipped = 0

for (const game of games) {
  const startSec = Math.floor(Date.parse(game.iso) / 1000)
  const ladder = []
  let actualTotal = null
  for (const m of game.markets) {
    actualTotal ??= m.expiration_value != null ? Number(m.expiration_value) : null
    const c = await authedRequest('GET', `/series/KXMLBTOTAL/markets/${m.ticker}/candlesticks`, null, {
      period_interval: 60,
      start_ts: startSec - PRE_GAME_HRS * 3600,
      end_ts: startSec,
    }).catch(()=>null)
    await new Promise(r => setTimeout(r, REQUEST_DELAY_MS))
    const cs = c?.candlesticks || []
    if (!cs.length) continue
    const last = cs[cs.length - 1]
    const yb = parseFloat(last?.yes_bid?.close_dollars ?? '0')
    const ya = parseFloat(last?.yes_ask?.close_dollars ?? '0')
    if (yb + ya === 0 || yb >= 0.99 || ya <= 0.01) continue
    const x = /Over\s+([\d.]+)/i.exec(m.yes_sub_title || '')
    if (!x) continue
    const strikeFloor = Math.ceil(parseFloat(x[1]))
    ladder.push({
      strike: strikeFloor,
      yes_bid: Math.round(yb * 100), yes_ask: Math.round(ya * 100),
      no_bid:  Math.round((1 - ya) * 100),
      no_ask:  Math.round((1 - yb) * 100),
      market_mid: ((yb + ya) / 2) * 100,
      ticker: m.ticker,
    })
  }
  ladder.sort((a, b) => a.strike - b.strike)
  if (ladder.length < 4) { skipped++; continue }

  // Fit Poisson over the ladder
  const strikes = ladder.map(l => l.strike)
  const probs   = ladder.map(l => l.market_mid / 100)
  const fit = fitDistribution(strikes, probs, { lambdaMin: 3, lambdaMax: 18 })

  // Find ALL mispricings
  const all = findMispricedStrikes(strikes, probs, fit, 0.01)
  const dataByStrike = new Map(ladder.map(l => [l.strike, l]))
  const enriched = all.map(c => {
    const md = dataByStrike.get(c.strike)
    const askCents = c.side === 'YES' ? md.yes_ask : md.no_ask
    return { ...c, askCents, md }
  }).filter(c => c.askCents != null)
  enriched.sort((a, b) => b.magnitude - a.magnitude)

  let perEventFires = 0
  for (const c of enriched) {
    const blocked = whyBlocked(c, perEventFires)
    const wouldFire = blocked == null ? 1 : 0
    if (wouldFire) perEventFires++

    let won = null, pnl = null
    if (actualTotal != null) {
      won = (c.side === 'YES' ? actualTotal >= c.strike : actualTotal < c.strike) ? 1 : 0
      const { contracts } = sizeBet(c.askCents)
      pnl = won ? contracts * ((100 - c.askCents) / 100) * (1 - FEE) : -contracts * (c.askCents / 100)
    }

    try {
      await db.execute({
        sql: `INSERT OR REPLACE INTO shadow_cross_strike_total (
          evaluated_at, bet_date, game_key, game_label, game_start_iso,
          n_strikes_in_chain, poisson_lambda, poisson_quality, poisson_sse,
          strike, side, residual_cents, market_prob, fit_prob,
          yes_bid, yes_ask, no_bid, no_ask, market_mid, ask_cents, ticker,
          would_fire_default, filter_reason,
          actual_total, won, pnl_at_default_size
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        args: [
          evaluatedAt, game.date, game.gameKey, game.label, game.iso,
          ladder.length, fit.lambda, fit.quality, fit.sse,
          c.strike, c.side,
          Math.round(c.residual * 1000) / 10, c.marketProb, c.fitProb,
          c.md.yes_bid, c.md.yes_ask, c.md.no_bid, c.md.no_ask,
          c.md.market_mid, c.askCents, c.md.ticker,
          wouldFire, blocked,
          actualTotal, won, pnl,
        ],
      })
      written++
    } catch (err) {
      if (!/UNIQUE/.test(err.message)) console.warn(`  insert err: ${err.message}`)
    }
  }
}

console.log(`\nWrote ${written} candidate rows  (skipped ${skipped} games with thin/missing ladders)`)

// Summary
const sum = await db.execute(`
  SELECT bet_date, COUNT(*) AS n, SUM(would_fire_default) AS would_fire,
         SUM(CASE WHEN actual_total IS NOT NULL THEN 1 ELSE 0 END) AS settled,
         SUM(CASE WHEN would_fire_default=1 AND won=1 THEN 1 ELSE 0 END) AS wins,
         ROUND(SUM(CASE WHEN would_fire_default=1 THEN pnl_at_default_size ELSE 0 END), 2) AS pnl
  FROM shadow_cross_strike_total
  ${ARG_DATE ? `WHERE bet_date = '${ARG_DATE}'` : `WHERE bet_date >= '${FROM_DATE}'`}
  GROUP BY bet_date ORDER BY bet_date
`)
console.log('\nshadow_cross_strike_total summary:')
console.log('date         candidates  would-fire  settled   wouldFire-W  P&L')
for (const r of sum.rows) {
  console.log(`  ${r.bet_date}  ${String(r.n).padStart(10)}  ${String(r.would_fire).padStart(10)}  ${String(r.settled).padStart(7)}  ${String(r.wins).padStart(11)}  ${(r.pnl >= 0 ? '+' : '') + (r.pnl ?? 0)}`)
}
