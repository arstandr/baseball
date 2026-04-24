// lib/mlb-live.js — Cached MLB Stats API client for live game data.
// Used by server/api.js /ks/live endpoint (and any future live-data routes).

import { fetch as httpFetch } from './http.js'

const _cache = new Map()
const TTL    = 8_000   // 8-second cache — fast enough for live K updates without hammering MLB

export async function mlbFetch(url) {
  const hit = _cache.get(url)
  if (hit && hit.expiry > Date.now()) return hit.data
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    if (!r.ok) return null
    const data = await r.json()
    _cache.set(url, { data, expiry: Date.now() + TTL })
    return data
  } catch { return null }
}

/**
 * MLB Stats API GET with retry + circuit breaker (via lib/http.js).
 * Returns parsed JSON data or null on failure. No in-memory cache — callers
 * that need caching (server-side hot paths) should use mlbFetch instead.
 */
export async function mlbGet(url, { params } = {}) {
  const result = await httpFetch('mlb-stats', { method: 'GET', url, params, timeout: 8000 })
  return result.ok ? result.data : null
}

function ipToDecimal(ip) {
  const n = Number(ip || 0)
  return Math.floor(n) + Math.round((n % 1) * 10) / 3
}

// Extract starting pitcher live stats from a game boxscore response.
// side: 'home' | 'away'
export function extractStarterFromBoxscore(bs, side) {
  const team = bs?.teams?.[side]
  if (!team) return null
  const ids = team.pitchers || []
  if (!ids.length) return null
  const sid = ids[0]
  const p   = team.players?.[`ID${sid}`]
  if (!p) return null
  const st  = p.stats?.pitching
  if (!st) return null
  return {
    id:       String(sid),
    name:     p.person?.fullName || String(sid),
    ks:       Number(st.strikeOuts      || 0),
    ip:       parseFloat(ipToDecimal(Number(st.inningsPitched || 0)).toFixed(1)),
    bf:       Number(st.battersFaced    || 0),
    pitches:  Number(st.pitchesThrown   || 0),
    still_in: ids[ids.length - 1] === sid,
  }
}
