// oracle/layers/0-trace/impl.js
//
// The Oracle — Layer 0: Trace
// Public API for emitting and querying trace events.
//
// Design contract (from spec.md, locked v1.0):
// - writeAsync: non-blocking enqueue (Math/Path/Trust/Critic/Judge use this)
// - writeSync:  awaits DB confirmation (Gateway uses this)
// - read:       fetch a per-bet decision document by decision_id
// - recordOutcome: settlement backfill
// - disagreements / counterfactual: pre-built queries
// - replayValidate: input_hash integrity check

import * as crypto from 'node:crypto'
import * as db from '../../../lib/db.js'
import { validateTraceEvent, TRACE_SCHEMA_VERSION } from './validate.js'

// Module-level state
const _queue = []                  // in-memory async event queue
let _flushInProgress = false       // mutex for flush
const _MAX_QUEUE_SIZE = 5000       // safety ceiling; events dropped above this with alert
const _BATCH_SIZE = 50             // flush this many at a time
const _FLUSH_INTERVAL_MS = 100     // background flush cadence
let _flushTimer = null
let _shuttingDown = false

// Hooks that other modules (alerts.js, queue.js) can wire in
let _onCriticalFailure = null      // (event, error) => void

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

/**
 * Compute sha256 hex of a JSON-serializable value.
 * Used for input_hash, output_hash, evidence input_hashes.
 */
export function sha256(value) {
  const json = typeof value === 'string' ? value : JSON.stringify(value, sortKeys)
  return crypto.createHash('sha256').update(json).digest('hex')
}

// Stable JSON.stringify replacer that sorts object keys for deterministic hashing.
function sortKeys(_, v) {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    return Object.keys(v).sort().reduce((acc, k) => { acc[k] = v[k]; return acc }, {})
  }
  return v
}

/**
 * Build a base TraceEvent with sensible defaults.
 * Caller fills in the layer-specific fields.
 */
export function makeEvent(partial) {
  const now = new Date().toISOString()
  return {
    id: partial.id ?? crypto.randomUUID(),
    decision_id: partial.decision_id,
    parent_event_id: partial.parent_event_id ?? null,
    trace_schema_version: TRACE_SCHEMA_VERSION,
    created_at: now,

    layer_name: partial.layer_name,
    layer_version: partial.layer_version ?? '1.0.0',
    commit_hash: partial.commit_hash ?? process.env.COMMIT_HASH ?? 'unknown',
    agent_id: partial.agent_id ?? process.env.AGENT_ID ?? 'railway',
    agent_version: partial.agent_version ?? process.env.AGENT_VERSION ?? 'unknown',
    server_version: partial.server_version ?? null,
    environment: partial.environment ?? process.env.NODE_ENV ?? 'production',
    run_id: partial.run_id ?? null,
    request_id: partial.request_id ?? null,

    mode: partial.mode ?? 'shadow',
    system: partial.system ?? 'oracle',
    event_type: partial.event_type ?? 'decision',
    user_id: partial.user_id ?? null,
    bet_id: partial.bet_id ?? null,

    game_pk: partial.game_pk ?? null,
    pitcher_id: partial.pitcher_id ?? null,
    pitcher_name: partial.pitcher_name ?? null,
    market_ticker: partial.market_ticker ?? null,
    bet_date: partial.bet_date ?? null,
    strike: partial.strike ?? null,
    side: partial.side ?? null,

    decision: partial.decision,
    reason_code: partial.reason_code ?? 'unspecified',
    reasoning: partial.reasoning ?? {},
    metrics: partial.metrics ?? {},
    evidence_used: partial.evidence_used ?? [],
    input_hash: partial.input_hash ?? sha256({ inputs: partial.inputs ?? null }),
    output_hash: partial.output_hash ?? sha256({
      decision: partial.decision,
      reasoning: partial.reasoning ?? {},
      metrics: partial.metrics ?? {},
    }),

    status: partial.status ?? 'success',
    severity: partial.severity ?? 'info',
    latency_ms: partial.latency_ms ?? 0,
    error_message: partial.error_message ?? null,
    tokens_used: partial.tokens_used ?? null,
    cost_usd: partial.cost_usd ?? null,

    would_have_action: partial.would_have_action ?? null,
    actual_action: partial.actual_action ?? null,
    market_snapshot_id: partial.market_snapshot_id ?? null,
    state_snapshot_id: partial.state_snapshot_id ?? null,
  }
}

