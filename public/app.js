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
import { refreshCalibrationView } from './app/views/calibration.js'

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
  refreshCageStatus()
  setInterval(refreshCageStatus, 60 * 1000)
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

// ── Cage (Railway production) status ─────────────────────────────────────────

async function refreshCageStatus() {
  const dot   = document.getElementById('cage-dot')
  const meta  = document.getElementById('cage-meta')
  if (!dot || !meta) return

  const data = await fetchJson('/api/admin/status').catch(() => null)
  const cage = data?.cage
  if (!cage) {
    dot.className = 'closer-dot'
    meta.textContent = 'offline'
    return
  }

  const schedAge = cage.scheduler_heartbeat_age_s
  const liveAge  = cage.liveMonitor_heartbeat_age_s
  const reconStatus = cage.last_reconciliation_status
  const halted = data.trading_halted === true || data.trading_halted === 1
  const ddHalted = cage.drawdown_halted === true || cage.drawdown_halted === 1
  const kalshiOutage = cage.kalshi_outage === true || cage.kalshi_outage === 1
  const paperMode = data.posture?.kalshi_paper_mode === true || data.posture?.kalshi_paper_mode === 1

  // Roll-up: RED if scheduler dead or recon failed; AMBER if halted/drawdown/paper/liveMonitor stale; GREEN otherwise
  let level = 'green'
  let label = 'healthy'

  if (schedAge == null || schedAge > 180) {
    level = 'red'
    label = 'scheduler down'
  } else if (reconStatus === 'mismatch' || reconStatus === 'error') {
    level = 'red'
    label = `recon ${reconStatus}`
  } else if (kalshiOutage) {
    level = 'red'
    label = 'kalshi outage'
  } else if (halted) {
    level = 'amber'
    label = 'halted'
  } else if (ddHalted) {
    level = 'amber'
    label = 'drawdown'
  } else if (paperMode) {
    level = 'amber'
    label = 'paper mode'
  } else if (liveAge != null && liveAge > 600) {
    level = 'amber'
    label = 'liveMonitor idle'
  }

  const dotClass = level === 'green' ? 'online' : 'stale'
  dot.className = `closer-dot ${dotClass}`

  const fmtAge = s => {
    if (s == null) return '—'
    if (s < 60) return `${Math.round(s)}s`
    if (s < 3600) return `${Math.round(s / 60)}m`
    return `${Math.round(s / 3600)}h`
  }

  const parts = [label]
  if (schedAge != null) parts.push(`· sched ${fmtAge(schedAge)}`)
  meta.textContent = parts.join(' ')
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
    state.view === 'settings'     ? refreshSettings()          :
    state.view === 'calibration'  ? refreshCalibrationView()   : null

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
        <div class="bettor-card-top" style="padding:0;cursor:pointer">
          <div class="sc-bettor-name">${b.name} &nbsp; ${modeBadge}
            <button class="dry-toggle ${b.paper ? 'dry-on' : 'dry-off'}" data-id="${b.id}" style="margin-left:8px">
              ${b.paper ? 'Switch to Live' : 'Switch to Dry'}
            </button>
          </div>
          <div class="sc-bettor-balance">${fmt$(b.kalshi_cash ?? b.bankroll, true)}</div>
          ${b.projected_bank != null ? `<div class="sc-bettor-start">→ ${fmt$(b.projected_bank)} projected</div>` : (b.kalshi_exposure > 0 ? `<div class="sc-bettor-start">+${fmt$(b.kalshi_exposure)} in open positions</div>` : '')}
          <div class="sc-bettor-day-row">
            <div>
              <div class="sc-bettor-day-label">LOCKED</div>
              <div class="sc-bettor-day-val ${todayCls}">${todaySign}${fmt$(b.today_pnl)}</div>
              <div class="sc-bettor-day-sublabel">confirmed P&amp;L</div>
            </div>
            <div>
              <div class="sc-bettor-day-label">UPSIDE</div>
              <div class="sc-bettor-day-val good" id="bettor-bestcase-${b.id}">…</div>
              <div class="sc-bettor-day-sublabel">if all pending win</div>
            </div>
          </div>
          <div class="sc-bettor-pnl ${pnlCls}">${pnlSign}${fmt$(b.total_pnl)} all-time P&L</div>
          <div class="sc-bettor-record">${record}</div>
          <div class="sc-bettor-expand-hint">Tap for breakdown &amp; bets <span class="sc-bettor-chevron">▾</span></div>
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

  const allCards = [...wrap.querySelectorAll('.bettor-card')]
  allCards.forEach(card => {
    card.addEventListener('click', async e => {
      if (e.target.closest('.dry-toggle')) return
      const anyOpen = allCards.some(c => c.querySelector('.bettor-drawer')?.classList.contains('bettor-drawer-open'))
      if (anyOpen) {
        // Close all
        allCards.forEach(c => {
          c.querySelector('.bettor-drawer')?.classList.remove('bettor-drawer-open')
          const ch = c.querySelector('.sc-bettor-chevron')
          if (ch) ch.style.transform = ''
        })
        return
      }
      // Open all simultaneously, load each drawer's content in parallel
      await Promise.all(allCards.map(async c => {
        const drawer  = c.querySelector('.bettor-drawer')
        const chevron = c.querySelector('.sc-bettor-chevron')
        drawer.hidden = false
        requestAnimationFrame(() => drawer.classList.add('bettor-drawer-open'))
        if (chevron) chevron.style.transform = 'rotate(180deg)'
        if (!drawer.dataset.loaded) {
          const bettorId = Number(c.dataset.bettorId)
          const b = bettors.find(x => x.id === bettorId)
          await buildBettorDrawer(drawer, b)
          drawer.dataset.loaded = '1'
        }
      }))
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
