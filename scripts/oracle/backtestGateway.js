// scripts/oracle/backtestGateway.js
//
// Backtest Layer 6 Gateway against historical pre-game bets.
//
// What it does:
//   1. Reads every pre-game bet (ks_bets WHERE live_bet=0) chronologically.
//   2. For each bet, reconstructs the (account, bet_date) daily state as it
//      stood at that bet's moment — realized_pnl from prior settled bets,
//      open_risk from prior unsettled bets, submitted_order_usd from prior
//      placements.
//   3. Builds a fully-formed Gateway intent + signs HMAC + runs the real
//      validatePlaceIntent against three killswitch configurations:
//          - 'defaults'      → empty config (sanity baseline)
//          - 'v1-realistic'  → daily_loss=$500/$250, max_order=$200
//          - 'tight'         → daily_loss=$200/$100, max_order=$100
//   4. Aggregates per-config: would-accept count, would-reject count by
//      reason, P&L impact (sum pnl of rejected bets), worst-day saves.
//   5. Writes:
//        - Markdown report → oracle/backtest/gateway-backtest-<date>.md
//        - CSV per-bet     → oracle/backtest/gateway-backtest-<date>.csv
//
// Production DB is read-only for ks_bets; nothing written to production.
// Per-bet validator runs in-memory with synthesized loaders (no temp DB).
//
// Usage:
//   node scripts/oracle/backtestGateway.js
//   node scripts/oracle/backtestGateway.js --since 2026-04-15
//   node scripts/oracle/backtestGateway.js --config tight
//   node scripts/oracle/backtestGateway.js --config all   (default)

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

const SECRET = 'backtest-closer-legacy-secret'

// user_id → account_id mapping (per Closer's BETTOR_USER_ID convention)
const ACCOUNT_MAP = { 1: 'adam', 2: 'isaiah' }

// ── CLI arg parsing ────────────────────────────────────────────────────
const args = process.argv.slice(2)
function arg(name, dflt) {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt
}

const SINCE = arg('--since', '2026-04-15')   // default: last ~2 weeks
const CONFIG_NAME = arg('--config', 'all')
const OUT_DIR = path.resolve(__dirname, '../../oracle/backtest')

// ── Killswitch configs ────────────────────────────────────────────────

const BASE_KS = Object.freeze({
  gateway_kill_all: false,
  gateway_kill_agent: [],
  gateway_kill_mode: [],
  gateway_kill_account: [],
  min_version_by_agent: {},
  monitor_only_stale_agent: {},
  allowed_commit_hash_by_agent: {},
  daily_loss_limit_by_account: {},
  daily_risk_limit_by_account: {},
  max_order_usd_by_mode: {},
})

const CONFIGS = {
  defaults: { ...BASE_KS },
  'v1-realistic': {
    ...BASE_KS,
    daily_loss_limit_by_account: { adam: 500, isaiah: 250 },
    max_order_usd_by_mode: { pregame_model: 200 },
  },
  tight: {
    ...BASE_KS,
    daily_loss_limit_by_account: { adam: 200, isaiah: 100 },
    max_order_usd_by_mode: { pregame_model: 100 },
  },
  // V1.1 sweep — symmetric daily loss across accounts, vary pregame order cap
  'pregame-100': {
    ...BASE_KS,
    daily_loss_limit_by_account: { adam: 400, isaiah: 400 },
    max_order_usd_by_mode: { pregame_model: 100 },
  },
  'pregame-125': {
    ...BASE_KS,
    daily_loss_limit_by_account: { adam: 400, isaiah: 400 },
    max_order_usd_by_mode: { pregame_model: 125 },
  },
  'pregame-150': {
    ...BASE_KS,
    daily_loss_limit_by_account: { adam: 400, isaiah: 400 },
    max_order_usd_by_mode: { pregame_model: 150 },
  },
  // V1.2 daily-loss sweep at locked pregame=$125
  'sweep-300': {
    ...BASE_KS,
    daily_loss_limit_by_account: { adam: 300, isaiah: 300 },
    max_order_usd_by_mode: { pregame_model: 125 },
  },
  'sweep-350': {
    ...BASE_KS,
    daily_loss_limit_by_account: { adam: 350, isaiah: 350 },
    max_order_usd_by_mode: { pregame_model: 125 },
  },
  'sweep-400': {
    ...BASE_KS,
    daily_loss_limit_by_account: { adam: 400, isaiah: 400 },
    max_order_usd_by_mode: { pregame_model: 125 },
  },
  'sweep-450': {
    ...BASE_KS,
    daily_loss_limit_by_account: { adam: 450, isaiah: 450 },
    max_order_usd_by_mode: { pregame_model: 125 },
  },
  'sweep-500': {
    ...BASE_KS,
    daily_loss_limit_by_account: { adam: 500, isaiah: 500 },
    max_order_usd_by_mode: { pregame_model: 125 },
  },
}

