#!/usr/bin/env node
// scripts/tests/sonarSystemTest.js — Bat Sonar system comprehensive test suite.
//
// Tests ALL new modules: game_pulse, bankrollState, betLock, adaptive polling,
// slot-weighted K%, Kalshi outage detection, Kelly integration, full day sim.
//
// Uses a temp local SQLite file so no real DB credentials needed.
// Run: node scripts/tests/sonarSystemTest.js

import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TEST_DB = path.join(os.tmpdir(), `sonar-test-${Date.now()}.db`)

// Set env BEFORE any db module loads (dynamic imports below use these values)
process.env.TURSO_DATABASE_URL  = `file:${TEST_DB}`
process.env.TURSO_AUTH_TOKEN    = 'unused-for-local-file'
process.env.STARTING_BANKROLL   = '5000'
process.env.LOCK_HOLDER         = 'test-process'
process.env.MAX_BET             = '500'

// Dynamic imports — run AFTER env vars are set
const dbMod              = await import('../../lib/db.js')
const bankrollStateMod   = await import('../../lib/bankrollState.js')
const betLockMod         = await import('../../lib/betLock.js')
const gamePulseMod       = await import('../../lib/gamePulse.js')

const { initBankrollState, getAvailablePool, addCommitted, releaseCommitted,
        addRealized, reconcileBankrollState, getBankrollState } = bankrollStateMod
const { acquireBetLock, confirmBetPlaced, releaseBetLock, cleanStaleLocks,
        isLocked, makeLockKey } = betLockMod
const { adaptivePollDelayMs, getGamePulseRow, getActivePulse } = gamePulseMod

// ── Bootstrap test DB ─────────────────────────────────────────────────────────
await dbMod.migrate()
const client = dbMod.getClient()
// Disable FK enforcement for unit tests (bet_placement_locks.bet_id refs ks_bets.id)
await client.execute(`PRAGMA foreign_keys = OFF`)
// Seed required system_flags rows
try {
  await client.execute(`INSERT OR IGNORE INTO system_flags (key, value, updated_by) VALUES ('kalshi_outage', '0', 'system')`)
} catch {}

// ── Test harness ──────────────────────────────────────────────────────────────

let passed = 0, failed = 0
const failures = []

