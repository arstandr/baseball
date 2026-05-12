// lib/liveTier2.js
//
// Tier 2 = Dead-Path NO. The mid-game "math is closed" live mode.
// Pitcher is still in the game, but given the K count, BF remaining, and
// realistic per-BF strikeout rate, the threshold is mathematically out of
// reach. Kalshi YES often still trades 5–20¢ in this window because the
// orderbook lags game state — that's our edge.
//
// Higher variance than Tier 1 because the pitcher is still throwing: the
// K count CAN still tick up. The dead-path math says probability of reaching
// strike is small but nonzero. So Tier 2 sizes ~60% of Tier 1.
//
// Built tonight; gated by env TIER2_ENABLED='true'. Same rollout cadence as
// Tier 1: shadow → small caps → expand only after forward-validated ROI.
//
// Family-lock note: confirmedPull is FALSE for Tier 2 (pitcher still in
// game). So any active live NO position blocks Tier 2 — if pitcher gets
// pulled later, we wait for confirmed pull and let Tier 1 add layers.
// Stacking pre-pull NO at K6 + K7 + K8 looks like 3 bets but is one
// correlated position.
//
// This module is the DECISION layer. It does not place orders itself; it
// returns a decision object the existing executeBet() pipeline consumes.

import { STATES, classifyPitcherState, isDeadPath, estimateBfRemaining } from './pitcherState.js'
import { checkFamilyLock, isDuplicateStrike } from './familyLock.js'
import { checkAllCaps } from './strategyCaps.js'
import { STRATEGY_MODES } from './strategyMode.js'

const TIER2_KELLY_FRACTION_HARD_CAP = 0.03  // never more than 3% bankroll per Tier 2 fire
const TIER2_DEFAULT_MAX_BET_USD     = 30    // hard ceiling unless env overrides
const TIER2_AVG_PITCHES_PER_BF      = 4.0

/**
 * Decide whether to fire a Tier 2 dead-path NO bet for a given
 * (user, pitcher, strike) under current state.
 *
 * Returns:
 *   { fire: false, reason }                          → skip
 *   { fire: true, contracts, bet_size_usd, ... }    → proceed to placement
 */
export async function decideTier2({
  db,
  bettor,            // { id, name, kalshi_balance, ... }
  pitcher,           // { id, name }
  strike,
  ourPitcherId,
  game,              // MLB feed game obj (for state check)
  ls,                // linescore (for state check)
  monitorState,      // { not_current_since, game_settled, ... }
  currentPitcherId,
  actualKs,
  betDate,
  orderbook,         // { best_yes_bid, best_no_ask, fetched_at, ... }
  bankroll,          // user's available bankroll for this strategy
  kRateThisStart,    // observed per-BF K rate this start (or season fallback)
  pitchCount,
  expectedBF,
  ip,
  expectedTotalPitches, // optional, improves bfRemaining accuracy
  capCheck = checkAllCaps,
}) {
  // 0. Tier 2 must be explicitly enabled
  if (String(process.env.TIER2_ENABLED ?? '').toLowerCase() !== 'true') {
    return { fire: false, reason: 'tier2_disabled' }
  }

  // 1. State must be MID_GAME or LATE_GAME — pitcher actively throwing,
  //    not pre/early (signal too noisy) and not pulled/final (Tier 1 territory).
  const stateInfo = classifyPitcherState({
    game, ls, ourPitcherId, currentPitcherId, pitchCount, monitorState,
  })
  if (stateInfo.state !== STATES.MID_GAME && stateInfo.state !== STATES.LATE_GAME) {
    return { fire: false, reason: `wrong_state_${stateInfo.state}` }
  }

  // 2. K count must be < strike — otherwise YES already won and NO is locked out
  if (actualKs == null || !Number.isFinite(actualKs)) {
    return { fire: false, reason: 'k_count_not_recorded' }
  }
  if (actualKs >= strike) {
    return { fire: false, reason: `k_count_${actualKs}_already_>=_strike_${strike}` }
  }

  // 3. Estimate BF remaining for this start
  const bfRemaining = estimateBfRemaining({
    pitchCount,
    expectedTotalPitches,
    avgPitchesPerBF: TIER2_AVG_PITCHES_PER_BF,
    ip,
    expectedBF,
  })
  if (bfRemaining == null) {
    return { fire: false, reason: 'bf_remaining_unestimable' }
  }

  // 4. Dead-path math — gap unreachable given remaining BF and observed K rate
  const dead = isDeadPath({
    kCount: actualKs,
    strike,
    bfRemaining,
    kRateThisStart,
  })
  if (!dead.dead) {
    return { fire: false, reason: `path_alive_${dead.reason}` }
  }

  // 5. Orderbook must have fillable NO ask
  const noAsk = orderbook?.best_no_ask
  if (noAsk == null || noAsk <= 0 || noAsk >= 100) {
    return { fire: false, reason: 'no_market_or_invalid_no_ask' }
  }

  // 6. Quote freshness (sub-30s, since we're racing market makers)
  const fetchedAt = orderbook?.fetched_at
  if (fetchedAt) {
    const ageMs = Date.now() - new Date(fetchedAt).getTime()
    if (ageMs > 30_000) return { fire: false, reason: `stale_quote_${Math.round(ageMs / 1000)}s` }
  }

  // 7. Family lock — confirmedPull is FALSE for Tier 2 (pitcher still in game).
  //    Any active live NO position blocks the fire (correlated risk pre-pull).
  const lock = await checkFamilyLock({
    db, userId: bettor.id, pitcherId: pitcher.id, betDate, confirmedPull: false,
  })
  if (!lock.allowed) return { fire: false, reason: `family_lock_${lock.reason}` }
  if (isDuplicateStrike(strike, lock.active_strikes)) {
    return { fire: false, reason: `duplicate_strike_${strike}` }
  }

  // 8. Cap check
  const cap = await capCheck({
    db, userId: bettor.id, pitcherId: String(pitcher.id), betDate,
    strategy_mode: STRATEGY_MODES.LIVE,
  })
  if (!cap.allowed) return { fire: false, reason: `cap_${cap.reason}` }

  // 9. Sizing — Tier 2 is smaller than Tier 1 to reflect higher variance.
  //    Bet $X where X = min(bankroll * TIER2_KELLY_FRACTION_HARD_CAP,
  //                         TIER2_DEFAULT_MAX_BET_USD,
  //                         MAX_LIVE_RISK_PER_PITCHER from env).
  const tier2FractionEnv = Number(process.env.TIER2_KELLY_FRACTION ?? TIER2_KELLY_FRACTION_HARD_CAP)
  const tier2Fraction = Math.min(tier2FractionEnv, TIER2_KELLY_FRACTION_HARD_CAP)
  const tier2MaxBetEnv = Number(process.env.TIER2_MAX_BET_USD ?? TIER2_DEFAULT_MAX_BET_USD)
  const maxPerPitcher = Number(process.env.MAX_LIVE_RISK_PER_PITCHER ?? 75)
  const desiredUsd = Math.min(bankroll * tier2Fraction, tier2MaxBetEnv, maxPerPitcher)
  const noPriceFrac = noAsk / 100
  const contracts = Math.max(1, Math.floor(desiredUsd / noPriceFrac))
  const betSizeUsd = Math.round(contracts * noPriceFrac * 100) / 100

  if (betSizeUsd < 0.5) {
    return { fire: false, reason: `bet_size_below_floor_$${betSizeUsd.toFixed(2)}` }
  }

  return {
    fire: true,
    reason: 'tier2_dead_path_no',
    strategy_mode: STRATEGY_MODES.LIVE,
    strategy_submode: 'live_tier2_dead_path',
    contracts,
    bet_size_usd: betSizeUsd,
    no_price_cents: noAsk,
    dead_path_detail: {
      gap: strike - actualKs,
      bfRemaining,
      kRateThisStart,
      p_yes_estimate: dead.p_yes_estimate,
    },
  }
}

