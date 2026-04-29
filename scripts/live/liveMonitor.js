// scripts/live/liveMonitor.js — In-game live signal monitor + auto-trader
//
// Polls live box scores every POLL_INTERVAL seconds once games are underway.
// For each active pitcher, recalculates λ using current game state (Ks, IP,
// pitch count) and checks Kalshi for live prices. When a new in-game edge
// ≥ LIVE_EDGE_MIN is found, it bets (paper or real) sized by Kelly.
//
//
// Daily loss limit: DAILY_LOSS_LIMIT (default $500) — stops all trading if hit.
//
// Usage:
//   node scripts/live/liveMonitor.js [--date YYYY-MM-DD] [--poll 15]
//
// Run after morning dailyRun.sh. Keeps running until all today's games finish.

import 'dotenv/config'
import * as db from '../../lib/db.js'
import { getAuthHeaders, placeOrder, cancelOrder, cancelAllOrders, getOrder, getMarketPrice, getSettlements, getBalance as getKalshiBalance, getQueuePosition, amendOrder, getOrderbook, availableDepth, listOrders, getFills, listMarkets } from '../../lib/kalshi.js'
import { mlbGet, mlbFeedLive } from '../../lib/mlb-live.js'
import { createKalshiTickerWs } from '../../lib/kalshiWs.js'
import { kellySizing, correlatedKellyDivide, config as kellyConfig } from '../../lib/kelly.js'
import { alertStaleFireBlocked, alertExtremeDivergence } from '../../lib/healthAlerts.js'
import { notifyLiveBet, notifyFreeMoney, notifyCrossedYes, notifyBlowout, notifyHedge, notifyScratch, notifyCovered, notifyDead, notifyOneAway, notifyGameResult, notifyDailyReport, getAllWebhooks, notifyCertaintyParlay } from '../../lib/discord.js'
import { buildCertaintyParlay, parlayKey } from '../../lib/dkParlay.js'
import { NB_R, LEAGUE_K_PCT, LEAGUE_PA_PER_IP, nbCDF, pAtLeast, archetypeR, ipToDecimal } from '../../lib/strikeout-model.js'
import { buildSnapshotRow, writeSnapshotBatch, linkBetToSnapshot, backfillOutcome } from '../../lib/marketSnapshotWriter.js'
import { seedDefaults, getRules, invalidateCache as invalidateRulesCache } from '../../lib/bettingRules.js'
import { parseArgs } from '../../lib/cli-args.js'
import { getAvailablePool, getPerUserAvailablePool, addCommitted } from '../../lib/bankrollState.js'
import { acquireBetLock, confirmBetPlaced, releaseBetLock } from '../../lib/betLock.js'
import { alertError } from '../../lib/errorSentinel.js'

const opts     = parseArgs({
  date: { default: new Date().toISOString().slice(0, 10) },
  poll: { type: 'number', default: 5 },
})
const TODAY       = opts.date
const POLL_SEC    = opts.poll
const LIVE        = true  // always live — use users.paper=1 to paper-trade a specific user
const LIVE_EDGE   = Number(process.env.LIVE_EDGE_MIN || 0.08)
const LOSS_LIMIT  = Number(process.env.DAILY_LOSS_LIMIT || 500)

const MLB_BASE        = 'https://statsapi.mlb.com/api/v1'
// Field filters reduce boxscore payload ~80% — only pull what extractStarterFromBoxscore needs
const LS_FIELDS       = 'abstractGameState,currentInning,currentInningOrdinal,teams,offense,defense'
const BOX_FIELDS      = 'teams.home.pitchers,teams.away.pitchers,teams.home.players,teams.away.players,teams.home.battingOrder,teams.away.battingOrder'
// Max USD risk per free-money taker order per strike threshold (pulled pitcher)
let PULLED_CAP_USD    = Number(process.env.PULLED_CAP_USD    || 10)
// Max USD total free-money spend across all strike thresholds for one pulled pitcher
let FREE_MONEY_PITCHER_CAP = Number(process.env.FREE_MONEY_PITCHER_CAP || 30)
// Max USD risk per dead-path NO taker (high pitch count, gap structurally uncloseable)
let DEAD_PATH_CAP_USD = Number(process.env.DEAD_PATH_CAP_USD || 10)
const AVG_PITCHES_PER_IP = 17   // ~17 pitches per IP for starters
// Max ¢ to pay for YES when threshold is already crossed (Kalshi market lag — near-certain win)
// Raised from 20→35: outcome is 100% certain (currentKs >= n), buying at 35¢ still yields ~60¢ net/contract
let CROSSED_YES_MAX_ASK  = Number(process.env.CROSSED_YES_MAX_ASK  || 35)
// Blowout NO: team losing by ≥BLOWOUT_DEFICIT runs in inning ≥BLOWOUT_INNING with ≥BLOWOUT_K_GAP still needed
let BLOWOUT_DEFICIT      = Number(process.env.BLOWOUT_DEFICIT      || 5)
let BLOWOUT_INNING       = Number(process.env.BLOWOUT_INNING       || 6)
let BLOWOUT_K_GAP        = Number(process.env.BLOWOUT_K_GAP        || 3)
// Early blowout tier: deficit ≥ this in inning ≥ EARLY_BLOWOUT_INNING with K gap ≥ 2
let EARLY_BLOWOUT_DEFICIT = Number(process.env.EARLY_BLOWOUT_DEFICIT || 7)
let EARLY_BLOWOUT_INNING  = Number(process.env.EARLY_BLOWOUT_INNING  || 5)
let EARLY_BLOWOUT_PITCH   = Number(process.env.EARLY_BLOWOUT_PITCH   || 65)
// Late-inning NO: 9th inning+, needs ≥ 2 more Ks, pitch count ≥ this, model prob < LATE_INN_MAX_PROB
let LATE_INN_MIN_PITCH    = Number(process.env.LATE_INN_MIN_PITCH    || 70)
let LATE_INN_MAX_PROB     = Number(process.env.LATE_INN_MAX_PROB     || 0.20)

// Apr 28 — lowered from 85 → 70 so hedge arms earlier. At 85 pitches a starter is typically
// already in the 6th–7th and the NO market has often already moved, making hedge insurance
// expensive. 70 pitches catches the late-5th window when fatigue starts mattering, NO is
// still cheap, and the structural ceiling is informative. The 4-signal confidence score
// (lines 162-227) still gates final arming — lowering this just lets us *consider* sooner.
let PULL_PITCH_COUNT      = Number(process.env.PULL_PITCH_COUNT      || 70)
let PULL_MIN_IP           = Number(process.env.PULL_MIN_IP           || 4)    // minimum IP before tracking pull risk
const QUEUE_GOOD_THRESHOLD  = Number(process.env.QUEUE_GOOD_THRESHOLD  || 10)   // qp ≤ this → leave it
const QUEUE_AMEND_THRESHOLD = Number(process.env.QUEUE_AMEND_THRESHOLD || 30)   // qp ≤ this → amend price
let QUEUE_AMEND_CENTS     = Number(process.env.QUEUE_AMEND_CENTS     || 1)    // ¢ to shift when amending

// Live Bayesian model cap — max weight given to in-game observed K% (readable from betting_rules)
let LIVE_BAYESIAN_WEIGHT_CAP = 0.75
// Pulled cap for two-tier confirmed pulls (reliever on mound or substitution event)
let PULLED_CAP_CONFIRMED_USD = 60
// Max USD risk per pull-hedge NO order per bettor (portfolio insurance sizing)
let PULL_HEDGE_MAX_USD = Number(process.env.PULL_HEDGE_MAX_USD || 60)
// Hard ceiling on a single live bet (cash USD, before fills). Belt-and-suspenders cap layered
// on top of MAX_BET_PCT × bankroll. Prevents tonight's Paddack-2+ scenario where a stale model
// produced a 60% "edge" against a 0.5¢ market and Kelly authorized a $500 cash bet → $666.68 loss.
let LIVE_HIGH_CONVICTION_CAP_USD = Number(process.env.LIVE_HIGH_CONVICTION_CAP_USD || 200)
// Per-pitcher cumulative cap for model-driven modes (high-conviction / stack-yes / dead-path).
// Limits total per-pitcher exposure across all strike thresholds — prevents the case where
// 5 strikes (2+/3+/4+/5+/6+) each hit the per-bet cap and we end up $1000 deep on one pitcher.
let LIVE_HC_PITCHER_CAP_USD = Number(process.env.LIVE_HC_PITCHER_CAP_USD || 300)
// Conservative pitch count ceiling for structural ceiling calculation
// Managers rarely extend past 105 — use this as worst-case remaining batter estimate
let CONSERVATIVE_PULL_PITCH = Number(process.env.CONSERVATIVE_PULL_PITCH || 105)

// _computeHedgePlan — pure portfolio-insurance math.
// Given a bettor's YES position and the current NO market, returns the optimal
// hedge contract count and whether buying it improves expected value.
//
// Returns:
//   { qualified: true, hedgeContracts, hedgeCost, capped, fullOffset, evHedge, evNoHedge, reason: 'qualified' }
//   { qualified: false, reason: 'noAsk-out-of-range' | 'fullOffset-zero' | 'ev-gate-fail', ... }
function _computeHedgePlan({ yesFilledContracts, yesFillCents, noAskCents, modelProb, maxUSD }) {
  if (noAskCents <= 0 || noAskCents >= 100) return { qualified: false, reason: 'noAsk-out-of-range' }
  if (!yesFilledContracts || yesFilledContracts <= 0) return { qualified: false, reason: 'fullOffset-zero' }

  const kalshiFee       = 0.93
  const yesFillFrac     = yesFillCents / 100
  const noAskFrac       = noAskCents / 100
  const noNetPerContract = (1 - noAskFrac) * kalshiFee

  // Full offset: NOs needed so that if YES fails, the NO payout covers the YES capital loss
  const yesExposure  = yesFilledContracts * yesFillFrac
  const fullOffset   = Math.ceil(yesExposure / noNetPerContract)
  if (fullOffset <= 0) return { qualified: false, reason: 'fullOffset-zero' }

  // EV gate: the NO leg must itself have positive expected value for the hedge to be worthwhile.
  // evNoLeg = (1-p)*noNetPerContract - p*noAskFrac
  // If evNoLeg ≤ 0, paying for the NO destroys more EV than it protects.
  const evYesPerContract = modelProb * (1 - yesFillFrac) - (1 - modelProb) * yesFillFrac
  const evNoLeg          = (1 - modelProb) * noNetPerContract - modelProb * noAskFrac
  const evHedge          = yesFilledContracts * evYesPerContract + fullOffset * evNoLeg
  const evNoHedge        = yesFilledContracts * evYesPerContract
  if (evNoLeg <= 0) return { qualified: false, reason: 'ev-gate-fail', evHedge, evNoHedge }

  // Cap: never spend more than maxUSD on NO contracts for a single hedge
  const rawCost        = fullOffset * noAskFrac
  const capped         = rawCost > maxUSD
  const hedgeContracts = capped ? Math.max(1, Math.floor(maxUSD / noAskFrac)) : fullOffset
  const hedgeCost      = hedgeContracts * noAskFrac

  return { qualified: true, hedgeContracts, hedgeCost, capped, fullOffset, evHedge, evNoHedge, reason: 'qualified' }
}

// ── Hedge confidence: pure functions (no DB/API deps, fully testable) ─────────

// Signal 1: Maximum additional batters the pitcher can face before a conservative pull.
// Uses this game's actual pitch efficiency (currentPitches/currentBF) — not a global average.
// Returns integer: max additional batters. 0 = already at or past pull point.
function structuralCeiling({ currentPitches, currentBF, conservativePullPitch = CONSERVATIVE_PULL_PITCH }) {
  if (!currentBF || currentBF <= 0) return 999   // no data — leave open
  const pitchesPerBF     = currentPitches / currentBF
  const remainingPitches = Math.max(0, conservativePullPitch - currentPitches)
  return Math.floor(remainingPitches / pitchesPerBF)
}

// Signal 2: Poisson-binomial P(getting ≥ needed Ks from these specific batters).
// Each batter has an independent kPct — this is NOT a simple binomial (each p_i differs).
// DP runs in O(N²) — N ≤ 5, so it's trivial cost.
function batterGauntletProb(nextBatters, needed) {
  const probs = (nextBatters ?? []).map(b => Math.max(0.01, Math.min(0.99, b.kPct ?? 0.20)))
  const N = probs.length
  if (needed <= 0) return 1.0
  if (needed > N)  return 0.0   // mathematically impossible from this many batters
  const dp = new Array(N + 1).fill(0)
  dp[0] = 1.0
  for (let i = 0; i < N; i++) {
    const p = probs[i]
    for (let j = i + 1; j >= 1; j--) dp[j] = dp[j] * (1 - p) + dp[j - 1] * p
    dp[0] *= (1 - p)
  }
  let pAtLeast = 0
  for (let k = needed; k <= N; k++) pAtLeast += dp[k]
  return Math.max(0, Math.min(1, pAtLeast))
}

// Combined 4-signal confidence scorer for pull-hedge decisions.
// Returns { score (0-100), confident (bool), sizeMultiplier (0-1), signals (object) }
// Score ≥ 45 → confident to hedge. Size scales with score.
function computeHedgeConfidence({
  needed, currentPitches, currentBF, noMid, modelProb,
  nextBatters, scoreDiff, currentInn,
}) {
  const signals = {}
  let score = 0

  // ── Signal 1: Structural ceiling (hard arithmetic) ──────────────────────────
  const ceiling = structuralCeiling({ currentPitches, currentBF })
  signals.ceiling  = ceiling
  signals.needed   = needed
  if (ceiling < needed) {
    signals.structural = 'impossible'   // mathematical certainty — threshold can't be reached
    score += 50
  } else if (ceiling <= needed) {
    signals.structural = 'tight'        // exactly enough batters — every one would need a K
    score += 30
  } else if (ceiling <= needed + 2) {
    signals.structural = 'limited'      // 1-2 batter cushion above minimum
    score += 15
  } else {
    signals.structural = 'open'
  }

  // ── Signal 2: Batter gauntlet (upcoming hitters' K%) ────────────────────────
  const hasGauntletData = Array.isArray(nextBatters) && nextBatters.some(b => b.kPct != null)
  if (hasGauntletData) {
    const pHit = batterGauntletProb(nextBatters.slice(0, 3), needed)
    signals.gauntletProb = pHit
    if      (pHit < 0.05) score += 30
    else if (pHit < 0.10) score += 20
    else if (pHit < 0.20) score += 10
    else if (pHit < 0.30) score += 5
  } else {
    signals.gauntletProb = null   // no batter data — don't penalize, don't reward
  }

  // ── Signal 5: Market + model dual confirmation ───────────────────────────────
  // Both the live model AND the Kalshi market should agree the outcome is unlikely.
  const marketNoProb = noMid / 100
  signals.modelProb    = modelProb
  signals.marketNoProb = marketNoProb
  if      (marketNoProb >= 0.65 && modelProb <= 0.20) { signals.marketModel = 'strong';   score += 20 }
  else if (marketNoProb >= 0.55 && modelProb <= 0.30) { signals.marketModel = 'moderate'; score += 10 }
  else if (marketNoProb >= 0.45 && modelProb <= 0.40) { signals.marketModel = 'weak';     score += 5  }
  else                                                  { signals.marketModel = 'diverged'              }

  // ── Signal 6: Game state (manager pull incentives) ──────────────────────────
  const inn = typeof currentInn === 'number' ? currentInn
    : parseInt(String(currentInn ?? '').replace(/\D/g, '')) || 0
  signals.inning    = inn
  signals.scoreDiff = scoreDiff
  if      (scoreDiff <= -4 && inn >= 6) { signals.gameState = 'blowout-pull'; score += 15 }
  else if (scoreDiff <= -2 && inn >= 7) { signals.gameState = 'losing-late';  score += 10 }
  else if (inn >= 8)                    { signals.gameState = 'very-late';     score += 5  }
  else if (scoreDiff >= 4 && inn >= 6)  { signals.gameState = 'winning-big';   score += 5  }
  else                                  { signals.gameState = 'normal'                      }

  const confident      = score >= 45
  const sizeMultiplier = score >= 90 ? 1.00
                       : score >= 70 ? 0.75
                       : score >= 45 ? 0.50
                       : 0

  return { score, confident, sizeMultiplier, signals }
}

// ── Batter lineup data ─────────────────────────────────────────────────────────
// Keyed by MLB personId. Stats don't change during a game — 24h TTL is safe.
const _batterStatsCache = new Map()   // personId → { kPct, name, fetchedAt }
const BATTER_STATS_TTL_MS = 24 * 60 * 60 * 1000

// Fetch season K% (strikeOuts/atBats) for a batch of batter IDs.
// Caches per-batter so each player is fetched at most once per day.
async function fetchBatterKPcts(personIds) {
  const now = Date.now()
  const result = {}
  const toFetch = []

  for (const id of personIds) {
    const cached = _batterStatsCache.get(id)
    if (cached && (now - cached.fetchedAt) < BATTER_STATS_TTL_MS) {
      result[id] = cached.kPct
    } else {
      toFetch.push(id)
    }
  }

  if (toFetch.length > 0) {
    const season = new Date().getFullYear()
    const url = `${MLB_BASE}/people?personIds=${toFetch.join(',')}&hydrate=stats(group=[hitting],type=[season],season=${season})&fields=people,id,fullName,stats,splits,stat,strikeOuts,atBats`
    const data = await mlbGet(url).catch(() => null)
    if (data?.people) {
      for (const person of data.people) {
        const stat = person.stats?.[0]?.splits?.[0]?.stat
        const ab   = stat?.atBats ?? 0
        // Require ≥30 AB before trusting K%; default 0.20 (league average) for small samples
        const kPct = ab >= 30 ? stat.strikeOuts / ab : null
        _batterStatsCache.set(person.id, { kPct, name: person.fullName ?? `Player ${person.id}`, fetchedAt: now })
        result[person.id] = kPct
      }
    }
  }

  return result
}

