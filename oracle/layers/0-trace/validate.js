// oracle/layers/0-trace/validate.js
//
// Hand-rolled schema validation for TraceEvent.
// No external dependencies (no Zod) to keep deps minimal.
//
// Hard rule: invalid events THROW. They do not silently fail.
// The throw is the caller's signal that they have a bug.

export const TRACE_SCHEMA_VERSION = '1.0.0'

const VALID_LAYERS = new Set([
  'math', 'path', 'trust', 'critic', 'judge', 'gateway', 'execution', 'system',
])

const VALID_MODES = new Set(['production', 'shadow'])
const VALID_SYSTEMS = new Set(['oracle', 'current', 'old'])
const VALID_EVENT_TYPES = new Set([
  'decision', 'health_check', 'heartbeat', 'config_change', 'error',
])
const VALID_SIDES = new Set(['YES', 'NO'])
const VALID_STATUS = new Set([
  'success', 'error', 'timeout', 'skipped', 'fail_closed',
])
const VALID_SEVERITIES = new Set(['info', 'warn', 'error', 'critical'])

// Required fields for ALL events
const REQUIRED_BASE = [
  'id', 'decision_id', 'trace_schema_version', 'created_at',
  'layer_name', 'layer_version', 'commit_hash', 'agent_id', 'agent_version',
  'environment', 'mode', 'system', 'event_type',
  'decision', 'reason_code', 'reasoning', 'metrics',
  'evidence_used', 'input_hash', 'output_hash',
  'status', 'severity', 'latency_ms',
]

// Required additionally for event_type === 'decision'
const REQUIRED_FOR_DECISION = [
  'pitcher_id', 'pitcher_name', 'bet_date', 'strike', 'side',
]

class ValidationError extends Error {
  constructor(field, message) {
    super(`TraceEvent validation failed: ${field}: ${message}`)
    this.field = field
    this.name = 'TraceEventValidationError'
  }
}

/**
 * Validate a TraceEvent. Throws ValidationError on any issue.
 * Returns the event unchanged if valid.
 *
 * Why hand-rolled: the spec's hard rule is "invalid events throw."
 * Zod would also throw, but adding a dep for ~80 lines of validation
 * isn't worth it.
 */
export function validateTraceEvent(ev) {
  if (!ev || typeof ev !== 'object') {
    throw new ValidationError('event', 'must be an object')
  }

  // Required base fields
  for (const f of REQUIRED_BASE) {
    if (ev[f] === undefined || ev[f] === null) {
      throw new ValidationError(f, 'required field missing or null')
    }
  }

  // Type checks on critical fields
  if (typeof ev.id !== 'string' || ev.id.length === 0) {
    throw new ValidationError('id', 'must be non-empty string')
  }
  if (typeof ev.decision_id !== 'string' || ev.decision_id.length === 0) {
    throw new ValidationError('decision_id', 'must be non-empty string')
  }
  if (ev.trace_schema_version !== TRACE_SCHEMA_VERSION) {
    throw new ValidationError('trace_schema_version',
      `expected '${TRACE_SCHEMA_VERSION}', got '${ev.trace_schema_version}'`)
  }
  if (!VALID_LAYERS.has(ev.layer_name)) {
    throw new ValidationError('layer_name',
      `must be one of [${[...VALID_LAYERS].join(', ')}], got '${ev.layer_name}'`)
  }
  if (!VALID_MODES.has(ev.mode)) {
    throw new ValidationError('mode', `must be 'production' or 'shadow', got '${ev.mode}'`)
  }
  if (!VALID_SYSTEMS.has(ev.system)) {
    throw new ValidationError('system', `must be one of [oracle, current, old], got '${ev.system}'`)
  }
  if (!VALID_EVENT_TYPES.has(ev.event_type)) {
    throw new ValidationError('event_type',
      `must be one of [${[...VALID_EVENT_TYPES].join(', ')}], got '${ev.event_type}'`)
  }
  if (!VALID_STATUS.has(ev.status)) {
    throw new ValidationError('status',
      `must be one of [${[...VALID_STATUS].join(', ')}], got '${ev.status}'`)
  }
  if (!VALID_SEVERITIES.has(ev.severity)) {
    throw new ValidationError('severity',
      `must be one of [${[...VALID_SEVERITIES].join(', ')}], got '${ev.severity}'`)
  }
  if (typeof ev.latency_ms !== 'number' || ev.latency_ms < 0) {
    throw new ValidationError('latency_ms', 'must be non-negative number')
  }

  // ISO-8601 created_at
  if (typeof ev.created_at !== 'string' || isNaN(Date.parse(ev.created_at))) {
    throw new ValidationError('created_at', 'must be valid ISO-8601 timestamp')
  }

  // Side values
  if (ev.side != null && !VALID_SIDES.has(ev.side)) {
    throw new ValidationError('side', `must be 'YES' or 'NO' or null, got '${ev.side}'`)
  }

  // For decision events, additional fields required
  if (ev.event_type === 'decision') {
    for (const f of REQUIRED_FOR_DECISION) {
      if (ev[f] === undefined || ev[f] === null) {
        throw new ValidationError(f, `required for event_type='decision'`)
      }
    }
    if (typeof ev.strike !== 'number' || ev.strike < 0) {
      throw new ValidationError('strike', 'must be non-negative number')
    }
  }

  // evidence_used must be an array of {name, id, input_hash}
  if (!Array.isArray(ev.evidence_used)) {
    throw new ValidationError('evidence_used', 'must be array')
  }
  for (let i = 0; i < ev.evidence_used.length; i++) {
    const e = ev.evidence_used[i]
    if (!e || typeof e !== 'object') {
      throw new ValidationError(`evidence_used[${i}]`, 'must be object')
    }
    if (typeof e.name !== 'string' || typeof e.id !== 'string' || typeof e.input_hash !== 'string') {
      throw new ValidationError(`evidence_used[${i}]`,
        'must have string {name, id, input_hash}')
    }
  }

  // reasoning and metrics must be objects (we store as JSON strings in DB)
  if (typeof ev.reasoning !== 'object' || Array.isArray(ev.reasoning)) {
    throw new ValidationError('reasoning', 'must be object (will be JSON-encoded)')
  }
  if (typeof ev.metrics !== 'object' || Array.isArray(ev.metrics)) {
    throw new ValidationError('metrics', 'must be object (will be JSON-encoded)')
  }

  // Hash format check (sha256 hex = 64 chars)
  for (const f of ['input_hash', 'output_hash']) {
    if (typeof ev[f] !== 'string' || !/^[a-f0-9]{64}$/.test(ev[f])) {
      throw new ValidationError(f, 'must be sha256 hex (64 lowercase hex chars)')
    }
  }

  return ev
}

/**
 * Convenience: check if validation would pass without throwing.
 * Returns { valid: bool, error: string|null }.
 */
export function tryValidateTraceEvent(ev) {
  try {
    validateTraceEvent(ev)
    return { valid: true, error: null }
  } catch (err) {
    return { valid: false, error: err.message }
  }
}

export { ValidationError }
