// lib/cageAlerts.js — Critical / silent alerts for the live trading cage
//
// Two tiers:
//   CRITICAL — LOUD, prepends "@here" to ping the channel. Used for halts,
//              reconciliation mismatches, trace orphans, COMMIT_SHA mismatches,
//              and lost component heartbeats. NEVER batched.
//   SILENT   — In-channel, no mention. Used for fire confirmations, EOD
//              summaries, and OK heartbeats. Fires can be batched (5+ in 60s
//              collapse into a single message) when DISCORD_BATCH_FIRES=true.
//
// All exports return Promise<{ ok, error?, status_code? }>. Errors are caught
// and surfaced via the result — never thrown — so a Discord outage never
// breaks the trading pipeline.
//
// Env vars:
//   DISCORD_WEBHOOK_URL      — required; primary destination
//   DISCORD_BATCH_FIRES      — 'false' to disable fire batching (default: enabled)
//   DISCORD_ERRORS_ONLY      — 'true' (default) suppresses all SILENT alerts
//                              (fires, EOD, heartbeat OK) — only CRITICAL fires.
//                              The user wanted error-only on a personal channel
//                              to keep the channel quiet during normal operation.

import 'dotenv/config'

export const ALERT_LEVELS = Object.freeze({
  CRITICAL: 'critical',
  SILENT:   'silent',
})

// ── Module state (in-memory; single-process is fine for the cage) ────────────

const FIRE_BATCH_WINDOW_MS = 60_000
const FIRE_BATCH_THRESHOLD = 5         // 5+ fires in window → collapse to one
const _fireBuffer        = []           // [{ ts, content, meta }]
let   _fireFlushTimer    = null

// ── Internal Discord sender ──────────────────────────────────────────────────

/**
 * Post a message to a Discord webhook.
 * Adds "@here " prefix + allowed_mentions for CRITICAL; plain content for SILENT.
 * Best-effort — catches errors and returns { ok, error?, status_code? }.
 */
export async function postWebhook({ webhookUrl, content, level }) {
  const url = webhookUrl || process.env.DISCORD_WEBHOOK_URL
  if (!url) {
    console.warn('[cageAlerts] DISCORD_WEBHOOK_URL not configured — alert dropped')
    return { ok: false, error: 'no_webhook_configured' }
  }
  if (!content) {
    return { ok: false, error: 'empty_content' }
  }

  const isCritical = level === ALERT_LEVELS.CRITICAL
  const body = {
    content: isCritical ? `@here ${content}` : content,
    allowed_mentions: isCritical ? { parse: ['everyone'] } : { parse: [] },
  }

  try {
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    })
    if (!res.ok) {
      let detail = ''
      try { detail = await res.text() } catch {}
      return { ok: false, error: 'http_error', status_code: res.status, detail: detail?.slice(0, 200) }
    }
    return { ok: true, status_code: res.status }
  } catch (err) {
    return { ok: false, error: err?.message || 'fetch_failed' }
  }
}

// ── CRITICAL alerts (LOUD, never batched) ────────────────────────────────────

export async function alertHalt({ reason, detail, user_id }) {
  const userTag = user_id ? ` ${user_id}` : ''
  const detailTag = detail ? ` (${detail})` : ''
  const content = `🛑 HALT — ${reason}${userTag}${detailTag}; live trading off`
  return postWebhook({ content, level: ALERT_LEVELS.CRITICAL })
}

export async function alertReconciliationMismatch({ user_id, user_name, mismatches }) {
  const arr = Array.isArray(mismatches) ? mismatches : []
  const top = arr[0]
  const topStr = top
    ? (typeof top === 'string'
        ? top
        // mismatches use kalshi_qty/db_qty (per lib/reconciliation.js); accept legacy
        // local/broker keys as a fallback so old payloads still render readably.
        : `${top.type || 'mismatch'} ${top.ticker || 'unknown'} kalshi=${top.kalshi_qty ?? top.broker ?? '?'} db=${top.db_qty ?? top.local ?? '?'}`)
    : 'n/a'
  const who = user_name || user_id || 'unknown'
  const content = `🚨 RECON MISMATCH ${who}: ${arr.length} positions diverge — TRADING HALTED. Top: ${topStr}`
  return postWebhook({ content, level: ALERT_LEVELS.CRITICAL })
}

