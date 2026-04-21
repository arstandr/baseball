# MLBIE — MLB Betting Intelligence Engine
## Project Governance Document

---

## What This Is

MLBIE is an automated, multi-agent prediction system targeting MLB full-game total run markets on Kalshi (`KXMLBTOTAL-*` series). It identifies games where the market's implied probability is temporarily dislocated from true probability — typically in a narrow window around specific information events — then executes trades before convergence closes the gap.

This is not a gambling system. It is a timing-aware probability estimation engine that deploys capital when it detects an exploitable dislocation that has not yet been priced in.

---

## Architecture Overview

```
Raw Data (Savant, Fangraphs, Weather, Odds, Kalshi)
        ↓
Feature Engineering Pipeline
        ↓
Agent Layer (7 specialized agents)
        ↓
Distribution Model (XGBoost regressor + negative binomial)
        ↓
MEM Agent (timing gate — is it still actionable right now?)
        ↓
Judge Agent (rules-based edge filter + position sizing)
        ↓
Orchestrator (CLI execution)
        ↓
Trade Execution + Outcome Logging
        ↓
Retraining Loop
```

---

## The Seven Agents

| Agent | Domain | AI Layer | Update Frequency |
|---|---|---|---|
| Scout | Starting pitcher intelligence | Claude Haiku (news) + XGBoost | Daily + real-time |
| Lineup | Offensive intelligence | Claude Haiku (lineup changes) + XGBoost | Daily + 2hr pre-game |
| Park | Venue factors | None (static) | Weekly |
| Storm | Weather intelligence | None (rules) | Every 30min game day |
| Market | Line intelligence + sportsbook consensus | Claude Sonnet (synthesis) | Hourly |
| MEM | Market efficiency + timing gate | None (rules + metrics) | Real-time |
| Judge | Decision + disqualification + sizing | Claude Sonnet (edge cases) | Per game |

---

## Agent Run Sequence

```
Park → Scout + Lineup + Bullpen (parallel) → Storm → Market → MEM → Judge
```

MEM runs last before Judge. It receives all agent outputs plus real-time Kalshi data and outputs a Trade Quality Score (TQS) and traffic light. Judge only fires if MEM returns GREEN.

---

## Technology Stack

- **Runtime**: Node.js + Commander.js (CLI)
- **Prediction model**: XGBoost regressor (per-team runs) + negative binomial distribution → threshold probability
- **LLM layer**: Claude API (Haiku for high-frequency, Sonnet for synthesis)
- **Database**: Turso/libSQL (local `file:./mlbie.db` for dev/paper)
- **Deployment**: Railway
- **Data sources**: Baseball Savant, Fangraphs, The Odds API, Open-Meteo, MLB Stats API
- **Execution target**: Kalshi REST API (RSA-PSS auth)

---

## Edge Thesis

The edge is not "better model than retail." The edge is **information timing dislocation**.

```
1. Information timing edge (PRIMARY)
   Lineup confirmations, SP scratches, weather updates, bullpen availability
   Kalshi lags these events by minutes
   This is the most exploitable window

2. Execution/microstructure edge (SECONDARY)
   Early market thin liquidity, wider spreads, slow price adjustment
   Kalshi is weakest here relative to traditional sportsbooks

3. Slow model edge (TERTIARY — weakest)
   Better stats than retail (xFIP vs ERA, park-adjusted metrics)
   Likely already priced in by time you trade
   Adds value only in combination with timing advantage
```

**Honest edge framing**:
```
Gross edge on filtered signals:     4-8%  (occasional, not sustained average)
Expected net durable edge:          2-4%  (after Kalshi fees + spread + slippage)
Edge is time-sensitive — exists in a window, not persistently
```

---

## Position Sizing

**Phase 1 (first 200 live trades): Quarter-Kelly with hard limits.**

```javascript
// Phase 1: live deployment (first 200 trades)
kelly_multiplier = 0.25

// Phase 2: after calibration confirmed (>200 trades, model at predicted probabilities)
kelly_multiplier = 0.5

// Never
kelly_multiplier = 1.0
```

```javascript
tradeSize = min(MAX_BET, max(MIN_BET, bankroll * (edge / odds) * kelly_multiplier))
MIN_BET = $25
MAX_BET = bankroll * 0.03  // never more than 3% per trade
```

