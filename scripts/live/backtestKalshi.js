// scripts/live/backtestKalshi.js — Real-price Kalshi P&L backtest
//
// Two modes:
//
//   --cache   Snapshot current Kalshi KXMLBKS market prices into kalshi_ks_markets.
//             Run this alongside strikeoutEdge.js each morning to build history.
//             Prices stored: yes_ask, yes_bid, no_ask, no_bid, mid, spread.
//
//   --settle  Match settled ks_bets rows against kalshi_ks_markets cache and
//             backfill actual_ks + result. Run after ksBets.js settles.
//
//   --report  Show P&L simulation from $5,000 starting bankroll using only
//             real cached Kalshi prices (not naive market proxy).
//             Reports bankroll curve, monthly breakdown, win rate, drawdown.
//
//   --all     Run --cache, then --settle, then --report.
//
// Usage:
//   node scripts/live/backtestKalshi.js [--date YYYY-MM-DD] [--cache] [--settle] [--report] [--all]
//
// Data collection cadence:
//   Morning (before games): run --cache to lock in open prices
//   Evening (after settle): run --settle to record outcomes
//   Weekly: run --report to see P&L curve
//
// Look-ahead safety: market prices are captured at run time, before games start.
// No future prices or outcomes are ever back-populated into the open price fields.

import 'dotenv/config'
import axios from 'axios'
import * as db from '../../lib/db.js'
import { getAuthHeaders } from '../../lib/kalshi.js'

const args    = process.argv.slice(2)
const dateArg = args.includes('--date') ? args[args.indexOf('--date') + 1] : null
const TODAY   = dateArg || new Date().toISOString().slice(0, 10)

const DO_CACHE  = args.includes('--cache')  || args.includes('--all')
const DO_SETTLE = args.includes('--settle') || args.includes('--all')
const DO_REPORT = args.includes('--report') || args.includes('--all')

const KALSHI_BASE = 'https://api.elections.kalshi.com/trade-api/v2'
const STARTING_BANKROLL = 5000
const KELLY_MULT   = 0.25
const MAX_BET_PCT  = 0.05
const MIN_BET      = 25
const EDGE_THRESH  = 0.05   // primary threshold
const EDGE_HI      = 0.10   // conservative threshold (second simulation)

// ── Cache: snapshot current open prices ──────────────────────────────────────

async function runCache() {
  console.log(`[ks-cache] Snapshotting Kalshi KXMLBKS prices for ${TODAY}…`)

  // Fetch all open KXMLBKS markets for today
  const headers = getAuthHeaders('GET', '/trade-api/v2/markets')
  let markets = []
  let cursor = ''
  while (true) {
    const params = { series_ticker: 'KXMLBKS', limit: 200 }
    if (cursor) params.cursor = cursor
    try {
      const res = await axios.get(`${KALSHI_BASE}/markets`, {
        params, headers, timeout: 15000, validateStatus: s => s < 500,
      })
      if (res.status >= 400) break
      const page = res.data?.markets || []
      markets.push(...page)
      cursor = res.data?.cursor
      if (!cursor || !page.length) break
    } catch { break }
  }

  // Filter to today's games (close_time within today-tomorrow window)
  const todayMs  = new Date(TODAY).getTime()
  const todayEnd = todayMs + 2 * 24 * 60 * 60 * 1000
  const todayMkts = markets.filter(m => {
    const t = m.close_time ? new Date(m.close_time).getTime() : 0
    return t >= todayMs && t < todayEnd
  })

  console.log(`[ks-cache] ${markets.length} total KXMLBKS markets → ${todayMkts.length} for ${TODAY}`)

  const parseCents = v => {
    if (v == null) return null
    const n = typeof v === 'string' ? parseFloat(v) : v
    return Number.isFinite(n) ? Math.round(n * 100) : null
  }

  let stored = 0, skipped = 0
  for (const m of todayMkts) {
    const titleMatch = m.title?.match(/^(.+?):\s*(\d+)\+ strikeouts?/i)
    if (!titleMatch) continue
    const pitcherName = titleMatch[1].trim()
    const strike      = parseInt(titleMatch[2], 10)

    const yes_ask = parseCents(m.yes_ask_dollars)
    const yes_bid = parseCents(m.yes_bid_dollars)
    const no_ask  = parseCents(m.no_ask_dollars)
    const no_bid  = parseCents(m.no_bid_dollars)
    const mid     = yes_ask != null && yes_bid != null ? (yes_ask + yes_bid) / 2 : null
    const spread  = yes_ask != null && yes_bid != null ? yes_ask - yes_bid : null
    const volume  = m.volume_fp != null ? Number(m.volume_fp) : null

    try {
      await db.run(
        `INSERT INTO kalshi_ks_markets
           (ticker, game_date, pitcher_name, strike, yes_ask, yes_bid, no_ask, no_bid, mid, spread, volume)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(ticker) DO NOTHING`,
        [m.ticker, TODAY, pitcherName, strike, yes_ask, yes_bid, no_ask, no_bid, mid, spread, volume],
      )
      stored++
    } catch { skipped++ }
  }

  console.log(`[ks-cache] Stored ${stored} new price snapshots, ${skipped} already cached`)

  // Backfill model_prob + model_lambda from ks_bets where tickers match
  const backfilled = await db.run(
    `UPDATE kalshi_ks_markets
        SET model_prob   = (SELECT b.model_prob FROM ks_bets b WHERE b.ticker = kalshi_ks_markets.ticker AND b.bet_date = kalshi_ks_markets.game_date LIMIT 1),
            model_lambda = (SELECT b.lambda     FROM ks_bets b WHERE b.ticker = kalshi_ks_markets.ticker AND b.bet_date = kalshi_ks_markets.game_date LIMIT 1)
      WHERE game_date = ? AND model_prob IS NULL`,
    [TODAY],
  )
  console.log(`[ks-cache] Backfilled model_prob for ${backfilled.rowsAffected ?? '?'} markets`)
}

