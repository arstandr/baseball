// lib/familyLock.js
//
// Per-(user, pitcher) lock for live K-family NO positions. Prevents
// stacking multiple NO bets on K6/K7/K8 same pitcher pre-pull, which look
// like 4 independent bets but are 1 correlated position.
//
// Rules:
//   - Default: at most ONE active live NO position per (user_id, pitcher_id).
//     Active = order_status='filled' AND result IS NULL AND live_bet=1.
//   - On confirmed pull (PITCHER_OUT state): unlock. Higher-strike NO bets
//     allowed up to per-pitcher total cap because K count is now frozen and
//     additional strike-level bets carry only settlement risk, not
//     mid-start correlation risk.
//
// Lock state is computed fresh from the DB on each check — no in-memory
// state, no stale flag risk.

const ACTIVE_STATUSES = ['filled', 'partial']

/**
 * Check if a new live NO bet is allowed under the family lock.
 *
 * @param {object} args
 * @param {object} args.db          — lib/db.js module
 * @param {number|string} args.userId
 * @param {number|string} args.pitcherId
 * @param {string} args.betDate     — 'YYYY-MM-DD' (ET)
 * @param {boolean} args.confirmedPull — true if pitcher is PITCHER_OUT state
 *
 * @returns {Promise<{ allowed: boolean, reason: string, active_count: number, active_strikes: number[] }>}
 */
export async function checkFamilyLock({ db, userId, pitcherId, betDate, confirmedPull = false }) {
  if (!userId || !pitcherId || !betDate) {
    return { allowed: false, reason: 'family_lock_missing_inputs', active_count: 0, active_strikes: [] }
  }

  // Pull active live NO positions for this user × pitcher today
  const rows = await db.all(
    `SELECT id, strike, side, order_status, result, capital_at_risk
     FROM ks_bets
     WHERE bet_date = ? AND user_id = ? AND pitcher_id = ?
       AND live_bet = 1
       AND side = 'NO'
       AND result IS NULL
       AND COALESCE(order_status,'') IN ('filled','partial')`,
    [betDate, String(userId), String(pitcherId)],
  ).catch(() => [])

  const activeStrikes = rows.map(r => Number(r.strike)).sort((a, b) => a - b)
  const activeCount = rows.length

  if (activeCount === 0) {
    return { allowed: true, reason: 'no_active_positions', active_count: 0, active_strikes: [] }
  }

  if (!confirmedPull) {
    return {
      allowed: false,
      reason: `family_lock_held_${activeCount}_positions_strikes_${activeStrikes.join('_')}`,
      active_count: activeCount,
      active_strikes: activeStrikes,
    }
  }

  // Confirmed pull — allow more, but require monotonic strike increase to avoid
  // duplicate / lower-strike re-entry against frozen K count.
  return {
    allowed: true,
    reason: `confirmed_pull_unlock_existing_strikes_${activeStrikes.join('_')}`,
    active_count: activeCount,
    active_strikes: activeStrikes,
  }
}

/**
 * Given an attempted strike and the active strikes already held, decide if
 * this is a duplicate (same strike already held) or an addition.
 *
 * Used inside the Tier 1 fire path after confirmedPull unlocks the lock.
 */
export function isDuplicateStrike(attemptedStrike, activeStrikes) {
  if (!Array.isArray(activeStrikes)) return false
  return activeStrikes.includes(Number(attemptedStrike))
}
