// scripts/live/liveMonitor.js — In-game live signal monitor + auto-trader
//
// Polls live box scores every POLL_INTERVAL seconds once games are underway.
// For each active pitcher, recalculates λ using current game state (Ks, IP,
// pitch count) and checks Kalshi for live prices. When a new in-game edge
// ≥ LIVE_EDGE_MIN is found, it bets (paper or real) sized by Kelly.
//
// Trading toggle: LIVE_TRADING=false in .env → paper trade only
//                 LIVE_TRADING=true          → place real Kalshi orders
//
// Daily loss limit: DAILY_LOSS_LIMIT (default $500) — stops all trading if hit.
//
// Usage:
//   node scripts/live/liveMonitor.js [--date YYYY-MM-DD] [--poll 180]
//
// Run after morning dailyRun.sh. Keeps running until all today's games finish.

import 'dotenv/config'
import axios from 'axios'
import * as db from '../../lib/db.js'
import { getAuthHeaders, placeOrder, getMarketPrice } from '../../lib/kalshi.js'
import { kellySizing, capitalAtRisk } from '../../lib/kelly.js'
import { notifyLiveBet, notifyCovered, notifyDead, notifyOneAway, notifyGameResult, notifyDailyReport } from '../../lib/discord.js'
import { NB_R, LEAGUE_K_PCT, LEAGUE_PA_PER_IP, nbCDF, pAtLeast, ipToDecimal } from '../../lib/strikeout-model.js'
import { parseArgs } from '../../lib/cli-args.js'

const opts     = parseArgs({
  date: { default: new Date().toISOString().slice(0, 10) },
  poll: { type: 'number', default: 180 },
})
const TODAY       = opts.date
const POLL_SEC    = opts.poll
const LIVE        = process.env.LIVE_TRADING === 'true'
const LIVE_EDGE   = Number(process.env.LIVE_EDGE_MIN || 0.08)
const LOSS_LIMIT  = Number(process.env.DAILY_LOSS_LIMIT || 500)

const MLB_BASE    = 'https://statsapi.mlb.com/api/v1'
const AVG_PITCHES_PER_IP = 17   // ~17 pitches per IP for starters

// ── Live λ recalculation ──────────────────────────────────────────────────────
//
// Given current game state, compute the conditional expected remaining Ks.
// P(K_total ≥ n | k_so_far, ip_so_far, pitches_so_far)
//   = P(K_remaining ≥ n - k_so_far) under NB(λ_remaining)
//
// λ_remaining = expected_remaining_BF × pK
// expected_remaining_BF derived from pitch count pace vs. avg total pitches.

function computeLiveModel(preGame, currentKs, currentIP, currentPitches) {
  const { pK_blended, avgPitches, avgBF } = preGame

  // Estimate remaining IP from pitch count
  const totalExpectedPitches = avgPitches || 90
  const pitchesLeft = Math.max(0, totalExpectedPitches - currentPitches)
  const remainingIP = pitchesLeft / AVG_PITCHES_PER_IP

  // Expected remaining BF
  const remainingBF = remainingIP * LEAGUE_PA_PER_IP

  // λ_remaining = remaining BF × K rate
  const lambdaRemaining = Math.max(0, remainingBF * pK_blended)

  return {
    lambdaRemaining,
    remainingIP,
    remainingBF,
    currentKs,
    pK_blended,
    // P(total ≥ n) = P(additional ≥ n - currentKs) for each threshold
    probAtLeast: (n) => {
      if (currentKs >= n) return 1.0  // already hit
      return pAtLeast(lambdaRemaining, n - currentKs)
    },
  }
}

// ── Kalshi live market fetch for KS markets ───────────────────────────────────

async function fetchLiveKsMarkets(ticker) {
  // ticker is like KXMLBKS-26APR202138TORLAA-TORDCEASE84
  // We want all K thresholds for this pitcher: KXMLBKS-26APR202138TORLAA-TORDCEASE84-{N}
  try {
    const eventTicker = ticker.split('-').slice(0, -1).join('-')  // strip threshold
    const path = `/markets?event_ticker=${eventTicker}&series_ticker=KXMLBKS&status=open&limit=20`
    const headers = getAuthHeaders('GET', `/trade-api/v2/markets`)
    const res = await axios.get(`https://api.elections.kalshi.com/trade-api/v2/markets`, {
      params: { event_ticker: eventTicker, series_ticker: 'KXMLBKS', status: 'open', limit: 20 },
      headers,
      timeout: 10000,
    })
    return res.data?.markets || []
  } catch { return [] }
}

