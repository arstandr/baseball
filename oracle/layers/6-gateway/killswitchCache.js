// oracle/layers/6-gateway/killswitchCache.js
//
// 1-second TTL in-memory cache over gateway_killswitch.
// Spec v1.0 §8: TTL = 1s for ALL keys. Safety > efficiency.
//
// Stores the FULL killswitch state as a single object. Refreshes lazily on
// first access after TTL expiry. The fetcher is injected so this module is
// trivially unit-testable without a real DB.
//
// Values are stored as parsed JSON (or raw strings for primitives like 'true').
// Callers receive a normalized snapshot:
//   {
//     gateway_kill_all: bool,
//     gateway_kill_agent: string[],
//     gateway_kill_mode: string[],
//     gateway_kill_account: string[],
//     min_version_by_agent: { [agent]: semver },
//     monitor_only_stale_agent: { [agent]: bool },
//     allowed_commit_hash_by_agent: { [agent]: string[] },
//     daily_loss_limit_by_account: { [account]: number },
//     daily_risk_limit_by_account: { [account]: number },
//     max_order_usd_by_mode: { [strategy_mode]: number },
//     _fetchedAt: number,
//   }

import { KILLSWITCH_KEYS } from './enums.js'

export const KILLSWITCH_TTL_MS = 1_000

const DEFAULTS = Object.freeze({
  gateway_kill_all:               false,
  gateway_kill_agent:             [],
  gateway_kill_mode:              [],
  gateway_kill_account:           [],
  min_version_by_agent:           {},
  monitor_only_stale_agent:       {},
  allowed_commit_hash_by_agent:   {},
  daily_loss_limit_by_account:    {},
  daily_risk_limit_by_account:    {},
  max_order_usd_by_mode:          {},
})

function parseValue(key, raw) {
  if (raw == null) return DEFAULTS[key]
  if (key === 'gateway_kill_all') {
    return raw === 'true' || raw === true || raw === '1' || raw === 1
  }
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(raw)
  } catch {
    return DEFAULTS[key]
  }
}

export function normalize(rows) {
  // rows: array of { key, value } from gateway_killswitch
  const byKey = new Map()
  for (const r of rows ?? []) byKey.set(r.key, r.value)
  const out = { _fetchedAt: Date.now() }
  for (const k of KILLSWITCH_KEYS) {
    out[k] = parseValue(k, byKey.get(k))
  }
  return out
}

export function makeKillswitchCache({ fetcher, ttlMs = KILLSWITCH_TTL_MS, now = () => Date.now() } = {}) {
  if (typeof fetcher !== 'function') {
    throw new Error('makeKillswitchCache: fetcher required (async function returning rows)')
  }
  let _snapshot = null
  let _expiresAt = 0
  let _inflight = null

  async function load() {
    if (_inflight) return _inflight
    _inflight = (async () => {
      const rows = await fetcher()
      _snapshot = normalize(rows)
      _expiresAt = now() + ttlMs
      _inflight = null
      return _snapshot
    })()
    return _inflight
  }

  async function get() {
    if (_snapshot && now() < _expiresAt) return _snapshot
    return load()
  }

  function invalidate() {
    _snapshot = null
    _expiresAt = 0
  }

  function peek() {
    return _snapshot  // may be null if never loaded
  }

  return { get, invalidate, peek, load }
}

export const _DEFAULTS_FOR_TEST = DEFAULTS
