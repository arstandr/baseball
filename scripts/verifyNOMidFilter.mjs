import 'dotenv/config'
import { createClient } from '@libsql/client'
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })

// Historical NO bets by strike, broken down by whether market_mid was above
// or below the current no_max_market_mid=50 filter. If most K3-K5 NO bets
// had market_mid > 50, the live engine WILL NOT replicate the historical
// profit because they'll be blocked.
const r = await db.execute(`
  SELECT strike,
    COUNT(*) AS total,
    SUM(CASE WHEN market_mid <= 50 THEN 1 ELSE 0 END) AS would_fire_today,
    SUM(CASE WHEN market_mid > 50 THEN 1 ELSE 0 END) AS would_be_blocked,
    ROUND(AVG(market_mid), 1) AS avg_mid,
    ROUND(SUM(CASE WHEN market_mid > 50 THEN pnl ELSE 0 END), 2) AS pnl_at_risk_of_block,
    ROUND(SUM(CASE WHEN market_mid <= 50 THEN pnl ELSE 0 END), 2) AS pnl_safe
  FROM ks_bets
  WHERE bet_date >= date('now','-30 days') AND live_bet = 0 AND side = 'NO'
    AND result IN ('win','loss') AND capital_at_risk > 0
  GROUP BY strike
  ORDER BY strike
`)
console.log(`strike   total   would_fire  blocked  avg_mid   pnl_at_risk   pnl_safe`)
console.log('─'.repeat(80))
for (const row of r.rows) {
  console.log(`K${row.strike}       ${String(row.total).padEnd(5)}   ${String(row.would_fire_today).padEnd(10)}  ${String(row.would_be_blocked).padEnd(7)}  ${String(row.avg_mid).padEnd(7)}   ${row.pnl_at_risk_of_block >= 0 ? '+' : ''}$${Number(row.pnl_at_risk_of_block).toFixed(2).padStart(7)}    ${row.pnl_safe >= 0 ? '+' : ''}$${Number(row.pnl_safe).toFixed(2).padStart(7)}`)
}
