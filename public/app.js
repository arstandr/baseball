// KSBETS dashboard — Strikeout P&L tracker
// Fetches /api/ks/* and /api/users, renders all four views.

const state = {
  view:           localStorage.getItem('ks.view') || 'today',
  selectedDate:   null,
  charts:         { bankroll: null, daily: null, weekly: null },
  log:            { page: 1, pitcher: '', side: '', result: '', from: '', to: '', sort: 'bet_date', dir: 'desc' },
  lastRefresh:    null,
  currentUser:    null,
  currentUserId:  null,
  liveBettorId:   null,   // ID of the live (non-paper) bettor; drives all data fetches
  liveTimer:      null,
  countdownTimer: null,
}

// Live overlay: pitcher_id → { ks, still_in, is_final }
// Updated every poll cycle; used by computeMaxTheoretical to reflect pulled/finished pitchers
let _liveOverlay = {}
let _dailyPitchers = []

// ──────────────────────────────────────────────────────────────────────────
// Boot
// ──────────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init)

async function init() {
  await loadUser()
  loadDeployTime()
  connectSSE()
  wireTabs()
  applyView(state.view, false)
  await refreshAll()
  setInterval(refreshHero, 3 * 60 * 1000)
  setInterval(updateLastSeen, 15 * 1000)
}

function fmtAgo(ts) {
  if (!ts) return null
  const d = new Date(ts)
  const now = new Date()
  const diffMin = Math.round((now - d) / 60000)
  const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const ago = diffMin < 2
    ? 'just now'
    : diffMin < 60
    ? `${diffMin}m ago`
    : diffMin < 1440
    ? `${Math.round(diffMin / 60)}h ago`
    : `${Math.round(diffMin / 1440)}d ago`
  return { timeStr, ago }
}

function updateLastUpdated(ts) {
  const el = document.getElementById('last-updated')
  if (!el || !ts) return
  const f = fmtAgo(ts)
  if (f) el.textContent = `Updated ${f.timeStr} (${f.ago})`
}

async function loadDeployTime() {
  const el = document.getElementById('deploy-time')
  if (!el) return
  const meta = await fetchJson('/api/meta').catch(() => null)
  if (!meta?.deploy_time) return
  const f = fmtAgo(meta.deploy_time)
  if (f) el.textContent = `Deployed ${f.timeStr} (${f.ago})`
  if (meta.last_data_update) updateLastUpdated(meta.last_data_update)
}

function connectSSE() {
  const es = new EventSource('/api/events')
  es.onmessage = e => {
    try {
      const ev = JSON.parse(e.data)
      const date = state.selectedDate || new Date().toISOString().slice(0, 10)
      if (ev.lastDataUpdate) updateLastUpdated(ev.lastDataUpdate)
      if (ev.type === 'settled') {
        // Snapshot current results before reload so we can detect covers
        const prevResults = {}
        for (const p of _dailyPitchers) {
          for (const b of p.bets) {
            prevResults[b.id] = { result: b.result, pitcher_name: p.pitcher_name, pitcher_id: p.pitcher_id }
          }
        }
        if (state.view === 'today') {
          loadDay(date).then(() => {
            // After reload: find bets that just went pending → win or → loss
            const newlyCovered = new Set()
            for (const p of _dailyPitchers) {
              for (const b of p.bets) {
                const prev = prevResults[b.id]
                if (!prev || prev.result) continue // wasn't pending before
                if (b.result === 'win') {
                  if (!newlyCovered.has(String(p.pitcher_id))) {
                    newlyCovered.add(String(p.pitcher_id))
                    flashPitcherCard(p.pitcher_id, 'win', p.pitcher_name)
                  }
                } else if (b.result === 'loss') {
                  if (!newlyCovered.has(String(p.pitcher_id))) {
                    newlyCovered.add(String(p.pitcher_id))
                    flashPitcherCard(p.pitcher_id, 'loss', p.pitcher_name)
                  }
                }
              }
            }
          })
        }
        refreshBettorCards()
      }
      if (ev.type === 'live_bet') {
        if (state.view === 'today') loadLiveBets(date)
        refreshBettorCards()
      }
    } catch {}
  }
  es.onerror = () => { es.close(); setTimeout(connectSSE, 5000) }
}

function flashPitcherCard(pitcherId, type, pitcherName) {
  const card = pitcherId
    ? document.querySelector(`.pitcher-card[data-pitcher-id="${CSS.escape(String(pitcherId))}"]`)
    : null
  if (card) {
    card.classList.remove('flash-win', 'flash-loss')
    void card.offsetWidth  // force reflow so animation restarts
    card.classList.add(`flash-${type}`)
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    setTimeout(() => card.classList.remove(`flash-${type}`), 3500)
  }
  const name = pitcherName || 'Bet'
  const msg  = type === 'win' ? `✓ COVERED — ${name} just won!` : `✗ ${name} bet settled as a loss`
  showToast(msg, type)
}

function showToast(message, type = 'win') {
  let toast = document.getElementById('cover-toast')
  if (!toast) {
    toast = document.createElement('div')
    toast.id        = 'cover-toast'
    toast.className = 'cover-toast'
    document.body.appendChild(toast)
  }
  toast.textContent = message
  toast.className   = `cover-toast cover-toast--${type} cover-toast--show`
  clearTimeout(toast._timer)
  toast._timer = setTimeout(() => toast.classList.remove('cover-toast--show'), 5000)
}

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

