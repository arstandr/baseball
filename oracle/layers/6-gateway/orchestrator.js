// oracle/layers/6-gateway/orchestrator.js
//
// Layer 6: Gateway — orchestration around validatePlaceIntent.
// Owns the full request lifecycle for /gateway/place:
//
//   1. Validate via validatePlaceIntent
//   2. On reject  → writeAsync gateway_reject Trace event, return rejected response
//   3. On replay  → return cached response (no second exchange call)
//   4. On ok, halt-blind already ruled out by validator's halted check
//   5. writeSync gateway_intent Trace (writeSync because failure must fail-closed)
//   6. writeAsync any DECISION_AGE_HIGH warnings
//   7. Mode = shadow:
//        upsert idempotency row with status=shadow_logged
//        writeSync gateway_result
//        return shadow_logged
//   8. Mode = production:
//        kalshi.place() → outcome (success | error | unknown)
//        unknown → unknownsStore.enqueue() for reconciliation
//        idempotencyStore.upsert(...)
//        writeSync gateway_result
//          on writeSync failure → deadLetter.write(record)
//          on deadLetter ALSO failure → halt.setBlind(), return with _gateway_blind flag
//        return result
//
// All side-effecting dependencies are injected via `deps` so the orchestrator
// is unit-testable end-to-end with stubs.

import crypto from 'node:crypto'
import { validatePlaceIntent } from './validator.js'

const STATUS = Object.freeze({
  ACCEPTED:         'accepted',
  SHADOW_LOGGED:    'shadow_logged',
  REJECTED:         'rejected',
  EXCHANGE_UNKNOWN: 'exchange_unknown',
  EXCHANGE_ERROR:   'exchange_error',
  REPLAY:           'replay',
  HALTED:           'halted',
})

function newEventId() {
  return crypto.randomUUID()
}

/**
 * Execute a /gateway/place intent end-to-end.
 *
 * @param {object} req
 * @param {object} req.headers
 * @param {string|Buffer} req.rawBody
 * @param {object} req.body
 * @param {string} [req.sourceIp]
 * @param {string} req.tradingDate          // YYYY-MM-DD (ET)
 *
 * @param {object} deps                     // ALL side-effecting deps injected
 * @param {object} deps.trace               // { writeSync(ev), writeAsync(ev), makeEvent(params) }
 * @param {object} deps.kalshi              // { place({...}) → { outcome:'success'|'error'|'unknown', kalshi_order_id?, error_code?, raw_response? } }
 * @param {object} deps.idempotencyStore    // { upsert(row), get(decision_id) }
 * @param {object} deps.unknownsStore       // { enqueue({decision_id, account_id, market_ticker, submitted_at}) }
 * @param {object} deps.deadLetter          // { write(record) }
 * @param {object} deps.halt                // { isHalted(), setBlind(reason), peekStatus() }
 * @param {object} deps.killswitchCache     // { get() → snapshot }
 * @param {object} deps.agentSecrets        // { [agent_id]: secret }
 * @param {object} deps.loaders             // validator's loaders (insertNonce, loadAccount, loadAccountState, loadDecisionEvent, loadIdempotency)
 * @param {function} [deps.now]             // () → unix ms
 */
