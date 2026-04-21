// lib/http.js — shared axios client with retry + circuit breaker
//
// Circuit-breaker semantics:
//  - Each (source) has independent state.
//  - On repeated failures (>= FAILURE_THRESHOLD consecutive) the breaker OPENS
//    for COOLDOWN_MS. Calls return { ok: false, skipped: true } so the caller
//    can proceed without blocking the whole pipeline.
//  - A single successful call closes the breaker.
//
// Retry semantics:
//  - Up to RETRY_MAX attempts with exponential backoff + jitter.
//  - Timeouts and 5xx/429 are retried; 4xx (non-429) are NOT retried.

import axios from 'axios'

const FAILURE_THRESHOLD = 5
const COOLDOWN_MS = 5 * 60 * 1000
const RETRY_MAX = 3
const BASE_BACKOFF_MS = 500

const breakers = new Map() // source -> { failures, openUntil }

function breakerState(source) {
  if (!breakers.has(source)) {
    breakers.set(source, { failures: 0, openUntil: 0 })
  }
  return breakers.get(source)
}

function isOpen(source) {
  const s = breakerState(source)
  return Date.now() < s.openUntil
}

function recordSuccess(source) {
  const s = breakerState(source)
  s.failures = 0
  s.openUntil = 0
}

function recordFailure(source) {
  const s = breakerState(source)
  s.failures += 1
  if (s.failures >= FAILURE_THRESHOLD) {
    s.openUntil = Date.now() + COOLDOWN_MS
  }
}

function isRetryable(err) {
  if (!err.response) return true // network/timeout
  const code = err.response.status
  return code >= 500 || code === 429
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

/**
 * fetch — GET/POST helper with retry + breaker.
 * @param {string} source          - logical name for the circuit breaker
 * @param {object} config          - axios config
 * @param {object} [opts]
 * @param {number} [opts.retries=RETRY_MAX]
 */
export async function fetch(source, config, { retries = RETRY_MAX } = {}) {
  if (isOpen(source)) {
    return { ok: false, skipped: true, reason: 'breaker_open', source }
  }
  let lastErr
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await axios({
        timeout: 20000,
        validateStatus: s => s >= 200 && s < 400,
        ...config,
      })
      recordSuccess(source)
      return { ok: true, data: res.data, status: res.status, headers: res.headers }
    } catch (err) {
      lastErr = err
      if (!isRetryable(err) || attempt === retries) break
      const wait = BASE_BACKOFF_MS * 2 ** attempt + Math.random() * 200
      await sleep(wait)
    }
  }
  recordFailure(source)
  return {
    ok: false,
    error: lastErr?.message || String(lastErr),
    status: lastErr?.response?.status,
    source,
  }
}

export function breakerStatus() {
  const now = Date.now()
  const out = {}
  for (const [source, state] of breakers.entries()) {
    out[source] = {
      open: now < state.openUntil,
      failures: state.failures,
      reopens_in_ms: Math.max(0, state.openUntil - now),
    }
  }
  return out
}
