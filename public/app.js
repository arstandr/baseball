// Boot entry — imports focused modules, wires UI, starts the app.
import { state, shared } from './app/state.js'
import { fmt$, esc } from './app/utils.js'
import { fetchJson } from './app/api.js'
import { connectSSE, updateLastUpdated } from './app/live.js'
import { initTrendsPeriodBar, refreshTrendsView } from './app/views/trends.js'
import { refreshTestingView }            from './app/views/testing.js'
import { refreshLogView }                from './app/views/log.js'
import { refreshSettings }               from './app/views/settings.js'
import { refreshPipelineView }               from './app/views/pipeline.js'
import {
  refreshTodayView, stopLivePolling, buildBettorDrawer,
} from './app/views/today.js'

// ── Boot ────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', init)

// live.js dispatches this event whenever it calls refreshBettorCards internally
document.addEventListener('ks:refresh-bettors', () => refreshBettorCards())

// game cards use inline onclick — expose to global scope
window.toggleGcDetails = toggleGcDetails

async function init() {
  await loadUser()
  loadDeployTime()
  connectSSE()
  wireTabs()
  applyView(state.view, false)
  await refreshAll()
  setInterval(updateLastSeen, 15 * 1000)
  refreshCloserStatus()
  setInterval(refreshCloserStatus, 60 * 1000)
  initTrendsPeriodBar()
}

// ── Auth / user ──────────────────────────────────────────────────────────────

async function loadUser() {
  try {
    const r = await fetch('/auth/me', { credentials: 'same-origin' })
    if (!r.ok) { window.location.href = '/login'; return }
    const { user } = await r.json()
    state.currentUser   = user?.name
    state.currentUserId = user?.id ?? null
    const n = (user?.name || '—').split(' ')[0]
    document.getElementById('user-name').textContent = n.charAt(0).toUpperCase() + n.slice(1)
  } catch { window.location.href = '/login' }
}

async function loadDeployTime() {
  const el = document.getElementById('deploy-time')
  if (!el) return
  const meta = await fetchJson('/api/meta').catch(() => null)
  if (!meta?.deploy_time) return
  const f = _fmtAgo(meta.deploy_time)
  if (f) el.textContent = `Deployed ${f.timeStr} (${f.ago})`
  if (meta.last_data_update) updateLastUpdated(meta.last_data_update)
}

function _fmtAgo(ts) {
  if (!ts) return null
  const d = new Date(ts)
  const now = new Date()
  const diffMin = Math.round((now - d) / 60000)
  const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const ago = diffMin < 2 ? 'just now'
    : diffMin < 60   ? `${diffMin}m ago`
    : diffMin < 1440 ? `${Math.round(diffMin / 60)}h ago`
    : `${Math.round(diffMin / 1440)}d ago`
  return { timeStr, ago }
}

function updateLastSeen() {
  const el = document.getElementById('last-updated')
  if (!el || !state.lastRefresh) return
  const s = Math.round((Date.now() - state.lastRefresh) / 1000)
  el.textContent = `Updated: ${s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`}`
}

// ── Closer (agent) status ────────────────────────────────────────────────────

async function refreshCloserStatus() {
  const dot   = document.getElementById('closer-dot')
  const meta  = document.getElementById('closer-meta')
  if (!dot || !meta) return

  const data = await fetchJson('/api/agent/status').catch(() => null)
  if (!data?.heartbeat) {
    dot.className = 'closer-dot'
    meta.textContent = 'offline'
    return
  }

  const hb    = data.heartbeat
  const tsRaw = hb.ts || hb.updated_at || null
  const tsStr = tsRaw ? (tsRaw.endsWith('Z') ? tsRaw : tsRaw + 'Z') : null
  const ago   = tsStr && !isNaN(new Date(tsStr)) ? Math.floor((Date.now() - new Date(tsStr).getTime()) / 60000) : null
  const fresh = ago != null && ago < 10

  const codeStale = data.is_current === false  // null = unknown (closer hasn't reported commit yet)
  dot.className = `closer-dot ${fresh ? (codeStale ? 'stale' : 'online') : 'stale'}`

  const fmtMin = m => m === 0 ? 'just now' : m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`

  const metaParts = []
  if (fresh) {
    metaParts.push(hb.status === 'running' ? 'running' : 'idle')
    metaParts.push(fmtMin(ago))
  } else {
    metaParts.push(ago != null ? `last seen ${fmtMin(ago)}` : 'stale')
  }

  if (codeStale) {
    metaParts.push(`· needs update (${hb.commit ?? '?'} → ${data.server_commit ?? '?'})`)
  }

  if (!codeStale && data.last_update?.msg) {
    const u    = data.last_update
    const uRaw = u.ts || u.updated_at || null
    const uTs  = uRaw ? (uRaw.endsWith('Z') ? uRaw : uRaw + 'Z') : null
    const uAgo = uTs && !isNaN(new Date(uTs)) ? Math.floor((Date.now() - new Date(uTs).getTime()) / 60000) : null
    metaParts.push(`· updated ${uAgo != null ? fmtMin(uAgo) : 'recently'}`)
  }

  meta.textContent = metaParts.join(' ')
}

