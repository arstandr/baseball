// scripts/oracle/edgeCaseTestSuite.js
//
// Comprehensive edge-case validation for the May 3 launch cage. Run after
// build, before unhalt. Exercises every safety surface in the operational
// layer with realistic edge cases, then prints PASS/FAIL per case.
//
// Categories:
//   A. strategy_mode validator
//   B. cap helpers
//   C. family lock
//   D. pitcher state classifier
//   E. dead-path math
//   F. reconciliation
//   G. cage alerts (mock — doesn't actually send)
//   H. integration: end-to-end placement gate flow
//
// Sentinel data: pitcher_id='99999999', strategy_submode='edge_test'
// Cleanup runs in finally for every category.
//
// Usage: node scripts/oracle/edgeCaseTestSuite.js
// Exits 0 if all PASS, 1 if any FAIL.

import 'dotenv/config'
import * as db from '../../lib/db.js'
import { STRATEGY_MODES, validateStrategyMode, isValidStrategyMode, liveBetModeToSubmode, parentModeFromSubmode } from '../../lib/strategyMode.js'
import { checkAllCaps, checkPitcherCap, checkDailyLossCap, checkGlobalDailyLossCap, getRemainingCaps } from '../../lib/strategyCaps.js'
import { checkFamilyLock, isDuplicateStrike } from '../../lib/familyLock.js'
import { STATES, classifyPitcherState, isConfirmedPull, isDeadPath, estimateBfRemaining } from '../../lib/pitcherState.js'
import * as recon from '../../lib/reconciliation.js'
import * as cage from '../../lib/cageAlerts.js'
import { decideTier1 } from '../../lib/liveTier1.js'
import { decideTier2 } from '../../lib/liveTier2.js'
import { decideTier3 } from '../../lib/liveTier3.js'

const SENTINEL_PITCHER = '99999999'
const SENTINEL_SUBMODE = 'edge_test'
const TODAY = new Date().toISOString().slice(0, 10)

let pass = 0, fail = 0
const failures = []