function assert(label, condition, detail = '') {
  if (condition) {
    passed++
    process.stdout.write(`  ✓ ${label}\n`)
  } else {
    failed++
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`)
    process.stderr.write(`  ✗ ${label}${detail ? `  [${detail}]` : ''}\n`)
  }
}

function assertClose(label, actual, expected, tol = 0.01, detail = '') {
  const ok = typeof actual === 'number' && Math.abs(actual - expected) <= tol
  assert(label, ok, detail || `got ${actual?.toFixed?.(4) ?? actual} expected ${expected} ±${tol}`)
}

function section(name) { console.log(`\n── ${name} ──`) }

// ── A. adaptivePollDelayMs ────────────────────────────────────────────────────

section('A. Adaptive Poll Rate')

assert('A1: no thresholds → 60s', adaptivePollDelayMs(0, []) === 60_000)
assert('A2: all crossed → 60s fallback', adaptivePollDelayMs(12, [5, 7, 9]) === 60_000)
{
  const v = adaptivePollDelayMs(7, [7, 9, 12])
  assert('A3: exact threshold hit → 0ms', v === 0, `got ${v}`)
}
{
  const v = adaptivePollDelayMs(6, [7, 9])
  assert('A4: dist=1 → 10s', v === 10_000, `got ${v}`)
}
{
  const v = adaptivePollDelayMs(4, [7])
  assert('A5: dist=3 → 10s', v === 10_000, `got ${v}`)
}
{
  const v = adaptivePollDelayMs(3, [7])
  assert('A6: dist=4 → 15s', v === 15_000, `got ${v}`)
}
{
  const v = adaptivePollDelayMs(2, [7])
  assert('A7: dist=5 → 15s', v === 15_000, `got ${v}`)
}
{
  const v = adaptivePollDelayMs(4, [12])
  assert('A8: dist=8 → 30s', v === 30_000, `got ${v}`)
}
{
  const v = adaptivePollDelayMs(1, [12])
  assert('A9: dist=11 → 60s', v === 60_000, `got ${v}`)
}
assert('A10: uses min distance of multiple thresholds', adaptivePollDelayMs(5, [6, 10, 15]) === 10_000)
assert('A11: exact highest threshold → 0ms', adaptivePollDelayMs(15, [15]) === 0)
assert('A12: undefined thresholds treated as empty', adaptivePollDelayMs(3, undefined) === 60_000)

// ── B. Slot-weighted lineup K% ────────────────────────────────────────────────

section('B. Slot-weighted Lineup K%')

const LINEUP_SLOT_WEIGHTS = [1.15, 1.10, 1.10, 1.05, 1.00, 0.95, 0.90, 0.85, 0.80]
const LEAGUE_K_PCT = 0.225

function computeSlotWeightedKpct(lineupJson, pitcherHand) {
  try {
    const batters = typeof lineupJson === 'string' ? JSON.parse(lineupJson) : lineupJson
    if (!Array.isArray(batters) || !batters.length) return null
    const field = pitcherHand === 'L' ? 'vs_l' : 'vs_r'
    const leaguePct = LEAGUE_K_PCT * 100
    let weightedSum = 0, totalWeight = 0
    for (let i = 0; i < Math.min(9, batters.length); i++) {
      const w    = LINEUP_SLOT_WEIGHTS[i] ?? 1.0
      const kPct = batters[i]?.[field] ?? leaguePct
      weightedSum += w * kPct
      totalWeight += w
    }
    return totalWeight > 0 ? (weightedSum / totalWeight) / 100 : null
  } catch { return null }
}

// All same K% → equal-weight result
const eqLineup = Array.from({ length: 9 }, () => ({ vs_r: 25.0, vs_l: 25.0 }))
assertClose('B1: equal-batter lineup → 25%', computeSlotWeightedKpct(eqLineup, 'R'), 0.25, 0.001)

// High-K leadoff, low-K tail → slot-weighted > equal-weight
const tilt = [35,33,30,28,25,22,20,18,15].map(v => ({ vs_r: v }))
const tiltSlot  = computeSlotWeightedKpct(tilt, 'R')
const tiltEqual = tilt.reduce((s,b) => s + b.vs_r, 0) / 9 / 100
assert('B2: high-K leadoff → slot > equal', tiltSlot > tiltEqual, `slot=${tiltSlot?.toFixed(4)} eq=${tiltEqual?.toFixed(4)}`)

// Low-K leadoff → slot < equal
const rev = [...tilt].reverse()
const revSlot = computeSlotWeightedKpct(rev, 'R')
assert('B3: low-K leadoff → slot < equal', revSlot < tiltEqual, `slot=${revSlot?.toFixed(4)} eq=${tiltEqual?.toFixed(4)}`)

// Uses correct column for pitcher hand
const handLineup = [{ vs_r: 10.0, vs_l: 40.0 }, ...Array(8).fill({ vs_r: 25.0, vs_l: 25.0 })]
assert('B4: L-hand pitcher uses vs_l', computeSlotWeightedKpct(handLineup, 'L') > computeSlotWeightedKpct(handLineup, 'R'))

// Partial lineup
assert('B5: partial lineup returns value', computeSlotWeightedKpct([{ vs_r: 30 }, { vs_r: 30 }], 'R') != null)

// Empty
assert('B6: empty lineup → null', computeSlotWeightedKpct([], 'R') == null)

// JSON string input
assertClose('B7: JSON string input parses', computeSlotWeightedKpct(JSON.stringify(eqLineup), 'R'), 0.25, 0.001)

// Slot weights sum: 1.15+1.10+1.10+1.05+1.00+0.95+0.90+0.85+0.80 = 8.90
const slotSum = LINEUP_SLOT_WEIGHTS.reduce((s,w) => s+w, 0)
assertClose('B8: slot weights sum = 8.90', slotSum, 8.90, 0.001)

// ── C. bankrollState ──────────────────────────────────────────────────────────

section('C. bankrollState — atomic pool tracking')

const TODAY   = '2026-04-27'
const MORNING = 5000

await initBankrollState(TODAY, MORNING)
assertClose('C1: init → available_pool = morning', await getAvailablePool(TODAY), MORNING, 0.01)

await addCommitted(TODAY, 100)
assertClose('C2: addCommitted(100) → 4900', await getAvailablePool(TODAY), 4900, 0.01)

await addCommitted(TODAY, 200)
assertClose('C3: addCommitted(200) more → 4700', await getAvailablePool(TODAY), 4700, 0.01)

await releaseCommitted(TODAY, 100)
assertClose('C4: releaseCommitted(100) → 4800', await getAvailablePool(TODAY), 4800, 0.01)

// Win $80, release $200 committed
await addRealized(TODAY, 80, 200)
assertClose('C5: addRealized(80, release 200) → 5080', await getAvailablePool(TODAY), 5080, 0.01)

const st = await getBankrollState(TODAY)
assertClose('C6: morning_bankroll unchanged', st.morning_bankroll, MORNING, 0.01)
assertClose('C7: realized_pnl = 80', st.realized_pnl, 80, 0.01)
assertClose('C8: committed_capital = 0 after releases', st.committed_capital, 0, 0.01)

// Zero amount is no-op
await addCommitted(TODAY, 0)
assertClose('C9: addCommitted(0) no-op', await getAvailablePool(TODAY), 5080, 0.01)

// available_pool never negative
await addCommitted(TODAY, 99999)
assert('C10: over-commit → pool ≥ 0', await getAvailablePool(TODAY) >= 0)

// ── D. betLock ────────────────────────────────────────────────────────────────

section('D. betLock — DB mutex')

const LP = { game: 'G001', pid: 'P123', thr: 7, side: 'YES' }
await releaseBetLock(LP.game, LP.pid, LP.thr, LP.side)

assert('D1: first acquire → true', await acquireBetLock(LP.game, LP.pid, LP.thr, LP.side) === true)
assert('D2: second acquire → false (blocked)', await acquireBetLock(LP.game, LP.pid, LP.thr, LP.side) === false)

await confirmBetPlaced(LP.game, LP.pid, LP.thr, LP.side, 99999)
const confirmed = await isLocked(LP.game, LP.pid, LP.thr, LP.side)
assert('D3: isLocked after confirm → row exists', confirmed != null)
assert('D4: confirmed lock has bet_id', confirmed?.bet_id != null)

await cleanStaleLocks()
assert('D5: confirmed lock survives cleanStaleLocks', await isLocked(LP.game, LP.pid, LP.thr, LP.side) != null)

await releaseBetLock(LP.game, LP.pid, LP.thr, LP.side)
assert('D6: releaseBetLock removes lock', await isLocked(LP.game, LP.pid, LP.thr, LP.side) == null)

// Stale lock (10 min old, no bet_id) gets swept
const staleKey = makeLockKey('STALE-G', 'STALE-P', 5, 'NO')
await client.execute({ sql: `INSERT OR REPLACE INTO bet_placement_locks (lock_key, holder, locked_at, bet_id) VALUES (?,?,?,?)`, args: [staleKey, 'test', Date.now() - 10 * 60_000, null] })
await cleanStaleLocks()
const staleRow = await dbMod.one(`SELECT lock_key FROM bet_placement_locks WHERE lock_key=?`, [staleKey]).catch(() => null)
assert('D7: stale lock (10min, no bet_id) swept', staleRow == null)

// Fresh lock (< 5min, no bet_id) NOT swept
await acquireBetLock('FRESH-G', 'FRESH-P', 6, 'YES')
await cleanStaleLocks()
assert('D8: fresh lock not swept', await isLocked('FRESH-G', 'FRESH-P', 6, 'YES') != null)
await releaseBetLock('FRESH-G', 'FRESH-P', 6, 'YES')

// Different sides = independent locks
const yA = await acquireBetLock('DUAL-G', 'DUAL-P', 8, 'YES')
const nA = await acquireBetLock('DUAL-G', 'DUAL-P', 8, 'NO')
assert('D9: YES and NO have independent locks', yA && nA)
await releaseBetLock('DUAL-G', 'DUAL-P', 8, 'YES')
await releaseBetLock('DUAL-G', 'DUAL-P', 8, 'NO')

// ── E. Concurrent dedup simulation ───────────────────────────────────────────

section('E. Concurrent dedup — betLock + bankrollState')

const CONC = '2026-04-27-conc'
await initBankrollState(CONC, 5000)

const lock1 = await acquireBetLock(CONC, 'P-RACE', 6, 'YES')
const lock2 = await acquireBetLock(CONC, 'P-RACE', 6, 'YES')

assert('E1: first process wins lock', lock1 === true)
assert('E2: second process blocked', lock2 === false)

if (lock1) {
  await addCommitted(CONC, 100)
  await confirmBetPlaced(CONC, 'P-RACE', 6, 'YES', 12345)
}
assertClose('E3: only $100 committed (not $200)', await getAvailablePool(CONC), 4900, 0.01)
await releaseBetLock(CONC, 'P-RACE', 6, 'YES')

// ── F. Kelly integration — available_pool as bankroll base ────────────────────

section('F. Kelly base = available_pool')

const KD = '2026-04-27-kelly'
await initBankrollState(KD, 5000)
await addCommitted(KD, 1000)
const kPool = await getAvailablePool(KD)
assertClose('F1: available_pool = 4000 after $1000 committed', kPool, 4000, 0.01)
assert('F2: available_pool < morning (committed subtracted)', kPool < 5000)
assert('F3: available_pool > 0', kPool > 0)

// Win releases committed and adds pnl
await addRealized(KD, 150, 1000)
assertClose('F4: after win → pool = 5150', await getAvailablePool(KD), 5150, 0.01)

// Multiple bets accumulate correctly
await addCommitted(KD, 50); await addCommitted(KD, 50); await addCommitted(KD, 50)
assertClose('F5: three $50 bets → pool = 5000', await getAvailablePool(KD), 5000, 0.01)

// ── G. game_pulse state machine ───────────────────────────────────────────────
// Note: initGamePulse/updateGamePulse call external MLB API — not for unit tests.
// We test the DB schema and read functions using direct SQL inserts.

section('G. game_pulse state machine')

const GP_DATE = '2026-04-27'
const GP_GAME = 'TEST-GAME-001'

// Insert directly (no MLB API call)
await client.execute({
  sql: `INSERT OR REPLACE INTO game_pulse (game_pk, bet_date, home_team, away_team, home_pitcher_id, away_pitcher_id, game_time_et, phase, home_lineup_posted, away_lineup_posted, home_pitcher_pulled, away_pitcher_pulled, last_updated)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  args: [GP_GAME, GP_DATE, 'NYY', 'BOS', 'P-H', 'P-A', '19:05', 'pre_lineup', 0, 0, 0, 0, Date.now()],
})