export async function alertTraceOrphan({ rows }) {
  const arr = Array.isArray(rows) ? rows : []
  const ids = arr.slice(0, 10).map(r => r?.id ?? r?.bet_id ?? r).join(', ')
  const more = arr.length > 10 ? ` (+${arr.length - 10} more)` : ''
  const content = `❗ TRACE ORPHAN — ${arr.length} ks_bets rows have no oracle_bet_traces — HALTED. ${ids}${more}`
  return postWebhook({ content, level: ALERT_LEVELS.CRITICAL })
}

export async function alertCommitMismatch({ expected, actual }) {
  const content = `❗ COMMIT_SHA MISMATCH — expected ${expected ?? '?'}, deployed ${actual ?? '?'}`
  return postWebhook({ content, level: ALERT_LEVELS.CRITICAL })
}

export async function alertHeartbeatLost({ component, last_seen_seconds_ago }) {
  const ago = Number.isFinite(last_seen_seconds_ago) ? Math.round(last_seen_seconds_ago) : '?'
  const content = `❗ ${component || 'component'} heartbeat lost ${ago}s ago`
  return postWebhook({ content, level: ALERT_LEVELS.CRITICAL })
}

// ── SILENT alerts (in-channel, no mention) ───────────────────────────────────

/**
 * Fire confirmation. Batches into a single message when 5+ fires arrive within
 * a 60s window (set DISCORD_BATCH_FIRES=false to send each immediately).
 *
 * Suppressed entirely when DISCORD_ERRORS_ONLY=true (default Day 1 posture —
 * keep the personal alert channel quiet; only critical halts/mismatches ping).
 */
export async function notifyFire({
  user_name, pitcher, strike, side, price_cents, contracts, tier, strategy_mode,
}) {
  if (String(process.env.DISCORD_ERRORS_ONLY ?? 'true').toLowerCase() === 'true') {
    return { ok: true, suppressed: 'errors_only' }
  }
  const line =
    `🟢 FIRE ${user_name || '?'} K${strike ?? '?'}+ ${side || '?'} ${pitcher || '?'} ` +
    `${price_cents ?? '?'}¢ ×${contracts ?? '?'} tier=${tier ?? '?'}` +
    (strategy_mode ? ` mode=${strategy_mode}` : '')

  const batchEnabled = String(process.env.DISCORD_BATCH_FIRES ?? 'true').toLowerCase() !== 'false'
  if (!batchEnabled) {
    return postWebhook({ content: line, level: ALERT_LEVELS.SILENT })
  }

  // Buffer and decide whether to flush now or schedule a flush.
  const now = Date.now()
  _fireBuffer.push({ ts: now, content: line })

  // Drop expired entries
  while (_fireBuffer.length && now - _fireBuffer[0].ts > FIRE_BATCH_WINDOW_MS) {
    _fireBuffer.shift()
  }

  // If we've crossed the batch threshold within the window, collapse + send now.
  if (_fireBuffer.length >= FIRE_BATCH_THRESHOLD) {
    const count  = _fireBuffer.length
    const latest = _fireBuffer[_fireBuffer.length - 1].content
    _fireBuffer.length = 0
    if (_fireFlushTimer) { clearTimeout(_fireFlushTimer); _fireFlushTimer = null }
    const content = `🟢 ${count} fires in last minute, latest: ${latest}`
    return postWebhook({ content, level: ALERT_LEVELS.SILENT })
  }

  // Below threshold — send this one immediately, but if more pile up they'll batch.
  // Schedule a passive flush of the buffer (no-op if already cleared).
  if (!_fireFlushTimer) {
    _fireFlushTimer = setTimeout(() => {
      _fireFlushTimer = null
      // Just clear stale entries; individual fires were already sent.
      const cutoff = Date.now() - FIRE_BATCH_WINDOW_MS
      while (_fireBuffer.length && _fireBuffer[0].ts < cutoff) _fireBuffer.shift()
    }, FIRE_BATCH_WINDOW_MS + 1_000)
    if (_fireFlushTimer.unref) _fireFlushTimer.unref()
  }

  return postWebhook({ content: line, level: ALERT_LEVELS.SILENT })
}

