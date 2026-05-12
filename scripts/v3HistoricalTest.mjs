// True out-of-sample test of v3.
// v3's filters (H-H + H-I + skip K=7-9) were designed using May 7-10 paper-test data.
// The historical 37-day backtest (Mar 31 → May 6, 1,056 pitcher-games) was NOT seen
// when designing these filters. Applying v3 to that period = clean out-of-sample test.
//
// Compares:
//   - Unfiltered ideal (the original v1: edge ≥5c, ask ≤50c, strike ≥6, no v3 filters)
//   - v3 (= unfiltered ideal + H-H + H-I + strike = 6 OR ≥10)
//
// If v3 outperforms unfiltered on data v3 never saw, the filter has real signal.
// If v3 underperforms, the +59% on May 7-10 was overfitting.

import 'dotenv/config'
import fs from 'fs'
import { createClient } from '@libsql/client'

const RAW = '/Users/adamstandridge/Documents/projects/baseball/.rawBacktestData.json'
const FEE = 0.07
const STARTING = 5000

const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })

function nbGEqN(lambda, r, n) {
  if (n <= 0) return 1
  const p = r / (r + lambda)
  let cum = Math.pow(p, r), term = cum
  for (let k = 1; k < n; k++) { term = term * (k + r - 1) / k * (1 - p); cum += term }
  return Math.max(0, Math.min(1, 1 - cum))
}
function poissonGEqN(lambda, n) {
  if (n <= 0) return 1
  let cum = Math.exp(-lambda), term = cum
  for (let k = 1; k < n; k++) { term = term * lambda / k; cum += term }
  return Math.max(0, Math.min(1, 1 - cum))
}

const records = JSON.parse(fs.readFileSync(RAW, 'utf8'))
console.log(`Historical records: ${records.length}`)

// Pull pitcher_signals for confidence lookup (out-of-sample for the May 7+ window;
// in-sample for everything else, but H-I was designed from May 7-9 only).
const sigRows = await db.execute(`
  SELECT pitcher_id, signal_date, confidence, avg_innings_l5
  FROM pitcher_signals
  WHERE signal_date <= '2026-05-06'
`)
const sigMap = new Map()
for (const r of sigRows.rows) {
  sigMap.set(`${r.pitcher_id}|${r.signal_date}`, {
    confidence: r.confidence,
    avg_innings_l5: r.avg_innings_l5,
  })
}
console.log(`Pitcher_signals rows for backtest window: ${sigRows.rows.length}`)

