#!/usr/bin/env python3
"""
shadowTestPkModel.py — Ridge regression pK model trainer.

Handles two modes, auto-detected from CSV columns:
  Historical mode: CSV has 'target_pK' (pre-computed k_pct_l5), 'season'
  In-season mode:  CSV has 'actual_pK' or computes from actual_ks/expected_bf

Usage:
  python3 shadowTestPkModel.py train.csv test.csv predictions.json

Writes predictions.json. Diagnostics go to stderr.
"""

import sys
import json
import math
import warnings
import numpy as np
import pandas as pd
from sklearn.linear_model import RidgeCV
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import Pipeline
from sklearn.model_selection import cross_val_score, KFold
from sklearn.impute import SimpleImputer
from sklearn.metrics import r2_score

warnings.filterwarnings('ignore')

TRAIN_CSV = sys.argv[1]
TEST_CSV  = sys.argv[2]
OUT_JSON  = sys.argv[3]

LEAGUE_PA_PER_IP = 4.3
LEAGUE_K_PCT     = 0.225

train = pd.read_csv(TRAIN_CSV)
test  = pd.read_csv(TEST_CSV)

print(f'[py] train rows: {len(train)}  test rows: {len(test)}', file=sys.stderr)

# ── Mode detection ────────────────────────────────────────────────────────────
HIST_MODE = 'target_pK' in train.columns
print(f'[py] mode: {"historical" if HIST_MODE else "in-season"}', file=sys.stderr)

# ── Target ────────────────────────────────────────────────────────────────────
if HIST_MODE:
    y_train = train['target_pK'].values
    w_train = train['expected_bf'].fillna(18.0).values
else:
    if 'actual_pK' in train.columns:
        y_train = train['actual_pK'].values
    else:
        y_train = np.clip(
            train['actual_ks'].fillna(0) / train['expected_bf'].fillna(18.0),
            0.05, 0.55
        ).values
    w_train = train['expected_bf'].fillna(18.0).values

# ── Feature engineering ───────────────────────────────────────────────────────
def safe(df, col, fill=None):
    if col in df.columns:
        s = df[col].copy()
        return s.fillna(fill) if fill is not None else s
    return pd.Series(fill if fill is not None else np.nan, index=df.index)

