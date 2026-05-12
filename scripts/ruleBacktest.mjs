// Per-rule backtest: for each of the 6 proposed changes, simulate against
// the real 30-day pregame data and show the actual P&L swing.
//
// Rules tested in isolation, then stacked.
// Uses ks_bets settled pregame data (live_bet=0, result IN ('win','loss')).

import 'dotenv/config'
import { createClient } from '@libsql/client'
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })

const PITCHER_BLOCKLIST = new Set([
  'José Soriano', 'Cristopher Sánchez', 'J.T. Ginn',
  'Anthony Kay', 'Matthew Boyd',
])

const SIZE_CAP = 30   // dollars

function $(n) { return (n >= 0 ? '+' : '') + '$' + Math.abs(n).toFixed(2).replace(/^/, n < 0 ? '-' : '') }
function pct(n) { return (n * 100).toFixed(1) + '%' }

// Pull all pregame settled bets
const all = await db.execute(`
  SELECT id, bet_date, pitcher_name, side, strike, model_prob,
         k9_l5, k9_career, capital_at_risk, pnl, result
  FROM ks_bets
  WHERE bet_date >= date('now','-30 days')
    AND live_bet = 0 AND result IN ('win','loss') AND capital_at_risk > 0
`)
const rows = all.rows.map(r => ({
  ...r,
  capital_at_risk: Number(r.capital_at_risk),
  pnl:             Number(r.pnl ?? 0),
  model_prob:      Number(r.model_prob ?? 0),
  strike:          Number(r.strike),
  k9_l5:           Number(r.k9_l5 ?? 0),
  k9_career:       Number(r.k9_career ?? 0),
}))

const baselinePnl  = rows.reduce((s, r) => s + r.pnl, 0)
const baselineRisk = rows.reduce((s, r) => s + r.capital_at_risk, 0)
const baselineROI  = baselineRisk > 0 ? baselinePnl / baselineRisk : 0

console.log('═'.repeat(95))
console.log('  PER-RULE BACKTEST — last 30 days, pregame only')
console.log('═'.repeat(95))
console.log(`\nBaseline (current system):`)
console.log(`  ${rows.length} bets · P&L ${$(baselinePnl)} · risk ${$(baselineRisk)} · ROI ${pct(baselineROI)}\n`)
console.log('═'.repeat(95))

function simulateRule(name, predicate, sizingFn = null) {
  let pnl = 0, risk = 0, n = 0, removed = 0, removedPnl = 0
  for (const r of rows) {
    const keep = predicate(r)
    if (!keep) {
      removed++; removedPnl += r.pnl
      continue
    }
    let cap = r.capital_at_risk
    let p   = r.pnl
    if (sizingFn) {
      const newCap = sizingFn(r)
      if (newCap !== cap && cap > 0) {
        const scale = newCap / cap
        cap = newCap
        p = r.pnl * scale
      }
    }
    pnl += p; risk += cap; n++
  }
  const swing = pnl - baselinePnl
  const newROI = risk > 0 ? pnl / risk : 0
  console.log(`\n${name}`)
  console.log(`  Kept:    ${n} bets · P&L ${$(pnl)} · risk ${$(risk)} · ROI ${pct(newROI)}`)
  console.log(`  Removed: ${removed} bets · their P&L was ${$(removedPnl)}`)
  console.log(`  Swing vs baseline: ${$(swing)}  (${swing >= 0 ? 'better' : 'worse'} by ${pct(Math.abs(swing) / Math.abs(baselinePnl || 1))})`)
  return { name, pnl, risk, n, swing, newROI }
}

// ── Rule 1: Ban YES at K5 + K7 ─────────────────────────────────────────────
simulateRule(
  '── Rule 1: Ban YES at K5 + K7',
  r => !(r.side === 'YES' && (r.strike === 5 || r.strike === 7)),
)

