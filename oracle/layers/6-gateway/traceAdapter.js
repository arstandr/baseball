// oracle/layers/6-gateway/traceAdapter.js
//
// Bridges the orchestrator's `trace.api` contract ({ writeSync, writeAsync,
// makeEvent }) onto Layer 0's actual Trace impl (oracle/layers/0-trace/impl.js).
//
// Key job: inject request-scope context (agent_id, agent_version, commit_hash,
// mode) into each makeEvent call so callers don't have to pass these every time.
//
// Usage:
//   import * as trace from '../0-trace/impl.js'
//   const adapter = makeTraceAdapter(trace)
//   const reqTrace = adapter.forRequest({ headers, body })
//   await reqTrace.writeSync(reqTrace.makeEvent({ event_type: 'gateway_intent', ... }))
//
// The adapter is also test-friendly: pass a mock `traceModule` to swap out
// Layer 0 entirely for unit tests.

const DEFAULT_AGENT = 'railway'
const DEFAULT_VERSION = 'unknown'
const DEFAULT_COMMIT = 'unknown'
const DEFAULT_LAYER_VERSION = '1.0.0'

export function makeTraceAdapter(traceModule, opts = {}) {
  if (!traceModule || typeof traceModule.writeSync !== 'function' || typeof traceModule.makeEvent !== 'function') {
    throw new Error('makeTraceAdapter: traceModule must expose { writeSync, writeAsync, makeEvent }')
  }

  const staticContext = Object.freeze({
    layer_name:     opts.layerName     ?? 'gateway',
    layer_version:  opts.layerVersion  ?? DEFAULT_LAYER_VERSION,
    server_version: opts.serverVersion ?? null,
    environment:    opts.environment   ?? process.env.NODE_ENV ?? 'production',
    system:         opts.system        ?? 'oracle',
  })

  function forRequest({ headers = {}, body = {}, runId = null, requestId = null } = {}) {
    const requestContext = {
      ...staticContext,
      agent_id:      headers['x-gateway-agent']         ?? DEFAULT_AGENT,
      agent_version: headers['x-gateway-agent-version'] ?? DEFAULT_VERSION,
      commit_hash:   headers['x-gateway-commit']        ?? DEFAULT_COMMIT,
      mode:          body?.execution_mode               ?? 'shadow',
      run_id:        runId,
      request_id:    requestId,
    }

    return {
      makeEvent(partial = {}) {
        // Caller-supplied keys win over request context; request context wins
        // over Layer 0's makeEvent defaults.
        return traceModule.makeEvent({
          ...requestContext,
          ...partial,
        })
      },
      writeSync:  traceModule.writeSync,
      writeAsync: traceModule.writeAsync,
    }
  }

  // Convenience: a "system" trace API for non-request context (probes, sweepers)
  function forSystem(extra = {}) {
    const ctx = {
      ...staticContext,
      agent_id:      extra.agent_id      ?? DEFAULT_AGENT,
      agent_version: extra.agent_version ?? DEFAULT_VERSION,
      commit_hash:   extra.commit_hash   ?? DEFAULT_COMMIT,
      mode:          extra.mode          ?? 'production',
    }
    return {
      makeEvent: (partial = {}) => traceModule.makeEvent({ ...ctx, ...partial }),
      writeSync: traceModule.writeSync,
      writeAsync: traceModule.writeAsync,
    }
  }

  return { forRequest, forSystem, staticContext }
}