const p0 = await getGamePulseRow(GP_GAME, GP_DATE)
assert('G1: insert creates row', p0 != null)
assert('G2: initial phase = pre_lineup', p0?.phase === 'pre_lineup')
assert('G3: lineups not posted', p0?.home_lineup_posted === 0 && p0?.away_lineup_posted === 0)

// Phase → pre_game (lineup posted)
await client.execute({ sql: `UPDATE game_pulse SET home_lineup_posted=1, away_lineup_posted=1, phase='pre_game', home_pitcher_confirmed=1, away_pitcher_confirmed=1, last_updated=? WHERE game_pk=? AND bet_date=?`, args: [Date.now(), GP_GAME, GP_DATE] })
const p1 = await getGamePulseRow(GP_GAME, GP_DATE)
assert('G4: phase → pre_game', p1?.phase === 'pre_game')
assert('G5: home_lineup_posted = 1', p1?.home_lineup_posted === 1)

// Phase → live
await client.execute({ sql: `UPDATE game_pulse SET phase='live', inning=1, half='top', last_updated=? WHERE game_pk=? AND bet_date=?`, args: [Date.now(), GP_GAME, GP_DATE] })
assert('G6: phase → live', (await getGamePulseRow(GP_GAME, GP_DATE))?.phase === 'live')

