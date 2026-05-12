# Layer 4: Critic — Specification

**Status:** 🔒 LOCKED v1.0 — ready for implementation
**Last edited:** 2026-05-01
**Purpose deliverable:** L4.1

---

## 1. Purpose

Critic is the AI second-opinion layer. It reads news, line moves,
weather narrative, and lineup status — context the deterministic
Layers 1-3 structurally cannot see — and returns a categorical
verdict that Judge v0.2 uses as a veto-or-upgrade signal.

Critic produces a **vote**, not just a veto. It can:
- skip → force decision = skip (overrides anything except
                                  hard-veto-from-skip semantics; see §4)
- concern → downgrade fire → size_down
- proceed → no change
- boost → upgrade size_down → fire, but only when conditions met (§4)

KEY INVARIANT: **Critic boost CANNOT turn a skip into a fire.**
Deterministic skips from Layers 1-3 (feasibility=dead, trust_score=0,
insufficient_edge) are structural floors that AI news cannot rescue.

Critic NEVER produces a probability or sizing recommendation. Those
remain owned by Layers 1-3 and Judge.

---

## 2. Inputs

### 2a. Layer outputs (compressed for prompt efficiency)

```js
{
  feasibility:    'strong'|'viable'|'fragile'|'dead',
  trust_level:    'high'|'medium'|'low',
  trust_score:    number,
  edge:           number,           // from Judge inputs
  market_mid:     number,
  decision_so_far: 'fire'|'size_down'|'skip',
}
```

These go into the prompt as ~50 tokens of structured context, so
Sonnet/Haiku knows what the chain already decided.

### 2b. External context (sourced from existing pipelines)

Reused from `lib/preflightCheck.js`:
- pitcher news (Google snippets, recent quotes, injury reports)
- opponent team news (lineup status, hot/cold hitters)
- line direction (DK move, Kalshi move, K-prop gap vs DK)
- bullpen IP last 2 days
- weather summary
- umpire identity + change status

### 2c. ctx (per-bet)

```js
{
  decision_id, strike, side,
  pitcher_id, pitcher_name, bet_date,
  game_pk, market_ticker,

  // Layer outputs
  layer1Envelope, layer2Result, layer3Result, judgeBaseDecision,

  // Critic-specific
  criticClient:   {  // dependency-injected for tests
    classify({ prompt, model, max_tokens }) → Promise<{verdict, confidence, concerns, raw}>
  },
  preflightContext: {  // pre-fetched from lib/preflightCheck pipeline
    kPropGap, lineDelta, bullpenData, weatherData, umpireData,
    pitcherNews: [...], opponentNews: [...],
  },
  cache:          { get, set } | null,    // optional cache adapter

  // Standard Trace fields
  emit_trace, trace, mode, system, run_id, commit_hash, ...
}
```

---

## 3. Output envelope

```js
{
  schema_version:        '1.0.0',
  layer:                 'critic',
  layer_version:         '1.0.0',
  source:                'oracle_layer_4_critic',
  run_id, decision_id, computed_at, commit_hash, fixture_id,
  inputs_hash, output_hash,

  matchup_output_hash,    // = layer1Envelope.output_hash
  path_output_hash,       // = layer2Result.output_hash
  trust_output_hash,      // = layer3Result.output_hash

  strike, side,

  verdict:        'skip' | 'concern' | 'proceed' | 'boost',
  confidence:     'high' | 'medium' | 'low',
  concerns:       string[],   // structured reasons (§5 vocab)
  reason_code:    string,     // primary driver

  // Cost / call accounting
  model_used:     'haiku' | 'sonnet' | 'cache' | 'unavailable',
  tokens_input:   number | null,
  tokens_output:  number | null,
  cost_usd:       number | null,
  cache_hit:      boolean,

  // Failure observability
  status:         'ok' | 'unavailable' | 'parse_error' | 'too_large',
  error_message:  string | null,
}
```

---

## 4. Veto + boost ladder (the core contract)

Judge v0.2 reads `criticResult.verdict` and applies:

```
critic.verdict   Judge transformation                effect on decision
──────────────   ───────────────────────────────     ──────────────────
skip             decision := 'skip'                  always overrides
concern          if decision === 'fire':             fire → size_down
                   decision := 'size_down'
                 else: no change
proceed          no change
boost            if decision === 'size_down'
                   AND L2 feasibility != 'fragile'
                   AND L3 trust_score >= 0.50
                   AND edge >= threshold
                   AND original size_down was caused by
                       LOW_TRUST_SIZE_DOWN (not FRAGILE_SIZE_DOWN):
                   then decision := 'fire'
                 else:
                   decision unchanged
                   add concern code 'boost_blocked_<reason>'
```

### 4a. boost_blocked reason codes