/**
 * EOD summary. summary = {
 *   total_pnl, inversion_pnl?, live_pnl?,
 *   fires, fires_inversion?, fires_live?,
 *   skips_total?, skips_by_reason: { cap, stale_quote, model_filter, ... },
 *   by_user: { 'Adam-Live': 12, Isaiah: -8, global: 4 },
 *   by_strategy: { inversion: 12, live: -4, ... },
 * }
 */
export async function notifyEod({ date, summary }) {
  // The EOD report is opt-in: DISCORD_DAILY_REPORT_ENABLED=true bypasses
  // errors-only because the user explicitly asked for one daily summary
  // post even when routine alerts are suppressed.
  const dailyOptIn = String(process.env.DISCORD_DAILY_REPORT_ENABLED ?? '').toLowerCase() === 'true'
  if (!dailyOptIn && String(process.env.DISCORD_ERRORS_ONLY ?? 'true').toLowerCase() === 'true') {
    return { ok: true, suppressed: 'errors_only' }
  }
  const s = summary || {}
  const fmt = n => {
    if (!Number.isFinite(n)) return '$0.00'
    const v = Number(n)
    return (v >= 0 ? '$+' : '$-') + Math.abs(v).toFixed(2)
  }
  const fmtUser = n => {
    if (!Number.isFinite(n)) return '$0'
    const v = Number(n)
    return (v >= 0 ? '$+' : '$-') + Math.abs(v).toFixed(0)
  }

  const lines = [`📊 EOD ${date || ''}`.trim()]

  // Mode banner — clearly mark paper-only days so the report can't be misread as live results
  if (s.mode) lines.push(`Mode: ${s.mode}`)

  // Live P&L (real money) — top line, since this is what bankroll moves on
  if (s.live) {
    const L = s.live
    const csTag = (L.cross_strike_fires ?? 0) > 0 ? ` | 📐 cross-strike ${L.cross_strike_fires}f ${fmt(L.cross_strike_pnl)}` : ''
    lines.push(`Live: ${L.fires ?? 0} fires · P&L total ${fmt(L.total_pnl)} | inversion ${fmt(L.inversion_pnl)} | tier1 ${fmt(L.tier1_pnl)} tier2 ${fmt(L.tier2_pnl)} tier3 ${fmt(L.tier3_pnl)}${csTag}`)
  }

  // Paper P&L (synthetic fills) — same shape so we can compare side-by-side
  if (s.paper) {
    const P = s.paper
    const csTag = (P.cross_strike_fires ?? 0) > 0 ? ` | 📐 cross-strike ${P.cross_strike_fires}f ${fmt(P.cross_strike_pnl)}` : ''
    lines.push(`Paper: ${P.fires ?? 0} fires · P&L total ${fmt(P.total_pnl)} | inversion ${fmt(P.inversion_pnl)} | tier1 ${fmt(P.tier1_pnl)} tier2 ${fmt(P.tier2_pnl)} tier3 ${fmt(P.tier3_pnl)}${csTag}`)
  }

  // Legacy flat-summary path (back-compat for callers that haven't updated)
  if (!s.live && !s.paper) {
    const totalPnl     = Number(s.total_pnl ?? 0)
    const inversionPnl = Number(s.inversion_pnl ?? 0)
    const livePnl      = Number(s.live_pnl ?? 0)
    lines.push(`P&L: total ${fmt(totalPnl)} | inversion ${fmt(inversionPnl)} | live ${fmt(livePnl)}`)
    const fires = Number(s.fires ?? 0)
    const fInv  = Number(s.fires_inversion ?? 0)
    const fLive = Number(s.fires_live ?? 0)
    lines.push(`Fires: ${fires}` + ((fInv || fLive) ? ` (${fInv} inversion, ${fLive} live)` : ''))
  }

  // Skips line
  const skipsByReason = s.skips_by_reason || {}
  const skipKeys = Object.keys(skipsByReason)
  const skipsTotal = Number.isFinite(s.skips_total)
    ? Number(s.skips_total)
    : skipKeys.reduce((a, k) => a + Number(skipsByReason[k] || 0), 0)
  if (skipsTotal || skipKeys.length) {
    const skipDetail = skipKeys.length
      ? ' (' + skipKeys.map(k => `${k}=${skipsByReason[k]}`).join(', ') + ')'
      : ''
    lines.push(`Skips: ${skipsTotal}${skipDetail}`)
  }

  // By user
  const byUser = s.by_user || {}
  const userKeys = Object.keys(byUser)
  if (userKeys.length) {
    lines.push('By user: ' + userKeys.map(u => `${u} ${fmtUser(byUser[u])}`).join(' / '))
  }

  // Top winners / losers if provided (max 5 each)
  const top = Array.isArray(s.top_results) ? s.top_results.slice(0, 8) : []
  if (top.length) {
    lines.push('Top: ' + top.map(t => `${t.icon ?? ''} ${t.label} ${fmtUser(t.pnl)}`).join(' / '))
  }

  // Shadow inversion audit — appended as its own block so the eye can scan it
  const shadowLines = Array.isArray(s.shadow_lines) ? s.shadow_lines : []
  if (shadowLines.length) {
    lines.push('Shadow inversion:')
    for (const sl of shadowLines) lines.push(`  ${sl}`)
  }

  // Shadow calibrated-YES audit — alternate strategy comparison
  const calYesLines = Array.isArray(s.calibrated_yes_lines) ? s.calibrated_yes_lines : []
  if (calYesLines.length) {
    lines.push('Shadow calibrated YES:')
    for (const cl of calYesLines) lines.push(`  ${cl}`)
  }

  // Calibrate-Kelly audit — same fires, calibrated sizing
  const ckLines = Array.isArray(s.calibrate_kelly_lines) ? s.calibrate_kelly_lines : []
  if (ckLines.length) {
    lines.push('Calibrate-Kelly shadow:')
    for (const cl of ckLines) lines.push(`  ${cl}`)
  }

  // Full-distribution audit — what blocked candidates would have done
  const fdLines = Array.isArray(s.full_distribution_lines) ? s.full_distribution_lines : []
  if (fdLines.length) {
    lines.push('Full-distribution shadow (blocked by filters):')
    for (const fl of fdLines) lines.push(`  ${fl}`)
  }

  // Pending rule evaluations — running 14-day shadow stats per candidate rule
  const prLines = Array.isArray(s.pending_rule_lines) ? s.pending_rule_lines : []
  if (prLines.length) {
    lines.push('Pending rule evaluations (14-day rolling):')
    for (const pl of prLines) lines.push(`  ${pl}`)
  }

  return postWebhook({ content: lines.join('\n'), level: ALERT_LEVELS.SILENT })
}