// Get the next 2-3 batters the pitcher will face, with their season K%.
// Returns [] if pitcher is not currently on the mound or data is unavailable.
async function fetchNextBatters(feed, pitcherSide) {
  // Which half-inning should this pitcher be pitching?
  // Home pitcher pitches during 'top' (away bats); away pitcher during 'bottom' (home bats)
  const inningHalf   = feed?.liveData?.linescore?.inningHalf?.toLowerCase() ?? ''
  const expectedHalf = pitcherSide === 'home' ? 'top' : 'bottom'
  if (inningHalf !== expectedHalf) return []   // wrong half — pitcher not currently pitching

  const battingSide  = pitcherSide === 'home' ? 'away' : 'home'
  const battingOrder = (feed?.liveData?.boxscore?.teams?.[battingSide]?.battingOrder ?? []).map(Number)
  if (!battingOrder.length) return []

  const currentBatterId = feed?.liveData?.linescore?.offense?.batter?.id
  if (!currentBatterId) return []

  const currentIdx = battingOrder.indexOf(Number(currentBatterId))
  if (currentIdx === -1) return []

  // Next 2-3 batters after the current at-bat (lineup wraps around)
  const nextIds = []
  for (let i = 1; i <= 3; i++) nextIds.push(battingOrder[(currentIdx + i) % battingOrder.length])

  const statsMap = await fetchBatterKPcts(nextIds)
  return nextIds.map(id => ({
    id,
    kPct: statsMap[id] ?? null,
    name: _batterStatsCache.get(id)?.name ?? `Player ${id}`,
  }))
}

// ── Adaptive polling state ─────────────────────────────────────────────────────
// Per-pitcher next-check timestamp (ms). Prevents high-frequency polls when a
// pitcher is far from any threshold (60s). Collapses to 10-15s when ≤5 BF away.
const _pitcherNextCheckAt = new Map()  // String(pitcherId) → timestamp ms

// Certainty parlay tracking — accumulate crossed-YES legs, fire when 2+ hit from different pitchers
const _certLegs          = new Map()   // `${pitcherName}-${strike}` → leg object
const _certParlaySent    = new Set()   // parlayKey strings already notified today

// Returns ms to wait before next check based on BF distance to nearest threshold
function _adaptivePollMs(currentBF, qualifiedThresholds) {
  if (!qualifiedThresholds || qualifiedThresholds.length === 0) return 60_000
  // >= so exact threshold hit (minDist=0) returns 0ms for immediate action
  const remaining = qualifiedThresholds.filter(t => t >= currentBF)
  if (!remaining.length) return 90_000   // all crossed — still monitor but less often
  const minDist = Math.min(...remaining.map(t => t - currentBF))
  if (minDist === 0) return 0            // exactly at threshold — fire immediately
  if (minDist <= 2)  return 8_000        // ≤2 BF away — 8s
  if (minDist <= 5)  return 15_000       // ≤5 BF away — 15s
  if (minDist <= 10) return 30_000       // ≤10 BF away — 30s
  return 60_000                          // far away — 60s
}

// ── Kalshi outage detection ────────────────────────────────────────────────────
// 3 consecutive API failures → declare outage, halt new orders, Discord alert.
// Outage clears when any API call succeeds.
let _kalshiConsecutiveFailures = 0
let _kalshiOutageStart = null
const KALSHI_OUTAGE_THRESHOLD = 3

async function _trackKalshiResult(success, webhooksGetter) {
  if (success) {
    if (_kalshiOutageStart) {
      const dur = ((Date.now() - _kalshiOutageStart) / 60000).toFixed(1)
      console.log(`\n[liveMonitor] ✅ Kalshi API restored after ${dur}min outage`)
      db.run(`INSERT OR REPLACE INTO system_flags (key, value, updated_at, updated_by) VALUES ('kalshi_outage','0',datetime('now'),'liveMonitor')`).catch(() => {})
      _kalshiOutageStart = null
    }
    _kalshiConsecutiveFailures = 0
    return
  }
  _kalshiConsecutiveFailures++
  if (_kalshiConsecutiveFailures >= KALSHI_OUTAGE_THRESHOLD && !_kalshiOutageStart) {
    _kalshiOutageStart = Date.now()
    console.error(`\n[liveMonitor] ⚠️ Kalshi API OUTAGE — ${_kalshiConsecutiveFailures} consecutive failures. Halting new orders.`)
    db.run(`INSERT OR REPLACE INTO system_flags (key, value, updated_at, updated_by) VALUES ('kalshi_outage','1',datetime('now'),'liveMonitor')`).catch(() => {})
    try {
      const wh = await webhooksGetter()
      const { notifyAlert } = await import('../lib/discord.js')
      await notifyAlert({ title: '⚠️ Kalshi API Degraded', description: `${_kalshiConsecutiveFailures} consecutive API failures. New orders halted. Monitoring continues.`, color: 0xff6600 }, wh)
    } catch {}
  }
}

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
  // Derive NB dispersion r from per-BF K rate (proxy for k_pct when statcast not available).
  const nbR = pK_blended >= 0.28 ? 20 : pK_blended <= 0.19 ? 50 : 30

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
    const w_live   = Math.min(LIVE_BAYESIAN_WEIGHT_CAP, currentBF / 30)
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
  // Only the BF≥18 step (TTO3 start) is applied here. The BF≥24 step was removed:
  // at that depth the Bayesian live blend (now up to 0.75 weight) already captures
  // observed K-rate regression from TTO fatigue, so applying a fixed penalty on top
  // double-counts the same signal.
  if (currentBF >= 18) pK_effective *= 0.85  // 3rd time through lineup

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
      return pAtLeast(lambdaRemaining, n - currentKs, nbR)
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
    const res = await listMarkets({ eventTicker, seriesTicker: 'KXMLBKS', status: 'open', limit: 20 })
    const all = res?.markets || []
    return all.filter(m => m.ticker.startsWith(ticker + '-'))
  } catch { return [] }
}

// ── Kalshi ticker pull-signal state ──────────────────────────────────────────
// When the Kalshi WS ticker shows a sharp YES mid drop (≥15¢ or below 8¢),
// the pitcher was almost certainly pulled by a TV-watching trader before the
// MLB API boxscore updates. We add the pitcherId to this set and force an
// urgent poll cycle so the pull confirmation runs within seconds.
const _kalshiPullSignal = new Set()  // pitcherIds with active Kalshi pull signal
const _tickerLastMid    = new Map()  // ticker → last YES mid (cents)
const _pullFired        = new Set()  // pitcherIds where pull free-money has already fired (prevents re-trigger)
const _openerSkipLogged = new Set()  // pitcherIds where opener exit was detected — log once, then quietly skip free-money

// ── Daily loss guard ─────────────────────────────────────────────────────────

let _dailyLoss = 0
let _dailyNetPnl = 0  // net P&L today (all settled bets, pre-game + live)
let _dailyReportSent = false  // gate to prevent duplicate EOD Discord reports on crash+restart
let _haltLogged = false  // suppress repeated halt log messages

async function loadDailyLoss() {
  // Use actual Kalshi balance delta (snapshot → current) for live bettors, minus any
  // manual adjustments (deposits/withdrawals) so a mid-day deposit doesn't hide losses.
  const rows = await db.all(
    `SELECT u.id AS user_id, u.kalshi_balance, bs.balance_usd AS snapshot_balance
     FROM users u
     JOIN balance_snapshots bs ON bs.user_id = u.id AND bs.date = ?
     WHERE u.active_bettor = 1 AND u.paper = 0 AND u.kalshi_key_id IS NOT NULL`,
    [TODAY],
  )
  if (rows.length) {
    let netPnl = 0
    for (const r of rows) {
      const adjRow = await db.one(
        `SELECT COALESCE(SUM(amount_usd), 0) AS net_adj FROM manual_balance_adjustments
         WHERE user_id = ? AND created_at >= ?`,
        [r.user_id, TODAY + 'T00:00:00.000Z'],
      ).catch(() => null)
      netPnl += ((r.kalshi_balance ?? 0) - (r.snapshot_balance ?? 0)) - (adjRow?.net_adj ?? 0)
    }
    _dailyLoss = Math.max(0, -netPnl)
  } else {
    // Fallback: no snapshots yet (first run of day before any bets)
    const fallback = await db.all(
      `SELECT SUM(CASE WHEN pnl < 0 THEN ABS(pnl) ELSE 0 END) as losses
         FROM ks_bets WHERE bet_date = ? AND result IN ('win','loss') AND paper = 0`,
      [TODAY],
    )
    _dailyLoss = fallback[0]?.losses || 0
  }
  return _dailyLoss
}

// Per-user daily loss in USD (positive = lost money).
// Subtracts any manual balance adjustments (deposits/withdrawals) made since the
// snapshot so that a mid-day deposit doesn't mask a real trading loss.
async function getUserDailyLoss(userId) {
  try {
    const row = await db.one(
      `SELECT u.kalshi_balance, bs.balance_usd AS snapshot_balance, bs.date AS snap_date
       FROM users u
       JOIN balance_snapshots bs ON bs.user_id = u.id AND bs.date = ?
       WHERE u.id = ? AND u.paper = 0 AND u.kalshi_key_id IS NOT NULL`,
      [TODAY, userId],
    )
    if (!row) return 0
    const adjRow = await db.one(
      `SELECT COALESCE(SUM(amount_usd), 0) AS net_adj
       FROM manual_balance_adjustments
       WHERE user_id = ? AND created_at >= ?`,
      [userId, row.snap_date + 'T00:00:00.000Z'],
    ).catch(() => null)
    const netAdj   = adjRow?.net_adj ?? 0
    const rawDelta = (row.kalshi_balance ?? 0) - (row.snapshot_balance ?? 0)
    return Math.max(0, -(rawDelta - netAdj))
  } catch { return 0 }
}

async function reloadDailyNetPnl() {
  // Use actual Kalshi balance delta minus any manual adjustments (deposits/withdrawals)
  // made since the snapshot — same source as the dashboard today P&L.
  const rows = await db.all(
    `SELECT u.id AS user_id, u.kalshi_balance, bs.balance_usd AS snapshot_balance
     FROM users u
     JOIN balance_snapshots bs ON bs.user_id = u.id AND bs.date = ?
     WHERE u.active_bettor = 1 AND u.paper = 0 AND u.kalshi_key_id IS NOT NULL`,
    [TODAY],
  )
  if (rows.length) {
    let total = 0
    for (const r of rows) {
      const adjRow = await db.one(
        `SELECT COALESCE(SUM(amount_usd), 0) AS net_adj FROM manual_balance_adjustments
         WHERE user_id = ? AND created_at >= ?`,
        [r.user_id, TODAY + 'T00:00:00.000Z'],
      ).catch(() => null)
      const netAdj = adjRow?.net_adj ?? 0
      total += ((r.kalshi_balance ?? 0) - (r.snapshot_balance ?? 0)) - netAdj
    }
    _dailyNetPnl = total
  } else {
    const fallback = await db.one(
      `SELECT COALESCE(SUM(pnl), 0) as net FROM ks_bets WHERE bet_date = ? AND result IN ('win','loss') AND paper = 0`,
      [TODAY],
    )
    _dailyNetPnl = fallback?.net || 0
  }
  return _dailyNetPnl
}

// ── Place or paper-log a live bet ─────────────────────────────────────────────


