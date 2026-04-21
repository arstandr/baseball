# MLBIE — Data Specification

**Last updated**: April 15, 2026 (design session)
**Philosophy**: Free data first. Pay only when the data provides edge that free sources don't.

---

## Data Sources

| Source | Data | Cost | Access | Update Frequency |
|---|---|---|---|---|
| Baseball Savant | Statcast, pitcher metrics | Free | REST API | Daily |
| Fangraphs | FIP, xFIP, wRC+, splits | Free | Scrape | Daily |
| Baseball-Reference | Historical logs, splits | Free | Scrape | Daily |
| MLB Stats API | Schedule, lineups, results, pitch counts | Free | REST API | Real-time |
| Open-Meteo Archive | Historical weather (2000+) | Free | REST API | Backfill |
| OpenWeather | Live forecast per venue | Free tier | REST API | Every 30min |
| The Odds API | Live + historical lines | ~$50/mo | REST API | Real-time |
| Kalshi | Contract prices, order book | Free | REST API (RSA auth) | Real-time |
| Rotowire | Daily confirmed lineups | Free | Scrape | 2hr pre-game |

**Total data cost: ~$50/month**

---

## Timestamp Purity Rule

Every feature record must include:
```sql
available_at TIMESTAMP NOT NULL   -- when this data was actually available
decision_window TEXT NOT NULL     -- morning|midday|2hr_pregame|30min_pregame
```

The feature engineering pipeline enforces:
```
feature_value = value_as_of(decision_time - 5 minutes)
```

No feature may use information unavailable at decision time. This is the most common source of false backtest confidence. Violations silently inflate all performance metrics.

---

## Convergence Tracking Schema (P0 — collect immediately)

This is the highest-priority data task. It cannot be backdated from historical sources. Collection starts now, with every MLB game.

```sql
-- Kalshi price convergence tracking
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
  convergence_trigger TEXT,    -- lineup|weather|sharp_money|unknown
  notes TEXT,
  captured_at TEXT DEFAULT (datetime('now'))
);

-- 15-minute Kalshi price snapshots (for velocity calculation)
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
```

**What two weeks of convergence data tells you**:
- Average minutes from market open to Kalshi-sportsbook consensus convergence
- How edge magnitude at open relates to time-to-convergence
- Which information events (lineup, weather, sharp money) trigger fastest convergence
- Whether the PRIMARY window (6hr-90min pre-game) is actually exploitable

**Target**: 500 entries before calibrating MEM weights. After 500, run:
```sql
SELECT
  ROUND(ABS(kalshi_price_open - sportsbook_implied_open) / 0.02) * 0.02 AS edge_bucket,
  AVG(time_to_convergence_min) AS avg_min_to_convergence,
  MIN(time_to_convergence_min) AS min_min,
  MAX(time_to_convergence_min) AS max_min,
  COUNT(*) AS n
FROM convergence_log
WHERE kalshi_price_open IS NOT NULL
GROUP BY edge_bucket
ORDER BY edge_bucket;
```

---

## Database Schema (Production)

