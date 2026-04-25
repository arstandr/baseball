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
//   node scripts/live/liveMonitor.js [--date YYYY-MM-DD] [--poll 15]
//
// Run after morning dailyRun.sh. Keeps running until all today's games finish.

import 'dotenv/config'
import axios from 'axios'
import * as db from '../../lib/db.js'
import { getAuthHeaders, placeOrder, cancelOrder, cancelAllOrders, getOrder, getMarketPrice, getSettlements, getBalance as getKalshiBalance, getQueuePosition, amendOrder, getOrderbook, availableDepth, listOrders, getFills } from '../../lib/kalshi.js'
import { mlbGet } from '../../lib/mlb-live.js'
import { kellySizing, capitalAtRisk, correlatedKellyDivide } from '../../lib/kelly.js'
import { notifyLiveBet, notifyFreeMoney, notifyCrossedYes, notifyBlowout, notifyScratch, notifyCovered, notifyDead, notifyOneAway, notifyGameResult, notifyDailyReport, getAllWebhooks } from '../../lib/discord.js'
import { NB_R, LEAGUE_K_PCT, LEAGUE_PA_PER_IP, nbCDF, pAtLeast, ipToDecimal } from '../../lib/strikeout-model.js'
import { parseArgs } from '../../lib/cli-args.js'

const opts     = parseArgs({
  date: { default: new Date().toISOString().slice(0, 10) },
  poll: { type: 'number', default: 15 },
})
const TODAY       = opts.date
const POLL_SEC    = opts.poll
let   LIVE        = process.env.LIVE_TRADING === 'true'
const LIVE_EDGE   = Number(process.env.LIVE_EDGE_MIN || 0.08)
const LOSS_LIMIT  = Number(process.env.DAILY_LOSS_LIMIT || 500)

const MLB_BASE        = 'https://statsapi.mlb.com/api/v1'
// Field filters reduce boxscore payload ~80% — only pull what extractStarterFromBoxscore needs
const LS_FIELDS       = 'abstractGameState,currentInning,currentInningOrdinal,teams,offense,defense'
const BOX_FIELDS      = 'teams.home.pitchers,teams.away.pitchers,teams.home.players,teams.away.players'
// Max USD risk per free-money taker order per strike threshold (pulled pitcher)
const PULLED_CAP_USD    = Number(process.env.PULLED_CAP_USD    || 10)
// Max USD total free-money spend across all strike thresholds for one pulled pitcher
const FREE_MONEY_PITCHER_CAP = Number(process.env.FREE_MONEY_PITCHER_CAP || 30)
// Max USD risk per dead-path NO taker (high pitch count, gap structurally uncloseable)
const DEAD_PATH_CAP_USD = Number(process.env.DEAD_PATH_CAP_USD || 10)
const AVG_PITCHES_PER_IP = 17   // ~17 pitches per IP for starters
// Max ¢ to pay for YES when threshold is already crossed (Kalshi market lag — near-certain win)
const CROSSED_YES_MAX_ASK  = Number(process.env.CROSSED_YES_MAX_ASK  || 20)
// Blowout NO: team losing by ≥BLOWOUT_DEFICIT runs in inning ≥BLOWOUT_INNING with ≥BLOWOUT_K_GAP still needed
const BLOWOUT_DEFICIT      = Number(process.env.BLOWOUT_DEFICIT      || 5)
const BLOWOUT_INNING       = Number(process.env.BLOWOUT_INNING       || 6)
const BLOWOUT_K_GAP        = Number(process.env.BLOWOUT_K_GAP        || 3)

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
  //   Fast-update: if live K% is ≥1.5× prior AND hot AND BF≥9 → accelerate convergence
  // Clamped to [0.10, 0.45] to avoid runaway extremes on small samples.
  let pK_effective = pK_blended
  if (currentBF >= 9) {
    const liveKpct = currentBF > 0 ? currentKs / currentBF : pK_blended
    const w_live   = Math.min(0.5, currentBF / 36)
    const blended  = w_live * liveKpct + (1 - w_live) * pK_blended
    pK_effective   = Math.max(0.10, Math.min(0.45, blended))
    // Fast update: pitcher is dominating well above prior → trust live evidence faster
    if (liveKpct > pK_blended * 1.5 && liveKpct > 0.25) {
      const w_fast    = Math.min(0.75, currentBF / 18)
      const fastBlend = w_fast * liveKpct + (1 - w_fast) * pK_blended
      pK_effective    = Math.max(0.10, Math.min(0.45, fastBlend))
    }
  }

  // TTO K-rate penalty: batters have seen this pitcher 2-3× through the order and adjust.
  // Separate from the pitch-budget penalty above — both effects are real and independent.
  if      (currentBF >= 24) pK_effective *= 0.75  // deep into 4th time through
  else if (currentBF >= 18) pK_effective *= 0.85  // 3rd time through

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

// ── In-game Bayesian probability update ──────────────────────────────────────
// Updates the remaining K distribution as the game progresses.
// Prior: pre-game λ (total expected Ks over the start)
// Likelihood: observed K rate from current in-game data
// Posterior: blended estimate that starts as pre-game model and moves toward
//            in-game evidence as the sample size grows.
//
// Returns: P(total_Ks >= n | already have currentKs, inning data)
function computeLiveProb(lambda, currentKs, currentBF, estimatedTotalBF, strike) {
  if (currentKs >= strike) return 1.0  // already hit threshold
  if (!lambda || lambda <= 0) return 0

  // Observed K rate per BF so far
  const observedRate = currentBF > 0 ? currentKs / currentBF : (lambda / Math.max(estimatedTotalBF, 1))

  // Bayesian blend: weight prior by 9 "synthetic" BF (≈ 3 innings of prior belief),
  // then blend with observed as sample grows. Prior dominates early; observed dominates late.
  const PRIOR_WEIGHT_BF = 9
  const priorRate = lambda / Math.max(estimatedTotalBF, 1)
  const posteriorRate = (priorRate * PRIOR_WEIGHT_BF + observedRate * currentBF) / (PRIOR_WEIGHT_BF + currentBF)

  // Remaining batters faced = estimated total - already faced
  const remainingBF = Math.max(0, estimatedTotalBF - currentBF)
  const lambdaRemaining = posteriorRate * remainingBF

  // Need (strike - currentKs) more Ks in remainingBF batters
  const needed = strike - currentKs
  if (needed <= 0) return 1.0
  if (lambdaRemaining <= 0) return 0

  return pAtLeast(lambdaRemaining, needed)
}

// ── Kalshi live market fetch for KS markets ───────────────────────────────────

async function fetchLiveKsMarkets(ticker) {
  // ticker is like KXMLBKS-26APR202138TORLAA-TORDCEASE84 (pitcher's baseTicker — no threshold suffix)
  // We want all K thresholds for THIS pitcher only: TORDCEASE84-2, -3, -4, ...
  // The API endpoint only accepts an event_ticker (strips the pitcher code), so we filter
  // the response to markets whose ticker starts with this specific pitcher's baseTicker.
  // Without this filter, all pitchers in the same game would be included, causing the
  // false-pull system to buy contracts on the wrong pitcher's markets.
  try {
    const eventTicker = ticker.split('-').slice(0, -1).join('-')  // strip pitcher code → event level
    const headers = getAuthHeaders('GET', `/trade-api/v2/markets`)
    const res = await axios.get(`https://api.elections.kalshi.com/trade-api/v2/markets`, {
      params: { event_ticker: eventTicker, series_ticker: 'KXMLBKS', status: 'open', limit: 20 },
      headers,
      timeout: 10000,
    })
    const all = res.data?.markets || []
    return all.filter(m => m.ticker.startsWith(ticker + '-'))
  } catch { return [] }
}

// ── Daily loss guard ─────────────────────────────────────────────────────────

let _dailyLoss = 0
let _dailyNetPnl = 0  // net P&L today (all settled bets, pre-game + live)
let _dailyReportSent = false  // gate to prevent duplicate EOD Discord reports on crash+restart

async function loadDailyLoss() {
  const rows = await db.all(
    `SELECT SUM(CASE WHEN pnl < 0 THEN ABS(pnl) ELSE 0 END) as losses
       FROM ks_bets WHERE bet_date = ? AND result IN ('win','loss')`,
    [TODAY],
  )
  _dailyLoss = rows[0]?.losses || 0
  return _dailyLoss
}

async function reloadDailyNetPnl() {
  const row = await db.one(
    `SELECT COALESCE(SUM(pnl), 0) as net FROM ks_bets WHERE bet_date = ? AND result IN ('win','loss')`,
    [TODAY],
  )
  _dailyNetPnl = row?.net || 0
  return _dailyNetPnl
}

// ── Place or paper-log a live bet ─────────────────────────────────────────────


