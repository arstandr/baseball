# Layer 0: Trace / Audit Ledger

**Status:** 🔒 LOCKED v1.0 — ready for implementation
**Last edited:** 2026-04-30
**Signed off:** 2026-04-30 by Adam + Claude

---

## 1. Purpose

Trace is the foundation that makes every other layer auditable, debuggable, and improvable. It records WHAT each layer decided, WHY, and WHAT actually happened — for every bet evaluated, whether placed or skipped.

If Trace is broken, calibration is impossible, replay is impossible, A/B comparison is impossible. That's why it's Layer 0.

**One-line summary:** Trace is the system's single source of truth about its own behavior.

---

## 2. Inputs — Event Schema

Every layer emits **events** to Trace. Schema (locked):

```typescript
interface TraceEvent {
  // ── Identity (required) ──
  id: string                    // UUID, this event's primary key
  decision_id: string           // UUID per bet evaluation; ALL layer events for one bet share this
  parent_event_id: string|null  // event that triggered this one (chain debugging)
  trace_schema_version: string  // e.g. "1.0.0" — locked at write time
  created_at: string            // ISO timestamp

  // ── Provenance (required) ──
  layer_name: string            // 'math' | 'path' | 'trust' | 'critic' | 'judge' | 'gateway' | 'execution' | 'system'
  layer_version: string         // semantic, manually bumped on algorithm change
  commit_hash: string           // exact code that ran, auto from build
  agent_id: string              // 'railway' | 'closer' | hostname for diagnostics
  agent_version: string         // for stale-client detection (the 4/29 incident)
  server_version: string|null   // populated for Gateway-mediated events
  environment: string           // 'production' | 'staging' (forward-compatible; v1 always 'production')
  run_id: string|null           // ID for the broader pipeline run (e.g. morning_run_2026-04-30)
  request_id: string|null       // for Gateway: correlates client intent → server decision

  // ── Context (required) ──
  mode: 'production' | 'shadow' // is this event from real flow or shadow run?
  system: 'oracle' | 'current' | 'old'  // which system produced it (for A/B comparison)
  event_type: string            // 'decision' | 'health_check' | 'heartbeat' | 'config_change' | 'error'
  user_id: number|null          // null for layer-level events; populated for per-user decisions
  bet_id: string|null           // populated once a ks_bets row exists; null for shadow

  // ── Bet identity (required for decision events) ──
  // Sparse for non-decision events (heartbeat, health_check)
  game_pk: string|null
  pitcher_id: string|null
  pitcher_name: string|null
  market_ticker: string|null    // Kalshi ticker
  bet_date: string|null         // YYYY-MM-DD
  strike: number|null
  side: 'YES'|'NO'|null

  // ── The decision (required for decision events) ──
  decision: string              // layer-defined: 'pass' | 'skip' | 'size_down' | 'fire' | 'no_objection' | etc.
  reason_code: string           // categorical, machine-readable (e.g. 'workload_bf_risk', 'low_trust')
  reasoning: object             // structured, layer-defined details (NOT prose)
  metrics: object               // numeric outputs (e.g. {modelProb: 0.78, edge: 0.27, kellySize: 90})

  // ── Replay integrity (required) ──
  evidence_used: Array<{
    name: string                // e.g. 'pitcher_recent_starts', 'dk_k_props'
    id: string                  // pointer to source row (e.g. 'pitcher_123_game_456')
    input_hash: string          // sha256 of the actual values used
                                // (catches "row changed under us" replay corruption)
  }>
  input_hash: string            // sha256 of all inputs combined (for full-context replay check)
  output_hash: string           // sha256 of decision + reasoning + metrics

  // ── Operational (required) ──
  status: 'success' | 'error' | 'timeout' | 'skipped' | 'fail_closed'
  severity: 'info' | 'warn' | 'error' | 'critical'
  latency_ms: number            // how long the layer took
  error_message: string|null    // populated on status=error/fail_closed
  tokens_used: number|null      // AI layers only
  cost_usd: number|null         // AI layers only

  // ── Counterfactual fields (for shadow mode) ──
  would_have_action: string|null    // what this layer/system would have done
  actual_action: string|null        // what actually happened (matches if production, may differ if shadow)
  market_snapshot_id: string|null   // Kalshi quote at decision time
  state_snapshot_id: string|null    // game state (Ks, IP, pitches) at decision time
}
```

**Validation:** Every event is validated by Zod schema on entry. Invalid events throw — they DO NOT silently fail.

---

