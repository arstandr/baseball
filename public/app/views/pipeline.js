// public/app/views/pipeline.js — Pipeline tab: full slate view with per-pitcher detail.
import { esc } from '../utils.js'
import { fetchJson } from '../api.js'
import { renderPipelineSteps } from '../pipelineRender.js'

const ps = {
  date: null,
  dates: [],
  pitchers: [],
  selectedId: null,
}

export async function refreshPipelineView() {
  if (!ps.date) ps.date = new Date().toLocaleDateString('en-CA')
  await Promise.all([loadDates(), loadSlate()])
  wirePipelineClicks()
  if (ps.selectedId) await loadDetail(ps.selectedId)
}

async function loadDates() {
  try {
    const data = await fetchJson('/api/ks/pipeline/dates')
    ps.dates = data.dates || []
    renderDateBar()
  } catch { /* ignore */ }
}

function renderDateBar() {
  const bar = document.getElementById('pipe-date-bar')
  if (!bar) return
  if (!ps.dates.length) { bar.innerHTML = '<span class="muted">No pipeline data yet.</span>'; return }
  bar.innerHTML = ps.dates.slice(0, 14).map(d =>
    `<button class="pipe-date-pill ${d.date === ps.date ? 'active' : ''}" data-date="${d.date}">${d.date.slice(5)} <span class="pipe-date-n">${d.n}</span></button>`
  ).join('')
  bar.querySelectorAll('.pipe-date-pill').forEach(btn => {
    btn.addEventListener('click', async () => {
      ps.date = btn.dataset.date
      ps.selectedId = null
      await Promise.all([loadSlate(), loadDates()])
    })
  })
}

function statusIcon(p) {
  if (p.outcome?.wins > 0 && p.outcome?.losses === 0)   return { cls: 'pipe-dot-won',            label: 'Won' }
  if (p.outcome?.losses > 0 && p.outcome?.wins === 0)   return { cls: 'pipe-dot-lost',           label: 'Lost' }
  if (p.outcome?.wins > 0 && p.outcome?.losses > 0)     return { cls: 'pipe-dot-pending',        label: 'Split' }
  if (p.n_bets_logged > 0 && !p.outcome)                return { cls: 'pipe-dot-pending',        label: 'Pending' }
  if (p.final_action === 'preflight_skip')               return { cls: 'pipe-dot-skip-preflight', label: 'Preflight skip' }
  if (p.final_action === 'filtered_out')                 return { cls: 'pipe-dot-skip-rule',      label: 'Rule skip' }
  if (p.final_action === 'no_edge')                      return { cls: 'pipe-dot-no-edge',        label: 'No edge' }
  if (p.final_action === 'no_markets')                   return { cls: 'pipe-dot-no-markets',     label: 'No markets' }
  if (p.final_action === 'error')                        return { cls: 'pipe-dot-error',          label: 'Error' }
  return { cls: 'pipe-dot-unknown', label: 'Processed' }
}

function renderRailItem(p) {
  const ic      = statusIcon(p)
  const edgeTxt = p.best_edge != null ? (p.best_edge * 100).toFixed(1) + '¢' : '—'
  const timeTxt = p.game_time ? new Date(p.game_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''
  const pnlTxt  = p.outcome?.pnl != null ? (p.outcome.pnl >= 0 ? '+' : '') + '$' + Math.abs(p.outcome.pnl).toFixed(2) : ''
  return `<div class="pipe-rail-item ${ps.selectedId === String(p.pitcher_id) ? 'active' : ''}" data-pitcher-id="${p.pitcher_id}">
    <span class="pipe-dot ${ic.cls}" title="${ic.label}"></span>
    <div class="pipe-rail-main">
      <div class="pipe-rail-name">${esc(p.pitcher_name)}</div>
      <div class="pipe-rail-meta">${esc(p.game_label || '')}${timeTxt ? ' · ' + timeTxt : ''}${p.lambda != null ? ' · λ=' + p.lambda.toFixed(2) : ''}${edgeTxt !== '—' ? ' · ' + edgeTxt : ''}</div>
    </div>
    <div class="pipe-rail-right">${pnlTxt ? `<span class="pipe-rail-pnl ${p.outcome?.pnl >= 0 ? 'good' : 'bad'}">${pnlTxt}</span>` : `<span class="pipe-rail-badge">${p.n_bets_logged || 0}</span>`}</div>
  </div>`
}

async function loadSlate() {
  const rail = document.getElementById('pipe-rail')
  if (!rail) return
  try {
    const data = await fetchJson(`/api/ks/pipeline?date=${ps.date}`)
    ps.pitchers = data.pitchers || []
    if (!ps.pitchers.length) {
      rail.innerHTML = '<div class="pipe-empty">No pipeline data for this date.</div>'
      return
    }
    rail.innerHTML = ps.pitchers.map(renderRailItem).join('')
    wireRailClicks()
  } catch {
    rail.innerHTML = '<div class="pipe-empty muted">Failed to load slate.</div>'
  }
}

function wireRailClicks() {
  const rail = document.getElementById('pipe-rail')
  if (!rail || rail.dataset.clickWired) return
  rail.dataset.clickWired = '1'
  rail.addEventListener('click', async e => {
    const item = e.target.closest('.pipe-rail-item[data-pitcher-id]')
    if (!item) return
    const pid = item.dataset.pitcherId
    ps.selectedId = pid
    rail.querySelectorAll('.pipe-rail-item').forEach(el => el.classList.toggle('active', el.dataset.pitcherId === pid))
    await loadDetail(pid)
  })
}

function wirePipelineClicks() {
  // date bar re-wiring happens in renderDateBar — nothing else to wire globally
}

async function loadDetail(pitcherId) {
  const detail = document.getElementById('pipe-detail')
  if (!detail) return
  detail.innerHTML = '<div class="pipe-detail-loading">Loading…</div>'
  try {
    const data = await fetchJson(`/api/ks/pipeline/${ps.date}/${pitcherId}`)
    const p = ps.pitchers.find(x => String(x.pitcher_id) === String(pitcherId))
    const gameTime = data.game_time ? new Date(data.game_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''
    detail.innerHTML = `
      <div class="pipe-detail-header">
        <div class="pipe-detail-pitcher">${esc(data.pitcher_name || '—')}</div>
        <div class="pipe-detail-meta">${esc(data.game_label || '')}${gameTime ? ' · ' + gameTime : ''} · ${data.bet_date || ''}</div>
      </div>
      <div class="pipe-detail-steps">${renderPipelineSteps(data)}</div>`
  } catch {
    detail.innerHTML = '<div class="pipe-detail-empty muted">Pipeline data not available for this pitcher.</div>'
  }
}
