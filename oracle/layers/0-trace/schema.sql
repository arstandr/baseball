-- ═══════════════════════════════════════════════════════════════════
-- The Oracle — Layer 0: Trace / Audit Ledger
-- Schema v1.0 (locked 2026-04-30)
--
-- Four tables, no partitioning, indexes from day one.
-- Append-only. Schema changes are additive (never remove/rename columns).
-- ═══════════════════════════════════════════════════════════════════

-- ── Main events table ────────────────────────────────────────────────
-- One row per layer emission. Sparse columns for non-decision events
-- (heartbeat, health_check) where bet identity isn't applicable.
CREATE TABLE IF NOT EXISTS oracle_trace_events (
  id                    TEXT PRIMARY KEY,
  decision_id           TEXT NOT NULL,
  parent_event_id       TEXT,
  trace_schema_version  TEXT NOT NULL,
  created_at            TEXT NOT NULL,

  layer_name            TEXT NOT NULL,
  layer_version         TEXT NOT NULL,
  commit_hash           TEXT NOT NULL,
  agent_id              TEXT NOT NULL,
  agent_version         TEXT NOT NULL,
  server_version        TEXT,
  environment           TEXT NOT NULL DEFAULT 'production',
  run_id                TEXT,
  request_id            TEXT,

  mode                  TEXT NOT NULL,    -- 'production' | 'shadow'
  system                TEXT NOT NULL,    -- 'oracle' | 'current' | 'old'
  event_type            TEXT NOT NULL,    -- 'decision' | 'health_check' | 'heartbeat' | 'config_change' | 'error'
  user_id               INTEGER,
  bet_id                TEXT,

  game_pk               TEXT,
  pitcher_id            TEXT,
  pitcher_name          TEXT,
  market_ticker         TEXT,
  bet_date              TEXT,
  strike                INTEGER,
  side                  TEXT,             -- 'YES' | 'NO'

  decision              TEXT NOT NULL,
  reason_code           TEXT NOT NULL,
  reasoning             TEXT NOT NULL,    -- JSON
  metrics               TEXT NOT NULL,    -- JSON

  evidence_used         TEXT NOT NULL,    -- JSON array of {name, id, input_hash}
  input_hash            TEXT NOT NULL,
  output_hash           TEXT NOT NULL,

  status                TEXT NOT NULL,    -- 'success' | 'error' | 'timeout' | 'skipped' | 'fail_closed'
  severity              TEXT NOT NULL,    -- 'info' | 'warn' | 'error' | 'critical'
  latency_ms            INTEGER NOT NULL,
  error_message         TEXT,
  tokens_used           INTEGER,
  cost_usd              REAL,

  would_have_action     TEXT,
  actual_action         TEXT,
  market_snapshot_id    TEXT,
  state_snapshot_id     TEXT
);

CREATE INDEX IF NOT EXISTS idx_ote_decision_id   ON oracle_trace_events(decision_id);
CREATE INDEX IF NOT EXISTS idx_ote_bet_id        ON oracle_trace_events(bet_id);
CREATE INDEX IF NOT EXISTS idx_ote_layer         ON oracle_trace_events(layer_name);
CREATE INDEX IF NOT EXISTS idx_ote_event_type    ON oracle_trace_events(event_type);
CREATE INDEX IF NOT EXISTS idx_ote_created_at    ON oracle_trace_events(created_at);
CREATE INDEX IF NOT EXISTS idx_ote_bet_date      ON oracle_trace_events(bet_date);
CREATE INDEX IF NOT EXISTS idx_ote_system_mode   ON oracle_trace_events(system, mode);

-- ── Bet decision summary ────────────────────────────────────────────
-- One row per (decision_id, system) pair. The most important table for
-- per-bet inspection and A/B comparison. Updated as layers complete.
CREATE TABLE IF NOT EXISTS oracle_bet_traces (
  decision_id           TEXT NOT NULL,
  system                TEXT NOT NULL,    -- 'oracle' | 'current' | 'old'
  pitcher_id            TEXT NOT NULL,
  game_pk               TEXT,
  market_ticker         TEXT,
  bet_date              TEXT NOT NULL,
  strike                INTEGER NOT NULL,
  side                  TEXT NOT NULL,

  final_decision        TEXT NOT NULL,
  final_size_usd        REAL,
  would_have_executed   INTEGER NOT NULL DEFAULT 0,
  executed              INTEGER NOT NULL DEFAULT 0,
  bet_id                TEXT,

  outcome_result        TEXT,             -- 'win' | 'loss' | 'void'
  outcome_pnl_usd       REAL,
  outcome_settled_at    TEXT,

  created_at            TEXT NOT NULL,
  finalized_at          TEXT,

  PRIMARY KEY (decision_id, system)
);

CREATE INDEX IF NOT EXISTS idx_obt_bet_date       ON oracle_bet_traces(bet_date);
CREATE INDEX IF NOT EXISTS idx_obt_pitcher        ON oracle_bet_traces(pitcher_id);
CREATE INDEX IF NOT EXISTS idx_obt_game           ON oracle_bet_traces(game_pk);
CREATE INDEX IF NOT EXISTS idx_obt_ticker         ON oracle_bet_traces(market_ticker);
CREATE INDEX IF NOT EXISTS idx_obt_decision       ON oracle_bet_traces(final_decision);
CREATE INDEX IF NOT EXISTS idx_obt_outcome        ON oracle_bet_traces(outcome_result);

-- ── Probe ledger ────────────────────────────────────────────────────
-- 1-3% of skipped bets fired at $1 minimum to validate fill assumptions.
-- 90 days detailed retention; aggregate to monthly summary thereafter.
CREATE TABLE IF NOT EXISTS oracle_probe_ledger (
  id                    TEXT PRIMARY KEY,
  decision_id           TEXT NOT NULL,
  probe_type            TEXT NOT NULL,    -- 'fill_validation' | 'random_skip_sample' | etc.
  reason_code           TEXT NOT NULL,    -- why this skipped bet was probed
  bet_id                TEXT,
  probe_amount_usd      REAL NOT NULL,
  probe_fill_price      INTEGER,
  probe_filled          INTEGER,
  market_snapshot_id    TEXT,
  outcome_result        TEXT,
  outcome_pnl_usd       REAL,
  settled               INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL,
  settled_at            TEXT
);

CREATE INDEX IF NOT EXISTS idx_opl_created_at     ON oracle_probe_ledger(created_at);
CREATE INDEX IF NOT EXISTS idx_opl_decision       ON oracle_probe_ledger(decision_id);
CREATE INDEX IF NOT EXISTS idx_opl_probe_type     ON oracle_probe_ledger(probe_type);
CREATE INDEX IF NOT EXISTS idx_opl_settled        ON oracle_probe_ledger(settled);

-- ── Settlement lag tracking ─────────────────────────────────────────
-- Operational metric: how long between game-final detection and Kalshi settlement.
CREATE TABLE IF NOT EXISTS oracle_settlement_lag (
  id                    TEXT PRIMARY KEY,
  decision_id           TEXT NOT NULL,
  bet_id                TEXT,
  market_ticker         TEXT NOT NULL,
  game_pk               TEXT,
  detected_final_at     TEXT NOT NULL,
  kalshi_settled_at     TEXT,
  lag_seconds           INTEGER,
  created_at            TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_osl_market         ON oracle_settlement_lag(market_ticker);
CREATE INDEX IF NOT EXISTS idx_osl_game           ON oracle_settlement_lag(game_pk);
CREATE INDEX IF NOT EXISTS idx_osl_detected       ON oracle_settlement_lag(detected_final_at);
