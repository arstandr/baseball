-- MLBIE — libSQL schema (full-game totals on Kalshi)
-- See DATA.md for field semantics and the feature groups that consume each field.
--
-- Pivoted from F5 → full-game totals (DEC-016). All "f5" columns renamed to
-- "full" (market line) or "total" (actual runs). Bullpen group (I) added.

-- ========================================================================
-- games: one row per MLB game
-- ========================================================================
CREATE TABLE IF NOT EXISTS games (
  id TEXT PRIMARY KEY,                 -- MLB game ID (from Stats API)
  date TEXT NOT NULL,                  -- YYYY-MM-DD (game local date)
  season INTEGER NOT NULL,
  game_time TEXT NOT NULL,             -- ISO timestamp (first pitch local)
  status TEXT NOT NULL,                -- scheduled|in_progress|final|postponed
  venue_id TEXT NOT NULL,
  team_home TEXT NOT NULL,
  team_away TEXT NOT NULL,
  pitcher_home_id TEXT,
  pitcher_away_id TEXT,
  full_line_open REAL,                 -- Opening full-game total
  full_line_current REAL,              -- Most recent full-game total
  actual_runs_home INTEGER,            -- Full-game runs scored by home team
  actual_runs_away INTEGER,            -- Full-game runs scored by away team
  actual_runs_total INTEGER,           -- Combined full-game total
  f5_runs_home INTEGER,
  f5_runs_away INTEGER,
  f5_runs_total INTEGER,
  f5_winner TEXT,                      -- 'home'|'away'|'tie'
  f5_innings_played INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- ========================================================================
-- pitcher_signals: one row per (pitcher, date)
-- ========================================================================
CREATE TABLE IF NOT EXISTS pitcher_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pitcher_id TEXT NOT NULL,
  pitcher_name TEXT NOT NULL,
  signal_date TEXT NOT NULL,
  hand TEXT NOT NULL,                  -- R|L
  fip_weighted REAL,
  xfip_weighted REAL,
  swstr_pct REAL,
  gb_pct REAL,
  hard_contact_pct REAL,
  k9 REAL,
  bb9 REAL,
  fstrike_pct REAL,
  tto_penalty REAL,
  tto3_penalty REAL,                   -- 3rd time through order penalty (full-game critical)
  era_l5 REAL,                         -- Full-game ERA last 5 starts (was f5_era_l5)
  avg_innings_l5 REAL,
  pitch_efficiency_l5 REAL,
  days_rest INTEGER,
  season_start_num INTEGER,
  confidence REAL,
  news_flag TEXT DEFAULT 'none',
  news_adjustment REAL DEFAULT 0.0,
  news_reasoning TEXT,
  raw_data_json TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(pitcher_id, signal_date)
);

-- ========================================================================
-- lineup_signals: one row per (team, game)
-- ========================================================================
CREATE TABLE IF NOT EXISTS lineup_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id TEXT NOT NULL,
  game_id TEXT NOT NULL,
  signal_date TEXT NOT NULL,
  vs_handedness TEXT NOT NULL,         -- R|L
  wrc_plus_14d REAL,
  wrc_plus_30d REAL,
  k_pct_14d REAL,
  hard_contact_14d REAL,
  iso_14d REAL,
  runs_pg_14d REAL,                    -- Full-game runs per game (was f5_runs_pg_14d)
  lob_pct_14d REAL,                    -- Left on base % (stranded runners)
  top6_weighted_ops REAL,
  schedule_fatigue INTEGER,
  changes_detected INTEGER DEFAULT 0,
  key_players_scratched TEXT,
  change_adjustment REAL DEFAULT 0.0,
  confidence REAL,
  raw_data_json TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(team_id, game_id)
);

-- ========================================================================
-- bullpen_signals: one row per (team, date) — Group I (NEW for full-game)
-- ========================================================================
CREATE TABLE IF NOT EXISTS bullpen_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id TEXT NOT NULL,
  signal_date TEXT NOT NULL,
  era_14d REAL,
  whip_14d REAL,
  k_pct_14d REAL,
  hr_per_9_14d REAL,
  inherited_score_pct REAL,
  quality_score REAL,
  confidence REAL,
  raw_data_json TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(team_id, signal_date)
);

-- ========================================================================
-- venues: static park factors (update once per season)
-- ========================================================================
CREATE TABLE IF NOT EXISTS venues (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  team TEXT NOT NULL,
  city TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  altitude_feet INTEGER DEFAULT 0,
  orientation_degrees INTEGER,
  roof_type TEXT NOT NULL,             -- open|retractable|dome
  surface TEXT NOT NULL,               -- grass|turf
  lf_line_feet INTEGER,
  rf_line_feet INTEGER,
  cf_feet INTEGER,
  run_factor REAL DEFAULT 1.0,
  hr_factor REAL DEFAULT 1.0,
  f5_factor REAL DEFAULT 1.0,          -- retained for legacy agents (full-game uses run_factor)
  updated_at TEXT DEFAULT (datetime('now'))
);

