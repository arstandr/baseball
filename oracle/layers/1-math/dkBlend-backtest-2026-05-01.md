# DK Blend Backtest — 2026-05-01

**STATUS:** PRELIMINARY — DK overlap only starts 2026-04-24; THIN sample may be insufficient.

## Run config

- Window:                 2026-03-02 → 2026-05-01
- Settled placed pregame bets loaded: 621
- Replayable (DK match + JSONs):       301
- Skipped:                 no_dp=308, no_dk=12, parse_fail=0

### Backtest limitation: dynamic betting_rules table values are not time-traveled in v1.
This replay uses current static production thresholds from strikeoutEdge.js:
YES_MIN_EDGE=0.12, NO_MIN_EDGE=0.12, MIN_EDGE_FLOOR=0.04, plus spread/2 when spread is available.

**Decision-flip gate per row:**
-   spread present  → threshold = max(0.12, spread/2 + 0.04)
-   spread missing  → threshold = 0.12  (and row is marked spread_unavailable)

**Spread coverage in this run:**
-   spread_available_rows:           301
-   spread_unavailable_rows:         0
-   spread_adjusted_threshold_used: 0  (spread/2+0.04 > 0.12)
-   floor_threshold_used:            301            (0.12 binding)

**Probability reconstruction:** orig and blend probs are BOTH recomputed from
logged lambda_final using TODAY's archetypeR(savant). This isolates the blend's
marginal effect from pitcher_statcast drift (Bite 6.3.B). Logged ks_bets.model_prob
may differ from probOrig in this report; that's expected.

**Placed-bet replay treats production placement as canonical.**
The reconstructed edge gate is used only to detect fire→skip changes caused by
DK blending. If both baseline and blended gates disagree with production
(common when betting_rules dynamic overrides differ from our static gate),
the row is counted as unchanged, not as a skipped bet. Hard baseline assertion
enforces this: T0.00_M0.00 must produce zero deltas or the script aborts.

- DK over_price:           includes vig (under_price not stored)
- pitcher_statcast:        TODAY's snapshot (drift caveat)
- Thinness uncertainty flagged when today.savant.ip ≥ 30 AND (n_starts<3 OR bfSource weak)
- Schedules swept:         15 (THIN × {0,0.10,0.20,0.30,0.40} × MID × {0,0.05,0.10})
- Production candidate:    THIN=0.20 MID=0.05 STABLE=0.00

## Per-schedule summary

| schedule | n | flipped→skip | ΔBrier | ΔLogLoss | ΣPnL_orig | ΣPnL_fix | ΔROI_fix | ΣPnL_kelly | ΔROI_kelly | medianΔλ | p95\|Δλ\| |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| T0.00_M0.00 (baseline) | 301 | 0 | 0.0000 | 0.0000 | -297.84 | -297.84 | 0.00 | -297.84 | 0.00 | 0.000 | 0.000 |
| T0.00_M0.05 | 301 | 2 | -0.0003 | -0.0006 | -297.84 | -239.13 | 58.71 | -228.67 | 69.17 | 0.000 | 0.024 |
| T0.00_M0.10 | 301 | 2 | -0.0005 | -0.0011 | -297.84 | -239.13 | 58.71 | -218.20 | 79.64 | 0.000 | 0.047 |
| T0.10_M0.00 | 301 | 0 | 0.0001 | 0.0002 | -297.84 | -297.84 | 0.00 | -300.85 | -3.01 | 0.000 | 0.000 |
| T0.10_M0.05 | 301 | 2 | -0.0002 | -0.0004 | -297.84 | -239.13 | 58.71 | -231.68 | 66.16 | 0.000 | 0.034 |
| T0.10_M0.10 | 301 | 2 | -0.0005 | -0.0010 | -297.84 | -239.13 | 58.71 | -221.21 | 76.63 | 0.000 | 0.047 |
| T0.20_M0.00 | 301 | 0 | 0.0001 | 0.0003 | -297.84 | -297.84 | 0.00 | -303.89 | -6.05 | 0.000 | 0.000 |
| T0.20_M0.05 ★ | 301 | 2 | -0.0001 | -0.0002 | -297.84 | -239.13 | 58.71 | -234.72 | 63.12 | 0.000 | 0.034 |
| T0.20_M0.10 | 301 | 2 | -0.0004 | -0.0008 | -297.84 | -239.13 | 58.71 | -224.25 | 73.59 | 0.000 | 0.069 |
| T0.30_M0.00 | 301 | 0 | 0.0002 | 0.0005 | -297.84 | -297.84 | 0.00 | -306.96 | -9.12 | 0.000 | 0.000 |
| T0.30_M0.05 | 301 | 2 | -0.0000 | -0.0001 | -297.84 | -239.13 | 58.71 | -237.79 | 60.05 | 0.000 | 0.034 |
| T0.30_M0.10 | 301 | 2 | -0.0003 | -0.0006 | -297.84 | -239.13 | 58.71 | -227.31 | 70.53 | 0.000 | 0.069 |
| T0.40_M0.00 | 301 | 0 | 0.0003 | 0.0007 | -297.84 | -297.84 | 0.00 | -310.04 | -12.20 | 0.000 | 0.000 |
| T0.40_M0.05 | 301 | 2 | 0.0000 | 0.0001 | -297.84 | -239.13 | 58.71 | -240.87 | 56.97 | 0.000 | 0.034 |
| T0.40_M0.10 | 301 | 2 | -0.0002 | -0.0005 | -297.84 | -239.13 | 58.71 | -230.40 | 67.44 | 0.000 | 0.069 |