## 3. Outputs

Trace produces three downstream artifacts:

### 3a. Per-bet decision document (one per `decision_id`)

```typescript
interface BetDecisionTrace {
  decision_id: string
  pitcher_id: string
  game_pk: string
  bet_date: string
  strike: number
  side: 'YES' | 'NO'

  systems: {
    oracle:   SystemTrace
    current:  SystemTrace
    old?:     SystemTrace      // optional legacy replay
  }

  outcome?: BetOutcome           // filled by settlement job
  created_at: string
  finalized_at: string|null
}

interface SystemTrace {
  events: TraceEvent[]
  final_decision: string
  final_size_usd: number
  would_have_executed: boolean   // for shadow systems: counterfactual
  executed: boolean              // only one system actually executes
  execution_record?: ExecutionRecord
}

interface BetOutcome {
  result: 'win' | 'loss' | 'void'
  pnl_usd: number
  settled_at: string
}
```

### 3b. Standard queries

Pre-built views for common questions:

- **Disagreements:** `SELECT * FROM oracle_disagreements_view WHERE bet_date = ?` — bets where Oracle and current system reached different verdicts
- **Counterfactual P&L:** `SELECT pnl_oracle, pnl_current, pnl_delta FROM oracle_counterfactual_view WHERE bet_date BETWEEN ? AND ?`
- **Layer attribution:** which layer caused which disagreements

### 3c. Probe ledger

Separate small table for the 1-3% of skipped bets fired at $1 minimum to validate fill assumptions only.

---

## 4. Failure modes

**Distinct behavior in shadow vs enforced mode:**

| Failure | Shadow mode (v1) | Enforced mode (post-Gateway-cutover) |
|---|---|---|
| DB write times out | Retry once. If still fails, queue locally + alert. **Pre-game continues unaffected.** | Retry once. If still fails for Gateway events, **fail closed (reject order).** Non-Gateway events queue locally + alert. |
| DB unavailable (read or write) | Disable Oracle's shadow logging entirely. Pre-game continues unaffected. | **All Gateway-mediated orders fail closed.** No new orders fire. |
| Schema validation rejects event | Throw. Caller layer handles + alerts. Bug in caller. | Same. |
| Disk queue fills (during DB outage) | Alert; oldest events purged FIFO; do NOT silently drop | Same; Gateway also fails closed. |
| Settlement job lags | Outcomes filled late; document the lag. Acceptable up to 24h. | Same. |
| Trace event for Gateway decision lost | Alert (CRITICAL). Investigate. | **Hard alert + auto-halt new orders.** Lost Gateway audit = lost trail = potential bypass. |

**Critical principle:** Trace's failure mode changes based on the system mode it's recording. In shadow, Trace failure is annoying. Once Gateway is enforcing decisions, Trace failure is **safety-critical** because lost audit = lost authorization trail.

**Hard rule:** Trace cannot use `.catch(() => null)`. Every error path either succeeds via retry, queues for later, or alerts. Silent loss of trace data is treated as data corruption.

---

## 5. Test fixtures

### Synthetic primary

```typescript
// F1: Single layer event roundtrip
const ev = makeTraceEvent({ layer_name: 'math', decision: 'fire', strike: 6, side: 'YES' })
await trace.write(ev)
const retrieved = await trace.read({ decision_id: ev.decision_id })
expect(retrieved.systems.oracle.events).toContainEqual(expect.objectContaining({ id: ev.id }))

// F2: Two systems disagree on the same bet
await trace.write({ ...baseEv, system: 'oracle', decision: 'skip' })
await trace.write({ ...baseEv, system: 'current', decision: 'fire' })
const disagreements = await trace.disagreements({ bet_date: '2026-04-30' })
expect(disagreements).toHaveLength(1)

// F3: Outcome backfill
await trace.write({ decision_id: id, ... })
await trace.recordOutcome({ decision_id: id, result: 'loss', pnl_usd: -22.50 })
const t = await trace.read({ decision_id: id })
expect(t.outcome.pnl_usd).toBe(-22.50)

// F4: Schema validation rejects invalid event
expect(() => trace.write({ decision: 'fire' /* missing required fields */ }))
  .toThrow(/schema/i)

// F5: Replay integrity — input_hash detects underlying row change
await trace.write({ ...ev, evidence_used: [{ name: 'x', id: 'y', input_hash: 'abc' }] })
// Source row changes; replay catches mismatch
const replayResult = await trace.replayValidate(ev.decision_id)
expect(replayResult.integrity).toBe('mismatch')
expect(replayResult.changed_evidence).toContain('x')

// F6: Async write doesn't block decision loop
const start = Date.now()
trace.writeAsync(ev)  // fire-and-forget
const elapsed = Date.now() - start
expect(elapsed).toBeLessThan(5)  // should return immediately

// F7: Sync write (Gateway pattern) returns only after confirmed
await trace.writeSync(ev)
const back = await trace.read({ id: ev.id })
expect(back).toBeTruthy()  // immediately readable

// F8: DB write retry on transient failure
mockDb.failOnce()
await trace.writeSync(ev)
expect(mockDb.callCount).toBe(2)  // first failed, retry succeeded
```