```sql
-- Games: one row per MLB game
CREATE TABLE games (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  season INTEGER NOT NULL,
  game_time TEXT NOT NULL,
  status TEXT NOT NULL,              -- scheduled|in_progress|final|postponed
  venue_id TEXT NOT NULL,
  team_home TEXT NOT NULL,
  team_away TEXT NOT NULL,
  pitcher_home_id TEXT,
  pitcher_away_id TEXT,
  full_line_open REAL,               -- Opening full-game total
  full_line_current REAL,
  actual_runs_home INTEGER,
  actual_runs_away INTEGER,
  actual_runs_total INTEGER,
  kalshi_ticker TEXT,
  kalshi_order_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Pitcher signals: signal cache per pitcher per date
CREATE TABLE pitcher_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pitcher_id TEXT NOT NULL,
  pitcher_name TEXT NOT NULL,
  signal_date TEXT NOT NULL,
  available_at TEXT NOT NULL,         -- timestamp purity: when this data was available
  decision_window TEXT NOT NULL,      -- morning|midday|2hr_pregame
  hand TEXT NOT NULL,
  fip_weighted REAL,
  xfip_weighted REAL,
  swstr_pct REAL,
  gb_pct REAL,
  hard_contact_pct REAL,
  k9 REAL,
  bb9 REAL,
  fstrike_pct REAL,
  tto_penalty REAL,
  tto3_penalty REAL,                  -- full-game key metric
  era_l5 REAL,                        -- full-game ERA last 5 starts
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

-- Lineup signals
CREATE TABLE lineup_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id TEXT NOT NULL,
  game_id TEXT NOT NULL,
  signal_date TEXT NOT NULL,
  available_at TEXT NOT NULL,
  decision_window TEXT NOT NULL,
  vs_handedness TEXT NOT NULL,
  wrc_plus_14d REAL,
  wrc_plus_30d REAL,
  k_pct_14d REAL,
  hard_contact_14d REAL,
  iso_14d REAL,
  runs_pg_14d REAL,                   -- full-game runs per game
  lob_pct_14d REAL,
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

-- Bullpen signals
CREATE TABLE bullpen_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id TEXT NOT NULL,
  signal_date TEXT NOT NULL,
  available_at TEXT NOT NULL,
  decision_window TEXT NOT NULL,
  era_14d REAL,
  whip_14d REAL,
  k_pct_14d REAL,
  hr_per_9_14d REAL,
  inherited_score_pct REAL,
  raw_data_json TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(team_id, signal_date)
);

-- Venues: static park factors
CREATE TABLE venues (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  team TEXT NOT NULL,
  city TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  altitude_feet INTEGER DEFAULT 0,
  orientation_degrees INTEGER,
  roof_type TEXT NOT NULL,
  surface TEXT NOT NULL,
  lf_line_feet INTEGER,
  rf_line_feet INTEGER,
  cf_feet INTEGER,
  run_factor REAL DEFAULT 1.0,
  hr_factor REAL DEFAULT 1.0,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Weather: per-game weather at first pitch
CREATE TABLE weather (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id TEXT NOT NULL,
  venue_id TEXT NOT NULL,
  first_pitch_time TEXT NOT NULL,
  available_at TEXT NOT NULL,
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

-- Lines: opening and current lines with movement history
CREATE TABLE lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id TEXT NOT NULL,
  source TEXT NOT NULL,
  market_type TEXT NOT NULL,          -- full_game_total|f5_total (f5 retained for legacy)
  line_value REAL,
  over_price REAL,
  under_price REAL,
  is_opening INTEGER DEFAULT 0,
  movement_from_open REAL,
  efficiency_score REAL DEFAULT 1.0,
  sharp_signal TEXT,
  fetched_at TEXT DEFAULT (datetime('now'))
);

-- Projections: model output per game
CREATE TABLE projections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id TEXT NOT NULL,
  model_version TEXT NOT NULL,
  projected_total REAL,
  over_probability REAL,
  confidence_interval_low REAL,
  confidence_interval_high REAL,
  expected_home_runs REAL,           -- distribution model: per-team expected
  expected_away_runs REAL,
  distribution_n REAL,               -- negative binomial n parameter
  distribution_p REAL,               -- negative binomial p parameter
  feature_vector_json TEXT,
  shap_values_json TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(game_id, model_version)
);

-- MEM decisions: every evaluation, trade or not (convergence dataset)
CREATE TABLE mem_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id TEXT NOT NULL,
  evaluated_at TEXT NOT NULL,
  edge_raw REAL,
  gap_consensus REAL,
  velocity REAL,
  liquidity_score REAL,
  minutes_to_game REAL,
  time_window TEXT,                   -- EARLY|PRIMARY|LATE
  tqs REAL,
  decision TEXT NOT NULL,             -- GREEN|YELLOW|RED
  decision_reason TEXT,
  traded INTEGER DEFAULT 0,
  trade_id INTEGER REFERENCES trades(id)
);

-- Agent outputs
CREATE TABLE agent_outputs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id TEXT NOT NULL,
  agent TEXT NOT NULL,                -- scout|lineup|bullpen|park|storm|market|mem|judge
  output_json TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(game_id, agent)
);

-- Trades
CREATE TABLE trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id TEXT NOT NULL,
  trade_date TEXT NOT NULL,
  mode TEXT NOT NULL,                 -- paper|live
  side TEXT NOT NULL,                 -- OVER|UNDER
  line REAL NOT NULL,
  contract_price REAL NOT NULL,
  contracts INTEGER NOT NULL,
  position_size_usd REAL NOT NULL,
  model_probability REAL NOT NULL,
  market_implied_probability REAL NOT NULL,
  raw_edge REAL NOT NULL,
  adjusted_edge REAL NOT NULL,
  tqs REAL,
  confidence_multiplier REAL NOT NULL,
  kelly_multiplier REAL,              -- 0.25 or 0.5
  bankroll_at_trade REAL,
  kalshi_ticker TEXT,
  kalshi_order_id TEXT,
  primary_driver_agent TEXT,
  agent_attribution_json TEXT,
  explanation TEXT,
  executed_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Outcomes
CREATE TABLE outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_id INTEGER NOT NULL REFERENCES trades(id),
  game_id TEXT NOT NULL,
  actual_runs_total INTEGER,
  line REAL NOT NULL,
  result TEXT NOT NULL,               -- WIN|LOSS|PUSH|VOID
  pnl_usd REAL,
  settled_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(trade_id)
);

-- Model versions
CREATE TABLE model_versions (
  id TEXT PRIMARY KEY,
  trained_at TEXT NOT NULL,
  train_seasons TEXT NOT NULL,
  model_type TEXT,                    -- binary_classifier|regressor_nb|ensemble
  hyperparams_json TEXT,
  feature_importance_json TEXT,
  brier_score REAL,
  auc_roc REAL,
  val_win_rate_55 REAL,
  val_win_rate_60 REAL,
  val_roi_gross REAL,
  val_roi_net REAL,                   -- after simulated friction
  calibration_json TEXT,              -- reliability curve data per bucket
  ablation_json TEXT,                 -- Brier delta per feature group
  is_active INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
```

