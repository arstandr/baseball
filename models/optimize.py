#!/usr/bin/env python3
"""
models/optimize.py — Exhaustive hyperparameter + feature-group search for MLBIE.

Runs a random grid search across XGBoost hyperparameters, feature subsets,
edge thresholds, and calibration methods using strict walk-forward validation.

All metrics are net of 5% Kalshi fee. Best configs ranked by walk-forward ROI.

Outputs:
  data/optimization_results.json   — all configs + metrics
  data/optimization_best.json      — top 10 configs
  data/optimization_summary.txt    — human-readable report
"""
from __future__ import annotations

import argparse
import json
import os
import random
import sys
import time
from itertools import product
from pathlib import Path

import numpy as np
import pandas as pd


class NumpyEncoder(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, (np.integer,)): return int(obj)
        if isinstance(obj, (np.floating,)): return float(obj)
        if isinstance(obj, np.ndarray): return obj.tolist()
        return super().default(obj)

from sklearn.ensemble import HistGradientBoostingClassifier, GradientBoostingClassifier
from sklearn.calibration import CalibratedClassifierCV
from sklearn.metrics import brier_score_loss, roc_auc_score

# Try XGBoost — fall back to sklearn if libomp missing
try:
    import xgboost as xgb
    _XGB_OK = True
except Exception:
    _XGB_OK = False
    print("[optimize] XGBoost unavailable (missing libomp), using sklearn HistGradientBoosting", file=sys.stderr)

KALSHI_FEE = 0.05   # 5% of winnings
STAKE = 100         # flat $100/trade for ROI simulation

# Walk-forward folds — use whatever seasons are in the data
# Will be populated dynamically based on available years

FEATURE_GROUPS = {
    "all": ["sp_h_", "sp_a_", "lu_h_", "lu_a_", "pk_", "wx_", "mkt_", "ix_", "bp_h_", "bp_a_", "ump_"],
    "pitcher_only": ["sp_h_", "sp_a_"],
    "pitcher_park_weather": ["sp_h_", "sp_a_", "pk_", "wx_"],
    "pitcher_park_weather_ump": ["sp_h_", "sp_a_", "pk_", "wx_", "ump_"],
    "pitcher_lineup_park": ["sp_h_", "sp_a_", "lu_h_", "lu_a_", "pk_"],
    "pitcher_bullpen_park": ["sp_h_", "sp_a_", "bp_h_", "bp_a_", "pk_"],
    "pitcher_bullpen_park_ump": ["sp_h_", "sp_a_", "bp_h_", "bp_a_", "pk_", "ump_"],
    "no_market": ["sp_h_", "sp_a_", "lu_h_", "lu_a_", "pk_", "wx_", "ix_", "bp_h_", "bp_a_", "ump_"],
    "core": ["sp_h_", "sp_a_", "lu_h_", "lu_a_", "pk_", "wx_", "bp_h_", "bp_a_"],
    "core_ump": ["sp_h_", "sp_a_", "lu_h_", "lu_a_", "pk_", "wx_", "bp_h_", "bp_a_", "ump_"],
}

EDGE_THRESHOLDS = [0.04, 0.05, 0.06, 0.07, 0.08, 0.10]

CALIBRATION_METHODS = ["isotonic", "sigmoid"]

# Hyperparameter grid — shared keys map to both XGBoost and sklearn HGBT
# sklearn HistGradientBoosting names: max_iter, max_depth, learning_rate,
#   min_samples_leaf, l2_regularization, max_features, max_bins
PARAM_GRID = {
    "max_depth":         [3, 4, 5, 6, 7, 8, None],   # None = unlimited (HGBT default)
    "learning_rate":     [0.01, 0.02, 0.03, 0.05, 0.08, 0.10, 0.15],
    "n_estimators":      [200, 300, 500, 700, 1000],  # = max_iter for HGBT
    "min_samples_leaf":  [10, 15, 20, 30, 50],        # HGBT; maps to min_child_weight for XGB
    "l2_regularization": [0.0, 0.05, 0.1, 0.5, 1.0], # HGBT; maps to reg_lambda for XGB
    "max_features":      [0.6, 0.7, 0.8, 0.9, 1.0],  # HGBT colsample equivalent
}

N_CONFIGS = 60   # number of random hyperparameter combos to try


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--csv", required=True)
    p.add_argument("--out-dir", default=str(Path(__file__).parent.parent / "data"))
    p.add_argument("--n-configs", type=int, default=N_CONFIGS)
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--quick", action="store_true", help="Run fewer configs for a quick pass")
    p.add_argument("--exclude-train-seasons", type=str, default="",
                   help="Comma-separated seasons to exclude from training sets (e.g. '2023')")
    p.add_argument("--suffix", type=str, default="",
                   help="Suffix for output files (e.g. 'no2023')")
    return p.parse_args()