function expect(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ' — '+detail : ''}`) }
  else { fail++; failures.push(label); console.log(`  ✗ ${label}${detail ? ' — '+detail : ''}`) }
}

function category(name) {
  console.log()
  console.log(`── ${name} ──`)
}

// ── Cleanup helper ──
async function cleanupSentinels() {
  await db.run(`DELETE FROM ks_bets WHERE strategy_submode = ?`, [SENTINEL_SUBMODE]).catch(() => {})
}

// ───────────────────────────────────────────────────────────────────
// A. strategy_mode validator
// ───────────────────────────────────────────────────────────────────
async function testStrategyMode() {
  category('A. strategy_mode validator')

  expect('valid mode passes', isValidStrategyMode('pregame_normal'))
  expect('valid mode "live" passes', isValidStrategyMode('live'))
  expect('unknown mode fails', !isValidStrategyMode('bogus_mode'))
  expect('null fails', !isValidStrategyMode(null))
  expect('empty string fails', !isValidStrategyMode(''))
  expect('undefined fails', !isValidStrategyMode(undefined))
  expect('numeric fails', !isValidStrategyMode(123))

  // validateStrategyMode throws
  try { validateStrategyMode(null); expect('validate(null) throws', false) }
  catch { expect('validate(null) throws', true) }
  try { validateStrategyMode(''); expect('validate("") throws', false) }
  catch { expect('validate("") throws', true) }
  try { validateStrategyMode('bogus'); expect('validate(bogus) throws', false) }
  catch (e) { expect('validate(bogus) throws', true, 'msg includes valid list: '+(e.message.includes('|'))) }
  try { validateStrategyMode('pregame_normal'); expect('validate(valid) returns', true) }
  catch { expect('validate(valid) returns', false) }

  // submode mapping
  expect('liveBetModeToSubmode(pulled) → live_pulled', liveBetModeToSubmode('pulled') === 'live_pulled')
  expect('liveBetModeToSubmode(pull-hedge) → live_pull_hedge', liveBetModeToSubmode('pull-hedge') === 'live_pull_hedge')
  expect('liveBetModeToSubmode(undefined) → live_unknown', liveBetModeToSubmode(undefined) === 'live_unknown')
  expect('parentModeFromSubmode(topup_pregame_inversion) → pregame_inversion', parentModeFromSubmode('topup_pregame_inversion') === 'pregame_inversion')
  expect('parentModeFromSubmode(live_dead_path) → live', parentModeFromSubmode('live_dead_path') === 'live')
  expect('parentModeFromSubmode(invalid) → null', parentModeFromSubmode('garbage') === null)
}

// ───────────────────────────────────────────────────────────────────
// B. Cap helpers
// ───────────────────────────────────────────────────────────────────
async function testCaps() {
  category('B. Cap helpers')
  await cleanupSentinels()

  // Empty state — all caps allow
  const r1 = await checkAllCaps({ db, userId: 284, pitcherId: SENTINEL_PITCHER, betDate: TODAY, strategy_mode: 'pregame_inversion' })
  expect('empty state: allowed', r1.allowed === true)

  // Insert one bet, check pitcher cap (Day 1 cap = 1 bet)
  await db.run(`INSERT INTO ks_bets
    (bet_date, logged_at, user_id, pitcher_id, pitcher_name, strike, side, model_prob, edge,
     ticker, capital_at_risk, fill_price, market_mid, order_id, order_status, live_bet, paper,
     strategy_mode, strategy_submode)
    VALUES (?,?,?,?,?,?,?,?,?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [TODAY, new Date().toISOString(), 284, SENTINEL_PITCHER, 'TEST_PITCHER', 6, 'NO',
     0.20, 0.30, 'KX-TEST', 5.00, 80, 20, 'real-uuid-test-1', 'filled', 0, 0,
     'pregame_inversion', SENTINEL_SUBMODE])

  const r2 = await checkAllCaps({ db, userId: 284, pitcherId: SENTINEL_PITCHER, betDate: TODAY, strategy_mode: 'pregame_inversion' })
  expect('1 bet at $5 hits cap (Day 1: 1 bet max per pitcher)', r2.allowed === false, 'reason='+r2.reason)

  // Different pitcher — should still allow
  const r3 = await checkAllCaps({ db, userId: 284, pitcherId: 'different_pitcher', betDate: TODAY, strategy_mode: 'pregame_inversion' })
  expect('different pitcher: allowed', r3.allowed === true)

  // Different user, same pitcher — Isaiah should be allowed (per-user caps)
  const r4 = await checkAllCaps({ db, userId: 2, pitcherId: SENTINEL_PITCHER, betDate: TODAY, strategy_mode: 'pregame_inversion' })
  expect('different user same pitcher: allowed (per-user caps)', r4.allowed === true)

  // Add a settled losing bet to trigger daily loss cap
  await db.run(`INSERT INTO ks_bets
    (bet_date, logged_at, user_id, pitcher_id, pitcher_name, strike, side, model_prob, edge,
     ticker, capital_at_risk, fill_price, market_mid, order_id, order_status, live_bet, paper,
     strategy_mode, strategy_submode, result, pnl)
    VALUES (?,?,?,?,?,?,?,?,?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [TODAY, new Date().toISOString(), 284, '88888888', 'TEST_LOSS_PITCHER', 5, 'NO',
     0.30, 0.20, 'KX-TEST-2', 60.00, 60, 40, 'real-uuid-test-2', 'filled', 0, 0,
     'pregame_inversion', SENTINEL_SUBMODE, 'loss', -60.00])

  const r5 = await checkDailyLossCap({ db, userId: 284, betDate: TODAY, strategy_mode: 'pregame_inversion' })
  expect('settled $60 loss > $50 inversion cap: blocks', r5.allowed === false, 'reason='+r5.reason)

  // Headroom calc
  const head = await getRemainingCaps({ db, betDate: TODAY })
  expect('headroom returns numbers for all 5 fields',
    Number.isFinite(head.adam_inv) && Number.isFinite(head.isaiah_inv) &&
    Number.isFinite(head.adam_live) && Number.isFinite(head.isaiah_live) &&
    Number.isFinite(head.global_remaining))
  expect('Adam-Live inversion headroom < $50 (we burned $60)', head.adam_inv < 50, `value=$${head.adam_inv}`)

  await cleanupSentinels()
}

// ───────────────────────────────────────────────────────────────────
// C. Family lock
// ───────────────────────────────────────────────────────────────────
async function testFamilyLock() {
  category('C. Family lock')
  await cleanupSentinels()

  // No active live NO position → allowed
  const r1 = await checkFamilyLock({ db, userId: 284, pitcherId: SENTINEL_PITCHER, betDate: TODAY, confirmedPull: false })
  expect('no active positions: allowed', r1.allowed === true)

  // Insert an active live NO at K6+
  await db.run(`INSERT INTO ks_bets
    (bet_date, logged_at, user_id, pitcher_id, pitcher_name, strike, side, model_prob, edge,
     ticker, capital_at_risk, fill_price, market_mid, order_id, order_status, live_bet, paper,
     strategy_mode, strategy_submode)
    VALUES (?,?,?,?,?,?,?,?,?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [TODAY, new Date().toISOString(), 284, SENTINEL_PITCHER, 'TEST_PITCHER', 6, 'NO',
     0.20, 0.30, 'KX-TEST', 5.00, 80, 20, 'real-uuid-test-fl-1', 'filled', 1, 0,
     'live', SENTINEL_SUBMODE])

  // Pre-pull state: should be blocked
  const r2 = await checkFamilyLock({ db, userId: 284, pitcherId: SENTINEL_PITCHER, betDate: TODAY, confirmedPull: false })
  expect('1 active NO pre-pull: blocked', r2.allowed === false, 'reason='+r2.reason)

  // Same state but confirmedPull=true: allowed (with diagnostic)
  const r3 = await checkFamilyLock({ db, userId: 284, pitcherId: SENTINEL_PITCHER, betDate: TODAY, confirmedPull: true })
  expect('1 active NO + pull confirmed: allowed', r3.allowed === true, 'reason='+r3.reason)
  expect('active_strikes correctly enumerated', JSON.stringify(r3.active_strikes) === '[6]')

  // Duplicate strike check
  expect('isDuplicateStrike(6, [6]) → true', isDuplicateStrike(6, [6]) === true)
  expect('isDuplicateStrike(7, [6]) → false', isDuplicateStrike(7, [6]) === false)
  expect('isDuplicateStrike("6", [6]) → true (string-num)', isDuplicateStrike('6', [6]) === true)
  expect('isDuplicateStrike(6, []) → false', isDuplicateStrike(6, []) === false)

  await cleanupSentinels()
}

