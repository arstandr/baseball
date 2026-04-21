# MLBIE — Model Specification

**Last updated**: April 15, 2026 (design session)
**Model type**: Distribution-first architecture — XGBoost regressor + negative binomial threshold probability
**Target**: P(total runs > Kalshi line) derived from run distribution, not direct binary classification

---

## Problem Framing

This is a **calibrated probability estimation** problem, not a classification problem.

A Kalshi total contract is a bet on whether runs exceed a specific threshold. A binary classifier trained on historical over/under results compresses a continuous distribution into a noisy label and throws away structural information. The correct approach is to estimate a run distribution, then convert that distribution to a probability at the exact Kalshi line threshold.

A well-calibrated model that says 60% should be right 60% of the time when it says 60%.

---

## Model Architecture (Distribution-First)

### Step 1: Predict Per-Team Expected Runs

Two XGBoost regressors — one per team:
- **Home team expected runs**: trained on home offense vs away pitcher quality vs park vs weather vs bullpen
- **Away team expected runs**: trained on away offense vs home pitcher quality vs park vs weather vs bullpen

Each uses the full feature vector but weighted toward the relevant side.

### Step 2: Estimate Distribution Parameters

```python
expected_total = home_runs_hat + away_runs_hat

# Variance proxy — these features inflate or compress variance around the mean:
variance_factors = [
  park_run_factor,      # Coors inflates variance; Petco compresses
  pitcher_control,      # BB/9 → more variance; high k_rate → less
  weather_score,        # Extreme weather increases variance
  bullpen_quality       # Poor bullpen inflates variance in 2nd half
]
```

### Step 3: Fit Negative Binomial Distribution

MLB run scoring is overdispersed relative to a Poisson (variance > mean). Negative binomial fits better.

```python
from scipy.stats import nbinom

# Fit negative binomial to expected total + variance
# P(total > threshold) = 1 - CDF(threshold)
# For a line of 8.5: P(total > 8.5) = P(total >= 9) = 1 - CDF(8)
prob_over = 1 - nbinom.cdf(int(threshold), n_param, p_param)
```

### Step 4: Calibration Layer

Apply isotonic regression calibration on top of distribution output. Build reliability diagrams. Deploy only if calibrated model is within 3% in each confidence bucket.

---

## Model Comparison — Test All Four, Deploy Best

Run all four. Report Brier score, log loss, and edge-at-confidence-band for each. Deploy the ensemble that performs best on walk-forward validation.

```
1. XGBoost binary classifier (baseline — keep for comparison)
   Direct P(over) from binary labels. Simple, fast. Throws away distribution info.

2. XGBoost regressor on total runs → distribution mapping
   Predict continuous run total, then fit distribution, then compute threshold probability.
   Better: preserves distribution shape.

3. Negative binomial count model
   Directly models run count distribution. Theoretically correct. May need more data.

4. Ensemble: weighted combination of (2) + (3) with calibration layer
   Best of both approaches. Deploy this if walk-forward confirms edge.
```

---

## Training Data

**Source**: Historical MLB game data 2020-2025
**Volume**: ~4,800 games per season × 6 seasons ≈ 28,000 games (minus postponements/no odds data)
**Format**: One row per game. Features represent information available before first pitch. Target is actual total runs vs line.

**Target variable construction**:
```python
# For each game:
# 1. Actual total runs (home + away, full game)
# 2. Opening full-game line from historical odds
# 3. Binary target: 1 if actual > line, 0 if actual <= line
df['target'] = (df['actual_runs_total'] > df['full_line_open']).astype(int)
```

**Historical line data**: The Odds API historical endpoint (2020+).

---

## Timestamp Purity Requirement

**Every feature must be tagged with its availability timestamp.**

The backtest is invalid if any feature uses information that wasn't available at decision time. This is the most common source of false confidence in sports betting backtests.

```
feature: lineup_confirmed
availability_timestamp: posted 2 hours before game
decision_window: 2hr_pregame

feature: weather_forecast
availability_timestamp: last OpenWeather fetch before game
decision_window: 30min_pregame

feature: opening_line
availability_timestamp: line open date/time
decision_window: morning
```

**Implementation requirement**: The feature engineering pipeline must enforce:
```
feature_value = value_as_of(decision_time - 5 minutes)
```
Never use a value that wasn't available at the decision time. No exceptions.

---

## Feature Groups (95 total)

### Group A: Starting Pitcher — Home (SP_H) — 19 features
prefix: `sp_h_`