def load_data(csv_path):
    df = pd.read_csv(csv_path)
    df["date"] = pd.to_datetime(df["date"])
    df["season"] = df["date"].dt.year
    if "target" not in df.columns:
        if {"actual_runs_total", "full_line"}.issubset(df.columns):
            df["target"] = (df["actual_runs_total"] > df["full_line"]).astype(int)
        else:
            raise ValueError("CSV must have 'target' or ('actual_runs_total' + 'full_line')")
    return df


def get_features(df, group_prefixes):
    return [c for c in df.columns if any(c.startswith(p) for p in group_prefixes)]


def build_folds(df):
    """Build walk-forward folds from available seasons."""
    seasons = sorted(df["season"].unique())
    if len(seasons) < 2:
        raise ValueError(f"Need at least 2 seasons, got: {seasons}")
    folds = []
    # Need at least 1 train season before each val season
    for i in range(1, len(seasons)):
        train_seasons = list(seasons[:i])
        val_season = seasons[i]
        # Only use folds where we have enough training data
        if len(train_seasons) >= 1:
            folds.append((train_seasons, val_season))
    # Use at most last 3 folds (most recent and relevant)
    return folds[-3:] if len(folds) > 3 else folds


def build_model(params):
    """Build either XGBoost or sklearn HGBT depending on availability."""
    if _XGB_OK:
        return xgb.XGBClassifier(
            objective="binary:logistic",
            eval_metric="logloss",
            max_depth=params.get("max_depth", 6),
            learning_rate=params.get("learning_rate", 0.05),
            n_estimators=params.get("n_estimators", 500),
            subsample=params.get("max_features", 0.8),
            colsample_bytree=params.get("max_features", 0.8),
            min_child_weight=params.get("min_samples_leaf", 15),
            reg_lambda=params.get("l2_regularization", 1.0),
            early_stopping_rounds=40,
            random_state=42,
            tree_method="hist",
            verbosity=0,
        )
    else:
        return HistGradientBoostingClassifier(
            max_depth=params.get("max_depth"),
            learning_rate=params.get("learning_rate", 0.05),
            max_iter=params.get("n_estimators", 500),
            min_samples_leaf=params.get("min_samples_leaf", 20),
            l2_regularization=params.get("l2_regularization", 0.1),
            max_features=params.get("max_features", 0.8),
            early_stopping=True,
            validation_fraction=0.1,
            n_iter_no_change=30,
            random_state=42,
        )


def train_and_eval_fold(df, feature_cols, params, cal_method, edge_threshold, train_seasons, val_season,
                        exclude_train_seasons=None):
    effective_train_seasons = [s for s in train_seasons if s not in (exclude_train_seasons or [])]
    train = df[df["season"].isin(effective_train_seasons)].sort_values("date")
    val = df[df["season"] == val_season]
    if train.empty or val.empty or len(feature_cols) == 0:
        return None

    # 80/20 train/calibration split (time-ordered)
    cutoff = int(len(train) * 0.8)
    fit_df = train.iloc[:cutoff]
    cal_df = train.iloc[cutoff:]

    if len(cal_df) < 20:
        cal_df = train.iloc[max(0, cutoff - 50):]

    X_fit = fit_df[feature_cols].fillna(0)
    y_fit = fit_df["target"]
    X_cal = cal_df[feature_cols].fillna(0)
    y_cal = cal_df["target"]
    X_val = val[feature_cols].fillna(0)
    y_val = val["target"].values

    model = build_model(params)

    if _XGB_OK:
        model.fit(X_fit, y_fit, eval_set=[(X_cal, y_cal)], verbose=False)
    else:
        model.fit(X_fit, y_fit)

    try:
        from sklearn.frozen import FrozenEstimator
        cal_model = CalibratedClassifierCV(FrozenEstimator(model), method=cal_method)
    except ImportError:
        cal_model = CalibratedClassifierCV(model, cv="prefit", method=cal_method)
    cal_model.fit(X_cal, y_cal)

    probs = cal_model.predict_proba(X_val)[:, 1]

    brier = float(brier_score_loss(y_val, probs))
    try:
        auc = float(roc_auc_score(y_val, probs))
    except Exception:
        auc = None

    # ROI simulation net of Kalshi fee
    implied = 0.524  # -110 baseline
    pnl = 0.0
    n_bets = wins = losses = 0
    for p, actual in zip(probs, y_val):
        edge = p - implied
        if abs(edge) < edge_threshold:
            continue
        side_over = edge > 0
        win = (side_over and actual == 1) or (not side_over and actual == 0)
        if win:
            gross_win = STAKE * (1 / implied - 1)
            net_win = gross_win * (1 - KALSHI_FEE)
            pnl += net_win
            wins += 1
        else:
            pnl -= STAKE
            losses += 1
        n_bets += 1

    roi = float(pnl / (n_bets * STAKE)) if n_bets else None

    return {
        "val_season": val_season,
        "n_val": len(y_val),
        "n_bets": n_bets,
        "wins": wins,
        "losses": losses,
        "win_rate": wins / n_bets if n_bets else None,
        "roi_net": roi,
        "pnl": float(pnl),
        "brier": brier,
        "auc": auc,
    }