-- ========================================================================
-- weather: per-game weather at first pitch
-- ========================================================================
CREATE TABLE IF NOT EXISTS weather (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id TEXT NOT NULL,
  venue_id TEXT NOT NULL,
  first_pitch_time TEXT NOT NULL,
  temp_f REAL,
  temp_category TEXT,
  wind_mph REAL,
  wind_bearing_degrees INTEGER,
  wind_direction_relative TEXT,
  wind_adjustment REAL DEFAULT 0.0,
  humidity REAL,
  precip_probability REAL,
  precip_timing TEXT,
  dome INTEGER DEFAULT 0,
  disqualify INTEGER DEFAULT 0,
  weather_score REAL DEFAULT 0.0,
  fetched_at TEXT DEFAULT (datetime('now')),
  UNIQUE(game_id)
);

-- ========================================================================
-- lines: opening/current lines with movement history
-- ========================================================================
CREATE TABLE IF NOT EXISTS lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id TEXT NOT NULL,
  source TEXT NOT NULL,                -- odds_api|robinhood|kalshi
  market_type TEXT NOT NULL,           -- full_total|full_ml|f5_total (legacy)
  line_value REAL,
  over_price REAL,
  under_price REAL,
  is_opening INTEGER DEFAULT 0,
  movement_from_open REAL,
  efficiency_score REAL DEFAULT 1.0,
  sharp_signal TEXT,
  fetched_at TEXT DEFAULT (datetime('now'))
);

-- ========================================================================
-- projections: one row per (game, model_version)
-- ========================================================================
CREATE TABLE IF NOT EXISTS projections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id TEXT NOT NULL,
  model_version TEXT NOT NULL,
  projected_total REAL,                -- was projected_f5_total
  over_probability REAL,
  confidence_interval_low REAL,
  confidence_interval_high REAL,
  feature_vector_json TEXT,
  shap_values_json TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(game_id, model_version)
);

-- ========================================================================
-- agent_outputs: raw JSON snapshot per (game, agent)
-- ========================================================================
CREATE TABLE IF NOT EXISTS agent_outputs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id TEXT NOT NULL,
  agent TEXT NOT NULL,                 -- scout|lineup|park|storm|market|judge|bullpen
  output_json TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(game_id, agent)
);

-- ========================================================================
-- trades: every trade fired (paper + live)
-- ========================================================================
CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id TEXT NOT NULL,
  trade_date TEXT NOT NULL,
  mode TEXT NOT NULL,                  -- paper|live
  side TEXT NOT NULL,                  -- OVER|UNDER
  line REAL NOT NULL,
  contract_price REAL NOT NULL,
  contracts INTEGER NOT NULL,
  position_size_usd REAL NOT NULL,
  model_probability REAL NOT NULL,
  market_implied_probability REAL NOT NULL,
  raw_edge REAL NOT NULL,
  adjusted_edge REAL NOT NULL,
  confidence_multiplier REAL NOT NULL,
  bankroll_at_trade REAL,
  primary_driver_agent TEXT,
  agent_attribution_json TEXT,
  explanation TEXT,
  kalshi_ticker TEXT,                  -- NEW: Kalshi market ticker when executed
  kalshi_order_id TEXT,                -- NEW: order id returned by Kalshi
  executed_at TEXT,
  execution_confirmation TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- ========================================================================
-- outcomes: actual results + P&L per trade
-- ========================================================================
CREATE TABLE IF NOT EXISTS outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_id INTEGER NOT NULL REFERENCES trades(id),
  game_id TEXT NOT NULL,
  actual_runs_total INTEGER,           -- was actual_f5_total
  line REAL NOT NULL,
  result TEXT NOT NULL,                -- WIN|LOSS|PUSH|VOID
  pnl_usd REAL,
  settled_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(trade_id)
);

