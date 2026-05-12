// Create shadow_calibrate_kelly table — for each actual YES fire, record what
// the Kelly size WOULD have been if Kelly had been fed calibrated_yes_prob
// instead of raw model_prob. At settle, compute the alt-PnL using the same
// outcome (actual_ks) at the new size. Lets us answer: "would calibrate-Kelly
// sizing have beaten raw-Kelly sizing yesterday?"
//
// Run:
//   node scripts/migrateShadowCalibrateKelly.mjs

import 'dotenv/config'
import { createClient } from '@libsql/client'
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })

await db.execute(`
  CREATE TABLE IF NOT EXISTS shadow_calibrate_kelly (
    ks_bet_id INTEGER PRIMARY KEY,
    bet_date TEXT NOT NULL,
    user_id INTEGER,
    pitcher_name TEXT NOT NULL,
    strike INTEGER NOT NULL,
    side TEXT NOT NULL,
    bankroll_used REAL,
    raw_model_prob REAL,
    calibrated_yes_prob REAL,
    yes_ask REAL,
    raw_kelly_fraction REAL,
    raw_size REAL,
    calibrated_kelly_fraction REAL,
    calibrated_size REAL,
    actual_ks INTEGER,
    result TEXT,
    raw_pnl REAL,
    calibrated_pnl REAL,
    created_at TEXT NOT NULL,
    settled_at TEXT
  )
`)
await db.execute(`CREATE INDEX IF NOT EXISTS idx_shadow_calibrate_kelly_date ON shadow_calibrate_kelly(bet_date)`)
await db.execute(`CREATE INDEX IF NOT EXISTS idx_shadow_calibrate_kelly_settle ON shadow_calibrate_kelly(bet_date, result)`)

const cols = await db.execute(`PRAGMA table_info(shadow_calibrate_kelly)`)
console.log(`✓ shadow_calibrate_kelly table ready (${cols.rows.length} columns)`)
