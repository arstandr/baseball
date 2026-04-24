export async function fetchJson(url, opts = {}) {
  const r = await fetch(url, { credentials: 'same-origin', ...opts })
  if (r.status === 401) { window.location.href = '/login'; return Promise.reject('unauth') }
  if (!r.ok) return Promise.reject(new Error(`HTTP ${r.status}`))
  return r.json()
}
