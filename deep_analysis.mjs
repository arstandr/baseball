import { getClient } from './lib/db.js'
import 'dotenv/config'

const client = getClient()

// Get all Apr 27 bets with key columns for C1 diagnosis
const bets = await client.execute({
  sql: `
    SELECT id, pitcher_name, strike, side, logged_at, bet_size, fill_price, filled_contracts, order_status, market_mid, ticker
    FROM ks_bets 
    WHERE bet_date = ? AND live_bet = 0
    ORDER BY logged_at DESC
    LIMIT 50
  `,
  args: ['2026-04-27']
})

console.log('=== BET SIZE vs FILLED CONTRACTS ANALYSIS ===')
console.log('Columns: id | pitcher | strike | bet_size | fill_price | filled_contracts | ratio | status')
for (const b of bets.rows) {
  const ratio = b.filled_contracts && b.fill_price 
    ? ((b.filled_contracts * b.fill_price) / 100).toFixed(1)
    : 'null'
  console.log(`${b.id} | ${b.pitcher_name} | ${b.strike} | ${b.bet_size} | ${b.fill_price} | ${b.filled_contracts} | ratio=${ratio} | ${b.order_status}`)
}

console.log('\n=== RESTING ORDERS THAT NEVER FILLED ===')
const resting = await client.execute({
  sql: `
    SELECT id, pitcher_name, strike, bet_size, order_id, order_status, filled_contracts
    FROM ks_bets
    WHERE bet_date = ? AND order_status = 'resting'
    ORDER BY logged_at
  `,
  args: ['2026-04-27']
})

console.log(`Found ${resting.rows.length} resting orders:`)
resting.rows.forEach(r => {
  console.log(`  id=${r.id} pitcher=${r.pitcher_name} strike=${r.strike} bet_size=${r.bet_size} filled=${r.filled_contracts} order_id=${r.order_id}`)
})

client.close()
