// Test A — Rule K boundary exhaustion + variable scope
// Mirrors ksBets.js predicate exactly:
//   if (e.side === 'YES' && (
//     e.model_prob < yesPregameMinProb ||
//     (e.model_prob < yesPregameMinProbHi && (e.market_mid ?? 50) > yesPregameMaxMid)
//   )) return false  // BLOCK
// Pass means BLOCK behaves as expected; FAIL means a discrepancy.

const yesPregameMinProb   = 0.45
const yesPregameMinProbHi = 0.65
const yesPregameMaxMid    = 35

function isBlocked(side, model_prob, market_mid) {
  if (side !== 'YES') return false  // never blocks NO
  if (model_prob < yesPregameMinProb) return true
  if (model_prob < yesPregameMinProbHi && (market_mid ?? 50) > yesPregameMaxMid) return true
  return false
}

const cases = [
  // [label, side, prob, mid, expectBlock]
  ['prob 0.449 (just below tier1)',           'YES', 0.449, 30, true],
  ['prob 0.450 mid 36 (tier1 just passes, tier2 fires)', 'YES', 0.450, 36, true],
  ['prob 0.450 mid 35 (tier2 mid NOT > 35)',  'YES', 0.450, 35, false],
  ['prob 0.450 mid 30 (tier2 cheap)',         'YES', 0.450, 30, false],
  ['prob 0.649 mid 36 (tier2 fires)',         'YES', 0.649, 36, true],
  ['prob 0.650 mid 36 (tier2 NOT < 0.65)',    'YES', 0.650, 36, false],
  ['prob 0.651 mid 99 (above both)',          'YES', 0.651, 99, false],
  ['prob 0.999 mid 99 (very high)',           'YES', 0.999, 99, false],
  ['mid null prob 0.50 (default 50 > 35, prob<0.65 → tier2 BLOCK)', 'YES', 0.50, null, true],
  ['mid null prob 0.70 (default 50 > 35, prob >=0.65 → ALLOW)',   'YES', 0.70, null, false],
  ['NO side prob 0.10 (never blocks)',        'NO',  0.10, 30, false],
  ['NO side prob 0.99 (never blocks)',        'NO',  0.99, 99, false],
]

let pass = 0, fail = 0
for (const [label, side, prob, mid, expect] of cases) {
  const got = isBlocked(side, prob, mid)
  const ok = got === expect
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} → ${got ? 'BLOCK' : 'ALLOW'}${ok ? '' : ` (expected ${expect ? 'BLOCK' : 'ALLOW'})`}`)
  ok ? pass++ : fail++
}

// Edge: model_prob is null
// `null < 0.45` evaluates to `false` (null coerces to 0... actually null < 0.45 is true!)
// Let's verify what JS actually does:
console.log('\n--- model_prob = null behavior ---')
console.log(`null < 0.45 = ${null < 0.45}`)   // true (null → 0)
console.log(`null < 0.65 = ${null < 0.65}`)   // true
// So if model_prob is null, the YES bet WOULD be blocked (tier1 fires).
const nullProb = isBlocked('YES', null, 30)
console.log(`isBlocked YES null prob mid 30 → ${nullProb ? 'BLOCK' : 'ALLOW'}  (expected BLOCK)`)
if (!nullProb) fail++; else pass++

// Edge: model_prob is undefined
// `undefined < 0.45` is `false` (undefined → NaN)
console.log(`undefined < 0.45 = ${undefined < 0.45}`)   // false
const undefProb = isBlocked('YES', undefined, 30)
console.log(`isBlocked YES undefined prob mid 30 → ${undefProb ? 'BLOCK' : 'ALLOW'}  (Tier1 NaN comparison → false; Tier2 NaN comparison → false; ALLOW)`)
console.log('  ⚠ undefined model_prob bypasses Rule K entirely (NaN comparisons return false)')

console.log(`\nTotal: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
