// lib/betLock.js — DB-level mutex preventing duplicate bets.
//
// Problem: Railway and The Closer can both monitor the same game simultaneously.
// Without a lock, the same threshold crossing fires a bet from both processes,
// resulting in double-long positions on Kalshi (+$100 exposure on a $50 bet).
//
// Solution: INSERT OR IGNORE on bet_placement_locks table. First writer wins.
// SQLite/Turso serializes writes — INSERT OR IGNORE is atomic.
//
// Lock lifecycle:
//   acquireBetLock()   → attempt INSERT; returns true if acquired, false if lost
//   confirmBetPlaced() → set bet_id on the lock once order is filled/resting
//   releaseBetLock()   → DELETE the lock (on cancel or failed order)
//   cleanStaleLocks()  → remove locks older than 5 min with no bet_id (stale/crashed)
//
// lock_key format: '{gamePk}-{pitcherId}-{threshold}-{side}'
// holder: process identifier ('railway' | 'closer' | hostname)

import * as db from './db.js'
import os from 'node:os'

const HOLDER = process.env.LOCK_HOLDER ?? (
  process.env.RAILWAY_ENVIRONMENT ? 'railway' :
  os.hostname().toLowerCase().includes('windows') ? 'closer' : 'local'
)
const LOCK_TTL_MS = 5 * 60 * 1000  // 5 minutes

export function makeLockKey(gamePk, pitcherId, threshold, side = 'YES', userId = null) {
  return userId != null
    ? `u${userId}-${gamePk}-${pitcherId}-${threshold}-${side}`
    : `${gamePk}-${pitcherId}-${threshold}-${side}`
}

// Returns true if this process acquired the lock, false if another process already holds it.
export async function acquireBetLock(gamePk, pitcherId, threshold, side = 'YES', userId = null) {
  const key = makeLockKey(gamePk, pitcherId, threshold, side, userId)
  await cleanStaleLocks()  // clean expired locks before attempting acquire

  try {
    const result = await db.run(
      `INSERT OR IGNORE INTO bet_placement_locks (lock_key, holder, locked_at) VALUES (?,?,?)`,
      [key, HOLDER, Date.now()],
    )
    const acquired = (result?.rowsAffected ?? result?.changes ?? 0) > 0
    if (!acquired) {
      // Log who holds the lock
      const holder = await db.one(
        `SELECT holder, locked_at FROM bet_placement_locks WHERE lock_key=?`,
        [key],
      ).catch(() => null)
      const ageSec = holder ? ((Date.now() - (holder.locked_at ?? 0)) / 1000).toFixed(0) : '?'
      console.log(`[betLock] BLOCKED ${key} — held by ${holder?.holder ?? '?'} for ${ageSec}s`)
    }
    return acquired
  } catch (err) {
    console.error(`[betLock] acquireBetLock error: ${err.message}`)
    return true  // on DB error, allow the bet (fail open rather than block all trading)
  }
}

// Call after order is confirmed placed — sets bet_id so the lock is not swept by cleanStaleLocks
export async function confirmBetPlaced(gamePk, pitcherId, threshold, side, betId, userId = null) {
  const key = makeLockKey(gamePk, pitcherId, threshold, side, userId)
  await db.run(
    `UPDATE bet_placement_locks SET bet_id=? WHERE lock_key=? AND holder=?`,
    [betId, key, HOLDER],
  ).catch(() => {})
}

// Release the lock — call on failed order or cancelled bet
export async function releaseBetLock(gamePk, pitcherId, threshold, side = 'YES', userId = null) {
  const key = makeLockKey(gamePk, pitcherId, threshold, side, userId)
  await db.run(
    `DELETE FROM bet_placement_locks WHERE lock_key=? AND holder=?`,
    [key, HOLDER],
  ).catch(() => {})
}

// Remove locks older than TTL with no bet_id (process crashed before confirming)
export async function cleanStaleLocks() {
  const cutoff = Date.now() - LOCK_TTL_MS
  try {
    const result = await db.run(
      `DELETE FROM bet_placement_locks WHERE locked_at < ? AND bet_id IS NULL`,
      [cutoff],
    )
    const cleaned = result?.rowsAffected ?? result?.changes ?? 0
    if (cleaned > 0) {
      console.log(`[betLock] Cleaned ${cleaned} stale lock(s) older than 5min`)
    }
  } catch {}
}

// Check if a lock exists (for testing/debugging)
export async function isLocked(gamePk, pitcherId, threshold, side = 'YES') {
  const key = makeLockKey(gamePk, pitcherId, threshold, side)
  const row = await db.one(`SELECT holder, locked_at, bet_id FROM bet_placement_locks WHERE lock_key=?`, [key])
    .catch(() => null)
  return row ?? null
}