## Detail for production candidate (THIN=0.20, MID=0.05, STABLE=0)

**by thinness class (suffix _uncertain = today's savant likely diverges from bet-date)**

| key | n | flipped→skip | ΔBrier | ΔLogLoss | ΣPnL_orig | ΣPnL_fix | ΔROI_fix | medianΔλ |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| mid | 111 | 2 | -0.0007 | -0.0015 | -500.45 | -441.74 | 58.71 | 0.000 |
| stable | 168 | 0 | 0.0000 | 0.0000 | 231.33 | 231.33 | 0.00 | 0.000 |
| thin | 22 | 0 | 0.0020 | 0.0044 | -28.72 | -28.72 | 0.00 | 0.000 |

**by side**

| key | n | flipped→skip | ΔBrier | ΔLogLoss | ΣPnL_orig | ΣPnL_fix | ΔROI_fix | medianΔλ |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| NO | 90 | 0 | -0.0001 | -0.0003 | -298.33 | -298.33 | 0.00 | 0.000 |
| YES | 211 | 2 | -0.0001 | -0.0002 | 0.49 | 59.20 | 58.71 | 0.000 |

**by strike bucket**

| key | n | flipped→skip | ΔBrier | ΔLogLoss | ΣPnL_orig | ΣPnL_fix | ΔROI_fix | medianΔλ |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 3-4 | 33 | 0 | -0.0001 | -0.0003 | -12.33 | -12.33 | 0.00 | 0.000 |
| 5-6 | 165 | 2 | -0.0004 | -0.0008 | 33.87 | 92.58 | 58.71 | 0.000 |
| 7-8 | 95 | 0 | 0.0003 | 0.0007 | -218.86 | -218.86 | 0.00 | 0.000 |
| 9+ | 8 | 0 | 0.0000 | 0.0000 | -100.52 | -100.52 | 0.00 | 0.000 |

**by bfSource tier**

| key | n | flipped→skip | ΔBrier | ΔLogLoss | ΣPnL_orig | ΣPnL_fix | ΔROI_fix | medianΔλ |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| medium | 12 | 0 | -0.0005 | -0.0011 | -118.03 | -118.03 | 0.00 | 0.000 |
| strong | 281 | 2 | -0.0001 | -0.0002 | -94.73 | -36.02 | 58.71 | 0.000 |
| weak | 8 | 0 | 0.0000 | 0.0000 | -85.08 | -85.08 | 0.00 | 0.000 |

**by account (user_id)**

| key | n | flipped→skip | ΔBrier | ΔLogLoss | ΣPnL_orig | ΣPnL_fix | ΔROI_fix | medianΔλ |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 2 | 157 | 1 | -0.0001 | -0.0002 | -225.83 | -196.19 | 29.64 | 0.000 |
| 284 | 144 | 1 | -0.0001 | -0.0003 | -72.01 | -42.94 | 29.07 | 0.000 |

**probability calibration (blended-prob bucket)**

| bucket | n | actual hit rate | avg P_orig | avg P_blend | Brier_orig | Brier_blend |
|---|---:|---:|---:|---:|---:|---:|
| [0.2, 0.3) | 10 | 0.0000 | 0.2540 | 0.2540 | 0.0655 | 0.0655 |
| [0.3, 0.4) | 23 | 0.0870 | 0.3512 | 0.3511 | 0.1545 | 0.1545 |
| [0.4, 0.5) | 40 | 0.2750 | 0.4570 | 0.4567 | 0.2263 | 0.2260 |
| [0.5, 0.6) | 81 | 0.3457 | 0.5462 | 0.5452 | 0.2700 | 0.2697 |
| [0.6, 0.7) | 72 | 0.4583 | 0.6547 | 0.6539 | 0.2929 | 0.2928 |
| [0.7, 0.8) | 37 | 0.5676 | 0.7532 | 0.7527 | 0.2794 | 0.2794 |
| [0.8, 0.9) | 30 | 0.7333 | 0.8492 | 0.8492 | 0.2091 | 0.2091 |
| [0.9, 1.0) | 8 | 0.7500 | 0.9233 | 0.9233 | 0.2106 | 0.2106 |

## Vig + drift sanity (T=0.20 M=0.05)

- median bf_delta:    -1.487    (DK over_price has vig → expect slightly positive)
- p95 |bf_delta|:     13.071
- median Δλ:          0.000
- p95 |Δλ|:           0.034

## Bar check — illustrative thresholds (you set the real ones in 6.4)

| check | result |
|---|---|
| THIN n ≥ 30 | WARN (22) |
| THIN ΔBrier ≤ −0.005 | FAIL |
| THIN ΔLogLoss ≤ −0.02 | FAIL |
| THIN ΔROI_fix > 0 | FAIL |
| median |Δλ| (overall) ≤ 0.5 K | PASS |
| p95 |Δλ| (overall) ≤ 1.5 K | PASS |

> **Reminder:** small sample. Do not use this preliminary run alone to enable/disable.