### Real-history regression

After Trace is built, replay all bets from 2026-04-26 (a winning day) and verify:
- Every bet generates a complete decision document
- Every layer for the current system contributes events
- Final outcomes match `ks_bets.result` + `ks_bets.pnl`
- No silent drops between expected vs recorded event count

---

## 5b. ORACLE-HEALTH alert channel (locked)

Dedicated Discord webhook for Oracle operational health. **Adam-only.** This is NOT the same channel as bet notifications, EOD reports, or general baseball noise.

**What sends to ORACLE-HEALTH:**

| Trigger | Severity |
|---|---|
| Trace write failure (sync or async, after retry) | CRITICAL |
| Trace queue backlog (>500 events OR oldest >60s) | CRITICAL |
| Gateway rejection due to DB outage / kill switch / version mismatch | WARN (info) |
| Stale Closer / agent version detected | CRITICAL |
| Oracle enabled or disabled (`oracle_disabled` flag toggled) | INFO |
| DB outage detected | CRITICAL |
| DB recovery confirmed | INFO |
| Replay-integrity mismatch (input_hash drift >1%) | WARN |
| Health probe failed 2+ consecutive times | CRITICAL |
| Settlement lag >24h on >5 bets | WARN |

**Webhook URL:** TBD — Adam to provide a dedicated webhook URL. Until provided, alerts go to existing webhook with `[ORACLE-HEALTH]` prefix as fallback.

**Dedup:** Repeating alerts dedup on `(trigger, hour)` — same alert won't fire more than once per hour per trigger type.

---

## 6. Health probe

Synthetic write+read roundtrip every 60 seconds:

```javascript
async function traceHealthProbe() {
  const probeId = `probe-${Date.now()}`
  const startTs = Date.now()

  await trace.writeSync(makeTraceEvent({
    decision_id: probeId,
    layer_name: 'system',
    event_type: 'health_check',
    pitcher_name: 'PROBE',
    pitcher_id: '0',
    strike: 0, side: 'YES',
    decision: 'pass',
    system: 'oracle',
    mode: 'shadow',
  }))

  const back = await trace.read({ decision_id: probeId })
  if (!back || back.systems.oracle.events.length === 0) {
    return { healthy: false, reason: 'roundtrip_failed' }
  }

  await trace.delete({ decision_id: probeId })
  return { healthy: true, latency_ms: Date.now() - startTs }
}
```

Runs every 60s in healthSentinel. **2 consecutive failures → Discord alert (CRITICAL) to Adam-only webhook.**

---

## 7. Performance budget

**Async writes (default for Math, Path, Trust, Critic, Judge):**

| Operation | p50 | p95 | p99 | Hard ceiling |
|---|---|---|---|---|
| In-memory enqueue | <1 ms | <2 ms | <5 ms | 10 ms |
| Queue → DB flush (batch) | 50 ms | 200 ms | 500 ms | 2000 ms |

**Sync writes (Gateway only):**

| Operation | p50 | p95 | p99 | Hard ceiling |
|---|---|---|---|---|
| Single Gateway audit event | 20 ms | 100 ms | 250 ms | 500 ms |

**Architectural pattern:**

```
Math/Path/Trust/Critic/Judge:
  layer.run(ctx)
    → emit event to in-memory queue (<1ms, non-blocking)
    → return decision to caller
  Background: queue flushes to DB every 100ms or when 10 events queued

Gateway:
  gateway.validate(intent)
    → SYNC write audit event (must complete before Kalshi call)
    → if write fails in enforced mode: fail closed
    → return decision

Health probe:
  Tests sync path (writeSync + read) — guarantees DB write capability
```

**Budgets that trigger alerts if exceeded:**
- Any sync write >500ms (Gateway hot path)
- Any async batch flush >2000ms (queue is backing up)
- Storage cost >$5/month (initially expecting <$1)

