// KSBETS dashboard — Strikeout P&L tracker
// Fetches /api/ks/* and /api/users, renders all four views.

const state = {
  view:         localStorage.getItem('ks.view') || 'today',
  selectedDate: null,
  charts:       { bankroll: null, daily: null, weekly: null },
  log:          { page: 1, pitcher: '', side: '', result: '', from: '', to: '' },
  lastRefresh:  null,
  currentUser:  null,
  liveTimer:    null,
}

// ──────────────────────────────────────────────────────────────────────────
// Boot
// ──────────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init)

async function init() {
  await loadUser()
  wireTabs()
  applyView(state.view, false)
  await refreshAll()
  setInterval(refreshHero, 3 * 60 * 1000)
  setInterval(updateLastSeen, 15 * 1000)
}

async function loadUser() {
  try {
    const r = await fetch('/auth/me', { credentials: 'same-origin' })
    if (!r.ok) { window.location.href = '/login'; return }
    const { user } = await r.json()
    state.currentUser = user?.name
    document.getElementById('user-name').textContent = user?.name || '—'
  } catch { window.location.href = '/login' }
}

// ──────────────────────────────────────────────────────────────────────────
// Tab switching
// ──────────────────────────────────────────────────────────────────────────
function wireTabs() {
  document.querySelectorAll('.mode[data-view]').forEach(btn => {
    btn.addEventListener('click', () => applyView(btn.dataset.view))
  })

  // Expandable bet tile detail drawers (event delegation, works for dynamic content)
  document.addEventListener('click', e => {
    const btn = e.target.closest('.pc-detail-toggle')
    if (!btn) return
    const tile   = btn.closest('.pc-bet-tile')
    const detail = tile?.querySelector('.pc-bet-detail')
    if (!detail) return
    const isOpen = detail.classList.toggle('open')
    detail.hidden = false        // remove HTML hidden attr so CSS transition works
    btn.classList.toggle('open', isOpen)
    btn.title = isOpen ? 'Hide details' : 'Show details'
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
  if (state.view === 'today')    await refreshTodayView()
  if (state.view === 'trends')   await refreshTrendsView()
  if (state.view === 'testing')  await refreshTestingView()
  if (state.view === 'log')      await refreshLogView()
  if (state.view === 'settings') await refreshSettings()
  state.lastRefresh = Date.now()
  updateLastSeen()
}

async function refreshHero() {
  const s = await fetchJson('/api/ks/summary').catch(() => null)
  if (!s) return
  const bankrollEl = document.getElementById('hero-bankroll')
  bankrollEl.classList.remove('skel')
  bankrollEl.textContent = fmt$(s.bankroll, true)
  bankrollEl.className = s.total_pnl >= 0 ? 'bankroll-value good' : 'bankroll-value bad'

  setText('hero-start', fmt$(s.start_bankroll, true))
  const roi = s.start_bankroll > 0 ? s.total_pnl / s.start_bankroll : 0
  setHtml('hero-roi', `<span class="${roi >= 0 ? 'good' : 'bad'}">${fmtPct(roi, 1)}</span>`)

  setDelta('hero-today', s.today_pnl)
  setDelta('hero-week',  s.week_pnl)
  setDelta('hero-month', s.month_pnl)
  setDelta('hero-ytd',   s.ytd_pnl)

  const wr = s.win_rate
  setHtml('hero-wr', `<span class="${wr >= 0.55 ? 'good' : wr >= 0.5 ? '' : 'bad'}">${fmtPct(wr)}</span>`)
  const betsEl = document.getElementById('hero-bets')
  betsEl.classList.remove('skel')
  betsEl.textContent = `${s.settled}/${s.total_bets}`

  const pendEl = document.getElementById('hero-pending')
  pendEl.classList.remove('skel')
  pendEl.textContent = s.pending > 0 ? `${s.pending} live` : '0'
  pendEl.style.color = s.pending > 0 ? 'var(--accent)' : 'var(--muted)'

  const edgeEl = document.getElementById('hero-edge')
  edgeEl.classList.remove('skel')
  edgeEl.textContent = s.avg_edge != null ? `${(s.avg_edge * 100).toFixed(1)}¢` : '—'
}

// ──────────────────────────────────────────────────────────────────────────
// TODAY view
// ──────────────────────────────────────────────────────────────────────────
async function refreshTodayView() {
  await refreshDates()
}

async function refreshDates() {
  const dates = await fetchJson('/api/ks/dates').catch(() => [])
  const today = new Date().toISOString().slice(0, 10)
  if (!dates.includes(today)) dates.unshift(today)
  if (!state.selectedDate || !dates.includes(state.selectedDate)) {
    state.selectedDate = dates[0] || today
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
  const data = await fetchJson(`/api/ks/daily?date=${date}`).catch(() => null)
  const list  = document.getElementById('pitcher-list')
  const empty = document.getElementById('empty-today')
  const hdr   = document.getElementById('day-header')
  const liveBanner = document.getElementById('live-banner')

  list.querySelectorAll('.pitcher-card').forEach(el => el.remove())
  if (liveBanner) liveBanner.hidden = true

  if (!data || !data.pitchers?.length) {
    hdr.hidden = true
    empty.hidden = false
    return
  }
  empty.hidden = true

  hdr.hidden = false
  const pnlCls = data.day_pnl >= 0 ? 'good' : 'bad'
  hdr.innerHTML = `
    <div>
      <div class="day-date">${fmtDateFull(date)}</div>
      <div class="day-meta">${data.pitchers.length} pitcher${data.pitchers.length !== 1 ? 's' : ''} · ${data.day_bets} bets</div>
    </div>
    <div>
      <span class="day-meta">${data.day_wins}W · ${data.day_losses}L${data.day_pending > 0 ? ` · ${data.day_pending} pending` : ''}</span>
    </div>
    <div class="day-pnl ${pnlCls}">${data.day_pnl >= 0 ? '+' : ''}${fmt$(data.day_pnl)}</div>`

  for (const p of data.pitchers) {
    list.appendChild(buildPitcherCard(p))
  }

  // Start live polling whenever there are pending bets
  if (data.day_pending > 0) startLivePolling(date)
}

function buildPitcherCard(p) {
  const card = document.createElement('article')
  let colorCls = 'pending'
  if (p.pending === 0) {
    if (p.losses === 0 && p.wins > 0)        colorCls = 'win'
    else if (p.wins === 0 && p.losses > 0)   colorCls = 'loss'
    else if (p.wins > 0 && p.losses > 0)     colorCls = 'mixed'
  }
  card.className = `pitcher-card ${colorCls}`
  if (p.pitcher_id) card.dataset.pitcherId = p.pitcher_id

  const pnlCls = p.pnl >= 0 ? 'good' : 'bad'
  const pnlStr = p.pnl != null
    ? `<span class="${pnlCls}">${p.pnl >= 0 ? '+' : ''}${fmt$(p.pnl)}</span>`
    : '<span class="muted">—</span>'

  // Actual Ks badge — shown when settled
  const actualKsBadge = p.actual_ks != null
    ? `<div class="pc-actual-ks">Threw <strong>${p.actual_ks}</strong> Ks</div>`
    : ''

  const betTiles = p.bets.map(b => {
    const mid  = b.market_mid != null ? Number(b.market_mid) : null
    const face = b.bet_size   != null ? Number(b.bet_size)   : null
    const wager  = mid != null && face != null ? fmt$(face * mid / 100) : '—'
    const potWin = mid != null && face != null ? fmt$(face * (100 - mid) / 100) : '—'

    // Plain-English description of what we're betting on
    const direction = b.side === 'YES'
      ? `Will throw <strong>${b.strike}+</strong> strikeouts`
      : `Will throw <strong>fewer than ${b.strike}</strong> strikeouts`

    let resultBadge, moneyLine
    if (b.result === 'win') {
      resultBadge = `<span class="pc-badge pc-badge--win">✓ WIN</span>`
      moneyLine   = `<span class="pc-money-win">+${fmt$(b.pnl)}</span>`
    } else if (b.result === 'loss') {
      resultBadge = `<span class="pc-badge pc-badge--loss">✗ LOSS</span>`
      moneyLine   = `<span class="pc-money-loss">${fmt$(b.pnl)}</span>`
    } else {
      resultBadge = `<span class="pc-badge pc-badge--pending">In Progress</span>`
      moneyLine   = `<span class="pc-money-potential">Could win ${potWin}</span>`
    }

    const tileCls = b.result === 'win' ? 'pc-bet-tile--win'
      : b.result === 'loss' ? 'pc-bet-tile--loss' : ''

    // Technical detail drawer (hidden by default, shown on click)
    const modelPct    = b.model_prob    != null ? `${(b.model_prob * 100).toFixed(1)}%` : '—'
    const rawPct      = b.raw_model_prob != null ? `${(b.raw_model_prob * 100).toFixed(1)}%` : modelPct
    const edgeCents   = b.edge          != null ? `+${(b.edge * 100).toFixed(1)}¢` : '—'
    const midCents    = b.market_mid    != null ? `${b.market_mid}¢` : '—'
    const spreadCents = b.spread        != null ? `${b.spread}¢` : '—'
    const kellyPct    = b.kelly_fraction != null ? `${(b.kelly_fraction * 100).toFixed(1)}%` : '—'
    const lambdaVal   = b.lambda        != null ? b.lambda.toFixed(2) : '—'
    const parkVal     = b.park_factor   != null && b.park_factor !== 1 ? `×${b.park_factor.toFixed(2)}` : 'neutral'
    const umpVal      = b.ump_name      != null ? `${b.ump_name} (×${b.ump_factor?.toFixed(2) ?? '—'})` : '—'
    const veloVal     = b.velo_trend_mph != null ? `${b.velo_trend_mph >= 0 ? '+' : ''}${b.velo_trend_mph.toFixed(1)} mph` : '—'
    const wxVal       = b.weather_mult  != null && b.weather_mult !== 1 ? `×${b.weather_mult.toFixed(2)}` : 'neutral'

    return `<div class="pc-bet-tile ${tileCls}" data-bet-id="${b.id}">
      <div class="pc-bet-main">
        <div class="pc-bet-desc">${direction}</div>
        <div class="pc-bet-bottom">
          <span class="pc-bet-wager">Bet ${wager}</span>
          ${moneyLine}
          ${resultBadge}
          <button class="pc-detail-toggle" title="Show details">▼</button>
        </div>
      </div>
      <div class="pc-bet-detail" hidden>
        <div class="pc-detail-grid">
          <div class="pc-detail-item"><span>Model probability</span><b>${modelPct}${b.raw_model_prob != null ? ` <span class="muted" style="font-size:12px">(raw ${rawPct})</span>` : ''}</b></div>
          <div class="pc-detail-item"><span>Market price</span><b>${midCents}</b></div>
          <div class="pc-detail-item"><span>Our edge</span><b class="good">${edgeCents}</b></div>
          <div class="pc-detail-item"><span>Spread</span><b>${spreadCents}</b></div>
          <div class="pc-detail-item"><span>Kelly fraction</span><b>${kellyPct}</b></div>
          <div class="pc-detail-item"><span>Lambda (exp Ks)</span><b>${lambdaVal}</b></div>
          <div class="pc-detail-item"><span>Park factor</span><b>${parkVal}</b></div>
          <div class="pc-detail-item"><span>Umpire</span><b>${umpVal}</b></div>
          <div class="pc-detail-item"><span>Velo trend</span><b>${veloVal}</b></div>
          <div class="pc-detail-item"><span>Weather</span><b>${wxVal}</b></div>
        </div>
      </div>
    </div>`
  }).join('')

  // Summary line at bottom
  let summaryLine = ''
  if (p.pending > 0 && p.wins === 0 && p.losses === 0) {
    summaryLine = `<span class="muted">${p.pending} bet${p.pending > 1 ? 's' : ''} in progress</span>`
  } else {
    const parts = []
    if (p.wins   > 0) parts.push(`<span class="good">${p.wins} won</span>`)
    if (p.losses > 0) parts.push(`<span class="bad">${p.losses} lost</span>`)
    if (p.pending > 0) parts.push(`<span class="muted">${p.pending} pending</span>`)
    summaryLine = parts.join(' · ')
  }

  card.innerHTML = `
    <div class="pc-head">
      <div class="pc-head-left">
        <div class="pc-pitcher">${esc(p.pitcher_name)}</div>
        <div class="pc-meta">${esc(p.game || p.team || '—')}</div>
      </div>
      <div class="pc-head-right">
        ${actualKsBadge}
      </div>
    </div>
    <div class="pc-bet-tiles">${betTiles}</div>
    <div class="pc-footer">
      <div class="pc-wl">${summaryLine}</div>
      <div class="pc-total">${pnlStr}</div>
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
}

async function pollLive(date) {
  const data = await fetchJson(`/api/ks/live?date=${date}`).catch(() => null)
  if (!data) return

  renderLiveBanner(data)

  for (const p of data.pitchers) {
    updatePitcherCardLive(p)
  }

  // If everything is final and all bets have settled results, stop polling
  if (data.pitchers.length && data.pitchers.every(p => p.is_final)) {
    // Check if bets are still pending in DB — if so keep polling for settlement
    const anyPending = await fetchJson(`/api/ks/summary`).then(s => s.pending > 0).catch(() => false)
    if (!anyPending) stopLivePolling()
  }
}

function renderLiveBanner(data) {
  const banner = document.getElementById('live-banner')
  if (!banner) return

  const livePitchers  = data.pitchers.filter(p => !p.is_final)
  const finalPitchers = data.pitchers.filter(p => p.is_final)

  if (!data.pitchers.length) { banner.hidden = true; return }
  banner.hidden = false

  const liveChips = livePitchers.map(p => {
    const tto = p.tto3 ? ' <span class="tto-warn">TTO3</span>' : ''
    return `<span class="live-chip">
      <span class="live-chip-name">${esc(p.pitcher_name)}</span>
      <b>${p.ks} Ks</b> / ${p.ip.toFixed(1)} IP
      <span class="live-inning">${esc(p.inning)}</span>${tto}
    </span>`
  }).join('')

  const finalChips = finalPitchers.map(p =>
    `<span class="live-chip final-chip">
      <span class="live-chip-name">${esc(p.pitcher_name)}</span>
      <b>${p.ks} Ks</b> Final
    </span>`
  ).join('')

  banner.innerHTML = `
    ${livePitchers.length ? `<span class="live-dot"></span><span class="live-label">${livePitchers.length} live</span>` : ''}
    ${liveChips}${finalChips}`
}

function updatePitcherCardLive(p) {
  const card = document.querySelector(`.pitcher-card[data-pitcher-id="${CSS.escape(String(p.pitcher_id))}"]`)
  if (!card) return

  // Update/create actual Ks badge
  let ksBadge = card.querySelector('.pc-actual-ks')
  if (!ksBadge) {
    ksBadge = document.createElement('div')
    ksBadge.className = 'pc-actual-ks'
    const headRight = card.querySelector('.pc-head-right')
    if (headRight) headRight.appendChild(ksBadge)
  }
  const ksStrong = ksBadge.querySelector('strong')
  if (ksStrong) {
    ksStrong.textContent = p.ks
    ksStrong.style.color = p.is_final ? '' : 'var(--accent)'
  } else {
    ksBadge.innerHTML = `Threw <strong style="color:var(--accent)">${p.ks}</strong> Ks`
  }

  // Inning badge in header
  let statusBadge = card.querySelector('.pc-live-badge')
  if (!statusBadge) {
    statusBadge = document.createElement('span')
    statusBadge.className = 'pc-live-badge'
    const headRight = card.querySelector('.pc-head-right')
    if (headRight) headRight.prepend(statusBadge)
  }
  statusBadge.textContent = p.inning
  statusBadge.className = `pc-live-badge${p.is_final ? ' final' : ' pulsing'}`

  // Update each pending bet tile
  for (const bs of p.bet_statuses) {
    const tile = card.querySelector(`.pc-bet-tile[data-bet-id="${bs.id}"]`)
    if (!tile) continue
    const badge = tile.querySelector('.pc-badge')
    if (!badge || !badge.classList.contains('pc-badge--pending')) continue

    const isNo = tile.querySelector('.pc-bet-desc')?.textContent?.includes('fewer') ?? false
    if (!isNo) {
      if (bs.needed === 0) {
        badge.textContent = '✓ HIT'; badge.className = 'pc-badge pc-badge--win'
      } else {
        badge.textContent = `Needs ${bs.needed} more`
      }
    } else {
      if (bs.ks >= bs.strike) {
        badge.textContent = '✗ Over'; badge.className = 'pc-badge pc-badge--loss'
      } else if (p.is_final) {
        badge.textContent = '✓ Safe'; badge.className = 'pc-badge pc-badge--win'
      } else {
        badge.textContent = `At ${bs.ks} of ${bs.strike}`
      }
    }
  }

  // TTO3 warning
  if (p.tto3) {
    const meta = card.querySelector('.pc-meta')
    if (meta && !meta.querySelector('.tto-warn')) {
      meta.insertAdjacentHTML('beforeend', ' <span class="tto-warn">⚠ Pitch limit warning</span>')
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// TRENDS view
// ──────────────────────────────────────────────────────────────────────────
async function refreshTrendsView() {
  const [bankroll, monthly, weekly, stats, breakdown, leaderboard] = await Promise.all([
    fetchJson('/api/ks/bankroll').catch(() => []),
    fetchJson('/api/ks/monthly').catch(() => []),
    fetchJson('/api/ks/weekly').catch(() => []),
    fetchJson('/api/ks/stats').catch(() => null),
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
    state.log = { page: 1, pitcher: '', side: '', result: '', from: '', to: '' }
    loadBets()
  })
  document.getElementById('lf-pitcher').addEventListener('keydown', e => { if (e.key === 'Enter') { state.log.page = 1; loadBets() } })
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

  const data = await fetchJson(`/api/ks/bets?${params}`).catch(() => null)
  const body = document.getElementById('log-body')
  body.innerHTML = ''

  if (!data?.bets?.length) {
    body.innerHTML = '<div style="padding:24px;color:var(--text-dim);text-align:center;font-size:13px;">No bets found.</div>'
    renderLogPagination(null)
    return
  }

  for (const b of data.bets) {
    const rowCls = b.result === 'win' ? 'win-row' : b.result === 'loss' ? 'loss-row' : ''
    const row = document.createElement('div')
    row.className = `ks-log-row ${rowCls}`
    const mid  = b.market_mid != null ? Number(b.market_mid) : null
    const face = b.bet_size   != null ? Number(b.bet_size)   : null
    const wager = mid != null && face != null ? fmt$(face * mid / 100) : (face ? fmt$(face) : '—')

    const betDesc = b.side === 'YES'
      ? `${b.strike}+ strikeouts YES`
      : `Under ${b.strike} strikeouts NO`

    const resultHtml = b.result === 'win'
      ? `<span class="pc-badge pc-badge--win">✓ WIN</span>`
      : b.result === 'loss'
      ? `<span class="pc-badge pc-badge--loss">✗ LOSS</span>`
      : `<span class="muted">—</span>`
    const pnlHtml = b.pnl != null
      ? `<span class="${b.pnl >= 0 ? 'good' : 'bad'}">${b.pnl >= 0 ? '+' : ''}${fmt$(b.pnl)}</span>`
      : '<span class="muted">—</span>'

    row.innerHTML = `
      <div class="muted">${b.bet_date || '—'}</div>
      <div class="log-pitcher">${esc(b.pitcher_name || '—')}</div>
      <div class="muted">${betDesc}</div>
      <div>${wager}</div>
      <div>${b.actual_ks != null ? b.actual_ks + 'K' : '—'}</div>
      <div>${resultHtml}</div>
      <div>${pnlHtml}</div>`
    body.appendChild(row)
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
    const item = document.createElement('div')
    item.className = 'user-item'
    item.innerHTML = `
      <div>
        <div class="u-name">${esc(u.name)}${isMe ? ' <span class="u-you">(you)</span>' : ''}</div>
        <div class="u-since">Added ${fmtDateFull(u.created_at?.slice(0, 10) || '')}</div>
      </div>
      ${isMe ? '' : `<button class="u-del" data-name="${esc(u.name)}">Remove</button>`}`
    if (!isMe) {
      item.querySelector('.u-del').addEventListener('click', async () => {
        if (!confirm(`Remove user "${u.name}"?`)) return
        await fetchJson(`/api/users/${encodeURIComponent(u.name)}`, { method: 'DELETE' }).catch(() => null)
        await loadUsers()
      })
    }
    list.appendChild(item)
  }
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