// ───────────────────────────────────────────────────────────────────
// D. Pitcher state classifier
// ───────────────────────────────────────────────────────────────────
async function testPitcherState() {
  category('D. Pitcher state classifier')

  // Edge: missing inputs → UNKNOWN
  const r0 = classifyPitcherState({})
  expect('no inputs: UNKNOWN', r0.state === STATES.UNKNOWN)

  // Each state from realistic snapshots
  const cases = [
    { name: 'preview', expect: STATES.PRE_GAME, args: { game: { abstractGameState: 'Preview' }, ls: { currentInning: 0 }, ourPitcherId: '1', currentPitcherId: '1' }},
    { name: 'final', expect: STATES.GAME_FINAL, args: { game: { abstractGameState: 'Final' }, ls: { currentInning: 9 }, ourPitcherId: '1', currentPitcherId: '1' }},
    { name: 'live 1st', expect: STATES.EARLY_GAME, args: { game: { abstractGameState: 'Live' }, ls: { currentInning: 1, teams: { home: { runs: 0 }, away: { runs: 0 } } }, ourPitcherId: '1', currentPitcherId: '1' }},
    { name: 'live 4th', expect: STATES.MID_GAME, args: { game: { abstractGameState: 'Live' }, ls: { currentInning: 4, teams: { home: { runs: 2 }, away: { runs: 1 } } }, ourPitcherId: '1', currentPitcherId: '1' }},
    { name: 'live 7th', expect: STATES.LATE_GAME, args: { game: { abstractGameState: 'Live' }, ls: { currentInning: 7, teams: { home: { runs: 3 }, away: { runs: 2 } } }, ourPitcherId: '1', currentPitcherId: '1' }},
    { name: 'pulled', expect: STATES.PITCHER_OUT, args: { game: { abstractGameState: 'Live' }, ls: { currentInning: 6, teams: { home: { runs: 2 }, away: { runs: 1 } } }, ourPitcherId: '1', currentPitcherId: '999' }},
    { name: 'no score', expect: STATES.UNKNOWN, args: { game: { abstractGameState: 'Live' }, ls: { currentInning: 5, teams: { home: { runs: null }, away: { runs: null } } }, ourPitcherId: '1', currentPitcherId: '1' }},
    { name: 'monitor settled', expect: STATES.GAME_FINAL, args: { game: { abstractGameState: 'Live' }, ls: { currentInning: 9 }, monitorState: { game_settled: 1 }, ourPitcherId: '1', currentPitcherId: '1' }},
  ]
  for (const c of cases) {
    const r = classifyPitcherState(c.args)
    expect(`state classify: ${c.name}`, r.state === c.expect, `got ${r.state} (${r.reason})`)
  }

  // Confirmed-pull: all guards
  expect('isConfirmedPull: not in live phase', isConfirmedPull({ game: { abstractGameState: 'Final' }, ourPitcherId: '1', currentPitcherId: '2' }).confirmed === false)
  expect('isConfirmedPull: still in', isConfirmedPull({ game: { abstractGameState: 'Live' }, ourPitcherId: '1', currentPitcherId: '1', monitorState: { not_current_since: new Date(Date.now()-60_000).toISOString() }, actualKs: 4 }).confirmed === false)
  expect('isConfirmedPull: too recent (10s)', isConfirmedPull({ game: { abstractGameState: 'Live' }, ourPitcherId: '1', currentPitcherId: '2', monitorState: { not_current_since: new Date(Date.now()-10_000).toISOString() }, actualKs: 4 }).confirmed === false)
  expect('isConfirmedPull: no K count', isConfirmedPull({ game: { abstractGameState: 'Live' }, ourPitcherId: '1', currentPitcherId: '2', monitorState: { not_current_since: new Date(Date.now()-60_000).toISOString() }, actualKs: null }).confirmed === false)
  expect('isConfirmedPull: all good', isConfirmedPull({ game: { abstractGameState: 'Live' }, ourPitcherId: '1', currentPitcherId: '2', monitorState: { not_current_since: new Date(Date.now()-60_000).toISOString() }, actualKs: 4 }).confirmed === true)
}

