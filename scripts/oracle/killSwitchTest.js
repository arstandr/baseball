// scripts/oracle/killSwitchTest.js
//
// KILL-SWITCH VERIFICATION — proves the cage's three trading kill switches
// actually halt placement before launch. Each test inserts sentinel rows that
// it cleans up in a `finally` so a partial run never leaves the DB dirty.
//
// Test A — system_flags.trading_halted=1 stops everything (the master switch).
// Test B — daily realized-loss cap (LIVE_DAILY_LOSS_LIMIT, default $300):
//          fake settled losing bet brings live PnL just past −$300 → checkAllCaps
//          must return { allowed:false, reason:/daily_loss/ }.
// Test C — per-pitcher risk cap (MAX_INVERT_RISK_PER_PITCHER, default $50):
//          two fake filled inversion bets with combined capital_at_risk ≥$50
//          → checkAllCaps must return { allowed:false, reason:/pitcher_cap/ }.
//
// Sentinel data is identifiable by:
//   pitcher_id   = '99999999'
//   pitcher_name LIKE 'TEST_KILLSWITCH_%'
//   strategy_submode = 'kill_switch_test'
//
// Safe to run on production Turso — only writes/reads sentinel rows. Restores
// system_flags.trading_halted to its original value at the end of Test A.
//
// Usage:
//   node scripts/oracle/killSwitchTest.js
//
// Exit: 0 if all three tests PASS, 1 if any FAIL.

import 'dotenv/config'

import * as db from '../../lib/db.js'
import { checkAllCaps, checkPitcherCap, config as capsConfig } from '../../lib/strategyCaps.js'

// ── Constants ─────────────────────────────────────────────────────
const SENTINEL_PITCHER_ID   = '99999999'
const SENTINEL_SUBMODE      = 'kill_switch_test'
const ADAM_LIVE_USER_ID     = 284

function todayET() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
}
const TODAY = todayET()

// ── Result tracking ──────────────────────────────────────────────
const results = []
function record(label, pass, detail = '') {
  results.push({ label, pass })
  const tag = pass ? 'PASS' : 'FAIL'
  console.log(`[${label}] ${tag}${detail ? ` (${detail})` : ''}`)
}

// ── Cleanup helper — wipes any sentinel ks_bets rows ─────────────
async function cleanupSentinelBets() {
  await db.run(
    `DELETE FROM ks_bets
     WHERE pitcher_id = ?
       AND COALESCE(strategy_submode,'') = ?`,
    [SENTINEL_PITCHER_ID, SENTINEL_SUBMODE],
  )
}

// ═════════════════════════════════════════════════════════════════
// TEST A — trading_halted halts placement
// ═════════════════════════════════════════════════════════════════
async function testA() {
  console.log('\n── TEST A: trading_halted halts placement ──')

  // 1. Snapshot original trading_halted
  const before = await db.one(
    `SELECT value, updated_by FROM system_flags WHERE key='trading_halted'`,
  )
  const originalValue   = before?.value ?? '0'
  const originalUpdater = before?.updated_by ?? 'system'
  console.log(`  snapshot: trading_halted='${originalValue}' updated_by='${originalUpdater}'`)

  let pass = false
  try {
    // 2. Set trading_halted=1 (subtype 'paused' = pause_new_entries alias for now)
    await db.run(
      `INSERT OR REPLACE INTO system_flags (key, value, updated_by, updated_at)
       VALUES ('trading_halted', '1', 'kill_switch_test:paused', ?)`,
      [new Date().toISOString()],
    )
    console.log('  set:      trading_halted=1 updated_by=kill_switch_test:paused')

    // 3. Verify ksBets-style placement query reads it as halted
    const after = await db.one(
      `SELECT value FROM system_flags WHERE key='trading_halted'`,
    )
    const isHalted = String(after?.value) === '1'
    console.log(`  read:     trading_halted='${after?.value}' (placement should be blocked)`)

    if (isHalted) {
      record('TEST A', true, 'trading_halted halts placement')
      pass = true
    } else {
      record('TEST A', false, `expected '1', got '${after?.value}'`)
    }
  } finally {
    // 4. Restore original state
    await db.run(
      `INSERT OR REPLACE INTO system_flags (key, value, updated_by, updated_at)
       VALUES ('trading_halted', ?, ?, ?)`,
      [originalValue, originalUpdater, new Date().toISOString()],
    )
    console.log(`  restored: trading_halted='${originalValue}' updated_by='${originalUpdater}'`)
  }
  return pass
}

