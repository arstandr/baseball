import 'dotenv/config'
import { createClient } from '@libsql/client'
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })
const now = Date.now()
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })

const hb = await db.execute(`SELECT key, value FROM system_flags WHERE key IN ('scheduler_heartbeat','liveMonitor_heartbeat','gamePulse_heartbeat','trading_halted','last_reconciliation_status')`)
console.log('── Health ──')
for (const r of hb.rows) {
  if (r.key.includes('heartbeat')) {
    const ageS = Math.round((now - Number(r.value)) / 1000)
    const status = ageS < 120 ? '✅' : '⚠️'
    console.log(`  ${status} ${r.key.padEnd(28)} ${ageS}s ago`)
  } else {
    console.log(`  ${r.key.padEnd(28)} = ${r.value}`)
  }
}

const fires = await db.execute({ sql: `SELECT COUNT(*) AS n, ROUND(SUM(capital_at_risk),2) AS risk FROM ks_bets WHERE bet_date = ? AND order_id IS NOT NULL`, args: [today] })
console.log(`\n── Today's fires (${today}) ──`)
console.log(`  ${fires.rows[0].n} fires · $${fires.rows[0].risk ?? 0} risk`)

const sched = await db.execute({ sql: `SELECT status, COUNT(*) AS n FROM bet_schedule WHERE bet_date = ? GROUP BY status`, args: [today] })
console.log(`\n── Schedule status ──`)
for (const r of sched.rows) console.log(`  ${r.status.padEnd(12)} ${r.n}`)

const games = await db.execute({ sql: `SELECT phase, COUNT(*) AS n FROM game_pulse WHERE bet_date = ? GROUP BY phase`, args: [today] })
console.log(`\n── Games by phase ──`)
for (const r of games.rows) console.log(`  ${r.phase.padEnd(14)} ${r.n}`)