// ──────────────────────────────────────────────────────────────────────────
// Tab switching
// ──────────────────────────────────────────────────────────────────────────
function wireTabs() {
  document.querySelectorAll('.mode[data-view]').forEach(btn => {
    btn.addEventListener('click', () => applyView(btn.dataset.view))
  })

  // Click anywhere on a pitcher card to expand — exclude Kalshi links
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

// ──────────────────────────────────────────────────────────────────────────
// Refresh orchestration
// ──────────────────────────────────────────────────────────────────────────
async function refreshAll() {
  await refreshHero()
  await refreshBettorCards()
  if (state.view === 'today')    await refreshTodayView()
  if (state.view === 'trends')   await refreshTrendsView()
  if (state.view === 'testing')  await refreshTestingView()
  if (state.view === 'log')      await refreshLogView()
  if (state.view === 'settings') await refreshSettings()
  state.lastRefresh = Date.now()
  updateLastSeen()
}

async function refreshHero() {
  // Fetch bettors first to get liveBettorId, then fetch summary scoped to that user.
  // This avoids a chicken-and-egg where the first summary call has no user filter.
  const bettors = await fetchJson('/api/ks/bettors').catch(() => [])
  // Match hero to the logged-in user by name (e.g. 'adam' matches 'adam-live')
  const sessionName = (state.currentUser || '').toLowerCase().split(' ')[0]
  const myBettor = sessionName
    ? (bettors || []).find(b => b.name?.toLowerCase().includes(sessionName))
    : null
  const liveBettor = myBettor || (bettors || []).find(b => !b.paper)
  if (liveBettor) state.liveBettorId = liveBettor.id  // cache so all data fetches use the right user

  const uidParam = state.liveBettorId ? `?user_id=${state.liveBettorId}` : ''
  const s = await fetchJson(`/api/ks/summary${uidParam}`).catch(() => null)
  if (!s) return

  const heroBalance  = liveBettor?.bankroll       ?? s.kalshi_balance ?? s.bankroll
  const heroStart    = liveBettor?.start_bankroll  ?? s.start_bankroll
  const heroTotalPnl = liveBettor?.total_pnl       ?? s.total_pnl

  // ── New status hero ──────────────────────────────────────────────────────
  const bankrollEl = document.getElementById('sh-bankroll')
  if (bankrollEl) {
    bankrollEl.textContent = fmt$(heroBalance, true)
    bankrollEl.className = 'sh-stat-value'
  }
  setText('sh-start', fmt$(heroStart, true))

  const totalPnlEl = document.getElementById('sh-total-pnl')
  if (totalPnlEl) {
    const sign = heroTotalPnl >= 0 ? '+' : ''
    totalPnlEl.textContent = sign + fmt$(heroTotalPnl)
    totalPnlEl.className   = `sh-stat-value ${heroTotalPnl >= 0 ? 'good' : 'bad'}`
  }
  const roiEl = document.getElementById('sh-total-roi')
  if (roiEl) {
    const roi = heroStart > 0 ? (heroTotalPnl / heroStart * 100).toFixed(1) : 0
    const roiSign = roi >= 0 ? '+' : ''
    roiEl.textContent = `${roiSign}${roi}% overall`
  }

  // Hide the redundant "Real money account" secondary stat — Kalshi balance is now the primary hero number
  const liveStatEl = document.getElementById('sh-live-stat')
  if (liveStatEl) liveStatEl.style.display = 'none'

  // Note: sh-verdict and sh-record are updated by renderDaySummary (has day-specific data)
}

// ──────────────────────────────────────────────────────────────────────────
// PER-BETTOR CARDS
// ──────────────────────────────────────────────────────────────────────────
async function refreshBettorCards() {
  const bettors = await fetchJson('/api/ks/bettors').catch(() => [])
  const wrap = document.getElementById('bettor-cards')
  if (!wrap || !bettors.length) return

  wrap.style.display = 'grid'
  wrap.className = 'sc-bettor-cards'
  wrap.innerHTML = bettors.map(b => {
    const pnlCls  = b.total_pnl >= 0 ? 'good' : 'bad'
    const pnlSign = b.total_pnl >= 0 ? '+' : ''
    const record  = `${b.wins}W · ${b.losses}L${b.pending > 0 ? ` · ${b.pending} pending` : ''}`
    const modeBadge = b.paper
      ? `<span style="font-size:12px;color:#94a3b8">💧 DRY MODE</span>`
      : `<span style="font-size:12px;color:#22c55e">⚡ LIVE</span>`
    return `
      <div class="sc-bettor-card bettor-card" data-bettor-id="${b.id}">
        <div class="bettor-card-top" style="padding:0;cursor:default">
          <div class="sc-bettor-name">${b.name} &nbsp; ${modeBadge}
            <button class="dry-toggle ${b.paper ? 'dry-on' : 'dry-off'}" data-id="${b.id}" style="margin-left:8px">
              ${b.paper ? 'Switch to Live' : 'Switch to Dry'}
            </button>
          </div>
          <div class="sc-bettor-balance">${fmt$(b.bankroll, true)}</div>
          <div class="sc-bettor-start">Started with ${fmt$(b.start_bankroll, true)}</div>
          <div class="sc-bettor-pnl ${pnlCls}">${pnlSign}${fmt$(b.total_pnl)} total profit / loss</div>
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
      const card   = top.closest('.bettor-card')
      const drawer = card.querySelector('.bettor-drawer')
      const expandBtn = top.querySelector('.bettor-expand-btn')
      const isOpen = !drawer.hidden
      if (isOpen) {
        drawer.hidden = true
        expandBtn.textContent = '▾'
        return
      }
      drawer.hidden = false
      expandBtn.textContent = '▴'
      if (!drawer.dataset.loaded) {
        drawer.innerHTML = '<div class="dr-loading">Loading…</div>'
        const bettorId = Number(card.dataset.bettorId)
        const b = bettors.find(x => x.id === bettorId)
        await buildBettorDrawer(drawer, b)
        drawer.dataset.loaded = '1'
      }
    })
  })
}

function betDescPlain(side, strike) {
  return side === 'YES'
    ? `Bet he'd get ${strike} or more strikeouts`
    : `Bet he'd get fewer than ${strike} strikeouts`
}

function betOutcomePlain(side, strike, actualKs, result) {
  if (actualKs == null) return null
  if (side === 'YES') {
    return result === 'win'
      ? `Got ${actualKs} strikeouts — needed ${strike} or more ✓`
      : `Got ${actualKs} strikeout${actualKs !== 1 ? 's' : ''} — needed ${strike} or more ✗`
  } else {
    return result === 'win'
      ? `Got ${actualKs} strikeouts — needed fewer than ${strike} ✓`
      : `Got ${actualKs} strikeout${actualKs !== 1 ? 's' : ''} — needed fewer than ${strike} ✗`
  }
}

function renderSimpleBetList(pitchers, date) {
  const container = document.getElementById('sc-bet-list')
  if (!container) return

  // Flatten all bets with pitcher context
  const allBets = pitchers.flatMap(p =>
    p.bets.map(b => ({ ...b, pitcher_name: p.pitcher_name, pitcher_id: p.pitcher_id }))
  )

  if (!allBets.length) {
    container.innerHTML = '<div class="sc-empty">No bets placed for this date yet.</div><div class="sc-empty-sub">Picks are placed automatically at 9:00 AM Eastern Time.</div>'
    return
  }

  // Sort: losses first, then wins, then pending
  const sortOrder = b => b.result === 'loss' ? 0 : b.result === 'win' ? 1 : 2
  const sorted = [...allBets].sort((a, b) => sortOrder(a) - sortOrder(b))

  const KALSHI_FEE = 0.07

  container.innerHTML = sorted.map(b => {
    const isWin  = b.result === 'win'
    const isLoss = b.result === 'loss'
    const cls    = isWin ? 'sc-win' : isLoss ? 'sc-loss' : 'sc-wait'
    const icon   = isWin ? '✅' : isLoss ? '❌' : '⏳'
    const status = isWin ? 'WON' : isLoss ? 'LOST' : 'IN PROGRESS'

    let amountStr = ''
    if (b.result) {
      const sign = (b.pnl ?? 0) >= 0 ? '+' : ''
      amountStr = `${sign}${fmt$(b.pnl ?? 0)}`
    } else {
      // Best case for pending
      const mid = Number(b.market_mid ?? 50)
      const potential = b.side === 'YES'
        ? (b.bet_size ?? 0) * (100 - mid) / 100 * (1 - KALSHI_FEE)
        : (b.bet_size ?? 0) * mid / 100 * (1 - KALSHI_FEE)
      amountStr = `up to +${fmt$(potential)}`
    }

    const desc    = betDescPlain(b.side, b.strike)
    const outcome = betOutcomePlain(b.side, b.strike, b.actual_ks, b.result)

    // Pending live status text
    let pendingText = ''
    if (!b.result) {
      if (b.actual_ks != null && b.actual_ks > 0) {
        pendingText = `Has ${b.actual_ks} strikeout${b.actual_ks !== 1 ? 's' : ''} so far`
      } else {
        pendingText = 'Game not started yet'
      }
    }

    const edgeStr  = b.edge  != null ? `+${(Number(b.edge) * 100).toFixed(1)}¢` : '—'
    const probStr  = b.model_prob != null ? `${(b.model_prob * 100).toFixed(0)}%` : '—'
    const priceStr = b.market_mid != null ? `${b.market_mid}¢` : '—'
    const wagerStr = b.bet_size   != null ? fmt$(b.bet_size) : '—'

    const detailsId = `sc-det-${b.pitcher_id ?? ''}-${b.strike}-${b.side}`

    return `<div class="sc-bet-card ${cls}">
      <div class="sc-bet-header">
        <span class="sc-bet-icon">${icon}</span>
        <span class="sc-bet-status">${status}</span>
        <span class="sc-bet-amount">${amountStr}</span>
      </div>
      <div class="sc-bet-body">
        <div class="sc-bet-pitcher">${b.pitcher_name}</div>
        <div class="sc-bet-what">${desc}</div>
        ${outcome ? `<div class="sc-bet-outcome">${outcome}</div>` : ''}
        ${pendingText ? `<div class="sc-bet-outcome">${pendingText}</div>` : ''}
      </div>
      <button class="sc-details-btn" onclick="
        var d=document.getElementById('${detailsId}');
        if(d){d.hidden=!d.hidden;this.textContent=d.hidden?'▸ Details':'▾ Hide details'}
      ">▸ Details</button>
      <div id="${detailsId}" class="sc-details-body" hidden>
        <div class="sc-detail-row"><span>Wager size</span><b>${wagerStr}</b></div>
        <div class="sc-detail-row"><span>Market price</span><b>${priceStr}</b></div>
        <div class="sc-detail-row"><span>Our model probability</span><b>${probStr}</b></div>
        <div class="sc-detail-row"><span>Our edge</span><b>${edgeStr}</b></div>
      </div>
    </div>`
  }).join('')
}

async function buildBettorDrawer(drawer, b) {
  const today = new Date().toISOString().slice(0, 10)
  const uid = b.id
  const [dailyData, liveBetsData] = await Promise.all([
    fetchJson(`/api/ks/daily?date=${today}&user_id=${uid}`).catch(() => ({ pitchers: [] })),
    fetchJson(`/api/ks/live-bets?date=${today}&user_id=${uid}`).catch(() => ({ pitchers: [], totals: { bets: 0 } })),
  ])

  const KALSHI_FEE = 0.07
  const allBets = (dailyData.pitchers || []).flatMap(p => p.bets.map(bet => ({ ...bet, pitcher_name: p.pitcher_name })))
  const wins    = allBets.filter(x => x.result === 'win').length
  const losses  = allBets.filter(x => x.result === 'loss').length
  const pending = allBets.filter(x => !x.result).length
  const settled = allBets.filter(x => x.result)
  const settledPnl = settled.reduce((s, x) => s + (x.pnl || 0), 0)

  let atRisk = 0, bestCase = 0
  for (const bet of allBets.filter(x => !x.result)) {
    const mid  = Number(bet.market_mid ?? 50)
    const face = Number(bet.bet_size   ?? 0)
    const hs   = (bet.spread ?? 4) / 2
    const fill = bet.side === 'YES' ? mid + hs : (100 - mid) + hs
    const win  = bet.side === 'YES' ? (100 - mid) - hs : mid - hs
    atRisk   += face * fill / 100
    bestCase += face * win / 100 * (1 - KALSHI_FEE)
  }

  const pnlCls  = settledPnl >= 0 ? 'good' : 'bad'
  const pnlSign = settledPnl >= 0 ? '+' : ''

  // Pre-game bet rows — settled first, then pending
  const sorted = [...allBets].sort((a, x) => {
    if (a.result && !x.result) return -1
    if (!a.result && x.result) return 1
    if (a.result === 'win' && x.result === 'loss') return -1
    if (a.result === 'loss' && x.result === 'win') return 1
    return (a.pitcher_name || '').localeCompare(x.pitcher_name || '')
  })

  const pregameRows = sorted.map(bet => {
    const label   = bet.side === 'YES' ? `YES ${bet.strike}+` : `NO ${bet.strike}+`
    const stCls   = bet.result === 'win' ? 'good' : bet.result === 'loss' ? 'bad' : 'muted'
    const stText  = bet.result === 'win' ? 'WIN' : bet.result === 'loss' ? 'LOSS' : '⏳'
    const pnlText = bet.pnl != null ? `${bet.pnl >= 0 ? '+' : ''}${fmt$(bet.pnl)}` : '—'
    const pnlC    = bet.pnl != null ? (bet.pnl >= 0 ? 'good' : 'bad') : 'muted'
    return `<div class="dr-row">
      <span class="dr-pitcher">${bet.pitcher_name.split(' ').pop()}</span>
      <span class="dr-label">${label}</span>
      <span class="dr-size muted">${fmt$(bet.bet_size)}</span>
      <span class="dr-status ${stCls}">${stText}</span>
      <span class="dr-pnl ${pnlC}">${pnlText}</span>
    </div>`
  }).join('')

  // In-game bet rows
  let liveSection = ''
  if (liveBetsData.totals?.bets > 0) {
    const lt = liveBetsData.totals
    const liveRows = liveBetsData.pitchers.flatMap(p =>
      p.bets.map(bet => {
        const label  = bet.side === 'YES' ? `YES ${bet.strike}+` : `NO ${bet.strike}+`
        const ctx    = bet.live_inning ? `${bet.live_inning} · ${bet.live_ks_at_bet ?? '?'}K` : '—'
        const stCls  = bet.result === 'win' ? 'good' : bet.result === 'loss' ? 'bad' : 'muted'
        const stText = bet.result === 'win' ? 'WIN' : bet.result === 'loss' ? 'LOSS' : '⏳'
        const pnlText = bet.pnl != null ? `${bet.pnl >= 0 ? '+' : ''}${fmt$(bet.pnl)}` : '—'
        const pnlC   = bet.pnl != null ? (bet.pnl >= 0 ? 'good' : 'bad') : 'muted'
        return `<div class="dr-row dr-row-live">
          <span class="dr-pitcher">${p.pitcher_name.split(' ').pop()}</span>
          <span class="dr-label">${label}</span>
          <span class="dr-ctx muted">${ctx}</span>
          <span class="dr-size muted">${fmt$(bet.bet_size)}</span>
          <span class="dr-status ${stCls}">${stText}</span>
          <span class="dr-pnl ${pnlC}">${pnlText}</span>
        </div>`
      })
    ).join('')

    const ltPnlSign = lt.pnl >= 0 ? '+' : ''
    const ltPnlCls  = lt.pnl >= 0 ? 'good' : 'bad'
    liveSection = `
      <div class="dr-section">
        <div class="dr-section-head">IN-GAME WAGERS
          <span class="muted">${lt.bets} bets · ${lt.wins}W ${lt.losses}L ${lt.pending > 0 ? `· ${lt.pending}⏳` : ''} · <span class="${ltPnlCls}">${ltPnlSign}${fmt$(lt.pnl)}</span></span>
        </div>
        <div class="dr-col-head dr-col-head-live"><span>Pitcher</span><span>Bet</span><span>Game State</span><span>Size</span><span>Status</span><span>P&L</span></div>
        ${liveRows}
      </div>`
  }

  const balance = b.kalshi_balance != null ? fmt$(b.kalshi_balance) : 'Paper'
  const modeCls = b.paper ? 'muted' : 'good'

  drawer.innerHTML = `
    <div class="dr-inner">
      <div class="dr-summary">
        <div class="dr-sum-cell">
          <div class="dr-sum-label">SETTLED P&L</div>
          <div class="dr-sum-val ${pnlCls}">${pnlSign}${fmt$(settledPnl)}</div>
          <div class="dr-sum-sub">${wins}W · ${losses}L · ${wins + losses} done</div>
        </div>
        <div class="dr-sum-cell">
          <div class="dr-sum-label">PENDING</div>
          <div class="dr-sum-val">${pending}</div>
          <div class="dr-sum-sub">${fmt$(atRisk)} at risk</div>
        </div>
        <div class="dr-sum-cell">
          <div class="dr-sum-label">BEST CASE</div>
          <div class="dr-sum-val good">+${fmt$(bestCase)}</div>
          <div class="dr-sum-sub">if all pending win</div>
        </div>
      </div>

      <div class="dr-section">
        <div class="dr-section-head">PRE-GAME BETS <span class="muted">${allBets.length} total</span></div>
        <div class="dr-col-head"><span>Pitcher</span><span>Bet</span><span>Size</span><span>Status</span><span>P&L</span></div>
        ${pregameRows || '<div class="dr-empty">No bets logged for this date.</div>'}
      </div>

      ${liveSection}

      <div class="dr-section dr-section-account">
        <div class="dr-sum-cell">
          <div class="dr-sum-label">ACCOUNT</div>
          <div class="dr-sum-val">${balance}</div>
          <div class="dr-sum-sub"><span class="${modeCls}">${b.paper ? '💧 Dry Mode' : '⚡ Live'}</span></div>
        </div>
        <div class="dr-sum-cell">
          <div class="dr-sum-label">DAILY BUDGET</div>
          <div class="dr-sum-val">${fmt$(b.bankroll * b.daily_risk_pct)}</div>
          <div class="dr-sum-sub">${(b.daily_risk_pct * 100).toFixed(0)}% of bankroll</div>
        </div>
      </div>
    </div>`
}

// ──────────────────────────────────────────────────────────────────────────
// TODAY view
// ──────────────────────────────────────────────────────────────────────────
async function refreshTodayView() {
  await refreshDates()
}

async function refreshDates() {
  const uidParam = state.liveBettorId ? `?user_id=${state.liveBettorId}` : ''
  const datesWithBets = await fetchJson(`/api/ks/dates${uidParam}`).catch(() => [])
  const today = new Date().toISOString().slice(0, 10)
  const dates = datesWithBets.includes(today) ? datesWithBets : [today, ...datesWithBets]
  if (!state.selectedDate || !dates.includes(state.selectedDate)) {
    // Default to the most recent date that actually has bets, not today if it's empty
    state.selectedDate = datesWithBets[0] || today
  }

  const container = document.getElementById('date-pills')
  container.innerHTML = ''
  for (const d of dates.slice(0, 14)) {
    const pill = document.createElement('button')
    pill.className = 'date-pill' + (d === state.selectedDate ? ' active' : '')
    pill.textContent = fmtDatePill(d)
    pill.addEventListener('click', () => {
      state.selectedDate = d
      refreshDates()
      loadDay(d)
    })
    container.appendChild(pill)
  }
  await loadDay(state.selectedDate)
}

async function loadDay(date) {
  stopLivePolling()
  const uidParam = state.liveBettorId ? `&user_id=${state.liveBettorId}` : ''
  const data = await fetchJson(`/api/ks/daily?date=${date}${uidParam}`).catch(err => { console.error('[loadDay] fetch failed:', err); return null })
  const list  = document.getElementById('pitcher-list')
  const empty = document.getElementById('empty-today')
  const hdr   = document.getElementById('day-header')
  const liveBanner = document.getElementById('live-banner')

  list.querySelectorAll('.pitcher-card').forEach(el => el.remove())
  if (liveBanner) liveBanner.hidden = true

  if (!data || !data.pitchers?.length) {
    hdr.hidden = true
    empty.hidden = false
    const betList = document.getElementById('sc-bet-list')
    if (betList) betList.innerHTML = '<div class="sc-empty">No bets placed for this date yet.</div><div class="sc-empty-sub">Picks are placed automatically at 9:00 AM Eastern Time.</div>'
    const scSummary = document.getElementById('sc-summary')
    if (scSummary) scSummary.hidden = true
    return
  }
  empty.hidden = true

  _dailyPitchers = data.pitchers || []
  _liveOverlay = {} // reset on new day load

  hdr.hidden = false
  const pnlCls = data.day_pnl >= 0 ? 'good' : 'bad'
  const maxT = computeMaxTheoretical(data.pitchers)
  hdr.innerHTML = `
    <div>
      <div class="day-date">${fmtDateFull(date)}</div>
      <div class="day-meta">${data.pitchers.length} pitcher${data.pitchers.length !== 1 ? 's' : ''} · ${data.day_bets} bets</div>
    </div>
    <div>
      <span class="day-meta">${data.day_wins}W · ${data.day_losses}L${data.day_pending > 0 ? ` · ${data.day_pending} pending` : ''}</span>
    </div>
    <div class="day-pnl ${pnlCls}">${data.day_pnl >= 0 ? '+' : ''}${fmt$(data.day_pnl)}</div>
    <div class="day-max-wrap">
      <span class="day-max-label">best case</span>
      <span class="day-max-val" id="day-max-val">${maxT >= 0 ? '+' : ''}${fmt$(maxT)}</span>
    </div>`

  // Sort by game_time ascending (earliest games first) — live polling switches to live-first
  const sorted = [...data.pitchers].sort((a, b) => {
    if (a.game_time && b.game_time) return a.game_time.localeCompare(b.game_time)
    if (a.game_time) return -1
    if (b.game_time) return 1
    return 0
  })

  for (const p of sorted) {
    try {
      list.appendChild(buildPitcherCard(p))
    } catch (err) {
      console.error('[buildPitcherCard] failed for', p.pitcher_name, err)
    }
  }

  try { renderSimpleBetList(sorted, date) } catch (err) { console.error('[renderSimpleBetList]', err) }

  try { renderDaySummary(date, data) } catch (err) { console.error('[renderDaySummary]', err) }
  try { await loadLiveBets(date)     } catch (err) { console.error('[loadLiveBets]', err) }

  buildLiveBanner(data.pitchers)
  startCountdowns()

  // Start live polling whenever there are pending bets
  if (data.day_pending > 0) startLivePolling(date)
}

function renderDaySummary(date, data) {
  // Update the big status banner in the hero
  const verdictEl   = document.getElementById('sh-verdict')
  const recordEl    = document.getElementById('sh-record')
  const bestcaseCard = document.getElementById('sh-bestcase-card')
  const bestcaseEl  = document.getElementById('sh-bestcase')

  const KALSHI_FEE = 0.07
  let atRisk = 0, bestCase = 0

  if (!data || !data.pitchers?.length) {
    if (verdictEl) verdictEl.textContent = 'No bets for this day.'
    if (recordEl)  recordEl.textContent = ''
    if (bestcaseCard) bestcaseCard.style.display = 'none'
  } else {
    // Compute best case from pending bets
    for (const p of data.pitchers) {
      for (const b of p.bets) {
        if (b.result) continue
        const mid  = Number(b.market_mid ?? 50)
        const face = Number(b.bet_size   ?? 0)
        const hs   = (b.spread ?? 4) / 2
        const fill = b.side === 'YES' ? mid + hs : (100 - mid) + hs
        const win  = b.side === 'YES' ? (100 - mid) - hs : mid - hs
        atRisk   += face * fill / 100
        bestCase += face * win / 100 * (1 - KALSHI_FEE)
      }
    }

    if (verdictEl) {
      const pnl = data.day_pnl
      if (pnl === 0 && data.day_wins === 0 && data.day_losses === 0) {
        verdictEl.textContent = `No settled bets yet today.`
      } else {
        const direction = pnl > 0 ? 'UP' : pnl < 0 ? 'DOWN' : 'EVEN'
        const cls       = pnl > 0 ? 'good' : pnl < 0 ? 'bad' : ''
        const amount    = Math.abs(pnl) > 0.005 ? ` <span class="${cls}">${direction} ${fmt$(Math.abs(pnl))}</span>` : ` <span>EVEN</span>`
        verdictEl.innerHTML = `Today you are${amount}`
      }
    }

    if (recordEl) {
      const parts = []
      if (data.day_wins > 0)    parts.push(`${data.day_wins} bet${data.day_wins !== 1 ? 's' : ''} won`)
      if (data.day_losses > 0)  parts.push(`${data.day_losses} lost`)
      if (data.day_pending > 0) parts.push(`${data.day_pending} still settling`)
      if (parts.length === 0 && (data.day_wins + data.day_losses + data.day_pending) === 0)
        parts.push('No activity yet')
      recordEl.textContent = parts.join(' · ')
    }

    if (bestcaseCard && bestcaseEl) {
      if (data.day_pending > 0) {
        bestcaseCard.style.display = 'flex'
        const projectedEnd = data.day_pnl + bestCase
        const sign = projectedEnd >= 0 ? '+' : ''
        bestcaseEl.textContent = sign + fmt$(projectedEnd)
        bestcaseEl.className = `sh-stat-value ${projectedEnd >= 0 ? 'good' : 'bad'}`
      } else {
        bestcaseCard.style.display = 'none'
      }
    }
  }

  // Minimal day-summary panel (kept but hidden — banner above handles it now)
  const el = document.getElementById('day-summary')
  if (el) el.hidden = true

  // Update simple scorecard summary
  const scSummary = document.getElementById('sc-summary')
  const scDate    = document.getElementById('sc-summary-date')
  const scWon     = document.getElementById('sc-won-count')
  const scLost    = document.getElementById('sc-lost-count')
  const scWait    = document.getElementById('sc-wait-count')
  const scTotal   = document.getElementById('sc-day-total')

  if (scSummary) {
    if (!data || !data.pitchers?.length) {
      scSummary.hidden = true
    } else {
      scSummary.hidden = false
      if (scDate) scDate.textContent = new Date(date + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
      if (scWon)  scWon.textContent  = data.day_wins    || 0
      if (scLost) scLost.textContent = data.day_losses   || 0
      if (scWait) scWait.textContent = data.day_pending  || 0
      if (scTotal) {
        const pnl = data.day_pnl || 0
        const sign = pnl > 0 ? '+' : ''
        scTotal.textContent = pnl === 0 && data.day_wins === 0 && data.day_losses === 0
          ? 'No settled bets yet'
          : `${pnl > 0 ? 'UP' : pnl < 0 ? 'DOWN' : 'EVEN'} ${sign}${fmt$(Math.abs(pnl))} today`
        scTotal.className = `sc-day-total ${pnl > 0 ? 'sc-up' : pnl < 0 ? 'sc-down' : 'sc-even'}`
      }
    }
  }
}

async function loadLiveBets(date) {
  const data = await fetchJson(`/api/ks/live-bets?date=${date}`).catch(() => null)
  const section = document.getElementById('live-bets-section')
  const list    = document.getElementById('live-bets-list')
  const meta    = document.getElementById('lbs-meta')
  if (!section || !list) return

  if (!data || !data.pitchers?.length) {
    section.hidden = true
    return
  }

  const t = data.totals
  const pnlSign = t.pnl >= 0 ? '+' : ''
  const pnlCls  = t.pnl >= 0 ? 'good' : 'bad'
  meta.innerHTML = `${t.bets} bet${t.bets !== 1 ? 's' : ''} · ${t.wins}W ${t.losses}L${t.pending > 0 ? ` · ${t.pending} pending` : ''} · <span class="${pnlCls}">${pnlSign}${fmt$(t.pnl)}</span>`

  list.innerHTML = data.pitchers.map(p => {
    const pnlSign2 = p.pnl >= 0 ? '+' : ''
    const pnlCls2  = p.pnl >= 0 ? 'good' : 'bad'
    const rows = p.bets.map(bet => {
      const label  = bet.side === 'YES' ? `YES ${bet.strike}+` : `NO ${bet.strike}+`
      const ctx    = bet.live_inning ? `${bet.live_inning} · ${bet.live_ks_at_bet ?? '?'}Ks` : ''
      const stCls  = bet.result === 'win' ? 'good' : bet.result === 'loss' ? 'bad' : 'muted'
      const stText = bet.result === 'win' ? 'WIN' : bet.result === 'loss' ? 'LOSS' : 'pending'
      const pnlT   = bet.pnl != null ? `${bet.pnl >= 0 ? '+' : ''}${fmt$(bet.pnl)}` : '—'
      const pnlC   = bet.pnl != null ? (bet.pnl >= 0 ? 'good' : 'bad') : 'muted'
      return `<div class="lbs-row">
        <span class="lbs-bet">${label}</span>
        <span class="lbs-ctx muted">${ctx}</span>
        <span class="lbs-size muted">${fmt$(bet.bet_size)}</span>
        <span class="lbs-status ${stCls}">${stText}</span>
        <span class="lbs-pnl ${pnlC}">${pnlT}</span>
      </div>`
    }).join('')

    return `<div class="lbs-pitcher">
      <div class="lbs-pitcher-name">${p.pitcher_name} <span class="muted">${p.wins}W ${p.losses}L${p.pending > 0 ? ` ${p.pending}⏳` : ''}</span> <span class="${pnlCls2}">${pnlSign2}${fmt$(p.pnl)}</span></div>
      ${rows}
    </div>`
  }).join('')

  section.hidden = false
}

function buildPitcherCard(p) {
  const KALSHI_FEE = 0.07
  const card = document.createElement('article')
  let colorCls = 'pending'
  if (p.pending === 0) {
    if (p.losses === 0 && p.wins > 0)      colorCls = 'win'
    else if (p.wins === 0 && p.losses > 0) colorCls = 'loss'
    else if (p.wins > 0 && p.losses > 0)   colorCls = 'mixed'
  }
  card.className = `pitcher-card ${colorCls}`
  if (p.pitcher_id) card.dataset.pitcherId = p.pitcher_id
  if (p.game_time)  card.dataset.gameTime  = p.game_time
  // card.dataset.coverage set below after coverPct is computed

  // ── Collapsed header ────────────────────────────────────────────────────
  const pnlCls = p.pnl >= 0 ? 'good' : 'bad'
  const pnlStr = p.pnl != null && (p.wins + p.losses) > 0
    ? `<span class="${pnlCls}">${p.pnl >= 0 ? '+' : ''}${fmt$(p.pnl)}</span>`
    : ''

  let statusChips = ''
  if (p.pending > 0 && p.wins === 0 && p.losses === 0) {
    statusChips = `<span class="pc-chip pending">${p.pending} pending</span>`
  } else {
    if (p.wins   > 0) statusChips += `<span class="pc-chip win">${p.wins}W</span>`
    if (p.losses > 0) statusChips += `<span class="pc-chip loss">${p.losses}L</span>`
    if (p.pending > 0) statusChips += `<span class="pc-chip pending">${p.pending} live</span>`
  }

  // Total $ at risk + overall win pct for progress bar
  let totalRisk = 0
  for (const b of p.bets) {
    const mid = b.market_mid != null ? Number(b.market_mid) / 100 : 0.5
    const hs  = (b.spread ?? 4) / 200
    const fill = b.side === 'YES' ? mid + hs : (1 - mid) + hs
    totalRisk += (b.bet_size ?? 0) * fill
  }
  card.dataset.stake = totalRisk  // set after computed

  const totalBets  = p.wins + p.losses + p.pending
  const overallPct = totalBets > 0 ? Math.round(p.wins / totalBets * 100) : 0
  const overallClr = overallPct >= 60 ? 'good' : overallPct >= 30 ? '' : (p.losses > 0 ? 'bad' : '')

  // Average model probability across pending bets → "coverage chance"
  const pendingBets = p.bets.filter(b => !b.result)
  const coverProb = b => b.side === 'NO' ? 1 - (b.model_prob ?? 0.5) : (b.model_prob ?? 0.5)
  const avgCoverage = pendingBets.length > 0
    ? pendingBets.reduce((s, b) => s + coverProb(b), 0) / pendingBets.length
    : p.bets.length > 0 ? p.bets.reduce((s, b) => s + coverProb(b), 0) / p.bets.length : null
  const coverPct = avgCoverage != null ? Math.round(avgCoverage * 100) : null
  const coverCls = coverPct >= 60 ? 'good' : coverPct >= 40 ? 'warn' : 'bad'
  card.dataset.coverage = coverPct ?? 0

  // ── Expanded body ────────────────────────────────────────────────────────

  // Signals — pull from first bet (same per pitcher)
  const s = p.bets[0] || {}
  const firstName = p.pitcher_name.split(' ').pop()  // last name for text

  const lambdaStr   = s.lambda       != null ? s.lambda.toFixed(1) : null
  const parkStr     = s.park_factor  != null && Math.abs(s.park_factor - 1) > 0.01
                        ? `×${s.park_factor.toFixed(2)}` : 'neutral'
  const umpStr      = s.ump_name     != null ? `${s.ump_name}${s.ump_factor != null && Math.abs(s.ump_factor - 1) > 0.01 ? ` (×${s.ump_factor.toFixed(2)})` : ''}` : '—'
  const wxStr       = s.weather_mult != null && Math.abs(s.weather_mult - 1) > 0.01
                        ? `×${s.weather_mult.toFixed(2)}` : 'neutral'
  const veloStr     = s.velo_trend_mph != null ? `${s.velo_trend_mph >= 0 ? '+' : ''}${s.velo_trend_mph.toFixed(1)} mph` : null
  const k9Str       = s.k9_season    != null ? s.k9_season.toFixed(1) : null
  const whiffStr    = s.savant_whiff != null ? `${(s.savant_whiff * 100).toFixed(1)}%` : null
  const avgEdgeCents = p.bets.reduce((sum, b) => sum + (b.edge != null ? Number(b.edge) * 100 : 0), 0) / p.bets.length

  const signalItems = [
    lambdaStr  ? `<div class="pc-sig"><span>Expected Ks</span><b>${lambdaStr}</b></div>` : '',
    k9Str      ? `<div class="pc-sig"><span>Ks per 9 inn.</span><b>${k9Str}</b></div>` : '',
    whiffStr   ? `<div class="pc-sig"><span>Swing &amp; Miss</span><b>${whiffStr}</b></div>` : '',
    `<div class="pc-sig"><span>Our Edge</span><b class="good">+${avgEdgeCents.toFixed(1)}¢</b></div>`,
    `<div class="pc-sig"><span>Ballpark</span><b>${parkStr}</b></div>`,
    `<div class="pc-sig"><span>Home Plate Ump</span><b>${umpStr}</b></div>`,
    veloStr    ? `<div class="pc-sig"><span>Fastball Trend</span><b>${veloStr}</b></div>` : '',
    `<div class="pc-sig"><span>Weather</span><b>${wxStr}</b></div>`,
  ].filter(Boolean).join('')

  // Why picked — pitcher-level summary
  const whyParts = []
  if (lambdaStr) whyParts.push(`Model expects ${firstName} to average ~${lambdaStr} Ks today.`)
  if (avgEdgeCents >= 5) whyParts.push(`Market is consistently underpricing him — avg ${avgEdgeCents.toFixed(1)}¢ edge across all thresholds.`)
  if (s.park_factor != null && s.park_factor < 0.97) whyParts.push(`Pitcher-friendly ballpark helps.`)
  if (s.park_factor != null && s.park_factor > 1.03) whyParts.push(`Hitter-friendly park — factor into expectations.`)
  if (s.ump_factor  != null && s.ump_factor  > 1.03) whyParts.push(`Umpire ${s.ump_name} calls a big strike zone.`)
  if (s.ump_factor  != null && s.ump_factor  < 0.97) whyParts.push(`Umpire ${s.ump_name} has a tight zone — could suppress Ks.`)
  if (s.velo_trend_mph != null && s.velo_trend_mph >= 0.5)  whyParts.push(`Velocity trending up +${s.velo_trend_mph.toFixed(1)} mph.`)
  if (s.velo_trend_mph != null && s.velo_trend_mph <= -0.5) whyParts.push(`Velocity trending down ${s.velo_trend_mph.toFixed(1)} mph — watch closely.`)
  const whyText = whyParts.join(' ') || 'Picked based on model edge vs. market price.'

  // Heat map
  const heatMap = (() => {
    if (!p.recent_ks?.length) return ''
    const thresholds = [...new Set(p.bets.map(b => b.strike))].sort((a,b) => a - b)
    if (!thresholds.length) return ''
    const cols = p.recent_ks.map((ks, i) => {
      const cells = thresholds.map(t =>
        `<div class="hm-cell ${ks >= t ? 'hm-hit' : 'hm-miss'}" title="${ks} Ks vs ${t}+">${ks}</div>`
      )
      return `<div class="hm-col"><div class="hm-start-label">S-${p.recent_ks.length - i}</div>${cells.join('')}</div>`
    })
    const rowLabels = thresholds.map(t => `<div class="hm-row-label">${t}+</div>`).join('')
    return `<div class="pc-heatmap">
      <div class="hm-header">Last ${p.recent_ks.length} starts</div>
      <div class="hm-body">
        <div class="hm-labels"><div class="hm-corner"></div>${rowLabels}</div>
        <div class="hm-cols">${cols.join('')}</div>
      </div>
    </div>`
  })()

  // Bet rows — flat list, no expand
  const betRows = p.bets.map(b => {
    const mid        = b.market_mid != null ? Number(b.market_mid) : null
    const face       = b.bet_size   != null ? Number(b.bet_size)   : null
    const halfSpread = (b.spread ?? 4) / 2
    const fillCents  = mid != null ? (b.side === 'YES' ? mid + halfSpread : (100 - mid) + halfSpread) : null
    const winCents   = mid != null ? (b.side === 'YES' ? (100 - mid) - halfSpread : mid - halfSpread) : null
    const wager  = fillCents != null && face != null ? fmt$(face * fillCents / 100) : '—'
    const potWin = winCents  != null && face != null ? fmt$(face * winCents / 100 * (1 - KALSHI_FEE)) : '—'
    const edgeStr = b.edge != null ? `Edge: +${(b.edge * 100).toFixed(1)}¢` : ''
    const midStr  = b.market_mid != null ? `Market: ${b.market_mid}¢` : ''

    const direction = b.side === 'YES'
      ? `<strong>${b.strike}+</strong> Ks YES`
      : `Under <strong>${b.strike}</strong> Ks NO`

    let badge, moneyStr
    if (b.result === 'win') {
      badge    = `<span class="pc-badge pc-badge--win">✓ WIN</span>`
      moneyStr = `<span class="pc-money-win">+${fmt$(b.pnl)}</span>`
    } else if (b.result === 'loss') {
      badge    = `<span class="pc-badge pc-badge--loss">✗ LOSS</span>`
      moneyStr = `<span class="pc-money-loss">${fmt$(b.pnl)}</span>`
    } else {
      badge    = `<span class="pc-badge pc-badge--pending">Pending</span>`
      moneyStr = `<span class="pc-money-potential">→ ${potWin}</span>`
    }

    const kalshiBtn = b.ticker
      ? `<a class="pc-kalshi-btn" href="https://kalshi.com/markets/kxmlbks/${b.ticker}" target="_blank" rel="noopener">Kalshi →</a>`
      : ''

    // Order confirmation block — shown when a real order has been placed
    let orderConfirm = ''
    if (b.order_id) {
      const contracts = b.filled_contracts ?? b.bet_size
      const price = b.fill_price != null ? Math.round(b.fill_price) : b.market_mid != null ? Math.round(b.market_mid) : null
      const cost = contracts != null && price != null ? fmt$(contracts * price / 100) : null
      const timeDisp = b.filled_at ? fmtTs(b.filled_at) : ''
      const statusCls = b.order_status === 'filled' ? 'good' : b.order_status === 'canceled' ? 'bad' : ''
      const detail = [
        contracts != null ? `${contracts} contracts` : null,
        price != null ? `@ ${price}¢ each` : null,
        cost ? `= ${cost}` : null,
      ].filter(Boolean).join(' ')
      orderConfirm = `<div class="pc-order-confirm">
        <span class="pc-order-chip ${statusCls}">✓ Real Bet Placed</span>
        <span class="pc-order-detail">${detail}</span>
        ${timeDisp ? `<span class="pc-order-time">${timeDisp}</span>` : ''}
      </div>`
    } else if (b.paper === 0) {
      orderConfirm = `<div class="pc-order-confirm"><span class="pc-order-chip">Real Bet Placed</span></div>`
    }

    // Live money badge — shown when real money is on this bet (separate user)
    let liveBadge = ''
    if (b.live) {
      const lv = b.live
      const contracts = lv.filled_contracts ?? lv.bet_size ?? '?'
      const price = lv.fill_price != null ? `${Math.round(lv.fill_price)}¢` : ''
      const spent = lv.fill_price != null && lv.filled_contracts != null
        ? fmt$(lv.filled_contracts * lv.fill_price / 100) : ''
      let livePnlHtml = ''
      if (lv.result === 'win') {
        livePnlHtml = `<span class="pc-live-pnl win">+${fmt$(lv.pnl)}</span>`
      } else if (lv.result === 'loss') {
        livePnlHtml = `<span class="pc-live-pnl loss">${fmt$(lv.pnl)}</span>`
      }
      const liveDetail = [
        contracts != null ? `${contracts} contracts` : null,
        price ? `@ ${price} each` : null,
        spent ? `= ${spent}` : null,
      ].filter(Boolean).join(' ')
      liveBadge = `<div class="pc-live-badge">
        <span class="pc-live-chip">💵 Real Money</span>
        <span class="pc-live-detail">${liveDetail}</span>
        ${livePnlHtml}
      </div>`
    }

    const rowCls = b.result === 'win' ? 'pc-bet-row--win' : b.result === 'loss' ? 'pc-bet-row--loss' : ''
    const tooltipText = b.side === 'YES'
      ? `${firstName} needs at least ${b.strike} strikeout${b.strike !== 1 ? 's' : ''} for this bet to win`
      : `${firstName} must stay under ${b.strike} strikeout${b.strike !== 1 ? 's' : ''} for this NO bet to win`

    const betCoverPct = b.model_prob != null ? Math.round((b.side === 'NO' ? 1 - b.model_prob : b.model_prob) * 100) : null
    const betCoverCls = betCoverPct >= 60 ? 'good' : betCoverPct >= 40 ? 'warn' : 'bad'
    const betCoverTag = betCoverPct != null ? `<span class="pc-bet-cover ${betCoverCls}">${betCoverPct}%</span>` : ''

    let progressBar
    if (b.result === 'win') {
      progressBar = `<div class="pc-ks-progress">
        <div class="pc-ks-bar"><div class="pc-ks-fill hit" style="width:100%"></div></div>
        <span class="pc-ks-label">✓ ${b.actual_ks ?? b.strike}+ Ks hit</span>
        ${betCoverTag}
      </div>`
    } else if (b.result === 'loss') {
      progressBar = `<div class="pc-ks-progress">
        <div class="pc-ks-bar"><div class="pc-ks-fill miss" style="width:100%"></div></div>
        <span class="pc-ks-label">✗ ${b.actual_ks ?? '?'} Ks</span>
        ${betCoverTag}
      </div>`
    } else {
      const lbl = b.side === 'YES' ? `0 / ${b.strike} Ks` : `0 Ks (need < ${b.strike})`
      progressBar = `<div class="pc-ks-progress">
        <div class="pc-ks-bar"><div class="pc-ks-fill" style="width:0%"></div></div>
        <span class="pc-ks-label">${lbl}</span>
        ${betCoverTag}
      </div>`
    }

    return `<div class="pc-bet-row ${rowCls}" data-bet-id="${b.id}" data-strike="${b.strike}" data-side="${b.side}" title="${esc(tooltipText)}">
      <div class="pc-bet-row-main">
        <div class="pc-bet-row-left">
          <span class="pc-bet-row-desc">${direction}</span>
          <span class="pc-bet-row-meta">${[edgeStr, midStr].filter(Boolean).join(' · ')}</span>
        </div>
        <div class="pc-bet-row-right">
          <span class="pc-bet-wager">${wager}</span>
          ${moneyStr}
          ${badge}
          ${kalshiBtn}
        </div>
      </div>
      ${progressBar}
      ${orderConfirm}
      ${liveBadge}
    </div>`
  }).join('')

  card.innerHTML = `
    <div class="pc-header">
      <div class="pc-header-left">
        <div class="pc-pitcher">${esc(p.pitcher_name)}</div>
        <div class="pc-meta">${esc(p.game || p.team || '—')}${p.game_time ? ` · <span class="pc-gametime">${fmtGameTime(p.game_time)}</span><span class="pc-countdown" data-game-time="${esc(p.game_time)}"></span>` : ''}</div>
      </div>
      <div class="pc-header-right">
        <div class="pc-actual-ks">${p.actual_ks != null ? `<strong>${p.actual_ks}</strong> Ks` : ''}</div>
        ${coverPct != null ? `<div class="pc-coverage ${coverCls}">${coverPct}% cover</div>` : ''}
        <div class="pc-header-chips">${statusChips}</div>
        <div class="pc-header-risk">${fmt$(totalRisk)} at risk</div>
        ${pnlStr ? `<div class="pc-header-pnl">${pnlStr}</div>` : ''}
        <div class="pc-expand-arrow">›</div>
      </div>
    </div>
    <div class="pc-overall-bar"><div class="pc-overall-fill ${overallClr}" style="width:${overallPct}%"></div></div>
    <div class="pc-body" hidden>
      <div class="pc-signals-section">
        <div class="pc-signals">${signalItems}</div>
        <p class="pc-why-text">${whyText}</p>
      </div>
      ${heatMap}
      <div class="pc-bet-rows">${betRows}</div>
    </div>`

  return card
}

// ──────────────────────────────────────────────────────────────────────────
// Live game polling
// ──────────────────────────────────────────────────────────────────────────

function startLivePolling(date) {
  stopLivePolling()
  pollLive(date)
  state.liveTimer = setInterval(() => pollLive(date), 60_000)
}

function stopLivePolling() {
  if (state.liveTimer) { clearInterval(state.liveTimer); state.liveTimer = null }
  if (state.countdownTimer) { clearInterval(state.countdownTimer); state.countdownTimer = null }
}

function startCountdowns() {
  updateCountdowns()
  if (state.countdownTimer) clearInterval(state.countdownTimer)
  state.countdownTimer = setInterval(updateCountdowns, 30_000)
}

function updateCountdowns() {
  document.querySelectorAll('.pc-countdown[data-game-time]').forEach(el => {
    const diff = new Date(el.dataset.gameTime) - Date.now()
    if (diff <= 0) { el.textContent = ''; el.hidden = true; return }
    el.hidden = false
    const totalMin = Math.floor(diff / 60000)
    const h = Math.floor(totalMin / 60)
    const m = totalMin % 60
    el.textContent = h > 0 ? `· ${h}h ${m}m` : `· ${m}m`
  })
}

function computeMaxTheoretical(pitchers) {
  const FEE = 0.07
  let total = 0
  for (const p of pitchers) {
    const live = _liveOverlay[String(p.pitcher_id)] || {}
    // Pitcher is "done" if game final OR pulled from the game (won't get more Ks)
    const determined = live.is_final === true || live.still_in === false
    const currentKs  = live.ks
    for (const b of p.bets) {
      const mid  = b.market_mid != null ? Number(b.market_mid) / 100 : 0.5
      const hs   = (b.spread ?? 4) / 200
      const fill = b.side === 'YES' ? mid + hs : (1 - mid) + hs
      const size = b.bet_size ?? 0
      if (b.result === 'win' || b.result === 'loss') {
        // Already formally settled in DB
        total += b.pnl ?? 0
      } else if (determined && currentKs != null) {
        // Pitcher done — compute real outcome from current K count
        const won = b.side === 'YES' ? currentKs >= b.strike : currentKs < b.strike
        total += won ? size * (1 - fill) * (1 - FEE) : -(size * fill)
      } else {
        // Still live — show optimistic best case
        total += size * (1 - fill) * (1 - FEE)
      }
    }
  }
  return total
}

async function pollLive(date) {
  const data = await fetchJson(`/api/ks/live?date=${date}`).catch(() => null)
  if (!data) return

  renderLiveBanner(data)

  for (const p of data.pitchers) {
    updatePitcherCardLive(p)
  }

  updateBannerChipColors(data.pitchers)

  // Update live overlay: track ks/still_in/is_final per pitcher
  for (const p of data.pitchers) {
    _liveOverlay[String(p.pitcher_id)] = {
      ks:       p.ks,
      still_in: p.still_in,
      is_final: p.is_final,
    }
  }

  // Recompute best case using daily data + live overlay
  const maxEl = document.getElementById('day-max-val')
  if (maxEl && _dailyPitchers.length) {
    const maxT = computeMaxTheoretical(_dailyPitchers)
    maxEl.textContent = (maxT >= 0 ? '+' : '') + fmt$(maxT)
    maxEl.className = 'day-max-val ' + (maxT >= 0 ? 'good' : 'bad')
  }

  // Re-sort: live first → pre-game by start time → final at bottom
  const list = document.getElementById('pitcher-list')
  if (list) {
    const cards = [...list.querySelectorAll('.pitcher-card')]
    cards.sort((a, b) => {
      const aLive  = !!a.querySelector('.pc-live-chip.live')
      const bLive  = !!b.querySelector('.pc-live-chip.live')
      const aFinal = !!a.querySelector('.pc-live-chip.final')
      const bFinal = !!b.querySelector('.pc-live-chip.final')
      if (aLive  !== bLive)  return aLive  ? -1 : 1
      if (aFinal !== bFinal) return aFinal ?  1 : -1
      if (aLive  && bLive)   return Number(b.dataset.coverage || 0) - Number(a.dataset.coverage || 0)
      const at = a.dataset.gameTime || '', bt = b.dataset.gameTime || ''
      if (at && bt) return at.localeCompare(bt)
      return at ? -1 : bt ? 1 : 0
    })
    cards.forEach(c => list.appendChild(c))
  }

  // Refresh live bets section on every live poll
  try { await loadLiveBets(date) } catch {}

  // If everything is final and all bets have settled results, stop polling
  if (data.pitchers.length && data.pitchers.every(p => p.is_final)) {
    // Check if bets are still pending in DB — if so keep polling for settlement
    const anyPending = await fetchJson(`/api/ks/summary`).then(s => s.pending > 0).catch(() => false)
    if (!anyPending) stopLivePolling()
  }
}

function fmtGameTime(utc) {
  if (!utc) return ''
  try {
    return new Date(utc).toLocaleTimeString('en-US', {
      hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York', hour12: true,
    }) + ' ET'
  } catch { return '' }
}

function buildLiveBanner(pitchers) {
  const banner = document.getElementById('live-banner')
  if (!banner) return
  if (!pitchers?.length) { banner.hidden = true; return }
  banner.hidden = false

  banner.className = 'live-now-panel'
  const sorted = [...pitchers].sort((a, b) => {
    if (a.game_time && b.game_time) return a.game_time.localeCompare(b.game_time)
    return a.pitcher_name.localeCompare(b.pitcher_name)
  })

  banner.innerHTML = `
    <div class="lnp-header">
      <span class="live-dot"></span>
      <span class="lnp-title">${pitchers.length} pitcher${pitchers.length !== 1 ? 's' : ''} today</span>
    </div>
    <div class="lnp-rows" id="lnp-rows">
      ${sorted.map(p => {
        const timeStr = fmtGameTime(p.game_time)
        const status  = timeStr ? `Game starts at ${timeStr}` : 'Warming up'
        return `<div class="lnp-row" data-pitcher-id="${p.pitcher_id || ''}" data-name="${esc(p.pitcher_name)}">
          <span class="lnp-name">${esc(p.pitcher_name)}</span>
          <span class="lnp-status lnp-pregame">${status}</span>
          <span class="lnp-jump">▸ bets</span>
        </div>`
      }).join('')}
    </div>`

  banner.querySelectorAll('.lnp-row').forEach(row => {
    row.addEventListener('click', () => scrollToPitcher(row.dataset.pitcherId, row.dataset.name))
  })
}

function scrollToPitcher(pid, name) {
  let card = pid ? document.querySelector(`.pitcher-card[data-pitcher-id="${CSS.escape(pid)}"]`) : null
  if (!card) {
    document.querySelectorAll('.pitcher-card').forEach(c => {
      if (c.querySelector('.pc-pitcher')?.textContent?.trim() === name) card = c
    })
  }
  if (card) {
    card.scrollIntoView({ behavior: 'smooth', block: 'start' })
    card.classList.add('lb-highlight')
    setTimeout(() => card.classList.remove('lb-highlight'), 1500)
  }
}

function renderLiveBanner(data) {
  const banner = document.getElementById('live-banner')
  if (!banner || banner.hidden) return

  const liveNow = data.pitchers.filter(p => !p.is_final && p.ip > 0).length
  const titleEl = banner.querySelector('.lnp-title')
  if (titleEl) {
    titleEl.textContent = liveNow > 0
      ? `${liveNow} game${liveNow !== 1 ? 's' : ''} happening right now · ${data.pitchers.length} total today`
      : `${data.pitchers.length} pitcher${data.pitchers.length !== 1 ? 's' : ''} today`
  }

  for (const p of data.pitchers) {
    const row = p.pitcher_id
      ? banner.querySelector(`.lnp-row[data-pitcher-id="${p.pitcher_id}"]`)
      : null
    if (!row) continue
    const statusEl = row.querySelector('.lnp-status')
    if (!statusEl) continue

    const ksWord = p.ks === 1 ? '1 strikeout' : `${p.ks} strikeouts`

    if (p.is_final) {
      statusEl.textContent = `Final — threw ${ksWord}`
      statusEl.className   = 'lnp-status lnp-final'
    } else if (!p.still_in) {
      statusEl.textContent = `Out of the game — ${ksWord} (won't throw more)`
      statusEl.className   = 'lnp-status lnp-pulled'
    } else if (p.ip === 0) {
      const timeStr = fmtGameTime(p.game_time)
      statusEl.textContent = timeStr ? `Game starts at ${timeStr}` : 'Warming up'
      statusEl.className   = 'lnp-status lnp-pregame'
    } else {
      statusEl.textContent = `${ksWord} · ${p.inning}`
      statusEl.className   = 'lnp-status lnp-live'
    }

    // Verdict from card coverage (card is built and updated separately)
    const card     = p.pitcher_id ? document.querySelector(`.pitcher-card[data-pitcher-id="${p.pitcher_id}"]`) : null
    const coverage = card ? Number(card.dataset.coverage || 0) : 0
    let verdictEl  = row.querySelector('.lnp-verdict')

    if (p.is_final || !p.still_in) {
      // Definitive outcome
      if (!verdictEl) {
        verdictEl = document.createElement('span')
        row.insertBefore(verdictEl, row.querySelector('.lnp-jump'))
      }
      verdictEl.textContent = coverage >= 50 ? 'You win' : 'You lose'
      verdictEl.className   = `lnp-verdict ${coverage >= 50 ? 'good' : 'bad'}`
    } else if (p.ip > 0 && coverage > 0) {
      if (!verdictEl) {
        verdictEl = document.createElement('span')
        row.insertBefore(verdictEl, row.querySelector('.lnp-jump'))
      }
      if (coverage >= 65)      { verdictEl.textContent = 'Looking good'; verdictEl.className = 'lnp-verdict good' }
      else if (coverage >= 40) { verdictEl.textContent = 'On track';     verdictEl.className = 'lnp-verdict' }
      else                     { verdictEl.textContent = 'Worried';      verdictEl.className = 'lnp-verdict bad' }
    } else if (verdictEl) {
      verdictEl.remove()
    }
  }
}

function updateBannerChipColors(pitchers) {
  // Coverage colors are now applied directly in renderLiveBanner via .lnp-verdict classes
  // This function is kept as a no-op for compatibility
}

// ── Poisson probability helpers ───────────────────────────────────────────
function poissonCDF(k, lambda) {
  if (lambda <= 0) return k >= 0 ? 1 : 0
  let cdf = 0, term = Math.exp(-lambda)
  for (let i = 0; i <= Math.floor(k); i++) {
    cdf += term
    term *= lambda / (i + 1)
  }
  return Math.min(1, cdf)
}

// Probability a pitcher gets ≥ needed more Ks given remaining lambda
function probAtLeast(needed, remainLambda) {
  if (needed <= 0) return 1
  return 1 - poissonCDF(needed - 1, remainLambda)
}

// Remaining expected Ks based on current K rate and pitch count
function remainingLambda(ks, ip, pitches) {
  if (ip <= 0 || pitches <= 0) return null
  const kPerIp       = ks / ip
  const pitchPerIp   = pitches / ip
  const AVG_PITCH_LIMIT = 95
  const remainIp     = Math.max(0, AVG_PITCH_LIMIT - pitches) / pitchPerIp
  return kPerIp * remainIp
}

function updatePitcherCardLive(p) {
  const card = document.querySelector(`.pitcher-card[data-pitcher-id="${CSS.escape(String(p.pitcher_id))}"]`)
  if (!card) return

  const isWarmup       = !p.is_final && p.pitches === 0 && p.ip === 0
  const hasLiveData    = p.ip > 0 && p.pitches > 0
  // Require either Ks recorded OR 2+ IP before trusting Poisson — avoids 0% when pitcher just started with 0 Ks
  const hasEnoughData  = hasLiveData && (p.ks > 0 || p.ip >= 2)
  const remLambda      = hasEnoughData ? remainingLambda(p.ks, p.ip, p.pitches) : null

  // ── K pace projection ─────────────────────────────────────────────────────
  let projKs = null
  if (!p.is_final && hasEnoughData && remLambda != null) {
    projKs = Math.round((p.ks + remLambda) * 10) / 10
  }

  // ── Score / danger flags ──────────────────────────────────────────────────
  const scoreDiff = p.home_score != null && p.away_score != null
    ? Math.abs(p.home_score - p.away_score) : null
  const isBlowout = scoreDiff != null && scoreDiff >= 5 && !p.is_final

  // ── K count + status visible on collapsed header ──────────────────────────
  const actualKsEl = card.querySelector('.pc-actual-ks')
  if (actualKsEl) {
    if (p.is_final) {
      actualKsEl.innerHTML = `<strong>${p.ks}</strong> Ks`
    } else if (!p.still_in) {
      actualKsEl.innerHTML = `<span class="pc-pulled-badge">PULLED</span> <strong>${p.ks}</strong> Ks`
    } else if (!isWarmup) {
      actualKsEl.innerHTML = `<strong>${p.ks}</strong> Ks`
    } else {
      actualKsEl.innerHTML = ''
    }
  }

  // ── Live info row in header left ──────────────────────────────────────────
  let liveRow = card.querySelector('.pc-live-row')
  if (!liveRow) {
    liveRow = document.createElement('div')
    liveRow.className = 'pc-live-row'
    card.querySelector('.pc-header-left')?.appendChild(liveRow)
  }

  if (p.is_final) {
    liveRow.innerHTML = `<span class="pc-live-chip final">Final · ${p.ip.toFixed(1)} IP</span>`
  } else if (!p.still_in) {
    liveRow.innerHTML = `<span class="pc-live-chip pulled">⚠ PULLED · ${p.ip.toFixed(1)} IP</span>`
  } else if (isWarmup) {
    liveRow.innerHTML = `<span class="pc-live-chip warmup">⚡ Warmup</span>`
  } else {
    const score  = p.home_score != null ? `${p.away_score}–${p.home_score}` : ''
    const parts  = [`${p.inning}`, `${p.ip.toFixed(1)} IP`, p.pitches ? `${p.pitches}p` : null, score || null]
      .filter(Boolean).join(' · ')
    const blowout = isBlowout ? ` <span class="pc-blowout-warn">⚠ blowout</span>` : ''
    const pace    = projKs != null ? `<span class="pc-pace-chip">proj <strong>${projKs}</strong> Ks</span>` : ''
    liveRow.innerHTML = `<span class="pc-live-chip live">${parts}${blowout}</span>${pace}`
  }

  // ── Overall bar — show only once game starts, fill by coverage % ─────────
  const overallBar  = card.querySelector('.pc-overall-bar')
  const overallFill = card.querySelector('.pc-overall-fill')
  if (overallBar && !isWarmup) {
    overallBar.style.display = 'block'
  }
  // fill updated later once per-bet probs are computed (see coverageEl block)

  // ── Update each bet row (badge + progress bar) ────────────────────────────
  for (const bs of p.bet_statuses) {
    const row = card.querySelector(`.pc-bet-row[data-bet-id="${bs.id}"]`)
    if (!row) continue
    const badge = row.querySelector('.pc-badge')
    if (!badge || !badge.classList.contains('pc-badge--pending')) continue
    const isNo = row.dataset.side === 'NO'

    const prog = row.querySelector('.pc-ks-progress')
    if (prog && !isWarmup) {
      prog.style.display = 'flex'
      const fill = prog.querySelector('.pc-ks-fill')
      const lbl  = prog.querySelector('.pc-ks-label')
      if (lbl) lbl.textContent = isNo ? `${bs.ks} Ks (need < ${bs.strike})` : `${bs.ks} / ${bs.strike} Ks`
      // Fill and color updated in coverage block below
      if (fill) fill.dataset.betId = bs.id
    }

    if (!isNo) {
      if (bs.needed === 0)       { badge.textContent = '✅ COVERED';          badge.className = 'pc-badge pc-badge--win pc-badge--covered' }
      else if (!p.still_in)      { badge.textContent = `❌ Out at ${bs.ks}K — needed ${bs.strike}`;  badge.className = 'pc-badge pc-badge--loss' }
      else if (bs.needed === 1)  { badge.textContent = `🔥 ${bs.ks} Ks — 1 MORE to win!`;           badge.className = 'pc-badge pc-badge--oneaway' }
      else                       { badge.textContent = `Has ${bs.ks} — needs ${bs.strike} to win`;   badge.className = 'pc-badge' }
    } else {
      if (bs.ks >= bs.strike)    { badge.textContent = `❌ Hit ${bs.ks}K — needed to stay under ${bs.strike}`; badge.className = 'pc-badge pc-badge--loss' }
      else if (p.is_final)       { badge.textContent = `✅ Stayed under ${bs.strike} (${bs.ks}K)`;             badge.className = 'pc-badge pc-badge--win pc-badge--covered' }
      else if (!p.still_in)      { badge.textContent = `✅ Done at ${bs.ks}K — under ${bs.strike}`;            badge.className = 'pc-badge pc-badge--win pc-badge--covered' }
      else if (bs.ks === bs.strike - 1) { badge.textContent = `⚠️ At ${bs.ks}K — one more and we lose`;       badge.className = 'pc-badge pc-badge--oneaway' }
      else                       { badge.textContent = `At ${bs.ks}K — needs to stay under ${bs.strike}`;      badge.className = 'pc-badge' }
    }
  }

  // ── Live coverage % — Poisson once game is active, model_prob during warmup ──
  let coverSum = 0, coverCount = 0
  for (const bs of p.bet_statuses) {
    const row = card.querySelector(`.pc-bet-row[data-bet-id="${bs.id}"]`)
    if (!row) continue
    const coverChip = row.querySelector('.pc-bet-cover')
    if (!coverChip) continue
    const isNo = row.dataset.side === 'NO'

    let prob
    if (p.is_final || !p.still_in) {
      // Game over — definitive
      prob = !isNo ? (bs.ks >= bs.strike ? 1 : 0) : (bs.ks < bs.strike ? 1 : 0)
    } else if (hasEnoughData && remLambda != null) {
      // Game active with enough data — Poisson probability based on current K rate + remaining pitches
      const needed = !isNo ? bs.strike - bs.ks : null
      prob = !isNo
        ? probAtLeast(needed, remLambda)
        : poissonCDF(bs.strike - bs.ks - 1, remLambda)
    } else {
      // Warmup or early innings with 0 Ks — keep pre-game model_prob estimate
      continue
    }

    const pct    = Math.round(prob * 100)
    const colCls = pct >= 60 ? 'good' : pct >= 40 ? 'warn' : 'bad'
    coverChip.textContent = `${pct}%`
    coverChip.className = `pc-bet-cover ${colCls}`

    // Drive the per-bet progress bar with coverage probability
    const fill = row.querySelector('.pc-ks-fill')
    if (fill) {
      fill.style.width  = `${pct}%`
      fill.className    = `pc-ks-fill ${colCls}`
    }

    if (!bs.result) { coverSum += pct; coverCount++ }
  }

  // Update header coverage chip
  const coverageEl = card.querySelector('.pc-coverage')
  if (coverageEl && coverCount > 0) {
    const avgPct = Math.round(coverSum / coverCount)
    const colCls = avgPct >= 60 ? 'good' : avgPct >= 40 ? 'warn' : 'bad'
    coverageEl.textContent = `${avgPct}% cover`
    coverageEl.className = `pc-coverage ${colCls}`
    card.dataset.coverage = avgPct
    // Drive the overall bar with the same avg coverage
    if (overallFill) {
      overallFill.style.width = `${avgPct}%`
      overallFill.className   = `pc-overall-fill ${colCls}`
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// TRENDS view
// ──────────────────────────────────────────────────────────────────────────
async function refreshTrendsView() {
  const uid = state.liveBettorId ? `?user_id=${state.liveBettorId}` : ''
  const [bankroll, monthly, weekly, stats, breakdown, leaderboard] = await Promise.all([
    fetchJson(`/api/ks/bankroll${uid}`).catch(() => []),
    fetchJson(`/api/ks/monthly${uid}`).catch(() => []),
    fetchJson(`/api/ks/weekly${uid}`).catch(() => []),
    fetchJson(`/api/ks/stats${uid}`).catch(() => null),
    fetchJson('/api/ks/edge-breakdown').catch(() => null),
    fetchJson('/api/ks/pitcher-leaderboard').catch(() => null),
  ])
  drawBankrollChart(bankroll)
  drawDailyChart(bankroll)
  drawWeeklyChart(weekly)
  renderMonthly(monthly)
  renderStats(stats)
  renderRecentForm(bankroll, stats)
  renderEdgeBreakdown(breakdown)
  renderPitcherLeaderboard(leaderboard)
}

function drawBankrollChart(series) {
  if (typeof Chart === 'undefined') { setTimeout(() => drawBankrollChart(series), 200); return }
  const ctx = document.getElementById('chart-bankroll')
  if (!ctx) return
  if (state.charts.bankroll) state.charts.bankroll.destroy()
  if (!series.length) { ctx.getContext('2d').clearRect(0, 0, ctx.width, ctx.height); return }

  const el = document.getElementById('br-range')
  if (el && series.length >= 2) el.textContent = `${series[0].date} → ${series[series.length-1].date}`

  state.charts.bankroll = new Chart(ctx, {
    type: 'line',
    data: {
      labels: series.map(p => p.date),
      datasets: [{
        label: 'Bankroll',
        data: series.map(p => p.bankroll),
        borderColor: '#3fb950',
        backgroundColor: 'rgba(63,185,113,0.10)',
        fill: true, tension: 0.3,
        pointRadius: series.length > 30 ? 0 : 3,
        pointBackgroundColor: '#3fb950',
      }],
    },
    options: chartOpts({
      tooltip: c => {
        const p = series[c.dataIndex]
        return ` ${fmt$(p.bankroll, true)}  (${p.pnl >= 0 ? '+' : ''}${fmt$(p.pnl)} · ${p.wins}W/${p.losses}L)`
      },
      yFmt: v => '$' + v.toLocaleString(),
    }),
  })
}

function drawDailyChart(series) {
  if (typeof Chart === 'undefined') { setTimeout(() => drawDailyChart(series), 200); return }
  const ctx = document.getElementById('chart-daily')
  if (!ctx) return
  if (state.charts.daily) state.charts.daily.destroy()
  const recent = series.slice(-30)
  if (!recent.length) { ctx.getContext('2d').clearRect(0, 0, ctx.width, ctx.height); return }

  state.charts.daily = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: recent.map(p => p.date.slice(5)),
      datasets: [{
        label: 'Daily P&L',
        data: recent.map(p => p.pnl),
        backgroundColor: recent.map(p => p.pnl >= 0 ? 'rgba(63,185,113,0.85)' : 'rgba(248,81,73,0.85)'),
        borderColor:     recent.map(p => p.pnl >= 0 ? '#3fb950' : '#f85149'),
        borderWidth: 1,
      }],
    },
    options: chartOpts({
      tooltip: c => {
        const p = recent[c.dataIndex]
        return ` ${p.pnl >= 0 ? '+' : ''}${fmt$(p.pnl)}  (${p.wins}W/${p.losses}L · ${p.bets} bets)`
      },
      yFmt: v => (v >= 0 ? '+$' : '-$') + Math.abs(v).toLocaleString(),
    }),
  })
}

function drawWeeklyChart(weekly) {
  if (typeof Chart === 'undefined') { setTimeout(() => drawWeeklyChart(weekly), 200); return }
  const ctx = document.getElementById('chart-weekly')
  if (!ctx) return
  if (state.charts.weekly) state.charts.weekly.destroy()
  if (!weekly.length) { ctx.getContext('2d').clearRect(0, 0, ctx.width, ctx.height); return }

  state.charts.weekly = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: weekly.map(w => w.week),
      datasets: [{
        label: 'Weekly P&L',
        data: weekly.map(w => w.pnl),
        backgroundColor: weekly.map(w => w.pnl >= 0 ? 'rgba(63,185,113,0.85)' : 'rgba(248,81,73,0.85)'),
        borderColor:     weekly.map(w => w.pnl >= 0 ? '#3fb950' : '#f85149'),
        borderWidth: 1,
      }],
    },
    options: chartOpts({
      tooltip: c => {
        const w = weekly[c.dataIndex]
        return ` ${fmt$(w.pnl)}  (${w.wins}W/${w.losses}L · ${fmtPct(w.roi, 1)} ROI)`
      },
      yFmt: v => (v >= 0 ? '+$' : '-$') + Math.abs(v).toLocaleString(),
    }),
  })
}

function chartOpts({ tooltip, yFmt }) {
  return {
    responsive: true, maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: '#161b22', titleColor: '#c9d1d9', bodyColor: '#c9d1d9',
        borderColor: '#30363d', borderWidth: 1,
        callbacks: { label: c => tooltip(c) },
      },
    },
    scales: {
      x: { ticks: { color: '#8b949e', maxTicksLimit: 10 }, grid: { display: false } },
      y: { ticks: { color: '#8b949e', callback: yFmt }, grid: { color: 'rgba(48,54,61,0.3)' } },
    },
  }
}