const CONFIG_DESCRIPTIONS = {
  defaults: 'No killswitches — pure structural baseline.',
  'v1-realistic': 'Reasonable V1 limits: daily_loss=$500 adam / $250 isaiah; max_order=$200 pregame.',
  tight: 'Tight limits: daily_loss=$200 adam / $100 isaiah; max_order=$100 pregame.',
  'pregame-100': 'Pregame sweep: daily_loss=$400/account; max_order=$100 pregame.',
  'pregame-125': 'Pregame sweep: daily_loss=$400/account; max_order=$125 pregame.',
  'pregame-150': 'Pregame sweep: daily_loss=$400/account; max_order=$150 pregame.',
  'sweep-300':   'Daily-loss sweep: $300/account; pregame=$125.',
  'sweep-350':   'Daily-loss sweep: $350/account; pregame=$125.',
  'sweep-400':   'Daily-loss sweep: $400/account; pregame=$125.',
  'sweep-450':   'Daily-loss sweep: $450/account; pregame=$125.',
  'sweep-500':   'Daily-loss sweep: $500/account; pregame=$125.',
}

// ── Helpers ────────────────────────────────────────────────────────────

function isoToMs(iso) {
  if (!iso) return NaN
  const t = new Date(iso).getTime()
  return Number.isFinite(t) ? t : NaN
}

function buildIntent(bet, account_id) {
  const ts = isoToMs(bet.logged_at)
  const fillPriceCents = Math.round((bet.fill_price ?? 0.5) * 100)
  const limitPriceCents = Math.max(1, Math.min(99, fillPriceCents || 30))
  const quantity = Math.max(1, Math.round(bet.filled_contracts ?? bet.bet_size / Math.max(1, limitPriceCents / 100) ?? 10))
  const decision_id = `backtest-${bet.id}`
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
  const nonce = `bt-n-${bet.id}-${crypto.randomBytes(2).toString('hex')}`
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
      account_id: id,
      trading_date: date,
      realized_pnl_usd: state.realized,
      open_risk_usd: state.openRisk,
      submitted_order_usd: state.submitted,
      daily_loss_limit_usd: killswitch.daily_loss_limit_by_account?.[id] ?? null,
      daily_risk_limit_usd: killswitch.daily_risk_limit_by_account?.[id] ?? null,
      updated_at: new Date(ts - 1000).toISOString(),
    }),
    loadDecisionEvent: async (decision_id) => ({
      decision_id,
      agent_id: 'closer-legacy',
      created_at: new Date(ts - 5000).toISOString(),
    }),
    loadIdempotency: async () => null,
  }
}

// ── Per-config simulation ──────────────────────────────────────────────

