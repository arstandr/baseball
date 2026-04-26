# MLBIE — MLB Strikeout Edge Model Governance

**Last updated: 2026-04-25 (Kelly system deployed, NO-bet formula fixed, scheduler cleanup fixed)**

## System Overview

MLBIE (MLB Innings/Batters Edge) is a quantitative edge-finding system for
Kalshi `KXMLBKS` strikeout proposition markets. It computes a pitcher's
expected strikeout count (λ) using a multi-source blended model, compares that
to Kalshi YES/NO prices, and sizes bets using a correlated quarter-Kelly
criterion.

Two betting pipelines share one `ks_bets` database table:

| Pipeline | Script | Trigger | Mode |
|----------|--------|---------|------|
| **Morning picks** | `scripts/live/ksBets.js` | ~9am + ~12:30pm refresh | Pre-game |
| **The Closer** | `scripts/live/liveMonitor.js` | Continuous during games (Windows machine) | In-game |

Edge generation for morning picks flows through `scripts/live/strikeoutEdge.js`.
The Closer uses a live model (`computeLiveModel`) that re-computes λ_remaining
using real-time pitch count, innings pitched, and batters faced.

---

## Model Architecture

### Core Formula

```
λ = E[BF] × pK_blended × lineup_adj × park_factor × weather_mult × ump_factor × velo_adj

P(K ≥ n) = 1 - NB_CDF(λ, r=30, k=n-1)
```

### Component Breakdown

#### pK_blended — Three-Way K% Blend

A weighted blend of three K% signals, each measured in per-BF space:

| Signal | Description | Weight formula |
|--------|-------------|----------------|
| `pK_career` | Multi-year weighted average K% from `historical_pitcher_stats` (2023=0.20, 2024=0.30, 2025=0.50) | `w_career = max(0, 0.40 × (1 - ip_2026/40))` — fades to zero by 40 IP |
| `pK_season` | 2026 Savant K% from `pitcher_statcast` | `w_season = min(0.60, ip_2026/50)` — grows to 0.60 by 50 IP |
| `pK_l5` | Last-5-starts K/BF ratio from game log | `w_l5 = 1 - w_career - w_season` |

**Why BF not K/9?** K/9 confounds K-rate with innings pitched. A pitcher who
gets pulled at 5 IP after 8 Ks has an excellent K-rate (K/BF) but ordinary
K/9 because innings are truncated. We model expected strikeouts as
`E[BF] × pK_blended`, so all math is in batters-faced space.

**Why three-way blend?** Career weight provides a stable anchor early in the
season (low IP, high variance). Season (Savant) weight grows as we accumulate
reliable data. L5 captures recent form. Each source dominates at the
appropriate sample-size regime.

#### E[BF] — Expected Batters Faced

Priority order:
1. `pitcher_recent_starts` table (last 3-5 starts, actual BF recorded)
2. Game log last-5 BF average (if `pitcher_recent_starts` unavailable)
3. Career avg IP × LEAGUE_PA_PER_IP (fallback)

**Leash flag**: if avg pitch count < 85 over recent starts, the pitcher is
likely being managed aggressively and E[BF] may be optimistic. Flagged in
output as `⚠leash`.

#### lineup_adj — Opponent Quality Adjustment

`lineup_adj = lineup_k_pct / LEAGUE_K_PCT`

Priority:
1. Official 9-man lineup from `game_lineups` (posted ~3-4 PM ET game day) —
   per-batter K% splits vs RHP/LHP fetched from MLB Stats API and
   **position-weighted by batting order** (see Batting Order Weighting below)
2. `historical_team_offense` table (14-day rolling K% by hand split)
3. MLB API season team hitting stats
4. League average (0.22)

#### park_factor — Park K-Rate Multiplier

Source: `lib/parkFactors.js`. Research-based multipliers derived from
Baseball Prospectus and FanGraphs 3-year park factors for K%. Applied to λ
after all other adjustments.

Notable values: COL=0.92 (thin air, least break), SD=1.06 (Petco marine
layer, heaviest air), NYY=1.04 (aggressive pull-swing culture).

Dome teams have factors between 1.01-1.03 (climate-controlled conditions
favor clean pitch spin).

#### weather_mult — Game-Day Weather Adjustment

Applied for outdoor parks only. Dome/retractable-roof teams are excluded.
Multipliers stack (all can apply simultaneously):

| Condition | Multiplier | Rationale |
|-----------|-----------|-----------|
| Wind > 15 mph | ×0.97 | Crosswinds make it harder to locate/spin breaking balls |
| Temp < 45°F | ×0.96 | Cold reduces grip and pitch spin rate |
| Humidity > 80% | ×1.02 | Heavy humid air increases ball-bat resistance slightly |

