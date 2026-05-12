import 'dotenv/config'
import { createClient } from '@libsql/client'
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })

// kalshi_ks_markets has pitcher_name AND actual_ks. Just need to figure out which dates.
const distinctDates = await db.execute(`SELECT DISTINCT game_date, COUNT(*) AS n FROM kalshi_ks_markets WHERE actual_ks IS NOT NULL GROUP BY game_date ORDER BY game_date DESC LIMIT 10`)
console.log('Recent settled game_dates in kalshi_ks_markets:')
for (const r of distinctDates.rows) console.log(`  ${r.game_date}: ${r.n} markets`)

// Now: cross-strike POC pitchers + their actual Ks for May 5
console.log('\n── POC pitcher → actual_ks lookup (using kalshi_ks_markets) ──')
const poc = await db.execute(`SELECT DISTINCT pitcher_name FROM crossstrike_poc_predictions WHERE bet_date='2026-05-05'`)
for (const p of poc.rows) {
  const ks = await db.execute(`SELECT MAX(actual_ks) AS k, COUNT(*) AS n FROM kalshi_ks_markets WHERE pitcher_name = '${p.pitcher_name.replace(/'/g, "''")}' AND game_date >= '2026-05-05' AND actual_ks IS NOT NULL`)
  const k = ks.rows[0].k
  console.log(`  ${p.pitcher_name.padEnd(24)} → actual_ks=${k ?? 'NOT SETTLED'} (${ks.rows[0].n} markets)`)
}
