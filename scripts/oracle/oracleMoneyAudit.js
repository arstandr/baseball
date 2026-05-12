// scripts/oracle/oracleMoneyAudit.js
//
// "Where are we leaving money on the table" deep-dive.
//
// Joins:
//   - oracle full-pipeline backtest CSV (with Critic)
//   - original ks_bets (for kelly_fraction, edge, model_prob, market_mid, etc.)
//   - decision_pipeline.lambda_calc_json + model_input_json
//
// Produces a structured findings report identifying specific dollar
// values left on the table by:
//   1. Calibration drift (predicted vs actual)
//   2. Per-pitcher / per-archetype patterns
//   3. Per-strike-bucket / per-side patterns
//   4. Critic flags that were correctly cautious vs over-cautious
//   5. Sizing inefficiency (production size vs Kelly target)
//   6. The 308 unreplayable bets (what they represent)
//   7. Threshold tuning opportunities
//   8. "Perfect Oracle" upper bound

import 'dotenv/config'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import * as db from '../../lib/db.js'

const today = new Date().toISOString().slice(0, 10)
const CSV_PATH = path.resolve(`oracle/oracle-full-backtest-with-critic-${today}.csv`)
const OUTBASE  = `oracle/oracle-money-audit-${today}`

console.log(`[moneyAudit] reading ${CSV_PATH}`)
const csv = readFileSync(CSV_PATH, 'utf-8').split('\n').filter(Boolean)
const header = csv[0].split(',')
const rows = csv.slice(1).map(line => {
  const f = line.split(',')
  const obj = {}
  for (let i = 0; i < header.length; i++) obj[header[i]] = f[i]
  obj.production_pnl  = parseFloat(obj.production_pnl)
  obj.production_size = parseFloat(obj.production_size)
  obj.strike = parseInt(obj.strike, 10)
  obj.bet_id = parseInt(obj.bet_id, 10)
  obj.actual_ks = obj.actual_ks != null ? parseInt(obj.actual_ks, 10) : null
  obj.critic_concerns = obj.critic_concerns ? obj.critic_concerns.replace(/;/g, ',').split('|').filter(Boolean) : []
  return obj
})
console.log(`[moneyAudit] ${rows.length} bets in backtest CSV`)

// Pull richer fields from ks_bets + decision_pipeline
const betIds = rows.map(r => r.bet_id)
const ksRowsBatch = await db.all(`
  SELECT id, model_prob, market_mid, lambda, edge, kelly_fraction, actual_ks,
         spread, fill_price, savant_k_pct, n_starts
  FROM ks_bets WHERE id IN (${betIds.map(()=>'?').join(',')})
`, betIds)
const ksMap = new Map(ksRowsBatch.map(r => [r.id, r]))
for (const r of rows) {
  const k = ksMap.get(r.bet_id)
  if (k) {
    r.model_prob = k.model_prob
    r.market_mid = k.market_mid / 100
    r.lambda = k.lambda
    r.edge = k.edge / 100   // edge stored as cents in ks_bets? check
    r.kelly_fraction = k.kelly_fraction
    r.actual_ks = k.actual_ks
    r.spread = k.spread
    r.fill_price = k.fill_price
    r.savant_k_pct = k.savant_k_pct
    r.n_starts = k.n_starts
  }
  // YES outcome
  r.yes_hit = r.actual_ks != null && r.actual_ks >= r.strike ? 1 : 0
  r.actual_outcome = r.side === 'YES' ? r.yes_hit : 1 - r.yes_hit
  // Used by audit
  r.is_win  = r.result === 'win'
  r.is_loss = r.result === 'loss'
}

// ─── Helpers ─────────────────────────────────────────────────────
const fmt = (n, d=2) => Number.isFinite(n) ? n.toFixed(d) : '—'
const pct = (n, d) => d > 0 ? ((n/d)*100).toFixed(1)+'%' : '—'
function aggregate(arr, keyFn) {
  const m = new Map()
  for (const r of arr) {
    const k = keyFn(r)
    if (!m.has(k)) m.set(k, { n:0, wins:0, losses:0, voids:0, sum_pnl:0, sum_size:0, rows:[] })
    const b = m.get(k)
    b.n++
    if (r.is_win) b.wins++
    if (r.is_loss) b.losses++
    if (r.result === 'void') b.voids++
    b.sum_pnl += r.production_pnl
    b.sum_size += r.production_size
    b.rows.push(r)
  }
  return m
}

