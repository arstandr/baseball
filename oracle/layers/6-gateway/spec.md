# Layer 6: Gateway — Spec v1.0 (LOCKED)

**Status:** LOCKED 2026-04-30
**Owner:** Adam
**Deployment phasing:** Phase A (shadow, 24–48h) → Phase B (credential cutover, enforced)

---

## 1. Purpose

The Gateway is the single chokepoint for all state-changing Kalshi calls (place / cancel / amend). It enforces, at the server-side per request:

- HMAC + IP authentication
- Agent identity, version, and commit hash
- Account permissions and per-account daily loss/risk limits
- Input freshness (MLB state, Kalshi quote, decision)
- Killswitches (all / agent / mode / account / version-floor / commit-allowlist / order-USD-cap)
- Idempotency on `decision_id`
- Synchronous Trace logging before and after every exchange call

**The failure mode this layer eliminates:** a stale binary (Closer or any agent) running old code can bypass code-level kill switches because the kill switch only exists in newer code the stale binary never picked up. After Phase B credential cutover, no binary anywhere holds valid Kalshi write credentials except the Gateway, so any agent — current Closer, future Oracle, anything — must ask Gateway and accept its server-side enforcement.

**What the Gateway does NOT prevent:**
> Gateway prevents stale or unauthorized agents from placing orders outside the control plane. It does **not** prevent *omission failures* — where a stale agent fails to submit a valid order intent because it lacks new signal logic. Omission failures are addressed separately, through agent version enforcement, drift detection, and deployment monitoring (§9). The Gateway is a write-side filter, not a guarantee that good opportunities are taken.

---

## 2. Inputs

### Endpoints

```
POST /gateway/place
POST /gateway/cancel
POST /gateway/amend
POST /gateway/admin/killswitch     (HMAC-protected, audit-logged)
POST /gateway/admin/unhalt         (HMAC-protected, audit-logged, halt-bypass path)
GET  /gateway/healthz              (probe)
```

### Headers (every non-healthz request)

| Header | Type | Notes |
|---|---|---|
| `X-Gateway-Agent` | string (canonical enum) | `closer-legacy` \| `oracle` \| `gateway-probe-agent` \| ... |
| `X-Gateway-Agent-Version` | semver | e.g. `0.7.3` |
| `X-Gateway-Commit` | hex (40) | full git SHA of running binary |
| `X-Gateway-Timestamp` | unix ms | rejected if abs(now − ts) > 30s |
| `X-Gateway-Nonce` | uuid v4 | rejected if seen in last 60s |
| `X-Gateway-Body-SHA256` | hex (64) | sha256 of raw body bytes |
| `X-Gateway-Signature` | hex (64) | HMAC-SHA256 |

**HMAC payload:**
```
bodySha256       = sha256_hex(rawBody)            // server recomputes from raw bytes received
signaturePayload = `${timestamp}.${nonce}.${bodySha256}`
signature        = hex(HMAC_SHA256(secret_for_agent, signaturePayload))
```

The server recomputes `bodySha256` from the raw bytes it actually received and compares to `X-Gateway-Body-SHA256` BEFORE recomputing the signature. This isolates JSON-serialization bugs from auth bugs.

### Body — `POST /gateway/place`

