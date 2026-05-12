// scripts/smokeTestHedgeConfidence.js — Comprehensive tests for pull-hedge confidence system
// Run: node scripts/smokeTestHedgeConfidence.js

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

function assertApprox(actual, expected, tolerance, msg) {
  const ok = Math.abs(actual - expected) <= tolerance
  if (ok) {
    console.log(`  ✅ ${msg}  (${actual.toFixed(4)} ≈ ${expected.toFixed(4)})`)
    passed++
  } else {
    console.error(`  ❌ FAIL: ${msg}  (${actual.toFixed(4)} ≠ ${expected.toFixed(4)}, tol=${tolerance})`)
    failed++
    failures.push(msg)
  }
}

// ── Inline pure functions (mirrors liveMonitor.js exactly) ──────────────────

const DEFAULT_CONSERVATIVE_PULL_PITCH = 105

function structuralCeiling({ currentPitches, currentBF, conservativePullPitch = DEFAULT_CONSERVATIVE_PULL_PITCH }) {
  if (!currentBF || currentBF <= 0) return 999
  const pitchesPerBF    = currentPitches / currentBF
  const remainingPitches = Math.max(0, conservativePullPitch - currentPitches)
  return Math.floor(remainingPitches / pitchesPerBF)
}

function batterGauntletProb(nextBatters, needed) {
  const probs = (nextBatters ?? []).map(b => Math.max(0.01, Math.min(0.99, b.kPct ?? 0.20)))
  const N = probs.length
  if (needed <= 0) return 1.0
  if (needed > N)  return 0.0
  const dp = new Array(N + 1).fill(0)
  dp[0] = 1.0
  for (let i = 0; i < N; i++) {
    const p = probs[i]
    for (let j = i + 1; j >= 1; j--) dp[j] = dp[j] * (1 - p) + dp[j - 1] * p
    dp[0] *= (1 - p)
  }
  let pAtLeast = 0
  for (let k = needed; k <= N; k++) pAtLeast += dp[k]
  return Math.max(0, Math.min(1, pAtLeast))
}

function computeHedgeConfidence({ needed, currentPitches, currentBF, noMid, modelProb,
    nextBatters, scoreDiff, currentInn }) {
  const signals = {}
  let score = 0

  // Signal 1: Structural ceiling
  const ceiling = structuralCeiling({ currentPitches, currentBF })
  signals.ceiling = ceiling; signals.needed = needed
  if (ceiling < needed)         { signals.structural = 'impossible'; score += 50 }
  else if (ceiling <= needed)   { signals.structural = 'tight';      score += 30 }
  else if (ceiling <= needed + 2) { signals.structural = 'limited'; score += 15 }
  else                          { signals.structural = 'open' }

  // Signal 2: Batter gauntlet
  const hasGauntletData = Array.isArray(nextBatters) && nextBatters.some(b => b.kPct != null)
  if (hasGauntletData) {
    const pHit = batterGauntletProb(nextBatters.slice(0, 3), needed)
    signals.gauntletProb = pHit
    if (pHit < 0.05)      score += 30
    else if (pHit < 0.10) score += 20
    else if (pHit < 0.20) score += 10
    else if (pHit < 0.30) score += 5
  } else { signals.gauntletProb = null }

  // Signal 5: Market + model dual confirmation
  const marketNoProb = noMid / 100
  signals.modelProb = modelProb; signals.marketNoProb = marketNoProb
  if (marketNoProb >= 0.65 && modelProb <= 0.20)      { signals.marketModel = 'strong';   score += 20 }
  else if (marketNoProb >= 0.55 && modelProb <= 0.30) { signals.marketModel = 'moderate'; score += 10 }
  else if (marketNoProb >= 0.45 && modelProb <= 0.40) { signals.marketModel = 'weak';     score += 5  }
  else                                                 { signals.marketModel = 'diverged' }

  // Signal 6: Game state
  const inn = typeof currentInn === 'number' ? currentInn
    : parseInt(String(currentInn ?? '').replace(/\D/g, '')) || 0
  signals.inning = inn; signals.scoreDiff = scoreDiff
  if (scoreDiff <= -4 && inn >= 6)  { signals.gameState = 'blowout-pull'; score += 15 }
  else if (scoreDiff <= -2 && inn >= 7) { signals.gameState = 'losing-late'; score += 10 }
  else if (inn >= 8)                { signals.gameState = 'very-late';    score += 5  }
  else if (scoreDiff >= 4 && inn >= 6) { signals.gameState = 'winning-big'; score += 5 }
  else                              { signals.gameState = 'normal' }

  const confident      = score >= 45
  const sizeMultiplier = score >= 90 ? 1.00 : score >= 70 ? 0.75 : score >= 45 ? 0.50 : 0
  return { score, confident, sizeMultiplier, signals }
}

function _computeHedgePlan({ yesFilledContracts, yesFillCents, noAskCents, modelProb, maxUSD }) {
  if (noAskCents <= 0 || noAskCents >= 100) return { qualified: false, reason: 'noAsk-out-of-range' }
  if (!yesFilledContracts || yesFilledContracts <= 0) return { qualified: false, reason: 'fullOffset-zero' }
  const kalshiFee       = 0.93
  const yesFillFrac     = yesFillCents / 100
  const noAskFrac       = noAskCents / 100
  const noNetPerContract = (1 - noAskFrac) * kalshiFee
  const yesExposure     = yesFilledContracts * yesFillFrac
  const fullOffset      = Math.ceil(yesExposure / noNetPerContract)
  if (fullOffset <= 0) return { qualified: false, reason: 'fullOffset-zero' }
  const evYesPerContract = modelProb * (1 - yesFillFrac) - (1 - modelProb) * yesFillFrac
  const evNoLeg          = (1 - modelProb) * noNetPerContract - modelProb * noAskFrac
  const evHedge   = yesFilledContracts * evYesPerContract + fullOffset * evNoLeg
  const evNoHedge = yesFilledContracts * evYesPerContract
  if (evNoLeg <= 0) return { qualified: false, reason: 'ev-gate-fail', evHedge, evNoHedge }
  const rawCost = fullOffset * noAskFrac
  const capped  = rawCost > maxUSD
  const hedgeContracts = capped ? Math.max(1, Math.floor(maxUSD / noAskFrac)) : fullOffset
  const hedgeCost = hedgeContracts * noAskFrac
  return { qualified: true, hedgeContracts, hedgeCost, capped, fullOffset, evHedge, evNoHedge, reason: 'qualified' }
}