| Trigger | concern code |
|---|---|
| feasibility=fragile | `boost_blocked_fragile` |
| trust_score < 0.50 | `boost_blocked_low_trust` |
| edge < threshold | `boost_blocked_insufficient_edge` |
| decision was already skip | `boost_blocked_skip_floor` |
| decision was already fire | (no-op, no log — boost unnecessary) |
| size_down caused by FRAGILE_SIZE_DOWN | `boost_blocked_fragile_size_down` |

### 4b. Why these guards

The boost path can ONLY rescue a `size_down` that came from
`LOW_TRUST_SIZE_DOWN`. If the size_down came from
`FRAGILE_SIZE_DOWN` (Layer 2 said the path is structurally fragile),
external news doesn't rescue that — fragility is a workload issue
that AI cannot see around.

---

## 5. Reason / concern code vocabulary

### 5a. Critic-emitted concerns (from Sonnet/Haiku output)

```
news_pitcher_injury
news_pitcher_health_concern
news_pitcher_dominance        (positive — supports boost)
news_pitcher_recent_struggle
news_opponent_lineup_weak     (positive on YES, supports boost)
news_opponent_lineup_strong   (negative on YES)
news_opponent_lineup_unposted
news_lineup_scratched
weather_concern
weather_favorable
line_move_against_us
line_move_with_us
bullpen_overworked            (positive on NO, supports boost on NO)
ump_change
sharp_disagreement_dk
generic_concern
generic_positive
```

### 5b. Critic primary reason_code

= the concern that drove the verdict; or one of the meta-codes:
  `clean_proceed` (proceed, no concerns)
  `clean_boost` (boost, only positive signals)
  `mixed_signals` (concern with mix of pos/neg)
  `critic_unavailable`
  `critic_parse_error`
  `critic_too_large`

### 5c. boost_blocked codes (orchestrator-level)

See §4a.

---

## 6. Model selection (locked v1)

**Default model:** Anthropic Claude Haiku 4.5 (`claude-haiku-4-5-20251001`)

**Rationale:**
- Critic verdict is fundamentally categorical (4 options + confidence)
- Haiku handles structured-news classification well
- ~10× cheaper than Sonnet
- Fast (~1s p50) — important for pre-game decision flow

**Per-bet cost (estimated):**
- Input: ~3-4k tokens (compressed L1-L3 + top 5 news items + structure)
- Output: ~300 tokens (JSON with verdict + concerns)
- Cost: ~$0.001-0.002 per call

**Daily volume cost:** ~10-15 bets × $0.002 ≈ $0.02-0.03/day

**Sonnet escalation hook (deferred to v1.1, NOT in v1.0):**
- If Haiku returns `confidence: 'low'` OR fails to parse, optionally
  re-call Sonnet 4.6 for a second pass
- Cap escalations at 3/day
- Flag stays OFF in v1.0; design is just space-reserved

**Existing preflight stays Sonnet:**
- `lib/preflightCheck.js` continues using Sonnet for its existing
  pre-bet scouting role (NOT changing legacy behavior)
- Layer 4 Critic is a NEW path; uses Haiku
- Both can coexist; Layer 4 may eventually replace preflight in
  the Oracle migration, at which point we revisit model choice

---

## 7. Caching

**Cache key:**
```
sha256(JSON.stringify({
  pitcher_id, bet_date,
  lineup_state_hash,    // hash of (home_lineup_posted, away_lineup_posted, scratch_alert)
  line_direction_hash,  // hash of (dk_home_direction, dk_away_direction, line_delta_bucket)
  prompt_version,       // bumps when prompt template changes
}))
```

**TTL:** 4 hours from cache write

**Invalidation triggers:** lineup change (state hash changes),
scratched starter alert, prompt_version bump

**Storage:** mirrors `preflightCheck`'s `preflight_cache` table
pattern. New table: `oracle_critic_cache`. Schema:

```sql
CREATE TABLE oracle_critic_cache (
  cache_key       TEXT PRIMARY KEY,
  pitcher_id      TEXT NOT NULL,
  bet_date        TEXT NOT NULL,
  verdict         TEXT NOT NULL,
  confidence      TEXT NOT NULL,
  concerns_json   TEXT NOT NULL,
  reason_code     TEXT NOT NULL,
  model_used      TEXT NOT NULL,
  tokens_input    INTEGER,
  tokens_output   INTEGER,
  cost_usd        REAL,
  raw_response    TEXT,
  created_at      TEXT NOT NULL,
  expires_at      TEXT NOT NULL
);
CREATE INDEX idx_oracle_critic_cache_pitcher ON oracle_critic_cache(pitcher_id, bet_date);
CREATE INDEX idx_oracle_critic_cache_expires ON oracle_critic_cache(expires_at);
```

---

## 8. Cost cap / circuit breaker