Weather fetched concurrently at startup via `lib/weather.js` (OpenWeather
5-day forecast, 3-hour blocks — picks the block closest to first pitch).

#### ump_factor — HP Umpire Tendencies

Source: `lib/umpireFactors.js`. Multipliers from Umpire Scorecards /
Baseball Savant umpire data (2023-2026, min 200 games).

**Updated 2026-04-23:** 13 retired/suspended/deceased umps removed:
Angel Hernandez (retired Jul 2023), Joe West (retired Nov 2021),
Dana DeMuth (retired 2018), Tom Hallion (retired 2017),
John Hirschbeck (retired 2017), Jerry Meals (retired 2020),
Eric Cooper (died 2015), Bill Miller (retired 2022),
Paul Emmel (retired 2022), Mike Everitt (retired 2021),
Gerry Davis (retired 2018), Pat Hoberg (suspended 2024),
Bruce Dreckman (retired 2022).

**Magnitude cap: ±0.05.** Prior table had values up to ±0.08 which
over-adjusted and produced negative ROI on expanded-zone bets in live trading.

Expanded-zone example: Ted Barrett (1.05), Dan Iassogna (1.04).
Tight-zone example: Clint Fagan (0.95), CB Bucknor (0.97).

HP ump fetched via `scripts/live/fetchUmpire.js` → MLB Stats API
`/schedule?gamePk=X&hydrate=officials`. All game umps fetched concurrently at
startup. Unknown umps default to 1.00.

**Review ump table annually before Opening Day.**

#### velo_adj — Velocity Trend Signal

Compares current season `fb_velo` (Savant) to career average (2023-2025
average from `pitcher_statcast`):

| Delta | Multiplier | Flag |
|-------|-----------|------|
| > +1.0 mph | ×1.03 | `velo-up` — more velocity = more swing-and-miss |
| < -1.5 mph | ×0.96 | `velo-down` — velocity loss = contact regression |
| Within range | ×1.00 | No adjustment |

Applied inside `computeLambdaBase` before returning λ_base, so it scales the
K% estimate directly rather than being a post-hoc multiplier.

#### Batting Order Position Weighting

Batting order positions weight by expected plate appearances in a typical
5-6 IP start. Weights [1.0, 0.97, 0.95, 0.93, 0.92, 0.91, 0.88, 0.86, 0.84]
for positions 1-9, re-normalized to sum to 1. A leadoff hitter facing an
ace starter gets roughly 3 PAs; the cleanup hitter in position 4 gets ~2.8;
the #9 hitter may only see 2.5 PAs.

#### NB(λ, r=30) Distribution

**Why Negative Binomial, not Poisson?** Pitcher strikeout counts have more
variance than a Poisson process because of game-to-game heterogeneity (stuff,
command, opponent). Calibration from 4,255 starts (2023-2025): actual
variance/Poisson_variance ≈ 1.17, implying dispersion parameter
r = mean_λ / (variance_ratio - 1) ≈ 30.

At r=30, the NB is nearly Poisson for low λ but meaningfully wider-tailed
for high λ. This is appropriate since upside outcomes (8+ Ks) are
systematically underpriced in Poisson-based models.

**No shrinkage applied to upper-tail probabilities.** A shrinkage block
(×0.93-0.97 for K≥7-9) was removed 2026-04-23 after live data showed the
model *under*-predicts the upper tail: K≥7+ bets won at 44-45% when the
raw model predicted 30-40%. The shrinkage was making predictions worse.
Use raw `pAtLeast(lambda, n)` output directly.

Re-run calibration yearly: `backtest.js` produces calibration plots.

---

## Calibration Results

**2024 out-of-sample holdout** (not used in model fitting):
- Model probabilities vs realized outcomes by 10% bucket: within 2% across all
  buckets
- Brier score: 0.183 (vs Kalshi implied: 0.197, ~7% improvement)
- P(K≥5) bucket (most liquid): model 48.2%, realized 47.8% over 612 starts
- P(K≥7) bucket: model 31.4%, realized 32.1% over 612 starts

**2025 in-season ongoing**: re-run `backtest.js --season 2025` weekly.

---

## Live Performance — Apr 2026

### Morning bets (live, real Kalshi money — both accounts)

| Date | Bets | Capital at Risk | P&L | Win Rate | Notes |
|------|------|-----------------|-----|----------|-------|
| Apr 22 | 47 | $707 | -$174 | 43% | Old sizing system |
| Apr 23 | 28 | $542 | +$114 | 54% | Old sizing system |
| Apr 24 | ~28 | ~$523 | — | — | Old sizing system |
| Apr 25 | 28 | $550 | — | — | **Kelly system live** |

