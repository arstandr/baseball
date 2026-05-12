# DK Blend — Decision Memo (Bite 6.4)

**Date:** 2026-05-01
**Status:** Decision review only. No code change. No production flip.

---

## 1. What the hypothesis was

Production strikeout-K probability estimates are noisier for pitchers
with thin sample (rookies, post-IL returns, weak BF source). The
DraftKings/FanDuel total-K line is set by sharp markets and may carry
information that complements our model — specifically about
**workload / opportunity (E[BF])**, not strikeout skill.

Bite 6 v1 wired DK as a **bounded BF prior**:

- `λ_dk` inverted from DK over/under line + over price
- `BF_dk = λ_dk / pK_ours`
- `E[BF]_blended = (1 − w_dk)·E[BF]_ours + w_dk·BF_dk`
- `λ_base_blended = E[BF]_blended × pK_ours` → outer chain composes as usual
- `pK` not modified
- BF blend skipped (not clipped) if `|bf_delta| > 3 BF`
- `STABLE` class always `w_dk = 0`
- Default flag OFF

Production candidate weights pending backtest: **THIN=0.20, MID=0.05, STABLE=0.00**.

---

## 2. What the backtest showed

Backtest run 2026-05-01. See
`oracle/layers/1-math/dkBlend-backtest-2026-05-01.md`.

- 621 settled placed pre-game bets in the 60-day window
- 301 replayable (DK match + decision_pipeline JSONs)
- DK overlap window: only **7 days** (2026-04-24 → 2026-04-30)
- Class split at candidate weights: THIN=22, MID=111, STABLE=168

Candidate schedule (T=0.20, M=0.05, S=0.00) deltas vs baseline:

| Metric | Value |
|---|---:|
| flipped→skip | 2 bets |
| ΔBrier (overall) | −0.0001 |
| ΔLogLoss (overall) | −0.0002 |
| ΔROI fixed-size | +$58.71 |
| ΔROI Kelly-resized | +$63.12 |
| median \|Δλ\| | 0.000 |
| p95 \|Δλ\| | 0.034 |

Where the signal is concentrated:

- **All +$58.71 ROI improvement came from MID class, YES side, 5-6 strike bucket** (n=2 bets)
- **THIN bucket** (the design target): 0 flips, ΔBrier=+0.0020, ΔROI=$0
- STABLE: unchanged by design (w_dk=0)

Hard baseline assertion (T=0/M=0/S=0 must produce zero deltas) passed.

---

## 3. Why it failed the enable bar

Illustrative thresholds for THIN bucket:

| Check | Threshold | Observed | Result |
|---|---|---|---|
| THIN n ≥ 30 | 30 | 22 | **WARN** |
| THIN ΔBrier ≤ −0.005 | improvement | +0.0020 | **FAIL** |
| THIN ΔLogLoss ≤ −0.02 | improvement | +0.0044 | **FAIL** |
| THIN ΔROI_fix > 0 | positive | $0 | **FAIL** |
| median \|Δλ\| ≤ 0.5 K | sanity | 0.000 | PASS |
| p95 \|Δλ\| ≤ 1.5 K | sanity | 0.034 | PASS |

THIN — the bucket where the design hypothesis predicted improvement — failed every signal threshold.

The +$58.71 fixed-size ROI delta is real but:
- driven by **two MID bets** (coin-flip territory)
- concentrated in a single strike bucket (5-6) and side (YES)
- not present in THIN, where the hypothesis lives

Seven days of DK overlap is not enough sample. Enabling now would
chase a $58 signal anchored on n=2.

---

## 4. What data threshold triggers a re-review

Re-run `scripts/oracle/dkBlendBacktest.js` and re-evaluate when **either**:

1. **30+ days of DK overlap** have accumulated (i.e. on or after 2026-05-24), OR
2. **THIN bucket size ≥ 30** in the replayable set, whichever comes first

Cadence between re-reviews: **weekly** while the sample is below the bar.

Re-review is informational unless **all** of the following clear:

- THIN n ≥ 30
- THIN ΔBrier ≤ −0.005
- THIN ΔROI_fix > 0
- median \|Δλ\| ≤ 0.5 K
- p95 \|Δλ\| ≤ 1.5 K
- No single bet flip > 25% of total ROI delta
- No single pitcher > 40% of THIN bucket sample
- Median bf_delta direction consistent with vig (slightly positive, not extreme)

---

## 5. What remains dark in production

| Item | Status |
|---|---|
| `DK_BLEND_ENABLED` env flag | `false` (production) |
| `computeMatchup` math behavior with no `ctx.dkContext` | Unchanged (byte-for-byte parity vs Bite 3+4) |
| `computeMatchup` with `ctx.dkContext` + flag false | Counterfactual `envelope.dk_blend` block populated; math UNCHANGED; `skip_reason='flag_off'` |
| Trace events when blend is dark | Carry `reasoning.dk_blend` audit info if `dkContext` was provided; metrics not affected by blend |
| Bite 6.5 (env flip + shadow run) | **Not started**. Gated on this memo's verdict. |
| Backtest harness | Available; re-runs informational |
| `dkBlend.js` helpers | Pure, tested (193 assertions); no live wiring |

---

## Decision

**Locked: keep DK blend dark.** Do not flip `DK_BLEND_ENABLED`.

Re-review trigger: 30 days of DK overlap (2026-05-24) OR THIN n ≥ 30,
whichever comes first. Until then, the harness produces weekly
informational reports; no production decisions are made on the
preliminary signal.

The Bite 6 v1 architecture is intact and ready to be enabled if a
future backtest clears the bar. We are not chasing a $58 signal
anchored on n=2.