// ────────────────────────────────────────────────────────────────────
// SYNC write — Gateway uses this; awaits DB confirmation.
// On failure, retries once. If still fails, throws.
// ────────────────────────────────────────────────────────────────────

export async function writeSync(event) {
  validateTraceEvent(event)
  return await _persistOne(event, { retryOnce: true })
}

// ────────────────────────────────────────────────────────────────────
// ASYNC write — Math/Path/Trust/Critic/Judge use this.
// Enqueues to in-memory queue and returns immediately.
// Background flusher writes to DB in batches.
// ────────────────────────────────────────────────────────────────────

export function writeAsync(event) {
  // Validate synchronously so caller knows immediately if they have a bug.
  validateTraceEvent(event)

  if (_queue.length >= _MAX_QUEUE_SIZE) {
    // Queue is full — DB is severely degraded. Drop oldest, alert.
    const dropped = _queue.shift()
    _emitCritical('queue_overflow_drop', dropped, new Error('queue at MAX_QUEUE_SIZE; oldest dropped'))
  }

  _queue.push(event)
  return event.id  // for the caller's reference
}

// ────────────────────────────────────────────────────────────────────
// READ — fetch the per-bet decision document by decision_id.
// ────────────────────────────────────────────────────────────────────

export async function read({ decision_id }) {
  if (!decision_id) throw new Error('read() requires decision_id')

  const events = await db.all(
    `SELECT * FROM oracle_trace_events
     WHERE decision_id = ?
     ORDER BY created_at ASC, id ASC`,
    [decision_id],
  )
  if (!events.length) return null

  const traces = await db.all(
    `SELECT * FROM oracle_bet_traces WHERE decision_id = ?`,
    [decision_id],
  )

  // Group events by system, hydrate JSON columns
  const systems = {}
  for (const trace of traces) {
    const sys = trace.system
    systems[sys] = {
      events: [],
      final_decision: trace.final_decision,
      final_size_usd: trace.final_size_usd,
      would_have_executed: !!trace.would_have_executed,
      executed: !!trace.executed,
      bet_id: trace.bet_id,
    }
  }
  for (const ev of events) {
    const hydrated = _hydrateEventRow(ev)
    if (!systems[ev.system]) {
      systems[ev.system] = { events: [], final_decision: null }
    }
    systems[ev.system].events.push(hydrated)
  }

  // Outcome (any system row will have it; outcome is per-bet)
  const outcomeRow = traces.find(t => t.outcome_result)
  const outcome = outcomeRow ? {
    result: outcomeRow.outcome_result,
    pnl_usd: outcomeRow.outcome_pnl_usd,
    settled_at: outcomeRow.outcome_settled_at,
  } : undefined

  return {
    decision_id,
    pitcher_id: events[0].pitcher_id,
    game_pk: events[0].game_pk,
    bet_date: events[0].bet_date,
    strike: events[0].strike,
    side: events[0].side,
    systems,
    outcome,
    created_at: events[0].created_at,
  }
}

// ────────────────────────────────────────────────────────────────────
// recordOutcome — settlement backfill. Updates oracle_bet_traces.
// ────────────────────────────────────────────────────────────────────

export async function recordOutcome({ decision_id, system, result, pnl_usd, settled_at }) {
  if (!decision_id || !system || !result) {
    throw new Error('recordOutcome requires decision_id, system, result')
  }
  await db.run(
    `UPDATE oracle_bet_traces
     SET outcome_result = ?, outcome_pnl_usd = ?, outcome_settled_at = ?, finalized_at = ?
     WHERE decision_id = ? AND system = ?`,
    [result, pnl_usd ?? null, settled_at ?? new Date().toISOString(),
     new Date().toISOString(), decision_id, system],
  )
}