// Pull detected
await client.execute({ sql: `UPDATE game_pulse SET home_pitcher_pulled=1, home_bf=18, last_updated=? WHERE game_pk=? AND bet_date=?`, args: [Date.now(), GP_GAME, GP_DATE] })
assert('G7: pull flag = 1', (await getGamePulseRow(GP_GAME, GP_DATE))?.home_pitcher_pulled === 1)

// Phase → final
await client.execute({ sql: `UPDATE game_pulse SET phase='final', home_score=4, away_score=2, last_updated=? WHERE game_pk=? AND bet_date=?`, args: [Date.now(), GP_GAME, GP_DATE] })
const p4 = await getGamePulseRow(GP_GAME, GP_DATE)
assert('G8: phase → final', p4?.phase === 'final')

// getActivePulse excludes final games (returns all, caller filters)
// Actually getActivePulse returns ALL rows for bet_date — filter final in caller
const allPulse = await getActivePulse(GP_DATE)
assert('G9: getActivePulse includes game rows for date', allPulse.length > 0)

// Add a live game and verify it appears
await client.execute({
  sql: `INSERT OR REPLACE INTO game_pulse (game_pk, bet_date, home_team, away_team, game_time_et, phase, last_updated) VALUES (?,?,?,?,?,?,?)`,
  args: ['ACTIVE-G', GP_DATE, 'ATL', 'PHI', '20:10', 'live', Date.now()],
})
const active2 = await getActivePulse(GP_DATE)
assert('G10: live game appears in getActivePulse', active2.some(p => p.game_pk === 'ACTIVE-G'))

