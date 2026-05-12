// lib/pitcherState.js
//
// Canonical pitcher state classifier for live trading. Maps the chaotic mess
// of MLB feed signals + monitor_state row + Kalshi price into ONE explicit
// state machine the live engine can dispatch on.
//
// States (in roughly chronological order):
//   PRE_GAME      — game not started; pre-game logic applies
//   EARLY_GAME    — innings 1–3, K-count signal weak, leash unclear
//   MID_GAME      — innings 4–6, K-count visible, leash 70–85 pitches
//   LATE_GAME     — 7+ innings, leash imminent, BF remaining ≤ 6–9
//   PITCHER_OUT   — confirmed pull, K count FROZEN, market still trading
//   GAME_FINAL    — settled, no more market action
//   UNKNOWN       — feed inconsistent / cannot classify
//
// The classifier is INTENTIONALLY conservative: when in doubt, return UNKNOWN
// and let the caller refuse to fire. False UNKNOWN costs us a missed bet;
// false confidence in a wrong state costs real money.

export const STATES = Object.freeze({
  PRE_GAME:    'PRE_GAME',
  EARLY_GAME:  'EARLY_GAME',
  MID_GAME:    'MID_GAME',
  LATE_GAME:   'LATE_GAME',
  PITCHER_OUT: 'PITCHER_OUT',
  GAME_FINAL:  'GAME_FINAL',
  UNKNOWN:     'UNKNOWN',
})

/**
 * Pure classifier — given snapshots, return state + diagnostic detail.
 *
 * Required inputs:
 *   game.abstractGameState : 'Preview' | 'Live' | 'Final'
 *   ls.currentInning       : 0|null|number  (null pre-game, 0 = warmup, 1+ live)
 *   ls.teams.home/away.runs : number|null    (null if feed broken)
 *
 * Strongly-recommended inputs (improve accuracy):
 *   currentPitcherId       : the pitcher actively on the mound right now
 *   ourPitcherId           : the pitcher we're betting on
 *   pitchCount             : number of pitches thrown by ourPitcherId so far
 *   monitor_state          : { game_settled, not_current_since } row for this game
 *
 * Returns:
 *   { state, reason, detail }
 *     state:  one of STATES
 *     reason: human-readable why-this-state string
 *     detail: { inning, pitcher_active, pitch_count, ... } passthrough for logging
 */
export function classifyPitcherState({
  game,
  ls,
  ourPitcherId,
  currentPitcherId,
  pitchCount,
  monitorState,
}) {
  const detail = {
    inning:           ls?.currentInning ?? null,
    abstract:         game?.abstractGameState ?? null,
    pitcher_active:   currentPitcherId ?? null,
    pitch_count:      pitchCount ?? null,
    monitor_settled:  monitorState?.game_settled ?? null,
  }

  // Catastrophic missing inputs → UNKNOWN
  if (!game || !ls) {
    return { state: STATES.UNKNOWN, reason: 'missing game or linescore', detail }
  }

  // Feed says final, or monitor says settled
  if (game.abstractGameState === 'Final' || monitorState?.game_settled === 1) {
    return { state: STATES.GAME_FINAL, reason: 'feed_or_monitor_final', detail }
  }

  // Feed says preview = pre-game
  if (game.abstractGameState === 'Preview') {
    return { state: STATES.PRE_GAME, reason: 'feed_preview', detail }
  }

  // Now in 'Live' phase
  // Confirmed pull: someone else is on the mound
  if (currentPitcherId && ourPitcherId && String(currentPitcherId) !== String(ourPitcherId)) {
    return {
      state: STATES.PITCHER_OUT,
      reason: 'pitcher_change_confirmed',
      detail: { ...detail, replaced_by: currentPitcherId },
    }
  }

  // Score state required for any "in-progress" classification
  const homeRuns = ls?.teams?.home?.runs
  const awayRuns = ls?.teams?.away?.runs
  if (homeRuns == null || awayRuns == null) {
    return { state: STATES.UNKNOWN, reason: 'missing_score_state', detail }
  }

  const inning = Number(ls.currentInning ?? 0)
  if (inning <= 0) {
    return { state: STATES.PRE_GAME, reason: 'inning_zero_or_warmup', detail }
  }
  if (inning <= 3) {
    return { state: STATES.EARLY_GAME, reason: `inning_${inning}`, detail }
  }
  if (inning <= 6) {
    return { state: STATES.MID_GAME, reason: `inning_${inning}`, detail }
  }
  return { state: STATES.LATE_GAME, reason: `inning_${inning}`, detail }
}

