// lib/btcdBankroll.js — BTCD paper bankroll + position sizing
//
// State is persisted in Turso so the runner can restart without losing P&L.
// Sizing rule: min(BTCD_TARGET_PCT × bankroll, BTCD_MAX_DOLLARS) per trade.
// Defaults: 2% of bankroll, $500 cap → matches the backtest scenario that
// produced $7K → ~$210K over 34 days (modulo real-world haircut).

import { getClient } from './db.js'

const STARTING_BALANCE_DEFAULT = 7000
const TARGET_PCT_DEFAULT = 0.02
const MAX_DOLLARS_DEFAULT = 500
const DAILY_LOSS_CAP_PCT = 0.10        // halt at -10% of starting balance per day

function cfg() {
  return {
    starting: Number(process.env.BTCD_STARTING_BALANCE ?? STARTING_BALANCE_DEFAULT),
    pct:      Number(process.env.BTCD_TARGET_PCT ?? TARGET_PCT_DEFAULT),
    maxDollars: Number(process.env.BTCD_MAX_DOLLARS ?? MAX_DOLLARS_DEFAULT),
    dailyLossCapPct: Number(process.env.BTCD_DAILY_LOSS_CAP_PCT ?? DAILY_LOSS_CAP_PCT),
  }
}

export async function ensureBankroll() {
  const db = getClient()
  const r = await db.execute(`SELECT * FROM btcd_bankroll_state WHERE id=1`)
  if (r.rows.length) return r.rows[0]

  const { starting } = cfg()
  const now = new Date().toISOString()
  await db.execute({
    sql: `INSERT INTO btcd_bankroll_state
            (id, mode, balance, starting_balance, starting_ts, peak_balance)
          VALUES (1, 'paper', ?, ?, ?, ?)`,
    args: [starting, starting, now, starting],
  })
  const r2 = await db.execute(`SELECT * FROM btcd_bankroll_state WHERE id=1`)
  return r2.rows[0]
}

export async function loadBankroll() {
  return ensureBankroll()
}

// Returns { contracts, debit } where debit = contracts*(cost+fee). Contracts=0
// means "below minimum trade size — skip."
export function sizeContracts(bankroll, costPerContract, feePerContract) {
  if (!costPerContract || costPerContract <= 0) return { contracts: 0, debit: 0 }
  const { pct, maxDollars } = cfg()
  const balance = Number(bankroll.balance)
  const budget = Math.min(balance * pct, maxDollars)
  const unit = costPerContract + feePerContract
  const contracts = Math.max(0, Math.floor(budget / unit))
  return { contracts, debit: contracts * unit }
}

export async function debitTrade(amount) {
  const db = getClient()
  await db.execute({
    sql: `UPDATE btcd_bankroll_state SET balance = balance - ?, updated_at = datetime('now') WHERE id=1`,
    args: [amount],
  })
}

export async function applySettlement({ payout, realizedPnl }) {
  const db = getClient()
  const today = new Date().toISOString().slice(0, 10)
  await db.execute({
    sql: `UPDATE btcd_bankroll_state
            SET balance        = balance + ?,
                peak_balance   = MAX(peak_balance, balance + ?),
                daily_pnl      = CASE WHEN daily_pnl_date = ? THEN daily_pnl + ? ELSE ? END,
                daily_pnl_date = ?,
                updated_at     = datetime('now')
          WHERE id = 1`,
    args: [payout, payout, today, realizedPnl, realizedPnl, today],
  })
}

// Check daily-loss-cap. If hit, set halted=1 with a reason. Halts auto-clear at
// UTC midnight (the daily_pnl rollover).
export async function maybeHaltOnDailyCap() {
  const db = getClient()
  const br = await loadBankroll()
  const today = new Date().toISOString().slice(0, 10)
  const dailyPnl = br.daily_pnl_date === today ? Number(br.daily_pnl) : 0
  const { starting, dailyLossCapPct } = cfg()
  const capLoss = -starting * dailyLossCapPct
  if (dailyPnl <= capLoss && !br.halted) {
    await db.execute({
      sql: `UPDATE btcd_bankroll_state SET halted = 1, halt_reason = ?, updated_at = datetime('now') WHERE id=1`,
      args: [`daily loss cap: ${dailyPnl.toFixed(2)} <= ${capLoss.toFixed(2)}`],
    })
    return true
  }
  // Auto-unhalt at day rollover
  if (br.halted && br.halt_reason?.startsWith('daily loss cap') && br.daily_pnl_date !== today) {
    await db.execute({
      sql: `UPDATE btcd_bankroll_state SET halted=0, halt_reason=NULL, daily_pnl=0, daily_pnl_date=?, updated_at=datetime('now') WHERE id=1`,
      args: [today],
    })
    return false
  }
  return Boolean(br.halted)
}

export async function setHalt(reason) {
  const db = getClient()
  await db.execute({
    sql: `UPDATE btcd_bankroll_state SET halted=1, halt_reason=?, updated_at=datetime('now') WHERE id=1`,
    args: [reason],
  })
}

export async function clearHalt() {
  const db = getClient()
  await db.execute(`UPDATE btcd_bankroll_state SET halted=0, halt_reason=NULL, updated_at=datetime('now') WHERE id=1`)
}

export async function getOpenExposure() {
  const db = getClient()
  const r = await db.execute(`SELECT COALESCE(SUM(cost + fee), 0) AS exposure FROM btcd_trades WHERE status='open'`)
  return Number(r.rows[0]?.exposure ?? 0)
}
