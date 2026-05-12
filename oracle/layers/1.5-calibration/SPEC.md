# Layer 1.5: Calibration — Specification

**Status:** 🔒 LOCKED v1.0 — ready for implementation
**Last edited:** 2026-05-01
**Purpose deliverable:** L1.5.1

---

## 1. Purpose

Layer 1.5 corrects the **final per-strike probabilities** produced by
Layer 1 against observed historical outcomes. The 2026-05-01 money-on-
the-table audit showed Layer 1's `prob_at_least[k]` is severely
overconfident in the 30–80% range (the bucket where most bets cluster):

```
Model 70% → actual 24%   (50pp bias)
Model 60% → actual 37%   (23pp bias)
Model 40% → actual 28%   (18pp bias)
```

Edge calculation, Kelly sizing, Trust scoring, and Judge thresholds
all depend on `prob_at_least[k]`. Miscalibration distorts ALL
downstream layers in correlated ways. Sizing inversion, NO-bucket
losses, and several other audit findings are likely symptoms of this
single upstream defect.

**Layer 1.5 sits between Layer 1 and Layer 2** in the pipeline and
applies a learned mapping `raw_prob → calibrated_prob`. Calibration
is the single highest-value lever in the audit.

> Calibration is applied to **`envelope.prob_at_least[k]`** (per-strike
> output of `probAtLeastByStrike`), NOT to `pK_blended`. Calibrating
> at the per-BF rate would distort all strikes in correlated ways via
> the NB curve. Surgical per-strike calibration is the right target.

One-line summary: Layer 1.5 is the calibrator that fixes Layer 1's
probability bias before it poisons every downstream decision.

---

## 2. Inputs

### 2a. From Layer 1 envelope

```js
envelope.prob_at_least: { '3': p3, '4': p4, ..., '12': p12 }
envelope.outer.lambda_final          // for context only (not calibrated)
envelope.dk_blend                    // optional; informational only
```

### 2b. From a fitted calibrator artifact

```js
loaded once at module init from disk:
  oracle/layers/1.5-calibration/calibrators/<sha256>.json

artifact shape:
{
  schema_version:  '1.0.0',
  calibrator_id:   '<sha256 of training data + method + cutoff>',
  trained_at:      '<ISO>',
  cutoff_date:     '<YYYY-MM-DD>',          // boundary between train and test
  method:          'isotonic' | 'platt',
  global_curve:    [{ raw_lo, raw_hi, calibrated }, ...],   // for fallback
  stratified: {
    'YES_3-4': { n_train: <int>, curve: [...], in_use: <bool> },
    'YES_5-6': ...,
    ...
  },
  metrics: {
    brier_train, brier_test, brier_raw_test,
    logloss_train, logloss_test, logloss_raw_test,
    roi_replay_test, roi_replay_raw_test,
  },
  raw_train_min, raw_train_max,        // for OOD clipping
  source_dataset_hash:    '<sha256>',  // bets snapshot
}
```

### 2c. ctx (per-bet)

```js
{
  strike, side,
  // optional flags:
  calibration_enabled?:  boolean,         // ctx override (defaults to env)
  // standard Trace fields like other layers
}
```

### 2d. Hash linkage

```
result.matchup_output_hash === layer1Envelope.output_hash
result.calibrator_id      === <fitted artifact hash>
result.inputs_hash        = sha256({matchup_output_hash, strike, side, calibrator_id})
result.output_hash        = sha256(result minus output_hash)
```

---

## 3. Outputs

```js
{
  schema_version:        '1.0.0',
  layer:                 'calibration',
  layer_version:         '1.0.0',
  source:                'oracle_layer_1_5_calibration',
  run_id, decision_id, computed_at, commit_hash, fixture_id,
  inputs_hash, output_hash,
  matchup_output_hash,             // = layer1Envelope.output_hash

  strike, side,

  raw_prob_at_strike:        number,    // = envelope.prob_at_least[strike] (side-adjusted)
  calibrated_prob_at_strike: number,    // post-calibration
  delta:                     number,    // calibrated - raw

  stratum:                   string,    // e.g. 'YES_5-6'
  stratum_n_train:           number,    // training samples in this stratum
  used_global_fallback:      boolean,   // true if stratum n_train < 30
  ood_clipped:               boolean,   // true if raw was outside training range

  calibrator_id:             string,    // fitted artifact id (sha256)
  calibrator_method:         string,    // 'isotonic' | 'platt'

  flag_calibration_enabled:  boolean,   // observed flag value

  // ECHOES (read-only diagnostics)
  raw_prob_at_least:         { '3': p3, ..., '12': p12 },   // raw (unchanged)
  calibrated_prob_at_least:  { '3': c3, ..., '12': c12 },   // full per-strike map
}
```

