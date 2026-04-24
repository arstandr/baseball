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
import { getAuthHeaders, placeOrder, cancelOrder, cancelAllOrders, getOrder, getMarketPrice, getSettlements, getBalance as getKalshiBalance, getQueuePosition, amendOrder, getOrderbook, availableDepth } from '../../lib/kalshi.js'
import { kellySizing, capitalAtRisk, correlatedKellyDivide } from '../../lib/kelly.js'
import { notifyLiveBet, notifyCovered, notifyDead, notifyOneAway, notifyGameResult, notifyDailyReport, getAllWebhooks } from '../../lib/discord.js'
import { NB_R, LEAGUE_K_PCT, LEAGUE_PA_PER_IP, nbCDF, pAtLeast, ipToDecimal } from '../../lib/strikeout-model.js'
import { parseArgs } from '../../lib/cli-args.js'

const opts     = parseArgs({
  date: { default: new Date().toISOString().slice(0, 10) },
  poll: { type: 'number', default: 180 },
})
const TODAY       = opts.date
const POLL_SEC    = opts.poll
let   LIVE        = process.env.LIVE_TRADING === 'true'
const LIVE_EDGE   = Number(process.env.LIVE_EDGE_MIN || 0.08)
const LOSS_LIMIT  = Number(process.env.DAILY_LOSS_LIMIT || 500)

const MLB_BASE    = 'https://statsapi.mlb.com/api/v1'
const AVG_PITCHES_PER_IP = 17   // ~17 pitches per IP for starters

const PULL_PITCH_COUNT      = Number(process.env.PULL_PITCH_COUNT      || 85)   // pitches at which pull risk becomes real
const PULL_MIN_IP           = Number(process.env.PULL_MIN_IP           || 4)    // minimum IP before tracking pull risk
const QUEUE_GOOD_THRESHOLD  = Number(process.env.QUEUE_GOOD_THRESHOLD  || 10)   // qp ≤ this → leave it
const QUEUE_AMEND_THRESHOLD = Number(process.env.QUEUE_AMEND_THRESHOLD || 30)   // qp ≤ this → amend price
const QUEUE_AMEND_CENTS     = Number(process.env.QUEUE_AMEND_CENTS     || 1)    // ¢ to shift when amending

// ── Live λ recalculation ──────────────────────────────────────────────────────
//
// Given current game state, compute the conditional expected remaining Ks.
// P(K_total ≥ n | k_so_far, ip_so_far, pitches_so_far)
//   = P(K_remaining ≥ n - k_so_far) under NB(λ_remaining)
//
// λ_remaining = expected_remaining_BF × pK
// expected_remaining_BF derived from pitch count pace vs. avg total pitches.