async function simulate(bets, configName, killswitch) {
  // Per-(account, date) running state. Settlements (positive or negative pnl)
  // graduate from "open" to "realized" when their settled_at < the current
  // bet's logged_at.
  const state = new Map()  // key = "account|date" → { realized, openRisk, submitted, openQueue: [{ts, bet}] }

  const decisions = []

  function getKey(acct, date) { return `${acct}|${date}` }
  function getState(acct, date) {
    const k = getKey(acct, date)
    let s = state.get(k)
    if (!s) {
      s = { realized: 0, openRisk: 0, submitted: 0, openQueue: [] }
      state.set(k, s)
    }
    return s
  }

  // Graduate any open positions whose settled_at < tNow into realized.
  function graduate(s, tNow) {
    if (!s.openQueue.length) return
    const remaining = []
    for (const item of s.openQueue) {
      const settledMs = item.bet.settled_at ? isoToMs(item.bet.settled_at) : null
      if (settledMs && settledMs < tNow && Number.isFinite(item.bet.pnl)) {
        s.realized += Number(item.bet.pnl)
        s.openRisk -= item.bet_size
      } else {
        remaining.push(item)
      }
    }
    s.openQueue = remaining
  }

  for (const bet of bets) {
    const account_id = ACCOUNT_MAP[bet.user_id]
    if (!account_id) {
      decisions.push({ bet, status: 'skipped', reject_reason: null, context: { reason: 'unknown_user_id' }, config: configName })
      continue
    }
    const intent = buildIntent(bet, account_id)
    const acctState = getState(account_id, bet.bet_date)
    graduate(acctState, intent.ts)

    const result = await validatePlaceIntent({
      headers: intent.headers, rawBody: intent.rawBody, body: intent.body,
      agentSecrets: { 'closer-legacy': SECRET },
      killswitch,
      loaders: makeLoaders({ killswitch, account_id, state: acctState, ts: intent.ts }),
      now: intent.ts,
      tradingDate: bet.bet_date,
      halted: false,
    })

    const decisionRow = {
      bet, account_id, config: configName,
      ok: result.ok === true,
      reject_reason: result.ok ? null : result.reject_reason,
      context: result.ok ? null : result.context,
      bet_amount_usd: intent.body.bet_amount_usd,
    }
    decisions.push(decisionRow)

    // Update running state ONLY if Gateway would have accepted.
    if (decisionRow.ok) {
      acctState.submitted += intent.body.bet_amount_usd
      acctState.openRisk += intent.body.bet_amount_usd
      acctState.openQueue.push({ ts: intent.ts, bet, bet_size: intent.body.bet_amount_usd })
    }
    // (If rejected, this bet didn't count toward daily state — that's the
    // counterfactual's whole point.)
  }

  return decisions
}

// ── Aggregation ────────────────────────────────────────────────────────

