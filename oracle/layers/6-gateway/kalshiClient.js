// oracle/layers/6-gateway/kalshiClient.js
//
// Gateway-side wrapper around lib/kalshi.js for state-changing calls
// (placeOrder, cancelOrder, amendOrder).
//
// Adds three things on top of lib/kalshi.js:
//   1. Credential routing — each call carries account_id; we look up the
//      KALSHI_API_KEY_ID / KALSHI_PRIVATE_KEY_PEM pair for that account.
//   2. Timeout — bounded by gateway perf budget (default 5000ms) so a slow
//      Kalshi response can't block the whole request indefinitely.
//   3. Outcome classification — translates lib/kalshi's throws into the
//      orchestrator's contract:
//          { outcome: 'success' | 'error' | 'unknown', kalshi_order_id?, error_code?, raw_response? }
//
// Classification rules (locked spec §4):
//   - HTTP 4xx with status code parsed → outcome='error' (definitive Kalshi rejection)
//   - HTTP 5xx, timeout, network error → outcome='unknown' (order may or may
//     not have reached Kalshi; reconciler must resolve)
//   - Missing credentials before any HTTP call → outcome='error' (we never
//     contacted Kalshi)
//   - Anything else / unparseable → outcome='unknown' (safe default)
//
// kalshiLib (lib/kalshi.js) is injected so tests can mock without hitting
// the real exchange.
//
// client_order_id (deterministic) — derived as `gateway_<sha256(decision_id):0..16>`.
// Passed to lib/kalshi.placeOrder so a Gateway retry on the same decision_id
// uses the same Kalshi-side idempotency key, preventing double-place even if
// the first request reached Kalshi but our network response timed out.
// Returned in the place() result so the orchestrator can persist it on
// gateway_idempotency + gateway_unknowns rows for the reconciler to look up by.

import crypto from 'node:crypto'

const DEFAULT_TIMEOUT_MS = 5000

const CLIENT_ORDER_ID_HASH_LEN = 16
const CLIENT_ORDER_ID_PREFIX   = 'gateway_'

export function deriveClientOrderId(decision_id) {
  if (typeof decision_id !== 'string' || decision_id.length === 0) {
    throw new Error('deriveClientOrderId: decision_id required')
  }
  const hash = crypto.createHash('sha256').update(decision_id).digest('hex').slice(0, CLIENT_ORDER_ID_HASH_LEN)
  return `${CLIENT_ORDER_ID_PREFIX}${hash}`
}