def run_config(df, config_id, xgb_params, feature_group, cal_method, edge_threshold, folds,
               exclude_train_seasons=None):
    prefixes = FEATURE_GROUPS[feature_group]
    feature_cols = get_features(df, prefixes)
    if not feature_cols:
        return None

    fold_results = []
    for train_seasons, val_season in folds:
        r = train_and_eval_fold(
            df, feature_cols, xgb_params, cal_method, edge_threshold,
            train_seasons, val_season,
            exclude_train_seasons=exclude_train_seasons,
        )
        if r:
            fold_results.append(r)

    if not fold_results:
        return None

    # Aggregate across folds
    total_bets = sum(f["n_bets"] for f in fold_results)
    total_wins = sum(f["wins"] for f in fold_results)
    total_pnl = sum(f["pnl"] for f in fold_results)
    avg_brier = float(np.mean([f["brier"] for f in fold_results]))
    avg_roi = float(total_pnl / (total_bets * STAKE)) if total_bets else None
    folds_positive = sum(1 for f in fold_results if (f["roi_net"] or 0) > 0)

    return {
        "config_id": config_id,
        "feature_group": feature_group,
        "n_features": len(feature_cols),
        "calibration": cal_method,
        "edge_threshold": edge_threshold,
        "xgb_params": xgb_params,
        "folds": fold_results,
        "n_folds": len(fold_results),
        "folds_positive_roi": folds_positive,
        "total_bets": total_bets,
        "total_wins": total_wins,
        "overall_win_rate": total_wins / total_bets if total_bets else None,
        "overall_roi_net": avg_roi,
        "avg_brier": avg_brier,
        "score": (avg_roi or -99) * folds_positive,  # penalize non-consistent configs
    }


def sample_params(rng):
    return {k: rng.choice(v) for k, v in PARAM_GRID.items()}