function renderMonthly(rows) {
  const body = document.getElementById('monthly-body')
  if (!body) return
  body.innerHTML = ''
  if (!rows.length) {
    body.innerHTML = '<div style="padding:20px 14px;color:var(--text-dim);font-size:13px;">No settled bets yet.</div>'
    return
  }
  for (const r of rows) {
    const pnlCls = r.pnl >= 0 ? 'good' : 'bad'
    const roiCls = r.roi >= 0 ? 'good' : 'bad'
    const wrCls  = r.win_rate >= 0.55 ? 'good' : r.win_rate >= 0.5 ? '' : 'bad'
    const row = document.createElement('div')
    row.className = 'ks-monthly-row'
    row.innerHTML = `
      <div>${r.month}</div>
      <div>${r.bets}</div>
      <div>${r.wins}/${r.losses}</div>
      <div class="${wrCls}">${fmtPct(r.win_rate)}</div>
      <div class="${pnlCls}">${r.pnl >= 0 ? '+' : ''}${fmt$(r.pnl)}</div>
      <div class="${roiCls}">${fmtPct(r.roi, 1)}</div>
      <div>${r.avg_edge != null ? (r.avg_edge*100).toFixed(1)+'¢' : '—'}</div>
      <div>${fmt$(r.bankroll, true)}</div>`
    body.appendChild(row)
  }
}

