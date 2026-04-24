import express from 'express'
import * as db from '../lib/db.js'
import { sseBus } from '../lib/sseBus.js'
import { syncSettlementsForUser } from '../lib/ksSettlementSync.js'
import { todayISO, invalidateBalanceCache } from './shared.js'

const router = express.Router()

export const SERVER_START = new Date().toISOString()

const _sseClients = new Set()
let _lastFillEventAt = null
let _lastDataUpdate = null
let _sseState = {
  settledCount: -1, liveBetCount: -1, morningBetCount: -1, filledCount: -1,
  lastSettledAt: null, lastLoggedAt: null, kalshiBalance: -1,
  pnlEventCount: -1, pnlLastSettled: null,
}

export function getLastFillEventAt() { return _lastFillEventAt }
export function getLastDataUpdate()  { return _lastDataUpdate }
export function setLastDataUpdate(v) { _lastDataUpdate = v }

export function broadcastSSE(type, data = {}) {
  const msg = `data: ${JSON.stringify({ type, ...data })}\n\n`
  for (const client of [..._sseClients]) {
    try { client.write(msg) } catch { _sseClients.delete(client) }
  }
}

sseBus.on('fill_update', () => {
  _lastFillEventAt = Date.now()
  invalidateBalanceCache()
  broadcastSSE('fill_update', { lastDataUpdate: new Date().toISOString() })
})

setInterval(async () => {
  if (!_sseClients.size) return
  try {
    const today = todayISO()
    const [settlRow, liveRow, morningRow, filledRow] = await Promise.all([
      db.one(`SELECT COUNT(*) as n, MAX(settled_at) as last_settled, MAX(logged_at) as last_logged
               FROM ks_bets WHERE bet_date=?`, [today]),
      db.one(`SELECT COUNT(*) as n FROM ks_bets WHERE bet_date=? AND live_bet=1`, [today]),
      db.one(`SELECT COUNT(*) as n FROM ks_bets WHERE bet_date=? AND live_bet=0`, [today]),
      db.one(`SELECT COUNT(*) as n FROM ks_bets WHERE bet_date=? AND live_bet=0 AND filled_contracts > 0`, [today]),
    ])
    const newSettled     = settlRow?.n ?? 0
    const newLive        = liveRow?.n ?? 0
    const newMorning     = morningRow?.n ?? 0
    const newFilled      = filledRow?.n ?? 0
    const newLastSettled = settlRow?.last_settled ?? null
    const newLastLogged  = settlRow?.last_logged ?? null

    const newDataUpdate = [newLastSettled, newLastLogged].filter(Boolean).sort().pop() ?? null
    if (newDataUpdate && newDataUpdate !== _lastDataUpdate) _lastDataUpdate = newDataUpdate

    if (newSettled !== _sseState.settledCount || newLastSettled !== _sseState.lastSettledAt) {
      broadcastSSE('settled', { count: newSettled, lastSettledAt: newLastSettled, lastDataUpdate: _lastDataUpdate })
      _sseState.settledCount  = newSettled
      _sseState.lastSettledAt = newLastSettled
    }
    if (newLive !== _sseState.liveBetCount || newLastLogged !== _sseState.lastLoggedAt) {
      broadcastSSE('live_bet', { count: newLive, lastDataUpdate: _lastDataUpdate })
      _sseState.liveBetCount  = newLive
      _sseState.lastLoggedAt  = newLastLogged
    }
    if (newMorning !== _sseState.morningBetCount) {
      broadcastSSE('morning_bet', { count: newMorning, lastDataUpdate: _lastDataUpdate })
      _sseState.morningBetCount = newMorning
    }
    if (newFilled !== _sseState.filledCount) {
      broadcastSSE('fill_update', { count: newFilled, lastDataUpdate: _lastDataUpdate })
      _sseState.filledCount = newFilled
    }

    const pnlRow = await db.one(
      `SELECT COUNT(*) as n, MAX(settled_at) as last_settled FROM daily_pnl_events WHERE date=?`, [today]
    ).catch(() => null)
    const newPnlCount = pnlRow?.n ?? 0
    const newPnlLast  = pnlRow?.last_settled ?? null
    if (newPnlCount !== _sseState.pnlEventCount || newPnlLast !== _sseState.pnlLastSettled) {
      broadcastSSE('pnl_update', {})
      _sseState.pnlEventCount  = newPnlCount
      _sseState.pnlLastSettled = newPnlLast
    }

    const bettors = await db.all(`SELECT id, kalshi_key_id, kalshi_private_key, kalshi_balance FROM users WHERE active_bettor=1 AND id != 1`)
    for (const u of bettors) {
      if (u.kalshi_key_id) syncSettlementsForUser(u).catch(() => {})
    }
    const newBal = Math.round((bettors[0]?.kalshi_balance || 0) * 100)
    if (newBal !== _sseState.kalshiBalance && _sseState.kalshiBalance !== -1) {
      broadcastSSE('balance_update', {})
    }
    _sseState.kalshiBalance = newBal
  } catch { /* ignore DB errors */ }
}, 10_000)

router.get('/meta', async (req, res) => {
  try {
    const today = todayISO()
    let lastDataUpdate = _lastDataUpdate
    if (!lastDataUpdate) {
      const row = await db.one(
        `SELECT MAX(settled_at) as s, MAX(logged_at) as l FROM ks_bets WHERE bet_date=?`, [today],
      ).catch(() => null)
      lastDataUpdate = [row?.s, row?.l].filter(Boolean).sort().pop() ?? null
      if (lastDataUpdate) _lastDataUpdate = lastDataUpdate
    }
    res.json({ deploy_time: SERVER_START, last_data_update: lastDataUpdate })
  } catch (err) {
    res.status(500).json({ error: 'internal_error', message: err.message })
  }
})

router.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()

  _sseClients.add(res)
  res.write(': connected\n\n')

  const keepalive = setInterval(() => {
    try { res.write(': ping\n\n') } catch { clearInterval(keepalive); _sseClients.delete(res) }
  }, 25_000)

  req.on('close', () => {
    clearInterval(keepalive)
    _sseClients.delete(res)
  })
})

export default router
