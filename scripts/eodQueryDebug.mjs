import 'dotenv/config'
import { createClient } from '@libsql/client'
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })

console.log('── Direct query of today fires by paper flag ──')
const r1 = await db.execute(`
  SELECT paper, COUNT(*) AS fires, COUNT(*) FILTER (WHERE order_id IS NOT NULL) AS fires_with_order
  FROM ks_bets WHERE bet_date='2026-05-06' GROUP BY paper
`)
for (const r of r1.rows) console.log(`  paper=${r.paper}: ${r.fires} rows, ${r.fires_with_order} with order_id`)

console.log('\n── EOD query simulation (paper=1) ──')
const eodPaper = await db.execute(`
  SELECT
    COUNT(*) FILTER (WHERE order_id IS NOT NULL) AS fires,
    ROUND(SUM(pnl) FILTER (WHERE result IN ('win','loss')), 2) AS total_pnl,
    ROUND(SUM(pnl) FILTER (WHERE strategy_mode='pregame_inversion' AND result IN ('win','loss')), 2) AS inversion_pnl,
    ROUND(SUM(pnl) FILTER (WHERE strategy_mode='pregame_normal'    AND result IN ('win','loss')), 2) AS normal_pnl,
    ROUND(SUM(pnl) FILTER (WHERE strategy_mode='pregame_cross_strike' AND result IN ('win','loss')), 2) AS cross_strike_pnl
  FROM ks_bets
  WHERE bet_date = '2026-05-06' AND paper = 1
`)
console.log(eodPaper.rows[0])