def engineer(df):
    d = pd.DataFrame(index=df.index)

    # ── K% signals ───────────────────────────────────────────────────────────
    # L5 rolling
    k9_l5       = safe(df, 'k9_l5')
    k_pct_l5    = safe(df, 'k_pct_l5')          # historical only (also target)
    k_pct_l5_d  = k9_l5 / (LEAGUE_PA_PER_IP * 9)

    # Season Statcast
    savant_kpct = safe(df, 'savant_k_pct')

    # Career / in-season blend inputs
    k9_career   = safe(df, 'k9_career')
    k9_season   = safe(df, 'k9_season')
    k_pct_car_d = k9_career / (LEAGUE_PA_PER_IP * 9)
    k_pct_sea_d = k9_season / (LEAGUE_PA_PER_IP * 9)

    # Unified "best single K% estimate"
    best_kpct = savant_kpct.fillna(k_pct_l5_d).fillna(k_pct_l5).fillna(LEAGUE_K_PCT)

    d['k_pct_l5_derived']    = k_pct_l5_d
    d['savant_k_pct']        = savant_kpct.fillna(LEAGUE_K_PCT)
    d['k9_l5']               = k9_l5.fillna(LEAGUE_K_PCT * LEAGUE_PA_PER_IP * 9)
    d['k9_career']           = k9_career
    d['k9_season']           = k9_season
    d['k_pct_vs_l']          = safe(df, 'k_pct_vs_l')
    d['k_pct_vs_r']          = safe(df, 'k_pct_vs_r')
    d['pK_split_diff']       = safe(df, 'k_pct_vs_l', 0) - safe(df, 'k_pct_vs_r', 0)
    d['pK_l5_vs_savant']     = k_pct_l5_d.fillna(0) - savant_kpct.fillna(0)
    d['pK_career_vs_savant'] = k_pct_car_d.fillna(0) - savant_kpct.fillna(0)

    # ── Stuff / movement signals ──────────────────────────────────────────────
    whiff = safe(df, 'savant_whiff')
    fbv   = safe(df, 'savant_fbv', 93.0)
    d['savant_whiff']    = whiff
    d['savant_fbv']      = fbv
    d['whiff_x_fbv']     = whiff.fillna(0) * fbv
    d['savant_gb_pct']   = safe(df, 'savant_gb_pct')

    # ── Walk / command signals ────────────────────────────────────────────────
    d['savant_bb_pct']   = safe(df, 'savant_bb_pct')
    d['bb9_l5']          = safe(df, 'bb9_l5')
    d['bb_penalty']      = safe(df, 'bb_penalty', 1.0)

    # ── Workload / leash signals ──────────────────────────────────────────────
    avg_ip = safe(df, 'avg_innings_l5', 5.5)
    savant_ip = safe(df, 'savant_ip', 0)
    ip_proxy  = savant_ip.clip(lower=0)           # historical: use Statcast IP
    if 'n_starts' in df.columns:
        ip_proxy = safe(df, 'n_starts', 0) * 5.5  # in-season fallback
    d['early_exit_rate_l5']   = safe(df, 'early_exit_rate_l5', 0.0)
    d['manager_leash_factor'] = safe(df, 'manager_leash_factor', 1.0)
    d['log_expected_bf']      = np.log1p(safe(df, 'expected_bf', 18.0))
    d['log_ip_proxy']         = np.log1p(ip_proxy)
    d['savant_ip']            = savant_ip
    d['savant_pa']            = safe(df, 'savant_pa', 0)
    d['days_rest']            = safe(df, 'days_rest', 4)

    # ── Blend weight reconstruction ───────────────────────────────────────────
    w_season = np.minimum(0.60, savant_ip / 30)
    w_career  = np.maximum(0, 0.40 * (1 - savant_ip / 40))
    w_l5      = np.maximum(0, 1 - w_season - w_career)
    w_total   = (w_season + w_career + w_l5).clip(lower=1e-6)
    d['w_season'] = w_season
    d['w_career']  = w_career
    d['w_l5']      = w_l5
    prod_blend = (
        w_season * best_kpct +
        w_career  * k_pct_car_d.fillna(best_kpct) +
        w_l5      * k_pct_l5_d.fillna(best_kpct)
    ) / w_total
    d['pK_blended_prod'] = prod_blend

    # ── Context / external multipliers (in-season only) ───────────────────────
    d['opp_k_pct']    = safe(df, 'opp_k_pct', LEAGUE_K_PCT)
    d['adj_factor']   = safe(df, 'adj_factor', 1.0)
    d['raw_adj_factor'] = safe(df, 'raw_adj_factor', 1.0)
    d['park_factor']  = safe(df, 'park_factor', 1.0)
    d['weather_mult'] = safe(df, 'weather_mult', 1.0)
    d['ump_factor']   = safe(df, 'ump_factor', 1.0)
    d['velo_adj']     = safe(df, 'velo_adj', 1.0)

    return d

train_e = engineer(train)
test_e  = engineer(test)

FEATURES = [col for col in train_e.columns]

# Pass DataFrames (not .values) so sklearn preserves column names in feature_names_out
X_train = train_e
X_test  = test_e[train_e.columns]

# ── Pipeline: impute → scale → RidgeCV ───────────────────────────────────────
alphas = [0.01, 0.1, 1.0, 10.0, 100.0, 500.0, 1000.0]

pipe = Pipeline([
    ('impute', SimpleImputer(strategy='median')),
    ('scale',  StandardScaler()),
    ('ridge',  RidgeCV(alphas=alphas, cv=5, scoring='r2')),
])

pipe.fit(X_train, y_train, ridge__sample_weight=w_train)
best_alpha = pipe.named_steps['ridge'].alpha_
print(f'[py] RidgeCV best alpha: {best_alpha}', file=sys.stderr)