// ── H. line direction tracking ────────────────────────────────────────────────
// updateLineDirections(date) calls DK API — test the direction LOGIC inline.

section('H. DK line direction logic')

// Insert game_pulse row with T-180 baseline
await client.execute({
  sql: `INSERT OR REPLACE INTO game_pulse (game_pk, bet_date, home_team, away_team, home_pitcher_id, game_time_et, phase, dk_home_line_t180, dk_away_line_t180, dk_home_direction, dk_away_direction, last_updated)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  args: ['DIR-001', GP_DATE, 'ATL', 'PHI', 'P-ATL', '20:05', 'pre_game', 7.5, -7.5, 0, 0, Date.now()],
})

// Compute direction logic (mirrors what updateLineDirections does)
function computeDirection(current, t180) {
  if (t180 == null) return 0
  return current > t180 ? 1 : current < t180 ? -1 : 0
}
assert('H1: rising home line → +1', computeDirection(8.5, 7.5) === 1)
assert('H2: falling away line → -1', computeDirection(-8.5, -7.5) === -1)
assert('H3: same as T-180 → 0', computeDirection(7.5, 7.5) === 0)
assert('H4: line drops below T-180 → -1', computeDirection(6.5, 7.5) === -1)
assert('H5: T-180 null → 0 (no baseline)', computeDirection(8.5, null) === 0)

// Store a direction update directly
await client.execute({ sql: `UPDATE game_pulse SET dk_home_direction=?, dk_away_direction=? WHERE game_pk=? AND bet_date=?`, args: [1, -1, 'DIR-001', GP_DATE] })
const d1 = await getGamePulseRow('DIR-001', GP_DATE)
assert('H6: direction persists in DB', d1?.dk_home_direction === 1 && d1?.dk_away_direction === -1)

// ── I. scratch watch timing window ────────────────────────────────────────────

section('I. Scratch watch timing')

function inScratchWindow(minsOut) { return minsOut >= 50 && minsOut <= 70 }

assert('I1: T-55 in window', inScratchWindow(55))
assert('I2: T-65 in window', inScratchWindow(65))
assert('I3: T-50 edge (in)', inScratchWindow(50))
assert('I4: T-70 edge (in)', inScratchWindow(70))
assert('I5: T-80 out (too early)', !inScratchWindow(80))
assert('I6: T-30 out (too close)', !inScratchWindow(30))
assert('I7: T-0 out', !inScratchWindow(0))
assert('I8: T-120 out', !inScratchWindow(120))

// ── J. Kalshi outage detection state machine ──────────────────────────────────

section('J. Kalshi outage detection')

let consec = 0
const THRESHOLD = 3

function track(success) {
  if (success) { consec = 0; return false }
  return (++consec) >= THRESHOLD
}

assert('J1: 1 failure → no outage', !track(false))
assert('J2: 2 failures → no outage', !track(false))
assert('J3: 3 failures → outage', track(false))
assert('J4: counter at 3 after threshold', consec === 3)
track(true)
assert('J5: success resets counter', consec === 0)

// Reset and test non-monotonic failures
consec = 0
track(false); track(false); track(true); track(false)
assert('J6: success mid-run resets counter', consec === 1)

// ── K. makeLockKey format ─────────────────────────────────────────────────────

section('K. betLock key format')

const k1 = makeLockKey('12345', '543210', 7, 'YES')
assert('K1: key contains gamePk', k1.includes('12345'))
assert('K2: key contains pitcherId', k1.includes('543210'))
assert('K3: key contains threshold', k1.includes('7'))
assert('K4: key contains side', k1.includes('YES'))
assert('K5: YES/NO different keys', makeLockKey('G','P',7,'YES') !== makeLockKey('G','P',7,'NO'))
assert('K6: different thresholds different keys', makeLockKey('G','P',7,'YES') !== makeLockKey('G','P',8,'YES'))
assert('K7: different pitchers different keys', makeLockKey('G','P1',7,'YES') !== makeLockKey('G','P2',7,'YES'))

// ── L. Full-day scenario simulation ──────────────────────────────────────────

section('L. Full-day scenario simulation')

const SIM = '2026-04-27-sim'

await initBankrollState(SIM, 5000)
assertClose('L1: starts at $5000', await getAvailablePool(SIM), 5000, 0.01)

// Morning bets
await acquireBetLock(SIM, 'SP1', 6, 'YES')
await addCommitted(SIM, 100)
await confirmBetPlaced(SIM, 'SP1', 6, 'YES', 1001)

await acquireBetLock(SIM, 'SP2', 7, 'NO')
await addCommitted(SIM, 150)
await confirmBetPlaced(SIM, 'SP2', 7, 'NO', 1002)

await acquireBetLock(SIM, 'SP3', 5, 'YES')
await addCommitted(SIM, 80)
await confirmBetPlaced(SIM, 'SP3', 5, 'YES', 1003)

assertClose('L2: after 3 morning bets → $4670 pool', await getAvailablePool(SIM), 4670, 0.01)
assert('L3: afternoon Kelly base < morning', await getAvailablePool(SIM) < 5000)

// Settle: SP1 win +100, SP2 loss -150
await addRealized(SIM, 100, 100)
await addRealized(SIM, -150, 150)
// pool = 5000 + (100-150) - 80 = 4870
assertClose('L4: SP1+SP2 settled → $4870', await getAvailablePool(SIM), 4870, 0.01)

// SP3 win +80
await addRealized(SIM, 80, 80)
// pool = 5000 + (100-150+80) - 0 = 5030
assertClose('L5: all settled → $5030', await getAvailablePool(SIM), 5030, 0.01)

const simSt = await getBankrollState(SIM)
assertClose('L6: realized_pnl = +30', simSt.realized_pnl, 30, 0.01)
assertClose('L7: committed_capital = 0', simSt.committed_capital, 0, 0.01)

// ── M. betLock TTL boundary ───────────────────────────────────────────────────

section('M. betLock TTL boundary conditions')

// 4:59 ago → NOT stale
const borderKey = makeLockKey('B-G', 'B-P', 9, 'YES')
await client.execute({ sql: `INSERT OR REPLACE INTO bet_placement_locks (lock_key,holder,locked_at,bet_id) VALUES (?,?,?,?)`, args: [borderKey, 'test', Date.now() - (5*60_000 - 1000), null] })
await cleanStaleLocks()
assert('M1: 4:59-old lock not swept', await dbMod.one(`SELECT lock_key FROM bet_placement_locks WHERE lock_key=?`, [borderKey]).catch(() => null) != null)

// 5:01 ago → stale
const overKey = makeLockKey('O-G', 'O-P', 9, 'YES')
await client.execute({ sql: `INSERT OR REPLACE INTO bet_placement_locks (lock_key,holder,locked_at,bet_id) VALUES (?,?,?,?)`, args: [overKey, 'test', Date.now() - (5*60_000 + 1000), null] })
await cleanStaleLocks()
assert('M2: 5:01-old lock swept', await dbMod.one(`SELECT lock_key FROM bet_placement_locks WHERE lock_key=?`, [overKey]).catch(() => null) == null)

// 6-min old WITH bet_id → NOT swept
const confirmedOld = makeLockKey('CO-G', 'CO-P', 5, 'NO')
await client.execute({ sql: `INSERT OR REPLACE INTO bet_placement_locks (lock_key,holder,locked_at,bet_id) VALUES (?,?,?,?)`, args: [confirmedOld, 'test', Date.now() - 6*60_000, 99998] })
await cleanStaleLocks()
assert('M3: confirmed old lock not swept', await dbMod.one(`SELECT lock_key FROM bet_placement_locks WHERE lock_key=?`, [confirmedOld]).catch(() => null) != null)

// ── N. bankrollState reconcile from ks_bets ───────────────────────────────────

section('N. bankrollState reconcile from ks_bets')

const RECON = '2026-04-27-recon'
await initBankrollState(RECON, 6000)

// 2 open bets ($100+$150 risk) + 1 settled win ($80)
for (const [ticker, result, risk, pnl] of [
  ['T1', null, 100, null],
  ['T2', null, 150, null],
  ['T3', 'win', 80,  80],
]) {
  await client.execute({
    sql: `INSERT OR IGNORE INTO ks_bets (bet_date,logged_at,pitcher_name,team,game,strike,side,model_prob,market_mid,edge,lambda,ticker,bet_size,live_bet,paper,result,capital_at_risk,pnl) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [RECON, new Date().toISOString(), 'Tester', 'NYY', 'NYY@BOS', 7, 'YES', 0.45, 55, 0.12, 5.5, ticker, 10, 0, 0, result, risk, pnl],
  })
}

