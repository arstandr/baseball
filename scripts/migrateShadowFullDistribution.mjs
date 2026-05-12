// Create shadow_full_distribution table — for every pitcher × strike × side
// the model can score, write a shadow row regardless of whether production
// filters allow betting. Lets us audit: "of the bets the system didn't fire
// because of filters, how many had positive calibrated edge?"
//
// Run:
//   node scripts/migrateShadowFullDistribution.mjs

import 'dotenv/config'
import { createClient } from '@libsql/client'
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })

await db.execute(`
  CREATE TABLE IF NOT EXISTS shadow_full_distribution (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bet_date TEXT NOT NULL,
    pitcher_id TEXT,
    pitcher_name TEXT NOT NULL,
    strike INTEGER NOT NULL,
    side TEXT NOT NULL,
    ticker TEXT,
    lambda REAL,
    pitcher_nb_r REAL,
    raw_model_prob REAL,
    calibrated_yes_prob REAL,
    yes_bid REAL,
    yes_ask REAL,
    no_bid REAL,
    no_ask REAL,
    market_mid REAL,
    spread REAL,
    raw_edge REAL,
    calibrated_edge REAL,
    production_allowed INTEGER,
    production_filter_reason TEXT,
    proposed_kelly_size REAL,
    actual_ks INTEGER,
    result TEXT,
    shadow_pnl REAL,
    created_at TEXT NOT NULL,
    settled_at TEXT,
    UNIQUE (bet_date, pitcher_name, strike, side)
  )
`)
await db.execute(`CREATE INDEX IF NOT EXISTS idx_shadow_fd_date ON shadow_full_distribution(bet_date)`)
await db.execute(`CREATE INDEX IF NOT EXISTS idx_shadow_fd_settle ON shadow_full_distribution(bet_date, result)`)

const cols = await db.execute(`PRAGMA table_info(shadow_full_distribution)`)
console.log(`✓ shadow_full_distribution table ready (${cols.rows.length} columns)`)
