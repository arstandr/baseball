# Layer 2: Path — Specification

**Status:** ✅ v1.0 SHIPPED 2026-05-01 — implementation closed L2.1–L2.5
**Last edited:** 2026-05-01
**Purpose deliverable:** Bite L2.1 (this spec)
**Implementation status:** see `PARITY_NOTES.md` for close-outs

---

## 1. Purpose

Path answers a single deterministic question per (strike, side):

> "Even if Layer 1's math says there is edge, is there a realistic path
> for **this specific bet** to win, given the pitcher's workload
> constraints?"

Path is the gate that catches **physically stretched bets** — bets
where the math is favorable but the trajectory required is
implausible given the pitcher's expected workload, leash, or
sample-size signals. It does **not** decide bet/skip, sizing, or
edge. Trust + Critic + Judge own those.

**Path may report Layer 1 probabilities as evidence, but it must not
produce or alter probability estimates.**

One-line summary: Path classifies feasibility — `strong / viable /
fragile / dead` — per (strike, side), based on the comparison of
required workload vs. expected workload, with side-specific logic.

---

## 2. Inputs

Path consumes one Layer 1 matchup envelope (output of
`computeMatchup`) plus a per-bet `ctx`.

### 2a. Layer 1 envelope fields used

| Field | Source | Used for |
|---|---|---|
| `envelope.inner.expectedBF` | Bite 4 inner | the workload anchor |
| `envelope.inner.pK_blended` | Bite 4 inner | per-BF K rate |
| `envelope.inner.avgPitches` | Bite 4 inner | pitch-count signal (may be null) |
| `envelope.inner.leashFlag` | Bite 4 inner | early-pull indicator |
| `envelope.inner.bfSource` | Bite 4 inner | provenance tier (strong/medium/weak) |
| `envelope.inner.nStarts` | Bite 4 inner | sample-size signal |
| `envelope.outer.lambda_final` | Bite 4 outer | effective λ after multipliers + DK blend |
| `envelope.prob_at_least` | Bite 4 | per-strike probability map (reported, not bucketed) |
| `envelope.nb_r` | Bite 4 | dispersion (for prob_no) |
| `envelope.dk_blend` | Bite 6.2 (optional) | audit-only; affects only the weak-BF-cap exception |

Path **does not recompute** λ or prob. It treats `envelope.outer.lambda_final`
as the single source of truth.

### 2b. ctx (per-bet)

```js
{
  decision_id:    string,    // propagated; same across all 5 layers per bet
  strike:         number,    // K threshold
  side:           'YES' | 'NO',
  pitcher_id:     string,
  pitcher_name:   string,
  bet_date:       'YYYY-MM-DD',
  // optional Trace fields:
  emit_trace?:    boolean,   // default false
  trace?:         { writeAsync: (event) => any },
  game_pk?, market_ticker?,
  parent_event_id?, request_id?, run_id?,
  commit_hash?, agent_id?, agent_version?, server_version?, environment?,
  user_id?, bet_id?, mode?, system?,
}
```