// Apply IDEAL config + variants
function evaluate(records, label, opts) {
  const {
    minEdge = 0.05, maxAsk = 50, minStrike = 6,
    skipMiddle = false,           // skip K=7,8,9 (v3 strike filter)
    requireH_H = false,            // ipL5 ≥ 5
    requireH_I = false,            // confidence > 0.3
    sizeBase = 0.01, sizeEdgeMax = 5, capPerBet = 200,
  } = opts

  let bankroll = STARTING
  let pnl = 0, fires = 0, wins = 0, losses = 0
  const dailyFires = new Map()

  for (const rec of records) {
    if (!rec.prior_starts || rec.prior_starts.length === 0) continue
    const recent = rec.prior_starts.slice(-5)
    const totalK = recent.reduce((s, g) => s + g.ks, 0)
    const totalIp = recent.reduce((s, g) => s + g.ip, 0)
    if (totalIp <= 0) continue
    const k9 = totalK / totalIp * 9
    const avgIp = totalIp / recent.length
    if (k9 < 4 || k9 > 18) continue
    const lambda = k9 * avgIp / 9

    // H-H check (from rec data — avg_innings_l5 = avgIp from last 5)
    if (requireH_H && avgIp < 5) continue

    // H-I check (from pitcher_signals)
    if (requireH_I) {
      const sig = sigMap.get(`${rec.pitcher_id}|${rec.target_date}`)
      if (sig?.confidence != null && Number(sig.confidence) <= 0.3) continue
    }

    // Find best YES candidate (strike + edge filters)
    let best = null
    for (const lad of rec.ladder) {
      const strike = Number(lad.strike)
      if (strike < minStrike) continue
      if (skipMiddle && strike >= 7 && strike <= 9) continue
      const yesAsk = Number(lad.yes_ask)
      if (yesAsk < 3 || yesAsk > maxAsk) continue
      const modelProb = nbGEqN(lambda, 8, strike)
      const edge = modelProb - yesAsk / 100
      if (edge < minEdge) continue
      if (!best || edge > best.edge) best = { ...lad, edge, modelProb }
    }
    if (!best) continue

    // Sizing
    const edgeMult = Math.min(sizeEdgeMax, 1 + (best.edge - minEdge) / minEdge)
    const wantUsd = Math.min(capPerBet, bankroll * sizeBase * edgeMult)
    const contracts = Math.max(1, Math.floor(wantUsd / (best.yes_ask / 100)))
    const stake = contracts * (best.yes_ask / 100)

    const won = rec.actual_K >= best.strike
    const result = won
      ? contracts * ((100 - best.yes_ask) / 100) * (1 - FEE)
      : -stake
    pnl += result
    bankroll += result
    fires++
    if (won) wins++; else losses++

    const d = rec.target_date
    const cur = dailyFires.get(d) ?? { n: 0, w: 0, pnl: 0 }
    cur.n++; if (won) cur.w++; cur.pnl += result
    dailyFires.set(d, cur)
  }

  const winPct = fires > 0 ? (wins / fires * 100).toFixed(1) : '—'
  const ret = ((bankroll / STARTING - 1) * 100).toFixed(1)
  console.log(`  ${label.padEnd(50)} fires=${String(fires).padStart(4)}  ${wins}W/${losses}L  win%=${String(winPct).padStart(5)}  P&L=${pnl >= 0 ? '+' : ''}$${pnl.toFixed(0).padStart(6)}  bankroll=$${bankroll.toFixed(0).padStart(7)}  return=${ret}%`)
  return { fires, wins, losses, pnl, bankroll, dailyFires }
}

console.log('\n═══ Out-of-Sample v3 Test on Historical 37-Day Backtest ═══')
console.log('All records: Mar 31 - May 6, 2026 — BEFORE v3 filters were designed.\n')

const v1 = evaluate(records, 'v1 (original ideal — no v3 filters)',         {})
const justHH = evaluate(records, 'v1 + H-H (ipL5 ≥ 5)',                      { requireH_H: true })
const justHI = evaluate(records, 'v1 + H-I (confidence > 0.3)',              { requireH_I: true })
const justHN = evaluate(records, 'v1 + skip K=7-9',                          { skipMiddle: true })
const v2 = evaluate(records, 'v2 (v1 + H-H + H-I)',                          { requireH_H: true, requireH_I: true })
const v3 = evaluate(records, 'v3 (v2 + skip K=7-9)',                         { requireH_H: true, requireH_I: true, skipMiddle: true })

console.log(`\n═══ Verdict ═══`)
console.log(`  v1 baseline:     +$${v1.pnl.toFixed(0)} (${((v1.bankroll/STARTING - 1)*100).toFixed(1)}% return)`)
console.log(`  v3 out-of-sample: +$${v3.pnl.toFixed(0)} (${((v3.bankroll/STARTING - 1)*100).toFixed(1)}% return)`)
console.log(`  v3 lift over v1:  ${v3.pnl > v1.pnl ? '+' : ''}$${(v3.pnl - v1.pnl).toFixed(0)}`)
console.log(`  v3 fires/day avg: ${(v3.fires / 37).toFixed(1)}`)
console.log()
console.log('If v3 lift > 0 ⟹ filters have real out-of-sample signal.')
console.log('If v3 lift ≤ 0 ⟹ the +$2,971 on May 7-10 was overfitting.')