function computeLiveModel(preGame, currentKs, currentIP, currentPitches, currentBF = 0, scoreDiff = 0) {
  const { pK_blended, avgPitches, avgBF } = preGame

  // Score-state modifier: managers pull starters earlier when blowout, push them in close games
  let pitchBudget = avgPitches || 90
  if      (scoreDiff >=  5) pitchBudget *= 0.88   // blowout win  → early hook
  else if (scoreDiff <= -5) pitchBudget *= 0.92   // blowout loss → early hook
  else if (Math.abs(scoreDiff) <= 2) pitchBudget *= 1.03  // close game → push starter

  // TTO penalty: 3rd time through lineup (~BF≥21) → manager more likely to pull
  if (currentBF >= 21) pitchBudget *= 0.93

  const pitchesLeft = Math.max(0, pitchBudget - currentPitches)
  const remainingIP = pitchesLeft / AVG_PITCHES_PER_IP

  // Expected remaining BF
  const remainingBF = remainingIP * LEAGUE_PA_PER_IP

  // Bayesian blend of live K% with pre-game prior.
  //   BF < 9   → pure prior (too small a sample)
  //   BF ≥ 9   → blend liveKpct with pK_blended, weight rising to 0.5 at BF=18
  // Clamped to [0.10, 0.45] to avoid runaway extremes on small samples.
  let pK_effective = pK_blended
  if (currentBF >= 9) {
    const liveKpct = currentBF > 0 ? currentKs / currentBF : pK_blended
    const w_live   = Math.min(0.5, currentBF / 36)
    const blended  = w_live * liveKpct + (1 - w_live) * pK_blended
    pK_effective   = Math.max(0.10, Math.min(0.45, blended))
  }

  // λ_remaining = remaining BF × K rate
  const lambdaRemaining = Math.max(0, remainingBF * pK_effective)

  return {
    lambdaRemaining,
    remainingIP,
    remainingBF,
    currentKs,
    currentBF,
    pK_blended,
    pK_effective,
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
let _dailyNetPnl = 0  // net P&L today (all settled bets, pre-game + live)

async function loadDailyLoss() {
  const rows = await db.all(
    `SELECT SUM(CASE WHEN pnl < 0 THEN ABS(pnl) ELSE 0 END) as losses
       FROM ks_bets WHERE bet_date = ? AND live_bet = 1`,
    [TODAY],
  )
  _dailyLoss = rows[0]?.losses || 0
  return _dailyLoss
}

async function reloadDailyNetPnl() {
  const row = await db.one(
    `SELECT COALESCE(SUM(pnl), 0) as net FROM ks_bets WHERE bet_date = ? AND result IS NOT NULL`,
    [TODAY],
  )
  _dailyNetPnl = row?.net || 0
  return _dailyNetPnl
}

// ── Place or paper-log a live bet ─────────────────────────────────────────────

const LIVE_USER_ID  = 284  // Adam-Live
const PAPER_USER_ID = 1    // Adam (paper)

async function isLiveEnabled() {
  const row = await db.one(`SELECT paper FROM users WHERE id = ?`, [LIVE_USER_ID])
  return row?.paper === 0
}

async function executeBet({ pitcherName, pitcherId, game, strike, side, modelProb, marketMid, edge, ticker, betSize, kellyFraction, capitalRisk,
  liveKs, liveIP, livePitches, liveBF, liveInning, livePkEffective, liveLambda, liveScore }) {
  LIVE = await isLiveEnabled()
  const paper  = !LIVE
  const userId = LIVE ? LIVE_USER_ID : PAPER_USER_ID
  const now    = new Date().toISOString()

  // DB-level dedup: skip if already logged this session (survives monitor restarts)
  // Use IS instead of = for user_id because SQLite NULL = NULL is always false
  const existing = await db.one(
    `SELECT id FROM ks_bets WHERE bet_date=? AND pitcher_name=? AND strike=? AND side=? AND live_bet=1 AND user_id IS ?`,
    [TODAY, pitcherName, strike, side, userId],
  )
  if (existing) return

  // In-game cap: based on OUTSTANDING exposure (pending bets only), not total wagered.
  // As afternoon bets settle, the slot opens up for evening games.
  // Rule E (drawdown halt) still prevents spiraling on bad days.
  const userRow = await db.one(
    `SELECT starting_bankroll, live_daily_risk_pct, kalshi_key_id, kalshi_private_key FROM users WHERE id = ?`, [userId],
  )
  if (userRow) {
    let bankroll = userRow.starting_bankroll || 1000
    if (userRow.kalshi_key_id) {
      try {
        const creds = { keyId: userRow.kalshi_key_id, privateKey: userRow.kalshi_private_key }
        const kb = await getKalshiBalance(creds)
        bankroll = kb.balance_usd
      } catch {}
    }
    const cap = bankroll * (userRow.live_daily_risk_pct ?? 0.10)
    const spent = await db.one(
      `SELECT COALESCE(SUM(capital_at_risk), 0) as total FROM ks_bets WHERE bet_date=? AND live_bet=1 AND user_id=? AND result IS NULL`,
      [TODAY, userId],
    )
    const thisCap = capitalAtRisk(betSize, Math.round(side === 'YES' ? marketMid : 100 - marketMid) / 100, side)
    if ((spent?.total || 0) + thisCap > cap) {
      console.log(`  [CAP] ${pitcherName} ${strike}+ ${side} skipped — live cap $${cap.toFixed(0)} (bankroll $${bankroll.toFixed(0)}) reached ($${(spent?.total || 0).toFixed(0)} already out)`)
      return
    }
  }

  if (LIVE) {
    // betSize is face value ($1 per contract at Kalshi) = contract count directly
    const contracts = Math.max(1, Math.round(betSize))

    // Maker order at ask-1¢: rests on book, 75% fee discount vs taker.
    // Fall back to mid if orderbook unavailable.
    let askCents = side === 'YES'
      ? Math.min(99, Math.round(marketMid + 2))   // rough ask estimate
      : Math.min(99, Math.round(100 - marketMid + 2))
    let finalContracts = contracts
    try {
      const ob = await getOrderbook(ticker, 10)
      if (ob) {
        if (side === 'YES' && ob.best_yes_ask != null) askCents = ob.best_yes_ask
        if (side === 'NO'  && ob.best_no_ask  != null) askCents = ob.best_no_ask
        const depth = availableDepth(ob, side.toLowerCase(), askCents)
        if (depth > 0 && finalContracts > depth) {
          console.log(`  [depth] ${pitcherName} ${strike}+ ${side}: capping ${finalContracts}→${depth}c`)
          finalContracts = depth
        }
      }
    } catch { /* non-fatal — use estimate */ }
    const makerCents = Math.max(1, askCents - 1)
    try {
      await placeOrder(ticker, side.toLowerCase(), finalContracts, makerCents)
      console.log(`  [LIVE MAKER] ${pitcherName} ${strike}+ ${side} ${finalContracts}c @ ${makerCents}¢ (ask ${askCents}¢)`)
      db.saveLog({ tag: 'BET', msg: `${pitcherName} ${strike}+ ${side} ${finalContracts}c @ ${makerCents}¢ (ask ${askCents}¢)`, pitcher: pitcherName, strike, side })
    } catch (err) {
      console.error(`  [ORDER FAILED] ${pitcherName} ${strike}+ ${side}: ${err.message}`)
      db.saveLog({ tag: 'ERROR', level: 'error', msg: `ORDER FAILED ${pitcherName} ${strike}+ ${side}: ${err.message}`, pitcher: pitcherName, strike, side })
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
    paper:                paper ? 1 : 0,
    live_bet:             1,
    ticker,
    live_ks_at_bet:       liveKs       ?? null,
    live_ip_at_bet:       liveIP       ?? null,
    live_pitches_at_bet:  livePitches  ?? null,
    live_bf_at_bet:       liveBF       ?? null,
    live_inning:          liveInning   ?? null,
    live_pk_effective:    livePkEffective ?? null,
    live_lambda_remaining: liveLambda  ?? null,
    live_score:           liveScore    ?? null,
  }, ['bet_date', 'pitcher_name', 'strike', 'side', 'live_bet'])
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

    // P&L: use Kalshi's revenue minus our cost basis.
    // profit_loss is always 0 in their API; revenue is the actual cash credited.
    let pnl
    const contracts = bet.filled_contracts != null ? bet.filled_contracts : Math.round(bet.bet_size)
    const fillPrice = bet.fill_price ?? bet.market_mid ?? 50  // cents
    if (bet.ticker) {
      try {
        const liveCreds = await db.one(`SELECT kalshi_key_id, kalshi_private_key FROM users WHERE id = ?`, [bet.user_id])
        if (liveCreds?.kalshi_key_id) {
          const creds = { keyId: liveCreds.kalshi_key_id, privateKey: liveCreds.kalshi_private_key }
          const { settlements } = await getSettlements({ ticker: bet.ticker }, creds)
          const s = settlements?.[0]
          if (s?.revenue != null) {
            const revenue   = s.revenue / 100
            const costBasis = contracts * (fillPrice / 100)
            pnl = revenue - costBasis
          }
        }
      } catch { /* fall through to math */ }
    }
    if (pnl == null) {
      const fillFraction = fillPrice / 100
      const KALSHI_FEE   = 0.07
      pnl = won
        ? contracts * (1 - fillFraction) * (1 - KALSHI_FEE * fillFraction)
        : -contracts * fillFraction
    }

    await db.run(
      `UPDATE ks_bets SET actual_ks=?, result=?, settled_at=?, pnl=? WHERE id=?`,
      [actualKs, won ? 'win' : 'loss', now, Math.round(pnl * 100) / 100, bet.id],
    )
    settled.push({ ...bet, actual_ks: actualKs, result: won ? 'win' : 'loss', pnl })
  }

  if (!settled.length) return

  const gamePnl = settled.reduce((s, b) => s + (b.pnl || 0), 0)
  const wins = settled.filter(b => b.result === 'win').length
  const losses = settled.length - wins
  console.log(`\n[live] ${gameLabel} settled: ${wins}W/${losses}L  ${gamePnl >= 0 ? '+' : ''}$${gamePnl.toFixed(2)}`)
  db.saveLog({ tag: 'SETTLED', msg: `${gameLabel}  ${wins}W/${losses}L  ${gamePnl >= 0 ? '+' : ''}$${gamePnl.toFixed(2)}`, pnl: gamePnl })

  await notifyGameResult({ game: gameLabel, bets: settled, gamePnl }, await getAllWebhooks(db))
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
  }, await getAllWebhooks(db))
}

