import 'dotenv/config'
import { createClient } from '@libsql/client'
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
const cols = await db.execute(`PRAGMA table_info(game_pulse)`)
const allCols = cols.rows.map(r => r.name)
console.log('Game_pulse cols (filtered):', allCols.filter(c => /dk_|line|home_team|away_team|phase|game_time/i.test(c)).join(', '))
const r = await db.execute({
  sql: `SELECT game_pk, away_team, home_team, game_time_et, phase,
               dk_home_line_t180, dk_away_line_t180,
               dk_home_line_t90, dk_away_line_t90
        FROM game_pulse
        WHERE bet_date = ?
        ORDER BY game_time_et`,
  args: [today],
})
console.log(`\nGames today (${r.rows.length}):`)
for (const g of r.rows) {
  const t180 = (g.dk_home_line_t180 == null && g.dk_away_line_t180 == null) ? 'MISS' : `${g.dk_away_line_t180 ?? '·'}/${g.dk_home_line_t180 ?? '·'}`
  const t90  = (g.dk_home_line_t90  == null && g.dk_away_line_t90  == null) ? 'MISS' : `${g.dk_away_line_t90  ?? '·'}/${g.dk_home_line_t90  ?? '·'}`
  console.log(`  ${g.away_team}@${g.home_team}  ${g.game_time_et}  phase=${g.phase}  T180=${t180}  T90=${t90}`)
}
