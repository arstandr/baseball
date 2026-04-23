# MLBIE — System Status (Apr 22, 2026)

## What This Is

A paper-trading MLB strikeout prop betting system targeting Kalshi `KXMLBKS` markets.

Each morning: fetch schedule + pitcher data → find edges where our model probability
diverges from Kalshi's market price → log paper bets → live dashboard tracks results.

Stack: Node.js, Turso/libSQL (SQLite), Railway (cloud), vanilla JS web dashboard.

---

## Live Results So Far (2 days of paper trading)

| Date | Bets | W/L | Win Rate | P&L |
|------|------|-----|----------|-----|
| Apr 20 | 73 | 37/36 | 50.7% | +$879.50 |
| Apr 21 | 107 | 54/53 | 50.5% | +$755.38 |
| **Total** | **180** | **91/89** | **50.6%** | **+$1,634.88** |

Starting bankroll: $5,000 paper. Current: $6,634.88. ROI: +32.7%.

Important caveat: only 2 days of data. Win rate of 50.6% is not statistically significant yet.

---

## The Model

### Lambda (expected Ks) formula

```
λ = E[BF] × pK_blended × lineup_adj × park_factor × weather_mult × ump_factor × velo_adj
P(K ≥ n) = 1 - NB_CDF(λ, r=30, k=n-1)
```

### pK_blended — three-way blend of K% signals

| Signal | Source | Weight |
|--------|--------|--------|
| k9_career | Historical 2023-2025 season stats | fades from 40% → 0% as 2026 IP grows past 40 |
| k9_season | 2026 Baseball Savant K% | grows from 0% → 60% by 50 IP |
| k9_l5 | Last 5 starts K/BF | remainder |

### Multipliers applied on top

- **lineup_adj**: opponent team K% vs pitcher handedness (official lineup if posted, else rolling 14d)
- **park_factor**: static multiplier per home team (e.g. COL=0.92, SD=1.06)
- **ump_factor**: HP umpire zone tendency (expanded zone umps up to ×1.08)
- **velo_adj**: current season fb_velo vs career avg (±1mph triggers ±3-4% adjustment)
- **bb_penalty**: Savant season BB% penalty on λ when above threshold
- **weather_mult**: wind/temp/humidity adjustment for outdoor parks

### NB distribution

Using Negative Binomial with r=30 (calibrated from 4,255 historical starts). Chosen
over Poisson because pitcher K counts are overdispersed (variance > mean due to
game-to-game heterogeneity).

### Sizing

Quarter-Kelly with edge-weighted portfolio allocation across the day's bets.
Daily risk budget = 20% of bankroll. Correlated Kelly cap: when multiple thresholds
have edge for the same pitcher, total exposure = max single-threshold Kelly.

---

## What Is Working ✅

### Data pipeline
- **Baseball Savant statcast** — 404 pitchers loaded (k_pct, bb_pct, swstr_pct, fb_velo, gb_pct)
- **Pitcher recent starts** — last 5 starts BF + K totals for 64 active starters
- **Team K% splits** — rolling 14d K% by handedness for all 30 teams (60 rows)
- **Official game lineups** — per-batter K% weighted by batting order position (38 game-days loaded)
- **Kalshi market data** — 127 markets cached with mid/spread/volume
- **Schedule fetching** — game times, probable pitchers, venue IDs

### Model signals (Apr 21 coverage)
- savant_k_pct: 180/180 bets (100%)
- k9_season: 180/180 (100%)
- k9_l5: 180/180 (100%)
- opp_adj applied (non-1.0): 67/180 bets (37% — when lineups are posted)
- park_factor: 107/107 Apr 21 bets (100% on that day)
- ump_factor: 107/107 Apr 21 bets (100% on that day)
- velo_adj: 107/107 Apr 21 bets (100% on that day)
- bb_penalty applied: 46/180 bets (25% — when BB% is above threshold)

### System infrastructure
- Web dashboard (Money Tree 2.0) — live polling every 60s, best case tracking
- Auto-settlement — bets now settle automatically when game goes Final (just fixed)
- Discord reports — morning picks + EOD report card sent automatically
- ksBets.js — report/settle/log modes all working
- eodReport.js — Claude analysis of day's results → Discord
- backtest.js — calibration script (blocked pending historical data, see below)
- Kalshi auth (RSA-PSS) — configured and working for market data fetches

---

## What Is NOT Working / Missing ❌

### 1. historical_pitcher_stats — 0 rows (CRITICAL)

This is the career K% data (2023-2024 seasons). The `k9_career` signal is NULL for
86/107 bets placed on Apr 21, meaning most bets are running on only 2 of the 3
blend signals. Career anchor is the stability signal for early-season when 2026 IP
is low — without it, the model relies entirely on recent form which is noisier.

