import WebSocket from 'ws'
import { getAuthHeaders } from './kalshi.js'

const WS_URL = 'wss://api.elections.kalshi.com/trade-api/ws/v2'

const defaultFactory = (url, opts) => new WebSocket(url, opts)

// Lightweight ticker-only subscription — watches public price feeds for specific markets.
// Used by liveMonitor to detect sharp YES mid-price drops, which signal pitcher pulls
// 15–30s before the MLB API boxscore updates.
export function createKalshiTickerWs({ keyId, privateKey, marketTickers, onTicker, onStatus, wsFactory }) {
  let ws = null
  let state = 'closed'
  let _attempt = 0
  let _shouldClose = false
  let _heartbeatInterval = null
  let _pongReceived = true

  function connect() {
    if (_shouldClose) return
    const headers = getAuthHeaders('GET', '/trade-api/ws/v2', {}, { keyId, privateKey })
    ws = (wsFactory || defaultFactory)(WS_URL, { headers })
    state = 'connecting'
    onStatus?.('connecting')

    ws.on('open', () => {
      state = 'open'
      ws.send(JSON.stringify({
        id: 1, cmd: 'subscribe',
        params: { channels: ['ticker'], market_tickers: marketTickers },
      }))
      _pongReceived = true
      _heartbeatInterval = setInterval(() => {
        if (!_pongReceived) { ws.terminate(); return }
        _pongReceived = false
        try { ws.ping() } catch (_) {}
        setTimeout(() => { if (!_pongReceived) ws.terminate() }, 45000)
      }, 30000)
    })

    ws.on('pong', () => { _pongReceived = true })

    ws.on('message', (data) => {
      let msg
      try { msg = JSON.parse(data) } catch (_) { return }
      if (msg.type === 'subscribed') {
        state = 'subscribed'
        onStatus?.('subscribed')
        _attempt = 0
      } else if (msg.type === 'ticker' && msg.msg?.market_ticker) {
        const p = msg.msg
        const yesBid = p.yes_bid ?? null
        const yesAsk = p.yes_ask ?? null
        if (yesBid != null && yesAsk != null) {
          const yesMid = (yesBid + yesAsk) / 2
          onTicker?.({ ticker: p.market_ticker, yesBid, yesAsk, yesMid })
        }
      }
    })

    ws.on('close', () => { _clearHeartbeat(); state = 'closed'; onStatus?.('closed'); _scheduleReconnect() })
    ws.on('error', () => { _clearHeartbeat(); state = 'closed'; onStatus?.('closed'); _scheduleReconnect() })
  }

  function _clearHeartbeat() {
    if (_heartbeatInterval) { clearInterval(_heartbeatInterval); _heartbeatInterval = null }
  }
  function _scheduleReconnect() {
    if (_shouldClose) return
    const delay = Math.min(30000, 1000 * Math.pow(2, _attempt)) + Math.floor(Math.random() * 500)
    _attempt = Math.min(_attempt + 1, 5)
    setTimeout(() => connect(), delay)
  }
  function close() { _shouldClose = true; _clearHeartbeat(); ws?.terminate() }
  function isOpen() { return state === 'subscribed' }

  // Apr 28 — add tickers to a live subscription (R1 fix).
  // Kalshi WS allows multiple independent subscribe commands on a single connection.
  // Used by liveMonitor when a late-added pitcher's bets need WS pull-signal coverage
  // (without this, late lineup additions fall back to ~30s API polling).
  let _nextId = 2
  function addTickers(newTickers) {
    if (!ws || state !== 'subscribed' || !Array.isArray(newTickers) || !newTickers.length) return false
    try {
      ws.send(JSON.stringify({
        id: _nextId++, cmd: 'subscribe',
        params: { channels: ['ticker'], market_tickers: newTickers },
      }))
      return true
    } catch { return false }
  }

  return { connect, close, isOpen, addTickers }
}

export function createKalshiWsClient({ userId, name, keyId, privateKey, onEvent, onStatus, wsFactory }) {
  let ws = null
  let state = 'closed'
  let _attempt = 0
  let _shouldClose = false
  let _heartbeatInterval = null
  let _pongReceived = true
  let lastMsgAt = null

  function connect() {
    if (_shouldClose) return

    const headers = getAuthHeaders('GET', '/trade-api/ws/v2', {}, { keyId, privateKey })
    ws = (wsFactory || defaultFactory)(WS_URL, { headers })
    state = 'connecting'
    onStatus('connecting')

    ws.on('open', () => {
      state = 'open'
      onStatus('open')

      ws.send(JSON.stringify({
        id: 1,
        cmd: 'subscribe',
        params: { channels: ['fill', 'user_orders', 'market_positions'] }
      }))

      _pongReceived = true
      _heartbeatInterval = setInterval(() => {
        if (!_pongReceived) {
          ws.terminate()
          return
        }
        _pongReceived = false
        try {
          ws.ping()
        } catch (_) {
          // ignore ping errors — close/error handlers will fire
        }
        setTimeout(() => {
          if (!_pongReceived) {
            ws.terminate()
          }
        }, 45000)
      }, 30000)
    })

    ws.on('pong', () => {
      _pongReceived = true
    })

    ws.on('message', (data) => {
      lastMsgAt = Date.now()

      let msg
      try {
        msg = JSON.parse(data)
      } catch (_) {
        return
      }

      if (msg.type === 'subscribed') {
        state = 'subscribed'
        onStatus('subscribed')
        _attempt = 0
      } else if (msg.type === 'error') {
        onStatus('error:' + (msg.msg?.msg || msg.msg?.message || JSON.stringify(msg.msg)))
      } else if (msg.type === 'fill') {
        onEvent({ channel: 'fill', payload: msg.msg })
      } else if (msg.type === 'user_order') {
        onEvent({ channel: 'order_update', payload: msg.msg })
      } else if (msg.type === 'market_position') {
        onEvent({ channel: 'market_position', payload: msg.msg })
      } else if (msg.type && msg.type !== 'pong') {
        console.log(`[ws ${name}] unrecognized msg type="${msg.type}" — ${JSON.stringify(msg).slice(0, 200)}`)
      }
    })

    ws.on('close', () => {
      _clearHeartbeat()
      state = 'closed'
      onStatus('closed')
      _scheduleReconnect()
    })

    ws.on('error', (err) => {
      _clearHeartbeat()
      state = 'closed'
      onStatus('closed')
      _scheduleReconnect()
    })
  }

  function _clearHeartbeat() {
    if (_heartbeatInterval) {
      clearInterval(_heartbeatInterval)
      _heartbeatInterval = null
    }
  }

  function _scheduleReconnect() {
    if (_shouldClose) return

    const delay = Math.min(30000, 1000 * Math.pow(2, _attempt)) + Math.floor(Math.random() * 500)
    _attempt = Math.min(_attempt + 1, 5)
    console.log(`[ws ${name}] reconnecting in ${delay}ms (attempt ${_attempt})`)
    setTimeout(() => connect(), delay)
  }

  function close() {
    _shouldClose = true
    _clearHeartbeat()
    ws?.terminate()
  }

  function isOpen() {
    return state === 'subscribed'
  }

  function getState() {
    return state
  }

  return { connect, close, isOpen, getState, get lastMsgAt() { return lastMsgAt } }
}
