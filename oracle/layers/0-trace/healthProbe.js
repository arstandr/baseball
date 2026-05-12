// oracle/layers/0-trace/healthProbe.js
//
// Synthetic write+read roundtrip every 60s.
// 2 consecutive failures → CRITICAL alert.
//
// Per spec §6 — runs in healthSentinel cron.

import * as trace from './impl.js'
import { alertOracleHealth } from './alerts.js'
import * as db from '../../../lib/db.js'
import crypto from 'node:crypto'

let _consecutiveFailures = 0
const _MAX_CONSECUTIVE_BEFORE_ALERT = 2

export async function traceHealthProbe() {
  const probeId = `probe-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
  const startTs = Date.now()

  try {
    // Synthetic write+read roundtrip
    const ev = trace.makeEvent({
      decision_id: probeId,
      layer_name: 'system',
      event_type: 'health_check',
      pitcher_id: '0',
      pitcher_name: 'PROBE',
      bet_date: '2026-04-30',  // any valid date; this is purely synthetic
      strike: 0,
      side: 'YES',
      decision: 'pass',
      reason_code: 'health_probe',
      reasoning: { probe_at: new Date().toISOString() },
      metrics: { probe: true },
    })

    await trace.writeSync(ev)

    const back = await trace.read({ decision_id: probeId })
    if (!back || !back.systems.oracle || back.systems.oracle.events.length === 0) {
      throw new Error('roundtrip_failed: write succeeded but read returned empty')
    }

    // Cleanup the probe event
    await db.run(
      `DELETE FROM oracle_trace_events WHERE decision_id = ?`,
      [probeId],
    ).catch(() => {})

    _consecutiveFailures = 0
    const latency = Date.now() - startTs
    return { healthy: true, latency_ms: latency, probeId }
  } catch (err) {
    _consecutiveFailures++
    if (_consecutiveFailures >= _MAX_CONSECUTIVE_BEFORE_ALERT) {
      await alertOracleHealth({
        trigger: 'trace_health_probe_failed',
        severity: 'critical',
        title: 'Trace health probe failed',
        detail: `Synthetic write+read roundtrip failed ${_consecutiveFailures} consecutive times. Trace may be down.`,
        context: {
          consecutive_failures: _consecutiveFailures,
          last_error: err.message?.slice(0, 200) ?? 'unknown',
          latency_ms: Date.now() - startTs,
        },
      }).catch(() => {})
    }
    return {
      healthy: false,
      reason: err.message ?? 'unknown',
      consecutive_failures: _consecutiveFailures,
      latency_ms: Date.now() - startTs,
    }
  }
}

// For tests
export function _resetFailureCounter() {
  _consecutiveFailures = 0
}

export function _getFailureCounter() {
  return _consecutiveFailures
}
