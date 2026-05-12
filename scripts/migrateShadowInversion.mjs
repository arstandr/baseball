// Create shadow_inversion table for the shadow-audit system. Idempotent.
//
// Run:
//   node scripts/migrateShadowInversion.mjs

import 'dotenv/config'
import { createClient } from '@libsql/client'
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })

await db.execute(`
  CREATE TABLE IF NOT EXISTS shadow_inversion (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bet_date TEXT NOT NULL,
    pitcher_id TEXT,
    pitcher_name TEXT NOT NULL,
    strike INTEGER NOT NULL,
    threshold REAL NOT NULL,
    original_side TEXT DEFAULT 'YES',
    ticker TEXT,
    l5_k9 REAL,
    career_k9 REAL,
    l5_gap REAL,
    model_prob REAL,
    calibrated_yes_prob REAL,
    yes_mid REAL,
    spread REAL,
    no_ask_reconstructed REAL,
    fee_adjusted_no_breakeven REAL,
    proposed_no_edge REAL,
    proposed_kelly_size REAL,
    would_fire INTEGER NOT NULL,
    would_fire_reason TEXT,
    would_skip_reason TEXT,
    actual_ks INTEGER,
    result TEXT,
    shadow_pnl REAL,
    created_at TEXT NOT NULL,
    settled_at TEXT,
    UNIQUE (bet_date, pitcher_name, strike, threshold)
  )
`)
await db.execute(`CREATE INDEX IF NOT EXISTS idx_shadow_inversion_date ON shadow_inversion(bet_date)`)
await db.execute(`CREATE INDEX IF NOT EXISTS idx_shadow_inversion_settle ON shadow_inversion(bet_date, result)`)

const cols = await db.execute(`PRAGMA table_info(shadow_inversion)`)
console.log(`✓ shadow_inversion table ready (${cols.rows.length} columns)`)