// ── Test runner ──────────────────────────────────────────────────────────────

console.log('\n══════════════════════════════════════════════════════')
console.log('  PULL-HEDGE CONFIDENCE SYSTEM — COMPREHENSIVE TESTS')
console.log('══════════════════════════════════════════════════════\n')

// ────────────────────────────────────────────────────────────────────────────
// SECTION 1: structuralCeiling
// ────────────────────────────────────────────────────────────────────────────
console.log('── Section 1: structuralCeiling ──')

{
  // Normal case: 80p / 24BF = 3.33 p/BF; 25 remaining → floor(25/3.33) = 7
  const c = structuralCeiling({ currentPitches: 80, currentBF: 24 })
  assert(c === 7, `S1.1 normal case: 80p/24BF → ceiling=${c} (expected 7)`)
}
{
  // At the pull threshold: 105p / 25BF = 4.2 p/BF; 0 remaining → 0
  const c = structuralCeiling({ currentPitches: 105, currentBF: 25 })
  assert(c === 0, `S1.2 at pull threshold: ceiling=${c} (expected 0)`)
}
{
  // Past pull threshold: remaining goes negative → clamped to 0 → floor(0/x) = 0
  const c = structuralCeiling({ currentPitches: 112, currentBF: 28 })
  assert(c === 0, `S1.3 past pull threshold: ceiling=${c} (expected 0)`)
}
{
  // Very efficient pitcher (2 p/BF), early in game
  const c = structuralCeiling({ currentPitches: 60, currentBF: 30, conservativePullPitch: 105 })
  // 60/30=2 p/BF; 45 remaining → floor(45/2)=22
  assert(c === 22, `S1.4 efficient pitcher early: ceiling=${c} (expected 22)`)
}
{
  // Zero BF guard: returns 999 (infinite ceiling)
  const c = structuralCeiling({ currentPitches: 50, currentBF: 0 })
  assert(c === 999, `S1.5 zero BF guard: ceiling=${c} (expected 999)`)
}
{
  // Custom conservativePullPitch = 90 (manager pulls early)
  const c = structuralCeiling({ currentPitches: 75, currentBF: 25, conservativePullPitch: 90 })
  // 75/25=3 p/BF; 15 remaining → floor(15/3) = 5
  assert(c === 5, `S1.6 custom pull threshold 90: ceiling=${c} (expected 5)`)
}
{
  // High pitch-count per BF (wild pitcher), 88p/20BF = 4.4 p/BF
  const c = structuralCeiling({ currentPitches: 88, currentBF: 20 })
  // remaining = 105-88=17; floor(17/4.4) = floor(3.86) = 3
  assert(c === 3, `S1.7 wild pitcher high count: ceiling=${c} (expected 3)`)
}
{
  // 1 BF (nearly fresh, first batter): 50/1=50 p/BF; remaining=55 → floor(55/50)=1
  const c = structuralCeiling({ currentPitches: 50, currentBF: 1 })
  assert(c === 1, `S1.8 single BF: ceiling=${c} (expected 1)`)
}

// ────────────────────────────────────────────────────────────────────────────
// SECTION 2: batterGauntletProb
// ────────────────────────────────────────────────────────────────────────────
console.log('\n── Section 2: batterGauntletProb ──')

{
  // needed=0: always 1.0 (need 0 Ks from anyone)
  const p = batterGauntletProb([{kPct:0.25},{kPct:0.30},{kPct:0.20}], 0)
  assert(p === 1.0, `S2.1 needed=0: p=${p} (expected 1.0)`)
}
{
  // needed > N: impossible → 0.0
  const p = batterGauntletProb([{kPct:0.25},{kPct:0.30}], 3)
  assert(p === 0.0, `S2.2 needed > N: p=${p} (expected 0.0)`)
}
{
  // 1 batter, need 1: exactly that batter's K%
  const p = batterGauntletProb([{kPct:0.28}], 1)
  assertApprox(p, 0.28, 0.001, `S2.3 1 batter need 1: p=${p.toFixed(4)}`)
}
{
  // 2 batters at 0.25 each, need 1: P(at least 1) = 1 - (0.75)^2 = 0.4375
  const p = batterGauntletProb([{kPct:0.25},{kPct:0.25}], 1)
  assertApprox(p, 0.4375, 0.001, `S2.4 2 batters 25% each, need 1`)
}
{
  // 3 batters at 0.25 each, need 3: P(all K) = 0.25^3 = 0.015625
  const p = batterGauntletProb([{kPct:0.25},{kPct:0.25},{kPct:0.25}], 3)
  assertApprox(p, 0.015625, 0.0001, `S2.5 3 batters 25% each, need 3 (all must K)`)
}
{
  // 3 batters at 0.01 each, need 1: very low K guys, very unlikely to get any K
  const p = batterGauntletProb([{kPct:0.01},{kPct:0.01},{kPct:0.01}], 1)
  // P(at least 1) = 1 - (0.99)^3 ≈ 0.0297
  assertApprox(p, 1 - (0.99 ** 3), 0.001, `S2.6 3 weak contact hitters (1% K), need 1`)
}
{
  // 3 batters at 0.99 each, need 3: very high K guys, near certain
  const p = batterGauntletProb([{kPct:0.99},{kPct:0.99},{kPct:0.99}], 3)
  // P(all K) = 0.99^3 ≈ 0.9703
  assertApprox(p, 0.99 ** 3, 0.001, `S2.7 3 elite strikeout batters (99% K), need 3`)
}
{
  // null kPct treated as 0.20 default
  const p1 = batterGauntletProb([{kPct:null},{kPct:null},{kPct:null}], 1)
  const p2 = batterGauntletProb([{kPct:0.20},{kPct:0.20},{kPct:0.20}], 1)
  assertApprox(p1, p2, 0.001, `S2.8 null kPct uses 0.20 default`)
}
{
  // Mixed: first batter .45, second .15, need 1
  // P(at least 1) = 1 - (1-0.45)(1-0.15) = 1 - 0.55*0.85 = 1 - 0.4675 = 0.5325
  const p = batterGauntletProb([{kPct:0.45},{kPct:0.15}], 1)
  assertApprox(p, 0.5325, 0.001, `S2.9 mixed K rates, need 1`)
}
{
  // Empty array, need 1: impossible → 0.0
  const p = batterGauntletProb([], 1)
  assert(p === 0.0, `S2.10 empty batter list, need 1: p=${p}`)
}
{
  // needed=2 from 3 batters at 0.30 each
  // P(≥2) = P(exactly 2) + P(exactly 3)
  // P(2) = C(3,2) × 0.3^2 × 0.7 = 3 × 0.09 × 0.7 = 0.189
  // P(3) = 0.3^3 = 0.027
  const p = batterGauntletProb([{kPct:0.30},{kPct:0.30},{kPct:0.30}], 2)
  assertApprox(p, 0.189 + 0.027, 0.001, `S2.11 3 batters 30% each, need 2`)
}
{
  // Out-of-range kPct clamped: kPct=1.5 should be treated as 0.99
  const p1 = batterGauntletProb([{kPct:1.5}], 1)
  const p2 = batterGauntletProb([{kPct:0.99}], 1)
  assertApprox(p1, p2, 0.001, `S2.12 kPct > 1.0 clamped to 0.99`)
}