export async function executePlaceIntent(req, deps) {
  const t0 = (deps.now ?? Date.now)()
  const halted = deps.halt?.isHalted?.() === true

  // ── 1. Pull killswitch snapshot once for validator ─────────────────────
  let killswitch
  try {
    killswitch = await deps.killswitchCache.get()
  } catch {
    return finishReject(req, deps, t0, {
      reject_reason: 'DB_DOWN',
      context: { reason: 'killswitch_load_failed' },
    })
  }

  // ── 2. Validate ────────────────────────────────────────────────────────
  let validation
  try {
    validation = await validatePlaceIntent({
      headers:       req.headers,
      rawBody:       req.rawBody,
      body:          req.body,
      agentSecrets:  deps.agentSecrets,
      killswitch,
      loaders:       deps.loaders,
      now:           t0,
      tradingDate:   req.tradingDate,
      halted,
    })
  } catch (err) {
    return finishReject(req, deps, t0, {
      reject_reason: 'DB_DOWN',
      context: { reason: 'validator_threw', detail: err?.message?.slice(0, 200) },
    })
  }

  if (!validation.ok) {
    return finishReject(req, deps, t0, {
      reject_reason: validation.reject_reason,
      context: validation.context,
    })
  }

  // ── 3. Idempotency replay short-circuit ────────────────────────────────
  if (validation.idempotency?.state === 'replay') {
    return {
      status: STATUS.REPLAY,
      last_status:     validation.idempotency.last_status,
      kalshi_order_id: validation.idempotency.kalshi_order_id,
      exchange_status: validation.idempotency.exchange_status,
      response_json:   validation.idempotency.response_json,
      latency_ms:      latency(deps, t0),
    }
  }

  // ── 4. Build common Trace event scaffold ───────────────────────────────
  const decisionId = req.body.decision_id
  const traceCommon = {
    decision_id: decisionId,
    layer_name:  'gateway',
    pitcher_id:  String(req.body.pitcher_id ?? '0'),
    pitcher_name: req.body.pitcher_name ?? 'unknown',
    bet_date:    req.body.bet_date ?? '',
    strike:      req.body.strike ?? 0,
    side:        (req.body.contract_side ?? 'yes').toUpperCase(),
  }

  // ── 5. writeSync gateway_intent (fail-closed) ──────────────────────────
  const intentEventId = newEventId()
  const intentEvent = deps.trace.makeEvent({
    ...traceCommon,
    event_type:   'gateway_intent',
    decision:     'accept',
    reason_code:  validation.idempotency.state === 'fresh' ? 'fresh_intent' : 'replay_check',
    reasoning: {
      execution_mode: req.body.execution_mode,
      strategy_mode:  req.body.strategy_mode,
      account_id:     req.body.account_id,
      action:         req.body.action,
      contract_side:  req.body.contract_side,
      order_type:     req.body.order_type,
      time_in_force:  req.body.time_in_force,
      limit_price_cents: req.body.limit_price_cents,
      decision_input_hash: req.body.decision_input_hash,
      market_ticker:  req.body.market_ticker,
      bet_amount_usd: req.body.bet_amount_usd,
    },
    metrics: {
      quantity:                req.body.quantity,
      bet_amount_usd:          req.body.bet_amount_usd,
      bankroll_at_decision_usd: req.body.bankroll_at_decision_usd,
      kelly_fraction:          req.body.kelly_fraction,
    },
  })
  intentEvent.id = intentEventId

  try {
    await deps.trace.writeSync(intentEvent)
  } catch (err) {
    return finishReject(req, deps, t0, {
      reject_reason: 'TRACE_DOWN',
      context: { reason: 'intent_write_failed', detail: err?.message?.slice(0, 200) },
    })
  }

  // ── 6. Emit any warnings from validator (best-effort writeAsync) ───────
  for (const w of (validation.warnings ?? [])) {
    const warnEv = deps.trace.makeEvent({
      ...traceCommon,
      event_type:  'gateway_warning',
      decision:    'warn',
      reason_code: w.code,
      reasoning:   w,
      metrics:     { warn_threshold_ms: w.warn_threshold_ms ?? null, age_ms: w.age_ms ?? null },
    })
    deps.trace.writeAsync(warnEv).catch(() => {/* best-effort */})
  }

  // ── 7. Shadow short-circuit ────────────────────────────────────────────
  if (req.body.execution_mode === 'shadow') {
    await safeUpsertIdempotency(deps, req.body.decision_id, req.rawBody, {
      last_status: STATUS.SHADOW_LOGGED,
      client_order_id: null,           // shadow never reaches Kalshi
      exchange_request_sent: 0,
      kalshi_order_id: null,
      exchange_status: null,
      response_json: JSON.stringify({ status: STATUS.SHADOW_LOGGED }),
    })

    const resultEvId = newEventId()
    const resultEv = deps.trace.makeEvent({
      ...traceCommon,
      event_type:  'gateway_result',
      decision:    'shadow',
      reason_code: STATUS.SHADOW_LOGGED,
      reasoning:   { execution_mode: 'shadow' },
      metrics:     { latency_ms: latency(deps, t0).total },
    })
    resultEv.id = resultEvId
    resultEv.parent_event_id = intentEventId

    const traceResult = await safeWriteSync(deps, resultEv)
    if (traceResult.status === 'blind') {
      return {
        status: STATUS.SHADOW_LOGGED,
        trace_event_id_intent: intentEventId,
        trace_event_id_result: resultEvId,
        _gateway_blind: true,
        latency_ms: latency(deps, t0),
      }
    }
    return {
      status: STATUS.SHADOW_LOGGED,
      trace_event_id_intent: intentEventId,
      trace_event_id_result: resultEvId,
      latency_ms: latency(deps, t0),
    }
  }

  // ── 8. Production: call exchange ───────────────────────────────────────
  let exchange
  const tEx = (deps.now ?? Date.now)()
  try {
    exchange = await deps.kalshi.place({
      account_id:        req.body.account_id,
      market_ticker:     req.body.market_ticker,
      action:            req.body.action,
      contract_side:     req.body.contract_side,
      order_type:        req.body.order_type,
      time_in_force:     req.body.time_in_force,
      quantity:          req.body.quantity,
      limit_price_cents: req.body.limit_price_cents,
      decision_id:       req.body.decision_id,
    })
  } catch (err) {
    // Wrapper threw — treat as unknown (we don't know what reached Kalshi)
    exchange = {
      outcome: 'unknown',
      raw_response: { error: err?.message?.slice(0, 200) ?? 'wrapper_threw' },
    }
  }
  const exchangeLatencyMs = (deps.now ?? Date.now)() - tEx

  // Map exchange outcome → top-level status
  let topStatus, kalshi_order_id = null, exchange_status = null, error_code = null
  const client_order_id = exchange.client_order_id ?? null   // surfaced by kalshiClient.place
  if (exchange.outcome === 'success') {
    topStatus = STATUS.ACCEPTED
    kalshi_order_id = exchange.kalshi_order_id ?? null
    exchange_status = 'placed'
  } else if (exchange.outcome === 'error') {
    topStatus = STATUS.EXCHANGE_ERROR
    error_code = exchange.error_code ?? 'unknown_error'
    exchange_status = 'rejected'
  } else {
    // unknown
    topStatus = STATUS.EXCHANGE_UNKNOWN
    exchange_status = 'unknown'
    // Enqueue for reconciliation — persist client_order_id so the reconciler
    // has a deterministic key even after Gateway restart.
    try {
      await deps.unknownsStore.enqueue({
        decision_id:     req.body.decision_id,
        client_order_id,
        account_id:      req.body.account_id,
        market_ticker:   req.body.market_ticker,
        submitted_at:    new Date(t0).toISOString(),
      })
    } catch {
      // Enqueue failure on an unknown is dangerous — the order may be live
      // and we have no reconciliation path. Surface via warning Trace event;
      // operator must reconcile manually until reconciliation queue catches up.
      deps.trace.writeAsync(deps.trace.makeEvent({
        decision_id:  req.body.decision_id,
        layer_name:   'gateway',
        pitcher_id:   String(req.body.pitcher_id ?? '0'),
        pitcher_name: req.body.pitcher_name ?? 'unknown',
        bet_date:     req.body.bet_date ?? '',
        strike:       req.body.strike ?? 0,
        side:         (req.body.contract_side ?? 'yes').toUpperCase(),
        event_type:   'gateway_unknown_enqueue_failed',
        decision:     'critical',
        reason_code:  'UNKNOWN_ENQUEUE_FAILED',
        reasoning:    { market_ticker: req.body.market_ticker },
        metrics:      {},
      })).catch(() => {})
    }
  }

  // ── 9. Idempotency cache write (so retries replay) ─────────────────────
  await safeUpsertIdempotency(deps, req.body.decision_id, req.rawBody, {
    last_status:           topStatus,
    client_order_id,
    exchange_request_sent: 1,
    kalshi_order_id,
    exchange_status,
    response_json: JSON.stringify({
      status: topStatus,
      kalshi_order_id,
      client_order_id,
      exchange_status,
      error_code,
    }),
  })

  // ── 10. writeSync gateway_result; on fail → dead-letter; on dead-letter fail → halt ──
  const resultEvId = newEventId()
  const resultEv = deps.trace.makeEvent({
    ...traceCommon,
    event_type:  'gateway_result',
    decision:    topStatus === STATUS.ACCEPTED ? 'accept' : (topStatus === STATUS.EXCHANGE_ERROR ? 'reject' : 'unknown'),
    reason_code: topStatus,
    reasoning: {
      kalshi_order_id,
      exchange_status,
      error_code,
      raw_response_preview: previewRaw(exchange.raw_response),
    },
    metrics: {
      exchange_latency_ms: exchangeLatencyMs,
      total_latency_ms:    latency(deps, t0).total,
    },
  })
  resultEv.id = resultEvId
  resultEv.parent_event_id = intentEventId

  const traceResultWrite = await safeWriteSync(deps, resultEv, {
    decision_id:   req.body.decision_id,
    market_ticker: req.body.market_ticker,
    kalshi_order_id,
    topStatus,
    raw_response: exchange.raw_response,
  })

  const base = {
    status: topStatus,
    kalshi_order_id,
    exchange_status,
    error_code,
    exchange_response: exchange.raw_response ?? null,
    trace_event_id_intent: intentEventId,
    trace_event_id_result: resultEvId,
    latency_ms: latency(deps, t0),
  }
  if (topStatus === STATUS.EXCHANGE_UNKNOWN) base.reconciliation_state = 'pending'
  if (traceResultWrite.status === 'blind') base._gateway_blind = true
  return base
}

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

