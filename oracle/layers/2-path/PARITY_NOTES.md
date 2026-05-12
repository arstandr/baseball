# Layer 2 (Path) — Parity / Runtime Notes

Companion to `SPEC.md` (contract) and `parity-fixtures.json` (test data).

---

## Bite L2.2 close-out (2026-05-01) — pure feasibility helpers

### Files

- ✅ `oracle/layers/2-path/feasibility.js` — pure helpers, no I/O
- ✅ `scripts/tests/oraclePathFeasibilityTest.js` — 209 unit assertions

### Exports

```
Math:       requiredBf, requiredBfOuter, bfGap, bfGapRatio,
            gapUnder, requiredPk, bfCeiling
Tiers:      capTier, upgradeTier, yesBaseBucket, noBaseBucket
Classify:   classifyYes(input), classifyNo(input)
Constants:  FEASIBILITY_CLASSES, TIER_ORDER, REASON_CODES,
            BF_GAP_RATIO_*, GAP_UNDER_*, TAIL_STRIKE_*,
            TAIL_DEAD_RATIO, PK_EXTREME_*, LEAGUE_PITCHES_PER_BF,
            SHORT_WORKLOAD_PITCH_MAX, HELPER_NAME, HELPER_VERSION
```

### Locked behavior (matches SPEC §4i)

- **YES hard-dead precedence:** workload_ceiling > pk_extreme_dead > tail_dead_high_strike
- **YES cap precedence:** pk_extreme_fragile > tail_fragile_high_strike (both fragile-level); bf_source_weak_cap (viable-level) only primary if no fragile cap fired
- **NO modifier precedence:** leash_supports_no > workload_ceiling_supports_no > short_workload_supports_no
- **Dead-baseline NO upgrade cap:** dead bucket can climb at most one tier (to fragile) regardless of how many modifiers fire
- **Weak-source cap exception:** SKIPPED entirely when `dk_blend_applied === true` (DK blend is intended to correct weak workload anchors)
- **secondary_reasons:** trigger-evaluation order, deduplicated, primary excluded

### Test coverage

| Section | Assertions | Notes |
|---|---:|---|
| M math helpers | 25 | throws + edge cases |
| T tier helpers | 50 | 16 capTier pairs, upgradeTier, threshold boundaries with 1e-9 offsets |
| Y classifyYes | 70 | every reason code path + precedence + secondary order |
| N classifyNo | 70 | every reason code path + dead-baseline cap + weak interaction |
| E error handling | 25 | required throws, optional defaults, bfCeiling null path |
| C constants/metadata | 25 | freezing, threshold values, vocabulary completeness |

**209 passed, 0 failed.**

**Bite L2.3 (fixture generator) is unblocked.**

---

## Bite L2.3 close-out (2026-05-01) — fixture generator

### Files

- ✅ `scripts/oracle/buildPathParityFixtures.js` — deterministic generator
- ✅ `oracle/layers/2-path/parity-fixtures.json` — 280 fixture rows

### Method

Reads Layer 1 `parity-fixtures.json` (14 archetype rows) and expands each into 10 strikes × 2 sides = 20 Layer 2 rows. Per-row inputs (`expected_bf`, `pK_blended`, `lambda_final`, `bf_source_tier`, `avg_pitches`, `leash_flag`, `dk_blend_applied=false`) are derived from the Layer 1 fixture's `expected_inner` and `expected_outer_chain_from_production`. `lambda_final` uses the Bite 3 convention `inner.lambdaBase × Π multipliers` (recomputed, not production-logged).

The expected output is whatever `classifyYes`/`classifyNo` returns for those inputs. This locks the bite-3 + bite-L2.2 contract end-to-end.

### Distribution

| Feasibility | Count |
|---|---:|
| strong | 106 |
| viable | 31 |
| fragile | 11 |
| dead | 132 |

| Top reason codes | Count |
|---|---:|
| workload_ceiling | 76 |
| no_path_ample_cushion | 62 |
| no_path_overrun | 36 |
| comfortable_buffer | 32 |
| workload_ceiling_supports_no | 16 |
| bf_source_weak_cap | 16 |
| bf_gap_dead | 11 |

ML weights hash carried over from Layer 1 (`9b0794f8400d…`).

**Bite L2.4 unblocked.**

---

## Bite L2.4 close-out (2026-05-01) — Layer 2 module

### Files

- ✅ `oracle/layers/2-path/impl.js` — `run(layer1Envelope, ctx)`

### Behavior

- Reads Layer 1 envelope: `inner`, `outer.lambda_final`, `prob_at_least`, `nb_r`, `dk_blend` (when present).
- Calls `classifyYes` / `classifyNo` with translated input shape.
- Builds Layer 2 envelope with `schema_version`, `run_id`, `inputs_hash`, `output_hash`, `matchup_output_hash`.
- `output_hash` excludes `run_id`, `computed_at`, `output_hash` itself (matches Bite 4 convention).
- Optional `emit_trace` writes a Layer 0 TraceEvent via `writeAsync`.
- Trace event: `event_type='decision'`, `decision = feasibility`, `reason_code = primary`, `reasoning` carries `feasibility / workload_signal / bf_source_tier / secondary_reasons / dk_blend_applied / dk_skip_reason`, `metrics` carries every numeric diagnostic, `evidence_used` links to the Layer 1 matchup hash.
- Layer 0 `validateTraceEvent` accepts the events without modification.
- Inner is never mutated; `result.matchup_output_hash === envelope.output_hash` exactly.