async function executeBet({ pitcherName, pitcherId, game, strike, side, modelProb, marketMid, edge, ticker, betSize, kellyFraction, capitalRisk,
  liveKs, liveIP, livePitches, liveBF, liveInning, livePkEffective, liveLambda, liveScore, mode = 'normal', user }) {
  const isLive = LIVE && user?.paper === 0
  const userId = user?.id ?? null
  const creds  = user?.kalshi_key_id
    ? { keyId: user.kalshi_key_id, privateKey: user.kalshi_private_key }
    : {}
  const now    = new Date().toISOString()

  // DB-level dedup
  const existing = await db.one(
    `SELECT id FROM ks_bets WHERE bet_date=? AND pitcher_name=? AND strike=? AND side=? AND live_bet=1 AND user_id IS ?`,
    [TODAY, pitcherName, strike, side, userId],
  )
  if (existing) return { dedup: true }

  let finalContracts = Math.max(1, Math.round(betSize))
  let orderCents     = Math.round(side === 'YES' ? marketMid : 100 - marketMid)  // fallback
  let freeMoneySummary = null  // set below for pulled-mode notifications
  let orderId    = null  // captured from placeOrder response so ksFillSync + WS applier can track it
  let initFilled = 0    // taker orders may fill immediately; capture so the DB row is accurate from the start

  if (isLive) {
    const ob = await getOrderbook(ticker, 10, creds).catch(() => null)

    if (mode === 'pulled' || mode === 'dead-path' || mode === 'crossed-yes' || mode === 'blowout') {
      // ── STRUCTURAL EDGE: taker order — hit the ask immediately ──
      // pulled      → pitcher removed, outcome determined (certainty)
      // crossed-yes → threshold already crossed, YES market hasn't repriced (certainty)
      // blowout     → large deficit late in game, pull imminent (near-certainty)
      // dead-path   → high pitch count, 3+ K gap, market still fat (near-certainty)
      // Speed > fees in all cases; maker orders risk sitting unfilled as market reprices.
      // crossed-yes is a YES taker — skips game_reserves (which track NO-side spending)
      const usesGameReserves = mode !== 'crossed-yes'
      let capUSD = mode === 'dead-path' ? DEAD_PATH_CAP_USD : PULLED_CAP_USD
      if (usesGameReserves && pitcherId && userId) {
        const gameRow = await db.one(
          `SELECT id FROM games WHERE date = ? AND (pitcher_home_id = ? OR pitcher_away_id = ?)`,
          [TODAY, String(pitcherId), String(pitcherId)],
        ).catch(() => null)
        if (gameRow) {
          const reserve = await db.one(
            `SELECT reserved_usd, used_usd, provisional_usd FROM game_reserves
             WHERE game_id = ? AND pitcher_id = ? AND bet_date = ? AND user_id = ?`,
            [gameRow.id, String(pitcherId), TODAY, userId],
          ).catch(() => null)
          if (reserve) {
            capUSD = Math.max(0, reserve.reserved_usd + (reserve.provisional_usd ?? 0) - reserve.used_usd)
          }
        }
      }

      // Dead-path: use Kelly sizing off live posterior probability rather than flat cap.
      // The posterior is passed in as modelProb (updated by P3-A's computeLiveProb).
      // Kelly fraction f = (p*b - (1-p)) / b where b = (1/askFrac - 1) = odds
      // Cap at 2× the pre-game Kelly fraction as sanity limit.
      if ((mode === 'dead-path' || mode === 'blowout') && modelProb > 0.5) {
        const _askFrac    = side === 'NO'
          ? (100 - marketMid) / 100   // approximate: NO ask ≈ NO mid before orderbook
          : marketMid / 100
        const _b          = (1 - _askFrac) / _askFrac   // net odds: win this much per $1 risked
        const _kellyF     = Math.max(0, (modelProb * (_b + 1) - 1) / _b)
        const _bankroll   = capUSD > 0 ? capUSD / 0.15 : 1000  // reverse the 15% reserve calc
        const _kellyBet   = _kellyF * _bankroll * 0.25   // quarter-Kelly conservative
        capUSD = Math.min(capUSD, Math.max(_kellyBet, 10))  // floor $10, capped by reserve
      }

      const askCents = side === 'NO'
        ? (ob?.best_no_ask  ?? Math.min(99, Math.round(100 - marketMid + 2)))
        : (ob?.best_yes_ask ?? Math.min(99, Math.round(marketMid + 2)))
      const maxByDollars = Math.floor(capUSD / (askCents / 100))
      const depth        = ob ? availableDepth(ob, side.toLowerCase(), askCents) : maxByDollars
      finalContracts     = Math.max(1, Math.min(maxByDollars, depth > 0 ? depth : maxByDollars))
      orderCents         = askCents
      const expectedProfit = finalContracts * ((100 - askCents) / 100) * 0.93  // after Kalshi fee

      // API dedup: skip if we already have fills or resting orders on this ticker+side
      try {
        const sideKey = side.toLowerCase()
        const [existingFills, restingOrders] = await Promise.all([
          getFills({ ticker, limit: 200 }, creds).catch(() => []),
          listOrders({ ticker, status: 'resting' }, creds).catch(() => []),
        ])
        const filledContracts = existingFills.filter(f => f.side === sideKey).reduce((s, f) => s + Number(f.count_fp || 0), 0)
        const restingContracts = restingOrders.filter(o => o.side === sideKey).reduce((s, o) => s + Number(o.remaining_count || o.count || 0), 0)
        if (filledContracts + restingContracts > 0) {
          console.log(`  [dedup] ${pitcherName} ${strike}+ ${side} (${user?.name}) — already ${filledContracts} filled + ${restingContracts} resting on Kalshi, skipping`)
          return { freeMoneySummary: null, kalshiDedup: true }
        }
      } catch { /* non-fatal */ }

      try {
        const betTag  = mode === 'pulled'     ? '💰 FREE MONEY TAKER'
                      : mode === 'crossed-yes'? '🟢 CROSSED-YES TAKER'
                      : mode === 'blowout'    ? '🏳️ BLOWOUT TAKER'
                      :                        '🚫 DEAD PATH TAKER'
        const logTag  = mode === 'pulled'     ? 'FREE MONEY'
                      : mode === 'crossed-yes'? 'CROSSED YES'
                      : mode === 'blowout'    ? 'BLOWOUT'
                      :                        'DEAD PATH'
        const placed  = await placeOrder(ticker, side.toLowerCase(), finalContracts, askCents, creds)
        const placedOrder = placed?.order ?? placed
        orderId    = placedOrder?.order_id ?? null
        initFilled = Math.round(parseFloat(placedOrder?.fill_count_fp ?? '0'))
        console.log(`\n  [${betTag}] ${user?.name} ${pitcherName} ${strike}+ ${side} ${finalContracts}c @ ${askCents}¢  profit≈+$${expectedProfit.toFixed(2)}`)
        db.saveLog({ tag: 'BET', msg: `[${logTag}] ${pitcherName} ${strike}+ ${side} ${finalContracts}c @ ${askCents}¢ taker  profit≈+$${expectedProfit.toFixed(2)}`, pitcher: pitcherName, strike, side })
        freeMoneySummary = { askCents, expectedProfit, yesPrice: Math.round(100 - askCents) }

        // Track spending against this pitcher's reserve
        if (pitcherId && userId) {
          const gameRow2 = await db.one(
            `SELECT id FROM games WHERE date = ? AND (pitcher_home_id = ? OR pitcher_away_id = ?)`,
            [TODAY, String(pitcherId), String(pitcherId)],
          ).catch(() => null)
          if (gameRow2) {
            const spent = finalContracts * (askCents / 100)
            await db.run(
              `UPDATE game_reserves SET used_usd = used_usd + ?
               WHERE game_id = ? AND pitcher_id = ? AND bet_date = ? AND user_id = ?`,
              [spent, gameRow2.id, String(pitcherId), TODAY, userId],
            ).catch(() => {})
          }
        }
      } catch (err) {
        console.error(`  [ORDER FAILED] ${user?.name} ${pitcherName} ${strike}+ ${side}: ${err.message}`)
        db.saveLog({ tag: 'ERROR', level: 'error', msg: `ORDER FAILED [FREE MONEY] ${pitcherName} ${strike}+ ${side}: ${err.message}`, pitcher: pitcherName, strike, side })
        return { freeMoneySummary: null, apiFailed: true }
      }

    } else {
      // ── NORMAL EDGE: maker at ask-1¢, 75% fee discount ──
      // Check budget cap for normal bets only; pulled bets are capped by PULLED_CAP_USD above.
      let bankroll = user?.starting_bankroll || 1000
      if (user?.kalshi_key_id) {
        try {
          const kb = await getKalshiBalance(creds)
          bankroll = kb.balance_usd
        } catch {}
      }
      const cap   = bankroll * (user?.live_daily_risk_pct ?? user?.daily_risk_pct ?? 0.20)
      const spent = await db.one(
        `SELECT COALESCE(SUM(capital_at_risk), 0) as total FROM ks_bets WHERE bet_date=? AND live_bet=1 AND user_id=? AND result IS NULL`,
        [TODAY, userId],
      )
      const thisCap = capitalAtRisk(betSize, Math.round(side === 'YES' ? marketMid : 100 - marketMid) / 100, side)
      if ((spent?.total || 0) + thisCap > cap) {
        console.log(`  [CAP] ${user?.name} ${pitcherName} ${strike}+ ${side} skipped — live cap $${cap.toFixed(0)} reached`)
        return { freeMoneySummary: null, budget: true }
      }

      let askCents = side === 'YES'
        ? Math.min(99, Math.round(marketMid + 2))
        : Math.min(99, Math.round(100 - marketMid + 2))
      if (ob) {
        if (side === 'YES' && ob.best_yes_ask != null) askCents = ob.best_yes_ask
        if (side === 'NO'  && ob.best_no_ask  != null) askCents = ob.best_no_ask
        const depth = availableDepth(ob, side.toLowerCase(), askCents)
        if (depth > 0 && finalContracts > depth) {
          console.log(`  [depth] ${pitcherName} ${strike}+ ${side}: capping ${finalContracts}→${depth}c`)
          finalContracts = depth
        }
      }
      const makerCents = Math.max(1, askCents - 1)
      orderCents = makerCents

      // API dedup: skip if we already have fills or resting orders on this ticker+side
      try {
        const sideKey = side.toLowerCase()
        const [existingFills, restingOrders] = await Promise.all([
          getFills({ ticker, limit: 200 }, creds).catch(() => []),
          listOrders({ ticker, status: 'resting' }, creds).catch(() => []),
        ])
        const filledContracts = existingFills.filter(f => f.side === sideKey).reduce((s, f) => s + Number(f.count_fp || 0), 0)
        const restingContracts = restingOrders.filter(o => o.side === sideKey).reduce((s, o) => s + Number(o.remaining_count || o.count || 0), 0)
        if (filledContracts + restingContracts > 0) {
          console.log(`  [dedup] ${pitcherName} ${strike}+ ${side} (${user?.name}) — already ${filledContracts} filled + ${restingContracts} resting on Kalshi, skipping`)
          return { freeMoneySummary: null, kalshiDedup: true }
        }
      } catch { /* non-fatal */ }

      try {
        const placed2     = await placeOrder(ticker, side.toLowerCase(), finalContracts, makerCents, creds)
        const placedOrder2 = placed2?.order ?? placed2
        orderId    = placedOrder2?.order_id ?? null
        initFilled = Math.round(parseFloat(placedOrder2?.fill_count_fp ?? '0'))
        console.log(`  [LIVE MAKER] ${user?.name} ${pitcherName} ${strike}+ ${side} ${finalContracts}c @ ${makerCents}¢ (ask ${askCents}¢)`)
        db.saveLog({ tag: 'BET', msg: `${pitcherName} ${strike}+ ${side} ${finalContracts}c @ ${makerCents}¢ (ask ${askCents}¢)`, pitcher: pitcherName, strike, side })
      } catch (err) {
        console.error(`  [ORDER FAILED] ${user?.name} ${pitcherName} ${strike}+ ${side}: ${err.message}`)
        db.saveLog({ tag: 'ERROR', level: 'error', msg: `ORDER FAILED ${pitcherName} ${strike}+ ${side}: ${err.message}`, pitcher: pitcherName, strike, side })
        return { freeMoneySummary: null, apiFailed: true }
      }
    }
  } else {
    const _modeLabel = { pulled: '💰 FREE MONEY', 'crossed-yes': '🟢 CROSSED-YES', blowout: '🏳️ BLOWOUT', 'dead-path': '🚫 DEAD PATH' }[mode] ?? 'EDGE'
    console.log(`  [PAPER ${_modeLabel}] ${user?.name ?? 'unknown'} ${pitcherName} ${strike}+ ${side} @ ${marketMid}¢  edge=${(edge*100).toFixed(1)}¢  size=$${betSize}`)
    if (mode === 'pulled' || mode === 'crossed-yes' || mode === 'blowout' || mode === 'dead-path') {
      const askCents = side === 'NO' ? Math.round(100 - marketMid) : Math.round(marketMid)
      freeMoneySummary = { askCents, expectedProfit: finalContracts * ((100 - askCents) / 100) * 0.93, yesPrice: Math.round(marketMid) }
    }
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
    paper:                isLive ? 0 : 1,
    live_bet:             1,
    ticker,
    bet_mode:             mode,
    fill_price:           isLive ? orderCents : null,
    order_id:             orderId,
    filled_contracts:     initFilled || null,
    order_status:         orderId ? (initFilled >= finalContracts ? 'filled' : 'resting') : null,
    live_ks_at_bet:       liveKs       ?? null,
    live_ip_at_bet:       liveIP       ?? null,
    live_pitches_at_bet:  livePitches  ?? null,
    live_bf_at_bet:       liveBF       ?? null,
    live_inning:          liveInning   ?? null,
    live_pk_effective:    livePkEffective ?? null,
    live_lambda_remaining: liveLambda  ?? null,
    live_score:           liveScore    ?? null,
  }, ['bet_date', 'pitcher_name', 'strike', 'side', 'live_bet', 'user_id'])

  return { freeMoneySummary, finalContracts, orderCents }
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

    // Pre-game resting orders that never filled — void them, no real money was risked.
    if (!bet.live_bet && !bet.filled_contracts) {
      await db.run(
        `UPDATE ks_bets SET result='void', pnl=0, settled_at=? WHERE id=?`,
        [now, bet.id],
      )
      continue
    }

    const hit = actualKs >= bet.strike
    const won = bet.side === 'YES' ? hit : !hit

    // P&L: use Kalshi's revenue minus our cost basis.
    // profit_loss is always 0 in their API; revenue is the actual cash credited.
    let pnl
    const fillCents = bet.fill_price ?? bet.market_mid ?? 50
    let contracts
    if (bet.filled_contracts != null) {
      contracts = bet.filled_contracts
    } else if (bet.capital_at_risk != null && fillCents > 0) {
      contracts = Math.max(1, Math.round((bet.capital_at_risk * 100) / fillCents))
    } else {
      contracts = Math.max(1, Math.round((bet.bet_size || 100) * 100 / Math.max(1, fillCents)))
      console.warn(`[settle] ${bet.pitcher_name} ${bet.strike}+ ${bet.side}: contracts estimated from bet_size`)
    }
    const fillPrice = fillCents  // cents — kept for P&L math below
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
    if (pnl == null && bet.live_bet && !bet.filled_contracts) {
      // Live bet with no fill data — defer to ksSettlementSync for correct P&L.
      // Still credit any provisional debit so rebalance budget doesn't stay inflated.
      await postProvisionalCredit(bet.id, bet.user_id, 'game-settled-no-fill').catch(() => {})
      continue
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
    // Zero out any provisional debit for this bet — real cash now credited by Kalshi
    await postProvisionalCredit(bet.id, bet.user_id, 'game-settled').catch(() => {})
    settled.push({ ...bet, actual_ks: actualKs, result: won ? 'win' : 'loss', pnl })
  }

  if (!settled.length) return

  const gamePnl = settled.reduce((s, b) => s + (b.pnl || 0), 0)
  const wins = settled.filter(b => b.result === 'win').length
  const losses = settled.length - wins
  console.log(`\n[live] ${gameLabel} settled: ${wins}W/${losses}L  ${gamePnl >= 0 ? '+' : ''}$${gamePnl.toFixed(2)}`)
  db.saveLog({ tag: 'SETTLED', msg: `${gameLabel}  ${wins}W/${losses}L  ${gamePnl >= 0 ? '+' : ''}$${gamePnl.toFixed(2)}`, pnl: gamePnl })

  await notifyGameResult({ game: gameLabel, bets: settled, gamePnl }, await getAllWebhooks(db))

  // Rebalance pending allocations now that the account balance has changed
  await rebalancePendingAllocations().catch(() => {})
}