function summarize(decisions, configName) {
  const total = decisions.length
  const accepted = decisions.filter(d => d.ok).length
  const rejected = decisions.filter(d => !d.ok && d.reject_reason).length
  const skipped = decisions.filter(d => d.status === 'skipped').length
  const byReason = {}
  for (const d of decisions) {
    if (!d.ok && d.reject_reason) {
      byReason[d.reject_reason] ??= { count: 0, sample_ids: [], blocked_pnl_total: 0, blocked_size_total: 0 }
      const r = byReason[d.reject_reason]
      r.count++
      if (r.sample_ids.length < 5) r.sample_ids.push(d.bet.id)
      const pnl = Number(d.bet.pnl)
      if (Number.isFinite(pnl)) r.blocked_pnl_total += pnl
      r.blocked_size_total += Number(d.bet_amount_usd) || 0
    }
  }
  const blockedPnlTotal = Object.values(byReason).reduce((s, r) => s + r.blocked_pnl_total, 0)
  // Of the would-have-rejected bets, how many were losers (saved money) vs winners (cost money)?
  // Note: must require reject_reason — skipped bets (unknown user_id) have d.ok=undefined too.
  const blockedLosingPnl  = decisions.filter(d => !d.ok && d.reject_reason && Number(d.bet?.pnl) < 0).reduce((s, d) => s + Number(d.bet.pnl), 0)
  const blockedWinningPnl = decisions.filter(d => !d.ok && d.reject_reason && Number(d.bet?.pnl) > 0).reduce((s, d) => s + Number(d.bet.pnl), 0)
  const blockedUnsettled  = decisions.filter(d => !d.ok && d.reject_reason && (d.bet?.pnl == null || !Number.isFinite(Number(d.bet?.pnl)))).length

  // Per-account — only count bets with a known account_id
  const byAccount = {}
  for (const d of decisions) {
    if (!d.account_id) continue
    byAccount[d.account_id] ??= { total: 0, accepted: 0, rejected: 0, blocked_pnl: 0 }
    byAccount[d.account_id].total++
    if (d.ok) byAccount[d.account_id].accepted++
    else if (d.reject_reason) {
      byAccount[d.account_id].rejected++
      const pnl = Number(d.bet.pnl)
      if (Number.isFinite(pnl)) byAccount[d.account_id].blocked_pnl += pnl
    }
  }

  // Per-day — only count bets with a known account_id AND not skipped
  const byDay = {}
  for (const d of decisions) {
    if (!d.bet?.bet_date) continue
    if (d.status === 'skipped') continue
    byDay[d.bet.bet_date] ??= { total: 0, rejected: 0, blocked_pnl: 0 }
    byDay[d.bet.bet_date].total++
    if (!d.ok && d.reject_reason) {
      byDay[d.bet.bet_date].rejected++
      const pnl = Number(d.bet.pnl)
      if (Number.isFinite(pnl)) byDay[d.bet.bet_date].blocked_pnl += pnl
    }
  }

  // Per-pitcher rollup of blocked bets — same pitcher repeatedly = correlated
  // risk caught; spread across many pitchers = random losers in a window.
  const byPitcher = {}
  for (const d of decisions) {
    if (!d.ok && d.reject_reason && d.bet?.pitcher_name) {
      const k = d.bet.pitcher_name
      byPitcher[k] ??= { count: 0, sum_pnl: 0, dates: new Set(), reasons: new Set(), bet_ids: [] }
      byPitcher[k].count++
      const pnl = Number(d.bet.pnl)
      if (Number.isFinite(pnl)) byPitcher[k].sum_pnl += pnl
      byPitcher[k].dates.add(d.bet.bet_date)
      byPitcher[k].reasons.add(d.reject_reason)
      if (byPitcher[k].bet_ids.length < 5) byPitcher[k].bet_ids.push(d.bet.id)
    }
  }

  // Detailed list of every blocked bet, sorted by abs(pnl) desc so most
  // impactful surface first.
  const blockedDetails = decisions
    .filter(d => !d.ok && d.reject_reason)
    .map(d => ({
      bet_id:        d.bet.id,
      bet_date:      d.bet.bet_date,
      logged_at:     d.bet.logged_at,
      account_id:    d.account_id,
      pitcher_name:  d.bet.pitcher_name,
      strike:        d.bet.strike,
      side:          d.bet.side,
      market_ticker: d.bet.ticker,
      bet_size:      Number(d.bet.bet_size) || 0,
      limit_price_cents: Math.round((d.bet.fill_price ?? 0.5) * 100),
      model_prob:    Number(d.bet.model_prob) || null,
      market_mid:    d.bet.market_mid != null ? Number(d.bet.market_mid) : null,
      edge:          d.bet.edge != null ? Number(d.bet.edge) : null,
      pnl:           Number.isFinite(Number(d.bet.pnl)) ? Number(d.bet.pnl) : null,
      result:        d.bet.result,
      reject_reason: d.reject_reason,
      reject_detail: d.context ? JSON.stringify(d.context) : null,
    }))
    .sort((a, b) => Math.abs(Number(b.pnl) || 0) - Math.abs(Number(a.pnl) || 0))

  return {
    config: configName,
    total, accepted, rejected, skipped,
    accepted_pct: total ? (accepted / total * 100) : 0,
    rejected_pct: total ? (rejected / total * 100) : 0,
    by_reason: byReason,
    blocked_pnl_total: blockedPnlTotal,
    blocked_losing_pnl: blockedLosingPnl,
    blocked_winning_pnl: blockedWinningPnl,
    blocked_unsettled_count: blockedUnsettled,
    by_account: byAccount,
    by_day: byDay,
    by_pitcher: byPitcher,
    blocked_details: blockedDetails,
  }
}

// ── Reporting ──────────────────────────────────────────────────────────

function fmtUsd(n) {
  if (!Number.isFinite(n)) return '—'
  const sign = n < 0 ? '-' : ''
  return `${sign}$${Math.abs(n).toFixed(2)}`
}