const lines = []
lines.push(`# Oracle Money-on-the-Table Audit — ${today}`)
lines.push(``)
lines.push(`Sample: ${rows.length} settled placed pre-game bets (the replayable subset).`)
lines.push(``)

// ════════════════════════════════════════════════════════════════════
// 1. Headline P&L scoreboard
// ════════════════════════════════════════════════════════════════════
const totalProdPnl = rows.reduce((s, r) => s + r.production_pnl, 0)
const totalProdSize = rows.reduce((s, r) => s + r.production_size, 0)
let oraclePnlNoCritic = 0
let oraclePnlFull = 0
for (const r of rows) {
  if (r.decision_off === 'skip')      { /* +0 */ }
  else if (r.decision_off === 'size_down') oraclePnlNoCritic += r.production_pnl * 0.5
  else                                  oraclePnlNoCritic += r.production_pnl
  if (r.decision_full === 'skip')      { /* +0 */ }
  else if (r.decision_full === 'size_down') oraclePnlFull += r.production_pnl * 0.5
  else                                       oraclePnlFull += r.production_pnl
}
lines.push(`## 1. Headline scoreboard`)
lines.push(``)
lines.push(`| Strategy | P&L | ROI on production size |`)
lines.push(`|---|---:|---:|`)
lines.push(`| Production | $${fmt(totalProdPnl)} | ${pct(totalProdPnl, totalProdSize)} |`)
lines.push(`| Oracle (no Critic) | $${fmt(oraclePnlNoCritic)} | ${pct(oraclePnlNoCritic, totalProdSize)} |`)
lines.push(`| Oracle (with Critic) | $${fmt(oraclePnlFull)} | ${pct(oraclePnlFull, totalProdSize)} |`)
lines.push(``)
lines.push(`Total production size deployed: $${fmt(totalProdSize)}`)
lines.push(``)

// ════════════════════════════════════════════════════════════════════
// 2. Calibration analysis — predicted vs actual
// ════════════════════════════════════════════════════════════════════
lines.push(`## 2. Probability calibration (production model)`)
lines.push(``)
lines.push(`If Layer 1 said 70% but actual win rate at that bucket is 50%, the model is overconfident in that range. Bias = predicted − actual.`)
lines.push(``)
const calBuckets = []
for (let i = 0; i < 10; i++) {
  calBuckets.push({ lo: i/10, hi: (i+1)/10, n:0, wins:0, sum_pred:0, sum_pnl:0, sum_size:0 })
}
for (const r of rows) {
  if (!Number.isFinite(r.model_prob)) continue
  const idx = Math.min(9, Math.floor(r.model_prob * 10))
  calBuckets[idx].n++
  calBuckets[idx].sum_pred += r.model_prob
  calBuckets[idx].sum_pnl  += r.production_pnl
  calBuckets[idx].sum_size += r.production_size
  if (r.is_win) calBuckets[idx].wins++
}
lines.push(`| bucket | n | avg predicted | actual win rate | bias | total pnl |`)
lines.push(`|---|---:|---:|---:|---:|---:|`)
let calBiasMoney = 0
for (const b of calBuckets) {
  if (!b.n) continue
  const avgPred = b.sum_pred / b.n
  const actual = b.wins / b.n
  const bias = avgPred - actual
  // Rough money "wasted" by bias: bets in this bucket where bias > 5pp
  if (bias > 0.05 && b.sum_pnl < 0) calBiasMoney += b.sum_pnl
  lines.push(`| [${b.lo.toFixed(1)},${b.hi.toFixed(1)}) | ${b.n} | ${pct(b.sum_pred, b.n)} | ${pct(b.wins, b.n)} | ${bias >= 0 ? '+' : ''}${(bias*100).toFixed(1)}pp | $${fmt(b.sum_pnl)} |`)
}
lines.push(``)
if (calBiasMoney < 0) {
  lines.push(`**Calibration insight:** buckets where the model is overconfident by ≥5pp lost a net $${fmt(Math.abs(calBiasMoney))}. If we could correct that bias, we'd recover roughly that amount over time.`)
} else {
  lines.push(`Model calibration looks reasonable in the high-bias buckets (no clear money saved by recalibration on this sample).`)
}
lines.push(``)