**Behavior matrix:**

| Flag | Result | Downstream consumes |
|---|---|---|
| `false` (dark) | Both raw + calibrated populated; metrics flow into Trace | `raw_prob_at_least` (no behavior change) |
| `true` (live) | Same; downstream reads calibrated | `calibrated_prob_at_least` |

When `ctx.calibration_enabled === false` AND no calibrator artifact is loaded, Layer 1.5 is a passthrough — `calibrated_prob_at_strike === raw_prob_at_strike`, all stratum/method fields = null.

---

## 4. Calibration target

```
INPUT:   envelope.prob_at_least[k]     (raw, per-strike, side-adjusted internally)
OUTPUT:  calibrated_prob_at_least[k]   (per-strike)
```

**Side-adjusted** means: for YES, raw_prob = `envelope.prob_at_least[k]`. For NO, raw_prob = `1 - envelope.prob_at_least[k]`. The calibrator operates on side-adjusted probabilities (the probability that the bet WINS given side).

We do NOT calibrate `pK_blended`. We do NOT calibrate `lambda_final`. We do NOT calibrate the full distribution — only the single per-bet "wins" probability that drives downstream decisions.

---

## 5. Stratification

8 strata: `(strike_bucket × side)` cross-product.

| strike_bucket | strikes |
|---|---|
| 3-4 | 3, 4 |
| 5-6 | 5, 6 |
| 7-8 | 7, 8 |
| 9+ | 9, 10, 11, 12 |

| side | values |
|---|---|
| YES | YES |
| NO | NO |

Stratum keys: `'YES_3-4'`, `'YES_5-6'`, `'YES_7-8'`, `'YES_9+'`, `'NO_3-4'`, `'NO_5-6'`, `'NO_7-8'`, `'NO_9+'`.

Locked decisions (rejected for v1):
- Per-strike (10×2 = 20 strata) — too thin
- Per-feasibility (8×4 = 32 strata) — too thin, and would couple Layer 1.5 to Layer 2
- Global only (1 stratum) — loses the side asymmetry the audit revealed

---

## 6. Fallback rules

```
If stratum.n_train < 30:
  use global calibrator (across all bets)
  result.used_global_fallback = true
  result.stratum = '<original>'   (still recorded so we know what happened)
```

The training script also tracks per-stratum sample sizes and emits
warnings if any stratum has < 30. The artifact's `stratified.<key>.in_use`
field reflects whether each stratum's individual curve is used or the
global curve is the active fallback.

**Crucially: per-stratum n_train < 30 does NOT block training.** The
artifact still ships; the global curve handles the thin strata. As more
data accumulates, more strata will graduate to their own curves.

---

## 7. Train/test split

**Time-based, not random.** Random splits leak pitcher × bet_date
patterns into training.

```
Sort all settled-pre-game-bet (raw_prob, actual_outcome) pairs by bet_date.
train = earliest 70% of distinct bet_dates
test  = latest 30% of distinct bet_dates
```

Splitting by **distinct dates** (not by row count) ensures all bets
from a given slate land on the same side of the cutoff. The actual
cutoff date is recorded in the artifact and printed in the calibration
report.

The training script must:
- Print `train_period`, `test_period`, `cutoff_date` in the report
- Refuse to fit if test set < 50 bets (with a clear error message)
- Include a `--dry-run` mode that fits and reports without writing the artifact

---

## 8. Model methods

### 8a. Isotonic regression (primary)

Sklearn-style monotonic step function. Free-form mapping `raw → calibrated` constrained to be non-decreasing. Fit per-stratum (and globally) via PAV algorithm.

Implementation: pure JavaScript. No sklearn dependency. Reference algorithm: Pool-Adjacent-Violators (PAV).

Storage: array of `{raw_lo, raw_hi, calibrated}` segments, sorted by `raw_lo`.

