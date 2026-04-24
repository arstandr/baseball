#!/usr/bin/env python3
"""
models/predict.py — stdin/stdout XGBoost inference bridge.

Contract:
  stdin:   JSON { "model_dir": "path/to/version", "features": { ... } }
           -- or --
           JSON { "model_dir": "path/to/version", "features": [ { ... }, ... ] }
  stdout:  JSON { "probability": 0.58, "shap": { "sp_h_swstr_pct_weighted": 0.03, ... } }
           (or an array of the same for batch input).
  stderr:  human-readable errors/logging.

Any missing feature column is filled with NaN and XGBoost handles it natively.
Output includes top-20 SHAP contributions for explainability.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd


def load_model(model_dir: str):
    import joblib
    d = Path(model_dir)
    calibrated_path = d / "calibrated.joblib"
    feature_names_path = d / "feature_names.json"
    if not calibrated_path.exists():
        raise FileNotFoundError(f"calibrated.joblib missing in {model_dir}")
    if not feature_names_path.exists():
        raise FileNotFoundError(f"feature_names.json missing in {model_dir}")
    with open(feature_names_path) as f:
        feature_names = json.load(f)
    calibrated = joblib.load(calibrated_path)
    raw_model = joblib.load(d / "model.joblib") if (d / "model.joblib").exists() else None
    return calibrated, raw_model, feature_names


def build_matrix(features_blob, feature_names):
    rows = features_blob if isinstance(features_blob, list) else [features_blob]
    df = pd.DataFrame(rows)
    # Ensure every expected column exists, fill missing with NaN
    for name in feature_names:
        if name not in df.columns:
            df[name] = np.nan
    return df[feature_names]


def compute_shap(raw_model, X):
    """
    SHAP values via XGBoost's built-in predict with pred_contribs=True.
    Returns per-row dict of top 20 contributions (by absolute value).
    The last "feature" in contribs is the base bias; we exclude it.
    """
    if raw_model is None:
        return [None] * len(X)
    try:
        # XGBoost 1.x API: booster.predict(..., pred_contribs=True)
        booster = raw_model.get_booster() if hasattr(raw_model, "get_booster") else raw_model
        import xgboost as xgb
        d = xgb.DMatrix(X.values, feature_names=list(X.columns))
        contribs = booster.predict(d, pred_contribs=True)  # shape (n, n_features + 1)
        out = []
        feature_names = list(X.columns)
        for row_contribs in contribs:
            values = row_contribs[:-1]
            paired = list(zip(feature_names, values.tolist()))
            paired.sort(key=lambda t: abs(t[1]), reverse=True)
            out.append({f: float(v) for f, v in paired[:20]})
        return out
    except Exception as exc:  # pragma: no cover
        print(f"SHAP computation failed: {exc}", file=sys.stderr)
        return [None] * len(X)


def run_once(payload):
    """One-shot mode: process a single payload dict, return result."""
    model_dir = payload.get("model_dir")
    if not model_dir:
        raise ValueError("missing model_dir")
    features = payload.get("features")
    if features is None:
        raise ValueError("missing features")
    calibrated, raw_model, feature_names = load_model(model_dir)
    X = build_matrix(features, feature_names)
    probs = calibrated.predict_proba(X)[:, 1]
    shap_vals = compute_shap(raw_model, X)
    results = [
        {"probability": float(p), "shap": shap_vals[i] if shap_vals and i < len(shap_vals) else None}
        for i, p in enumerate(probs)
    ]
    return results[0] if not isinstance(features, list) else results


def daemon_main(model_dir: str):
    """Persistent mode: load model once, then read NDJSON lines and respond.
    Write READY to stderr once the model is loaded so the caller knows it's warm.
    """
    calibrated, raw_model, feature_names = load_model(model_dir)
    print("READY", file=sys.stderr, flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            payload = json.loads(line)
            features = payload.get("features")
            if features is None:
                raise ValueError("missing features")
            X = build_matrix(features, feature_names)
            probs = calibrated.predict_proba(X)[:, 1]
            shap_vals = compute_shap(raw_model, X)
            results = [
                {"probability": float(p), "shap": shap_vals[i] if shap_vals and i < len(shap_vals) else None}
                for i, p in enumerate(probs)
            ]
            out = results[0] if not isinstance(features, list) else results
        except Exception as exc:
            out = {"error": str(exc)}
        sys.stdout.write(json.dumps(out) + "\n")
        sys.stdout.flush()


def main():
    # --daemon <model_dir>: persistent subprocess mode (no spawn overhead per prediction)
    if len(sys.argv) >= 3 and sys.argv[1] == "--daemon":
        daemon_main(sys.argv[2])
        return

    raw = sys.stdin.read()
    if not raw.strip():
        print("ERROR: empty stdin", file=sys.stderr)
        sys.exit(2)
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        print(f"ERROR: bad JSON: {exc}", file=sys.stderr)
        sys.exit(2)

    try:
        out = run_once(payload)
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(2)

    sys.stdout.write(json.dumps(out))
    sys.stdout.flush()


if __name__ == "__main__":
    main()