async function executeBet({ pitcherName, pitcherId, game, strike, side, modelProb, marketMid, edge, ticker, betSize, kellyFraction, capitalRisk,
  liveKs, liveIP, livePitches, liveBF, liveInning, livePkEffective, liveLambda, liveScore, mode = 'normal', hedgeOverride = null, user }) {
  // ── Apr 29 — Belt-and-suspenders mode kill switch ──
  // The qualifying[] filter at line ~3263 should prevent disabled modes from reaching
  // executeBet. If they somehow do (race, bug, alternate path), refuse here as a final
  // safety floor. Triggered by Bradley 8+ YES live bet on 4/29 that escaped the
  // upstream filter in some still-unexplained path.
  const _executeBetDisabled = String(process.env.DISABLED_LIVE_MODES || '')
    .split(',').map(s => s.trim()).filter(Boolean)
  if (_executeBetDisabled.includes(mode)) {
    console.log(`[liveMonitor] 🚫 SAFETY-FLOOR refusing executeBet — mode '${mode}' is in DISABLED_LIVE_MODES (${pitcherName} ${strike}+ ${side})`)
    db.saveLog({
      tag: 'BUG', level: 'error',
      msg: `executeBet safety floor caught a disabled-mode bet that escaped upstream filter: ${pitcherName} ${strike}+ ${side} mode=${mode}`,
      pitcher: pitcherName, strike, side,
    }).catch(() => {})
    return { skipped: true, reason: `mode_disabled:${mode}` }
  }
  // ── Kill switch (Item 2) ──
  const haltFlag = await db.one(`SELECT value FROM system_flags WHERE key='trading_halted'`).catch(() => null)
  if (haltFlag?.value === '1') {
    console.log(`[liveMonitor] HALTED — skipping ${pitcherName} ${strike}+ ${side}`)
    // Discord alert (deduped — fires once per halted state regardless of how many bets attempted)
    import('../../lib/healthAlerts.js').then(m => m.alertTradingHalted({ value: 1 })).catch(() => {})
    return { halted: true }
  }
  // ── Apr 28 stale-fire guards ────────────────────────────────────────────────
  // Guard 1: game already settled — never fire on a finished game (caused Kochanowicz
  // 5+ bet at 03:14, 215 min after first pitch, when the game was already over).
  if (game?.id && settledGames.has(game.id)) {
    console.log(`[live] 🛑 STALE-FIRE  ${pitcherName} ${strike}+ ${side} skipped — game already settled`)
    db.saveLog({ tag: 'BUG', level: 'warn', msg: `stale-fire blocked: ${pitcherName} ${strike}+ ${side} (game already final)`, pitcher: pitcherName, strike, side })
    alertStaleFireBlocked({ pitcherName, strike, side, reason: 'game already settled' }).catch(() => {})
    return { stale: true }
  }
  // Guard 2: game began > 4.5 hours ago — even with extra innings, bets this late are
  // virtually always processing-stale state (caught Paddack 2+ at 87 min late where
  // the live model fed on stale lambda/pitch-count snapshots).
  const gameStartMs = game?.game_time ? Date.parse(game.game_time) : null
  if (gameStartMs && Date.now() - gameStartMs > 4.5 * 60 * 60 * 1000) {
    const ageMin = Math.round((Date.now() - gameStartMs) / 60000)
    console.log(`[live] 🛑 STALE-FIRE  ${pitcherName} ${strike}+ ${side} skipped — game started ${ageMin}min ago`)
    db.saveLog({ tag: 'BUG', level: 'warn', msg: `stale-fire blocked: ${pitcherName} ${strike}+ ${side} (${ageMin}min after first pitch)`, pitcher: pitcherName, strike, side })
    alertStaleFireBlocked({ pitcherName, strike, side, reason: `game started ${ageMin} min ago` }).catch(() => {})
    return { stale: true }
  }
  // ── Drawdown scale (Item 6) ──
  const ddFlag = await db.one(`SELECT value FROM system_flags WHERE key='drawdown_scale'`).catch(() => null)
  const ddScale = Number(ddFlag?.value ?? 1.0)
  if (ddScale !== 1.0 && ddScale > 0) {
    betSize = betSize * ddScale
    console.log(`[liveMonitor] drawdown scale ${ddScale}× → $${betSize.toFixed(2)} for ${pitcherName}`)
  }

  const isLive = LIVE && user?.paper === 0
  const userId = user?.id ?? null
  const creds  = user?.kalshi_key_id
    ? { keyId: user.kalshi_key_id, privateKey: user.kalshi_private_key }
    : {}
  const now    = new Date().toISOString()

  // DB-level dedup — use IS for null-safe comparison (libSQL requires explicit IS NULL branch)
  const dedupQuery = userId != null
    ? `SELECT id FROM ks_bets WHERE bet_date=? AND pitcher_name=? AND strike=? AND side=? AND live_bet=1 AND user_id=?`
    : `SELECT id FROM ks_bets WHERE bet_date=? AND pitcher_name=? AND strike=? AND side=? AND live_bet=1 AND user_id IS NULL`
  const dedupParams = userId != null
    ? [TODAY, pitcherName, strike, side, userId]
    : [TODAY, pitcherName, strike, side]
  const existing = await db.one(dedupQuery, dedupParams)
  if (existing) return { dedup: true }

  // betSize is dollars (from kellySizing); convert to integer contract count.
  // orderCents is the estimated fill price per contract in cents (e.g. 64 → $0.64/contract).
  let orderCents     = Math.max(1, Math.round(side === 'YES' ? marketMid : 100 - marketMid))
  let finalContracts = Math.max(1, Math.round((betSize * 100) / orderCents))
  let freeMoneySummary = null  // set below for pulled-mode notifications
  let orderId    = null  // captured from placeOrder response so ksFillSync + WS applier can track it
  let initFilled = 0    // taker orders may fill immediately; capture so the DB row is accurate from the start

  // ── Kalshi outage guard ──
  if (_kalshiConsecutiveFailures >= KALSHI_OUTAGE_THRESHOLD) {
    console.log(`  [kalshi-outage] ${pitcherName} ${strike}+ ${side} — API degraded, skipping order`)
    return { freeMoneySummary: null, kalshiOutage: true }
  }

  if (isLive) {
    // Skip orderbook fetch for time-critical structural modes — saves 200-500ms.
    // Pulled/crossed-yes windows last ~1s; spending half of it on a roundtrip is costly.
    // Fallback pricing (mid ± buffer) is still aggressive enough for these near-certain outcomes.
    const ob = (mode === 'pulled' || mode === 'crossed-yes' || mode === 'blowout')
      ? null
      : await getOrderbook(ticker, 10, creds).catch(() => null)

    if (mode === 'pulled' || mode === 'dead-path' || mode === 'crossed-yes' || mode === 'blowout' || mode === 'pull-hedge') {
      // ── STRUCTURAL EDGE: taker order — hit the ask immediately ──
      // pulled      → pitcher removed, outcome determined (certainty)
      // crossed-yes → threshold already crossed, YES market hasn't repriced (certainty)
      // blowout     → large deficit late in game, pull imminent (near-certainty)
      // dead-path   → high pitch count, 3+ K gap, market still fat (near-certainty)
      // pull-hedge  → portfolio insurance NO, sized to offset YES exposure exactly
      // Speed > fees in all cases; maker orders risk sitting unfilled as market reprices.
      // crossed-yes is a YES taker — skips game_reserves (which track NO-side spending)
      // pull-hedge skips game_reserves — it's insurance, not a new directional position
      const usesGameReserves = mode !== 'crossed-yes' && mode !== 'pull-hedge'
      let capUSD = mode === 'dead-path' ? DEAD_PATH_CAP_USD : FREE_MONEY_PITCHER_CAP
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

      if (mode === 'pull-hedge') {
        // Portfolio insurance: contract count and ask price come from _computeHedgePlan (bettor loop).
        // Use live orderbook ask if available; fall back to hedgeOverride.noAskCents + 2¢ buffer.
        const liveNoAsk = ob?.best_no_ask ?? ((hedgeOverride?.noAskCents ?? Math.round(100 - marketMid)) + 2)
        orderCents     = Math.min(99, liveNoAsk + 2)
        finalContracts = Math.max(1, hedgeOverride?.hedgeContracts ?? 1)
      } else {
        // For pulled/crossed-yes (near-certain outcome), the market reprices fast after
        // the pull is detected. The stale orderbook ask may have already been lifted by
        // the time our order hits the exchange — leaving us resting below the new ask.
        // Fix: bid aggressively (ask + 15¢, capped at 97¢) to sweep available depth
        // even as the market moves. At 97¢ for a ~99% outcome the EV is still strongly +.
        const AGGRESSIVE_CAP    = mode === 'pulled' || mode === 'crossed-yes' ? 97 : 99
        const AGGRESSIVE_BUFFER = mode === 'pulled' || mode === 'crossed-yes' ? 15 : 2
        const baseAsk = side === 'NO'
          ? (ob?.best_no_ask  ?? Math.round(100 - marketMid + 2))
          : (ob?.best_yes_ask ?? Math.round(marketMid + 2))
        const aggAskCents  = Math.min(AGGRESSIVE_CAP, baseAsk + AGGRESSIVE_BUFFER)
        const maxByDollars = Math.floor(capUSD / (aggAskCents / 100))
        const depth        = ob ? availableDepth(ob, side.toLowerCase(), aggAskCents) : maxByDollars
        finalContracts     = Math.max(1, Math.min(maxByDollars, depth > 0 ? depth : maxByDollars))
        orderCents         = aggAskCents
      }
      const expectedProfit = finalContracts * ((100 - orderCents) / 100) * 0.93  // after Kalshi fee

      // API dedup: skip if we already have fills or resting orders on this ticker+side.
      // For time-critical pulled/crossed-yes modes use fills-only (one API call, ~200ms saved).
      // The window for free-money orders is ~1s; a full fills+resting check burns half of it.
      try {
        const sideKey = side.toLowerCase()
        if (mode === 'pulled' || mode === 'crossed-yes') {
          const existingFills = await getFills({ ticker, limit: 20 }, creds).catch(() => [])
          const filledContracts = existingFills.filter(f => f.side === sideKey).reduce((s, f) => s + Number(f.count_fp || 0), 0)
          if (filledContracts > 0) {
            console.log(`  [dedup] ${pitcherName} ${strike}+ ${side} (${user?.name}) — ${filledContracts} already filled, skipping`)
            return { freeMoneySummary: null, kalshiDedup: true }
          }
        } else {
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
        }
      } catch (dedupErr) {
        console.error(`  [dedup-err] ${pitcherName} ${strike}+ ${side} (${user?.name}) — API dedup check failed: ${dedupErr.message}`)
      }

      const _liveLockAcquired = await acquireBetLock(TODAY, String(pitcherId ?? pitcherName), strike, side, userId)
      if (!_liveLockAcquired) {
        console.log(`  [lock] SKIP ${pitcherName} ${strike}+ ${side} (${user?.name}) — concurrent process holds lock`)
        return { freeMoneySummary: null, kalshiDedup: true }
      }
      try {
        const betTag  = mode === 'pulled'     ? '💰 FREE MONEY TAKER'
                      : mode === 'crossed-yes'? '🟢 CROSSED-YES TAKER'
                      : mode === 'blowout'    ? '🏳️ BLOWOUT TAKER'
                      : mode === 'pull-hedge' ? '🛡️ PULL-HEDGE TAKER'
                      :                        '🚫 DEAD PATH TAKER'
        const logTag  = mode === 'pulled'     ? 'FREE MONEY'
                      : mode === 'crossed-yes'? 'CROSSED YES'
                      : mode === 'blowout'    ? 'BLOWOUT'
                      : mode === 'pull-hedge' ? 'PULL HEDGE'
                      :                        'DEAD PATH'
        let placed  = await placeOrder(ticker, side.toLowerCase(), finalContracts, orderCents, creds)
        let placedOrder = placed?.order ?? placed
        orderId    = placedOrder?.order_id ?? null
        initFilled = Math.round(parseFloat(placedOrder?.fill_count_fp ?? '0'))
        _trackKalshiResult(true, getAllWebhooks.bind(null, db)).catch(() => {})

        // If 0 fills immediately for near-certain structural modes, cancel and retry at 97¢.
        // Not applicable for pull-hedge (insurance order — no aggressive retry needed).
        if (initFilled === 0 && (mode === 'pulled' || mode === 'crossed-yes') && orderId) {
          const RETRY_CAP = 97
          if (RETRY_CAP > orderCents) {
            console.log(`  [retry] ${pitcherName} ${strike}+ ${side} — 0 fills @ ${orderCents}¢, cancelling and retrying @ ${RETRY_CAP}¢`)
            const originalOrderId = orderId
            const cancelled = await cancelOrder(orderId, creds).then(() => true).catch(() => false)
            orderId = null
            try {
              placed      = await placeOrder(ticker, side.toLowerCase(), finalContracts, RETRY_CAP, creds)
              placedOrder = placed?.order ?? placed
              orderId     = placedOrder?.order_id ?? null
              initFilled  = Math.round(parseFloat(placedOrder?.fill_count_fp ?? '0'))
              orderCents  = RETRY_CAP
              console.log(`  [retry] resubmitted @ ${RETRY_CAP}¢ — filled=${initFilled}`)
              db.saveLog({ tag: 'RETRY', msg: `[${logTag}] ${pitcherName} ${strike}+ ${side} retry @ ${RETRY_CAP}¢ filled=${initFilled}`, pitcher: pitcherName, strike, side })
            } catch (retryErr) {
              console.error(`  [retry-failed] ${pitcherName} ${strike}+ ${side}: ${retryErr.message} (original ${cancelled ? 'cancelled' : 'cancel-failed'}: ${originalOrderId})`)
              db.saveLog({ tag: 'ERROR', level: 'error', msg: `RETRY FAILED [${logTag}] ${pitcherName} ${strike}+ ${side} — original ${cancelled ? 'cancelled' : 'may still be resting'} ${originalOrderId}`, pitcher: pitcherName, strike, side })
            }
          }
        }

        console.log(`\n  [${betTag}] ${user?.name} ${pitcherName} ${strike}+ ${side} ${finalContracts}c @ ${orderCents}¢  filled=${initFilled}  profit≈+$${expectedProfit.toFixed(2)}`)
        db.saveLog({ tag: 'BET', msg: `[${logTag}] ${pitcherName} ${strike}+ ${side} ${finalContracts}c @ ${orderCents}¢ taker  filled=${initFilled}  profit≈+$${expectedProfit.toFixed(2)}`, pitcher: pitcherName, strike, side })
        freeMoneySummary = { askCents: orderCents, expectedProfit, yesPrice: Math.round(100 - orderCents) }
        // Debit available_pool for structural taker orders too (including pull-hedge)
        const structuralCommitted = finalContracts * (orderCents / 100)
        addCommitted(TODAY, structuralCommitted).catch(() => {})

        // Track spending against this pitcher's reserve — skipped for pull-hedge (insurance, not directional)
        if (usesGameReserves && pitcherId && userId) {
          const gameRow2 = await db.one(
            `SELECT id FROM games WHERE date = ? AND (pitcher_home_id = ? OR pitcher_away_id = ?)`,
            [TODAY, String(pitcherId), String(pitcherId)],
          ).catch(() => null)
          if (gameRow2) {
            const spent = finalContracts * (orderCents / 100)
            await db.run(
              `UPDATE game_reserves SET used_usd = used_usd + ?
               WHERE game_id = ? AND pitcher_id = ? AND bet_date = ? AND user_id = ?`,
              [spent, gameRow2.id, String(pitcherId), TODAY, userId],
            ).catch(() => {})
          }
        }
      } catch (err) {
        _trackKalshiResult(false, getAllWebhooks.bind(null, db)).catch(() => {})
        console.error(`  [ORDER FAILED] ${user?.name} ${pitcherName} ${strike}+ ${side}: ${err.message}`)
        db.saveLog({ tag: 'ERROR', level: 'error', msg: `ORDER FAILED [FREE MONEY] ${pitcherName} ${strike}+ ${side}: ${err.message}`, pitcher: pitcherName, strike, side })
        alertError('liveMonitor:orderFailed', err, {
          type: 'FREE MONEY', user: user?.name, pitcher: pitcherName, strike, side,
        }).catch(() => {})
        return { freeMoneySummary: null, apiFailed: true }
      } finally {
        releaseBetLock(TODAY, String(pitcherId ?? pitcherName), strike, side, userId).catch(() => {})
      }

    } else {
      // ── NORMAL EDGE: maker at ask-1¢, 75% fee discount ──
      // Check budget cap for normal bets only; pulled bets are capped by PULLED_CAP_USD above.
      // Per-user pool: user's own Kalshi balance minus their own committed capital.
      const availPool = await getPerUserAvailablePool(TODAY, userId).catch(() => 0)
      const bankroll  = availPool > 0 ? availPool : (user?.starting_bankroll || 1000)
      const cap   = bankroll * (user?.live_daily_risk_pct ?? user?.daily_risk_pct ?? 0.20)
      const spent = await db.one(
        `SELECT COALESCE(SUM(capital_at_risk), 0) as total FROM ks_bets WHERE bet_date=? AND live_bet=1 AND user_id=? AND result IS NULL`,
        [TODAY, userId],
      )
      // betSize is USD cash to spend (not contract-notional). Capital at risk = cash committed.
      // Previously used capitalAtRisk(betSize, price, side) which interpreted betSize as notional and
      // returned betSize × price — undercounting cheap-side bets by 1/price (catastrophic at <5¢ markets).
      const thisCap = betSize
      if ((spent?.total || 0) + thisCap > cap) {
        console.log(`  [CAP] ${user?.name} ${pitcherName} ${strike}+ ${side} skipped — live cap $${cap.toFixed(0)} reached (used=$${(spent?.total || 0).toFixed(0)}, this=$${thisCap.toFixed(0)})`)
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
      orderCents = askCents
      // Refine contract count using actual ask price.
      finalContracts = Math.max(1, Math.round((betSize * 100) / askCents))
      if (ob) {
        const depth = availableDepth(ob, side.toLowerCase(), askCents)
        if (depth > 0 && finalContracts > depth) {
          console.log(`  [depth] ${pitcherName} ${strike}+ ${side}: capping ${finalContracts}→${depth}c`)
          finalContracts = depth
        }
      }

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
      } catch (dedupErr) {
        console.error(`  [dedup-err] ${pitcherName} ${strike}+ ${side} (${user?.name}) — API dedup check failed: ${dedupErr.message}`)
      }

      const _normalLockAcquired = await acquireBetLock(TODAY, String(pitcherId ?? pitcherName), strike, side, userId)
      if (!_normalLockAcquired) {
        console.log(`  [lock] SKIP ${pitcherName} ${strike}+ ${side} (${user?.name}) — concurrent process holds lock`)
        return { freeMoneySummary: null, kalshiDedup: true }
      }
      try {
        const placed2      = await placeOrder(ticker, side.toLowerCase(), finalContracts, askCents, creds)
        const placedOrder2 = placed2?.order ?? placed2
        orderId    = placedOrder2?.order_id ?? null
        initFilled = Math.round(parseFloat(placedOrder2?.fill_count_fp ?? '0'))
        // Do NOT cancel on 0 initial fills — Kalshi fills are async; WS delivers the confirmation.
        console.log(`  [LIVE TAKER] ${user?.name} ${pitcherName} ${strike}+ ${side} ${finalContracts}c @ ${askCents}¢`)
        db.saveLog({ tag: 'BET', msg: `${pitcherName} ${strike}+ ${side} ${finalContracts}c @ ${askCents}¢ taker`, pitcher: pitcherName, strike, side })
        // Debit available_pool — keeps bankrollState in sync so next live bet sees correct pool
        const liveCommitted = finalContracts * (askCents / 100)
        addCommitted(TODAY, liveCommitted).catch(() => {})
      } catch (err) {
        console.error(`  [ORDER FAILED] ${user?.name} ${pitcherName} ${strike}+ ${side}: ${err.message}`)
        db.saveLog({ tag: 'ERROR', level: 'error', msg: `ORDER FAILED ${pitcherName} ${strike}+ ${side}: ${err.message}`, pitcher: pitcherName, strike, side })
        alertError('liveMonitor:orderFailed', err, {
          type: 'NORMAL', user: user?.name, pitcher: pitcherName, strike, side,
        }).catch(() => {})
        return { freeMoneySummary: null, apiFailed: true }
      } finally {
        releaseBetLock(TODAY, String(pitcherId ?? pitcherName), strike, side, userId).catch(() => {})
      }
    }
  } else {
    const _modeLabel = { pulled: '💰 FREE MONEY', 'crossed-yes': '🟢 CROSSED-YES', blowout: '🏳️ BLOWOUT', 'early-blowout': '🏳️ EARLY BLOWOUT', 'dead-path': '🚫 DEAD PATH', 'late-inning-no': '🕙 LATE NO', 'stack-yes': '📚 STACK YES', 'pull-hedge': '🛡️ PULL-HEDGE' }[mode] ?? 'EDGE'
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

  const insertedBet = await db.one(
    `SELECT id FROM ks_bets WHERE bet_date=? AND pitcher_name=? AND strike=? AND side=? AND live_bet=1 AND user_id=? ORDER BY id DESC LIMIT 1`,
    [TODAY, pitcherName, strike, side, userId],
  ).catch(() => null)
  const betId = insertedBet?.id ?? null

  const orderStatus = orderId ? (initFilled >= finalContracts ? 'filled' : 'resting') : null
  return { freeMoneySummary, finalContracts, orderCents, betId, orderStatus, initFilled }
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
        `UPDATE ks_bets SET result='void', pnl=0, settled_at=? WHERE id=? AND result IS NULL`,
        [now, bet.id],
      )
      continue
    }

    // Live bets with 0 fills — order was placed but never executed on Kalshi.
    // No real money changed hands; void the bet rather than computing phantom P&L.
    if (bet.live_bet && !bet.filled_contracts) {
      console.log(`[settle] VOID (no fill) ${bet.pitcher_name} ${bet.strike}+ ${bet.side} live_bet — order ${bet.order_id ?? 'unknown'} never filled`)
      await db.run(
        `UPDATE ks_bets SET result='void', pnl=0, order_status='cancelled', settled_at=? WHERE id=? AND result IS NULL`,
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
      // Fee is paid at fill time; settled P&L = contracts × (1-fill) for wins.
      // This matches daily_pnl_events (revenue - costBasis, no settlement fee).
      pnl = won
        ? contracts * (1 - fillFraction)
        : -contracts * fillFraction
    }

    await db.run(
      `UPDATE ks_bets SET actual_ks=?, result=?, settled_at=?, pnl=? WHERE id=? AND result IS NULL`,
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

  // Backfill actual_ks onto market_snapshots for all pitchers settled this game
  const uniquePitchers = [...new Map(settled.map(b => [b.pitcher_id, b])).values()]
  for (const b of uniquePitchers) {
    if (b.pitcher_id && b.actual_ks != null) {
      backfillOutcome({ pitcherId: b.pitcher_id, gameDate: TODAY, actualKs: b.actual_ks }).catch(() => {})
    }
  }

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
      // Per-user pool: user's own Kalshi balance minus their own committed capital.
      const availPool = await getPerUserAvailablePool(TODAY, user.id).catch(() => 0)
      const bankroll  = availPool > 0 ? availPool : (user.starting_bankroll || 1000)

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
        const priceDollars   = bet.side?.toUpperCase() === 'NO'
          ? (order?.no_price_dollars ?? order?.yes_price_dollars ?? null)
          : (order?.yes_price_dollars ?? order?.no_price_dollars ?? null)
        const fillPriceCents = priceDollars
          ? Math.round(parseFloat(priceDollars) * 100)
          : bet.side?.toUpperCase() === 'NO'
            ? (order?.no_price ?? order?.yes_price ?? null)
            : (order?.yes_price ?? order?.no_price ?? null)
        const filledCount = Math.round(parseFloat(order?.fill_count_fp ?? '0'))
        await db.run(
          `UPDATE ks_bets SET order_status='filled', fill_price=COALESCE(?, fill_price), filled_contracts=? WHERE id=?`,
          [fillPriceCents, filledCount || null, bet.id],
        )
        console.log(`\n[live] ✓ stale-check: ${bet.pitcher_name} ${bet.side} ${bet.strike}+ filled ${filledCount}c @ ${fillPriceCents ?? '?'}¢ (maker)`)
        // Apr 28 — REMOVED bogus notifyLiveBet call. The order was a PRE-GAME maker;
        // routing it through the in-game template produced misleading Discord embeds
        // ("[LIVE] In-game bet ... nullK · nullIP · nullp · betting hit 6+") for bets
        // that hadn't started yet. Pre-game bets already get their notification when
        // originally placed via ksBets.js — no second notification needed when the
        // resting maker eventually fills.
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
      // bet.bet_size is in USD dollars — convert to contracts at the current taker price.
      // Previously this used bet.bet_size directly as contracts (units bug).
      const computedContracts = Math.max(1, Math.round(((bet.bet_size ?? 10) * 100) / takerCents))
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
    // bet.bet_size is USD cash to spend (NOT contract count). Convert to contracts at the
    // new taker price, then subtract any already-filled portion so we don't double-buy.
    // Apr 28 fix — previously `Math.round(bet.bet_size)` was treated as contract count,
    // creating $500-contract resting orders that never filled (Messick 7+/9+/9+, Kochanowicz 6+).
    const takerPrice = bet.side === 'YES'
      ? Math.min(99, market.yes_ask + 1)
      : Math.min(99, market.no_ask  + 1)
    const intendedAtTaker = Math.max(1, Math.round((Number(bet.bet_size) || 10) * 100 / takerPrice))
    const alreadyFilled   = Number(bet.filled_contracts) || 0
    const contracts       = Math.max(1, intendedAtTaker - alreadyFilled)
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
          `UPDATE ks_bets SET order_status='cancelled', result='void', pnl=0, settled_at=? WHERE id=? AND result IS NULL`,
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
    const availPool = await getPerUserAvailablePool(TODAY, user.id).catch(() => 0)
    const bankroll  = availPool > 0 ? availPool : (user.starting_bankroll || 1000)
    // Scale reserve to bankroll: (free_money_risk_pct × bankroll) ÷ pitcher_count,
    // capped at FREE_MONEY_PITCHER_CAP so large accounts don't over-reserve.
    const freeMoneyPool     = bankroll * (user.free_money_risk_pct ?? 0.20)
    const pitcherCount      = Math.max(1, pitcherIds.length)
    const reservePerPitcher = Math.min(FREE_MONEY_PITCHER_CAP, freeMoneyPool / pitcherCount)

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
  const sampleReserve = sampleUser ? sampleBankroll * (sampleUser.free_money_risk_pct ?? 0.20) * 0.25 : 0
  const totalReserved = users.length * pitcherIds.length * sampleReserve
  console.log(`[live] Reserves initialized for ${gameLabel}: $${totalReserved.toFixed(0)} total (${users.length} users × ${pitcherIds.length} pitchers)`)
}

// ── Main monitor loop ─────────────────────────────────────────────────────────

async function main() {
  await db.migrate()
  await seedDefaults()
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
    console.log(`[live] ⚠  No pre-game bets found for ${TODAY} — watching for free money / in-game edge only`)
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

  // Declare allPitcherIds early so watch-only loop can add to it
  const allPitcherIds = new Set(preGameBets.map(b => b.pitcher_id).filter(Boolean))

  // ── Supplement with watch-only pitchers (no pre-game bet, but went through pipeline) ──
  // Covers: no-edge pitchers, missed bets (game-time mismatch, late schedules, etc.)
  // These can still trigger free money, dead-path, and in-game edge bets.
  const watchOnlyRows = await db.all(
    `SELECT pitcher_id, pitcher_name, game_id, game_label, lambda, edges_json
       FROM decision_pipeline
      WHERE bet_date = ?
        AND (final_action = 'no_edge' OR final_action IS NULL)
        AND lambda IS NOT NULL AND lambda > 0`,
    [TODAY],
  ).catch(() => [])

  for (const w of watchOnlyRows) {
    if (pitcherContext.has(w.pitcher_id)) continue  // already loaded from pre-game bets

    let baseTicker = null
    try {
      const edges = typeof w.edges_json === 'string' ? JSON.parse(w.edges_json) : (w.edges_json ?? [])
      const firstTicker = edges?.[0]?.ticker
      if (firstTicker) baseTicker = firstTicker.split('-').slice(0, -1).join('-')
    } catch { /* malformed edges_json — baseTicker stays null, skipped below */ }
    if (!baseTicker) continue  // no market data — can't query Kalshi for this pitcher

    const starts      = startsByPitcher.get(String(w.pitcher_id)) || []
    const pitchStarts = starts.filter(s => s.pitches > 0)
    const avgPitches  = pitchStarts.length ? pitchStarts.reduce((s, r) => s + r.pitches, 0) / pitchStarts.length : 90
    const ipStarts    = starts.filter(s => s.ip > 0)
    const avgIp       = ipStarts.length ? ipStarts.reduce((s, r) => s + Number(r.ip), 0) / ipStarts.length : 5.2
    const bfStarts    = starts.filter(s => s.bf > 0)
    const avgBF       = bfStarts.length ? bfStarts.reduce((s, r) => s + r.bf, 0) / bfStarts.length : 22
    const pK_blended  = avgBF > 0 ? w.lambda / avgBF : LEAGUE_K_PCT

    const numId = Number(w.pitcher_id)
    pitcherContext.set(numId, {
      pitcherName: w.pitcher_name,
      game:        w.game_label,
      lambda:      w.lambda,
      pK_blended,
      avgPitches,
      avgBF,
      avgIp,
      baseTicker,
    })
    allPitcherIds.add(numId)
    console.log(`[live] 👁  watch-only: ${w.pitcher_name} (${w.game_label ?? w.game_id}) λ=${Number(w.lambda).toFixed(2)} — free money + in-game edge eligible`)
  }

  // Load today's game IDs
  const games = await db.all(
    `SELECT id, team_home, team_away, pitcher_home_id, pitcher_away_id, game_time
       FROM games WHERE date = ?`,
    [TODAY],
  )

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

  // Kalshi ticker monitor is started after activeBettors is loaded (below)

  // Track which in-game bets we've already placed this session (avoid dups)
  const placed = new Set()
  // Hydrate from DB so restarts don't re-place bets already submitted this session.
  // Include paper bets (order_status IS NULL for paper) so paper mode doesn't re-fire on restart.
  const todayLiveBets = await db.all(
    `SELECT user_id, pitcher_id, strike FROM ks_bets
     WHERE bet_date = ? AND live_bet = 1 AND (order_status IS NOT NULL OR paper = 1)`,
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
  const noWon   = new Set()   // NO bets where pitcher pulled below threshold — settled as win mid-game
  const oneAway = new Set()
  // Notification dedup — fire Discord/log once per event (pitcher+strike), not once per bet row.
  // Two active bettors produce two bet rows for the same event; without this, every COVER/DEAD
  // fires 2–4× producing identical Discord alerts.
  const coveredNotified = new Set()   // `${pitcherId}:${strike}`
  const deadNotified    = new Set()   // `${pitcherId}:${strike}`
  const noLostNotified  = new Set()   // `${pitcherId}:${strike}`
  const noWonNotified   = new Set()   // `${pitcherId}:${strike}`
  const oneAwayNotified = new Set()   // `${pitcherId}:${strike}`
  const lastKsMap = new Map()  // pitcherId → last confirmed K count (delta detection)
  const freeMoneySentByUserPitcher = new Map()  // userId → Map(pitcherId → USD risked on free-money takers)
  // Apr 28 — per-pitcher cumulative spend on model-driven modes (high-conviction / stack-yes / dead-path).
  // Map(userId → Map(pitcherId → USD)). Prevents stacking $200 caps across 5 strikes for one pitcher.
  const hcSentByUserPitcher = new Map()
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

  // manual_balance_adjustments: records deposits/withdrawals made mid-day so the
  // balance-delta P&L calculation can subtract them (they inflate the apparent balance
  // without reflecting trading gains/losses).
  await db.run(`
    CREATE TABLE IF NOT EXISTS manual_balance_adjustments (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL,
      amount_usd  REAL NOT NULL,
      note        TEXT,
      created_at  TEXT NOT NULL
    )
  `).catch(() => {})


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

      // Hydrate freeMoneySentByUserPitcher from today's DB so the per-threshold cap still
      // applies after a liveMonitor restart (the in-memory Map resets on every cold start).
      const fmRows = await db.all(
        `SELECT user_id, pitcher_id, strike, fill_price, filled_contracts
         FROM ks_bets
         WHERE bet_date = ? AND live_bet = 1 AND paper = 0
           AND bet_mode IN ('pulled', 'crossed-yes', 'blowout', 'early-blowout', 'late-inning-no')
           AND filled_contracts > 0`,
        [TODAY],
      ).catch(() => [])
      for (const row of fmRows) {
        const capKey = `${row.pitcher_id}-${row.strike}`
        const spent  = row.filled_contracts * (row.fill_price / 100)
        if (!freeMoneySentByUserPitcher.has(row.user_id)) freeMoneySentByUserPitcher.set(row.user_id, new Map())
        const bMap = freeMoneySentByUserPitcher.get(row.user_id)
        bMap.set(capKey, (bMap.get(capKey) ?? 0) + spent)
      }
      if (fmRows.length > 0) {
        console.log(`[live] Free-money cap hydrated: ${fmRows.length} prior bet(s) across ${freeMoneySentByUserPitcher.size} bettor(s)`)
      }

      // Hydrate hcSentByUserPitcher (high-conviction per-pitcher cap) from today's DB.
      const hcRows = await db.all(
        `SELECT user_id, pitcher_id, capital_at_risk
         FROM ks_bets
         WHERE bet_date = ? AND live_bet = 1 AND paper = 0
           AND bet_mode IN ('high-conviction', 'stack-yes', 'dead-path')
           AND capital_at_risk > 0`,
        [TODAY],
      ).catch(() => [])
      for (const row of hcRows) {
        if (!hcSentByUserPitcher.has(row.user_id)) hcSentByUserPitcher.set(row.user_id, new Map())
        const bMap = hcSentByUserPitcher.get(row.user_id)
        bMap.set(row.pitcher_id, (bMap.get(row.pitcher_id) ?? 0) + Number(row.capital_at_risk))
      }
      if (hcRows.length > 0) {
        console.log(`[live] HC pitcher-cap hydrated: ${hcRows.length} prior bet(s) across ${hcSentByUserPitcher.size} bettor(s)`)
      }
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
      const feed = await mlbFeedLive(game.id)
      const abstractGameState = feed?.gameData?.status?.abstractGameState ?? null
      const box = feed?.liveData?.boxscore ?? null
      if (abstractGameState === 'Final' && !settledGames.has(game.id)) {
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
    `SELECT id, name, paper, kalshi_key_id, kalshi_private_key, starting_bankroll, daily_risk_pct, live_daily_risk_pct, free_money_risk_pct, kalshi_balance
     FROM users WHERE active_bettor=1 ORDER BY id`,
  )

  let activeBettingRules = await getRules().catch(() => ({}))

  // ── Kalshi ticker monitor — parallel pull-signal source ──────────────────
  // Subscribes to YES market tickers for today's open bets. When another trader
  // watching TV sees a pull and reprices, the YES mid drops sharply — we detect
  // that 15–30s before the MLB API boxscore updates and trigger an urgent cycle.
  // Apr 28 — `tickerWs` and `tickerToPitcher` lifted to outer scope so the pitcher
  // refresh loop (R1 fix) can extend the WS subscription with late-added tickers.
  let tickerWs = null
  const tickerToPitcher = new Map()
  ;(async () => {
    try {
      const bettor = activeBettors.find(b => b.kalshi_key_id && b.paper === 0)
      if (!bettor) return
      const openYesBets = await db.all(
        `SELECT DISTINCT pitcher_id, ticker FROM ks_bets
         WHERE bet_date=? AND side='YES' AND result IS NULL AND ticker IS NOT NULL`,
        [TODAY],
      )
      if (!openYesBets.length) return
      for (const b of openYesBets) tickerToPitcher.set(b.ticker, String(b.pitcher_id))
      const marketTickers = openYesBets.map(b => b.ticker)
      console.log(`[live] Kalshi ticker WS: watching ${marketTickers.length} markets for pull signals`)
      // Track WS connection state for Discord alerting (Apr 28 — Adam asked).
      // _wsClosedAt set when state leaves 'subscribed'; cleared on return.
      // Watchdog fires alertWsDown every 60s while still down (deduped 3 min in healthAlerts).
      let _wsClosedAt = null
      const _wsWatchdog = setInterval(async () => {
        if (_wsClosedAt && Date.now() - _wsClosedAt > 30_000) {
          const secsDown = (Date.now() - _wsClosedAt) / 1000
          import('../../lib/healthAlerts.js').then(m =>
            m.alertWsDown({ source: 'kalshi-ticker', secsDown })
          ).catch(() => {})
        }
      }, 60_000)
      tickerWs = createKalshiTickerWs({
        keyId: bettor.kalshi_key_id,
        privateKey: bettor.kalshi_private_key,
        marketTickers,
        onTicker: ({ ticker, yesMid }) => {
          const pitcherId = tickerToPitcher.get(ticker)
          if (!pitcherId) return
          const lastMid = _tickerLastMid.get(ticker)
          _tickerLastMid.set(ticker, yesMid)
          if (lastMid == null || lastMid <= 15) return  // no baseline or already near floor
          const drop = lastMid - yesMid
          if (drop >= 15 || yesMid <= 8) {
            const name = pitcherContext.get(pitcherId)?.pitcherName ?? pitcherId
            console.log(`\n[live] 🚨 KALSHI PULL SIGNAL  ${name}  mid ${lastMid.toFixed(0)}→${yesMid.toFixed(0)}¢`)
            db.saveLog({ tag: 'KALSHI_SIGNAL', level: 'warn',
              msg: `Kalshi pull signal: mid ${lastMid.toFixed(0)}→${yesMid.toFixed(0)}¢  drop=${drop.toFixed(0)}¢`,
              pitcher: name }).catch(() => {})
            _kalshiPullSignal.add(pitcherId)
          }
        },
        onStatus: (s) => {
          if (s !== 'subscribed') console.log(`[live] Kalshi ticker WS: ${s}`)
          if (s === 'subscribed') {
            // Reconnect — if we tracked a close window, alert with the duration
            if (_wsClosedAt) {
              const secsDown = (Date.now() - _wsClosedAt) / 1000
              if (secsDown > 5) {
                import('../../lib/healthAlerts.js').then(m =>
                  m.alertWsDown({ source: 'kalshi-ticker (reconnected after)', secsDown })
                ).catch(() => {})
              }
              _wsClosedAt = null
            }
          } else if (s === 'closed' || s === 'connecting') {
            if (!_wsClosedAt) _wsClosedAt = Date.now()
          }
        },
      })
      tickerWs.connect()
    } catch (err) {
      console.error(`[live] Kalshi ticker monitor failed to start: ${err.message}`)
    }
  })()

  function _applyRulesToGlobals(r) {
    if (r.pulled_cap_usd         != null) PULLED_CAP_USD         = r.pulled_cap_usd
    if (r.free_money_pitcher_cap != null) FREE_MONEY_PITCHER_CAP = r.free_money_pitcher_cap
    if (r.dead_path_cap_usd      != null) DEAD_PATH_CAP_USD      = r.dead_path_cap_usd
    if (r.crossed_yes_max_ask    != null) CROSSED_YES_MAX_ASK    = r.crossed_yes_max_ask
    if (r.blowout_deficit        != null) BLOWOUT_DEFICIT        = r.blowout_deficit
    if (r.blowout_inning         != null) BLOWOUT_INNING         = r.blowout_inning
    if (r.blowout_k_gap          != null) BLOWOUT_K_GAP          = r.blowout_k_gap
    if (r.pull_pitch_count       != null) PULL_PITCH_COUNT       = r.pull_pitch_count
    if (r.pull_min_ip            != null) PULL_MIN_IP            = r.pull_min_ip
    if (r.queue_amend_cents      != null) QUEUE_AMEND_CENTS      = r.queue_amend_cents
    if (r.live_bayesian_weight_cap != null) LIVE_BAYESIAN_WEIGHT_CAP = r.live_bayesian_weight_cap
    if (r.pulled_cap_confirmed_usd != null) PULLED_CAP_CONFIRMED_USD = r.pulled_cap_confirmed_usd
  }
  _applyRulesToGlobals(activeBettingRules)

  let iteration = 0
  while (true) {
    // Refresh active bettors and rules periodically in case config changed
    if (iteration > 0 && iteration % 50 === 0) {
      activeBettors = await db.all(
        `SELECT id, name, paper, kalshi_key_id, kalshi_private_key, starting_bankroll, daily_risk_pct, live_daily_risk_pct, free_money_risk_pct, kalshi_balance
         FROM users WHERE active_bettor=1 ORDER BY id`,
      ).catch(() => activeBettors)
      invalidateRulesCache()
      activeBettingRules = await getRules().catch(() => activeBettingRules)
      _applyRulesToGlobals(activeBettingRules)
    }

    // Refresh pitcher list every 10 iterations — picks up pre-game bets placed by the pipeline
    // after the monitor started. Without this, pitchers whose bets are placed post-startup
    // (lineup-gated pipeline fires 15min–2h after monitor starts) are never tracked.
    if (iteration % 10 === 0) {
      try {
        const newBets = await db.all(
          `SELECT DISTINCT pitcher_id, pitcher_name, ticker, lambda, game FROM ks_bets
           WHERE bet_date = ? AND live_bet = 0`,
          [TODAY],
        )
        const newWsTickers = []   // collect new tickers for WS resub (R1 fix)
        for (const b of newBets) {
          const numId = Number(b.pitcher_id)
          if (!numId || allPitcherIds.has(numId)) continue
          const starts     = startsByPitcher.get(String(b.pitcher_id)) || []
          const pitchS     = starts.filter(s => s.pitches > 0)
          const ipS        = starts.filter(s => s.ip > 0)
          const bfS        = starts.filter(s => s.bf > 0)
          const avgPitches = pitchS.length ? pitchS.reduce((s, r) => s + r.pitches, 0) / pitchS.length : 90
          const avgIp      = ipS.length    ? ipS.reduce((s, r) => s + Number(r.ip), 0) / ipS.length : 5.2
          const avgBF      = bfS.length    ? bfS.reduce((s, r) => s + r.bf, 0) / bfS.length : 22
          const pK_blended = avgBF > 0 ? (b.lambda ?? 0) / avgBF : LEAGUE_K_PCT
          pitcherContext.set(numId, {
            pitcherName: b.pitcher_name,
            game:        b.game,
            lambda:      b.lambda,
            pK_blended,
            avgPitches,
            avgBF,
            avgIp,
            baseTicker: b.ticker ? b.ticker.split('-').slice(0, -1).join('-') : null,
          })
          allPitcherIds.add(numId)
          // Register the late pitcher's YES ticker with the Kalshi WS so we get pull signals
          // for them too (otherwise they fall back to ~30s API polling — caused Apr 27 misses).
          if (b.ticker && !tickerToPitcher.has(b.ticker)) {
            tickerToPitcher.set(b.ticker, String(b.pitcher_id))
            newWsTickers.push(b.ticker)
          }
          console.log(`\n[live] ➕ Late-added pitcher: ${b.pitcher_name} (id=${b.pitcher_id}) — bets placed after monitor start`)
        }
        if (newWsTickers.length && tickerWs?.addTickers) {
          const ok = tickerWs.addTickers(newWsTickers)
          console.log(`[live] Kalshi ticker WS: ${ok ? '+' : 'failed +'}${newWsTickers.length} late ticker(s)`)
        }
      } catch (err) {
        console.warn('[live] pitcher refresh failed:', err.message)
      }
    }

    iteration++
    // Heartbeat write — sentinel cron in scheduler.js reads this to detect stalls.
    // Fire-and-forget; if Turso is briefly unreachable we don't want the loop to stall on it.
    db.run(
      `INSERT INTO system_flags (key, value, updated_at, updated_by) VALUES ('liveMonitor_heartbeat', ?, ?, 'liveMonitor')
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
      [String(Date.now()), new Date().toISOString()],
    ).catch(() => {})
    // Fast mode: shorten sleep if anyone is 1 K away from a threshold, a pitcher was pulled,
    // or Kalshi ticker signaled a sharp YES mid drop (probable pull by TV-watching traders)
    let urgentThisCycle = oneAway.size > 0 || _kalshiPullSignal.size > 0
    const now = new Date().toISOString().slice(11, 16)
    process.stdout.write(`\r[live] ${now} UTC | poll #${iteration} | daily loss: $${_dailyLoss.toFixed(0)}/$${LOSS_LIMIT}  `)

    if (_dailyLoss >= LOSS_LIMIT) {
      console.log(`\n[live] Daily loss limit hit ($${_dailyLoss.toFixed(0)}). Stopping.`)
      // Cancel all open orders for every live bettor (not just the env-var default user)
      for (const u of activeBettors.filter(u => u.paper === 0 && u.kalshi_key_id)) {
        try {
          await cancelAllOrders({ status: 'resting' }, { keyId: u.kalshi_key_id, privateKey: u.kalshi_private_key })
          console.log(`[live] Cancelled all resting orders for ${u.name} after loss limit hit`)
        } catch { /* non-fatal */ }
      }
      break
    }

    // Rule E: Auto-halt after -15% daily drawdown (net across all bets today)
    await reloadDailyNetPnl()
    const DRAWDOWN_HALT_PCT = 0.15
    // Use today's opening snapshot as the drawdown baseline so losses already
    // taken don't silently shrink the 15% floor. Falls back to current balance
    // if no snapshot exists (e.g. first run of the day before capture fires).
    const _snapshots = await db.all(
      `SELECT user_id, balance_usd FROM balance_snapshots WHERE date = ?`, [TODAY],
    ).catch(() => [])
    const _snapshotByUser = new Map(_snapshots.map(r => [r.user_id, Number(r.balance_usd)]))
    const totalBankroll = activeBettors.reduce((s, u) => {
      const opening = _snapshotByUser.get(u.id)
      if (opening != null && opening > 0) return s + opening
      return s + ((LIVE && u.kalshi_balance > 0) ? u.kalshi_balance : (u.starting_bankroll ?? 1000))
    }, 0)
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
        // Single feed/live call replaces separate linescore + boxscore fetches.
        // Also gives us the plays array for substitution fast-path pull detection.
        const feed = await mlbFeedLive(game.id)
        const abstractGameState = feed?.gameData?.status?.abstractGameState ?? null
        const ls  = feed?.liveData?.linescore ? { abstractGameState, ...feed.liveData.linescore } : null
        const box = feed?.liveData?.boxscore ?? null
        // Last 5 plays — detect pitching substitutions 15–30s before isCurrentPitcher flag updates
        const recentPlays = feed?.liveData?.plays?.allPlays?.slice(-5) ?? []
        const hasRecentSubstitution = recentPlays.some(p => {
          const ev = (p?.result?.event ?? '').toLowerCase()
          return ev.includes('substitut') || ev.includes('pitching change')
        })
        const state = ls?.abstractGameState

        if (state === 'Preview') {
          // Apr 28 — keep monitor alive through pre-game hours. Previously this just
          // skipped without touching allDone, so a fresh start at 8am with all games in
          // Preview hit the "allDone && iteration > 1" exit and the process died after
          // two ticks. Treat Preview as "not done — waiting for first pitch."
          allDone = false
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
          // Apr 28: pitch-count staleness flag. MLB API doesn't update numberOfPitches
          // mid-inning while a batter is on the mound — for a pitcher already deep in the
          // game (IP ≥ 5), a 0 pitch count means stale data, not a real read. Skip the
          // live model evaluation this tick rather than feeding stale lambda to Kelly.
          // (Caused Paddack 2+ disaster: model said 60.7% on stale state vs 0.5¢ market.)
          const pitchCountStale = currentPitches === 0 && currentIP >= 5
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

          // Fetch next 2-3 batters for pull-hedge confidence scoring.
          // Cached per-batter (24h TTL) — actual MLB API call only for new batters.
          // Returns [] gracefully if pitcher not currently pitching or data unavailable.
          const nextBatters = await fetchNextBatters(feed, side).catch(() => [])

          // ── K-delta detection — log when K count changes, flag urgency ──────
          const prevKs = lastKsMap.get(pitcherId) ?? null
          const ksChanged = prevKs !== null && currentKs !== prevKs
          lastKsMap.set(pitcherId, currentKs)
          if (ksChanged) {
            console.log(`\n[live] ⚡ K DELTA  ${ctx.pitcherName}  ${prevKs}→${currentKs}K  running edge check`)
            urgentThisCycle = true
          }

          // Pre-compute pull confirmation for use in dead-bet below.
          // MLB API sets isCurrentPitcher=false between half-innings (team is at bat),
          // so we must NOT rely on raw !isCurrent alone — we need a corroborating signal.
          const _teamPlayersEarly   = team?.players ?? {}
          const _relieverOnMoundEarly = Object.entries(_teamPlayersEarly).some(
            ([pid, p]) => pid !== `ID${pitcherId}` && p.gameStatus?.isCurrentPitcher === true,
          )
          const _notCurrentEntry    = notCurrentSince.get(String(pitcherId))
          // Apr 28 — pulse cross-check: gamePulse is the slate-wide truth on pull state.
          // If pulse hasn't flagged the pitcher as pulled, defer settlement even if local
          // signals look like a pull. Prevents false-DEAD from API hiccups (Martinez 4/28).
          const _pulsePulled = await db.one(
            `SELECT CASE WHEN home_pitcher_id = ? THEN home_pitcher_pulled
                         WHEN away_pitcher_id = ? THEN away_pitcher_pulled
                         ELSE 0 END AS pulled
             FROM game_pulse WHERE bet_date = ? AND (home_pitcher_id = ? OR away_pitcher_id = ?) LIMIT 1`,
            [String(pitcherId), String(pitcherId), TODAY, String(pitcherId), String(pitcherId)],
          ).catch(() => null)
          const _pulseSaysPulled = _pulsePulled?.pulled === 1
          const _pullConfirmedEarly = _pulseSaysPulled && (_relieverOnMoundEarly || hasRecentSubstitution)
          const _pullConfirmedStale = _pulseSaysPulled && !isCurrent && _notCurrentEntry &&
            _notCurrentEntry.ip === currentIP && _notCurrentEntry.ks === currentKs && currentIP >= 5

          // ── Cover / dead detection for pre-game bets ───────────────────────
          const openBets = await db.all(
            `SELECT * FROM ks_bets WHERE bet_date = ? AND pitcher_id = ? AND result IS NULL`,
            [TODAY, String(pitcherId)],
          )

          for (const bet of openBets) {
            const key = `${bet.id}`
            const eventKey = `${pitcherId}:${bet.strike}`  // dedup notifications — one per event, not per bet row

            // One away: YES bet needs exactly 1 more K (still pitching)
            if (bet.side === 'YES' && isCurrent && currentKs === bet.strike - 1 && !oneAway.has(key) && !covered.has(key)) {
              oneAway.add(key)
              if (!oneAwayNotified.has(eventKey)) {
                oneAwayNotified.add(eventKey)
                const pnl = bet.bet_size * (1 - (bet.market_mid ?? 50) / 100)
                console.log(`\n[live] 🔥 ONE AWAY ${ctx.pitcherName} ${bet.strike}+ (${currentKs}K)`)
                await notifyOneAway({ pitcherName: ctx.pitcherName, strike: bet.strike, pnl, currentKs, game: ctx.game }, await getAllWebhooks(db))
              }
            }

            // Cover: pitcher already has enough Ks — settle immediately, don't wait for game to end
            if (bet.side === 'YES' && currentKs >= bet.strike && !covered.has(key)) {
              covered.add(key)
              if ((bet.filled_contracts ?? 0) === 0) {
                // Resting/unfilled order — void it without P&L (no money was at risk)
                await db.run(
                  `UPDATE ks_bets SET actual_ks=?, result='void', pnl=0, order_status=COALESCE(order_status,'cancelled'), settled_at=? WHERE id=? AND result IS NULL`,
                  [currentKs, new Date().toISOString(), bet.id],
                )
                console.log(`[live] ⊘ COVER VOID (no fill) ${ctx.pitcherName} ${bet.strike}+ at ${currentKs}K — resting order never filled`)
                db.saveLog({ tag: 'COVER', msg: `${ctx.pitcherName} ${bet.strike}+ YES resting voided at ${currentKs}K (no fill)`, pitcher: ctx.pitcherName, strike: bet.strike, side: 'YES', pnl: 0 })
                continue
              }
              const _fcC = bet.filled_contracts
              const _ffC = ((bet.fill_price ?? bet.market_mid ?? 50)) / 100
              // bet_size = contract count; capital_at_risk = dollars spent (preferred fallback)
              const _szC = _fcC != null
                ? _fcC
                : bet.capital_at_risk != null && _ffC > 0
                  ? Math.round(bet.capital_at_risk / _ffC)
                  : Math.round(bet.bet_size ?? 0)
              const settlementPnl = Math.round(_szC * (1 - _ffC) * 0.93 * 100) / 100

              // Auto-close disabled — let covered bets settle naturally via Kalshi settlement.
              let autoCloseSucceeded = false
              let autoClosePnl = null
              if (false && LIVE && _fcC > 0 && bet.ticker && bet.paper === 0) {
                try {
                  const closeMkt = await getMarketPrice(bet.ticker).catch(() => null)
                  const yesBidCents = closeMkt?.bid != null ? Math.round(closeMkt.bid * 100) : null
                  if (yesBidCents != null && yesBidCents >= 88) {
                    const userRow = activeBettors.find(b => b.id === bet.user_id)
                    if (userRow?.kalshi_key_id) {
                      const sellCreds = { keyId: userRow.kalshi_key_id, privateKey: userRow.kalshi_private_key }
                      await placeOrder(bet.ticker, 'yes', _fcC, yesBidCents, sellCreds, 'sell')
                      autoCloseSucceeded = true
                      autoClosePnl = Math.round(_fcC * ((yesBidCents - (bet.fill_price ?? bet.market_mid ?? 50)) / 100) * 0.93 * 100) / 100
                      console.log(`[live] 💰 AUTO-CLOSE ${ctx.pitcherName} YES${bet.strike} ${_fcC}c @ ${yesBidCents}¢  pnl=$${autoClosePnl.toFixed(2)}`)
                      db.saveLog({ tag: 'SELL', msg: `${ctx.pitcherName} YES${bet.strike} sold ${_fcC}c @ ${yesBidCents}¢ — auto-close  pnl=$${autoClosePnl.toFixed(2)}`, pitcher: ctx.pitcherName, strike: bet.strike, side: 'YES' })
                    }
                  }
                } catch { /* non-fatal — fall through to settlement P&L */ }
              }

              const finalPnl = autoCloseSucceeded ? autoClosePnl : settlementPnl
              const now = new Date().toISOString()
              if (autoCloseSucceeded) {
                await db.run(
                  `UPDATE ks_bets SET actual_ks=?, result='win', settled_at=?, pnl=?, order_status='closed' WHERE id=? AND result IS NULL`,
                  [currentKs, now, finalPnl, bet.id],
                )
              } else {
                await db.run(
                  `UPDATE ks_bets SET actual_ks=?, result='win', settled_at=?, pnl=? WHERE id=? AND result IS NULL`,
                  [currentKs, now, finalPnl, bet.id],
                )
              }
              console.log(`\n[live] ✅ COVERED + SETTLED ${ctx.pitcherName} ${bet.strike}+ (${currentKs}K)  +$${finalPnl.toFixed(2)}${autoCloseSucceeded ? ' [early sell]' : ''}`)
              if (!coveredNotified.has(eventKey)) {
                coveredNotified.add(eventKey)
                db.saveLog({ tag: 'COVER', msg: `${ctx.pitcherName} ${bet.strike}+ YES covered at ${currentKs}K  +$${finalPnl.toFixed(2)}${autoCloseSucceeded ? ' [early sell]' : ''}`, pitcher: ctx.pitcherName, strike: bet.strike, side: 'YES', pnl: finalPnl })
                await notifyCovered({ pitcherName: ctx.pitcherName, strike: bet.strike, side: bet.side, pnl: finalPnl, currentKs, game: ctx.game }, await getAllWebhooks(db))
              }
            }

            // Dead: YES bet, starter pulled and can't reach threshold — settle as loss immediately.
            // Require confirmed pull (reliever on mound OR pitching-change play) OR stale fallback
            // (same IP/Ks two consecutive cycles AND ≥5 IP). Raw !isCurrent alone is NOT sufficient
            // because MLB API sets isCurrentPitcher=false between half-innings (team at bat).
            if (bet.side === 'YES' && !isCurrent && (_pullConfirmedEarly || _pullConfirmedStale) && currentKs < bet.strike && !dead.has(key)) {
              dead.add(key)
              if ((bet.filled_contracts ?? 0) === 0) {
                // Unfilled resting order — void without P&L
                await db.run(
                  `UPDATE ks_bets SET actual_ks=?, result='void', pnl=0, order_status=COALESCE(order_status,'cancelled'), settled_at=? WHERE id=? AND result IS NULL`,
                  [currentKs, new Date().toISOString(), bet.id],
                )
                console.log(`[live] ⊘ DEAD VOID (no fill) ${ctx.pitcherName} ${bet.strike}+ pulled at ${currentKs}K — resting order never filled`)
                db.saveLog({ tag: 'DEAD', msg: `${ctx.pitcherName} ${bet.strike}+ YES resting voided pulled at ${currentKs}K (no fill)`, pitcher: ctx.pitcherName, strike: bet.strike, side: 'YES', pnl: 0 })
                continue
              }
              const contracts = bet.filled_contracts  // guaranteed > 0 by guard above
              const fillFrac  = ((bet.fill_price ?? bet.market_mid ?? 50)) / 100
              const pnl       = -Math.round(contracts * fillFrac * 100) / 100
              const now = new Date().toISOString()
              await db.run(
                `UPDATE ks_bets SET actual_ks=?, result='loss', settled_at=?, pnl=? WHERE id=? AND result IS NULL`,
                [currentKs, now, pnl, bet.id],
              )
              console.log(`\n[live] ❌ DEAD + SETTLED ${ctx.pitcherName} pulled at ${currentKs}K (needed ${bet.strike}+)  $${pnl.toFixed(2)}`)
              if (!deadNotified.has(eventKey)) {
                deadNotified.add(eventKey)
                db.saveLog({ tag: 'DEAD', level: 'warn', msg: `${ctx.pitcherName} pulled at ${currentKs}K (needed ${bet.strike}+)  $${pnl.toFixed(2)}`, pitcher: ctx.pitcherName, strike: bet.strike, side: 'YES', pnl })
                await notifyDead({ pitcherName: ctx.pitcherName, strike: bet.strike, side: bet.side, pnl, currentKs, currentIPraw, game: ctx.game, reason: 'starter pulled' }, await getAllWebhooks(db))
              }
            }

            // NO bet: if pitcher is pulled below the threshold the NO is structurally WON —
            // pitcher can't accumulate more Ks once out of the game. Settle immediately so
            // capital is freed and ledger is accurate. Mirrors the YES-dead logic above.
            // Requires same pull confirmation as YES-dead — raw !isCurrent is false between
            // half-innings (team at bat) and would cause false settlements.
            if (bet.side === 'NO' && !isCurrent && (_pullConfirmedEarly || _pullConfirmedStale) && currentKs < bet.strike && currentIP >= 3 && !noWon.has(key)) {
              noWon.add(key)
              if ((bet.filled_contracts ?? 0) === 0) {
                await db.run(
                  `UPDATE ks_bets SET actual_ks=?, result='void', pnl=0, order_status=COALESCE(order_status,'cancelled'), settled_at=? WHERE id=? AND result IS NULL`,
                  [currentKs, new Date().toISOString(), bet.id],
                )
                console.log(`[live] ⊘ NO WON VOID (no fill) ${ctx.pitcherName} NO ${bet.strike}+ — pitcher pulled at ${currentKs}K, resting order never filled`)
                db.saveLog({ tag: 'NO_WON', msg: `${ctx.pitcherName} NO${bet.strike}+ resting voided (pitcher pulled at ${currentKs}K, no fill)`, pitcher: ctx.pitcherName, strike: bet.strike, side: 'NO', pnl: 0 })
                continue
              }
              const contracts = bet.filled_contracts
              const fillFrac  = ((bet.fill_price ?? bet.market_mid ?? 50)) / 100
              const pnl       = Math.round(contracts * (1 - fillFrac) * 0.93 * 100) / 100
              const now = new Date().toISOString()
              await db.run(
                `UPDATE ks_bets SET actual_ks=?, result='win', settled_at=?, pnl=? WHERE id=? AND result IS NULL`,
                [currentKs, now, pnl, bet.id],
              )
              console.log(`\n[live] ✅ NO WON (pitcher pulled) ${ctx.pitcherName} NO ${bet.strike}+ at ${currentKs}K  +$${pnl.toFixed(2)}`)
              if (!noWonNotified.has(eventKey)) {
                noWonNotified.add(eventKey)
                db.saveLog({ tag: 'NO_WON', msg: `${ctx.pitcherName} NO${bet.strike}+ won — pitcher pulled at ${currentKs}K  +$${pnl.toFixed(2)}`, pitcher: ctx.pitcherName, strike: bet.strike, side: 'NO', pnl })
                await notifyCovered({ pitcherName: ctx.pitcherName, strike: bet.strike, side: 'NO', pnl, currentKs, game: ctx.game }, await getAllWebhooks(db))
              }
            }

            // NO bet: if pitcher has already reached or exceeded the threshold the bet is
            // mathematically lost — K counts never decrease once recorded. Settle immediately
            // rather than waiting for game-end, which could be hours later.
            if (bet.side === 'NO' && currentKs >= bet.strike && !noLost.has(key)) {
              noLost.add(key)
              if ((bet.filled_contracts ?? 0) === 0) {
                // Unfilled resting order — void without P&L
                await db.run(
                  `UPDATE ks_bets SET actual_ks=?, result='void', pnl=0, order_status=COALESCE(order_status,'cancelled'), settled_at=? WHERE id=? AND result IS NULL`,
                  [currentKs, new Date().toISOString(), bet.id],
                )
                console.log(`[live] ⊘ NO LOST VOID (no fill) ${ctx.pitcherName} NO ${bet.strike}+ at ${currentKs}K — resting order never filled`)
                db.saveLog({ tag: 'NO_LOST', msg: `${ctx.pitcherName} NO${bet.strike}+ resting voided at ${currentKs}K (no fill)`, pitcher: ctx.pitcherName, strike: bet.strike, side: 'NO', pnl: 0 })
                continue
              }
              const contracts = bet.filled_contracts  // guaranteed > 0 by guard above
              const fillFrac  = ((bet.fill_price ?? bet.market_mid ?? 50)) / 100
              const pnl       = -Math.round(contracts * fillFrac * 100) / 100
              const now = new Date().toISOString()
              await db.run(
                `UPDATE ks_bets SET actual_ks=?, result='loss', settled_at=?, pnl=? WHERE id=? AND result IS NULL`,
                [currentKs, now, pnl, bet.id],
              )
              console.log(`\n[live] ❌ NO LOST ${ctx.pitcherName} NO ${bet.strike}+ already at ${currentKs}K  $${pnl.toFixed(2)}`)
              if (!noLostNotified.has(eventKey)) {
                noLostNotified.add(eventKey)
                db.saveLog({ tag: 'NO_LOST', level: 'warn', msg: `${ctx.pitcherName} NO${bet.strike}+ hit threshold at ${currentKs}K  $${pnl.toFixed(2)}`, pitcher: ctx.pitcherName, strike: bet.strike, side: 'NO', pnl })
                await notifyDead({ pitcherName: ctx.pitcherName, strike: bet.strike, side: 'NO', pnl, currentKs, currentIPraw, game: ctx.game, reason: `reached ${currentKs}K` }, await getAllWebhooks(db))
              }
            }
          }

          // Pull detection — strong signals only.
          // MLB API sets isCurrentPitcher=false between half-innings (team at bat), so a single
          // !isCurrent reading is NOT a pull. We require one of three confirmation signals:
          //   1. relieverOnMound: a different pitcher has isCurrentPitcher=true for this team
          //   2. hasRecentSubstitution: a pitching-change play event was logged
          //   3. kalshiSignalled: Kalshi WS gave us a pull market signal
          //
          // Apr 28: stale-fallback branch (same IP/Ks two cycles AND IP≥5) REMOVED. Caused
          // Kochanowicz 3K false-pull disaster (cost $499.85 NO 5+ insurance, then he got
          // 4th and 5th K). The signals above already cover real pulls; we'd rather miss
          // free money than fire false free-money against an inning-break stale reading.
          const teamPlayers = team?.players ?? {}
          const relieverOnMound = Object.entries(teamPlayers).some(
            ([pid, p]) => pid !== `ID${pitcherId}` && p.gameStatus?.isCurrentPitcher === true,
          )

          const kalshiSignalled = _kalshiPullSignal.has(String(pitcherId))
          let pitcherPulledEarly = false
          let pitcherPullConfirmed = false
          // Opener detection: pitcher exits with very low pitch count + low IP →
          // this is by-design (opener strategy, e.g., Rays / Astros), not an injury
          // pull. The bullpen will continue racking up Ks for the same listed
          // starter, so NO bets at low strikes lose. 4/24 incident: Rasmussen,
          // Valdez, Abbott pulled-mode on inning-1 exits → -$766 across 5 bets.
          const isOpenerExit = currentPitches > 0 && currentPitches < 30 && currentIP < 3
          if (_pullFired.has(String(pitcherId))) {
            // pull already fired this session — skip re-detection entirely
          } else if (!isCurrent && isOpenerExit) {
            // Opener: log once, then quietly skip on subsequent ticks. Do NOT set
            // _pullFired (that would trip the line ~2939 NO-strike fire path —
            // the exact bug this guard is meant to prevent).
            if (!_openerSkipLogged.has(String(pitcherId))) {
              _openerSkipLogged.add(String(pitcherId))
              console.log(`[live] 🎭 OPENER EXIT  ${ctx.pitcherName}  ${currentKs}K ${currentIPraw}IP ${currentPitches}p — skipping free-money (bullpen continues racking Ks for listed starter)`)
              db.saveLog({ tag: 'OPENER', level: 'info', msg: `${ctx.pitcherName} opener exit detected (${currentPitches}p / ${currentIPraw}IP) — free money skipped`, pitcher: ctx.pitcherName }).catch(() => {})
            }
          } else if (!isCurrent && currentIP >= 2 && !isOpenerExit) {
            if (relieverOnMound || hasRecentSubstitution || kalshiSignalled) {
              pitcherPulledEarly = true
              pitcherPullConfirmed = relieverOnMound || hasRecentSubstitution
              const _trigger = relieverOnMound ? 'reliever' : hasRecentSubstitution ? 'substitution' : 'kalshi-signal'
              console.log(`[live] ✅ PULL CONFIRMED (${_trigger}${pitcherPullConfirmed ? '' : ' — unconfirmed'})  ${ctx.pitcherName}  ${currentKs}K ${currentIPraw}IP — firing free money`)
              _kalshiPullSignal.delete(String(pitcherId))  // consume signal
              notCurrentSince.delete(pitcherId)
              _pullFired.add(String(pitcherId))
            } else {
              // Track for diagnostics only — no auto-fire on stale readings
              if (!notCurrentSince.has(pitcherId)) {
                notCurrentSince.set(pitcherId, { ip: currentIP, ks: currentKs, seenAt: Date.now() }, game.id)
                console.log(`[live] 👀 POSSIBLE PULL  ${ctx.pitcherName}  ${currentKs}K ${currentIPraw}IP — waiting for confirmed signal (reliever / substitution / Kalshi)`)
              }
            }
          } else if (isCurrent) {
            if (notCurrentSince.has(pitcherId)) {
              console.log(`[live] ↩  PULL CANCELLED  ${ctx.pitcherName}  back in game  ${currentKs}K ${currentIPraw}IP`)
              notCurrentSince.delete(pitcherId)
            }
          }
          // Suppress pull execution if the game is already settled — a restart with stale
          // IP/Ks data should not re-fire free-money bets for a game that finished hours ago.
          if (pitcherPulledEarly && settledGames.has(game.id)) {
            console.log(`[live] 🛑 PULL skip  ${ctx.pitcherName} — game already settled, suppressing free-money execution`)
            pitcherPulledEarly = false
          }
          if (pitcherPulledEarly) {
            urgentThisCycle = true  // free money window — stay fast
            // Clear any oneAway entries for this pitcher — pull means YES bets are dead, no longer urgent
            for (const bet of openBets) {
              const key = `${bet.id}`
              if (oneAway.has(key)) {
                oneAway.delete(key)
                console.log(`[live] ↩  oneAway cleared for bet #${bet.id} (${ctx.pitcherName} ${bet.strike}+) — pitcher pulled`)
              }
            }
          }

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
                // Only hedge the bettor who actually holds this YES position — not every active bettor.
                // Buying NO for a user with no YES exposure creates an orphan position.
                const betOwner = activeBettors.find(b => b.id === bet.user_id)
                if (!betOwner) continue
                await executeBet({
                  pitcherName: ctx.pitcherName, pitcherId, game: ctx.game,
                  strike: bet.strike, side: 'NO',
                  modelProb: 0.99, marketMid: bet.market_mid ?? 50, edge: 0.90,
                  ticker: bet.ticker, betSize: PULLED_CAP_USD,
                  kellyFraction: 0, capitalRisk: 0,
                  liveKs: 0, liveIP: 0, livePitches: 0, liveBF: 0,
                  liveInning: ls?.currentInning ?? 0, livePkEffective: null, liveLambda: null, liveScore: null,
                  mode: 'pulled', user: betOwner,
                }).catch(() => {})
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

          // ── Halt gate: check system_flags before any bet placement ──
          const haltRow = await db.one(`SELECT value FROM system_flags WHERE key='trading_halted'`).catch(() => null)
          if (haltRow?.value === '1') {
            if (!_haltLogged) { console.log('[liveMonitor] HALTED via system_flags — skipping bet placement'); _haltLogged = true }
            continue
          }
          if (_haltLogged) { console.log('[liveMonitor] HALT lifted — resuming'); _haltLogged = false }

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
          // model_prob + fill_price included so stack-yes and pull-hedge can use them.
          const preGameForPitcher = await db.all(
            `SELECT strike, side, user_id, model_prob, fill_price, filled_contracts, order_status FROM ks_bets
              WHERE bet_date = ? AND pitcher_id = ? AND live_bet = 0`,
            [TODAY, String(pitcherId)],
          )
          // Per-bettor pre-game positions — used to avoid mixed positions per user
          const preGameKeysByUser = new Map()
          // Per-strike max pre-game YES model_prob — stack-yes requires live prob ≥ this + 0.15
          const preGameProbByStrike = new Map()
          // Per-user, per-strike YES position for filled bets — pull-hedge portfolio sizing.
          // Map<userId, Map<strike, {fillPriceCents, filledContracts}>>
          const preGameYesByUserStrike = new Map()
          for (const r of preGameForPitcher) {
            if (!preGameKeysByUser.has(r.user_id)) preGameKeysByUser.set(r.user_id, new Set())
            preGameKeysByUser.get(r.user_id).add(`${r.strike}-${r.side}`)
            if (r.side === 'YES' && r.model_prob != null) {
              const prev = preGameProbByStrike.get(r.strike) ?? 0
              if (r.model_prob > prev) preGameProbByStrike.set(r.strike, r.model_prob)
            }
            if (r.side === 'YES' && r.fill_price != null && r.order_status === 'filled') {
              if (!preGameYesByUserStrike.has(r.user_id)) preGameYesByUserStrike.set(r.user_id, new Map())
              preGameYesByUserStrike.get(r.user_id).set(r.strike, {
                fillPriceCents:  r.fill_price,
                filledContracts: r.filled_contracts ?? 0,
              })
            }
          }
          // Helper: returns per-bettor key set (empty set if no pre-game bets)
          const pgKeys = (b) => preGameKeysByUser.get(b.id) ?? new Set()
          // Qualifying filter uses intersection: skip only when ALL bettors are blocked.
          // Per-bettor checks in the execution loop handle individual conflicts.
          const allHave  = (key) => activeBettors.length > 0 && activeBettors.every(b => pgKeys(b).has(key))
          const anyCanTrade = (noKey, yesKey) => activeBettors.some(b => !pgKeys(b).has(noKey) && !pgKeys(b).has(yesKey))

          // ── Pass 1: collect qualifying edges for this pitcher ──
          const qualifying      = []
          const snapshotRows    = []
          const capturedAt      = new Date().toISOString()
          const rejectReasonByN = new Map()  // n → reason string for snapshot

          // Read current rules from cache (10-min TTL)
          const R = activeBettingRules
          const yesMaxStrike    = R.yes_max_strike        ?? 6
          const noMaxStrike     = R.no_max_strike         ?? 6
          const noMaxMarketMid  = R.no_max_market_mid     ?? 45
          const yesMinProbBase  = R.yes_min_prob          ?? 0.60
          const yesMinProbMom   = R.yes_min_prob_momentum ?? 0.55
          const yesMinEdgeBase  = R.yes_min_edge_base     ?? 0.12
          const yesMinEdgeMom   = R.yes_min_edge_momentum ?? 0.10
          const yesMinEdgeFull  = R.yes_min_edge_full_conv ?? 0.20
          const yesFullConvProb = R.yes_full_conv_prob    ?? 0.75
          const noMaxModelProb  = R.no_max_model_prob     ?? 0.15
          const noMaxAskCents   = R.no_max_ask_cents      ?? 55
          const noMinEdge       = R.no_min_edge           ?? 0.15

          for (const mkt of markets) {
            const parts = mkt.ticker.split('-')
            const n = parseInt(parts[parts.length - 1])
            if (!Number.isInteger(n) || n < 2 || n > 15) continue

            // Pulled & below threshold: market is structurally dead, model hasn't caught up.
            // Block ALL new bets (YES and NO edge) to prevent buying YES at 1¢ with 60% model.
            // Crossed-YES (n ≤ currentKs) and NO for uncrossed thresholds still handled below.
            if (_pullFired.has(String(pitcherId)) && !isCurrent && n > currentKs) {
              rejectReasonByN.set(n, 'pulled_dead'); continue
            }

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
            if (activeBettors.length > 0 && activeBettors.every(b => placed.has(`${b.id}:${betKey}`))) {
              rejectReasonByN.set(n, 'already_covered'); continue
            }
            if (allHave(`${n}-NO`) && allHave(`${n}-YES`)) {
              rejectReasonByN.set(n, 'already_covered'); continue
            }

            // ── MODE 1: Pulled pitcher — structurally resolved, stale market arb ──
            // YES-only block intentionally removed: when we hold YES and the pitcher is pulled
            // with K < strike, YES is structurally dead. Buying NO here recovers part of the
            // loss (free-money hedge). The double-sided block above (NO+YES) already prevents
            // adding when both sides are held. Per-user conflict check in execution loop handles
            // users who already hold NO on this market.
            // IMPORTANT: always `continue` when pitcher is pulled — even if NO is illiquid —
            // so we never fall through to MODE 2 edge detection and buy YES on a dead market.
            if (pitcherPulledEarly && n > currentKs) {
              if (allHave(`${n}-NO`)) { rejectReasonByN.set(n, 'already_covered'); continue }
              if (noMid >= 96 || noMid <= 5) { rejectReasonByN.set(n, 'illiquid_pulled'); continue }
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

            // ── MODE 1.8: Early blowout — larger deficit, one inning earlier ──
            // Deficit ≥7 in inning ≥5 with K gap ≥2 and pitch count ≥65.
            // Pitch-count+deficit combo gives ~88% confidence even before the 6th.
            // Separate from MODE 1.7 so each can be independently calibrated.
            if (isCurrent && scoreDiff <= -EARLY_BLOWOUT_DEFICIT && currentInn >= EARLY_BLOWOUT_INNING &&
                currentPitches >= EARLY_BLOWOUT_PITCH && (n - currentKs) >= 2) {
              if (!allHave(`${n}-NO`) && noMid < 80 && noMid > 5) {
                const earlyBlowoutEdge = (1 - marketPrice) - 0.12  // ~88% confidence → ~12% miss rate
                if (earlyBlowoutEdge >= 0.10) {
                  qualifying.push({
                    n, mkt, midCents, marketPrice, modelProb: 0.12,
                    edge: earlyBlowoutEdge, betSide: 'NO', betKey, mode: 'early-blowout',
                    modelProbSide: 0.88, marketPriceSide: 1 - marketPrice,
                  })
                }
              }
              continue
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

            // ── MODE 1.55: Late-inning structural NO — 9th+ inning, pitcher running out of batters ──
            // 9th inning or later, still active, needs ≥2 more Ks, pitch count ≥LATE_INN_MIN_PITCH.
            // Even in a close game, a starter needing 2+ Ks in the 9th at 70+ pitches is ~90%+
            // to fail — managers almost never extend in this scenario. Dead-path catches <10% model
            // prob; this catches the 10-20% range specifically in late innings where blowout ≠ required.
            if (isCurrent && currentInn >= 9 && currentPitches >= LATE_INN_MIN_PITCH &&
                (n - currentKs) >= 2 && modelProb < LATE_INN_MAX_PROB) {
              if (!allHave(`${n}-NO`) && noMid < 80 && noMid > 5) {
                const lateEdge = (1 - marketPrice) - modelProb
                if (lateEdge >= 0.10) {
                  qualifying.push({
                    n, mkt, midCents, marketPrice, modelProb,
                    edge: lateEdge, betSide: 'NO', betKey, mode: 'late-inning-no',
                    modelProbSide: 1 - modelProb, marketPriceSide: 1 - marketPrice,
                  })
                }
              }
              continue
            }

            // ── MODE 1.6: Pull-hedge NO — protect a pre-game YES when pitcher nearing pull ──
            // Four-signal convergence gate:
            //   1. Structural ceiling (arithmetic: remaining batters vs. Ks needed)
            //   2. Batter gauntlet (upcoming hitters' K% → binomial probability)
            //   5. Market + model dual confirmation
            //   6. Game state (score diff, inning → manager pull incentives)
            // All four feed into a 0-100 confidence score. Score ≥ 45 → hedge.
            // Size scales with score: 0.5× at 45, 0.75× at 70, 1.0× at 90+.
            if (isCurrent && currentPitches >= PULL_PITCH_COUNT && currentIP >= PULL_MIN_IP) {
              const anyBettorNeedsHedge = activeBettors.some(b => {
                const pos = preGameYesByUserStrike.get(b.id)?.get(n)
                if (pos == null) return false
                return _computeHedgePlan({
                  yesFilledContracts: pos.filledContracts,
                  yesFillCents:       pos.fillPriceCents,
                  noAskCents, modelProb, maxUSD: PULL_HEDGE_MAX_USD,
                }).qualified
              })
              if (anyBettorNeedsHedge && noMid > 5 && noMid < 75 && !allHave(`${n}-NO`)) {
                const needed     = n - currentKs
                const confidence = computeHedgeConfidence({
                  needed, currentPitches, currentBF,
                  noMid, modelProb, nextBatters,
                  scoreDiff, currentInn: ls?.currentInning ?? 0,
                })
                if (!confidence.confident) {
                  rejectReasonByN.set(n, `hedge-low-confidence:score=${confidence.score}:${confidence.signals.structural}`)
                  continue
                }
                const noEdge = (1 - modelProb) - (1 - marketPrice)
                qualifying.push({
                  n, mkt, midCents, marketPrice, modelProb,
                  edge: noEdge, betSide: 'NO', betKey, mode: 'pull-hedge',
                  noAskCents, yesBidCents, confidence,
                  modelProbSide: 1 - modelProb, marketPriceSide: 1 - marketPrice,
                })
                continue
              }
            }

            const edgeYES   = modelProb - marketPrice
            const edgeNO    = (1 - modelProb) - (1 - marketPrice)
            const betSide   = edgeYES >= edgeNO ? 'YES' : 'NO'
            const edge      = betSide === 'YES' ? edgeYES : edgeNO

            // Stacking gate: block if all bettors already hold this side pre-game.
            // EXCEPTION (YES only): allow a half-sized stack when the live model is materially
            // more confident than pre-game (≥ +0.15 prob lift), edge is healthy (≥ 0.15),
            // and fill is reasonable (mid ≤ 65¢). Emitted directly, bypasses MODE 2 gates.
            if (allHave(`${n}-${betSide}`)) {
              let allowStack = false
              if (betSide === 'YES') {
                const pgProb = preGameProbByStrike.get(n)
                if (pgProb != null && modelProb >= pgProb + 0.15 && edge >= 0.15 && midCents <= 65) {
                  allowStack = true
                }
              }
              if (!allowStack) {
                rejectReasonByN.set(n, 'already_covered'); continue
              }
              qualifying.push({
                n, mkt, midCents, marketPrice, modelProb, edge, betSide, betKey,
                mode: 'stack-yes', kellyScale: 0.50,
                modelProbSide: modelProb, marketPriceSide: marketPrice,
              })
              continue
            }

            // ── Rule-based bans (from betting_rules table) ──
            if (betSide === 'YES' && yesMaxStrike > 0 && n > yesMaxStrike) {
              rejectReasonByN.set(n, `yes_strike_ban:${n}>${yesMaxStrike}`); continue
            }
            if (betSide === 'NO' && noMaxStrike > 0 && n > noMaxStrike) {
              rejectReasonByN.set(n, `no_strike_ban:${n}>${noMaxStrike}`); continue
            }
            if (betSide === 'NO' && noMaxMarketMid > 0 && midCents > noMaxMarketMid) {
              rejectReasonByN.set(n, `no_mid_cap:mid=${midCents.toFixed(0)}>${noMaxMarketMid}`); continue
            }

            // ── MODE 2: High-conviction — tiered YES thresholds + ksChanged momentum ──
            // kellyScale < 1 → partial sizing for lower-conviction entries
            if (betSide === 'YES') {
              // Apr 28 — pitch-count staleness gate. If MLB API returned 0 pitches for a
              // pitcher with IP ≥ 5, the lambda calc is built on stale data. Don't size off it.
              if (pitchCountStale) {
                rejectReasonByN.set(n, `pitch_count_stale:0p@${currentIP}IP`); continue
              }
              // Extreme divergence guard: when YES market < 5¢ AND model edge > 30¢, the divergence
              // almost always reflects model staleness (pitcher pulled / about to be pulled, model
              // still believes he's pitching) rather than a real edge. The market in that regime is
              // far more informative than the live model.
              if (marketPrice < 0.05 && edge > 0.30) {
                rejectReasonByN.set(n, `extreme_divergence:mkt=${(marketPrice*100).toFixed(1)}¢<5¢ model=${(modelProb*100).toFixed(0)}%`)
                alertExtremeDivergence({ pitcherName: ctx.pitcherName, strike: n, modelProb, marketPrice }).catch(() => {})
                continue
              }
              const onKMomentum = ksChanged   // pitcher just added a K this cycle
              const yesMinProb  = onKMomentum ? yesMinProbMom  : yesMinProbBase
              const yesFullConv = modelProb >= yesFullConvProb
              const yesMinEdge  = yesFullConv
                ? Math.max(yesMinEdgeFull, halfSpread + 0.04)
                : onKMomentum ? Math.max(yesMinEdgeMom, halfSpread + 0.03) : Math.max(yesMinEdgeBase, halfSpread + 0.03)
              if (modelProb < yesMinProb) { rejectReasonByN.set(n, `yes_low_prob:${modelProb.toFixed(3)}<${yesMinProb}`); continue }
              if (edge < yesMinEdge) { rejectReasonByN.set(n, `yes_low_edge:${edge.toFixed(3)}<${yesMinEdge.toFixed(3)}`); continue }
              const kellyScale  = yesFullConv ? 1.0 : onKMomentum ? 0.35 : 0.50
              qualifying.push({
                n, mkt, midCents, marketPrice, modelProb, edge, betSide, betKey,
                mode: 'high-conviction', kellyScale,
                modelProbSide: modelProb, marketPriceSide: marketPrice,
              })
            } else {
              if (modelProb > noMaxModelProb) { rejectReasonByN.set(n, `no_high_prob:${modelProb.toFixed(3)}>${noMaxModelProb}`); continue }
              if (noAskCents > noMaxAskCents) { rejectReasonByN.set(n, `no_high_ask:${noAskCents}>${noMaxAskCents}`); continue }
              const noMinEdgeCalc = Math.max(noMinEdge, halfSpread + 0.04)
              if (edge < noMinEdgeCalc) { rejectReasonByN.set(n, `no_low_edge:${edge.toFixed(3)}<${noMinEdgeCalc.toFixed(3)}`); continue }
              qualifying.push({
                n, mkt, midCents, marketPrice, modelProb, edge, betSide, betKey,
                mode: 'high-conviction', kellyScale: 1.0,
                modelProbSide: 1 - modelProb, marketPriceSide: 1 - marketPrice,
              })
            }
          }

          // ── Snapshot: capture every evaluated market this tick (fire-and-forget) ──
          for (const mkt of markets) {
            const parts = mkt.ticker.split('-')
            const n = parseInt(parts[parts.length - 1])
            if (!Number.isInteger(n) || n < 2 || n > 15) continue
            const yesBid = mkt.yes_bid ?? (mkt.yes_bid_dollars != null ? Math.round(parseFloat(mkt.yes_bid_dollars) * 100) : null)
            const yesAsk = mkt.yes_ask ?? (mkt.yes_ask_dollars != null ? Math.round(parseFloat(mkt.yes_ask_dollars) * 100) : null)
            if (yesBid == null || yesAsk == null) continue
            const midC     = (yesBid + yesAsk) / 2
            const mProb    = pitcherPulledEarly ? 0.02 : (live ? live.probAtLeast(n) : null)
            if (mProb == null) continue
            const mp       = midC / 100
            const eYes     = mProb - mp
            const eNo      = (1 - mProb) - (1 - mp)
            const bSide    = eYes >= eNo ? 'YES' : 'NO'
            const bEdge    = Math.max(eYes, eNo)
            const qItem    = qualifying.find(q => q.n === n)
            snapshotRows.push(buildSnapshotRow({
              ticker:       mkt.ticker,
              pitcherId,
              pitcherName:  ctx.pitcherName,
              strike:       n,
              gameDate:     TODAY,
              capturedAt,
              gameId:       game?.id    ?? null,
              gameLabel:    ctx.game    ?? null,
              gameStatus:   game?.status?.abstractGameState ?? null,
              yesBidCents:  yesBid,
              yesAskCents:  yesAsk,
              midCents:     midC,
              openInterest: mkt.open_interest ?? null,
              volume:       mkt.volume        ?? null,
              modelProb:    mProb,
              edgeYes:      eYes,
              edgeNo:       eNo,
              bestSide:     bSide,
              bestEdge:     bEdge,
              kellyFraction: qItem?.kellyScale ?? null,
              evalMode:     qItem?.mode ?? (pitcherPulledEarly ? 'pulled' : 'scan'),
              qualified:    qItem ? 1 : 0,
              rejectReason: qItem ? null : (rejectReasonByN.get(n) ?? null),
              liveKs:       currentKs,
              liveIp:       currentIP,
              liveBf:       currentBF,
              livePitches:  currentPitches,
              stillIn:      isCurrent,
              currentInning,
              homeScore,
              awayScore,
            }))
          }
          writeSnapshotBatch(snapshotRows).catch(() => {})

          // Apr 29 — env-gated mode kill switch. Set DISABLED_LIVE_MODES (comma-list)
          // to skip specific live modes without code changes. Currently used to disable
          // high-conviction et al. while live model is being recalibrated; pulled (free
          // money) and pull-hedge are intentionally left active.
          const _disabledModes = String(process.env.DISABLED_LIVE_MODES || '')
            .split(',').map(s => s.trim()).filter(Boolean)
          if (_disabledModes.length && qualifying.length) {
            const before = qualifying.length
            for (let qi = qualifying.length - 1; qi >= 0; qi--) {
              if (_disabledModes.includes(qualifying[qi].mode)) {
                rejectReasonByN.set(qualifying[qi].n, `mode_disabled:${qualifying[qi].mode}`)
                qualifying.splice(qi, 1)
              }
            }
            if (qualifying.length < before) {
              console.log(`[live] mode kill switch dropped ${before - qualifying.length} of ${before} qualifying signals (DISABLED=${_disabledModes.join(',')})`)
            }
          }

          // Apr 29 — backtest on 4/22-4/28 data showed inverting every live YES to NO
          // would have swung +$2,467 over the week. Live YES is systematically -EV
          // because pull risk is unmodeled and the upside is asymmetric (YES at 60c+
          // pays 30c; NO at the same strike pays 60c+). Disable all live YES until
          // pull-prob model is built. NO + hedge remain active.
          if (process.env.LIVE_YES_DISABLED === 'true' && qualifying.length) {
            const before = qualifying.length
            for (let qi = qualifying.length - 1; qi >= 0; qi--) {
              if (qualifying[qi].betSide === 'YES') {
                rejectReasonByN.set(qualifying[qi].n, `live_yes_disabled`)
                qualifying.splice(qi, 1)
              }
            }
            if (qualifying.length < before) {
              console.log(`[live] LIVE_YES_DISABLED dropped ${before - qualifying.length} of ${before} qualifying YES signals`)
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
          const TAKER_MODES = new Set(['pulled', 'crossed-yes', 'blowout', 'dead-path', 'pull-hedge', 'early-blowout', 'late-inning-no'])
          const execOrder = qualifying.map((_, i) => i)
          if (qualifying.some(q => TAKER_MODES.has(q.mode))) {
            execOrder.sort((a, b) => qualifying[b].n - qualifying[a].n)
          }

          // Shared exec helper — returns true if any bettor order succeeded
          const runExecItem = async (i) => {
            const q = qualifying[i]
            const s = sized[i]
            // Pull-hedge: skip Kelly entirely — per-bettor portfolio sizing inside bettor loop
            if (q.mode !== 'pull-hedge' && (!s || s.betSize <= 0)) return false

            // ── Live model probability update ────────────────────────────────
            // For normal high-conviction bets, use the same live.probAtLeast that drove
            // qualification (computeLiveModel result). This eliminates the inconsistency
            // where qualification used one function and sizing used another (computeLiveProb).
            // Pulled/dead-path modes use hardcoded structural probabilities — don't overwrite.
            let liveModelProbSide = q.modelProbSide
            if ((q.mode === 'high-conviction') && live && currentBF >= 6) {
              const posterior = live.probAtLeast(q.n)
              if (posterior > 0) {
                liveModelProbSide = q.betSide === 'YES' ? posterior : 1 - posterior
              }
            }

            // Per-pitcher cap check is now per-bettor — moved inside the bettor loop below.

            // Pull-hedge: betSize is determined per-bettor by _computeHedgePlan — skip Kelly math.
            // All other modes: 2× sizing for high-edge bets (≥15¢); kellyScale < 1 for lower-conviction.
            const edgeMult     = (q.mode === 'pull-hedge' || q.edge < 0.15) ? 1 : 2
            // Hard absolute cap applies to model-driven modes (where stale Bayesian state can produce
            // false edge). Structurally-certain modes (pulled/blowout/etc.) have their own per-mode
            // caps via FREE_MONEY_PITCHER_CAP / PULLED_CAP_CONFIRMED_USD, so don't double-cap them.
            const MODEL_DRIVEN = q.mode === 'high-conviction' || q.mode === 'stack-yes' || q.mode === 'dead-path'
            const rawSize      = s.betSize * edgeMult * (q.kellyScale ?? 1.0)
            const finalBetSize = q.mode === 'pull-hedge'
              ? 0   // unused — each bettor uses hedgePlan.hedgeCost computed in the loop
              : MODEL_DRIVEN
                ? Math.min(kellyConfig.MAX_BET, LIVE_HIGH_CONVICTION_CAP_USD, rawSize)
                : Math.min(kellyConfig.MAX_BET, rawSize)
            // capital at risk = cash committed (betSize is USD cash, not notional contracts)
            const capitalRisk  = finalBetSize

            const scaleTag = (q.kellyScale ?? 1.0) < 1.0 ? ` [${Math.round((q.kellyScale ?? 1.0)*100)}% kelly]` : ''
            const sizeTag  = edgeMult > 1 ? ` [2× edge=${(q.edge*100).toFixed(0)}¢]${scaleTag}` : scaleTag
            const _tag = q.mode === 'pulled' ? '🎯 PULLED' : q.mode === 'crossed-yes' ? '🟢 CROSSED-YES' : q.mode === 'blowout' ? '🏳️ BLOWOUT' : q.mode === 'early-blowout' ? '🏳️ EARLY-BLOWOUT' : q.mode === 'late-inning-no' ? '🕙 LATE-NO' : q.mode === 'stack-yes' ? '📚 STACK' : q.mode === 'pull-hedge' ? '🛡️ PULL-HEDGE' : '🔥 EDGE'
            const _confTag = q.mode === 'pull-hedge' && q.confidence ? `  conf=${q.confidence.score}/${q.confidence.sizeMultiplier*100|0}%[${q.confidence.signals?.structural}]` : ''
            console.log(`\n[live] ${_tag} ${ctx.game} ${ctx.pitcherName} ${q.n}+ Ks ${q.betSide}  model=${(q.modelProb*100).toFixed(1)}%  mid=${q.midCents.toFixed(0)}¢  edge=${(q.edge*100).toFixed(1)}¢  ${currentKs}K ${currentIPraw}IP ${currentPitches}p ${currentBF}BF  [${q.mode}]${sizeTag}${_confTag}`)
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
                // NOTE: bettors with pre-game YES are NOT blocked here — buying NO when pitcher
                // is structurally pulled is a free-money hedge that recovers part of the YES loss.
              } else if (q.mode === 'crossed-yes') {
                if (myPgKeys.has(`${q.n}-NO`) || myPgKeys.has(`${q.n}-YES`)) { placed.add(bettorKey); continue }
              } else if (q.mode === 'pull-hedge') {
                if (myPgKeys.has(`${q.n}-NO`)) { placed.add(bettorKey); continue }
                // Require the bettor to hold a filled YES at this strike — no orphan hedges.
                // Re-run _computeHedgePlan per-bettor: each bettor's fill price and contract count
                // determines their individual hedge size and whether the EV gate passes for them.
                const myPos = preGameYesByUserStrike.get(bettor.id)?.get(q.n)
                if (!myPos) { placed.add(bettorKey); continue }
                const hedgePlan = _computeHedgePlan({
                  yesFilledContracts: myPos.filledContracts,
                  yesFillCents:       myPos.fillPriceCents,
                  noAskCents:         q.noAskCents,
                  modelProb:          q.modelProb,
                  maxUSD:             PULL_HEDGE_MAX_USD,
                })
                if (!hedgePlan.qualified) { placed.add(bettorKey); continue }
                // Scale hedge size by confidence sizeMultiplier (0.50–1.00 based on signal score).
                // This lets high-conviction signals buy full insurance while borderline signals buy half.
                const sizeMult      = q.confidence?.sizeMultiplier ?? 0.5
                const adjContracts  = Math.max(1, Math.round(hedgePlan.hedgeContracts * sizeMult))
                const adjCost       = adjContracts * (q.noAskCents / 100)
                bettor._hedgePlan   = { ...hedgePlan, hedgeContracts: adjContracts, hedgeCost: adjCost, _myPos: myPos }
              } else if (q.mode === 'blowout' || q.mode === 'early-blowout' || q.mode === 'late-inning-no' || q.mode === 'dead-path') {
                if (myPgKeys.has(`${q.n}-NO`)) { placed.add(bettorKey); continue }
              } else if (q.mode === 'stack-yes') {
                // stack-yes is intentional same-side stacking — every active bettor holds YES
                // pre-game by definition (allHave(YES) gate above). Block only if they already hold NO,
                // which would create a mixed position.
                if (myPgKeys.has(`${q.n}-NO`)) { placed.add(bettorKey); continue }
              } else {
                if (myPgKeys.has(`${q.n}-${q.betSide}`)) { placed.add(bettorKey); continue }
              }

              // Per-user daily loss limit — skip this bettor if they've hit their personal cap.
              // Uses users.daily_loss_limit if set; falls back to global LOSS_LIMIT env var.
              if (bettor.paper === 0 && bettor.kalshi_key_id) {
                const userLimit = bettor.daily_loss_limit != null ? Number(bettor.daily_loss_limit) : LOSS_LIMIT
                const userLoss  = await getUserDailyLoss(bettor.id)
                if (userLoss >= userLimit) {
                  console.log(`[live] 🛑 ${bettor.name} daily loss limit hit ($${userLoss.toFixed(0)}/$${userLimit}) — skipping`)
                  placed.add(bettorKey)
                  continue
                }
              }

              // Per-bettor, per-threshold free-money cap — 5% of bankroll per strike threshold
              if (q.mode === 'pulled' || q.mode === 'crossed-yes' || q.mode === 'blowout' || q.mode === 'early-blowout' || q.mode === 'late-inning-no') {
                const capKey = `${pitcherId}-${q.n}`
                const alreadySent = freeMoneySentByUserPitcher.get(bettor.id)?.get(capKey) ?? 0
                // Confirmed two-tier pulls (reliever on mound or substitution event) get a higher
                // per-threshold cap — structural certainty is higher than a Kalshi-signal-only pull.
                const freeMoneyCap = (q.mode === 'pulled' && pitcherPullConfirmed)
                  ? PULLED_CAP_CONFIRMED_USD : FREE_MONEY_PITCHER_CAP
                if (alreadySent >= freeMoneyCap) {
                  console.log(`[live] 🚫 FREE MONEY CAP  ${bettor.name}  ${ctx.pitcherName}  ${q.n}+  $${alreadySent.toFixed(0)}/$${freeMoneyCap.toFixed(0)} — skipping  [${q.mode}${q.mode==='pulled'&&pitcherPullConfirmed?' confirmed':''}]`)
                  placed.add(bettorKey)
                  continue
                }
              }

              // Apr 28 — Per-bettor, per-pitcher HIGH-CONVICTION cap. Limits cumulative spend
              // across all strike thresholds for the same pitcher. Without this, 5 strikes
              // each at $200 = $1000 per user on one pitcher (Paddack-class disaster vector).
              if (q.mode === 'high-conviction' || q.mode === 'stack-yes' || q.mode === 'dead-path') {
                const alreadySent = hcSentByUserPitcher.get(bettor.id)?.get(pitcherId) ?? 0
                const wouldSpend  = alreadySent + finalBetSize
                if (wouldSpend > LIVE_HC_PITCHER_CAP_USD) {
                  console.log(`[live] 🚫 HC PITCHER CAP  ${bettor.name}  ${ctx.pitcherName}  ${q.n}+  $${alreadySent.toFixed(0)} + $${finalBetSize.toFixed(0)} > $${LIVE_HC_PITCHER_CAP_USD} — skipping  [${q.mode}]`)
                  placed.add(bettorKey)
                  continue
                }
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
                betSize:          q.mode === 'pull-hedge' ? (bettor._hedgePlan?.hedgeCost ?? 0) : finalBetSize,
                kellyFraction:    s?.kellyFraction ?? null,
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
                hedgeOverride:    q.mode === 'pull-hedge' ? bettor._hedgePlan : null,
                user:             bettor,
              })
              const capturedHedge = q.mode === 'pull-hedge' ? { ...bettor._hedgePlan } : null
              if (q.mode === 'pull-hedge') delete bettor._hedgePlan

              if (betResult?.dedup || betResult?.kalshiDedup || betResult?.budget) {
                placed.add(bettorKey)
              } else if (betResult?.apiFailed) {
                console.log(`  [live] order failed for ${bettor.name} ${q.betKey} — will retry next poll`)
              } else if (betResult?.finalContracts != null || betResult?.freeMoneySummary != null) {
                placed.add(bettorKey)
                anySuccess = true
                if (betResult.betId) linkBetToSnapshot(betResult.betId, q.mkt.ticker, capturedAt).catch(() => {})

                // Track free-money spend toward per-bettor per-threshold cap
                if ((q.mode === 'pulled' || q.mode === 'crossed-yes' || q.mode === 'blowout' || q.mode === 'early-blowout' || q.mode === 'late-inning-no') && betResult.finalContracts > 0) {
                  const askC = betResult.freeMoneySummary?.askCents ?? q.midCents
                  const spent = betResult.finalContracts * (askC / 100)
                  if (!freeMoneySentByUserPitcher.has(bettor.id)) freeMoneySentByUserPitcher.set(bettor.id, new Map())
                  const bMap = freeMoneySentByUserPitcher.get(bettor.id)
                  const capKey = `${pitcherId}-${q.n}`
                  bMap.set(capKey, (bMap.get(capKey) ?? 0) + spent)
                }

                // Apr 28 — track high-conviction spend toward per-pitcher cap
                if ((q.mode === 'high-conviction' || q.mode === 'stack-yes' || q.mode === 'dead-path') && finalBetSize > 0) {
                  if (!hcSentByUserPitcher.has(bettor.id)) hcSentByUserPitcher.set(bettor.id, new Map())
                  const bMap = hcSentByUserPitcher.get(bettor.id)
                  bMap.set(pitcherId, (bMap.get(pitcherId) ?? 0) + finalBetSize)
                }

                const webhooks = bettor.discord_webhook ? [bettor.discord_webhook] : []
                if (q.mode === 'pulled' && betResult?.freeMoneySummary) {
                  await notifyFreeMoney({
                    pitcherName: ctx.pitcherName,
                    strike: q.n, currentKs,
                    yesPrice:       betResult.freeMoneySummary.yesPrice,
                    contracts:      betResult.finalContracts,
                    initFilled:     betResult.initFilled,
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
                    initFilled:     betResult.initFilled,
                    expectedProfit: betResult.freeMoneySummary.expectedProfit,
                    game: ctx.game, paper: bettor.paper !== 0,
                  }, webhooks)
                  // Track for live certainty parlay — 2+ crossed-YES from different pitchers
                  if (!bettor.paper) {
                    const legKey = `${ctx.pitcherName}-${q.n}`
                    _certLegs.set(legKey, { pitcherName: ctx.pitcherName, strike: q.n, currentKs, game: ctx.game })
                    const uniquePitchers = [...new Set([..._certLegs.values()].map(l => l.pitcherName))]
                    if (uniquePitchers.length >= 2) {
                      const legs = uniquePitchers.slice(0, 2).map(p => [..._certLegs.values()].find(l => l.pitcherName === p))
                      const pKey = parlayKey(legs)
                      if (!_certParlaySent.has(pKey)) {
                        _certParlaySent.add(pKey)
                        const allWh = await getAllWebhooks(db).catch(() => [])
                        await notifyCertaintyParlay(buildCertaintyParlay(legs), allWh)
                      }
                    }
                  }
                } else if (q.mode === 'blowout' && betResult?.freeMoneySummary) {
                  await notifyBlowout({
                    pitcherName: ctx.pitcherName,
                    strike: q.n, currentKs,
                    scoreDiff, currentInn,
                    contracts:      betResult.finalContracts,
                    initFilled:     betResult.initFilled,
                    askCents:       betResult.freeMoneySummary.askCents,
                    expectedProfit: betResult.freeMoneySummary.expectedProfit,
                    game: ctx.game, paper: bettor.paper !== 0,
                  }, webhooks)
                } else if (q.mode === 'early-blowout' && betResult?.freeMoneySummary) {
                  await notifyBlowout({
                    pitcherName: ctx.pitcherName,
                    strike: q.n, currentKs,
                    scoreDiff, currentInn,
                    contracts:      betResult.finalContracts,
                    initFilled:     betResult.initFilled,
                    askCents:       betResult.freeMoneySummary.askCents,
                    expectedProfit: betResult.freeMoneySummary.expectedProfit,
                    game: ctx.game, paper: bettor.paper !== 0,
                  }, webhooks)
                } else if (q.mode === 'late-inning-no') {
                  await notifyLiveBet({
                    pitcherName: ctx.pitcherName,
                    strike: q.n, side: q.betSide,
                    marketMid: q.midCents, edge: q.edge, betSize: finalBetSize,
                    currentKs, currentIPraw, currentPitches, paper: bettor.paper !== 0,
                    betMode: 'late-inning-no',
                  }, webhooks)
                } else if (q.mode === 'pull-hedge' && betResult?.freeMoneySummary && (betResult.initFilled ?? 0) > 0 && capturedHedge) {
                  const hedgePos = capturedHedge._myPos ?? {}
                  await notifyHedge({
                    pitcherName:    ctx.pitcherName,
                    strike:         q.n,
                    currentKs,
                    currentIPraw,
                    currentInning:  currentInn,
                    yesContracts:   hedgePos.filledContracts ?? 0,
                    yesFillCents:   hedgePos.fillPriceCents ?? 0,
                    hedgeContracts: betResult.finalContracts,
                    hedgeAskCents:  betResult.freeMoneySummary.askCents,
                    hedgeCost:      betResult.finalContracts * (betResult.freeMoneySummary.askCents / 100),
                    game:           ctx.game,
                    paper:          bettor.paper !== 0,
                  }, webhooks)
                } else if (q.mode === 'dead-path') {
                  // Taker modes — order executes immediately, notify now
                  await notifyLiveBet({
                    pitcherName: ctx.pitcherName,
                    strike: q.n, side: q.betSide,
                    marketMid: q.midCents, edge: q.edge, betSize: finalBetSize,
                    currentKs, currentIPraw, currentPitches, paper: bettor.paper !== 0,
                    betMode: q.mode,
                  }, webhooks)
                } else if (q.mode === 'high-conviction') {
                  // Maker order — only notify if it filled immediately (rare cross).
                  // If resting, convertStaleMakers fires the notification on confirmed fill.
                  if (betResult.orderStatus === 'filled') {
                    await notifyLiveBet({
                      pitcherName: ctx.pitcherName,
                      strike: q.n, side: q.betSide,
                      marketMid: q.midCents, edge: q.edge, betSize: finalBetSize,
                      currentKs, currentIPraw, currentPitches, paper: bettor.paper !== 0,
                      betMode: 'high-conviction',
                    }, webhooks)
                  } else {
                    console.log(`  [MAKER RESTING] ${ctx.pitcherName} ${q.n}+ ${q.betSide} — order resting, Discord held until fill`)
                  }
                }
              }
            }
            if (!anySuccess) {
              const allPlaced = activeBettors.every(b => placed.has(`${b.id}:${q.betKey}`))
              const reason = allPlaced ? 'already placed this session (dedup)' : 'execution failed — see console'
              db.saveLog({ tag: 'SKIP', level: 'warn', msg: `${ctx.pitcherName} ${q.n}+ ${q.betSide} edge not placed — ${reason}`, pitcher: ctx.pitcherName, strike: q.n, side: q.betSide })
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

          // ── Adaptive poll: set per-pitcher next-check timestamp ──────────
          // Convert K-count thresholds to estimated BF thresholds so the main
          // loop wakes up sooner as the pitcher approaches each threshold.
          // live.pK_effective is the posterior K-rate; 1/pK_effective ≈ BF per K.
          if (live && live.pK_effective > 0) {
            const bfPerK = 1 / live.pK_effective
            const bfThresholds = qualifying.map(q =>
              currentBF + Math.max(1, Math.round((q.n - currentKs) * bfPerK)),
            )
            _pitcherNextCheckAt.set(
              String(pitcherId),
              Date.now() + _adaptivePollMs(currentBF, bfThresholds),
            )
          } else if (pitcherPulledEarly) {
            // Pulled pitcher — market repricing rapidly, check every 20s
            _pitcherNextCheckAt.set(String(pitcherId), Date.now() + 20_000)
          }
        }
      } catch (err) {
        const gLabel = ctx?.game ?? game?.game_label ?? 'unknown'
        console.error(`[live] ERROR in game loop [${gLabel}]:`, err.message)
        db.saveLog({ tag: 'ERROR', level: 'error', msg: `game loop error [${gLabel}]: ${err.message?.slice(0, 200)}` }).catch(() => {})
        alertError('liveMonitor:gameLoop', err, {
          game:    gLabel,
          pitcher: ctx?.pitcherName ?? 'unknown',
          phase:   ctx?.phase ?? 'unknown',
        }).catch(() => {})
      }
    }

    if (allDone && iteration > 1) {
      console.log('\n[live] All games final. Monitor done.')

      // Cancel any stale resting orders now that all games are final
      try {
        const liveUsers = await db.all(
          `SELECT id, name, kalshi_key_id, kalshi_private_key FROM users WHERE active_bettor=1 AND kalshi_key_id IS NOT NULL AND is_system_admin = 0`,
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

    // Adaptive sleep: use minimum next-check delay across all active pitchers.
    // If any pitcher is within 5 BF of a threshold, we wake up sooner.
    // Falls back to FAST_SEC if urgency flag is set.
    let nextWakeMs = urgentThisCycle ? FAST_SEC * 1000 : POLL_SEC * 1000
    if (_pitcherNextCheckAt.size > 0) {
      const minNext = Math.min(..._pitcherNextCheckAt.values())
      const timeToMin = minNext - Date.now()
      if (timeToMin > 0 && timeToMin < nextWakeMs) {
        nextWakeMs = Math.max(3000, timeToMin)  // floor 3s
      }
    }
    if (urgentThisCycle) process.stdout.write(`⚡${(nextWakeMs/1000).toFixed(0)}s `)
    await new Promise(r => setTimeout(r, nextWakeMs))
  }

  await db.close()
}

main().catch(async err => {
  console.error('[live] fatal:', err.message, err.stack)
  try {
    await db.saveLog({ tag: 'ERROR', level: 'error', msg: `FATAL CRASH: ${err.message?.slice(0, 300)}` })
    await db.close()
  } catch { /* cleanup failed — exiting anyway */ }
  process.exit(1)
})
