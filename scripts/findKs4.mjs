import 'dotenv/config'
import { createClient } from '@libsql/client'
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })

// Check pitcher_recent_starts
const prs = await db.execute(`PRAGMA table_info(pitcher_recent_starts)`)
console.log('pitcher_recent_starts cols:', prs.rows.map(r=>r.name).join(', '))

const sample = await db.execute(`SELECT * FROM pitcher_recent_starts ORDER BY ROWID DESC LIMIT 2`)
if (sample.rows[0]) {
  console.log('Sample:')
  for (const k of Object.keys(sample.rows[0])) console.log(`  ${k}: ${sample.rows[0][k]}`)
}

// Pull May 5 starts
const may5 = await db.execute(`SELECT * FROM pitcher_recent_starts WHERE game_date='2026-05-05' LIMIT 30`).catch(e => ({rows:[], error:e.message}))
console.log(`\n2026-05-05 starts in pitcher_recent_starts: ${may5.rows?.length ?? 0}`)
if (may5.error) console.log('Error:', may5.error)

// Check historical_pitcher_stats
const hps = await db.execute(`PRAGMA table_info(historical_pitcher_stats)`)
console.log('\nhistorical_pitcher_stats cols:', hps.rows.map(r=>r.name).join(', '))

const may5h = await db.execute(`SELECT * FROM historical_pitcher_stats WHERE game_date='2026-05-05' LIMIT 5`).catch(e => ({rows:[], error:e.message}))
console.log(`2026-05-05 starts in historical_pitcher_stats: ${may5h.rows?.length ?? 0}`)
if (may5h.rows?.[0]) {
  for (const k of Object.keys(may5h.rows[0])) console.log(`  ${k}: ${may5h.rows[0][k]}`)
}