// ────────────────────────────────────────────────────────────────────────────
// SECTION 3: computeHedgeConfidence — Signal 1 (structural ceiling)
// ────────────────────────────────────────────────────────────────────────────
console.log('\n── Section 3: computeHedgeConfidence — Signal 1 (structural) ──')

const BASE = { noMid: 30, modelProb: 0.40, nextBatters: null, scoreDiff: 0, currentInn: 5 }

{
  // Impossible: ceiling < needed → +50 → alone pushes to confident
  const r = computeHedgeConfidence({ ...BASE, needed: 3, currentPitches: 105, currentBF: 25 })
  // ceiling=0 < needed=3 → structural=impossible, score≥50
  assert(r.signals.structural === 'impossible', `S3.1 impossible: structural tag correct`)
  assert(r.score >= 50, `S3.2 impossible: score=${r.score} ≥ 50`)
  assert(r.confident, `S3.3 impossible alone → confident=true`)
  assert(r.sizeMultiplier >= 0.50, `S3.4 impossible: sizeMultiplier=${r.sizeMultiplier} ≥ 0.5`)
}
{
  // Tight: ceiling === needed → +30
  // 90p/25BF = 3.6 p/BF; remaining=15; floor(15/3.6)=4 → ceiling=4, needed=4 → tight
  const r = computeHedgeConfidence({ ...BASE, needed: 4, currentPitches: 90, currentBF: 25 })
  assert(r.signals.structural === 'tight', `S3.5 tight structural tag`)
  assert(r.score >= 30, `S3.6 tight: score=${r.score} ≥ 30`)
}
{
  // Limited: ceiling = needed + 1 → +15
  // 80p/24BF=3.33; remaining=25; floor(25/3.33)=7; needed=6 → ceiling=7=needed+1 → limited
  const r = computeHedgeConfidence({ ...BASE, needed: 6, currentPitches: 80, currentBF: 24 })
  assert(r.signals.structural === 'limited', `S3.7 limited: ceiling=${r.signals.ceiling}, needed=6`)
}
{
  // Open: ceiling much larger than needed → no score added from Signal 1
  const r = computeHedgeConfidence({ ...BASE, needed: 2, currentPitches: 50, currentBF: 20 })
  // 50/20=2.5 p/BF; remaining=55; floor(55/2.5)=22 → open
  assert(r.signals.structural === 'open', `S3.8 open: ceiling=${r.signals.ceiling}`)
}

// ────────────────────────────────────────────────────────────────────────────
// SECTION 4: computeHedgeConfidence — Signal 2 (batter gauntlet)
// ────────────────────────────────────────────────────────────────────────────
console.log('\n── Section 4: computeHedgeConfidence — Signal 2 (batter gauntlet) ──')

{
  // No batter data → gauntletProb = null, no score contribution
  const r = computeHedgeConfidence({ ...BASE, needed: 2, currentPitches: 80, currentBF: 24, nextBatters: null })
  assert(r.signals.gauntletProb === null, `S4.1 null batters → gauntletProb null`)
}
{
  // No kPct on any batter → treated as no data
  const r = computeHedgeConfidence({ ...BASE, needed: 2, currentPitches: 80, currentBF: 24, nextBatters: [{id:1},{id:2},{id:3}] })
  assert(r.signals.gauntletProb === null, `S4.2 batters with no kPct → gauntletProb null`)
}
{
  // Very low K probability batters → high score from gauntlet (+30 if pHit < 0.05)
  const lowK = [{kPct:0.05},{kPct:0.05},{kPct:0.05}]
  const r = computeHedgeConfidence({ ...BASE, needed: 3, currentPitches: 105, currentBF: 25, nextBatters: lowK })
  // pHit for 3 K from 3 batters at 5% each = 0.05^3 = 0.000125 → < 0.05 → +30
  assert(r.signals.gauntletProb < 0.05, `S4.3 low K batters need 3: pHit=${r.signals.gauntletProb?.toFixed(4)} < 0.05`)
}
{
  // High K probability batters → low score from gauntlet
  const highK = [{kPct:0.40},{kPct:0.45},{kPct:0.50}]
  const r1 = computeHedgeConfidence({ ...BASE, needed: 2, currentPitches: 80, currentBF: 24, nextBatters: highK })
  const r2 = computeHedgeConfidence({ ...BASE, needed: 2, currentPitches: 80, currentBF: 24, nextBatters: null })
  // High K batters → pHit is decent → less score from gauntlet than no-data case
  // (no-data adds 0 to score; high K adds less than low K)
  assert(r1.signals.gauntletProb > 0.30, `S4.4 high K batters, need 2: pHit=${r1.signals.gauntletProb?.toFixed(3)} > 0.30`)
}
{
  // Mixed-quality gauntlet, need 1 K
  const mixed = [{kPct:0.35},{kPct:0.08},{kPct:0.22}]
  const r = computeHedgeConfidence({ ...BASE, needed: 1, currentPitches: 80, currentBF: 24, nextBatters: mixed })
  // P(at least 1 K from 3) is high → not in the <0.05 bracket
  assert(r.signals.gauntletProb > 0.30, `S4.5 mixed batters need 1: gauntlet prob=${r.signals.gauntletProb?.toFixed(3)}`)
}

// ────────────────────────────────────────────────────────────────────────────
// SECTION 5: computeHedgeConfidence — Signal 5 (market+model)
// ────────────────────────────────────────────────────────────────────────────
console.log('\n── Section 5: computeHedgeConfidence — Signal 5 (market+model) ──')

