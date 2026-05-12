import 'dotenv/config'
import { createClient } from '@libsql/client'
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })

// Phase 1a: Update existing rule values
const updates = [
  ['yes_max_strike', 6, 'YES max strike (data-driven 5/4: K7+ losing -47% ROI)'],
  ['no_max_strike',  9, 'NO max strike (open K7-K9 — empirical edge in shadow + small historical samples)'],
]
for (const [key, value, notes] of updates) {
  await db.execute({
    sql: `UPDATE betting_rules SET value=?, updated_at=?, updated_by=?, description=COALESCE(description,'')||' [' || ? || ']' WHERE key=?`,
    args: [value, new Date().toISOString(), 'rules-1to6-deploy', notes, key],
  })
}

// Phase 1b: Add new rules
const newRules = [
  ['yes_block_k5',                1, 0, 'YES block K5',           'Block YES bets at strike=5 (data-driven 5/4: -27% ROI on 78 bets)'],
  ['cold_yes_block',              1, 0, 'Cold YES block',         'Block YES when k9_l5 < k9_career (cold pitchers -42% ROI)'],
  ['max_pct_bankroll_per_bet', 0.04, 0, 'Max % bankroll per bet', 'Cap per-bet capital_at_risk at this % of bankroll (D9-D10 lose money)'],
  ['high_conf_threshold',      0.65, 0, 'High confidence threshold', 'Above this model_prob, apply size haircut'],
  ['high_conf_size_haircut',    0.5, 1, 'High confidence size haircut', 'Multiply Kelly size by this when model_prob ≥ high_conf_threshold (calibration says ≥0.65 bucket has 27pp gap)'],
]
for (const [key, value, def, label, desc] of newRules) {
  await db.execute({
    sql: `INSERT INTO betting_rules (key, value, default_val, label, description, updated_at, updated_by)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET value=excluded.value, label=excluded.label, description=excluded.description, updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
    args: [key, value, def, label, desc, new Date().toISOString(), 'rules-1to6-deploy'],
  })
}

// Phase 1c: Create pitcher_blocklist table
await db.execute(`
  CREATE TABLE IF NOT EXISTS pitcher_blocklist (
    pitcher_name TEXT PRIMARY KEY,
    reason TEXT,
    added_at TEXT,
    added_by TEXT
  )
`)
const blocklist = [
  ['José Soriano',         '0-12 over 30 days, $-508 P&L, claim 58%'],
  ['Cristopher Sánchez',   '0-10 over 30 days, $-429 P&L, claim 57%'],
  ['J.T. Ginn',            '0-4 over 30 days, $-374 P&L, claim 59%'],
  ['Anthony Kay',          '0-6 over 30 days, $-184 P&L, claim 65%'],
  ['Matthew Boyd',         '0-8 over 30 days, $-210 P&L, claim 57%'],
]
for (const [name, reason] of blocklist) {
  await db.execute({
    sql: `INSERT INTO pitcher_blocklist (pitcher_name, reason, added_at, added_by)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(pitcher_name) DO UPDATE SET reason=excluded.reason, added_at=excluded.added_at`,
    args: [name, reason, new Date().toISOString(), 'rules-1to6-deploy'],
  })
}

// Verify
console.log('── Updated rules ──')
const r = await db.execute(`SELECT key, value, label FROM betting_rules WHERE key IN ('yes_max_strike','no_max_strike','yes_block_k5','cold_yes_block','max_pct_bankroll_per_bet','high_conf_threshold','high_conf_size_haircut','min_bet_floor','no_max_market_mid') ORDER BY key`)
for (const row of r.rows) console.log(`  ${row.key.padEnd(30)} = ${String(row.value).padEnd(6)}  (${row.label})`)
console.log('\n── Pitcher blocklist ──')
const b = await db.execute(`SELECT pitcher_name, reason FROM pitcher_blocklist ORDER BY pitcher_name`)
for (const row of b.rows) console.log(`  ${row.pitcher_name.padEnd(24)} ${row.reason}`)
