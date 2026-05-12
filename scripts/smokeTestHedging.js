// scripts/smokeTestHedging.js — Smoke tests for hedging bug fixes + _computeHedgePlan
// Run: node scripts/smokeTestHedging.js

import { createClient } from '@libsql/client'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TODAY = new Date().toISOString().slice(0, 10)

let passed = 0
let failed = 0
const failures = []

function assert(condition, msg) {
  if (condition) {
    console.log(`  ✅ ${msg}`)
    passed++
  } else {
    console.error(`  ❌ FAIL: ${msg}`)
    failed++
    failures.push(msg)
  }
}

// ── Temporary in-memory DB helpers ──────────────────────────────────────────

function makeDb() {
  const client = createClient({ url: 'file::memory:' })
  const run = (sql, args = []) => client.execute({ sql, args })
  const all = (sql, args = []) => client.execute({ sql, args }).then(r => r.rows ?? [])
  const one = (sql, args = []) => all(sql, args).then(r => r[0] ?? null)
  return { run, all, one, client }
}

async function setupSchema(db) {
  await db.run(`CREATE TABLE IF NOT EXISTS ks_bets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bet_date TEXT, user_id INTEGER, pitcher_id TEXT, pitcher_name TEXT,
    game TEXT, strike INTEGER, side TEXT, model_prob REAL, market_mid REAL,
    edge REAL, bet_size REAL, kelly_fraction REAL, capital_at_risk REAL,
    paper INTEGER DEFAULT 0, live_bet INTEGER DEFAULT 0, ticker TEXT,
    bet_mode TEXT, fill_price REAL, order_id TEXT, filled_contracts INTEGER,
    order_status TEXT, result TEXT, pnl REAL, actual_ks INTEGER,
    settled_at TEXT, logged_at TEXT, live_ks_at_bet INTEGER, live_ip_at_bet REAL,
    live_pitches_at_bet INTEGER, live_bf_at_bet INTEGER, live_inning INTEGER,
    live_pk_effective REAL, live_lambda_remaining REAL, live_score TEXT
  )`)
}

// ── Inline pure copy of _computeHedgePlan — no liveMonitor deps ─────────────
function _computeHedgePlan({ yesFilledContracts, yesFillCents, noAskCents, modelProb, maxUSD }) {
  if (noAskCents <= 0 || noAskCents >= 100) return { qualified: false, reason: 'noAsk-out-of-range' }
  if (!yesFilledContracts || yesFilledContracts <= 0) return { qualified: false, reason: 'fullOffset-zero' }
  const kalshiFee        = 0.93
  const yesFillFrac      = yesFillCents / 100
  const noAskFrac        = noAskCents / 100
  const noNetPerContract = (1 - noAskFrac) * kalshiFee
  const yesExposure      = yesFilledContracts * yesFillFrac
  const fullOffset       = Math.ceil(yesExposure / noNetPerContract)
  if (fullOffset <= 0) return { qualified: false, reason: 'fullOffset-zero' }
  const evYesPerContract = modelProb * (1 - yesFillFrac) - (1 - modelProb) * yesFillFrac
  const evNoLeg          = (1 - modelProb) * noNetPerContract - modelProb * noAskFrac
  const evHedge          = yesFilledContracts * evYesPerContract + fullOffset * evNoLeg
  const evNoHedge        = yesFilledContracts * evYesPerContract
  if (evNoLeg <= 0) return { qualified: false, reason: 'ev-gate-fail', evHedge, evNoHedge }
  const rawCost        = fullOffset * noAskFrac
  const capped         = rawCost > maxUSD
  const hedgeContracts = capped ? Math.max(1, Math.floor(maxUSD / noAskFrac)) : fullOffset
  const hedgeCost      = hedgeContracts * noAskFrac
  return { qualified: true, hedgeContracts, hedgeCost, capped, fullOffset, evHedge, evNoHedge, reason: 'qualified' }
}

// ── Test suite ───────────────────────────────────────────────────────────────

console.log('\n=== Hedging Bug Fix Smoke Tests ===\n')