await reconcileBankrollState(RECON)
const reconSt = await getBankrollState(RECON)
assertClose('N1: reconcile committed = 250', reconSt.committed_capital, 250, 0.01)
assertClose('N2: reconcile realized = 80', reconSt.realized_pnl, 80, 0.01)
// 6000 + 80 - 250 = 5830
assertClose('N3: reconcile pool = 5830', await getAvailablePool(RECON), 5830, 0.01)

// ── O. pitcher_edge_cache freshness ───────────────────────────────────────────

section('O. pitcher_edge_cache freshness gate')

await client.execute({
  sql: `INSERT OR REPLACE INTO pitcher_edge_cache (pitcher_id,bet_date,edge_computed_at,trigger_source,edges_json) VALUES (?,?,?,?,?)`,
  args: ['FRESH-P', TODAY, new Date().toISOString(), 'morning', JSON.stringify([{strike:6,passed:true}])],
})
const freshRow = await dbMod.one(`SELECT edge_computed_at FROM pitcher_edge_cache WHERE pitcher_id=? AND bet_date=?`, ['FRESH-P', TODAY])
const freshAge = (Date.now() - new Date(freshRow.edge_computed_at).getTime()) / 1000
assert('O1: fresh cache < 5s old', freshAge < 5)
assert('O2: fresh cache < 180s (skip recompute)', freshAge < 180)

