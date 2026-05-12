# Layer 4 (Critic) — Parity / Runtime Notes

Companion to `SPEC.md`. Implementation close-outs.

---

## L4.2 close-out (2026-05-01) — preflightAdapter

### Files

- ✅ `oracle/layers/4-critic/preflightAdapter.js` — pure normalizer

### Exports

```
PROMPT_VERSION = 'critic-v1'
CONCERN_VOCAB                            (frozen 17-item vocab)
buildSystemPrompt()                      → string
buildUserPrompt({chainSummary, preflightContext, betMeta})
                                         → string
computeCacheKey({pitcher_id, bet_date, preflightContext})
                                         → sha256 hex
parseCriticResponse(rawString)           → {ok, parsed?, error?}
ADAPTER_VERSION = '1.0.0'
```

### Behavior

- System prompt enumerates the full concern vocabulary so the model uses only those terms.
- User prompt compresses chain context (~50 tokens), includes top 5 pitcher news, top 3 opponent news, lineup status, line direction, weather, bullpen, ump, K-prop gap.
- `parseCriticResponse` handles common LLM mistakes: JSON code fences (```` ```json ```` ), prefix prose, malformed concerns array. Filters concerns to vocab; deduplicates; caps at 8.
- `computeCacheKey` uses `sha256(pitcher_id, bet_date, lineup_state_hash, line_direction_hash, prompt_version)`. Lineup change → cache miss.

---

## L4.3 close-out (2026-05-01) — Critic impl.js

### Files

- ✅ `oracle/layers/4-critic/impl.js` — `run(layer1Envelope, layer2Result, layer3Result, ctx)`

### Behavior

- Builds prompt via `preflightAdapter`.
- Checks cache via `ctx.cache.get(cacheKey)` if provided. Cache hit returns `model_used='cache'`, `cache_hit=true`.
- Cache miss calls `ctx.criticClient.classify({system, user, model, max_tokens})` — production wires Anthropic SDK; tests inject a stub.
- Default model: `claude-haiku-4-5-20251001`.
- Default timeout: 15s. Default max_input_tokens: 10,000.
- **FAIL OPEN on every error path:**
  - `criticClient` missing → `verdict='proceed'`, `status='unavailable'`
  - API throws → `verdict='proceed'`, `status='unavailable'`
  - Timeout → `verdict='proceed'`, `status='timeout'`
  - Parse error → `verdict='proceed'`, `status='parse_error'`
  - Prompt too large → `verdict='proceed'`, `status='too_large'` (no API call)
- Cache write on successful API response.
- Trace event optional via `emit_trace`. Severity is `info` on `status='ok'`, `warn` on any failure path.

### Reason-code derivation

```
verdict='proceed' AND no concerns         → reason_code='clean_proceed'
verdict='boost' AND concerns.length > 0   → reason_code='clean_boost'
concerns.length > 0                       → reason_code = first concern
otherwise                                  → 'mixed_signals' or status-driven code
```

---

## L4.4 close-out (2026-05-01) — Mock-Critic tests

### Files

- ✅ `scripts/tests/oracleCriticTest.js` — **89 assertions, 0 failed**

### Sections

| Section | Coverage |
|---|---|
| A — preflightAdapter | system prompt vocab inclusion, user prompt structure, cache key determinism, parseCriticResponse (happy + fenced + prose + bad verdict + concerns filter) |
| B — Critic impl envelope shape | every field, hash linkage to L1/L2/L3 envelopes, run_id is uuid |
| C — verdict round-trip | all 4 verdicts (skip / concern / proceed / boost) returned correctly via stub |
| D — cache hit | first call → API miss; second call (same context) → cache hit, no second API call |
| E — fail-open paths | client missing → proceed; client throws → proceed; parse error → proceed; too_large → proceed (no API call); timeout → proceed |
| F — Trace integration | emit_trace=true emits one event; validateTraceEvent passes; fail-open events get severity='warn' |
| G — ctx validation | empty decision_id, bad strike, bad side all throw |

---

## L4.5 close-out (2026-05-01) — Judge v0.2

### Files

- ✅ `oracle/layers/5-judge/impl.js` updated to v0.2.0

### Changes vs v0.1

- New optional `ctx.criticResult` parameter
- Backward-compatible: when absent, behaves identically to v0.1
- Critic ladder applied AFTER baseline deterministic decision
- `result` adds: `baseline_decision`, `baseline_reason`, `critic_verdict`, `critic_applied[]`, `critic_output_hash`
- `inputs_hash` includes `critic_output_hash`
- New reason codes: `CRITIC_SKIP`, `CRITIC_CONCERN_DOWNGRADE`, `CRITIC_BOOST`
- BOOST_BLOCKED_CODES enumerates the 5 reasons boost can be impotent
- TRUST_BOOST_MIN = 0.50 (threshold below which boost is blocked)
- Trace event `reasoning` carries the critic ladder details

### Critic ladder (locked)

```
verdict   action
─────     ──────────────────────────────────────────────────
skip      Force decision = 'skip' (overrides anything)
concern   fire → size_down (size_down/skip unchanged)
proceed   no change
boost     size_down → fire ONLY when ALL true:
            - feasibility != 'fragile'
            - baseline_reason != 'fragile_size_down'
            - trust_score >= 0.50
            - edge >= threshold
          Else: stays size_down; logs boost_blocked_<reason>
```

### Boost-blocked codes

| Code | Trigger |
|---|---|
| `boost_blocked_fragile` | feasibility=fragile |
| `boost_blocked_fragile_size_down` | baseline reason was fragile_size_down |
| `boost_blocked_low_trust` | trust_score < 0.50 |
| `boost_blocked_insufficient_edge` | edge < threshold |
| `boost_blocked_skip_floor` | decision was already skip |

---

## L4.6 close-out (2026-05-01) — Judge v0.2 tests

### Files

- ✅ `scripts/tests/oracleJudgeTest.js` extended with Section D — **83 total assertions, 0 failed** (was 34 in v0.1; added 49 for v0.2)

### Section D coverage

| ID | Test |
|---|---|
| D1 | Critic skip overrides fire → reason=critic_skip |
| D2 | Critic skip on already-skip is redundant; baseline reason preserved |
| D3 | Concern downgrades fire → size_down; reason=critic_concern_downgrade |
| D4 | Concern on size_down is no-op |
| D5 | Proceed is no-op |
| D6/D6b | Boost upgrades size_down → fire when LOW_TRUST_SIZE_DOWN baseline + trust ≥ 0.50 |
| D7 | Boost blocked by fragile baseline |
| D8 | Boost blocked by trust_score < 0.50 |
| D9 | Boost CANNOT upgrade skip |
| D10 | Boost on already-fire is no-op |
| D11 | No criticResult → behaves like v0.1 (back-compat) |
| D12 | critic_output_hash propagates into Judge envelope |
| D13 | Trace event reflects critic info, evidence has 4 entries (incl. critic) |

---

## L4.7 close-out (2026-05-01) — Live smoke test (opt-in)

### Files

- ✅ `scripts/oracle/criticLiveSmokeTest.js`

### Behavior

- Reads `ORACLE_CRITIC_LIVE` env flag. If unset, exits with instructions.
- When flag set, calls real Anthropic Haiku 4.5 via `@anthropic-ai/sdk`.
- Uses fixture `l1.fixtures[0]` with hand-crafted preflight context.
- Reports the live verdict + token usage + estimated cost.
- Exits non-zero if verdict is malformed or status != 'ok'.

### How to run

```bash
ORACLE_CRITIC_LIVE=1 node scripts/oracle/criticLiveSmokeTest.js
```

Cost: ~$0.001-0.002 per call. Not in CI. Not run as part of regression sweep.

---

## Test totals after Layer 4 + Judge v0.2

| Test | Assertions |
|---|---:|
| oracleMathParityTest | 865 |
| oracleDkBlendTest | 193 |
| oraclePathFeasibilityTest | 209 |
| oraclePathParityTest | 3148 |
| oracleTrustParityTest | 2871 |
| oracleCriticTest | 89 |
| oracleJudgeTest (v0.2) | 83 |
| **Total** | **7,458** |

**0 failed.**

---

## What's still deferred

- Live Critic backtest on production data (would need `preflight_json` from `decision_pipeline` AND real API calls — both authorization required from owner)
- Sonnet-escalation hook from Haiku low-confidence (v1.1)
- Caching DDL migration (`oracle_critic_cache` table) — schema documented in SPEC.md §7 but not migrated
- Production wiring (Stage 1: shadow → Stage 4: full ladder per SPEC.md §14)

---

*All implementation bites L4.1–L4.7 complete 2026-05-01.*