**Queue backlog alert (locked):**
```
if traceQueue.length > 500
   OR oldestUnflushedEventAge > 60 seconds
→ send ORACLE-HEALTH alert (CRITICAL)
```

Two scenarios that both trigger backlog: rapid burst of decisions (queue length spike) or stuck flusher (oldest-age spike). Both are recoverable conditions but signal Trace is degraded — possibly losing data if it gets worse.

---

## 8. Kill switch

Trace **cannot be killed.** It is foundational; disabling it means we lose visibility.

If Trace itself is broken, Oracle as a whole is disabled (`oracle_disabled=1` in `system_flags`). Trace continues attempting writes — it must record the disable event itself.

**Asymmetric design (locked):**
- Trace tries to write even when Oracle is disabled
- Oracle decisions can be disabled
- Gateway trading can be halted (separate flag)

**Emergency stop:**
```sql
UPDATE system_flags SET value = '1', updated_at = ?, updated_by = 'manual'
  WHERE key = 'oracle_disabled';
```

When `oracle_disabled = 1`:
- Oracle layers don't run
- No shadow events written
- Current system runs unaffected

This is not a layer kill switch — it's a system-level emergency stop.

---

## 9. Drift detector

**a. Event volume drift**
- Baseline: avg events per bet (across all systems) on a clean day
- Alert if today's avg <70% of baseline (drops?) or >150% (duplicates?)

**b. Schema drift**
- Baseline: distinct values for `decision` field per layer
- Alert if a new value appears that's not in the layer's spec
- Alert if a known value hasn't been seen in 7 days (layer broken?)

**c. Replay-integrity drift**
- Track `input_hash` mismatch rate during replay validation
- Baseline: <0.1% mismatch (data is stable)
- Alert if mismatch rate >1% (something is mutating evidence sources)

All three run as nightly cron, output to Discord on anomaly.

---

## 10. Success metric / SLO

**Primary:** 100% of bet evaluations produce a complete decision document (all expected layer events present, all required fields, outcome backfilled within 7 days).

**Secondary SLOs:**
- 99.9% async write enqueue success (p50; first attempt or retry)
- 99.99% sync write success for Gateway events
- <1 min lag from event generation to queryability
- 0 silent drops (any drop = alert)
- <0.1% replay-integrity mismatches

**Measurement:**
- Daily cron compares `bet_evaluations_started` (incremented at decision_id creation) vs `bet_evaluations_completed` (all expected layers present, outcome populated)
- Discrepancy > 0 = alert
- Weekly report includes: SLO attainment per metric, drift alerts fired, integrity mismatch incidents

---

## 11. Rollback plan

Trace is append-only. Schema changes are additive (new fields, never removed).

| Scenario | Rollback action |
|---|---|
| New schema field breaks downstream query | Make field nullable; fix query; redeploy |
| New decision/reason_code value confuses calibration | Add to layer spec; calibration adapts. No DB migration. |
| Trace's own code has a bug | Revert to previous git commit; redeploy. Past data preserved. |
| Disastrous data corruption | Tables append-only with timestamps. Drop affected date range; re-replay from primary sources (`ks_bets`, `bet_schedule`). |
| Gateway audit events lost (enforced mode) | Halt orders immediately. Investigate. Replay possible only if request_ids preserved. |

**Backward compatibility rule:** All Trace schema changes preserve ability to replay events under old schema. `trace_schema_version` field on every event tracks which schema produced it.

---

## 12. Dependencies

**Reads from:**
- Turso DB (own tables only)
- Settlement job (for outcome backfill, runs separately)

**Writes to:**
- Turso tables: `oracle_trace_events`, `oracle_bet_traces`, `oracle_probe_ledger`, `oracle_settlement_lag`
- Local disk queue (only when DB unavailable, as fallback)

**Required env / DB state:**
- Turso credentials (TURSO_DATABASE_URL, TURSO_AUTH_TOKEN)
- DB schema migrations applied
- `system_flags` table accessible (for `oracle_disabled` read)

**Other layers depend on Trace:**
- ALL of them. Math, Path, Trust, Critic, Judge, Gateway emit events. Without Trace, they can run but their decisions are unauditable.

---

## 13. Concrete schema (SQL DDL)

