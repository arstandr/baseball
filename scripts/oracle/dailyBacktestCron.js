// scripts/oracle/dailyBacktestCron.js
//
// Daily backtest job — runs at 6am ET, replays yesterday's pre-game bets
// through the locked V1 Gateway config, writes a markdown + CSV report,
// and posts a Discord summary ONLY if something material changed.
//
// "Material change" = any of:
//   - Reject count vs the prior day's run differs by ≥3
//   - A new reject_reason appeared that wasn't in the prior run
//   - daily_loss_limit_breach count > 0  (the trip-wire fired)
//   - Net saved swung by >$200 vs the prior day's run
//
// Goal: catch decision-process drift early without spamming Discord.
//
// Locked V1 config used:
//   max_order_usd_by_mode  = { pregame_model: 125 }
//   daily_loss_limit_by_account = { adam: 400, isaiah: 400 }

import dotenv from 'dotenv'
import path from 'node:path'
import url from 'node:url'
import fs from 'node:fs/promises'
import crypto from 'node:crypto'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
dotenv.config({ path: path.resolve(__dirname, '../../.env') })

import * as db from '../../lib/db.js'
import { validatePlaceIntent } from '../../oracle/layers/6-gateway/validator.js'
import { sign, sha256Hex } from '../../oracle/layers/6-gateway/hmac.js'

const SECRET = 'daily-cron-backtest-secret'
const ACCOUNT_MAP = { 1: 'adam', 2: 'isaiah' }
const OUT_DIR = path.resolve(__dirname, '../../oracle/backtest')

// V1 LOCKED CONFIG
const V1_CONFIG = {
  gateway_kill_all: false,
  gateway_kill_agent: [],
  gateway_kill_mode: [],
  gateway_kill_account: [],
  min_version_by_agent: {},
  monitor_only_stale_agent: {},
  allowed_commit_hash_by_agent: {},
  daily_loss_limit_by_account: { adam: 400, isaiah: 400 },
  daily_risk_limit_by_account: {},
  max_order_usd_by_mode: { pregame_model: 125 },
}

const MATERIAL_CHANGE_THRESHOLDS = Object.freeze({
  reject_count_delta: 3,
  net_saved_delta_usd: 200,
})

// ── Yesterday's date in ET ─────────────────────────────────────────────
function etDateMinus1() {
  const t = new Date()
  t.setUTCDate(t.getUTCDate() - 1)
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(t)
}

// ── Build intent (mirrors backtestGateway.js shape) ────────────────────
function isoToMs(iso) {
  const t = new Date(iso).getTime()
  return Number.isFinite(t) ? t : NaN
}

function buildIntent(bet, account_id) {
  const ts = isoToMs(bet.logged_at)
  const fillPriceCents = Math.round((bet.fill_price ?? 0.5) * 100)
  const limitPriceCents = Math.max(1, Math.min(99, fillPriceCents || 30))
  const quantity = Math.max(1, Math.round(bet.filled_contracts ?? bet.bet_size / Math.max(1, limitPriceCents / 100) ?? 10))
  const decision_id = `dailycron-${bet.id}`
  const decision_input_hash = sha256Hex(`${bet.id}|${bet.pitcher_id}|${bet.strike}|${bet.side}|${bet.user_id}`).padEnd(64, '0').slice(0, 64)

  const body = {
    decision_id,
    decision_input_hash,
    trace_event_type: 'closer_legacy_decision',
    account_id,
    execution_mode: 'production',
    strategy_mode: 'pregame_model',
    market_ticker: bet.ticker || `BACKTEST-${bet.bet_date}-${(bet.pitcher_name || 'unknown').replace(/\s+/g, '-')}-${bet.strike}`,
    action: 'buy',
    contract_side: bet.side === 'YES' ? 'yes' : 'no',
    order_type: 'limit',
    time_in_force: 'IOC',
    quantity,
    limit_price_cents: limitPriceCents,
    pitcher_id: String(bet.pitcher_id ?? '0'),
    pitcher_name: bet.pitcher_name || 'unknown',
    bet_date: bet.bet_date,
    strike: bet.strike,
    bet_amount_usd: Number(bet.bet_size) || 100,
    kelly_fraction: Number(bet.kelly_fraction) || 0,
    bankroll_at_decision_usd: 5000,
    expected_pK_low: Number(bet.model_prob) || 0.5,
    expected_pK_high: Number(bet.model_prob) || 0.5,
    evidence: {
      mlb_state_hash:    'a'.repeat(64), mlb_state_ts:    ts - 1000,
      kalshi_quote_hash: 'b'.repeat(64), kalshi_quote_ts: ts - 500,
      position_hash:     'c'.repeat(64), position_ts:     ts - 1000,
      orderbook_hash:    'd'.repeat(64), orderbook_ts:    ts - 500,
    },
  }
  const rawBody = JSON.stringify(body)
  const bodySha = sha256Hex(rawBody)
  const nonce = `dc-${bet.id}-${crypto.randomBytes(2).toString('hex')}`
  const headers = {
    'x-gateway-agent': 'closer-legacy',
    'x-gateway-agent-version': '0.7.3',
    'x-gateway-commit': 'a'.repeat(40),
    'x-gateway-timestamp': String(ts),
    'x-gateway-nonce': nonce,
    'x-gateway-body-sha256': bodySha,
    'x-gateway-signature': sign({ secret: SECRET, timestamp: ts, nonce, bodySha256: bodySha }),
  }
  return { headers, rawBody, body, ts }
}