// ── T-90 resting order review: flip-to-NO or cancel no-edge ──────────────────
//
// Called for each Preview game when first pitch is ≤90 min away.
// For unfilled maker orders:
//   - If YES price rose ≥7¢ past model_prob → NO side now has edge → flip
//   - If edge on original side dropped below threshold → cancel, skip
//   - Otherwise → leave it resting until T-45
// Guards with _t90Games so it only runs once per game.

const _t90Games = new Set()

async function manageRestingOrders(game) {
  if (_t90Games.has(game.id)) return
  _t90Games.add(game.id)

  const restingBets = await db.all(
    `SELECT * FROM ks_bets
      WHERE bet_date = ? AND order_status = 'resting' AND result IS NULL
        AND (pitcher_id = ? OR pitcher_id = ?)`,
    [TODAY, game.pitcher_home_id, game.pitcher_away_id],
  )
  if (!restingBets.length) return

  console.log(`\n[live] T-90 review: ${game.team_away}@${game.team_home} — ${restingBets.length} resting order(s)`)

  for (const bet of restingBets) {
    if (!bet.ticker) continue
    try {
      const mkt = await getMarketPrice(bet.ticker)
      if (!mkt) continue

      const modelProb   = bet.model_prob ?? 0.5
      // Current mid for each side (fractions 0-1)
      const yesMid  = mkt.mid != null ? mkt.mid / 100 : null
      if (yesMid == null) continue
      const noMid   = 1 - yesMid

      const edgeYES = modelProb - yesMid
      const edgeNO  = (1 - modelProb) - noMid

      // Original side edge still viable?
      const originalEdge = bet.side === 'YES' ? edgeYES : edgeNO
      if (originalEdge >= LIVE_EDGE / 2) continue  // still good — let it ride to T-45

      // Edge gone on original side — check if opposite side has edge
      const flipSide  = bet.side === 'YES' ? 'NO' : 'YES'
      const flipEdge  = bet.side === 'YES' ? edgeNO : edgeYES
      const flipPrice = bet.side === 'YES' ? noMid  : yesMid

      if (flipEdge >= LIVE_EDGE) {
        // Cancel original, place flip-side maker
        if (bet.order_id) await cancelOrder(bet.order_id)
        console.log(`  ↔ ${bet.pitcher_name} ${bet.strike}+ flip YES→${flipSide}  original edge=${(originalEdge*100).toFixed(1)}¢  flip edge=${(flipEdge*100).toFixed(1)}¢`)

        const flipAsk     = bet.side === 'YES' ? (mkt.no_ask ?? Math.round(noMid * 100 + 1)) : (mkt.yes_ask ?? Math.round(yesMid * 100 + 1))
        const makerCents  = Math.max(1, flipAsk - 1)
        const contracts   = Math.max(1, Math.round((bet.bet_size ?? 100) / flipPrice))
        const result      = await placeOrder(bet.ticker, flipSide.toLowerCase(), contracts, makerCents)
        const newOrder    = result?.order ?? result
        const newOrderId  = newOrder?.order_id ?? null

        await db.run(
          `UPDATE ks_bets SET side=?, order_id=?, order_status='resting', market_mid=?, fill_price=NULL WHERE id=?`,
          [flipSide, newOrderId, Math.round(flipPrice * 100), bet.id],
        )
        console.log(`    → ${flipSide} MAKER ${contracts}c @ ${makerCents}¢  id=${newOrderId}`)
      } else {
        // No edge on either side — cancel and skip
        if (bet.order_id) await cancelOrder(bet.order_id)
        await db.run(`UPDATE ks_bets SET order_status='cancelled' WHERE id=?`, [bet.id])
        console.log(`  ✗ ${bet.pitcher_name} ${bet.strike}+ ${bet.side} — no edge on either side at T-90, cancelled  (YES edge=${(edgeYES*100).toFixed(1)}¢ NO edge=${(edgeNO*100).toFixed(1)}¢)`)
      }
    } catch (err) {
      console.error(`  [T-90] error for ${bet.pitcher_name}: ${err.message}`)
    }
  }
}