`emit_trace=true` requires `ctx.trace.writeAsync` (same contract as
Layer 1's `run`).

### 2c. Hash linkage

```
result.matchup_output_hash === layer1Envelope.output_hash
result.inputs_hash         = sha256({ matchup_output_hash, strike, side })
result.output_hash         = sha256(result minus output_hash)
```

This preserves the lineage pattern locked in Bite 4: Layer 2's per-bet
result hash incorporates Layer 1's matchup hash, so replay validation
detects upstream drift.

---

## 3. Outputs

### 3a. Per-bet result envelope

```js
{
  schema_version:        '1.0.0',
  layer:                 'path',
  layer_version:         '1.0.0',
  source:                'oracle_layer_2_path',
  run_id:                '<uuid>',
  decision_id:           '<from ctx>',
  computed_at:           '<ISO>',
  commit_hash:           '<env COMMIT_HASH>',
  inputs_hash:           '<sha256, 64 hex>',
  output_hash:           '<sha256, 64 hex>',
  matchup_output_hash:   '<envelope.output_hash>',

  strike:                number,
  side:                  'YES' | 'NO',

  feasibility:           'strong' | 'viable' | 'fragile' | 'dead',

  // Numeric diagnostics
  required_bf:           number,          // strike / pK_blended (v1, bucketed on this)
  required_bf_outer:     number,          // strike × expected_bf / lambda_final (diagnostic)
  expected_bf:           number,          // = inner.expectedBF
  bf_gap:                number,          // required_bf - expected_bf
  bf_gap_ratio:          number,          // bf_gap / expected_bf
  bf_ceiling:            number | null,   // avgPitches / 3.8, or null if avgPitches missing
  required_pk:           number,          // strike / expected_bf (pK rate needed)
  gap_under:             number,          // strike - lambda_final  (NO-side metric)
  prob_at_strike:        number,          // envelope.prob_at_least[strike] for YES; 1 - that for NO
  prob_no:               number,          // 1 - prob_at_strike (echoed for NO inspection)
  lambda_final:          number,          // = envelope.outer.lambda_final (echoed)

  // Categorical
  bf_source_tier:        'strong' | 'medium' | 'weak' | 'unknown',
  workload_signal:       'normal' | 'short_leash' | 'deep' | 'capped' | 'thin',

  // Reason codes
  reason_code:           string,          // primary driver (see §6 vocab)
  secondary_reasons:     string[],        // other reasons that fired but were not primary

  // DK blend audit (when envelope.dk_blend exists)
  dk_blend_applied:      boolean,         // = envelope.dk_blend.applied
  dk_skip_reason:        string | null,   // = envelope.dk_blend.skip_reason
}
```

`feasibility === decision` for the Trace event. Layer 2 has no
fire/skip vocabulary; downstream layers translate feasibility into
gating decisions.

---

## 4. Formulas

### 4a. Required-BF calc (v1, bucketed)

```
required_bf       = strike / pK_blended
required_bf_outer = strike × expected_bf / lambda_final     (diagnostic)
```

Bucketing uses the simple `required_bf`. The `_outer` variant is
reported for visibility but does not drive the verdict.

`pK_blended` already incorporates `velo_adj × bb_penalty × tto_penalty`
per `strikeoutEdge.js:661`, so the simple calc honors those
adjustments without re-applying them.

### 4b. YES-side gap and bucketing

```
bf_gap        = required_bf - expected_bf
bf_gap_ratio  = bf_gap / expected_bf

YES bucket:
  ratio ≤ -0.10        → strong
  -0.10 < ratio ≤ +0.05 → viable
  +0.05 < ratio ≤ +0.20 → fragile
  ratio > +0.20         → dead
```

### 4c. NO-side gap and bucketing

```
gap_under = strike - lambda_final

NO bucket:
  gap_under ≥ +1.5            → strong
  +0.5 ≤ gap_under < +1.5     → viable
  -0.5 ≤ gap_under < +0.5     → fragile
  gap_under < -0.5            → dead
```

`prob_no` is exposed as a metric for trace/reporting but **not bucketed
on** in v1.

### 4d. Workload ceiling

```
if avgPitches finite and > 0:
  bf_ceiling = avgPitches / 3.8         (LEAGUE_PITCHES_PER_BF)
else:
  bf_ceiling = null
```

YES-side hard veto:

```
if bf_ceiling != null and required_bf > bf_ceiling:
  feasibility = 'dead'
  reason_code = 'workload_ceiling'
```

NO-side support (does NOT change tier directly; logged as a tier-up
modifier per §4f):

```
if bf_ceiling != null and bf_ceiling < strike / pK_blended:
  NO tier-up modifier 'workload_ceiling_supports_no'
```

### 4e. Required-pK extremes (YES only)

```
required_pk = strike / expected_bf

YES override:
  required_pk > 0.38 → cap at fragile     (reason: 'pk_extreme_fragile')
  required_pk > 0.45 → dead                (reason: 'pk_extreme_dead')
```

### 4f. NO-side support modifiers

Each modifier upgrades NO feasibility by one tier (cap at `strong`):

| Trigger | Modifier reason_code |
|---|---|
| `leashFlag === true` | `leash_supports_no` |
| `avgPitches != null && avgPitches < 80` | `short_workload_supports_no` |
| `bf_ceiling < strike / pK_blended` | `workload_ceiling_supports_no` |

Modifiers stack; cap at `strong`. The primary `reason_code` reflects
the highest-priority applied modifier; remaining modifiers go to
`secondary_reasons`.

### 4g. Tail-strike overrides (YES only)

```
if strike >= 9 and bf_gap > 0:
  cap feasibility at fragile     (reason: 'tail_fragile_high_strike')

if strike >= 10 and bf_gap_ratio > 0.10:
  feasibility = 'dead'           (reason: 'tail_dead_high_strike')
```

`tail_dead_high_strike` overrides `tail_fragile_high_strike` when both
fire (10+ strikes only).

### 4h. Weak-BF-source cap (both sides)

```
if bf_source_tier === 'weak' AND NOT envelope.dk_blend?.applied:
  cap feasibility at viable      (reason: 'bf_source_weak_cap')
```

If `envelope.dk_blend.applied === true`, the weak-source cap is **not
applied** — DK blend is specifically designed to improve weak workload
anchors. The reason code `bf_source_weak_cap` does not fire in that case.

### 4i. Order of operations

YES side:

```
1. Compute required_bf, expected_bf, bf_gap, bf_gap_ratio, required_pk, bf_ceiling.
2. Hard-dead checks (any → dead, with the matching reason_code):
     a. workload_ceiling:        bf_ceiling != null AND required_bf > bf_ceiling
     b. pk_extreme_dead:         required_pk > 0.45
     c. tail_dead_high_strike:   strike >= 10 AND bf_gap_ratio > 0.10
3. Compute baseline tier from bf_gap_ratio bucket (§4b).
4. Apply caps (best-tier ceiling, lowering toward fragile/viable):
     a. pk_extreme_fragile:      required_pk > 0.38   → cap at fragile
     b. tail_fragile_high_strike: strike >= 9 AND bf_gap > 0 → cap at fragile
     c. bf_source_weak_cap:      tier=weak AND NOT dk_blend.applied → cap at viable
5. Set primary reason_code:
     - any hard-dead trigger if matched (§2)
     - else the most restrictive cap that fired
     - else the natural-bucket reason (§6)
6. secondary_reasons: list remaining triggered codes (excluding the primary).
```

NO side:

```
1. Compute gap_under, bf_ceiling.
2. Compute baseline tier from gap_under bucket (§4c).
3. Apply support upgrades (§4f) one tier each, cap at strong:
     leash_supports_no
     short_workload_supports_no
     workload_ceiling_supports_no
4. Apply weak-source cap:
     bf_source_weak_cap        if tier=weak AND NOT dk_blend.applied → cap at viable
5. Primary reason_code:
     - the highest-priority applied modifier (precedence: leash_supports_no >
       workload_ceiling_supports_no > short_workload_supports_no)
     - else the weak-source cap reason if it fired
     - else the natural-bucket reason (§6)
6. secondary_reasons: list other triggered modifiers.
```

---

## 5. Decision vocabulary

```
strong   path is well-supported; expected workload comfortably covers
         required BF (YES) or λ comfortably below strike (NO); no
         leash flags; bf_source solid

viable   path is plausible but uses available margin; small adverse
         moves may threaten it

fragile  path requires luck or above-expected workload; high-strike
         tails, extreme pK requirements, or weak data sources land here

dead     path is structurally implausible; bet should not be considered
         regardless of edge
```

These four values are tracked by Layer 0's drift detector (§9b of
Trace spec). No other layer uses these; no other vocabulary appears
in Layer 2.

