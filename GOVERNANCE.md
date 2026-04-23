# MLBIE — MLB Strikeout Edge Model Governance

## System Overview

MLBIE (MLB Innings/Batters Edge) is a quantitative edge-finding system for
Kalshi `KXMLBKS` strikeout proposition markets. It computes a pitcher's
expected strikeout count (λ) using a multi-source blended model, compares that
to Kalshi YES/NO prices, and sizes bets using a correlated quarter-Kelly
criterion.

The system is used daily during the MLB season. Edge output feeds into
`scripts/live/ksBets.js` which handles order submission.

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
Baseball Savant umpire data (2021-2025, min 300 games). Covers ~30 known
expanded-zone umps and ~20 tight-zone umps.

Expanded-zone example: Angel Hernandez (1.08), Ted Barrett (1.06).
Tight-zone example: CB Bucknor (0.96), Jerry Meals (0.96).

HP ump fetched via `scripts/live/fetchUmpire.js` → MLB Stats API
`/schedule?gamePk=X&hydrate=officials`. All game umps fetched concurrently at
startup. Unknown umps default to 1.00.

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
the #9 hitter may only see 2.5 PAs. This is especially impactful for
early-exit pitchers where the bottom of the order may not bat a third time.

#### NB(λ, r=30) Distribution

**Why Negative Binomial, not Poisson?** Pitcher strikeout counts have more
variance than a Poisson process because of game-to-game heterogeneity (stuff,
command, opponent). Calibration from 4,255 starts (2023-2025): actual
variance/Poisson_variance ≈ 1.17, implying dispersion parameter
r = mean_λ / (variance_ratio - 1) ≈ 30.

At r=30, the NB is nearly Poisson for low λ but meaningfully wider-tailed
for high λ, which is appropriate since upside outcomes (8+ Ks) are
systematically underpriced in Poisson-based models.

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
mid. A model edge of 5¢ in that market is entirely within the vig band — you
can't reliably execute at the mid. The new formula requires clearance above
the half-spread, so we only flag genuine directional edges.

### 4. Weather Adjustment
**What**: Wind, temperature, and humidity multipliers applied to λ for outdoor
parks.  
**Why**: Cold temperatures reduce spin rate (less break on sliders/curves →
fewer Ks). Strong winds disrupt pitch location. High humidity is slightly
favorable for whiff. Real effect sizes are small (2-4%) but systematic. Domes
are correctly excluded since environment is constant.

### 5. Umpire K% Adjustment (`lib/umpireFactors.js`)
**What**: HP umpire K-rate multiplier applied to λ. Fetched live from MLB Stats
API at startup.  
**Why**: Umpire zone tendencies are among the most predictable game-day
factors. Angel Hernandez calling balls that are strikes inflates K% by 8% vs
league. CB Bucknor's tight zone suppresses K% by 4%. These are consistent,
empirically documented tendencies that the market often doesn't fully price in.

### 6. Batting Order Position Weighting
**What**: Lineup K% weighted by expected plate appearances per batting order
position, rather than equal-weight average.  
**Why**: A pitcher facing a lineup where the top 3 (who get the most PAs) are
high-K batters is meaningfully more dangerous than one where only the 8-9
slots are high-K. The old equal-weight average treats the leadoff hitter
identically to the #9 hitter, which misprices the opportunity by ~2-4%.

### 7. Velocity Trend Signal
**What**: Compare current-season fb_velo to career average (2023-2025). Apply
1.03× boost for velo up >1 mph; 0.96× penalty for down >1.5 mph.  
**Why**: Velocity is the leading indicator of stuff. When a pitcher gains
velocity, swing-and-miss tends to follow weeks later. When velo is down
significantly, the pitcher's off-speed pitches move differently and hitters
make more contact. This is an early-warning signal the K% blend may be stale.

### 8. This Governance Document
**What**: Full documentation of the model, every component, calibration, and
risk management.  
**Why**: As the model grows in complexity, a written spec prevents
model drift — the risk that a future edit changes a component without
understanding its interaction with other components. Also useful for
explaining bets post-hoc.

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

## Risk Management

### Protection Rules (implemented Apr 23, 2026 — Opus analysis)

Five rules derived from backtesting the Apr 22 -$641 loss. Implemented in
`scripts/live/ksBets.js` (Rules A/B/C/D) and `scripts/live/liveMonitor.js`
(Rule E). Simulation: Apr 22 -$641 → +$5.58 under all 5 rules.

| Rule | Description | Location |
|------|-------------|----------|
| **A** | Ban NO bets where `market_mid ≥ 65 AND model_prob ≤ 0.75` — market already prices the event as likely | `ksBets.js` filter |
| **B** | ~~Per-pitcher CAR cap at 2%~~ — **REMOVED Apr 23**. Cuts too much upside (+$879 → $229 on Apr 20). Rules A/C/D/E carry the protection load. | removed |
| **C** | Skip `strike=3` markets — structurally mispriced by K-first models | `ksBets.js` filter |
| **D** | Require YES `model_prob ≥ 0.30` — 0.25 was too loose, 0-for-14 at model_prob < 0.25 historically | `ksBets.js` filter |
| **E** | Auto-halt live trading after **-15% daily drawdown** (net across all bets) | `liveMonitor.js` main loop |

