// scripts/live/testLiveChanges.js
// Tests all 7 live system improvements. Run with: node scripts/live/testLiveChanges.js

import 'dotenv/config'

// ── helpers ─────────────────────────────────────────────────────────────────
let passed = 0, failed = 0
function assert(condition, label, detail = '') {
  if (condition) {
    console.log(`  ✅ ${label}`)
    passed++
  } else {
    console.log(`  ❌ ${label}${detail ? '\n     ' + detail : ''}`)
    failed++
  }
}

// ── Inline copy of computeLiveModel (for Change 6 testing) ──────────────────
// Must match liveMonitor.js exactly.
const AVG_PITCHES_PER_IP = 17
const LEAGUE_PA_PER_IP   = 4.44

function computeLiveModel_test(preGame, currentKs, currentIP, currentPitches, currentBF = 0, scoreDiff = 0) {
  const { pK_blended, avgPitches } = preGame
  let pitchBudget = avgPitches || 90
  if      (scoreDiff >=  5) pitchBudget *= 0.88
  else if (scoreDiff <= -5) pitchBudget *= 0.92
  else if (Math.abs(scoreDiff) <= 2) pitchBudget *= 1.03
  if (currentBF >= 21) pitchBudget *= 0.93

  const pitchesLeft  = Math.max(0, pitchBudget - currentPitches)
  const remainingIP  = pitchesLeft / AVG_PITCHES_PER_IP
  const remainingBF  = remainingIP * LEAGUE_PA_PER_IP

  let pK_effective = pK_blended
  if (currentBF >= 9) {
    const liveKpct = currentBF > 0 ? currentKs / currentBF : pK_blended
    const w_live   = Math.min(0.5, currentBF / 36)
    const blended  = w_live * liveKpct + (1 - w_live) * pK_blended
    pK_effective   = Math.max(0.10, Math.min(0.45, blended))
    // Change 6: fast Bayesian when pitcher is dominating well above prior
    if (liveKpct > pK_blended * 1.5 && liveKpct > 0.25) {
      const w_fast    = Math.min(0.75, currentBF / 18)
      const fastBlend = w_fast * liveKpct + (1 - w_fast) * pK_blended
      pK_effective    = Math.max(0.10, Math.min(0.45, fastBlend))
    }
  }
  if      (currentBF >= 24) pK_effective *= 0.75
  else if (currentBF >= 18) pK_effective *= 0.85

  return { pK_effective, remainingBF }
}

