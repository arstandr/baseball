import 'dotenv/config'
import { createClient } from '@libsql/client'
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })

// Today's fires with timing context
const r = await db.execute(`
  SELECT b.id, b.user_id, b.pitcher_name, b.side, b.strike, b.capital_at_risk,
         b.logged_at, b.filled_at, b.order_id, b.strategy_mode,
         b.ticker, b.live_bet, b.paper
  FROM ks_bets b
  WHERE b.bet_date = '2026-05-04' AND b.live_bet = 0
  ORDER BY b.logged_at ASC
`)

console.log(`Today's pregame fires (${r.rows.length}):\n`)
console.log('logged_at_UTC          pitcher              side   strike  user  risk    mode               paper  order_prefix')
console.log('─'.repeat(120))
for (const row of r.rows) {
  const userName = row.user_id === 1 ? 'Adam' : row.user_id === 2 ? 'Isaiah' : row.user_id === 284 ? 'Adam-Live' : `u${row.user_id}`
  const orderShort = (row.order_id ?? '').slice(0, 18)
  console.log(`${row.logged_at}   ${(row.pitcher_name ?? '').padEnd(20)} ${row.side.padEnd(4)}   K${row.strike}     ${userName.padEnd(5)} $${String(row.capital_at_risk).padEnd(6)} ${(row.strategy_mode ?? '').padEnd(18)} ${row.paper}      ${orderShort}`)
}

// Look at games + lineup state
console.log(`\nToday's games + lineup state:`)
const games = await db.execute(`
  SELECT game_pk, away_team, home_team, game_time_et, phase,
         home_lineup_posted, away_lineup_posted
  FROM game_pulse
  WHERE bet_date = '2026-05-04'
  ORDER BY game_time_et
`)
for (const g of games.rows) {
  console.log(`  ${g.away_team}@${g.home_team}  fp=${g.game_time_et}  phase=${g.phase}  away_lineup=${g.away_lineup_posted ?? '-'}  home_lineup=${g.home_lineup_posted ?? '-'}`)
}

// Pre-fire schedule for context
console.log(`\nbet_schedule entries for today:`)
const sched = await db.execute(`
  SELECT pitcher_name, game_label, game_time, status, fired_at, scheduled_at, allocated_usd, preflight_outcome
  FROM bet_schedule
  WHERE bet_date = '2026-05-04'
  ORDER BY game_time
`)
for (const s of sched.rows) {
  console.log(`  ${(s.pitcher_name ?? '').padEnd(22)} ${(s.game_label ?? '').padEnd(10)}  fp=${s.game_time}  status=${s.status} fired_at=${s.fired_at ?? '-'} alloc=$${s.allocated_usd ?? '-'} preflight=${s.preflight_outcome ?? '-'}`)
}