```sql
-- ── Main events table ───────────────────────────────────────────────
CREATE TABLE oracle_trace_events (
  id                    TEXT PRIMARY KEY,
  decision_id           TEXT NOT NULL,
  parent_event_id       TEXT,
  trace_schema_version  TEXT NOT NULL,
  created_at            TEXT NOT NULL,

  layer_name            TEXT NOT NULL,
  layer_version         TEXT NOT NULL,
  commit_hash           TEXT NOT NULL,
  agent_id              TEXT NOT NULL,
  agent_version         TEXT NOT NULL,
  server_version        TEXT,
  environment           TEXT NOT NULL DEFAULT 'production',
  run_id                TEXT,
  request_id            TEXT,

  mode                  TEXT NOT NULL,    -- 'production' | 'shadow'
  system                TEXT NOT NULL,    -- 'oracle' | 'current' | 'old'
  event_type            TEXT NOT NULL,    -- 'decision' | 'health_check' | etc.
  user_id               INTEGER,
  bet_id                TEXT,

  game_pk               TEXT,
  pitcher_id            TEXT,
  pitcher_name          TEXT,
  market_ticker         TEXT,
  bet_date              TEXT,
  strike                INTEGER,
  side                  TEXT,             -- 'YES' | 'NO'

  decision              TEXT NOT NULL,
  reason_code           TEXT NOT NULL,
  reasoning             TEXT NOT NULL,    -- JSON
  metrics               TEXT NOT NULL,    -- JSON

  evidence_used         TEXT NOT NULL,    -- JSON array
  input_hash            TEXT NOT NULL,
  output_hash           TEXT NOT NULL,

  status                TEXT NOT NULL,
  severity              TEXT NOT NULL,
  latency_ms            INTEGER NOT NULL,
  error_message         TEXT,
  tokens_used           INTEGER,
  cost_usd              REAL,

  would_have_action     TEXT,
  actual_action         TEXT,
  market_snapshot_id    TEXT,
  state_snapshot_id     TEXT
);

CREATE INDEX idx_ote_decision_id   ON oracle_trace_events(decision_id);
CREATE INDEX idx_ote_bet_id        ON oracle_trace_events(bet_id);
CREATE INDEX idx_ote_layer         ON oracle_trace_events(layer_name);
CREATE INDEX idx_ote_event_type    ON oracle_trace_events(event_type);
CREATE INDEX idx_ote_created_at    ON oracle_trace_events(created_at);
CREATE INDEX idx_ote_bet_date      ON oracle_trace_events(bet_date);
CREATE INDEX idx_ote_system_mode   ON oracle_trace_events(system, mode);

-- ── Bet decision summary ───────────────────────────────────────────
CREATE TABLE oracle_bet_traces (
  decision_id           TEXT NOT NULL,
  system                TEXT NOT NULL,    -- 'oracle' | 'current' | 'old'
  pitcher_id            TEXT NOT NULL,
  game_pk               TEXT,
  market_ticker         TEXT,
  bet_date              TEXT NOT NULL,
  strike                INTEGER NOT NULL,
  side                  TEXT NOT NULL,

  final_decision        TEXT NOT NULL,
  final_size_usd        REAL,
  would_have_executed   INTEGER NOT NULL DEFAULT 0,
  executed              INTEGER NOT NULL DEFAULT 0,
  bet_id                TEXT,

  outcome_result        TEXT,             -- 'win' | 'loss' | 'void'
  outcome_pnl_usd       REAL,
  outcome_settled_at    TEXT,

  created_at            TEXT NOT NULL,
  finalized_at          TEXT,

  PRIMARY KEY (decision_id, system)
);

CREATE INDEX idx_obt_bet_date       ON oracle_bet_traces(bet_date);
CREATE INDEX idx_obt_pitcher        ON oracle_bet_traces(pitcher_id);
CREATE INDEX idx_obt_game           ON oracle_bet_traces(game_pk);
CREATE INDEX idx_obt_ticker         ON oracle_bet_traces(market_ticker);
CREATE INDEX idx_obt_decision       ON oracle_bet_traces(final_decision);
CREATE INDEX idx_obt_outcome        ON oracle_bet_traces(outcome_result);

-- ── Probe ledger (1-3% of skipped bets fired at $1) ────────────────
CREATE TABLE oracle_probe_ledger (
  id                    TEXT PRIMARY KEY,
  decision_id           TEXT NOT NULL,
  probe_type            TEXT NOT NULL,    -- 'fill_validation' | etc.
  reason_code           TEXT NOT NULL,    -- why this skipped bet was probed
  bet_id                TEXT,
  probe_amount_usd      REAL NOT NULL,
  probe_fill_price      INTEGER,
  probe_filled          INTEGER,
  market_snapshot_id    TEXT,
  outcome_result        TEXT,
  outcome_pnl_usd       REAL,
  settled              INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL,
  settled_at            TEXT
);

CREATE INDEX idx_opl_created_at     ON oracle_probe_ledger(created_at);
CREATE INDEX idx_opl_decision       ON oracle_probe_ledger(decision_id);
CREATE INDEX idx_opl_probe_type     ON oracle_probe_ledger(probe_type);
CREATE INDEX idx_opl_settled        ON oracle_probe_ledger(settled);

-- ── Settlement lag tracking ────────────────────────────────────────
CREATE TABLE oracle_settlement_lag (
  id                    TEXT PRIMARY KEY,
  decision_id           TEXT NOT NULL,
  bet_id                TEXT,
  market_ticker         TEXT NOT NULL,
  game_pk               TEXT,
  detected_final_at     TEXT NOT NULL,
  kalshi_settled_at     TEXT,
  lag_seconds           INTEGER,
  created_at            TEXT NOT NULL
);

CREATE INDEX idx_osl_market         ON oracle_settlement_lag(market_ticker);
CREATE INDEX idx_osl_game           ON oracle_settlement_lag(game_pk);
CREATE INDEX idx_osl_detected       ON oracle_settlement_lag(detected_final_at);
```