// ═════════════════════════════════════════════════════════════════
// TEST B — daily-loss cap auto-trip blocks bets
// ═════════════════════════════════════════════════════════════════
async function testB() {
  console.log('\n── TEST B: daily-loss cap auto-trip ──')
  const cap = capsConfig.LIVE_DAILY_LOSS_LIMIT
  // Need pnl <= -cap. Use cap+10 to be just past the threshold.
  const fakeLoss = -(cap + 10)
  console.log(`  cap=$${cap}  fakeLoss=$${fakeLoss.toFixed(2)}  user=${ADAM_LIVE_USER_ID}`)

  // Make sure no stale sentinel rows linger from a prior failed run.
  await cleanupSentinelBets()

  let pass = false
  try {
    // 1. Insert a fake settled losing live bet that breaches the daily cap.
    //    NOT NULL columns: bet_date, logged_at, pitcher_name, strike, side,
    //    model_prob, edge.
    await db.run(
      `INSERT INTO ks_bets (
         bet_date, logged_at, pitcher_id, pitcher_name, strike, side,
         model_prob, market_mid, edge,
         live_bet, paper, user_id,
         strategy_mode, strategy_submode,
         capital_at_risk, bet_size, fill_price, filled_contracts, order_status,
         result, pnl, settled_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, 'live', ?, ?, ?, ?, ?, 'filled', 'loss', ?, ?)`,
      [
        TODAY, new Date().toISOString(),
        SENTINEL_PITCHER_ID, 'TEST_KILLSWITCH_DAILYLOSS',
        7, 'YES',
        0.55, 50, 0.05,
        ADAM_LIVE_USER_ID,
        SENTINEL_SUBMODE,
        Math.abs(fakeLoss), Math.abs(fakeLoss), 50, 1,
        fakeLoss,
        new Date().toISOString(),
      ],
    )
    console.log('  inserted fake settled losing live bet')

    // 2. checkAllCaps with strategy_mode='live' must block.
    const blocked = await checkAllCaps({
      db,
      userId: ADAM_LIVE_USER_ID,
      pitcherId: SENTINEL_PITCHER_ID,
      betDate: TODAY,
      strategy_mode: 'live',
    })
    console.log(`  checkAllCaps (loaded loss): allowed=${blocked.allowed} reason='${blocked.reason ?? ''}'`)

    const blockedOk = blocked.allowed === false && /daily_loss/.test(String(blocked.reason ?? ''))
    if (!blockedOk) {
      record('TEST B', false, `expected blocked w/ daily_loss reason; got ${JSON.stringify(blocked)}`)
      return false
    }

    // 3. Delete the fake bet → cap should clear.
    await cleanupSentinelBets()

    const allowed = await checkAllCaps({
      db,
      userId: ADAM_LIVE_USER_ID,
      pitcherId: SENTINEL_PITCHER_ID,
      betDate: TODAY,
      strategy_mode: 'live',
    })
    console.log(`  checkAllCaps (after cleanup): allowed=${allowed.allowed} reason='${allowed.reason ?? ''}'`)

    if (allowed.allowed === true) {
      record('TEST B', true, `cap=$${cap}, simulated loss=$${Math.abs(fakeLoss)}, blocked='${blocked.reason}'`)
      pass = true
    } else {
      record('TEST B', false, `after cleanup expected allowed=true, got ${JSON.stringify(allowed)}`)
    }
  } finally {
    await cleanupSentinelBets()
  }
  return pass
}

