// scripts/migrations/rebuildKsBetsConstraint.js
// One-time migration: add user_id to ks_bets UNIQUE constraint.
// Run once: node scripts/migrations/rebuildKsBetsConstraint.js

import 'dotenv/config'
import * as db from '../../lib/db.js'

await db.migrate()

const client = db.getClient()

console.log('[migrate] Rebuilding ks_bets with user_id in UNIQUE constraint…')

// Check if already migrated (new constraint in place)
const existing = await db.one("SELECT sql FROM sqlite_master WHERE type='table' AND name='ks_bets'")
if (existing?.sql?.includes('user_id') && existing.sql.match(/UNIQUE\([^)]*user_id/)) {
  console.log('[migrate] Already migrated — unique constraint already includes user_id. Done.')
  await db.close()
  process.exit(0)
}

// Run statements individually (batch API requires different args format)
await db.run(`CREATE TABLE IF NOT EXISTS ks_bets_v2 (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    bet_date        TEXT NOT NULL,
    logged_at       TEXT NOT NULL,
    pitcher_id      TEXT,
    pitcher_name    TEXT NOT NULL,
    team            TEXT,
    game            TEXT,
    strike          INTEGER NOT NULL,
    side            TEXT NOT NULL,
    model_prob      REAL NOT NULL,
    market_mid      REAL,
    edge            REAL NOT NULL,
    lambda          REAL,
    k9_career       REAL,
    k9_season       REAL,
    k9_l5           REAL,
    opp_k_pct       REAL,
    adj_factor      REAL,
    n_starts        INTEGER,
    confidence      TEXT,
    savant_k_pct    REAL,
    savant_whiff    REAL,
    savant_fbv      REAL,
    whiff_flag      TEXT,
    ticker          TEXT,
    bet_size        REAL DEFAULT 100,
    kelly_fraction  REAL,
    capital_at_risk REAL,
    paper           INTEGER DEFAULT 1,
    live_bet        INTEGER DEFAULT 0,
    actual_ks       INTEGER,
    result          TEXT,
    settled_at      TEXT,
    pnl             REAL,
    park_factor     REAL,
    weather_mult    REAL,
    ump_factor      REAL,
    ump_name        TEXT,
    velo_adj        REAL,
    velo_trend_mph  REAL,
    bb_penalty      REAL,
    raw_adj_factor  REAL,
    spread          REAL,
    raw_model_prob  REAL,
    order_id        TEXT,
    fill_price      REAL,
    filled_at       TEXT,
    filled_contracts INTEGER,
    order_status    TEXT,
    user_id         INTEGER REFERENCES users(id),
    model           TEXT DEFAULT 'mlb_strikeouts',
    open_interest   INTEGER,
    UNIQUE(bet_date, pitcher_name, strike, side, live_bet, user_id)
  )`)

await db.run(`INSERT OR IGNORE INTO ks_bets_v2
    SELECT id, bet_date, logged_at, pitcher_id, pitcher_name, team, game,
           strike, side, model_prob, market_mid, edge, lambda,
           k9_career, k9_season, k9_l5, opp_k_pct, adj_factor, n_starts, confidence,
           savant_k_pct, savant_whiff, savant_fbv, whiff_flag, ticker,
           bet_size, kelly_fraction, capital_at_risk, paper, live_bet,
           actual_ks, result, settled_at, pnl, park_factor, weather_mult,
           ump_factor, ump_name, velo_adj, velo_trend_mph, bb_penalty,
           raw_adj_factor, spread, raw_model_prob, order_id, fill_price,
           filled_at, filled_contracts, order_status, user_id, model, open_interest
    FROM ks_bets`)

await db.run(`DROP TABLE ks_bets`)
await db.run(`ALTER TABLE ks_bets_v2 RENAME TO ks_bets`)

// Recreate indexes
await db.run(`CREATE INDEX IF NOT EXISTS idx_ks_bets_date      ON ks_bets(bet_date)`)
await db.run(`CREATE INDEX IF NOT EXISTS idx_ks_bets_pitcher   ON ks_bets(pitcher_id)`)
await db.run(`CREATE INDEX IF NOT EXISTS idx_ks_bets_result    ON ks_bets(result)`)
await db.run(`CREATE INDEX IF NOT EXISTS idx_ks_bets_user      ON ks_bets(user_id)`)
await db.run(`CREATE INDEX IF NOT EXISTS idx_ks_bets_model     ON ks_bets(model)`)
await db.run(`CREATE INDEX IF NOT EXISTS idx_ks_bets_composite ON ks_bets(bet_date, live_bet, paper, user_id)`)

const count = await db.one('SELECT COUNT(*) as n FROM ks_bets')
console.log(`[migrate] Done — ${count.n} rows preserved, indexes rebuilt.`)

await db.close()