// ── T-45 pre-game order management ───────────────────────────────────────────
//
// Called for each Preview game when first pitch is ≤45 min away.
// Checks all resting maker orders for that game:
//   - Already filled → update DB status, done
//   - Still resting  → cancel, re-price at current market, place taker if edge holds
// This runs at most once per game (guarded by a Set in the caller scope).

const _managedGames = new Set()

async function managePreGameOrders(game) {
  if (_managedGames.has(game.id)) return
  _managedGames.add(game.id)

  const restingBets = await db.all(
    `SELECT * FROM ks_bets
      WHERE bet_date = ? AND order_status = 'resting' AND result IS NULL
        AND (pitcher_id = ? OR pitcher_id = ?)`,
    [TODAY, game.pitcher_home_id, game.pitcher_away_id],
  )
  if (!restingBets.length) return

  console.log(`\n[live] T-45 order check: ${game.team_away}@${game.team_home} — ${restingBets.length} resting order(s)`)

  for (const bet of restingBets) {
    if (!bet.order_id || !bet.ticker) continue
    try {
      const order = await getOrder(bet.order_id)
      const filled = order?.status === 'executed' || Number(order?.remaining_count_fp ?? order?.remaining_count ?? 0) === 0

      if (filled) {
        const priceDollars   = order?.yes_price_dollars ?? order?.no_price_dollars ?? null
        const fillPriceCents = priceDollars ? Math.round(parseFloat(priceDollars) * 100)
                             : (order?.yes_price ?? order?.no_price ?? null)
        const filledCount    = Math.round(parseFloat(order?.fill_count_fp ?? '0'))
        await db.run(
          `UPDATE ks_bets SET order_status='filled', fill_price=COALESCE(?, fill_price), filled_contracts=? WHERE id=?`,
          [fillPriceCents, filledCount || null, bet.id],
        )
        console.log(`  ✓ ${bet.pitcher_name} ${bet.side} ${bet.strike}+ — filled ${filledCount}c @ ${fillPriceCents ?? '?'}¢ (maker)`)
        continue
      }

      // Not filled — cancel and re-evaluate at current market price
      await cancelOrder(bet.order_id)
      console.log(`  ✗ ${bet.pitcher_name} ${bet.side} ${bet.strike}+ — not filled, cancelling maker order`)

      const mkt = await getMarketPrice(bet.ticker)
      if (!mkt) {
        await db.run(`UPDATE ks_bets SET order_status='cancelled' WHERE id=?`, [bet.id])
        console.log(`    → no market data, skipping`)
        continue
      }

      const currentAsk = bet.side === 'YES' ? mkt.ask : (1 - mkt.bid)   // fraction 0-1
      const modelProb  = bet.model_prob ?? 0.5
      const currentEdge = modelProb - currentAsk

      if (currentEdge < (LIVE_EDGE / 2)) {
        // Edge evaporated (use half threshold since we're close to game time)
        await db.run(`UPDATE ks_bets SET order_status='cancelled' WHERE id=?`, [bet.id])
        console.log(`    → edge gone (${(currentEdge*100).toFixed(1)}¢ at ${(currentAsk*100).toFixed(0)}¢ ask), skipping`)
        continue
      }

      // Edge still good — take the market as a taker order
      const takerCents = Math.min(99, Math.round(currentAsk * 100) + 1)
      // bet_size is face value ($1/contract at Kalshi) = contract count directly
      const contracts  = Math.max(1, Math.round(bet.bet_size ?? 100))
      const result     = await placeOrder(bet.ticker, bet.side.toLowerCase(), contracts, takerCents)
      const order2     = result?.order ?? result
      const newOrderId = order2?.order_id ?? null
      const newStatus  = order2?.status ?? 'placed'

      await db.run(
        `UPDATE ks_bets SET order_id=?, fill_price=?, order_status=?, market_mid=? WHERE id=?`,
        [newOrderId, takerCents, newStatus, Math.round(currentAsk * 100), bet.id],
      )
      console.log(`    → TAKER fallback placed ${contracts}c @ ${takerCents}¢  edge=${(currentEdge*100).toFixed(1)}¢  id=${newOrderId}`)
    } catch (err) {
      console.error(`  [T-45] error for ${bet.pitcher_name}: ${err.message}`)
    }
  }
}

// ── In-game queue position + order amend management ──────────────────────────
//
// Called each poll cycle for every live bet still in 'resting' state.
// Once the pitcher is deep in the game (≥PULL_PITCH_COUNT pitches, ≥PULL_MIN_IP),
// we check where our maker order sits in the queue and act:
//   qp ≤ QUEUE_GOOD_THRESHOLD   → leave it (near the front)
//   qp ≤ QUEUE_AMEND_THRESHOLD  → amend price 1¢ more aggressive
//   qp > QUEUE_AMEND_THRESHOLD  → cancel + re-enter as taker