```
sp_h_fip_weighted          # Recency-weighted FIP (half-life 4 starts)
sp_h_xfip_weighted         # Recency-weighted xFIP
sp_h_swstr_pct_weighted    # Swinging strike rate
sp_h_gb_pct_weighted       # Ground ball rate
sp_h_hard_contact_weighted # Hard contact rate
sp_h_k9_weighted           # K/9
sp_h_bb9_weighted          # BB/9
sp_h_fstrike_pct           # First pitch strike %
sp_h_tto_penalty           # Times through order penalty 2nd vs 1st (career)
sp_h_tto3_penalty          # Times through order penalty 3rd vs 1st (full-game key)
sp_h_era_l5                # Full-game ERA last 5 starts
sp_h_innings_l5            # Avg innings last 5 starts
sp_h_pitch_efficiency_l5   # Pitches per out last 5
sp_h_days_rest             # Days since last start
sp_h_season_start_num      # Start number this season (fatigue proxy)
sp_h_venue_era_career      # Career ERA at this specific venue
sp_h_confidence            # Data confidence (sample size)
sp_h_vs_lhb_fip            # FIP vs left-handed batters
sp_h_vs_rhb_fip            # FIP vs right-handed batters
```

Note: `sp_h_news_adjustment` is applied as an offset to quality_score upstream, not as a raw feature.

### Group B: Starting Pitcher — Away (SP_A) — 19 features
prefix: `sp_a_`
*(identical features as SP_H)*

### Group C: Batting Lineup — Home (LU_H) — 11 features
prefix: `lu_h_`

```
lu_h_wrc_plus_vs_hand_14d  # wRC+ vs opposing pitcher handedness, 14 days
lu_h_wrc_plus_vs_hand_30d  # wRC+ vs opposing pitcher handedness, 30 days
lu_h_k_pct_vs_hand_14d     # K% vs handedness, 14 days
lu_h_hard_contact_14d      # Hard contact rate, 14 days
lu_h_iso_vs_hand_14d       # Isolated power vs handedness
lu_h_runs_pg_14d           # Runs scored per game, 14 days (full-game)
lu_h_lob_pct_14d           # Left-on-base percentage, 14 days
lu_h_top6_weighted_ops     # Weighted OPS of lineup spots 1-6
lu_h_change_adjustment     # Lineup change penalty (-0.2 to 0.0)
lu_h_schedule_fatigue      # Games in last 7 days
lu_h_home_away_split       # Home performance vs road performance
```

### Group D: Batting Lineup — Away (LU_A) — 11 features
prefix: `lu_a_`
*(identical features as LU_H)*

### Group E: Venue (PK) — 6 features
prefix: `pk_`

```
pk_run_factor              # Run park factor
pk_hr_factor               # HR park factor
pk_altitude                # Altitude in feet (Coors effect)
pk_is_dome                 # Boolean — dome eliminates weather
pk_surface                 # 0=grass, 1=turf
pk_orientation_degrees     # Stadium orientation (for wind encoding)
```

### Group F: Weather (WX) — 7 features
prefix: `wx_`

```
wx_temp_f                  # Temperature at first pitch
wx_temp_category           # Encoded: 0=cold, 1=cool, 2=warm, 3=hot
wx_wind_mph                # Wind speed
wx_wind_direction          # Encoded: 0=in, 1=crosswind, 2=out
wx_wind_speed_x_direction  # Interaction: speed × direction (key feature)
wx_humidity                # Humidity 0-1
wx_precip_prob             # Precipitation probability
```

### Group G: Market Context (MKT) — 6 features
prefix: `mkt_`

```
mkt_opening_line           # Opening full-game total
mkt_current_line           # Current full-game total at model run time
mkt_movement               # current - opening (negative = moved toward under)
mkt_efficiency_score       # Market efficiency (1.0 = no sharp movement)
mkt_platform_gap           # Kalshi line vs consensus sportsbook line
mkt_time_to_game_hrs       # Hours until first pitch
```

### Group H: Interaction Features (IX) — 6 features
prefix: `ix_`

```
ix_sp_h_swstr_x_lu_a_k_pct    # High SwStr% × high K% lineup = strong under
ix_sp_a_swstr_x_lu_h_k_pct    # Same for away pitcher
ix_pk_factor_x_wx_temp         # Park factor adjusted for temperature
ix_wx_wind_out_x_sp_gb_rate    # Wind out × ground ball pitcher interaction
ix_both_sp_quality             # Combined quality of both starters (TTO3-weighted)
ix_lu_offense_vs_sp_quality    # Lineup strength relative to pitcher quality
```

### Group I: Bullpen (BP) — 10 features
prefix: `bp_`

```
bp_h_era_14d               # Home bullpen ERA, rolling 14 days
bp_h_whip_14d              # Home bullpen WHIP, rolling 14 days
bp_h_k_pct_14d             # Home bullpen K%, rolling 14 days
bp_h_hr_per_9_14d          # Home bullpen HR/9, rolling 14 days
bp_h_inherited_score_pct   # % inherited runners scored (leverage management)
bp_a_era_14d               # Away equivalents
bp_a_whip_14d
bp_a_k_pct_14d
bp_a_hr_per_9_14d
bp_a_inherited_score_pct
```

**Total features: 95**

---

## Validation Split

**Walk-forward — never random split:**

```
Fold 1: Train 2020-2022 (3 seasons) → Validate 2023
Fold 2: Train 2020-2023 (4 seasons) → Validate 2024
Fold 3: Train 2020-2024 (5 seasons) → Validate 2025
Final:  Train 2020-2025 (6 seasons) → Deploy live
```