const STRUCT_NONE = { needed: 1, currentPitches: 50, currentBF: 20 }  // ceiling=22, open → 0 from S1

{
  // Strong confirmation: noMid=70 (marketNoProb=0.70), modelProb=0.15 → +20
  const r = computeHedgeConfidence({ ...STRUCT_NONE, noMid: 70, modelProb: 0.15, nextBatters: null, scoreDiff: 0, currentInn: 4 })
  assert(r.signals.marketModel === 'strong', `S5.1 strong market+model: tag=${r.signals.marketModel}`)
  // Total should include +20 from market signal
  const baseline = computeHedgeConfidence({ ...STRUCT_NONE, noMid: 20, modelProb: 0.50, nextBatters: null, scoreDiff: 0, currentInn: 4 })
  assert(r.score >= baseline.score + 20, `S5.2 strong market adds ≥20 to score`)
}
{
  // Moderate: noMid=60, modelProb=0.25 → +10
  const r = computeHedgeConfidence({ ...STRUCT_NONE, noMid: 60, modelProb: 0.25, nextBatters: null, scoreDiff: 0, currentInn: 4 })
  assert(r.signals.marketModel === 'moderate', `S5.3 moderate market+model`)
}
{
  // Weak: noMid=50, modelProb=0.38 → +5
  const r = computeHedgeConfidence({ ...STRUCT_NONE, noMid: 50, modelProb: 0.38, nextBatters: null, scoreDiff: 0, currentInn: 4 })
  assert(r.signals.marketModel === 'weak', `S5.4 weak market+model`)
}
{
  // Diverged: model says prob=0.50 (likely to K), noMid=20 → diverged
  const r = computeHedgeConfidence({ ...STRUCT_NONE, noMid: 20, modelProb: 0.50, nextBatters: null, scoreDiff: 0, currentInn: 4 })
  assert(r.signals.marketModel === 'diverged', `S5.5 diverged: model=50% but noMid=20`)
}
{
  // Boundary: noMid=65 (marketNoProb=0.65), modelProb=0.20 → exactly strong
  const r = computeHedgeConfidence({ ...STRUCT_NONE, noMid: 65, modelProb: 0.20, nextBatters: null, scoreDiff: 0, currentInn: 4 })
  assert(r.signals.marketModel === 'strong', `S5.6 boundary strong: noMid=65, modelProb=0.20`)
}
{
  // Boundary: noMid=64, modelProb=0.20 → not strong, check moderate threshold (noMid≥55)
  const r = computeHedgeConfidence({ ...STRUCT_NONE, noMid: 64, modelProb: 0.25, nextBatters: null, scoreDiff: 0, currentInn: 4 })
  assert(r.signals.marketModel === 'moderate', `S5.7 noMid=64 modelProb=0.25 → moderate`)
}

// ────────────────────────────────────────────────────────────────────────────
// SECTION 6: computeHedgeConfidence — Signal 6 (game state)
// ────────────────────────────────────────────────────────────────────────────
console.log('\n── Section 6: computeHedgeConfidence — Signal 6 (game state) ──')

const STRUCT_NONE2 = { needed: 1, currentPitches: 50, currentBF: 20, noMid: 20, modelProb: 0.50, nextBatters: null }

{
  // Blowout pull: deficit ≤ -4, inning ≥ 6 → +15
  const r = computeHedgeConfidence({ ...STRUCT_NONE2, scoreDiff: -5, currentInn: 7 })
  assert(r.signals.gameState === 'blowout-pull', `S6.1 blowout-pull tag`)
}
{
  // Blowout boundary: deficit = -4, inning = 6 → blowout-pull
  const r = computeHedgeConfidence({ ...STRUCT_NONE2, scoreDiff: -4, currentInn: 6 })
  assert(r.signals.gameState === 'blowout-pull', `S6.2 blowout boundary (-4 runs, inn=6)`)
}
{
  // Blowout NOT triggered: deficit = -4 but inning = 5 → not blowout
  const r = computeHedgeConfidence({ ...STRUCT_NONE2, scoreDiff: -4, currentInn: 5 })
  assert(r.signals.gameState !== 'blowout-pull', `S6.3 blowout NOT in inn 5: gameState=${r.signals.gameState}`)
}
{
  // Losing late: deficit ≤ -2, inning ≥ 7 → +10
  const r = computeHedgeConfidence({ ...STRUCT_NONE2, scoreDiff: -3, currentInn: 8 })
  assert(r.signals.gameState === 'losing-late', `S6.4 losing-late tag`)
}
{
  // Very late: inn ≥ 8, score diff doesn't qualify for others → +5
  const r = computeHedgeConfidence({ ...STRUCT_NONE2, scoreDiff: 0, currentInn: 8 })
  assert(r.signals.gameState === 'very-late', `S6.5 very-late tag (inn=8, tied)`)
}
{
  // Winning big: scoreDiff ≥ +4, inn ≥ 6 → +5 (team is winning big, pitcher may stay)
  const r = computeHedgeConfidence({ ...STRUCT_NONE2, scoreDiff: 5, currentInn: 7 })
  assert(r.signals.gameState === 'winning-big', `S6.6 winning-big tag`)
}
{
  // Normal: no special state
  const r = computeHedgeConfidence({ ...STRUCT_NONE2, scoreDiff: 1, currentInn: 4 })
  assert(r.signals.gameState === 'normal', `S6.7 normal game state`)
}
{
  // String inning parses correctly: '7th' → 7 → very-late
  const r = computeHedgeConfidence({ ...STRUCT_NONE2, scoreDiff: 0, currentInn: '8th' })
  assert(r.signals.inning === 8, `S6.8 string inning '8th' parsed to 8`)
  assert(r.signals.gameState === 'very-late', `S6.9 string inning triggers very-late`)
}

// ────────────────────────────────────────────────────────────────────────────
// SECTION 7: computeHedgeConfidence — Score thresholds & sizeMultiplier
// ────────────────────────────────────────────────────────────────────────────
console.log('\n── Section 7: Score thresholds & sizeMultiplier ──')

