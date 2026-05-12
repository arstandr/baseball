import 'dotenv/config'
import { createClient } from '@libsql/client'
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })

// What's the typical lag between game_date and fetch_date for pitcher_recent_starts?
const lag = await db.execute(`
  SELECT game_date, MIN(fetch_date) AS first_fetch,
         CAST((julianday(MIN(fetch_date)) - julianday(game_date)) AS INTEGER) AS lag_days
  FROM pitcher_recent_starts
  WHERE game_date >= '2026-04-25' AND fetch_date IS NOT NULL
  GROUP BY game_date ORDER BY game_date DESC LIMIT 10
`)
console.log('Game date → fetch lag:')
for (const r of lag.rows) {
  console.log(`  game ${r.game_date} → first ingested ${r.first_fetch} (${r.lag_days} day lag)`)
}

// How many pitchers ingested per recent date?
console.log('\nPitchers ingested per date:')
const counts = await db.execute(`SELECT game_date, COUNT(*) AS n FROM pitcher_recent_starts WHERE game_date >= '2026-04-25' GROUP BY game_date ORDER BY game_date DESC LIMIT 8`)
for (const r of counts.rows) console.log(`  ${r.game_date}: ${r.n} pitchers`)