// ── Tab switching ────────────────────────────────────────────────────────────

function wireTabs() {
  document.querySelectorAll('.mode[data-view]').forEach(btn => {
    btn.addEventListener('click', () => applyView(btn.dataset.view))
  })

  // Click a pitcher card to expand — exclude Kalshi links
  document.addEventListener('click', e => {
    if (e.target.closest('a')) return
    const card = e.target.closest('.pitcher-card')
    if (!card) return
    const body = card.querySelector('.pc-body')
    if (!body) return
    const isOpen = card.classList.toggle('open')
    body.hidden = !isOpen
  })
}

function applyView(view, refresh = true) {
  state.view = view
  localStorage.setItem('ks.view', view)
  document.querySelectorAll('.mode[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === view))
  document.querySelectorAll('.view').forEach(s => s.hidden = true)
  const el = document.getElementById(`view-${view}`)
  if (el) el.hidden = false
  if (view !== 'today') stopLivePolling()
  if (refresh) refreshAll()
}

// ── Refresh orchestration ────────────────────────────────────────────────────

function _resolveLiveBettor(bettors) {
  const sessionName = (state.currentUser || '').toLowerCase().split(' ')[0]
  const myBettor    = sessionName
    ? (bettors || []).find(b => b.name?.toLowerCase().includes(sessionName))
    : null
  const liveBettor  = myBettor || (bettors || []).find(b => !b.paper)
  if (liveBettor) {
    state.liveBettorId       = liveBettor.id
    state.liveBettorTodayPnl = liveBettor.today_pnl
  }
}

async function refreshAll() {
  const bettors = await fetchJson('/api/ks/bettors').catch(() => [])
  shared.bettors = bettors.filter(b => !b.paper)
  _resolveLiveBettor(bettors)

  const viewRefresh =
    state.view === 'today'    ? refreshTodayView()    :
    state.view === 'trends'   ? refreshTrendsView()   :
    state.view === 'testing'  ? refreshTestingView()  :
    state.view === 'log'      ? refreshLogView()      :
    state.view === 'pipeline' ? refreshPipelineView() :
    state.view === 'settings' ? refreshSettings()     : null

  await Promise.all([
    refreshHero(bettors),
    refreshBettorCards(bettors),
    viewRefresh,
  ].filter(Boolean))

  state.lastRefresh = Date.now()
  updateLastSeen()
}

async function refreshHero(bettors) {
  const list = bettors ?? await fetchJson('/api/ks/bettors').catch(() => [])
  _resolveLiveBettor(list)
  const uidParam = state.liveBettorId ? `?user_id=${state.liveBettorId}` : ''
  await fetchJson(`/api/ks/summary${uidParam}`).catch(() => null)
}

// ── Per-bettor cards ─────────────────────────────────────────────────────────

async function refreshBettorCards(bettors) {
  const bettorList = bettors ?? await fetchJson('/api/ks/bettors').catch(() => [])
  bettors = bettorList
  const wrap = document.getElementById('bettor-cards')
  if (!wrap || !bettors.length) return

  wrap.style.display = 'grid'
  wrap.className = 'sc-bettor-cards'
  wrap.innerHTML = bettors.map(b => {
    const pnlCls   = b.total_pnl >= 0 ? 'good' : 'bad'
    const pnlSign  = b.total_pnl >= 0 ? '+' : ''
    const todayCls = b.today_pnl > 0 ? 'good' : b.today_pnl < 0 ? 'bad' : ''
    const todaySign = b.today_pnl >= 0 ? '+' : ''
    const record   = `${b.wins}W · ${b.losses}L${b.pending > 0 ? ` · ${b.pending} pending` : ''}`
    const modeBadge = b.paper
      ? `<span class="bettor-mode-dry">💧 Dry Mode</span>`
      : `<span class="bettor-mode-live">⚡ Live</span>`
    return `
      <div class="sc-bettor-card bettor-card" data-bettor-id="${b.id}">
        <div class="bettor-card-top" style="padding:0;cursor:default">
          <div class="sc-bettor-name">${b.name} &nbsp; ${modeBadge}
            <button class="dry-toggle ${b.paper ? 'dry-on' : 'dry-off'}" data-id="${b.id}" style="margin-left:8px">
              ${b.paper ? 'Switch to Live' : 'Switch to Dry'}
            </button>
          </div>
          <div class="sc-bettor-balance">${fmt$(b.kalshi_cash ?? b.bankroll, true)}</div>
          ${b.kalshi_exposure > 0 ? `<div class="sc-bettor-start">+${fmt$(b.kalshi_exposure)} in open positions</div>` : ''}
          <div class="sc-bettor-day-row">
            <div>
              <div class="sc-bettor-day-label">TODAY</div>
              <div class="sc-bettor-day-val ${todayCls}">${todaySign}${fmt$(b.today_pnl)}</div>
            </div>
            <div>
              <div class="sc-bettor-day-label">BEST CASE</div>
              <div class="sc-bettor-day-val good" id="bettor-bestcase-${b.id}">…</div>
            </div>
          </div>
          <div class="sc-bettor-pnl ${pnlCls}">${pnlSign}${fmt$(b.total_pnl)} all-time P&L</div>
          <div class="sc-bettor-record">${record}</div>
        </div>
        <div class="bettor-drawer" hidden></div>
      </div>`
  }).join('')

  wrap.querySelectorAll('.dry-toggle').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation()
      const id = btn.dataset.id
      btn.disabled = true
      const res = await fetchJson(`/api/users/${id}/toggle-live`, { method: 'POST' }).catch(() => null)
      if (res?.ok) {
        btn.className = `dry-toggle ${res.paper ? 'dry-on' : 'dry-off'}`
        btn.textContent = res.paper ? '💧 DRY MODE' : '⚡ LIVE'
      }
      btn.disabled = false
    })
  })

  wrap.querySelectorAll('.bettor-card-top').forEach(top => {
    top.addEventListener('click', async e => {
      if (e.target.closest('.dry-toggle')) return
      const card     = top.closest('.bettor-card')
      const drawer   = card.querySelector('.bettor-drawer')
      const expandBtn = top.querySelector('.bettor-expand-btn')
      const isOpen   = !drawer.hidden
      if (isOpen) {
        drawer.hidden = true
        if (expandBtn) expandBtn.textContent = '▾'
        return
      }
      drawer.hidden = false
      if (expandBtn) expandBtn.textContent = '▴'
      if (!drawer.dataset.loaded) {
        drawer.innerHTML = '<div class="dr-loading">Loading…</div>'
        const bettorId = Number(card.dataset.bettorId)
        const b = bettors.find(x => x.id === bettorId)
        await buildBettorDrawer(drawer, b)
        drawer.dataset.loaded = '1'
      }
    })
  })

  for (const b of bettors) {
    const bcEl = document.getElementById(`bettor-bestcase-${b.id}`)
    if (!bcEl) continue
    if (b.best_case != null) {
      bcEl.textContent = (b.best_case >= 0 ? '+' : '') + fmt$(b.best_case)
      bcEl.className = `sc-bettor-day-val ${b.best_case >= 0 ? 'good' : 'bad'}`
      bcEl.style.cssText = 'font-size:20px;font-weight:700;font-family:var(--mono)'
    } else {
      bcEl.textContent = '—'
      bcEl.className = 'sc-bettor-day-val'
      bcEl.style.cssText = 'font-size:20px;font-weight:700;font-family:var(--mono);color:var(--muted)'
    }
  }
}

// ── Game card helpers (called via global onclick) ────────────────────────────

function toggleGcDetails(cardId) {
  const det   = document.getElementById(`${cardId}-det`)
  const label = document.getElementById(`${cardId}-tlbl`)
  if (!det) return
  const opening = det.hidden
  det.hidden = !opening
  if (label) label.textContent = opening ? 'Hide details ‹' : 'Show details ›'
}