// ────────────────────────────────────────────────────────────────────
// upsertBetTrace — write/update the bet-level summary row.
// Called by layers when they finalize a system's decision (typically Judge).
// ────────────────────────────────────────────────────────────────────

export async function upsertBetTrace(row) {
  const required = ['decision_id', 'system', 'pitcher_id', 'bet_date', 'strike', 'side', 'final_decision']
  for (const f of required) {
    if (row[f] === undefined || row[f] === null) {
      throw new Error(`upsertBetTrace: missing required field '${f}'`)
    }
  }
  const now = new Date().toISOString()
  await db.run(
    `INSERT INTO oracle_bet_traces (
       decision_id, system, pitcher_id, game_pk, market_ticker,
       bet_date, strike, side, final_decision, final_size_usd,
       would_have_executed, executed, bet_id,
       created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(decision_id, system) DO UPDATE SET
       final_decision = excluded.final_decision,
       final_size_usd = excluded.final_size_usd,
       would_have_executed = excluded.would_have_executed,
       executed = excluded.executed,
       bet_id = COALESCE(excluded.bet_id, bet_id)`,
    [row.decision_id, row.system, row.pitcher_id, row.game_pk ?? null,
     row.market_ticker ?? null, row.bet_date, row.strike, row.side,
     row.final_decision, row.final_size_usd ?? null,
     row.would_have_executed ? 1 : 0, row.executed ? 1 : 0, row.bet_id ?? null,
     now],
  )
}

// ────────────────────────────────────────────────────────────────────
// disagreements — bets where Oracle and current system reached different verdicts
// ────────────────────────────────────────────────────────────────────

export async function disagreements({ bet_date }) {
  if (!bet_date) throw new Error('disagreements requires bet_date')
  const rows = await db.all(`
    SELECT
      o.decision_id, o.pitcher_id, o.bet_date, o.strike, o.side,
      o.final_decision AS oracle_decision,
      c.final_decision AS current_decision,
      o.outcome_result, o.outcome_pnl_usd, c.outcome_pnl_usd AS current_pnl_usd
    FROM oracle_bet_traces o
    LEFT JOIN oracle_bet_traces c
      ON c.decision_id = o.decision_id AND c.system = 'current'
    WHERE o.system = 'oracle'
      AND o.bet_date = ?
      AND (c.final_decision IS NULL OR c.final_decision != o.final_decision)
  `, [bet_date])
  return rows
}

// ────────────────────────────────────────────────────────────────────
// counterfactual P&L — what would Oracle's decisions have produced?
// ────────────────────────────────────────────────────────────────────

export async function counterfactual({ start_date, end_date }) {
  if (!start_date || !end_date) {
    throw new Error('counterfactual requires start_date and end_date')
  }
  const rows = await db.all(`
    SELECT
      bet_date,
      SUM(CASE WHEN system = 'oracle'  THEN outcome_pnl_usd ELSE 0 END) AS oracle_pnl,
      SUM(CASE WHEN system = 'current' THEN outcome_pnl_usd ELSE 0 END) AS current_pnl,
      SUM(CASE WHEN system = 'oracle' AND would_have_executed = 1 AND outcome_pnl_usd IS NOT NULL
                THEN outcome_pnl_usd ELSE 0 END) AS oracle_would_have_pnl
    FROM oracle_bet_traces
    WHERE bet_date BETWEEN ? AND ?
    GROUP BY bet_date
    ORDER BY bet_date
  `, [start_date, end_date])
  return rows
}

// ────────────────────────────────────────────────────────────────────
// replayValidate — input_hash integrity check
// ────────────────────────────────────────────────────────────────────

