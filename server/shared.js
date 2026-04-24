import * as db from '../lib/db.js'
import { getSettlements } from '../lib/kalshi.js'

export function safeJson(str, fallback = null) {
  if (str == null) return fallback
  try { return JSON.parse(str) } catch { return fallback }
}

export function todayISO() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'America/New_York' }).slice(0, 10)
}

export function roundTo(n, d = 4) {
  if (n == null || Number.isNaN(n)) return 0
  return Math.round(n * 10 ** d) / 10 ** d
}

export function winRate(wins, losses) {
  const d = (wins || 0) + (losses || 0)
  return d > 0 ? (wins || 0) / d : 0
}

export function fmtShort(d) {
  const m = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  return `${m[d.getUTCMonth()]} ${d.getUTCDate()}`
}

export function isoWeekGroup(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z')
  const dow = (d.getUTCDay() + 6) % 7
  const monday = new Date(d); monday.setUTCDate(d.getUTCDate() - dow)
  const sunday = new Date(monday); sunday.setUTCDate(monday.getUTCDate() + 6)
  return {
    key:   monday.toISOString().slice(0, 10),
    label: `${fmtShort(monday)}–${fmtShort(sunday)}`,
  }
}

export function userFilter(req) {
  const override = req.query?.user_id ? Number(req.query.user_id) : null
  const uid = override || (req.session?.user?.id ?? null)
  if (uid == null) return { clause: '', args: [], userId: null }
  return { clause: `AND user_id = ?`, args: [uid], userId: uid }
}

export function wrap(fn) {
  return async (req, res) => {
    try {
      await fn(req, res)
    } catch (err) {
      console.error(`[api] ${req.method} ${req.path} failed:`, err.stack || err.message)
      res.status(500).json({ error: 'internal_error', message: err.message })
    }
  }
}

export const STARTING_BANKROLL = Number(process.env.BANKROLL || 5000)

export const _balanceCache = new Map()
export const BALANCE_CACHE_MS = 45_000
export function invalidateBalanceCache() { _balanceCache.clear() }

export const _candlesCache = new Map()
export const CANDLES_CACHE_MS = 5 * 60 * 1000

export async function seedDailyPnlFromRest(userId, creds) {
  const today = todayISO()
  const { settlements } = await getSettlements({ limit: 200 }, creds)
  const todaySettlements = settlements.filter(s => {
    if (!s.settled_time) return false
    return new Date(s.settled_time).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) === today
  })
  for (const s of todaySettlements) {
    if (!s.ticker) continue
    const pnl = (Number(s.revenue || 0) / 100)
      - parseFloat(s.yes_total_cost_dollars || 0)
      - parseFloat(s.no_total_cost_dollars || 0)
      - parseFloat(s.fee_cost || 0)
    await db.run(
      `INSERT OR IGNORE INTO daily_pnl_events (user_id, date, ticker, pnl_usd, settled_at)
       VALUES (?, ?, ?, ?, ?)`,
      [userId, today, s.ticker, Math.round(pnl * 100) / 100, s.settled_time]
    ).catch(() => {})
  }
}
