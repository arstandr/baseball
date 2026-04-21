# MLBIE — Decisions Log

**Format**: Each decision records what was decided, why, and what alternatives were rejected.
**Rule**: Never change architecture without adding an entry here first.

---

## DEC-001: Target market — Full-game totals on Kalshi

**Date**: April 2026 (updated from original F5 framing)
**Decision**: Primary market is MLB full-game total runs on Kalshi (`KXMLBTOTAL-*` series).

**Rationale**:
- Kalshi's MLB totals product is full-game only; F5 is not listed
- Robinhood's F5 product runs on Kalshi's exchange infrastructure; if Kalshi doesn't list a market, neither does Robinhood
- Full-game liquidity is ~10x F5 liquidity, enabling larger per-trade sizing without moving the line
- Bullpen agent (DEC-019) covers the innings 6-9 variance that full-game introduces

**Alternatives rejected**:
- F5 totals: no execution venue on Kalshi
- Game winners: harder to model cleanly than scoring totals
- Player props: too many variables, lower volume, harder to automate

---

## DEC-002: Execution platform — Kalshi REST API

**Date**: April 2026
**Decision**: Primary execution target is Kalshi REST API (RSA-PSS auth, `KXMLBTOTAL-*` series).

**Rationale**:
- Confirmed $10 balance on Kalshi; full-game markets are live
- Clean REST API, no Puppeteer required
- Robinhood F5 was unavailable; Kalshi full-game is the right target

---

## DEC-003: Multi-agent architecture over monolithic model

**Date**: April 2026
**Decision**: Build seven specialized agents (Scout, Lineup, Bullpen, Park, Storm, Market, MEM, Judge) rather than a single monolithic model.

**Rationale**:
- Each domain has different data sources, update frequencies, and failure modes
- Agent independence means a failure in Storm doesn't break Scout
- Agent outputs are interpretable — you know which agent drove each trade
- Enables per-agent validation before full system integration
- Individual agents can be upgraded without destabilizing the whole system

**Alternatives rejected**:
- Single monolithic model: opaque, harder to debug, all-or-nothing failure modes
- Rules-only system: can't capture non-linear signal interactions
- Pure LLM prediction: non-deterministic, can't be backtested, no calibrated probabilities

---

## DEC-004: XGBoost in distribution-first architecture over pure classifier

**Date**: April 2026 (updated April 15, 2026)
**Decision**: XGBoost regressors (per-team runs) feed a negative binomial distribution, which produces threshold probability. XGBoost binary classifier retained as baseline comparison only.

**Rationale**:
- A binary classifier compresses a continuous run distribution into a noisy label, throwing away structural information
- A Kalshi total contract is a bet on whether runs exceed a specific threshold — the correct approach is to estimate a run distribution, then evaluate the threshold
- Negative binomial fits MLB run scoring better than Poisson (overdispersed: variance > mean)
- Four models are trained and compared; the best ensemble is deployed

**Four models to compare**:
1. XGBoost binary classifier (baseline)
2. XGBoost regressor → distribution mapping
3. Negative binomial count model
4. Ensemble of (2) + (3) with calibration layer

**Alternatives rejected**:
- Pure binary classifier: throws away distribution info
- Neural networks: require more data, less interpretable

---

## DEC-005: Quarter-Kelly initial deployment, half-Kelly after calibration

**Date**: April 2026 (updated April 15, 2026 — was half-Kelly)
**Decision**: Phase 1 live deployment uses quarter-Kelly. Upgrade to half-Kelly after 200+ live trades with calibration confirmed.

**Rationale**:
- Half-Kelly is too aggressive if probabilities are even slightly miscalibrated
- A model that says 60% but hits at 54% with half-Kelly will damage bankroll faster than flat betting
- Quarter-Kelly provides the safety margin needed during calibration
- Half-Kelly is optimal only when you trust the probabilities; you don't trust them until 200+ live trades prove it

**Kelly schedule**:
```
Phase 1: first 200 live trades → kelly_multiplier = 0.25
Phase 2: after calibration confirmed → kelly_multiplier = 0.5
Never: kelly_multiplier = 1.0
```

**Hard limits (both phases)**:
```
MIN_BET = $25
MAX_BET = bankroll * 0.03
```

**Alternatives rejected**:
- Half-Kelly from day one: too aggressive during calibration period
- Flat betting: leaves money on table when edge is high; oversizes when edge is low
- Full Kelly: optimal in theory, psychologically brutal, higher variance
- Martingale: mathematically seductive, practically catastrophic with correlated losses

---

## DEC-006: Walk-forward validation over random split

**Date**: April 2026
**Decision**: Use walk-forward (time-series) validation, never random train/test split.

**Rationale**:
- Random splits allow the model to train on future data — overstates real-world performance
- Walk-forward simulates exact deployment conditions

