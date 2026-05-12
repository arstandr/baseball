import 'dotenv/config'
import { createClient } from '@libsql/client'
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })

console.log('═══════════════════════════════════════════════════════════════════')
console.log('  FULL ENGINE VERIFICATION')
console.log('═══════════════════════════════════════════════════════════════════\n')

console.log('── A. betting_rules (DB) — what the engine reads ──')
const r = await db.execute(`SELECT key, value, label FROM betting_rules ORDER BY key`)
for (const row of r.rows) {
  console.log(`  ${row.key.padEnd(32)} = ${String(row.value).padEnd(8)}  ${row.label ?? ''}`)
}

console.log('\n── B. pitcher_blocklist (DB) ──')
const b = await db.execute(`SELECT pitcher_name, reason FROM pitcher_blocklist`)
for (const row of b.rows) console.log(`  ${row.pitcher_name.padEnd(24)} ${row.reason}`)

console.log('\n── C. system_flags (operational) ──')
const f = await db.execute(`SELECT key, value FROM system_flags WHERE key IN ('trading_halted','drawdown_halted','kalshi_outage','last_reconciliation_status')`)
for (const row of f.rows) console.log(`  ${row.key.padEnd(28)} = ${row.value}`)

console.log('\n── D. Heartbeats (operational health) ──')
const now = Date.now()
const hb = await db.execute(`SELECT key, value FROM system_flags WHERE key LIKE '%heartbeat%'`)
for (const row of hb.rows) {
  const ageS = Math.round((now - Number(row.value)) / 1000)
  console.log(`  ${row.key.padEnd(28)} ${ageS}s ago`)
}

console.log('\n── E. Today\'s ks_bets activity (May 4) ──')
const k = await db.execute(`SELECT COUNT(*) AS n, SUM(CASE WHEN paper=1 THEN 1 ELSE 0 END) AS paper, SUM(CASE WHEN paper=0 THEN 1 ELSE 0 END) AS live FROM ks_bets WHERE bet_date='2026-05-04'`)
console.log(`  Total fires: ${k.rows[0].n} (paper=${k.rows[0].paper}, live=${k.rows[0].live})`)

console.log('\n── F. Today\'s shadow data ──')
const s1 = await db.execute(`SELECT COUNT(*) AS n FROM shadow_full_distribution WHERE bet_date='2026-05-04'`)
const s2 = await db.execute(`SELECT COUNT(*) AS n FROM shadow_inversion WHERE bet_date='2026-05-04'`)
const s3 = await db.execute(`SELECT COUNT(*) AS n FROM shadow_calibrated_yes WHERE bet_date='2026-05-04'`)
const s4 = await db.execute(`SELECT COUNT(*) AS n FROM shadow_calibrate_kelly WHERE bet_date='2026-05-04'`)
console.log(`  shadow_full_distribution: ${s1.rows[0].n}`)
console.log(`  shadow_inversion:         ${s2.rows[0].n}`)
console.log(`  shadow_calibrated_yes:    ${s3.rows[0].n}`)
console.log(`  shadow_calibrate_kelly:   ${s4.rows[0].n}`)
