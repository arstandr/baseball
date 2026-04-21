#!/usr/bin/env python3
"""
models/evaluate.py — post-training evaluation + drift monitoring.

Usage:
  python models/evaluate.py --model-dir artifacts/<version> --predictions-csv predictions.csv

Inputs:
  --model-dir            Directory containing trained artifacts (metrics.json, feature_names.json).
  --predictions-csv      CSV with columns: date, game_id, probability, actual, line, model_implied.
  --baseline-dir         (optional) Directory of earlier version for feature-drift comparison.

Outputs to stdout (JSON):
  - calibration_plot_data (bins of predicted vs actual)
  - edge_bands (win-rate per 5-point probability bucket)
  - roi_simulation (flat $100 at 6% edge threshold)
  - feature_drift (if --baseline-dir supplied)
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

import numpy as np
import pandas as pd


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--model-dir", required=True)
    p.add_argument("--predictions-csv", required=True)
    p.add_argument("--baseline-dir", default=None)
    p.add_argument("--edge-threshold", type=float, default=0.06)
    return p.parse_args()


def calibration_plot(df, bins=10):
    edges = np.linspace(0, 1, bins + 1)
    idx = np.digitize(df["probability"], edges) - 1
    rows = []
    for b in range(bins):
        mask = idx == b
        n = int(mask.sum())
        if n == 0:
            continue
        rows.append({
            "bin_low": float(edges[b]),
            "bin_high": float(edges[b + 1]),
            "mean_predicted": float(df.loc[mask, "probability"].mean()),
            "mean_observed": float(df.loc[mask, "actual"].mean()),
            "n": n,
        })
    return rows


def edge_bands(df, bands=(0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80)):
    out = []
    for lo, hi in zip(bands[:-1], bands[1:]):
        mask = (df["probability"] >= lo) & (df["probability"] < hi)
        if mask.sum() == 0:
            continue
        out.append({
            "low": lo,
            "high": hi,
            "n": int(mask.sum()),
            "win_rate": float(df.loc[mask, "actual"].mean()),
        })
    return out


def roi_simulation(df, edge_threshold=0.06, stake=100):
    """
    ROI assuming flat $stake per trade at -110 equivalent.
    """
    implied = df.get("model_implied")
    if implied is None:
        df = df.copy()
        df["model_implied"] = 0.524
        implied = df["model_implied"]
    pnl = 0.0
    n_bets = 0
    wins = losses = 0
    for _, row in df.iterrows():
        edge = row["probability"] - row["model_implied"]
        if abs(edge) < edge_threshold:
            continue
        side_over = edge > 0
        price = row["model_implied"] if side_over else (1 - row["model_implied"])
        if (side_over and row["actual"] == 1) or (not side_over and row["actual"] == 0):
            pnl += stake * (1 / price - 1)
            wins += 1
        else:
            pnl -= stake
            losses += 1
        n_bets += 1
    return {
        "n_bets": n_bets,
        "wins": wins,
        "losses": losses,
        "win_rate": wins / n_bets if n_bets else None,
        "pnl_total": float(pnl),
        "roi_pct": float(pnl / (n_bets * stake)) if n_bets else None,
    }


def feature_drift(current_dir: Path, baseline_dir: Path):
    try:
        with open(current_dir / "feature_importance.json") as f:
            cur = json.load(f)
        with open(baseline_dir / "feature_importance.json") as f:
            base = json.load(f)
    except FileNotFoundError:
        return None
    drift = {}
    for name, cur_imp in cur.items():
        base_imp = base.get(name, 0)
        if base_imp == 0 and cur_imp == 0:
            continue
        if base_imp == 0:
            drift[name] = {"baseline": 0, "current": cur_imp, "pct_change": None}
        else:
            drift[name] = {
                "baseline": base_imp,
                "current": cur_imp,
                "pct_change": (cur_imp - base_imp) / base_imp,
            }
    # Sort by absolute pct_change (None -> end)
    drifted = sorted(
        drift.items(),
        key=lambda kv: abs(kv[1]["pct_change"] or 0),
        reverse=True,
    )
    return dict(drifted[:30])


def main():
    args = parse_args()
    df = pd.read_csv(args.predictions_csv)
    for col in ("probability", "actual"):
        if col not in df.columns:
            print(f"ERROR: predictions CSV missing column {col}", file=sys.stderr)
            sys.exit(2)
    out = {
        "calibration_plot_data": calibration_plot(df),
        "edge_bands": edge_bands(df),
        "roi_simulation": roi_simulation(df, args.edge_threshold),
        "n_rows": int(len(df)),
        "brier": float(((df["probability"] - df["actual"]) ** 2).mean()),
    }
    if args.baseline_dir:
        out["feature_drift"] = feature_drift(Path(args.model_dir), Path(args.baseline_dir))
    print(json.dumps(out, indent=2))


if __name__ == "__main__":
    main()
