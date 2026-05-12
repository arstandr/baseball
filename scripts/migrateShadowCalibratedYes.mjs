// Create shadow_calibrated_yes table for the calibrated-YES shadow audit.
// Idempotent.
//
// Run:
//   node scripts/migrateShadowCalibratedYes.mjs

import 'dotenv/config'
import { createClient } from '@libsql/client'
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })

await db.execute(`
  CREATE TABLE IF NOT EXISTS shadow_calibrated_yes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bet_date TEXT NOT NULL,
    pitcher_id TEXT,
    pitcher_name TEXT NOT NULL,
    strike INTEGER NOT NULL,
    edge_threshold REAL NOT NULL,
    ticker TEXT,
    raw_model_prob REAL,
    calibrated_yes_prob REAL,
    yes_mid REAL,
    spread REAL,
    yes_ask REAL,
    fee_adjusted_yes_breakeven REAL,
    raw_edge REAL,
    calibrated_edge REAL,
    fee_adjusted_calibrated_edge REAL,
    would_fire INTEGER NOT NULL,
    would_fire_reason TEXT,
    would_skip_reason TEXT,
    proposed_kelly_size REAL,
    actual_ks INTEGER,
    result TEXT,
    shadow_pnl REAL,
    created_at TEXT NOT NULL,
    settled_at TEXT,
    UNIQUE (bet_date, pitcher_name, strike, edge_threshold)
  )
`)
await db.execute(`CREATE INDEX IF NOT EXISTS idx_shadow_calibrated_yes_date ON shadow_calibrated_yes(bet_date)`)
await db.execute(`CREATE INDEX IF NOT EXISTS idx_shadow_calibrated_yes_settle ON shadow_calibrated_yes(bet_date, result)`)

const cols = await db.execute(`PRAGMA table_info(shadow_calibrated_yes)`)
console.log(`✓ shadow_calibrated_yes table ready (${cols.rows.length} columns)`)