-- ========================================================================
-- model_versions: training run metadata
-- ========================================================================
CREATE TABLE IF NOT EXISTS model_versions (
  id TEXT PRIMARY KEY,
  trained_at TEXT NOT NULL,
  train_seasons TEXT NOT NULL,
  hyperparams_json TEXT,
  feature_importance_json TEXT,
  brier_score REAL,
  auc_roc REAL,
  val_win_rate_55 REAL,
  val_win_rate_60 REAL,
  val_roi REAL,
  is_active INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- ========================================================================
-- historical_games: backtest dataset (Part 2 historical pipeline)
-- ========================================================================
CREATE TABLE IF NOT EXISTS historical_games (
  id TEXT PRIMARY KEY,                 -- MLB game_id
  date TEXT NOT NULL,
  season INTEGER NOT NULL,
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  home_team_id INTEGER,
  away_team_id INTEGER,
  venue_id TEXT,
  game_time TEXT,
  pitcher_home_id TEXT,
  pitcher_away_id TEXT,
  full_line_open REAL,                 -- opening total line
  actual_runs_home INTEGER,
  actual_runs_away INTEGER,
  actual_runs_total INTEGER,
  f5_runs_home INTEGER,                -- runs scored by home team through inning 5
  f5_runs_away INTEGER,                -- runs scored by away team through inning 5
  f5_runs_total INTEGER,               -- combined F5 total
  f5_winner TEXT,                      -- 'home'|'away'|'tie' — Kalshi F5 winner market target
  f5_innings_played INTEGER,           -- innings actually played (filter weather-shortened games)
  target INTEGER,                      -- 1 if over, 0 if under
  features_built INTEGER DEFAULT 0,    -- flag when feature row is complete
  hp_umpire_id TEXT,                   -- MLB ID of home plate umpire
  hp_umpire_name TEXT,                 -- display name
  created_at TEXT DEFAULT (datetime('now'))
);

-- ========================================================================
-- historical_pitcher_stats: rolling pitcher stats as-of game date
-- ========================================================================
CREATE TABLE IF NOT EXISTS historical_pitcher_stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pitcher_id TEXT NOT NULL,
  pitcher_name TEXT NOT NULL,
  as_of_date TEXT NOT NULL,
  season INTEGER NOT NULL,
  hand TEXT,
  era_l5 REAL,
  fip_l5 REAL,
  k9_l5 REAL,                          -- K/9 last 5 starts (was hardcoded 8.8)
  bb9_l5 REAL,                         -- BB/9 last 5 starts (was hardcoded 3.2)
  k_pct_l5 REAL,                       -- K% last 5 starts
  swstr_pct_l5 REAL,
  gb_pct_l5 REAL,
  hard_contact_l5 REAL,
  avg_innings_l5 REAL,
  early_exit_rate_l5 REAL,             -- fraction of last 5 starts where starter didn't complete inning 5
  era_f5_l5 REAL,                      -- ERA specifically in innings 1-5, last 5 qualifying starts
  avg_f5_ip_l5 REAL,                   -- avg IP through F5 window per start (< 5 = frequently pulled early)
  f5_starts_available INTEGER,         -- starts with usable F5 data (for confidence weighting)
  days_rest INTEGER,
  tto_penalty REAL,
  tto3_penalty REAL,
  venue_era REAL,
  confidence REAL,
  UNIQUE(pitcher_id, as_of_date)
);

-- ========================================================================
-- historical_umpire_stats: umpire run-impact metrics as-of game date
-- ========================================================================
CREATE TABLE IF NOT EXISTS historical_umpire_stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  umpire_id TEXT NOT NULL,
  umpire_name TEXT NOT NULL,
  as_of_date TEXT NOT NULL,
  runs_pg REAL,                        -- career avg runs/game as HP ump (as-of)
  over_rate REAL,                      -- fraction of games going over the line
  n_games INTEGER,                     -- total HP games (confidence proxy)
  UNIQUE(umpire_id, as_of_date)
);

-- ========================================================================
-- historical_team_offense: rolling team offense as-of date, vs hand
-- ========================================================================
CREATE TABLE IF NOT EXISTS historical_team_offense (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id INTEGER NOT NULL,
  as_of_date TEXT NOT NULL,
  vs_hand TEXT,
  runs_pg_14d REAL,
  k_pct_14d REAL,
  obp_14d REAL,
  hr_pg_14d REAL,
  UNIQUE(team_id, as_of_date, vs_hand)
);

-- ========================================================================
-- historical_bullpen_stats: rolling bullpen stats as-of date
-- ========================================================================
CREATE TABLE IF NOT EXISTS historical_bullpen_stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id INTEGER NOT NULL,
  as_of_date TEXT NOT NULL,
  era_14d REAL,
  whip_14d REAL,
  k_pct_14d REAL,
  hr_per_9_14d REAL,
  inherited_score_pct REAL,
  UNIQUE(team_id, as_of_date)
);

-- ========================================================================
-- convergence_log: Kalshi price snapshots at fixed pre-game windows
-- Highest-priority dataset — cannot be backdated. Collected live.
-- ========================================================================
CREATE TABLE IF NOT EXISTS convergence_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id TEXT NOT NULL,
  game_date TEXT NOT NULL,
  full_line REAL NOT NULL,
  kalshi_price_open REAL,
  kalshi_price_6hr REAL,
  kalshi_price_2hr REAL,
  kalshi_price_30min REAL,
  kalshi_price_start REAL,
  sportsbook_implied_open REAL,
  sportsbook_implied_6hr REAL,
  sportsbook_implied_2hr REAL,
  sportsbook_implied_30min REAL,
  sportsbook_implied_start REAL,
  time_to_convergence_min REAL,
  convergence_trigger TEXT,        -- lineup|weather|sharp_money|unknown
  notes TEXT,
  captured_at TEXT DEFAULT (datetime('now'))
);

-- ========================================================================
-- kalshi_price_snapshots: 15-min price polling for velocity calculation
-- Required by MEM agent (convergence velocity metric).
-- ========================================================================
CREATE TABLE IF NOT EXISTS kalshi_price_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id TEXT NOT NULL,
  kalshi_ticker TEXT NOT NULL,
  price_over REAL NOT NULL,
  price_under REAL NOT NULL,
  bid REAL,
  ask REAL,
  depth_over_contracts INTEGER,
  depth_under_contracts INTEGER,
  captured_at TEXT DEFAULT (datetime('now'))
);

