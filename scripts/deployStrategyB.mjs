import 'dotenv/config'
import { createClient } from '@libsql/client'
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })

const rules = [
  ['cross_strike_enabled',           1,    1,    'Cross-strike strategy enabled', 'Strategy B (cross-strike arb) gate. 1=enabled, 0=disabled.'],
  ['cross_strike_min_residual',      0.04, 0.04, 'Cross-strike min residual',     'Min |market - fit| to flag a strike as mispriced. Default 4¢.'],
  ['cross_strike_max_residual',      0.20, 0.20, 'Cross-strike max residual',     'Max residual — outlier filter. Likely data quality issues above this.'],
  ['cross_strike_max_per_pitcher',   2,    2,    'Cross-strike max per pitcher',  'Max candidates per pitcher per slate (concentration cap).'],
  ['cross_strike_max_pct_bankroll',  0.03, 0.03, 'Cross-strike max % bankroll',   'Per-bet bankroll cap for cross-strike (3% vs 4% for raw YES).'],
  ['cross_strike_tail_dollar_cap',   5,    5,    'Cross-strike tail $ cap',       'Hard $ cap for tail bets (ask < threshold). Variance protection.'],
  ['cross_strike_tail_ask_threshold', 25,  25,   'Cross-strike tail ask threshold (¢)', 'Below this ask, apply tail dollar cap.'],
]
for (const [key, value, def, label, desc] of rules) {
  await db.execute({
    sql: `INSERT INTO betting_rules (key, value, default_val, label, description, updated_at, updated_by)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET value=excluded.value, label=excluded.label, description=excluded.description, updated_at=excluded.updated_at`,
    args: [key, value, def, label, desc, new Date().toISOString(), 'strategy-b-deploy'],
  })
}
const r = await db.execute(`SELECT key, value, label FROM betting_rules WHERE key LIKE 'cross_strike%' ORDER BY key`)
console.log('Strategy B rules deployed:')
for (const row of r.rows) console.log(`  ${row.key.padEnd(36)} = ${String(row.value).padEnd(6)}  ${row.label}`)
