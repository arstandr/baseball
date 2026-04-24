import { state } from '../state.js'
import { fmt$, esc } from '../utils.js'
import { fetchJson } from '../api.js'

export async function refreshLogView() {
  wireLogFilters()
  await loadBets()
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

    const face    = b.bet_size != null ? Number(b.bet_size) : null
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
