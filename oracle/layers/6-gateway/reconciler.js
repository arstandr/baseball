// oracle/layers/6-gateway/reconciler.js
//
// Layer 6: Gateway — exchange_unknown reconciliation worker.
// Locked design (Q-RC1..Q-RC8):
//
//   RC1  account list read from DB each cycle (live; admin enable/disable
//        takes effect without restart).
//   RC2  uses the existing Gateway kalshi client; routes per row by account_id.
//   RC3  one run at a time; overlapping ticks skipped.
//   RC4  resolved rows kept indefinitely (audit). Resolution = mark, never delete.
//   RC5  on resolve, updates BOTH gateway_unknowns AND gateway_idempotency.
//        last_status flips from 'exchange_unknown' to the resolved truth.
//   RC6  rollup alerts only:
//          warn:     unresolved_total > 0 with any row > 60s
//          critical: any row > 5min
//          critical: any lookup_auth_error this cycle (immediate)
//   RC7  shadow mode: skip all polling; warn rollup if unresolved rows present.
//   RC8  fixed 15s cron; per-row cadence inside this function decides which
//        rows to actually poll:
//          age ≤ 5min: 15s cadence
//          age >  5min: 60s cadence
//
// Public:
//   runReconciliation(deps)  → one pass; idempotent; safe to call every 15s
//   _resetForTesting()       → clears the in-memory _running flag (test helper)

const PER_ROW_CADENCE_FAST_MS  = 15_000
const PER_ROW_CADENCE_SLOW_MS  = 60_000
const ROW_AGE_BREAKPOINT_MS    = 5 * 60_000   // switch from fast to slow cadence
const ROLLUP_WARN_AGE_MS       = 60_000
const ROLLUP_CRITICAL_AGE_MS   = 5 * 60_000
const SAMPLE_DECISION_IDS      = 5
const MAX_ROWS_PER_CYCLE       = 200
const RESPONSE_PREVIEW_LEN     = 1000

// Module-level concurrency guard — only one reconciler at a time per process.
let _running = false

function parseISOToMs(iso) {
  const t = new Date(iso).getTime()
  return Number.isFinite(t) ? t : NaN
}

// Map Kalshi-resolved status → gateway last_status (idempotency).
function resolvedToLastStatus(resolvedStatus) {
  switch (resolvedStatus) {
    case 'placed':
    case 'partially_filled':
      return 'accepted'
    case 'rejected':
      return 'exchange_error'
    default:
      // Unknown Kalshi status string → conservative: keep as exchange_unknown
      // so retries don't replay a misclassified response.
      return 'exchange_unknown'
  }
}

function safeStr(s, max = RESPONSE_PREVIEW_LEN) {
  if (s == null) return null
  const str = typeof s === 'string' ? s : JSON.stringify(s)
  return str.length > max ? str.slice(0, max) : str
}

function emitAsync(traceAdapter, partial) {
  try {
    const sysT = traceAdapter.forSystem({ agent_id: 'gateway-reconciler', mode: 'production' })
    const ev = sysT.makeEvent({
      decision_id:  partial.decision_id ?? `reconciler-${Date.now()}`,
      pitcher_id:   '0',
      pitcher_name: 'reconciler',
      bet_date:     '',
      strike:       0,
      side:         'YES',
      ...partial,
    })
    traceAdapter.forSystem({}).writeAsync(ev).catch(() => {})
  } catch { /* best-effort */ }
}

/**
 * One reconciliation pass.
 *
 * @param {object} deps
 * @param {object} deps.kalshi          — Gateway kalshi client (lookupByClientOrderId)
 * @param {object} deps.dataPlane       — { unknownsStore, idempotencyStore }
 * @param {object} deps.traceAdapter    — { forSystem() }
 * @param {string} deps.mode            — 'shadow' | 'production'
 * @param {function} [deps.now]         — () → unix ms (default Date.now)
 *
 * @returns {object} per-cycle stats (counts, oldest_age_ms, etc.)
 */