function makeLoaders({ killswitch, account_id, state, ts }) {
  return {
    insertNonce: async () => {},
    loadAccount: async (id) => (id === 'adam' || id === 'isaiah') ? { account_id: id, enabled: 1 } : null,
    loadAccountState: async (id, date) => ({
      account_id: id, trading_date: date,
      realized_pnl_usd: state.realized,
      open_risk_usd: state.openRisk,
      submitted_order_usd: state.submitted,
      daily_loss_limit_usd: killswitch.daily_loss_limit_by_account?.[id] ?? null,
      daily_risk_limit_usd: killswitch.daily_risk_limit_by_account?.[id] ?? null,
      updated_at: new Date(ts - 1000).toISOString(),
    }),
    loadDecisionEvent: async (decision_id) => ({
      decision_id, agent_id: 'closer-legacy',
      created_at: new Date(ts - 5000).toISOString(),
    }),
    loadIdempotency: async () => null,
  }
}

async function runDayBacktest(date) {
  const bets = await db.all(
    `SELECT id, bet_date, logged_at, pitcher_id, pitcher_name, strike, side, ticker,
            bet_size, kelly_fraction, capital_at_risk, user_id, model_prob, edge,
            fill_price, filled_contracts, pnl, result, settled_at, order_id
       FROM ks_bets
      WHERE live_bet = 0
        AND bet_date = ?
      ORDER BY logged_at ASC, id ASC`,
    [date],
  )
  if (bets.length === 0) return { date, total: 0, accepted: 0, rejected: 0, by_reason: {}, blocked_pnl: 0, daily_loss_breaches: 0 }

  const stateByAccount = new Map()
  function getState(acct) {
    let s = stateByAccount.get(acct)
    if (!s) { s = { realized: 0, openRisk: 0, submitted: 0, openQueue: [] }; stateByAccount.set(acct, s) }
    return s
  }
  function graduate(s, tNow) {
    if (!s.openQueue.length) return
    const remaining = []
    for (const item of s.openQueue) {
      const settledMs = item.bet.settled_at ? isoToMs(item.bet.settled_at) : null
      if (settledMs && settledMs < tNow && Number.isFinite(item.bet.pnl)) {
        s.realized += Number(item.bet.pnl)
        s.openRisk -= item.bet_size
      } else { remaining.push(item) }
    }
    s.openQueue = remaining
  }

  let accepted = 0
  let rejected = 0
  const byReason = {}
  let blockedLosingPnl = 0
  let blockedWinningPnl = 0
  let dailyLossBreaches = 0
  const blockedSamples = []

  for (const bet of bets) {
    const account_id = ACCOUNT_MAP[bet.user_id]
    if (!account_id) continue
    const intent = buildIntent(bet, account_id)
    const acctState = getState(account_id)
    graduate(acctState, intent.ts)

    const result = await validatePlaceIntent({
      headers: intent.headers, rawBody: intent.rawBody, body: intent.body,
      agentSecrets: { 'closer-legacy': SECRET },
      killswitch: V1_CONFIG,
      loaders: makeLoaders({ killswitch: V1_CONFIG, account_id, state: acctState, ts: intent.ts }),
      now: intent.ts,
      tradingDate: bet.bet_date,
      halted: false,
    })

    if (result.ok) {
      accepted++
      acctState.submitted += intent.body.bet_amount_usd
      acctState.openRisk += intent.body.bet_amount_usd
      acctState.openQueue.push({ ts: intent.ts, bet, bet_size: intent.body.bet_amount_usd })
    } else if (result.reject_reason) {
      rejected++
      byReason[result.reject_reason] = (byReason[result.reject_reason] ?? 0) + 1
      const pnl = Number(bet.pnl)
      if (Number.isFinite(pnl)) {
        if (pnl < 0) blockedLosingPnl += pnl
        else blockedWinningPnl += pnl
      }
      if (result.reject_reason === 'ACCOUNT_DAILY_LOSS_BREACHED') dailyLossBreaches++
      if (blockedSamples.length < 10) {
        blockedSamples.push({
          id: bet.id, account: account_id, pitcher: bet.pitcher_name,
          strike: bet.strike, side: bet.side, size: bet.bet_size,
          pnl: bet.pnl, reason: result.reject_reason,
        })
      }
    }
  }

  return {
    date,
    total: bets.length,
    accepted, rejected,
    by_reason: byReason,
    blocked_losing_pnl: blockedLosingPnl,
    blocked_winning_pnl: blockedWinningPnl,
    net_saved: -blockedLosingPnl - blockedWinningPnl,
    daily_loss_breaches: dailyLossBreaches,
    blocked_samples: blockedSamples,
  }
}