// Pre-fire summary — what the system is about to place, with calibrated-YES
// shadow context inline. Lets the user see "here's what raw-YES is firing,
// here's what calibrated would skip, here's the Civale-style risk picks"
// before contracts are placed. Opt-in: DISCORD_PREFIRE_REPORT_ENABLED=true.
export async function notifyPrefireSummary({ bettorName, sized, betDate }) {
  const optIn = String(process.env.DISCORD_PREFIRE_REPORT_ENABLED ?? '').toLowerCase() === 'true'
  if (!optIn) return { ok: true, suppressed: 'prefire_disabled' }
  if (!sized?.length) return { ok: true, suppressed: 'no_fires' }

  // Mirror calibration buckets from scripts/live/ksBets.js. If those change,
  // mirror here too. Used to tag each pick with "cal: fire" or "cal: skip".
  function calProb(p) {
    if (p < 0.42) return 0.06
    if (p < 0.52) return 0.24
    if (p < 0.65) return 0.33
    return 0.42
  }
  const FEE = 0.07
  const CALIB_EDGE_THRESHOLD = 0.03  // matches shadow edge≥0.03 bucket

  const totalRisk = sized.reduce((s, e) => s + (e._actualRisk ?? 0), 0)
  const lines = [`🎯 Pre-fire — ${bettorName} (${betDate})  ${sized.length} bets · $${totalRisk.toFixed(0)} risk`]

  let calibSkipCount = 0, csCount = 0
  const civaleRisk = []
  for (const e of sized) {
    const cap     = Number(e._actualRisk ?? 0)
    const yesAsk  = Math.min(99, (Number(e.market_mid ?? 50) + Number(e.spread ?? 4) / 2)) / 100
    const cp      = calProb(Number(e.model_prob))
    const feeAdj  = yesAsk + (FEE * Math.min(yesAsk, 1 - yesAsk))
    const calEdge = cp - feeAdj
    const calibSkip = calEdge < CALIB_EDGE_THRESHOLD
    if (calibSkip) calibSkipCount++

    // Civale-style flag: low strike + mid confidence + non-trivial size
    const isCivaleStyle = Number(e.strike) <= 5 && Number(e.model_prob) >= 0.50 && Number(e.model_prob) < 0.60 && cap > 10
    if (isCivaleStyle) civaleRisk.push(`${e.pitcher} K${e.strike}`)

    // Cross-Strike fires get distinct visual marker — math-based, not model-based
    const isCS = e.strategy_mode === 'pregame_cross_strike'
    if (isCS) csCount++

    const calTag = isCS
      ? `cs-resid${e.cross_strike_residual != null ? (e.cross_strike_residual >= 0 ? '+' : '') + (e.cross_strike_residual * 100).toFixed(0) + '¢' : ''}`
      : (calibSkip ? 'cal: skip' : 'cal: fire')
    const flag = isCivaleStyle ? ' 🚨' : isCS ? ' 📐' : ''
    lines.push(`  ${e.side}${e.strike} ${String(e.pitcher).padEnd(20).slice(0, 20)} mp=${Number(e.model_prob).toFixed(2)} cap=$${cap.toFixed(0)} (${calTag})${flag}`)
  }
  if (csCount > 0) {
    lines.push(`📐 Cross-Strike fires: ${csCount}`)
  }

  if (calibSkipCount > 0) {
    lines.push(`Calibrated YES (edge≥${CALIB_EDGE_THRESHOLD}) would skip ${calibSkipCount}/${sized.length}`)
  }
  if (civaleRisk.length > 0) {
    lines.push(`🚨 Civale-style risk (low-K + mid-confidence + sized): ${civaleRisk.join(', ')}`)
  }

  return postWebhook({ content: lines.join('\n'), level: ALERT_LEVELS.SILENT })
}