-- ========================================================================
-- mem_decisions: every MEM evaluation, trade or not
-- This log IS the convergence dataset for V2 edge half-life model.
-- ========================================================================
CREATE TABLE IF NOT EXISTS mem_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id TEXT NOT NULL,
  evaluated_at TEXT NOT NULL,
  edge_raw REAL,
  gap_consensus REAL,
  velocity REAL,
  liquidity_score REAL,
  minutes_to_game REAL,
  time_window TEXT,                -- EARLY|PRIMARY|LATE
  tqs REAL,
  decision TEXT NOT NULL,          -- GREEN|YELLOW|RED
  decision_reason TEXT,
  traded INTEGER DEFAULT 0,
  trade_id INTEGER REFERENCES trades(id)
);

-- ========================================================================
-- clv_log: closing line value tracking for paper bets
-- Primary edge-validation dataset. Cannot be backdated — collect live.
-- CLV = paper_price_close - paper_price_open (positive = beat the market).
-- series: 'f5_total' | 'full_total'
-- side: 'OVER' | 'UNDER'
-- paper_price_open: Kalshi yes_ask (0-100 cents) at time of paper bet
-- paper_price_close: Kalshi yes_ask 5min before first pitch
-- clv: paper_price_close - paper_price_open (filled when closeOutLines runs)
-- signal_tags: JSON array e.g. ["low_k_stack","hitter_park"]
-- ========================================================================
CREATE TABLE IF NOT EXISTS clv_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id TEXT NOT NULL,
  series TEXT NOT NULL,                -- 'f5_total' | 'full_total'
  line REAL NOT NULL,                  -- e.g. 4.5
  side TEXT NOT NULL,                  -- 'OVER' | 'UNDER'
  model_probability REAL,              -- model's P(side wins)
  paper_price_open REAL,               -- Kalshi yes_ask at paper bet time (cents 1-99)
  paper_price_close REAL,              -- Kalshi yes_ask 5min before first pitch
  clv REAL,                            -- paper_price_close - paper_price_open
  result INTEGER,                      -- 1=WIN, 0=LOSS, NULL=unsettled
  actual_f5_total REAL,                -- actual F5 runs (filled post-game)
  game_date TEXT NOT NULL,             -- YYYY-MM-DD
  signal_tags TEXT,                    -- JSON array of contributing signal types
  kalshi_ticker TEXT,                  -- ticker used to fetch prices
  logged_at TEXT DEFAULT (datetime('now')),
  settled_at TEXT
);

-- ========================================================================
-- Indexes
-- ========================================================================
CREATE INDEX IF NOT EXISTS idx_games_date ON games(date);
CREATE INDEX IF NOT EXISTS idx_games_season ON games(season);
CREATE INDEX IF NOT EXISTS idx_games_status ON games(status);
CREATE INDEX IF NOT EXISTS idx_pitcher_signals_date ON pitcher_signals(signal_date);
CREATE INDEX IF NOT EXISTS idx_lineup_signals_game ON lineup_signals(game_id);
CREATE INDEX IF NOT EXISTS idx_bullpen_signals_date ON bullpen_signals(signal_date);
CREATE INDEX IF NOT EXISTS idx_lines_game ON lines(game_id);
CREATE INDEX IF NOT EXISTS idx_agent_outputs_game ON agent_outputs(game_id);
CREATE INDEX IF NOT EXISTS idx_agent_outputs_agent ON agent_outputs(agent, created_at);
CREATE INDEX IF NOT EXISTS idx_trades_date ON trades(trade_date);
CREATE INDEX IF NOT EXISTS idx_trades_mode ON trades(mode);
CREATE INDEX IF NOT EXISTS idx_trades_game ON trades(game_id);
CREATE INDEX IF NOT EXISTS idx_outcomes_result ON outcomes(result);
CREATE INDEX IF NOT EXISTS idx_outcomes_game ON outcomes(game_id);
CREATE INDEX IF NOT EXISTS idx_projections_game ON projections(game_id);
CREATE INDEX IF NOT EXISTS idx_weather_game ON weather(game_id);
CREATE INDEX IF NOT EXISTS idx_historical_games_date ON historical_games(date);
CREATE INDEX IF NOT EXISTS idx_historical_games_season ON historical_games(season);
CREATE INDEX IF NOT EXISTS idx_historical_pitcher_stats_date ON historical_pitcher_stats(as_of_date);
CREATE INDEX IF NOT EXISTS idx_historical_team_offense_date ON historical_team_offense(as_of_date);
CREATE INDEX IF NOT EXISTS idx_historical_bullpen_date ON historical_bullpen_stats(as_of_date);
CREATE INDEX IF NOT EXISTS idx_historical_umpire_stats_date ON historical_umpire_stats(as_of_date);
CREATE INDEX IF NOT EXISTS idx_historical_umpire_stats_id ON historical_umpire_stats(umpire_id);
CREATE INDEX IF NOT EXISTS idx_convergence_game ON convergence_log(game_id);
CREATE INDEX IF NOT EXISTS idx_convergence_date ON convergence_log(game_date);
CREATE INDEX IF NOT EXISTS idx_kalshi_snapshots_game ON kalshi_price_snapshots(game_id);
CREATE INDEX IF NOT EXISTS idx_kalshi_snapshots_captured ON kalshi_price_snapshots(captured_at);
CREATE INDEX IF NOT EXISTS idx_mem_decisions_game ON mem_decisions(game_id);
CREATE INDEX IF NOT EXISTS idx_mem_decisions_decision ON mem_decisions(decision);
CREATE INDEX IF NOT EXISTS idx_clv_log_game ON clv_log(game_id);
CREATE INDEX IF NOT EXISTS idx_clv_log_date ON clv_log(game_date);
CREATE INDEX IF NOT EXISTS idx_clv_log_close ON clv_log(paper_price_close);
CREATE INDEX IF NOT EXISTS idx_clv_log_series ON clv_log(series);