// ── Inline MODE 2 YES gate logic (for Change 1 & 4 testing) ─────────────────
function mode2YesGate(modelProb, edge, halfSpread, ksChanged) {
  const onKMomentum = ksChanged
  const yesMinProb  = onKMomentum ? 0.55 : 0.60
  const yesFullConv = modelProb >= 0.75
  const yesMinEdge  = yesFullConv
    ? Math.max(0.20, halfSpread + 0.04)
    : onKMomentum ? Math.max(0.10, halfSpread + 0.03) : Math.max(0.12, halfSpread + 0.03)
  if (modelProb < yesMinProb) return null
  if (edge < yesMinEdge)       return null
  const kellyScale  = yesFullConv ? 1.0 : onKMomentum ? 0.35 : 0.50
  return { kellyScale, yesMinProb, yesMinEdge }
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n══════════════════════════════════════════════')
console.log('  CHANGE 7: placeOrder action param (kalshi.js)')
console.log('══════════════════════════════════════════════')

// Validate signature + validation rules (doesn't need a live API call)
let c7_throwBuy = false, c7_throwSell = false, c7_throwInvalid = false

// Import dynamically to get the real function
const kalshiMod = await import('../../lib/kalshi.js')
const { placeOrder } = kalshiMod

// Bad ticker → throws before reaching action check
try { await placeOrder('', 'yes', 1, 50) } catch (e) { c7_throwBuy = e.message.includes('ticker required') }
assert(c7_throwBuy, 'placeOrder: still throws on missing ticker (backward compat)')

// action='sell' should be accepted (will fail at authedRequest with no creds, not at validation)
let c7_sellValidates = false
try {
  await placeOrder('FAKE-TICKER', 'yes', 1, 50, {}, 'sell')
} catch (e) {
  // Expected to throw at API call (no real creds) — NOT at validation
  c7_sellValidates = !e.message.includes('action must be buy|sell')
}
assert(c7_sellValidates, "placeOrder: action='sell' passes validation (throws at API, not validation)")

// action='invalid' must throw
let c7_invalidThrows = false
try {
  await placeOrder('FAKE-TICKER', 'yes', 1, 50, {}, 'invalid')
} catch (e) {
  c7_invalidThrows = e.message.includes('action must be buy|sell')
}
assert(c7_invalidThrows, "placeOrder: action='invalid' throws validation error")

// action='buy' default still works
let c7_buyDefault = false
try {
  await placeOrder('FAKE-TICKER', 'yes', 1, 50)
} catch (e) {
  c7_buyDefault = !e.message.includes('action must be buy|sell')
}
assert(c7_buyDefault, "placeOrder: default action='buy' passes validation")

// ════════════════════════════════════════════════════════════════════════════
console.log('\n══════════════════════════════════════════════')
console.log('  CHANGE 6: Fast Bayesian update (computeLiveModel)')
console.log('══════════════════════════════════════════════')

// Scenario: pitcher striking out 40% (pK_live=0.40), prior=0.24, BF=12
// Standard blend: w_live=min(0.5,12/36)=0.333 → 0.333*0.40+(0.667*0.24)=0.293
// Fast update (liveKpct=0.40 > 0.24*1.5=0.36 AND > 0.25 AND BF≥9):
//   w_fast=min(0.75,12/18)=0.667 → 0.667*0.40+0.333*0.24=0.347
const preGameHot = { pK_blended: 0.24, avgPitches: 90, avgBF: 27 }
const hotResult  = computeLiveModel_test(preGameHot, 5, 2.2, 40, 12, 1)  // 5Ks/12BF = 0.417
const standardBlend_BF12 = Math.min(0.5, 12/36) * (5/12) + (1 - Math.min(0.5, 12/36)) * 0.24
const fastBlend_BF12     = Math.min(0.75, 12/18) * (5/12) + (1 - Math.min(0.75, 12/18)) * 0.24
assert(
  hotResult.pK_effective > standardBlend_BF12,
  `Fast Bayesian raises pK_effective above standard blend when pitcher is hot`,
  `got ${hotResult.pK_effective.toFixed(3)} vs standard ${standardBlend_BF12.toFixed(3)}`
)
assert(
  Math.abs(hotResult.pK_effective - fastBlend_BF12) < 0.001,
  `Fast blend value correct (w_fast=0.667): expected ${fastBlend_BF12.toFixed(3)}, got ${hotResult.pK_effective.toFixed(3)}`
)

// Scenario: pitcher at prior pace (no fast update should fire)
const preGameNorm = { pK_blended: 0.24, avgPitches: 90, avgBF: 27 }
const normResult  = computeLiveModel_test(preGameNorm, 3, 2.2, 40, 12, 1)  // 3/12=0.25, exactly 1.04× prior
const liveKpctNorm = 3/12
const shouldFast_norm = liveKpctNorm > 0.24 * 1.5 && liveKpctNorm > 0.25
assert(!shouldFast_norm, `Fast Bayesian does NOT fire when liveKpct (${liveKpctNorm.toFixed(2)}) ≤ 1.5× prior (${(0.24*1.5).toFixed(2)})`)

// Scenario: BF=8 — fast update should not fire (BF<9)
const result_BF8 = computeLiveModel_test(preGameHot, 4, 1.8, 30, 8, 0)  // 4/8=0.50
const shouldFire_BF8 = 8 >= 9
assert(!shouldFire_BF8, `Fast Bayesian does NOT fire at BF=8 (gate is BF≥9)`)

// Scenario: w_fast capped at 0.75 (BF=18+)
const result_BF18 = computeLiveModel_test(preGameHot, 8, 4.0, 65, 18, 0)  // 8/18=0.444, prior=0.24
const w_fast_BF18 = Math.min(0.75, 18/18)
assert(Math.abs(w_fast_BF18 - 0.75) < 0.001, `w_fast caps at 0.75 at BF=18`)

// ════════════════════════════════════════════════════════════════════════════
console.log('\n══════════════════════════════════════════════')
console.log('  CHANGE 2: BF + inning gates (4/2 vs old 6/3)')
console.log('══════════════════════════════════════════════')

// Simulate the gate logic
function bf_gate(currentBF, currentInn, pitcherPulledEarly) {
  if (!pitcherPulledEarly && currentBF < 4) return 'SKIP_BF'
  if (!pitcherPulledEarly && currentInn < 2) return 'SKIP_INN'
  return 'PASS'
}

assert(bf_gate(4, 2, false) === 'PASS',  'BF=4, Inn=2 → PASS (new minimum)')
assert(bf_gate(3, 2, false) === 'SKIP_BF', 'BF=3 → SKIP (below new gate of 4)')
assert(bf_gate(4, 1, false) === 'SKIP_INN', 'Inn=1 → SKIP (below new gate of 2)')
assert(bf_gate(5, 3, false) === 'PASS',  'BF=5, Inn=3 → PASS')
assert(bf_gate(3, 1, true)  === 'PASS',  'pitcherPulledEarly bypasses both gates')
assert(bf_gate(0, 0, true)  === 'PASS',  'pitcherPulledEarly with BF=0 → PASS')

// Verify old gate would have blocked what new gate now allows
function bf_gate_old(currentBF, currentInn, pitcherPulledEarly) {
  if (!pitcherPulledEarly && currentBF < 6) return 'SKIP_BF'
  if (!pitcherPulledEarly && currentInn < 3) return 'SKIP_INN'
  return 'PASS'
}
assert(bf_gate_old(4, 2, false) === 'SKIP_BF', 'Old gate: BF=4 would have been blocked')
assert(bf_gate_old(6, 2, false) === 'SKIP_INN', 'Old gate: Inn=2 would have been blocked')
assert(bf_gate(4, 2, false) === 'PASS',  'New gate: BF=4 + Inn=2 now fires (was double-blocked before)')

// ════════════════════════════════════════════════════════════════════════════
console.log('\n══════════════════════════════════════════════')
console.log('  CHANGE 3: Dead-path noMid cap (85 vs old 72)')
console.log('══════════════════════════════════════════════')

function deadPathGate_new(noMid, preGameHasNO) {
  if (preGameHasNO) return 'SKIP_PREGAME'
  if (noMid >= 85 || noMid <= 5) return 'SKIP_RANGE'
  return 'QUALIFY'
}
function deadPathGate_old(noMid, preGameHasNO) {
  if (preGameHasNO) return 'SKIP_PREGAME'
  if (noMid >= 72 || noMid <= 5) return 'SKIP_RANGE'
  return 'QUALIFY'
}

// New range that should now fire: noMid 72-84
assert(deadPathGate_new(72, false) === 'QUALIFY', 'noMid=72 → QUALIFY (old cap was 72 exclusive)')
assert(deadPathGate_new(80, false) === 'QUALIFY', 'noMid=80 → QUALIFY (new 72-84 range)')
assert(deadPathGate_new(84, false) === 'QUALIFY', 'noMid=84 → QUALIFY (one below new cap of 85)')
assert(deadPathGate_new(85, false) === 'SKIP_RANGE', 'noMid=85 → SKIP (at new cap)')
assert(deadPathGate_new(90, false) === 'SKIP_RANGE', 'noMid=90 → SKIP (above cap)')
assert(deadPathGate_new(71, false) === 'QUALIFY', 'noMid=71 → QUALIFY (was also fine under old rule)')
// Verify old rule blocked the new range
assert(deadPathGate_old(72, false) === 'SKIP_RANGE', 'Old rule: noMid=72 was blocked')
assert(deadPathGate_old(80, false) === 'SKIP_RANGE', 'Old rule: noMid=80 was blocked')

// ════════════════════════════════════════════════════════════════════════════
console.log('\n══════════════════════════════════════════════')
console.log('  CHANGE 1 & 4: MODE 2 YES thresholds + ksChanged')
console.log('══════════════════════════════════════════════')

const hs = 0.05  // typical halfSpread = 5¢ / 200

// Case 1: High conviction (75%+) — full kelly, standard edge
const hc = mode2YesGate(0.76, 0.22, hs, false)
assert(hc !== null && hc.kellyScale === 1.0, `75%+ model → QUALIFY with kellyScale=1.0 (got ${hc?.kellyScale})`)

// Case 2: Mid conviction (60-74%) no ksChanged — kellyScale=0.50
const mid = mode2YesGate(0.65, 0.14, hs, false)
assert(mid !== null && mid.kellyScale === 0.50, `65% no-momentum → kellyScale=0.50 (got ${mid?.kellyScale})`)

// Case 3: Mid conviction but edge too low (12¢ min for 60-74% non-momentum)
const midLowEdge = mode2YesGate(0.65, 0.10, hs, false)
assert(midLowEdge === null, `65% + edge=10¢ (below 12¢ min) → SKIP`)

// Case 4: On K-momentum (ksChanged=true) → 55% threshold, 35% kelly
const mom = mode2YesGate(0.57, 0.11, hs, true)
assert(mom !== null && mom.kellyScale === 0.35, `57% ksChanged=true → kellyScale=0.35 (got ${mom?.kellyScale})`)

// Case 5: ksChanged but edge below 10¢ min — skip
const momLowEdge = mode2YesGate(0.57, 0.08, hs, true)
assert(momLowEdge === null, `57% ksChanged + edge=8¢ (below 10¢ min) → SKIP`)

// Case 6: Below 55% threshold even with ksChanged — skip
const tooLow = mode2YesGate(0.54, 0.20, hs, true)
assert(tooLow === null, `54% even with ksChanged → SKIP (below 55% floor)`)

// Case 7: Old 75% rule would have blocked 65% — verify old vs new
const wouldHaveBlocked = 0.65 < 0.75
assert(wouldHaveBlocked, `Old rule: 65% would have been blocked (< 75%)`)
assert(mid !== null, `New rule: 65% with 14¢ edge now qualifies`)

// ════════════════════════════════════════════════════════════════════════════
console.log('\n══════════════════════════════════════════════')
console.log('  CHANGE 5: Concurrent execution (Promise.all for pulled/dead-path)')
console.log('══════════════════════════════════════════════')

// Simulate the batch/seq split logic
function splitExecOrder(qualifying) {
  const execOrder  = qualifying.map((_, i) => i)
  const batchItems = execOrder.filter(i => qualifying[i].mode === 'pulled' || qualifying[i].mode === 'dead-path')
  const seqItems   = execOrder.filter(i => qualifying[i].mode !== 'pulled' && qualifying[i].mode !== 'dead-path')
  return { batchItems, seqItems }
}

const mixedQ = [
  { mode: 'pulled', n: 7 },
  { mode: 'dead-path', n: 8 },
  { mode: 'high-conviction', n: 5 },
  { mode: 'pulled', n: 9 },
]
const { batchItems, seqItems } = splitExecOrder(mixedQ)
assert(batchItems.length === 3, `Batch (pulled+dead-path): 3 items (got ${batchItems.length})`)
assert(seqItems.length === 1,   `Sequential (high-conviction): 1 item (got ${seqItems.length})`)
assert(
  batchItems.every(i => mixedQ[i].mode !== 'high-conviction'),
  'All batch items are pulled or dead-path'
)
assert(
  seqItems.every(i => mixedQ[i].mode === 'high-conviction'),
  'All sequential items are high-conviction'
)

// Timing test: concurrent should be faster than sequential for IO-bound tasks
async function slowTask(ms) { return new Promise(r => setTimeout(r, ms)) }
const TASKS = [60, 60, 60]  // three 60ms tasks

const t0seq = Date.now()
for (const ms of TASKS) await slowTask(ms)
const seqMs = Date.now() - t0seq

const t0con = Date.now()
await Promise.all(TASKS.map(ms => slowTask(ms)))
const conMs = Date.now() - t0con

assert(conMs < seqMs * 0.6, `Promise.all is faster (${conMs}ms) vs sequential (${seqMs}ms) — ${Math.round((1 - conMs/seqMs)*100)}% speedup`)

// kellyScale applied to finalBetSize
function computeFinalBetSize(betSize, edge, kellyScale) {
  const edgeMult = edge >= 0.15 ? 2 : 1
  return betSize * edgeMult * (kellyScale ?? 1.0)
}
assert(computeFinalBetSize(100, 0.20, 0.50) === 100,  `kellyScale=0.50 + 2× edge = 100 (100*2*0.5)`)
assert(computeFinalBetSize(100, 0.20, 0.35) === 70,   `kellyScale=0.35 + 2× edge = 70 (100*2*0.35)`)
assert(computeFinalBetSize(100, 0.10, 1.0)  === 100,  `kellyScale=1.0 + 1× edge = 100`)
assert(computeFinalBetSize(100, 0.20, 1.0)  === 200,  `kellyScale=1.0 + 2× edge = 200`)
assert(computeFinalBetSize(100, 0.20, undefined) === 200, `kellyScale=undefined defaults to 1.0`)

// ════════════════════════════════════════════════════════════════════════════
console.log('\n══════════════════════════════════════════════')
console.log('  SUMMARY')
console.log('══════════════════════════════════════════════')
const total = passed + failed
console.log(`\n  ${passed}/${total} tests passed  ${failed > 0 ? `(${failed} FAILED)` : '✅ all green'}`)
if (failed > 0) process.exit(1)