### 8b. Platt scaling (control)

Logistic regression: `calibrated = sigmoid(a × raw + b)`. Fit per-stratum and globally.

Used as a sanity check, NOT shipped. The chosen method (isotonic) is what production reads. Both are computed and reported; only one is wired into the runtime calibrator.

### 8c. Method selection

Locked v1: **isotonic**. Platt is computed for comparison and reported but not consulted at runtime.

Rationale: the audit shows non-uniform bias (mid-range overconfidence, low/high range OK-ish). Isotonic handles non-linear bias shapes without parametric assumptions. Platt assumes a sigmoidal correction which fits some patterns but not arbitrary ones.

---

## 9. Out-of-distribution (OOD) clipping

```
if raw_prob < raw_train_min:
  calibrated = isotonic_curve_at(raw_train_min)
  result.ood_clipped = true
elif raw_prob > raw_train_max:
  calibrated = isotonic_curve_at(raw_train_max)
  result.ood_clipped = true
else:
  calibrated = isotonic_curve_at(raw_prob)
  result.ood_clipped = false
```

No extrapolation. If the raw probability is outside the range we observed in training, we use the nearest endpoint of the curve. Conservative.

---

## 10. Metrics (reported on every train run)

### 10a. Calibration metrics

```
brier_train       = mean((p - actual)^2) on train set, raw
brier_test_raw    = same on test, raw
brier_test_calib  = same on test, post-calibration
delta_brier       = brier_test_calib - brier_test_raw   (negative = improvement)

logloss_train     = mean(-y log p - (1-y) log(1-p)) on train, raw (clipped)
logloss_test_raw  = same on test, raw
logloss_test_calib = same on test, post-calibration
delta_logloss     = logloss_test_calib - logloss_test_raw  (negative = improvement)
```

### 10b. ROI-replay metric

