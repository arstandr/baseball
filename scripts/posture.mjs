import 'dotenv/config'
import { createClient } from '@libsql/client'
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })

const flagKeys = [
  'trading_halted','drawdown_halted','kalshi_paper_mode','live_trading',
  'oracle_stage','invert_yes_to_no',
  'tier1_enabled','tier2_enabled','tier3_enabled',
  'scheduler_heartbeat','liveMonitor_heartbeat',
  'last_reconciliation_pass_at','last_reconciliation_status','kalshi_outage','settling_in_progress',
  'invert_daily_cap_usd','max_invert_per_pitcher_usd',
  'live_daily_cap_usd','max_live_per_pitcher_usd','global_daily_cap_usd',
  'discord_errors_only',
]
const rows = await db.execute({
  sql: `SELECT key, value, updated_at FROM system_flags WHERE key IN (${flagKeys.map(()=>'?').join(',')})`,
  args: flagKeys
})
const map = Object.fromEntries(rows.rows.map(r => [r.key, { value: r.value, updated_at: r.updated_at }]))
const now = Date.now()
const ageS = ms => ms ? Math.round((now - Number(ms))/1000) : null

console.log('\n── POSTURE ─────────────────────────────────')
console.log(`oracle_stage          ${map.oracle_stage?.value ?? '(unset)'}`)
console.log(`invert_yes_to_no      ${map.invert_yes_to_no?.value ?? '(unset)'}`)
console.log(`tier1_enabled         ${map.tier1_enabled?.value ?? '(unset)'}`)
console.log(`tier2_enabled         ${map.tier2_enabled?.value ?? '(unset)'}`)
console.log(`tier3_enabled         ${map.tier3_enabled?.value ?? '(unset)'}`)
console.log(`kalshi_paper_mode     ${map.kalshi_paper_mode?.value ?? '(unset)'}`)
console.log(`live_trading          ${map.live_trading?.value ?? '(unset)'}`)
console.log(`discord_errors_only   ${map.discord_errors_only?.value ?? '(unset)'}`)

console.log('\n── HALTS ────────────────────────────────────')
console.log(`trading_halted        ${map.trading_halted?.value ?? '0'}`)
console.log(`drawdown_halted       ${map.drawdown_halted?.value ?? '(none)'}`)
console.log(`kalshi_outage         ${map.kalshi_outage?.value ?? '0'}`)
console.log(`settling_in_progress  ${map.settling_in_progress?.value ?? '0'}`)

console.log('\n── HEARTBEATS ───────────────────────────────')
console.log(`scheduler_heartbeat   ${ageS(map.scheduler_heartbeat?.value)}s ago`)
console.log(`liveMonitor_heartbeat ${ageS(map.liveMonitor_heartbeat?.value)}s ago`)

console.log('\n── RECONCILIATION ───────────────────────────')
console.log(`last_reconciliation_pass_at ${map.last_reconciliation_pass_at?.value ?? '(never)'}`)
console.log(`last_reconciliation_status  ${map.last_reconciliation_status?.value ?? '(none)'}`)

console.log('\n── CAPS ─────────────────────────────────────')
console.log(`invert_daily_cap_usd          ${map.invert_daily_cap_usd?.value ?? '(unset)'}`)
console.log(`max_invert_per_pitcher_usd    ${map.max_invert_per_pitcher_usd?.value ?? '(unset)'}`)
console.log(`live_daily_cap_usd            ${map.live_daily_cap_usd?.value ?? '(unset)'}`)
console.log(`max_live_per_pitcher_usd      ${map.max_live_per_pitcher_usd?.value ?? '(unset)'}`)
console.log(`global_daily_cap_usd          ${map.global_daily_cap_usd?.value ?? '(unset)'}`)
console.log()
