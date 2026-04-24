import { state } from '../state.js'
import { fmt$, fmtPct, esc } from '../utils.js'
import { fetchJson } from '../api.js'
import { drawBankrollChart, drawDailyChart, drawWeeklyChart } from '../charts.js'

const TRENDS_START_DATE = '2026-04-23'

const trendsState = { period: 'all', from: null, to: null }

function getTrendsDates() {
  const today = new Date().toLocaleDateString('en-CA')
  const { period, from, to } = trendsState
  if (period === 'week') {
    const d = new Date(); const dow = (d.getDay() + 6) % 7
    const mon = new Date(d); mon.setDate(d.getDate() - dow)
    return { from: mon.toLocaleDateString('en-CA'), to: today }
  }
  if (period === 'month') {
    const d = new Date()
    return { from: `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-01`, to: today }
  }
  if (period === 'since_start') return { from: TRENDS_START_DATE, to: today }
  if (period === 'custom')      return { from, to }
  return { from: null, to: null }
}

function buildTrendsParams() {
  const uid   = state.liveBettorId ? `user_id=${state.liveBettorId}` : ''
  const dates = getTrendsDates()
  const parts = [uid, dates.from ? `from=${dates.from}` : '', dates.to ? `to=${dates.to}` : ''].filter(Boolean)
  return parts.length ? '?' + parts.join('&') : ''
}

export function initTrendsPeriodBar() {
  document.querySelectorAll('.period-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
      trendsState.period = btn.dataset.period
      const customRange = document.getElementById('period-custom-range')
      if (customRange) customRange.style.display = trendsState.period === 'custom' ? 'flex' : 'none'
      if (trendsState.period !== 'custom') refreshTrendsView()
    })
  })
  const applyBtn = document.getElementById('period-apply')
  if (applyBtn) applyBtn.addEventListener('click', () => {
    trendsState.from = document.getElementById('period-from')?.value || null
    trendsState.to   = document.getElementById('period-to')?.value   || null
    refreshTrendsView()
  })
}

export async function refreshTrendsView() {
  const p = buildTrendsParams()
  const baseP = state.liveBettorId ? `?user_id=${state.liveBettorId}` : ''
  const [bankroll, monthly, weekly, stats, breakdown, leaderboard] = await Promise.all([
    fetchJson(`/api/ks/bankroll${p}`).catch(() => []),
    fetchJson(`/api/ks/monthly${p}`).catch(() => []),
    fetchJson(`/api/ks/weekly${p}`).catch(() => []),
    fetchJson(`/api/ks/stats${p}`).catch(() => null),
    fetchJson(`/api/ks/edge-breakdown${baseP}`).catch(() => null),
    fetchJson(`/api/ks/pitcher-leaderboard${baseP}`).catch(() => null),
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

  const ddPct   = s.max_drawdown_pct ? (Math.abs(s.max_drawdown_pct) * 100).toFixed(1) + '%' : '0%'
  const curDdPct = s.current_drawdown_pct ? (Math.abs(s.current_drawdown_pct) * 100).toFixed(1) + '%' : ''

  const cards = [
    { label: 'Total P&L',       val: (s.total_pnl >= 0 ? '+' : '') + fmt$(s.total_pnl), cls: s.total_pnl >= 0 ? 'good' : 'bad' },
    { label: 'ROI',             val: fmtPct(s.roi, 1), cls: s.roi >= 0 ? 'good' : 'bad' },
    { label: 'Win Rate',        val: fmtPct(s.win_rate), cls: s.win_rate >= 0.55 ? 'good' : s.win_rate >= 0.5 ? '' : 'bad' },
    { label: 'Avg Profit Per Bet', val: (s.ev_per_bet >= 0 ? '+' : '') + fmt$(s.ev_per_bet), cls: s.ev_per_bet >= 0 ? 'good' : 'bad', sub: `${(s.wins||0) + (s.losses||0)} settled` },
    { label: 'Biggest Losing Stretch', val: fmt$(s.max_drawdown), cls: 'bad', sub: ddPct + ' from peak' },
    { label: 'Current Dip',     val: s.current_drawdown < -0.01 ? fmt$(s.current_drawdown) : '$0', cls: s.current_drawdown < -0.01 ? 'bad' : 'good', sub: s.current_drawdown < -0.01 ? curDdPct + ' from peak' : 'No current dip' },
    { label: 'Winning Days',    val: fmtPct(s.winning_days_pct), cls: s.winning_days_pct >= 0.6 ? 'good' : s.winning_days_pct >= 0.5 ? '' : 'bad', sub: `${s.winning_days} of ${s.total_days} days` },
    { label: 'Total Wagered',   val: fmt$(s.total_wagered, true), cls: 'accent' },
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

  const totDays = bankroll.length
  const totWins = stats.wins || 0
  const totLoss = stats.losses || 0
  const totPnl  = stats.total_pnl || 0
  const totBets = totWins + totLoss
  const sWr     = totWins + totLoss > 0 ? totWins / (totWins + totLoss) : 0
  const sPnlDay = totDays > 0 ? totPnl / totDays : 0
  const sBpDay  = totDays > 0 ? totBets / totDays : 0

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