```jsonc
{
  // Decision binding
  "decision_id":          "string (caller-generated, idempotency key)",
  "decision_input_hash":  "hex64 (hash of inputs that produced this decision)",
  "trace_event_type":     "string (e.g. 'closer_legacy_decision', 'oracle_judge_decision')",

  // Account + execution context
  "account_id":           "adam | isaiah",
  "execution_mode":       "shadow | production",
  "strategy_mode":        "<canonical strategy_mode enum>",

  // Order semantics (no overloaded 'side' field)
  "market_ticker":        "string",
  "action":               "buy | sell",
  "contract_side":        "yes | no",
  "order_type":           "limit | market",
  "time_in_force":        "GTC | IOC | FOK",
  "quantity":             "int (contracts)",
  "limit_price_cents":    "int (omitted if order_type=market)",

  // Snapshot evidence (V1 audit, V2 enforced)
  "evidence": {
    "mlb_state_hash":     "hex64",
    "mlb_state_ts":       "unix ms",
    "kalshi_quote_hash":  "hex64",
    "kalshi_quote_ts":    "unix ms",
    "position_hash":      "hex64",
    "position_ts":        "unix ms",
    "orderbook_hash":     "hex64",
    "orderbook_ts":       "unix ms"
  },

  // Decision metadata for audit
  "pitcher_id":              "string",
  "pitcher_name":            "string",
  "bet_date":                "YYYY-MM-DD",
  "strike":                  "int",
  "expected_pK_low":         "float",
  "expected_pK_high":        "float",
  "bet_amount_usd":          "float",
  "kelly_fraction":          "float",
  "bankroll_at_decision_usd":"float"
}
```

### Body — `POST /gateway/cancel`

```jsonc
{
  "decision_id":     "string",
  "trace_event_type":"string",
  "account_id":      "adam | isaiah",
  "execution_mode":  "shadow | production",
  "strategy_mode":   "<canonical>",
  "kalshi_order_id": "string"
}
```

### Body — `POST /gateway/amend`

```jsonc
{
  "decision_id":          "string",
  "trace_event_type":     "string",
  "account_id":           "adam | isaiah",
  "execution_mode":       "shadow | production",
  "strategy_mode":        "<canonical>",
  "kalshi_order_id":      "string",
  "new_limit_price_cents":"int (optional)",
  "new_quantity":         "int (optional)"
}
```

---

## 3. Outputs

### Status codes (all endpoints)

| status | meaning |
|---|---|
| `accepted` | production: order placed at exchange; `kalshi_order_id` returned |
| `shadow_logged` | mode=shadow, no exchange call, Trace event written |
| `rejected` | validation failed; `reject_reason` set (see §4) |
| `exchange_unknown` | Kalshi timeout/network error after submit attempt; reconciler will resolve |
| `exchange_error` | Kalshi returned a definitive non-retryable error (e.g. insufficient funds) |
| `replay` | idempotent retry, same decision_id + same body hash → cached result returned |
| `conflict` | `IDEMPOTENCY_CONFLICT` — decision_id reused with different body hash |
| `halted` | Gateway is in `GATEWAY_BLIND` halt; only probe and admin/unhalt accepted |

### Response body

```jsonc
{
  "status": "accepted | shadow_logged | rejected | exchange_unknown | exchange_error | replay | conflict | halted",
  "reject_reason":         "string (when status=rejected)",
  "kalshi_order_id":       "string (when placed)",
  "exchange_response":     "object (raw Kalshi body, audit-only)",
  "trace_event_id_intent": "uuid",
  "trace_event_id_result": "uuid",
  "latency_ms": {
    "validation": "int",
    "exchange":   "int (0 for shadow/rejected)",
    "total":      "int"
  },
  "reconciliation_state":  "pending | resolved (only when status=exchange_unknown)"
}
```

---

## 4. Failure modes

### Validation rejects (no exchange call)

All emit a Trace event with `event_type='gateway_reject'` and the reject_reason; counted in §9 reject-spike baseline.

