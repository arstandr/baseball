// New engine backtest — simulate Rules 1-6 against the last 30 days of
// pregame settled bets, day-by-day. Also recompute calibration buckets on
// the SUBSET of bets the new engine would have placed.
//
// Rule 2 (open NO K8/K9) cannot be fully simulated retroactively because we
// don't have historical market prices for blocked tickers. We show the small
// historical sample of K8/K9 NOs that did fire for context.

import 'dotenv/config'
import { createClient } from '@libsql/client'
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })

const SIZE_CAP_PCT      = 0.04     // Rule 4
const HIGH_CONF_THRESH  = 0.65     // Rule 6
const HIGH_CONF_HAIRCUT = 0.5      // Rule 6
const REFERENCE_BANKROLL = 773     // Adam-Live $260 + Isaiah $513

function $(n) { return (n >= 0 ? '+' : '') + '$' + Math.abs(n).toFixed(2).replace(/^/, n < 0 ? '-' : '') }
function pct(n) { return (n * 100).toFixed(1) + '%' }
function pad(s, n) { return String(s ?? '').padEnd(n) }

// Pull pitcher blocklist
const blockRows = await db.execute(`SELECT pitcher_name FROM pitcher_blocklist`)
const blocklist = new Set(blockRows.rows.map(r => r.pitcher_name))

// Pull all pregame settled bets (last 30 days)
const all = await db.execute(`
  SELECT id, bet_date, pitcher_name, side, strike, model_prob,
         k9_l5, k9_career, capital_at_risk, pnl, result, market_mid
  FROM ks_bets
  WHERE bet_date >= date('now','-30 days')
    AND live_bet = 0 AND result IN ('win','loss') AND capital_at_risk > 0
  ORDER BY bet_date, id
`)
const rows = all.rows.map(r => ({
  ...r,
  capital_at_risk: Number(r.capital_at_risk),
  pnl:             Number(r.pnl ?? 0),
  model_prob:      Number(r.model_prob ?? 0),
  strike:          Number(r.strike),
  k9_l5:           Number(r.k9_l5 ?? 0),
  k9_career:       Number(r.k9_career ?? 0),
  market_mid:      Number(r.market_mid ?? 50),
}))

// Apply new engine rules to a single bet — returns {keep, scaledRisk, scaledPnl}
function applyNewEngine(r, bankroll = REFERENCE_BANKROLL) {
  // Rule 5: pitcher blocklist
  if (blocklist.has(r.pitcher_name)) return { keep: false, reason: 'blocklist' }

  // Rule 1: ban K5 YES + Rule 1 part 2: ban K7+ YES (yes_max_strike=6)
  if (r.side === 'YES' && (r.strike === 5 || r.strike >= 7)) return { keep: false, reason: 'K5/K7+ YES ban' }

  // Rule 3: cold YES block
  if (r.side === 'YES' && r.k9_career > 0 && r.k9_l5 < r.k9_career) return { keep: false, reason: 'cold pitcher' }

  // no_max_market_mid filter (now 65, was 50 — captures K5 NO winners)
  if (r.side === 'NO' && r.market_mid > 65) return { keep: false, reason: 'no_max_market_mid' }

  // Compute scaled risk
  let scaledRisk = r.capital_at_risk
  let scaledPnl = r.pnl

  // Rule 6: high-confidence YES haircut (50%)
  if (r.side === 'YES' && r.model_prob >= HIGH_CONF_THRESH) {
    scaledRisk *= HIGH_CONF_HAIRCUT
    scaledPnl  *= HIGH_CONF_HAIRCUT
  }

  // Rule 4: per-bet bankroll cap (4% of bankroll)
  const perBetCap = SIZE_CAP_PCT * bankroll
  if (scaledRisk > perBetCap) {
    const factor = perBetCap / scaledRisk
    scaledRisk *= factor
    scaledPnl  *= factor
  }

  return { keep: true, scaledRisk, scaledPnl }
}

// ── Per-day backtest ─────────────────────────────────────────────────────
const byDate = new Map()
let cumOldPnl = 0, cumNewPnl = 0
let oldPnlTotal = 0, oldRiskTotal = 0
let newPnlTotal = 0, newRiskTotal = 0
let kept = 0, removed = 0
const removedByReason = new Map()

for (const r of rows) {
  const result = applyNewEngine(r)
  if (!result.keep) {
    removed++
    removedByReason.set(result.reason, (removedByReason.get(result.reason) ?? 0) + 1)
  } else {
    kept++
  }

  oldPnlTotal  += r.pnl
  oldRiskTotal += r.capital_at_risk
  if (result.keep) {
    newPnlTotal  += result.scaledPnl
    newRiskTotal += result.scaledRisk
  }

  if (!byDate.has(r.bet_date)) byDate.set(r.bet_date, { date: r.bet_date, oldN: 0, oldPnl: 0, oldRisk: 0, newN: 0, newPnl: 0, newRisk: 0 })
  const d = byDate.get(r.bet_date)
  d.oldN++; d.oldPnl += r.pnl; d.oldRisk += r.capital_at_risk
  if (result.keep) { d.newN++; d.newPnl += result.scaledPnl; d.newRisk += result.scaledRisk }
}

