// oracle/layers/6-gateway/halt.js
//
// In-memory halt state for the Gateway.
//
// Two distinct halt categories per spec §4 / §8:
//   1. Operator killswitches (gateway_kill_*) — live in DB, NOT in-memory,
//      managed by the killswitch table + 1s cache. Not handled here.
//   2. Operational halts — set when post-exchange Trace AND dead-letter both
//      fail (`GATEWAY_BLIND`). In-memory only because the DB is presumed
//      degraded at the moment we'd want to record the halt.
//
// Auto-clear semantics (spec §4):
//   - When GATEWAY_BLIND is active, an external health-probe job calls
//     recordProbeResult(true|false) periodically.
//   - Two consecutive `true` results → auto-clear, emit GATEWAY_RECOVERED.
//   - One `false` resets the consecutive-success counter to 0.
//
// Manual unhalt:
//   - markUnhalt(by, reason) clears any operational halt regardless of
//     probe state (operator override).
//
// API:
//   const halt = makeHaltState({ now, onClear })
//   halt.isHalted()
//   halt.setBlind({ reason, detail })
//   halt.recordProbeResult(true|false)
//   halt.markUnhalt(by, reason?)
//   halt.peekStatus()

const REQUIRED_PROBE_SUCCESSES_FOR_AUTOCLEAR = 2

export function makeHaltState({ now = () => Date.now(), onClear } = {}) {
  let _state = {
    blind: null,                 // null | { reason, detail, at }
    consecutiveProbeSuccesses: 0,
    lastProbeAt: null,
    lastProbeResult: null,       // null | true | false
    audit: [],                   // [{ at, action, by?, reason?, detail? }]
  }

  function isHalted() {
    return _state.blind != null
  }

  function setBlind({ reason = 'GATEWAY_BLIND', detail = null } = {}) {
    if (_state.blind) {
      // Already blind — record additional detail in audit but don't reset
      _state.audit.push({ at: now(), action: 'blind_reentry', reason, detail })
      return _state.blind
    }
    _state.blind = { reason, detail, at: now() }
    _state.consecutiveProbeSuccesses = 0
    _state.audit.push({ at: now(), action: 'set_blind', reason, detail })
    return _state.blind
  }

  function recordProbeResult(success) {
    _state.lastProbeAt = now()
    _state.lastProbeResult = !!success
    if (!isHalted()) {
      // No-op if not halted — probes are still useful for keeping the counter
      // warm but they don't trigger anything.
      _state.consecutiveProbeSuccesses = success ? _state.consecutiveProbeSuccesses + 1 : 0
      return { cleared: false, reason: 'not_halted' }
    }

    if (success) {
      _state.consecutiveProbeSuccesses += 1
      if (_state.consecutiveProbeSuccesses >= REQUIRED_PROBE_SUCCESSES_FOR_AUTOCLEAR) {
        const cleared = _state.blind
        _state.blind = null
        _state.consecutiveProbeSuccesses = 0
        _state.audit.push({ at: now(), action: 'auto_clear', cleared_at: cleared.at })
        if (typeof onClear === 'function') {
          try { onClear({ trigger: 'auto_clear', cleared }) } catch { /* best-effort */ }
        }
        return { cleared: true, trigger: 'auto_clear' }
      }
      return { cleared: false, consecutive: _state.consecutiveProbeSuccesses }
    }

    // probe failed
    _state.consecutiveProbeSuccesses = 0
    _state.audit.push({ at: now(), action: 'probe_failed_during_blind' })
    return { cleared: false, consecutive: 0 }
  }

  function markUnhalt(by, reason = null) {
    if (!isHalted()) return { cleared: false, reason: 'not_halted' }
    const cleared = _state.blind
    _state.blind = null
    _state.consecutiveProbeSuccesses = 0
    _state.audit.push({ at: now(), action: 'manual_unhalt', by, reason, cleared_at: cleared.at })
    if (typeof onClear === 'function') {
      try { onClear({ trigger: 'manual_unhalt', by, reason, cleared }) } catch { /* best-effort */ }
    }
    return { cleared: true, trigger: 'manual_unhalt' }
  }

  function peekStatus() {
    return {
      blind: _state.blind ? { ...(_state.blind) } : null,
      consecutiveProbeSuccesses: _state.consecutiveProbeSuccesses,
      lastProbeAt: _state.lastProbeAt,
      lastProbeResult: _state.lastProbeResult,
      auditCount: _state.audit.length,
    }
  }

  function _peekAudit() {
    return _state.audit.slice()
  }

  return {
    isHalted,
    setBlind,
    recordProbeResult,
    markUnhalt,
    peekStatus,
    _peekAudit,
  }
}

export const HALT_AUTOCLEAR_THRESHOLD = REQUIRED_PROBE_SUCCESSES_FOR_AUTOCLEAR