// ════════════════════════════════════════════════════════════════════
// 3. Per-pitcher patterns
// ════════════════════════════════════════════════════════════════════
const byPitcher = aggregate(rows, r => r.pitcher.replace(/;/g, ','))
const pitcherList = [...byPitcher.entries()].sort((a,b) => a[1].sum_pnl - b[1].sum_pnl)
lines.push(`## 3. Per-pitcher P&L (worst 10)`)
lines.push(``)
lines.push(`Pitchers who systematically lost. Production may be over-betting these, or the model has a per-pitcher blind spot.`)
lines.push(``)
lines.push(`| pitcher | n | wins | losses | production pnl | oracle pnl (full) |`)
lines.push(`|---|---:|---:|---:|---:|---:|`)
for (const [name, b] of pitcherList.slice(0, 10)) {
  let oraclePnl = 0
  for (const r of b.rows) {
    if (r.decision_full === 'skip')      continue
    else if (r.decision_full === 'size_down') oraclePnl += r.production_pnl * 0.5
    else                                       oraclePnl += r.production_pnl
  }
  lines.push(`| ${name} | ${b.n} | ${b.wins} | ${b.losses} | $${fmt(b.sum_pnl)} | $${fmt(oraclePnl)} |`)
}
lines.push(``)
lines.push(`## 3b. Per-pitcher P&L (best 10)`)
lines.push(``)
lines.push(`| pitcher | n | wins | losses | production pnl |`)
lines.push(`|---|---:|---:|---:|---:|`)
for (const [name, b] of pitcherList.slice(-10).reverse()) {
  lines.push(`| ${name} | ${b.n} | ${b.wins} | ${b.losses} | $${fmt(b.sum_pnl)} |`)
}
lines.push(``)
const top3WorstPnl = pitcherList.slice(0, 3).reduce((s, [_, b]) => s + b.sum_pnl, 0)
lines.push(`**Concentration:** the worst 3 pitchers account for $${fmt(top3WorstPnl)} of the production loss. If Oracle could have flagged these structurally, that's the largest single recovery opportunity.`)
lines.push(``)

// ════════════════════════════════════════════════════════════════════
// 4. Per-strike-bucket × per-side
// ════════════════════════════════════════════════════════════════════
function strikeBucket(s) {
  if (s <= 4) return '3-4'
  if (s <= 6) return '5-6'
  if (s <= 8) return '7-8'
  return '9+'
}
const bySideStrike = aggregate(rows, r => `${r.side}_${strikeBucket(r.strike)}`)
lines.push(`## 4. Per-side × strike bucket`)
lines.push(``)
lines.push(`| key | n | wins | losses | win_rate | production pnl |`)
lines.push(`|---|---:|---:|---:|---:|---:|`)
const sideStrikeKeys = ['YES_3-4','YES_5-6','YES_7-8','YES_9+','NO_3-4','NO_5-6','NO_7-8','NO_9+']
for (const k of sideStrikeKeys) {
  const b = bySideStrike.get(k)
  if (!b) continue
  lines.push(`| ${k} | ${b.n} | ${b.wins} | ${b.losses} | ${pct(b.wins, b.wins + b.losses)} | $${fmt(b.sum_pnl)} |`)
}
lines.push(``)
const losingSideStrikes = sideStrikeKeys.filter(k => bySideStrike.get(k) && bySideStrike.get(k).sum_pnl < -50)
if (losingSideStrikes.length) {
  lines.push(`**Pattern flagged:** these (side, strike-bucket) combinations lost > $50 in this window:`)
  for (const k of losingSideStrikes) {
    const b = bySideStrike.get(k)
    lines.push(`  - ${k}: $${fmt(b.sum_pnl)} on ${b.n} bets (win rate ${pct(b.wins, b.wins + b.losses)})`)
  }
  lines.push(`Worth a per-bucket rule audit. Could be that high-strike YES is the wrong play for some pitchers.`)
} else {
  lines.push(`No (side, strike-bucket) lost more than $50 in this window — no obvious bucket to ban.`)
}
lines.push(``)