export function makeKalshiClient(opts = {}) {
  const kalshiLib  = opts.kalshiLib
  const credentials = opts.credentials ?? {}
  const timeoutMs   = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

  if (!kalshiLib || typeof kalshiLib.placeOrder !== 'function') {
    throw new Error('makeKalshiClient: kalshiLib must expose placeOrder')
  }

  function getCreds(account_id) {
    const c = credentials[account_id]
    if (!c) {
      const err = new Error(`no_credentials_for_account:${account_id}`)
      err.code = 'NO_CREDENTIALS'
      throw err
    }
    if (!c.KALSHI_API_KEY_ID || !c.KALSHI_PRIVATE_KEY_PEM) {
      const err = new Error(`incomplete_credentials_for_account:${account_id}`)
      err.code = 'INCOMPLETE_CREDENTIALS'
      throw err
    }
    return c
  }

  function classifyThrow(err) {
    const msg = err?.message ?? String(err)

    // Pre-flight credential errors are definitive — we never sent anything
    if (err?.code === 'NO_CREDENTIALS' || err?.code === 'INCOMPLETE_CREDENTIALS') {
      return { outcome: 'error', error_code: err.code, detail: msg }
    }

    // lib/kalshi throws "kalshi METHOD url -> NNN body" on >= 400 statuses
    const httpMatch = msg.match(/->\s*(\d{3})\b/)
    if (httpMatch) {
      const status = Number(httpMatch[1])
      if (status >= 400 && status < 500) {
        return { outcome: 'error', error_code: `http_${status}`, detail: msg }
      }
      if (status >= 500) {
        return { outcome: 'unknown', detail: msg }
      }
    }

    // Network / timeout / connection-level failures are "unknown"
    // (request bytes may have left the wire before the failure)
    if (/\b(?:timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENETUNREACH|ENOTFOUND|ENETDOWN|aborted|EAI_AGAIN)\b/i.test(msg)) {
      return { outcome: 'unknown', detail: msg }
    }
    if (/gateway timeout/i.test(msg)) {
      return { outcome: 'unknown', detail: msg }
    }

    // Default: unknown (don't risk a definitive 'error' classification on
    // an exception we don't recognize)
    return { outcome: 'unknown', detail: msg }
  }

  async function withTimeout(promise, ms, label) {
    let timer
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error(`gateway timeout: ${label} > ${ms}ms`)
        err.code = 'GATEWAY_TIMEOUT'
        reject(err)
      }, ms)
    })
    try {
      return await Promise.race([promise, timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  function extractOrderId(res) {
    if (!res || typeof res !== 'object') return null
    return res?.order?.order_id ?? res?.order_id ?? res?.data?.order?.order_id ?? null
  }

  async function place({
    account_id, market_ticker, contract_side, action,
    quantity, limit_price_cents, decision_id,
  }) {
    if (!decision_id) {
      return { outcome: 'error', error_code: 'missing_decision_id', raw_response: null, client_order_id: null }
    }
    let creds
    try { creds = getCreds(account_id) }
    catch (err) {
      const c = classifyThrow(err)
      return { outcome: c.outcome, error_code: c.error_code, raw_response: { error: c.detail }, client_order_id: null }
    }

    const client_order_id = deriveClientOrderId(decision_id)

    try {
      const res = await withTimeout(
        kalshiLib.placeOrder(
          market_ticker, contract_side, quantity, limit_price_cents,
          creds, action,
          { client_order_id },
        ),
        timeoutMs,
        'placeOrder',
      )
      return {
        outcome: 'success',
        kalshi_order_id: extractOrderId(res),
        client_order_id,
        raw_response: res,
      }
    } catch (err) {
      const c = classifyThrow(err)
      return {
        outcome: c.outcome,
        error_code: c.error_code,
        client_order_id,            // surface even on failure so caller persists for reconciler
        raw_response: { error: c.detail },
      }
    }
  }

  // ── Reconciler support: look up an order by its client_order_id ──────
  //
  // Searches open orders for the given ticker first; if not found and the
  // caller asks, also probes fills (a fully-filled IOC order may have
  // disappeared from open list and only exists as a fill).
  //
  // Returns:
  //   { found: true, status: 'placed'|'rejected'|'partially_filled', kalshi_order_id, raw }
  //   { found: false, raw }                                      // searched but not present
  //   { error: true, error_code: 'lookup_5xx'|'lookup_timeout'|'lookup_auth_error'|'lookup_rate_limited', detail, raw }
  function classifyLookupError(err) {
    const msg = err?.message ?? String(err)
    if (err?.code === 'NO_CREDENTIALS' || err?.code === 'INCOMPLETE_CREDENTIALS') {
      return 'lookup_auth_error'
    }
    const m = msg.match(/->\s*(\d{3})\b/)
    if (m) {
      const status = Number(m[1])
      if (status === 401 || status === 403) return 'lookup_auth_error'
      if (status === 429) return 'lookup_rate_limited'
      if (status >= 500) return 'lookup_5xx'
      if (status === 404) return 'lookup_not_found'
    }
    if (/timeout|ETIMEDOUT|gateway timeout/i.test(msg)) return 'lookup_timeout'
    if (/ECONNRESET|ECONNREFUSED|ENETUNREACH|ENOTFOUND|EAI_AGAIN|aborted/i.test(msg)) return 'lookup_5xx'
    return 'lookup_5xx'
  }

  async function lookupByClientOrderId({ account_id, market_ticker, client_order_id, checkFills = true }) {
    if (!client_order_id) {
      return { error: true, error_code: 'lookup_not_found', detail: 'missing_client_order_id' }
    }
    let creds
    try { creds = getCreds(account_id) }
    catch (err) {
      return { error: true, error_code: 'lookup_auth_error', detail: err.message ?? 'creds' }
    }

    let orders
    try {
      orders = await withTimeout(
        kalshiLib.listOrders({ ticker: market_ticker, limit: 100 }, creds),
        timeoutMs,
        'listOrders',
      )
    } catch (err) {
      return { error: true, error_code: classifyLookupError(err), detail: err?.message?.slice(0, 200) }
    }

    if (!Array.isArray(orders)) orders = []
    const match = orders.find(o => o?.client_order_id === client_order_id)
    if (match) {
      const ksStatus = String(match.status ?? '').toLowerCase()
      let status
      if (ksStatus === 'executed' || ksStatus === 'filled' || ksStatus === 'fully_filled') status = 'placed'
      else if (ksStatus === 'partially_filled' || ksStatus === 'partial') status = 'partially_filled'
      else if (ksStatus === 'cancelled' || ksStatus === 'canceled' || ksStatus === 'rejected') status = 'rejected'
      else if (ksStatus === 'resting' || ksStatus === 'open' || ksStatus === 'pending') status = 'placed'
      else status = ksStatus || 'placed'
      return {
        found: true,
        status,
        kalshi_order_id: match.order_id ?? null,
        raw: match,
      }
    }

    // Not found in open/recent orders. Optionally probe fills — a filled IOC
    // order may not be returned by listOrders depending on Kalshi's status
    // filtering. Fills don't carry client_order_id directly; this is a
    // best-effort sanity probe that returns the most recent fill matching the
    // ticker so the operator/reconciler has SOMETHING to look at.
    if (checkFills && typeof kalshiLib.getFills === 'function') {
      try {
        const fills = await withTimeout(
          kalshiLib.getFills({ ticker: market_ticker, limit: 50 }, creds),
          timeoutMs,
          'getFills',
        )
        if (Array.isArray(fills) && fills.length > 0) {
          // We can't definitively match without client_order_id on fills; the
          // caller can use the fill data + listOrders next pass to confirm.
          return {
            found: false,
            raw: { fills_count: fills.length, fills_preview: fills.slice(0, 3) },
          }
        }
      } catch (err) {
        // Fills lookup failure is non-fatal; the primary signal was listOrders.
        return { found: false, raw: { fills_lookup_error: err?.message?.slice(0, 100) } }
      }
    }

    return { found: false, raw: { searched_orders_count: orders.length } }
  }

  async function cancel({ account_id, kalshi_order_id }) {
    if (!kalshi_order_id) {
      return { outcome: 'error', error_code: 'missing_kalshi_order_id', raw_response: null }
    }
    let creds
    try { creds = getCreds(account_id) }
    catch (err) {
      const c = classifyThrow(err)
      return { outcome: c.outcome, error_code: c.error_code, raw_response: { error: c.detail } }
    }

    try {
      const res = await withTimeout(
        kalshiLib.cancelOrder(kalshi_order_id, creds),
        timeoutMs,
        'cancelOrder',
      )
      return { outcome: 'success', kalshi_order_id, raw_response: res }
    } catch (err) {
      const c = classifyThrow(err)
      return { outcome: c.outcome, error_code: c.error_code, raw_response: { error: c.detail } }
    }
  }

  async function amend({ account_id, kalshi_order_id, contract_side, action, quantity, limit_price_cents }) {
    if (!kalshi_order_id) {
      return { outcome: 'error', error_code: 'missing_kalshi_order_id', raw_response: null }
    }
    let creds
    try { creds = getCreds(account_id) }
    catch (err) {
      const c = classifyThrow(err)
      return { outcome: c.outcome, error_code: c.error_code, raw_response: { error: c.detail } }
    }

    const amendArgs = {
      side:   contract_side,
      action: action,
      count:  quantity,
      price:  limit_price_cents,
    }

    try {
      const res = await withTimeout(
        kalshiLib.amendOrder(kalshi_order_id, amendArgs, creds),
        timeoutMs,
        'amendOrder',
      )
      return { outcome: 'success', kalshi_order_id, raw_response: res }
    } catch (err) {
      const c = classifyThrow(err)
      return { outcome: c.outcome, error_code: c.error_code, raw_response: { error: c.detail } }
    }
  }

  return {
    place, cancel, amend, lookupByClientOrderId,
    // Test helpers (underscore prefix = not part of public contract)
    _classifyThrow: classifyThrow,
    _classifyLookupError: classifyLookupError,
    _extractOrderId: extractOrderId,
    _deriveClientOrderId: deriveClientOrderId,
  }
}