-- ========================================================================
-- pitcher_statcast: season-level Statcast data per pitcher
-- Source: Baseball Savant custom leaderboard CSV (no auth required)
-- Refreshed daily by scripts/live/fetchPitcherStatcast.js
-- ========================================================================
CREATE TABLE IF NOT EXISTS pitcher_statcast (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id   TEXT NOT NULL,        -- MLB player ID (matches games.pitcher_home_id)
  player_name TEXT,
  season      INTEGER NOT NULL,
  fetch_date  TEXT NOT NULL,        -- YYYY-MM-DD of fetch
  ip          REAL,                 -- Innings pitched season-to-date
  pa          INTEGER,              -- Plate appearances season-to-date
  k_pct       REAL,                 -- Season K% (0-1)
  bb_pct      REAL,                 -- Season BB% (0-1)
  swstr_pct   REAL,                 -- Whiff% / swinging-strike rate (0-1, leading K indicator)
  fb_velo     REAL,                 -- Average fastball velocity (mph)
  fb_spin     REAL,                 -- Fastball average spin rate (RPM) — decline = injury/fatigue signal
  gb_pct      REAL,                 -- Ground ball % (0-1)
  k_pct_vs_l  REAL,                 -- K% vs LHB (0-1) — pitcher handedness split
  k_pct_vs_r  REAL,                 -- K% vs RHB (0-1) — pitcher handedness split
  UNIQUE(player_id, season, fetch_date)
);
CREATE INDEX IF NOT EXISTS idx_pitcher_statcast_pid ON pitcher_statcast(player_id, season);
CREATE INDEX IF NOT EXISTS idx_pitcher_statcast_date ON pitcher_statcast(fetch_date);

-- ========================================================================
-- pitcher_recent_starts: per-start pitch count + BF for leash modeling
-- Source: MLB Stats API game log. Refreshed daily by fetchPitcherRecentStarts.js
-- ========================================================================
CREATE TABLE IF NOT EXISTS pitcher_recent_starts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  pitcher_id  TEXT NOT NULL,
  game_id     TEXT NOT NULL,
  game_date   TEXT NOT NULL,
  season      INTEGER NOT NULL,
  ip          REAL,
  bf          INTEGER,
  ks          INTEGER,
  pitches     INTEGER,
  bb          INTEGER,
  fetch_date  TEXT NOT NULL,
  UNIQUE(pitcher_id, game_id)
);
CREATE INDEX IF NOT EXISTS idx_prs_pitcher ON pitcher_recent_starts(pitcher_id, season);
CREATE INDEX IF NOT EXISTS idx_prs_date    ON pitcher_recent_starts(game_date);

-- ========================================================================
-- game_lineups: official batting order K% per game/team/pitcher-hand
-- Source: MLB Stats API boxscore + per-batter statSplits.
-- Refreshed after lineups post (~3-4 PM ET). fetchLineups.js
-- ========================================================================
CREATE TABLE IF NOT EXISTS game_lineups (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id      TEXT NOT NULL,
  team_abbr    TEXT NOT NULL,
  vs_hand      TEXT NOT NULL,       -- pitcher throwing hand: R or L
  fetch_date   TEXT NOT NULL,
  lineup_k_pct REAL,                -- equal-weight avg K% of 9 batters vs this hand
  batter_count INTEGER,             -- batters with real K% data (rest use league avg)
  source       TEXT DEFAULT 'official',
  lineup_json  TEXT,                -- [{id, k_pct_vs_r, k_pct_vs_l}] for debugging
  UNIQUE(game_id, team_abbr, vs_hand, fetch_date)
);
CREATE INDEX IF NOT EXISTS idx_game_lineups_game ON game_lineups(game_id);