export async function replayValidate({ decision_id, recompute }) {
  // recompute: function ({name, id}) => Promise<currentValue>
  // It looks up the current value of the named source row and returns it.
  // We compare its hash to the stored input_hash.
  const events = await db.all(
    `SELECT id, layer_name, evidence_used FROM oracle_trace_events
     WHERE decision_id = ? ORDER BY created_at ASC`,
    [decision_id],
  )
  const mismatches = []
  for (const ev of events) {
    let evidence
    try { evidence = JSON.parse(ev.evidence_used) } catch { continue }
    if (!Array.isArray(evidence)) continue
    for (const e of evidence) {
      if (!e?.name || !e?.id || !e?.input_hash) continue
      const current = await recompute(e).catch(() => null)
      if (current === null) continue
      const currentHash = sha256(current)
      if (currentHash !== e.input_hash) {
        mismatches.push({
          event_id: ev.id,
          layer: ev.layer_name,
          evidence_name: e.name,
          evidence_id: e.id,
          stored_hash: e.input_hash,
          current_hash: currentHash,
        })
      }
    }
  }
  return {
    integrity: mismatches.length === 0 ? 'match' : 'mismatch',
    changed_evidence: mismatches.map(m => m.evidence_name),
    mismatches,
  }
}

// ────────────────────────────────────────────────────────────────────
// Internal: persist one event to DB
// ────────────────────────────────────────────────────────────────────

async function _persistOne(ev, opts = {}) {
  try {
    await db.run(_INSERT_EVENT_SQL, _eventToParams(ev))
    return ev.id
  } catch (err) {
    if (opts.retryOnce) {
      // brief backoff
      await new Promise(r => setTimeout(r, 100))
      try {
        await db.run(_INSERT_EVENT_SQL, _eventToParams(ev))
        return ev.id
      } catch (err2) {
        _emitCritical('write_failed_after_retry', ev, err2)
        throw err2
      }
    }
    _emitCritical('write_failed', ev, err)
    throw err
  }
}

async function _persistBatch(events) {
  if (!events.length) return { ok: 0, failed: 0 }
  // Per-event insert is the simplest. libSQL can do batch but our row counts are low.
  let ok = 0, failed = 0
  for (const ev of events) {
    try {
      await db.run(_INSERT_EVENT_SQL, _eventToParams(ev))
      ok++
    } catch (err) {
      failed++
      _emitCritical('async_write_failed', ev, err)
    }
  }
  return { ok, failed }
}

const _INSERT_EVENT_SQL = `
  INSERT OR REPLACE INTO oracle_trace_events (
    id, decision_id, parent_event_id, trace_schema_version, created_at,
    layer_name, layer_version, commit_hash, agent_id, agent_version,
    server_version, environment, run_id, request_id,
    mode, system, event_type, user_id, bet_id,
    game_pk, pitcher_id, pitcher_name, market_ticker, bet_date, strike, side,
    decision, reason_code, reasoning, metrics,
    evidence_used, input_hash, output_hash,
    status, severity, latency_ms, error_message, tokens_used, cost_usd,
    would_have_action, actual_action, market_snapshot_id, state_snapshot_id
  ) VALUES (
    ?, ?, ?, ?, ?,
    ?, ?, ?, ?, ?,
    ?, ?, ?, ?,
    ?, ?, ?, ?, ?,
    ?, ?, ?, ?, ?, ?, ?,
    ?, ?, ?, ?,
    ?, ?, ?,
    ?, ?, ?, ?, ?, ?,
    ?, ?, ?, ?
  )`

function _eventToParams(ev) {
  return [
    ev.id, ev.decision_id, ev.parent_event_id, ev.trace_schema_version, ev.created_at,
    ev.layer_name, ev.layer_version, ev.commit_hash, ev.agent_id, ev.agent_version,
    ev.server_version, ev.environment, ev.run_id, ev.request_id,
    ev.mode, ev.system, ev.event_type, ev.user_id, ev.bet_id,
    ev.game_pk, ev.pitcher_id, ev.pitcher_name, ev.market_ticker, ev.bet_date, ev.strike, ev.side,
    ev.decision, ev.reason_code, JSON.stringify(ev.reasoning), JSON.stringify(ev.metrics),
    JSON.stringify(ev.evidence_used), ev.input_hash, ev.output_hash,
    ev.status, ev.severity, ev.latency_ms, ev.error_message, ev.tokens_used, ev.cost_usd,
    ev.would_have_action, ev.actual_action, ev.market_snapshot_id, ev.state_snapshot_id,
  ]
}