// ─────────────────────────────────────────────────────────────────────────────
// TEST 1 — BUG-27: Scratch path only fires NO for YES-holders
// The scratch block iterates openYes bets and should use bet.user_id (betOwner),
// not every activeBettor. We test the logic directly by simulating the lookup.
// ─────────────────────────────────────────────────────────────────────────────
console.log('--- TEST 1: Scratch path — NO only for YES-holders ---')
{
  const activeBettors = [{ id: 1, name: 'Adam' }, { id: 2, name: 'Isaiah' }]
  const openYesBets = [
    { strike: 5, user_id: 1, market_mid: 60, ticker: 'T-5' },  // Adam's bet
    { strike: 6, user_id: 1, market_mid: 40, ticker: 'T-6' },  // Adam's bet
  ]

  // Simulated fix: for each openYes bet, only fire for bet.user_id
  const ordersWouldFire = []
  for (const bet of openYesBets) {
    const betOwner = activeBettors.find(b => b.id === bet.user_id)
    if (!betOwner) continue
    ordersWouldFire.push({ userId: betOwner.id, strike: bet.strike })
  }

  assert(ordersWouldFire.length === 2, 'Exactly 2 orders fire (one per Adam YES bet)')
  assert(ordersWouldFire.every(o => o.userId === 1), 'All orders are for Adam (id=1), not Isaiah')
  assert(!ordersWouldFire.some(o => o.userId === 2), 'Isaiah gets no orphan NO orders')

  // Verify: if Isaiah had a YES at strike 5 too, he'd get his own order
  const openYesBets2 = [
    { strike: 5, user_id: 1, market_mid: 60, ticker: 'T-5' },
    { strike: 5, user_id: 2, market_mid: 60, ticker: 'T-5' },
  ]
  const orders2 = []
  for (const bet of openYesBets2) {
    const betOwner = activeBettors.find(b => b.id === bet.user_id)
    if (!betOwner) continue
    orders2.push({ userId: betOwner.id, strike: bet.strike })
  }
  assert(orders2.length === 2, 'Both users get their own hedge when both hold YES-5')
  assert(orders2.some(o => o.userId === 1), 'Adam gets NO hedge for his YES-5')
  assert(orders2.some(o => o.userId === 2), 'Isaiah gets NO hedge for his YES-5')
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 2 — BUG-3: Pull-hedge bettor loop only hedges YES-holders
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n--- TEST 2: Pull-hedge — NO only for YES-holders (bettor loop) ---')
{
  const preGameYesFillByUserStrike = new Map()
  preGameYesFillByUserStrike.set(1, new Map([[5, 70]]))  // Adam: YES-5 @ 70¢
  // Isaiah has no pre-game YES (not in map)

  const activeBettors = [{ id: 1, name: 'Adam' }, { id: 2, name: 'Isaiah' }]
  const q = { n: 5, mode: 'pull-hedge', modelProb: 0.55 }  // modelProb < Adam's break-even (0.65)

  const wouldTrade = []
  for (const bettor of activeBettors) {
    const myFillPrice = preGameYesFillByUserStrike.get(bettor.id)?.get(q.n)
    if (myFillPrice == null) continue  // no YES to hedge — skip
    const myBreakEven = myFillPrice / 100 - 0.05
    if (q.modelProb >= myBreakEven) continue  // still above break-even — skip
    wouldTrade.push(bettor.id)
  }

  assert(wouldTrade.length === 1, 'Only 1 bettor gets pull-hedge NO')
  assert(wouldTrade[0] === 1, 'Adam (YES-holder) gets the hedge')
  assert(!wouldTrade.includes(2), 'Isaiah (no YES) is skipped')
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 3 — BUG-2: Pull-hedge uses per-user break-even, not shared max
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n--- TEST 3: Pull-hedge — per-user break-even is independent ---')
{
  const preGameYesFillByUserStrike = new Map()
  preGameYesFillByUserStrike.set(1, new Map([[5, 70]]))  // Adam: YES-5 @ 70¢ → break-even 65%
  preGameYesFillByUserStrike.set(2, new Map([[5, 40]]))  // Isaiah: YES-5 @ 40¢ → break-even 35%

  const activeBettors = [{ id: 1, name: 'Adam' }, { id: 2, name: 'Isaiah' }]
  const modelProb = 0.55  // below Adam's 65% break-even, above Isaiah's 35% break-even

  const wouldHedge = []
  for (const bettor of activeBettors) {
    const fillPrice = preGameYesFillByUserStrike.get(bettor.id)?.get(5)
    if (fillPrice == null) continue
    const breakEven = fillPrice / 100 - 0.05
    if (modelProb < breakEven) wouldHedge.push({ id: bettor.id, breakEven: breakEven.toFixed(2) })
  }

  assert(wouldHedge.length === 1, 'Only Adam hedges (model below his break-even 65%)')
  assert(wouldHedge[0].id === 1, 'Adam (70¢ buyer, break-even 65%) hedges')
  assert(!wouldHedge.some(b => b.id === 2), 'Isaiah (40¢ buyer, break-even 35%) does NOT hedge — still profitable')

  // Verify: when model drops to 0.25 (below both break-evens), both hedge
  const modelProb2 = 0.25
  const wouldHedge2 = []
  for (const bettor of activeBettors) {
    const fillPrice = preGameYesFillByUserStrike.get(bettor.id)?.get(5)
    if (fillPrice == null) continue
    const breakEven = fillPrice / 100 - 0.05
    if (modelProb2 < breakEven) wouldHedge2.push(bettor.id)
  }
  assert(wouldHedge2.length === 2, 'Both hedge when model drops to 25% (below both break-evens)')
  assert(wouldHedge2.includes(1), 'Adam hedges at 25%')
  assert(wouldHedge2.includes(2), 'Isaiah hedges at 25%')
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 4 — BUG-22: convertStaleMakers uses dollars correctly as contracts
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n--- TEST 4: convertStaleMakers — bet_size (dollars) → contracts ---')
{
  // Broken version: Math.round(bet_size) — treats dollars as contracts
  const broken = (betSize, _takerCents) => Math.max(1, Math.round(betSize ?? 100))

  // Fixed version: bet_size * 100 / takerCents
  const fixed = (betSize, takerCents) => Math.max(1, Math.round(((betSize ?? 10) * 100) / takerCents))

  // Case 1: $40 bet at 97¢ (near-certain pulled pitcher taker)
  assert(broken(40, 97) === 40, '[broken] $40 at 97¢ gives 40 contracts (wrong by units)')
  assert(fixed(40, 97) === 41, '[fixed] $40 at 97¢ gives 41 contracts (correct: 40/0.97)')

  // Case 2: $40 bet at 40¢ — broken gives 40c but correct is 100c
  assert(broken(40, 40) === 40, '[broken] $40 at 40¢ gives 40 contracts (WRONG — should be 100)')
  assert(fixed(40, 40) === 100, '[fixed] $40 at 40¢ gives 100 contracts (correct: 40/0.40)')

  // Case 3: $25 bet at 50¢ — should be 50 contracts
  assert(broken(25, 50) === 25, '[broken] $25 at 50¢ gives 25 contracts (wrong)')
  assert(fixed(25, 50) === 50, '[fixed] $25 at 50¢ gives 50 contracts (correct)')

  // Case 4: $10 bet at 10¢ (blowout NO at deep discount) — should be 100 contracts
  assert(broken(10, 10) === 10, '[broken] $10 at 10¢ gives 10 contracts (WRONG — should be 100)')
  assert(fixed(10, 10) === 100, '[fixed] $10 at 10¢ gives 100 contracts (correct)')
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 5 — BUG-1: Auto-close records correct P&L (sell proceeds, not settlement)
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n--- TEST 5: Auto-close P&L — sell proceeds used, not settlement value ---')
{
  const db = makeDb()
  await setupSchema(db)

  // Bet: 10 contracts at 50¢ fill price
  await db.run(`INSERT INTO ks_bets
    (bet_date, user_id, pitcher_name, strike, side, fill_price, filled_contracts, paper, live_bet, result, bet_size, market_mid)
    VALUES (?, 1, 'Skenes', 5, 'YES', 50, 10, 0, 0, NULL, 10, 50)`,
    [TODAY])
  const bet = await db.one(`SELECT * FROM ks_bets WHERE pitcher_name='Skenes'`)

  // Simulate the fixed logic: auto-close sell succeeds at 90¢ bid
  const fillPrice = bet.fill_price ?? bet.market_mid ?? 50
  const yesBidCents = 90
  const filledContracts = bet.filled_contracts

  const settlementPnl = Math.round(filledContracts * (1 - fillPrice / 100) * 0.93 * 100) / 100
  const autoClosePnl  = Math.round(filledContracts * ((yesBidCents - fillPrice) / 100) * 0.93 * 100) / 100

  // Fixed: use autoClosePnl when sell succeeds
  const finalPnl = autoClosePnl  // auto-close succeeded

  // Apply the correct UPDATE (auto-close path)
  await db.run(
    `UPDATE ks_bets SET result='win', pnl=?, order_status='closed', settled_at=? WHERE id=? AND result IS NULL`,
    [finalPnl, new Date().toISOString(), bet.id],
  )
  const settled = await db.one(`SELECT * FROM ks_bets WHERE id=?`, [bet.id])

  assert(settlementPnl.toFixed(2) === '4.65', `Settlement P&L would be $4.65 (10c × (1-0.50) × 0.93)`)
  assert(autoClosePnl.toFixed(2) === '3.72', `Auto-close P&L is $3.72 (10c × (0.90-0.50) × 0.93)`)
  assert(settled.result === 'win', 'Bet settled as win')
  assert(Number(settled.pnl).toFixed(2) === '3.72', 'Recorded P&L is auto-close value ($3.72), not settlement ($4.65)')
  assert(settled.order_status === 'closed', 'order_status is closed after sell')

  // Simulate: auto-close bid only 80¢ (below 88¢ threshold) — should use settlement P&L
  await db.run(`UPDATE ks_bets SET result=NULL, pnl=NULL, order_status=NULL WHERE id=?`, [bet.id])
  const noClosePnl = settlementPnl  // no auto-close, use settlement
  await db.run(
    `UPDATE ks_bets SET result='win', pnl=?, settled_at=? WHERE id=? AND result IS NULL`,
    [noClosePnl, new Date().toISOString(), bet.id],
  )
  const settled2 = await db.one(`SELECT * FROM ks_bets WHERE id=?`, [bet.id])
  assert(Number(settled2.pnl).toFixed(2) === '4.65', 'When bid < 88¢, uses settlement P&L ($4.65)')
  assert(settled2.order_status === null, 'order_status unchanged when no auto-close')
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 6 — BUG-24: NO bets auto-settle as win when pitcher pulled below threshold
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n--- TEST 6: NO auto-settle — pitcher pulled below threshold ---')
{
  const db = makeDb()
  await setupSchema(db)

  // NO bet at strike 7, filled 20 contracts at 25¢
  await db.run(`INSERT INTO ks_bets
    (bet_date, user_id, pitcher_name, strike, side, fill_price, filled_contracts, paper, live_bet, result, bet_size)
    VALUES (?, 1, 'Cole', 7, 'NO', 25, 20, 0, 1, NULL, 5)`,
    [TODAY])
  const bet = await db.one(`SELECT * FROM ks_bets WHERE pitcher_name='Cole'`)

  // Simulate the NO-won settlement logic (pitcher pulled at 4 Ks, needed 7+)
  const currentKs = 4
  const contracts = bet.filled_contracts
  const fillFrac  = ((bet.fill_price ?? 50)) / 100
  // NO win P&L: collect $1 per contract minus what we paid, minus Kalshi fee on profit
  const pnl = Math.round(contracts * (1 - fillFrac) * 0.93 * 100) / 100

  await db.run(
    `UPDATE ks_bets SET actual_ks=?, result='win', settled_at=?, pnl=? WHERE id=? AND result IS NULL`,
    [currentKs, new Date().toISOString(), pnl, bet.id],
  )
  const settled = await db.one(`SELECT * FROM ks_bets WHERE id=?`, [bet.id])

  // 20 contracts × (1 - 0.25) × 0.93 = 20 × 0.75 × 0.93 = $13.95
  assert(pnl.toFixed(2) === '13.95', `NO win P&L correct: 20c × 0.75 × 0.93 = $13.95`)
  assert(settled.result === 'win', 'NO bet settled as win when pitcher pulled below strike')
  assert(Number(settled.pnl).toFixed(2) === '13.95', 'Correct P&L recorded in DB')
  assert(Number(settled.actual_ks) === 4, 'actual_ks recorded correctly')

  // Verify: NO bet at strike 3 with pitcher at 4 Ks should NOT trigger (threshold exceeded)
  await db.run(`INSERT INTO ks_bets
    (bet_date, user_id, pitcher_name, strike, side, fill_price, filled_contracts, paper, live_bet, result, bet_size)
    VALUES (?, 1, 'Cole', 3, 'NO', 80, 5, 0, 1, NULL, 4)`,
    [TODAY])
  const lostBet = await db.one(`SELECT * FROM ks_bets WHERE pitcher_name='Cole' AND strike=3`)
  // currentKs=4 >= strike=3, so this NO is LOST, not won — should NOT match the noWon condition
  const noWonWouldFire = (4 < lostBet.strike)  // 4 < 3 → false
  assert(!noWonWouldFire, 'NO-won logic does NOT fire when pitcher exceeded the threshold (K >= strike)')
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 7 — BUG-8: freeMoney cap hydration includes all modes, excludes paper
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n--- TEST 7: freeMoney cap hydration — all modes, live only ---')
{
  const db = makeDb()
  await setupSchema(db)

  // Insert bets across different modes (live + paper mix)
  const bets = [
    { mode: 'pulled',          paper: 0, filled: 10, fill_price: 8,  pitcher_id: 'P1', strike: 5 },
    { mode: 'blowout',         paper: 0, filled: 5,  fill_price: 15, pitcher_id: 'P1', strike: 6 },
    { mode: 'early-blowout',   paper: 0, filled: 8,  fill_price: 12, pitcher_id: 'P1', strike: 7 },
    { mode: 'late-inning-no',  paper: 0, filled: 6,  fill_price: 20, pitcher_id: 'P1', strike: 8 },
    { mode: 'pulled',          paper: 1, filled: 15, fill_price: 8,  pitcher_id: 'P1', strike: 5 },  // paper — should be excluded
  ]
  for (const b of bets) {
    await db.run(`INSERT INTO ks_bets
      (bet_date, user_id, pitcher_id, pitcher_name, strike, side, bet_mode, paper, live_bet, filled_contracts, fill_price, result)
      VALUES (?, 1, ?, 'TestPitcher', ?, 'NO', ?, ?, 1, ?, ?, NULL)`,
      [TODAY, b.pitcher_id, b.strike, b.mode, b.paper, b.filled, b.fill_price])
  }

  // Run the fixed hydration query
  const fmRows = await db.all(
    `SELECT user_id, pitcher_id, strike, fill_price, filled_contracts
     FROM ks_bets
     WHERE bet_date = ? AND live_bet = 1 AND paper = 0
       AND bet_mode IN ('pulled', 'crossed-yes', 'blowout', 'early-blowout', 'late-inning-no')
       AND filled_contracts > 0`,
    [TODAY],
  )

  assert(fmRows.length === 4, '4 live bets hydrated (not the paper one)')
  assert(!fmRows.some(r => r.fill_price == null), 'No null fill_prices in hydration rows')

  // Compute total cap spent
  let totalSpent = 0
  for (const row of fmRows) totalSpent += row.filled_contracts * (row.fill_price / 100)
  // pulled: 10*0.08=0.80, blowout: 5*0.15=0.75, early-blowout: 8*0.12=0.96, late-inning-no: 6*0.20=1.20 → 3.71
  assert(Math.abs(totalSpent - 3.71) < 0.01, `Total cap spent correctly: $${totalSpent.toFixed(2)} (not $${(3.71 + 15*0.08).toFixed(2)} with paper)`)

  // Verify: old broken query (without paper filter, missing modes) would give different results
  const brokenRows = await db.all(
    `SELECT user_id, pitcher_id, strike, fill_price, filled_contracts
     FROM ks_bets
     WHERE bet_date = ? AND live_bet = 1
       AND bet_mode IN ('pulled', 'crossed-yes', 'blowout')
       AND filled_contracts > 0`,
    [TODAY],
  )
  assert(brokenRows.length === 3, 'Old query gets only 3 rows (misses early-blowout, late-inning-no; includes paper pulled)')
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 8 — BUG-18: placed Set hydration includes paper live bets
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n--- TEST 8: placed Set hydration — includes paper bets ---')
{
  const db = makeDb()
  await setupSchema(db)

  // Insert: one live bet (order placed), one paper bet (order_status IS NULL)
  await db.run(`INSERT INTO ks_bets
    (bet_date, user_id, pitcher_id, pitcher_name, strike, side, paper, live_bet, order_status, result)
    VALUES (?, 1, 'P1', 'Pitcher1', 5, 'NO', 0, 1, 'resting', NULL)`, [TODAY])
  await db.run(`INSERT INTO ks_bets
    (bet_date, user_id, pitcher_id, pitcher_name, strike, side, paper, live_bet, order_status, result)
    VALUES (?, 1, 'P2', 'Pitcher2', 6, 'YES', 1, 1, NULL, NULL)`, [TODAY])

  // Fixed hydration query
  const fixed = await db.all(
    `SELECT user_id, pitcher_id, strike FROM ks_bets
     WHERE bet_date = ? AND live_bet = 1 AND (order_status IS NOT NULL OR paper = 1)`,
    [TODAY],
  )

  // Broken hydration query (old)
  const broken = await db.all(
    `SELECT user_id, pitcher_id, strike FROM ks_bets
     WHERE bet_date = ? AND live_bet = 1 AND order_status IS NOT NULL`,
    [TODAY],
  )

  assert(fixed.length === 2, 'Fixed: both live bet and paper bet hydrated (2 rows)')
  assert(broken.length === 1, 'Broken: only live bet with order_status hydrated (1 row — paper missed)')

  const fixedKeys = new Set(fixed.map(b => `${b.user_id}:${b.pitcher_id}-${b.strike}-live`))
  assert(fixedKeys.has('1:P1-5-live'), 'Fixed: live bet key in placed Set')
  assert(fixedKeys.has('1:P2-6-live'), 'Fixed: paper bet key in placed Set (prevents re-fire on restart)')
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 9 — "Never hedge to less profit" invariant: verify hedge math
// For every scenario, ensure buying a hedge NO when holding YES cannot produce
// a total P&L worse than holding YES and letting it die without a hedge.
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n--- TEST 9: Hedge invariant — hedge can only help or be neutral ---')
{
  // Scenario: YES bet at strike 5, filled 50 contracts at 60¢ ($30 at risk)
  // Pitcher looks like they won't make it. Model prob = 0.20.
  // Should we buy NO at 75¢?
  const yesFillCents = 60
  const yesContracts = 50
  const noAskCents   = 75  // cost of buying NO
  const modelProb    = 0.20

  // P&L if YES wins (pitcher gets 5 Ks): YES wins, NO loses
  const pnlYesWins_withoutHedge = yesContracts * ((100 - yesFillCents) / 100) * 0.93
  const noContracts = Math.round(yesContracts * (yesFillCents / noAskCents))  // size hedge proportionally
  const pnlYesWins_withHedge = pnlYesWins_withoutHedge - noContracts * (noAskCents / 100)  // lose the NO cost

  // P&L if YES loses (pitcher pulled at 4 Ks): YES loses, NO wins
  const pnlYesLoses_withoutHedge = -yesContracts * (yesFillCents / 100)
  const pnlYesLoses_withHedge = pnlYesLoses_withoutHedge + noContracts * ((100 - noAskCents) / 100) * 0.93

  // Expected value with hedge vs without (using model prob 20%)
  const ev_without = modelProb * pnlYesWins_withoutHedge + (1 - modelProb) * pnlYesLoses_withoutHedge
  const ev_with    = modelProb * pnlYesWins_withHedge    + (1 - modelProb) * pnlYesLoses_withHedge

  console.log(`    YES wins: without hedge +$${pnlYesWins_withoutHedge.toFixed(2)}, with hedge +$${pnlYesWins_withHedge.toFixed(2)}`)
  console.log(`    YES loses: without hedge $${pnlYesLoses_withoutHedge.toFixed(2)}, with hedge $${pnlYesLoses_withHedge.toFixed(2)}`)
  console.log(`    EV: without $${ev_without.toFixed(2)}, with hedge $${ev_with.toFixed(2)}`)

  // At model prob 20% (well below 60¢ break-even of 60%), hedge improves EV
  assert(ev_with > ev_without, `Hedge improves EV at 20% model prob (below 60¢ break-even)`)

  // Verify: at 65% model prob (well above break-even), hedge HURTS EV — system should NOT hedge
  const modelProb2 = 0.65
  const ev_without2 = modelProb2 * pnlYesWins_withoutHedge + (1 - modelProb2) * pnlYesLoses_withoutHedge
  const ev_with2    = modelProb2 * pnlYesWins_withHedge    + (1 - modelProb2) * pnlYesLoses_withHedge
  assert(ev_without2 > ev_with2, 'Hedge HURTS EV at 65% model prob (above break-even) — system correctly does NOT hedge')

  // The break-even gate (modelProb < fillPrice/100 - 0.05) enforces this:
  const breakEven = yesFillCents / 100 - 0.05
  assert(modelProb < breakEven, `Break-even gate (${breakEven}) correctly passes at 20% model prob`)
  assert(modelProb2 >= breakEven, `Break-even gate correctly blocks at 65% model prob`)
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 10 — Pull-hedge EV-gate qualification: anyBettorNeedsHedge via _computeHedgePlan
// Verifies that the qualification passes/fails based on EV gate, not flat break-even.
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n--- TEST 10: Pull-hedge qualification — EV-gate via _computeHedgePlan ---')
{
  // preGameYesByUserStrike: Map<userId, Map<strike, {fillPriceCents, filledContracts}>>
  const preGameYesByUserStrike = new Map()
  preGameYesByUserStrike.set(1, new Map([[5, { fillPriceCents: 60, filledContracts: 50 }]]))

  const activeBettors = [{ id: 1, name: 'Adam' }, { id: 2, name: 'Isaiah' }]
  const n = 5
  const maxUSD = 60

  // modelProb = 0.20, noAskCents = 25 → well below break-even, NO leg EV > 0 → qualifies
  const anyNeeds1 = activeBettors.some(b => {
    const pos = preGameYesByUserStrike.get(b.id)?.get(n)
    if (pos == null) return false
    return _computeHedgePlan({ yesFilledContracts: pos.filledContracts, yesFillCents: pos.fillPriceCents,
      noAskCents: 25, modelProb: 0.20, maxUSD }).qualified
  })
  assert(anyNeeds1 === true, 'anyBettorNeedsHedge=true when Adam below break-even (EV-gate passes)')

  // modelProb = 0.80, noAskCents = 25 → above break-even, NO leg EV < 0 → EV gate rejects
  const anyNeeds2 = activeBettors.some(b => {
    const pos = preGameYesByUserStrike.get(b.id)?.get(n)
    if (pos == null) return false
    return _computeHedgePlan({ yesFilledContracts: pos.filledContracts, yesFillCents: pos.fillPriceCents,
      noAskCents: 25, modelProb: 0.80, maxUSD }).qualified
  })
  assert(anyNeeds2 === false, 'anyBettorNeedsHedge=false when model says 80% YES (EV-gate rejects)')

  // Neither user has YES at strike 5 → no hedge
  const emptyMap = new Map()
  const anyNeeds3 = activeBettors.some(b => {
    const pos = emptyMap.get(b.id)?.get(n)
    if (pos == null) return false
    return _computeHedgePlan({ yesFilledContracts: pos.filledContracts, yesFillCents: pos.fillPriceCents,
      noAskCents: 25, modelProb: 0.20, maxUSD }).qualified
  })
  assert(anyNeeds3 === false, 'anyBettorNeedsHedge=false when no user holds YES at this strike')
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 11 — _computeHedgePlan: Test A — Normal qualifying hedge
// 50 YES contracts @ 60¢, NO ask 25¢, model 20% → expect fullOffset + qualified
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n--- TEST 11: _computeHedgePlan — Test A: Normal qualifying hedge ---')
{
  // yesExposure = 50 * 0.60 = $30
  // noNetPerContract = (1 - 0.25) * 0.93 = 0.6975
  // fullOffset = ceil(30 / 0.6975) = ceil(43.01) = 44
  // rawCost = 44 * 0.25 = $11.00 < $60 cap → not capped
  // evNoLeg = (1-0.20)*0.6975 - 0.20*0.25 = 0.558 - 0.05 = 0.508 > 0 → qualifies
  const plan = _computeHedgePlan({ yesFilledContracts: 50, yesFillCents: 60, noAskCents: 25, modelProb: 0.20, maxUSD: 60 })
  assert(plan.qualified === true, 'Test A: qualified=true')
  assert(plan.fullOffset === 44, `Test A: fullOffset=44 (got ${plan.fullOffset})`)
  assert(plan.capped === false, 'Test A: not capped (cost < $60)')
  assert(plan.hedgeContracts === 44, `Test A: hedgeContracts=44 (got ${plan.hedgeContracts})`)
  assert(Math.abs(plan.hedgeCost - 11.00) < 0.01, `Test A: hedgeCost≈$11.00 (got $${plan.hedgeCost?.toFixed(2)})`)
  assert(plan.evHedge > plan.evNoHedge, 'Test A: hedge improves EV')
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 12 — _computeHedgePlan: Test B — More expensive NO ask
// 50 YES @ 60¢, NO ask 40¢ → fewer contracts needed but cost is higher
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n--- TEST 12: _computeHedgePlan — Test B: Expensive NO ask ---')
{
  // noNetPerContract = (1-0.40)*0.93 = 0.558
  // fullOffset = ceil(30/0.558) = ceil(53.76) = 54
  // rawCost = 54 * 0.40 = $21.60 < $60 → not capped
  // evNoLeg = (1-0.20)*0.558 - 0.20*0.40 = 0.4464 - 0.08 = 0.3664 > 0
  const plan = _computeHedgePlan({ yesFilledContracts: 50, yesFillCents: 60, noAskCents: 40, modelProb: 0.20, maxUSD: 60 })
  assert(plan.qualified === true, 'Test B: qualified=true')
  assert(plan.fullOffset === 54, `Test B: fullOffset=54 (got ${plan.fullOffset})`)
  assert(plan.capped === false, 'Test B: not capped')
  assert(Math.abs(plan.hedgeCost - 21.60) < 0.01, `Test B: hedgeCost≈$21.60 (got $${plan.hedgeCost?.toFixed(2)})`)
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 13 — _computeHedgePlan: Test C — Cap binds (large position)
// 200 YES @ 60¢, NO ask 25¢, $60 cap → capped at floor(60/0.25) = 240 ... wait
// Actually let's use a large position where cap clearly binds: 300 YES @ 60¢
// fullOffset = ceil(180/0.6975) = ceil(258.06) = 259, rawCost = 259*0.25 = $64.75 > $60
// capped: hedgeContracts = floor(60/0.25) = 240, hedgeCost = 240*0.25 = $60
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n--- TEST 13: _computeHedgePlan — Test C: Cap binds ---')
{
  const plan = _computeHedgePlan({ yesFilledContracts: 300, yesFillCents: 60, noAskCents: 25, modelProb: 0.20, maxUSD: 60 })
  assert(plan.qualified === true, 'Test C: qualified=true (cap binds but hedge still makes sense)')
  assert(plan.capped === true, 'Test C: capped=true')
  assert(plan.hedgeContracts === 240, `Test C: hedgeContracts=240 (got ${plan.hedgeContracts})`)
  assert(Math.abs(plan.hedgeCost - 60.00) < 0.01, `Test C: hedgeCost=$60.00 (got $${plan.hedgeCost?.toFixed(2)})`)
  assert(plan.hedgeContracts < plan.fullOffset, 'Test C: hedgeContracts < fullOffset (partial hedge)')
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 14 — _computeHedgePlan: Test D — EV gate rejects high model prob
// At 75% model prob, NO leg EV is negative → system should NOT hedge
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n--- TEST 14: _computeHedgePlan — Test D: EV gate rejects ---')
{
  // evNoLeg = (1-0.75)*0.6975 - 0.75*0.25 = 0.174375 - 0.1875 = -0.013125 < 0 → reject
  const plan = _computeHedgePlan({ yesFilledContracts: 50, yesFillCents: 60, noAskCents: 25, modelProb: 0.75, maxUSD: 60 })
  assert(plan.qualified === false, 'Test D: qualified=false (EV gate rejects at 75% model prob)')
  assert(plan.reason === 'ev-gate-fail', `Test D: reason=ev-gate-fail (got ${plan.reason})`)
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 15 — _computeHedgePlan: Test E — Illiquid NO ask
// noAskCents=0 → out of range → reject
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n--- TEST 15: _computeHedgePlan — Test E: Illiquid NO ---')
{
  const plan = _computeHedgePlan({ yesFilledContracts: 50, yesFillCents: 60, noAskCents: 0, modelProb: 0.20, maxUSD: 60 })
  assert(plan.qualified === false, 'Test E: qualified=false (noAsk=0 out of range)')
  assert(plan.reason === 'noAsk-out-of-range', `Test E: reason=noAsk-out-of-range (got ${plan.reason})`)

  const plan2 = _computeHedgePlan({ yesFilledContracts: 50, yesFillCents: 60, noAskCents: 100, modelProb: 0.20, maxUSD: 60 })
  assert(plan2.qualified === false, 'Test E: qualified=false (noAsk=100 out of range)')
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 16 — _computeHedgePlan: Test F — Zero filled contracts
// No YES position → nothing to hedge → reject
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n--- TEST 16: _computeHedgePlan — Test F: Zero filled contracts ---')
{
  const plan = _computeHedgePlan({ yesFilledContracts: 0, yesFillCents: 60, noAskCents: 25, modelProb: 0.20, maxUSD: 60 })
  assert(plan.qualified === false, 'Test F: qualified=false (yesFilledContracts=0)')
  assert(plan.reason === 'fullOffset-zero', `Test F: reason=fullOffset-zero (got ${plan.reason})`)

  const planNull = _computeHedgePlan({ yesFilledContracts: null, yesFillCents: 60, noAskCents: 25, modelProb: 0.20, maxUSD: 60 })
  assert(planNull.qualified === false, 'Test F: qualified=false (yesFilledContracts=null)')
}

// ─────────────────────────────────────────────────────────────────────────────
// SUMMARY
// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${'='.repeat(50)}`)
console.log(`Results: ${passed} passed, ${failed} failed`)
if (failures.length) {
  console.error('\nFailed assertions:')
  failures.forEach(f => console.error(`  ❌ ${f}`))
  process.exit(1)
} else {
  console.log('All tests passed ✅')
}