### Kelly vs. Old System — Apr 22–25 Retrospective

Smoke test: ran the full Kelly pipeline against all this week's live transactions.

| System | Bets | Risk | P&L | ROI |
|--------|------|------|-----|-----|
| Old (edge-weighted flat budget) | 87 | $2,269 | +$878 | 38.7% |
| Kelly (quarter-Kelly, NO bug fixed) | 72 | $1,274 | +$952 | 74.7% |

Kelly made **$74 more** on **$995 less capital**. ROI nearly doubles.
Apr 22 was the sharpest divergence: old system -$288, Kelly system +$152. Rule A alone
blocked ~$178 in Eduardo Rodriguez NO bet losses (mkt=78, mp=0.518 → no conviction).

### In-game bets — The Closer (paper simulation through Apr 23)

Simulation uses unique positions only (duplicates from the logging bug excluded).
2× sizing applied to all edge ≥ 15¢ bets per the live rule.

| Date | Unique Bets | Simulated P&L | Win Rate | Notes |
|------|-------------|---------------|----------|-------|
| Apr 21 | 185 | +$4,980 | 61% | Best day: Jacob Lopez 1K, Simeon Woods Richardson 2K |
| Apr 22 | 7 | -$149 | — | Small slate; Tyler Mahle 5NO cost $130 |
| Apr 23 | 43 | -$58 | — | Joe Ryan only 2Ks; deGrom open bets unsettled |

**Key findings from in-game simulation:**
- **Best segment: NO at high market_mid (70-90¢)** — 109% ROI. Market over-prices favorites; cheap NOs with huge upside.
- **2× sizing on edge ≥ 15¢ bets added +$1,909** vs flat-size across 100 bets.
- **In-game win rate (61%) beats morning (43-54%)** because The Closer only fires at ≥75% model_prob YES or ≤15% model_prob NO with ≥15-20¢ edge.

---

## The Closer — In-Game System

### Overview

`scripts/live/liveMonitor.js` runs continuously on a dedicated Windows machine
during MLB games. Every 20 seconds it:
1. Fetches live box score (MLB API) for each game with active K-prop bets
2. Updates a live model (`computeLiveModel`) using current K count, IP, pitches, BF
3. Computes updated P(K≥n) for all remaining thresholds
4. Compares against current Kalshi prices — fires only on high-conviction edges
5. Manages resting orders (queue position, amend, cancel+retake)
6. Settles bets at game-end using Kalshi's actual revenue data

### Entry Filters (both must pass)

| Side | Model Prob | Edge Floor | Notes |
|------|-----------|------------|-------|
| YES | ≥ 75% | ≥ 20¢ (or halfSpread + 4¢) | High-conviction only |
| NO | ≤ 15% | ≥ 15¢ (or halfSpread + 4¢) | Pitcher must be clearly under-performing |

Additional guards: min 6 BF faced, min 3rd inning, skip pitchers already pulled.

### Sizing

Correlated Kelly across all qualifying thresholds per pitcher (same as morning).
**High-edge multiplier: 2× bet size when edge ≥ 15¢** (validated +$1,909 on
100 bets in Apr 21-23 simulation). Budget cap: 20% of live Kalshi balance per
session.

### Order Execution — Maker First

1. **Initial placement:** Maker at `ask - 1¢` (fetch real ask from orderbook;
   fall back to `mid + 2¢` if unavailable). 75% fee discount vs taker.
2. **Queue management** (when pitcher hits 85+ pitches AND 4+ IP):
   - Queue ≤ 10: leave it
   - Queue ≤ 30: amend to `ask - 1¢` (improve position without losing slot)
   - Queue > 30: cancel + taker at `ask + 1¢`
3. **Pre-game resting orders** (morning bets, T-45 min before first pitch):
   - If filled: done
   - If unfilled: cancel + taker at `ask + 1¢` if edge still holds

### Settlement

- **YES wins:** Settled immediately when `actual_ks >= strike` (covered)
- **YES losses:** Settled when starter is pulled with `actual_ks < strike` and `IP ≥ 3`
- **NO bets (both wins and losses):** Settled at game-end only via
  `settleAndNotifyGame()` using Kalshi's actual settlement revenue.
  **No mid-game early settlement for NO bets** — box scores can briefly lag
  and an early loss lock is permanent and irreversible.

### Duplicate Prevention

The Closer uses a two-layer dedup:
1. **Application-level:** `executeBet` queries for an existing row before
   inserting. Returns immediately if found.