---

## 6. Reason-code vocabulary

Each `reason_code` in the result and Trace event must come from this
list. Adding a new reason requires updating this spec and Layer 0's
drift baseline.

### 6a. Hard-dead drivers (YES)

| Code | Trigger |
|---|---|
| `workload_ceiling` | `required_bf > avgPitches/3.8` |
| `pk_extreme_dead` | `required_pk > 0.45` |
| `tail_dead_high_strike` | `strike >= 10 AND bf_gap_ratio > 0.10` |

### 6b. Cap drivers (YES)

| Code | Trigger | Effect |
|---|---|---|
| `pk_extreme_fragile` | `required_pk > 0.38` | cap at fragile |
| `tail_fragile_high_strike` | `strike >= 9 AND bf_gap > 0` | cap at fragile |
| `bf_source_weak_cap` | `bfSource weak AND NOT dk_blend.applied` | cap at viable |

### 6c. NO-side support modifiers

| Code | Trigger | Effect |
|---|---|---|
| `leash_supports_no` | `leashFlag === true` | tier-up by 1 (cap at strong) |
| `workload_ceiling_supports_no` | `bf_ceiling < required_bf` | tier-up by 1 |
| `short_workload_supports_no` | `avgPitches < 80` | tier-up by 1 |

### 6d. Natural-bucket reasons

YES:
| Bucket | reason_code |
|---|---|
| strong | `comfortable_buffer` |
| viable | `normal_path` |
| fragile | `bf_gap_fragile` |
| dead | `bf_gap_dead` |

NO:
| Bucket | reason_code |
|---|---|
| strong | `no_path_ample_cushion` |
| viable | `no_path_at_strike_lambda` |
| fragile | `no_path_thin` |
| dead | `no_path_overrun` |

`secondary_reasons` may include any combination of the above; no
duplicates of the primary.

---

## 7. Trace event shape

