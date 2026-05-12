// Test NO-side bets retroactively against fade_paper_test_candidates shadow log.
//
// For every candidate where:
//   - We have outcome (actual_ks not null)
//   - The NO ask is in a sensible range (3-88c)
//   - Model prob is computed
// Compute NO-side edge: (1 - model_prob) - no_ask/100
// Apply various filter combinations
// Score: did pitcher fall short of strike? (NO wins if actual_ks < strike)

import 'dotenv/config'
import { createClient } from '@libsql/client'

const FEE = 0.07
const FIXED_STAKE = 50  // $50/bet for fair comparison

const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })

// Pull candidates with outcomes
const r = await db.execute(`
  SELECT target_date, pitcher_name, strike,
         yes_bid, yes_ask, no_ask, no_bid, market_mid,
         model_probs_json, actual_ks
  FROM fade_paper_test_candidates
  WHERE target_date BETWEEN '2026-05-07' AND '2026-05-08'
    AND actual_ks IS NOT NULL
    AND no_ask IS NOT NULL AND no_ask > 0
`)
console.log(`Settled candidates: ${r.rows.length}`)

// Build NO-side candidate list using nb8_l5 model variant (ideal)
const candidates = []
for (const row of r.rows) {
  let probs
  try { probs = JSON.parse(row.model_probs_json) } catch { continue }
  const modelProb = probs?.nb8_l5
  if (modelProb == null) continue
  const noProb = 1 - modelProb
  const noAsk = Number(row.no_ask)
  if (noAsk < 3 || noAsk > 88) continue
  const noEdge = noProb - noAsk / 100
  const won = Number(row.actual_ks) < Number(row.strike)
  candidates.push({
    date: row.target_date, pitcher: row.pitcher_name, strike: Number(row.strike),
    no_ask: noAsk, no_prob: noProb, edge: noEdge,
    actual_K: Number(row.actual_ks), won,
  })
}
console.log(`NO-side candidates with ideal-model probs: ${candidates.length}`)

function score(filterFn, label) {
  const sub = candidates.filter(filterFn)
  if (!sub.length) { console.log(`  ${label.padEnd(50)} n=0`); return null }
  let pnl = 0, wins = 0, stake = 0
  for (const c of sub) {
    const contracts = Math.max(1, Math.floor(FIXED_STAKE / (c.no_ask / 100)))
    const s = contracts * (c.no_ask / 100)
    stake += s
    if (c.won) { wins++; pnl += contracts * ((100 - c.no_ask) / 100) * (1 - FEE) }
    else pnl -= s
  }
  const winPct = (wins / sub.length * 100).toFixed(1)
  const roi = stake > 0 ? (pnl / stake * 100).toFixed(1) : '0'
  console.log(`  ${label.padEnd(50)} n=${String(sub.length).padStart(3)}  win%=${winPct.padStart(5)}  P&L=${pnl >= 0 ? '+' : ''}$${pnl.toFixed(0).padStart(4)}  ROI=${roi.padStart(6)}%`)
  return { sub, pnl, wins, stake }
}

console.log('\n═══ NO-side filter sweep (Days 1-2 shadow data, ideal model) ═══\n')
console.log('Hypothesis: when model says pitcher unlikely to hit strike, bet NO\n')

// Baseline
score(c => c.edge >= 0.05, 'edge ≥5c')
score(c => c.edge >= 0.05 && c.no_ask <= 50, 'edge ≥5c, no_ask ≤50c')
score(c => c.edge >= 0.05 && c.no_ask <= 30, 'edge ≥5c, no_ask ≤30c')
score(c => c.edge >= 0.08, 'edge ≥8c')
score(c => c.edge >= 0.10, 'edge ≥10c')
score(c => c.edge >= 0.15, 'edge ≥15c')
score(c => c.edge >= 0.20, 'edge ≥20c')

console.log('\n— By strike level —')
score(c => c.edge >= 0.05 && c.strike <= 5, 'strike ≤5')
score(c => c.edge >= 0.05 && c.strike >= 6 && c.strike <= 7, 'strike 6-7')
score(c => c.edge >= 0.05 && c.strike >= 8, 'strike ≥8')

console.log('\n— Tail strikes (high overpriced YES) —')
score(c => c.edge >= 0.05 && c.strike >= 8 && c.no_ask <= 30, 'strike ≥8, no_ask ≤30c')
score(c => c.edge >= 0.05 && c.strike >= 9 && c.no_ask <= 30, 'strike ≥9, no_ask ≤30c')
score(c => c.edge >= 0.10 && c.strike >= 8, 'strike ≥8, edge ≥10c')

console.log('\n— Lower strikes (favored YES) —')
score(c => c.edge >= 0.05 && c.strike <= 5 && c.no_ask >= 50, 'strike ≤5, no_ask ≥50c (fade favorite)')
score(c => c.edge >= 0.10 && c.strike >= 4 && c.strike <= 6, 'strike 4-6, edge ≥10c')

console.log('\n— Best per-pitcher (mirror our fade-yes structure) —')
const byPD = new Map()
for (const c of candidates) {
  if (c.edge < 0.05) continue
  const k = `${c.date}|${c.pitcher}`
  if (!byPD.has(k) || byPD.get(k).edge < c.edge) byPD.set(k, c)
}
const oneFire = [...byPD.values()]
let pnl = 0, wins = 0, stake = 0
for (const c of oneFire) {
  const contracts = Math.max(1, Math.floor(FIXED_STAKE / (c.no_ask / 100)))
  const s = contracts * (c.no_ask / 100)
  stake += s
  if (c.won) { wins++; pnl += contracts * ((100 - c.no_ask) / 100) * (1 - FEE) }
  else pnl -= s
}
console.log(`  ${'top-1 NO per pitcher (mirror fade-yes)'.padEnd(50)} n=${String(oneFire.length).padStart(3)}  win%=${(wins/oneFire.length*100).toFixed(1).padStart(5)}  P&L=${pnl >= 0 ? '+' : ''}$${pnl.toFixed(0).padStart(4)}  ROI=${(stake > 0 ? pnl/stake*100 : 0).toFixed(1).padStart(6)}%`)

// Sample of biggest NO-edge candidates
console.log('\n— Sample biggest NO-edge candidates (top 10 by edge) —')
candidates.sort((a, b) => b.edge - a.edge)
for (const c of candidates.slice(0, 10)) {
  const status = c.won ? '✅ NO won' : '❌ NO lost'
  console.log(`  ${c.date} ${(c.pitcher ?? '?').padEnd(20)} K≥${String(c.strike).padStart(2)}  no_ask=${String(c.no_ask).padStart(2)}c  edge=+${(c.edge*100).toFixed(1)}c  actualK=${c.actual_K}  ${status}`)
}