// Module-level map to avoid spamming "leave it" logs every poll
const _lastQueueDecision = new Map()  // order_id → { decision, loggedAt }

async function manageRestingOrder(bet, { currentPitches, currentIP, market, creds }) {
  if (!bet.order_id || bet.order_status !== 'resting') return

  // Gate: only manage when pitcher is deep in game (pull risk)
  const nearPull = currentPitches >= PULL_PITCH_COUNT && currentIP >= PULL_MIN_IP
  if (!nearPull) return

  // Check order is still alive
  let order
  try { order = await getOrder(bet.order_id, creds) } catch { return }
  if (!order || order.status === 'executed' || order.status === 'canceled' || order.status === 'cancelled') {
    // Order is gone — update DB status and exit
    if (order?.status === 'executed') {
      const filled = order.fill_count_fp ? Math.round(parseFloat(order.fill_count_fp)) : null
      await db.run(
        `UPDATE ks_bets SET order_status='filled', filled_contracts=COALESCE(?,filled_contracts) WHERE id=?`,
        [filled, bet.id]
      )
    } else {
      await db.run(`UPDATE ks_bets SET order_status='cancelled' WHERE id=?`, [bet.id])
    }
    return
  }

  // Fetch queue position
  let qp
  try {
    const qpRes = await getQueuePosition(bet.order_id, creds)
    if (!qpRes) return  // order gone between getOrder and here
    qp = qpRes.queue_position
  } catch { return }

  // Determine action
  const prevDecision = _lastQueueDecision.get(bet.order_id)
  const currentPrice = bet.fill_price ?? bet.market_mid ?? 50

  if (qp <= QUEUE_GOOD_THRESHOLD) {
    if (prevDecision?.decision !== 'leave') {
      console.log(`  [queue] ${bet.pitcher_name} ${bet.strike}+ ${bet.side} — queue=${qp} leave it`)
      _lastQueueDecision.set(bet.order_id, { decision: 'leave', loggedAt: Date.now() })
    }
    return
  }

  if (qp <= QUEUE_AMEND_THRESHOLD) {
    // Amend 1¢ more aggressive — closer to the market
    let newPrice
    if (bet.side === 'YES') {
      const ask = market?.yes_ask ?? (currentPrice + 5)
      newPrice = Math.min(99, Math.max(1, Math.round(currentPrice) + QUEUE_AMEND_CENTS))
      newPrice = Math.min(newPrice, ask - 1)  // don't cross the spread
    } else {
      const ask = market?.no_ask ?? (currentPrice + 5)
      newPrice = Math.min(99, Math.max(1, Math.round(currentPrice) + QUEUE_AMEND_CENTS))
      newPrice = Math.min(newPrice, ask - 1)
    }
    if (newPrice === Math.round(currentPrice)) {
      console.log(`  [queue] ${bet.pitcher_name} ${bet.strike}+ ${bet.side} — queue=${qp} amend skipped (already at ask-1)`)
      return
    }
    try {
      const result = await amendOrder(bet.order_id, { side: bet.side.toLowerCase(), price: newPrice }, creds)
      const newOrderId = result?.order_id ?? bet.order_id
      await db.run(
        `UPDATE ks_bets SET market_mid=?, order_id=? WHERE id=?`,
        [newPrice, newOrderId, bet.id]
      )
      console.log(`  [queue] ${bet.pitcher_name} ${bet.strike}+ ${bet.side} — queue=${qp} amend ${Math.round(currentPrice)}¢ → ${newPrice}¢`)
      _lastQueueDecision.set(newOrderId, { decision: 'amend', loggedAt: Date.now() })
    } catch (err) {
      console.error(`  [queue] amend failed: ${err.message}`)
    }
    return
  }

  // qp > QUEUE_AMEND_THRESHOLD — cancel and take the market
  try {
    await cancelOrder(bet.order_id, creds)
    const contracts = Math.max(1, Math.round(bet.bet_size / ((bet.fill_price ?? bet.market_mid ?? 50) / 100)))
    const takerPrice = bet.side === 'YES'
      ? Math.min(99, (market?.yes_ask ?? Math.round(currentPrice) + 3) + 1)
      : Math.min(99, (market?.no_ask  ?? Math.round(currentPrice) + 3) + 1)
    const result = await placeOrder(bet.ticker, bet.side.toLowerCase(), contracts, takerPrice, creds)
    const newOrderId = result?.order?.order_id ?? result?.order_id
    await db.run(
      `UPDATE ks_bets SET order_id=?, market_mid=?, order_status='resting' WHERE id=?`,
      [newOrderId, takerPrice, bet.id]
    )
    console.log(`  [queue] ${bet.pitcher_name} ${bet.strike}+ ${bet.side} — queue=${qp} cancel+taker ${contracts}c @ ${takerPrice}¢ (new order ${newOrderId})`)
    _lastQueueDecision.set(newOrderId, { decision: 'taker', loggedAt: Date.now() })
  } catch (err) {
    console.error(`  [queue] cancel+taker failed: ${err.message}`)
  }
}

// ── Main monitor loop ─────────────────────────────────────────────────────────

