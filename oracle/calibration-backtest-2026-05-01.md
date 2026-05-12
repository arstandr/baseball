# Calibration Backtest — 2026-05-01

**STATUS: NO-GO**

**FIRST-LOOK / SMALL SAMPLE.** This window is likely thinner than ideal for production enablement; use the harness to validate signal direction.

## Front page — flip-flag bar

| metric | bar | isotonic | passes |
|---|---|---:|:-:|
| Δ Brier (test) | ≤ -0.0050 | 0.0095 | ✗ |
| Δ log-loss (test) | ≤ -0.0200 | 2.4611 | ✗ |
| Δ ROI fixed-size (test) | ≥ 0.00 | $400.76 | ✓ |
| test n (strict win/loss) | ≥ 150 | 120 | ✗ |
| strata with own curve | ≥ 4 OR global passes | 7 | ✓ |
| no major stratum regression | none with Δ > 0.01 (n_test ≥ 10) | 1 | ✗ |

### Verdict: **NO-GO**

Failing: delta_brier_iso_passes, delta_logloss_iso_passes, test_n_sufficient, no_major_stratum_regression.
Do NOT promote to active artifact yet. See sections below for diagnostic detail.

## Sample

| metric | value |
|---|---:|
| window | 2026-03-02 → 2026-05-01 |
| bets loaded | 622 |
| trainable bets (win/loss) | 581 |
| distinct bet_dates | 11 |
| split cutoff date | 2026-04-26 |
| train dates | 7 |
| test dates | 4 |
| train bets (strict) | 461 |
| test bets (all settled) | 126 |
| test bets (strict win/loss) | 120 |

## Calibration metrics (test set, strict win/loss only)

| metric | raw | isotonic | platt |
|---|---:|---:|---:|
| Brier | 0.3254 | 0.3349 | 0.3135 |
| log-loss | 0.8665 | 3.3277 | 1.2043 |
| ECE | 0.2959 | 0.2636 | 0.2506 |
| MCE | 0.9088 | 0.7273 | 0.8195 |
| Δ Brier vs raw | — | 0.0095 | -0.0119 |
| Δ log-loss vs raw | — | 2.4611 | 0.3377 |
| Δ ECE vs raw | — | -0.0323 | -0.0453 |
| Δ MCE vs raw | — | -0.1816 | -0.0894 |

*ECE = expected calibration error (weighted-average bucket bias). MCE = max bucket bias. Lower is better.*

## ROI replay (test set, all settled bets)

| metric | value |
|---|---:|
| total production size | $8279.00 |
| total production pnl | $-620.77 |
| Oracle gate using raw probs | $-574.88 |
| Oracle gate using isotonic | $-174.12 |
| Oracle gate using platt | $-220.60 |
| Δ ROI isotonic vs raw | $400.76 |
| Δ ROI platt vs raw | $354.28 |

Fixed-size measure: hold production size; gate fire/skip via edge ≥ max(0.12, spread/2 + 0.04).

## Per-stratum (isotonic on test)

| stratum | n_train | n_test | own_curve | Brier raw | Brier iso | Δ Brier | flag |
|---|---:|---:|:-:|---:|---:|---:|---|
| YES_3-4 | 40 | 12 | ✓ | 0.5098 | 0.5131 | 0.0033 | ok |
| YES_5-6 | 113 | 67 | ✓ | 0.3087 | 0.2305 | -0.0782 | ok |
| YES_7-8 | 95 | 30 | ✓ | 0.3027 | 0.4144 | 0.1117 | REGRESSION |
| YES_9+ | 31 | 4 | ✓ | 0.4560 | 1.0000 | 0.5440 | noisy |
| NO_3-4 | 54 | 0 | ✓ | — | — | — | (no test data) |
| NO_5-6 | 90 | 3 | ✓ | 0.0705 | 0.3542 | 0.2837 | noisy |
| NO_7-8 | 35 | 4 | ✓ | 0.2831 | 0.2747 | -0.0084 | noisy |
| NO_9+ | 3 | 0 | (global) | — | — | — | (no test data) |

**Stratum regressions (gating):** YES_7-8 (Δ=0.1117, n=30)

## Cross-stratum transformation examples (isotonic)

Same raw probability mapped to different calibrated values per stratum.

| raw | YES_3-4 | YES_5-6 | YES_7-8 | YES_9+ | NO_3-4 | NO_5-6 | NO_7-8 | NO_9+ |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 0.30 | 0.000 (oodc) | 0.000 | 0.038 | 0.250 | 0.444 | 0.697 | 0.657 | 0.429 (g) |
| 0.50 | 0.000 | 0.409 | 0.171 | 1.000 | 0.444 | 0.697 | 0.657 (oodc) | 0.429 (g) |
| 0.70 | 0.636 | 0.429 | 1.000 | 1.000 (oodc) | 0.444 | 1.000 (oodc) | 0.657 (oodc) | 0.514 (g) |
| 0.85 | 1.000 | 1.000 (oodc) | 1.000 (oodc) | 1.000 (oodc) | 0.444 | 1.000 (oodc) | 0.657 (oodc) | 0.800 (g) |

Legend: (g) = used global fallback because stratum n_train < 30. (oodc) = OOD clipped to training range.

## Calibration curve (test set)

Predicted vs actual win rate by decile bucket. Bias = predicted − actual.

| bucket | n | raw avg pred | raw actual | raw bias | iso avg pred | iso actual | iso bias |
|---|---:|---:|---:|---:|---:|---:|---:|
| [0.1,0.2) | 2 | 0.1150 | 0.0000 | +0.1150 | 0.1714 | 0.3636 | -0.1922 |
| [0.4,0.5) | 22 | 0.4683 | 0.3636 | +0.1047 | 0.4162 | 0.3279 | +0.0883 |
| [0.5,0.6) | 39 | 0.5468 | 0.3333 | +0.2135 | 0.5000 | 0.0000 | +0.5000 |
| [0.6,0.7) | 33 | 0.6368 | 0.3636 | +0.2731 | 0.6567 | 0.3077 | +0.3490 |
| [0.7,0.8) | 16 | 0.7319 | 0.0625 | +0.6694 | — | — | — |
| [0.8,0.9) | 6 | 0.8518 | 0.3333 | +0.5184 | — | — | — |
| [0.9,1.0) | 2 | 0.9088 | 0.0000 | +0.9088 | 1.0000 | 0.2727 | +0.7273 |

## Caveats

1. Source: ks_bets.model_prob (production's logged probability). This calibrates the historical production decision probability, not a recomputed current Layer 1 probability. Drift caveat: when Layer 1 is wired into production, re-evaluate against fresh Layer 1 envelopes.
2. Voids excluded from training (no clean win/loss signal). Voids included in test ROI replay (pnl=0 by definition).
3. ROI replay uses fixed-size: hold production's size; gate fire/skip via edge ≥ max(0.12, spread/2 + 0.04). Kelly-resized variant computed but not gated on.
4. DK blend is dark; calibrator is fit on raw probs without DK. Forward-compat: when DK ships, retrain calibrator on the new probability surface.
5. NO active.json is created. Preview artifact only at oracle/layers/1.5-calibration/calibrators/<sha>.preview.json.
