# Layer 5: Judge — Specification (no-Critic path)

**Status:** ✅ v0.1 SHIPPED 2026-05-01 — no-AI path only
**Last edited:** 2026-05-01

> **Scope warning.** v0.1 ships the no-Critic path (no AI / Sonnet
> calls). When Layer 4 (Critic) is built, Judge will gain a second
> input that can override the v0.1 verdict. The contract below is
> deliberately minimal so v0.1 is a clean baseline.

---

## 1. Purpose

Judge converts the upstream layers' deterministic signals into a
single, actionable per-bet decision: **fire / skip / size_down**, with
a Kelly-scaled size when firing.

> v0.1 inputs: Layer 1 envelope + Layer 2 result + Layer 3 result
> + market values (price, edge).
> v0.1 output: decision ∈ {fire, skip, size_down}, recommended size,
> reason codes.

This is the layer that closes the loop from "signal" to "money."

---

## 2. Inputs

```js
ctx = {
  decision_id, strike, side,
  pitcher_id, pitcher_name, bet_date,
  market_mid:        number   in (0, 1),  // YES-side implied prob from market
  spread:            number | null,        // cents, optional
  bankroll:          number > 0,           // for sizing
  side_min_edge?:    number,                // default 0.12
  min_edge_floor?:   number,                // default 0.04
  kelly_multiplier?: number,                // default 1.0 (full Kelly × multiplier)
  max_size_usd?:     number,                // default 200 (production cap)
  ...trace fields like other layers...
}
```

Plus `layer1Envelope`, `layer2Result`, `layer3Result`.

---

## 3. Logic (v0.1)

```
prob_side       = side === 'YES' ? envelope.prob_at_least[strike]
                                  : 1 - envelope.prob_at_least[strike]
edge            = prob_side - market_mid
threshold       = max(side_min_edge, spread/2 + min_edge_floor)   when spread
                = side_min_edge                                     when no spread

# Hard skips
if layer2Result.feasibility === 'dead'                  → skip ('feasibility_dead')
if layer3Result.trust_score === 0                       → skip ('trust_zero')
if edge < threshold                                     → skip ('insufficient_edge')

# Size_down vs fire
if layer2Result.feasibility === 'fragile'               → decision = 'size_down'
else if layer3Result.trust_level === 'low'              → decision = 'size_down'
else                                                    → decision = 'fire'

# Kelly fraction
b               = (1 - market_mid) / market_mid           # decimal payoff
kelly_raw       = (prob_side * b - (1 - prob_side)) / b    # standard Kelly
kelly_raw       = max(0, kelly_raw)
kelly_eff       = kelly_raw × kelly_multiplier × layer3Result.trust_score
                  × (decision === 'size_down' ? 0.5 : 1.0)

size_usd        = clamp(0, max_size_usd, bankroll × kelly_eff)
```

`trust_score` directly modulates Kelly. Layer 2 fragile triggers a
half-size (0.5x). Layer 3 low triggers a half-size too. Both can
compound (0.25x).

---

## 4. Output envelope

```js
{
  schema_version, layer: 'judge', layer_version, source: 'oracle_layer_5_judge',
  run_id, decision_id, computed_at, commit_hash,
  inputs_hash, output_hash,
  matchup_output_hash, path_output_hash, trust_output_hash,

  strike, side,
  prob_side, market_mid, edge, threshold, spread,

  decision: 'fire' | 'skip' | 'size_down',
  reason_code: string,

  kelly_raw, kelly_eff, size_usd,

  // echoes
  feasibility, trust_score, trust_level,
}
```

---

## 5. reason_code vocabulary (v0.1)

```
feasibility_dead          Layer 2 said dead
trust_zero                Layer 3 trust_score = 0 (mirror of dead)
insufficient_edge         edge < threshold
fragile_size_down         feasibility=fragile → half-size
low_trust_size_down       trust_level=low → half-size
fire                      no downgrade fired
```

---

## 6. Trace event

`event_type='decision'`, `decision = fire/skip/size_down`,
`reason_code = primary`. evidence_used links to L1/L2/L3 hashes.
metrics carries every numeric.

---

## 7. Out of scope (v0.1)

- Layer 4 (Critic / AI) — its verdict will be added in v0.2 to
  override fire→skip when Sonnet flags structural concerns
- Live in-game updates
- Gateway enforcement
- Multi-account / per-user sizing
- Bankroll state tracking (caller passes bankroll)
- Order placement (Gateway's job)

When Layer 4 ships, Judge v0.2 will accept a `criticResult` argument
and add a hard-skip rule when `criticResult.skip === true`. The v0.1
contract above stays the same shape (additive).

---

*v0.1 ships 2026-05-01 alongside Layers 1-3.*