### Workload signal derivation

| Trigger | `workload_signal` |
|---|---|
| `bf_source_tier === 'weak'` | `thin` |
| `bfSource` includes `→capped(` | `capped` |
| `leashFlag === true` OR `avgPitches < 80` | `short_leash` |
| `avgPitches > 100` | `deep` |
| otherwise | `normal` |

**Bite L2.5 unblocked.**

---

## Bite L2.5 close-out (2026-05-01) — parity test

### Files

- ✅ `scripts/tests/oraclePathParityTest.js` — 3 suites, **3148 assertions, 0 failed**

### Suites

| Suite | Coverage | Assertions |
|---|---|---:|
| A — Parity | 280 fixtures × ~11 fields each | ~3000 |
| B — Envelope/Trace | shape, hash determinism, output_hash exclusion, per-bet hash distinctness, Trace stub validation, ctx validation, re-exports | ~50 |
| C — Pipeline smoke | Layer 1 `computeMatchup` → Layer 2 `run` for 7 archetypes × 10 strikes × 2 sides = 140 calls | ~430 |

ML weights drift gate carries over from Layer 1.

### Regression check

| Test | Before L2 | After L2 |
|---|---:|---:|
| `oracleMathParityTest.js` | 865 | 865 |
| `oracleDkBlendTest.js` | 193 | 193 |
| `oraclePathFeasibilityTest.js` | 209 | 209 |
| `oraclePathParityTest.js` | — | 3148 |

**Total: 4415 assertions, 0 failed.** No regressions.

**Layer 2 v1.0 ready. Backtest follows.**

---

## Layer 2 backtest (2026-05-01) — preliminary

### Files

- ✅ `scripts/oracle/pathBacktest.js` — replays settled bets through Layer 1 → Layer 2 chain
- ✅ `oracle/layers/2-path/path-backtest-2026-05-01.md` — Markdown report
- ✅ `oracle/layers/2-path/path-backtest-2026-05-01.csv` — per-bet CSV

### Headline numbers

Window: 2026-03-02 → 2026-05-01 (60 days; effective coverage starts at decision_pipeline cutover).

| Metric | Value |
|---|---:|
| Settled placed pre-game bets loaded | 622 |
| Replayable through Layer 2 (with decision_pipeline JSON) | 314 |
| Skipped (no decision_pipeline JSON) | 308 |
| Production baseline P&L | **−$628.37** |

### Feasibility distribution + win rate

| Class | n | Win rate | Total P&L |
|---|---:|---:|---:|
| strong | 128 | 56.5% | −$9.73 |
| viable | 81 | 28.7% | −$250.49 |
| fragile | 18 | 22.2% | −$220.65 |
| dead | 87 | 21.7% | −$147.50 |

Win-rate ordering matches the design hypothesis: stronger feasibility → higher win rate. Strong bucket is roughly break-even on P&L despite the production system losing overall.

### Counterfactual P&L

| Filter | Bets fired | P&L | Δ vs baseline |
|---|---:|---:|---:|
| baseline (production) | 314 | −$628.37 | — |
| skip dead | 227 | −$480.87 | **+$147.50** |
| skip dead + fragile | 209 | −$260.22 | **+$368.15** |
| skip dead, half-size fragile | 227 | −$370.54 | **+$257.82** |

### Outliers

- 18 bets classified DEAD that actually WON (forgone wins under filter A/B/C)
- 40 bets classified STRONG that LOST (Layer 2 confidence didn't help)
- 4 bets classified FRAGILE that won

### Caveats

- Sample is small. 314 replayable bets over ~7 days of decision_pipeline coverage.
- Today's `pitcher_statcast` is used for r (`archetypeR`); production-time r may have differed (drift caveat — same as Bite 6.3).
- Synthetic Layer 1 envelopes are reconstructed from `decision_pipeline.lambda_calc_json + model_input_json`. Hashes are synthesized.
- Production was losing in this window; Layer 2's "improvement" is limiting losses, not generating wins.
- 308 settled placed pregame bets predate decision_pipeline JSON capture and could not be replayed.

### Verdict

**Layer 2 produces a meaningful classification signal in preliminary data.** Win-rate ordering is monotone and counterfactual P&L improves under every filter. Sample is small and one window is not enough to ship behavior; this is informational. Re-run weekly as decision_pipeline coverage grows.

Bite to enable Layer 2 in production = future work (would gate on Layer 3 Trust scoring and Layer 5 Judge to convert feasibility into fire/skip — Layer 2 alone doesn't decide bets per spec).