// ── Provisional debit/credit ledger ──────────────────────────────────────────
//
// When a pitcher is confirmed pulled AND the game is official (≥5 innings), any
// filled NO bets above the current K count are near-certain winners. The capital
// for those bets is locked on Kalshi waiting for settlement. This system lets us
// treat 20% of that locked payout as available for pre-game rebalancing and 10%
// as available for in-game reserves — effectively "borrowing from ourselves."
//
// Accounting:
//   debit  — posted at pull confirmation, amount = full expected net payout
//   credit — posted at game settlement (same amount), zeroing the debit
//   net    = 0 after settlement; no double-counting at any step

async function postProvisionalDebits(pitcherId, gameId, currentKs, numericInning, userId) {
  if (numericInning < 5) return  // game not official yet

  const winningBets = await db.all(
    `SELECT id, filled_contracts, fill_price, strike
     FROM ks_bets
     WHERE bet_date = ? AND pitcher_id = ? AND user_id = ?
       AND side = 'NO' AND live_bet = 1
       AND filled_contracts > 0 AND result IS NULL AND strike > ?`,
    [TODAY, String(pitcherId), userId, currentKs],
  )
  if (!winningBets.length) return

  let totalDebit = 0
  for (const bet of winningBets) {
    const fillFrac      = (bet.fill_price ?? 20) / 100
    // Full net payout = contracts × (1 - 7% Kalshi fee on profit portion)
    const expectedPayout = bet.filled_contracts * (1 - 0.07 * (1 - fillFrac))

    const ins = await db.run(
      `INSERT OR IGNORE INTO provisional_ledger
         (user_id, bet_date, ks_bet_id, game_id, pitcher_id, type, amount_usd, reason)
       VALUES (?, ?, ?, ?, ?, 'debit', ?, 'pull-confirmed')`,
      [userId, TODAY, bet.id, gameId, String(pitcherId), expectedPayout],
    ).catch(() => ({ rowsAffected: 0 }))
    // Only count rows actually inserted (INSERT OR IGNORE returns rowsAffected=0 for skips)
    if ((ins?.rowsAffected ?? 0) > 0) totalDebit += expectedPayout
  }

  // Recalculate in-game provision from full ledger total (INSERT OR IGNORE skips dupes,
  // so totalDebit only reflects NEW bets this call — must re-query to get cumulative)
  const ledgerRow = await db.one(
    `SELECT COALESCE(SUM(CASE WHEN type='debit' THEN amount_usd ELSE -amount_usd END),0) AS net
     FROM provisional_ledger WHERE game_id=? AND pitcher_id=? AND bet_date=? AND user_id=?`,
    [gameId, String(pitcherId), TODAY, userId],
  ).catch(() => ({ net: 0 }))
  const totalNet       = Math.max(0, ledgerRow?.net ?? 0)
  const inGameProvision = totalNet * 0.10
  await db.run(
    `UPDATE game_reserves SET provisional_usd = ? WHERE game_id=? AND pitcher_id=? AND bet_date=? AND user_id=?`,
    [inGameProvision, gameId, String(pitcherId), TODAY, userId],
  ).catch(() => {})
  if (totalDebit > 0) {
    console.log(`[provisional] ${String(pitcherId)} debit +$${totalDebit.toFixed(2)}  in-game provision now $${inGameProvision.toFixed(2)}`)
  }
}

async function postProvisionalCredit(betId, userId, reason = 'game-settled') {
  const debit = await db.one(
    `SELECT amount_usd FROM provisional_ledger WHERE ks_bet_id = ? AND type = 'debit'`,
    [betId],
  ).catch(() => null)
  if (!debit) return  // no outstanding debit — nothing to zero out

  await db.run(
    `INSERT OR IGNORE INTO provisional_ledger
       (user_id, bet_date, ks_bet_id, game_id, pitcher_id, type, amount_usd, reason)
     SELECT user_id, bet_date, ks_bet_id, game_id, pitcher_id, 'credit', amount_usd, ?
     FROM provisional_ledger WHERE ks_bet_id = ? AND type = 'debit'`,
    [reason, betId],
  ).catch(() => {})
}

// ── Post-settlement allocation rebalance ──────────────────────────────────────
// After each game settles, the account balance changes (wins add cash, losses remove it).
// Re-compute each user's remaining daily budget and redistribute it proportionally
// across pending bet_schedule entries so late-game allocations reflect real P&L.
async function rebalancePendingAllocations() {
  try {
    const pending = await db.all(
      `SELECT bs.id, bs.pitcher_id, bs.pitcher_name, bs.game_label,
              dp.best_edge, dp.n_edges
       FROM bet_schedule bs
       LEFT JOIN decision_pipeline dp
             ON dp.bet_date = bs.bet_date AND dp.pitcher_id = bs.pitcher_id
       WHERE bs.bet_date = ? AND bs.status = 'pending'`,
      [TODAY],
    )
    if (!pending.length) return

    const users = await db.all(`SELECT * FROM users WHERE active_bettor = 1`)

    for (const user of users) {
      // Fetch live Kalshi balance
      let bankroll = user.starting_bankroll || 1000
      if (user.kalshi_key_id) {
        try {
          const creds = { keyId: user.kalshi_key_id, privateKey: user.kalshi_private_key }
          const kb = await getKalshiBalance(creds)
          bankroll = kb.balance_usd
        } catch {}
      }

      const dailyBudget = bankroll * (user.live_daily_risk_pct ?? user.daily_risk_pct ?? 0.20)

      // Subtract capital already committed to fired pre-game bets
      const spentRow = await db.one(
        `SELECT COALESCE(SUM(capital_at_risk), 0) AS spent
         FROM ks_bets
         WHERE bet_date = ? AND user_id = ? AND live_bet = 0 AND paper = 0
           AND order_status NOT IN ('cancelled', 'void')`,
        [TODAY, user.id],
      ).catch(() => ({ spent: 0 }))
      const spent = spentRow?.spent ?? 0

      const remaining = Math.max(0, dailyBudget - spent)

      // Add 20% of outstanding provisional capital (locked Kalshi wins not yet settled)
      const provRow = await db.one(
        `SELECT COALESCE(SUM(CASE WHEN type='debit' THEN amount_usd ELSE -amount_usd END), 0) AS net
         FROM provisional_ledger WHERE bet_date = ? AND user_id = ?`,
        [TODAY, user.id],
      ).catch(() => ({ net: 0 }))
      const provNet   = Math.max(0, provRow?.net ?? 0)
      const available = remaining + provNet * 0.20

      if (available <= 0) continue

      // Edge-weighted split across pending pitchers
      const totalEdge = pending.reduce((s, p) => s + Math.max(0, p.best_edge ?? 0), 0)

      for (const entry of pending) {
        const share = totalEdge > 0
          ? Math.max(0, entry.best_edge ?? 0) / totalEdge
          : 1 / pending.length
        const alloc = Math.round(share * available * 100) / 100
        await db.run(
          `UPDATE bet_schedule SET allocated_usd = ? WHERE id = ?`,
          [alloc, entry.id],
        ).catch(() => {})
      }

      const provTag = provNet > 0 ? `  provisional=$${(provNet * 0.20).toFixed(0)}` : ''
      console.log(`[rebalance] ${user.name}: balance=$${bankroll.toFixed(0)} spent=$${spent.toFixed(0)} remaining=$${remaining.toFixed(0)}${provTag} available=$${available.toFixed(0)} → split across ${pending.length} pending pitchers`)
    }
  } catch (err) {
    console.error(`[rebalance] error: ${err.message}`)
  }
}

// ── End-of-day report ─────────────────────────────────────────────────────────