function latency(deps, t0) {
  const total = (deps.now ?? Date.now)() - t0
  return { total }
}

function previewRaw(raw) {
  if (raw == null) return null
  const s = typeof raw === 'string' ? raw : JSON.stringify(raw)
  return s.slice(0, 500)
}

async function safeUpsertIdempotency(deps, decision_id, rawBody, fields) {
  try {
    const body_hash = sha256Hex(rawBody)
    await deps.idempotencyStore.upsert({
      decision_id,
      body_hash,
      ...fields,
    })
  } catch {
    // Idempotency write failure does NOT halt — it just means retries can't
    // replay correctly. Surface via warning Trace event.
    deps.trace.writeAsync(deps.trace.makeEvent({
      decision_id,
      layer_name:  'gateway',
      pitcher_id:  '0',
      pitcher_name: 'unknown',
      bet_date:    '',
      strike:      0,
      side:        'YES',
      event_type:  'gateway_idempotency_write_failed',
      decision:    'warn',
      reason_code: 'IDEMPOTENCY_WRITE_FAILED',
      reasoning:   {},
      metrics:     {},
    })).catch(() => {})
  }
}

// writeSync wrapper: on fail try dead-letter; on dead-letter fail set blind halt.
// Returns { status: 'ok' } | { status: 'dead_lettered' } | { status: 'blind' }
async function safeWriteSync(deps, event, deadLetterPayload) {
  try {
    await deps.trace.writeSync(event)
    return { status: 'ok' }
  } catch (err) {
    // Dead-letter the event itself + the operational payload (so operator can replay)
    const record = {
      kind: 'post_exchange_trace_failure',
      occurred_at: new Date((deps.now ?? Date.now)()).toISOString(),
      trace_event: event,
      payload: deadLetterPayload ?? null,
      error: err?.message?.slice(0, 200) ?? 'unknown',
    }
    try {
      await deps.deadLetter.write(record)
      // Best-effort critical alert via writeAsync (different event_type so it
      // doesn't itself fail the same way)
      deps.trace.writeAsync(deps.trace.makeEvent({
        decision_id:  event.decision_id,
        layer_name:   'gateway',
        pitcher_id:   String(event.pitcher_id ?? '0'),
        pitcher_name: event.pitcher_name ?? 'unknown',
        bet_date:     event.bet_date ?? '',
        strike:       event.strike ?? 0,
        side:         event.side ?? 'YES',
        event_type:   'POST_EXCHANGE_TRACE_GAP',
        decision:     'critical',
        reason_code:  'POST_EXCHANGE_TRACE_GAP',
        reasoning:    { dead_letter_kind: 'post_exchange_trace_failure' },
        metrics:      {},
      })).catch(() => {})
      return { status: 'dead_lettered' }
    } catch (dlErr) {
      // BOTH failed. Blind halt.
      deps.halt.setBlind?.({
        reason: 'GATEWAY_BLIND',
        detail: `trace_fail: ${err?.message?.slice(0, 100)} ; deadletter_fail: ${dlErr?.message?.slice(0, 100)}`,
        at: new Date((deps.now ?? Date.now)()).toISOString(),
      })
      return { status: 'blind' }
    }
  }
}

