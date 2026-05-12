import 'dotenv/config'
import { createClient } from '@libsql/client'
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })

const nowUTC = new Date()
const nowET = new Date(nowUTC.toLocaleString('en-US', { timeZone: 'America/New_York' }))
console.log(`Current time: ${nowUTC.toISOString()} UTC = ${nowET.toLocaleTimeString()} ET\n`)

// Today's games and how close to first pitch
const games = await db.execute(`
  SELECT game_pk, away_team, home_team, game_time_et, phase,
         home_lineup_posted, away_lineup_posted
  FROM game_pulse
  WHERE bet_date = '2026-05-04'
  ORDER BY game_time_et
`)
console.log(`Today's games + state:`)
for (const g of games.rows) {
  const [h, m] = String(g.game_time_et).split(':').map(Number)
  // game_time_et is the slated start time
  const gameET = new Date(nowET)
  gameET.setHours(h, m, 0, 0)
  const minToGame = Math.round((gameET - nowET) / 60000)
  const lineup = (g.home_lineup_posted || g.away_lineup_posted) ? '✓' : '✗'
  console.log(`  ${g.away_team}@${g.home_team}  fp=${g.game_time_et}ET  T-${minToGame}min  phase=${g.phase}  lineup=${lineup}`)
}

// Today's bet_schedule status
console.log(`\nbet_schedule status (today):`)
const sched = await db.execute(`
  SELECT pitcher_name, game_label, game_time, status, fired_at, allocated_usd, preflight_outcome
  FROM bet_schedule WHERE bet_date = '2026-05-04' ORDER BY game_time LIMIT 25
`)
for (const s of sched.rows) {
  const time = s.game_time ? s.game_time.slice(11, 16) + ' UTC' : '?'
  console.log(`  ${s.pitcher_name.padEnd(22)} ${(s.game_label ?? '').padEnd(10)}  fp=${time}  status=${s.status}  fired=${s.fired_at ?? '-'}  preflight=${s.preflight_outcome ?? '-'}`)
}

// Heartbeat health
console.log(`\nHeartbeats (operational health):`)
const hb = await db.execute(`SELECT key, value FROM system_flags WHERE key LIKE '%heartbeat%' OR key='trading_halted'`)
const now = Date.now()
for (const row of hb.rows) {
  if (row.key === 'trading_halted') {
    console.log(`  trading_halted = ${row.value}`)
  } else {
    const ageS = Math.round((now - Number(row.value)) / 1000)
    console.log(`  ${row.key.padEnd(28)} ${ageS}s ago`)
  }
}

// Pipeline log to see most recent activity
const pipeRows = await db.execute(`SELECT step, ts FROM pipeline_log WHERE bet_date = '2026-05-04' ORDER BY ts DESC LIMIT 10`).catch(() => ({rows:[]}))
if (pipeRows.rows.length) {
  console.log(`\nMost recent pipeline events:`)
  for (const r of pipeRows.rows) console.log(`  ${r.ts}  ${r.step}`)
}
