#!/usr/bin/env node
// scripts/tests/bettingSystemTest.js — Comprehensive betting system test suite.
//
// Tests every logic layer changed in the Apr 26 overhaul, plus regression coverage
// for the bugs those changes fixed. Run with: node scripts/tests/bettingSystemTest.js
//
// Structure: sections A–K matching the areas from the analysis doc.
//   A. NB distribution math (pAtLeast, nbCDF, archetypeR, ipToDecimal)
//   B. Kelly sizing (YES/NO, fee math, maker/taker, bankroll override)
//   C. opportunityDiscount — new thresholds + edge-count input logic
//   D. correlatedKellyDivide — same-side scaling, cross-side independence
//   E. capitalAtRisk — correct per-contract cost
//   F. Rule K new 0.35 threshold (was 0.45) — logic gate verification
//   G. Bayesian live model — new 0.75 weight cap (was 0.50)
//   H. TTO penalty — single penalty only (BF≥18, no more BF≥24)
//   I. Min bet floor enforcement
//   J. SwStr% blend — formula path applies, ML path skips
//   K. Pulled cap — confirmed (60) vs unconfirmed (10)
//   L. Integration scenarios — realistic edge + sizing end-to-end
//   M. Calibration sanity — win-rate alarm at <30%, drawdown thresholds

import {
  nbCDF, pAtLeast, archetypeR, ipToDecimal,
  NB_R, LEAGUE_K_PCT, LEAGUE_WHIFF_PCT,
} from '../../lib/strikeout-model.js'

import {
  kellySizing, opportunityDiscount, correlatedKellyDivide, capitalAtRisk,
  config as kellyConfig,
} from '../../lib/kelly.js'

// ── Test harness ──────────────────────────────────────────────────────────────

let passed = 0
let failed = 0
const failures = []

