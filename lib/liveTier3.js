// lib/liveTier3.js
//
// Tier 3 = Late-Game Leash NO. The medium-confidence live mode.
//
// Setup: pitcher is in 7th+ inning with a small number of BF remaining
// (≤6 typical) and an unmet K threshold. Manager has a leash. If the
// pitcher exits at 90-100 pitches having only thrown ~5-6 more BF, NO at
// the higher strikes wins by default.
//
// Math intuition (kGap = 1 case):
//   P(at least 1 K in 5 BF at 20% K-rate) = 1 - 0.8^5 = 0.67
//   → NO win prob ≈ 0.33; only profitable if NO ask is cheap relative to that.
// At kGap = 2 the math gets steeply more favorable to NO.
//
// Why Tier 3 sizes smallest of the live ladder:
//   - K-rate-this-start is a noisy estimator (small in-game sample).
//   - Leash timing has variance — a manager can stretch a starter another
//     2 BF beyond expectation, flipping a winning bet into a loser.
//   - Market may already have priced in the leash signal; we have less edge
//     than Tier 1 (structural certainty) or Tier 2 (math infeasibility).
//
// Family lock: confirmedPull is FALSE for Tier 3 (still in game). This
// prevents stacking with Tier 1/Tier 2 fires on the same pitcher pre-pull.
//
// Tier 3 is gated by env TIER3_ENABLED='true'. Default OFF.
// This module is the DECISION layer — it returns a decision object the
// existing executeBet() pipeline consumes; it does not place orders itself.

import { STATES, classifyPitcherState, isDeadPath, estimateBfRemaining } from './pitcherState.js'
import { checkFamilyLock, isDuplicateStrike } from './familyLock.js'
import { checkAllCaps } from './strategyCaps.js'
import { STRATEGY_MODES } from './strategyMode.js'

const TIER3_KELLY_FRACTION_HARD_CAP = 0.02  // never more than 2% bankroll per Tier 3 fire
const TIER3_DEFAULT_MAX_BF_REMAINING = 6
const TIER3_DEFAULT_MIN_PITCH_COUNT = 80
const TIER3_DEFAULT_MAX_PER_PITCHER = 20    // $20 default cap per pitcher
const TIER3_NO_ASK_FLOOR_CENTS = 30
const TIER3_NO_ASK_CEIL_CENTS = 95
const TIER3_P_YES_MIN = 0.10                // below: free money, market already agrees
const TIER3_P_YES_MAX = 0.45                // above: market right, no edge

/**
 * Estimate P(YES wins) — i.e. P(pitcher reaches strike from current state).
 *
 * For kGap = 1: closed form 1 - (1-p)^bf
 * For kGap >= 2: simple binomial CDF approximation P(X >= kGap | n=bf, p=kRate)
 *
 * Returns a number in [0,1] or null if inputs invalid.
 */
function estimatePYes({ kGap, bfRemaining, kRate }) {
  if (!Number.isFinite(kGap) || !Number.isFinite(bfRemaining) || !Number.isFinite(kRate)) return null
  if (kGap <= 0) return 1.0
  if (bfRemaining <= 0) return 0.0
  if (kRate <= 0) return 0.0
  if (kRate >= 1) return 1.0
  if (bfRemaining < kGap) return 0.0  // can't get kGap Ks in fewer than kGap BF

  if (kGap === 1) {
    return 1 - Math.pow(1 - kRate, bfRemaining)
  }

  // Binomial: P(X >= kGap) = sum_{k=kGap..n} C(n,k) p^k (1-p)^(n-k)
  const n = Math.floor(bfRemaining)
  let pAtLeast = 0
  // C(n,k) iteratively to avoid factorial overflow
  let logFactN = 0
  for (let i = 1; i <= n; i++) logFactN += Math.log(i)

  function logComb(nn, kk) {
    let lf = 0
    for (let i = 1; i <= kk; i++) lf += Math.log(nn - i + 1) - Math.log(i)
    return lf
  }

  for (let k = Math.floor(kGap); k <= n; k++) {
    const lp = logComb(n, k) + k * Math.log(kRate) + (n - k) * Math.log(1 - kRate)
    pAtLeast += Math.exp(lp)
  }
  return Math.max(0, Math.min(1, pAtLeast))
}