2. **DB-level:** `upsert('ks_bets', ..., ['bet_date', 'pitcher_name', 'strike', 'side', 'live_bet'])`
   conflict keys match the actual `UNIQUE` constraint. **Do not add `user_id`
   to the conflict key list** — the table's UNIQUE constraint does not include
   it, and SQLite would silently insert duplicates if the keys don't match.

---

## Kelly Sizing System Architecture (live as of 2026-04-25)

### Sizing Flow (ksBets.js)

1. Run `strikeoutEdge.js` → raw edges as JSON
2. Dedup hedges (keep highest-edge side at each pitcher+strike key)
3. Cap YES bets per pitcher at 3 (sorted by edge descending)
4. Apply protection rules A/D/E/F
5. Count pending games in `bet_schedule` → `opportunityDiscount()`
6. `pregamePool = bankroll × pregameRiskPct`
7. `effectiveBankroll = pregamePool × discount`
8. `perPitcherCap = pregamePool × 0.10`
9. Group edges by pitcher → `correlatedKellyDivide()` per group
10. Apply per-pitcher cap scale
11. Portfolio cap: if total > pregamePool → scale all bets down proportionally
12. For each sized bet: upsert to `ks_bets`, place Kalshi taker order

### Key Constants (.env)

| Constant | Value | Effect |
|----------|-------|--------|
| `KELLY_MULT` | 0.25 | Quarter-Kelly multiplier |
| `MAX_BET_PCT` | 0.05 | 5% of effectiveBankroll per-bet cap |
| `PER_PITCHER_CAP` | pregamePool × 0.10 | ~$74/pitcher ceiling |
| `PORTFOLIO_CAP` | pregamePool | ~$742/day absolute ceiling |

At current bankroll ($1,237): individual bets range $4–$24. Full Kelly fractions
of 25-75% are common — the discount + cap compress these to 2-12% sized fractions.

### NO-Bet Probability Convention (CRITICAL)

`modelProb` in this codebase is **always P(YES wins)** — i.e., P(pitcher reaches
the threshold). Kelly formula must account for this:

```js
// Correct (lib/kelly.js as of 2026-04-25):
const probWin = side === 'YES' ? modelProb : (1 - modelProb)
const feeEdge = probWin * winPerUnit - (1 - probWin) * losePerUnit
```

The bug before Apr 25 used `modelProb` directly for NO bets, giving P(win) ≈ 0.18
for a strong NO (where the actual P(win) was 0.82). All NO bets returned `betSize=0`.
Any code that calls `kellySizing()` or `correlatedKellyDivide()` with NO bets
depends on this convention — never change `modelProb` to mean P(NO wins).

### correlatedKellyDivide() — Pitcher Correlation Fix

When a pitcher has edges at 5+, 6+, 7+ Ks simultaneously, these bets are
near-perfectly correlated (same outcome pays all YES bets below it). Sizing each
at full Kelly would 3-4× actual exposure.

Fix: **total exposure = max single-threshold Kelly**, allocated proportionally
within that cap. YES and NO bet groups are sized independently (uncorrelated
across sides).

### Smoke Test Results — Week of Apr 21-25 ($1,237 bankroll)

| Day | Edges | Kelly bets | Deployed | % of pool |
|-----|-------|-----------|----------|-----------|
| Apr 21 | 76 | 76 | $742 | 100% (scaled ×0.846) |
| Apr 22 | 39 | 39 | $699 | 94% |
| Apr 23 | 16 | 16 | $302 | 41% (light slate) |
| Apr 24 | 28 | 28 | $523 | 71% |
| Apr 25 | 28 | 28 | $550 | 74% |
| **Week** | **187** | **187** | **$2,816** | — |

### What to Watch When Reviewing Edge System Changes

1. `model_prob` must remain P(YES wins = pitcher reaches threshold). Kelly depends on this.
2. If the `edge` field calculation changes, re-verify rules A/D/E/F thresholds.
3. Run `node scripts/smokeTest.js` after any model change — verify sizing stays in $4-$24/bet, total ≤ $742/day.
4. NO bets need `model_prob` LOW (e.g., 0.15-0.45) for Kelly to correctly size them as high-conviction NO positions.
5. Full Kelly fractions of 50-75% on individual bets are normal given strong edges — cap and quarter-Kelly compress to safe sizes.

---

## Kelly Sizing Rationale

**Quarter-Kelly (KELLY_MULT = 0.25)**
Full Kelly maximizes long-run growth but produces drawdowns that are
psychologically unsustainable and practically dangerous when model estimates
have error. Quarter-Kelly gives ~56% of the geometric growth rate at roughly
1/4 the variance.

**Why not half-Kelly?** Model error. Our K% estimates have roughly ±2-3%
standard error. When you propagate that through pAtLeast() for a 7+ threshold,
the pricing error on the probability is often larger than the market edge. A
0.25 multiplier provides adequate buffer.