// ── Daily loss guard ─────────────────────────────────────────────────────────

let _dailyLoss = 0

async function loadDailyLoss() {
  const rows = await db.all(
    `SELECT SUM(CASE WHEN pnl < 0 THEN ABS(pnl) ELSE 0 END) as losses
       FROM ks_bets WHERE bet_date = ? AND live_bet = 1`,
    [TODAY],
  )
  _dailyLoss = rows[0]?.losses || 0
  return _dailyLoss
}

// ── Place or paper-log a live bet ─────────────────────────────────────────────

const LIVE_USER_ID  = 284  // Adam-Live
const PAPER_USER_ID = 1    // Adam (paper)

async function executeBet({ pitcherName, pitcherId, game, strike, side, modelProb, marketMid, edge, ticker, betSize, kellyFraction, capitalRisk, preGameBetId }) {
  const paper  = !LIVE
  const userId = LIVE ? LIVE_USER_ID : PAPER_USER_ID
  const now    = new Date().toISOString()

  // DB-level dedup: skip if already logged this session (survives monitor restarts)
  const existing = await db.one(
    `SELECT id FROM ks_bets WHERE bet_date=? AND pitcher_name=? AND strike=? AND side=? AND live_bet=1 AND user_id=?`,
    [TODAY, pitcherName, strike, side, userId],
  )
  if (existing) return

  if (LIVE) {
    // Real order — Kalshi expects contracts (integer) and price (cents)
    const price = side === 'YES' ? Math.round(marketMid) : Math.round(100 - marketMid)
    const contracts = Math.max(1, Math.round(betSize))  // 1 contract = $1 face value
    try {
      await placeOrder(ticker, side.toLowerCase(), contracts, price)
      console.log(`  [LIVE ORDER] ${pitcherName} ${strike}+ ${side} ${contracts}c @ ${price}¢`)
    } catch (err) {
      console.error(`  [ORDER FAILED] ${pitcherName} ${strike}+ ${side}: ${err.message}`)
      return
    }
  } else {
    console.log(`  [PAPER] ${pitcherName} ${strike}+ Ks ${side} @ ${marketMid}¢  edge=${(edge*100).toFixed(1)}¢  size=$${betSize}  risk=$${capitalRisk.toFixed(2)}`)
  }

  await db.upsert('ks_bets', {
    bet_date:        TODAY,
    logged_at:       now,
    user_id:         userId,
    pitcher_id:      pitcherId || null,
    pitcher_name:    pitcherName,
    game,
    strike,
    side,
    model_prob:      modelProb,
    market_mid:      marketMid,
    edge,
    bet_size:        betSize,
    kelly_fraction:  kellyFraction,
    capital_at_risk: capitalRisk,
    paper:           paper ? 1 : 0,
    live_bet:        1,
    ticker,
  }, ['bet_date', 'pitcher_name', 'strike', 'side', 'live_bet', 'user_id'])
}

// ── Settle a finished game and post Discord summary ───────────────────────────

async function settleAndNotifyGame(game, boxData) {
  const gameLabel = `${game.team_away}@${game.team_home}`
  const now = new Date().toISOString()

  const openBets = await db.all(
    `SELECT * FROM ks_bets WHERE bet_date = ? AND game = ? AND result IS NULL`,
    [TODAY, gameLabel],
  )
  if (!openBets.length) return

  const settled = []
  for (const bet of openBets) {
    // Find actual Ks from box score
    let actualKs = null
    for (const side of ['home', 'away']) {
      const team = boxData.teams?.[side]
      if (!team) continue
      const pid = String(bet.pitcher_id)
      const player = team.players?.[`ID${pid}`]
      if (!player) continue
      const ks = player.stats?.pitching?.strikeOuts
      if (ks != null) { actualKs = Number(ks); break }
    }

    if (actualKs == null) continue

    const hit = actualKs >= bet.strike
    const won = bet.side === 'YES' ? hit : !hit
    const p   = bet.market_mid != null ? bet.market_mid / 100 : bet.model_prob
    const pnl = won ? bet.bet_size * (1 - p) : -bet.bet_size * p

    await db.run(
      `UPDATE ks_bets SET actual_ks=?, result=?, settled_at=?, pnl=? WHERE id=?`,
      [actualKs, won ? 'win' : 'loss', now, Math.round(pnl * 100) / 100, bet.id],
    )
    settled.push({ ...bet, actual_ks: actualKs, result: won ? 'win' : 'loss', pnl })
  }

  if (!settled.length) return

  const gamePnl = settled.reduce((s, b) => s + (b.pnl || 0), 0)
  console.log(`\n[live] ${gameLabel} settled: ${settled.filter(b => b.result === 'win').length}W/${settled.filter(b => b.result === 'loss').length}L  ${gamePnl >= 0 ? '+' : ''}$${gamePnl.toFixed(2)}`)

  await notifyGameResult({ game: gameLabel, bets: settled, gamePnl })
}

