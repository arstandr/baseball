import express from 'express'
import * as db from '../lib/db.js'
import { sseBus } from '../lib/sseBus.js'
import { syncSettlementsForUser } from '../lib/ksSettlementSync.js'
import { todayISO, invalidateBalanceCache } from './shared.js'
import { fetchLivePitcherData } from '../lib/liveGameData.js'

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
               FROM ks_bets WHERE bet_date=? AND paper=0`, [today]),
      db.one(`SELECT COUNT(*) as n FROM ks_bets WHERE bet_date=? AND live_bet=1 AND paper=0`, [today]),
      db.one(`SELECT COUNT(*) as n FROM ks_bets WHERE bet_date=? AND live_bet=0 AND paper=0`, [today]),
      db.one(`SELECT COUNT(*) as n FROM ks_bets WHERE bet_date=? AND live_bet=0 AND paper=0 AND filled_contracts > 0`, [today]),
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

    const bettors = await db.all(`SELECT id, kalshi_key_id, kalshi_private_key, kalshi_balance FROM users WHERE active_bettor=1 AND is_system_admin = 0`)
    for (const u of bettors) {
      if (u.kalshi_key_id) {
        syncSettlementsForUser(u).then(r => {
          if (r?.newSettled > 0) broadcastSSE('settled', { lastDataUpdate: new Date().toISOString() })
        }).catch(() => {})
      }
    }
    // Re-read balances after sync (syncSettlementsForUser writes to DB asynchronously,
    // so pull the freshest row rather than relying on the pre-sync snapshot above)
    const freshBettors = await db.all(`SELECT id, kalshi_balance FROM users WHERE active_bettor=1 AND is_system_admin = 0`)
    for (const fb of freshBettors) {
      const newBal = Math.round((fb.kalshi_balance || 0) * 100)
      const key    = `bal_${fb.id}`
      const prev   = _sseState[key] ?? -1
      if (prev !== -1 && newBal !== prev) {
        console.log(`[sse] balance change detected for user ${fb.id}: ${prev / 100} → ${newBal / 100}`)
        invalidateBalanceCache()
        broadcastSSE('balance_update', {})
      }
      _sseState[key] = newBal
    }
    // Legacy single-bettor field kept for compatibility
    _sseState.kalshiBalance = Math.round((freshBettors[0]?.kalshi_balance || 0) * 100)
  } catch { /* ignore DB errors */ }
}, 10_000)

// Settle bets whose outcomes are determined from live data — no need to wait for Kalshi.
// Conditions: NO bet blown (ks >= strike), YES bet dead (pitcher pulled with ks < strike),
// or game/appearance final. Runs server-side; result written directly to ks_bets.
async function settleDeterminedBets(pitchers, date) {
  const FEE = 0.07
  const now = new Date().toISOString()
  let settled = 0

  for (const p of pitchers) {
    if (p.is_postponed) continue
    // Determine if this pitcher's appearance is over
    const pulled  = p.still_in === false
    const done    = p.is_final || pulled
    // If game hasn't started yet skip — ks=0 and ip=0 means no data yet
    if (!done && p.ks === 0 && p.ip === 0) continue

    // Fetch all unsettled bets (morning + live) for this pitcher today
    const bets = await db.all(
      `SELECT id, side, strike, market_mid, spread, bet_size, fill_price, filled_contracts
       FROM ks_bets
       WHERE pitcher_id = ? AND bet_date = ? AND result IS NULL AND paper = 0`,
      [p.pitcher_id, date],
    )

    for (const b of bets) {
      let won = null
      if (b.side === 'YES') {
        if (p.ks >= b.strike)      won = true   // covered
        else if (done)             won = false  // pulled/final without hitting
      } else {
        if (p.ks >= b.strike)      won = false  // blown
        else if (done)             won = true   // done and stayed under
      }
      if (won === null) continue

      // P&L using same math as /ks/live route
      const contracts = b.filled_contracts || 0
      const mid      = (b.market_mid ?? 50) / 100
      const hs       = (b.spread ?? 4) / 200
      const fill     = b.side === 'YES' ? mid + hs : (1 - mid) + hs
      const fillFrac = contracts > 0 ? (b.fill_price ?? (b.market_mid ?? 50)) / 100 : fill
      const size     = contracts > 0 ? contracts : (b.bet_size ?? 0)
      const pnl      = won
        ? Math.round(size * (1 - fillFrac) * (1 - FEE) * 100) / 100
        : -Math.round(size * fillFrac * 100) / 100

      const rows = await db.run(
        `UPDATE ks_bets SET result=?, actual_ks=?, pnl=?, settled_at=?
         WHERE id=? AND result IS NULL`,
        [won ? 'win' : 'loss', p.ks, pnl, now, b.id],
      )
      if (rows?.rowsAffected ?? 1) {
        console.log(`[live-settle] ${p.pitcher_name} ${b.side} ${b.strike}+: ${won ? 'WIN' : 'LOSS'} @ ${p.ks}Ks  ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`)
        settled++
      }
    }
  }
  return settled
}

// Track live_log and decision_pipeline for feed updates.
let _lastFeedLogId  = 0
let _lastPipelineTs = null
setInterval(async () => {
  if (!_sseClients.size) return
  try {
    const today = todayISO()
    const [logRow, pipeRow] = await Promise.all([
      db.one(`SELECT MAX(id) as m FROM live_log WHERE bet_date=?`, [today]).catch(() => null),
      db.one(`SELECT MAX(updated_at) as m FROM decision_pipeline WHERE bet_date=?`, [today]).catch(() => null),
    ])
    const newLogId  = logRow?.m  ?? 0
    const newPipeTs = pipeRow?.m ?? null
    if (newLogId > _lastFeedLogId || newPipeTs !== _lastPipelineTs) {
      _lastFeedLogId  = newLogId  > _lastFeedLogId  ? newLogId  : _lastFeedLogId
      _lastPipelineTs = newPipeTs ?? _lastPipelineTs
      broadcastSSE('feed_update', {})
    }
  } catch {}
}, 15_000)

// Push live game data (K counts, innings, scores) to all connected clients.
// Runs every 20s; only fetches MLB API when there are pending bets today.
let _lastLiveHash = ''
setInterval(async () => {
  if (!_sseClients.size) return
  try {
    const today    = todayISO()
    const pitchers = await fetchLivePitcherData(today)
    if (!pitchers.length) {
      console.log('[sse] live tick: no pitchers found for', today)
      return
    }

    // Settle any bets whose outcomes are now determinable
    const settled = await settleDeterminedBets(pitchers, today)
    if (settled > 0) broadcastSSE('settled', { lastDataUpdate: new Date().toISOString() })

    const hash = pitchers.map(p =>
      `${p.pitcher_id}|${p.ks}|${p.is_final}|${p.inning}|${String(p.still_in)}`
    ).join(',')

    const now = new Date().toISOString()
    const summary = pitchers.map(p => `${p.pitcher_name}(${p.ks}K,${p.inning ?? 'pre'},${p.is_final ? 'final' : p.still_in ? 'in' : 'out'})`).join(' | ')
    console.log(`[sse] live tick: ${pitchers.length} pitcher(s) — ${summary} — hash ${hash === _lastLiveHash ? 'UNCHANGED' : 'CHANGED'}`)

    if (hash === _lastLiveHash) return
    _lastLiveHash = hash
    _lastDataUpdate = now
    broadcastSSE('live_update', { pitchers, date: today, lastDataUpdate: now })
  } catch (err) {
    console.error('[sse] live tick error:', err.message)
  }
}, 20_000)

router.get('/meta', async (req, res) => {
  try {
    const today = todayISO()
    let lastDataUpdate = _lastDataUpdate
    if (!lastDataUpdate) {
      const row = await db.one(
        `SELECT MAX(settled_at) as s, MAX(logged_at) as l FROM ks_bets WHERE bet_date=? AND paper=0`, [today],
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
  _lastLiveHash = '' // force next interval tick to push current live state to this new client
  res.write(': connected\n\n')

  // Immediately push current bet counts so a reconnecting client doesn't wait
  // up to 10s for the polling interval. Without this, bets placed while the tab
  // was backgrounded or the SSE connection was dropped are invisible until refresh.
  const today = todayISO()
  Promise.all([
    db.one(`SELECT COUNT(*) as n FROM ks_bets WHERE bet_date=? AND live_bet=0 AND paper=0`, [today]),
    db.one(`SELECT COUNT(*) as n FROM ks_bets WHERE bet_date=? AND live_bet=0 AND paper=0 AND filled_contracts > 0`, [today]),
  ]).then(([morningRow, filledRow]) => {
    const now = new Date().toISOString()
    try {
      res.write(`data: ${JSON.stringify({ type: 'morning_bet', count: morningRow?.n ?? 0, lastDataUpdate: now })}\n\n`)
      res.write(`data: ${JSON.stringify({ type: 'fill_update',  count: filledRow?.n  ?? 0, lastDataUpdate: now })}\n\n`)
    } catch {}
  }).catch(() => {})

  const keepalive = setInterval(() => {
    try { res.write(': ping\n\n') } catch { clearInterval(keepalive); _sseClients.delete(res) }
  }, 25_000)

  req.on('close', () => {
    clearInterval(keepalive)
    _sseClients.delete(res)
  })
})

export default router