async function main() {
  await db.migrate()
  await loadDailyLoss()
  await reloadDailyNetPnl()

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
  db.saveLog({ tag: 'STARTUP', msg: `Mode=${LIVE ? 'LIVE' : 'PAPER'}  edge≥${(LIVE_EDGE*100).toFixed(0)}¢  pitchers=${allPitcherIds.size}  games=${games.length}` })

  // Track which in-game bets we've already placed this session (avoid dups)
  const placed = new Set()
  // Track cover/dead/one-away alerts already sent
  const covered = new Set()
  const dead    = new Set()
  const oneAway = new Set()
  // Track which games have been settled + Discord'd
  const settledGames = new Set()

  // ── Startup backfill: settle any games that went Final while monitor was offline ──
  console.log('[live] Checking for games that finished before monitor started...')
  for (const game of games) {
    try {
      const [lsRes, boxRes] = await Promise.all([
        axios.get(`${MLB_BASE}/game/${game.id}/linescore`, { timeout: 8000 }),
        axios.get(`${MLB_BASE}/game/${game.id}/boxscore`, { timeout: 8000 }),
      ])
      if (lsRes.data.abstractGameState === 'Final' && !settledGames.has(game.id)) {
        settledGames.add(game.id)
        await settleAndNotifyGame(game, boxRes.data)
      }
    } catch (err) {
      console.error(`[live] backfill check failed for game ${game.id}: ${err.message}`)
    }
  }

  let iteration = 0
  while (true) {
    iteration++
    const now = new Date().toISOString().slice(11, 16)
    process.stdout.write(`\r[live] ${now} UTC | poll #${iteration} | daily loss: $${_dailyLoss.toFixed(0)}/$${LOSS_LIMIT}  `)

    if (_dailyLoss >= LOSS_LIMIT) {
      console.log(`\n[live] Daily loss limit hit ($${_dailyLoss.toFixed(0)}). Stopping.`)
      // Cancel all open orders on halt
      try {
        const creds = {}  // uses env-var KALSHI_KEY_ID for Adam-Live (live monitor runs as single user)
        await cancelAllOrders({ status: 'resting' }, creds)
        console.log('[live] Cancelled all resting orders after loss limit hit')
      } catch { /* non-fatal */ }
      break
    }

    // Rule E: Auto-halt after -15% daily drawdown (net across all bets today)
    await reloadDailyNetPnl()
    const DRAWDOWN_HALT_PCT = 0.15
    const userRow = await db.one(`SELECT starting_bankroll FROM users WHERE id = ?`, [LIVE_USER_ID])
    const drawdownLimit = -((userRow?.starting_bankroll ?? 1000) * DRAWDOWN_HALT_PCT)
    if (_dailyNetPnl < drawdownLimit) {
      console.log(`\n[live] Rule E: Drawdown halt — today's P&L $${_dailyNetPnl.toFixed(2)} exceeds -${(DRAWDOWN_HALT_PCT*100).toFixed(0)}% limit. Stopping new bets.`)
      // Cancel all open orders on halt
      try {
        const creds = {}  // uses env-var KALSHI_KEY_ID for Adam-Live (live monitor runs as single user)
        await cancelAllOrders({ status: 'resting' }, creds)
        console.log('[live] Cancelled all resting orders after drawdown halt')
      } catch { /* non-fatal */ }
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

        if (state === 'Preview') {
          if (LIVE && game.game_time) {
            const minsToGame = (new Date(game.game_time) - Date.now()) / 60000
            // T-90: flip-to-NO / cancel no-edge resting orders
            if (minsToGame <= 90 && minsToGame > 45) {
              await manageRestingOrders(game)
            }
            // T-45: fill check → taker fallback
            if (minsToGame <= 45 && minsToGame > 0) {
              await managePreGameOrders(game)
            }
          }
          continue
        }

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
          const currentBF      = Number(player.stats?.pitching?.battersFaced || 0)
          const isCurrent      = player.gameStatus?.isCurrentPitcher
          const ls             = lsRes.data
          const currentInning  = ls.currentInning != null ? `${ls.inningHalf?.slice(0,3) ?? ''}${ls.currentInning}` : null
          const awayScore      = ls.teams?.away?.runs ?? null
          const homeScore      = ls.teams?.home?.runs ?? null
          const currentScore   = awayScore != null ? `${awayScore}-${homeScore}` : null
          // Score diff from pitcher's team perspective (positive = pitcher's team winning)
          const pitcherScore   = side === 'away' ? awayScore : homeScore
          const oppScore       = side === 'away' ? homeScore : awayScore
          const scoreDiff      = (pitcherScore ?? 0) - (oppScore ?? 0)

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
              await notifyOneAway({ pitcherName: ctx.pitcherName, strike: bet.strike, pnl, currentKs, game: ctx.game }, await getAllWebhooks(db))
            }

            // Cover: pitcher already has enough Ks — settle immediately, don't wait for game to end
            if (bet.side === 'YES' && currentKs >= bet.strike && !covered.has(key)) {
              covered.add(key)
              const _fcC = bet.filled_contracts != null ? bet.filled_contracts : null
              const _ffC = _fcC != null ? (bet.fill_price ?? (bet.market_mid ?? 50)) / 100 : (bet.market_mid ?? 50) / 100
              const _szC = _fcC != null ? _fcC : (bet.bet_size ?? 100)
              const pnl = Math.round(_szC * (1 - _ffC) * 0.93 * 100) / 100
              const now = new Date().toISOString()
              await db.run(
                `UPDATE ks_bets SET actual_ks=?, result='win', settled_at=?, pnl=? WHERE id=? AND result IS NULL`,
                [currentKs, now, pnl, bet.id],
              )
              console.log(`\n[live] ✅ COVERED + SETTLED ${ctx.pitcherName} ${bet.strike}+ (${currentKs}K)  +$${pnl.toFixed(2)}`)
              db.saveLog({ tag: 'COVER', msg: `${ctx.pitcherName} ${bet.strike}+ YES covered at ${currentKs}K  +$${pnl.toFixed(2)}`, pitcher: ctx.pitcherName, strike: bet.strike, side: 'YES', pnl })
              await notifyCovered({ pitcherName: ctx.pitcherName, strike: bet.strike, side: bet.side, pnl, currentKs, game: ctx.game }, await getAllWebhooks(db))
            }

            // Dead: YES bet, starter pulled and can't reach threshold — settle as loss immediately
            // Require 3+ IP before trusting isCurrent=false; MLB API flag is unreliable in early innings
            if (bet.side === 'YES' && !isCurrent && currentKs < bet.strike && currentIP >= 3 && !dead.has(key)) {
              dead.add(key)
              const FEE = 0.07
              const contracts = bet.filled_contracts != null ? bet.filled_contracts : null
              const fillFrac  = contracts != null ? (bet.fill_price ?? (bet.market_mid ?? 50)) / 100 : (bet.market_mid ?? 50) / 100
              const size      = contracts != null ? contracts : (bet.bet_size ?? 100)
              const pnl = -Math.round(size * fillFrac * 100) / 100
              const now = new Date().toISOString()
              await db.run(
                `UPDATE ks_bets SET actual_ks=?, result='loss', settled_at=?, pnl=? WHERE id=? AND result IS NULL`,
                [currentKs, now, pnl, bet.id],
              )
              console.log(`\n[live] ❌ DEAD + SETTLED ${ctx.pitcherName} pulled at ${currentKs}K (needed ${bet.strike}+)  $${pnl.toFixed(2)}`)
              db.saveLog({ tag: 'DEAD', level: 'warn', msg: `${ctx.pitcherName} pulled at ${currentKs}K (needed ${bet.strike}+)  $${pnl.toFixed(2)}`, pitcher: ctx.pitcherName, strike: bet.strike, side: 'YES', pnl })
              await notifyDead({ pitcherName: ctx.pitcherName, strike: bet.strike, side: bet.side, pnl, currentKs, currentIPraw, game: ctx.game, reason: 'starter pulled' }, await getAllWebhooks(db))
            }

            // NO bets are settled at game-end by settleAndNotifyGame — no mid-game
            // early settlement here. Box scores can briefly lag/correct, and an
            // early lock is irreversible. Once the game is Final we get exact Ks.
          }

          const pitcherPulledEarly = !isCurrent && currentIP >= 1

          // BF + inning gates — bypassed for confirmed-pulled pitchers (state already resolved)
          if (!pitcherPulledEarly && currentBF < 6) continue
          const currentInn = ls.currentInning ?? 0
          if (!pitcherPulledEarly && currentInn < 3) continue

          const live = pitcherPulledEarly
            ? null
            : computeLiveModel(ctx, currentKs, currentIP, currentPitches, currentBF, scoreDiff)

          // Fetch current Kalshi prices for this pitcher's markets
          if (!ctx.baseTicker) continue
          const markets = await fetchLiveKsMarkets(ctx.baseTicker)
          if (!markets.length) continue

          // Manage any resting live bets for this pitcher (queue position + reprice)
          const restingLiveBets = await db.all(
            `SELECT * FROM ks_bets WHERE bet_date=? AND pitcher_id=? AND live_bet=1 AND order_status='resting' AND result IS NULL`,
            [TODAY, String(pitcherId)]
          )
          for (const restBet of restingLiveBets) {
            const mkt = markets.find(m => m.ticker === restBet.ticker)
            await manageRestingOrder(restBet, { currentPitches, currentIP, market: mkt ?? null, creds: {} })
              .catch(err => console.error(`[live] manageRestingOrder error: ${err.message}`))
          }

          // Pre-load today's pre-game bets for this pitcher — used to dedup by (pitcher, strike, side)
          const preGameForPitcher = await db.all(
            `SELECT strike, side FROM ks_bets
              WHERE bet_date = ? AND pitcher_id = ? AND live_bet = 0`,
            [TODAY, String(pitcherId)],
          )
          const preGameKeys = new Set(preGameForPitcher.map(r => `${r.strike}-${r.side}`))

          // ── Pass 1: collect qualifying edges for this pitcher ──
          const qualifying = []

          for (const mkt of markets) {
            const parts = mkt.ticker.split('-')
            const n = parseInt(parts[parts.length - 1])
            if (!Number.isInteger(n) || n < 2 || n > 15) continue

            if (mkt.yes_bid == null || mkt.yes_ask == null) continue
            const midCents   = (mkt.yes_bid + mkt.yes_ask) / 2
            const halfSpread = (mkt.yes_ask - mkt.yes_bid) / 200
            const marketPrice = midCents / 100
            const noMid      = 100 - midCents

            const betKey = `${pitcherId}-${n}-live`  // mode-agnostic dedup key
            if (placed.has(betKey)) continue
            if (preGameKeys.has(`${n}-NO`) && preGameKeys.has(`${n}-YES`)) continue

            // ── MODE 1: Pulled pitcher — structurally resolved, stale market arb ──
            if (pitcherPulledEarly && n > currentKs) {
              if (preGameKeys.has(`${n}-NO`)) continue
              if (noMid >= 90 || noMid <= 5) continue  // already repriced or illiquid
              qualifying.push({
                n, mkt, midCents, marketPrice, modelProb: 0.02,
                edge: 1 - marketPrice - 0.02, betSide: 'NO', betKey, mode: 'pulled',
                modelProbSide: 0.98, marketPriceSide: 1 - marketPrice,
              })
              continue
            }

            if (!live) continue  // pulled pitcher — no high-conviction model available

            const modelProb = live.probAtLeast(n)
            const edgeYES   = modelProb - marketPrice
            const edgeNO    = (1 - modelProb) - (1 - marketPrice)
            const betSide   = edgeYES >= edgeNO ? 'YES' : 'NO'
            const edge      = betSide === 'YES' ? edgeYES : edgeNO

            if (preGameKeys.has(`${n}-${betSide}`)) continue

            // ── MODE 2: High-conviction only — YES 20¢/75%, NO 15¢/15% ──
            if (betSide === 'YES') {
              if (modelProb < 0.75) continue
              if (edge < Math.max(0.20, halfSpread + 0.04)) continue
            } else {
              if (modelProb > 0.15) continue
              if (midCents > 55) continue  // Rule: don't pay >55¢ for a NO — too expensive if pitcher hits threshold
              if (edge < Math.max(0.15, halfSpread + 0.04)) continue
            }

            qualifying.push({
              n, mkt, midCents, marketPrice, modelProb, edge, betSide, betKey,
              mode: 'high-conviction',
              modelProbSide: betSide === 'YES' ? modelProb : 1 - modelProb,
              marketPriceSide: betSide === 'YES' ? marketPrice : 1 - marketPrice,
            })
          }

          if (!qualifying.length) continue

          // ── Pass 2: correlated Kelly across all qualifying thresholds for this pitcher ──
          const sized = correlatedKellyDivide(
            qualifying.map(q => ({
              modelProb:  q.modelProbSide,
              marketPrice: q.marketPriceSide,
              side:       q.betSide,
            })),
          )

          for (let i = 0; i < qualifying.length; i++) {
            const q = qualifying[i]
            const s = sized[i]
            if (!s || s.betSize <= 0) continue

            // 2× sizing for high-edge bets (≥15¢) — validated +$1,909 on 100 bets historically
            const edgeMult    = q.edge >= 0.15 ? 2 : 1
            const finalBetSize = s.betSize * edgeMult
            const capitalRisk = capitalAtRisk(finalBetSize, q.marketPrice, q.betSide)

            placed.add(q.betKey)
            const sizeTag = edgeMult > 1 ? ` [2× edge=${(q.edge*100).toFixed(0)}¢]` : ''
            console.log(`\n[live] ${q.mode === 'pulled' ? '🎯 PULLED' : '🔥 EDGE'} ${ctx.game} ${ctx.pitcherName} ${q.n}+ Ks ${q.betSide}  model=${(q.modelProb*100).toFixed(1)}%  mid=${q.midCents.toFixed(0)}¢  edge=${(q.edge*100).toFixed(1)}¢  ${currentKs}K ${currentIPraw}IP ${currentPitches}p ${currentBF}BF  [${q.mode}]${sizeTag}`)
            db.saveLog({ tag: q.mode === 'pulled' ? 'PULLED' : 'EDGE', msg: `${ctx.pitcherName} ${q.n}+ ${q.betSide}  model=${(q.modelProb*100).toFixed(1)}%  mid=${q.midCents.toFixed(0)}¢  edge=${(q.edge*100).toFixed(1)}¢  ${currentKs}K ${currentIPraw}IP${sizeTag}`, pitcher: ctx.pitcherName, strike: q.n, side: q.betSide, edge_cents: Math.round(q.edge * 100) })

            await executeBet({
              pitcherName:      ctx.pitcherName,
              pitcherId,
              game:             ctx.game,
              strike:           q.n,
              side:             q.betSide,
              modelProb:        q.modelProbSide,
              marketMid:        q.midCents,
              edge:             q.edge,
              ticker:           q.mkt.ticker,
              betSize:          finalBetSize,
              kellyFraction:    s.kellyFraction,
              capitalRisk,
              liveKs:           currentKs,
              liveIP:           currentIP,
              livePitches:      currentPitches,
              liveBF:           currentBF,
              liveInning:       currentInning,
              livePkEffective:  live.pK_effective,
              liveLambda:       live.lambdaRemaining,
              liveScore:        currentScore,
            })

            await notifyLiveBet({
              pitcherName: ctx.pitcherName,
              strike: q.n,
              side: q.betSide,
              marketMid: q.midCents,
              edge: q.edge,
              betSize: finalBetSize,
              currentKs,
              currentIPraw,
              currentPitches,
              paper: !LIVE,
            }, await getAllWebhooks(db))

            if (LIVE) _dailyLoss  // recheck after live order
          }
        }
      } catch { /* skip game on error */ }
    }

    if (allDone && iteration > 1) {
      console.log('\n[live] All games final. Monitor done.')

      // Cancel any stale resting orders now that all games are final
      try {
        const liveUsers = await db.all(
          `SELECT id, name, kalshi_key_id, kalshi_private_key FROM users WHERE active_bettor=1 AND kalshi_key_id IS NOT NULL AND id != 1`,
        )
        for (const u of liveUsers) {
          const creds = { keyId: u.kalshi_key_id, privateKey: u.kalshi_private_key }
          const res = await cancelAllOrders({ status: 'resting' }, creds)
          if (res.cancelled_count > 0) {
            console.log(`[live] Cleaned up ${res.cancelled_count} stale resting orders for ${u.name}`)
            await db.run(
              `UPDATE ks_bets SET order_status='cancelled', result='void', pnl=0, settled_at=?
                WHERE bet_date=? AND user_id=? AND order_status IN ('resting','partial') AND result IS NULL`,
              [new Date().toISOString(), TODAY, u.id],
            )
          }
        }
      } catch (err) {
        console.error('[live] End-of-day order cleanup error:', err.message)
      }

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