function renderStats(s) {
  const grid = document.getElementById('stats-grid')
  if (!grid) return
  if (!s || s.empty) {
    grid.innerHTML = '<div style="grid-column:1/-1;padding:20px;color:var(--text-dim);text-align:center;font-size:13px;">No settled bets yet.</div>'
    return
  }

  const curStreak = s.current_streak || 0
  const streakHtml = curStreak > 0
    ? `<span class="good">${curStreak}W</span> <span class="ks-sc-sub" style="display:inline">streak</span>`
    : curStreak < 0
    ? `<span class="bad">${Math.abs(curStreak)}L</span> <span class="ks-sc-sub" style="display:inline">streak</span>`
    : '<span class="muted">—</span>'

  const expAct = s.expected_wins != null
    ? `${s.actual_wins} vs ${s.expected_wins.toFixed(0)} exp`
    : '—'

  const ddPct = s.max_drawdown_pct ? (Math.abs(s.max_drawdown_pct) * 100).toFixed(1) + '%' : '0%'
  const curDdPct = s.current_drawdown_pct ? (Math.abs(s.current_drawdown_pct) * 100).toFixed(1) + '%' : ''

  const cards = [
    // Row 1 — Core
    { label: 'Total P&L',       val: (s.total_pnl >= 0 ? '+' : '') + fmt$(s.total_pnl), cls: s.total_pnl >= 0 ? 'good' : 'bad' },
    { label: 'ROI',             val: fmtPct(s.roi, 1), cls: s.roi >= 0 ? 'good' : 'bad' },
    { label: 'Win Rate',        val: fmtPct(s.win_rate), cls: s.win_rate >= 0.55 ? 'good' : s.win_rate >= 0.5 ? '' : 'bad' },
    { label: 'Avg Profit Per Bet', val: (s.ev_per_bet >= 0 ? '+' : '') + fmt$(s.ev_per_bet), cls: s.ev_per_bet >= 0 ? 'good' : 'bad', sub: `${(s.wins||0) + (s.losses||0)} settled` },
    // Row 2 — Risk
    { label: 'Biggest Losing Stretch', val: fmt$(s.max_drawdown), cls: 'bad', sub: ddPct + ' from peak' },
    { label: 'Current Dip',     val: s.current_drawdown < -0.01 ? fmt$(s.current_drawdown) : '$0', cls: s.current_drawdown < -0.01 ? 'bad' : 'good', sub: s.current_drawdown < -0.01 ? curDdPct + ' from peak' : 'No current dip' },
    { label: 'Winning Days',    val: fmtPct(s.winning_days_pct), cls: s.winning_days_pct >= 0.6 ? 'good' : s.winning_days_pct >= 0.5 ? '' : 'bad', sub: `${s.winning_days} of ${s.total_days} days` },
    { label: 'Total Wagered',   val: fmt$(s.total_wagered, true), cls: 'accent' },
    // Row 3 — Streaks / Quality
    { label: 'Best Win Streak', val: String(s.longest_win_streak), cls: 'good', sub: 'consecutive wins' },
    { label: 'Worst Lose Run',  val: String(s.longest_loss_streak), cls: s.longest_loss_streak >= 5 ? 'bad' : 'warn', sub: 'consecutive losses' },
    { label: 'Current Streak',  html: streakHtml, cls: '' },
    { label: 'Model vs Actual Wins', val: expAct, cls: (s.actual_wins || 0) >= (s.expected_wins || 0) ? 'good' : 'bad' },
  ]

  grid.innerHTML = cards.map(c => `
    <div class="ks-sc">
      <div class="ks-sc-label">${c.label}</div>
      <div class="ks-sc-val ${c.cls || ''}">${c.html != null ? c.html : esc(c.val)}</div>
      ${c.sub ? `<div class="ks-sc-sub">${esc(c.sub)}</div>` : ''}
    </div>`).join('')
}