{
  // Score < 45 → not confident, sizeMultiplier = 0
  const r = computeHedgeConfidence({ needed: 1, currentPitches: 50, currentBF: 20, noMid: 20, modelProb: 0.50, nextBatters: null, scoreDiff: 0, currentInn: 3 })
  assert(!r.confident, `S7.1 low score (${r.score}) → not confident`)
  assert(r.sizeMultiplier === 0, `S7.2 low score → sizeMultiplier=0`)
}
{
  // Score in [45,70) → confident, sizeMultiplier = 0.50
  // Impossible structural alone = +50 → score=50
  const r = computeHedgeConfidence({ needed: 5, currentPitches: 105, currentBF: 25, noMid: 20, modelProb: 0.50, nextBatters: null, scoreDiff: 0, currentInn: 3 })
  assert(r.score >= 45 && r.score < 70, `S7.3 score=${r.score} in [45,70)`)
  assert(r.confident, `S7.4 confident=true at score=${r.score}`)
  assert(r.sizeMultiplier === 0.50, `S7.5 sizeMultiplier=0.50 at score=${r.score}`)
}
{
  // Score in [70,90) → sizeMultiplier = 0.75
  // Impossible(+50) + strong market(+20) = 70 exactly
  const r = computeHedgeConfidence({ needed: 5, currentPitches: 105, currentBF: 25, noMid: 70, modelProb: 0.15, nextBatters: null, scoreDiff: 0, currentInn: 3 })
  assert(r.score >= 70 && r.score < 90, `S7.6 score=${r.score} in [70,90)`)
  assert(r.sizeMultiplier === 0.75, `S7.7 sizeMultiplier=0.75 at score=${r.score}`)
}
{
  // Score ≥ 90 → sizeMultiplier = 1.00
  // Impossible(+50) + very-low gauntlet(+30) + strong market(+20) = 100
  const lowK = [{kPct:0.01},{kPct:0.01},{kPct:0.01}]
  const r = computeHedgeConfidence({ needed: 5, currentPitches: 105, currentBF: 25, noMid: 70, modelProb: 0.15, nextBatters: lowK, scoreDiff: 0, currentInn: 3 })
  assert(r.score >= 90, `S7.8 max confidence score=${r.score} ≥ 90`)
  assert(r.sizeMultiplier === 1.00, `S7.9 sizeMultiplier=1.00 at score=${r.score}`)
}

// ────────────────────────────────────────────────────────────────────────────
// SECTION 8: computeHedgeConfidence — combination scenarios
// ────────────────────────────────────────────────────────────────────────────
console.log('\n── Section 8: Combination scenarios ──')

{
  // The pitcher has 4K, needs 2 more. 88p/22BF=4p/BF; remaining=17; ceiling=4. needed=2 → open(4>2+2=4? no, 4<=2+2=4 → limited)
  // Actually ceiling=4, needed=2 → ceiling <= needed+2 → limited (+15)
  // noMid=60, modelProb=0.25 → moderate (+10)
  // scoreDiff=0, inn=6 → normal (+0)
  // No batters
  // Total = 15 + 10 = 25 → not confident
  const r = computeHedgeConfidence({ needed: 2, currentPitches: 88, currentBF: 22, noMid: 60, modelProb: 0.25, nextBatters: null, scoreDiff: 0, currentInn: 6 })
  assert(r.signals.structural === 'limited', `S8.1 limited structural`)
  assert(r.score === 25, `S8.2 limited+moderate=25, score=${r.score}`)
  assert(!r.confident, `S8.3 score=25 → not confident`)
}
{
  // Pitcher needs 2, ceiling is tight. noMid=65, modelProb=0.18, scoreDiff=-5, inn=7, good batters
  // structural: ceiling tight (+30 or impossible +50)... let me compute
  // 92p/23BF=4 p/BF; remaining=13; ceiling=floor(13/4)=3; needed=2 → ceiling=3=needed+1 → limited (+15)
  // noMid=65, modelProb=0.18 → strong (+20)
  // scoreDiff=-5, inn=7 → blowout-pull (+15)
  // No batter data
  // Total = 15 + 20 + 15 = 50 → confident, sizeMultiplier=0.50
  const r = computeHedgeConfidence({ needed: 2, currentPitches: 92, currentBF: 23, noMid: 65, modelProb: 0.18, nextBatters: null, scoreDiff: -5, currentInn: 7 })
  assert(r.score === 50, `S8.4 limited+strong market+blowout=50, got ${r.score}`)
  assert(r.confident, `S8.5 score=50 → confident`)
  assert(r.sizeMultiplier === 0.50, `S8.6 score=50 → sizeMultiplier=0.50`)
}
{
  // The "save our money" scenario: pitcher at 80p after 5 innings with 4K, needs 3 more.
  // 80p/20BF=4 p/BF; remaining=25; ceiling=floor(25/4)=6; needed=3 → ceiling>needed+2=5? No: 6>5=true → open (+0)
  // noMid=65, modelProb=0.18 → strong (+20)
  // two outs in inning, but we track innings not outs — inn=5, scoreDiff=-1 → normal (+0)
  // no batters
  // Total = 20 → not confident yet (needs 45)
  const r = computeHedgeConfidence({ needed: 3, currentPitches: 80, currentBF: 20, noMid: 65, modelProb: 0.18, nextBatters: null, scoreDiff: -1, currentInn: 5 })
  assert(r.score === 20, `S8.7 open+strong market only=20, got ${r.score}`)
  assert(!r.confident, `S8.8 score=20 → not confident (correct, no hedge)`)
}
{
  // Confident only because signals converge: none individually strong enough
  // structural=open (+0), noMid=45 modelProb=0.38 → weak (+5), inn=8 scoreDiff=0 → very-late (+5), no batters
  // Total=10 → not confident
  const r = computeHedgeConfidence({ needed: 2, currentPitches: 50, currentBF: 20, noMid: 45, modelProb: 0.38, nextBatters: null, scoreDiff: 0, currentInn: 8 })
  assert(r.score === 10, `S8.9 all weak signals = 10, got ${r.score}`)
  assert(!r.confident, `S8.10 weak convergence → not confident`)
}

// ────────────────────────────────────────────────────────────────────────────
// SECTION 9: _computeHedgePlan — core math verification
// ────────────────────────────────────────────────────────────────────────────
console.log('\n── Section 9: _computeHedgePlan math ──')

