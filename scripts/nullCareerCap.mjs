import 'dotenv/config'
import { createClient } from '@libsql/client'
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })

const PITCHER_BLOCKLIST = new Set(['José Soriano', 'Cristopher Sánchez', 'J.T. Ginn', 'Anthony Kay', 'Matthew Boyd'])
const SIZE_CAP_PCT = 0.04
const HIGH_CONF_THRESH = 0.65
const HIGH_CONF_HAIRCUT = 0.5
const REFERENCE_BANKROLL = 773

const all = await db.execute(`
  SELECT pitcher_name, side, strike, model_prob, k9_l5, k9_career, capital_at_risk, pnl, result, market_mid
  FROM ks_bets
  WHERE bet_date >= date('now','-30 days') AND live_bet=0 AND result IN ('win','loss') AND capital_at_risk > 0
`)
const rows = all.rows.map(r => ({
  ...r,
  capital_at_risk: Number(r.capital_at_risk), pnl: Number(r.pnl ?? 0),
  model_prob: Number(r.model_prob ?? 0), strike: Number(r.strike),
  k9_l5: Number(r.k9_l5 ?? 0),
  k9_career: r.k9_career == null ? null : Number(r.k9_career),
}))

function run(rookieDollarCap) {
  let kept = 0, pnl = 0, risk = 0, capped = 0, savedFromCap = 0
  for (const r of rows) {
    if (PITCHER_BLOCKLIST.has(r.pitcher_name)) continue
    if (r.side === 'YES' && (r.strike === 5 || r.strike >= 7)) continue
    if (r.side === 'YES' && r.k9_career != null && r.k9_career > 0 && r.k9_l5 < r.k9_career) continue
    if (r.side === 'NO' && Number(r.market_mid) > 65) continue

    let cap = r.capital_at_risk, p = r.pnl
    if (r.side === 'YES' && r.model_prob >= HIGH_CONF_THRESH) { cap *= HIGH_CONF_HAIRCUT; p *= HIGH_CONF_HAIRCUT }
    const perBetCap = SIZE_CAP_PCT * REFERENCE_BANKROLL
    if (cap > perBetCap) { const f = perBetCap / cap; cap *= f; p *= f }
    // NEW: rookie hard dollar cap
    const isRookie = r.side === 'YES' && (r.k9_career == null || r.k9_career === 0)
    if (isRookie && cap > rookieDollarCap) {
      const f = rookieDollarCap / cap
      cap *= f
      const oldP = p
      p *= f
      capped++
      savedFromCap += oldP - p
    }
    kept++; pnl += p; risk += cap
  }
  return { kept, pnl, risk, capped, savedFromCap }
}

const baseline = run(Infinity)
console.log(`Baseline (no rookie cap):  ${baseline.kept} bets, P&L $${baseline.pnl.toFixed(2)}, risk $${baseline.risk.toFixed(2)}, ROI ${(baseline.pnl/baseline.risk*100).toFixed(1)}%\n`)

console.log('Rookie size cap scenarios (k9_career null/0 only, max $X):')
console.log('cap     bets_capped   savings    new_pnl     new_risk    new_ROI    swing_vs_baseline')
console.log('─'.repeat(95))
for (const cap of [3, 5, 7, 10, 15]) {
  const r = run(cap)
  const swing = r.pnl - baseline.pnl
  console.log(`$${String(cap).padEnd(2)}    ${String(r.capped).padEnd(11)}   $${r.savedFromCap.toFixed(2).padStart(7)}   $${r.pnl.toFixed(2).padStart(8)}   $${r.risk.toFixed(2).padStart(8)}   ${(r.pnl/r.risk*100).toFixed(1).padStart(5)}%    ${swing >= 0 ? '+' : ''}$${swing.toFixed(2)}`)
}