**Validation schedule**:
- Train 2020-2022 → validate 2023
- Train 2020-2023 → validate 2024
- Train 2020-2024 → validate 2025

---

## DEC-007: Claude API for qualitative interpretation only

**Date**: April 2026
**Decision**: Use Claude API (Haiku for high-frequency, Sonnet for synthesis) only for qualitative tasks — news interpretation, lineup change analysis, cross-signal synthesis, edge case reasoning.

**Claude is NOT used for**:
- Predicting game outcomes
- Generating probability estimates
- Replacing XGBoost numerical signals

---

## DEC-008: Python subprocess bridge for XGBoost

**Date**: April 2026
**Decision**: Call XGBoost and scipy via Python subprocess from Node.js.

**Rationale**:
- XGBoost + scipy (negative binomial) are Python libraries
- Node.js is the CLI runtime
- Subprocess bridge is simple and sufficient for 15-30 predictions per night

---

## DEC-009: Umpire agent deferred to V2

**Date**: April 2026
**Decision**: Umpire home plate assignment data deferred to V2 release.

**Rationale**: Core agents need validation first. Umpire signal is real (~0.3-0.5 run effect) but smaller than pitcher/lineup/weather/bullpen.

---

## DEC-010: Six-week paper trading minimum before live capital

**Date**: April 2026
**Decision**: Mandatory minimum six weeks of paper trading before any live execution.

**Go-live criteria**:
- Paper win rate >53% on high-confidence signals
- Calibration tracking within 3% of backtest
- Zero systematic pipeline failures
- 300+ paper trades logged

**This decision cannot be overridden.**

---

## DEC-011: Wind direction convention — bearing FROM, not TO

**Date**: April 2026 (implementation)
**Decision**: OpenWeather's `wind_deg` is the bearing the wind is COMING FROM.

**Implementation**:
```javascript
out_bearing = (park_orientation + 180) % 360
relative_angle = (wind_bearing - out_bearing + 360) % 360
// 0-45 or 315-360 → "out"; 135-225 → "in"; else → "crosswind"
```

---

## DEC-012: Feature vector has 95 features (Groups A-I)

**Date**: April 2026 (updated from 83 to 95 with bullpen + additional lineup features)
**Decision**: The actual feature vector contains 95 named features across groups A-I.

**Breakdown**:
- Group A (SP Home): 19 features
- Group B (SP Away): 19 features
- Group C (Lineup Home): 11 features
- Group D (Lineup Away): 11 features
- Group E (Park): 6 features
- Group F (Weather): 7 features
- Group G (Market): 6 features
- Group H (Interactions): 6 features
- Group I (Bullpen): 10 features
**Total: 95 features**

---

## DEC-013: Confidence multiplier floor at 0.5

**Date**: April 2026
**Decision**: The confidence multiplier in Judge cannot fall below 0.5.

**Rationale**: Without a floor, rare multi-agent penalty combinations could drive the multiplier near zero, making position sizing meaninglessly small while still technically approving a trade.

---

## DEC-014: runs_pg_14d computed from own outcomes table

**Date**: April 2026
**Decision**: `lu_h_runs_pg_14d` and `lu_a_runs_pg_14d` computed from MLBIE's own settled outcomes table. Falls back to league average (4.8 runs) during cold start.

---

## DEC-015: Paper mode uses TURSO_DATABASE_URL=file:./mlbie.db by default

**Date**: April 2026
**Decision**: When `TURSO_DATABASE_URL` is not set, system defaults to local SQLite via libSQL.

---

## DEC-016: Pivot from F5 to full-game totals on Kalshi

**Date**: April 16, 2026
**Decision**: Primary target market is now MLB full-game total runs on Kalshi. F5 retained as legacy path.

---

## DEC-017: Historical weather via Open-Meteo archive API

**Date**: April 16, 2026
**Decision**: Historical per-game weather from `archive.api.open-meteo.com`. Free, no key, back to 1940.

---

## DEC-018: Two-phase validation — historical backtest first, paper trading second

**Date**: April 16, 2026
**Decision**: Before any live execution:
1. Build full 2020-2025 historical feature matrix
2. Train on 2020-2024, validate on 2025
3. Demonstrate edge on validation
4. Then begin paper trading (DEC-010)

**This decision cannot be overridden.**

---

## DEC-019: Bullpen as the 7th agent (Group I, 95 features total)

**Date**: April 16, 2026
**Decision**: Bullpen agent added. 10 features (bp_ prefix). Full-game totals require bullpen coverage.

---

## DEC-020: MEM (Market Efficiency Monitor) as execution gatekeeper

**Date**: April 15, 2026 (design session)
**Decision**: Added MEM as the 8th component in the pipeline (Agent 6 of 7 agents, just before Judge). Judge only fires if MEM returns GREEN.

