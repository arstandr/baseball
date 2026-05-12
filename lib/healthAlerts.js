// lib/healthAlerts.js — System-health Discord alerts.
//
// Apr 28 — separate from errorSentinel (catches throws) and discord.js (event
// notifications). This layer alerts on operational degradations: stalled loops,
// dropped WebSockets, kill-switches active, dampener changes, guard-rail trips
// that mean the system protected itself but Adam needs to know.
//
// All functions are fire-and-forget. Each event has its own dedup window so a
// single repeating condition doesn't spam Discord.

import 'dotenv/config'

const ADAM_WEBHOOK =
  process.env.ADAM_WEBHOOK_URL ||
  'https://discord.com/api/webhooks/1495964427382558740/e6Q7pZPQWSjghWSx9XYYeXWBVXIFV1kPvSG-lmE9YSDiRbnaABSLCvYTUUNLE_Feer6W'

// Per-event cooldown registry. Key = `${event}|${dedup}`, value = lastSentAt ms.
const _cooldowns = new Map()
function _shouldSend(event, dedupKey, cooldownMs) {
  const fp = `${event}|${dedupKey}`
  const now = Date.now()
  const last = _cooldowns.get(fp)
  if (last != null && now - last < cooldownMs) return false
  _cooldowns.set(fp, now)
  return true
}

async function _post(embed) {
  try {
    await fetch(ADAM_WEBHOOK, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] }),
    }).catch(() => {})
  } catch { /* never throw from sentinel */ }
}

function _embed(title, description, color = 0xff4444) {
  return {
    title,
    description: String(description).slice(0, 3800),
    color,
    timestamp: new Date().toISOString(),
    footer: { text: 'healthAlerts · baseball' },
  }
}

// ── Loop-health alerts ──────────────────────────────────────────────────────

export async function alertLiveMonitorStalled({ lastHeartbeatMs, ageMs }) {
  if (!_shouldSend('live_stalled', 'global', 5 * 60 * 1000)) return
  const ageMin = Math.round(ageMs / 60000)
  await _post(_embed(
    '🛑 liveMonitor heartbeat stalled',
    `Last heartbeat **${ageMin} min ago** (${new Date(lastHeartbeatMs).toISOString()}).\nMonitor may have crashed or hung. Live bets are NOT being evaluated.`,
    0xc62828,
  ))
}

export async function alertGamePulseStalled({ lastUpdateMs, ageMs }) {
  if (!_shouldSend('pulse_stalled', 'global', 5 * 60 * 1000)) return
  const ageMin = Math.round(ageMs / 60000)
  await _post(_embed(
    '🛑 gamePulse loop stalled',
    `game_pulse last_updated was **${ageMin} min ago** (${new Date(lastUpdateMs).toISOString()}).\nPhase transitions, scratch detection, line snapshots are NOT firing.`,
    0xc62828,
  ))
}

export async function alertWsDown({ source, secsDown }) {
  if (!_shouldSend('ws_down', source, 3 * 60 * 1000)) return
  await _post(_embed(
    `📡 ${source} WebSocket down`,
    `Disconnected for **${Math.round(secsDown)}s**. Pull-signal latency degraded to ~30s API polling.`,
    0xf57c00,
  ))
}

// ── Flag-state alerts ───────────────────────────────────────────────────────

export async function alertTradingHalted({ value }) {
  if (!_shouldSend('halt_change', String(value), 60 * 1000)) return
  if (String(value) === '1') {
    await _post(_embed(
      '🛑 trading_halted = 1',
      'Master kill-switch is ON. Every executeBet() returns immediately. No bets will fire until cleared.',
      0xc62828,
    ))
  } else {
    await _post(_embed(
      '✅ trading_halted = 0',
      'Master kill-switch is OFF. Bets resume.',
      0x2e7d32,
    ))
  }
}

export async function alertDrawdownChange({ from, to, rollingPnl, capital }) {
  if (!_shouldSend('drawdown_change', `${from}->${to}`, 60 * 1000)) return
  const arrow = to < from ? '⬇️ tightening' : '⬆️ relaxing'
  await _post(_embed(
    `📉 drawdown_scale ${arrow}: ${from}× → ${to}×`,
    `7-day P&L **$${(rollingPnl ?? 0).toFixed(0)}** vs starting capital **$${(capital ?? 0).toFixed(0)}**.\nAll Kelly bets now sized at **${to}×**.`,
    to < 1 ? 0xfb8c00 : 0x2e7d32,
  ))
}

export async function alertKalshiOutage({ value, consecutiveFailures }) {
  if (!_shouldSend('kalshi_outage', String(value), 60 * 1000)) return
  if (String(value) === '1') {
    await _post(_embed(
      '🛑 Kalshi outage detected',
      `Consecutive API failures: **${consecutiveFailures}**. Order placement disabled until clear.`,
      0xc62828,
    ))
  } else {
    await _post(_embed('✅ Kalshi outage cleared', 'API responsive — orders re-enabled.', 0x2e7d32))
  }
}

// ── Guard-rail trips ────────────────────────────────────────────────────────
// These mean a safety mechanism caught something — Adam should see them so he
// can decide if it's noise or a real upstream problem.

export async function alertStaleFireBlocked({ pitcherName, strike, side, reason }) {
  if (!_shouldSend('stale_fire', `${pitcherName}|${strike}|${side}`, 30 * 60 * 1000)) return
  await _post(_embed(
    '🛡️ Stale-fire guard blocked a bet',
    `**${pitcherName}** ${strike}+ ${side}\nReason: ${reason}\nThe system rejected a stale bet attempt — investigate why upstream code tried to fire on stale state.`,
    0xfb8c00,
  ))
}

export async function alertExtremeDivergence({ pitcherName, strike, modelProb, marketPrice }) {
  if (!_shouldSend('extreme_div', `${pitcherName}|${strike}`, 30 * 60 * 1000)) return
  await _post(_embed(
    '🛡️ Extreme divergence guard blocked',
    `**${pitcherName}** ${strike}+ YES — model ${(modelProb * 100).toFixed(0)}% vs market ${(marketPrice * 100).toFixed(1)}¢\nLikely model staleness (pitcher near pull). Bet was NOT placed.`,
    0xfb8c00,
  ))
}

export async function alertNearLossLimit({ userName, usedUsd, capUsd }) {
  const pct = capUsd > 0 ? usedUsd / capUsd : 0
  if (pct < 0.80) return
  if (!_shouldSend('near_loss', userName, 30 * 60 * 1000)) return
  await _post(_embed(
    '⚠️ Near daily loss limit',
    `**${userName}** has used **$${usedUsd.toFixed(0)} of $${capUsd.toFixed(0)}** (${(pct * 100).toFixed(0)}%) of today's loss limit.\nAt 100%, this user stops betting.`,
    0xfb8c00,
  ))
}

export async function alertHighConvictionCapHit({ pitcherName, strike, rawSize, cappedSize }) {
  if (!_shouldSend('hc_cap_hit', `${pitcherName}|${strike}`, 30 * 60 * 1000)) return
  await _post(_embed(
    '🛡️ High-conviction cap binding',
    `**${pitcherName}** ${strike}+ — Kelly wanted **$${rawSize.toFixed(0)}**, capped to **$${cappedSize.toFixed(0)}** by LIVE_HIGH_CONVICTION_CAP_USD.\nNot necessarily a problem — just letting you know the cap is doing work.`,
    0x2196f3,
  ))
}