-- ========================================================================
-- kalshi_ks_markets: cached Kalshi KXMLBKS market prices + results
-- Captured at edge-run time (pre-game open prices) and at settlement.
-- This is the live-accumulating dataset that enables real-price backtests
-- once we have enough history (target: 4+ weeks = ~100+ game-days).
-- ========================================================================
CREATE TABLE IF NOT EXISTS kalshi_ks_markets (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker       TEXT NOT NULL,           -- full Kalshi ticker e.g. KXMLBKS-26APR201840...
  game_date    TEXT NOT NULL,           -- YYYY-MM-DD
  game_id      TEXT,                    -- MLB game ID (if linked)
  pitcher_name TEXT,
  pitcher_id   TEXT,
  team         TEXT,
  strike       INTEGER NOT NULL,        -- K threshold (3, 4, 5 … 12)
  yes_ask      REAL,                    -- Kalshi yes_ask at capture time (cents)
  yes_bid      REAL,
  no_ask       REAL,
  no_bid       REAL,
  mid          REAL,                    -- (yes_ask + yes_bid) / 2
  spread       REAL,                    -- yes_ask - yes_bid
  volume       REAL,
  model_prob   REAL,                    -- our model P(K>=strike) at capture time
  model_lambda REAL,                    -- lambda at capture time
  captured_at  TEXT DEFAULT (datetime('now')),
  result       INTEGER,                 -- 1=YES won, 0=NO won, NULL=unsettled
  actual_ks    INTEGER,                 -- actual strikeouts (filled at settlement)
  settled_at   TEXT,
  UNIQUE(ticker)
);
CREATE INDEX IF NOT EXISTS idx_ksm_date    ON kalshi_ks_markets(game_date);
CREATE INDEX IF NOT EXISTS idx_ksm_pitcher ON kalshi_ks_markets(pitcher_id, game_date);
CREATE INDEX IF NOT EXISTS idx_ksm_settled ON kalshi_ks_markets(settled_at);

-- ========================================================================
-- model_config_log: daily snapshot of model parameters
-- One row per run of ksBets.js log. Lets us slice P&L analysis by
-- which config was active — critical when we change thresholds mid-season.
-- ========================================================================
CREATE TABLE IF NOT EXISTS model_config_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_date        TEXT NOT NULL,
  logged_at       TEXT DEFAULT (datetime('now')),
  edge_threshold  REAL,          -- MIN_EDGE used this run (e.g. 0.05)
  adj_threshold   REAL,          -- opp adj selectivity threshold (e.g. 0.28)
  shrink7         REAL,          -- P(7+) shrinkage multiplier
  shrink8         REAL,          -- P(8+) shrinkage multiplier
  shrink9         REAL,          -- P(9+) shrinkage multiplier
  kelly_mult      REAL,          -- Kelly fraction (e.g. 0.25)
  max_bet_pct     REAL,          -- max bet as % of bankroll
  min_bet         REAL,          -- minimum bet size $
  bb_penalty_on   INTEGER,       -- 1 if BB% penalty active
  no_cap_cents    REAL,          -- NO bet cap in cents (e.g. 80)
  bets_logged     INTEGER,       -- how many edges were found
  notes           TEXT           -- free text (e.g. "raised threshold to 8¢")
);
CREATE INDEX IF NOT EXISTS idx_mcl_date ON model_config_log(run_date);

-- ========================================================================
-- users: multi-user auth (website + CLI access)
-- Seeded from ENV on first start; manageable via web admin or addUser.js.
-- ========================================================================
CREATE TABLE IF NOT EXISTS users (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  name               TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pin                TEXT NOT NULL,
  created_at         TEXT DEFAULT (datetime('now')),
  -- Betting profile (populated when user joins the betting system)
  active_bettor      INTEGER DEFAULT 0,     -- 1 = participates in daily bets
  starting_bankroll  REAL    DEFAULT 5000,  -- their starting paper/real bankroll ($)
  daily_risk_pct     REAL    DEFAULT 0.20,  -- fraction of bankroll to risk per day
  paper              INTEGER DEFAULT 1,     -- 1 = paper only, 0 = live trading
  kalshi_key_id      TEXT,                  -- Kalshi API key ID (RSA auth)
  kalshi_private_key TEXT,                  -- Kalshi RSA private key (PEM format)
  discord_webhook    TEXT                   -- personal Discord webhook for EOD reports
);

-- Add betting profile columns to users (safe no-ops if columns already exist)
ALTER TABLE users ADD COLUMN active_bettor      INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN starting_bankroll  REAL    DEFAULT 5000;
ALTER TABLE users ADD COLUMN daily_risk_pct     REAL    DEFAULT 0.20;
ALTER TABLE users ADD COLUMN paper              INTEGER DEFAULT 1;
ALTER TABLE users ADD COLUMN kalshi_key_id      TEXT;
ALTER TABLE users ADD COLUMN kalshi_private_key TEXT;
ALTER TABLE users ADD COLUMN discord_webhook       TEXT;
ALTER TABLE users ADD COLUMN live_daily_risk_pct  REAL DEFAULT 0.10;
ALTER TABLE users ADD COLUMN kalshi_pnl           REAL DEFAULT NULL;