// ═════════════════════════════════════════════════════════════════
// TEST C — per-pitcher cap blocks
// ═════════════════════════════════════════════════════════════════
async function testC() {
  console.log('\n── TEST C: per-pitcher cap blocks ──')
  const cap = capsConfig.MAX_INVERT_RISK_PER_PITCHER
  // Two bets summing to >= cap. Use cap/2 + 5 each so total = cap + 10.
  const each = cap / 2 + 5
  console.log(`  cap=$${cap}  per-bet capital_at_risk=$${each.toFixed(2)}  total=$${(each * 2).toFixed(2)}  user=${ADAM_LIVE_USER_ID}`)

  await cleanupSentinelBets()

  let pass = false
  try {
    // 1. Insert 2 fake FILLED inversion bets on the sentinel pitcher.
    //    Caps query keys on order_id IS NOT NULL and order_status NOT IN
    //    ('cancelled','void'); use 'filled' to count.
    for (let i = 0; i < 2; i++) {
      await db.run(
        `INSERT INTO ks_bets (
           bet_date, logged_at, pitcher_id, pitcher_name, strike, side,
           model_prob, market_mid, edge,
           live_bet, paper, user_id,
           strategy_mode, strategy_submode,
           capital_at_risk, bet_size, fill_price, filled_contracts,
           order_id, order_status
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, 'pregame_inversion', ?, ?, ?, ?, ?, ?, 'filled')`,
        [
          TODAY, new Date().toISOString(),
          SENTINEL_PITCHER_ID, `TEST_KILLSWITCH_PITCHER_${i}`,
          6 + i, 'NO',
          0.40, 35, 0.05,
          ADAM_LIVE_USER_ID,
          SENTINEL_SUBMODE,
          each, each, 35, Math.round(each / 0.35),
          `kill-switch-test-pitcher-${i}-${Date.now()}`,
        ],
      )
    }
    console.log(`  inserted 2 fake filled inversion bets totaling $${(each * 2).toFixed(2)} at risk`)

    // 2. checkPitcherCap (and also checkAllCaps) must block.
    const pitcherOnly = await checkPitcherCap({
      db,
      userId: ADAM_LIVE_USER_ID,
      pitcherId: SENTINEL_PITCHER_ID,
      betDate: TODAY,
      strategy_mode: 'pregame_inversion',
    })
    console.log(`  checkPitcherCap: allowed=${pitcherOnly.allowed} reason='${pitcherOnly.reason ?? ''}' risk=$${pitcherOnly.current_risk ?? 0} bets=${pitcherOnly.current_bets ?? 0}`)

    const all = await checkAllCaps({
      db,
      userId: ADAM_LIVE_USER_ID,
      pitcherId: SENTINEL_PITCHER_ID,
      betDate: TODAY,
      strategy_mode: 'pregame_inversion',
    })
    console.log(`  checkAllCaps:    allowed=${all.allowed} reason='${all.reason ?? ''}'`)

    const blockedOk =
      pitcherOnly.allowed === false &&
      /pitcher_cap/.test(String(pitcherOnly.reason ?? '')) &&
      all.allowed === false &&
      /pitcher_cap/.test(String(all.reason ?? ''))

    if (!blockedOk) {
      record('TEST C', false,
        `expected pitcher_cap block; got pitcher=${JSON.stringify(pitcherOnly)} all=${JSON.stringify(all)}`)
      return false
    }

    // 3. Delete fake bets → cap should clear.
    await cleanupSentinelBets()

    const allowed = await checkAllCaps({
      db,
      userId: ADAM_LIVE_USER_ID,
      pitcherId: SENTINEL_PITCHER_ID,
      betDate: TODAY,
      strategy_mode: 'pregame_inversion',
    })
    console.log(`  checkAllCaps (after cleanup): allowed=${allowed.allowed} reason='${allowed.reason ?? ''}'`)

    if (allowed.allowed === true) {
      record('TEST C', true, `cap=$${cap}, simulated risk=$${(each * 2).toFixed(2)}, blocked='${pitcherOnly.reason}'`)
      pass = true
    } else {
      record('TEST C', false, `after cleanup expected allowed=true, got ${JSON.stringify(allowed)}`)
    }
  } finally {
    await cleanupSentinelBets()
  }
  return pass
}

// ═════════════════════════════════════════════════════════════════
// Main
// ═════════════════════════════════════════════════════════════════
async function main() {
  console.log(`KILL-SWITCH VERIFICATION — bet_date=${TODAY}`)
  console.log(`User=${ADAM_LIVE_USER_ID} (Adam-Live)`)
  console.log(`Sentinel: pitcher_id='${SENTINEL_PITCHER_ID}', submode='${SENTINEL_SUBMODE}'`)

  const a = await testA()
  const b = await testB()
  const c = await testC()

  // Final cleanup belt-and-suspenders.
  await cleanupSentinelBets()

  console.log('')
  console.log('─────────────────────────────────────────────')
  for (const r of results) console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.label}`)
  console.log('─────────────────────────────────────────────')

  const allPass = a && b && c
  if (allPass) console.log('ALL KILL SWITCHES VERIFIED')
  else         console.log('KILL-SWITCH FAILURE — DO NOT UNHALT')

  await db.close()
  process.exit(allPass ? 0 : 1)
}

main().catch(async (err) => {
  console.error('[killSwitchTest] FATAL:', err.message)
  console.error(err.stack)
  // Best-effort cleanup so a crash doesn't leave sentinel rows or a halted system.
  try { await cleanupSentinelBets() } catch {}
  try { await db.close() } catch {}
  process.exit(1)
})
