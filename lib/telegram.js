// lib/telegram.js — Telegram alert helper
// No-op if TELEGRAM_BOT_TOKEN is not set (so paper-only dev runs don't fail).

import TelegramBot from 'node-telegram-bot-api'
import 'dotenv/config'

let _bot = null
function bot() {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) return null
  if (_bot) return _bot
  _bot = new TelegramBot(token, { polling: false })
  return _bot
}

/**
 * Low-level send. Silently noops if config is missing, logs to console
 * if the API returns an error (we never want an alert failure to crash
 * the trading pipeline).
 */
export async function send(text, { parseMode = 'Markdown', silent = false } = {}) {
  const chatId = process.env.TELEGRAM_CHAT_ID
  const b = bot()
  if (!b || !chatId) {
    // Dev fallback — log to console so we can see what would have been sent
    console.log('[telegram:dry]', text)
    return { ok: true, dry: true }
  }
  try {
    await b.sendMessage(chatId, text, {
      parse_mode: parseMode,
      disable_notification: silent,
    })
    return { ok: true }
  } catch (err) {
    console.error('[telegram] send failed:', err.message)
    return { ok: false, error: err.message }
  }
}

// ------------------------------------------------------------------
// High-level helpers
// ------------------------------------------------------------------
export async function alertTradeSignal({ game, decision }) {
  const edge = (decision.adjusted_edge * 100).toFixed(1)
  const prob = (decision.model_probability * 100).toFixed(1)
  const msg = `*MLBIE — Trade Signal*
\`${game.team_away} @ ${game.team_home}\`  \`${game.id}\`
Side: *${decision.recommended_side}* ${decision.line ?? ''}
Edge: *${edge}%*  (model ${prob}% vs market ${(decision.market_implied_probability * 100).toFixed(1)}%)
Size: *$${decision.position_size}*
Driver: ${decision.agent_attribution?.primary_driver}
${decision.explanation}`
  return send(msg)
}

export async function alertDailyReport(report) {
  const msg = `*MLBIE — Daily P&L (${report.date})*
Trades: ${report.n} (W/L/P: ${report.wins}/${report.losses}/${report.pushes})
Net P&L: *$${(report.pnl || 0).toFixed(2)}*
Win rate: ${report.n > 0 ? ((report.wins / (report.wins + report.losses)) * 100).toFixed(1) : '—'}%
Mode: ${report.mode}`
  return send(msg)
}

export async function alertPipelineFailure({ source, error }) {
  const msg = `*MLBIE — Pipeline Failure*
Source: \`${source}\`
Error: ${error?.message || String(error)}`
  return send(msg)
}

export async function alertPaperSummary(summary) {
  const msg = `*MLBIE — Paper Trading Summary*
Date: ${summary.date}
Signals found: ${summary.signals_found}
Would-have-traded: ${summary.trades_logged}
Avg edge: ${(summary.avg_edge * 100).toFixed(1)}%
Mode: paper (no execution)`
  return send(msg, { silent: true })
}
