// One-off validation: re-run Apr 27 Adam-Live bets with proposed Phase 1 + Phase 2 fixes.
// Phase 1: tiered E[BF] cap for thin-sample pitchers
// Phase 2: archetypeR (NB dispersion by K%)
// Output: counterfactual P&L if these were active.

import { getClient } from '../../lib/db.js'
import { nbCDF, pAtLeast, archetypeR, NB_R } from '../../lib/strikeout-model.js'

// Binary-search invert: find lambda such that pAtLeast(lambda, n, r) ≈ targetProb
function invertLambda(targetProb, n, r = NB_R) {
  if (targetProb >= 0.999) return 999
  if (targetProb <= 0.001) return 0
  let lo = 0.01, hi = 30
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2
    const p = pAtLeast(mid, n, r)
    if (p < targetProb) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

// Phase 1 — tiered E[BF] cap.
// careerStarts < 3  → cap 15
// careerStarts < 10 → cap 18
// careerStarts < 25 → cap 21
// else → no cap
function bfCap(careerStarts) {
  if (careerStarts < 3) return 15
  if (careerStarts < 10) return 18
  if (careerStarts < 25) return 21
  return null
}

const c = getClient()

// Get bets
const bets = await c.execute(`
  SELECT id, pitcher_id, pitcher_name, strike, side, ROUND(model_prob,4) as p, ROUND(market_mid,2) as mid,
         bet_size, fill_price, ROUND(pnl,2) as pnl, result, actual_ks, bet_mode
  FROM ks_bets
  WHERE bet_date='2026-04-27' AND user_id=284 AND live_bet=0
  ORDER BY pitcher_name, strike
`)

// Pull career starts + season K%/BF per pitcher
const pids = [...new Set(bets.rows.map(b => String(b.pitcher_id)))]
const ctx = {}
for (const pid of pids) {
  // career starts (cumulative across seasons via pitcher_recent_starts)
  const starts = await c.execute({
    sql: `SELECT COUNT(*) as n,
                 AVG(bf) as avg_bf,
                 AVG(CASE WHEN season=2026 THEN bf END) as avg_bf_2026,
                 AVG(CASE WHEN season=2026 THEN ks*1.0/NULLIF(bf,0) END) as kpct_2026
          FROM pitcher_recent_starts WHERE pitcher_id=?`,
    args: [pid]
  })
  const sc = await c.execute({
    sql: `SELECT k_pct, ip FROM pitcher_statcast WHERE player_id=? AND season=2026 ORDER BY id DESC LIMIT 1`,
    args: [pid]
  })
  ctx[pid] = {
    careerStarts: Number(starts.rows[0]?.n ?? 0),
    avgBF:        Number(starts.rows[0]?.avg_bf_2026 ?? starts.rows[0]?.avg_bf ?? 22),
    kPct:         Number(sc.rows[0]?.k_pct ?? starts.rows[0]?.kpct_2026 ?? 0.22),
  }
}

// Replay each bet
const results = []
const counterfactual = { kept: 0, killed: 0, pnlKept: 0, pnlKilled: 0 }
const byPitcher = {}

for (const b of bets.rows) {
  const pid = String(b.pitcher_id)
  const C   = ctx[pid]
  const currentR = NB_R
  const newR     = archetypeR({ k_pct: C.kPct })
  // Implied lambda from stored model_prob with current r
  const lambdaOld = invertLambda(Number(b.p), b.strike, currentR)
  // Phase 1: cap E[BF] by careerStarts
  const cap = bfCap(C.careerStarts)
  const bfFactor = cap != null ? Math.min(1, cap / Math.max(C.avgBF, 1)) : 1
  const lambdaNew = lambdaOld * bfFactor
  // Phase 2: recompute prob with archetypeR
  const probNew = pAtLeast(lambdaNew, b.strike, newR)
  // Gates
  const TAIL_MIN = b.side === 'YES' && b.strike >= 8 ? 0.55 : 0.40
  const yesPregameMaxMid = 50
  const yesMaxStrike = 8
  const noMaxStrike  = 6
  let killed = false
  let killReason = null
  if (b.side === 'YES' && b.mid > yesPregameMaxMid) { killed = true; killReason = 'yes_max_mid>50' }
  else if (b.side === 'YES' && b.strike > yesMaxStrike) { killed = true; killReason = 'yes_max_strike>8' }
  else if (b.side === 'NO'  && b.strike > noMaxStrike)  { killed = true; killReason = 'no_max_strike>6' }
  else if (b.side === 'YES' && probNew < TAIL_MIN) { killed = true; killReason = `prob<${TAIL_MIN.toFixed(2)} (was ${b.p}, now ${probNew.toFixed(3)})` }
  results.push({ ...b, careerStarts: C.careerStarts, kPct: C.kPct, avgBF: C.avgBF, lambdaOld, lambdaNew, probNew, newR, bfFactor, killed, killReason })
  if (!byPitcher[b.pitcher_name]) byPitcher[b.pitcher_name] = { kept: 0, killed: 0, pnlKept: 0, pnlKilled: 0, count: 0 }
  const bp = byPitcher[b.pitcher_name]
  bp.count++
  const pnl = Number(b.pnl || 0)
  if (killed) { bp.killed++; bp.pnlKilled += pnl; counterfactual.killed++; counterfactual.pnlKilled += pnl }
  else        { bp.kept++;   bp.pnlKept   += pnl; counterfactual.kept++;   counterfactual.pnlKept   += pnl }
}

// Apply max_yes_per_pitcher = 2 (post-filter): keep top 2 by (model_prob descending) for YES per pitcher
// (we're cutting the rest)
const yesByPitcher = {}
for (const r of results) {
  if (r.killed || r.side !== 'YES') continue
  if (!yesByPitcher[r.pitcher_name]) yesByPitcher[r.pitcher_name] = []
  yesByPitcher[r.pitcher_name].push(r)
}
for (const [name, arr] of Object.entries(yesByPitcher)) {
  arr.sort((a, b) => b.probNew - a.probNew)
  const keep = arr.slice(0, 2)
  const cut  = arr.slice(2)
  for (const r of cut) {
    r.killed = true
    r.killReason = 'max_yes_per_pitcher=2'
    const bp = byPitcher[name]
    bp.kept--; bp.killed++
    bp.pnlKept   -= Number(r.pnl || 0)
    bp.pnlKilled += Number(r.pnl || 0)
    counterfactual.kept--; counterfactual.killed++
    counterfactual.pnlKept   -= Number(r.pnl || 0)
    counterfactual.pnlKilled += Number(r.pnl || 0)
  }
}

console.log('=== Phase 1+2 + already-live gates: Apr 27 Adam pre-game replay ===\n')
console.log('Pitcher           | bets | kept→pnl | killed→pnl(saved if -)')
for (const [name, s] of Object.entries(byPitcher).sort((a,b) => a[1].pnlKept + a[1].pnlKilled - (b[1].pnlKept + b[1].pnlKilled))) {
  console.log('  ' + name.slice(0,17).padEnd(18) + '| ' + String(s.count).padStart(4) + ' | ' + String(s.kept).padStart(2) + '→$' + s.pnlKept.toFixed(2).padStart(8) + ' | ' + String(s.killed).padStart(2) + '→$' + s.pnlKilled.toFixed(2).padStart(8))
}
console.log()
console.log('Bets KEPT (would still fire today):  ', counterfactual.kept,   ' P&L:', '$' + counterfactual.pnlKept.toFixed(2))
console.log('Bets KILLED (would NOT fire today):  ', counterfactual.killed, ' P&L:', '$' + counterfactual.pnlKilled.toFixed(2), '(saved if negative)')
const totalActual = counterfactual.pnlKept + counterfactual.pnlKilled
console.log('Total actual Apr 27 pre-game P&L:    ', '$' + totalActual.toFixed(2))
console.log('Counterfactual Apr 27 pre-game P&L:  ', '$' + counterfactual.pnlKept.toFixed(2))
console.log('Delta (improvement):                 ', '$' + (counterfactual.pnlKept - totalActual).toFixed(2) +
            ' = -$' + counterfactual.pnlKilled.toFixed(2) + ' loss avoided')

console.log('\n--- Per-bet detail (sample) ---')
for (const r of results.slice(0, 60)) {
  console.log('  ' + (r.killed ? '🔴 KILL' : '🟢 KEEP') + ' ' + r.pitcher_name.slice(0,15).padEnd(16) + ' K' + String(r.strike).padEnd(2) + ' ' + r.side + ' | starts=' + r.careerStarts + ' kpct=' + r.kPct.toFixed(2) + ' λold=' + r.lambdaOld.toFixed(2) + ' λnew=' + r.lambdaNew.toFixed(2) + ' p=' + r.p + '→' + r.probNew.toFixed(3) + ' r=' + r.newR + ' | actual=' + r.result + ' pnl=$' + r.pnl + (r.killReason ? '  (' + r.killReason + ')' : ''))
}
process.exit(0)
