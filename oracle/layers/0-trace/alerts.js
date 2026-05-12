// oracle/layers/0-trace/alerts.js
//
// ORACLE-HEALTH Discord alerts for Trace operational health.
// Per spec.md §5b — Adam-only dedicated webhook, with fallback prefix.
//
// Triggers covered (from locked spec):
//   - Trace write failure (sync or async, after retry)
//   - Trace queue backlog (>500 events OR oldest >60s)
//   - Gateway rejection (DB / killswitch / version mismatch)
//   - Stale Closer / agent version detected
//   - Oracle enabled / disabled
//   - DB outage / recovery
//   - Replay-integrity mismatch (>1%)
//   - Health probe failed 2+ consecutive times
//   - Settlement lag >24h on >5 bets
//
// Dedup: same (trigger, hour) won't fire more than once per hour.

const ORACLE_HEALTH_WEBHOOK_URL = process.env.ORACLE_HEALTH_WEBHOOK_URL || null

// Fallback to existing Adam webhook with [ORACLE-HEALTH] prefix when dedicated isn't set
const FALLBACK_WEBHOOK_URL =
  process.env.ADAM_WEBHOOK_URL ||
  'https://discord.com/api/webhooks/1495964427382558740/e6Q7pZPQWSjghWSx9XYYeXWBVXIFV1kPvSG-lmE9YSDiRbnaABSLCvYTUUNLE_Feer6W'

// In-memory dedup: trigger+hour key → last-sent timestamp
const _dedupMap = new Map()
const _DEDUP_WINDOW_MS = 60 * 60 * 1000  // 1 hour

const SEVERITY_COLORS = {
  info:     0x3498db,  // blue
  warn:     0xf39c12,  // orange
  error:    0xe74c3c,  // red
  critical: 0x8b0000,  // dark red
}

const SEVERITY_EMOJI = {
  info:     'ℹ️',
  warn:     '⚠️',
  error:    '❌',
  critical: '🚨',
}

/**
 * Send an ORACLE-HEALTH alert.
 *
 * @param {object} args
 * @param {string} args.trigger - one of the locked trigger types
 * @param {string} args.severity - 'info' | 'warn' | 'error' | 'critical'
 * @param {string} args.title - short title
 * @param {string} args.detail - longer description (markdown OK)
 * @param {object} [args.context] - structured context (key-value pairs displayed as fields)
 * @param {boolean} [args.bypassDedup] - if true, skip dedup check (for tests / forced alerts)
 */
export async function alertOracleHealth({ trigger, severity = 'critical', title, detail, context = {}, bypassDedup = false }) {
  if (!trigger || !title) {
    throw new Error('alertOracleHealth requires trigger and title')
  }

  // Dedup check: same trigger within the same hour-bucket
  const hourBucket = Math.floor(Date.now() / _DEDUP_WINDOW_MS)
  const dedupKey = `${trigger}|${hourBucket}`
  if (!bypassDedup && _dedupMap.has(dedupKey)) {
    return { sent: false, reason: 'deduped' }
  }
  _dedupMap.set(dedupKey, Date.now())
  _purgeOldDedupEntries()

  const isDedicated = !!ORACLE_HEALTH_WEBHOOK_URL
  const webhookUrl = ORACLE_HEALTH_WEBHOOK_URL || FALLBACK_WEBHOOK_URL
  const titlePrefix = isDedicated ? '' : '[ORACLE-HEALTH] '

  const fields = Object.entries(context).slice(0, 25).map(([k, v]) => ({
    name: k,
    value: String(v).slice(0, 1024),  // Discord limits field value length
    inline: true,
  }))

  const embed = {
    title: `${SEVERITY_EMOJI[severity] ?? ''} ${titlePrefix}${title}`,
    description: (detail ?? '').slice(0, 4000),
    color: SEVERITY_COLORS[severity] ?? SEVERITY_COLORS.error,
    timestamp: new Date().toISOString(),
    footer: { text: `Oracle Trace · trigger=${trigger}` },
    fields,
  }

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] }),
    })
    if (!res.ok) {
      console.error(`[oracle.alerts] webhook returned ${res.status}: ${await res.text().catch(() => '')}`)
      return { sent: false, reason: `webhook_status_${res.status}` }
    }
    return { sent: true, dedicated: isDedicated }
  } catch (err) {
    console.error(`[oracle.alerts] webhook fetch failed: ${err.message}`)
    return { sent: false, reason: 'webhook_fetch_failed', error: err.message }
  }
}

function _purgeOldDedupEntries() {
  const cutoff = Date.now() - 2 * _DEDUP_WINDOW_MS  // keep 2 hours of history just in case
  for (const [k, ts] of _dedupMap) {
    if (ts < cutoff) _dedupMap.delete(k)
  }
}

/**
 * Trace's critical-failure handler. Wired into trace impl via
 * setCriticalFailureHandler. Routes errors to ORACLE-HEALTH.
 */
export function makeTraceCriticalHandler() {
  return async function onTraceCritical({ reason, event, error }) {
    const triggerMap = {
      write_failed:                  'trace_write_failure',
      write_failed_after_retry:      'trace_write_failure',
      async_write_failed:            'trace_write_failure',
      queue_overflow_drop:           'trace_queue_overflow',
      shutdown_drained_incomplete:   'trace_shutdown_incomplete',
    }
    const trigger = triggerMap[reason] || `trace_${reason}`
    const severity = (reason === 'queue_overflow_drop') ? 'critical' : 'critical'

    const context = {
      reason,
      error: error?.message?.slice(0, 200) ?? '(no error)',
    }
    if (event?.decision_id) context.decision_id = event.decision_id
    if (event?.layer_name) context.layer = event.layer_name
    if (event?.pitcher_name) context.pitcher = event.pitcher_name

    await alertOracleHealth({
      trigger,
      severity,
      title: `Trace failure: ${reason}`,
      detail: error?.message ?? 'No error message',
      context,
    }).catch(e => {
      console.error('[oracle.alerts] handler itself failed:', e?.message)
    })
  }
}

/**
 * Backlog monitor — call this periodically to detect queue health issues.
 * Per spec §7: alert if queue.length > 500 OR oldest_age_ms > 60_000.
 */
export async function checkQueueBacklog(queueStats) {
  const { length, oldest_age_ms } = queueStats

  if (length > 500) {
    await alertOracleHealth({
      trigger: 'trace_queue_backlog_length',
      severity: 'critical',
      title: `Trace queue backlog: ${length} events`,
      detail: `Async write queue has ${length} events pending DB flush (threshold: 500). Either burst load or stuck flusher.`,
      context: { queue_length: length, oldest_age_ms },
    })
    return { alerted: 'length' }
  }

  if (oldest_age_ms > 60_000) {
    await alertOracleHealth({
      trigger: 'trace_queue_backlog_age',
      severity: 'critical',
      title: `Trace queue stuck`,
      detail: `Oldest unflushed event is ${Math.round(oldest_age_ms / 1000)}s old (threshold: 60s). Flusher may be stuck.`,
      context: { queue_length: length, oldest_age_seconds: Math.round(oldest_age_ms / 1000) },
    })
    return { alerted: 'age' }
  }

  return { alerted: null }
}

// Test helper — clear dedup state between runs
export function _clearDedupForTesting() {
  _dedupMap.clear()
}