For each test-set bet:
- recompute decision under fixed-size policy (skip if edge < 12¢, else fire at production size, fragile = half-size — same as audit's fixed-size measure)
- using BOTH raw and calibrated prob_at_strike
- report:

```
roi_test_raw       = sum(pnl_under_raw_decisions)
roi_test_calib     = sum(pnl_under_calib_decisions)
delta_roi          = calib - raw   (positive = improvement)
roi_pct_size_raw   = roi_test_raw / total_test_size
roi_pct_size_calib = roi_test_calib / total_test_size
```

### 10c. Per-stratum table

| stratum | n_train | n_test | brier_raw | brier_calib | delta | n_strict (n>=30) |
|---|---|---|---|---|---|---|
| YES_3-4 | 47 | 21 | 0.245 | 0.231 | -0.014 | yes |
| ... | ... | ... | ... | ... | ... | ... |

### 10d. Calibration curve plot data

For both raw and calibrated, on test set, in 10 decile-buckets:
- avg predicted prob
- actual hit rate
- bucket size
- bias (predicted - actual)

This is the visual "is calibration getting better" check.

### 10e. Cross-stratum example transformations

Per the design note: show examples where the SAME raw probability gets DIFFERENT calibrated probabilities depending on stratum. This is intentional and visible:

```
raw 0.70 in YES 5-6 → calibrated 0.42  (this stratum is overconfident here)
raw 0.70 in NO 5-6  → calibrated 0.65  (this stratum is closer to truth)
raw 0.70 in YES 9+  → calibrated 0.25  (extreme overconfidence in tail YES)
```

---

## 11. Hash / version / artifact

### 11a. Calibrator artifact ID

```
calibrator_id = sha256({
  schema_version,
  method,
  cutoff_date,
  source_dataset_hash,    // hash of (bet_id, raw_prob, actual_outcome) tuples used in train
  stratification_keys,
})
```

The artifact is stored as:
`oracle/layers/1.5-calibration/calibrators/<calibrator_id>.json`

A symlink-or-pointer at `oracle/layers/1.5-calibration/active.json` indicates which artifact is currently loaded. Production reads `active.json`; previous fits remain on disk for replay.

### 11b. Versioning

| Field | Value |
|---|---|
| schema_version | 1.0.0 |
| layer_version | 1.0.0 |
| LAYER_NAME | 'calibration' |
| SOURCE | 'oracle_layer_1_5_calibration' |

Schema bump means breaking change to artifact format. Layer version
bump means breaking change to runtime API. Both invalidate cached
calibrator artifacts.

### 11c. Trace event integration

`event_type='decision'`, `decision = 'calibrated' | 'passthrough'`,
`reason_code` from a small vocab:

| reason_code | when |
|---|---|
| `clean_calibrated` | calibrator applied without fallback or OOD |
| `global_fallback` | stratum had n_train < 30, used global curve |
| `ood_clipped` | raw prob was outside training range |
| `passthrough_disabled` | flag false; no calibration applied |
| `passthrough_no_artifact` | no calibrator loaded |

Trace event evidence_used links to the L1 envelope hash AND the calibrator_id.

---

## 12. Production posture

`CALIBRATION_ENABLED=false` by default. Same shape as DK blend:

```
ctx.calibration_enabled !== undefined
  ? !!ctx.calibration_enabled
  : process.env.CALIBRATION_ENABLED === 'true'
```

When dark:
- Both raw and calibrated probabilities populate envelope.dk_blend-style peer block
- Downstream reads `raw_prob_at_least` (no behavior change)
- Trace records the calibrator's would-have outcome for shadow logging

When live:
- Downstream reads `calibrated_prob_at_least`
- All chain hashes incorporate the calibration

Staged rollout (each stage requires explicit owner approval):

| Stage | Duration | Behavior |
|---|---|---|
| Stage 1 — Train + Shadow | 2 weeks | Calibrator fitted; runs on every bet; logs both raw + calibrated; downstream uses raw |
| Stage 2 — Test cohort | 1 week | Calibration_enabled=true on a single test account or strike subset |
| Stage 3 — Full | ongoing | Calibration_enabled=true everywhere |

---

## 13. Bar to flip the flag (Stage 2 and 3)

ALL of the following must be true:

```
delta_brier   ≤ -0.005    (calibrated test Brier strictly better)
delta_logloss ≤ -0.02     (calibrated test log-loss strictly better)
delta_roi     ≥ 0          (fixed-size ROI replay improves OR stays flat)
test_n_bets   ≥ 150        (sufficient sample)
≥ 4 of 8 strata have n_train ≥ 30   OR   global calibrator independently
                                          beats both Brier and log-loss bars
```

Plus a no-major-stratum-regression guard:

```
no individual stratum's calibrated Brier worse than its raw Brier by > 0.01
```

If sample is too small or the regression guard trips, ship dark only.

---

## 14. Out of scope (v1)

- Per-feasibility or per-trust-level calibration (would couple Layer 1.5 to Layer 2/3)
- Per-pitcher calibration (sample too thin)
- Per-archetype calibration (deferred until per-archetype sample is sufficient)
- Multi-strike joint calibration (NB-curve preserving) — separate research project
- Online learning (calibrator updates per bet) — manual retrain only in v1
- Web search / news for calibration features
- Sonnet escalation
- Layer 4 Critic interaction (Critic's verdict is independent of probability calibration)

---

## 15. Implementation plan

| Bite | Deliverable |
|---|---|
| L1.5.1 | This spec (locked) |
| L1.5.2 | `scripts/oracle/calibrationBacktest.js` — pulls bets, time-splits, fits isotonic + Platt globally and per-stratum, emits report. Does NOT write the production artifact yet. Pure analysis. |
| L1.5.3 | If L1.5.2 clears the bar: `scripts/oracle/fitCalibrator.js` — manual retrain script that writes artifact JSON to disk |
| L1.5.4 | `oracle/layers/1.5-calibration/calibrator.js` — pure helper: load artifact, apply transformation, return calibrated prob |
| L1.5.5 | `oracle/layers/1.5-calibration/impl.js` — `run(layer1Envelope, ctx)` wrapping the calibrator with envelope/Trace shape |
| L1.5.6 | Unit tests for calibrator helpers + impl (mocks the artifact) |
| L1.5.7 | Re-run full Oracle pipeline backtest with calibration ON (compare to current) — see whether sizing inversion / NO bucket / pitcher concentration findings collapse into the calibration fix |

Bites L1.5.2 and L1.5.7 are the high-value diagnostic steps. L1.5.3-L1.5.6 are mechanical work to ship the fix once the diagnostic motivates it.

---

## 16. Open items not locked here

- Whether to fit a separate calibrator for DK-blend-applied bets vs not (irrelevant while DK is dark; revisit if DK ships)
- Whether to retroactively rebuild Layer 2 fixtures with calibrated probs (for parity tests). Locked: no. Layer 2 fixtures stay against raw probs; calibration is a runtime overlay.
- Whether to expose the per-stratum bias deltas to Trust / Critic as additional context (could; deferred to v1.1)
- ROI replay edge threshold for the metric (default 12¢; matches production gate)

---

*Spec locked 2026-05-01. Updates require explicit re-locking with version bump.*

---

## Addendum A — L1.5.2 first-look result (2026-05-01)

The first calibration backtest produced a **disciplined NO-GO**. Recorded here for future reference.

### What ran

- Window: 2026-04-20 → 2026-05-01 (11 distinct bet_dates)
- 622 bets loaded; 581 trainable (win/loss only)
- Time split at 2026-04-26: 7 train dates / 4 test dates
- 461 train bets, 120 strict-test bets
- Both isotonic and Platt fitted globally and per-stratum (8 strata)

### Test-set metrics

| metric | raw | isotonic | platt |
|---|---:|---:|---:|
| Brier | 0.3254 | 0.3349 (+0.0095) | 0.3135 (-0.0119) |
| log-loss | 0.8665 | 3.3277 (+2.46) | 1.2043 (+0.34) |
| ROI replay | -$575 | -$174 (+$401) | -$221 (+$354) |

### Flip-bar verdict

NO-GO on every method. Failed:
- delta_brier (isotonic only — Platt cleared)
- delta_logloss (both)
- test_n_sufficient (120 < 150)
- no_major_stratum_regression (YES_7-8 had Δ Brier +0.111)

### Methodology finding (locked)

**Isotonic overfit badly on small per-stratum samples.** With train-set sizes around 30-115 per stratum, the PAV algorithm produced extreme step functions (mapping inputs to 0.000 or 1.000), which exploded log-loss on test bets that landed in those segments. Cross-stratum table showed e.g. raw 0.50 in YES_3-4 → 0.000, raw 0.70 in YES_7-8 → 1.000.

**Platt/logit was more stable.** Parametric form (`sigmoid(a · logit(p) + b)`) cannot produce extreme outputs from moderate inputs. Beat raw on Brier (-0.0119 ≤ -0.005 bar) but failed log-loss bar and sample-size bar.

**Raw bias remains real.** Test-set buckets confirm the audit's finding:
- 0.5-0.6 bucket: predicted 55% / actual 33% / bias +21pp
- 0.7-0.8 bucket: predicted 73% / actual 6% / bias +67pp
- 0.9-1.0 bucket: predicted 91% / actual 0% / bias +91pp (n=2; noise)

### v1 method posture (revised)

**Platt/logit is preferred for small samples** (under ~50 train per stratum). Parametric smoothness avoids the extreme-output problem.

**Isotonic remains a candidate when samples grow.** PAV is more flexible and can capture non-uniform bias correction patterns once each stratum has enough density. Reconsider when samples allow.

The runtime calibrator interface stays method-agnostic. The artifact's `method` field declares which curve is shipped.

### Rerun trigger (locked)

Re-run `calibrationBacktest.js` when **any** of:

1. ≥30 additional days of decision_pipeline JSON capture have accumulated past 2026-05-01, OR
2. ≥500 settled pre-game bets in the dataset, OR
3. ≥150 test-set bets with at least 4 strata at n_train ≥ 30

Until then, calibration stays dark; downstream findings (pitcher concentration, NO-bucket losses, sizing inversion, Critic broadening) remain blocked behind calibration as the upstream cause.

### Next-run requirements

When re-run, the report MUST include in addition to current metrics:

- **ECE (Expected Calibration Error)**: weighted average absolute calibration error across probability deciles. Better discriminates "probs got smoother" from "probs got more useful for thresholds."
- **MCE (Maximum Calibration Error)**: worst single-bucket calibration error.

Both computed for raw, isotonic, and Platt. Bucketed by decile.

### Bottom line

The harness caught why calibration shouldn't ship. That's the successful outcome — calibration hypothesis remains alive, production answer is NO-GO until rerun trigger fires.