| Trigger | Action |
|---|---|
| Per-bet prompt > 10k input tokens | reject; status='too_large'; verdict=proceed (fail open) |
| Daily Critic spend > $1.00 | WARN trace event |
| Daily Critic spend > $3.00 | hard skip Critic for the rest of the day; verdict=proceed |
| Single API call > 15s | timeout; verdict=proceed; status='unavailable' |

All circuit-breaker paths fail OPEN: deterministic chain stays functional.

---

## 9. Failure mode (FAIL OPEN)

If Sonnet/Haiku call fails for any reason:

```js
return {
  ...envelope,
  verdict:       'proceed',
  confidence:    'low',
  concerns:      [],
  reason_code:   'critic_unavailable',  // or critic_timeout / critic_parse_error
  model_used:    'unavailable',
  tokens_input:  null,
  tokens_output: null,
  cost_usd:      null,
  cache_hit:     false,
  status:        'unavailable',
  error_message: <real error>,
}
```

Trace event fires with `severity='warn'` so monitoring catches the
unavailability without escalating to critical (deterministic chain
is the safety floor).

ORACLE-HEALTH alert fires only if Critic unavailability > 5 events
in a single day.

---

## 10. Trace event shape

`event_type='decision'`, `decision = verdict`, `reason_code = primary`.

```js
{
  layer_name:    'critic',
  layer_version: '1.0.0',
  event_type:    'decision',
  decision:      'skip' | 'concern' | 'proceed' | 'boost',
  reason_code:   string,

  reasoning: {
    verdict, confidence, concerns,
    feasibility, trust_level, judge_base_decision,
    cache_hit, model_used,
  },

  metrics: {
    tokens_input, tokens_output, cost_usd, latency_ms,
    matchup_output_hash, path_output_hash, trust_output_hash,
  },

  evidence_used: [
    { name: 'oracle_layer_1_math.matchup',  id: '<pid>_<date>',  input_hash: ... },
    { name: 'oracle_layer_2_path.result',   id: '...',           input_hash: ... },
    { name: 'oracle_layer_3_trust.result',  id: '...',           input_hash: ... },
    { name: 'oracle_critic.preflight_ctx',  id: '<pid>_<date>',  input_hash: <sha of preflightContext> },
  ],

  status:   'success' | 'error' | 'timeout' | 'fail_closed',
  severity: 'info' | 'warn',
  ...
}
```

Note: cost_usd in metrics is critical for daily-cap monitoring.

---

## 11. Out of scope (v1)

- Web search (uses cached news from preflight pipeline only)
- Image inputs
- Multi-turn conversations
- Agentic tool use
- Sentiment scoring beyond Sonnet/Haiku's inline analysis
- Pitcher-specific fine-tuning
- Live in-game Critic (pre-game only)
- Sonnet escalation (deferred to v1.1)

---

## 12. Versioning

| Field | Value |
|---|---|
| schema_version | 1.0.0 |
| layer_version | 1.0.0 |
| LAYER_NAME | 'critic' |
| SOURCE | 'oracle_layer_4_critic' |
| prompt_version | 'critic-v1' |

`prompt_version` bumps invalidate cache entries.

---

## 13. Implementation plan

| Bite | Deliverable |
|---|---|
| L4.1 | This spec (locked) |
| L4.2 | preflightCheck adapter — pure normalizer (preflight result → Critic envelope inputs). Unit tests, no API. |
| L4.3 | `oracle/layers/4-critic/impl.js` — `run()` with `criticClient` injected; Trace; cache; fail-open |
| L4.4 | Mock-Critic tests — stub-based; envelope shape, hash linkage, all 4 verdicts, fail-open paths |
| L4.5 | Judge v0.2 — accepts `criticResult`; applies §4 ladder; boost_blocked logging; existing deterministic floor preserved |
| L4.6 | Judge v0.2 tests — extend `oracleJudgeTest`; ~30 new assertions covering 4 verdicts × 3 base decisions + boost-blocked paths |
| L4.7 | Live-Critic smoke test — manual, opt-in, real Haiku call on 1-2 fixtures. NOT in CI. Captures real cost numbers. |

---

## 14. Production rollout (recommended; not part of this spec)

| Stage | Duration | Behavior |
|---|---|---|
| Stage 1 — Shadow | 2 weeks | Critic runs on every bet; verdict logged in Trace; Judge ignores it |
| Stage 2 — Skip-only veto | 1 week | Critic 'skip' verdict gates Judge; concern/boost still logged but ignored |
| Stage 3 — Concern downgrade | 1 week | + Critic 'concern' downgrades fire→size_down |
| Stage 4 — Full ladder | ongoing | + Critic 'boost' upgrades size_down→fire (with §4 guards) |

Each stage requires explicit owner approval before advancing.
Boost is the riskiest stage and goes last because it's the only
direction that increases bet count.

---

*Spec locked 2026-05-01. Updates require explicit re-locking with
version bump.*