**Report separately for each validation fold.** If edge exists in 2023 but not 2024, that's a warning. Edge should be consistent across all three years.

---

## Training Configuration

```python
import xgboost as xgb
from sklearn.calibration import CalibratedClassifierCV

params = {
    'objective': 'binary:logistic',  # baseline model
    'eval_metric': 'logloss',
    'max_depth': 6,
    'learning_rate': 0.05,
    'n_estimators': 500,
    'subsample': 0.8,
    'colsample_bytree': 0.8,
    'min_child_weight': 10,   # Prevents overfitting on small groups
    'reg_alpha': 0.1,         # L1 regularization
    'reg_lambda': 1.0,        # L2 regularization
    'scale_pos_weight': 1,    # Adjust if class imbalance
    'random_state': 42
}

# For distribution model, objective changes to 'reg:squarederror' per-team
# Then scipy.stats.nbinom fits the distribution

# Calibrate probability outputs
calibrated_model = CalibratedClassifierCV(model, cv='prefit', method='isotonic')
calibrated_model.fit(X_cal, y_cal)  # Last 20% of train set for calibration
```

---

## Evaluation Metrics

**Calibration reliability curves (required)**:
```
Plot predicted probability vs actual outcome rate in buckets:
  50-55%: what % actually went over?
  55-60%: what % actually went over?
  60-65%: what % actually went over?
  65-70%: what % actually went over?

A calibrated model should track within 3% of predicted probability in each bucket.
If a bucket is off by >5%, the model is miscalibrated in that range — do not trade those signals.
```

**Secondary metrics**:
```
Brier score < 0.23         # Calibration quality (lower is better, random = 0.25)
AUC-ROC > 0.54            # Discrimination ability
Log loss < 0.68           # Probability quality
```

**Segment stability checks (required before deployment)**:
Performance must hold across:
```
Month:          April vs August (scoring environments differ)
Park:           High run (Coors, CIN) vs low run (SD, SF)
Total band:     Games with line 7.5 vs 9.5 (different dynamics)
Weather regime: Indoor vs outdoor, hot vs cold
```
If edge only exists in one segment, it's noise.

**Ablation tests**:
```
Remove each feature group one at a time. Measure Brier score change.
If removing weather has zero effect → weather signal isn't working.
If removing bullpen improves performance → bullpen signal is adding noise.
```

**Net-of-friction simulation**:
```
Apply realistic Kalshi fee + spread + slippage to every backtested trade.
Typical: 1-2 cents per contract round trip.
If gross edge is 3% and friction is 2% → net edge 1% → not worth deploying.
```

**Business metrics**:
```
ROI at 6% gross edge threshold, flat $100 bets: target >8% per year
Win rate on signals with >6% gross edge: target >55%
Net-of-friction ROI: target >5% per year
```

---

## Feature Importance Analysis

After each training run, generate:
1. **Global importance** (gain-based)
2. **SHAP values** — per-prediction feature contributions
3. **Permutation importance** — which features most hurt performance when randomized
4. **Ablation impact** — Brier score delta per group removed

Save to database for drift tracking.

---

## Python Files

### train.py
```
Input: feature matrix CSV (output of historical pipeline)
Output: trained model + calibrated model (joblib format)
        feature importance JSON
        validation metrics JSON
        calibration curve data
        ablation test results
```

### predict.py
```
Input: feature vector JSON (from Node.js via stdin)
Output: probability JSON (via stdout)
        SHAP values for this prediction
        distribution parameters (expected_home_runs, expected_away_runs, variance)

Called by Node.js:
const result = await callPython('predict.py', featureVector)
```

### evaluate.py
```
Input: predictions CSV + actuals
Output: calibration reliability curves
        edge analysis by confidence band
        segment stability report
        ablation test results
        net-of-friction ROI simulation
        feature drift report (compare to baseline)
```

---

## Retraining Schedule

- **Trigger**: 500 new game outcomes accumulated since last training
- **Process**: Retrain from scratch on full dataset including new games
- **Validation**: Compare new model's calibration curves and segment stability to previous model
- **Deployment**: Auto-deploy if new model >= 95% of previous model performance on all validation folds
- **Alert**: If new model significantly underperforms, hold and flag for review

---

## Known Limitations

1. **Historical odds depth**: The Odds API historical data starts 2020. Earlier data would improve sample size but isn't available at this quality.

2. **Small sample early season**: Pitchers with <5 starts have high uncertainty. Confidence scoring handles this but edge is reduced.

3. **Rule changes**: Universal DH 2022, shift ban 2023, pitch clock 2023. Weight post-2022 data more heavily.

4. **Playoff exclusion**: Postseason games have different pitcher usage patterns. Train on regular season only.

5. **Double-headers**: Game 2 often uses openers or bullpen games. Flag and apply lower confidence.

6. **Negative binomial fit**: Works well when expected runs > ~3. For very low-scoring (pitching duel) or very high-scoring (Coors) extremes, verify the fit doesn't degrade.