// ── Settle: backfill outcomes from ks_bets ────────────────────────────────────

async function runSettle() {
  console.log('[ks-settle] Backfilling results from ks_bets…')

  // Get all settled ks_bets that have a ticker match in our cache
  const settled = await db.all(
    `SELECT b.ticker, b.actual_ks, b.result, b.pnl, b.settled_at
       FROM ks_bets b
       JOIN kalshi_ks_markets k ON k.ticker = b.ticker
      WHERE b.result IS NOT NULL AND k.result IS NULL`,
  )

  let updated = 0
  for (const row of settled) {
    const result = row.result === 'win' ? 1 : 0
    await db.run(
      `UPDATE kalshi_ks_markets
          SET result = ?, actual_ks = ?, settled_at = ?
        WHERE ticker = ?`,
      [result, row.actual_ks, row.settled_at, row.ticker],
    )
    updated++
  }

  console.log(`[ks-settle] Updated ${updated} market records with outcomes`)
  console.log(`[ks-settle] Total settled in cache: ${(await db.one('SELECT COUNT(*) as n FROM kalshi_ks_markets WHERE result IS NOT NULL'))?.n || 0}`)
}

// ── Report: bankroll simulation using real prices ─────────────────────────────

async function runReport() {
  const rows = await db.all(
    `SELECT k.game_date, k.pitcher_name, k.strike, k.mid, k.spread,
            COALESCE(k.model_prob, b.model_prob)     AS model_prob,
            COALESCE(k.model_lambda, b.lambda)       AS model_lambda,
            k.result,
            b.side, b.edge, b.pnl as actual_pnl, b.bet_size
       FROM kalshi_ks_markets k
       LEFT JOIN ks_bets b ON b.ticker = k.ticker AND b.live_bet = 0
      WHERE k.result IS NOT NULL AND k.mid IS NOT NULL
      ORDER BY k.game_date, k.pitcher_name, k.strike`,
  )

  if (!rows.length) {
    console.log('[ks-report] No settled real-price data yet. Run --cache daily and --settle after games.')
    console.log(`            Currently have ${(await db.one('SELECT COUNT(*) as n FROM kalshi_ks_markets'))?.n || 0} cached markets total.`)
    return
  }

  console.log(`\n══ REAL-PRICE BANKROLL SIMULATION ($${STARTING_BANKROLL.toLocaleString()} start) ══`)
  console.log(`   ${rows.length} settled markets with real Kalshi prices\n`)

  // Group by date for day-by-day processing
  const byDate = new Map()
  for (const r of rows) {
    if (!byDate.has(r.game_date)) byDate.set(r.game_date, [])
    byDate.get(r.game_date).push(r)
  }

  // Simulate two bankrolls: 5¢+ edge and 10¢+ edge
  for (const [label, minEdge] of [[`${(EDGE_THRESH*100).toFixed(0)}¢+ edge`, EDGE_THRESH], [`${(EDGE_HI*100).toFixed(0)}¢+ edge`, EDGE_HI]]) {
    let bankroll  = STARTING_BANKROLL
    let peak      = bankroll
    let maxDD     = 0
    let totalBets = 0, totalWins = 0
    let totalWagered = 0
    let bestDay = null, worstDay = null
    const monthly = new Map()

    for (const [date, dayRows] of [...byDate.entries()].sort()) {
      // For each pitcher on this date, apply correlated Kelly
      const pitcherGroups = new Map()
      for (const r of dayRows) {
        if (r.model_prob == null || r.mid == null) continue
        if (r.mid < 5 || r.mid > 95) continue   // skip pre-resolved markets
        const marketFrac = r.mid / 100
        const side = r.model_prob > marketFrac ? 'YES' : 'NO'
        const edgeVal = side === 'YES'
          ? r.model_prob - marketFrac
          : (1 - r.model_prob) - (1 - marketFrac)
        if (edgeVal < minEdge) continue

        const key = `${date}-${r.pitcher_name}`
        if (!pitcherGroups.has(key)) pitcherGroups.set(key, [])
        pitcherGroups.get(key).push({ ...r, side, edgeVal, marketFrac })
      }

      let dayPnl = 0
      for (const [, bets] of pitcherGroups.entries()) {
        // Correlated Kelly: max exposure = single max Kelly unit
        const kellyFracs = bets.map(b => {
          const price = b.side === 'YES' ? b.marketFrac : 1 - b.marketFrac
          const f = price > 0 && price < 1 ? (b.edgeVal / (1 - price)) * KELLY_MULT : 0
          return Math.min(0.10, Math.max(0, f))  // hard cap at 10% of bankroll per bet
        })
        const maxKelly = Math.max(...kellyFracs)
        const totalKelly = kellyFracs.reduce((s, v) => s + v, 0)
        const scale = totalKelly > 0 ? maxKelly / totalKelly : 1

        for (let i = 0; i < bets.length; i++) {
          const b = bets[i]
          const adjFrac = kellyFracs[i] * scale
          const betSize = Math.min(
            bankroll * MAX_BET_PCT,
            Math.max(MIN_BET, adjFrac * bankroll),
          )
          const price = b.side === 'YES' ? b.marketFrac : 1 - b.marketFrac
          const won   = b.side === 'YES' ? b.result === 1 : b.result === 0
          const pnl   = won ? betSize * (1 - price) / price : -betSize

          dayPnl    += pnl
          bankroll  += pnl
          totalBets++
          totalWagered += betSize
          if (won) totalWins++
        }
      }

      if (dayPnl !== 0) {
        const mo = date.slice(0, 7)
        monthly.set(mo, (monthly.get(mo) || 0) + dayPnl)
        if (!bestDay || dayPnl > bestDay.pnl) bestDay = { date, pnl: dayPnl }
        if (!worstDay || dayPnl < worstDay.pnl) worstDay = { date, pnl: dayPnl }
      }

      if (bankroll > peak) peak = bankroll
      const dd = (peak - bankroll) / peak
      if (dd > maxDD) maxDD = dd
    }

    const roi = ((bankroll - STARTING_BANKROLL) / STARTING_BANKROLL * 100)
    const wr  = totalBets ? (totalWins / totalBets * 100) : 0
    const evPerBet = totalBets ? (bankroll - STARTING_BANKROLL) / totalBets : 0

    console.log(`── ${label} ──────────────────────────────────────`)
    console.log(`  Start: $${STARTING_BANKROLL.toLocaleString()} → End: $${bankroll.toFixed(0)} (${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%)`)
    console.log(`  Peak: $${peak.toFixed(0)} | Max drawdown: ${(maxDD*100).toFixed(1)}%`)
    console.log(`  Bets: ${totalBets} | Win rate: ${wr.toFixed(1)}% | EV/bet: $${evPerBet.toFixed(2)}`)
    if (bestDay)  console.log(`  Best day: ${bestDay.date} +$${bestDay.pnl.toFixed(0)}`)
    if (worstDay) console.log(`  Worst day: ${worstDay.date} $${worstDay.pnl.toFixed(0)}`)

    if (monthly.size) {
      console.log('\n  Monthly:')
      for (const [mo, pnl] of [...monthly.entries()].sort()) {
        console.log(`    ${mo}: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(0)}`)
      }
    }
    console.log()
  }

  // Data coverage summary
  const dates = [...byDate.keys()].sort()
  console.log(`══ DATA COVERAGE ══`)
  console.log(`  ${dates.length} game-days: ${dates[0]} → ${dates[dates.length - 1]}`)
  console.log(`  Total cached markets: ${(await db.one('SELECT COUNT(*) as n FROM kalshi_ks_markets'))?.n || 0}`)
  console.log(`  Settled: ${rows.length} | Unsettled: ${(await db.one('SELECT COUNT(*) as n FROM kalshi_ks_markets WHERE result IS NULL'))?.n || 0}`)
  console.log('\n  NOTE: Real Kalshi prices used throughout — no naive market proxy.')
  console.log(`  Once we have 30+ game-days this becomes a statistically meaningful backtest.`)
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!DO_CACHE && !DO_SETTLE && !DO_REPORT) {
    console.log('Usage: node backtestKalshi.js [--cache] [--settle] [--report] [--all] [--date YYYY-MM-DD]')
    console.log('  --cache   Snapshot today\'s open Kalshi prices into DB')
    console.log('  --settle  Backfill outcomes from settled ks_bets')
    console.log('  --report  Run P&L simulation from real cached prices')
    console.log('  --all     Run all three steps')
    process.exit(0)
  }

  await db.migrate()
  if (DO_CACHE)  await runCache()
  if (DO_SETTLE) await runSettle()
  if (DO_REPORT) await runReport()
  await db.close()
}

main().catch(err => {
  console.error('[backtestKalshi] fatal:', err.message)
  process.exit(1)
})