**MAX_BET_PCT = 5% of bankroll** per single bet (cap). This prevents the
Kelly formula from sizing very large bets on high-probability markets where
the formula legitimately suggests large fractions.

---

## Budget Structure (as of 2026-04-25)

Bankroll is split into three pools at the user level (`users` table columns):

| Pool | Column | Default | Daily role |
|------|--------|---------|-----------|
| Pre-game | `pregame_risk_pct` | 0.60 | Morning ksBets.js runs |
| Live (in-game) | `live_daily_risk_pct` | 0.20 | The Closer / liveMonitor.js |
| Free money | `free_money_risk_pct` | 0.20 | Kalshi promo / bonus bets |

**Key formulas (ksBets.js)**:
```
pregamePool       = bankroll × pregame_risk_pct  (~$742 at $1,237)
effectiveBankroll = pregamePool × opportunityDiscount(remaining_games)
perPitcherCap     = pregamePool × 0.10           (~$74/pitcher)
portfolioCap      = pregamePool                  (absolute daily ceiling)
MAX_BET_PCT = 0.05 of effectiveBankroll          (~$24 per bet)
```

**`opportunityDiscount(remaining)`** — scales down effective bankroll to
preserve capital for later high-edge games:
```
remaining >= 7 → 0.65×   (most common — large slate)
remaining >= 4 → 0.80×
remaining >= 2 → 0.90×
remaining  = 1 → 1.00×
```
`remaining` = count of `bet_schedule` rows with `status='pending' AND game_time > now`.
Buffer: +2 added before noon ET, +1 before 3pm ET.

**At current bankroll ($1,237)**:
- pregamePool = $742/day max
- effectiveBankroll ≈ $482 on a large slate (0.65× discount)
- Per-bet cap ≈ $24.10 (5% × $482)
- Per-pitcher cap ≈ $74

Running ksBets.js twice (9am + 12:30pm refresh) is safe — portfolio cap
enforced on total capital deployed that day, not per-run.

---

## Risk Management

### Protection Rules — ksBets.js pre-game (as of 2026-04-25)

| Rule | Condition | Rationale |
|------|-----------|-----------|
| **A** | Ban NO bets where `market_mid ≥ 65 AND model_prob ≥ 0.50` | Both market and model say YES is favored — no conviction for NO. Single biggest loss-preventer: blocked ~$178 in Eduardo Rodriguez losses Apr 22. |
| **D** | Ban YES bets where `model_prob < 0.25 AND edge < 0.18` | Low-prob YES with thin edge. Waived if edge ≥ 18¢ (strong signal despite low absolute prob). |
| **E** | Ban NO bets where `market_mid < 15` | Market near-certain NO already — no exploitable edge to capture. |
| **F** | Ban NO bets where `strike ≤ 4` | Apr 2026 live data: strike=3 NO at 0% WR, strike=4 NO at 27.8% WR. Structurally bad segment. |

Removed: **B** (per-pitcher CAR cap — cut too much upside), **C** (strike=3 skip — 47% ROI in live data, was costing money).

**Rule A history**: The original GOVERNANCE.md condition was `model_prob ≤ 0.75` (wrong direction). The correct condition deployed in code is `model_prob ≥ 0.50` — banning NO bets where BOTH market AND model agree YES is favored. If model says NO wins outright (`model_prob < 0.50`), the bet passes regardless of market price.

### Risk Rules — liveMonitor.js (in-game)

### Daily Loss Limit

Automated — `DAILY_LOSS_LIMIT` env var (default $500). Tracked in `_dailyLoss`
variable in `liveMonitor.js`. Live trading stops immediately when hit.

Rule E extends this: -15% net drawdown halt also stops new bets. Whichever
triggers first wins.

### Correlated Kelly (Pitcher-Level Cap)

When multiple K-prop thresholds have edge for the same pitcher, total
exposure = max single-threshold Kelly. Implementation in
`correlatedKellyDivide()` in `lib/kelly.js`. This prevents 3-4× over-exposure
to one pitcher outcome.

### Spread Test Gate

Markets with wide spreads (typically thin liquidity) require larger raw edges
to qualify. Formula: `edge > spread/2 + 4¢`. A 12¢ spread market requires a
10¢ raw edge to qualify; a 4¢ spread market requires only a 6¢ raw edge.

### Lock Detection

Markets where `yes_ask >= 99¢` or `yes_bid <= 1¢` with `yes_ask <= 2¢` are
treated as resolved/locked and skipped. These are in-game markets that have
already settled.

### Leash Flag

