# MLBIE — Status

**Last updated**: April 15-16, 2026 (design session + build session)
**Phase**: Architecture updated — awaiting historical data fetch before model training
**Market**: MLB full-game totals on Kalshi (`KXMLBTOTAL-*` series)

---

## What Changed in the April 15 Design Session

Major architecture changes applied to all framework documents. Summary:

1. **MEM agent added** (Agent 6 of 7, between Market and Judge) — timing/execution gatekeeper
2. **Distribution-first model** — XGBoost regressor + negative binomial replaces pure binary classifier
3. **Bullpen sub-model upgraded** — from aggregate ERA to per-reliever availability engine spec (V2; V1 keeps team aggregate)
4. **Quarter-Kelly for Phase 1** — replaced half-Kelly initial deployment
5. **Edge framing corrected** — 2-4% net durable (not "4-8% persistent")
6. **Timestamp purity required** — all backtest features must be tagged with availability timestamp
7. **Convergence data collection = P0** — start collecting Kalshi price snapshots immediately
8. **Additional validation requirements** — calibration reliability curves, segment stability, ablation tests, net-of-friction simulation

All framework docs (CLAUDE.md, AGENTS.md, MODEL.md, BACKLOG.md, DECISIONS.md, DATA.md) updated to reflect these changes.

---

## What's Been Built (April 16, 2026 build session)

### Core infrastructure
- [x] **`db/schema.sql`** — all tables including historical, bullpen, convergence, MEM decisions
- [x] **`lib/db.js`** — getClient, migrate, all domain helpers
- [x] **`lib/features.js`** — 95-feature vector (Groups A-I)
- [x] **`lib/kalshi.js`** — RSA-PSS auth, findMarket, placeOrder, getPortfolio, ticker builder
- [x] **`lib/model.js`** — predictGame, positionSize helpers

### Agents (all built)
- [x] **`agents/scout/`** — signals.js + index.js, full-game ERA, TTO3 penalty
- [x] **`agents/lineup/`** — signals.js + index.js, runs_pg_14d, lob_pct_14d
- [x] **`agents/bullpen/`** — signals.js + index.js, 14-day team aggregate
- [x] **`agents/park/`** — index.js + venues.js (all 30 stadiums)
- [x] **`agents/storm/`** — index.js + encoding.js (wind convention correct)
- [x] **`agents/market/`** — index.js + lines.js
- [x] **`agents/judge/`** — index.js (quarter-Kelly wired via KELLY_MULTIPLIER env)
- [ ] **`agents/mem/`** — NOT YET BUILT (design only, spec in AGENTS.md)

### Pipeline
- [x] **`pipeline/orchestrate.js`** — Scout+Lineup+Bullpen parallel, full run sequence
- [x] **`pipeline/execute.js`** — Kalshi execution adapter
- [x] **`pipeline/fetch.js`** — master data ingestion
- [x] **`pipeline/scheduler.js`** — cron-based scheduling

### Historical pipeline
- [x] **`scripts/historical/fetchGames.js`** — 2020-2025 game results
- [x] **`scripts/historical/fetchOdds.js`** — Odds API historical endpoint
- [x] **`scripts/historical/fetchPitcherStats.js`** — rolling pitcher features AS-OF game date
- [x] **`scripts/historical/fetchTeamOffense.js`** — rolling 14d team offense
- [x] **`scripts/historical/fetchBullpen.js`** — rolling 14d bullpen
- [x] **`scripts/historical/fetchWeather.js`** — Open-Meteo archive
- [x] **`scripts/historical/buildFeatureMatrix.js`** — assembles CSV
- [x] **`scripts/historical/validate.js`** — null rate, target balance, line distribution
- [x] **`cli.js`** — all commands including `historical`

### Model
- [x] **`models/train.py`** — XGBoost binary classifier (baseline), walk-forward folds
- [x] **`models/predict.py`** — subprocess inference, SHAP output
- [x] **`models/evaluate.py`** — calibration curves, edge analysis
- [ ] **Distribution model** — NOT YET BUILT (architecture defined in MODEL.md)

### Server + Auth
- [x] **`server/index.js`** — Express app, gated routes
- [x] **`server/auth.js`** — PIN auth (adam/1031, isaiah/49994)
- [x] **`public/login.html`** — PIN form
- [x] **`public/index.html`** — dashboard
- [x] **`.env`** — all keys configured

