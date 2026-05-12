# Layer 3: Trust — Specification

**Status:** ✅ v1.0 SHIPPED 2026-05-01
**Last edited:** 2026-05-01
**Purpose deliverable:** spec doc

> Authored autonomously per the user's "keep going till done" mandate.
> Design choices are reasonable defaults — owner can re-tune any
> threshold without breaking the contract.

---

## 1. Purpose

Trust answers a single deterministic question per (strike, side):

> "Given Layer 1's math and Layer 2's feasibility verdict, how much
> should the downstream sizing layer trust this bet?"

Trust does **not** decide bet/skip and does **not** compute edge or
size. It produces a numeric `trust_score ∈ [0, 1]` plus a categorical
`trust_level ∈ {low, medium, high}` to be consumed by Layer 5 (Judge)
when scaling Kelly fraction. If Layer 2 said `dead`, Trust returns
score = 0 (Layer 3 honors Layer 2's veto without re-deriving it).

**Trust may report Layer 1/Layer 2 fields as evidence, but it must not
produce or alter probability estimates, lambda, edge, or feasibility.**

One-line summary: Trust gates sizing confidence using the quality
signals already produced by Layer 1 and Layer 2.

---

## 2. Inputs

Trust consumes:
- One Layer 1 matchup envelope (output of `computeMatchup`)
- One Layer 2 per-bet result (output of `pathRun`)
- A per-bet `ctx`

### 2a. Fields used

From the Layer 1 envelope:
- `envelope.inner.confidence` (string like `'high(career+savant+l5)'`); parsed for the prefix
- `envelope.inner.nStarts` (number; secondary to `confidence`)
- `envelope.dk_blend` (optional)

From the Layer 2 result:
- `pathResult.feasibility` ∈ `{strong, viable, fragile, dead}`
- `pathResult.bf_source_tier` ∈ `{strong, medium, weak, unknown}`

### 2b. ctx (per-bet)

```js
{
  decision_id:    string,    // propagated; same across all 5 layers per bet
  strike:         number,
  side:           'YES' | 'NO',
  pitcher_id, pitcher_name, bet_date,
  // optional Trace fields (mirrors L1/L2):
  emit_trace?:    boolean,
  trace?:         { writeAsync },
  game_pk?, market_ticker?, mode?, system?,
  parent_event_id?, request_id?, run_id?,
  commit_hash?, agent_id?, agent_version?, server_version?, environment?,
  user_id?, bet_id?, computed_at?, fixture_id?,
}
```

### 2c. Hash linkage

```
result.matchup_output_hash === layer1Envelope.output_hash
result.path_output_hash    === pathResult.output_hash
result.inputs_hash         = sha256({matchup_output_hash, path_output_hash, strike, side})
result.output_hash         = sha256(result minus output_hash)
```

---

## 3. Outputs

```js
{
  schema_version:        '1.0.0',
  layer:                 'trust',
  layer_version:         '1.0.0',
  source:                'oracle_layer_3_trust',
  run_id, decision_id, computed_at, commit_hash, fixture_id,
  inputs_hash, output_hash,

  matchup_output_hash,           // = layer1Envelope.output_hash
  path_output_hash,              // = layer2Result.output_hash

  strike, side,

  trust_score:    number in [0, 1],
  trust_level:    'high' | 'medium' | 'low',

  // Factor breakdown (each in [0, ~1.0])
  feasibility_factor:    number,
  bf_source_factor:      number,
  confidence_factor:     number,
  dk_blend_factor:       number,

  // Echoes (read-only diagnostics for trace)
  feasibility:        'strong'|'viable'|'fragile'|'dead',
  bf_source_tier:     'strong'|'medium'|'weak'|'unknown',
  confidence:         'high'|'medium'|'low'|'unknown',
  dk_blend_applied:   boolean,
  dk_skip_reason:     string | null,

  // Reason codes
  reason_code:         string,    // primary driver
  reason_codes:        string[],  // all that fired (deduped, eval order)
}
```

---

## 4. Formulas

### 4a. Multiplicative factor chain

```
trust_score_raw = feasibility_factor × bf_source_factor × confidence_factor × dk_blend_factor
trust_score     = clamp(0, 1, trust_score_raw)

if feasibility === 'dead':
  trust_score = 0   (hard veto from Layer 2)
```

### 4b. feasibility_factor

| feasibility | factor |
|---|---:|
| strong | 1.00 |
| viable | 0.80 |
| fragile | 0.40 |
| dead | 0.00 |

### 4c. bf_source_factor (with DK blend protection)

| bf_source_tier | factor (no DK blend) | factor (dk_blend_applied=true) |
|---|---:|---:|
| strong | 1.00 | 1.00 |
| medium | 0.85 | 0.90 |
| weak | 0.60 | 0.85 (DK blend protects) |
| unknown | 0.70 | 0.85 |

### 4d. confidence_factor

Parse from `envelope.inner.confidence` string (prefix-only):

| confidence | factor |
|---|---:|
| high | 1.00 |
| medium | 0.85 |
| low | 0.70 |
| unknown / unparseable | 0.70 |

### 4e. dk_blend_factor

| state | factor |
|---|---:|
| envelope.dk_blend.applied === true | 1.00 |
| otherwise | 1.00 |

(In v1 the DK blend's effect is encoded entirely in `bf_source_factor`.
The `dk_blend_factor` slot is reserved for future tuning.)

### 4f. trust_level cuts

| trust_score range | trust_level |
|---|---|
| ≥ 0.70 | high |
| 0.40 ≤ score < 0.70 | medium |
| < 0.40 | low |

---

## 5. reason_code vocabulary

```
HIGH_TRUST                  trust_score ≥ 0.85, no downgrades fired
FEASIBILITY_DEAD            feasibility=dead → score forced to 0
FEASIBILITY_FRAGILE         feasibility_factor=0.40
FEASIBILITY_VIABLE          feasibility_factor=0.80
BF_SOURCE_WEAK              bf_source_factor=0.60 (no DK blend)
BF_SOURCE_WEAK_DK_PROTECTED bf_source_factor=0.85 (DK blend present)
BF_SOURCE_MEDIUM            bf_source_factor=0.85
BF_SOURCE_UNKNOWN           bf_source_factor=0.70
CONFIDENCE_LOW              confidence_factor=0.70
CONFIDENCE_MEDIUM           confidence_factor=0.85
CONFIDENCE_UNKNOWN          confidence_factor=0.70
```

`reason_code` (singular) = the most-impactful factor (lowest non-1.00
factor). `reason_codes` (plural) = all that fired in trigger-evaluation
order, deduped.

---

## 6. Trace event shape

`event_type='decision'` (per Layer 0 contract).

```js
{
  layer_name:    'trust',
  layer_version: '1.0.0',
  event_type:    'decision',
  decision:      'high' | 'medium' | 'low',     // trust_level
  reason_code:   '<primary>',

  decision_id, strike, side, pitcher_id, pitcher_name, bet_date,

  reasoning: {
    trust_level, feasibility, bf_source_tier, confidence,
    dk_blend_applied, dk_skip_reason,
    secondary_reasons: string[],
  },

  metrics: {
    trust_score,
    feasibility_factor, bf_source_factor, confidence_factor, dk_blend_factor,
    matchup_output_hash, path_output_hash,
  },

  evidence_used: [
    { name: 'oracle_layer_1_math.matchup', id: '<pid>_<date>',
      input_hash: layer1Envelope.inputs_hash },
    { name: 'oracle_layer_2_path.result', id: '<pid>_<date>_<k>_<side>',
      input_hash: layer2Result.inputs_hash },
  ],

  input_hash, output_hash,
  status: 'success', severity: 'info', latency_ms,
}
```

---

## 7. Out of scope

- AI / Sonnet (Layer 4 Critic)
- Bet sizing / Kelly math (Layer 5 Judge)
- Fire / skip decision (Layer 5 Judge)
- Edge calculation (Layer 4/5)
- Recomputing prob, lambda, feasibility (Layers 1 and 2 own those)
- Live in-game updates
- Gateway enforcement

---

## 8. Versioning

| Field | Value |
|---|---|
| schema_version | 1.0.0 |
| layer_version | 1.0.0 |
| LAYER_NAME | 'trust' |
| SOURCE | 'oracle_layer_3_trust' |

---

## 9. Implementation plan

| Bite | Deliverable |
|---|---|
| L3.1 | This spec (locked in same pass as implementation per autonomous mandate) |
| L3.2 | `oracle/layers/3-trust/trustScore.js` — pure helpers + tests |
| L3.3 | `scripts/oracle/buildTrustParityFixtures.js` + fixtures (280 rows) |
| L3.4 | `oracle/layers/3-trust/impl.js` — `run(layer1Envelope, layer2Result, ctx)` + Trace |
| L3.5 | `scripts/tests/oracleTrustParityTest.js` |

---

*Spec authored 2026-05-01. Re-tunable thresholds without contract change.*