// ════════════════════════════════════════════════════════════════════
// 5. Critic effectiveness — flagged + not flagged
// ════════════════════════════════════════════════════════════════════
const criticActed = rows.filter(r => r.decision_off !== r.decision_full)
const criticNoOp  = rows.filter(r => r.decision_off === r.decision_full)
const criticForcedSkip = rows.filter(r => r.decision_off !== 'skip' && r.decision_full === 'skip')
const criticDowngrade  = rows.filter(r => r.decision_off === 'fire' && r.decision_full === 'size_down')
const criticForcedSkipPnl = criticForcedSkip.reduce((s, r) => s + r.production_pnl, 0)
const criticDowngradePnl  = criticDowngrade.reduce((s, r) => s + r.production_pnl, 0)
const criticForcedSkipWins = criticForcedSkip.filter(r => r.is_win).length
const criticForcedSkipLosses = criticForcedSkip.filter(r => r.is_loss).length
const criticDowngradeWins = criticDowngrade.filter(r => r.is_win).length
const criticDowngradeLosses = criticDowngrade.filter(r => r.is_loss).length

lines.push(`## 5. Critic effectiveness audit`)
lines.push(``)
lines.push(`Critic changed Oracle's decision on **${criticActed.length}** of ${rows.length} bets.`)
lines.push(``)
lines.push(`### 5a. Critic forced skip (n=${criticForcedSkip.length})`)
lines.push(`Production placed these. Oracle (no-Critic) would have placed at full or half size. Critic said no.`)
lines.push(``)
lines.push(`- wins (Critic forgone wins, BAD for Critic): ${criticForcedSkipWins}`)
lines.push(`- losses (Critic correctly skipped losers): ${criticForcedSkipLosses}`)
lines.push(`- Production P&L on these bets: $${fmt(criticForcedSkipPnl)}  ${criticForcedSkipPnl < 0 ? '← Critic SAVED this loss' : '← Critic FORWENT this win'}`)
lines.push(``)
if (criticForcedSkip.length) {
  lines.push(`Top concerns Critic cited:`)
  const concernCount = {}
  for (const r of criticForcedSkip) for (const c of (r.critic_concerns ?? [])) concernCount[c] = (concernCount[c] ?? 0) + 1
  for (const [c, n] of Object.entries(concernCount).sort((a,b) => b[1] - a[1])) {
    lines.push(`  - ${c}: ${n}`)
  }
}
lines.push(``)
lines.push(`### 5b. Critic downgraded fire → size_down (n=${criticDowngrade.length})`)
lines.push(`Production placed at full size. Oracle (no-Critic) would have fired full. Critic said size_down.`)
lines.push(``)
lines.push(`- wins (half loss vs full win — small marginal cost): ${criticDowngradeWins}`)
lines.push(`- losses (half loss vs full loss — half saved): ${criticDowngradeLosses}`)
lines.push(`- Production P&L on these bets: $${fmt(criticDowngradePnl)}`)
const downSavings = criticDowngrade.reduce((s, r) => s + (r.is_loss ? -r.production_pnl * 0.5 : -r.production_pnl * 0.5), 0)
lines.push(`- Marginal savings vs full-size: $${fmt(downSavings)}  (negative = Critic gave up wins)`)
lines.push(``)

// Critic was wrong (proceed but lost)
const criticProceedLosses = rows.filter(r => r.critic_verdict === 'proceed' && r.is_loss && r.decision_full !== 'skip')
const criticProceedLossSum = criticProceedLosses.reduce((s, r) => s + r.production_pnl, 0)
lines.push(`### 5c. Critic 'proceed' bets that lost (n=${criticProceedLosses.length})`)
lines.push(``)
lines.push(`These are bets where Critic gave a clean signal AND Oracle fired or sized_down AND production lost.`)
lines.push(`Total production loss on Critic-cleared bets: $${fmt(criticProceedLossSum)}.`)
lines.push(`If we could improve Critic to catch even 20% of these, that's ~$${fmt(criticProceedLossSum * 0.2)} additional savings.`)
lines.push(``)