function renderRecentForm(bankroll, stats) {
  const grid = document.getElementById('form-grid')
  if (!grid) return
  if (!bankroll.length || !stats) {
    grid.innerHTML = '<div style="padding:20px;color:var(--text-dim);text-align:center;font-size:13px;">No data yet.</div>'
    return
  }

  const recent = bankroll.slice(-7)
  const r7wins   = recent.reduce((s, d) => s + (d.wins || 0), 0)
  const r7losses = recent.reduce((s, d) => s + (d.losses || 0), 0)
  const r7pnl    = recent.reduce((s, d) => s + (d.pnl || 0), 0)
  const r7bets   = recent.reduce((s, d) => s + (d.bets || 0), 0)
  const r7days   = recent.length
  const r7wr     = r7wins + r7losses > 0 ? r7wins / (r7wins + r7losses) : 0
  const r7pnlDay = r7days > 0 ? r7pnl / r7days : 0
  const r7bpDay  = r7days > 0 ? r7bets / r7days : 0

  const totDays  = bankroll.length
  const totWins  = stats.wins || 0
  const totLoss  = stats.losses || 0
  const totPnl   = stats.total_pnl || 0
  const totBets  = totWins + totLoss
  const sWr      = totWins + totLoss > 0 ? totWins / (totWins + totLoss) : 0
  const sPnlDay  = totDays > 0 ? totPnl / totDays : 0
  const sBpDay   = totDays > 0 ? totBets / totDays : 0

  const rows = [
    {
      label: 'Win Rate',
      r7: fmtPct(r7wr), s: fmtPct(sWr),
      diff: r7wr - sWr,
      diffStr: (r7wr - sWr >= 0 ? '▲ +' : '▼ ') + (Math.abs(r7wr - sWr) * 100).toFixed(1) + 'pp',
      rCls: r7wr >= 0.55 ? 'good' : r7wr >= 0.5 ? '' : 'bad',
      sCls: sWr  >= 0.55 ? 'good' : sWr  >= 0.5 ? '' : 'bad',
    },
    {
      label: 'P&L / Day',
      r7: (r7pnlDay >= 0 ? '+' : '') + fmt$(r7pnlDay),
      s:  (sPnlDay  >= 0 ? '+' : '') + fmt$(sPnlDay),
      diff: r7pnlDay - sPnlDay,
      diffStr: (r7pnlDay - sPnlDay >= 0 ? '▲ +' : '▼ ') + fmt$(Math.abs(r7pnlDay - sPnlDay)),
      rCls: r7pnlDay >= 0 ? 'good' : 'bad',
      sCls: sPnlDay  >= 0 ? 'good' : 'bad',
    },
    {
      label: 'Bets / Day',
      r7: r7bpDay.toFixed(1), s: sBpDay.toFixed(1),
      diff: r7bpDay - sBpDay,
      diffStr: (r7bpDay - sBpDay >= 0 ? '▲ +' : '▼ ') + Math.abs(r7bpDay - sBpDay).toFixed(1),
      rCls: '', sCls: '',
    },
    {
      label: `7-Day P&L`,
      r7: (r7pnl >= 0 ? '+' : '') + fmt$(r7pnl),
      s: fmt$(stats.total_pnl, false),
      diff: r7pnl,
      diffStr: `${r7wins}W · ${r7losses}L`,
      rCls: r7pnl >= 0 ? 'good' : 'bad',
      sCls: stats.total_pnl >= 0 ? 'good' : 'bad',
    },
  ]

  grid.innerHTML = `<div class="ks-form-table">
    <div class="ks-form-row hdr"><div></div><div>Last 7 Days</div><div>Season</div><div>Trend</div></div>
    ${rows.map(r => {
      const dCls = r.diff > 0.001 ? 'good' : r.diff < -0.001 ? 'bad' : 'muted'
      return `<div class="ks-form-row">
        <div class="fg-label">${r.label}</div>
        <div class="fg-val ${r.rCls}">${r.r7}</div>
        <div class="fg-val ${r.sCls}">${r.s}</div>
        <div class="fg-diff ${dCls}">${r.diffStr}</div>
      </div>`
    }).join('')}
  </div>`
}

