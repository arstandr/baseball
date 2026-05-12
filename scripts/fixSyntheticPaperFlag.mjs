import 'dotenv/config'
import { createClient } from '@libsql/client'
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })

// Find any pre-game ks_bets rows with synthetic paper-prefix order_ids that
// are incorrectly tagged as paper=0 (they should be paper=1; the wrapper
// returned a fake order_id and they have no real Kalshi position).
const before = await db.execute(`
  SELECT id, bet_date, pitcher_name, side, strike, paper, order_id
  FROM ks_bets
  WHERE live_bet = 0 AND paper = 0 AND order_id LIKE 'paper-%'
`)
console.log(`Rows to fix: ${before.rows.length}`)
for (const b of before.rows) console.log(`  #${b.id} ${b.bet_date} ${b.pitcher_name} ${b.side}${b.strike} paper=${b.paper} order=${b.order_id}`)

if (before.rows.length === 0) { console.log('Nothing to fix.'); process.exit(0) }

await db.execute(`UPDATE ks_bets SET paper = 1 WHERE live_bet = 0 AND paper = 0 AND order_id LIKE 'paper-%'`)
console.log('\n✓ Restored to paper=1')