**No partitioning yet.** Re-evaluate if `oracle_trace_events` grows past ~10M rows or query latency degrades.

---

## 14. Retention policy

| Data | Retention | Rationale |
|---|---|---|
| `oracle_trace_events` (decision events) | Forever | Small rows, append-only, irreplaceable |
| `oracle_bet_traces` | Forever | Decision summary, irreplaceable |
| `oracle_probe_ledger` (detailed) | 90 days | Useful only for short-window fill validation |
| `oracle_probe_ledger` (aggregates) | Forever | Roll up to monthly summary table after 90 days |
| `oracle_settlement_lag` | Forever | Operational metric, small |
| Raw AI prompts/responses | 90 days | Stored separately; structured critic result kept forever |
| AI prompt hashes | Forever | Allows "did Sonnet say this same thing before?" lookups |

---

## 15. Implementation plan (after spec is locked)

1. **Schema migrations** — create the 4 tables + indices
2. **Library module** — `oracle/layers/0-trace/impl.ts` exposing:
   - `writeAsync(event)` — non-blocking enqueue
   - `writeSync(event)` — Gateway path; awaits DB confirmation
   - `read({decision_id})` — fetch per-bet trace
   - `recordOutcome({decision_id, ...})` — settlement backfill
   - `disagreements({date})`, `counterfactual({range})` — pre-built queries
   - `replayValidate({decision_id})` — input_hash integrity check
3. **Async queue worker** — flushes in-memory queue to DB
4. **Health probe** — wired into healthSentinel
5. **Test fixtures** — synthetic suite passing
6. **Discord alert webhook** — Adam-only channel for Trace failures

Estimated time: 2-3 days after spec lock.

---

## Open questions resolved (2026-04-30 review)

| # | Question | Resolution |
|---|---|---|
| Q1 | DB location | ✅ Same Turso DB for v1; separate only if measurable problem |
| Q2 | `evidence_used` granularity | ✅ Names + IDs + input_hashes |
| Q3 | Retention | ✅ Forever for decisions/outcomes, 90d detailed for probes (then aggregate forever), raw AI 90d (hashes forever) |
| Q4 | Version Trace? | ✅ Yes — `trace_schema_version` + `layer_version` + `commit_hash` all required |
| Q5 | Tables | ✅ Four tables, no partitioning, indexes from day one |

---

## Sign-off (2026-04-30)

| # | Item | Status |
|---|---|---|
| 1 | Discord webhook URL | ⚠️ Pending — Adam to provide dedicated `ORACLE-HEALTH` webhook. Fallback: `[ORACLE-HEALTH]` prefix on existing webhook |
| 2 | Failure-mode asymmetry (shadow vs enforced) | ✅ Confirmed |
| 3 | Async/sync split (non-Gateway async, Gateway sync) | ✅ Confirmed |
| 4 | Queue backlog alert thresholds (500 events / 60s) | ✅ Confirmed |
| 5 | ORACLE-HEALTH alert trigger list | ✅ Confirmed |

**Spec locked v1.0.** Implementation may begin. Updates to this spec require explicit re-locking with version bump.

---

*Spec locked 2026-04-30. Implementation tracked separately.*
