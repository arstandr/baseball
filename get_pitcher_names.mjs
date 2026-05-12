import { getClient } from './lib/db.js'
import 'dotenv/config'

const client = getClient()

const pitcher_ids = ["800048", "571927", "669160", "656302", "624133", "687570", "622491", "641743", "686799", "683004", "608331", "681190", "571510", "808967", "663978"]

const results = await client.execute({
  sql: `SELECT DISTINCT pitcher_name FROM ks_bets WHERE pitcher_id IN (${pitcher_ids.map(() => '?').join(',')})`,
  args: pitcher_ids
})

console.log('Pitcher names for IDs:')
console.log(JSON.stringify(results.rows, null, 2))

// Also check pitcher_signals table
const sigs = await client.execute({
  sql: `SELECT DISTINCT pitcher_name FROM pitcher_signals WHERE pitcher_id IN (${pitcher_ids.map(() => '?').join(',')})`,
  args: pitcher_ids
})

console.log('\nFrom pitcher_signals:')
console.log(JSON.stringify(sigs.rows, null, 2))

client.close()