When a pitcher's recent average pitch count < 85, they are flagged `⚠leash`.
These bets should be sized more conservatively since the E[BF] estimate may be
high if the team is actively managing their starter's workload.

---

## Deploy Process

The project runs on Railway via direct upload (`railway up`), **not** via a GitHub-connected deploy.

### Standard deploy command

```bash
railway variables set COMMIT_SHA=$(git rev-parse --short HEAD) && railway up --detach
```

**Why the variable set:** `liveMonitor.js` writes `process.env.COMMIT_SHA` into the heartbeat so the dashboard can display the running commit next to "THE CLOSER". Railway's built-in `${{RAILWAY_GIT_COMMIT_SHA}}` reference only resolves for git-connected deploys — it stays blank with `railway up`. Setting it manually before each deploy keeps the Closer status header accurate.

**Never `git push` as part of a deploy.** Git commits are separate operations, done only when explicitly requested.

---

## Code Structure — Shared Libraries

As of April 21, 2026 all shared logic is extracted into `lib/`. Scripts must
import from there; no duplication allowed.

| Module | What it provides |
|--------|-----------------|
| `lib/strikeout-model.js` | `NB_R`, `LEAGUE_*` constants, `nbCDF`, `pAtLeast`, `ipToDecimal` |
| `lib/cli-args.js` | `parseArgs(schema)` — unified CLI flag parser (type-safe, camelCase) |
| `lib/utils.js` | `safeJson`, `todayISO`, `roundTo`, `winRate`, `fmtShort` |
| `lib/analytics.js` | `computeModeSummary`, `computeCalibration`, `computeBankrollRollup`, `runningBankroll` |
| `lib/mlb-live.js` | `mlbFetch` (25s TTL cache), `extractStarterFromBoxscore` |
| `lib/db.js` | Turso/libSQL client |
| `lib/kalshi.js` | Full Kalshi REST + WS client: `getAuthHeaders`, `placeOrder`, `getOrderbook`, `amendOrder`, `cancelAllOrders`, `getSettlements` etc. |
| `lib/kelly.js` | `kellySizing`, `correlatedKellyDivide`, `capitalAtRisk` |
| `lib/parkFactors.js` | Park K-rate multipliers |
| `lib/umpireFactors.js` | HP umpire K% multipliers (updated 2026-04-23) |
| `lib/weather.js` | Game-day weather multipliers |
| `lib/kalshiWs.js` | WebSocket fill stream daemon |
| `lib/wsFillApplier.js` | WS event → DB update |
| `lib/sseBus.js` | Server-Sent Events bus for dashboard real-time updates |

---

## Known Bugs Fixed — 2026-04-25

### 1. Kelly NO-bet formula — all NO bets returned betSize=0

**Bug**: `kellySizing()` computed `feeEdge = modelProb × winPerUnit - (1-modelProb) × losePerUnit`
for ALL bets. Since `modelProb` is always P(YES wins), for NO bets P(win) = `1-modelProb`.
Using `modelProb` directly gave P(win) ≈ 0.18 for a strong NO bet (where P(win) should
be 0.82), so `feeEdge` was deeply negative and `betSize` returned 0 for every NO bet.

**Fix** (`lib/kelly.js`):
```js
const probWin = side === 'YES' ? modelProb : (1 - modelProb)
const feeEdge = probWin * winPerUnit - (1 - probWin) * losePerUnit
```

**Impact**: Before fix, the Kelly system never placed any NO bets. All NO bets in the
DB from Apr 21-24 (kf=0.00%) were placed by the old edge-weighted system. After fix,
NO bets get proper Kelly fractions (typically 2-12% sized Kelly after discounts).

### 2. scheduler.js stale cleanup — all bet_schedule rows marked 'error' on Railway redeploy

**Bug**: On startup, the cleanup marked ALL 'fired' rows older than 4h as `status='error'`
unconditionally. When Railway redeployed mid-day, all 30+ 'fired' rows (successfully
placed bets from 8:35 AM) got marked 'error', making the dashboard look broken when
54 real bets with real Kalshi order IDs existed.

**Fix**: Two-query cleanup distinguishes placed vs. unplaced bets:
```sql
-- Rows with matching ks_bets → mark done (bets were placed, just status update was lost)
UPDATE bet_schedule SET status='done' WHERE status='fired' AND fired_at < ?
  AND EXISTS (SELECT 1 FROM ks_bets k WHERE k.bet_date = bet_schedule.bet_date
              AND k.pitcher_id = bet_schedule.pitcher_id AND k.live_bet = 0)

-- Rows without matching ks_bets → mark error (process truly never completed)
UPDATE bet_schedule SET status='error' WHERE status='fired' AND fired_at < ?
  AND NOT EXISTS (SELECT 1 FROM ks_bets k WHERE k.bet_date = bet_schedule.bet_date
                  AND k.pitcher_id = bet_schedule.pitcher_id AND k.live_bet = 0)
```

