# MLBIE — Backlog

**Last updated**: April 15, 2026 (design session)
**Format**: Priority order. Do not skip items. Do not reorder without updating DECISIONS.md.

---

## Phase 0 — Foundation (COMPLETE)

- [x] P0-001: Database schema — historical + live tables, Kalshi fields
- [x] P0-002: Data pipeline scaffolding — fetch.js structure
- [x] P0-003: Historical data pipeline — fetchGames, fetchOdds, fetchPitcherStats, fetchTeamOffense, fetchBullpen, fetchWeather, buildFeatureMatrix, validate
- [x] P0-004: Full-game pivot — F5 → full-game on all agents, db, features
- [x] P0-005: 95-feature vector (Groups A-I)
- [x] P0-006: Kalshi REST client (RSA-PSS auth)
- [x] P0-007: Auth layer (PIN-based, two users)
- [x] P0-008: Web dashboard scaffolding

---

## Phase 0.5 — Convergence Data Collection (P0 — START IMMEDIATELY)

This is the highest-priority data task. Cannot be backdated. Starts now.

### P05-001: Kalshi price snapshots — live collection
**Status**: Not started
**Description**: For every MLB game from now on, capture Kalshi price at multiple timestamps before first pitch.

Schema (add to DB):
```sql
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
  convergence_trigger TEXT,  -- lineup|weather|sharp_money|unknown
  captured_at TEXT DEFAULT (datetime('now'))
);
```

Trigger: Run at game open, -6hr, -2hr, -30min, -0. Integrated into the `fetch.js` schedule.

**Success target**: 500 entries. At that point, MEM's W1-W5 weights can be calibrated empirically.

### P05-002: Convergence analysis query
**Status**: Not started
**Description**: Once 100+ entries exist, run:
```sql
-- Average time-to-convergence by edge magnitude bucket
SELECT
  ROUND(ABS(kalshi_price_open - sportsbook_implied_open) / 0.02) * 0.02 AS edge_bucket,
  AVG(time_to_convergence_min) AS avg_convergence_min,
  COUNT(*) AS n
FROM convergence_log
GROUP BY edge_bucket ORDER BY edge_bucket;
```
Output tells you exactly where your trading window is.

---

## Phase 1 — Scout Agent (BUILT — needs validation)

### P1-004: Scout validation against historical data
**Status**: Not started — depends on Phase 3 (historical fetch complete)
**Description**: Validate Scout quality scores predict full-game runs allowed better than ERA alone.

Target: r² > 0.20 between Scout score and actual full-game runs allowed per starter.
Baseline: r² of raw ERA alone (expect ~0.12).

---

## Phase 2 — Lineup Agent (BUILT — needs validation)

### P2-004: LOB% and runs_pg_14d cold start validation
**Status**: Not started
**Description**: Verify cold-start fallback (league average) doesn't introduce systematic bias in first-season predictions.

---

## Phase 3 — Historical Data Fetch (P0 — NEXT ACTION)

### P3-001: Run full 2020-2025 historical pipeline
**Status**: Not started
**Description**: Execute in order. Each stage is cached — can be resumed if interrupted.

```bash
node cli.js historical --season 2020-2025 --stage games
node cli.js historical --season 2020-2025 --stage odds
node cli.js historical --season 2020-2025 --stage pitchers
node cli.js historical --season 2020-2025 --stage team-offense
node cli.js historical --season 2020-2025 --stage bullpen
node cli.js historical --season 2020-2025 --build-matrix
node cli.js historical --validate
```

Expected runtime: 2-4 hours (API throttling + caching)

**Checkpoint**: After `--stage games`, verify:
```sql
SELECT season, COUNT(*) FROM historical_games GROUP BY season ORDER BY season;
-- Expect ~2,400-2,500 per season
```

---

## Phase 4 — Timestamp Purity Audit (P0 — before model training)

### P4-001: Tag all historical features with availability timestamps
**Status**: Not started — design session requirement (DEC-022)
**Description**: Every feature used in the training matrix must be verified as available at decision time.