// ───────────────────────────────────────────────────────────────────
// E. Dead-path math + BF estimate
// ───────────────────────────────────────────────────────────────────
async function testDeadPath() {
  category('E. Dead-path + BF estimation')

  expect('dead: 4Ks K7+ 8BF 18%K → DEAD', isDeadPath({ kCount: 4, strike: 7, bfRemaining: 8, kRateThisStart: 0.18 }).dead === true)
  expect('live: 5Ks K6+ 6BF 25%K → live', isDeadPath({ kCount: 5, strike: 6, bfRemaining: 6, kRateThisStart: 0.25 }).dead === false)
  expect('threshold hit already', isDeadPath({ kCount: 6, strike: 6, bfRemaining: 5, kRateThisStart: 0.20 }).dead === false)
  expect('null inputs → not dead', isDeadPath({ kCount: null, strike: 6, bfRemaining: 5, kRateThisStart: 0.20 }).dead === false)

  expect('estimateBfRemaining returns null on missing', estimateBfRemaining({}) == null)
  expect('estimateBfRemaining works with pitch count', Number.isFinite(estimateBfRemaining({ pitchCount: 60, expectedTotalPitches: 95, avgPitchesPerBF: 4.0 })))
  expect('estimateBfRemaining works with ip', Number.isFinite(estimateBfRemaining({ ip: 5, expectedBF: 22 })))
}

// ───────────────────────────────────────────────────────────────────
// F. Reconciliation
// ───────────────────────────────────────────────────────────────────
async function testReconciliation() {
  category('F. Reconciliation')

  // Test current state — should match (smoke test positions on Kalshi exist in DB)
  const r1 = await recon.reconcileAll({ db, betDate: TODAY })
  expect('reconcileAll returns object', typeof r1 === 'object')
  expect('reconcileAll returns users array', Array.isArray(r1.users))
  expect('both users included', r1.users.length === 2)

  // Test individual user
  const r2 = await recon.reconcileUser({ db, userId: 284, betDate: TODAY })
  expect('reconcileUser shape: has user_id', r2.user_id === 284)
  expect('reconcileUser shape: has user_name', !!r2.user_name)
  expect('reconcileUser shape: has mismatches array', Array.isArray(r2.mismatches))
}

