// lib/utils.js — Shared utility functions used across server routes and scripts.

export function safeJson(str, fallback = null) {
  if (str == null) return fallback
  try { return JSON.parse(str) } catch { return fallback }
}

export function todayISO() {
  return new Date().toISOString().slice(0, 10)
}

export function roundTo(n, d = 4) {
  if (n == null || Number.isNaN(n)) return 0
  const f = 10 ** d
  return Math.round(n * f) / f
}

export function winRate(wins, losses) {
  const d = (wins || 0) + (losses || 0)
  return d > 0 ? (wins || 0) / d : 0
}

export function fmtShort(d) {
  const m = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${m[d.getUTCMonth()]} ${d.getUTCDate()}`
}
