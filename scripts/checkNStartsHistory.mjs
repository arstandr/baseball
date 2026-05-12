import 'dotenv/config'
import { createClient } from '@libsql/client'
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })

// How is n_starts distributed in the last 30 days?
const r = await db.execute(`
  SELECT
    CASE
      WHEN n_starts IS NULL          THEN '0: null'
      WHEN n_starts < 5              THEN '1: <5'
      WHEN n_starts < 10             THEN '2: 5-9'
      WHEN n_starts < 20             THEN '3: 10-19'
      ELSE                                '4: 20+'
    END AS bucket,
    COUNT(*) AS n,
    SUM(CASE WHEN result='win' THEN 1 ELSE 0 END) AS wins,
    SUM(CASE WHEN result='loss' THEN 1 ELSE 0 END) AS losses,
    ROUND(SUM(pnl), 2) AS pnl,
    ROUND(SUM(capital_at_risk), 2) AS risk
  FROM ks_bets
  WHERE bet_date >= date('now','-30 days') AND live_bet=0 AND side='YES' AND result IN ('win','loss')
  GROUP BY bucket ORDER BY bucket
`)
console.log('YES bets last 30 days, by n_starts bucket:')
console.log('bucket          n     wins  losses  pnl       risk      ROI')
console.log('─'.repeat(70))
for (const row of r.rows) {
  const pnl = Number(row.pnl ?? 0), risk = Number(row.risk ?? 0)
  const roi = risk > 0 ? (pnl / risk) * 100 : 0
  console.log(`${row.bucket.padEnd(15)} ${String(row.n).padEnd(4)}  ${String(row.wins).padEnd(5)} ${String(row.losses).padEnd(6)}  ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2).padStart(7)}  $${risk.toFixed(2).padStart(8)}   ${roi.toFixed(1)}%`)
}