---

## Data Pipeline

### fetch.js — Master Ingestion Schedule

```
8:00 AM ET:   schedule + starters + Kalshi market open
12:00 PM ET:  lineups + stats refresh + Kalshi price snapshot
-6hr pre-game: weather + lines + Kalshi price snapshot
-2hr pre-game: weather + confirmed lineup + Kalshi price snapshot
-30min pre-game: final weather + line + Kalshi price snapshot + convergence log entry
+game_start:  Kalshi price snapshot (post-convergence baseline)
post-game:    settle outcomes from MLB linescore
```

### Data Fetchers (lib/ directory)

#### savant.js — Baseball Savant Statcast
- SwStr%, GB%, hard contact%, exit velo, spin rate per pitcher
- Per pitcher per season, last 30/14/7 day windows

#### fangraphs.js — Fangraphs
- FIP, xFIP, K%, BB%, GB%, F-Strike%, WHIP (pitcher leaderboard)
- wRC+, K%, ISO, BABIP by handedness (team offense)
- Cache daily — data updates slowly

#### bbref.js — Baseball-Reference
- Per-start stats including TTO splits (1st vs 2nd vs 3rd time through)
- Career stats at specific park

#### mlbapi.js — Official MLB Stats API
- Schedule, lineups, results, pitch counts
- Linescore by inning (for full-game and F5 actuals)
- Bullpen usage: game logs, pitcher appearances, pitch counts

