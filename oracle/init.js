// oracle/init.js
//
// One-time Oracle initialization. Call once at server startup BEFORE any
// layer code emits trace events. Wires the critical-failure handler so
// async write failures route to Discord, and starts the background flusher.
//
// Usage:
//   import { initOracle } from './oracle/init.js'
//   initOracle()    // called once in server/scheduler.js startup

import * as trace from './layers/0-trace/impl.js'
import { makeTraceCriticalHandler } from './layers/0-trace/alerts.js'

let _initialized = false

export function initOracle() {
  if (_initialized) return
  _initialized = true

  // Wire critical-failure handler — async write failures, queue overflow,
  // shutdown drains all route to ORACLE-HEALTH Discord webhook
  trace.setCriticalFailureHandler(makeTraceCriticalHandler())

  // Start the background async flusher
  // Non-Gateway layers use writeAsync(); the flusher batches & persists every 100ms
  trace.startAsyncFlusher()

  console.log('[oracle] initialized — Trace handler wired, async flusher started')
}

export function shutdownOracle(timeoutMs = 5000) {
  return trace.shutdown(timeoutMs)
}