**Audit checklist**:
- [ ] Pitcher stats (as-of game date — fetchPitcherStats.js computes rolling, must verify no future data bleeds)
- [ ] Team offense stats (14-day rolling as-of game date — same verification)
- [ ] Bullpen stats (rolling — same)
- [ ] Weather data (historical first-pitch weather — Open-Meteo, should be clean)
- [ ] Line data (opening line only — fetchOdds.js uses first available snapshot)
- [ ] Lineup (not applicable for historical — use actual lineup from game record, which is pre-game data)

**Verification query**:
```sql
-- For each game, verify pitcher stats record date <= game date
SELECT COUNT(*) FROM historical_pitcher_stats hps
JOIN historical_games hg ON hps.pitcher_id = hg.home_pitcher_id
WHERE hps.as_of_date > hg.date;
-- Should be 0
```

---

## Phase 5 — Model Training (P1)

### P5-001: Train baseline binary classifier
**Status**: Not started
**Description**: Run `node cli.js train --csv data/feature_matrix_all.csv`. Report Brier score and calibration curves per validation fold.

### P5-002: Train XGBoost regressor + negative binomial distribution model
**Status**: Not started
**Description**: Implement distribution model in train.py. Per-team expected runs → NB fit → threshold probability.

### P5-003: Compare all four model architectures
**Status**: Not started
**Description**: Run all four (DEC-021). Report on same validation folds:
- Brier score
- Log loss
- Calibration reliability (per 5% bucket)
- Net-of-friction ROI at 6% edge threshold

### P5-004: Segment stability checks
**Status**: Not started
**Description**: Required before any deployment (DEC-021). Check performance across:
- Month of season (April vs August)
- Park environment (high vs low run)
- Total line band (7.5 vs 9.5)
- Weather regime (indoor vs outdoor, hot vs cold)

If edge only exists in one segment → it's noise. Do not deploy.

### P5-005: Ablation tests
**Status**: Not started
**Description**: Remove each feature group (A-I) one at a time. Measure Brier score change.

If removing a group improves performance → that group is adding noise → drop it.
If removing weather has zero effect → weather signal isn't working → investigate.

### P5-006: Net-of-friction simulation
**Status**: Not started
**Description**: Apply realistic Kalshi fee (1-2 cents per contract round trip) + spread + slippage to every backtested trade.

If gross edge is 3% and friction is 2% → net edge 1% → not worth deploying. Report net ROI separately.

---

## Phase 5.5 — MEM Agent Build (P1 — required before execution)

### P55-001: MEM agent implementation
**Status**: Not started
**Description**: Build `agents/mem/index.js` with the five metrics: edge_raw, gap_consensus, velocity, liquidity_score, time_decay_penalty. Compute TQS. Return traffic light GREEN/YELLOW/RED.

**Depends on**: Kalshi price polling (lib/kalshi.js `getContractPrice()`) and The Odds API current sportsbook consensus line.

### P55-002: Velocity window — price snapshot polling
**Status**: Not started
**Description**: Price velocity requires comparing current Kalshi price to price 15 minutes ago. Add a `kalshi_price_snapshots` table and a polling job that writes a snapshot every 15 minutes for all active markets.