// ════════════════════════════════════════════════════════════════════
// 6. Sizing inefficiency
// ════════════════════════════════════════════════════════════════════
const fireBets = rows.filter(r => r.decision_full === 'fire' && Number.isFinite(r.kelly_fraction))
const sizeDownBets = rows.filter(r => r.decision_full === 'size_down')
lines.push(`## 6. Sizing inefficiency`)
lines.push(``)
lines.push(`Production sizes are determined by ks_bets.kelly_fraction × actual_bankroll. Oracle sizing is independent of production sizing — but there's signal in the production sizes.`)
lines.push(``)
const avgFireSize = fireBets.reduce((s, r) => s + r.production_size, 0) / Math.max(1, fireBets.length)
const avgSizeDownSize = sizeDownBets.reduce((s, r) => s + r.production_size, 0) / Math.max(1, sizeDownBets.length)
lines.push(`- Avg production size on Oracle-fire bets:      $${fmt(avgFireSize)}`)
lines.push(`- Avg production size on Oracle-size_down bets: $${fmt(avgSizeDownSize)}`)
lines.push(``)
const fireWins = fireBets.filter(r => r.is_win)
const fireLosses = fireBets.filter(r => r.is_loss)
const fireWinSize = fireWins.reduce((s, r) => s + r.production_size, 0)
const fireLossSize = fireLosses.reduce((s, r) => s + r.production_size, 0)
lines.push(`On Oracle-fire bets:`)
lines.push(`  - winning bets: ${fireWins.length}, total production size $${fmt(fireWinSize)}`)
lines.push(`  - losing bets:  ${fireLosses.length}, total production size $${fmt(fireLossSize)}`)
if (fireWinSize > fireLossSize) {
  lines.push(`  ✓ Production sized winners larger than losers — sizing was directionally correct`)
} else {
  lines.push(`  ✗ Production sized LOSERS larger than winners — sizing was anti-correlated with outcome (random luck or bad sizing signal)`)
}
lines.push(``)

// ════════════════════════════════════════════════════════════════════
// 7. The 308 unreplayable bets
// ════════════════════════════════════════════════════════════════════
const unreplayable = await db.all(`
  SELECT bet_date, COUNT(*) AS n,
    SUM(CASE WHEN result='win' THEN 1 ELSE 0 END) AS wins,
    SUM(pnl) AS pnl
  FROM ks_bets
  WHERE result IN ('win','loss','void') AND actual_ks IS NOT NULL AND live_bet=0
    AND id NOT IN (SELECT b.id FROM ks_bets b
                    LEFT JOIN decision_pipeline dp ON dp.bet_date=b.bet_date AND dp.pitcher_id=b.pitcher_id
                    WHERE dp.lambda_calc_json IS NOT NULL AND dp.model_input_json IS NOT NULL)
  GROUP BY bet_date ORDER BY bet_date
`)
lines.push(`## 7. The 308 unreplayable bets`)
lines.push(``)
lines.push(`These bets predate decision_pipeline JSON capture, so Layer 1 envelope cannot be reconstructed and Oracle cannot replay them.`)
lines.push(``)
lines.push(`| date | n | wins | pnl |`)
lines.push(`|---|---:|---:|---:|`)
let totalUnreplayablePnl = 0
for (const u of unreplayable) {
  totalUnreplayablePnl += u.pnl
  lines.push(`| ${u.bet_date} | ${u.n} | ${u.wins} | $${fmt(u.pnl)} |`)
}
lines.push(``)
lines.push(`Total unreplayable bet count: ${unreplayable.reduce((s, u) => s + u.n, 0)}`)
lines.push(`Total production P&L on unreplayable bets: $${fmt(totalUnreplayablePnl)}`)
lines.push(``)
lines.push(`**Money implication:** if Oracle had been running on these 308 bets too with similar +5pp ROI improvement, that would have been roughly $${fmt(totalUnreplayablePnl + Math.abs(totalUnreplayablePnl) * 0.05)} in additional value (rough estimate). The fix is to make sure decision_pipeline JSON gets captured going forward.`)
lines.push(``)