export async function runReconciliation(deps) {
  if (!deps?.kalshi || !deps?.dataPlane?.unknownsStore || !deps?.dataPlane?.idempotencyStore || !deps?.traceAdapter) {
    throw new Error('runReconciliation: missing required deps (kalshi, dataPlane.{unknownsStore,idempotencyStore}, traceAdapter)')
  }
  const now = deps.now ?? Date.now
  const mode = deps.mode ?? 'shadow'

  if (_running) {
    emitAsync(deps.traceAdapter, {
      event_type: 'gateway_reconciler_tick_skipped',
      decision: 'noop',
      reason_code: 'OVERLAP',
      reasoning: { reason: 'previous_run_still_active' },
      metrics: {},
    })
    return { skipped: true, reason: 'overlap' }
  }
  _running = true

  try {
    // ── Shadow mode: noop with warn guard ────────────────────────────────
    if (mode === 'shadow') {
      const unresolved = await deps.dataPlane.unknownsStore.listUnresolved({ olderThanMs: 0, limit: MAX_ROWS_PER_CYCLE })
      if (unresolved.length > 0) {
        emitAsync(deps.traceAdapter, {
          event_type: 'gateway_unknowns_in_shadow_mode',
          decision: 'warn',
          reason_code: 'UNRESOLVED_IN_SHADOW',
          reasoning: {
            count: unresolved.length,
            sample_decision_ids: unresolved.slice(0, SAMPLE_DECISION_IDS).map(r => r.decision_id),
          },
          metrics: { unresolved_count: unresolved.length },
        })
      }
      return { mode: 'shadow', skipped: true, unresolved_count: unresolved.length }
    }

    // ── Production: pull unresolved rows + apply per-row cadence ─────────
    const allRows = await deps.dataPlane.unknownsStore.listUnresolved({ olderThanMs: 0, limit: MAX_ROWS_PER_CYCLE })
    const t = now()

    const eligible = []
    let cadenceSkippedCount = 0
    for (const row of allRows) {
      const submittedMs = parseISOToMs(row.submitted_at)
      const ageMs = Number.isFinite(submittedMs) ? t - submittedMs : Infinity
      const lastCheckMs = row.last_check_at ? parseISOToMs(row.last_check_at) : null
      const sinceLastCheck = lastCheckMs ? t - lastCheckMs : Infinity
      const cadenceMs = ageMs <= ROW_AGE_BREAKPOINT_MS ? PER_ROW_CADENCE_FAST_MS : PER_ROW_CADENCE_SLOW_MS
      if (sinceLastCheck >= cadenceMs) eligible.push({ row, ageMs })
      else cadenceSkippedCount++
    }

    const outcomes = { resolved: 0, errored: 0, still_unknown: 0, by_error: {} }
    let firstAuthErrorRow = null

    for (const { row } of eligible) {
      const result = await deps.kalshi.lookupByClientOrderId({
        account_id:      row.account_id,
        market_ticker:   row.market_ticker,
        client_order_id: row.client_order_id,
      })

      // Categorized lookup error → bump attempt + record error_code, leave unresolved
      if (result?.error) {
        outcomes.errored++
        outcomes.by_error[result.error_code] = (outcomes.by_error[result.error_code] ?? 0) + 1
        await deps.dataPlane.unknownsStore.bumpAttempt(row.id, {
          error_code: result.error_code,
          response: safeStr({ error_code: result.error_code, detail: result.detail ?? null }),
        })
        if (result.error_code === 'lookup_auth_error' && !firstAuthErrorRow) {
          firstAuthErrorRow = row
        }
        continue
      }

      // Resolved truth from exchange
      if (result?.found) {
        const resolved_at = new Date(now()).toISOString()
        await deps.dataPlane.unknownsStore.markResolved(row.id, {
          resolved_status: result.status,
          resolved_at,
          kalshi_order_id: result.kalshi_order_id ?? null,
          last_check_response: safeStr(result.raw),
        })
        const newLastStatus = resolvedToLastStatus(result.status)
        const newExchangeStatus = result.status === 'rejected' ? 'rejected'
                              : result.status === 'partially_filled' ? 'partially_filled'
                              : 'placed'
        await deps.dataPlane.idempotencyStore.markResolved(row.decision_id, {
          last_status:     newLastStatus,
          kalshi_order_id: result.kalshi_order_id ?? null,
          exchange_status: newExchangeStatus,
          response_json:   JSON.stringify({
            status: newLastStatus,
            resolved_status: result.status,
            kalshi_order_id: result.kalshi_order_id ?? null,
            reconciled_at: resolved_at,
          }),
        })

        // Per-resolution Trace event (info severity)
        emitAsync(deps.traceAdapter, {
          decision_id: row.decision_id,
          event_type: 'gateway_reconciler_resolved',
          decision: 'accept',
          reason_code: result.status,
          reasoning: {
            account_id: row.account_id,
            market_ticker: row.market_ticker,
            kalshi_order_id: result.kalshi_order_id ?? null,
            attempts_before_resolve: row.attempts,
          },
          metrics: { age_ms: now() - parseISOToMs(row.submitted_at) },
        })
        outcomes.resolved++
        continue
      }

      // Not found yet — bump attempt; row stays unresolved
      outcomes.still_unknown++
      await deps.dataPlane.unknownsStore.bumpAttempt(row.id, {
        error_code: null,
        response: safeStr(result?.raw),
      })
    }

    // ── Rollup alerts (one per cycle, NOT per-row) ────────────────────────
    const stillUnresolved = await deps.dataPlane.unknownsStore.listUnresolved({ olderThanMs: 0, limit: 1000 })
    const tNow = now()
    let oldestAgeMs = 0
    const warnRows = []
    const critRows = []
    for (const r of stillUnresolved) {
      const ageMs = tNow - parseISOToMs(r.submitted_at)
      if (Number.isFinite(ageMs) && ageMs > oldestAgeMs) oldestAgeMs = ageMs
      if (ageMs > ROLLUP_CRITICAL_AGE_MS) critRows.push(r)
      else if (ageMs > ROLLUP_WARN_AGE_MS) warnRows.push(r)
    }

    if (critRows.length > 0) {
      emitAsync(deps.traceAdapter, {
        event_type: 'gateway_unknowns_critical',
        decision: 'critical',
        reason_code: 'UNRESOLVED_OVER_5MIN',
        reasoning: {
          count: critRows.length,
          oldest_age_ms: oldestAgeMs,
          sample_decision_ids: critRows.slice(0, SAMPLE_DECISION_IDS).map(r => r.decision_id),
        },
        metrics: { count: critRows.length, oldest_age_ms: oldestAgeMs },
      })
    } else if (warnRows.length > 0) {
      emitAsync(deps.traceAdapter, {
        event_type: 'gateway_unknowns_warn',
        decision: 'warn',
        reason_code: 'UNRESOLVED_OVER_60S',
        reasoning: {
          count: warnRows.length,
          oldest_age_ms: oldestAgeMs,
          sample_decision_ids: warnRows.slice(0, SAMPLE_DECISION_IDS).map(r => r.decision_id),
        },
        metrics: { count: warnRows.length, oldest_age_ms: oldestAgeMs },
      })
    }

    // Auth error: critical immediately, no threshold delay
    if (firstAuthErrorRow) {
      emitAsync(deps.traceAdapter, {
        event_type: 'gateway_reconciler_auth_error',
        decision: 'critical',
        reason_code: 'LOOKUP_AUTH_ERROR',
        reasoning: {
          account_id: firstAuthErrorRow.account_id,
          decision_id: firstAuthErrorRow.decision_id,
          error_count_this_cycle: outcomes.by_error.lookup_auth_error ?? 1,
        },
        metrics: { auth_errors_this_cycle: outcomes.by_error.lookup_auth_error ?? 1 },
      })
    }

    return {
      mode: 'production',
      total_unresolved_pre: allRows.length,
      eligible_count: eligible.length,
      cadence_skipped_count: cadenceSkippedCount,
      outcomes,
      total_unresolved_post: stillUnresolved.length,
      oldest_age_ms: oldestAgeMs,
      warn_count: warnRows.length,
      critical_count: critRows.length,
      auth_error_observed: !!firstAuthErrorRow,
    }
  } finally {
    _running = false
  }
}

// Test helper — clears the module-level _running flag
export function _resetForTesting() {
  _running = false
}

export const RECONCILER_CONSTANTS = Object.freeze({
  PER_ROW_CADENCE_FAST_MS,
  PER_ROW_CADENCE_SLOW_MS,
  ROW_AGE_BREAKPOINT_MS,
  ROLLUP_WARN_AGE_MS,
  ROLLUP_CRITICAL_AGE_MS,
  SAMPLE_DECISION_IDS,
})