-- ========================================================================
-- ks_bets: Kalshi strikeout bet ledger (paper + live)
-- ========================================================================
CREATE TABLE IF NOT EXISTS ks_bets (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  bet_date         TEXT NOT NULL,
  logged_at        TEXT NOT NULL,
  pitcher_id       TEXT,
  pitcher_name     TEXT NOT NULL,
  team             TEXT,
  game             TEXT,
  strike           INTEGER NOT NULL,
  side             TEXT NOT NULL,
  model_prob       REAL NOT NULL,
  market_mid       REAL,
  edge             REAL NOT NULL,
  lambda           REAL,
  k9_career        REAL,
  k9_season        REAL,
  k9_l5            REAL,
  opp_k_pct        REAL,
  adj_factor       REAL,
  n_starts         INTEGER,
  confidence       TEXT,
  savant_k_pct     REAL,
  savant_whiff     REAL,
  savant_fbv       REAL,
  whiff_flag       TEXT,
  ticker           TEXT,
  bet_size         REAL DEFAULT 100,
  kelly_fraction   REAL,
  capital_at_risk  REAL,
  paper            INTEGER DEFAULT 1,
  live_bet         INTEGER DEFAULT 0,
  actual_ks        INTEGER,
  result           TEXT,
  settled_at       TEXT,
  pnl              REAL,
  park_factor      REAL,
  weather_mult     REAL,
  ump_factor       REAL,
  ump_name         TEXT,
  velo_adj         REAL,
  velo_trend_mph   REAL,
  bb_penalty       REAL,
  raw_adj_factor   REAL,
  spread           REAL,
  raw_model_prob   REAL,
  order_id         TEXT,
  fill_price       REAL,
  filled_at        TEXT,
  filled_contracts INTEGER,
  order_status     TEXT,
  user_id          INTEGER REFERENCES users(id),
  model            TEXT DEFAULT 'mlb_strikeouts',
  open_interest    INTEGER,
  UNIQUE(bet_date, pitcher_name, strike, side, live_bet, user_id)
);
CREATE INDEX IF NOT EXISTS idx_ks_bets_date      ON ks_bets(bet_date);
CREATE INDEX IF NOT EXISTS idx_ks_bets_pitcher   ON ks_bets(pitcher_id);
CREATE INDEX IF NOT EXISTS idx_ks_bets_result    ON ks_bets(result);
CREATE INDEX IF NOT EXISTS idx_ks_bets_user      ON ks_bets(user_id);
CREATE INDEX IF NOT EXISTS idx_ks_bets_model     ON ks_bets(model);
CREATE INDEX IF NOT EXISTS idx_ks_bets_composite ON ks_bets(bet_date, live_bet, paper, user_id);

-- Backfill new ks_bets columns for existing databases (safe no-ops)
ALTER TABLE ks_bets ADD COLUMN user_id          INTEGER REFERENCES users(id);
ALTER TABLE ks_bets ADD COLUMN model            TEXT DEFAULT 'mlb_strikeouts';
ALTER TABLE ks_bets ADD COLUMN open_interest    INTEGER;