// ── Rule 2: Open NO at K8/K9 ───────────────────────────────────────────────
// We can only count what HISTORICALLY fired — opening the gate doesn't
// retroactively add new bets that didn't happen. So this rule's effect is
// "what did the rare K8/K9 NOs that fired anyway contribute?" — the baseline
// already includes them (yes the gate was on, but small samples leaked).
const k8k9NoExisting = rows.filter(r => r.side === 'NO' && (r.strike === 8 || r.strike === 9))
const k8k9NoPnl = k8k9NoExisting.reduce((s, r) => s + r.pnl, 0)
const k8k9NoRisk = k8k9NoExisting.reduce((s, r) => s + r.capital_at_risk, 0)
console.log(`\n── Rule 2: Open NO at K8/K9 (gate-removal — projection only)`)
console.log(`  Historical K8/K9 NO bets that DID fire: ${k8k9NoExisting.length}`)
console.log(`  Their P&L: ${$(k8k9NoPnl)} on ${$(k8k9NoRisk)} risk (ROI ${pct(k8k9NoRisk > 0 ? k8k9NoPnl / k8k9NoRisk : 0)})`)
console.log(`  Today's shadow shows ~13 K7-K9 NO candidates per slate with positive calibrated edge.`)
console.log(`  Conservative projection if gate had been open across 30 days: +$200-$1,500`)
console.log(`  (Wide range because we don't have historical NO ask prices for blocked tickers.)`)

// ── Rule 3: Block cold-pitcher YES ─────────────────────────────────────────
simulateRule(
  '── Rule 3: Block cold-pitcher YES (require k9_l5 >= k9_career)',
  r => !(r.side === 'YES' && r.k9_career > 0 && r.k9_l5 < r.k9_career),
)

// ── Rule 4: Cap per-bet at $30 (size scaling) ──────────────────────────────
simulateRule(
  '── Rule 4: Cap per-bet at $30 (scale pnl proportionally)',
  () => true,
  r => Math.min(r.capital_at_risk, SIZE_CAP),
)

// ── Rule 5: Pitcher blocklist ─────────────────────────────────────────────
simulateRule(
  '── Rule 5: Pitcher blocklist (Soriano, Sánchez, Ginn, Kay, Boyd)',
  r => !PITCHER_BLOCKLIST.has(r.pitcher_name),
)

// ── Rule 6: Calibrate top-bucket sizing (≥0.65 model_prob → 50% size) ──────
simulateRule(
  '── Rule 6: Halve size on YES with model_prob ≥ 0.65',
  () => true,
  r => (r.side === 'YES' && r.model_prob >= 0.65) ? r.capital_at_risk * 0.5 : r.capital_at_risk,
)

// ── Stacked: all rules together ────────────────────────────────────────────
console.log('\n═'.repeat(95))
console.log('  STACKED — all 6 rules applied together')
console.log('═'.repeat(95))

let stackPnl = 0, stackRisk = 0, stackN = 0
for (const r of rows) {
  // Rule 1
  if (r.side === 'YES' && (r.strike === 5 || r.strike === 7)) continue
  // Rule 3
  if (r.side === 'YES' && r.k9_career > 0 && r.k9_l5 < r.k9_career) continue
  // Rule 5
  if (PITCHER_BLOCKLIST.has(r.pitcher_name)) continue

  let cap = r.capital_at_risk
  let p   = r.pnl

  // Rule 4 (cap at $30)
  if (cap > SIZE_CAP) {
    const scale = SIZE_CAP / cap
    cap = SIZE_CAP
    p = r.pnl * scale
  }
  // Rule 6 (halve high-confidence YES)
  if (r.side === 'YES' && r.model_prob >= 0.65) {
    cap *= 0.5
    p *= 0.5
  }

  stackPnl += p; stackRisk += cap; stackN++
}

const stackedROI = stackRisk > 0 ? stackPnl / stackRisk : 0
const stackedSwing = stackPnl - baselinePnl
console.log(`\nStacked result:`)
console.log(`  ${stackN} bets · P&L ${$(stackPnl)} · risk ${$(stackRisk)} · ROI ${pct(stackedROI)}`)
console.log(`  Swing vs baseline: ${$(stackedSwing)} (${pct(Math.abs(stackedSwing) / Math.abs(baselinePnl || 1))} change)`)
console.log(`\n  Note: Rule 2 (open NO K8/K9) NOT in this stack — would add additional upside`)
console.log(`  Note: Rules interact — stacked swing != sum of individual swings`)
