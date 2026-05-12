import 'dotenv/config'
import { createClient } from '@libsql/client'
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })

// 1. The deepAnalysis script used live_bet=0. Check live_bet=1 NO bets too —
//    that's where confirmed-pull / false-pull bug fills would land.
console.log('── ALL NO bets last 30 days, by live_bet flag ──\n')
const r = await db.execute(`
  SELECT live_bet, strategy_mode, bet_mode, COUNT(*) AS n,
         SUM(CASE WHEN result='win' THEN 1 ELSE 0 END) AS wins,
         ROUND(SUM(pnl), 2) AS pnl,
         ROUND(SUM(capital_at_risk), 2) AS risk
  FROM ks_bets
  WHERE bet_date >= date('now','-30 days') AND side = 'NO' AND result IN ('win','loss')
  GROUP BY live_bet, strategy_mode, bet_mode
  ORDER BY live_bet, strategy_mode, bet_mode
`)
for (const row of r.rows) {
  console.log(`  live_bet=${row.live_bet}  mode=${(row.strategy_mode ?? '').padEnd(28)}  bet_mode=${(row.bet_mode ?? '-').padEnd(15)}  n=${String(row.n).padEnd(4)}  wins=${row.wins}  pnl=${row.pnl >= 0 ? '+' : ''}$${row.pnl}  risk=$${row.risk}`)
}

// 2. Look for suspicious-looking big single days — where we suddenly bought lots of NOs at once
console.log('\n── Days with the most NO fires (top 10) ──\n')
const r2 = await db.execute(`
  SELECT bet_date, live_bet, strategy_mode,
    COUNT(*) AS n, ROUND(SUM(pnl), 2) AS pnl, ROUND(SUM(capital_at_risk), 2) AS risk
  FROM ks_bets
  WHERE bet_date >= date('now','-30 days') AND side = 'NO' AND result IN ('win','loss')
  GROUP BY bet_date, live_bet, strategy_mode
  ORDER BY n DESC LIMIT 10
`)
for (const row of r2.rows) {
  console.log(`  ${row.bet_date}  live_bet=${row.live_bet}  ${(row.strategy_mode ?? '').padEnd(28)}  n=${row.n}  pnl=${row.pnl >= 0 ? '+' : ''}$${row.pnl}  risk=$${row.risk}`)
}

// 3. Look specifically for confirmed-pull or live NO bets that won big
console.log('\n── Top 10 individual NO winners (any live_bet, any mode) ──\n')
const r3 = await db.execute(`
  SELECT bet_date, pitcher_name, strike, side, live_bet, strategy_mode, bet_mode,
    ROUND(pnl, 2) AS pnl, ROUND(capital_at_risk, 2) AS risk, actual_ks, live_pk_effective
  FROM ks_bets
  WHERE bet_date >= date('now','-30 days') AND side = 'NO' AND result = 'win'
  ORDER BY pnl DESC LIMIT 10
`)
for (const row of r3.rows) {
  console.log(`  ${row.bet_date}  ${(row.pitcher_name ?? '').padEnd(20)} ${row.side}${row.strike}  live=${row.live_bet}  ${(row.strategy_mode ?? '').padEnd(28)}  pnl=+$${row.pnl}  risk=$${row.risk}  actual_K=${row.actual_ks}  pk_eff=${row.live_pk_effective ?? '-'}`)
}
