// lib/strategyMode.js
//
// Strategy mode enum + validator. Every ks_bets and oracle_bet_traces row
// must have a valid strategy_mode set. Unknown values are rejected at insert
// time and trigger a global halt (the trace watchdog catches missing rows).
//
// strategy_submode is optional, free-form, logged but not validated.
// Submodes are used to track sub-categories within 'live' (e.g. 'live_dead_path',
// 'live_pull_hedge') without bloating the enum or breaking forward compat.

export const STRATEGY_MODES = Object.freeze({
  PREGAME_NORMAL:       'pregame_normal',
  PREGAME_INVERSION:    'pregame_inversion',
  PREGAME_CROSS_STRIKE: 'pregame_cross_strike',  // Strategy B (math-based mispricing) — added 2026-05-06
  PREGAME_FADE_YES:     'pregame_fade_yes',      // Ideal model — NB r=8, K9_l5, strike≥6, per_pitcher_cap=1, edge-weighted sizing
  LIVE:                 'live',
  TOPUP:                'topup',
})

const VALID_MODES = new Set(Object.values(STRATEGY_MODES))

export function isValidStrategyMode(mode) {
  return typeof mode === 'string' && VALID_MODES.has(mode)
}

/**
 * Throws if mode is null, undefined, empty string, or not in the enum.
 * Use at every ks_bets / oracle_bet_traces insert site.
 */
export function validateStrategyMode(mode, context = '') {
  if (mode == null || mode === '') {
    throw new Error(`strategy_mode required${context ? ` (${context})` : ''}; got ${JSON.stringify(mode)}`)
  }
  if (!VALID_MODES.has(mode)) {
    throw new Error(`unknown strategy_mode "${mode}"${context ? ` (${context})` : ''}; valid: ${[...VALID_MODES].join('|')}`)
  }
  return mode
}

/**
 * Map an existing bet_mode string (the legacy unvalidated column) to a
 * strategy_submode. Used during liveMonitor placements where bet_mode is set
 * to one of: pulled, crossed-yes, blowout, dead-path, stack-yes, pull-hedge,
 * late-inning-no, high-conviction, early-blowout. All become live_* submodes.
 */
export function liveBetModeToSubmode(betMode) {
  if (!betMode) return 'live_unknown'
  const m = String(betMode).toLowerCase().replace(/-/g, '_')
  return `live_${m}`
}

/**
 * Inverse: given a strategy_submode like 'topup_pregame_inversion', return the
 * parent strategy_mode. Used by cap-check logic to determine which bucket a
 * topup row counts against.
 */
export function parentModeFromSubmode(submode) {
  if (!submode) return null
  if (submode.startsWith('topup_')) {
    const parent = submode.slice('topup_'.length)
    return isValidStrategyMode(parent) ? parent : null
  }
  if (submode.startsWith('live_')) return STRATEGY_MODES.LIVE
  return null
}
