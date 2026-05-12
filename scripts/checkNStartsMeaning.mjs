import 'dotenv/config'
import { createClient } from '@libsql/client'
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })

// Get range and examples of n_starts to understand what it represents
const r = await db.execute(`
  SELECT pitcher_name, n_starts, k9_career, k9_season, k9_l5, COUNT(*) AS n
  FROM ks_bets
  WHERE bet_date >= date('now','-30 days') AND live_bet=0
  GROUP BY pitcher_name
  ORDER BY n_starts DESC, pitcher_name
  LIMIT 20
`)
console.log('Sample (top 20 highest n_starts):')
console.log('pitcher                  n_starts  k9_career  k9_season  k9_l5')
for (const row of r.rows) {
  console.log(`  ${(row.pitcher_name || '').padEnd(24)} ${String(row.n_starts).padEnd(8)} ${String(Number(row.k9_career ?? 0).toFixed(1)).padEnd(9)} ${String(Number(row.k9_season ?? 0).toFixed(1)).padEnd(9)} ${Number(row.k9_l5 ?? 0).toFixed(1)}`)
}

const min = await db.execute(`SELECT pitcher_name, n_starts FROM ks_bets WHERE n_starts IS NOT NULL ORDER BY n_starts ASC LIMIT 5`)
console.log('\nLowest n_starts:')
for (const row of min.rows) console.log(`  ${row.pitcher_name}: ${row.n_starts}`)

const dist = await db.execute(`SELECT MIN(n_starts) AS min, MAX(n_starts) AS max, AVG(n_starts) AS avg, COUNT(*) AS n FROM ks_bets WHERE n_starts IS NOT NULL`)
console.log(`\nDistribution: min=${dist.rows[0].min}, max=${dist.rows[0].max}, avg=${Number(dist.rows[0].avg).toFixed(1)}, n=${dist.rows[0].n}`)
