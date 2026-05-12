import { getClient } from './lib/db.js'
import 'dotenv/config'

const client = getClient()

// Fetch Apr 27 bets
const bets = await client.execute({
  sql: `
    SELECT 
      id, pitcher_name, strike, side, logged_at, game, 
      live_inning, order_status, filled_contracts, bet_size, fill_price, 
      market_mid, ticker, order_id, paper, live_bet
    FROM ks_bets 
    WHERE bet_date = ?
    ORDER BY logged_at ASC
  `,
  args: ['2026-04-27']
})

console.log('=== KS_BETS FOR 2026-04-27 ===')
console.log(JSON.stringify(bets.rows, null, 2))

// Fetch games for Apr 27 to check first pitch times
const games = await client.execute({
  sql: `
    SELECT id, team_away, team_home, game_time, status
    FROM games
    WHERE date = ?
    ORDER BY game_time ASC
  `,
  args: ['2026-04-27']
})

console.log('\n=== GAMES FOR 2026-04-27 ===')
console.log(JSON.stringify(games.rows, null, 2))

// Fetch pitcher edges for Apr 27
const edges = await client.execute({
  sql: `
    SELECT pitcher_id, edge_computed_at, edges_json
    FROM pitcher_edge_cache
    WHERE bet_date = ?
  `,
  args: ['2026-04-27']
})

console.log('\n=== PITCHER_EDGE_CACHE FOR 2026-04-27 ===')
if (edges.rows && edges.rows.length) {
  edges.rows.forEach(row => {
    console.log(`Pitcher ID: ${row.pitcher_id}`)
    console.log(`Computed: ${row.edge_computed_at}`)
    try {
      const edges_parsed = JSON.parse(row.edges_json)
      console.log(`Edges: ${JSON.stringify(edges_parsed, null, 2)}`)
    } catch {
      console.log(`Edges (raw): ${row.edges_json}`)
    }
    console.log('---')
  })
} else {
  console.log('No pitcher edge cache entries found')
}

client.close()