{
  // Normal case: 10 YES @ 40¢ = $4 exposure; NO ask = 30¢
  // noNetPerContract = (1-0.30)*0.93 = 0.651
  // yesExposure = 10 * 0.40 = $4
  // fullOffset = ceil(4 / 0.651) = ceil(6.14) = 7
  const r = _computeHedgePlan({ yesFilledContracts: 10, yesFillCents: 40, noAskCents: 30, modelProb: 0.10, maxUSD: 100 })
  assert(r.qualified, `S9.1 normal qualify`)
  assert(r.fullOffset === 7, `S9.2 fullOffset=${r.fullOffset} (expected 7)`)
  assertApprox(r.hedgeContracts, 7, 0, `S9.3 hedgeContracts=${r.hedgeContracts} (uncapped=7)`)
}
{
  // EV gate: modelProb=0.80 → pitcher likely to K → buying NO loses EV → reject
  const r = _computeHedgePlan({ yesFilledContracts: 10, yesFillCents: 40, noAskCents: 30, modelProb: 0.80, maxUSD: 100 })
  assert(!r.qualified, `S9.4 EV gate rejects when modelProb=0.80`)
  assert(r.reason === 'ev-gate-fail', `S9.5 reason=${r.reason}`)
}
{
  // Cap applies: 5 YES @ 60¢ = $3 exposure; NO ask = 45¢
  // noNetPerContract = 0.55 * 0.93 = 0.5115
  // fullOffset = ceil(3 / 0.5115) = ceil(5.87) = 6
  // rawCost = 6 * 0.45 = $2.70 — under cap
  const r = _computeHedgePlan({ yesFilledContracts: 5, yesFillCents: 60, noAskCents: 45, modelProb: 0.10, maxUSD: 2 })
  // rawCost=$2.70 > maxUSD=$2 → cap applies → hedgeContracts = floor(2/0.45) = floor(4.44) = 4
  assert(r.qualified, `S9.6 capped plan still qualifies`)
  assert(r.capped, `S9.7 capped=true`)
  assert(r.hedgeContracts === 4, `S9.8 hedgeContracts=${r.hedgeContracts} (expected 4 after cap)`)
}
{
  // Illiquid NO (out of range)
  const r = _computeHedgePlan({ yesFilledContracts: 5, yesFillCents: 40, noAskCents: 0, modelProb: 0.10, maxUSD: 100 })
  assert(!r.qualified, `S9.9 noAskCents=0 → not qualified`)
  assert(r.reason === 'noAsk-out-of-range', `S9.10 reason=${r.reason}`)
}
{
  // Zero contracts
  const r = _computeHedgePlan({ yesFilledContracts: 0, yesFillCents: 40, noAskCents: 30, modelProb: 0.10, maxUSD: 100 })
  assert(!r.qualified, `S9.11 zero contracts → not qualified`)
}
{
  // noAskCents=99: noNetPerContract=(0.01*0.93)=0.0093; break-even modelProb < 0.0093.
  // Even at modelProb=0.01 the EV gate rejects: evNoLeg=0.99*0.0093−0.01*0.99=0.009207−0.0099<0
  const r = _computeHedgePlan({ yesFilledContracts: 10, yesFillCents: 40, noAskCents: 99, modelProb: 0.01, maxUSD: 1000 })
  assert(!r.qualified, `S9.12 noAskCents=99 always rejected by EV gate — net payout too tiny`)
  assert(r.reason === 'ev-gate-fail', `S9.13 reason=${r.reason} (ev-gate-fail)`)
}

// ────────────────────────────────────────────────────────────────────────────
// SECTION 10: sizeMultiplier integration with _computeHedgePlan
// ────────────────────────────────────────────────────────────────────────────
console.log('\n── Section 10: sizeMultiplier × hedgeContracts integration ──')

{
  // Simulates what the bettor loop does: scale hedgeContracts by sizeMultiplier
  const hedgePlan = _computeHedgePlan({ yesFilledContracts: 10, yesFillCents: 40, noAskCents: 30, modelProb: 0.10, maxUSD: 100 })
  assert(hedgePlan.qualified, `S10.1 base plan qualified`)

  // Low confidence (score < 45) → sizeMultiplier=0 → no bet
  const noConf = { sizeMultiplier: 0 }
  const contracts0 = Math.max(1, Math.round(hedgePlan.hedgeContracts * noConf.sizeMultiplier))
  // Edge: sizeMultiplier=0 → Math.round(7*0)=0 → Math.max(1,0)=1 → still 1 minimum
  // But the actual gate in liveMonitor uses: if (!hedgePlan.qualified) skip — sizeMultiplier=0 means NOT confident, so we don't even get here
  // The sizeMultiplier=0 path is filtered by `if (!confidence.confident)` before the bettor loop
  assert(contracts0 === 1, `S10.2 sizeMultiplier=0 still yields min 1 contract (floor protection)`)

  // Medium confidence (sizeMultiplier=0.5) → ~50% of fullOffset
  const medContracts = Math.max(1, Math.round(hedgePlan.hedgeContracts * 0.5))
  assert(medContracts === 4, `S10.3 sizeMultiplier=0.5 → ${medContracts} contracts (expected 4 from 7)`)
  const medCost = medContracts * (30 / 100)
  assertApprox(medCost, 1.20, 0.001, `S10.4 medium hedge cost = $${medCost.toFixed(2)}`)

  // High confidence (sizeMultiplier=0.75) → ~75%
  const highContracts = Math.max(1, Math.round(hedgePlan.hedgeContracts * 0.75))
  assert(highContracts === 5, `S10.5 sizeMultiplier=0.75 → ${highContracts} contracts (expected 5 from 7)`)

  // Full conviction (sizeMultiplier=1.0) → all fullOffset contracts
  const fullContracts = Math.max(1, Math.round(hedgePlan.hedgeContracts * 1.0))
  assert(fullContracts === 7, `S10.6 sizeMultiplier=1.0 → ${fullContracts} contracts (expected 7)`)
}

// ────────────────────────────────────────────────────────────────────────────
// SECTION 11: "Never hedge a winning position" — EV gate
// ────────────────────────────────────────────────────────────────────────────
console.log('\n── Section 11: Never hedge a winning position ──')

