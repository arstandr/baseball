import * as db from './lib/db.js'

async function loadUmpireFeatures(umpireId, asOfDate) {
  if (!umpireId) return null
  const row = await db.one(
    `SELECT * FROM historical_umpire_stats WHERE umpire_id = ? AND as_of_date = ?`,
    [umpireId, asOfDate],
  )
  console.log(`Query: umpire_id=${umpireId}, as_of_date=${asOfDate}`)
  console.log(`Result:`, JSON.stringify(row))
  if (!row) return null
  return {
    runs_pg: row.runs_pg,
    over_rate: row.over_rate,
    n_games: row.n_games,
  }
}

// Test with game 634642
const umpFeatures = await loadUmpireFeatures('427053', '2021-04-01')
console.log('Loaded umpire features:', JSON.stringify(umpFeatures))

process.exit(0)