/**
 * Confirmed-pull check that's stricter than mere state==='PITCHER_OUT'. Used
 * by Tier 1 to ensure we have all the evidence we need before betting NO at
 * a frozen K count.
 *
 * Returns: { confirmed: bool, reason }
 *
 * Requires ALL of:
 *   - currentPitcherId differs from ourPitcherId
 *   - monitor_state.not_current_since is set AND > 30s ago (not a transient feed hiccup)
 *   - actual_ks for ourPitcher is recorded (we know the frozen K count)
 *   - game still 'Live' (not 'Final', because then market settles instead of trading)
 */
export function isConfirmedPull({
  game,
  ourPitcherId,
  currentPitcherId,
  monitorState,
  actualKs,
}) {
  if (!game || game.abstractGameState !== 'Live') {
    return { confirmed: false, reason: 'not_in_live_phase' }
  }
  if (!currentPitcherId || !ourPitcherId) {
    return { confirmed: false, reason: 'missing_pitcher_ids' }
  }
  if (String(currentPitcherId) === String(ourPitcherId)) {
    return { confirmed: false, reason: 'our_pitcher_still_in' }
  }
  const notCurrentSince = monitorState?.not_current_since
  if (!notCurrentSince) {
    return { confirmed: false, reason: 'not_current_since_unset' }
  }
  const sinceMs = Date.now() - new Date(notCurrentSince).getTime()
  if (sinceMs < 30_000) {
    return { confirmed: false, reason: `pull_too_recent_${Math.round(sinceMs / 1000)}s` }
  }
  if (actualKs == null || !Number.isFinite(actualKs)) {
    return { confirmed: false, reason: 'k_count_not_recorded' }
  }
  return {
    confirmed: true,
    reason: 'confirmed_pull',
    detail: {
      replaced_by: currentPitcherId,
      since_seconds: Math.round(sinceMs / 1000),
      frozen_ks: actualKs,
    },
  }
}

/**
 * Compute remaining BF (batters faced) capacity for an in-progress start.
 * Used by Tier 2 (dead-path) to decide if K threshold is mathematically
 * unreachable in the BF the pitcher likely has left.
 *
 * Returns null when inputs insufficient. Caller should refuse to bet on null.
 */
export function estimateBfRemaining({ pitchCount, expectedTotalPitches, avgPitchesPerBF, ip, expectedBF }) {
  if (Number.isFinite(pitchCount) && Number.isFinite(expectedTotalPitches) && Number.isFinite(avgPitchesPerBF) && avgPitchesPerBF > 0) {
    const pitchesLeft = Math.max(0, expectedTotalPitches - pitchCount)
    return Math.max(0, Math.round(pitchesLeft / avgPitchesPerBF))
  }
  if (Number.isFinite(ip) && Number.isFinite(expectedBF)) {
    const bfPerInning = expectedBF / Math.max(1, ip)
    const inningsLeft = Math.max(0, 9 - ip)  // approximate leash
    return Math.max(0, Math.round(bfPerInning * inningsLeft))
  }
  return null
}

/**
 * Determine if the K threshold is mathematically dead given BF remaining and
 * realistic per-BF strikeout probability.
 *
 * Returns { dead: bool, reason, p_yes_estimate }
 */
export function isDeadPath({ kCount, strike, bfRemaining, kRateThisStart }) {
  if (kCount == null || strike == null || bfRemaining == null || !Number.isFinite(kRateThisStart)) {
    return { dead: false, reason: 'insufficient_inputs' }
  }
  const kGap = strike - kCount
  if (kGap <= 0) {
    return { dead: false, reason: 'threshold_already_hit', p_yes_estimate: 1.0 }
  }
  // Rough binomial: probability of getting kGap+ more Ks in bfRemaining BF at kRate
  // Use Bonferroni-ish approximation: requires gap K's in bfRemaining trials.
  // P(X >= kGap) ≈ 1 - P(X < kGap) — for sanity check only, not precise.
  const expectedKs = bfRemaining * kRateThisStart
  if (expectedKs < kGap * 0.5) {
    return { dead: true, reason: `gap_${kGap}_vs_expected_${expectedKs.toFixed(1)}_in_${bfRemaining}bf`, p_yes_estimate: 0.05 }
  }
  return { dead: false, reason: 'gap_reachable', p_yes_estimate: null }
}