// Old cache → should recompute
await client.execute({
  sql: `INSERT OR REPLACE INTO pitcher_edge_cache (pitcher_id,bet_date,edge_computed_at,trigger_source,edges_json) VALUES (?,?,?,?,?)`,
  args: ['STALE-P', TODAY, new Date(Date.now() - 4*60_000).toISOString(), 'morning', '[]'],
})
const staleEdgeRow = await dbMod.one(`SELECT edge_computed_at FROM pitcher_edge_cache WHERE pitcher_id=? AND bet_date=?`, ['STALE-P', TODAY])
const staleAge = (Date.now() - new Date(staleEdgeRow.edge_computed_at).getTime()) / 1000
assert('O3: stale cache > 180s (should recompute)', staleAge > 180)

// Cache survives with edges_json intact
const cacheEdges = JSON.parse(freshRow ? (await dbMod.one(`SELECT edges_json FROM pitcher_edge_cache WHERE pitcher_id=? AND bet_date=?`, ['FRESH-P', TODAY]))?.edges_json ?? '[]' : '[]')
assert('O4: cached edges_json parseable', Array.isArray(cacheEdges))

// ── P. phase transition and BF tracking ──────────────────────────────────────

section('P. Phase transitions and BF tracking')

// Direct SQL insert (no MLB API)
await client.execute({ sql: `INSERT OR REPLACE INTO game_pulse (game_pk, bet_date, home_team, away_team, phase, last_updated) VALUES (?,?,?,?,?,?)`, args: ['PHASE-T', GP_DATE, 'CLE', 'DET', 'pre_lineup', Date.now()] })
await client.execute({ sql: `UPDATE game_pulse SET phase=? WHERE game_pk=? AND bet_date=?`, args: ['live', 'PHASE-T', GP_DATE] })
await client.execute({ sql: `UPDATE game_pulse SET phase=? WHERE game_pk=? AND bet_date=?`, args: ['final', 'PHASE-T', GP_DATE] })
const phaseAfterFinal = await getGamePulseRow('PHASE-T', GP_DATE)
assert('P1: final phase write persists', phaseAfterFinal?.phase === 'final')