```sql
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

### P55-003: Liquidity score implementation
**Status**: Not started
**Description**: Kalshi order book depth / bid-ask spread. Requires Kalshi order book API endpoint. If not available, use bid-ask spread alone as liquidity proxy.

### P55-004: MEM weight calibration
**Status**: Deferred until 500+ convergence data points
**Description**: Calibrate W1-W5 from actual convergence data. Initial weights hardcoded (DEC-020).

### P55-005: YELLOW → re-poll loop
**Status**: Not started
**Description**: When MEM returns YELLOW (edge exists but velocity high), implement re-check in 10 minutes. Max 3 re-checks per game before dropping.

---

## Phase 6 — Judge Agent (BUILT — needs MEM integration)

### P6-004: Wire MEM → Judge hard disqualifier
**Status**: Not started
**Description**: Add `mem.decision !== 'GREEN'` as hard disqualifier in Judge. Already in spec, needs implementation.

---

## Phase 7 — Backtest Validation (P1)

### P7-001: Walk-forward backtest runner
**Status**: Not started
**Description**: `node cli.js backtest --season 2025` — run orchestrator over 2025 games with trained model. Report edge analysis.

**Critical**: Backtest must respect timestamp purity (DEC-022). Use decision_time-5min rule for all features.

### P7-002: Calibration reliability diagrams
**Status**: Not started
**Description**: Required before paper trading. Plot predicted probability vs actual outcome rate in 5% buckets. Must track within 3% in each bucket.

### P7-003: Net-of-friction ROI confirmation
**Status**: Not started
**Description**: If gross edge doesn't survive fee simulation → do not proceed to paper trading.

---

## Phase 8 — Paper Trading (P1 — gated by Phase 7)

### P8-001: Paper trading mode validation
**Status**: Not started
**Description**: Run full live pipeline with `--dry-run` flag. Minimum 6 weeks, 300+ paper trades.

Success criteria (DEC-010):
- Win rate >53% on signals with edge >5%
- Calibration tracking within 3% of backtest
- Zero systematic pipeline failures
- 300+ paper trades logged

### P8-002: Convergence data capture integration
**Status**: Not started
**Description**: While paper trading, capture all MEM decision logs (GREEN/YELLOW/RED) plus outcomes. This builds the convergence dataset for V2 MEM calibration (DEC-023).

---

## Phase 9 — Live Execution (gated by Phase 8)

### P9-001: Kalshi live execution validation
**Status**: Not started
**Description**: $25 per trade (MIN_BET), execution confirmation loop, Kalshi ticker verification.

First trade checklist:
- [ ] Verify `buildTicker()` output matches live Kalshi series
- [ ] Confirm `getBalance()` returns expected amount
- [ ] Confirm `placeOrder()` returns order ID (paper buy first — use sandbox if available)
- [ ] Confirm `getPosition()` reflects the trade

### P9-002: Set KELLY_MULTIPLIER=0.25 for Phase 1
**Status**: Not started
**Description**: Ensure quarter-Kelly is active for first 200 trades. Upgrade requires manual review.

---

## Phase 10 — V2 Improvements

### V2-001: MEM Edge Half-Life Model
**Status**: Deferred — needs 500+ convergence data points
**Description**: Train a model on convergence data: given edge magnitude + time_to_game + velocity, predict probability edge still exists in X minutes.

### V2-002: Per-reliever availability engine (Bullpen upgrade)
**Status**: Deferred
**Description**: Upgrade Bullpen from 14-day team aggregate to per-reliever availability scoring (pitches last 3 days, back-to-back, leverage yesterday).

### V2-003: Manager behavior model
**Status**: Deferred
**Description**: Per-manager: back-to-back tolerance, closer threshold, high-leverage usage rate.

### V2-004: Umpire agent
**Status**: Deferred
**Description**: Home plate umpire strike zone size (Baseball Savant). ~0.3-0.5 run effect. Add after core validated.

### V2-005: ONNX model export
**Status**: Deferred
**Description**: Remove Python subprocess dependency. After initial model proves edge.

---

## Data Sources Reference

| Source | Data | Cost | API |
|---|---|---|---|
| Baseball Savant | Statcast, pitcher metrics | Free | REST |
| Fangraphs | FIP, xFIP, wRC+, splits | Free | Scrape |
| Baseball-Reference | Historical game logs, splits | Free | Scrape |
| MLB Stats API | Schedule, lineups, results, linescore | Free | REST |
| Open-Meteo | Historical weather archive | Free | REST |
| OpenWeather | Live forecast | Free tier | REST |
| The Odds API | Live + historical lines | ~$50/mo | REST |
| Kalshi | Contract prices, order book | Free | REST (RSA auth) |
| Rotowire | Daily lineups | Free | Scrape |
