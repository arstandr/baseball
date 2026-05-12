# Layer 1 (Math) — Extraction Notes

**Bite 1 deliverable. Read-only documentation of the production lambda computation.**
**No code yet. This document gates Bite 2 (parity harness) and Bite 3 (extraction).**

Source files under documentation:
- `scripts/live/strikeoutEdge.js` — `computeLambdaBase`, outer multiplier chain, `computeWeatherMult`, `fetchOpponentKpct`, `computeSlotWeightedKpct`
- `lib/strikeout-model.js` — `nbCDF`, `pAtLeast`, `archetypeR`, `ipToDecimal`, league constants
- `lib/pkModel.js` — `loadModel`, `predictPk`, `buildFeatures` (Ridge regression overlay)
- `lib/parkFactors.js` — `getParkFactor` (referenced; not yet read in detail)
- `lib/umpireFactors.js` — `getUmpireFactor` (referenced; not yet read in detail)

---

## 1. The complete formula

```
λ_final = lambdaBase × splitAdj × effectiveAdj × parkFactor × weatherMult × umpFactor

lambdaBase = expectedBF × pK_final
pK_final   = pK_afterVelo × bbPenalty × ttoPenalty
pK_afterVelo = pK_blended × veloAdj
pK_blended   = ml_pK ?? pK_blended_formula
```

All multipliers are unbounded numerics (no soft caps in `pK_final` itself, only in the outer multiplier chain via `splitAdj` ∈ [0.88, 1.12], `effectiveAdj` ∈ [0.85, 1.15] for lineups).

---

## 2. Inputs to `computeLambdaBase`

Function signature: `computeLambdaBase(log, gameDate, savant, career, recentStartsData, careerAvgFbVelo)`.

### 2.1 `log` — pitcher game log
- Source: `fetchGameLog(pitcherId)` — MLB API + cache
- Shape: array of `{ date, started, ip, bf?, k }` rows
- Used for: `last5` (most recent 5 STARTED games before gameDate)

### 2.2 `gameDate` — string YYYY-MM-DD
- Used as cutoff filter on log

### 2.3 `savant` — current-season `pitcher_statcast` row (nullable)
- Fields read:
  - `k_pct` (current-season K rate) → `pK_season`
  - `ip` (current-season IP) → blend weights
  - `pa` (current-season PA) → derive PA/IP for k9_season
  - `swstr_pct` → SwStr%-implied K% correction (formula-only, when ML not running)
  - `fb_velo` → velocity trend signal
  - `manager_leash_factor` → bf scaling
  - `nb_r` (optional pre-fitted) → archetypeR
  - `gb_pct`, `bb_pct`, `k_pct_vs_l`, `k_pct_vs_r` → ML feature inputs
- Falls back to: nothing — entire `pK_season` branch is skipped

### 2.4 `career` — multi-year career totals (nullable)
- Fields read:
  - `k_pct` → `pK_career`
  - `k9` → `careerK9` for L5 regression cap
  - `avg_ip` → `careerIp` for E[BF] fallback
  - `seasons` → display only
- Falls back to league constants when null

### 2.5 `recentStartsData` — `pitcher_recent_starts` rows
- Shape: array of `{ bf, pitches }`
- Used for: E[BF] computation (preferred over log when length ≥ 2)
- Computes `avgPitches` for leash flag

### 2.6 `careerAvgFbVelo` — career fb_velo average from 2023-2025 (nullable)
- Used for: velocity trend signal (`savant.fb_velo - careerAvgFbVelo`)

---

## 3. Outputs of `computeLambdaBase` (verbatim from line 668)

```
{
  lambdaBase,        // expectedBF × pK_final
  k9,                // pK_final × LEAGUE_PA_PER_IP × 9
  pK_blended,        // = pK_final (the chosen rate after all adjustments)
  pK_formula,        // hand-tuned 3-way blend (pre-ML)
  ml_pK,             // ML overlay output (null when not used)
  k9_l5, k9_season, k9_career,  // per-source k9 rates
  w_career, w_season, w_l5,     // blend weights (sum to 1)
  expectedBF, avgIp, bfSource, avgPitches, leashFlag,
  nStarts, confidence, earlyExitRate,
  whiffFlag, savantNote, careerNote,
  veloTrendMph, veloAdj,
  bbPenalty,         // currently always 1.0 (disabled per Apr 24 backtest)
  ttoPenalty, ttoNote,
}
```