async function sendDailyReport() {
  if (_dailyReportSent) {
    console.log('[daily-report] already sent today — skipping duplicate')
    return
  }
  _dailyReportSent = true
  const bets = await db.all(
    `SELECT * FROM ks_bets WHERE bet_date = ? ORDER BY result DESC, edge DESC`,
    [TODAY],
  )

  const settled  = bets.filter(b => b.result != null)
  const liveBets = settled.filter(b => !b.paper || b.paper === 0)
  const dayPnl   = liveBets.reduce((s, b) => s + (b.pnl || 0), 0)
  const wins     = liveBets.filter(b => b.result === 'win')

  // Season stats
  const season = await db.all(
    `SELECT SUM(pnl) as pnl, COUNT(*) as n,
            SUM(CASE WHEN result='win' THEN 1 ELSE 0 END) as w,
            SUM(bet_size) as wagered
       FROM ks_bets WHERE result IN ('win','loss') AND (paper = 0 OR paper IS NULL)`,
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

// Load per-user Kalshi credentials for a batch of ks_bets rows.
// Kalshi 404s when an order is looked up under the wrong account, so every
// cancel/place/getOrder must auth as the row's owner, not the env default.
async function _loadCredsForBets(bets) {
  const credsMap = new Map()
  const userIds = [...new Set(bets.map(b => b.user_id).filter(Boolean))]
  if (!userIds.length) return credsMap
  const users = await db.all(
    `SELECT id, kalshi_key_id, kalshi_private_key FROM users WHERE id IN (${userIds.map(() => '?').join(',')})`,
    userIds,
  )
  for (const u of users) {
    if (u.kalshi_key_id) credsMap.set(u.id, { keyId: u.kalshi_key_id, privateKey: u.kalshi_private_key })
  }
  return credsMap
}


// ── 30-min stale maker → taker conversion ────────────────────────────────────
//
// Runs every poll cycle. Any resting maker order that hasn't filled within
// 30 minutes of posting is cancelled and re-placed as a taker — provided edge
// still exists at the current market price (same half-threshold as T-45).
//
// Triggered by time-since-posting (filled_at), not time-to-game.
// T-90 and T-45 checks remain as safety nets but will typically find nothing.

const _convertedBetIds = new Set()

// Module-level cache: written each poll cycle inside the per-game loop so that
// convertStaleMakers() (which runs BEFORE the game loop) can access the live
// game state from the previous poll cycle when re-evaluating edge.
// Map: pitcherId (string) → { currentKs, currentIP, currentPitches, currentBF, scoreDiff, ctx }
const _liveGameStateCache = new Map()

async function convertStaleMakers() {
  if (!LIVE) return

  const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString()

  const stale = await db.all(
    `SELECT * FROM ks_bets
      WHERE bet_date = ? AND order_status = 'resting' AND result IS NULL
        AND paper = 0
        AND COALESCE(filled_at, logged_at) <= ?`,
    [TODAY, cutoff],
  )

  if (!stale.length) return

  const credsMap = await _loadCredsForBets(stale)

  for (const bet of stale) {
    if (_convertedBetIds.has(bet.id)) continue
    if (!bet.order_id || !bet.ticker) { _convertedBetIds.add(bet.id); continue }

    const creds = credsMap.get(bet.user_id) ?? {}
    if (!creds.keyId) {
      console.error(`  [stale-maker] no creds for user_id=${bet.user_id} (${bet.pitcher_name}) — skipping`)
      _convertedBetIds.add(bet.id)
      continue
    }

    try {
      const order  = await getOrder(bet.order_id, creds)
      const filled = order?.status === 'executed' ||
                     Number(order?.remaining_count_fp ?? order?.remaining_count ?? 0) === 0

      if (filled) {
        _convertedBetIds.add(bet.id)
        const priceDollars   = order?.yes_price_dollars ?? order?.no_price_dollars ?? null
        const fillPriceCents = priceDollars
          ? Math.round(parseFloat(priceDollars) * 100)
          : (order?.yes_price ?? order?.no_price ?? null)
        const filledCount = Math.round(parseFloat(order?.fill_count_fp ?? '0'))
        await db.run(
          `UPDATE ks_bets SET order_status='filled', fill_price=COALESCE(?, fill_price), filled_contracts=? WHERE id=?`,
          [fillPriceCents, filledCount || null, bet.id],
        )
        console.log(`\n[live] ✓ stale-check: ${bet.pitcher_name} ${bet.side} ${bet.strike}+ filled ${filledCount}c @ ${fillPriceCents ?? '?'}¢ (maker)`)
        continue
      }

      // Not filled after 30 min — cancel and re-evaluate
      await cancelOrder(bet.order_id, creds)
      console.log(`\n[live] ⏱ stale maker: ${bet.pitcher_name} ${bet.side} ${bet.strike}+ (${bet.ticker}) — 30min unfilled, cancelling`)

      const mkt = await getMarketPrice(bet.ticker)
      if (!mkt) {
        _convertedBetIds.add(bet.id)
        await db.run(`UPDATE ks_bets SET order_status='cancelled' WHERE id=?`, [bet.id])
        console.log(`  → no market data, skipping`)
        continue
      }

      const currentAsk = bet.side === 'YES' ? mkt.ask : (1 - mkt.bid)

      // B13 fix: use a fresh live-model probability if we have cached game state
      // from the previous poll cycle; fall back to the stale DB value only when
      // no live data is available (e.g. pre-game makers or first poll after restart).
      const liveState = _liveGameStateCache.get(String(bet.pitcher_id))
      let modelProb
      if (liveState?.ctx) {
        const live = computeLiveModel(
          liveState.ctx,
          liveState.currentKs,
          liveState.currentIP,
          liveState.currentPitches,
          liveState.currentBF,
          liveState.scoreDiff,
        )
        modelProb = live.probAtLeast(bet.strike)
        console.log(`  → fresh model_prob=${(modelProb * 100).toFixed(1)}% (was ${((bet.model_prob ?? 0.5) * 100).toFixed(1)}% at placement)`)
      } else {
        modelProb = bet.model_prob ?? 0.5
      }

      const currentEdge = modelProb - currentAsk

      if (currentEdge < LIVE_EDGE / 2) {
        _convertedBetIds.add(bet.id)
        await db.run(`UPDATE ks_bets SET order_status='cancelled' WHERE id=?`, [bet.id])
        console.log(`  → edge gone (${(currentEdge * 100).toFixed(1)}¢ at ${(currentAsk * 100).toFixed(0)}¢ ask), skipping`)
        continue
      }

      // Edge still good — take the market
      const takerCents    = Math.min(99, Math.round(currentAsk * 100) + 1)
      const computedContracts = Math.max(1, Math.round(bet.bet_size ?? 100))
      // Deduct already-filled contracts so we don't over-expose beyond original Kelly intent
      const alreadyFilled  = bet.filled_contracts ?? 0
      const takerContracts = Math.max(0, computedContracts - alreadyFilled)
      if (takerContracts === 0) {
        console.log(`  [stale-maker] ${bet.pitcher_name} ${bet.strike}+ already fully filled — no taker needed`)
        _convertedBetIds.add(bet.id)
        await db.run(`UPDATE ks_bets SET order_status='filled' WHERE id=?`, [bet.id])
        continue
      }
      const result     = await placeOrder(bet.ticker, bet.side.toLowerCase(), takerContracts, takerCents, creds)
      const order2     = result?.order ?? result
      const newOrderId = order2?.order_id ?? null
      const newStatus  = order2?.status ?? 'placed'

      _convertedBetIds.add(bet.id)
      await db.run(
        `UPDATE ks_bets SET order_id=?, fill_price=?, order_status=?, market_mid=?, filled_at=? WHERE id=?`,
        [newOrderId, takerCents, newStatus, Math.round(currentAsk * 100), new Date().toISOString(), bet.id],
      )
      console.log(`  → TAKER placed ${takerContracts}c @ ${takerCents}¢  edge=${(currentEdge * 100).toFixed(1)}¢  id=${newOrderId}  (${alreadyFilled} already filled as maker)`)
    } catch (err) {
      console.error(`  [stale-maker] error for ${bet.pitcher_name}: ${err.message}`)
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
  // B4 fix: require a live market snapshot before placing the taker so we never
  // send an order at a fabricated price derived from stale DB data.
  if (!market) {
    console.log(`  [queue] ${bet.pitcher_name} ${bet.strike}+ ${bet.side} — no live market snapshot, skipping cancel+taker`)
    return
  }
  try {
    await cancelOrder(bet.order_id, creds)
    const contracts = Math.max(1, Math.round(bet.bet_size / ((bet.fill_price ?? bet.market_mid ?? 50) / 100)))
    const takerPrice = bet.side === 'YES'
      ? Math.min(99, market.yes_ask + 1)
      : Math.min(99, market.no_ask  + 1)
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

// ── Reconcile live bet fills from Kalshi at game-end ─────────────────────────
//
// Belt-and-suspenders: even if wsFillApplier or ksFillSync missed an update
// (e.g. WS disconnect, or bet was placed before order_id fix deployed), this
// runs once per game when state → Final and patches any live bets that still
// have no fill data. Queries Kalshi fills by ticker so it works even for bets
// with null order_id.

async function reconcileLiveFills(game) {
  const gameLabel = `${game.team_away}@${game.team_home}`
  const liveBets = await db.all(
    `SELECT * FROM ks_bets
      WHERE bet_date = ? AND game = ? AND live_bet = 1 AND result IS NULL
        AND (filled_contracts IS NULL OR filled_contracts = 0)`,
    [TODAY, gameLabel],
  )
  if (!liveBets.length) return

  const credsMap = await _loadCredsForBets(liveBets)
  const fillsByTicker = new Map()  // ticker → fills[]

  for (const bet of liveBets) {
    const creds = credsMap.get(bet.user_id) ?? {}
    if (!creds.keyId) continue
    const ticker = bet.ticker
    if (!ticker) continue

    try {
      if (!fillsByTicker.has(ticker)) {
        const fills = await getFills({ ticker, limit: 200 }, creds).catch(() => [])
        fillsByTicker.set(ticker, fills)
      }
      const fills = fillsByTicker.get(ticker) || []
      const sideKey = (bet.side || 'no').toLowerCase()
      const filled = fills
        .filter(f => f.side === sideKey && f.action === 'buy')
        .reduce((s, f) => s + Math.round(parseFloat(f.count_fp || 0)), 0)
      if (filled > 0) {
        await db.run(
          `UPDATE ks_bets SET filled_contracts = ?, order_status = 'filled' WHERE id = ?`,
          [filled, bet.id],
        )
        console.log(`[reconcile-fills] bet ${bet.id} ${ticker}: backfilled ${filled} contracts from Kalshi`)
      }
    } catch (err) {
      console.error(`[reconcile-fills] error for bet ${bet.id}: ${err.message}`)
    }
  }
}

// ── Cancel pre-game resting orders the moment a game goes live ───────────────
//
// Pre-game resting orders are placed at stale pre-game prices. Once the first
// pitch is thrown, live K data makes those prices obsolete. The worst outcome
// is filling mid-game at a price that's now wrong: you only fill when the market
// moves against you (someone hits your limit when your edge has evaporated).
// So we cancel all unfilled pre-game makers the moment the game starts.

async function cancelPreGameOrders(game) {
  const gameLabel = `${game.team_away}@${game.team_home}`
  const gameLabel2 = `${game.team_away}@${game.team_home}`
  const restingBets = await db.all(
    `SELECT * FROM ks_bets
      WHERE bet_date = ? AND live_bet = 0 AND order_status = 'resting' AND result IS NULL
        AND (pitcher_id = ? OR pitcher_id = ? OR (pitcher_id IS NULL AND game = ?))`,
    [TODAY, game.pitcher_home_id, game.pitcher_away_id, gameLabel2],
  )
  if (!restingBets.length) return

  const credsMap = await _loadCredsForBets(restingBets)
  console.log(`\n[live] 🚫 GAME STARTED — cancelling ${restingBets.length} pre-game resting order(s) for ${gameLabel}`)

  for (const bet of restingBets) {
    const creds = credsMap.get(bet.user_id) ?? {}
    try {
      if (bet.order_id && creds.keyId) await cancelOrder(bet.order_id, creds)
      if ((bet.filled_contracts ?? 0) > 0) {
        // Partially filled — cancel the resting portion but leave result=NULL so settlement handles the filled contracts
        await db.run(
          `UPDATE ks_bets SET order_status='cancelled', settled_at=? WHERE id=?`,
          [new Date().toISOString(), bet.id],
        )
        console.log(`  ⚠ ${bet.pitcher_name} ${bet.strike}+ ${bet.side} — partial fill (${bet.filled_contracts}c), cancelling resting portion only`)
      } else {
        await db.run(
          `UPDATE ks_bets SET order_status='cancelled', result='void', pnl=0, settled_at=? WHERE id=?`,
          [new Date().toISOString(), bet.id],
        )
        console.log(`  ✗ ${bet.pitcher_name} ${bet.strike}+ ${bet.side} — pre-game order cancelled at first pitch`)
      }
    } catch (err) {
      console.error(`  [cancel-pregame] error for ${bet.pitcher_name}: ${err.message}`)
    }
  }
  db.saveLog({ tag: 'INFO', msg: `${gameLabel} started — cancelled ${restingBets.length} pre-game resting orders` })
}

// ── Initialize per-pitcher false-pull budget when game goes live ──────────────
// Reserves a capped slice of each user's daily budget for false-pull/dead-path
// taker orders. Prevents simultaneous pulls from competing for the same cash.
async function initGameReserves(game) {
  const gameLabel = `${game.team_away}@${game.team_home}`
  const users = await db.all(`SELECT * FROM users WHERE active_bettor = 1`).catch(() => [])
  const pitcherIds = [game.pitcher_home_id, game.pitcher_away_id].filter(Boolean)

  for (const user of users) {
    const creds = { keyId: user.kalshi_key_id, privateKey: user.kalshi_private_key }
    let bankroll = user.starting_bankroll || 1000
    if (user.kalshi_key_id) {
      try {
        const kb = await getKalshiBalance(creds)
        bankroll = kb.balance_usd
      } catch {}
    }
    // Reserve up to 15% of daily budget per pitcher, capped at $400
    const dailyBudget = bankroll * (user.daily_risk_pct ?? 0.20)
    const reservePerPitcher = Math.min(400, dailyBudget * 0.15)

    for (const pitcherId of pitcherIds) {
      await db.run(
        `INSERT OR IGNORE INTO game_reserves
           (game_id, pitcher_id, bet_date, user_id, reserved_usd, used_usd, created_at)
         VALUES (?, ?, ?, ?, ?, 0, ?)`,
        [game.id, String(pitcherId), TODAY, user.id, reservePerPitcher, new Date().toISOString()],
      ).catch(() => {})
    }
  }
  const sampleUser = users[0]
  const sampleBankroll = sampleUser ? (sampleUser.starting_bankroll || 1000) : 1000
  const sampleReserve = sampleUser ? Math.min(400, sampleBankroll * (sampleUser.daily_risk_pct ?? 0.20) * 0.15) : 0
  const totalReserved = users.length * pitcherIds.length * sampleReserve
  console.log(`[live] Reserves initialized for ${gameLabel}: $${totalReserved.toFixed(0)} total (${users.length} users × ${pitcherIds.length} pitchers)`)
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

    // Per-pitcher average IP from recent starts (replaces hardcoded 5.2 league default)
    const ipStarts = starts.filter(s => s.ip > 0)
    const avgIp = ipStarts.length
      ? ipStarts.reduce((s, r) => s + Number(r.ip), 0) / ipStarts.length
      : 5.2

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
      avgIp,
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

  // Per-user live/paper banner — catches the case where LIVE_TRADING=true but a user still has paper=1
  if (LIVE) {
    const bettors = await db.all(`SELECT id, name, paper, kalshi_key_id FROM users WHERE active_bettor = 1`)
    const paperBettors = bettors.filter(u => u.paper !== 0)
    const liveBettors  = bettors.filter(u => u.paper === 0 && u.kalshi_key_id)
    const noCredsLive  = bettors.filter(u => u.paper === 0 && !u.kalshi_key_id)
    for (const u of liveBettors)  console.log(`  [live] ✅ ${u.name} — LIVE (paper=0, has creds)`)
    for (const u of paperBettors) console.log(`  [live] 📄 ${u.name} — PAPER despite LIVE_TRADING=true (paper=${u.paper})`)
    for (const u of noCredsLive)  console.log(`  [live] ⚠  ${u.name} — paper=0 but NO Kalshi creds — orders will fail`)
  }

  console.log(`[live] Polling every ${POLL_SEC}s. Ctrl+C to stop.\n`)
  db.saveLog({ tag: 'STARTUP', msg: `Mode=${LIVE ? 'LIVE' : 'PAPER'}  edge≥${(LIVE_EDGE*100).toFixed(0)}¢  pitchers=${allPitcherIds.size}  games=${games.length}` })

  // Write heartbeat to agent_heartbeat so dashboard can show Closer status
  const COMMIT = process.env.COMMIT_SHA || 'unknown'
  async function writeHeartbeat(status = 'running') {
    const payload = JSON.stringify({ commit: COMMIT, status, ts: new Date().toISOString() })
    await db.run(
      `INSERT OR REPLACE INTO agent_heartbeat (key, value, updated_at) VALUES ('closer', ?, ?)`,
      [payload, new Date().toISOString()],
    ).catch(() => {})
  }
  await writeHeartbeat('running')
  const _hbTimer = setInterval(() => writeHeartbeat('running'), 60_000)
  // Ensure heartbeat stops cleanly on exit
  process.on('SIGINT',  () => { clearInterval(_hbTimer); writeHeartbeat('offline').finally(() => process.exit(0)) })
  process.on('SIGTERM', () => { clearInterval(_hbTimer); writeHeartbeat('offline').finally(() => process.exit(0)) })

  // Track which in-game bets we've already placed this session (avoid dups)
  const placed = new Set()
  // Hydrate from DB so restarts don't re-place bets already submitted this session
  const todayLiveBets = await db.all(
    `SELECT user_id, pitcher_id, strike FROM ks_bets
     WHERE bet_date = ? AND live_bet = 1 AND order_status IS NOT NULL`,
    [TODAY],
  ).catch(() => [])
  for (const b of todayLiveBets) {
    const betKey = `${b.pitcher_id}-${b.strike}-live`
    placed.add(`${b.user_id}:${betKey}`)
  }
  console.log(`[live] Hydrated placed Set with ${placed.size} existing live bets from DB`)
  // Track cover/dead/one-away alerts already sent
  const covered = new Set()
  const dead    = new Set()
  const noLost  = new Set()   // NO bets already at/past threshold — settled as loss mid-game
  const oneAway = new Set()
  const lastKsMap = new Map()  // pitcherId → last confirmed K count (delta detection)
  const freeMoneySentPerPitcher = new Map()  // pitcherId → total USD risked on free-money takers
  const _scratchCandidates = new Map()       // `${pitcherId}:${gameId}` → { seenAt } (2-poll scratch confirmation)
  const _scratchFired = new Set()            // `${pitcherId}:${gameId}` — scratch NO orders already placed

  // ── DB-backed monitor state (survives restarts) ───────────────────────────
  // In-memory caches are the hot path; every write also persists to monitor_state.
  // On startup, loadMonitorState() hydrates the caches from today's DB rows.

  // Ensure monitor_state table exists (safe no-op if already present)
  await db.run(`
    CREATE TABLE IF NOT EXISTS monitor_state (
      game_id           TEXT NOT NULL,
      bet_date          TEXT NOT NULL,
      pitcher_id        TEXT,
      pregame_cancelled INTEGER DEFAULT 0,
      game_settled      INTEGER DEFAULT 0,
      not_current_since TEXT,
      final_detected_at TEXT,
      updated_at        TEXT,
      PRIMARY KEY (game_id, bet_date, pitcher_id)
    )
  `).catch(() => {})
  // Add final_detected_at column to existing monitor_state tables (safe no-op)
  await db.run(`ALTER TABLE monitor_state ADD COLUMN final_detected_at TEXT`).catch(() => {})

  // Ensure game_reserves table exists (safe no-op if already present)
  await db.run(`
    CREATE TABLE IF NOT EXISTS game_reserves (
      game_id        TEXT NOT NULL,
      pitcher_id     TEXT NOT NULL,
      bet_date       TEXT NOT NULL,
      user_id        INTEGER NOT NULL,
      reserved_usd   REAL NOT NULL DEFAULT 0,
      used_usd       REAL NOT NULL DEFAULT 0,
      provisional_usd REAL NOT NULL DEFAULT 0,
      created_at     TEXT,
      PRIMARY KEY (game_id, pitcher_id, bet_date, user_id)
    )
  `).catch(() => {})
  await db.run(`ALTER TABLE game_reserves ADD COLUMN provisional_usd REAL NOT NULL DEFAULT 0`).catch(() => {})

  const _settledGames      = new Set()  // game_id
  const _preGameCancelled  = new Set()  // game_id
  const _notCurrentSince   = new Map()  // pitcherId → { ip, ks, seenAt, gameId }

  async function loadMonitorState() {
    try {
      const rows = await db.all(
        `SELECT game_id, pitcher_id, pregame_cancelled, game_settled, not_current_since
         FROM monitor_state WHERE bet_date = ?`,
        [TODAY],
      )
      for (const row of rows) {
        if (row.game_settled)      _settledGames.add(row.game_id)
        if (row.pregame_cancelled) _preGameCancelled.add(row.game_id)
        if (row.not_current_since && row.pitcher_id && row.pitcher_id !== '__game__') {
          try {
            const parsed = JSON.parse(row.not_current_since)
            _notCurrentSince.set(row.pitcher_id, { ...parsed, gameId: row.game_id })
          } catch { /* corrupt row — ignore */ }
        }
      }
      console.log(`[live] Monitor state loaded: ${_settledGames.size} settled, ${_preGameCancelled.size} pre-game cancelled, ${_notCurrentSince.size} possible-pull tracked`)
    } catch (err) {
      console.warn('[live] Could not load monitor_state:', err.message)
    }
  }

  async function _markSettled(gameId) {
    _settledGames.add(gameId)
    await db.run(
      `INSERT INTO monitor_state (game_id, bet_date, pitcher_id, game_settled, updated_at)
       VALUES (?, ?, '__game__', 1, ?)
       ON CONFLICT(game_id, bet_date, pitcher_id) DO UPDATE SET game_settled=1, updated_at=excluded.updated_at`,
      [gameId, TODAY, new Date().toISOString()],
    ).catch(() => {})
  }

  async function _markPreGameCancelled(gameId) {
    _preGameCancelled.add(gameId)
    await db.run(
      `INSERT INTO monitor_state (game_id, bet_date, pitcher_id, pregame_cancelled, updated_at)
       VALUES (?, ?, '__game__', 1, ?)
       ON CONFLICT(game_id, bet_date, pitcher_id) DO UPDATE SET pregame_cancelled=1, updated_at=excluded.updated_at`,
      [gameId, TODAY, new Date().toISOString()],
    ).catch(() => {})
  }

  async function _setNotCurrentSince(pitcherId, gameId, value) {
    if (value === null) {
      _notCurrentSince.delete(pitcherId)
      await db.run(
        `UPDATE monitor_state SET not_current_since=NULL, updated_at=? WHERE game_id=? AND bet_date=? AND pitcher_id=?`,
        [new Date().toISOString(), gameId, TODAY, pitcherId],
      ).catch(() => {})
    } else {
      _notCurrentSince.set(pitcherId, { ...value, gameId })
      await db.run(
        `INSERT INTO monitor_state (game_id, bet_date, pitcher_id, not_current_since, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(game_id, bet_date, pitcher_id) DO UPDATE SET not_current_since=excluded.not_current_since, updated_at=excluded.updated_at`,
        [gameId, TODAY, pitcherId, JSON.stringify(value), new Date().toISOString()],
      ).catch(() => {})
    }
  }

  await loadMonitorState()

  // Proxy wrappers so the rest of the code calls Set/Map idioms as before,
  // but writes are persisted to DB automatically.
  const settledGames = {
    has: (id) => _settledGames.has(id),
    add: async (id) => { await _markSettled(id) },
  }
  const preGameCancelled = {
    has: (id) => _preGameCancelled.has(id),
    add: async (id) => { await _markPreGameCancelled(id) },
  }
  // notCurrentSince: callers must pass gameId as extra arg to set(); delete() derives from cached entry
  const notCurrentSince = {
    get:    (pid)          => _notCurrentSince.get(pid),
    has:    (pid)          => _notCurrentSince.has(pid),
    set:    (pid, val, gid) => _setNotCurrentSince(pid, gid ?? _notCurrentSince.get(pid)?.gameId ?? 'unknown', val),
    delete: (pid)          => _setNotCurrentSince(pid, _notCurrentSince.get(pid)?.gameId ?? 'unknown', null),
  }
  // ─────────────────────────────────────────────────────────────────────────

  // ── Startup backfill: settle any games that went Final while monitor was offline ──
  console.log('[live] Checking for games that finished before monitor started...')
  for (const game of games) {
    try {
      const [ls, box] = await Promise.all([
        mlbGet(`${MLB_BASE}/game/${game.id}/linescore?fields=${LS_FIELDS}`),
        mlbGet(`${MLB_BASE}/game/${game.id}/boxscore?fields=${BOX_FIELDS}`),
      ])
      if (ls?.abstractGameState === 'Final' && !settledGames.has(game.id)) {
        await settledGames.add(game.id)
        await reconcileLiveFills(game).catch(() => {})
        await settleAndNotifyGame(game, box)
      }
    } catch (err) {
      console.error(`[live] backfill check failed for game ${game.id}: ${err.message}`)
    }
  }

  const FAST_SEC = Math.max(3, Math.floor(POLL_SEC / 4))  // e.g. 15s→3s, 5s→3s

  // Load active bettors once — refreshed every 50 iterations to pick up config changes
  let activeBettors = await db.all(
    `SELECT id, name, paper, kalshi_key_id, kalshi_private_key, starting_bankroll, daily_risk_pct, live_daily_risk_pct, kalshi_balance
     FROM users WHERE active_bettor=1 ORDER BY id`,
  )

  let iteration = 0
  while (true) {
    // Refresh active bettors periodically in case creds/paper flag changed
    if (iteration > 0 && iteration % 50 === 0) {
      activeBettors = await db.all(
        `SELECT id, name, paper, kalshi_key_id, kalshi_private_key, starting_bankroll, daily_risk_pct, live_daily_risk_pct, kalshi_balance
         FROM users WHERE active_bettor=1 ORDER BY id`,
      ).catch(() => activeBettors)
    }
    iteration++
    // Fast mode: shorten sleep if anyone is 1 K away from a threshold or a pitcher was pulled
    // (oneAway persists once set; urgentThisCycle is re-evaluated each iteration for pulled pitchers)
    let urgentThisCycle = oneAway.size > 0
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
    // For live users, prefer kalshi_balance (reflects real P&L over time) over starting_bankroll
    const totalBankroll = activeBettors.reduce((s, u) => s + ((LIVE && u.kalshi_balance > 0) ? u.kalshi_balance : (u.starting_bankroll ?? 1000)), 0)
    const drawdownLimit = -(totalBankroll * DRAWDOWN_HALT_PCT)
    if (_dailyNetPnl < drawdownLimit) {
      console.log(`\n[live] Rule E: Drawdown halt — today's P&L $${_dailyNetPnl.toFixed(2)} exceeds -${(DRAWDOWN_HALT_PCT*100).toFixed(0)}% limit. Stopping new bets.`)
      // Cancel all open orders on halt — for each live bettor
      for (const u of activeBettors.filter(u => u.paper === 0 && u.kalshi_key_id)) {
        try {
          await cancelAllOrders({ status: 'resting' }, { keyId: u.kalshi_key_id, privateKey: u.kalshi_private_key })
          console.log(`[live] Cancelled all resting orders for ${u.name} after drawdown halt`)
        } catch { /* non-fatal */ }
      }
      break
    }

    let allDone = true

    // Convert any maker orders that have sat unfilled for 30+ minutes
    await convertStaleMakers()

    for (const game of games) {
      try {
        // Get live box score
        const [ls, box] = await Promise.all([
          mlbGet(`${MLB_BASE}/game/${game.id}/linescore`),
          mlbGet(`${MLB_BASE}/game/${game.id}/boxscore`),
        ])
        const state = ls?.abstractGameState

        if (state === 'Preview') {
          continue
        }

        // ── Game just went Final — wait 10min for boxscore to stabilize, then settle ──
        if (state === 'Final') {
          if (!settledGames.has(game.id)) {
            // Record when we first saw Final — settle after 10-min delay for boxscore stabilization
            const finalRow = await db.one(
              `SELECT final_detected_at FROM monitor_state
               WHERE game_id = ? AND bet_date = ? AND pitcher_id = '__game__'`,
              [game.id, TODAY],
            ).catch(() => null)

            if (!finalRow?.final_detected_at) {
              // First time seeing Final — record timestamp, don't settle yet
              await db.run(
                `INSERT INTO monitor_state (game_id, bet_date, pitcher_id, final_detected_at, updated_at)
                 VALUES (?, ?, '__game__', ?, ?)
                 ON CONFLICT(game_id, bet_date, pitcher_id) DO UPDATE SET
                   final_detected_at = excluded.final_detected_at,
                   updated_at = excluded.updated_at`,
                [game.id, TODAY, new Date().toISOString(), new Date().toISOString()],
              ).catch(() => {})
              console.log(`\n[live] ${game.team_away}@${game.team_home} Final — waiting 10min for boxscore to stabilize`)
            } else {
              const msSinceFinal = Date.now() - new Date(finalRow.final_detected_at).getTime()
              if (msSinceFinal >= 10 * 60 * 1000) {
                // 10 minutes passed — settle with a fresh boxscore
                await settledGames.add(game.id)
                let freshBox = box
                try {
                  freshBox = await mlbGet(`${MLB_BASE}/game/${game.id}/boxscore?fields=${BOX_FIELDS}`)
                } catch { /* use cached box */ }
                await reconcileLiveFills(game).catch(() => {})
                await settleAndNotifyGame(game, freshBox ?? box)
              } else {
                const minsLeft = Math.ceil((10 * 60 * 1000 - msSinceFinal) / 60_000)
                console.log(`\n[live] ${game.team_away}@${game.team_home} Final — ${minsLeft}min until settlement`)
              }
            }
          }
          continue
        }

        allDone = false  // at least one game still live

        // Cancel pre-game resting orders the first time we see this game live.
        // Pre-game limit prices are stale once first pitch is thrown — keeping
        // them open invites adverse fills when the market moves against us.
        if (!preGameCancelled.has(game.id)) {
          await preGameCancelled.add(game.id)
          await cancelPreGameOrders(game).catch(() => {})
          await initGameReserves(game).catch(() => {})
        }

        // Check both starters
        for (const [side, pitcherId] of [
          ['away', game.pitcher_away_id],
          ['home', game.pitcher_home_id],
        ]) {
          if (!pitcherId || !allPitcherIds.has(pitcherId)) continue
          const ctx = pitcherContext.get(pitcherId)
          if (!ctx) continue

          const team    = box?.teams?.[side]
          const player  = team?.players?.[`ID${pitcherId}`]

          // ── Early scratch check: pitcher completely absent from boxscore ──
          // When a starter is scratched before the game, the MLB API sometimes
          // omits them from the players dict entirely (no zeros, just missing).
          // This fires before the player-null guard so we can still detect it.
          // The in-game scratch check (later, at line ~1620) handles the case
          // where the player IS present but shows IP=0, Ks=0.
          if (!player) {
            const _earlyTeamPlayers = team?.players ?? {}
            const _earlyReliever = Object.entries(_earlyTeamPlayers).some(
              ([pid, p]) => pid !== `ID${pitcherId}` && p.gameStatus?.isCurrentPitcher === true,
            )
            if (_earlyReliever && (ls?.currentInning ?? 0) >= 3 &&
                !_scratchFired.has(`${pitcherId}:${game.id}`)) {
              const scratchKey = `${pitcherId}:${game.id}`
              const prev = _scratchCandidates.get(scratchKey)
              if (!prev) {
                _scratchCandidates.set(scratchKey, { seenAt: Date.now() })
                console.log(`[live] 🚫 POSSIBLE SCRATCH (absent)  ${ctx.pitcherName}  inning ${ls?.currentInning ?? 0} — waiting for confirmation`)
              } else {
                _scratchFired.add(scratchKey)
                _scratchCandidates.delete(scratchKey)
                console.log(`\n[live] 🚫 SCRATCH CONFIRMED (absent)  ${ctx.pitcherName}  firing NO takers`)
                db.saveLog({ tag: 'SCRATCH', msg: `${ctx.pitcherName} scratch confirmed — absent from boxscore`, pitcher: ctx.pitcherName })
                const openYes = await db.all(
                  `SELECT * FROM ks_bets WHERE bet_date=? AND pitcher_id=? AND live_bet=0 AND result IS NULL AND side='YES'`,
                  [TODAY, String(pitcherId)],
                )
                for (const bet of openYes) {
                  for (const bettor of activeBettors) {
                    await executeBet({
                      pitcherName: ctx.pitcherName, pitcherId, game: ctx.game,
                      strike: bet.strike, side: 'NO',
                      modelProb: 0.99, marketMid: bet.market_mid ?? 50, edge: 0.90,
                      ticker: bet.ticker, betSize: PULLED_CAP_USD,
                      kellyFraction: 0, capitalRisk: 0,
                      liveKs: 0, liveIP: 0, livePitches: 0, liveBF: 0,
                      liveInning: ls?.currentInning ?? 0, livePkEffective: null, liveLambda: null, liveScore: null,
                      mode: 'pulled', user: bettor,
                    }).catch(() => {})
                  }
                }
                await notifyScratch({
                  pitcherName: ctx.pitcherName, game: ctx.game,
                  marketCount: openYes.length, paper: !LIVE,
                }, await getAllWebhooks(db))
              }
            }
            continue
          }

          const currentKs      = Number(player.stats?.pitching?.strikeOuts || 0)
          const currentIPraw   = player.stats?.pitching?.inningsPitched || '0.0'
          const currentIP      = ipToDecimal(currentIPraw)
          const currentPitches = Number(player.stats?.pitching?.numberOfPitches || 0)
          const currentBF      = Number(player.stats?.pitching?.battersFaced || 0)
          const isCurrent      = player.gameStatus?.isCurrentPitcher
          const currentInning  = ls?.currentInning != null ? `${ls.inningHalf?.slice(0,3) ?? ''}${ls.currentInning}` : null
          const awayScore      = ls?.teams?.away?.runs ?? null
          const homeScore      = ls?.teams?.home?.runs ?? null
          const currentScore   = awayScore != null ? `${awayScore}-${homeScore}` : null
          // Score diff from pitcher's team perspective (positive = pitcher's team winning)
          const pitcherScore   = side === 'away' ? awayScore : homeScore
          const oppScore       = side === 'away' ? homeScore : awayScore
          const scoreDiff      = (pitcherScore ?? 0) - (oppScore ?? 0)

          // Cache live game state so convertStaleMakers() can compute a fresh
          // model probability on the next poll cycle (B13 fix).
          _liveGameStateCache.set(String(pitcherId), { currentKs, currentIP, currentPitches, currentBF, scoreDiff, ctx })

          // ── K-delta detection — log when K count changes, flag urgency ──────
          const prevKs = lastKsMap.get(pitcherId) ?? null
          const ksChanged = prevKs !== null && currentKs !== prevKs
          lastKsMap.set(pitcherId, currentKs)
          if (ksChanged) {
            console.log(`\n[live] ⚡ K DELTA  ${ctx.pitcherName}  ${prevKs}→${currentKs}K  running edge check`)
            urgentThisCycle = true
          }

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
              const _ffC = ((bet.fill_price ?? bet.market_mid ?? 50)) / 100
              const _szC = _fcC != null ? _fcC : Math.round((bet.bet_size ?? 100) / _ffC)
              const pnl = Math.round(_szC * (1 - _ffC) * 0.93 * 100) / 100
              const now = new Date().toISOString()
              await db.run(
                `UPDATE ks_bets SET actual_ks=?, result='win', settled_at=?, pnl=? WHERE id=? AND result IS NULL`,
                [currentKs, now, pnl, bet.id],
              )
              console.log(`\n[live] ✅ COVERED + SETTLED ${ctx.pitcherName} ${bet.strike}+ (${currentKs}K)  +$${pnl.toFixed(2)}`)
              db.saveLog({ tag: 'COVER', msg: `${ctx.pitcherName} ${bet.strike}+ YES covered at ${currentKs}K  +$${pnl.toFixed(2)}`, pitcher: ctx.pitcherName, strike: bet.strike, side: 'YES', pnl })
              await notifyCovered({ pitcherName: ctx.pitcherName, strike: bet.strike, side: bet.side, pnl, currentKs, game: ctx.game }, await getAllWebhooks(db))

              // Auto-close: sell YES position early if bid ≥ 88¢ — lock near-max profit now
              if (LIVE && bet.filled_contracts > 0 && bet.ticker && bet.paper === 0) {
                try {
                  const closeMkt = await getMarketPrice(bet.ticker).catch(() => null)
                  const yesBidCents = closeMkt?.bid != null ? Math.round(closeMkt.bid * 100) : null
                  if (yesBidCents != null && yesBidCents >= 88) {
                    const userRow = activeBettors.find(b => b.id === bet.user_id)
                    if (userRow?.kalshi_key_id) {
                      const sellCreds = { keyId: userRow.kalshi_key_id, privateKey: userRow.kalshi_private_key }
                      await placeOrder(bet.ticker, 'yes', bet.filled_contracts, yesBidCents, sellCreds, 'sell')
                      console.log(`[live] 💰 AUTO-CLOSE ${ctx.pitcherName} YES${bet.strike} ${bet.filled_contracts}c @ ${yesBidCents}¢`)
                      db.saveLog({ tag: 'SELL', msg: `${ctx.pitcherName} YES${bet.strike} sold ${bet.filled_contracts}c @ ${yesBidCents}¢ — auto-close`, pitcher: ctx.pitcherName, strike: bet.strike, side: 'YES' })
                      // Update pnl to reflect actual early-sale proceeds, not settlement value
                      const autoClosePnl = Math.round(bet.filled_contracts * ((yesBidCents - (bet.fill_price ?? bet.market_mid ?? 50)) / 100) * 0.93 * 100) / 100
                      await db.run(
                        `UPDATE ks_bets SET pnl = ?, result = 'win', order_status = 'closed', settled_at = ? WHERE id = ? AND result IS NULL`,
                        [autoClosePnl, new Date().toISOString(), bet.id],
                      ).catch(() => {})
                    }
                  }
                } catch { /* non-fatal — position still settled above */ }
              }
            }

            // Dead: YES bet, starter pulled and can't reach threshold — settle as loss immediately
            // Require 3+ IP before trusting isCurrent=false; MLB API flag is unreliable in early innings
            if (bet.side === 'YES' && !isCurrent && currentKs < bet.strike && currentIP >= 3 && !dead.has(key)) {
              dead.add(key)
              const FEE = 0.07
              const contracts = bet.filled_contracts != null ? bet.filled_contracts : null
              const fillFrac  = ((bet.fill_price ?? bet.market_mid ?? 50)) / 100
              const pnl = contracts != null
                ? -Math.round(contracts * fillFrac * 100) / 100  // loss = contracts × cost per contract
                : -(bet.bet_size ?? 0)                           // loss = capital invested
              const now = new Date().toISOString()
              await db.run(
                `UPDATE ks_bets SET actual_ks=?, result='loss', settled_at=?, pnl=? WHERE id=? AND result IS NULL`,
                [currentKs, now, pnl, bet.id],
              )
              console.log(`\n[live] ❌ DEAD + SETTLED ${ctx.pitcherName} pulled at ${currentKs}K (needed ${bet.strike}+)  $${pnl.toFixed(2)}`)
              db.saveLog({ tag: 'DEAD', level: 'warn', msg: `${ctx.pitcherName} pulled at ${currentKs}K (needed ${bet.strike}+)  $${pnl.toFixed(2)}`, pitcher: ctx.pitcherName, strike: bet.strike, side: 'YES', pnl })
              await notifyDead({ pitcherName: ctx.pitcherName, strike: bet.strike, side: bet.side, pnl, currentKs, currentIPraw, game: ctx.game, reason: 'starter pulled' }, await getAllWebhooks(db))
            }

            // NO bet: if pitcher has already reached or exceeded the threshold the bet is
            // mathematically lost — K counts never decrease once recorded. Settle immediately
            // rather than waiting for game-end, which could be hours later.
            if (bet.side === 'NO' && currentKs >= bet.strike && !noLost.has(key)) {
              noLost.add(key)
              const contracts = bet.filled_contracts != null ? bet.filled_contracts : null
              const fillFrac  = ((bet.fill_price ?? bet.market_mid ?? 50)) / 100
              const pnl = contracts != null
                ? -Math.round(contracts * fillFrac * 100) / 100
                : -(bet.bet_size ?? 0)
              const now = new Date().toISOString()
              await db.run(
                `UPDATE ks_bets SET actual_ks=?, result='loss', settled_at=?, pnl=? WHERE id=? AND result IS NULL`,
                [currentKs, now, pnl, bet.id],
              )
              console.log(`\n[live] ❌ NO LOST ${ctx.pitcherName} NO ${bet.strike}+ already at ${currentKs}K  $${pnl.toFixed(2)}`)
              db.saveLog({ tag: 'NO_LOST', level: 'warn', msg: `${ctx.pitcherName} NO${bet.strike}+ hit threshold at ${currentKs}K  $${pnl.toFixed(2)}`, pitcher: ctx.pitcherName, strike: bet.strike, side: 'NO', pnl })
              await notifyDead({ pitcherName: ctx.pitcherName, strike: bet.strike, side: 'NO', pnl, currentKs, currentIPraw, game: ctx.game, reason: `reached ${currentKs}K` }, await getAllWebhooks(db))
            }
          }

          // Pull detection — two-tier:
          // Tier 1 (definitive): a different pitcher has isCurrentPitcher=true for this team → real pull
          // Tier 2 (fallback): same IP/Ks two consecutive cycles AND deep in game (≥5 IP) → pulled
          // MLB API sets isCurrentPitcher=false between half-innings (team at bat), so we need
          // either a confirmed reliever on mound or multiple stale readings before trusting a pull.
          const teamPlayers = team?.players ?? {}
          const relieverOnMound = Object.entries(teamPlayers).some(
            ([pid, p]) => pid !== `ID${pitcherId}` && p.gameStatus?.isCurrentPitcher === true,
          )

          let pitcherPulledEarly = false
          if (!isCurrent && currentIP >= 2) {
            if (relieverOnMound) {
              pitcherPulledEarly = true  // definitive: different pitcher confirmed on mound
              console.log(`[live] ✅ PULL CONFIRMED (reliever)  ${ctx.pitcherName}  ${currentKs}K ${currentIPraw}IP — firing free money`)
              notCurrentSince.delete(pitcherId)
            } else {
              const prev = notCurrentSince.get(pitcherId)
              if (!prev) {
                notCurrentSince.set(pitcherId, { ip: currentIP, ks: currentKs, seenAt: Date.now() }, game.id)
                console.log(`[live] 👀 POSSIBLE PULL  ${ctx.pitcherName}  ${currentKs}K ${currentIPraw}IP — waiting for confirmation`)
              } else if (prev.ip === currentIP && prev.ks === currentKs && currentIP >= 5) {
                pitcherPulledEarly = true  // fallback: same IP/Ks two cycles, deep enough in game
                console.log(`[live] ✅ PULL CONFIRMED (stale)  ${ctx.pitcherName}  ${currentKs}K ${currentIPraw}IP — firing free money`)
              } else {
                notCurrentSince.set(pitcherId, { ip: currentIP, ks: currentKs, seenAt: Date.now() }, game.id)
              }
            }
          } else if (isCurrent) {
            if (notCurrentSince.has(pitcherId)) {
              console.log(`[live] ↩  PULL CANCELLED  ${ctx.pitcherName}  back in game  ${currentKs}K ${currentIPraw}IP`)
              notCurrentSince.delete(pitcherId)
            }
          }
          if (pitcherPulledEarly) urgentThisCycle = true  // free money window — stay fast

          // Post provisional debits for locked winning NO bets when pull is confirmed
          // and game is official (≥5 innings). Idempotent — UNIQUE constraint deduplicates.
          if (pitcherPulledEarly && (ls?.currentInning ?? 0) >= 5) {
            for (const u of activeBettors) {
              await postProvisionalDebits(String(pitcherId), game.id, currentKs, ls?.currentInning ?? 0, u.id).catch(() => {})
            }
          }

          // ── Scratch detection: pitcher registered but never appeared in the game ──
          // Requires: IP=0, Ks=0, not current pitcher, confirmed reliever on mound, game ≥3 innings.
          // Two-poll confirmation pattern (same as pull detection) to guard against MLB API lag.
          // Uses `mode: 'pulled'` in executeBet to reuse existing taker + dedup infrastructure.
          if (!pitcherPulledEarly && !isCurrent && currentIP === 0 && currentKs === 0 &&
              relieverOnMound && (ls?.currentInning ?? 0) >= 3 && !_scratchFired.has(`${pitcherId}:${game.id}`)) {
            const scratchKey = `${pitcherId}:${game.id}`
            const prev = _scratchCandidates.get(scratchKey)
            if (!prev) {
              _scratchCandidates.set(scratchKey, { seenAt: Date.now() })
              console.log(`[live] 🚫 POSSIBLE SCRATCH  ${ctx.pitcherName}  IP=0 K=0 not current inning ${ls?.currentInning ?? 0} — waiting for confirmation`)
            } else {
              _scratchFired.add(scratchKey)
              _scratchCandidates.delete(scratchKey)
              console.log(`\n[live] 🚫 SCRATCH CONFIRMED  ${ctx.pitcherName}  firing NO takers on pre-game YES positions`)
              db.saveLog({ tag: 'SCRATCH', msg: `${ctx.pitcherName} scratch confirmed — never appeared in game`, pitcher: ctx.pitcherName })
              const openYes = await db.all(
                `SELECT * FROM ks_bets WHERE bet_date=? AND pitcher_id=? AND live_bet=0 AND result IS NULL AND side='YES'`,
                [TODAY, String(pitcherId)],
              )
              for (const bet of openYes) {
                for (const bettor of activeBettors) {
                  await executeBet({
                    pitcherName: ctx.pitcherName, pitcherId, game: ctx.game,
                    strike: bet.strike, side: 'NO',
                    modelProb: 0.99, marketMid: bet.market_mid ?? 50, edge: 0.90,
                    ticker: bet.ticker, betSize: PULLED_CAP_USD,
                    kellyFraction: 0, capitalRisk: 0,
                    liveKs: 0, liveIP: 0, livePitches: 0, liveBF: 0,
                    liveInning: ls?.currentInning ?? 0, livePkEffective: null, liveLambda: null, liveScore: null,
                    mode: 'pulled', user: bettor,
                  }).catch(() => {})
                }
              }
              await notifyScratch({
                pitcherName: ctx.pitcherName, game: ctx.game,
                marketCount: openYes.length, paper: !LIVE,
              }, await getAllWebhooks(db))
            }
          }

          // BF + inning gates — bypassed for confirmed-pulled pitchers (state already resolved)
          if (!pitcherPulledEarly && currentBF < 4) continue
          const currentInn = ls.currentInning ?? 0
          if (!pitcherPulledEarly && currentInn < 2) continue

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
            const restBettor = activeBettors.find(u => u.id === restBet.user_id)
            const restCreds = restBettor?.kalshi_key_id ? { keyId: restBettor.kalshi_key_id, privateKey: restBettor.kalshi_private_key } : {}
            await manageRestingOrder(restBet, { currentPitches, currentIP, market: mkt ?? null, creds: restCreds })
              .catch(err => console.error(`[live] manageRestingOrder error: ${err.message}`))
          }

          // Pre-load today's pre-game bets for this pitcher — used to dedup by (pitcher, strike, side)
          const preGameForPitcher = await db.all(
            `SELECT strike, side, user_id FROM ks_bets
              WHERE bet_date = ? AND pitcher_id = ? AND live_bet = 0`,
            [TODAY, String(pitcherId)],
          )
          // Per-bettor pre-game positions — used to avoid mixed positions per user
          const preGameKeysByUser = new Map()
          for (const r of preGameForPitcher) {
            if (!preGameKeysByUser.has(r.user_id)) preGameKeysByUser.set(r.user_id, new Set())
            preGameKeysByUser.get(r.user_id).add(`${r.strike}-${r.side}`)
          }
          // Helper: returns per-bettor key set (empty set if no pre-game bets)
          const pgKeys = (b) => preGameKeysByUser.get(b.id) ?? new Set()
          // Qualifying filter uses intersection: skip only when ALL bettors are blocked.
          // Per-bettor checks in the execution loop handle individual conflicts.
          const allHave  = (key) => activeBettors.length > 0 && activeBettors.every(b => pgKeys(b).has(key))
          const anyCanTrade = (noKey, yesKey) => activeBettors.some(b => !pgKeys(b).has(noKey) && !pgKeys(b).has(yesKey))

          // ── Pass 1: collect qualifying edges for this pitcher ──
          const qualifying = []

          for (const mkt of markets) {
            const parts = mkt.ticker.split('-')
            const n = parseInt(parts[parts.length - 1])
            if (!Number.isInteger(n) || n < 2 || n > 15) continue

            // Harden bid/ask parsing — Kalshi returns either integer cents or *_dollars string fields
            const yesBidCents = mkt.yes_bid != null ? mkt.yes_bid
                              : mkt.yes_bid_dollars != null ? Math.round(parseFloat(mkt.yes_bid_dollars) * 100) : null
            const yesAskCents = mkt.yes_ask != null ? mkt.yes_ask
                              : mkt.yes_ask_dollars != null ? Math.round(parseFloat(mkt.yes_ask_dollars) * 100) : null
            if (yesBidCents == null || yesAskCents == null) continue
            const noAskCents  = 100 - yesBidCents   // cost to buy NO = 100 - yes_bid
            const midCents    = (yesBidCents + yesAskCents) / 2
            const halfSpread  = (yesAskCents - yesBidCents) / 200
            const marketPrice = midCents / 100
            const noMid       = 100 - midCents

            const betKey = `${pitcherId}-${n}-live`  // mode-agnostic dedup key
            if (activeBettors.length > 0 && activeBettors.every(b => placed.has(`${b.id}:${betKey}`))) continue
            if (allHave(`${n}-NO`) && allHave(`${n}-YES`)) continue  // all bettors fully covered both sides

            // ── MODE 1: Pulled pitcher — structurally resolved, stale market arb ──
            if (pitcherPulledEarly && n > currentKs) {
              if (allHave(`${n}-NO`)) continue  // all bettors already have NO here
              if (allHave(`${n}-YES`)) continue  // all bettors have pre-game YES — all would get mixed position
              if (noMid >= 90 || noMid <= 5) continue  // already repriced or illiquid
              qualifying.push({
                n, mkt, midCents, marketPrice, modelProb: 0.02,
                edge: 1 - marketPrice - 0.02, betSide: 'NO', betKey, mode: 'pulled',
                modelProbSide: 0.98, marketPriceSide: 1 - marketPrice,
              })
              continue
            }

            // ── MODE 1.2: Crossed-YES — threshold already hit, market lag on YES ──
            // If currentKs >= n, the YES outcome is structurally locked — buy before Kalshi reprices.
            // yesAsk ≤ CROSSED_YES_MAX_ASK: meaningful discount (market still lagged).
            // midCents > 5: market hasn't fully repriced to 0 yet.
            // No conflicting pre-game YES or NO positions (avoid mixed exposure).
            if (currentKs >= n) {
              if (yesAskCents <= CROSSED_YES_MAX_ASK && midCents > 5 &&
                  anyCanTrade(`${n}-NO`, `${n}-YES`)) {
                qualifying.push({
                  n, mkt, midCents, marketPrice, modelProb: 1.0,
                  edge: (100 - yesAskCents) / 100 - 0.08,
                  betSide: 'YES', betKey, mode: 'crossed-yes',
                  modelProbSide: 1.0, marketPriceSide: yesAskCents / 100,
                })
              }
              continue  // outcome determined — skip all other mode checks for this n
            }

            // ── MODE 1.7: Blowout NO — large deficit late, pull structurally likely ──
            // Team losing BLOWOUT_DEFICIT+ runs in inning BLOWOUT_INNING+, pitcher still in game.
            // BLOWOUT_K_GAP: gap wide enough that reaching the threshold is structurally unlikely
            // before manager pulls the starter. noMid range guard: not already repriced or illiquid.
            if (isCurrent && scoreDiff <= -BLOWOUT_DEFICIT && currentInn >= BLOWOUT_INNING &&
                (n - currentKs) >= BLOWOUT_K_GAP) {
              if (!allHave(`${n}-NO`) && noMid < 85 && noMid > 5) {
                const blowoutEdge = (1 - marketPrice) - 0.08
                if (blowoutEdge >= 0.10) {
                  qualifying.push({
                    n, mkt, midCents, marketPrice, modelProb: 0.10,
                    edge: blowoutEdge, betSide: 'NO', betKey, mode: 'blowout',
                    modelProbSide: 0.90, marketPriceSide: 1 - marketPrice,
                  })
                }
              }
              continue  // blowout: skip normal model for this n
            }

            if (!live) continue  // pulled pitcher — no high-conviction model available

            const modelProb = live.probAtLeast(n)

            // ── MODE 1.5: Dead-path NO — model confirms threshold is near-unreachable ──
            // Only fires when BOTH the pitch-count gate AND the live model agree.
            // Previously used a hardcoded 0.05 probability — this caused misfires for
            // high-pitch-budget starters (e.g. avgPitches=105 at 85 pitches has ~1.2 IP left,
            // which at 33% K rate gives ~20% probability, not 5%).
            if (isCurrent && currentPitches >= PULL_PITCH_COUNT && currentIP >= PULL_MIN_IP &&
                n - currentKs >= 3 && modelProb < 0.10) {
              if (!allHave(`${n}-NO`) && noMid < 85 && noMid > 5) {
                const deadEdge = (1 - marketPrice) - modelProb
                if (deadEdge >= 0.10) {
                  qualifying.push({
                    n, mkt, midCents, marketPrice, modelProb,
                    edge: deadEdge, betSide: 'NO', betKey, mode: 'dead-path',
                    modelProbSide: 1 - modelProb, marketPriceSide: 1 - marketPrice,
                  })
                }
              }
              continue
            }
            const edgeYES   = modelProb - marketPrice
            const edgeNO    = (1 - modelProb) - (1 - marketPrice)
            const betSide   = edgeYES >= edgeNO ? 'YES' : 'NO'
            const edge      = betSide === 'YES' ? edgeYES : edgeNO

            if (allHave(`${n}-${betSide}`)) continue  // all bettors already have this position

            // ── MODE 2: High-conviction — tiered YES thresholds + ksChanged momentum ──
            // kellyScale < 1 → partial sizing for lower-conviction entries
            if (betSide === 'YES') {
              const onKMomentum = ksChanged   // pitcher just added a K this cycle
              const yesMinProb  = onKMomentum ? 0.55 : 0.60
              const yesFullConv = modelProb >= 0.75
              const yesMinEdge  = yesFullConv
                ? Math.max(0.20, halfSpread + 0.04)
                : onKMomentum ? Math.max(0.10, halfSpread + 0.03) : Math.max(0.12, halfSpread + 0.03)
              if (modelProb < yesMinProb) continue
              if (edge < yesMinEdge) continue
              const kellyScale  = yesFullConv ? 1.0 : onKMomentum ? 0.35 : 0.50
              qualifying.push({
                n, mkt, midCents, marketPrice, modelProb, edge, betSide, betKey,
                mode: 'high-conviction', kellyScale,
                modelProbSide: modelProb, marketPriceSide: marketPrice,
              })
            } else {
              if (modelProb > 0.15) continue
              if (noAskCents > 55) continue   // don't pay >55¢ for a NO — cost = 100 - yes_bid
              if (edge < Math.max(0.15, halfSpread + 0.04)) continue
              qualifying.push({
                n, mkt, midCents, marketPrice, modelProb, edge, betSide, betKey,
                mode: 'high-conviction', kellyScale: 1.0,
                modelProbSide: 1 - modelProb, marketPriceSide: 1 - marketPrice,
              })
            }
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

          // All structural taker modes: execute highest threshold first.
          // Near-certain wins — if cash runs out, highest-n (most certain) positions fill first.
          const TAKER_MODES = new Set(['pulled', 'crossed-yes', 'blowout', 'dead-path'])
          const execOrder = qualifying.map((_, i) => i)
          if (qualifying.some(q => TAKER_MODES.has(q.mode))) {
            execOrder.sort((a, b) => qualifying[b].n - qualifying[a].n)
          }

          // Shared exec helper — returns true if any bettor order succeeded
          const runExecItem = async (i) => {
            const q = qualifying[i]
            const s = sized[i]
            if (!s || s.betSize <= 0) return false

            // ── Bayesian posterior model probability update ──────────────────
            // For normal high-conviction bets, blend pre-game model with in-game
            // evidence using computeLiveProb. Pulled/dead-path modes use hardcoded
            // structural probabilities (0.02 / 0.05) — don't overwrite those.
            let liveModelProbSide = q.modelProbSide
            if ((q.mode === 'high-conviction') && ctx.lambda && currentBF > 0) {
              // Estimate total BF from pre-game λ: lambda = E[BF] × pK, so E[BF] = lambda / pK
              // Use LEAGUE_K_PCT as the per-BF K rate proxy (conservative denominator).
              const estTotalBF = Math.round(ctx.lambda / Math.max(LEAGUE_K_PCT, 0.20))
              const posterior  = computeLiveProb(ctx.lambda, currentKs, currentBF, estTotalBF, q.n)
              // Only replace if we have meaningful in-game sample (≥6 BF ≈ 2 innings)
              if (currentBF >= 6 && posterior > 0) {
                liveModelProbSide = q.betSide === 'YES' ? posterior : 1 - posterior
              }
            }

            // Per-pitcher free-money cap: stop firing takers once limit reached
            // Applies to all in-game structural taker modes (pulled, crossed-yes, blowout).
            if (q.mode === 'pulled' || q.mode === 'crossed-yes' || q.mode === 'blowout') {
              const alreadySent = freeMoneySentPerPitcher.get(pitcherId) ?? 0
              if (alreadySent >= FREE_MONEY_PITCHER_CAP) {
                console.log(`[live] 🚫 FREE MONEY PITCHER CAP  ${ctx.pitcherName}  $${alreadySent.toFixed(0)}/$${FREE_MONEY_PITCHER_CAP} — skipping ${q.n}+  [${q.mode}]`)
                return false
              }
            }

            // 2× sizing for high-edge bets (≥15¢); kellyScale < 1 for lower-conviction entries
            const edgeMult     = q.edge >= 0.15 ? 2 : 1
            const finalBetSize = s.betSize * edgeMult * (q.kellyScale ?? 1.0)
            const capitalRisk  = capitalAtRisk(finalBetSize, q.marketPrice, q.betSide)

            const scaleTag = (q.kellyScale ?? 1.0) < 1.0 ? ` [${Math.round((q.kellyScale ?? 1.0)*100)}% kelly]` : ''
            const sizeTag  = edgeMult > 1 ? ` [2× edge=${(q.edge*100).toFixed(0)}¢]${scaleTag}` : scaleTag
            const _tag = q.mode === 'pulled' ? '🎯 PULLED' : q.mode === 'crossed-yes' ? '🟢 CROSSED-YES' : q.mode === 'blowout' ? '🏳️ BLOWOUT' : '🔥 EDGE'
            console.log(`\n[live] ${_tag} ${ctx.game} ${ctx.pitcherName} ${q.n}+ Ks ${q.betSide}  model=${(q.modelProb*100).toFixed(1)}%  mid=${q.midCents.toFixed(0)}¢  edge=${(q.edge*100).toFixed(1)}¢  ${currentKs}K ${currentIPraw}IP ${currentPitches}p ${currentBF}BF  [${q.mode}]${sizeTag}`)
            db.saveLog({ tag: q.mode === 'pulled' ? 'PULLED' : 'EDGE', msg: `${ctx.pitcherName} ${q.n}+ ${q.betSide}  model=${(q.modelProb*100).toFixed(1)}%  mid=${q.midCents.toFixed(0)}¢  edge=${(q.edge*100).toFixed(1)}¢  ${currentKs}K ${currentIPraw}IP${sizeTag}`, pitcher: ctx.pitcherName, strike: q.n, side: q.betSide, edge_cents: Math.round(q.edge * 100) })

            let anySuccess = false
            for (const bettor of activeBettors) {
              const bettorKey = `${bettor.id}:${q.betKey}`
              if (placed.has(bettorKey)) continue

              // Per-bettor pre-game conflict check — mirrors the qualifying filter but per-user.
              // Ensures a bettor with a conflicting position is skipped even if others can trade.
              const myPgKeys = pgKeys(bettor)
              if (q.mode === 'pulled') {
                if (myPgKeys.has(`${q.n}-NO`))  { placed.add(bettorKey); continue }  // already have NO
                if (myPgKeys.has(`${q.n}-YES`)) { placed.add(bettorKey); continue }  // would create mixed position
              } else if (q.mode === 'crossed-yes') {
                if (myPgKeys.has(`${q.n}-NO`) || myPgKeys.has(`${q.n}-YES`)) { placed.add(bettorKey); continue }
              } else if (q.mode === 'blowout' || q.mode === 'dead-path') {
                if (myPgKeys.has(`${q.n}-NO`)) { placed.add(bettorKey); continue }
              } else {
                if (myPgKeys.has(`${q.n}-${q.betSide}`)) { placed.add(bettorKey); continue }
              }

              const betResult = await executeBet({
                pitcherName:      ctx.pitcherName,
                pitcherId,
                game:             ctx.game,
                strike:           q.n,
                side:             q.betSide,
                modelProb:        liveModelProbSide,
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
                livePkEffective:  live?.pK_effective ?? null,
                liveLambda:       live?.lambdaRemaining ?? null,
                liveScore:        currentScore,
                mode:             q.mode,
                user:             bettor,
              })

              if (betResult?.dedup || betResult?.kalshiDedup || betResult?.budget) {
                placed.add(bettorKey)
              } else if (betResult?.apiFailed) {
                console.log(`  [live] order failed for ${bettor.name} ${q.betKey} — will retry next poll`)
              } else if (betResult?.finalContracts != null || betResult?.freeMoneySummary != null) {
                placed.add(bettorKey)
                anySuccess = true

                // Track free-money spend toward per-pitcher cap
                if ((q.mode === 'pulled' || q.mode === 'crossed-yes' || q.mode === 'blowout') && betResult.finalContracts > 0) {
                  const askC = betResult.freeMoneySummary?.askCents ?? q.midCents
                  const spent = betResult.finalContracts * (askC / 100)
                  freeMoneySentPerPitcher.set(pitcherId, (freeMoneySentPerPitcher.get(pitcherId) ?? 0) + spent)
                }

                const webhooks = bettor.discord_webhook ? [bettor.discord_webhook] : []
                if (q.mode === 'pulled' && betResult?.freeMoneySummary) {
                  await notifyFreeMoney({
                    pitcherName: ctx.pitcherName,
                    strike: q.n, currentKs,
                    yesPrice:       betResult.freeMoneySummary.yesPrice,
                    contracts:      betResult.finalContracts,
                    askCents:       betResult.freeMoneySummary.askCents,
                    expectedProfit: betResult.freeMoneySummary.expectedProfit,
                    game: ctx.game, paper: bettor.paper !== 0,
                  }, webhooks)
                } else if (q.mode === 'crossed-yes' && betResult?.freeMoneySummary) {
                  await notifyCrossedYes({
                    pitcherName: ctx.pitcherName,
                    strike: q.n, currentKs,
                    yesAskCents:    betResult.freeMoneySummary.askCents,
                    contracts:      betResult.finalContracts,
                    expectedProfit: betResult.freeMoneySummary.expectedProfit,
                    game: ctx.game, paper: bettor.paper !== 0,
                  }, webhooks)
                } else if (q.mode === 'blowout' && betResult?.freeMoneySummary) {
                  await notifyBlowout({
                    pitcherName: ctx.pitcherName,
                    strike: q.n, currentKs,
                    scoreDiff, currentInn,
                    contracts:      betResult.finalContracts,
                    askCents:       betResult.freeMoneySummary.askCents,
                    expectedProfit: betResult.freeMoneySummary.expectedProfit,
                    game: ctx.game, paper: bettor.paper !== 0,
                  }, webhooks)
                } else if (q.mode === 'dead-path') {
                  await notifyLiveBet({
                    pitcherName: ctx.pitcherName,
                    strike: q.n, side: q.betSide,
                    marketMid: q.midCents, edge: q.edge, betSize: finalBetSize,
                    currentKs, currentIPraw, currentPitches, paper: bettor.paper !== 0,
                  }, webhooks)
                }
                // high-conviction: maker order — no notification until fill confirmed at T-120
              }
            }
            return anySuccess
          }

          // All structural taker modes: independent markets, time-sensitive — fire concurrently
          const batchItems = execOrder.filter(i => TAKER_MODES.has(qualifying[i].mode))
          const seqItems   = execOrder.filter(i => !TAKER_MODES.has(qualifying[i].mode))

          if (batchItems.length) {
            const batchResults = await Promise.all(batchItems.map(i => runExecItem(i)))
            if (LIVE && batchResults.some(Boolean)) await loadDailyLoss()
          }

          // High-conviction: maker orders — sequential to respect queue ordering
          for (const i of seqItems) {
            const success = await runExecItem(i)
            if (LIVE && success) await loadDailyLoss()
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

      // Expire any provisional debits older than 24h that never received a credit
      // (guard against suspended games or other edge cases that prevent settlement)
      await db.run(
        `DELETE FROM provisional_ledger
         WHERE type = 'debit'
           AND created_at < datetime('now', '-24 hours')
           AND ks_bet_id NOT IN (SELECT ks_bet_id FROM provisional_ledger WHERE type = 'credit')`,
      ).catch(() => {})

      await sendDailyReport()

      // Preflight retrospective: fill in would_win/would_lose for skipped pitchers
      try {
        const { default: { execSync } } = await import('child_process')
        execSync(`node scripts/live/preflightRetro.js --date ${TODAY}`, {
          cwd: process.cwd(), timeout: 30_000, encoding: 'utf8', stdio: 'inherit',
        })
      } catch (err) {
        console.error('[live] preflightRetro failed (non-fatal):', err.message?.slice(0, 80))
      }

      break
    }

    const sleepSec = urgentThisCycle ? FAST_SEC : POLL_SEC
    if (urgentThisCycle) process.stdout.write(`⚡${sleepSec}s `)
    await new Promise(r => setTimeout(r, sleepSec * 1000))
  }

  await db.close()
}

main().catch(err => {
  console.error('[live] fatal:', err.message)
  process.exit(1)
})