Also fixed: the `status='done'` update after successful bet placement was
fire-and-forget (unawaited). Now `await`ed so the status persists before the
next iteration.

---

## Known Bugs Fixed — 2026-04-23

Seven bugs identified and fixed from analysis of all historical transactions:

1. **Shrinkage removed** — `strikeoutEdge.js` was discounting raw model probability
   by 7% at K≥7, 5% at K≥8, 3% at K≥9. Live data showed the opposite: the model
   under-predicts the upper tail. Removed; raw `pAtLeast()` used directly.

2. **Rule C removed** — K=3 markets had 47% ROI in live data. Skipping them was
   costing money. Filter removed from `ksBets.js`.

3. **Duplicate logging (upsert conflict key mismatch)** — `db.upsert()` was called
   with conflict keys `['bet_date', 'pitcher_name', 'strike', 'side', 'live_bet', 'user_id']`
   but the table's UNIQUE constraint is on the first 5 columns only (no `user_id`).
   SQLite requires conflict keys to exactly match an existing constraint — if they
   don't match, it inserts a fresh row on every call. This produced 33× duplicate
   rows for deGrom K≥8 YES on Apr 23. Fixed: `user_id` removed from conflict keys
   in both `ksBets.js` and `liveMonitor.js`.

4. **NO bet mid-game lock** — `liveMonitor.js` was settling NO bets as losses the
   moment `currentKs >= bet.strike` mid-game. Box scores can briefly lag or correct,
   and this lock was permanent (no reverse path). Removed; NO bets now settle only
   at game-end via `settleAndNotifyGame()` using Kalshi's actual revenue data.

5. **filled_contracts falsy-zero** — `bet.filled_contracts ?? fallback` treated
   `filled_contracts = 0` as falsy and used the wrong fallback for P&L math.
   Fixed to `bet.filled_contracts != null ? bet.filled_contracts : fallback`.
   Applied in `ksBets.js`, `liveMonitor.js` (cover and dead settlement blocks,
   and `settleAndNotifyGame`).

6. **2× sizing for edge ≥ 15¢ in-game bets** — Historical simulation showed
   +$1,909 gain across 100 bets (Apr 21-23) by doubling position when edge ≥ 15¢.
   Implemented in `liveMonitor.js executeBet` as `edgeMult = q.edge >= 0.15 ? 2 : 1`.

7. **Umpire table stale** — 13 retired/suspended/deceased umps removed. Magnitude
   cap reduced to ±0.05 (was ±0.08, causing negative ROI on expanded-zone bets).

---

## The 8 Improvements

### 1. Park Factors (`lib/parkFactors.js`)
**What**: K-rate multiplier by home team, applied to λ.
**Why**: Park environment has a material effect on pitcher K-rate independent
of the pitcher and opponent. Coors Field thin air measurably reduces pitch
break (0.92×), while Petco Park's heavy marine air adds ~6% K-rate (1.06×).
Ignoring park in a K-prop model means systematically overpricing K-heavy
pitchers at Coors and underpricing at Petco.

### 2. Correlated Kelly Fix (`lib/kelly.js` — `correlatedKellyDivide`)
**What**: When a pitcher has edges at 5+, 6+, 7+ Ks simultaneously, treat all
bets as one correlated unit (total exposure = max single-threshold Kelly).
**Why**: These bets have near-perfect positive correlation — if the pitcher
throws 8K, every YES bet below 8 wins. Sizing each at full Kelly would 3-4×
the actual capital exposure for a single pitcher outcome. The correlated fix
caps total exposure at max single-threshold Kelly and divides proportionally.

### 3. Spread-Adjusted Edge Threshold
**What**: `edge > spread/2 + MIN_EDGE_FLOOR (4¢)` instead of flat 5¢.
**Why**: A 10¢ spread market has a 5¢ half-spread "no man's land" around the
mid. A model edge of 5¢ in that market is entirely within the vig band. The
new formula requires clearance above the half-spread, so we only flag genuine
directional edges.

### 4. Weather Adjustment
**What**: Wind, temperature, and humidity multipliers applied to λ for outdoor
parks.
**Why**: Cold temperatures reduce spin rate (less break on sliders/curves →
fewer Ks). Strong winds disrupt pitch location. High humidity is slightly
favorable for whiff. Real effect sizes are small (2-4%) but systematic.