-- ========================================================================
-- nba_games: one row per NBA game (today's slate)
-- ========================================================================
CREATE TABLE IF NOT EXISTS nba_games (
  id          TEXT PRIMARY KEY,   -- e.g. '26APR25DENMIN'
  game_date   TEXT NOT NULL,
  game_time   TEXT,               -- HH:MM ET
  team_away   TEXT NOT NULL,      -- e.g. 'DEN'
  team_home   TEXT NOT NULL,      -- e.g. 'MIN'
  kalshi_event TEXT,              -- e.g. 'KXNBATOTAL-26APR25DENMIN'
  season      TEXT DEFAULT '2025-26',
  status      TEXT DEFAULT 'scheduled',
  actual_total INTEGER            -- filled at settlement
);
CREATE INDEX IF NOT EXISTS idx_nba_games_date ON nba_games(game_date);

-- ========================================================================
-- nba_team_stats: rolling team ratings (OffRtg, DefRtg, Pace)
-- ========================================================================
CREATE TABLE IF NOT EXISTS nba_team_stats (
  team_id     TEXT NOT NULL,
  stat_date   TEXT NOT NULL,
  window      TEXT NOT NULL,      -- 'season' | 'last10'
  season_type TEXT DEFAULT 'Playoffs',
  off_rtg     REAL,
  def_rtg     REAL,
  pace        REAL,
  pts_pg      REAL,
  opp_pts_pg  REAL,
  PRIMARY KEY (team_id, stat_date, window)
);
CREATE INDEX IF NOT EXISTS idx_nba_team_stats ON nba_team_stats(team_id, stat_date);

-- ========================================================================
-- nba_ref_assignments: referee → foul adjustment per game
-- ========================================================================
CREATE TABLE IF NOT EXISTS nba_ref_assignments (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  game_date             TEXT NOT NULL,
  game_id               TEXT NOT NULL,
  away_team             TEXT NOT NULL,
  home_team             TEXT NOT NULL,
  ref_id                TEXT NOT NULL,
  ref_name              TEXT,
  career_fouls_per_game REAL,
  career_fta_per_game   REAL,
  career_pts_per_game   REAL,
  foul_adj              REAL DEFAULT 0,
  fetched_at            TEXT DEFAULT (datetime('now')),
  UNIQUE(game_date, game_id, ref_id)
);
CREATE INDEX IF NOT EXISTS idx_nba_refs_date ON nba_ref_assignments(game_date);

-- ========================================================================
-- nba_player_3pt_stats: player 3PT shooting stats (season + last5)
-- ========================================================================
CREATE TABLE IF NOT EXISTS nba_player_3pt_stats (
  player_id   TEXT NOT NULL,
  player_name TEXT NOT NULL,
  stat_date   TEXT NOT NULL,
  window      TEXT NOT NULL,
  season_type TEXT DEFAULT 'Playoffs',
  team_id     TEXT,
  gp          INTEGER,
  minutes_pg  REAL,
  fg3a_pg     REAL,
  fg3m_pg     REAL,
  fg3_pct     REAL,
  PRIMARY KEY (player_id, stat_date, window)
);
CREATE INDEX IF NOT EXISTS idx_nba_3pt_player ON nba_player_3pt_stats(player_id, stat_date);

-- ========================================================================
-- nba_opp_3pt_defense: how many 3s each team allows per game
-- ========================================================================
CREATE TABLE IF NOT EXISTS nba_opp_3pt_defense (
  team_id     TEXT NOT NULL,
  stat_date   TEXT NOT NULL,
  season_type TEXT DEFAULT 'Playoffs',
  opp_fg3a_pg REAL,
  opp_fg3m_pg REAL,
  opp_fg3_pct REAL,
  PRIMARY KEY (team_id, stat_date)
);

-- ========================================================================
-- agent_heartbeat: status pings from The Closer Windows agent
-- ========================================================================
CREATE TABLE IF NOT EXISTS agent_heartbeat (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TEXT
);

-- ========================================================================
-- balance_snapshots: opening balance per user per day (ET date)
-- Captured by ksBets.js before placing bets. Used for today_pnl:
--   today_pnl = current_kalshi_balance - opening_balance_usd
-- ========================================================================
CREATE TABLE IF NOT EXISTS balance_snapshots (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL,
  date         TEXT NOT NULL,
  balance_usd  REAL,
  cash_usd     REAL,
  exposure_usd REAL,
  captured_at  TEXT,
  UNIQUE(user_id, date)
);
CREATE INDEX IF NOT EXISTS idx_balance_snapshots_user ON balance_snapshots(user_id, date);

-- ========================================================================
-- daily_pnl_events: per-market settlement records for real-time P&L
-- One row per (user, date, ticker). Populated by WS market_position events
-- and backfilled from REST settlements API on server startup.
-- ========================================================================
CREATE TABLE IF NOT EXISTS daily_pnl_events (
  user_id    INTEGER NOT NULL,
  date       TEXT NOT NULL,
  ticker     TEXT NOT NULL,
  pnl_usd    REAL NOT NULL,
  settled_at TEXT,
  PRIMARY KEY (user_id, date, ticker)
);

CREATE TABLE IF NOT EXISTS live_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         TEXT    NOT NULL DEFAULT (datetime('now')),
  bet_date   TEXT    NOT NULL,
  level      TEXT    NOT NULL DEFAULT 'info',   -- info | warn | error
  tag        TEXT    NOT NULL,                  -- BET | COVER | DEAD | SETTLED | PULLED | ERROR | STARTUP
  msg        TEXT    NOT NULL,
  pitcher    TEXT,
  strike     INTEGER,
  side       TEXT,
  edge_cents REAL,
  pnl        REAL
);
CREATE INDEX IF NOT EXISTS live_log_date ON live_log(bet_date, ts);

-- bet_mode: 'normal' (edge-based maker) | 'pulled' (free money taker)
ALTER TABLE ks_bets ADD COLUMN bet_mode TEXT DEFAULT 'normal';

-- ========================================================================
-- bet_schedule: per-game scheduled bet entries (T-2.5h before first pitch)
-- Built by ksBets.js build-schedule at 9am. Polled every 5min by scheduler.
-- ========================================================================
CREATE TABLE IF NOT EXISTS bet_schedule (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  bet_date     TEXT NOT NULL,
  game_id      TEXT NOT NULL,
  game_label   TEXT NOT NULL,
  pitcher_id   TEXT NOT NULL,
  pitcher_name TEXT NOT NULL,
  pitcher_side TEXT NOT NULL,          -- 'home' | 'away'
  game_time    TEXT NOT NULL,          -- ISO first-pitch timestamp
  scheduled_at TEXT NOT NULL,          -- game_time - 2.5h ISO
  status       TEXT NOT NULL DEFAULT 'pending',  -- pending | fired | skipped | checking
  fired_at     TEXT,
  preflight    TEXT,                             -- 'proceed'|'skip'|'boost' from AI check
  notes        TEXT,                             -- reason from preflight check
  UNIQUE(bet_date, game_id, pitcher_id)
);
CREATE INDEX IF NOT EXISTS idx_bet_schedule_date ON bet_schedule(bet_date, status);

-- ========================================================================
-- dk_k_props: DraftKings/FanDuel pitcher K prop lines (fetched 2x daily)
-- Used by preflight check to compare model λ vs sharp market consensus.
-- ========================================================================
CREATE TABLE IF NOT EXISTS dk_k_props (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  prop_date    TEXT NOT NULL,
  pitcher_name TEXT NOT NULL,
  dk_line      REAL NOT NULL,       -- K over/under line (e.g. 7.5)
  over_price   REAL,                -- implied probability of over
  book         TEXT,                -- 'draftkings'|'fanduel'|'betmgm'
  fetched_at   TEXT DEFAULT (datetime('now')),
  UNIQUE(prop_date, pitcher_name)
);