`event_type='decision'` (already accepted by Layer 0's validator;
no Layer 0 changes needed).

```js
{
  layer_name:    'path',
  layer_version: '1.0.0',
  event_type:    'decision',
  decision:      'strong' | 'viable' | 'fragile' | 'dead',
  reason_code:   '<primary from §6>',

  decision_id, strike, side, pitcher_id, pitcher_name, bet_date,

  reasoning: {
    feasibility:        '<same as decision>',
    workload_signal:    '<from §3a>',
    bf_source_tier:     '<from §3a>',
    secondary_reasons:  ['<other reason_codes>'],
    dk_blend_applied:   <boolean>,
    dk_skip_reason:     <string | null>,
  },

  metrics: {
    required_bf, required_bf_outer, expected_bf,
    bf_gap, bf_gap_ratio, bf_ceiling, required_pk,
    gap_under, lambda_final, prob_at_strike, prob_no,
    matchup_output_hash,
  },

  evidence_used: [{
    name:       'oracle_layer_1_math.matchup',
    id:         '<pitcher_id>_<bet_date>',
    input_hash: '<envelope.inputs_hash>',
  }],

  input_hash:  '<per-bet inputs_hash>',
  output_hash: '<per-bet output_hash>',

  status: 'success', severity: 'info', latency_ms: <number>,
}
```

Use `writeAsync` (non-blocking) per Layer 0's contract for
non-Gateway layers.

---

## 8. Out of scope

Path **must not** include any of the following:

- AI / Sonnet / external LLM calls (Layer 4 Critic)
- Trust score (Layer 3 Trust)
- Bet sizing or Kelly logic (Layer 4 / 5)
- Fire / skip / size_down decision (Layer 5 Judge)
- Live / in-game updates (Bite L2.live deferred — see §9)
- Gateway enforcement (Layer 6)
- Recomputing λ, pK, or any probability (Layer 1 owns probabilities)
- Bet quality / EV / edge calculation (Layer 4 / 5)
- Discord alerts or any external I/O beyond Layer 0 Trace
- Any production flag (Path runs unconditionally; no DK_BLEND_ENABLED
  analog)

If something violates this list, it does not belong in Layer 2.

---

## 9. Future / live in-game notes

The v1 spec is **pre-game only**. Live in-game feasibility looks
different because:

- `expected_bf` becomes `expected_remaining_bf` (BF already accumulated
  is fixed; only the remaining trajectory is uncertain)
- `required_bf_remaining = (strike - currentKs) / pK_effective`
- Workload ceiling derives from `pitchBudget - currentPitches`
- Leash signals shift once the pitcher is past TTO3 / a high pitch count
- `gap_under` becomes `strike - currentKs - lambda_remaining`

A future bite (L2.live) will define the in-game spec. Until then,
Layer 2 runs only on pre-game `computeMatchup` envelopes; live trading
continues to use the legacy `liveMonitor` / `livePositions` /
`inGameEdge` paths (see PARITY_NOTES.md "Layer 1 vs legacy live paths
— known inconsistencies").

---

## 10. Versioning

| Field | Value |
|---|---|
| `schema_version` | `1.0.0` |
| `layer_version` | `1.0.0` |
| `LAYER_NAME` | `'path'` |
| `SOURCE` | `'oracle_layer_2_path'` |

`schema_version` and `layer_version` bump together when this spec
changes. New `reason_code` values do not require a version bump (they
register naturally in Layer 0's drift detector); removed or renamed
codes do.

---

## 11. Implementation plan

| Bite | Deliverable |
|---|---|
| L2.1 | This spec (locked) |
| L2.2 | `oracle/layers/2-path/feasibility.js` — pure helpers + unit tests |
| L2.3 | `scripts/oracle/buildPathParityFixtures.js` — generate fixtures |
| L2.4 | `oracle/layers/2-path/impl.js` — `run(envelope, ctx)` + Trace |
| L2.5 | `scripts/tests/oraclePathParityTest.js` — parity + synthetic |

Each bite follows the locked cadence: discussion → lock → write →
surface → run.

---

## 12. Open items not locked here

- Whether `secondary_reasons` should be order-stable (alphabetical?
  trigger-order?). Default proposal in L2.2: trigger-order.
- Whether to expose a `decision_id` per-call vs derive deterministically
  from `(matchup_output_hash, strike, side)`. Default: `decision_id`
  must come from caller per Trace spec; same `decision_id` flows
  through all 5 layers per bet.
- L2.live spec for in-game (deferred).

These get resolved in their respective bites.

---

*Spec locked 2026-05-01. Updates require explicit re-locking with
version bump.*