# ── Cross-validation ──────────────────────────────────────────────────────────
# Use fewer folds if small dataset
n_folds = min(5, max(3, len(train) // 20))
cv_scores = cross_val_score(pipe, X_train, y_train, cv=n_folds, scoring='r2')
cv_r2_mean = float(np.mean(cv_scores))
cv_r2_std  = float(np.std(cv_scores))
print(f'[py] {n_folds}-fold CV R²: {cv_r2_mean:.3f} ± {cv_r2_std:.3f}', file=sys.stderr)
print(f'[py] CV scores: {[round(float(s), 3) for s in cv_scores]}', file=sys.stderr)

# ── Feature importances ───────────────────────────────────────────────────────
coefs = pipe.named_steps['ridge'].coef_
importance = sorted(zip(FEATURES, coefs), key=lambda x: abs(x[1]), reverse=True)
print('\n[py] Feature importances (|coef| descending):', file=sys.stderr)
for feat, coef in importance[:18]:
    print(f'  {feat:<28} {coef:+.4f}', file=sys.stderr)

# ── Predictions ───────────────────────────────────────────────────────────────
preds_raw     = pipe.predict(X_test)
preds_clipped = np.clip(preds_raw, 0.05, 0.55)

train_preds = np.clip(pipe.predict(X_train), 0.05, 0.55)
train_r2    = r2_score(y_train, train_preds, sample_weight=w_train)
residuals   = y_train - train_preds
print(f'[py] In-sample R² (weighted): {train_r2:.3f}', file=sys.stderr)
print(f'[py] Residuals: mean={np.mean(residuals):.4f}  MAE={np.mean(np.abs(residuals)):.4f}  RMSE={math.sqrt(np.mean(residuals**2)):.4f}', file=sys.stderr)

# ── Export model weights (for JS runtime inference) ───────────────────────────
from datetime import datetime
model_path = OUT_JSON.replace('predictions.json', 'model.json')
def safe_list(arr, fill=0.0):
    return [fill if (isinstance(x, float) and math.isnan(x)) else float(x) for x in arr]

# Identify which features were all-NaN in training — SimpleImputer 1.4+ drops
# these columns silently, so feature_names must match the post-imputation length.
all_nan_mask = train_e.isna().all(axis=0).values
kept_features = [f for f, drop in zip(FEATURES, all_nan_mask) if not drop]
dropped       = [f for f, drop in zip(FEATURES, all_nan_mask) if drop]
if dropped:
    print(f'[py] Imputer will drop {len(dropped)} all-NaN features: {dropped}', file=sys.stderr)

# Build a name→median lookup so imputer_medians is aligned to kept_features,
# not the raw 35-feature FEATURES list.  Without this, JS inference uses the
# wrong median for null features at positions ≥ first-dropped-feature.
feat_stat_map = dict(zip(FEATURES, pipe.named_steps['impute'].statistics_))
kept_imputer_medians = safe_list([feat_stat_map.get(f, 0.0) for f in kept_features], fill=0.0)

model_weights = {
    'feature_names':    kept_features,
    'imputer_medians':  kept_imputer_medians,
    'scaler_mean':      safe_list(pipe.named_steps['scale'].mean_,        fill=0.0),
    'scaler_std':       safe_list(pipe.named_steps['scale'].scale_,       fill=1.0),
    'ridge_coef':       safe_list(pipe.named_steps['ridge'].coef_,        fill=0.0),
    'ridge_intercept':  float(pipe.named_steps['ridge'].intercept_),
    'cv_r2':            cv_r2_mean,
    'train_rows':       len(train),
    'trained_at':       datetime.now().isoformat(),
    'alpha':            float(best_alpha),
    'mode':             'historical' if HIST_MODE else 'in-season',
}
with open(model_path, 'w') as f:
    json.dump(model_weights, f, indent=2)
print(f'[py] Wrote model weights → {model_path}', file=sys.stderr)

# ── Output ────────────────────────────────────────────────────────────────────
output = []
for i, (idx, row) in enumerate(test.iterrows()):
    entry = {
        'pitcher_id':   str(row['pitcher_id']),
        'pitcher_name': str(row.get('pitcher_name', '')),
        'predicted_pK': float(round(preds_clipped[i], 4)),
        'cv_r2':        cv_r2_mean,
        'best_alpha':   best_alpha,
    }
    # Include whichever date key is present
    for dk in ['bet_date', 'season', 'as_of_date']:
        if dk in row.index and not pd.isna(row.get(dk)):
            entry[dk] = str(row[dk]) if dk == 'bet_date' else int(row[dk]) if dk == 'season' else str(row[dk])
    output.append(entry)

with open(OUT_JSON, 'w') as f:
    json.dump(output, f, indent=2)

print(f'[py] Wrote {len(output)} predictions → {OUT_JSON}', file=sys.stderr)