Rule B trade-off: at 2% it significantly limits upside on winning days (+$3,681 → +$1,479 on Apr 21). Consider raising to 5% if Rules A/C/D alone provide adequate protection after 50+ bets of sample.

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
These bets should be sized more conservatively (consider halving bet_size
manually) since the E[BF] estimate may be high if the team is actively
managing their starter's workload.

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
| `lib/kalshi.js` | `getAuthHeaders`, `toKalshiAbbr` |
| `lib/kelly.js` | `correlatedKellyDivide` |
| `lib/parkFactors.js` | Park K-rate multipliers |
| `lib/umpireFactors.js` | HP umpire K% multipliers |
| `lib/weather.js` | Game-day weather multipliers |

`server/api.js` was slimmed from ~1,933 → ~1,735 lines by removing the six
local definitions now provided by the lib modules.

---

## Live Calibration — Apr 20, 2026 (73 bets settled)

First real-money day with the full system. Summary of findings:

| Segment | W/L | WR | P&L |
|---------|-----|----|-----|
| All bets | 37/36 | 51% | +$879 |
| Medium confidence only | 29/23 | 56% | +$900 |
| Edge ≥ 0.15 | 15/5 | 75% | +$782 |
| Edge ≥ 0.10 | 21/12 | 64% | +$904 |
| NO side | 19/7 | 73% | +$606 |
| YES side | 18/29 | 38% | +$274 |
| Edge 0.05–0.10 | 16/24 | 40% | -$24 |

**Key findings from first 73 bets:**

1. **YES bets at low model_prob are the drag** — YES bets with model_prob
   10–20% went 0-for-9 (0% actual). The model is overestimating low-end
   YES probability, likely because the Kalshi market already prices very-low-K
   outcomes efficiently and the spread/vig absorbs our edge.

2. **Edge ≥ 0.15 is the sweet spot** — 75% WR, $782 P&L from only 20 bets.
   The 0.05–0.10 bucket is consistently unprofitable; these bets sit inside
   or near the half-spread vig band.

3. **NO side significantly outperforms YES** — 73% vs 38%. The model
   systematically underestimates when K totals fall short of threshold, meaning
   NO edges are more reliable than YES edges at the same raw edge size.

4. **Low-confidence bets hurt ROI** — dropping low-confidence to medium-only
   eliminates 21 bets with 38% WR. Given the small sample, this directional
   signal is worth watching.

5. **Brier score 0.281** (73 predictions) — higher than the 0.183 OOS target,
   but small-sample variance is large. Revisit after 500+ bets.

**Recommended adjustments (provisional — n=73):**
- Raise minimum edge from `0.05` to `0.10` in `strikeoutEdge.js`
- Consider separate YES/NO edge floors: YES requires ≥ 0.15, NO requires ≥ 0.10
- Do not auto-bet YES when model_prob < 0.25 (0-for-14 at these prob levels)
- Medium-confidence gate is already implemented; confirm it's being applied consistently

---

## Improvement Roadmap

### Near-Term (Next Season)
- **Platoon adjustment within lineup**: current implementation averages K% for
  the pitcher's hand; a deeper model would track which batters will actually
  face the pitcher in the first 2-3 times through the order
- **Starter vs bullpen usage model**: some teams increasingly use starters as
  "bulk" 4-inning openers; a pitch-count survival model would give better E[BF]
- **Home/Away split for pitcher**: some pitchers have material home/away K%
  differences independent of park factors (comfort, travel fatigue)
- **Days of rest adjustment**: pitchers on normal rest (4-5 days) vs short rest
  vs extended rest have documented performance differences

### Medium-Term
- **Calibration refresh**: re-run r parameter calibration annually with newest
  season data; r=30 was calibrated on 2023-2025
- **Umpire table refresh**: update `lib/umpireFactors.js` with new umps and
  refresh existing factors with 2025+ data
- **Live in-game updates**: `inGameEdge.js` already exists; integrate the full
  λ model with live pitch count updates

### Long-Term
- **Opposing lineup vs pitcher history**: some batters have strong individual
  matchup K% vs specific pitchers independent of platoon split
- **Weather sub-conditions**: precipitation probability as a K-rate suppressor
  (pitchers lose grip in drizzle regardless of temperature)
- **Market microstructure model**: instead of mid-price, model the true
  execution price accounting for fill probability at different price levels

---

## Known Limitations

1. **Career velocity requires 2023-2025 Savant data** — rookies and pitchers
   with limited MLB history will have no career velo baseline; velo_adj = 1.0
   for these pitchers.

2. **Umpire assignments not posted until day-of** — if running the model early
   (before ~11 AM ET), ump assignments may not be in the MLB API yet. The
   model defaults to 1.0 and logs "ump=TBD". Re-run after assignments post.

3. **Weather requires `OPENWEATHER_API_KEY`** — without it, weather_mult = 1.0
   silently. Set in `.env`.

4. **Lineup K% requires lineups to post** — official batting orders typically
   appear 3-4 hours before first pitch. Early-morning runs fall back to
   `historical_team_offense`. Run `fetchLineups.js` again after lineups post.

5. **Park factors are static 3-year averages** — they don't capture year-to-year
   park condition changes (e.g. a fence moved in, new humidor installed). Review
   annually against current-year park factor estimates.

6. **Correlated Kelly only handles intra-pitcher correlation** — cross-pitcher
   correlated exposure (e.g. two pitchers in the same game on opposite sides
   of the same threshold) is not modeled. Unlikely to be material but worth
   noting.

7. **NB r=30 calibrated on 2023-2025** — as pitch design, analytics, and
   bullpen usage evolve, the variance structure of starter K-counts may shift.
   Re-calibrate annually via `backtest.js`.