| reject_reason | trigger |
|---|---|
| `DB_DOWN` | Trace or config table unreachable |
| `TRACE_DOWN` | Trace writeSync (intent) failed |
| `HMAC_INVALID` | bad sig / replayed nonce / stale ts (>30s) / missing headers |
| `IP_NOT_ALLOWED` | source IP not in allowlist for agent (warn-only in V1, hard-reject in V2) |
| `KILLSWITCH_ALL` | `gateway_kill_all=true` |
| `KILLSWITCH_AGENT` | agent in `gateway_kill_agent` |
| `KILLSWITCH_MODE` | strategy_mode in `gateway_kill_mode` |
| `KILLSWITCH_ACCOUNT` | account_id in `gateway_kill_account` |
| `VERSION_BELOW_MIN` | agent_version < `min_version_by_agent[agent]` (production); shadow may pass if `monitor_only_stale_agent[agent]=true`. Prerelease versions (`-rc1`, etc.) are LOWER than the corresponding GA — operator must allowlist the specific commit to ship an RC against a GA floor. |
| `COMMIT_NOT_ALLOWED` | commit_hash not in `allowed_commit_hash_by_agent[agent]` |
| `BODY_INVALID` | required body field missing, body not an object, or wrong shape (separate from ENUM_INVALID for debuggability) |
| `ENUM_INVALID` | a canonical-enum field has a value not in the registry (typo in `strategy_mode`, case mismatch, etc.) |
| `ACCOUNT_UNKNOWN` | account_id not in `gateway_accounts` or `enabled=0` |
| `ACCOUNT_STATE_STALE` | `gateway_account_daily_state.updated_at` older than the per-mode window: **60s for live**, **10min for pregame**. Shadow mirrors the corresponding production window. Missing row = stale. |
| `ACCOUNT_DAILY_LOSS_BREACHED` | account `realized_pnl_usd + open_risk_usd < -daily_loss_limit_usd` |
| `ACCOUNT_DAILY_RISK_BREACHED` | account `submitted_order_usd + this_order_usd > daily_risk_limit_usd` |
| `ORDER_USD_OVER_LIMIT` | `bet_amount_usd > max_order_usd_by_mode[strategy_mode]` |
| `DECISION_NOT_FOUND` | no Trace event with this decision_id |
| `DECISION_STALE` | Trace event older than 30s (live) / 5min (pregame) |
| `DECISION_AGENT_MISMATCH` | Trace event's agent_name ≠ submitted agent |
| `STATE_STALE_MLB` | `mlb_state_ts` age > 20s (live only) |
| `STATE_STALE_QUOTE` | `kalshi_quote_ts` age > 10s (live only) |
| `IDEMPOTENCY_CONFLICT` | same decision_id, different body_hash, within 5min idempotency window |
| `GATEWAY_HALTED` | gateway in `GATEWAY_BLIND` halt |

### Internal sub-reasons for `HMAC_INVALID`

