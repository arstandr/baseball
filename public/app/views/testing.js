import { fmtDateFull, esc } from '../utils.js'
import { fetchJson } from '../api.js'

export async function refreshTestingView() {
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

  const notesPanel = document.getElementById('model-notes-panel')
  const notesList  = document.getElementById('model-notes-list')
  if (notesPanel && notesList && data.model_notes?.length) {
    notesPanel.style.display = ''
    notesList.innerHTML = data.model_notes.map(n =>
      `<div class="model-note model-note--${n.level}">${n.text}</div>`
    ).join('')
  }

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
