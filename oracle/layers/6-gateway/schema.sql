-- oracle/layers/6-gateway/schema.sql
--
-- Layer 6: Gateway — schema v1.0 (LOCKED 2026-04-30)
--
-- All tables idempotent (CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS).
-- Apply via the same migration helper used for Layer 0.
--
-- Conventions:
--   * Timestamps stored as ISO-8601 TEXT (UTC) for human readability + lexicographic sort
--   * Hashes always lowercase hex
--   * decision_id is the cross-layer binding key (matches oracle_trace_events.decision_id)
--   * Enum-typed string columns (account_id, strategy_mode, etc.) are validated in code,
--     not by SQLite CHECK constraints, because the canonical lists evolve and live in
--     oracle/layers/6-gateway/strategyModes.js (and adjacent enum modules).

------------------------------------------------------------------------------
-- 1. gateway_accounts
--    Account registry. Gateway rejects unknown or disabled accounts.
--    Adding a new account is a config-only change.
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gateway_accounts (
  account_id              TEXT PRIMARY KEY,         -- e.g. 'adam', 'isaiah'
  display_name            TEXT NOT NULL,
  kalshi_credential_ref   TEXT NOT NULL,            -- env var name OR KMS key id
  enabled                 INTEGER NOT NULL DEFAULT 1,
  daily_loss_limit_usd    REAL,                     -- mirrored into account_daily_state
  daily_risk_limit_usd    REAL,
  notes                   TEXT,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_gw_accounts_enabled
  ON gateway_accounts(enabled);

------------------------------------------------------------------------------
-- 2. gateway_killswitch
--    Server-side operator killswitches. 1s in-memory cache TTL.
--    Values JSON-encoded except for primitive booleans (stored as 'true'/'false').
--    Any UPDATE bumps updated_at; cache treats stale entries as immediate refresh trigger.
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gateway_killswitch (
  key          TEXT PRIMARY KEY,                    -- canonical key (see spec §8)
  value        TEXT NOT NULL,                       -- JSON-encoded
  updated_at   TEXT NOT NULL,
  updated_by   TEXT NOT NULL                        -- admin agent id
);

------------------------------------------------------------------------------
-- 3. gateway_idempotency
--    Decision-id keyed idempotency cache.
--    A second call with same decision_id + same body_hash → replay last response.
--    Same decision_id + different body_hash → IDEMPOTENCY_CONFLICT.
--    exchange_request_sent + kalshi_order_id + exchange_status track the partial-state
--    needed to correctly replay during exchange_unknown reconciliation.
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gateway_idempotency (
  decision_id             TEXT PRIMARY KEY,
  body_hash               TEXT NOT NULL,            -- sha256 hex of canonical request body
  client_order_id         TEXT,                     -- gateway_<sha256(decision_id):0..16>; persisted for audit + reconciliation
  exchange_request_sent   INTEGER NOT NULL DEFAULT 0,  -- 1 if Kalshi POST was attempted
  kalshi_order_id         TEXT,                     -- nullable; set on accepted
  exchange_status         TEXT,                     -- placed | rejected | unknown | partially_filled
  last_status             TEXT NOT NULL,            -- gateway-level: accepted | shadow_logged | rejected | exchange_unknown | exchange_error | conflict | replay
  response_json           TEXT,                     -- nullable; full last response for replay
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  expires_at              TEXT NOT NULL             -- created_at + 5 min
);

CREATE INDEX IF NOT EXISTS idx_gw_idem_expires
  ON gateway_idempotency(expires_at);

CREATE INDEX IF NOT EXISTS idx_gw_idem_status
  ON gateway_idempotency(last_status, expires_at);

------------------------------------------------------------------------------
-- 4. gateway_unknowns
--    Reconciliation queue for exchange_unknown outcomes.
--    Worker polls Kalshi every 15s for first 5min, then every 60s, until resolved.
--    resolved_status: placed | rejected | not_found | partially_filled
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gateway_unknowns (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  decision_id           TEXT NOT NULL,
  client_order_id       TEXT,                       -- gateway_<sha256(decision_id):0..16>; reconciler key
  account_id            TEXT NOT NULL,
  market_ticker         TEXT NOT NULL,
  submitted_at          TEXT NOT NULL,
  attempts              INTEGER NOT NULL DEFAULT 0,
  last_check_at         TEXT,
  last_check_response   TEXT,                       -- raw Kalshi response (audit)
  last_check_error_code TEXT,                       -- categorized: lookup_5xx | lookup_timeout | lookup_auth_error | lookup_rate_limited | lookup_not_found
  resolved_status       TEXT,                       -- nullable until resolved
  resolved_at           TEXT,                       -- nullable until resolved
  resolved_kalshi_order_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_gw_unknown_unresolved
  ON gateway_unknowns(resolved_at, submitted_at);

CREATE INDEX IF NOT EXISTS idx_gw_unknown_decision
  ON gateway_unknowns(decision_id);

------------------------------------------------------------------------------
-- 5. gateway_nonces
--    HMAC replay protection. Nonce + agent must be unique within 60s window.
--    Cleanup job sweeps rows where expires_at < now every 5min.
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gateway_nonces (
  nonce        TEXT PRIMARY KEY,
  agent_id     TEXT NOT NULL,
  used_at      TEXT NOT NULL,
  expires_at   TEXT NOT NULL                        -- used_at + 60s
);

CREATE INDEX IF NOT EXISTS idx_gw_nonces_expires
  ON gateway_nonces(expires_at);

------------------------------------------------------------------------------
-- 6. gateway_account_daily_state
--    Materialized per-account per-day state. Updated by the settlement path
--    (and order-submit path for submitted_order_usd / open_risk_usd).
--    Gateway reads ONE ROW per request; never SUM().
--    Stale read (updated_at older than 60s for live trades) → ACCOUNT_STATE_STALE reject.
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gateway_account_daily_state (
  account_id              TEXT NOT NULL,
  trading_date            TEXT NOT NULL,            -- YYYY-MM-DD (ET)
  realized_pnl_usd        REAL NOT NULL DEFAULT 0,  -- settled P&L today
  open_risk_usd           REAL NOT NULL DEFAULT 0,  -- max loss on currently-open positions
  submitted_order_usd     REAL NOT NULL DEFAULT 0,  -- sum of bet_amount on accepted orders today
  daily_loss_limit_usd    REAL,                     -- mirror of gateway_accounts at start-of-day
  daily_risk_limit_usd    REAL,
  updated_at              TEXT NOT NULL,
  PRIMARY KEY (account_id, trading_date)
);

CREATE INDEX IF NOT EXISTS idx_gw_acct_state_updated
  ON gateway_account_daily_state(updated_at);

------------------------------------------------------------------------------
-- 7. gateway_admin_audit
--    Full audit log of every admin endpoint call (killswitch changes, manual unhalt).
--    Cross-referenced from oracle_trace_events via trace_event_id.
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gateway_admin_audit (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at     TEXT NOT NULL,
  action          TEXT NOT NULL,                    -- killswitch_set | unhalt | other
  key             TEXT,                             -- which killswitch key, if applicable
  prior_value     TEXT,                             -- JSON-encoded previous value
  new_value       TEXT,                             -- JSON-encoded new value
  performed_by    TEXT NOT NULL,                    -- admin agent id
  source_ip       TEXT,
  trace_event_id  TEXT NOT NULL,                    -- FK to oracle_trace_events
  reason          TEXT
);

CREATE INDEX IF NOT EXISTS idx_gw_admin_audit_time
  ON gateway_admin_audit(occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_gw_admin_audit_action
  ON gateway_admin_audit(action, occurred_at DESC);

------------------------------------------------------------------------------
-- Done. 7 tables, 12 indexes.
-- No partitioning yet (revisit if any single table > 10M rows).
-- Apply via Layer 0 migration helper, idempotent on re-run.
------------------------------------------------------------------------------