async function finishReject(req, deps, t0, { reject_reason, context }) {
  // Best-effort writeAsync of the reject Trace event.
  // We never made an exchange call, so losing this audit is acceptable — but
  // we still try because drift detector relies on reject counts.
  try {
    const rejectEv = deps.trace.makeEvent({
      decision_id:  req.body?.decision_id ?? 'unknown',
      layer_name:   'gateway',
      pitcher_id:   String(req.body?.pitcher_id ?? '0'),
      pitcher_name: req.body?.pitcher_name ?? 'unknown',
      bet_date:     req.body?.bet_date ?? '',
      strike:       req.body?.strike ?? 0,
      side:         (req.body?.contract_side ?? 'yes').toUpperCase(),
      event_type:   'gateway_reject',
      decision:     'reject',
      reason_code:  reject_reason,
      reasoning:    context ?? {},
      metrics:      { latency_ms: latency(deps, t0).total },
    })
    deps.trace.writeAsync(rejectEv).catch(() => {})
  } catch {/* even constructing the event failed; nothing to log */}

  // Map IDEMPOTENCY_CONFLICT into "rejected" with the conflict reject_reason
  // (per spec §3 — no separate top-level "conflict" status from the orchestrator
  // since the validator path already classified it).

  // GATEWAY_HALTED maps to top-level "halted" status per spec §3.
  if (reject_reason === 'GATEWAY_HALTED') {
    return {
      status: STATUS.HALTED,
      latency_ms: latency(deps, t0),
    }
  }

  return {
    status: STATUS.REJECTED,
    reject_reason,
    context: context ?? {},
    latency_ms: latency(deps, t0),
  }
}

// Local sha256 for idempotency body hashing (matches validator's expectation)
function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex')
}

export { STATUS as GATEWAY_STATUS }