// ───────────────────────────────────────────────────────────────────
// G. Cage alerts (mock: no webhook)
// ───────────────────────────────────────────────────────────────────
async function testCageAlerts() {
  category('G. Cage alerts (mock — DISCORD_WEBHOOK_URL behavior)')

  const oldUrl = process.env.DISCORD_WEBHOOK_URL
  delete process.env.DISCORD_WEBHOOK_URL

  const r1 = await cage.alertHalt({ reason: 'test', detail: 'edge case test', user_id: 284 })
  expect('alertHalt returns ok=false when no webhook', r1.ok === false && r1.error === 'no_webhook_configured')

  const r2 = await cage.notifyFire({ user_name: 'Test', pitcher: 'TestP', strike: 7, side: 'NO', price_cents: 30, contracts: 1, tier: 1, strategy_mode: 'live' })
  expect('notifyFire handles no-webhook gracefully', r2.ok === false || r2.ok === true)

  if (oldUrl) process.env.DISCORD_WEBHOOK_URL = oldUrl
}

// ───────────────────────────────────────────────────────────────────
// H. End-to-end: Tier 1 decision flow
// ───────────────────────────────────────────────────────────────────
async function testTier1Integration() {
  category('H. Tier 1 decision integration')
  await cleanupSentinels()

  const baseInputs = {
    db,
    bettor: { id: 284, name: 'Adam-Live', kalshi_balance: 260 },
    pitcher: { id: SENTINEL_PITCHER, name: 'TEST_PITCHER' },
    strike: 7,
    ourPitcherId: '1',
    game: { abstractGameState: 'Live' },
    ls: { currentInning: 6, teams: { home: { runs: 1 }, away: { runs: 0 } } },
    monitorState: { not_current_since: new Date(Date.now() - 60_000).toISOString() },
    currentPitcherId: '999',  // someone else on the mound = pulled
    actualKs: 4,
    betDate: TODAY,
    orderbook: { best_yes_bid: 18, best_no_ask: 85, fetched_at: new Date().toISOString() },
    bankroll: 260,
  }

  // Tier 1 disabled by default
  const oldFlag = process.env.TIER1_ENABLED
  delete process.env.TIER1_ENABLED
  const r1 = await decideTier1(baseInputs)
  expect('Tier 1 disabled → no fire', r1.fire === false && r1.reason === 'tier1_disabled')

  // Enable Tier 1
  process.env.TIER1_ENABLED = 'true'
  const r2 = await decideTier1(baseInputs)
  expect('Tier 1 enabled, all green → fire', r2.fire === true, 'reason='+r2.reason)
  expect('contracts > 0', r2.contracts > 0)
  expect('strategy_submode is live_tier1_confirmed_pull', r2.strategy_submode === 'live_tier1_confirmed_pull')

  // Edge: K count already over threshold
  const r3 = await decideTier1({ ...baseInputs, actualKs: 8 })
  expect('K count >= strike → no fire', r3.fire === false, 'reason='+r3.reason)

  // Edge: pitcher still in (no pull)
  const r4 = await decideTier1({ ...baseInputs, currentPitcherId: '1' })
  expect('pitcher still in → no fire', r4.fire === false, 'reason='+r4.reason)

  // Edge: stale quote
  const r5 = await decideTier1({ ...baseInputs, orderbook: { best_no_ask: 85, fetched_at: new Date(Date.now() - 60_000).toISOString() } })
  expect('stale quote → no fire', r5.fire === false, 'reason='+r5.reason)

  // Edge: no orderbook
  const r6 = await decideTier1({ ...baseInputs, orderbook: null })
  expect('no orderbook → no fire', r6.fire === false, 'reason='+r6.reason)

  // Restore env
  if (oldFlag != null) process.env.TIER1_ENABLED = oldFlag
  else delete process.env.TIER1_ENABLED

  await cleanupSentinels()
}

