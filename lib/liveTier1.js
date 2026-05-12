// lib/liveTier1.js
//
// Tier 1 = Confirmed-Pull NO. The structurally-certain live mode.
// Once a pitcher is confirmed pulled and the K count is frozen, NO contracts
// at higher strikes have only settlement risk (no in-progress correlation).
// Kalshi often still trades these markets at 5-15¢ for some seconds-to-minutes
// after a pull — that's our window.
//
// Built tonight; gated by env TIER1_ENABLED='true'. Day 4 target:
//   1. enable Tier 1 in shadow (audit log only, no real placements)
//   2. after 48hr clean shadow, enable Tier 1 with reduced caps
//   3. expand to Tier 2/3 only after Tier 1 forward-validates positive ROI
//
// This module is the DECISION layer. It does not place orders itself; it
// returns a decision object the existing executeBet() pipeline consumes.

import { STATES, isConfirmedPull } from './pitcherState.js'
import { checkFamilyLock, isDuplicateStrike } from './familyLock.js'
import { checkAllCaps } from './strategyCaps.js'
import { STRATEGY_MODES } from './strategyMode.js'

const TIER1_KELLY_FRACTION_HARD_CAP = 0.05  // never more than 5% bankroll per Tier 1 fire

/**
 * Decide whether to fire a Tier 1 confirmed-pull NO bet for a given
 * (user, pitcher, strike) under current state.
 *
 * Returns:
 *   { fire: false, reason }                          → skip
 *   { fire: true, contracts, bet_size_usd, ... }    → proceed to placement
 */
export async function decideTier1({
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
  capCheck = checkAllCaps,
}) {
  // 0. Tier 1 must be explicitly enabled
  if (String(process.env.TIER1_ENABLED ?? '').toLowerCase() !== 'true') {
    return { fire: false, reason: 'tier1_disabled' }
  }

  // 1. Confirmed-pull check (the strict version, not just state==='PITCHER_OUT')
  const pullCheck = isConfirmedPull({
    game, ourPitcherId, currentPitcherId, monitorState, actualKs,
  })
  if (!pullCheck.confirmed) {
    return { fire: false, reason: `not_confirmed_pull_${pullCheck.reason}` }
  }

  // 2. Frozen K count must be < strike for NO to win
  if (actualKs >= strike) {
    return { fire: false, reason: `k_count_${actualKs}_already_>=_strike_${strike}` }
  }

  // 3. Orderbook must have fillable NO ask
  const noAsk = orderbook?.best_no_ask
  if (noAsk == null || noAsk <= 0 || noAsk >= 100) {
    return { fire: false, reason: 'no_market_or_invalid_no_ask' }
  }

  // 4. Quote freshness (sub-30s, since we're racing market makers)
  const fetchedAt = orderbook?.fetched_at
  if (fetchedAt) {
    const ageMs = Date.now() - new Date(fetchedAt).getTime()
    if (ageMs > 30_000) return { fire: false, reason: `stale_quote_${Math.round(ageMs/1000)}s` }
  }

  // 5. Family lock check — confirmed pull unlocks the lock for additional strikes
  const lock = await checkFamilyLock({
    db, userId: bettor.id, pitcherId: pitcher.id, betDate, confirmedPull: true,
  })
  if (!lock.allowed) return { fire: false, reason: `family_lock_${lock.reason}` }
  if (isDuplicateStrike(strike, lock.active_strikes)) {
    return { fire: false, reason: `duplicate_strike_${strike}` }
  }

  // 6. Cap check
  const cap = await capCheck({
    db, userId: bettor.id, pitcherId: String(pitcher.id), betDate,
    strategy_mode: STRATEGY_MODES.LIVE,
  })
  if (!cap.allowed) return { fire: false, reason: `cap_${cap.reason}` }

  // 7. Sizing — Tier 1 uses small fixed-fraction size, never more than the cap
  // Bet $X where X = min(bankroll * TIER1_KELLY_FRACTION_HARD_CAP, MAX_LIVE_RISK_PER_PITCHER, $cap from env)
  const tier1FractionEnv = Number(process.env.TIER1_KELLY_FRACTION ?? TIER1_KELLY_FRACTION_HARD_CAP)
  const tier1Fraction = Math.min(tier1FractionEnv, TIER1_KELLY_FRACTION_HARD_CAP)
  const maxPerPitcher = Number(process.env.MAX_LIVE_RISK_PER_PITCHER ?? 75)
  const desiredUsd = Math.min(bankroll * tier1Fraction, maxPerPitcher)
  const noPriceFrac = noAsk / 100
  const contracts = Math.max(1, Math.floor(desiredUsd / noPriceFrac))
  const betSizeUsd = Math.round(contracts * noPriceFrac * 100) / 100

  if (betSizeUsd < 0.5) {
    return { fire: false, reason: `bet_size_below_floor_$${betSizeUsd.toFixed(2)}` }
  }

  return {
    fire: true,
    reason: 'tier1_confirmed_pull_no',
    strategy_mode: STRATEGY_MODES.LIVE,
    strategy_submode: 'live_tier1_confirmed_pull',
    contracts,
    bet_size_usd: betSizeUsd,
    no_price_cents: noAsk,
    pull_detail: pullCheck.detail,
  }
}
