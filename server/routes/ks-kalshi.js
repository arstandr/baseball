import express from 'express'
import axios from 'axios'
import * as db from '../../lib/db.js'
import { getBalance as getKalshiBalance, getMarketCandles, getAuthHeaders } from '../../lib/kalshi.js'
import { wrap, _candlesCache, CANDLES_CACHE_MS } from '../shared.js'

const router = express.Router()

router.get('/ks/balance', wrap(async (req, res) => {
  try {
    const bal = await getKalshiBalance()
    res.json({ balance_cents: bal.balance_cents, balance_usd: bal.balance_usd })
  } catch (err) {
    res.status(502).json({ error: 'kalshi_unavailable', message: err.message })
  }
}))

router.get('/ks/kalshi-positions', wrap(async (req, res) => {
  const { user_id } = req.query
  let creds = {}
  if (user_id) {
    try {
      const u = await db.one(`SELECT kalshi_key_id, kalshi_private_key FROM users WHERE id = ?`, [user_id])
      if (u?.kalshi_key_id && u?.kalshi_private_key) creds = { keyId: u.kalshi_key_id, privateKey: u.kalshi_private_key }
    } catch {}
  }
  const BASE = 'https://api.elections.kalshi.com/trade-api/v2'
  try {
    const headers = getAuthHeaders('GET', '/trade-api/v2/portfolio/positions', {}, creds)
    const r = await axios({ method: 'GET', url: BASE + '/portfolio/positions', params: { count_filter: 'position', limit: 100 }, headers, timeout: 10000 })
    const positions = r.data?.market_positions || []
    res.json(positions.map(p => ({
      ticker:    p.ticker,
      contracts: Math.round(Math.abs(Number(p.position_fp || 0))),
      side:      Number(p.position_fp) >= 0 ? 'YES' : 'NO',
      cost:      Number(p.market_exposure_dollars || 0),
      pnl:       Number(p.realized_pnl_dollars || 0),
    })))
  } catch (e) {
    console.error('[kalshi-positions] API error:', e.message)
    res.json([])
  }
}))

router.get('/ks/market-prices', wrap(async (req, res) => {
  const tickers = (req.query.tickers || '').split(',').map(t => t.trim()).filter(Boolean)
  if (!tickers.length) return res.json([])

  const BASE = 'https://api.elections.kalshi.com/trade-api/v2'
  const parseCents = v => {
    if (v == null) return null
    const n = typeof v === 'string' ? parseFloat(v) : Number(v)
    return Number.isFinite(n) ? Math.round(n * 100) : null
  }

  const results = await Promise.all(tickers.map(async ticker => {
    try {
      const path = `/trade-api/v2/markets/${ticker}`
      const headers = getAuthHeaders('GET', path)
      const r = await axios({ method: 'GET', url: BASE + `/markets/${ticker}`, headers, timeout: 8000 })
      const m = r.data?.market
      if (!m) return { ticker, error: 'not found' }
      const yes_bid = m.yes_bid != null ? m.yes_bid : parseCents(m.yes_bid_dollars)
      const yes_ask = m.yes_ask != null ? m.yes_ask : parseCents(m.yes_ask_dollars)
      const mid = (yes_bid != null && yes_ask != null) ? (yes_bid + yes_ask) / 2 : null
      return { ticker, status: m.status, result: m.result ?? null, yes_bid, yes_ask, mid, expiration_value: m.expiration_value ?? null }
    } catch (e) {
      return { ticker, error: e.message }
    }
  }))
  res.json(results)
}))

router.get('/ks/candles', wrap(async (req, res) => {
  const { ticker, period, start_ts, end_ts } = req.query
  if (!ticker) return res.status(400).json({ error: 'ticker required' })
  const periodMinutes = [1, 60, 1440].includes(Number(period)) ? Number(period) : 60
  const startTs = start_ts ? Number(start_ts) : undefined
  const endTs   = end_ts   ? Number(end_ts)   : undefined
  const cacheKey = `${ticker}|${periodMinutes}|${startTs ?? ''}|${endTs ?? ''}`
  const cached = _candlesCache.get(cacheKey)
  if (cached && Date.now() - cached.ts < CANDLES_CACHE_MS) {
    return res.json({ ticker, period_minutes: periodMinutes, candles: cached.candles })
  }
  const candles = await getMarketCandles(ticker, { startTs, endTs, periodMinutes }).catch(() => null)
  const result = candles ?? []
  _candlesCache.set(cacheKey, { ts: Date.now(), candles: result })
  for (const [k, v] of _candlesCache) {
    if (Date.now() - v.ts > CANDLES_CACHE_MS * 2) _candlesCache.delete(k)
  }
  res.json({ ticker, period_minutes: periodMinutes, candles: result })
}))

export default router
