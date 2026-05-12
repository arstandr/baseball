import 'dotenv/config'
import { createClient } from '@libsql/client'
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })

// What tables have actual_ks data?
const tables = await db.execute(`SELECT name FROM sqlite_master WHERE type='table'`)
console.log('Tables that might have actual_ks:')
for (const t of tables.rows) {
  try {
    const cols = await db.execute(`PRAGMA table_info(${t.name})`)
    const colNames = cols.rows.map(c => c.name)
    if (colNames.includes('actual_ks') || colNames.some(c => c.toLowerCase().includes('strikeout') || c === 'k_count')) {
      console.log(`  ${t.name}: [${colNames.filter(c => c.includes('k') || c.includes('K')).join(', ')}]`)
    }
  } catch {}
}
console.log('\n── Check pitcher_recent_starts for May 5 ──')
const rs = await db.execute({sql: `SELECT pitcher_name, game_date, ks FROM pitcher_recent_starts WHERE game_date = '2026-05-05' LIMIT 30`, args: []}).catch(e => ({rows: [], error: e.message}))
if (rs.rows?.length > 0) {
  for (const r of rs.rows) console.log(`  ${r.pitcher_name?.padEnd(24)} K=${r.ks}`)
} else {
  console.log(`  (no rows or error: ${rs.error})`)
}

// Check if there's a games/boxscore table
console.log('\n── Game-level data on May 5 ──')
const games = await db.execute({
  sql: `SELECT pitcher_home_id, pitcher_away_id, status, * FROM games WHERE date='2026-05-05' LIMIT 3`,
}).catch(e => ({rows: [], error: e.message}))
if (games.rows?.length > 0) {
  console.log('  games table cols:', Object.keys(games.rows[0]).join(', '))
}

// Are pitcher boxscores stored anywhere?
const candidateTables = ['mlb_pitcher_lines', 'pitcher_box', 'game_pitcher_stats', 'box_scores']
for (const t of candidateTables) {
  const e = await db.execute({sql:`SELECT COUNT(*) AS n FROM ${t}`}).catch(() => null)
  if (e) console.log(`  ${t}: exists (${e.rows[0].n} rows)`)
}