/**
 * Decide whether to fire a Tier 3 late-game-leash NO bet for a given
 * (user, pitcher, strike) under current state.
 *
 * Returns:
 *   { fire: false, reason }                          → skip
 *   { fire: true, contracts, bet_size_usd, ... }    → proceed to placement
 */
export async function decideTier3({
  db,
  bettor,            // { id, name, kalshi_balance, ... }
  pitcher,           // { id, name }
  strike,
  ourPitcherId,
  game,              // MLB feed game obj
  ls,                // linescore
  monitorState,      // { not_current_since, game_settled, ... }
  currentPitcherId,
  actualKs,
  betDate,
  orderbook,         // { best_yes_bid, best_no_ask, fetched_at, ... }
  bankroll,          // user's available bankroll for this strategy
  kRateThisStart,    // observed K-rate for this start (Ks / BF so far)
  pitchCount,        // pitches thrown by ourPitcherId
  expectedBF,        // pre-game expected BF for this pitcher
  ip,                // innings pitched so far (number, e.g. 6.2 → 6.67)
  capCheck = checkAllCaps,
}) {
  // 0. Tier 3 must be explicitly enabled
  if (String(process.env.TIER3_ENABLED ?? '').toLowerCase() !== 'true') {
    return { fire: false, reason: 'tier3_disabled' }
  }

  // 1. State must be LATE_GAME specifically (not MID, not PITCHER_OUT, not UNKNOWN)
  const stateRes = classifyPitcherState({
    game, ls, ourPitcherId, currentPitcherId, pitchCount, monitorState,
  })
  if (stateRes.state !== STATES.LATE_GAME) {
    return { fire: false, reason: `state_${stateRes.state}_not_late_game` }
  }

  // 2. K count must be < strike for NO to win
  if (actualKs == null || !Number.isFinite(actualKs)) {
    return { fire: false, reason: 'k_count_unknown' }
  }
  if (actualKs >= strike) {
    return { fire: false, reason: `k_count_${actualKs}_already_>=_strike_${strike}` }
  }
  const kGap = strike - actualKs

  // 3. K-rate must be a valid number (we use it to estimate p_yes and dead-path)
  if (!Number.isFinite(kRateThisStart) || kRateThisStart < 0 || kRateThisStart > 1) {
    return { fire: false, reason: 'k_rate_invalid' }
  }

  // 4. BF remaining must be small (configurable)
  const bfRemaining = estimateBfRemaining({
    pitchCount,
    expectedTotalPitches: Number(process.env.TIER3_EXPECTED_TOTAL_PITCHES ?? 100),
    avgPitchesPerBF: Number(process.env.TIER3_AVG_PITCHES_PER_BF ?? 4),
    ip,
    expectedBF,
  })
  if (bfRemaining == null) {
    return { fire: false, reason: 'bf_remaining_unknown' }
  }
  const maxBfRemaining = Number(process.env.TIER3_MAX_BF_REMAINING ?? TIER3_DEFAULT_MAX_BF_REMAINING)
  if (bfRemaining > maxBfRemaining) {
    return { fire: false, reason: `bf_remaining_${bfRemaining}_>_${maxBfRemaining}` }
  }
  if (bfRemaining <= 0) {
    // Effectively done — should be Tier 2 / dead path territory
    return { fire: false, reason: 'bf_remaining_zero' }
  }

  // 5. Not a dead path (that's Tier 2's territory)
  const dead = isDeadPath({ kCount: actualKs, strike, bfRemaining, kRateThisStart })
  if (dead.dead) {
    return { fire: false, reason: `dead_path_${dead.reason}_use_tier2` }
  }

  // 6. Pitch count threshold — leash imminent
  const minPitchCount = Number(process.env.TIER3_MIN_PITCH_COUNT ?? TIER3_DEFAULT_MIN_PITCH_COUNT)
  if (!Number.isFinite(pitchCount)) {
    return { fire: false, reason: 'pitch_count_unknown' }
  }
  if (pitchCount < minPitchCount) {
    return { fire: false, reason: `pitch_count_${pitchCount}_<_${minPitchCount}_premature` }
  }

  // 7. Conditional probability check — we want p_yes in the sweet spot
  const pYes = estimatePYes({ kGap, bfRemaining, kRate: kRateThisStart })
  if (pYes == null) {
    return { fire: false, reason: 'p_yes_estimate_failed' }
  }
  if (pYes > TIER3_P_YES_MAX) {
    return { fire: false, reason: `p_yes_${pYes.toFixed(3)}_>_${TIER3_P_YES_MAX}_no_edge` }
  }
  if (pYes < TIER3_P_YES_MIN) {
    return { fire: false, reason: `p_yes_${pYes.toFixed(3)}_<_${TIER3_P_YES_MIN}_use_tier2` }
  }

  // 8. Orderbook check — best_no_ask in usable range
  const noAsk = orderbook?.best_no_ask
  if (noAsk == null || !Number.isFinite(noAsk) || noAsk <= 0 || noAsk >= 100) {
    return { fire: false, reason: 'no_market_or_invalid_no_ask' }
  }
  if (noAsk < TIER3_NO_ASK_FLOOR_CENTS) {
    return { fire: false, reason: `no_ask_${noAsk}c_<_${TIER3_NO_ASK_FLOOR_CENTS}c_market_agrees` }
  }
  if (noAsk > TIER3_NO_ASK_CEIL_CENTS) {
    return { fire: false, reason: `no_ask_${noAsk}c_>_${TIER3_NO_ASK_CEIL_CENTS}c_too_expensive` }
  }

  // 9. Quote freshness < 30s
  const fetchedAt = orderbook?.fetched_at
  if (fetchedAt) {
    const ageMs = Date.now() - new Date(fetchedAt).getTime()
    if (ageMs > 30_000) {
      return { fire: false, reason: `stale_quote_${Math.round(ageMs / 1000)}s` }
    }
  }

  // 10. Family lock — confirmedPull is FALSE; Tier 3 fires while pitcher still in
  const lock = await checkFamilyLock({
    db, userId: bettor.id, pitcherId: pitcher.id, betDate, confirmedPull: false,
  })
  if (!lock.allowed) return { fire: false, reason: `family_lock_${lock.reason}` }
  if (isDuplicateStrike(strike, lock.active_strikes)) {
    return { fire: false, reason: `duplicate_strike_${strike}` }
  }

  // 11. Cap check
  const cap = await capCheck({
    db, userId: bettor.id, pitcherId: String(pitcher.id), betDate,
    strategy_mode: STRATEGY_MODES.LIVE,
  })
  if (!cap.allowed) return { fire: false, reason: `cap_${cap.reason}` }

  // 12. Sizing — Tier 3 uses the smallest fraction of the live ladder
  const tier3FractionEnv = Number(process.env.TIER3_KELLY_FRACTION ?? TIER3_KELLY_FRACTION_HARD_CAP)
  const tier3Fraction = Math.min(tier3FractionEnv, TIER3_KELLY_FRACTION_HARD_CAP)
  const maxPerPitcher = Number(process.env.TIER3_MAX_RISK_PER_PITCHER ?? TIER3_DEFAULT_MAX_PER_PITCHER)
  if (!Number.isFinite(bankroll) || bankroll <= 0) {
    return { fire: false, reason: 'bankroll_invalid' }
  }
  const desiredUsd = Math.min(bankroll * tier3Fraction, maxPerPitcher)
  const noPriceFrac = noAsk / 100
  const contracts = Math.max(1, Math.floor(desiredUsd / noPriceFrac))
  const betSizeUsd = Math.round(contracts * noPriceFrac * 100) / 100

  if (betSizeUsd < 0.5) {
    return { fire: false, reason: `bet_size_below_floor_$${betSizeUsd.toFixed(2)}` }
  }

  return {
    fire: true,
    reason: 'tier3_late_game_leash_no',
    strategy_mode: STRATEGY_MODES.LIVE,
    strategy_submode: 'live_tier3_late_game_leash',
    contracts,
    bet_size_usd: betSizeUsd,
    no_price_cents: noAsk,
    leash_detail: {
      bfRemaining,
      kGap,
      pitchCount,
      p_yes_estimate: Math.round(pYes * 1000) / 1000,
    },
  }
}