function renderEdgeBreakdown(data) {
  if (!data) return
  renderBdRows('bd-bucket', data.by_bucket)
  renderBdRows('bd-side',   data.by_side)
  renderBdRows('bd-strike', data.by_strike)
}

function renderBdRows(id, rows) {
  const el = document.getElementById(id)
  if (!el || !rows) return
  if (!rows.length) { el.innerHTML = '<div style="padding:12px 0;color:var(--text-dim);font-size:12px;">No data.</div>'; return }

  const maxWr = Math.max(...rows.map(r => r.win_rate || 0), 0.01)

  el.innerHTML = rows.map(r => {
    const pct      = r.bets > 0 ? (r.win_rate / maxWr) * 100 : 0
    const barColor = r.win_rate >= 0.55 ? 'var(--good)' : r.win_rate >= 0.5 ? 'var(--warn)' : 'var(--bad)'
    const wrCls    = r.win_rate >= 0.55 ? 'good' : r.win_rate >= 0.5 ? '' : 'bad'
    const pnlCls   = r.pnl >= 0 ? 'good' : 'bad'
    return `<div class="bd-row">
      <div class="bd-label">${esc(r.label)}</div>
      <div class="bd-bar-wrap">
        <div class="bd-bar-fill" style="width:${pct.toFixed(1)}%;background:${barColor}"></div>
      </div>
      <div class="bd-wr ${wrCls}">${r.bets > 0 ? fmtPct(r.win_rate) : '—'} <span class="muted" style="font-size:10px">(${r.bets})</span></div>
      <div class="bd-pnl ${pnlCls}">${r.pnl >= 0 ? '+' : ''}${fmt$(r.pnl)}</div>
    </div>`
  }).join('')
}

