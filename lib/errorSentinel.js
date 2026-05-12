// lib/errorSentinel.js — Real-time error alerting for live trading.
//
// Sends raw errors to Adam's Discord webhook the moment they happen.
// No AI processing — just the error, stack, and context so you can act fast.
//
// Wire-in points:
//   watchProcess()       — call once at server startup (uncaught exceptions)
//   alertError(src, err, ctx) — call from any catch block
//   wrapCron(name, fn)   — wraps a cron callback so crashes get reported

import 'dotenv/config'

const ADAM_WEBHOOK =
  process.env.ADAM_WEBHOOK_URL ||
  'https://discord.com/api/webhooks/1495964427382558740/e6Q7pZPQWSjghWSx9XYYeXWBVXIFV1kPvSG-lmE9YSDiRbnaABSLCvYTUUNLE_Feer6W'

// Dedup: same error message+source → max 1 alert per 5 min
const _seen = new Map()
const COOLDOWN_MS = 5 * 60 * 1000

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Send a raw error alert to Adam's Discord.
 *
 * @param {string} source  — human label: 'scheduler', 'liveMonitor', 'gamePulse', etc.
 * @param {Error|string} err
 * @param {object} [ctx]   — optional key/value context: { pitcher, game, phase, ... }
 */
export async function alertError(source, err, ctx = {}) {
  try {
    const errObj = err instanceof Error ? err : new Error(String(err))
    const fp     = `${source}|${errObj.message.slice(0, 60)}`

    const now = Date.now()
    if (_seen.has(fp) && now - _seen.get(fp) < COOLDOWN_MS) return
    _seen.set(fp, now)

    await _send(source, errObj, ctx)
  } catch { /* never let the sentinel crash anything */ }
}

/**
 * Hook process-level uncaught exceptions and unhandled rejections.
 * Call once at the top of server/index.js or scheduler.js startup.
 */
export function watchProcess() {
  process.on('uncaughtException', (err) => {
    alertError('uncaughtException', err, { fatal: true }).catch(() => {})
    // Give Discord time to send before process might exit
    setTimeout(() => {}, 3000)
  })

  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason))
    alertError('unhandledRejection', err).catch(() => {})
  })

  console.log('[errorSentinel] watching for uncaught errors')
}

/**
 * Wrap a cron/loop callback — any throw gets reported then re-thrown.
 *
 * @param {string} name   — label for the alert
 * @param {Function} fn   — async function to wrap
 */
export function wrapCron(name, fn) {
  return async (...args) => {
    try {
      return await fn(...args)
    } catch (err) {
      await alertError(name, err)
      throw err
    }
  }
}

// ── Discord send ──────────────────────────────────────────────────────────────

async function _send(source, err, ctx) {
  const stack  = _cleanStack(err.stack ?? '')
  const ctxStr = Object.entries(ctx)
    .filter(([, v]) => v != null)
    .map(([k, v]) => `**${k}:** \`${String(v).slice(0, 120)}\``)
    .join('\n')

  const isFatal = ctx.fatal === true

  const lines = [
    `**Source:** \`${source}\``,
    `**Error:** \`\`\`\n${err.message.slice(0, 400)}\n\`\`\``,
    stack ? `**Stack:**\n\`\`\`\n${stack}\n\`\`\`` : '',
    ctxStr || '',
  ].filter(Boolean).join('\n')

  await fetch(ADAM_WEBHOOK, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      embeds: [{
        title:       `${isFatal ? '💀 FATAL' : '🚨 Error'} — ${source}`,
        description: lines.slice(0, 3800),
        color:       isFatal ? 0x8B0000 : 0xFF4444,
        timestamp:   new Date().toISOString(),
        footer:      { text: 'errorSentinel · baseball' },
      }],
    }),
  }).catch(() => {})
}

function _cleanStack(stack) {
  return stack
    .split('\n')
    .filter(l => !l.includes('node_modules') && (l.includes('/baseball/') || /^\s*Error/.test(l)))
    .slice(0, 10)
    .join('\n')
    .trim()
}