function buildMarkdown({ since, summaries, totalBets, dateRange }) {
  const lines = []
  lines.push(`# Gateway Backtest — Pregame Only`)
  lines.push('')
  lines.push(`Run at: ${new Date().toISOString()}`)
  lines.push(`Bets simulated: ${totalBets}`)
  lines.push(`Coverage: ${dateRange.first ?? '?'} → ${dateRange.last ?? '?'} (since ${since})`)
  lines.push('')
  lines.push(`## Headline numbers per config`)
  lines.push('')
  lines.push(`| config | accepted | rejected | rejected_pct | blocked_losing_pnl (saved) | blocked_winning_pnl (cost) | net effect |`)
  lines.push(`|---|---|---|---|---|---|---|`)
  for (const s of summaries) {
    const net = (s.blocked_losing_pnl) + (s.blocked_winning_pnl)
    // blocked_losing_pnl is negative (sum of losing bets blocked → if blocked, money NOT lost = +)
    // Saved = -blocked_losing_pnl, Cost = blocked_winning_pnl, Net saved = saved - cost = -blocked_losing_pnl - blocked_winning_pnl = -net
    const savedAmt = -s.blocked_losing_pnl
    const costAmt = s.blocked_winning_pnl
    const netSaved = savedAmt - costAmt
    lines.push(`| **${s.config}** | ${s.accepted} | ${s.rejected} | ${s.rejected_pct.toFixed(1)}% | ${fmtUsd(savedAmt)} | ${fmtUsd(costAmt)} | **${fmtUsd(netSaved)}** |`)
  }
  lines.push('')
  lines.push(`> *Saved* = sum of pnl Gateway would have blocked from losing bets (positive number = good).`)
  lines.push(`> *Cost* = sum of pnl Gateway would have blocked from winning bets (positive number = missed wins).`)
  lines.push(`> *Net saved* = Saved − Cost.`)
  lines.push('')

  for (const s of summaries) {
    lines.push(`---`)
    lines.push('')
    lines.push(`## Config: \`${s.config}\``)
    lines.push('')
    lines.push(`*${CONFIG_DESCRIPTIONS[s.config] ?? ''}*`)
    lines.push('')
    lines.push(`### Reject reason breakdown`)
    lines.push('')
    if (Object.keys(s.by_reason).length === 0) {
      lines.push(`No rejects under this config.`)
    } else {
      lines.push(`| reason | count | sum of blocked pnl | sum of blocked size | sample bet ids |`)
      lines.push(`|---|---|---|---|---|`)
      const sorted = Object.entries(s.by_reason).sort((a, b) => b[1].count - a[1].count)
      for (const [reason, r] of sorted) {
        lines.push(`| \`${reason}\` | ${r.count} | ${fmtUsd(r.blocked_pnl_total)} | ${fmtUsd(r.blocked_size_total)} | ${r.sample_ids.join(', ')} |`)
      }
    }
    lines.push('')

    lines.push(`### Per-account`)
    lines.push('')
    lines.push(`| account | total | accepted | rejected | sum blocked pnl |`)
    lines.push(`|---|---|---|---|---|`)
    for (const [acct, a] of Object.entries(s.by_account)) {
      lines.push(`| ${acct} | ${a.total} | ${a.accepted} | ${a.rejected} | ${fmtUsd(a.blocked_pnl)} |`)
    }
    lines.push('')

    lines.push(`### Per-day (where Gateway rejected ≥1 bet)`)
    lines.push('')
    const days = Object.entries(s.by_day).filter(([_, v]) => v.rejected > 0).sort((a, b) => a[0].localeCompare(b[0]))
    if (days.length === 0) {
      lines.push(`No day had any rejected bets under this config.`)
    } else {
      lines.push(`| date | total | rejected | sum blocked pnl |`)
      lines.push(`|---|---|---|---|`)
      for (const [d, v] of days) {
        lines.push(`| ${d} | ${v.total} | ${v.rejected} | ${fmtUsd(v.blocked_pnl)} |`)
      }
    }
    lines.push('')

    // Per-pitcher rollup — reveals correlated risk (same pitcher repeatedly)
    // vs random noise (spread across many pitchers).
    lines.push(`### Per-pitcher rollup (descending block count)`)
    lines.push('')
    const pitchers = Object.entries(s.by_pitcher).sort((a, b) => b[1].count - a[1].count)
    if (pitchers.length === 0) {
      lines.push(`No bets blocked.`)
    } else {
      lines.push(`| pitcher | blocks | distinct dates | sum blocked pnl | reject reasons | sample bet ids |`)
      lines.push(`|---|---|---|---|---|---|`)
      for (const [pitcher, p] of pitchers) {
        lines.push(`| ${pitcher} | ${p.count} | ${p.dates.size} | ${fmtUsd(p.sum_pnl)} | ${[...p.reasons].join(', ')} | ${p.bet_ids.join(', ')} |`)
      }
    }
    lines.push('')

    // Full blocked-bets detail — every row, descending by abs(pnl)
    lines.push(`### Blocked bet details (sorted by impact)`)
    lines.push('')
    if (s.blocked_details.length === 0) {
      lines.push(`No bets blocked under this config.`)
    } else {
      lines.push(`| id | date | account | pitcher | K | side | size | limit¢ | model | mid | edge | pnl | result | reason |`)
      lines.push(`|---|---|---|---|---|---|---|---|---|---|---|---|---|---|`)
      for (const b of s.blocked_details) {
        lines.push(`| ${b.bet_id} | ${b.bet_date} | ${b.account_id} | ${b.pitcher_name} | ${b.strike} | ${b.side} | ${fmtUsd(b.bet_size)} | ${b.limit_price_cents}¢ | ${b.model_prob != null ? b.model_prob.toFixed(3) : '—'} | ${b.market_mid != null ? b.market_mid.toFixed(3) : '—'} | ${b.edge != null ? b.edge.toFixed(3) : '—'} | ${fmtUsd(b.pnl)} | ${b.result ?? '—'} | \`${b.reject_reason}\` |`)
      }
    }
    lines.push('')
  }

  return lines.join('\n') + '\n'
}