function _hydrateEventRow(row) {
  return {
    ...row,
    reasoning: _safeParseJson(row.reasoning, {}),
    metrics: _safeParseJson(row.metrics, {}),
    evidence_used: _safeParseJson(row.evidence_used, []),
  }
}

function _safeParseJson(val, fallback) {
  try { return JSON.parse(val) } catch { return fallback }
}

// ────────────────────────────────────────────────────────────────────
// Background async flusher
// ────────────────────────────────────────────────────────────────────

export function startAsyncFlusher() {
  if (_flushTimer) return
  _flushTimer = setInterval(_flushOnce, _FLUSH_INTERVAL_MS).unref?.() ?? null
}

export function stopAsyncFlusher() {
  if (_flushTimer) {
    clearInterval(_flushTimer)
    _flushTimer = null
  }
}

export async function flushNow() {
  return await _flushOnce()
}

async function _flushOnce() {
  if (_flushInProgress || _queue.length === 0) return { flushed: 0, failed: 0 }
  _flushInProgress = true
  try {
    const batch = _queue.splice(0, _BATCH_SIZE)
    const result = await _persistBatch(batch)
    return { flushed: result.ok, failed: result.failed }
  } finally {
    _flushInProgress = false
  }
}

export function queueStats() {
  const oldest = _queue[0]
  return {
    length: _queue.length,
    oldest_age_ms: oldest ? (Date.now() - Date.parse(oldest.created_at)) : 0,
  }
}

// Graceful shutdown — flush remaining queue.
export async function shutdown(timeoutMs = 5000) {
  _shuttingDown = true
  stopAsyncFlusher()
  const start = Date.now()
  while (_queue.length > 0 && Date.now() - start < timeoutMs) {
    await _flushOnce()
  }
  if (_queue.length > 0) {
    _emitCritical('shutdown_drained_incomplete', null,
      new Error(`${_queue.length} events undelivered at shutdown`))
  }
}

// ────────────────────────────────────────────────────────────────────
// Hooks
// ────────────────────────────────────────────────────────────────────

export function setCriticalFailureHandler(fn) {
  _onCriticalFailure = fn
}

function _emitCritical(reason, event, error) {
  try {
    if (_onCriticalFailure) {
      _onCriticalFailure({ reason, event, error })
    } else {
      // No handler wired — at minimum console-log so we see it.
      console.error(`[oracle.trace] CRITICAL ${reason}: ${error?.message ?? '(no error)'}`)
    }
  } catch (e) {
    console.error('[oracle.trace] _emitCritical handler itself threw:', e?.message)
  }
}

// ────────────────────────────────────────────────────────────────────
// Schema migration helper — run schema.sql against the configured DB.
// ────────────────────────────────────────────────────────────────────

export async function migrate() {
  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  const url = await import('node:url')
  const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
  const raw = await fs.readFile(path.join(__dirname, 'schema.sql'), 'utf-8')
  // Strip line comments FIRST (per-line), then split on ;.
  // Same pattern as lib/db.js migrate() — handles CRLF, inline comments,
  // and comment-only chunks correctly.
  const stmts = raw
    .replace(/\r/g, '')
    .split('\n')
    .map(line => line.replace(/--.*$/, ''))
    .filter(line => line.trim())
    .join('\n')
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0)

  for (const stmt of stmts) {
    await db.run(stmt)
  }
  return { statements: stmts.length }
}

// Exports
export {
  TRACE_SCHEMA_VERSION,
}