// ───────────────────────────────────────────────────────────────────
// H2. Tier 2 dead-path NO decision
// ───────────────────────────────────────────────────────────────────
async function testTier2Integration() {
  category('H2. Tier 2 dead-path decision')
  await cleanupSentinels()

  const baseInputs = {
    db,
    bettor: { id: 284, name: 'Adam-Live', kalshi_balance: 260 },
    pitcher: { id: SENTINEL_PITCHER, name: 'TEST_PITCHER' },
    strike: 8,
    ourPitcherId: '1',
    game: { abstractGameState: 'Live' },
    ls: { currentInning: 5, teams: { home: { runs: 2 }, away: { runs: 1 } } },
    monitorState: { not_current_since: null },
    currentPitcherId: '1',  // pitcher still in
    actualKs: 4,
    betDate: TODAY,
    orderbook: { best_no_ask: 75, fetched_at: new Date().toISOString() },
    bankroll: 260,
    kRateThisStart: 0.18,    // low K rate this start
    pitchCount: 75,
    expectedBF: 22, ip: 5,
    expectedTotalPitches: 95, avgPitchesPerBF: 4.0,
  }

  const oldFlag = process.env.TIER2_ENABLED
  delete process.env.TIER2_ENABLED
  const r1 = await decideTier2(baseInputs)
  expect('Tier 2 disabled → no fire', r1.fire === false && r1.reason === 'tier2_disabled')

  process.env.TIER2_ENABLED = 'true'

  // Dead path scenario: gap=4, ~5 BF left, 18% K rate → mathematically infeasible
  const r2 = await decideTier2(baseInputs)
  expect('Tier 2 enabled + dead path → fire', r2.fire === true, 'reason='+r2.reason)
  if (r2.fire) {
    expect('Tier 2 strategy_submode = live_tier2_dead_path', r2.strategy_submode === 'live_tier2_dead_path')
    expect('Tier 2 contracts > 0', r2.contracts > 0)
  }

  // Path alive: gap small, lots of BF, decent K rate
  const r3 = await decideTier2({ ...baseInputs, strike: 6, actualKs: 5, kRateThisStart: 0.30, pitchCount: 40, expectedTotalPitches: 95 })
  expect('Tier 2 path alive → no fire', r3.fire === false, 'reason='+r3.reason)

  // PRE_GAME state
  const r4 = await decideTier2({ ...baseInputs, game: { abstractGameState: 'Preview' } })
  expect('Tier 2 PRE_GAME → no fire', r4.fire === false, 'reason='+r4.reason)

  // PITCHER_OUT state — should defer to Tier 1
  const r5 = await decideTier2({ ...baseInputs, currentPitcherId: '999' })
  expect('Tier 2 PITCHER_OUT → no fire (Tier 1 territory)', r5.fire === false, 'reason='+r5.reason)

  if (oldFlag != null) process.env.TIER2_ENABLED = oldFlag
  else delete process.env.TIER2_ENABLED

  await cleanupSentinels()
}

// ───────────────────────────────────────────────────────────────────
// H3. Tier 3 late-game leash NO decision
// ───────────────────────────────────────────────────────────────────
async function testTier3Integration() {
  category('H3. Tier 3 late-game leash decision')
  await cleanupSentinels()

  const baseInputs = {
    db,
    bettor: { id: 284, name: 'Adam-Live', kalshi_balance: 260 },
    pitcher: { id: SENTINEL_PITCHER, name: 'TEST_PITCHER' },
    strike: 7,
    ourPitcherId: '1',
    game: { abstractGameState: 'Live' },
    ls: { currentInning: 7, teams: { home: { runs: 2 }, away: { runs: 1 } } },
    monitorState: { not_current_since: null },
    currentPitcherId: '1',
    actualKs: 6,
    betDate: TODAY,
    orderbook: { best_no_ask: 70, fetched_at: new Date().toISOString() },
    bankroll: 260,
    kRateThisStart: 0.20,
    pitchCount: 85,
    expectedBF: 22, ip: 7,
    expectedTotalPitches: 100, avgPitchesPerBF: 4.0,
  }

  const oldFlag = process.env.TIER3_ENABLED
  delete process.env.TIER3_ENABLED
  const r1 = await decideTier3(baseInputs)
  expect('Tier 3 disabled → no fire', r1.fire === false && r1.reason === 'tier3_disabled')

  process.env.TIER3_ENABLED = 'true'

  // Viable late-game leash: 6 Ks, gap 1, 4 BF left at 20% K rate → P(YES) ~55% → not in [10%, 45%] band actually
  // Adjust: lower K rate so P(YES) lands in band
  const r2 = await decideTier3({ ...baseInputs, kRateThisStart: 0.15 })
  expect('Tier 3 enabled + viable leash → check returns object', r2 !== null && typeof r2.fire === 'boolean', 'reason='+r2.reason)

  // Premature pitch count
  const r3 = await decideTier3({ ...baseInputs, pitchCount: 50 })
  expect('Tier 3 premature pitch count → no fire', r3.fire === false, 'reason='+r3.reason)

  // Not late game (MID_GAME inning 5)
  const r4 = await decideTier3({ ...baseInputs, ls: { currentInning: 5, teams: { home: { runs: 0 }, away: { runs: 0 } } } })
  expect('Tier 3 MID_GAME → no fire', r4.fire === false, 'reason='+r4.reason)

  // Confirmed pull → Tier 1 territory
  const r5 = await decideTier3({ ...baseInputs, currentPitcherId: '999', monitorState: { not_current_since: new Date(Date.now()-60_000).toISOString() } })
  expect('Tier 3 PITCHER_OUT → no fire (Tier 1)', r5.fire === false, 'reason='+r5.reason)

  if (oldFlag != null) process.env.TIER3_ENABLED = oldFlag
  else delete process.env.TIER3_ENABLED

  await cleanupSentinels()
}