def main():
    args = parse_args()
    rng = random.Random(args.seed)
    np.random.seed(args.seed)

    exclude_train_seasons = []
    if args.exclude_train_seasons:
        exclude_train_seasons = [int(s.strip()) for s in args.exclude_train_seasons.split(",") if s.strip()]
        print(f"[optimize] Excluding seasons from training: {exclude_train_seasons}", file=sys.stderr)

    out_suffix = f"_{args.suffix}" if args.suffix else ""

    print(f"[optimize] Loading data from {args.csv}", file=sys.stderr)
    df = load_data(args.csv)
    folds = build_folds(df)
    seasons = sorted(df["season"].unique())
    print(f"[optimize] {len(df)} rows, seasons {seasons}", file=sys.stderr)
    print(f"[optimize] Walk-forward folds: {[(t, v) for t, v in folds]}", file=sys.stderr)

    n_configs = 10 if args.quick else args.n_configs
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    results = []
    config_id = 0
    total_runs = n_configs * len(FEATURE_GROUPS) * len(EDGE_THRESHOLDS) * len(CALIBRATION_METHODS)
    # That's too many — use random sampling across all dimensions
    # Sample n_configs total configs randomly
    seen = set()
    attempts = 0
    max_attempts = n_configs * 20

    while len(results) < n_configs and attempts < max_attempts:
        attempts += 1
        xgb_params = sample_params(rng)
        feature_group = rng.choice(list(FEATURE_GROUPS.keys()))
        cal_method = rng.choice(CALIBRATION_METHODS)
        edge_threshold = rng.choice(EDGE_THRESHOLDS)

        key = (feature_group, cal_method, edge_threshold,
               tuple(sorted(xgb_params.items())))
        if key in seen:
            continue
        seen.add(key)

        config_id += 1
        t0 = time.time()
        try:
            result = run_config(df, config_id, xgb_params, feature_group, cal_method, edge_threshold, folds,
                                exclude_train_seasons=exclude_train_seasons)
        except Exception as e:
            print(f"[optimize] Config {config_id} failed: {e}", file=sys.stderr)
            result = None

        if result is None:
            continue

        elapsed = time.time() - t0
        results.append(result)
        n = len(results)
        roi_str = f"{result['overall_roi_net']:.3f}" if result['overall_roi_net'] is not None else "N/A"
        print(
            f"[optimize] {n}/{n_configs} | cfg={config_id} feat={feature_group} "
            f"thresh={edge_threshold} cal={cal_method} "
            f"roi={roi_str} "
            f"brier={result['avg_brier']:.4f} bets={result['total_bets']} "
            f"pos_folds={result['folds_positive_roi']}/{result['n_folds']} "
            f"({elapsed:.1f}s)",
            file=sys.stderr,
        )

        # Save partial results every 10 configs
        if n % 10 == 0:
            with open(out_dir / f"optimization_results{out_suffix}.json", "w") as f:
                json.dump(results, f, indent=2, cls=NumpyEncoder)

    # Final sort: primary = folds_positive_roi DESC, secondary = overall_roi_net DESC, tertiary = avg_brier ASC
    results.sort(key=lambda r: (
        -(r["folds_positive_roi"] or 0),
        -(r["overall_roi_net"] or -99),
        (r["avg_brier"] or 99),
    ))

    # Save all results
    with open(out_dir / f"optimization_results{out_suffix}.json", "w") as f:
        json.dump(results, f, indent=2, cls=NumpyEncoder)

    # Top 10
    top10 = results[:10]
    with open(out_dir / f"optimization_best{out_suffix}.json", "w") as f:
        json.dump(top10, f, indent=2, cls=NumpyEncoder)

    # Human-readable summary
    lines = [
        "=" * 72,
        "MLBIE OPTIMIZATION SUMMARY",
        f"Configs tested: {len(results)}  |  Seasons: {seasons}  |  Folds: {len(folds)}",
        f"Kalshi fee: {KALSHI_FEE*100:.0f}%  |  Stake: ${STAKE}/trade",
        "=" * 72,
        "",
        "TOP 10 CONFIGURATIONS (ranked: positive folds → net ROI → Brier)",
        "-" * 72,
    ]

    for i, r in enumerate(top10, 1):
        roi_str = f"{r['overall_roi_net']*100:.2f}%" if r['overall_roi_net'] is not None else "N/A"
        wr_str = f"{r['overall_win_rate']*100:.1f}%" if r['overall_win_rate'] is not None else "N/A"
        p = r['xgb_params']
        lines.append(
            f"#{i:2d}  feat={r['feature_group']:<25} thresh={r['edge_threshold']:.2f}  "
            f"cal={r['calibration']:<9}  roi={roi_str:>8}  wr={wr_str:>6}  "
            f"brier={r['avg_brier']:.4f}  bets={r['total_bets']:4d}  "
            f"pos_folds={r['folds_positive_roi']}/{r['n_folds']}"
        )
        lines.append(
            f"    params: depth={p.get('max_depth','?')} lr={p.get('learning_rate','?')} "
            f"n_est={p.get('n_estimators','?')} min_leaf={p.get('min_samples_leaf','?')} "
            f"l2={p.get('l2_regularization','?')} max_feat={p.get('max_features','?')}"
        )
        for fold in r["folds"]:
            roi_f = f"{fold['roi_net']*100:.2f}%" if fold["roi_net"] is not None else "N/A"
            lines.append(
                f"    {fold['val_season']}: roi={roi_f:>8}  brier={fold['brier']:.4f}  "
                f"bets={fold['n_bets']:4d}  wr={fold['wins']}/{fold['n_bets']}"
            )
        lines.append("")

    # Overall best single config
    if results:
        best = results[0]
        lines += [
            "=" * 72,
            "RECOMMENDED CONFIG (best consistent walk-forward performance)",
            "=" * 72,
            json.dumps({
                "feature_group": best["feature_group"],
                "edge_threshold": best["edge_threshold"],
                "calibration": best["calibration"],
                "overall_roi_net": best["overall_roi_net"],
                "avg_brier": best["avg_brier"],
                "total_bets": best["total_bets"],
                "xgb_params": best["xgb_params"],
            }, indent=2),
        ]

    summary_text = "\n".join(lines)
    with open(out_dir / f"optimization_summary{out_suffix}.txt", "w") as f:
        f.write(summary_text)

    print(summary_text)
    print(f"\n[optimize] Results saved to {out_dir}/optimization_results.json", file=sys.stderr)
    print(json.dumps({"ok": True, "configs_tested": len(results), "best_roi": top10[0]["overall_roi_net"] if top10 else None}))


if __name__ == "__main__":
    main()