function buildCsv(allDecisions) {
  const header = ['config', 'bet_id', 'bet_date', 'logged_at', 'account_id', 'pitcher_name', 'strike', 'side', 'bet_size', 'pnl', 'result', 'gateway_ok', 'reject_reason', 'reject_context_short']
  const rows = [header.join(',')]
  for (const d of allDecisions) {
    const cs = d.context ? JSON.stringify(d.context).replace(/"/g, '""').slice(0, 200) : ''
    rows.push([
      d.config,
      d.bet.id,
      d.bet.bet_date,
      d.bet.logged_at,
      d.account_id ?? '',
      d.bet.pitcher_name ?? '',
      d.bet.strike,
      d.bet.side,
      d.bet.bet_size ?? '',
      d.bet.pnl ?? '',
      d.bet.result ?? '',
      d.ok ? 'true' : 'false',
      d.reject_reason ?? '',
      `"${cs}"`,
    ].join(','))
  }
  return rows.join('\n') + '\n'
}

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
  console.log(`[backtest] reading pre-game bets since ${SINCE}`)
  const bets = await db.all(
    `SELECT id, bet_date, logged_at, pitcher_id, pitcher_name, strike, side, ticker,
            bet_size, kelly_fraction, capital_at_risk, paper, live_bet,
            user_id, model_prob, edge, fill_price, filled_contracts,
            pnl, result, settled_at, order_id
       FROM ks_bets
      WHERE live_bet = 0
        AND bet_date >= ?
      ORDER BY logged_at ASC, id ASC`,
    [SINCE],
  )
  console.log(`[backtest] ${bets.length} pre-game bets in range`)
  if (bets.length === 0) {
    console.log('[backtest] nothing to backtest')
    process.exit(0)
  }

  const dateRange = { first: bets[0].bet_date, last: bets[bets.length - 1].bet_date }

  const configNames = CONFIG_NAME === 'all' ? Object.keys(CONFIGS) : [CONFIG_NAME]
  const allDecisions = []
  const summaries = []

  for (const name of configNames) {
    if (!CONFIGS[name]) {
      console.error(`[backtest] unknown config: ${name}`)
      process.exit(1)
    }
    console.log(`[backtest] simulating config: ${name}`)
    const decisions = await simulate(bets, name, CONFIGS[name])
    allDecisions.push(...decisions)
    summaries.push(summarize(decisions, name))
  }

  await fs.mkdir(OUT_DIR, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const mdPath  = path.join(OUT_DIR, `gateway-backtest-${stamp}.md`)
  const csvPath = path.join(OUT_DIR, `gateway-backtest-${stamp}.csv`)
  await fs.writeFile(mdPath, buildMarkdown({ since: SINCE, summaries, totalBets: bets.length, dateRange }))
  await fs.writeFile(csvPath, buildCsv(allDecisions))

  console.log('')
  console.log(`[backtest] wrote ${mdPath}`)
  console.log(`[backtest] wrote ${csvPath}`)
  console.log('')
  console.log('────────────────────────────────────────')
  console.log('  Headline')
  console.log('────────────────────────────────────────')
  for (const s of summaries) {
    const saved = -s.blocked_losing_pnl
    const cost  = s.blocked_winning_pnl
    const net   = saved - cost
    console.log(`  ${s.config.padEnd(15)} accepted=${s.accepted}/${s.total} rejected=${s.rejected} saved=${fmtUsd(saved)} cost=${fmtUsd(cost)} net=${fmtUsd(net)}`)
  }
  console.log('────────────────────────────────────────')
}

main().catch(err => {
  console.error('[backtest] FATAL:', err)
  process.exit(1)
})