#### weather.js — OpenWeather (live) + Open-Meteo (historical)
- Live: 3-hour forecast covering first pitch window
- Historical: archive endpoint for backfill (free, no key)

#### odds.js — The Odds API
- Current and historical full-game totals
- Opening + closing line capture
- Sportsbook consensus implied probability

#### kalshi.js — Kalshi REST API
- Contract prices (over/under implied probabilities)
- Order book depth (for liquidity score)
- Position management, order placement, portfolio

#### rotowire.js — Daily Lineups
- Confirmed batting orders per team, 2 hours before first game

---

## Bullpen Data Sources (per-reliever availability — V2)

V1 uses team-aggregate 14-day stats from MLB Stats API.

V2 per-reliever tracking requires:

| Data | Source | Availability |
|---|---|---|
| Pitcher appearances | MLB Stats API game logs | Free, real-time |
| Pitch counts per appearance | MLB Stats API boxscore | Free, real-time |
| xFIP / SIERA per reliever | Fangraphs leaderboard | Free, daily |
| k_bb_pct per reliever | Fangraphs / Savant | Free, daily |
| Leverage index (LI) | FanGraphs game logs | Free |

Implementation: For each team, pull all pitcher appearances from last 3 days. Separate starters from relievers. Sum pitch counts. Flag back-to-back and high-leverage appearances.

---

## Data Quality Rules

1. **Missing pitcher data**: <3 starts → confidence = 0.3. Use career averages with heavy uncertainty penalty. Do not fabricate stats.

2. **Weather API failure**: Retry 3x. If still failing, set weather score = 0.0 and log failure. Do not block trade evaluation.

3. **Line data missing**: Set market efficiency = 0.7 (penalized but not disqualified). Log failure.

4. **SP scratch timing**: No confirmed starter by 2hr before game → flag UNCERTAIN. Still unknown at 30min → disqualify.

5. **Stale lineup**: Confirmation not arrived by 90min before game → use projected lineup, change_adjustment = -0.1.

6. **Timestamp violations**: If any feature's `available_at` is after the decision time → exclude that game from training. Log the violation. Never fill forward with future data.

7. **Kalshi ticker mismatch**: If `buildTicker()` output doesn't match any live market → skip execution, log warning. Verify ticker format before first live trade.

---

## API Keys Required

```bash
# .env
ANTHROPIC_API_KEY=
ODDS_API_KEY=
OPENWEATHER_API_KEY=
KALSHI_KEY_PATH=./.kalshi_key.pem
KALSHI_KEY_ID=
TURSO_DATABASE_URL=file:./mlbie.db   # default for dev/paper
TURSO_AUTH_TOKEN=                    # leave blank for local file
SESSION_SECRET=
USER1_NAME=
USER1_PIN=
USER2_NAME=
USER2_PIN=
KELLY_MULTIPLIER=0.25                # Phase 1 default
```

---

## Venue Database — 30 Stadiums

Pre-populated at build time. Update run factors annually after season ends.

Key hitter parks:

| Venue | Run Factor | Altitude | Notes |
|---|---|---|---|
| Coors Field (COL) | 1.38 | 5,280ft | Most extreme — negative binomial variance inflated |
| Great American Ball Park (CIN) | 1.13 | 495ft | LF short |
| Globe Life Field (TEX) | 1.08 | 551ft | Warm, retractable dome |
| Wrigley Field (CHC) | 1.07 | 595ft | Wind-dependent — wx signal important |
| Fenway Park (BOS) | 1.05 | 20ft | Green Monster adds doubles |

Key pitcher parks:

| Venue | Run Factor | Notes |
|---|---|---|
| Petco Park (SD) | 0.89 | Marine layer suppresses scoring |
| Oracle Park (SF) | 0.91 | Marine layer, deep CF |
| Busch Stadium (STL) | 0.93 | Natural grass |
| Dodger Stadium (LAD) | 0.94 | Pitcher-friendly history |