`confidence` here is a string label (`high`/`medium`/`low` + data source tag), NOT the structured object we want for Layer 1's interface.

---

## 4. Outer multiplier chain (lines 1000-1041)

After `computeLambdaBase` returns, the caller computes:

| variable | source | formula | bounds |
|---|---|---|---|
| `oppKpct` | `fetchOpponentKpct(...)` | lineup slot-weighted → lineup equal-weight → DB historical → MLB API → league_avg | — |
| `adjFactor` | derived | `oppKpct / LEAGUE_K_PCT` | unbounded |
| `effectiveAdj` | conditional | lineup source: clamp `[0.85, 1.15]`; team avg: gate at `\|adj-1\|>0.28`, else 1.0 | bounded |
| `parkFactor` | `getParkFactor(home_team)` | per-park K-rate multiplier | unbounded |
| `weatherMult` | `computeWeatherMult(wx)` | wind/temp/humidity stack: `[0.97, 0.96, 1.02]` | typically `[0.92, 1.04]` |
| `umpFactor` | `getUmpireFactor(ump_name)` | HP umpire K% tendency | unbounded |
| `splitAdj` | derived from `savant.k_pct_vs_l/r` | `(0.40 × kvL + 0.60 × kvR) / k_pct`, clamp `[0.88, 1.12]` | bounded |
| `λ_final` | composition | `lambdaBase × splitAdj × effectiveAdj × parkFactor × weatherMult × umpFactor` | unbounded |

**Critical for parity test:** the outer chain is NOT inside `computeLambdaBase`. Layer 1's interface must encompass both the inner function AND the outer chain.

---

## 5. Per-strike probability (line 1156-1163)

```js
const pitcherNbR   = archetypeR(savant)
const rawModelProb = Math.max(0, 1 - nbCDF(lambda, pitcherNbR, mkt.strike - 1))
const modelProb    = rawModelProb  // shrinkage explicitly disabled (note at line 1161-1162)
```

**archetypeR IS already used in the pre-game path** (line 1156). Backlog #36 ("Wire archetypeR pre-game") may already be complete in this code path. Worth confirming with the user before doing it again.

archetypeR resolution:
1. `savant.nb_r` (if pre-fitted by `fitDispersion.js`)
2. `k_pct ≥ 0.28` → `r=20` (power, tighter)
3. `k_pct ≤ 0.19` → `r=50` (contact, wider tails)
4. else → `r=30`

---

## 6. The 3-way K% blend (computeLambdaBase lines 502-608)

Three sources, weighted by Statcast IP coverage:

| source | computation | weight |
|---|---|---|
| `pK_season` | `savant.k_pct` (with optional SwStr% correction when ML doesn't run) | `w_season = min(0.60, savant.ip / 30)` |
| `pK_career` | `career.k_pct` | `w_career = max(0, 0.40 × (1 - savant.ip / 40))` |
| `pK_l5` | last-5-game total K / total BF, regressed to career when nStarts < 5, capped at `careerK9 × 1.25` | `w_l5 = 1 - w_career - w_season` |

Renormalization branches when `pK_career` or `pK_season` is missing.

ML overlay (`predictPk`) replaces the formula when `_pkModel != null && savant.ip >= 5`. ML output is clipped to `[0.05, 0.55]` per `pkModel.js` line 136.

**Calibration history baked in:**
- L5 regression cap at 1.25× career — explicit comment cites "Sánchez Apr 23: L5 was 32% above career → model said 81% YES → got 4 Ks → -$430"
- BB penalty disabled — explicit comment cites "backtest with n=28,973 predictions showed BB_THRESHOLD=1.0 (disabled) produces better Brier score"

---

## 7. E[BF] computation (lines 439-498)

Priority chain:
1. `pitcher_recent_starts` rows — `BF×N`
2. Last-5 game log BF — `logBF×N`
3. Last-5 IP × `LEAGUE_PA_PER_IP` (4.44) — `ip×PA/IP`
4. `careerIp × LEAGUE_PA_PER_IP` — `career_ip×PA/IP`

Modifications:
- **Leash cap**: if `avgPitches < 85`, cap `expectedBF ≤ avgPitches / 3.8` (`LEAGUE_PITCHES_PER_BF`)
- **Manager leash factor**: multiply by `savant.manager_leash_factor` (default 1.0)

`leashFlag = avgPitches < 85` becomes part of the output.

---

## 8. Velocity trend signal (lines 561-576)

If `savant.fb_velo` and `careerAvgFbVelo` both available:

| condition | `veloAdj` | `whiffFlag` |
|---|---|---|
| `> +1.0 mph vs career` | 1.03 | 'velo-up' |
| `< -1.5 mph vs career` | 0.96 | 'velo-down' |
| else | 1.0 | (preserves existing flag if any) |

Note the asymmetric thresholds: +1 vs -1.5. Velocity loss is judged more conservatively than gain.

---

## 9. TTO penalty (lines 644-659)

3rd-time-through-order K-rate decay:
- `TTO3_BF = 18` (2 lineups through)
- `TTO3_DECAY = 0.85`
- `ttoPenalty = 1 - (fracBFInTTO3) × (1 - 0.85)`

Active only when `expectedBF > 18`. A pitcher with `expectedBF=24` faces `6/24 = 25%` of batters in TTO3, so `ttoPenalty = 1 - 0.25 × 0.15 = 0.9625`. Modest but consistent.

Value matches `inGameEdge.js` so pre-game and live models agree.

---

## 10. ML overlay (`lib/pkModel.js`)

Ridge regression trained on 2022-2024 historical data. ~30 engineered features:
- Raw rates: `k_pct_l5_derived`, `savant_k_pct`, `k9_l5/season/career`
- Splits: `k_pct_vs_l/r`, `pK_split_diff`
- Drift signals: `pK_l5_vs_savant`, `pK_career_vs_savant`
- Stuff: `savant_whiff`, `savant_fbv`, `whiff_x_fbv`
- Profile: `savant_gb_pct`, `savant_bb_pct`, `bb9_l5`, `bb_penalty`
- Workload: `early_exit_rate_l5`, `manager_leash_factor`, `log_expected_bf`, `log_ip_proxy`
- Sample-size proxy: `savant_ip`, `savant_pa`, `days_rest`
- Blend hints: `w_season/career/l5`, `pK_blended_prod`
- Context: `opp_k_pct`, `adj_factor`, `raw_adj_factor`, `park_factor`, `weather_mult`, `ump_factor`, `velo_adj`

Pipeline: impute (training medians) → scale (training mean/std) → dot product with ridge_coef + intercept → clip to `[0.05, 0.55]`.

Loaded once at process start from `models/pk_ridge_weights.json`. Skipped silently if file missing (`_model = null`, formula fallback used).

**Hidden assumption:** ML expects context multipliers (`park_factor`, `weather_mult`, `ump_factor`, `velo_adj`) as features. So when ML is the path, those multipliers feed BOTH `pK_blended` (via ML features) AND the outer chain. That looks like double-counting. **Worth flagging — needs verification with user.**

---

## 11. Side effects in `computeLambdaBase`

- `console.log` on L5 regression cap (line 522): `[strikeout-edge] L5 regression: k9_l5 X → Y (career Z ×1.25)`
- No DB writes
- No mutation of input objects (purely functional once inputs are passed)

Outer chain in `strikeoutEdge.js`:
- `recordPipelineStep` called with `step: 'model_input'` and `step: 'lambda_calc'` payloads (DB write to `pipeline_log` table, async, errors swallowed)
- Multiple `console.log` lines for human-readable summary

---

## 12. External dependencies

External imports/calls used during a single pre-game lambda computation:

| dep | source | type |
|---|---|---|
| `fetchGameLog` | likely MLB API client | external HTTP (cached) |
| `LEAGUE_K9`, `LEAGUE_AVG_IP`, `LEAGUE_K_PCT`, `LEAGUE_PA_PER_IP`, `LEAGUE_WHIFF_PCT` | `lib/strikeout-model.js` | constants |
| `nbCDF`, `pAtLeast`, `archetypeR`, `NB_R` | `lib/strikeout-model.js` | pure functions |
| `predictPk`, `loadModel`, `_pkModel` | `lib/pkModel.js` | pure once loaded |
| `getParkFactor` | `lib/parkFactors.js` | pure (constant lookup) |
| `getUmpireFactor` | `lib/umpireFactors.js` | pure (constant lookup) |
| `LINEUP_SLOT_WEIGHTS` | (defined inline at top of `strikeoutEdge.js`?) | constants |
| `fetchOpponentKpct` | local | DB queries + MLB API fallback |
| `pitcher_statcast` row | DB | runtime fetch |
| `pitcher_recent_starts` rows | DB | runtime fetch |
| `historical_team_offense` | DB | runtime fetch |

---

## 13. Fallbacks / failure modes

| input missing | behavior |
|---|---|
| `savant` null | `pK_season` skipped; `w_season=0`; relies on career + L5 |
| `career` null | `pK_career` skipped; `w_career=0`; relies on season + L5 |
| both `savant` AND `career` null | `pK_blended_formula = pK_l5` (rookie/debut case) |
| `recentStartsData` empty | falls through to log-based BF, then ip×PA/IP, then league |
| `nStarts == 0` (debut) | `pK_l5 = careerKpct`, `expectedBF = careerIp × PA/IP` |
| `_pkModel` null | formula path used unconditionally |
| `_pkModel` loaded but `savant.ip < 5` | formula path used (rookie-safety branch) |
| `careerAvgFbVelo` null | velocity trend signal skipped (`veloAdj = 1.0`) |
| weather not in cache | `weatherMult = 1.0`, note='n/a' |
| ump not in cache | `umpFactor = getUmpireFactor(undefined)` — need to verify behavior |
| no Kalshi market group | edge calc skipped, recorded as `no_markets`, no λ persisted |

---

## 14. Hidden assumptions (worth flagging)

1. **Context multiplier double-counting in ML path.** ML overlay receives `park_factor`, `weather_mult`, `ump_factor`, `velo_adj` as features AND the outer chain multiplies by them again. Need to verify if Ridge coefficients on those features are zero/near-zero, or if this is genuine double-counting.

2. **`bbPenalty = 1.0` disabled but still in output.** `pK_final = pK_afterVelo × bbPenalty × ttoPenalty` keeps `bbPenalty` for shape/legacy. Layer 1 should preserve the variable in the output schema even though it's currently a no-op.

3. **`splitAdj` references `savant.k_pct`** — when savant is null, splitAdj is silently 1.0. Documented at line 1037-1038.

4. **`pK_l5` floors short starts at 3 IP** when fewer than 40% of L5 are short exits — but only in the IP-fallback branch, not in the BF branches. Inconsistent across branches.

5. **Career `k9` is recomputed as `pK_career × 4.44 × 9`** (line 583), assuming league-average PA/IP. Doesn't use career's actual PA/IP if available.

6. **Velocity trend asymmetric thresholds** (+1.0 vs -1.5) are unexplained in code; worth flagging in spec for review.

7. **L5 regression cap at 1.25× career K9** is a SOFT one-way cap — caps ABOVE 1.25× but no LOWER cap. Cold streaks are not regressed back up. May be intentional (don't trust hot streaks; trust cold streaks).

8. **`recordPipelineStep` is async fire-and-forget with `.catch(() => {})`** — Layer 1's Trace event should NOT be fire-and-forget per Layer 0 spec. This is one place behavior must change in extraction.

9. **The `confidence` string in current output** doesn't carry numeric values needed by Trust. Layer 1's new `confidence` block must derive from raw signals (nStarts, savant.ip, pK source set) — equivalent computation, richer output.

---

## 15. What Layer 1 must produce (proposed schema, awaiting lock)

Output of Layer 1 `compute(input)`:

```js
{
  // Core scalar outputs
  lambda: number,                      // λ_final after all multipliers
  expected_bf: number,                 // E[BF] used
  pK_blended: number,                  // per-BF rate after all adjustments
  nb_r: number,                        // archetypeR(savant)
  source: 'ml_overlay' | 'formula',    // which pK path was taken

  // Per-strike event probabilities (Layer 1 owns the NB math)
  prob_at_least_by_strike: {
    3: number, 4: number, ..., 12: number,
  },

  // Diagnostic components — raw inputs preserved for downstream consumers
  components: {
    pK_formula: number, ml_pK: number | null,
    pK_l5: number, pK_season: number | null, pK_career: number | null,
    w_l5: number, w_season: number, w_career: number,
    veloAdj: number, bbPenalty: number, ttoPenalty: number,
    splitAdj: number, effectiveAdj: number,
    parkFactor: number, weatherMult: number, umpFactor: number,
    bf_source: string,                 // 'BF×N(Xpc)', 'logBF×N', 'ip×PA/IP', etc
    avg_pitches: number | null,
    leash_flag: boolean,
    manager_leash_factor: number,
    early_exit_rate_l5: number | null,
  },

  // Confidence block — for Trust (Layer 3) to consume
  confidence: {
    bf_source_quality:    { label: 'high' | 'medium' | 'low', score: 0.0-1.0 },
    k_pct_sample_quality: { label: 'high' | 'medium' | 'low', score: 0.0-1.0 },
    thin_sample: boolean,              // savant.ip < 5
    dk_blend_weight: number,           // 0=model-only, 1=DK-only (Bite 6)
    ml_overlay_used: boolean,
    flags: string[],                   // ['velo-up', 'short-leash', etc]
    n_starts: number,                  // raw signal for downstream
    savant_ip: number,
  },

  // Replay integrity
  input_hash: string,                  // sha256 of canonicalized inputs
  output_hash: string,                 // sha256 of this object's deterministic fields
  evidence_used: [                     // canonical list of inputs consumed
    { name: 'savant', id: pitcherId, fields: ['k_pct', 'ip', ...] },
    { name: 'career', id: pitcherId },
    { name: 'recent_starts', id: pitcherId, n_rows: N },
    ...
  ],

  // Trace metadata (filled by traceAdapter in production)
  layer_name: 'math',
  layer_version: '1.0.0',
}
```

---

## 16. Test cases for Bite 2 parity harness

ChatGPT's 8 archetypes need real pitcher mappings. Candidate pitcher IDs to source from `pitcher_edge_cache` or `ks_bets`:

| # | archetype | needs |
|---|---|---|
| 1 | High-K ace, full Statcast | savant.ip ≥ 30, k_pct ≥ 0.28, ML overlay active |
| 2 | Low-K control, full Statcast | savant.ip ≥ 30, k_pct ≤ 0.19, ML overlay active |
| 3 | Rookie / thin sample | savant.ip < 5, formula path forced |
| 4 | Post-IL / short leash | manager_leash_factor < 0.95, leashFlag true |
| 5 | Missing Statcast (career-only) | savant null, career != null |
| 6 | Lineup posted | game_lineups row present, slot weights apply |
| 7 | No lineup posted | game_lineups null, fall through to historical_team_offense |
| 8 | High L5 spike | k9_l5 > careerK9 × 1.25 → regression cap fires |

A 9th worth adding: full debut (no career, no savant, no log). Should produce λ_l5 = league_K_pct, expectedBF = league_ip × PA/IP.

For each: capture EVERY intermediate quantity (`expectedBF, pK_career, pK_season, pK_l5, w_*, pK_formula, ml_pK, pK_blended, veloAdj, bbPenalty, ttoPenalty, splitAdj, effectiveAdj, parkFactor, weatherMult, umpFactor, lambdaBase, lambda_final, nb_r, prob_at_least_by_strike[3..12]`).

Reference dataset persists as `oracle/layers/1-math/parity-fixtures.json` so future code changes can be regressed against the exact same expected outputs.

---

## 17. Open questions — resolutions

**Q-M1.1.** ✅ **RESOLVED.** Read `models/pk_ridge_weights.json` (33 features, cv_r²=0.94, 882 train rows). The four contextual multipliers + `manager_leash_factor` + `opp_k_pct` + `adj_factor` + `raw_adj_factor` + `bb_penalty` + `pK_split_diff` all have **`coef = 0.0` exactly**. The model is structurally aware of these features but treats them as no-signal — they were null/missing in the 2022-2024 training data. **Not double-counting.** ML overlay is effectively a stuff/sample-quality model (top weights: `savant_pa`, `savant_ip`, `whiff_x_fbv`, `pK_l5_vs_savant`, `k_pct_l5_derived`, `savant_k_pct`, `savant_whiff`); the outer multiplier chain is the sole authoritative source of context/workload adjustment. Preserve verbatim in Layer 1 v1.0.

**Q-M1.2.** Open. `splitAdj` requires `savant.k_pct_vs_l` AND `savant.k_pct_vs_r` AND `savant.k_pct > 0.01`. When any are missing, splitAdj silently becomes 1.0 with only a `console.warn`. **Lean (not yet locked): add `flags: ['splits_missing']` to confidence block** so Trust knows the splits adjustment was skipped.

**Q-M1.3.** Open. The `confidence` string from `computeLambdaBase` uses thresholds `nStarts >= 5` (high), `nStarts >= 3` (medium). The new structured confidence should preserve these thresholds verbatim OR explicitly redefine. **Lean: preserve verbatim for first parity baseline; revisit after.**

**Q-M1.4.** ✅ **RESOLVED.** Greped every `NB_R` / `pAtLeast` / `nbCDF` / `archetypeR` reference. The pre-game per-strike probability path uses `archetypeR(savant)` → `pitcherNbR` at `strikeoutEdge.js:1156-1157`. There is NO active pre-game path still using bare `NB_R=30` for market probability. The line-923 reference is a cosmetic startup-banner log only. Live/in-game paths (`inGameEdge.js`, `liveMonitor.js`, `livePositions.js`) still default to `NB_R` because they call `pAtLeast(...)` without the 3rd arg — but **live is out of Layer 1's pre-game scope**. Backlog #36 ("Wire archetypeR pre-game") IS DONE for pre-game. Layer 1 v1.0 just needs to expose `nb_r` in output so Trust/Judge see which dispersion was used.

**Q-M1.5.** Open. `pK_l5` floors short starts at 3 IP only in the IP-fallback branch (line 462-466), not the BF branches. Inconsistent across branches. **Lean: preserve verbatim during extraction (don't fix bugs while extracting).**

**Q-M1.6.** ✅ **RESOLVED — naming locked.** New canonical output names (will replace the overloaded `pK_blended`):

| field | meaning |
|---|---|
| `pK_blend_raw` | per-BF rate from 3-way blend OR ML overlay, BEFORE velo/bb/tto |
| `pK_effective` | per-BF rate AFTER velo × bb × tto |
| `lambda_base` | `expected_bf × pK_effective` |
| `lambda_final` | `lambda_base × splitAdj × effectiveAdj × parkFactor × weatherMult × umpFactor` |
| `prob_at_least_by_strike` | `{ 3: P(K≥3), 4: P(K≥4), ..., 12: P(K≥12) }` computed via `nbCDF(lambda_final, archetypeR(savant), strike-1)` |

Old name `pK_blended` does NOT appear in Layer 1 v1.0 output (it's overloaded in `computeLambdaBase`'s return — caller uses `pK_blended` to mean the FINAL rate). The `components` block can preserve `pK_formula` and `pK_ml` for diagnostic transparency.

**Q-M1.7.** ✅ **RESOLVED — deferred.** DK-line blend pushed to **Bite 6** with preliminary lean: should adjust `expected_bf` / workload confidence first, NOT directly override `lambda_final`. It's a leash/opportunity sanity check, not a blanket probability override. Final formulation TBD by Bite 6 design discussion.

---

## 18. Bite 1 close-out

Read complete:
- ✅ `computeLambdaBase` (full body, lines 429-680)
- ✅ Outer multiplier chain (lines 990-1041)
- ✅ Per-strike NB CDF usage (line 1156-1163)
- ✅ `lib/strikeout-model.js` (NB math, archetypeR, league constants)
- ✅ `lib/pkModel.js` (Ridge inference, feature engineering, clip range)
- ✅ `models/pk_ridge_weights.json` (33 features, all coef magnitudes inspected — see §17 Q-M1.1)
- ✅ `computeWeatherMult`, `fetchOpponentKpct`, `computeSlotWeightedKpct`
- ✅ Grep verification of pre-game NB_R usage (§17 Q-M1.4) — confirmed pre-game uses archetypeR
- ⏳ `lib/parkFactors.js` — referenced; not deeply read (constant lookup, low risk)
- ⏳ `lib/umpireFactors.js` — referenced; not deeply read (constant lookup, low risk)

Resolved questions:
- Q-M1.1 (no double-counting) ✅
- Q-M1.4 (archetypeR already wired pre-game) ✅
- Q-M1.6 (schema naming locked) ✅
- Q-M1.7 (DK blend deferred to Bite 6) ✅

Open questions for Bite 3 design (not blocking Bite 2):
- Q-M1.2 (`splits_missing` flag in confidence)
- Q-M1.3 (preserve `nStarts >= 5/3` thresholds verbatim?)
- Q-M1.5 (`pK_l5` short-start floor inconsistency across branches)

This document is the input to Bite 2 (parity harness design). Bite 2 is unblocked.
