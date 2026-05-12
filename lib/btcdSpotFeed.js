// lib/btcdSpotFeed.js — Bitcoin spot price feed
//
// Polls Coinbase BTC-USD spot every 5s, keeps a 15-minute rolling history.
// Used as a sanity check on Kalshi BTCD strike levels and to detect vol
// regime changes that should temporarily halt signaling.

import axios from 'axios'

const POLL_MS_DEFAULT = 5_000
const HISTORY_MS = 15 * 60 * 1_000

const _state = {
  spot: null,
  spotTs: 0,
  history: [],          // [{ts, price}]
  pollTimer: null,
  consecutiveErrors: 0,
}

async function pollOnce() {
  try {
    const r = await axios.get('https://api.coinbase.com/v2/prices/BTC-USD/spot', { timeout: 5000 })
    const price = parseFloat(r.data?.data?.amount)
    if (!Number.isFinite(price)) throw new Error('bad spot payload')
    const ts = Date.now()
    _state.spot = price
    _state.spotTs = ts
    _state.history.push({ ts, price })
    const cutoff = ts - HISTORY_MS
    while (_state.history.length && _state.history[0].ts < cutoff) _state.history.shift()
    _state.consecutiveErrors = 0
  } catch (e) {
    _state.consecutiveErrors++
    if (_state.consecutiveErrors === 1 || _state.consecutiveErrors % 12 === 0) {
      console.warn(`[btcdSpotFeed] poll error #${_state.consecutiveErrors}:`, e.message)
    }
  }
}

export function startSpotFeed({ intervalMs = POLL_MS_DEFAULT } = {}) {
  if (_state.pollTimer) return _state.pollTimer
  pollOnce()
  _state.pollTimer = setInterval(pollOnce, intervalMs)
  _state.pollTimer.unref?.()
  return _state.pollTimer
}

export function stopSpotFeed() {
  if (_state.pollTimer) {
    clearInterval(_state.pollTimer)
    _state.pollTimer = null
  }
}

export function getSpot() {
  return _state.spot
}

export function getSpotAgeMs() {
  return _state.spotTs ? Date.now() - _state.spotTs : Infinity
}

// Returns the price range / midpoint over the last `windowMinutes` minutes.
// Use as a coarse 1-window realized vol proxy — when > maxVol guard threshold,
// halt new signaling (the regime is moving too fast for the edge to apply).
export function getRecentRange(windowMinutes = 5) {
  const cutoff = Date.now() - windowMinutes * 60 * 1000
  const pts = _state.history.filter(p => p.ts > cutoff)
  if (pts.length < 2) return null
  const prices = pts.map(p => p.price)
  const max = Math.max(...prices)
  const min = Math.min(...prices)
  return (max - min) / ((max + min) / 2)
}

export function getHealth() {
  return {
    spot: _state.spot,
    spotAgeMs: getSpotAgeMs(),
    historyPoints: _state.history.length,
    consecutiveErrors: _state.consecutiveErrors,
  }
}