**What MEM measures**:
1. Price Gap (edge_raw)
2. Consensus Gap (Kalshi vs sharp sportsbook)
3. Convergence Velocity (how fast is Kalshi converging toward consensus)
4. Liquidity Score
5. Time-to-first-pitch decay

**Why**:
- Kalshi full-game total contracts converge toward sharp sportsbook consensus lines
- The exploitable window is minutes to hours, not persistent
- Without MEM, the system fires trades into already-corrected prices
- A valid probability estimate is not automatically a valid trade

**TQS (Trade Quality Score)**:
```
TQS = (edge_raw × W1) + (gap_consensus × W2) - (|velocity| × W3) + (liquidity × W4) - (decay × W5)
```

Initial weights: W1=0.35, W2=0.25, W3=0.20, W4=0.10, W5=0.10. Calibrated from convergence data.

**V2 upgrade**: Edge Half-Life Model — once 500+ convergence data points accumulated, predicts expected minutes until edge decays for given edge magnitude and market conditions.

**Alternatives rejected**:
- Time-based gates only: too crude, ignores velocity signal
- Price gate only: doesn't detect fast-moving markets about to close the gap
- No execution filter: fires into stale prices, destroys real edge with bad timing

---

## DEC-021: Distribution-first model replaces pure binary classifier

**Date**: April 15, 2026 (design session)
**Decision**: Replace XGBoost binary classifier as the sole model with a distribution-first architecture. XGBoost binary classifier retained as baseline comparison only.

**Correct framing**: A Kalshi total contract is a bet on whether runs exceed a specific threshold. The correct approach is to estimate a run distribution (negative binomial), then evaluate the threshold. A binary classifier compresses that distribution into a noisy label.

**New architecture**:
1. XGBoost regressor (per-team expected runs)
2. Negative binomial distribution fit
3. `P(total > threshold) = 1 - CDF(threshold)`
4. Isotonic regression calibration layer

**Four models tested**: binary classifier, XGBoost regressor + NB, pure NB count model, ensemble.

**Alternatives rejected**:
- Keep pure binary classifier: valid baseline but throws away distribution information
- Neural network: insufficient data for deep learning to outperform gradient boosting at this scale

---

## DEC-022: Timestamp purity required on all backtest features

**Date**: April 15, 2026 (design session)
**Decision**: Every feature in the training dataset must be tagged with its availability timestamp. The pipeline must enforce that no feature uses information unavailable at decision time.

**Why**:
- Lookahead bias is the most common source of false confidence in sports backtests
- A confirmed lineup, a line movement, or a weather reading from after the decision window would make the backtest fiction

**Implementation**:
- `available_at` timestamp on all feature records
- `decision_window` tag: `morning | midday | 2hr_pregame | 30min_pregame`
- Feature engineering pipeline enforces: `feature_value = value_as_of(decision_time - 5 minutes)`

**Scope**: Applies to all historical and live feature data. Not retroactively fixable — build correctly from the start.

---

## DEC-023: Convergence data collection is highest priority data task

**Date**: April 15, 2026 (design session)
**Decision**: Collecting Kalshi convergence data starts immediately — higher priority than model training.

**What to collect** (for every MLB game from now on):
```
game_id, game_date, total_line
kalshi_price_at_open
kalshi_price_at_6hr_pregame
kalshi_price_at_2hr_pregame
kalshi_price_at_30min_pregame
kalshi_price_at_game_start
sportsbook_consensus_at_each_timestamp
time_to_convergence_minutes
convergence_trigger (lineup|weather|sharp_money|unknown)
```

**Why**: Two weeks of this data shows exactly where the exploitable window lives and calibrates MEM's velocity weights. This data has no substitute — it cannot be backdated from historical sources because real-time Kalshi prices weren't captured.

---

## DEC-024: Honest edge framing — 2-4% net durable, not 4-8% persistent

**Date**: April 15, 2026 (design session)
**Decision**: All documentation uses correct edge framing.

**Correct framing**:
```
Gross edge on filtered signals:     4-8% (occasional, not sustained average)
Expected net durable edge:          2-4% (after Kalshi fees + spread + slippage)
Edge is time-sensitive — exists in a window, not persistently
```

**Why this matters for sizing**: Half-Kelly (or quarter-Kelly in Phase 1) on 2-3% net edge produces much smaller position sizes than half-Kelly on 6%. This is correct — appropriately conservative until live calibration proves actual edge magnitude.

**Old framing (incorrect)**: "retail users misprice things consistently; we build a better model and capture that."
**Correct framing**: "Kalshi prices are temporarily dislocated from true probability around specific information events. We detect those dislocations and execute before convergence closes the gap."