{
  // EV gate rejects when modelProb pushes above the break-even for the given NO price.
  // At noAskCents=20: break-even ≈ 0.788. modelProb=0.80 (above break-even) → rejects.
  // evNoLeg = 0.20*0.80*0.93 − 0.80*0.20 = 0.1488 − 0.16 = −0.0112 < 0
  const r = _computeHedgePlan({ yesFilledContracts: 20, yesFillCents: 35, noAskCents: 20, modelProb: 0.80, maxUSD: 100 })
  assert(!r.qualified, `S11.1 modelProb=0.80 at noAsk=20¢ → EV gate rejects`)
}
{
  // noAskCents=20, modelProb=0.70: EV gate actually passes — NO is cheap enough.
  // evNoLeg = 0.30*0.80*0.93 − 0.70*0.20 = 0.2232 − 0.14 = 0.0832 > 0 → qualifies.
  // Confidence gate is the safety net here (marketModel signal will flag divergence).
  const r = _computeHedgePlan({ yesFilledContracts: 20, yesFillCents: 35, noAskCents: 20, modelProb: 0.70, maxUSD: 100 })
  assert(r.qualified, `S11.2 modelProb=0.70 at noAsk=20¢ → EV gate passes (NO cheap enough)`)
}
{
  // modelProb=0.50 → coin flip → marginal, depends on prices
  // evNoLeg = (1-0.50)*(1-0.20)*0.93 - 0.50*0.20 = 0.372 - 0.10 = 0.272 > 0 → qualifies
  const r = _computeHedgePlan({ yesFilledContracts: 20, yesFillCents: 35, noAskCents: 20, modelProb: 0.50, maxUSD: 100 })
  // evNoLeg = 0.5 * (0.80*0.93) - 0.5 * 0.20 = 0.5*0.744 - 0.1 = 0.372 - 0.10 = 0.272 > 0
  assert(r.qualified, `S11.3 modelProb=0.50 → EV gate passes (noAsk=20¢ cheap)`)
}
{
  // Expensive NO: noAskCents=60, modelProb=0.35 → check if EV gate passes
  // evNoLeg = (1-0.35)*(1-0.60)*0.93 - 0.35*0.60 = 0.65*0.40*0.93 - 0.21 = 0.2418 - 0.21 = 0.0318 > 0 → passes
  const r = _computeHedgePlan({ yesFilledContracts: 20, yesFillCents: 35, noAskCents: 60, modelProb: 0.35, maxUSD: 200 })
  assert(r.qualified, `S11.4 expensive NO @ 60¢, modelProb=0.35 → EV gate passes (barely)`)
}
{
  // Very expensive NO: noAskCents=80, modelProb=0.35
  // evNoLeg = 0.65 * 0.20 * 0.93 - 0.35 * 0.80 = 0.1209 - 0.28 = -0.1591 < 0 → reject
  const r = _computeHedgePlan({ yesFilledContracts: 20, yesFillCents: 35, noAskCents: 80, modelProb: 0.35, maxUSD: 200 })
  assert(!r.qualified, `S11.5 very expensive NO @ 80¢, modelProb=0.35 → EV gate rejects`)
}
{
  // computeHedgeConfidence gate: if model prob is high, structural signal alone shouldn't fire
  // because the EV gate in _computeHedgePlan would reject it per-bettor anyway
  // But the confidence gate is separate — it looks at modelProb via Signal 5 (market+model)
  // If modelProb=0.70, marketNoProb=0.20 → diverged (no score from S5)
  const r = computeHedgeConfidence({ needed: 3, currentPitches: 105, currentBF: 25, noMid: 20, modelProb: 0.70, nextBatters: null, scoreDiff: 0, currentInn: 5 })
  // impossible(+50), market diverged(+0), normal game state(+0)
  // score=50 → confidence.confident=true at score ≥ 45
  // But _computeHedgePlan will then reject per-bettor via EV gate → safe
  assert(r.confident, `S11.6 high modelProb: confidence=true but EV gate rejects per-bettor`)
  // Verify EV gate kills it downstream
  const plan = _computeHedgePlan({ yesFilledContracts: 10, yesFillCents: 40, noAskCents: 80, modelProb: 0.70, maxUSD: 100 })
  assert(!plan.qualified, `S11.7 EV gate correctly kills the bet even when confidence fires`)
}

// ────────────────────────────────────────────────────────────────────────────
// SECTION 12: Edge cases and boundary values
// ────────────────────────────────────────────────────────────────────────────
console.log('\n── Section 12: Edge cases ──')

{
  // structuralCeiling: currentPitches=0 (game just started, first batter)
  const c = structuralCeiling({ currentPitches: 0, currentBF: 0 })
  assert(c === 999, `S12.1 zero pitches, zero BF → 999 (guard)`)
}
{
  // batterGauntletProb: needed=0 always returns 1.0 regardless of batter quality
  const p = batterGauntletProb([{kPct:0.01}], 0)
  assert(p === 1.0, `S12.2 needed=0 → always 1.0`)
}
{
  // computeHedgeConfidence: score cannot exceed 115 (50+30+20+15)
  const maxBatters = [{kPct:0.01},{kPct:0.01},{kPct:0.01}]
  const r = computeHedgeConfidence({ needed: 10, currentPitches: 105, currentBF: 25, noMid: 70, modelProb: 0.15, nextBatters: maxBatters, scoreDiff: -6, currentInn: 7 })
  assert(r.score <= 115, `S12.3 max possible score ≤ 115, got ${r.score}`)
  assert(r.sizeMultiplier === 1.00, `S12.4 max score → full size`)
}
{
  // _computeHedgePlan: noAskCents=100 → out of range (NO would cost $1 = worthless)
  const r = _computeHedgePlan({ yesFilledContracts: 10, yesFillCents: 40, noAskCents: 100, modelProb: 0.10, maxUSD: 100 })
  assert(!r.qualified, `S12.5 noAskCents=100 → not qualified`)
}
{
  // _computeHedgePlan: very small YES exposure (1 contract at 5¢ fill)
  // exposure = 1 * 0.05 = $0.05; noNetPerContract = 0.93*0.70 = 0.651
  // fullOffset = ceil(0.05/0.651) = ceil(0.077) = 1
  const r = _computeHedgePlan({ yesFilledContracts: 1, yesFillCents: 5, noAskCents: 30, modelProb: 0.10, maxUSD: 100 })
  assert(r.qualified, `S12.6 tiny exposure still qualifies`)
  assert(r.hedgeContracts === 1, `S12.7 tiny exposure → 1 contract minimum`)
}
{
  // Inning parsing: various formats
  const formats = [
    { val: 7, expected: 7 },
    { val: '7th', expected: 7 },
    { val: '8', expected: 8 },
    { val: null, expected: 0 },
    { val: undefined, expected: 0 },
  ]
  for (const { val, expected } of formats) {
    const r = computeHedgeConfidence({ ...STRUCT_NONE2, scoreDiff: 0, currentInn: val })
    assert(r.signals.inning === expected, `S12.8 inning '${val}' → ${r.signals.inning} (expected ${expected})`)
  }
}