// ── Discord posting (best-effort) ──────────────────────────────────────
async function postDiscord(content) {
  const url = process.env.GATEWAY_DAILY_BACKTEST_WEBHOOK_URL || process.env.ADAM_WEBHOOK_URL
  if (!url) return { sent: false, reason: 'no_webhook_url' }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: content.slice(0, 2000) }),
    })
    return { sent: res.ok, status: res.status }
  } catch (err) {
    return { sent: false, error: err.message }
  }
}

function fmtUsd(n) {
  if (!Number.isFinite(n)) return '—'
  const sign = n < 0 ? '-' : ''
  return `${sign}$${Math.abs(n).toFixed(2)}`
}

// ── Material-change comparison vs prior run ────────────────────────────
async function loadPriorReport() {
  try {
    const files = await fs.readdir(OUT_DIR).catch(() => [])
    const dailies = files.filter(f => f.startsWith('daily-') && f.endsWith('.json')).sort()
    if (dailies.length === 0) return null
    const last = dailies[dailies.length - 1]
    return JSON.parse(await fs.readFile(path.join(OUT_DIR, last), 'utf-8'))
  } catch { return null }
}

function detectMaterialChange(today, prior) {
  if (!prior) return { material: true, reasons: ['first_run'] }
  const reasons = []
  if (Math.abs(today.rejected - prior.rejected) >= MATERIAL_CHANGE_THRESHOLDS.reject_count_delta) {
    reasons.push(`reject_count_delta:${today.rejected - prior.rejected}`)
  }
  if (Math.abs(today.net_saved - prior.net_saved) >= MATERIAL_CHANGE_THRESHOLDS.net_saved_delta_usd) {
    reasons.push(`net_saved_delta:${(today.net_saved - prior.net_saved).toFixed(0)}`)
  }
  if (today.daily_loss_breaches > 0) {
    reasons.push(`daily_loss_breaches:${today.daily_loss_breaches}`)
  }
  const newReasons = Object.keys(today.by_reason).filter(k => !(k in (prior.by_reason ?? {})))
  if (newReasons.length) reasons.push(`new_reject_reasons:${newReasons.join(',')}`)
  return { material: reasons.length > 0, reasons }
}

// ── Main ───────────────────────────────────────────────────────────────
export async function runDailyBacktestCron({ now = new Date(), discord = true } = {}) {
  const date = etDateMinus1.call(null) // yesterday in ET
  console.log(`[daily-backtest] running for ${date}`)
  const today = await runDayBacktest(date)
  const prior = await loadPriorReport()
  const change = detectMaterialChange(today, prior)

  await fs.mkdir(OUT_DIR, { recursive: true })
  const stamp = new Date(now).toISOString().slice(0, 10)
  const jsonPath = path.join(OUT_DIR, `daily-${stamp}.json`)
  await fs.writeFile(jsonPath, JSON.stringify({ ...today, change, ranAt: new Date(now).toISOString() }, null, 2))
  console.log(`[daily-backtest] wrote ${jsonPath}`)

  console.log(`[daily-backtest] ${date}: ${today.accepted} accepted, ${today.rejected} rejected, net_saved=${fmtUsd(today.net_saved)}, daily_loss_breaches=${today.daily_loss_breaches}`)

  if (discord && change.material) {
    const lines = [
      `**Gateway daily backtest — ${date}**`,
      `accepted=${today.accepted}  rejected=${today.rejected}  net_saved=${fmtUsd(today.net_saved)}  loss_breaches=${today.daily_loss_breaches}`,
      `change reasons: ${change.reasons.join(', ')}`,
    ]
    if (Object.keys(today.by_reason).length) {
      lines.push(`reasons: ${Object.entries(today.by_reason).map(([k, v]) => `${k}=${v}`).join(', ')}`)
    }
    const r = await postDiscord(lines.join('\n'))
    console.log(`[daily-backtest] discord: ${r.sent ? 'sent' : `not_sent (${r.reason ?? r.error ?? 'no_url'})`}`)
  } else {
    console.log(`[daily-backtest] no material change — Discord skipped`)
  }

  return { date, today, change }
}

// CLI entrypoint
if (import.meta.url === `file://${process.argv[1]}`) {
  runDailyBacktestCron()
    .then(() => process.exit(0))
    .catch(err => { console.error('[daily-backtest] FATAL:', err); process.exit(1) })
}
