import 'dotenv/config'
import { createClient } from '@libsql/client'
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })

// Test: how do bets where k9_career IS NULL perform?
const r = await db.execute(`
  SELECT
    CASE
      WHEN k9_career IS NULL OR k9_career = 0 THEN 'null/zero career'
      ELSE 'has career data'
    END AS bucket,
    COUNT(*) AS n,
    SUM(CASE WHEN result='win' THEN 1 ELSE 0 END) AS wins,
    ROUND(SUM(pnl), 2) AS pnl,
    ROUND(SUM(capital_at_risk), 2) AS risk
  FROM ks_bets
  WHERE bet_date >= date('now','-30 days') AND live_bet=0 AND side='YES' AND result IN ('win','loss')
  GROUP BY bucket
`)
for (const row of r.rows) {
  const pnl = Number(row.pnl ?? 0), risk = Number(row.risk ?? 0)
  const roi = risk > 0 ? (pnl / risk) * 100 : 0
  console.log(`  ${row.bucket.padEnd(20)} n=${row.n}  ${row.wins}W  pnl=${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}  risk=$${risk.toFixed(2)}  ROI=${roi.toFixed(1)}%`)
}