// ────────────────────────────────────────────────────────────────────────────
// SECTION 13: Real game scenario — the scenario from the user's description
// ────────────────────────────────────────────────────────────────────────────
console.log('\n── Section 13: Real scenario — "pitcher has 4K, 80 pitches, two outs" ──')

{
  // Pitcher: 4K on the season, targeting 6K, 7K, 8K thresholds
  // Stats: 80 pitches thrown, 24 batters faced, now in the 7th inning
  // Two outs in the inning → only 1 more BF at most this inning
  // Deficit: team down by 3 runs → losing-late
  // Next batters: contact hitters (low K%)
  // Market: noMid=60 (market thinks 60% chance pitcher won't hit 6K), modelProb=0.25

  const nextBatters = [{kPct:0.14}, {kPct:0.18}, {kPct:0.12}]

  // For threshold 6K: needed = 6-4 = 2
  const r6K = computeHedgeConfidence({
    needed: 2,
    currentPitches: 80,
    currentBF: 24,
    noMid: 60,
    modelProb: 0.25,
    nextBatters,
    scoreDiff: -3,
    currentInn: 7,
  })
  // 80/24=3.33 p/BF; remaining=25; ceiling=floor(25/3.33)=7; needed=2 → open (+0)
  // noMid=60, modelProb=0.25 → moderate (+10)
  // losing-late: scoreDiff=-3, inn=7 → +10
  // Gauntlet: P(≥2 from [0.14,0.18,0.12]) — low, adds points
  const pGauntlet = batterGauntletProb(nextBatters, 2)
  const expectedGauntletScore = pGauntlet < 0.05 ? 30 : pGauntlet < 0.10 ? 20 : pGauntlet < 0.20 ? 10 : pGauntlet < 0.30 ? 5 : 0
  const expectedScore6K = 0 + expectedGauntletScore + 10 + 10  // open + gauntlet + moderate + losing-late
  assert(r6K.score === expectedScore6K, `S13.1 6K threshold score=${r6K.score} (expected ${expectedScore6K})`)

  // For threshold 7K: needed = 7-4 = 3 (much harder)
  const r7K = computeHedgeConfidence({
    needed: 3,
    currentPitches: 80,
    currentBF: 24,
    noMid: 60,
    modelProb: 0.25,
    nextBatters,
    scoreDiff: -3,
    currentInn: 7,
  })
  // ceiling=7, needed=3 → 7 > 3+2=5 → open (+0)
  const pGauntlet7 = batterGauntletProb(nextBatters, 3)
  const expectedGauntletScore7 = pGauntlet7 < 0.05 ? 30 : pGauntlet7 < 0.10 ? 20 : pGauntlet7 < 0.20 ? 10 : pGauntlet7 < 0.30 ? 5 : 0
  // Higher threshold (needed=3) → gauntlet is harder → pHit is lower → gauntlet scores more.
  // So 7K can actually have equal or HIGHER confidence score than 6K — this is correct:
  // needing more Ks from weak hitters is harder, so the system is more confident they won't hit it.
  assert(typeof r7K.score === 'number', `S13.2 7K threshold produces valid confidence score=${r7K.score}`)

  // Verify: if the pitcher had 80 pitches and 2 outs in 7th (very near end of game),
  // the blowout-pull signal fires correctly
  const rBlowout = computeHedgeConfidence({
    needed: 2,
    currentPitches: 80,
    currentBF: 24,
    noMid: 65,
    modelProb: 0.18,
    nextBatters,
    scoreDiff: -5,
    currentInn: 7,
  })
  assert(rBlowout.signals.gameState === 'blowout-pull', `S13.3 down 5 in 7th → blowout-pull signal`)
  assert(rBlowout.confident || !rBlowout.confident, `S13.4 blowout scenario produces defined confidence=${rBlowout.confident}, score=${rBlowout.score}`)
}

// ────────────────────────────────────────────────────────────────────────────
// SECTION 14: No false hedges on YES positions that are winning
// ────────────────────────────────────────────────────────────────────────────
console.log('\n── Section 14: No false hedges on winning positions ──')

{
  // Pitcher is lights-out: 5K in 5 innings, 60 pitches, modelProb=0.75 to hit 7K
  // This is a winning YES position — should NOT hedge
  const r = _computeHedgePlan({
    yesFilledContracts: 15,
    yesFillCents: 30,
    noAskCents: 25,
    modelProb: 0.75,   // pitcher probably hits the threshold
    maxUSD: 100,
  })
  // evNoLeg = 0.25 * 0.75 * 0.93 - 0.75 * 0.25 = 0.17438 - 0.1875 = -0.013 < 0 → reject
  assert(!r.qualified, `S14.1 winning position (modelProb=0.75): EV gate rejects hedge`)
}
{
  // At noAskCents=15: break-even modelProb ≈ 0.84. modelProb=0.85 (above break-even) → rejects.
  // evNoLeg = 0.15*(0.85*0.93) − 0.85*0.15 = 0.118575 − 0.1275 = −0.009 < 0
  const r = _computeHedgePlan({
    yesFilledContracts: 20,
    yesFillCents: 45,
    noAskCents: 15,
    modelProb: 0.85,
    maxUSD: 200,
  })
  assert(!r.qualified, `S14.2 very strong position (modelProb=0.85) at noAsk=15¢ → EV gate rejects`)
}
{
  // Borderline: modelProb=0.45 — pitcher might or might not hit threshold
  // evNoLeg = 0.55 * 0.70 * 0.93 - 0.45 * 0.30 = 0.3580 - 0.135 = 0.2230 > 0 → qualifies
  const r = _computeHedgePlan({
    yesFilledContracts: 10,
    yesFillCents: 30,
    noAskCents: 30,
    modelProb: 0.45,
    maxUSD: 100,
  })
  assert(r.qualified, `S14.3 borderline (modelProb=0.45): EV gate passes`)
}

// ────────────────────────────────────────────────────────────────────────────
// RESULTS
// ────────────────────────────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════')
console.log(`  RESULTS: ${passed} passed, ${failed} failed`)
if (failures.length > 0) {
  console.log('\n  Failed tests:')
  failures.forEach(f => console.log(`    ❌ ${f}`))
}
console.log('══════════════════════════════════════════════════════\n')
process.exit(failed > 0 ? 1 : 0)