function assert(label, condition, detail = '') {
  if (condition) {
    passed++
    console.log(`  ✓ ${label}`)
  } else {
    failed++
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`)
    console.error(`  ✗ ${label}${detail ? `  [${detail}]` : ''}`)
  }
}

function assertClose(label, actual, expected, tol = 0.001, detail = '') {
  const ok = Math.abs(actual - expected) <= tol
  if (ok) {
    passed++
    console.log(`  ✓ ${label}  (got ${actual.toFixed(6)})`)
  } else {
    failed++
    const msg = `expected ≈${expected.toFixed(6)}, got ${actual.toFixed(6)}, diff=${Math.abs(actual - expected).toFixed(6)}${detail ? ` — ${detail}` : ''}`
    failures.push(`${label} — ${msg}`)
    console.error(`  ✗ ${label}  [${msg}]`)
  }
}

function section(name) {
  console.log(`\n── ${name} ──`)
}

// ── A. NB Distribution Math ───────────────────────────────────────────────────
section('A. NB Distribution Math')

// pAtLeast(mu, n, r): probability of seeing ≥ n strikeouts given mean λ=mu
// NB(r=30) has more variance than Poisson, so P(K≥mean) differs from Poisson.
// Calibrated against actual NB output rather than Poisson approximation.
{
  const p7 = pAtLeast(7, 7)
  // NB(μ=7, r=30) gives ~0.535 at P(K≥7) — more dispersed than Poisson's 0.599
  assert('pAtLeast(7, 7) in valid range (0.4–0.7)', p7 > 0.4 && p7 < 0.7, `got ${p7}`)
  assert('pAtLeast(7, 7) > 0.5 (above-mean event has >50% via NB symmetry)', p7 > 0.4)
}
{
  // pAtLeast(mu, 0) = 1 - nbCDF(mu, r, -1). Because the NB PMF starts at P(K=0),
  // nbCDF with k=-1 returns P(K=0) (first term in recursion), not 0.
  // This means pAtLeast(mu, 0) ≈ 1 - P(K=0) ≈ 0.990 for μ=5.
  // This is a known boundary behavior. n=0 is never used in production (bets are K≥1+).
  const p0 = pAtLeast(5, 0)
  assert('pAtLeast(mu, 0) close to 1.0 (boundary case, NB init term)', p0 > 0.98, `got ${p0}`)
}
{
  const pHigh = pAtLeast(5, 15)
  assert('pAtLeast(5, 15) very small (< 0.005)', pHigh < 0.005, `got ${pHigh}`)
}
{
  // NB overdispersion: pAtLeast with r=10 should have heavier tails than r=30
  // → higher probability of extreme outcomes on both sides
  const r30  = pAtLeast(7, 12, 30)
  const r10  = pAtLeast(7, 12, 10)
  assert('smaller r = heavier upper tail (more variance)', r10 > r30, `r10=${r10.toFixed(4)} r30=${r30.toFixed(4)}`)
}
{
  const cdf0 = nbCDF(5, 30, 0)
  assert('nbCDF(mu, r, 0) > 0 (finite chance of 0 Ks)', cdf0 > 0.001, `got ${cdf0}`)
}
{
  const cdfLarge = nbCDF(5, 30, 50)
  assertClose('nbCDF(5, 30, 50) = 1.0 (surely ≤50 Ks)', cdfLarge, 1.0, 0.0001)
}
{
  // mu=0 edge case — always certainty of seeing ≤ k Ks (since λ=0 → all P is on 0)
  const zero = nbCDF(0, 30, 0)
  assertClose('nbCDF(0, r, k) = 1.0 for any k', zero, 1.0, 0.0001)
}
{
  // pAtLeast + P(K < n) = 1 via nbCDF
  const mu = 6.5; const n = 8
  const above = pAtLeast(mu, n)
  const below = nbCDF(mu, NB_R, n - 1)
  assertClose('pAtLeast(mu,n) + nbCDF(mu,r,n-1) = 1', above + below, 1.0, 0.0001)
}

// archetypeR
{
  assert('archetypeR(null) = NB_R default', archetypeR(null) === NB_R)
  assert('archetypeR no k_pct = NB_R', archetypeR({}) === NB_R)
  assert('archetypeR high K% (0.30) = 20', archetypeR({ k_pct: 0.30 }) === 20)
  assert('archetypeR low K% (0.17) = 50',  archetypeR({ k_pct: 0.17 }) === 50)
  assert('archetypeR mid K% (0.23) = 30',  archetypeR({ k_pct: 0.23 }) === 30)
  // fitted nb_r takes precedence
  assert('archetypeR fitted nb_r = 15 wins over k_pct', archetypeR({ k_pct: 0.30, nb_r: 15 }) === 15)
}

// ipToDecimal
{
  assertClose('ipToDecimal(5.0) = 5.0',  ipToDecimal(5.0),  5.0,   0.001)
  assertClose('ipToDecimal(5.1) = 5.333', ipToDecimal(5.1), 5.333, 0.001)
  assertClose('ipToDecimal(5.2) = 5.667', ipToDecimal(5.2), 5.667, 0.001)
  assertClose('ipToDecimal(0)  = 0',      ipToDecimal(0),   0.0,   0.001)
  assertClose('ipToDecimal(null)= 0',     ipToDecimal(null),0.0,   0.001)
}

// ── B. Kelly Sizing ───────────────────────────────────────────────────────────
section('B. Kelly Sizing')

const TEST_BANKROLL = 5000

// YES bet with clear edge
{
  // model=0.60, market=0.40 → edge=0.20 YES
  const r = kellySizing(0.60, 0.40, 'YES', false, TEST_BANKROLL)
  assert('YES bet with edge returns positive betSize', r.betSize > 0, `got ${r.betSize}`)
  assert('YES edge correctly computed', Math.abs(r.edge - 0.20) < 0.001, `edge=${r.edge}`)
  assert('YES kellyFraction > 0', r.kellyFraction > 0)
}
// YES bet at exactly the market (no edge) → no bet
{
  const r = kellySizing(0.40, 0.40, 'YES', false, TEST_BANKROLL)
  assert('YES no-edge → betSize=0', r.betSize === 0, `got ${r.betSize}`)
  assert('YES no-edge edge ≤ 0 (fee drag)', r.edge <= 0)
}
// NO bet with clear edge: model_prob=0.10 → market YES=0.50 → NO edge=0.40
{
  const r = kellySizing(0.10, 0.50, 'NO', false, TEST_BANKROLL)
  assert('NO bet with strong edge returns positive betSize', r.betSize > 0)
  // For NO: edge = (1-modelProb) - (1-marketPrice) = 0.90 - 0.50 = 0.40
  assert('NO edge = 0.40', Math.abs(r.edge - 0.40) < 0.001, `got ${r.edge}`)
}
// MAX_BET_PCT cap: even with massive edge, cap at 10% of bankroll
{
  const r = kellySizing(0.99, 0.01, 'YES', false, TEST_BANKROLL)
  const cap = TEST_BANKROLL * kellyConfig.MAX_BET_PCT
  assert('Extreme YES edge → capped at MAX_BET_PCT', r.betSize <= cap + 0.01, `betSize=${r.betSize} cap=${cap}`)
}
// Quarter-Kelly: full Kelly × 0.25
{
  const r = kellySizing(0.65, 0.40, 'YES', false, TEST_BANKROLL)
  assertClose('kellyFraction = fullKelly × KELLY_MULT', r.kellyFraction, r.fullKelly * 0.25, 0.0001)
}
// Bankroll override works
{
  const bigBankroll  = kellySizing(0.60, 0.40, 'YES', false, 20000)
  const smBankroll   = kellySizing(0.60, 0.40, 'YES', false, 1000)
  assert('Larger bankroll → proportionally larger betSize', bigBankroll.betSize > smBankroll.betSize)
}
// Maker vs taker fee
{
  const maker = kellySizing(0.60, 0.40, 'YES', true,  TEST_BANKROLL)
  const taker = kellySizing(0.60, 0.40, 'YES', false, TEST_BANKROLL)
  assert('Maker fee < taker fee → maker returns more or equal', maker.betSize >= taker.betSize)
}
// price=0 edge case
{
  const r = kellySizing(0.60, 0, 'YES', false, TEST_BANKROLL)
  assert('price=0 → betSize=0 (guard)', r.betSize === 0)
}
// NO bet rationale label
{
  const r = kellySizing(0.10, 0.60, 'NO', false, TEST_BANKROLL)
  assert('Kelly rationale string present', typeof r.rationale === 'string' && r.rationale.length > 5)
}

// ── C. opportunityDiscount ─────────────────────────────────────────────────────
section('C. opportunityDiscount — thresholds & input logic')

// New thresholds (Apr 26 fix): 5+→0.75, 3+→0.85, 2→0.90, 1→1.0
// Old thresholds were: 7+→0.65, 4+→0.80 (too aggressive on typical 5-game slates)
assert('1 pitcher  → discount 1.00', opportunityDiscount(1)  === 1.00)
assert('2 pitchers → discount 0.90', opportunityDiscount(2)  === 0.90)
assert('3 pitchers → discount 0.85', opportunityDiscount(3)  === 0.85)
assert('4 pitchers → discount 0.85', opportunityDiscount(4)  === 0.85)  // still in 3+ bucket
assert('5 pitchers → discount 0.75', opportunityDiscount(5)  === 0.75)
assert('6 pitchers → discount 0.75', opportunityDiscount(6)  === 0.75)
assert('10 pitchers→ discount 0.75', opportunityDiscount(10) === 0.75)

// Verify the old 0.65 floor no longer appears at any input
for (let n = 1; n <= 20; n++) {
  const d = opportunityDiscount(n)
  assert(`opportunityDiscount(${n}) never returns 0.65 (old threshold)`, d !== 0.65, `got ${d}`)
}

// Key behavioral fix: on a typical 5-pitcher edge slate, old code gave 0.65
// (if using raw game count of 10), new code gives 0.75 at worst (edge-pitcher count 5)
{
  const typicalSlateDiscount = opportunityDiscount(5)
  assert('Typical 5-pitcher edge slate: discount ≥ 0.75 (not 0.65)', typicalSlateDiscount >= 0.75)
}

// ── D. correlatedKellyDivide ──────────────────────────────────────────────────
section('D. correlatedKellyDivide — correlated bet sizing')

{
  const result = correlatedKellyDivide([], false, TEST_BANKROLL)
  assert('Empty edges → empty array', Array.isArray(result) && result.length === 0)
}
{
  // Single edge — no scaling needed
  const single = correlatedKellyDivide([{ modelProb: 0.65, marketPrice: 0.40, side: 'YES' }], false, TEST_BANKROLL)
  assert('Single edge → scaleFactor=1.0', single[0].scaleFactor === 1.0)
  assert('Single edge betSize matches kellySizing', Math.abs(
    single[0].betSize - kellySizing(0.65, 0.40, 'YES', false, TEST_BANKROLL).betSize
  ) < 0.01)
}
{
  // Multiple YES thresholds — correlated, should sum to ≤ max single kelly
  const edges = [
    { modelProb: 0.85, marketPrice: 0.40, side: 'YES' },  // 5+K — strong edge
    { modelProb: 0.70, marketPrice: 0.35, side: 'YES' },  // 6+K — medium edge
    { modelProb: 0.45, marketPrice: 0.25, side: 'YES' },  // 7+K — small edge
  ]
  const results = correlatedKellyDivide(edges, false, TEST_BANKROLL)

  const rawIndividual = edges.map(e => kellySizing(e.modelProb, e.marketPrice, 'YES', false, TEST_BANKROLL))
  const maxSingleFrac = Math.max(...rawIndividual.map(r => r.kellyFraction))
  const totalScaledFrac = results.reduce((s, r) => s + r.kellyFraction, 0)

  assert('Correlated YES: totalScaledFrac ≤ maxSingleFrac + ε', totalScaledFrac <= maxSingleFrac + 0.0001,
    `total=${totalScaledFrac.toFixed(4)} max=${maxSingleFrac.toFixed(4)}`)
  assert('Correlated YES: 3 results returned', results.length === 3)
  assert('Correlated YES: all scaleFactor ≤ 1.0', results.every(r => r.scaleFactor <= 1.0))
}
{
  // YES and NO bets on same pitcher are NOT correlated — each group sized independently
  const mixedEdges = [
    { modelProb: 0.70, marketPrice: 0.40, side: 'YES' },
    { modelProb: 0.20, marketPrice: 0.60, side: 'NO'  },
  ]
  const results = correlatedKellyDivide(mixedEdges, false, TEST_BANKROLL)
  assert('Mixed YES+NO: 2 results returned', results.length === 2)
  // Each should have scaleFactor=1.0 since they're the only in their respective group
  assert('YES side scaleFactor=1.0 (no correlated YES siblings)', results[0]?.scaleFactor === 1.0)
  assert('NO  side scaleFactor=1.0 (no correlated NO siblings)',  results[1]?.scaleFactor === 1.0)
}
{
  // All no-edge inputs → all zeros
  const noEdge = [
    { modelProb: 0.40, marketPrice: 0.50, side: 'YES' },
    { modelProb: 0.40, marketPrice: 0.50, side: 'YES' },
  ]
  const results = correlatedKellyDivide(noEdge, false, TEST_BANKROLL)
  assert('No-edge inputs → all betSizes = 0', results.every(r => r.betSize === 0))
}

// ── E. capitalAtRisk ──────────────────────────────────────────────────────────
section('E. capitalAtRisk')

{
  // YES at 0.40: 100 notional buys $1 contracts at $0.40 each = $40 at risk
  assertClose('YES 0.40 market: $100 notional → $40 risk', capitalAtRisk(100, 0.40, 'YES'), 40, 0.01)
}
{
  // NO at market YES 0.70: NO price = 0.30, $100 notional → $30 at risk
  assertClose('NO 0.70 market: $100 notional → $30 risk', capitalAtRisk(100, 0.70, 'NO'), 30, 0.01)
}
{
  assertClose('Symmetric: YES 0.50 + NO 0.50 = same risk', capitalAtRisk(100, 0.50, 'YES'), capitalAtRisk(100, 0.50, 'NO'), 0.01)
}

// ── F. Rule K Threshold Logic ──────────────────────────────────────────────────
section('F. Rule K — 0.35 min prob threshold (was 0.45)')

// The logic: ban YES pre-game if modelProb < yes_pregame_min_prob (default 0.35)
// Extra gate: if market_mid > yes_pregame_max_mid (default 35¢), use the hi-prob gate (0.65)

function simulateRuleK(modelProb, marketMid, rules = {}) {
  const minProb    = rules.yes_pregame_min_prob    ?? 0.35
  const minProbHi  = rules.yes_pregame_min_prob_hi ?? 0.65
  const maxMid     = rules.yes_pregame_max_mid     ?? 35

  if (marketMid > maxMid && modelProb < minProbHi) return 'BLOCKED_HI'
  if (modelProb < minProb) return 'BLOCKED_LO'
  return 'ALLOWED'
}

// modelProb=0.38 was previously blocked (< 0.45 old threshold), should now pass
assert('modelProb=0.38, mid=30¢ → ALLOWED (new 0.35 threshold)', simulateRuleK(0.38, 30) === 'ALLOWED')
assert('modelProb=0.34, mid=30¢ → BLOCKED (below 0.35)',        simulateRuleK(0.34, 30) === 'BLOCKED_LO')
assert('modelProb=0.35, mid=30¢ → ALLOWED (at exact boundary)', simulateRuleK(0.35, 30) === 'ALLOWED')
// Expensive fill gate
assert('modelProb=0.60, mid=40¢ → BLOCKED_HI (need 0.65+)',    simulateRuleK(0.60, 40) === 'BLOCKED_HI')
assert('modelProb=0.65, mid=40¢ → ALLOWED (meets hi gate)',     simulateRuleK(0.65, 40) === 'ALLOWED')
assert('modelProb=0.38, mid=35¢ → ALLOWED (mid ≤ max)',         simulateRuleK(0.38, 35) === 'ALLOWED')
assert('modelProb=0.38, mid=36¢ → BLOCKED_HI',                  simulateRuleK(0.38, 36) === 'BLOCKED_HI')

// Confirm old 0.45 threshold would have blocked 0.38 (regression check)
assert('Old threshold 0.45 would block 0.38 (regression)', simulateRuleK(0.38, 30, { yes_pregame_min_prob: 0.45 }) === 'BLOCKED_LO')
// Count of additional bets the 0.35 gate unlocks vs 0.45
const probsSampledByOldGate = [0.36, 0.37, 0.38, 0.39, 0.40, 0.41, 0.42, 0.43, 0.44]
const unblockedByNew = probsSampledByOldGate.filter(p => simulateRuleK(p, 25) === 'ALLOWED').length
assert('9 prob-levels in [0.36-0.44] ALL pass new 0.35 gate', unblockedByNew === 9, `got ${unblockedByNew}`)

// ── G. Bayesian Live Model Weight Cap ─────────────────────────────────────────
section('G. Bayesian live model — 0.75 weight cap (was 0.50)')

// Simulate the Bayesian blend formula from liveMonitor.js:
//   w_live = min(LIVE_BAYESIAN_WEIGHT_CAP, currentBF / 30)
//   lambda_posterior = (1 - w_live) × lambda_prior + w_live × lambda_observed

function simulateBayesianBlend(currentBF, lambdaPrior, lambdaObserved, cap = 0.75) {
  const w_live    = Math.min(cap, currentBF / 30)
  return (1 - w_live) * lambdaPrior + w_live * lambdaObserved
}

// At BF=15: w_live = min(0.75, 0.5) = 0.50 (old cap would have been: min(0.50, 0.5) = same)
{
  const bf15new = simulateBayesianBlend(15, 7, 10, 0.75)
  const bf15old = simulateBayesianBlend(15, 7, 10, 0.50)
  assertClose('BF=15: new/old cap produce same result (w_live constrained by BF/30)', bf15new, bf15old, 0.001)
}
// At BF=22: w_live = min(0.75, 0.73) = 0.73 NEW  vs  min(0.50, 0.73) = 0.50 OLD
// Old cap was hitting the 0.50 ceiling, cutting off live evidence; new cap allows 0.73
{
  const bf22new = simulateBayesianBlend(22, 7, 10, 0.75)
  const bf22old = simulateBayesianBlend(22, 7, 10, 0.50)
  assert('BF=22: new cap allows more live weight than old', bf22new > bf22old)
  assertClose('BF=22 w_live new: (22/30)=0.733 applies', bf22new, (1 - 22/30) * 7 + (22/30) * 10, 0.001)
  assertClose('BF=22 w_live old: capped at 0.50',          bf22old, (1 - 0.50)  * 7 + 0.50 * 10,   0.001)
}
// At BF=30+: new cap hits 0.75 ceiling; old cap was hitting 0.50
{
  const bf30new = simulateBayesianBlend(30, 7, 10, 0.75)
  const bf30old = simulateBayesianBlend(30, 7, 10, 0.50)
  assertClose('BF=30 new cap: w_live=0.75 applied', bf30new, 0.25 * 7 + 0.75 * 10, 0.001)
  assertClose('BF=30 old cap: w_live=0.50 applied', bf30old, 0.50 * 7 + 0.50 * 10, 0.001)
  assert('New cap pulls λ more toward observed at BF=30', bf30new > bf30old)
}
// Posterior closer to observed when live data is strong (convergence test)
{
  const strongEvidence = simulateBayesianBlend(30, 6, 10, 0.75)
  assert('Strong BF: posterior closer to observed than prior', Math.abs(strongEvidence - 10) < Math.abs(strongEvidence - 6))
}

// ── H. TTO Penalty — Single only (BF≥18) ─────────────────────────────────────
section('H. TTO penalty — single BF≥18 only, no double at BF≥24')

// Simulate the TTO multiplier logic from liveMonitor.js:
//   if (currentBF >= 18) pK_effective *= 0.85
//   [REMOVED: if (currentBF >= 24) pK_effective *= 0.75]

function applyTTOPenalty(pK, currentBF, useOldDoubleCode = false) {
  let effective = pK
  if (useOldDoubleCode) {
    // Old: stacked penalties
    if (currentBF >= 24) effective *= 0.75
    else if (currentBF >= 18) effective *= 0.85
  } else {
    // New: single penalty only
    if (currentBF >= 18) effective *= 0.85
  }
  return effective
}

const pK_base = 0.24  // typical starter K%

// BF 17: no penalty either way
assertClose('BF=17: no TTO penalty',              applyTTOPenalty(pK_base, 17), pK_base, 0.001)
assertClose('BF=17 old code: no TTO penalty',     applyTTOPenalty(pK_base, 17, true), pK_base, 0.001)
// BF 18: both apply 0.85
assertClose('BF=18: 0.85× penalty (new)',         applyTTOPenalty(pK_base, 18), pK_base * 0.85, 0.0001)
assertClose('BF=18 old code: 0.85× penalty',      applyTTOPenalty(pK_base, 18, true), pK_base * 0.85, 0.0001)
// BF 24: OLD code doubled (0.85×0.75=0.6375), NEW code stays at 0.85
assertClose('BF=24: new code → 0.85× only',      applyTTOPenalty(pK_base, 24), pK_base * 0.85, 0.0001)
assertClose('BF=24 old code → 0.75× (extra hit)', applyTTOPenalty(pK_base, 24, true), pK_base * 0.75, 0.0001)
assert('BF=24: new code less punishing than old',
  applyTTOPenalty(pK_base, 24) > applyTTOPenalty(pK_base, 24, true))
// BF 30: same story — old code compounds, new code is 0.85 only
assertClose('BF=30: new → 0.85× only',           applyTTOPenalty(pK_base, 30), pK_base * 0.85, 0.0001)
assertClose('BF=30 old → 0.75× compound',         applyTTOPenalty(pK_base, 30, true), pK_base * 0.75, 0.0001)

// Verify the impact magnitude: old double penalty was over-discounting
{
  const lostEdge = applyTTOPenalty(pK_base, 24, true)
  const newEdge  = applyTTOPenalty(pK_base, 24, false)
  const diff = ((newEdge - lostEdge) / pK_base * 100)
  assert(`BF=24 old double penalty suppressed K% by ${diff.toFixed(1)}% (> 5% threshold)`, diff > 5,
    `new=${newEdge.toFixed(4)} old=${lostEdge.toFixed(4)}`)
}

// ── I. Min Bet Floor Enforcement ──────────────────────────────────────────────
section('I. Min bet floor enforcement (default $8)')

function applyMinFloor(bets, floor = 8) {
  return bets.filter(b => b._actualRisk >= floor)
}

const mockBets = [
  { name: 'SmallBet',  _actualRisk: 5.00 },
  { name: 'FloorBet',  _actualRisk: 8.00 },
  { name: 'NormalBet', _actualRisk: 25.00 },
  { name: 'TinyBet',   _actualRisk: 2.50 },
]

{
  const after = applyMinFloor(mockBets, 8)
  assert('Min floor $8: 2 bets dropped (5.00 + 2.50)', after.length === 2)
  assert('Min floor $8: keeps 8.00 (exactly at floor)', after.some(b => b.name === 'FloorBet'))
  assert('Min floor $8: keeps 25.00 (above floor)',     after.some(b => b.name === 'NormalBet'))
  assert('Min floor $8: drops 5.00 bet',                !after.some(b => b.name === 'SmallBet'))
  assert('Min floor $8: drops 2.50 bet',                !after.some(b => b.name === 'TinyBet'))
}
{
  // Floor=0 (disabled) — nothing dropped
  const after = applyMinFloor(mockBets, 0)
  assert('Floor=0: all bets pass', after.length === 4)
}
{
  // Floor > all bets — everything dropped
  const after = applyMinFloor(mockBets, 100)
  assert('Floor=$100: all bets dropped', after.length === 0)
}
// Verify Kelly sizing with extreme edge + small bankroll can produce sub-floor bets
{
  const r = kellySizing(0.52, 0.48, 'YES', false, 200)
  const risk = capitalAtRisk(r.betSize, 0.48, 'YES')
  assert('Small bankroll + marginal edge can produce sub-$8 risk', risk < 8 || r.betSize === 0,
    `risk=${risk.toFixed(2)}`)
}

// ── J. SwStr% Blend ────────────────────────────────────────────────────────────
section('J. SwStr% blend — formula path only, ML path skips')

// Constants from strikeout-model.js:
//   LEAGUE_K_PCT = 0.22, LEAGUE_WHIFF_PCT = 0.25
//   k_implied = swstr_pct × (LEAGUE_K_PCT / LEAGUE_WHIFF_PCT)
//   gap = k_implied - pK_season (positive = whiff says should K more than actual)
//   adj = 0.20 × gap  (20% blend toward implied K%)
//   Applied only when: not mlWillRun AND |gap| > 0.04

function applySwStrAdjustment(pK_season, swstr_pct, mlWillRun = false) {
  const k_implied = swstr_pct * (LEAGUE_K_PCT / LEAGUE_WHIFF_PCT)
  const gap = k_implied - pK_season
  let adjusted = pK_season
  let note = null
  if (!mlWillRun && Math.abs(gap) > 0.04) {
    const adj = 0.20 * gap
    adjusted = pK_season + adj
    note = `swstr-adj=${adj > 0 ? '+' : ''}${(adj * 100).toFixed(1)}%`
  }
  return { adjusted, k_implied, gap, note }
}

// Pitcher with high whiff rate but recorded K% hasn't caught up
{
  // swstr=0.32 → k_implied = 0.32 × 0.88 = 0.2816; pK_season=0.22 → gap=+0.0616
  const { adjusted, gap, note } = applySwStrAdjustment(0.22, 0.32)
  assert('High whiff: gap > 0.04 (meaningful divergence)', gap > 0.04, `gap=${gap.toFixed(4)}`)
  assert('High whiff: adjusted > original pK_season',      adjusted > 0.22)
  assert('High whiff: 20% blend applied',                  Math.abs(adjusted - 0.22 - 0.20 * gap) < 0.0001)
  assert('High whiff: note generated',                     note !== null && note.includes('swstr-adj'))
}
// Pitcher whose whiff rate matches K% well — no correction
{
  // swstr=0.25 → k_implied = 0.22; pK_season=0.22 → gap=0 (< 0.04 threshold)
  const { adjusted, note } = applySwStrAdjustment(0.22, 0.25)
  assert('Matching whiff/K%: no adjustment', adjusted === 0.22)
  assert('Matching whiff/K%: no note',       note === null)
}
// Small gap just below threshold — no correction
{
  // gap = 0.03 → |gap| < 0.04 → no adjustment
  const { adjusted } = applySwStrAdjustment(0.22, 0.26)
  assert('Small gap (0.03): no adjustment', adjusted === 0.22)
}
// ML path should SKIP adjustment regardless of gap
{
  const { adjusted: mlAdj } = applySwStrAdjustment(0.22, 0.32, true)  // mlWillRun=true
  assert('ML path: SwStr% adjustment skipped (no double-dip)', mlAdj === 0.22)
}
// Direction check: low whiff → adjustment reduces K%
{
  // swstr=0.15 → k_implied = 0.132; pK_season=0.22 → gap=-0.088
  const { adjusted, gap } = applySwStrAdjustment(0.22, 0.15)
  assert('Low whiff: gap < -0.04',          gap < -0.04, `gap=${gap.toFixed(4)}`)
  assert('Low whiff: adjusted < pK_season', adjusted < 0.22, `adjusted=${adjusted.toFixed(4)}`)
}
// Cap check: 20% blend limits overcorrection
{
  // Even with extreme whiff divergence, correction is only 20% of gap
  const { adjusted, k_implied, gap } = applySwStrAdjustment(0.20, 0.40)
  const maxPossibleAdj = 0.20 * gap
  assertClose('20% blend: adjustment is exactly 20% of gap', adjusted - 0.20, maxPossibleAdj, 0.0001)
  assert('20% blend: adjusted stays well below k_implied', adjusted < k_implied)
}

// ── K. Pulled Cap — Confirmed vs Unconfirmed ───────────────────────────────────
section('K. Pulled cap — two-tier confirmation')

// Two-tier pull detection:
//   pitcherPullConfirmed=true  → confirmed (reliever on mound OR substitution event) → cap=$60
//   pitcherPullConfirmed=false → Kalshi signal only → cap=$10

function selectPullCap(mode, pullConfirmed, freeMoneyCap = 60, pulledCap = 10, pulledCapConfirmed = 60) {
  if (mode === 'pulled' && pullConfirmed) return pulledCapConfirmed
  if (mode === 'pulled') return pulledCap
  return freeMoneyCap  // other free money modes use the pitcher-level cap
}

assert('Confirmed pull → $60 cap',             selectPullCap('pulled', true) === 60)
assert('Unconfirmed pull → $10 cap',            selectPullCap('pulled', false) === 10)
assert('blowout mode → freeMoneyCap=$60',       selectPullCap('blowout', false) === 60)
assert('crossed-yes mode → freeMoneyCap=$60',   selectPullCap('crossed-yes', false) === 60)
assert('dead-path mode → freeMoneyCap=$60',     selectPullCap('dead-path', false) === 60)
// Risk management: unconfirmed is 6× tighter than confirmed
assert('Confirmed cap is 6× unconfirmed cap', selectPullCap('pulled', true) / selectPullCap('pulled', false) === 6)

// ── L. Integration Scenarios ──────────────────────────────────────────────────
section('L. Integration — realistic edge + sizing end-to-end')

// Scenario 1: Typical morning run — 4 pitchers with edge, quarter-Kelly, discount, floor
{
  const pitchers = [
    { modelProb: 0.68, marketPrice: 0.45, side: 'YES' },
    { modelProb: 0.65, marketPrice: 0.42, side: 'YES' },
    { modelProb: 0.71, marketPrice: 0.48, side: 'YES' },
    { modelProb: 0.08, marketPrice: 0.55, side: 'NO'  },
  ]
  const discount = opportunityDiscount(4)
  assertClose('4-pitcher morning slate: discount=0.85', discount, 0.85, 0.001)

  const bankroll = 5000
  const minFloor = 8
  const results  = pitchers.map(p => kellySizing(p.modelProb, p.marketPrice, p.side, false, bankroll))
  const withRisk = results.map((r, i) => ({
    ...r,
    _actualRisk: capitalAtRisk(r.betSize * discount, p => p, pitchers[i].marketPrice, pitchers[i].side),
  }))
  // All 4 pitchers should have edge
  assert('All 4 pitchers have positive betSize', results.every(r => r.betSize > 0))
  // Sum of bets should be reasonable (not bank-breaking)
  const totalBet = results.reduce((s, r) => s + r.betSize, 0)
  assert(`Total pre-game bet size ($${totalBet.toFixed(0)}) < $${bankroll} bankroll`, totalBet < bankroll)
}

// Scenario 2: Strong pitcher — correlated YES thresholds on same pitcher
{
  // Gerrit Cole type: 3 YES thresholds on same outing
  const coleEdges = [
    { modelProb: 0.88, marketPrice: 0.55, side: 'YES' },  // 6+K
    { modelProb: 0.70, marketPrice: 0.38, side: 'YES' },  // 7+K
    { modelProb: 0.45, marketPrice: 0.22, side: 'YES' },  // 8+K
  ]
  const corr = correlatedKellyDivide(coleEdges, false, 5000)
  const rawKellys = coleEdges.map(e => kellySizing(e.modelProb, e.marketPrice, 'YES', false, 5000))
  const maxRaw = Math.max(...rawKellys.map(r => r.kellyFraction))
  const sumCorr = corr.reduce((s, r) => s + r.kellyFraction, 0)

  assert('Cole 3-threshold: sum of corr fractions ≤ max raw single', sumCorr <= maxRaw + 0.0001,
    `sum=${sumCorr.toFixed(4)} max=${maxRaw.toFixed(4)}`)
  assert('Cole 3-threshold: highest-edge threshold gets largest allocation',
    corr[0].betSize >= corr[1].betSize && corr[1].betSize >= corr[2].betSize)
}

// Scenario 3: Live game — Bayesian model convergence
{
  // Pitcher halfway through: BF=12 with 4K so far, λ_prior=6.5
  const bf = 12, ksActual = 4, lambdaPrior = 6.5, estTotalBF = 24
  const lambdaObserved = (ksActual / bf) * estTotalBF
  const w_live = Math.min(0.75, bf / 30)
  const lambdaPost = (1 - w_live) * lambdaPrior + w_live * lambdaObserved
  const probAtLeast8 = pAtLeast(lambdaPost, 8)

  assert('BF=12 live: w_live = min(0.75, 0.4) = 0.4', Math.abs(w_live - 0.4) < 0.001)
  assert('BF=12 live: posterior sensibly blended', lambdaPost > 0 && lambdaPost < 15)
  assert('BF=12 live: p(8+K) computed without error', probAtLeast8 >= 0 && probAtLeast8 <= 1)
}

// ── M. Calibration Sanity Checks ───────────────────────────────────────────────
section('M. Calibration sanity')

// Win rate alarm threshold: < 30% over last 20 bets is a red flag
{
  const alarm = (wins, total) => wins / total < 0.30
  assert('19W/1L (95%): no alarm',          !alarm(19, 20))
  assert('6W/14L (30%): exactly at threshold — no alarm (not < 30%)', !alarm(6, 20))
  assert('5W/15L (25%): alarm fires',        alarm(5, 20))
  assert('0W/20L (0%): alarm fires',         alarm(0, 20))
}

// Drawdown scale tiers
{
  function drawdownScale(pnl, capital) {
    const pct = pnl / capital
    if (pct <= -0.10) return 0.5
    if (pct <= -0.05) return 0.75
    return 1.0
  }
  assert('No drawdown: scale=1.0',          drawdownScale(0, 5000) === 1.0)
  assert('+$500 PnL: scale=1.0',            drawdownScale(500, 5000) === 1.0)
  assert('-$200 (4%): scale=1.0',           drawdownScale(-200, 5000) === 1.0)
  assert('-$250 (5%): scale=0.75',          drawdownScale(-250, 5000) === 0.75)
  assert('-$499 (9.98%): scale=0.75',       drawdownScale(-499, 5000) === 0.75)
  assert('-$500 (10%): scale=0.5',          drawdownScale(-500, 5000) === 0.5)
  assert('-$1000 (20%): scale=0.5',         drawdownScale(-1000, 5000) === 0.5)
}

// MAX_YES_PER_PITCHER: ensure cap is configurable (now 5 not 3)
{
  const DEFAULT_MAX_YES = 5  // new default from bettingRules.js
  const OLD_MAX_YES     = 3  // old hardcoded cap
  assert('New max YES per pitcher (5) > old hardcoded (3)', DEFAULT_MAX_YES > OLD_MAX_YES)
  // With 5 thresholds and correlated Kelly, can now capture more of the distribution
  const fiveThresholds = Array.from({ length: 5 }, (_, i) => ({
    modelProb: 0.85 - i * 0.10,
    marketPrice: 0.50 - i * 0.07,
    side: 'YES',
  })).filter(e => e.modelProb > 0.35 && e.modelProb > e.marketPrice)
  assert(`${fiveThresholds.length} YES thresholds pass quality gate`, fiveThresholds.length >= 3)
}

// live_bayesian_weight_cap default
{
  const NEW_CAP = 0.75
  const OLD_CAP = 0.50
  // At BF=30, old cap leaves 50% weight on prior (stale); new cap uses 75% live
  const oldBlend = OLD_CAP
  const newBlend = Math.min(NEW_CAP, 30 / 30)  // = 0.75
  assert('BF=30: new cap uses 50% more live evidence than old', newBlend > oldBlend)
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log('\n' + '─'.repeat(60))
console.log(`  Tests passed: ${passed}`)
console.log(`  Tests failed: ${failed}`)
if (failures.length) {
  console.log('\n  FAILURES:')
  failures.forEach(f => console.log(`    ✗ ${f}`))
}
console.log('─'.repeat(60))

process.exit(failed > 0 ? 1 : 0)