// ════════════════════════════════════════════════════════════════════
// 8. "Perfect Oracle" upper bound — best possible filter
// ════════════════════════════════════════════════════════════════════
let perfectOraclePnl = 0
let perfectOracleSize = 0
for (const r of rows) {
  if (r.is_win) {
    perfectOraclePnl += r.production_pnl
    perfectOracleSize += r.production_size
  }
}
lines.push(`## 8. Perfect Oracle upper bound`)
lines.push(``)
lines.push(`If we had perfect foresight (skip every loser, fire every winner at production size), what's the cap?`)
lines.push(``)
lines.push(`- Bets we'd fire (winners): $${fmt(rows.filter(r => r.is_win).reduce((s, r) => s + r.production_pnl, 0))} ROI`)
lines.push(`- Bets we'd skip (losers): saved ${fmt(Math.abs(rows.filter(r => r.is_loss).reduce((s, r) => s + r.production_pnl, 0)))}`)
lines.push(`- Perfect-Oracle P&L: $${fmt(perfectOraclePnl)}`)
lines.push(`- Production P&L:    $${fmt(totalProdPnl)}`)
lines.push(`- Maximum possible Δ: **$${fmt(perfectOraclePnl - totalProdPnl)}**`)
lines.push(``)
lines.push(`Current Oracle (with Critic) captures **$${fmt(oraclePnlFull - totalProdPnl)}** of the $${fmt(perfectOraclePnl - totalProdPnl)} possible.`)
const captureRate = ((oraclePnlFull - totalProdPnl) / (perfectOraclePnl - totalProdPnl)) * 100
lines.push(`Capture rate: ${captureRate.toFixed(1)}%`)
lines.push(``)
lines.push(`**Money still on the table: $${fmt((perfectOraclePnl - totalProdPnl) - (oraclePnlFull - totalProdPnl))}** (the gap between current Oracle and perfect Oracle)`)
lines.push(``)

// ════════════════════════════════════════════════════════════════════
// 9. Specific actionable recommendations
// ════════════════════════════════════════════════════════════════════
lines.push(`## 9. Top recommendations (ranked by dollar impact)`)
lines.push(``)
const recommendations = []

// R1: Worst pitchers
if (top3WorstPnl < -100) {
  const names = pitcherList.slice(0, 3).map(([n]) => n).join(', ')
  recommendations.push({
    rank: 1,
    title: `Add pitcher-specific blacklist or per-pitcher prior for: ${names}`,
    impact: -top3WorstPnl,
    action: 'These 3 pitchers account for $' + fmt(-top3WorstPnl) + ' of losses. Oracle is firing on them at full or partial size. Investigate why model is over-predicting K rate; consider per-pitcher manual override.',
  })
}

// R2: Losing strike buckets
for (const k of losingSideStrikes) {
  const b = bySideStrike.get(k)
  recommendations.push({
    rank: recommendations.length + 1,
    title: `Investigate ${k} bucket: $${fmt(b.sum_pnl)} loss on ${b.n} bets`,
    impact: -b.sum_pnl,
    action: 'Win rate ' + pct(b.wins, b.wins + b.losses) + '. Consider banning this bucket entirely or raising min_edge for it.',
  })
}

// R3: Critic improvements (proceed losses)
if (Math.abs(criticProceedLossSum) > 100) {
  recommendations.push({
    rank: recommendations.length + 1,
    title: `Improve Critic prompt to catch ~20% of "proceed-and-lose" cases`,
    impact: Math.abs(criticProceedLossSum) * 0.2,
    action: 'Current Critic is conservative; lots of clean-proceed-then-loss happen. Audit prompt; add more concern triggers.',
  })
}

// R4: Bring decision_pipeline JSON to all bets
recommendations.push({
  rank: recommendations.length + 1,
  title: 'Ensure decision_pipeline JSON is captured for every bet going forward',
  impact: Math.abs(totalUnreplayablePnl) * 0.05,
  action: '308 bets had no JSON snapshot. Future Oracle can\'t learn from them. Verify the production logging path always writes to decision_pipeline.',
})

// R5: Calibration tuning
if (calBiasMoney < -50) {
  recommendations.push({
    rank: recommendations.length + 1,
    title: 'Recalibrate model probability buckets where bias > 5pp',
    impact: Math.abs(calBiasMoney),
    action: 'Bias-corrected predictions would save approximately $' + fmt(Math.abs(calBiasMoney)) + ' on this sample.',
  })
}

