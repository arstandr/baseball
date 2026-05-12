import 'dotenv/config'
import { createClient } from '@libsql/client'
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })

// Test multiple rookie caps. Apply to last 30 days. Compare PnL.
const all = await db.execute(`
  SELECT n_starts, capital_at_risk, pnl, result
  FROM ks_bets
  WHERE bet_date >= date('now','-30 days')
    AND live_bet=0 AND side='YES' AND result IN ('win','loss')
    AND capital_at_risk > 0
`)
const rows = all.rows.map(r => ({
  n_starts: r.n_starts == null ? -1 : Number(r.n_starts),
  cap: Number(r.capital_at_risk),
  pnl: Number(r.pnl),
}))

const baselinePnl = rows.reduce((s, r) => s + r.pnl, 0)
const baselineRisk = rows.reduce((s, r) => s + r.cap, 0)
console.log(`Baseline (no rookie cap): ${rows.length} bets, P&L $${baselinePnl.toFixed(2)} on $${baselineRisk.toFixed(2)} risk (ROI ${(baselinePnl/baselineRisk*100).toFixed(1)}%)\n`)

console.log('rookie cap scenarios (n_starts ≤ N, max bet $X):')
console.log('threshold  cap   bets_capped  pnl_change  new_total_pnl   new_ROI')
console.log('─'.repeat(80))
for (const [threshold, capDollars] of [[2, 5], [2, 10], [2, 15], [3, 5], [3, 10], [3, 15], [-1, 5], [-1, 10]]) {
  let pnlNew = 0, capped = 0
  for (const r of rows) {
    let pnl = r.pnl, cap = r.cap
    // Apply cap if n_starts ≤ threshold (note: -1 means "or null")
    if ((r.n_starts >= 0 && r.n_starts <= threshold) || (threshold === -1 && r.n_starts === -1)) {
      if (cap > capDollars) {
        const scale = capDollars / cap
        pnl = r.pnl * scale
        capped++
      }
    }
    pnlNew += pnl
  }
  const swing = pnlNew - baselinePnl
  console.log(`n≤${threshold}      $${String(capDollars).padEnd(2)}    ${String(capped).padEnd(11)}   ${swing >= 0 ? '+' : ''}$${swing.toFixed(2).padStart(7)}    $${pnlNew.toFixed(2).padStart(8)}     ${(pnlNew/baselineRisk*100).toFixed(1)}%`)
}