---

## What's Next (correct sequence)

### Immediate (before model training)
1. **Start convergence data collection** — add `convergence_log` table to schema, wire Kalshi price snapshots into fetch.js schedule (BACKLOG P05-001)
2. **Run historical data fetch** — 2020-2025, cached and resumable:
   ```bash
   node cli.js historical --season 2020-2025 --stage games
   node cli.js historical --season 2020-2025 --stage odds
   node cli.js historical --season 2020-2025 --stage pitchers
   node cli.js historical --season 2020-2025 --stage team-offense
   node cli.js historical --season 2020-2025 --stage bullpen
   ```
3. **Timestamp purity audit** — verify no lookahead in historical features (BACKLOG P4-001)

### Then
4. **Build feature matrix**: `node cli.js historical --season 2020-2025 --build-matrix`
5. **Validate**: `node cli.js historical --validate`
6. **Train baseline model**: `node cli.js train --csv data/feature_matrix_all.csv`
7. **Build distribution model**: implement regressor + NB in train.py (BACKLOG P5-002)
8. **Compare all four models** — pick best ensemble (BACKLOG P5-003)
9. **Segment stability + ablation tests** (BACKLOG P5-004, P5-005)
10. **Net-of-friction simulation** (BACKLOG P5-006)
11. **Build MEM agent** (BACKLOG P55-001 through P55-005)
12. **Backtest 2025**: `node cli.js backtest --season 2025`
13. **6-week paper trading** (DEC-010, cannot be skipped)
14. **Live Kalshi execution** (quarter-Kelly, Phase 1)

---

## Open Questions

### Architecture
- **MEM W1-W5 weights**: Currently hardcoded (DEC-020). Need 500+ convergence data points to calibrate. What are reasonable initial weights vs what the data will tell us?
- **Negative binomial fit at extremes**: Coors Field games (expected total ~11-12 runs) and low-scoring pitcher duels have different overdispersion. Should fit parameters vary by park environment?
- **Distribution model per-team vs combined**: Fitting home + away runs separately then summing vs fitting the total directly. Does the correlation between them matter?

### Data
- **Kalshi ticker half-run encoding**: We derived `KXMLBTOTAL-26APR161310KCDET-7` for a line of 7.0. How does 7.5 encode? Current guess: `75` (strip decimal). Must confirm with live market query before first execution.
- **TTO3 source accuracy**: fetchPitcherStats.js approximates TTO3 penalty. For production-grade values, need Baseball Savant TTO leaderboard scrape.
- **Fangraphs scraping stability**: If Fangraphs changes their HTML structure, the scraper breaks. What's the fallback if this data source goes dark?

### Execution
- **MEM YELLOW re-poll**: When velocity is high (market correcting fast) but edge exists, MEM returns YELLOW. Re-check in 10 minutes, max 3 tries. Is 10 minutes the right interval?
- **Late market trades**: < 90min pre-game, only if sudden news event. How do we detect "sudden news event" automatically (SP scratch tweet, weather alert)?

### Validation
- **How many games needed for segment stability?**: With 5 seasons × ~30 high-confidence signals per season = ~150 signals. Is that enough to check April vs August performance or park environment separately? Probably not — may need to relax segment-level confidence requirements.
- **Paper trading start date**: Can we begin paper trading while backtest validation is still running, or must backtest fully complete first?

---

## Known Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Kalshi ticker format mis-encoded | Medium | Verify with listMarkets() on real game before first live trade |
| Historical Odds API credits burn fast | Medium | Aggressive per-date disk cache; snapshots only fetched once |
| Open-Meteo archive rate limits | Low | Free tier, per-venue/date cache |
| MEM weights miscalibrated initially | High (first 500 trades) | Quarter-Kelly sizing provides buffer; weights will be refined |
| Edge doesn't survive friction | Medium | Net-of-friction simulation required before deployment (BACKLOG P5-006) |
| Bullpen aggregate too noisy | Medium | Ablation test (BACKLOG P5-005) will catch this; per-reliever V2 is the fix |
| Negative binomial fit degrades at extremes | Low-Medium | Monitor Brier score separately for Coors/low-scoring games |
| Lookahead bias in historical features | Medium | Timestamp purity audit (BACKLOG P4-001) before training |