recommendations.sort((a, b) => b.impact - a.impact)

lines.push(`| # | recommendation | est. dollar impact | action |`)
lines.push(`|---|---|---:|---|`)
for (let i = 0; i < recommendations.length; i++) {
  const r = recommendations[i]
  lines.push(`| ${i+1} | ${r.title} | $${fmt(r.impact)} | ${r.action} |`)
}
lines.push(``)
const totalRecImpact = recommendations.reduce((s, r) => s + r.impact, 0)
lines.push(`**Total estimated upside if all recommendations executed:** $${fmt(totalRecImpact)}`)
lines.push(``)

// ════════════════════════════════════════════════════════════════════
// 10. Bottom line
// ════════════════════════════════════════════════════════════════════
lines.push(`## 10. Bottom line — money on the table`)
lines.push(``)
lines.push(`In this 312-bet sample window:`)
lines.push(``)
lines.push(`| Layer | P&L delta from production |`)
lines.push(`|---|---:|`)
lines.push(`| Already capturing (Oracle deterministic) | +$${fmt(oraclePnlNoCritic - totalProdPnl)} |`)
lines.push(`| Critic adds | +$${fmt(oraclePnlFull - oraclePnlNoCritic)} |`)
lines.push(`| Captured by current Oracle | +$${fmt(oraclePnlFull - totalProdPnl)} |`)
lines.push(`| Gap to perfect Oracle | +$${fmt((perfectOraclePnl - totalProdPnl) - (oraclePnlFull - totalProdPnl))} |`)
lines.push(`| Estimated recoverable from recommendations | +$${fmt(totalRecImpact)} |`)
lines.push(``)
lines.push(`**Honest take:** the deterministic chain + Critic captured ${captureRate.toFixed(0)}% of the available improvement. The remaining ${(100 - captureRate).toFixed(0)}% is structurally unreachable without:`)
lines.push(`1. Better per-pitcher modeling (the worst-pitcher concentration)`)
lines.push(`2. More AI signal (Critic v1.1: catch clean-then-lose patterns)`)
lines.push(`3. Better data capture (the 308 unreplayable bets)`)
lines.push(`4. Calibration corrections (bias buckets)`)
lines.push(``)
lines.push(`On a 7-10 day sample, $${fmt(totalRecImpact)} of additional upside is the conservative ceiling. Annualized at the same rate that's roughly $${fmt(totalRecImpact * 36)} per year (rough — sample is small).`)
lines.push(``)

// Write
const mdPath = path.resolve(`${OUTBASE}.md`)
writeFileSync(mdPath, lines.join('\n'), 'utf-8')

console.log('\n═══ MONEY ON THE TABLE — STDOUT SUMMARY ═══')
console.log(`\nReport: ${mdPath}\n`)
console.log(`Production:                  $${fmt(totalProdPnl)} (ROI ${pct(totalProdPnl, totalProdSize)})`)
console.log(`Oracle deterministic:        $${fmt(oraclePnlNoCritic)}  (Δ +$${fmt(oraclePnlNoCritic - totalProdPnl)})`)
console.log(`Oracle full (with Critic):   $${fmt(oraclePnlFull)}  (Δ +$${fmt(oraclePnlFull - totalProdPnl)})`)
console.log(`Perfect Oracle (upper bound):$${fmt(perfectOraclePnl)}  (Δ +$${fmt(perfectOraclePnl - totalProdPnl)})`)
console.log(`Capture rate:                ${captureRate.toFixed(1)}% of perfect-Oracle ceiling`)
console.log(`Money still on table:        $${fmt((perfectOraclePnl - totalProdPnl) - (oraclePnlFull - totalProdPnl))}`)
console.log(`Recommendations sum:         $${fmt(totalRecImpact)} (rough, conservative)`)
console.log(`\nTop recommendations:`)
for (let i = 0; i < Math.min(5, recommendations.length); i++) {
  const r = recommendations[i]
  console.log(`  ${i+1}. ${r.title}`)
  console.log(`     est: $${fmt(r.impact)}`)
}

await db.close()