/**
 * OK heartbeat. Silent + cheap; meant for batched 60s pulses.
 * Currently posts a one-line message to the cage channel.
 */
export async function notifyHeartbeatOk({ component }) {
  if (String(process.env.DISCORD_ERRORS_ONLY ?? 'true').toLowerCase() === 'true') {
    return { ok: true, suppressed: 'errors_only' }
  }
  const content = `💚 ${component || 'cage'} heartbeat ok`
  return postWebhook({ content, level: ALERT_LEVELS.SILENT })
}

// ── Smoke test (commented; uncomment + run with `node lib/cageAlerts.js`) ────
//
// (async () => {
//   process.env.DISCORD_WEBHOOK_URL ||= 'https://discord.com/api/webhooks/.../...'
//   console.log(await alertHalt({ reason: 'recon_mismatch', detail: 'positions diverge', user_id: 'adam-live' }))
//   console.log(await alertReconciliationMismatch({
//     user_id: 'adam-live',
//     user_name: 'Adam-Live',
//     mismatches: [{ ticker: 'KXMLBKS-26MAY03SDLAD-T7', local: 12, broker: 10 }, { ticker: 'X', local: 1, broker: 2 }],
//   }))
//   console.log(await alertTraceOrphan({ rows: [{ id: 101 }, { id: 102 }, { id: 103 }] }))
//   console.log(await alertCommitMismatch({ expected: 'abc1234', actual: 'def5678' }))
//   console.log(await alertHeartbeatLost({ component: 'liveMonitor', last_seen_seconds_ago: 187 }))
//   console.log(await notifyFire({
//     user_name: 'Adam-Live', pitcher: 'Skenes', strike: 7, side: 'YES',
//     price_cents: 42, contracts: 5, tier: 'A', strategy_mode: 'live',
//   }))
//   console.log(await notifyEod({
//     date: '2026-05-03',
//     summary: {
//       total_pnl: 8, inversion_pnl: 12, live_pnl: -4,
//       fires: 5, fires_inversion: 3, fires_live: 2,
//       skips_total: 12, skips_by_reason: { cap: 4, stale_quote: 3, model_filter: 5 },
//       by_user: { 'Adam-Live': 12, Isaiah: -8, global: 4 },
//       by_strategy: { inversion: 12, live: -4 },
//     },
//   }))
//   console.log(await notifyHeartbeatOk({ component: 'cage' }))
// })()