Half-Kelly is too aggressive if probabilities are even slightly miscalibrated. A model that says 60% but is actually hitting at 54% will damage bankroll with half-Kelly faster than flat betting. Quarter-Kelly provides the safety margin needed during the calibration period.

---

## Validation Phases

1. **Historical backtest** — 2020-2025 data, walk-forward split
2. **Paper trading** — 6 weeks minimum live, dry-run mode, no execution
3. **Micro live** — $25 per trade, execution validation only
4. **Full deployment** — scale to quarter-Kelly (then half after 200 trades)

**Do not skip phases. Do not rush paper trading.**

---

## Disqualifiers (Judge Agent — hard stops)

- SP scratch detected after line opened → REJECT
- Rain probability >40% overlapping game window → REJECT
- Line movement >0.5 runs from open → REJECT
- Starter on <4 days rest → REJECT
- Scout confidence interval too wide (n<5 starts) → REJECT
- MEM returns RED → REJECT
- Model disagrees with both Kalshi AND sharp sportsbooks → REJECT

---

## Trading Windows

```
EARLY  (open → 6hr pre-game)
  Highest mispricing, lowest liquidity
  Small sizing only, early signals (weather, pitching mismatch)

PRIMARY (6hr → 90min pre-game)  ← main trading window
  Best balance of inefficiency + liquidity
  Full sizing per Judge/Kelly

LATE   (< 90min)
  Only trade sudden news events
  SP scratch, weather shift, lineup change
  Market hasn't caught up yet
```

---

## CLI Commands

```bash
mlbie fetch --date today          # ingest all data
mlbie signal --date today         # compute projections
mlbie scan --threshold 0.06       # find edges
mlbie trade --dry-run             # paper mode
mlbie trade --execute             # live mode
mlbie report --yesterday          # P&L summary
mlbie analyze --feature-importance
mlbie analyze --shap --game [id]
mlbie analyze --drift --window 60d
mlbie backtest --season 2024
mlbie historical --season 2020-2025  # build backtest dataset
```

---

## File Structure

```
mlbie/
├── CLAUDE.md          ← this file
├── STATUS.md          ← current state
├── BACKLOG.md         ← prioritized work queue
├── DECISIONS.md       ← architectural decisions log
├── agents/
│   ├── scout/
│   ├── lineup/
│   ├── park/
│   ├── storm/
│   ├── market/
│   ├── mem/           ← NEW: Market Efficiency Monitor
│   └── judge/
├── models/
│   ├── train.py
│   ├── predict.py
│   └── evaluate.py
├── pipeline/
│   ├── fetch.js
│   ├── orchestrate.js
│   └── execute.js
├── lib/
│   ├── savant.js
│   ├── fangraphs.js
│   ├── weather.js
│   ├── odds.js
│   ├── kalshi.js
│   └── features.js
├── db/
│   └── schema.sql
└── cli.js
```

---

## Rules

1. Never deploy capital before passing paper trading phase
2. Never skip the disqualifier layer
3. Never use Martingale sizing
4. Never use full-Kelly — max is half-Kelly after 200 calibrated trades
5. Always log agent attribution on every trade AND every non-trade
6. Retrain model every 500 new game outcomes
7. Monitor calibration weekly — if model says 60% and hits at <52%, pause
8. Scout agent must be validated independently before full system runs
9. Every feature in training data must be tagged with its availability timestamp

---

## Success Metrics

| Metric | Target | Alarm threshold |
|---|---|---|
| Win rate on high-confidence signals | >55% | <51% over 200 trades |
| Model calibration (Brier score) | <0.23 | >0.27 |
| Calibration reliability (per bucket) | within 3% of predicted | >5% drift in any bucket |
| Edge decay (feature drift) | <15% per 60d | >25% on key features |
| Daily P&L variance | Acceptable | >3 consecutive losing days |
| MEM GREEN → actual WIN rate | >55% | <50% over 100 GREEN signals |

---

*Last updated: April 15, 2026 (design session)*
*Parallel systems: BetTracker v9.12 (TT Elite / DraftKings), Veritas Ops, Charleston Training*