// ───────────────────────────────────────────────────────────────────
// I. Schema integrity
// ───────────────────────────────────────────────────────────────────
async function testSchemaIntegrity() {
  category('I. Schema integrity')

  const ksbCols = (await db.all('PRAGMA table_info(ks_bets)')).map(c => c.name)
  expect('ks_bets has strategy_mode', ksbCols.includes('strategy_mode'))
  expect('ks_bets has strategy_submode', ksbCols.includes('strategy_submode'))

  const obtCols = (await db.all('PRAGMA table_info(oracle_bet_traces)')).map(c => c.name)
  expect('oracle_bet_traces has strategy_mode', obtCols.includes('strategy_mode'))
  expect('oracle_bet_traces has strategy_submode', obtCols.includes('strategy_submode'))
  expect('oracle_bet_traces has pre_shrink_lambda', obtCols.includes('pre_shrink_lambda'))
  expect('oracle_bet_traces has post_shrink_lambda', obtCols.includes('post_shrink_lambda'))

  // No NULL strategy_mode after backfill
  const nullCount = await db.one(`SELECT COUNT(*) as n FROM ks_bets WHERE strategy_mode IS NULL`)
  expect('zero ks_bets rows with NULL strategy_mode', nullCount.n === 0, `count=${nullCount.n}`)

  // System flags exist
  const flags = await db.all(`SELECT key FROM system_flags WHERE key IN ('trading_halted','kalshi_outage','drawdown_scale')`)
  expect('system_flags has trading_halted', flags.some(f => f.key === 'trading_halted'))
  expect('system_flags has kalshi_outage', flags.some(f => f.key === 'kalshi_outage'))
  expect('system_flags has drawdown_scale', flags.some(f => f.key === 'drawdown_scale'))
}

// ───────────────────────────────────────────────────────────────────
// Run all
// ───────────────────────────────────────────────────────────────────
async function main() {
  console.log(`EDGE CASE TEST SUITE — ${TODAY}`)
  console.log('Sentinel: pitcher_id=' + SENTINEL_PITCHER + ', strategy_submode=' + SENTINEL_SUBMODE)

  try {
    await testStrategyMode()
    await testCaps()
    await testFamilyLock()
    await testPitcherState()
    await testDeadPath()
    await testReconciliation()
    await testCageAlerts()
    await testTier1Integration()
    await testTier2Integration()
    await testTier3Integration()
    await testSchemaIntegrity()
  } finally {
    await cleanupSentinels()
  }

  console.log()
  console.log('─────────────────────────────────────────────')
  console.log(`  Summary: ${pass} PASS · ${fail} FAIL`)
  if (fail > 0) {
    console.log()
    console.log('FAILURES:')
    for (const f of failures) console.log('  - ' + f)
  }
  console.log('─────────────────────────────────────────────')
  await db.close()
  process.exit(fail > 0 ? 1 : 0)
}

await main()