Also blocks `backtest.js` from running at all (it needs career history to reconstruct
model predictions for historical starts).

**What it needs**: a `fetchHistoricalPitcherStats.js` script that pulls 2023, 2024,
2025 season K% data from Baseball Savant or MLB Stats API for all pitchers, stores
it in `historical_pitcher_stats` table with columns:
`(pitcher_id, season, k_pct_l5, k9_l5, avg_innings_l5)`.

### 2. Weather — 0 rows (MODERATE)

`weather_mult` was 0/180 across both days. The `lib/weather.js` module exists
and the formula is implemented, but it's either not being called during `dailyRun.sh`
or `OPENWEATHER_API_KEY` is not set in the Railway environment. For outdoor parks
(~60% of games) this means we're missing a real multiplier.

### 3. k9_career inconsistency between days (MODERATE)

- Apr 20: k9_career populated for 73/73 bets (100%)
- Apr 21: k9_career populated for only 21/107 bets (20%)

Something changed or broke between the two morning runs. Possibly a data fetch
order issue, or the career data source changed. Needs investigation.

### 4. park_factor / ump_factor / velo_adj missing on Apr 20 (MODERATE)

- Apr 20: 0/73 bets had park_factor, ump_factor, or velo_adj
- Apr 21: 107/107 bets had all three

These features were added or fixed between the two days. Apr 20 results are
running on a less complete model than Apr 21.

### 5. All bets are paper — Kalshi orders never placed (BY DESIGN, currently)

`fill_price = NULL` for all 180 bets. `LIVE_TRADING` env var is not set to `true`.
Orders are being sized and logged but the actual Kalshi API order placement is
gated behind this flag. The Kalshi RSA auth IS working (market data fetches work).

### 6. venues table — 0 rows

The `venues` table is empty. Park factors are currently looked up by team
abbreviation in `lib/parkFactors.js` (hardcoded), not by venue_id from the DB.
This works but means we can't track venue-specific adjustments or road game park
factors correctly. Not urgent.

### 7. historical_games — 0 rows

No historical game outcomes stored. This would feed the run total model
(the MLBIE "phase 2" XGBoost approach documented in files/MODEL.md) but that
model hasn't been built yet. The current live system only bets strikeout props,
not run totals.

### 8. Duplicate bets in DB (cosmetic, now fixed in reporting)

In-game bets (live_bet=1, from inGameEdge.js) and pre-game bets (live_bet=0,
from ksBets.js) both get logged and settled for the same outcomes. The DB has
~185 in-game + 107 pre-game = 292 rows for Apr 21, but only the live_bet=0 rows
are used for P&L reporting. The duplicates don't affect real numbers but inflate
total row count.

---

## Calibration Findings (from 180 settled bets)

**Big finding: YES bets underperform NO bets significantly**

| Segment | W/L | WR | P&L |
|---------|-----|----|-----|
| All | 91/89 | 51% | +$1,635 |
| NO side | 53/19 | 74% | +$1,029 |
| YES side | 38/70 | 35% | +$606 |
| Edge ≥ 0.15 | ~75% | 75% | dominant |
| Edge 0.05-0.10 | ~40% | 40% | negative |

YES bets at model_prob 10-20%: **0-for-14**. The market already prices low-end YES
probability efficiently. These bets are inside the vig band and shouldn't be placed.

**Recommended filters** (provisional at n=180):
- Raise `MIN_EDGE` from 0.05 → 0.10
- Consider YES-only floor of 0.15
- Drop YES bets where model_prob < 0.25

---

## Daily Workflow

```
Morning (~9am ET after Kalshi markets open):
  bash scripts/live/dailyRun.sh

After lineups post (~3-4pm ET):
  bash scripts/live/dailyRun.sh --lineups

Live monitoring (optional, runs in terminal):
  node scripts/live/liveMonitor.js

Settlement now happens automatically via web server live poll.
Manual settle if needed:
  node scripts/live/ksBets.js settle --date YYYY-MM-DD
```

---

## Key Questions / What I Want Help With

1. **How to backfill historical_pitcher_stats**: Best source for 2023-2025 per-season
   K%, K/9, avg IP for ~800 pitchers? Baseball Savant has this but it's by season.
   MLB Stats API has career splits. What's the fastest way to populate this table?

2. **YES vs NO imbalance**: The model is consistently overconfident on YES (low
   probability events). Is this a model calibration issue (shrinkage too weak at low
   probabilities) or a market efficiency issue (Kalshi already prices these well)?
   How should I adjust?

3. **Going live**: What's the right criteria to flip `LIVE_TRADING=true`?
   Currently at 180 paper bets, 50.6% WR. We need more data but what's the
   threshold — n=500? Consistent WR > 53%? Calibration check?

4. **Weather integration**: Is OpenWeather the right source? Is there a better
   free or cheap weather API for stadium-specific conditions at game time?