// ---------------------------------------------------------------------------
// Smoke test (run manually: `node lib/liveTier3.js`)
// ---------------------------------------------------------------------------
//
// import assert from 'node:assert/strict'
//
// const fakeDb = { /* not actually called when family lock & caps mocked */ }
// const fakeAllow = async () => ({ allowed: true })
// // Mock family lock by overriding via DI not supported — for full smoke,
// // stub at module level. Quick path tests below exercise early-return branches.
//
// async function smoke() {
//   // 1. tier3_disabled when env unset
//   delete process.env.TIER3_ENABLED
//   let r = await decideTier3({})
//   assert.equal(r.fire, false)
//   assert.equal(r.reason, 'tier3_disabled')
//
//   process.env.TIER3_ENABLED = 'true'
//
//   // 2. state must be LATE_GAME — MID_GAME should skip
//   r = await decideTier3({
//     db: fakeDb, bettor: { id: 1 }, pitcher: { id: 100 }, strike: 6,
//     ourPitcherId: 100, currentPitcherId: 100,
//     game: { abstractGameState: 'Live' },
//     ls: { currentInning: 5, teams: { home: { runs: 2 }, away: { runs: 1 } } },
//     actualKs: 4, betDate: '2026-05-01', orderbook: { best_no_ask: 60 },
//     bankroll: 1000, kRateThisStart: 0.25, pitchCount: 85, expectedBF: 24, ip: 5,
//   })
//   assert.equal(r.fire, false)
//   assert.ok(r.reason.startsWith('state_MID_GAME'))
//
//   // 3. dead path → routes to Tier 2
//   //   kGap=3 in bfRemaining=2 at 20% rate → expectedKs=0.4 vs 1.5 floor → dead
//   r = await decideTier3({
//     db: fakeDb, bettor: { id: 1 }, pitcher: { id: 100 }, strike: 7,
//     ourPitcherId: 100, currentPitcherId: 100,
//     game: { abstractGameState: 'Live' },
//     ls: { currentInning: 8, teams: { home: { runs: 1 }, away: { runs: 0 } } },
//     actualKs: 4, betDate: '2026-05-01', orderbook: { best_no_ask: 80 },
//     bankroll: 1000, kRateThisStart: 0.20, pitchCount: 95, expectedBF: 24, ip: 7,
//   })
//   assert.equal(r.fire, false)
//   assert.ok(r.reason.startsWith('dead_path_') || r.reason.startsWith('bf_remaining_'),
//     `expected dead_path or bf_remaining, got ${r.reason}`)
//
//   // 4. premature pitch count
//   r = await decideTier3({
//     db: fakeDb, bettor: { id: 1 }, pitcher: { id: 100 }, strike: 6,
//     ourPitcherId: 100, currentPitcherId: 100,
//     game: { abstractGameState: 'Live' },
//     ls: { currentInning: 7, teams: { home: { runs: 1 }, away: { runs: 0 } } },
//     actualKs: 5, betDate: '2026-05-01', orderbook: { best_no_ask: 60 },
//     bankroll: 1000, kRateThisStart: 0.22, pitchCount: 70, expectedBF: 24, ip: 6.2,
//   })
//   assert.equal(r.fire, false)
//   assert.ok(r.reason.includes('premature') || r.reason.startsWith('bf_remaining_'),
//     `expected premature/bf_remaining, got ${r.reason}`)
//
//   // 5. viable late-game leash — would fire if family lock & caps mocked.
//   //    With real helpers it depends on db; skip the assertion or DI capCheck.
//   r = await decideTier3({
//     db: fakeDb, bettor: { id: 1 }, pitcher: { id: 100 }, strike: 6,
//     ourPitcherId: 100, currentPitcherId: 100,
//     game: { abstractGameState: 'Live' },
//     ls: { currentInning: 7, teams: { home: { runs: 1 }, away: { runs: 0 } } },
//     monitorState: {},
//     actualKs: 5, betDate: '2026-05-01',
//     orderbook: { best_no_ask: 65, fetched_at: new Date().toISOString() },
//     bankroll: 1000, kRateThisStart: 0.20, pitchCount: 90, expectedBF: 24, ip: 7,
//     capCheck: fakeAllow,
//   })
//   // family lock would call db.query — in real run replace with stub.
//   console.log('smoke 5 result:', r)
//
//   console.log('Tier 3 smoke OK')
// }
// smoke().catch((e) => { console.error(e); process.exit(1) })