Public `reject_reason` is always `HMAC_INVALID` (we don't leak which auth check failed). Internal Trace event records the sub-cause via `context.internal_reason`:

`MISSING_HEADER` · `AGENT_UNKNOWN` · `STALE_TIMESTAMP` · `BODY_HASH_MISMATCH` · `NO_SECRET_FOR_AGENT` · `SIG_MISMATCH` · `NONCE_REPLAYED`

### Warnings (non-rejecting)

When validation succeeds but a budget-burning condition is observed, the response carries `warnings: []`. The orchestrator writes each warning to Trace as `severity=warning`:

| code | trigger |
|---|---|
| `DECISION_AGE_HIGH` | live decision age 15s–30s (50%+ of the freshness budget consumed) |

### Exchange-side outcomes

- `exchange_success` → status=`accepted`, `kalshi_order_id` set
- `exchange_error` → Kalshi 4xx with definitive rejection (insufficient funds, market closed, etc.). Logged, returned to caller, NO retry.
- `exchange_unknown` → timeout, 5xx, or network error after submit attempt. Row inserted in `gateway_unknowns`; reconciler resolves (§ Reconciliation worker). Caller MUST NOT retry independently — same decision_id replay returns `exchange_unknown` from idempotency cache until reconciler updates.

### Trace failure handling

| scenario | behavior |
|---|---|
| writeSync (intent) fails BEFORE exchange | reject with `TRACE_DOWN`. No exchange call. |
| writeSync (result) fails AFTER exchange | write to `/data/oracle/dead-letter/gateway-{date}.jsonl`, fire `POST_EXCHANGE_TRACE_GAP` critical alert, return result to caller. Order is real; ledger has a recoverable gap. |
| writeSync (result) fails AND dead-letter write fails | fire `GATEWAY_BLIND` critical alert, halt Gateway (refuse new accepts), in-flight requests return their result, return `halted` to all subsequent callers until unhalt. |

### `GATEWAY_BLIND` halt — auto-clear and manual unhalt

**Auto-clear:**
- If Gateway is halted due to `GATEWAY_BLIND`, AND
- A successful Trace writeSync occurs (via probe or recovered request), AND
- A successful dead-letter write occurs (via probe), AND
- The full health probe (§6) passes for **2 consecutive checks**,
- Then auto-clear the halt and emit ORACLE-HEALTH `GATEWAY_RECOVERED` info alert.

**Manual unhalt:**
- `POST /gateway/admin/unhalt` (HMAC-required, audit-logged to Trace)
- This path is reachable WHILE Gateway is halted (halt-bypass for admin endpoints only).
- Manual unhalt clears `GATEWAY_BLIND` only; it does NOT clear `gateway_kill_*` operator killswitches.

**Distinction:** `gateway_kill_*` are deliberate operator decisions (do not auto-clear); `GATEWAY_BLIND` is operational self-protection (auto-clears once observability returns).

---

## 5. Test fixtures (cutover gate: F1–F26 must all pass)

### Validation

- **F1** happy path closer-legacy v0.7.3 places live YES → `accepted`, `kalshi_order_id` returned, intent + result Trace events written
- **F2** stale agent version (v0.5.0 < min) → `VERSION_BELOW_MIN`, ORACLE-HEALTH alert
- **F3** killswitch_all on → `KILLSWITCH_ALL`, no exchange call
- **F4** killswitch_agent (closer-legacy on, oracle off) → closer rejected, oracle accepted
- **F5** killswitch_account (adam on) → adam rejected, isaiah accepted
- **F6** killswitch_mode (`live_model_yes` on) → that mode rejected, others accepted
- **F7** account daily loss breached → `ACCOUNT_DAILY_LOSS_BREACHED`
- **F8** account state stale (updated_at > 60s ago) → `ACCOUNT_STATE_STALE`

### HMAC

- **F9** bad signature → `HMAC_INVALID`
- **F10** replayed nonce → `HMAC_INVALID`
- **F11** stale timestamp (>30s) → `HMAC_INVALID`
- **F12** valid HMAC, body bytes mutated by middleware → `HMAC_INVALID` (body hash mismatch)

### Decision binding

- **F13** decision_id missing in Trace → `DECISION_NOT_FOUND`
- **F14** decision_id 45s old (live) → `DECISION_STALE`
- **F15** decision_id 4min old (pregame) → `accepted` (under 5min limit)
- **F16** decision_id from agent A submitted by agent B → `DECISION_AGENT_MISMATCH`

### Freshness

- **F17** mlb_state_ts 25s old (live) → `STATE_STALE_MLB`
- **F18** kalshi_quote_ts 15s old (live) → `STATE_STALE_QUOTE`

### Idempotency

- **F19** mode=shadow → `shadow_logged`, no exchange call
- **F20** idempotent retry, same body → `replay` returns cached result
- **F21** idempotent retry, different body → `conflict` (`IDEMPOTENCY_CONFLICT`)
- **F24** same decision_id + same body after `exchange_unknown` → `replay` returns `exchange_unknown`, NO second Kalshi call
- **F25** same decision_id + same body after `accepted` → `replay` returns cached `accepted` + order_id, NO second Kalshi call

### Exchange + dead-letter

- **F22** Kalshi 5xx timeout after submit → `exchange_unknown`; reconciler resolves to `placed` within 30s
- **F23** Kalshi 4xx (insufficient funds) → `exchange_error`, no retry
- **F26** post-exchange Trace failure + dead-letter write also fails → Gateway enters `GATEWAY_BLIND` halt, `GATEWAY_BLIND` critical fired, subsequent requests return `halted`

### Enum + structural

- **F27** unknown strategy_mode value → `ENUM_INVALID`
- **F28** unknown action / contract_side / order_type / time_in_force → `ENUM_INVALID`
- **F29** killswitch admin attempt to set `gateway_kill_mode='live_yes'` (not in canonical enum) → admin endpoint rejects with `ENUM_INVALID`

### Halt path

- **F30** `GATEWAY_BLIND` active → place returns `halted`
- **F31** auto-clear: 2 consecutive successful health probes after `GATEWAY_BLIND` → halt clears, recovered alert fired
- **F32** manual unhalt via admin endpoint while halted → halt clears, audit Trace event written

---

## 6. Health probe

### Per-minute synthetic place (shadow)

- Agent: `gateway-probe-agent`
- Decision: synthetic Trace event written 100ms before probe
- execution_mode: `shadow`
- Expected: `shadow_logged`
- Probe also exercises Trace round-trip (same as Layer 0 probe shape)

**2 consecutive failures → ORACLE-HEALTH critical**.

### Reconciliation probe (every 5 min)

- Count rows in `gateway_unknowns` where `resolved_at IS NULL AND submitted_at < now-60s`
- 0 → ok
- ≥1 → ORACLE-HEALTH warn (`unknown_unresolved_60s`)
- Any row older than 5min → ORACLE-HEALTH critical (`unknown_unresolved_5min`)

### Dead-letter probe (every 5 min)

- Synthetic write of a probe row to current dead-letter file, fsync, read back, delete
- Fail → ORACLE-HEALTH critical (`dead_letter_volume_unwritable`)
- This probe is what powers `GATEWAY_BLIND` auto-clear

### `/data` volume sentinel (startup)

- On startup, write `/data/oracle/.gateway_sentinel` with current commit SHA
- On next startup, expect to read previous sentinel
- Mismatch or missing → log warning. Empty volume on startup means data was lost, so we record the discontinuity

---

## 7. Performance budget

| phase | p99 |
|---|---|
| HMAC + nonce + IP check | <30ms |
| Killswitch + version + commit + enum check | <30ms (1s-TTL cache) |
| Account state lookup (materialized row) | <20ms |
| Decision Trace lookup | <30ms (indexed on decision_id) |
| Freshness check (in-body timestamps only) | <5ms |
| Idempotency cache lookup + body hash compare | <30ms |
| **Validation total** | **<100ms** |
| Trace writeSync (intent) | <500ms |
| Kalshi exchange call | <1500ms |
| Trace writeSync (result) | <500ms |
| **Total p99** | **<2500ms** |

Validation > 250ms p99 over a 5min window → ORACLE-HEALTH warn (DB or Trace degraded).

---

## 8. Kill switch

### `gateway_killswitch` table — keys

All values JSON-encoded except where noted.

| key | type | notes |
|---|---|---|
| `gateway_kill_all` | bool | rejects everything except probes + admin |
| `gateway_kill_agent` | array of agent_id | enum-validated against canonical agents |
| `gateway_kill_mode` | array of strategy_mode | enum-validated; admin endpoint rejects unknown |
| `gateway_kill_account` | array of account_id | enum-validated against `gateway_accounts` |
| `min_version_by_agent` | object | `{agent: semver}`; `monitor_only_stale_agent[agent]=true` lets shadow pass |
| `monitor_only_stale_agent` | object | `{agent: bool}`; if true, agents below min may submit shadow but never production |
| `allowed_commit_hash_by_agent` | object | `{agent: [sha40, ...]}` |
| `daily_loss_limit_by_account` | object | `{account: usd}`; mirrored into `gateway_account_daily_state` |
| `daily_risk_limit_by_account` | object | `{account: usd}` |
| `max_order_usd_by_mode` | object | `{strategy_mode: usd}` |

### Cache

- 1s TTL in memory for ALL killswitch keys.
- DB hit per second is acceptable; safety > efficiency.
- `gateway_killswitch.updated_at` tick triggers immediate cache refresh on any read that crosses the boundary.

### Admin endpoint

`POST /gateway/admin/killswitch`

- HMAC-required (separate `GATEWAY_ADMIN_SECRET`)
- Audit-logged to Trace as `event_type='gateway_admin_killswitch_change'`
- Validates enum values against canonical registry — rejects unknown with `ENUM_INVALID`
- Returns the prior value for rollback

### Operational halts vs operator killswitches

| type | clears via |
|---|---|
| `gateway_kill_all` and friends (operator) | manual operator action only — no auto-clear |
| `GATEWAY_BLIND` halt (operational) | auto-clear after 2 successful health probes OR manual unhalt |

---

## 9. Drift detector

### Agent-version drift (hourly)

- Compute set of `(agent, version, commit_hash)` tuples seen in the last hour from Trace.
- Diff vs previous hour.
- New tuple → ORACLE-HEALTH info `gateway_new_agent_version`.
- Tuple active for 7+ days then missing 4+ hours → ORACLE-HEALTH warn `gateway_agent_disappeared`.

### Order-rate baseline

- Track placements/min by `(agent, execution_mode, strategy_mode, account)`.
- 5x deviation from 7-day median over a 5min window → warn.
- 0 placements in a window where median > 1/min → warn (omission signal — note this is the only place we *can* surface omission failures, and it's informational, not enforcement).

### Reject-rate spike

- Per-agent reject rate / accept rate ratio.
- 10x baseline jump in 5min → warn (likely caller bug or attempted bypass).

### Unauthorized commit attempts

- Any `COMMIT_NOT_ALLOWED` reject → critical alert immediately (this is the smoking gun for a stale binary attempting to place after cutover).

---

## 10. Success metric / SLO

### V1 (shadow, 24–48h)

- 100% of Closer placements have a matching Gateway shadow intent
- Every would-reject investigated and classified as one of:
  - `true_reject` — Closer should not have placed; Gateway is correct
  - `false_reject` — Gateway logic bug; fix before cutover
  - `policy_disagreement` — deliberate philosophy difference; document and decide
  - `data_freshness_mismatch` — timing artifact, not a bug
- p99 total latency < 2500ms
- p99 validation latency < 100ms

**Cutover gate to V2:** 0 unresolved `false_reject` in final 24h before V2 cred rotation.

### V2 (enforced)

- 99.9% of Gateway calls return non-error within budget
- 0 unauthorized commit_hash placements (`COMMIT_NOT_ALLOWED` count = 0 except probes)
- 100% decision_id binding (every `accepted` has a Trace event)
- 100% reconciliation: no `exchange_unknown` row unresolved past 5min
- 0 `GATEWAY_BLIND` halt incidents in first 7 days post-cutover

### V2 cutover prerequisites

1. ✅ Railway persistent volume mounted at `/data` (startup sentinel verifies)
2. ✅ Chaos test passing: `scripts/oracle/gatewayChaosTest.js` exercises all dead-letter + halt paths
3. ✅ All F1–F32 fixtures green
4. ✅ V1 shadow ran ≥24h with 0 unresolved `false_reject`
5. ✅ Per-agent HMAC secrets provisioned in Railway env
6. ✅ Reconciliation worker running; tested against synthetic `exchange_unknown`
7. ✅ Killswitch admin endpoint working with enum validation
8. ✅ **`validatePlaceIntent` + `validateCancelIntent` + `validateAmendIntent` all implemented and tested.** Phase A shadow may stub cancel/amend, but V2 credential rotation is blocked until all three state-changing paths flow through Gateway. Closer credentials cannot be revoked while cancel/amend remain on the direct path.
9. ✅ **`client_order_id` plumbed through `lib/kalshi.placeOrder`.** Gateway already passes `decision_id` to the kalshi client; `lib/kalshi` must include it as `client_order_id` in the Kalshi request body for exchange-side idempotency. Without this, a Gateway timeout retry on a decision whose first attempt actually reached Kalshi would double-place. V1 shadow tolerates absence (no real exchange call); V2 production cannot ship without it.
10. ✅ **Hard route-level timeout enabled.** V1 route uses a SOFT 5s deadline (warn-only via `ROUTE_LATENCY_HIGH` Trace event; in-flight orchestrator NOT aborted, because aborting mid-Kalshi-call risks double-place when the caller retries). V2 enables hard abort once #9 is shipped: client_order_id makes Kalshi-side dedup safe even on retry races.

---

## 11. Rollback plan

### V1 (shadow phase)

Stop the shadow worker. Closer keeps placing direct via existing path. Zero risk.

### V2 (enforced)

**No rollback to direct bypass exists.** The `GATEWAY_DISABLED` env var does not exist in code. Closer's Kalshi credentials have been revoked at the Kalshi portal.

If Gateway breaks:
- Halt = no trading window. Operator-investigated.
- This is acceptable. Lost trading window is recoverable; stale-binary placement is not.

**Last-resort recovery (deliberate, manual, audited):**
- Operator re-issues Closer's Kalshi credentials via the Kalshi portal (logged externally).
- Operator removes Gateway from the placement path manually.
- This action requires Kalshi portal access — it is not an env var, not an automated path, and inherently rate-limited by being a human action.

---

## 12. Dependencies

- **Layer 0 Trace** — writeSync, read by decision_id, schema includes `oracle_trace_events.decision_id` index ✅ (shipped)
- **Kalshi REST + WS client** — moved into Gateway codepath; reads (positions, fills, balance, markets, orderbook) remain available outside Gateway
- **Railway persistent volume** at `/data` — required for V2 (dead-letter durability)
- **Per-agent HMAC secrets** — env vars `GATEWAY_SECRET_<AGENT_ID>` and `GATEWAY_ADMIN_SECRET`
- **Per-agent IP allowlist** — env var `GATEWAY_IP_ALLOWLIST_<AGENT_ID>` (warn-only V1, hard-reject V2)
- **Canonical enum registry** — `oracle/layers/6-gateway/strategyModes.js` and adjacent enum files; validated at intent time AND at killswitch admin time
- **Reconciliation worker** — separate cron in scheduler (15s interval first 5min after submit, 60s thereafter)
- **Settlement → account_daily_state updater** — existing settlement path writes to `gateway_account_daily_state` so per-request reads are O(1) lookups, not SUM aggregations
- **Chaos test** — `scripts/oracle/gatewayChaosTest.js`; required pre-V2 cutover gate

---

## Schema reference

See `oracle/layers/6-gateway/schema.sql` for the locked DDL. Tables:

- `gateway_accounts` — account config
- `gateway_killswitch` — operator switches (1s cache TTL)
- `gateway_idempotency` — decision_id keyed cache + exchange-state fields for unknown resolution
- `gateway_unknowns` — exchange_unknown reconciliation queue
- `gateway_nonces` — replay protection (60s expiry)
- `gateway_account_daily_state` — materialized per-account daily P&L / risk / submitted USD
- `gateway_admin_audit` — full admin endpoint audit log

---

## Versioning

- This document: spec v1.0 (LOCKED 2026-04-30)
- Schema version: tracked in code via `GATEWAY_SCHEMA_VERSION` constant
- HMAC scheme version: `1` (single-secret per agent; v1.1 will add dual-secret rotation window)

Spec changes require a new version bump and explicit re-locking. All changes recorded in `CHANGES.md` adjacent to this file.
