import { getClient } from './lib/db.js'
import 'dotenv/config'

const client = getClient()

// 1. Get all bets on Apr 27
const bets = await client.execute({
  sql: `SELECT id, pitcher_name, strike, side, logged_at, game, order_status, filled_contracts, bet_size, fill_price FROM ks_bets WHERE bet_date = ? ORDER BY logged_at`,
  args: ['2026-04-27']
})

// 2. Get games to find first pitches
const games = await client.execute({
  sql: `SELECT id, team_away, team_home, game_time FROM games WHERE date = ?`,
  args: ['2026-04-27']
})

// 3. Get all pitchers with edges
const edges = await client.execute({
  sql: `SELECT pitcher_id, edges_json FROM pitcher_edge_cache WHERE bet_date = ?`,
  args: ['2026-04-27']
})

// Parse game times
const gameTimeMap = new Map()
for (const g of games.rows) {
  const gameLabel = `${g.team_away}@${g.team_home}`
  gameTimeMap.set(gameLabel, new Date(g.game_time))
}

// Find late bets (>30 min after first pitch)
console.log('=== LATE BETS (>30 MIN AFTER FIRST PITCH) ===')
const lateBets = []
for (const bet of bets.rows) {
  const gameTime = gameTimeMap.get(bet.game)
  if (!gameTime) continue
  const loggedTime = new Date(bet.logged_at)
  const diffMinutes = (loggedTime - gameTime) / 60000
  if (diffMinutes > 30) {
    lateBets.push({
      id: bet.id,
      pitcher: bet.pitcher_name,
      strike: bet.strike,
      side: bet.side,
      logged_at: bet.logged_at,
      game_time: gameTime.toISOString(),
      minutes_late: Math.round(diffMinutes),
      status: bet.order_status,
      filled: bet.filled_contracts
    })
  }
}
console.log(lateBets.length > 0 ? JSON.stringify(lateBets, null, 2) : 'None found')

// Parse edge cache
const edgesMap = new Map()
for (const edge of edges.rows) {
  try {
    const parsed = JSON.parse(edge.edges_json)
    if (parsed && typeof parsed === 'object') {
      edgesMap.set(edge.pitcher_id, Object.keys(parsed))
    }
  } catch (e) {
    // noop
  }
}

// Find pitchers we had edges for but didn't bet
console.log('\n=== PITCHERS WITH EDGES BUT NO BETS ===')
const bettedPitchers = new Set()
for (const bet of bets.rows) {
  bettedPitchers.add(bet.pitcher_name)
}
const missedEdges = []
for (const [pitcher_id, strikes] of edgesMap) {
  // Try to find pitcher name in bets
  const found = bets.rows.find(b => b.pitcher_name && 
    (b.pitcher_name.includes(pitcher_id) || pitcher_id.includes(b.pitcher_name)))
  if (!found) {
    missedEdges.push({ pitcher_id, strike_counts: strikes.join(', ') })
  }
}
console.log(missedEdges.length > 0 ? JSON.stringify(missedEdges, null, 2) : 'None found')

// Resting/sizing anomalies
console.log('\n=== RESTING ORDERS / SIZING ANOMALIES ===')
const anomalies = []
for (const bet of bets.rows) {
  if (bet.order_status === 'resting' && bet.filled_contracts === null) {
    anomalies.push({
      id: bet.id,
      pitcher: bet.pitcher_name,
      strike: bet.strike,
      bet_size: bet.bet_size,
      status: 'resting - never filled'
    })
  }
  // Check if filled_contracts vs bet_size/fill_price is wildly off
  if (bet.filled_contracts && bet.bet_size && bet.fill_price && bet.filled_contracts !== bet.bet_size) {
    if (Math.abs(bet.filled_contracts - bet.bet_size) > 5) {
      anomalies.push({
        id: bet.id,
        pitcher: bet.pitcher_name,
        strike: bet.strike,
        bet_size: bet.bet_size,
        filled_contracts: bet.filled_contracts,
        fill_price: bet.fill_price,
        note: 'Size mismatch'
      })
    }
  }
}
console.log(anomalies.length > 0 ? JSON.stringify(anomalies, null, 2) : 'None found')

// Check duplicate bets at same pitcher/strike/side with different prices/times
console.log('\n=== SEQUENCE ANOMALIES (DUPLICATE PITCHER/STRIKE/SIDE) ===')
const pitcherMap = new Map()
for (const bet of bets.rows) {
  const key = `${bet.pitcher_name}-${bet.strike}-${bet.side}`
  if (!pitcherMap.has(key)) pitcherMap.set(key, [])
  pitcherMap.get(key).push(bet)
}
const seqAnomalies = []
for (const [key, bets_list] of pitcherMap) {
  if (bets_list.length > 1) {
    const prices = bets_list.map(b => b.fill_price || b.market_mid).join(', ')
    const times = bets_list.map(b => new Date(b.logged_at).toISOString().split('T')[1]).join(' | ')
    seqAnomalies.push({ pitcher_strike_side: key, count: bets_list.length, prices, times })
  }
}
console.log(seqAnomalies.length > 0 ? JSON.stringify(seqAnomalies, null, 2) : 'None found')

// Reconciliation
console.log('\n=== RECONCILIATION ===')
let totalBets = 0, totalFilled = 0, totalOpen = 0
for (const bet of bets.rows) {
  totalBets += bet.bet_size || 0
  if (bet.filled_contracts) totalFilled += bet.filled_contracts
  if (bet.order_status === 'resting' || bet.order_status === null) totalOpen += bet.bet_size || 0
}
console.log(`Total bet_size: ${totalBets}, Total filled: ${totalFilled}, Unaccounted: ${totalBets - totalFilled}`)

client.close()