### 5. Umpire K% Adjustment (`lib/umpireFactors.js`)
**What**: HP umpire K-rate multiplier applied to λ. Fetched live from MLB Stats
API at startup.
**Why**: Umpire zone tendencies are among the most predictable game-day
factors. Consistent, empirically documented tendencies that the market often
doesn't fully price in.

### 6. Batting Order Position Weighting
**What**: Lineup K% weighted by expected plate appearances per batting order
position, rather than equal-weight average.
**Why**: A pitcher facing a lineup where the top 3 (who get the most PAs) are
high-K batters is meaningfully more dangerous than one where only the 8-9
slots are high-K.

### 7. Velocity Trend Signal
**What**: Compare current-season fb_velo to career average (2023-2025). Apply
1.03× boost for velo up >1 mph; 0.96× penalty for down >1.5 mph.
**Why**: Velocity is the leading indicator of stuff. When a pitcher gains
velocity, swing-and-miss tends to follow weeks later.

### 8. In-Game Live Model (The Closer)
**What**: Re-computes λ_remaining every 20 seconds using actual game state
(current Ks, IP, pitches thrown, BF). Only bets at ≥75% model_prob YES or
≤15% model_prob NO with ≥15-20¢ edge.
**Why**: Kalshi's in-game prices update slowly relative to actual game state.
A pitcher with 6 Ks through 4 innings will have K≥8 YES mis-priced for
several minutes while our live model already shows 80%+ probability. This
is the highest-ROI segment of the entire system.

---

## Improvement Roadmap

### Near-Term
- ~~**Kelly sizing for morning bets**~~: **DONE 2026-04-25** — `ksBets.js` now uses full Kelly pipeline with `correlatedKellyDivide()`, per-pitcher cap, portfolio cap, and opportunity discount. NO-bet formula bug also fixed.
- **lineup_source flag**: add `lineup_source` column to `ks_bets` to track
  whether each bet used posted lineups vs historical fallback. Needed to
  separate performance by lineup quality.
- **Platoon adjustment within lineup**: current implementation averages K% for
  the pitcher's hand; a deeper model would track which batters will actually
  face the pitcher in the first 2-3 times through the order.
- **Starter vs bullpen usage model**: some teams increasingly use starters as
  "bulk" 4-inning openers; a pitch-count survival model would give better E[BF].

### Medium-Term
- **Calibration refresh**: re-run r parameter calibration annually with newest
  season data; r=30 was calibrated on 2023-2025.
- **Umpire table refresh**: update `lib/umpireFactors.js` with new umps and
  refresh existing factors with 2025+ data annually before Opening Day.
- **Home/Away split for pitcher**: some pitchers have material home/away K%
  differences independent of park factors (comfort, travel fatigue).
- **Days of rest adjustment**: pitchers on normal rest (4-5 days) vs short rest
  vs extended rest have documented performance differences.

### Long-Term
- **Opposing lineup vs pitcher history**: some batters have strong individual
  matchup K% vs specific pitchers independent of platoon split.
- **Weather sub-conditions**: precipitation probability as a K-rate suppressor.
- **Market microstructure model**: model the true execution price accounting for
  fill probability at different price levels rather than using ask-1¢ flat.

---

## Known Limitations

1. **Career velocity requires 2023-2025 Savant data** — rookies and pitchers
   with limited MLB history will have no career velo baseline; velo_adj = 1.0.

2. **Umpire assignments not posted until day-of** — if running the model early
   (before ~11 AM ET), ump assignments may not be in the MLB API yet. The
   model defaults to 1.0 and logs "ump=TBD". Re-run after assignments post.

3. **Weather requires `OPENWEATHER_API_KEY`** — without it, weather_mult = 1.0
   silently. Set in `.env`.

4. **Lineup K% requires lineups to post** — official batting orders typically
   appear 3-4 hours before first pitch. Early-morning runs fall back to
   `historical_team_offense`. Run `fetchLineups.js` again after lineups post.

5. **Park factors are static 3-year averages** — they don't capture year-to-year
   park condition changes (fence moved, new humidor). Review annually.

6. **Correlated Kelly only handles intra-pitcher correlation** — cross-pitcher
   correlated exposure (two pitchers in the same game) is not modeled.

7. **NB r=30 calibrated on 2023-2025** — as pitch design, analytics, and
   bullpen usage evolve, the variance structure of starter K-counts may shift.
   Re-calibrate annually via `backtest.js`.

8. **In-game confidence = data completeness, not prediction quality** —
   the `confidence` label (`high/medium/low`) reflects how many starts are
   in the dataset, NOT how accurate the model is for that pitcher. Do not use
   confidence as a bet filter. Morning-bet `high` confidence showed 0% WR in
   early live data — the label is informational only.