function renderPitcherLeaderboard(data) {
  if (!data) return
  renderLbRows('lb-top',    data.top)
  renderLbRows('lb-bottom', data.bottom)
}

function renderLbRows(id, rows) {
  const el = document.getElementById(id)
  if (!el || !rows) return
  if (!rows.length) {
    el.innerHTML = '<div style="padding:20px;color:var(--text-dim);font-size:13px;text-align:center;">No data yet.</div>'
    return
  }
  el.innerHTML = rows.map(r => {
    const pnlCls = r.pnl >= 0 ? 'good' : 'bad'
    const rowCls = r.pnl >= 0 ? 'profit' : 'neg'
    const wrCls  = r.win_rate >= 0.55 ? 'good' : r.win_rate >= 0.5 ? '' : 'bad'
    return `<div class="ks-lb-row ${rowCls}">
      <div class="pitcher-name">${esc(r.pitcher)}</div>
      <div class="muted">${r.bets}</div>
      <div class="muted">${r.wins}/${r.losses}</div>
      <div class="${wrCls}">${fmtPct(r.win_rate)}</div>
      <div class="${pnlCls}">${r.pnl >= 0 ? '+' : ''}${fmt$(r.pnl)}</div>
    </div>`
  }).join('')
}

// ──────────────────────────────────────────────────────────────────────────
// BET LOG view
// ──────────────────────────────────────────────────────────────────────────
async function refreshLogView() {
  wireLogFilters()
  await loadBets()
}

function wireLogFilters() {
  if (document.getElementById('lf-apply').dataset.wired) return
  document.getElementById('lf-apply').dataset.wired = '1'
  document.getElementById('lf-apply').addEventListener('click', () => { state.log.page = 1; loadBets() })
  document.getElementById('lf-clear').addEventListener('click', () => {
    document.getElementById('lf-pitcher').value = ''
    document.getElementById('lf-side').value    = ''
    document.getElementById('lf-result').value  = ''
    document.getElementById('lf-from').value    = ''
    document.getElementById('lf-to').value      = ''
    state.log = { page: 1, pitcher: '', side: '', result: '', from: '', to: '', sort: 'bet_date', dir: 'desc' }
    document.querySelectorAll('.log-preset-btn').forEach(b => b.classList.remove('active'))
    loadBets()
  })
  document.getElementById('lf-pitcher').addEventListener('keydown', e => { if (e.key === 'Enter') { state.log.page = 1; loadBets() } })

  // Quick-date preset buttons
  document.querySelectorAll('.log-preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const today = new Date()
      const fmt = d => d.toISOString().split('T')[0]
      let from, to = fmt(today)
      if (btn.dataset.preset === 'today') {
        from = fmt(today)
      } else if (btn.dataset.preset === 'yesterday') {
        const y = new Date(today); y.setDate(today.getDate() - 1)
        from = to = fmt(y)
      } else if (btn.dataset.preset === 'week') {
        const s = new Date(today); s.setDate(today.getDate() - today.getDay())
        from = fmt(s)
      } else if (btn.dataset.preset === 'month') {
        from = fmt(new Date(today.getFullYear(), today.getMonth(), 1))
      }
      document.getElementById('lf-from').value = from
      document.getElementById('lf-to').value   = to
      document.querySelectorAll('.log-preset-btn').forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
      state.log.page = 1; loadBets()
    })
  })

}

async function loadBets() {
  const f = state.log
  f.pitcher = document.getElementById('lf-pitcher').value.trim()
  f.side    = document.getElementById('lf-side').value
  f.result  = document.getElementById('lf-result').value
  f.from    = document.getElementById('lf-from').value
  f.to      = document.getElementById('lf-to').value

  const params = new URLSearchParams({ page: f.page, limit: 50 })
  if (f.pitcher) params.set('pitcher', f.pitcher)
  if (f.side)    params.set('side', f.side)
  if (f.result)  params.set('result', f.result)
  if (f.from)    params.set('from', f.from)
  if (f.to)      params.set('to', f.to)
  params.set('sort', f.sort || 'bet_date')
  params.set('dir',  f.dir  || 'desc')

  const data = await fetchJson(`/api/ks/bets?${params}`).catch(() => null)
  const body = document.getElementById('log-body')
  body.innerHTML = ''

  if (!data?.bets?.length) {
    body.innerHTML = '<div class="sc-empty">No bets found.</div>'
    renderLogPagination(null)
    return
  }

  for (const b of data.bets) {
    const isWin  = b.result === 'win'
    const isLoss = b.result === 'loss'
    const isPend = !b.result || b.result === 'pending'
    const cls    = isWin ? 'sc-win' : isLoss ? 'sc-loss' : 'sc-wait'

    const face = b.bet_size != null ? Number(b.bet_size) : null
    const desc    = betDescPlain(b.side, b.strike)
    const outcome = betOutcomePlain(b.side, b.strike, b.actual_ks, b.result)

    const pnlText = b.pnl != null
      ? `${b.pnl >= 0 ? '+' : ''}${fmt$(b.pnl)}`
      : isPend && face ? `To win +${fmt$(face)}` : '—'
    const pnlCls = b.pnl != null ? (b.pnl >= 0 ? 'good' : 'bad') : 'muted'

    const card = document.createElement('div')
    card.className = `sc-bet-card ${cls}`
    card.innerHTML = `
      <div class="sc-bet-header">
        <div>
          <div class="sc-bet-date">${b.bet_date || '—'}</div>
          <div class="sc-bet-pitcher">${esc(b.pitcher_name || '—')}</div>
          <div class="sc-bet-desc">${desc}</div>
          ${!isPend ? `<div class="sc-bet-outcome">${outcome}</div>` : ''}
        </div>
        <div class="sc-bet-right">
          <div class="sc-bet-amount ${pnlCls}">${pnlText}</div>
        </div>
      </div>`
    body.appendChild(card)
  }
  renderLogPagination(data)
}

function renderLogPagination(data) {
  const host = document.getElementById('log-pagination')
  host.innerHTML = ''
  if (!data || data.pages <= 1) return
  const prev = document.createElement('button')
  prev.textContent = '← Prev'
  prev.disabled = state.log.page <= 1
  prev.addEventListener('click', () => { state.log.page--; loadBets() })
  const info = document.createElement('span')
  info.className = 'muted'
  info.textContent = ` Page ${data.page} of ${data.pages} · ${data.total} bets `
  const next = document.createElement('button')
  next.textContent = 'Next →'
  next.disabled = state.log.page >= data.pages
  next.addEventListener('click', () => { state.log.page++; loadBets() })
  host.append(prev, info, next)
}

// ──────────────────────────────────────────────────────────────────────────
// TESTING view
// ──────────────────────────────────────────────────────────────────────────
async function refreshTestingView() {
  await loadGameReview()
  await loadTestingStats()
  wireTestingFilters()
}

function wireTestingFilters() {
  const btn = document.getElementById('test-filter-btn')
  if (btn && !btn._wired) {
    btn._wired = true
    btn.addEventListener('click', loadGameReview)
  }
}

async function loadGameReview() {
  const result = document.getElementById('test-result-filter')?.value || ''
  const from   = document.getElementById('test-date-from')?.value || ''
  const to     = document.getElementById('test-date-to')?.value   || ''
  const params = new URLSearchParams()
  if (result) params.set('result', result)
  if (from)   params.set('from', from)
  if (to)     params.set('to', to)

  const data = await fetchJson(`/api/ks/game-review?${params}`).catch(() => null)
  const host = document.getElementById('game-review-list')
  if (!host) return
  if (!data || !data.length) {
    host.innerHTML = '<div class="empty-msg">No games found.</div>'
    return
  }

  host.innerHTML = ''
  for (const { date, games } of data) {
    const dateHdr = document.createElement('div')
    dateHdr.className = 'review-date-hdr'
    dateHdr.textContent = fmtDateFull(date)
    host.appendChild(dateHdr)

    for (const g of games) {
      const card = document.createElement('div')
      card.className = 'review-game-card'

      const allSettled  = g.wins + g.losses
      const winRateStr  = allSettled > 0 ? `${Math.round(g.wins / allSettled * 100)}%` : '—'
      const pnlCls      = g.pnl >= 0 ? 'good' : 'bad'
      const resultLabel = g.pending > 0
        ? `<span class="badge pending">${g.pending} pending</span>`
        : g.wins > 0 && g.losses === 0
          ? `<span class="badge win">SWEEP</span>`
          : g.losses > 0 && g.wins === 0
            ? `<span class="badge loss">0 for ${g.losses}</span>`
            : `<span class="badge mixed">${g.wins}W ${g.losses}L</span>`

      const lambdaNote = g.lambda_err != null
        ? (() => {
            const err = g.lambda_err
            if (Math.abs(err) < 0.5) return ''
            const dir = err > 0 ? 'over-predicted' : 'under-predicted'
            const cls = Math.abs(err) >= 2 ? 'warn' : 'muted'
            return `<span class="lambda-note ${cls}">Model ${dir} by ${Math.abs(err).toFixed(1)} Ks</span>`
          })()
        : ''

      card.innerHTML = `
        <div class="review-game-top">
          <div class="review-pitcher">${g.pitcher_name}</div>
          <div class="review-game-id">${g.game || ''}</div>
          ${resultLabel}
          <div class="review-pnl ${pnlCls}">${g.pnl >= 0 ? '+' : ''}$${g.pnl.toFixed(2)}</div>
        </div>
        <div class="review-game-meta">
          <span>Model predicted ${(g.lambda||0).toFixed(1)} Ks</span>
          ${g.actual_ks != null ? `<span>Actual: <b>${g.actual_ks}K</b></span>` : ''}
          ${lambdaNote}
          <span>${g.bets.length} bet${g.bets.length !== 1 ? 's' : ''} · ${winRateStr} WR</span>
          ${g.savant_k_pct != null ? `<span>K%=${(g.savant_k_pct*100).toFixed(0)}%</span>` : ''}
          ${g.ump_name ? `<span>UMP: ${g.ump_name} (${g.ump_factor != null ? (g.ump_factor>=0?'+':'')+g.ump_factor.toFixed(2) : '—'})</span>` : ''}
        </div>
        <div class="review-bets">
          ${g.bets.map(b => {
            const cls = !b.result ? 'pending' : b.result === 'win' ? 'win' : 'loss'
            const pnl = b.pnl != null ? ` <span class="${b.pnl>=0?'good':'bad'}">${b.pnl>=0?'+':''}$${Number(b.pnl).toFixed(2)}</span>` : ''
            const chipLabel = b.side === 'YES' ? `${b.strike}+ YES` : `Under ${b.strike} NO`
            return `<span class="bet-chip ${cls}">${chipLabel}${pnl}</span>`
          }).join('')}
        </div>`
      host.appendChild(card)
    }
  }
}