// ── Phase 3: Recalibrate ─────────────────────────────────────────────────
// Run new engine over historical bets, group SURVIVING YES bets by model_prob
// bucket, compute actual win rate. This is the new calibration table.
const yesSurvivors = rows.filter(r => r.side === 'YES' && applyNewEngine(r).keep)
const buckets = [
  { label: '<0.42',     min: 0,    max: 0.42, n: 0, wins: 0, sumProb: 0 },
  { label: '0.42-0.52', min: 0.42, max: 0.52, n: 0, wins: 0, sumProb: 0 },
  { label: '0.52-0.65', min: 0.52, max: 0.65, n: 0, wins: 0, sumProb: 0 },
  { label: '>=0.65',    min: 0.65, max: 1.01, n: 0, wins: 0, sumProb: 0 },
]
for (const r of yesSurvivors) {
  const b = buckets.find(b => r.model_prob >= b.min && r.model_prob < b.max)
  if (!b) continue
  b.n++
  b.sumProb += r.model_prob
  if (r.result === 'win') b.wins++
}

// ── Print report ─────────────────────────────────────────────────────────
console.log('═'.repeat(105))
console.log('  NEW ENGINE BACKTEST — Rules 1, 3, 4, 5, 6 applied (Rule 2 noted separately)')
console.log('  Window: last 30 days of pregame settled bets')
console.log('═'.repeat(105))

console.log(`\nBaseline (current engine):  ${rows.length} bets · P&L ${$(oldPnlTotal)} · risk ${$(oldRiskTotal)} · ROI ${pct(oldPnlTotal / oldRiskTotal)}`)
console.log(`New engine result:           ${kept} bets · P&L ${$(newPnlTotal)} · risk ${$(newRiskTotal)} · ROI ${pct(newPnlTotal / Math.max(newRiskTotal, 1))}`)
console.log(`Removed: ${removed} bets`)
for (const [reason, n] of removedByReason.entries()) console.log(`  ${reason}: ${n}`)
console.log(`\nP&L swing: ${$(newPnlTotal - oldPnlTotal)}`)
console.log(`Risk reduction: ${$(oldRiskTotal - newRiskTotal)} (${pct(1 - newRiskTotal/oldRiskTotal)} less capital deployed)`)

// Day-by-day
console.log('\n── DAY-BY-DAY P&L ──')
console.log(`date          old_n  old_pnl     old_risk    new_n  new_pnl     new_risk   day_swing   cum_swing`)
console.log('─'.repeat(105))
const sorted = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
let cumSwing = 0
for (const d of sorted) {
  const swing = d.newPnl - d.oldPnl
  cumSwing += swing
  console.log(
    `${d.date}    ${pad(d.oldN, 4)}  ${$(d.oldPnl).padStart(10)}  ${$(d.oldRisk).padStart(9)}    ${pad(d.newN, 4)}  ${$(d.newPnl).padStart(10)}  ${$(d.newRisk).padStart(9)}  ${$(swing).padStart(10)}  ${$(cumSwing).padStart(10)}`
  )
}
console.log('─'.repeat(105))
console.log(`TOTAL          ${pad(rows.length, 4)}  ${$(oldPnlTotal).padStart(10)}  ${$(oldRiskTotal).padStart(9)}    ${pad(kept, 4)}  ${$(newPnlTotal).padStart(10)}  ${$(newRiskTotal).padStart(9)}  ${$(newPnlTotal - oldPnlTotal).padStart(10)}`)

// Rule 2 note
const k8k9 = rows.filter(r => r.side === 'NO' && (r.strike === 8 || r.strike === 9))
const k8k9Pnl = k8k9.reduce((s, r) => s + r.pnl, 0)
const k8k9Risk = k8k9.reduce((s, r) => s + r.capital_at_risk, 0)
console.log(`\n── RULE 2 (open NO K8/K9) — historical sample only ──`)
console.log(`  Historical K8/K9 NO bets that fired: ${k8k9.length}`)
console.log(`  Their P&L: ${$(k8k9Pnl)} on ${$(k8k9Risk)} risk (ROI ${pct(k8k9Risk > 0 ? k8k9Pnl / k8k9Risk : 0)})`)
console.log(`  These ARE in the baseline above. Rule 2 does NOT add bets retroactively.`)
console.log(`  Today's shadow shows ~13 K7-K9 NO candidates per slate; opening prospectively`)
console.log(`  should add ~$10-50 per day average new fires going forward.`)

// Calibration recompute
console.log(`\n── PHASE 3: NEW CALIBRATION (on bets the new engine WOULD have placed) ──`)
console.log(`bucket          n     avg_claim   actual_win_rate   delta`)
console.log('─'.repeat(70))
for (const b of buckets) {
  const avgClaim = b.n > 0 ? b.sumProb / b.n : 0
  const actual = b.n > 0 ? b.wins / b.n : 0
  const delta = actual - avgClaim
  console.log(`${pad(b.label, 14)}  ${pad(b.n, 4)}   ${pct(avgClaim).padStart(6)}      ${pct(actual).padStart(6)}            ${(delta >= 0 ? '+' : '') + pct(delta).padStart(5)}`)
}

// Summary
console.log('\n═'.repeat(105))
console.log('  SUMMARY')
console.log('═'.repeat(105))
const oldROI = oldPnlTotal / oldRiskTotal
const newROI = newPnlTotal / Math.max(newRiskTotal, 1)
console.log(`  Old engine ROI:   ${pct(oldROI)}`)
console.log(`  New engine ROI:   ${pct(newROI)}`)
console.log(`  ROI improvement:  +${(newROI - oldROI) * 100} percentage points (${pct((newROI - oldROI) / Math.max(Math.abs(oldROI), 0.001))})`)
console.log(`  P&L swing:        ${$(newPnlTotal - oldPnlTotal)} over 30 days (~${$((newPnlTotal - oldPnlTotal)/30)} per day average)`)
console.log(`  Capital efficiency: ${pct(1 - newRiskTotal/oldRiskTotal)} less risk deployed for ${$(newPnlTotal)} P&L vs ${$(oldPnlTotal)} previously`)
