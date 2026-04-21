#!/usr/bin/env python3
"""
models/train.py — XGBoost training + calibration for MLBIE.

Inputs:
  --csv <path>            Feature matrix with a `target` column (1 = F5 over, 0 = under).
                          Must also contain a `date` column (YYYY-MM-DD) and `game_id`.
  --out-dir <path>        Directory to write model + metrics artifacts (default: models/artifacts).
  --version <id>          Version id to stamp onto the saved model (default: timestamp).

Walk-forward folds (per DEC-006 / MODEL.md):
  Fold 1: Train 2015-2021 -> validate 2022
  Fold 2: Train 2015-2022 -> validate 2023
  Fold 3: Train 2015-2023 -> validate 2024
  Final : Train 2015-2024 -> deploy live

Outputs per run:
  <out_dir>/<version>/model.joblib
  <out_dir>/<version>/calibrated.joblib
  <out_dir>/<version>/feature_importance.json
  <out_dir>/<version>/metrics.json
  <out_dir>/<version>/feature_names.json
  <out_dir>/<version>/calibration_data.json
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd

USE_XGB = False
try:
    import xgboost as xgb
    USE_XGB = True
except Exception:
    pass

from sklearn.calibration import CalibratedClassifierCV
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.inspection import permutation_importance
from sklearn.metrics import (
    brier_score_loss,
    log_loss,
    roc_auc_score,
)

# -------- Feature group constants (mirror MODEL.md) --------
# Post full-game pivot (DEC-016/DEC-019) — Group I (bullpen) added.
FEATURE_PREFIXES = (
    "sp_h_", "sp_a_",
    "lu_h_", "lu_a_",
    "pk_", "wx_", "mkt_", "ix_",
    "bp_h_", "bp_a_",
)

XGB_PARAMS = dict(
    objective="binary:logistic",
    eval_metric="logloss",
    max_depth=6,
    learning_rate=0.05,
    n_estimators=500,
    subsample=0.8,
    colsample_bytree=0.8,
    min_child_weight=10,
    reg_alpha=0.1,
    reg_lambda=1.0,
    scale_pos_weight=1.0,
    random_state=42,
    tree_method="hist",
)

HGBT_PARAMS = dict(
    max_iter=500,
    max_depth=6,
    learning_rate=0.05,
    min_samples_leaf=20,
    l2_regularization=1.0,
    random_state=42,
)

WALK_FORWARD_FOLDS = [
    ("2015-2021", list(range(2015, 2022)), 2022),
    ("2015-2022", list(range(2015, 2023)), 2023),
    ("2015-2023", list(range(2015, 2024)), 2024),
]


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--csv", required=True)
    p.add_argument("--out-dir", default=str(Path(__file__).parent / "artifacts"))
    p.add_argument("--version", default=None)
    p.add_argument("--skip-walk-forward", action="store_true",
                   help="Skip walk-forward folds; train on full dataset immediately.")
    p.add_argument("--mode", choices=["full", "f5"], default="full",
                   help="Training mode: full-game totals (full) or first 5 innings (f5).")
    return p.parse_args()


def load_dataset(csv_path: str, mode: str = "full") -> tuple[pd.DataFrame, list[str]]:
    df = pd.read_csv(csv_path)
    if "date" not in df.columns:
        raise ValueError("CSV must contain a `date` column")
    # Target construction — branches on mode.
    if "target" not in df.columns:
        if mode == "f5":
            if {"f5_runs_total", "f5_line_open"}.issubset(df.columns):
                df["target"] = (df["f5_runs_total"] > df["f5_line_open"]).astype(int)
            else:
                raise ValueError(
                    "F5 mode requires `f5_runs_total` and `f5_line_open` columns in the CSV."
                )
        else:
            # mode="full" — full-game totals (DEC-016).
            # Preferred: actual_runs_total + full_line (from historical pipeline).
            if {"actual_runs_total", "full_line"}.issubset(df.columns):
                df["target"] = (df["actual_runs_total"] > df["full_line"]).astype(int)
            else:
                raise ValueError(
                    "CSV must contain a `target` column OR both `actual_runs_total` and `full_line`."
                )
    df["date"] = pd.to_datetime(df["date"])
    df["season"] = df["date"].dt.year
    feature_cols = [c for c in df.columns if c.startswith(FEATURE_PREFIXES)]
    if not feature_cols:
        raise ValueError(f"No feature columns found with prefixes {FEATURE_PREFIXES}")

    if mode == "f5":
        # Bullpen is irrelevant before inning 5 — zero out bp_h_ / bp_a_ columns
        # by replacing with column mean (keeps feature set shape identical).
        bp_cols = [c for c in feature_cols if c.startswith(("bp_h_", "bp_a_"))]
        for col in bp_cols:
            df[col] = df[col].mean()
        # Third-time-through-order penalty is irrelevant for F5 — zero out.
        tto_cols = [c for c in feature_cols if c in ("sp_h_tto3_penalty", "sp_a_tto3_penalty")]
        for col in tto_cols:
            df[col] = 0.0

    return df, feature_cols


def train_xgb(X_train, y_train, X_val, y_val):
    if USE_XGB:
        model = xgb.XGBClassifier(**XGB_PARAMS, early_stopping_rounds=50)
        model.fit(X_train, y_train, eval_set=[(X_val, y_val)], verbose=False)
    else:
        print("XGBoost unavailable (missing libomp) — using HistGradientBoosting", file=sys.stderr)
        model = HistGradientBoostingClassifier(**HGBT_PARAMS)
        model.fit(X_train, y_train)
    return model


def calibrate(model, X_cal, y_cal):
    # cv='prefit' expects model already fit. Use isotonic for well-calibrated probs.
    try:
        from sklearn.frozen import FrozenEstimator
        cal = CalibratedClassifierCV(FrozenEstimator(model), method="isotonic")
    except ImportError:
        cal = CalibratedClassifierCV(model, cv="prefit", method="isotonic")
    cal.fit(X_cal, y_cal)
    return cal


def evaluate(model, X, y):
    probs = model.predict_proba(X)[:, 1]
    out = {
        "brier": float(brier_score_loss(y, probs)),
        "log_loss": float(log_loss(y, probs, labels=[0, 1])),
        "auc_roc": float(roc_auc_score(y, probs)) if len(np.unique(y)) > 1 else None,
        "n": int(len(y)),
        "base_rate": float(y.mean()),
    }
    # Confidence-band win rates
    for lo, hi, key in [(0.55, 0.60, "val_win_rate_55"), (0.60, 0.65, "val_win_rate_60"), (0.65, 0.70, "val_win_rate_65")]:
        mask = (probs >= lo) & (probs < hi)
        if mask.sum() > 0:
            out[key] = float(y[mask].mean())
            out[f"{key}_n"] = int(mask.sum())
        else:
            out[key] = None
    # ROI simulation — $100 flat at 6% threshold; assume -110 baseline (0.524 implied)
    implied_over = 0.524
    pnl = 0.0
    n_bets = 0
    for p, actual in zip(probs, y):
        edge = p - implied_over
        if abs(edge) >= 0.06:
            side_over = edge > 0
            if (side_over and actual == 1) or (not side_over and actual == 0):
                pnl += 100 * (1 / implied_over - 1)
            else:
                pnl -= 100
            n_bets += 1
    out["val_roi"] = float(pnl / (n_bets * 100)) if n_bets else None
    out["val_roi_n_bets"] = n_bets
    return out


def main():
    args = parse_args()
    df, feature_cols = load_dataset(args.csv, mode=args.mode)
    print(f"Loaded {len(df)} rows across seasons {sorted(df['season'].unique())}", file=sys.stderr)
    print(f"Features: {len(feature_cols)}", file=sys.stderr)

    version = args.version or time.strftime("%Y%m%dT%H%M%S")
    out_dir = Path(args.out_dir) / version
    out_dir.mkdir(parents=True, exist_ok=True)

    # Walk-forward folds
    fold_metrics = []
    if not args.skip_walk_forward:
        for label, train_years, val_year in WALK_FORWARD_FOLDS:
            train = df[df["season"].isin(train_years)].copy()
            val = df[df["season"] == val_year].copy()
            if train.empty or val.empty:
                print(f"Skipping fold {label} -> {val_year}: insufficient data", file=sys.stderr)
                continue
            # Hold out last 20% of train for calibration
            train = train.sort_values("date")
            cutoff = int(len(train) * 0.8)
            fit_df = train.iloc[:cutoff]
            cal_df = train.iloc[cutoff:]
            X_fit, y_fit = fit_df[feature_cols], fit_df["target"]
            X_cal, y_cal = cal_df[feature_cols], cal_df["target"]
            X_val, y_val = val[feature_cols], val["target"]

            model = train_xgb(X_fit, y_fit, X_val, y_val)
            calibrated = calibrate(model, X_cal, y_cal)

            metrics = evaluate(calibrated, X_val, y_val)
            metrics["fold"] = label
            metrics["val_year"] = val_year
            metrics["train_seasons"] = train_years
            fold_metrics.append(metrics)
            print(
                f"Fold {label} -> {val_year}: brier={metrics['brier']:.4f} auc={metrics['auc_roc']} "
                f"roi={metrics['val_roi']}",
                file=sys.stderr,
            )

    # Final model on all available data
    all_years = sorted(df["season"].unique())
    all_label = f"{all_years[0]}-{all_years[-1]}"
    full = df.sort_values("date")
    cutoff = int(len(full) * 0.8)
    fit_df = full.iloc[:cutoff]
    cal_df = full.iloc[cutoff:]
    X_fit, y_fit = fit_df[feature_cols], fit_df["target"]
    X_cal, y_cal = cal_df[feature_cols], cal_df["target"]
    model = train_xgb(X_fit, y_fit, X_cal, y_cal)
    calibrated = calibrate(model, X_cal, y_cal)
    final_metrics = evaluate(calibrated, X_cal, y_cal)
    final_metrics["fold"] = "final"
    final_metrics["train_seasons"] = all_years

    # Persist artifacts
    import joblib

    joblib.dump(model, out_dir / "model.joblib")
    joblib.dump(calibrated, out_dir / "calibrated.joblib")
    with open(out_dir / "feature_names.json", "w") as f:
        json.dump(feature_cols, f)

    if hasattr(model, 'feature_importances_'):
        importances = model.feature_importances_
    else:
        print("Computing permutation importances (sklearn fallback)…", file=sys.stderr)
        perm = permutation_importance(model, X_cal, y_cal, n_repeats=5, random_state=42, n_jobs=-1)
        importances = perm.importances_mean
    fi = dict(zip(feature_cols, importances.tolist()))
    fi_sorted = dict(sorted(fi.items(), key=lambda x: -x[1]))
    with open(out_dir / "feature_importance.json", "w") as f:
        json.dump(fi_sorted, f, indent=2)

    # Calibration curve data for later plotting
    probs = calibrated.predict_proba(X_cal)[:, 1]
    bins = np.linspace(0, 1, 11)
    idx = np.digitize(probs, bins) - 1
    calibration_data = []
    for b in range(10):
        mask = idx == b
        if mask.sum() == 0:
            continue
        calibration_data.append({
            "bin_low": float(bins[b]),
            "bin_high": float(bins[b + 1]),
            "mean_predicted": float(probs[mask].mean()),
            "mean_observed": float(y_cal[mask].mean()),
            "n": int(mask.sum()),
        })
    with open(out_dir / "calibration_data.json", "w") as f:
        json.dump(calibration_data, f, indent=2)

    metrics_payload = {
        "version": version,
        "trained_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "mode": args.mode,
        "train_seasons": all_label,
        "hyperparams": XGB_PARAMS,
        "feature_count": len(feature_cols),
        "row_count": int(len(full)),
        "folds": fold_metrics,
        "final": final_metrics,
    }
    class _Enc(json.JSONEncoder):
        def default(self, o):
            if isinstance(o, (np.integer,)): return int(o)
            if isinstance(o, (np.floating,)): return float(o)
            if isinstance(o, np.ndarray): return o.tolist()
            return super().default(o)
    with open(out_dir / "metrics.json", "w") as f:
        json.dump(metrics_payload, f, indent=2, cls=_Enc)

    model_meta = {"version": version, "mode": args.mode}
    with open(out_dir / "model_meta.json", "w") as f:
        json.dump(model_meta, f, indent=2)

    print(json.dumps({"version": version, "out_dir": str(out_dir), **metrics_payload["final"]}, cls=_Enc))


if __name__ == "__main__":
    main()