async function loadTestingStats() {
  const data = await fetchJson('/api/ks/testing').catch(() => null)
  if (!data) return

  // Model notes panel
  const notesPanel = document.getElementById('model-notes-panel')
  const notesList  = document.getElementById('model-notes-list')
  if (notesPanel && notesList && data.model_notes?.length) {
    notesPanel.style.display = ''
    notesList.innerHTML = data.model_notes.map(n =>
      `<div class="model-note model-note--${n.level}">${n.text}</div>`
    ).join('')
  }

  // Calibration table
  const calibTbody = document.querySelector('#calib-table tbody')
  if (calibTbody && data.calibration?.length) {
    calibTbody.innerHTML = data.calibration.map(r => {
      const wrCls  = r.win_rate >= 0.55 ? 'good' : r.win_rate < 0.45 ? 'bad' : ''
      const pnlCls = r.pnl >= 0 ? 'good' : 'bad'
      return `<tr>
        <td>${r.bucket_cents}¢</td><td>${r.bets}</td><td>${r.wins}</td><td>${r.losses}</td>
        <td class="${wrCls}">${(r.win_rate*100).toFixed(0)}%</td>
        <td class="${pnlCls}">${r.pnl>=0?'+':''}$${r.pnl.toFixed(2)}</td>
      </tr>`
    }).join('')
  }

  // Threshold table
  const threshTbody = document.querySelector('#thresh-table tbody')
  if (threshTbody && data.thresholds?.length) {
    threshTbody.innerHTML = data.thresholds.map(r => {
      const roiCls = r.roi >= 0 ? 'good' : 'bad'
      const pnlCls = r.pnl >= 0 ? 'good' : 'bad'
      return `<tr>
        <td>${r.threshold_cents}¢+</td><td>${r.bets}</td><td>${r.wins}</td><td>${r.losses}</td>
        <td>${(r.win_rate*100).toFixed(0)}%</td>
        <td class="${pnlCls}">${r.pnl>=0?'+':''}$${r.pnl.toFixed(2)}</td>
        <td class="${roiCls}">${(r.roi*100).toFixed(1)}%</td>
      </tr>`
    }).join('')
  }

  // Lambda accuracy table with per-pitcher notes
  const lambdaTbody = document.querySelector('#lambda-table tbody')
  if (lambdaTbody && data.lambda_accuracy?.length) {
    lambdaTbody.innerHTML = data.lambda_accuracy.map(r => {
      const errCls = Math.abs(r.lambda_err) >= 2 ? (r.lambda_err > 0 ? 'bad' : 'good') : ''
      const pnlCls = r.pnl >= 0 ? 'good' : 'bad'
      const notesHtml = r.notes?.length
        ? `<tr class="pitcher-notes-row"><td colspan="7">${r.notes.map(n => `<span class="pitcher-note">${n}</span>`).join('')}</td></tr>`
        : ''
      return `<tr>
        <td>${r.pitcher}</td><td>${r.avg_lambda}</td><td>${r.avg_actual}</td>
        <td class="${errCls}">${r.lambda_err > 0 ? '+' : ''}${r.lambda_err}</td>
        <td>${r.bets}</td>
        <td>${(r.win_rate*100).toFixed(0)}%</td>
        <td class="${pnlCls}">${r.pnl>=0?'+':''}$${r.pnl.toFixed(2)}</td>
      </tr>${notesHtml}`
    }).join('')
  }
}

// ──────────────────────────────────────────────────────────────────────────
// SETTINGS view
// ──────────────────────────────────────────────────────────────────────────
async function refreshSettings() {
  await loadUsers()
  wireAddUser()
}

async function loadUsers() {
  const users = await fetchJson('/api/users').catch(() => [])
  const list = document.getElementById('user-list')
  list.innerHTML = ''
  if (!users.length) {
    list.innerHTML = '<div style="color:var(--text-dim);font-size:13px;padding:8px 0;">No users yet.</div>'
    return
  }
  for (const u of users) {
    const isMe = u.name.toLowerCase() === state.currentUser?.toLowerCase()
    list.appendChild(buildUserCard(u, isMe))
  }
}

function buildUserCard(u, isMe) {
  const bettorBadge = u.active_bettor
    ? (u.paper ? '<span class="u-badge paper">PAPER</span>' : '<span class="u-badge live">LIVE</span>')
    : ''
  const keyStatus = u.has_kalshi_key
    ? '<span class="u-keychip ok">key ✓</span>'
    : '<span class="u-keychip miss">no key</span>'

  const wrap = document.createElement('div')
  wrap.className = 'user-item-wrap'
  wrap.innerHTML = `
    <div class="user-item">
      <div>
        <div class="u-name">${esc(u.name)}${isMe ? ' <span class="u-you">(you)</span>' : ''} ${bettorBadge}</div>
        <div class="u-since">Added ${fmtDateFull(u.created_at?.slice(0, 10) || '')} ${u.active_bettor ? '· ' + keyStatus : ''}</div>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <button class="u-edit filter-btn secondary">Edit</button>
        ${isMe ? '' : `<button class="u-del">Remove</button>`}
      </div>
    </div>
    <div class="u-bettor-form" style="display:none">
      <div class="bettor-form-grid">
        <label>Active Bettor
          <input type="checkbox" class="bf-active" ${u.active_bettor ? 'checked' : ''}/>
        </label>
        <label>Mode
          <select class="bf-paper">
            <option value="1" ${u.paper !== 0 ? 'selected' : ''}>Paper</option>
            <option value="0" ${u.paper === 0 ? 'selected' : ''}>Live</option>
          </select>
        </label>
        <label>Starting Bankroll ($)
          <input type="number" class="bf-bankroll" value="${u.starting_bankroll ?? 5000}" min="100" step="100"/>
        </label>
        <label>Daily Risk %
          <input type="number" class="bf-risk" value="${Math.round((u.daily_risk_pct ?? 0.20) * 100)}" min="1" max="100"/>
        </label>
      </div>
      <label class="bf-label-full">Kalshi Key ID
        <input type="text" class="bf-keyid" value="${esc(u.kalshi_key_id || '')}" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" autocomplete="off"/>
      </label>
      <label class="bf-label-full">Kalshi Private Key (RSA PEM) ${u.has_kalshi_key ? '<span class="u-keychip ok">saved</span>' : ''}
        <textarea class="bf-pem" rows="4" placeholder="-----BEGIN RSA PRIVATE KEY-----&#10;...paste full PEM here...&#10;-----END RSA PRIVATE KEY-----" autocomplete="off"></textarea>
        <span class="bf-pem-hint">Leave blank to keep existing key.</span>
      </label>
      <label class="bf-label-full">Discord Webhook URL (optional)
        <input type="text" class="bf-discord" value="${esc(u.discord_webhook || '')}" placeholder="https://discord.com/api/webhooks/…" autocomplete="off"/>
      </label>
      <label class="bf-label-full">Change PIN (leave blank to keep)
        <input type="password" class="bf-pin" placeholder="New PIN (4+ digits)" maxlength="10" inputmode="numeric" autocomplete="new-password"/>
      </label>
      <div style="display:flex;gap:8px;margin-top:10px">
        <button class="u-save filter-btn">Save</button>
        <button class="u-cancel filter-btn secondary">Cancel</button>
      </div>
      <div class="form-msg bf-msg"></div>
    </div>`

  const editBtn   = wrap.querySelector('.u-edit')
  const form      = wrap.querySelector('.u-bettor-form')
  const saveBtn   = wrap.querySelector('.u-save')
  const cancelBtn = wrap.querySelector('.u-cancel')
  const delBtn    = wrap.querySelector('.u-del')
  const msg       = wrap.querySelector('.bf-msg')

  editBtn.addEventListener('click', () => {
    const open = form.style.display !== 'none'
    form.style.display = open ? 'none' : 'block'
    editBtn.textContent = open ? 'Edit' : 'Close'
  })
  cancelBtn.addEventListener('click', () => {
    form.style.display = 'none'
    editBtn.textContent = 'Edit'
  })

  saveBtn.addEventListener('click', async () => {
    msg.className = 'form-msg'; msg.textContent = ''
    const body = {
      active_bettor:     wrap.querySelector('.bf-active').checked,
      paper:             wrap.querySelector('.bf-paper').value === '1',
      starting_bankroll: Number(wrap.querySelector('.bf-bankroll').value),
      daily_risk_pct:    Number(wrap.querySelector('.bf-risk').value) / 100,
      kalshi_key_id:     wrap.querySelector('.bf-keyid').value.trim() || null,
      discord_webhook:   wrap.querySelector('.bf-discord').value.trim() || null,
    }
    const pem = wrap.querySelector('.bf-pem').value.trim()
    if (pem) body.kalshi_private_key = pem
    const pin = wrap.querySelector('.bf-pin').value.trim()
    if (pin) {
      if (pin.length < 4) { msg.className = 'form-msg err'; msg.textContent = 'PIN must be at least 4 digits.'; return }
      body.pin = pin
    }
    try {
      const r = await fetch(`/api/users/${u.id}`, {
        method: 'PUT', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const d = await r.json()
      if (!r.ok) { msg.className = 'form-msg err'; msg.textContent = d.error || 'Error'; return }
      msg.className = 'form-msg ok'; msg.textContent = 'Saved.'
      setTimeout(() => { msg.textContent = ''; form.style.display = 'none'; editBtn.textContent = 'Edit' }, 1500)
      await loadUsers()
    } catch { msg.className = 'form-msg err'; msg.textContent = 'Network error.' }
  })

  if (delBtn) {
    delBtn.addEventListener('click', async () => {
      if (!confirm(`Remove user "${u.name}"?`)) return
      await fetchJson(`/api/users/${encodeURIComponent(u.name)}`, { method: 'DELETE' }).catch(() => null)
      await loadUsers()
    })
  }
  return wrap
}

function wireAddUser() {
  const btn = document.getElementById('add-user-btn')
  if (btn.dataset.wired) return
  btn.dataset.wired = '1'
  btn.addEventListener('click', async () => {
    const name = document.getElementById('new-name').value.trim()
    const pin  = document.getElementById('new-pin').value.trim()
    const msg  = document.getElementById('add-user-msg')
    msg.className = 'form-msg'
    msg.textContent = ''
    if (!name || !pin) { msg.className = 'form-msg err'; msg.textContent = 'Name and PIN required.'; return }
    if (pin.length < 4) { msg.className = 'form-msg err'; msg.textContent = 'PIN must be at least 4 digits.'; return }
    try {
      const r = await fetch('/api/users', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, pin }),
      })
      const d = await r.json()
      if (!r.ok) { msg.className = 'form-msg err'; msg.textContent = d.error || 'Error'; return }
      document.getElementById('new-name').value = ''
      document.getElementById('new-pin').value  = ''
      msg.className = 'form-msg ok'; msg.textContent = `User "${name}" added.`
      setTimeout(() => msg.textContent = '', 3000)
      await loadUsers()
    } catch { msg.className = 'form-msg err'; msg.textContent = 'Network error.' }
  })
}

// ──────────────────────────────────────────────────────────────────────────
// Utilities
// ──────────────────────────────────────────────────────────────────────────
async function fetchJson(url, opts = {}) {
  const r = await fetch(url, { credentials: 'same-origin', ...opts })
  if (r.status === 401) { window.location.href = '/login'; return Promise.reject('unauth') }
  if (!r.ok) return Promise.reject(new Error(`HTTP ${r.status}`))
  return r.json()
}

function setText(id, text) {
  const el = document.getElementById(id)
  if (!el) return
  el.classList.remove('skel')
  el.textContent = text
}
function setHtml(id, html) {
  const el = document.getElementById(id)
  if (!el) return
  el.classList.remove('skel')
  el.innerHTML = html
}
function setDelta(id, val) {
  const el = document.getElementById(id)
  if (!el) return
  el.classList.remove('skel')
  const v = Number(val || 0)
  el.className = v > 0 ? 'good' : v < 0 ? 'bad' : 'muted'
  el.textContent = (v >= 0 ? '+' : '') + fmt$(v)
}

function updateLastSeen() {
  const el = document.getElementById('last-updated')
  if (!el || !state.lastRefresh) return
  const s = Math.round((Date.now() - state.lastRefresh) / 1000)
  el.textContent = `Updated: ${s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`}`
}

// Formatting
function fmt$(n, noSign = false) {
  if (n == null || Number.isNaN(n)) return '$—'
  const v = Number(n)
  const abs = Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  if (noSign) return '$' + abs
  return (v < 0 ? '-$' : '$') + abs
}
function fmtPct(n, dp = 1) {
  if (n == null || Number.isNaN(n)) return '—'
  return (n * 100).toFixed(dp) + '%'
}
function fmtTs(iso) {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
  } catch { return '' }
}
function fmtDatePill(d) {
  try {
    const dt    = new Date(d + 'T12:00:00')
    const today = new Date(); today.setHours(0, 0, 0, 0)
    const date  = new Date(d + 'T00:00:00')
    if (date.getTime() === today.getTime()) return 'Today'
    const yest = new Date(today.getTime() - 86400000)
    if (date.getTime() === yest.getTime()) return 'Yesterday'
    return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  } catch { return d }
}
function fmtDateFull(d) {
  if (!d) return '—'
  try {
    return new Date(d + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
  } catch { return d }
}
function esc(s) {
  if (s == null) return ''
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]))
}