// ------------------------------------------------------------------
// Smoke test (commented out — uncomment + run with `node lib/liveTier2.js`):
// ------------------------------------------------------------------
// import * as db from './db.js'
//
// const baseArgs = {
//   db,
//   bettor: { id: 284, name: 'Adam-Live', kalshi_balance: 1000 },
//   pitcher: { id: '519242', name: 'Test Pitcher' },
//   strike: 7,
//   ourPitcherId: '519242',
//   currentPitcherId: '519242',  // still in
//   actualKs: 3,
//   betDate: '2026-05-01',
//   game: { abstractGameState: 'Live' },
//   ls: { currentInning: 5, teams: { home: { runs: 2 }, away: { runs: 1 } } },
//   monitorState: { game_settled: 0, not_current_since: null },
//   orderbook: { best_no_ask: 12, fetched_at: new Date().toISOString() },
//   bankroll: 1000,
//   kRateThisStart: 0.18,    // ~18% K-per-BF, lowish
//   pitchCount: 80,
//   expectedBF: 24,
//   ip: 5,
// }
//
// // Case A: Tier 2 disabled (no env)
// process.env.TIER2_ENABLED = 'false'
// console.log('A:', await decideTier2(baseArgs))
// // → { fire: false, reason: 'tier2_disabled' }
//
// // Case B: dead-path detected → fire
// // gap = 7-3 = 4; bfRemaining ≈ (24/5)*4 ≈ 19; expectedKs = 19 * 0.18 ≈ 3.4
// // 3.4 < 4*0.5=2.0? No, 3.4 > 2.0 — path is alive. Drop kRate to 0.10:
// process.env.TIER2_ENABLED = 'true'
// const argsDead = { ...baseArgs, kRateThisStart: 0.08, actualKs: 3, strike: 9 }
// // gap=6; expectedKs = 19*0.08 = 1.5; 1.5 < 6*0.5=3 → DEAD
// console.log('B:', await decideTier2(argsDead))
// // → { fire: true, reason: 'tier2_dead_path_no', contracts: ..., bet_size_usd: ..., ... }
//
// // Case C: dead-path NOT detected (high K rate, gap reachable) → no fire
// const argsAlive = { ...baseArgs, kRateThisStart: 0.30, actualKs: 5, strike: 7 }
// // gap=2; expectedKs = 19*0.30 = 5.7; 5.7 > 2*0.5=1 → ALIVE
// console.log('C:', await decideTier2(argsAlive))
// // → { fire: false, reason: 'path_alive_gap_reachable' }