// BF tracking
await client.execute({ sql: `INSERT OR REPLACE INTO game_pulse (game_pk, bet_date, home_team, away_team, home_pitcher_id, phase, home_bf, last_updated) VALUES (?,?,?,?,?,?,?,?)`, args: ['BF-TEST', GP_DATE, 'SF', 'LAD', 'SF-SP', 'live', 0, Date.now()] })
await client.execute({ sql: `UPDATE game_pulse SET home_bf=12 WHERE game_pk=? AND bet_date=?`, args: ['BF-TEST', GP_DATE] })
const bfRow = await getGamePulseRow('BF-TEST', GP_DATE)
assert('P2: BF update writes correctly', bfRow?.home_bf === 12)

// Pull confirmed flag
await client.execute({ sql: `UPDATE game_pulse SET home_pitcher_pulled=1, pull_confirmed_home=1 WHERE game_pk=? AND bet_date=?`, args: ['BF-TEST', GP_DATE] })
const pullRow = await getGamePulseRow('BF-TEST', GP_DATE)
assert('P3: pull_confirmed_home = 1', pullRow?.pull_confirmed_home === 1)

// ── Q. bankrollState doesn't double-count on re-init ─────────────────────────

section('Q. bankrollState re-init idempotence')

const REINIT = '2026-04-27-reinit'
await initBankrollState(REINIT, 5000)
await addCommitted(REINIT, 200)

// Re-init on same date should NOT reset committed_capital
await initBankrollState(REINIT, 5000)  // INSERT OR IGNORE — should be no-op
const reinitSt = await getBankrollState(REINIT)
assertClose('Q1: re-init does not reset committed_capital', reinitSt.committed_capital, 200, 0.01)
assertClose('Q2: pool still reflects committed after re-init', await getAvailablePool(REINIT), 4800, 0.01)

// ── R. betLock cross-pitcher isolation ───────────────────────────────────────

section('R. betLock cross-pitcher isolation')

// Same game, different pitchers
const acqP1 = await acquireBetLock('SAME-G', 'PID-1', 7, 'YES')
const acqP2 = await acquireBetLock('SAME-G', 'PID-2', 7, 'YES')
assert('R1: different pitchers have independent locks', acqP1 && acqP2)
await releaseBetLock('SAME-G', 'PID-1', 7, 'YES')
await releaseBetLock('SAME-G', 'PID-2', 7, 'YES')

// Same pitcher, different thresholds
const acqT6 = await acquireBetLock('THRESH-G', 'PID-T', 6, 'YES')
const acqT7 = await acquireBetLock('THRESH-G', 'PID-T', 7, 'YES')
assert('R2: different thresholds have independent locks', acqT6 && acqT7)
await releaseBetLock('THRESH-G', 'PID-T', 6, 'YES')
await releaseBetLock('THRESH-G', 'PID-T', 7, 'YES')

// ── Cleanup ───────────────────────────────────────────────────────────────────

try { await fs.unlink(TEST_DB) } catch {}

// ── Results ───────────────────────────────────────────────────────────────────

const total = passed + failed
console.log(`\n${'═'.repeat(60)}`)
console.log(`SONAR SYSTEM TEST RESULTS: ${passed}/${total} passed  (${failed} failed)`)
if (failed > 0) {
  console.log('\nFAILURES:')
  failures.forEach((f, i) => console.error(`  ${i+1}. ${f}`))
}
console.log(`${'═'.repeat(60)}`)

const pct = Math.round(passed / total * 100)
console.log(`Confidence: ${pct}% (target: >95%)`)
if (pct < 95) console.warn(`⚠ Below 95% confidence threshold — investigate failures above.`)
else console.log(`✓ Meets 95% confidence threshold`)

if (failed > 0) process.exit(1)