// ── End-of-day report ─────────────────────────────────────────────────────────

async function sendDailyReport() {
  const bets = await db.all(
    `SELECT * FROM ks_bets WHERE bet_date = ? ORDER BY result DESC, edge DESC`,
    [TODAY],
  )

  const settled  = bets.filter(b => b.result != null)
  const dayPnl   = settled.reduce((s, b) => s + (b.pnl || 0), 0)
  const wins     = settled.filter(b => b.result === 'win')

  // Season stats
  const season = await db.all(
    `SELECT SUM(pnl) as pnl, COUNT(*) as n,
            SUM(CASE WHEN result='win' THEN 1 ELSE 0 END) as w,
            SUM(bet_size) as wagered
       FROM ks_bets WHERE result IS NOT NULL`,
  )
  const sp = season[0] || {}

  await notifyDailyReport({
    date:        TODAY,
    bets:        settled,
    dayPnl,
    seasonPnl:   sp.pnl   || 0,
    seasonW:     sp.w     || 0,
    seasonL:     (sp.n || 0) - (sp.w || 0),
    totalWagered: sp.wagered || 0,
  })
}

// ── Main monitor loop ─────────────────────────────────────────────────────────

async function main() {
  await db.migrate()
  await loadDailyLoss()

  // Load today's pre-game bets as reference for pre-game λ data
  const preGameBets = await db.all(
    `SELECT DISTINCT pitcher_id, pitcher_name, game, lambda, opp_k_pct, adj_factor,
            k9_l5, k9_season, k9_career, n_starts, ticker
       FROM ks_bets
      WHERE bet_date = ? AND live_bet = 0`,
    [TODAY],
  )

  if (!preGameBets.length) {
    console.log(`[live] No pre-game bets found for ${TODAY} — run dailyRun.sh first`)
    await db.close()
    return
  }

  // Load recent starts for E[BF] and pitch count
  const recentStarts = await db.all(
    `SELECT pitcher_id, game_date, bf, ks, pitches, ip
       FROM pitcher_recent_starts WHERE season = ?
       ORDER BY pitcher_id, game_date DESC`,
    [new Date(TODAY).getFullYear()],
  )
  const startsByPitcher = new Map()
  for (const r of recentStarts) {
    const id = String(r.pitcher_id)
    if (!startsByPitcher.has(id)) startsByPitcher.set(id, [])
    if (startsByPitcher.get(id).length < 5) startsByPitcher.get(id).push(r)
  }

  // Build pre-game model context per pitcher
  const pitcherContext = new Map()
  for (const b of preGameBets) {
    if (pitcherContext.has(b.pitcher_id)) continue
    const starts = startsByPitcher.get(String(b.pitcher_id)) || []
    const pitchStarts = starts.filter(s => s.pitches > 0)
    const avgPitches = pitchStarts.length
      ? pitchStarts.reduce((s, r) => s + r.pitches, 0) / pitchStarts.length
      : 90

    // pK_blended from λ and avg BF
    const bfStarts = starts.filter(s => s.bf > 0)
    const avgBF = bfStarts.length
      ? bfStarts.reduce((s, r) => s + r.bf, 0) / bfStarts.length
      : 22
    const pK_blended = avgBF > 0 ? b.lambda / avgBF : LEAGUE_K_PCT

    pitcherContext.set(b.pitcher_id, {
      pitcherName: b.pitcher_name,
      game: b.game,
      lambda: b.lambda,
      pK_blended,
      avgPitches,
      avgBF,
      baseTicker: b.ticker ? b.ticker.split('-').slice(0, -1).join('-') : null,
    })
  }

  // Load today's game IDs
  const games = await db.all(
    `SELECT id, team_home, team_away, pitcher_home_id, pitcher_away_id, game_time
       FROM games WHERE date = ?`,
    [TODAY],
  )

  const allPitcherIds = new Set(preGameBets.map(b => b.pitcher_id).filter(Boolean))

  console.log(`[live] Monitoring ${allPitcherIds.size} pitchers across ${games.length} games`)
  console.log(`[live] Mode: ${LIVE ? '🔴 LIVE TRADING' : '📄 PAPER TRADING'} | Min edge: ${(LIVE_EDGE*100).toFixed(0)}¢ | Daily loss limit: $${LOSS_LIMIT}`)
  console.log(`[live] Polling every ${POLL_SEC}s. Ctrl+C to stop.\n`)

  // Track which in-game bets we've already placed this session (avoid dups)
  const placed = new Set()
  // Track cover/dead/one-away alerts already sent
  const covered = new Set()
  const dead    = new Set()
  const oneAway = new Set()
  // Track which games have been settled + Discord'd
  const settledGames = new Set()

  let iteration = 0
  while (true) {
    iteration++
    const now = new Date().toISOString().slice(11, 16)
    process.stdout.write(`\r[live] ${now} UTC | poll #${iteration} | daily loss: $${_dailyLoss.toFixed(0)}/$${LOSS_LIMIT}  `)

    if (_dailyLoss >= LOSS_LIMIT) {
      console.log(`\n[live] Daily loss limit hit ($${_dailyLoss.toFixed(0)}). Stopping.`)
      break
    }

    let allDone = true

    for (const game of games) {
      try {
        // Get live box score
        const [lsRes, boxRes] = await Promise.all([
          axios.get(`${MLB_BASE}/game/${game.id}/linescore`, { timeout: 8000 }),
          axios.get(`${MLB_BASE}/game/${game.id}/boxscore`, { timeout: 8000 }),
        ])
        const state = lsRes.data.abstractGameState

        if (state === 'Preview') continue    // not started

        // ── Game just went Final — settle + Discord ───────────────────────────
        if (state === 'Final') {
          if (!settledGames.has(game.id)) {
            settledGames.add(game.id)
            await settleAndNotifyGame(game, boxRes.data)
          }
          continue
        }

        allDone = false  // at least one game still live

        // Check both starters
        for (const [side, pitcherId] of [
          ['away', game.pitcher_away_id],
          ['home', game.pitcher_home_id],
        ]) {
          if (!pitcherId || !allPitcherIds.has(pitcherId)) continue
          const ctx = pitcherContext.get(pitcherId)
          if (!ctx) continue

          const team    = boxRes.data.teams[side]
          const player  = team.players?.[`ID${pitcherId}`]
          if (!player) continue

          const currentKs      = Number(player.stats?.pitching?.strikeOuts || 0)
          const currentIPraw   = player.stats?.pitching?.inningsPitched || '0.0'
          const currentIP      = ipToDecimal(currentIPraw)
          const currentPitches = Number(player.stats?.pitching?.numberOfPitches || 0)
          const isCurrent      = player.gameStatus?.isCurrentPitcher

          // ── Cover / dead detection for pre-game bets ───────────────────────
          const openBets = await db.all(
            `SELECT * FROM ks_bets WHERE bet_date = ? AND pitcher_id = ? AND result IS NULL`,
            [TODAY, String(pitcherId)],
          )

          for (const bet of openBets) {
            const key = `${bet.id}`

            // One away: YES bet needs exactly 1 more K (still pitching)
            if (bet.side === 'YES' && isCurrent && currentKs === bet.strike - 1 && !oneAway.has(key) && !covered.has(key)) {
              oneAway.add(key)
              const pnl = bet.bet_size * (1 - (bet.market_mid ?? 50) / 100)
              console.log(`\n[live] 🔥 ONE AWAY ${ctx.pitcherName} ${bet.strike}+ (${currentKs}K)`)
              await notifyOneAway({ pitcherName: ctx.pitcherName, strike: bet.strike, pnl, currentKs, game: ctx.game })
            }

            // Cover: pitcher already has enough Ks
            if (bet.side === 'YES' && currentKs >= bet.strike && !covered.has(key)) {
              covered.add(key)
              const pnl = bet.bet_size * (1 - (bet.market_mid ?? 50) / 100)
              console.log(`\n[live] ✅ COVERED ${ctx.pitcherName} ${bet.strike}+ (${currentKs}K)`)
              await notifyCovered({ pitcherName: ctx.pitcherName, strike: bet.strike, side: bet.side, pnl, currentKs, game: ctx.game })
            }

            // Dead: YES bet, starter pulled and can't reach threshold
            if (bet.side === 'YES' && !isCurrent && currentKs < bet.strike && currentIP >= 1 && !dead.has(key)) {
              dead.add(key)
              const pnl = -bet.bet_size * ((bet.market_mid ?? 50) / 100)
              console.log(`\n[live] ❌ DEAD ${ctx.pitcherName} pulled at ${currentKs}K (needed ${bet.strike}+)`)
              await notifyDead({ pitcherName: ctx.pitcherName, strike: bet.strike, side: bet.side, pnl, currentKs, currentIPraw, game: ctx.game, reason: 'starter pulled' })
            }

            // Dead: NO bet, pitcher already at or past threshold
            if (bet.side === 'NO' && currentKs >= bet.strike && !dead.has(key)) {
              dead.add(key)
              const pnl = -bet.bet_size * (1 - (bet.market_mid ?? 50) / 100)
              console.log(`\n[live] ❌ DEAD (NO) ${ctx.pitcherName} hit ${currentKs}K (needed under ${bet.strike})`)
              await notifyDead({ pitcherName: ctx.pitcherName, strike: bet.strike, side: bet.side, pnl, currentKs, currentIPraw, game: ctx.game, reason: `hit ${currentKs}K` })
            }
          }

          if (currentIP < 1) continue  // wait for 1+ IP before live model

          const live = computeLiveModel(ctx, currentKs, currentIP, currentPitches)

          // Fetch current Kalshi prices for this pitcher's markets
          if (!ctx.baseTicker) continue
          const markets = await fetchLiveKsMarkets(ctx.baseTicker)
          if (!markets.length) continue

          for (const mkt of markets) {
            // Parse threshold from ticker suffix
            const parts = mkt.ticker.split('-')
            const n = parseInt(parts[parts.length - 1])
            if (!Number.isInteger(n) || n < 2 || n > 15) continue

            const modelProb = live.probAtLeast(n)
            const midCents  = mkt.yes_bid != null && mkt.yes_ask != null
              ? (mkt.yes_bid + mkt.yes_ask) / 2
              : null
            if (midCents == null) continue

            const marketPrice = midCents / 100
            const edgeYES = modelProb - marketPrice
            const edgeNO  = (1 - modelProb) - (1 - marketPrice)
            const edge    = Math.max(edgeYES, edgeNO)
            const betSide = edgeYES >= edgeNO ? 'YES' : 'NO'

            if (edge < LIVE_EDGE) continue

            const betKey = `${pitcherId}-${n}-${betSide}-live`
            if (placed.has(betKey)) continue

            const { betSize, kellyFraction } = kellySizing(
              betSide === 'YES' ? modelProb : 1 - modelProb,
              betSide === 'YES' ? marketPrice : 1 - marketPrice,
              betSide,
            )
            if (betSize <= 0) continue

            const capitalRisk = capitalAtRisk(betSize, marketPrice, betSide)

            placed.add(betKey)
            console.log(`\n[live] EDGE ${ctx.game} ${ctx.pitcherName} ${n}+ Ks ${betSide}  model=${(modelProb*100).toFixed(1)}%  mid=${midCents.toFixed(0)}¢  edge=${(edge*100).toFixed(1)}¢  ${currentKs}K ${currentIPraw}IP ${currentPitches}p`)

            await executeBet({
              pitcherName:   ctx.pitcherName,
              pitcherId,
              game:          ctx.game,
              strike:        n,
              side:          betSide,
              modelProb:     betSide === 'YES' ? modelProb : 1 - modelProb,
              marketMid:     midCents,
              edge,
              ticker:        mkt.ticker,
              betSize,
              kellyFraction,
              capitalRisk,
            })

            await notifyLiveBet({
              pitcherName: ctx.pitcherName,
              strike: n,
              side: betSide,
              marketMid: midCents,
              edge,
              betSize,
              currentKs,
              currentIPraw,
              currentPitches,
              paper: !LIVE,
            })

            if (LIVE) _dailyLoss  // recheck after live order
          }
        }
      } catch { /* skip game on error */ }
    }

    if (allDone && iteration > 1) {
      console.log('\n[live] All games final. Monitor done.')
      await sendDailyReport()
      break
    }

    await new Promise(r => setTimeout(r, POLL_SEC * 1000))
  }

  await db.close()
}

main().catch(err => {
  console.error('[live] fatal:', err.message)
  process.exit(1)
})
