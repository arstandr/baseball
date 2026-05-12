// public/app/views/pipeline.js — Pipeline tab: full slate view with per-pitcher detail.
import { esc } from '../utils.js'
import { fetchJson } from '../api.js'
import { renderPipelineSteps } from '../pipelineRender.js'

const ps = {
  date: null,
  dates: [],
  pitchers: [],
  selectedId: null,
  query: '',
}

const fs = { collapsed: false, date: null }

export async function refreshPipelineView() {
  if (!ps.date) ps.date = new Date().toLocaleDateString('en-CA')
  await Promise.all([loadDates(), loadSlate(), loadFeed(), loadCalibHistory(), loadPnlBySource(), loadClv(), loadAdminControls()])
  wirePipelineClicks()
  wireFeedToggle()
  if (ps.selectedId) await loadDetail(ps.selectedId)
}

async function loadCalibHistory() {
  const el = document.getElementById('pipeline-calib-history')
  if (!el) return
  try {
    const data = await fetchJson('/api/ks/calibration/runs?limit=8')
    const runs = data.rows ?? []
    if (!runs.length) {
      el.innerHTML = `<div class="muted" style="padding:12px">No calibration runs yet — first one fires Monday 3am ET.</div>`
      return
    }
    el.innerHTML = `
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead><tr style="color:var(--text-dim);text-align:left">
          <th style="padding:8px 0">Date</th>
          <th style="padding:8px;text-align:right">Resolved bets</th>
          <th style="padding:8px;text-align:right">Buckets updated</th>
          <th style="padding:8px;text-align:right">Pitchers scored</th>
          <th style="padding:8px;text-align:right">Sharpe Δ</th>
          <th style="padding:8px;text-align:right">Promoted</th>
          <th style="padding:8px;text-align:right">Status</th>
        </tr></thead>
        <tbody>
          ${runs.map(r => {
            const ago     = r.finished_at ? _fmtCalibAgo(r.finished_at) : r.started_at?.slice(0,10)
            const delta   = r.walkforward_delta_pct != null ? `${(r.walkforward_delta_pct * 100).toFixed(1)}%` : '—'
            const deltaCls = r.walkforward_delta_pct > 0 ? 'good' : r.walkforward_delta_pct < 0 ? 'bad' : ''
            const promoted = r.promoted ? '<span class="good">✅ Yes</span>' : '<span class="muted">No</span>'
            const statusCls = r.status === 'success' ? 'good' : r.status === 'skipped' ? '' : 'bad'
            return `<tr style="border-top:1px solid rgba(255,255,255,0.06)">
              <td style="padding:8px 0;font-weight:600">${ago}</td>
              <td style="padding:8px;text-align:right;color:var(--text-dim)">${r.n_resolved_bets ?? '—'}</td>
              <td style="padding:8px;text-align:right;color:var(--text-dim)">${r.buckets_updated ?? '—'}</td>
              <td style="padding:8px;text-align:right;color:var(--text-dim)">${r.pitchers_scored ?? '—'}</td>
              <td style="padding:8px;text-align:right" class="${deltaCls}">${delta}</td>
              <td style="padding:8px;text-align:right">${promoted}</td>
              <td style="padding:8px;text-align:right" class="${statusCls}">${r.status}</td>
            </tr>`
          }).join('')}
        </tbody>
      </table>`
  } catch {
    el.innerHTML = `<div class="muted" style="padding:12px">Unable to load calibration history.</div>`
  }
}

function _fmtCalibAgo(ts) {
  if (!ts) return '—'
  const d = new Date(ts.endsWith('Z') ? ts : ts + 'Z')
  return d.toLocaleDateString('en-CA') + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

// ── Feed ──────────────────────────────────────────────────────────────────────

async function loadFeed() {
  const date = ps.date || new Date().toLocaleDateString('en-CA')
  fs.date = date
  const dateEl  = document.getElementById('feed-date-label')
  const countEl = document.getElementById('feed-event-count')
  if (dateEl) dateEl.textContent = date
  try {
    const data = await fetchJson(`/api/ks/feed?date=${date}`)
    const events = data.events || []
    _renderFeedEvents(events)
    if (countEl) countEl.textContent = events.length ? `${events.length} events` : ''
    _updateFeedDot(events)
  } catch {
    const list = document.getElementById('feed-list')
    if (list) list.innerHTML = '<div class="feed-empty">Unable to load system events.</div>'
  }
}

function _renderFeedEvents(events) {
  const list = document.getElementById('feed-list')
  if (!list) return
  if (!events.length) {
    list.innerHTML = '<div class="feed-empty">No system events yet for this date. Events appear here as the pipeline runs every 10 minutes and games go live.</div>'
    return
  }
  list.innerHTML = events.map(ev => {
    const raw = ev.ts || ''
    const d   = raw ? new Date(raw.includes('T') ? raw : raw + 'T00:00:00Z') : null
    const ts  = d && !isNaN(d) ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'
    const cat = esc(ev.category || 'info')
    const badge     = esc(ev.badge || 'INFO')
    const headline  = esc(ev.headline || '—')
    const detail    = ev.detail ? `<div class="feed-event-detail">${esc(ev.detail)}</div>` : ''
    const pnlHtml   = ev.pnl != null
      ? `<div class="feed-event-pnl ${ev.pnl >= 0 ? 'good' : 'bad'}">${ev.pnl >= 0 ? '+' : ''}$${Math.abs(ev.pnl).toFixed(2)}</div>`
      : ''
    return `<div class="feed-event feed-event--${cat}">
      <div class="feed-event-left">
        <div class="feed-event-time">${ts}</div>
        <div class="feed-badge feed-badge--${cat}">${badge}</div>
        ${pnlHtml}
      </div>
      <div class="feed-event-right">
        <div class="feed-event-headline">${headline}</div>
        ${detail}
      </div>
    </div>`
  }).join('')
}

function _updateFeedDot(events) {
  const dot = document.getElementById('feed-live-dot')
  if (!dot) return
  const live = ['free_money', 'bet_placed', 'cover', 'pulled', 'edge_found', 'win', 'loss'].some(
    c => events.find(e => e.category === c)
  )
  dot.className = live ? 'feed-live-dot live' : 'feed-live-dot'
}

function wireFeedToggle() {
  const head = document.getElementById('feed-head')
  const card = document.getElementById('feed-card')
  if (!head || !card || head.dataset.wired) return
  head.dataset.wired = '1'
  head.addEventListener('click', () => {
    fs.collapsed = !fs.collapsed
    card.classList.toggle('collapsed', fs.collapsed)
    const btn = document.getElementById('feed-toggle-btn')
    if (btn) btn.textContent = fs.collapsed ? '▶' : '▼'
  })
}

export function onFeedUpdate() {
  const view = document.getElementById('view-pipeline')
  if (view && !view.hidden) loadFeed()
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
      ps.query = ''
      const input = document.getElementById('pipe-search')
      if (input) input.value = ''
      await Promise.all([loadSlate(), loadDates(), loadFeed()])
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

function renderRail() {
  const rail = document.getElementById('pipe-rail')
  if (!rail) return
  const q = ps.query.toLowerCase()
  const visible = q ? ps.pitchers.filter(p => p.pitcher_name.toLowerCase().includes(q)) : ps.pitchers
  if (!visible.length) {
    rail.innerHTML = `<div class="pipe-empty">${q ? 'No match.' : 'No pipeline data for this date.'}</div>`
    return
  }
  rail.innerHTML = visible.map(renderRailItem).join('')
  wireRailClicks()
}

async function loadSlate() {
  const rail = document.getElementById('pipe-rail')
  if (!rail) return
  try {
    const data = await fetchJson(`/api/ks/pipeline?date=${ps.date}`)
    ps.pitchers = data.pitchers || []
    renderRail()
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
  const input = document.getElementById('pipe-search')
  if (!input || input.dataset.wired) return
  input.dataset.wired = '1'
  input.addEventListener('input', () => {
    ps.query = input.value.trim()
    renderRail()
  })
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

// ── Item 3: P&L by Bet Source ─────────────────────────────────────────────────
async function loadPnlBySource() {
  const el = document.getElementById('pipeline-pnl-source')
  if (!el) return
  try {
    const rows = await fetchJson('/api/ks/pnl-by-source')
    if (!rows.length) {
      el.innerHTML = '<div class="muted" style="padding:12px">No settled bets yet.</div>'
      return
    }
    const SOURCE_LABEL = {
      pre_game:     'Pre-game',
      structural:   'Structural Live (pulled / blowout / dead-path)',
      probabilistic:'Probabilistic Live (high-conviction)',
      live_other:   'Live (other)',
    }
    el.innerHTML = `
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead><tr style="color:var(--text-dim);text-align:left">
          <th style="padding:8px 0">Source</th>
          <th style="padding:8px;text-align:right">Bets</th>
          <th style="padding:8px;text-align:right">W–L</th>
          <th style="padding:8px;text-align:right">Win%</th>
          <th style="padding:8px;text-align:right">P&amp;L</th>
          <th style="padding:8px;text-align:right">ROI</th>
          <th style="padding:8px;text-align:right">Avg Edge</th>
        </tr></thead>
        <tbody>
          ${rows.map(r => {
            const pnlCls  = r.pnl >= 0 ? 'good' : 'bad'
            const roiCls  = r.roi >= 0 ? 'good' : 'bad'
            const label   = SOURCE_LABEL[r.source] || r.source
            return `<tr style="border-top:1px solid rgba(255,255,255,0.06)">
              <td style="padding:8px 0;font-weight:600">${esc(label)}</td>
              <td style="padding:8px;text-align:right;color:var(--text-dim)">${r.bets}</td>
              <td style="padding:8px;text-align:right;color:var(--text-dim)">${r.wins}–${r.losses}</td>
              <td style="padding:8px;text-align:right">${(r.win_rate * 100).toFixed(1)}%</td>
              <td style="padding:8px;text-align:right" class="${pnlCls}">${r.pnl >= 0 ? '+' : ''}$${r.pnl.toFixed(2)}</td>
              <td style="padding:8px;text-align:right" class="${roiCls}">${(r.roi * 100).toFixed(1)}%</td>
              <td style="padding:8px;text-align:right;color:var(--text-dim)">${r.avg_edge != null ? (r.avg_edge * 100).toFixed(1) + '¢' : '—'}</td>
            </tr>`
          }).join('')}
        </tbody>
      </table>`
  } catch {
    el.innerHTML = '<div class="muted" style="padding:12px">Unable to load P&L by source.</div>'
  }
}

// ── Item 1: CLV (Closing Line Value) ─────────────────────────────────────────
async function loadClv() {
  const sumEl   = document.getElementById('pipeline-clv-summary')
  const tableEl = document.getElementById('pipeline-clv-table')
  if (!sumEl || !tableEl) return
  try {
    const data = await fetchJson('/api/ks/clv')
    const s = data.summary || {}
    const total = Number(s.total_with_clv || 0)
    if (!total) {
      sumEl.innerHTML   = '<div class="muted" style="padding:0 0 8px">CLV data will appear here once bets close (captured ~25min after game start).</div>'
      tableEl.innerHTML = ''
      return
    }
    const beats = Number(s.beats_close || 0)
    const pct   = total > 0 ? Math.round(beats / total * 100) : 0
    const avgClv = Number(s.avg_clv || 0)
    const avgClvCls = avgClv >= 0 ? 'good' : 'bad'
    sumEl.innerHTML = `
      <div style="display:flex;gap:24px;padding-bottom:12px;flex-wrap:wrap">
        <div><div style="font-size:11px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.05em">Avg CLV</div>
             <div class="${avgClvCls}" style="font-size:20px;font-weight:700">${avgClv >= 0 ? '+' : ''}${avgClv.toFixed(1)}¢</div></div>
        <div><div style="font-size:11px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.05em">Beat Close</div>
             <div style="font-size:20px;font-weight:700">${pct}% <span style="font-size:13px;color:var(--text-dim)">(${beats}/${total})</span></div></div>
        <div><div style="font-size:11px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.05em">Avg CLV Wins</div>
             <div class="good" style="font-size:16px;font-weight:600">${s.avg_clv_wins != null ? (Number(s.avg_clv_wins) >= 0 ? '+' : '') + Number(s.avg_clv_wins).toFixed(1) + '¢' : '—'}</div></div>
        <div><div style="font-size:11px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.05em">Avg CLV Losses</div>
             <div class="bad" style="font-size:16px;font-weight:600">${s.avg_clv_losses != null ? (Number(s.avg_clv_losses) >= 0 ? '+' : '') + Number(s.avg_clv_losses).toFixed(1) + '¢' : '—'}</div></div>
      </div>`
    if (!data.bets.length) { tableEl.innerHTML = ''; return }
    tableEl.innerHTML = `
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead><tr style="color:var(--text-dim);text-align:left">
          <th style="padding:6px 0">Date</th>
          <th style="padding:6px">Pitcher</th>
          <th style="padding:6px;text-align:right">Strike</th>
          <th style="padding:6px;text-align:right">Side</th>
          <th style="padding:6px;text-align:right">Fill</th>
          <th style="padding:6px;text-align:right">Close</th>
          <th style="padding:6px;text-align:right">CLV</th>
          <th style="padding:6px;text-align:right">Result</th>
        </tr></thead>
        <tbody>
          ${data.bets.slice(0, 50).map(b => {
            const clvCls = b.clv_cents > 0 ? 'good' : b.clv_cents < 0 ? 'bad' : ''
            const resCls = b.result === 'win' ? 'good' : b.result === 'loss' ? 'bad' : ''
            return `<tr style="border-top:1px solid rgba(255,255,255,0.06)">
              <td style="padding:6px 0;color:var(--text-dim)">${b.bet_date?.slice(5) ?? '—'}</td>
              <td style="padding:6px">${esc(b.pitcher_name)}</td>
              <td style="padding:6px;text-align:right">${b.strike}+</td>
              <td style="padding:6px;text-align:right">${b.side}</td>
              <td style="padding:6px;text-align:right;color:var(--text-dim)">${b.fill_price != null ? b.fill_price + '¢' : '—'}</td>
              <td style="padding:6px;text-align:right;color:var(--text-dim)">${b.closing_line_cents != null ? b.closing_line_cents + '¢' : '—'}</td>
              <td style="padding:6px;text-align:right" class="${clvCls}">${b.clv_cents != null ? (b.clv_cents > 0 ? '+' : '') + b.clv_cents + '¢' : '—'}</td>
              <td style="padding:6px;text-align:right" class="${resCls}">${b.result ?? '—'}</td>
            </tr>`
          }).join('')}
        </tbody>
      </table>`
  } catch {
    sumEl.innerHTML   = '<div class="muted" style="padding:12px">Unable to load CLV data.</div>'
    tableEl.innerHTML = ''
  }
}

// ── System Controls (halt / drawdown scale) ───────────────────────────────────
async function loadAdminControls() {
  const el = document.getElementById('pipeline-admin-controls')
  if (!el) return
  try {
    const status = await fetchJson('/api/admin/status')
    const halted  = status.trading_halted
    const ddScale = Number(status.drawdown_scale ?? 1.0)
    const haltCls = halted ? 'bad' : 'good'

    // ── Cage health (May 3 operational layer) ──
    const cage = status.cage || {}
    const strat = status.strategy || {}
    const caps  = status.caps || {}
    const fires = status.today?.fires_by_mode || []
    const fmtAge = s => {
      if (s == null || !Number.isFinite(s)) return '—'
      if (s < 90) return `${s}s ago`
      if (s < 3600) return `${Math.round(s/60)}m ago`
      return `${(s/3600).toFixed(1)}h ago`
    }
    const ageBad = (s, threshold) => Number.isFinite(s) && s > threshold

    const sH = cage.scheduler_heartbeat_age_s
    const lH = cage.liveMonitor_heartbeat_age_s
    const reconOk = cage.last_reconciliation_status === 'ok'

    // Simple roll-up: GREEN if everything ok, AMBER if degraded, RED if broken
    let railwayHealth = 'good', railwayLabel = '✅ HEALTHY'
    if (cage.kalshi_outage) { railwayHealth = 'bad'; railwayLabel = '⛔ KALSHI OUTAGE' }
    else if (ageBad(sH, 180)) { railwayHealth = 'bad'; railwayLabel = '⛔ SCHEDULER STALE' }
    else if (cage.last_reconciliation_status && cage.last_reconciliation_status !== 'ok') { railwayHealth = 'bad'; railwayLabel = '⛔ RECON MISMATCH' }
    else if (ageBad(sH, 90)) { railwayHealth = 'warn'; railwayLabel = '⚠ scheduler stale' }
    else if (ageBad(lH, 180) && !halted) { railwayHealth = 'warn'; railwayLabel = '⚠ liveMonitor down' }

    el.innerHTML = `
      <div style="display:flex;gap:24px;flex-wrap:wrap;align-items:flex-start;margin-bottom:18px">
        <div>
          <div style="font-size:11px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">Trading Status</div>
          <div class="${haltCls}" style="font-size:18px;font-weight:700;margin-bottom:10px">${halted ? '⛔ HALTED' : '✅ ACTIVE'}</div>
          <div style="display:flex;gap:8px">
            <button id="admin-halt-btn" class="filter-btn secondary" style="background:${halted ? '' : '#c0392b'};color:#fff" ${halted ? 'disabled' : ''}>Halt Trading</button>
            <button id="admin-resume-btn" class="filter-btn secondary" style="background:${halted ? '#27ae60' : ''};color:#fff" ${halted ? '' : 'disabled'}>Resume Trading</button>
          </div>
        </div>
        <div>
          <div style="font-size:11px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">Railway Production</div>
          <div class="${railwayHealth === 'bad' ? 'bad' : railwayHealth === 'warn' ? '' : 'good'}" style="font-size:18px;font-weight:700;margin-bottom:6px;color:${railwayHealth === 'warn' ? '#d4a017' : ''}">${railwayLabel}</div>
          <div style="font-size:11px;color:var(--text-dim);line-height:1.5">
            scheduler ${fmtAge(sH)} · liveMonitor ${fmtAge(lH)}<br>
            recon ${reconOk ? '✓' : '✗'} ${cage.last_reconciliation_at ? cage.last_reconciliation_at.slice(11,16)+'Z' : '—'}<br>
            commit ${String(status.commit_sha ?? '?').slice(0,8)}
          </div>
        </div>
        <div>
          <div style="font-size:11px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">Drawdown Scale</div>
          <div class="${ddScale < 1 ? 'bad' : 'good'}" style="font-size:18px;font-weight:700">${ddScale}×</div>
          <div style="font-size:11px;color:var(--text-dim);margin-top:4px">Auto-set from 7-day P&amp;L</div>
        </div>
      </div>

      <div style="display:flex;gap:24px;flex-wrap:wrap;border-top:1px solid var(--border);padding-top:14px">
        <div style="min-width:160px">
          <div style="font-size:11px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">Strategy Posture</div>
          <div style="font-size:13px;line-height:1.7">
            <div>Oracle stage: <b>${strat.oracle_stage ?? '?'}</b></div>
            <div>Inversion: ${strat.invert_yes_to_no ? '<b class="good">on</b>' : 'off'}</div>
            <div>Tier 1: ${strat.tier1_enabled ? '<b class="good">on</b>' : 'off'}</div>
            <div>Tier 2: ${strat.tier2_enabled ? '<b class="good">on</b>' : 'off'}</div>
            <div>Tier 3: ${strat.tier3_enabled ? '<b class="good">on</b>' : 'off'}</div>
            ${strat.kalshi_paper_mode ? '<div class="warn">⚠ paper mode</div>' : ''}
          </div>
        </div>
        <div style="min-width:160px">
          <div style="font-size:11px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">Caps (per user)</div>
          <div style="font-size:13px;line-height:1.7">
            <div>Inversion daily: <b>$${caps.invert_daily}</b></div>
            <div>Live daily: <b>$${caps.live_daily}</b></div>
            <div>Per-pitcher inv: <b>$${caps.max_invert_per_pitcher}</b></div>
            <div>Per-pitcher live: <b>$${caps.max_live_per_pitcher}</b></div>
            <div>Global daily: <b>$${caps.global_daily}</b></div>
          </div>
        </div>
        <div style="min-width:200px">
          <div style="font-size:11px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">Today's Fires (real)</div>
          ${fires.length === 0
            ? '<div style="font-size:13px;color:var(--text-dim)">No real fires today</div>'
            : '<div style="font-size:13px;line-height:1.7">'+fires.map(f => `<div>${f.strategy_mode}: <b>${f.n}</b> @ $${(f.risk||0).toFixed(0)} risk · pnl ${(f.pnl||0)>=0?'+':''}$${(f.pnl||0).toFixed(0)}</div>`).join('')+'</div>'}
        </div>
      </div>`
    document.getElementById('admin-halt-btn')?.addEventListener('click', async () => {
      if (!confirm('Halt all trading? No new bets will be placed until you resume.')) return
      try {
        await fetchJson('/api/admin/halt', { method: 'POST' })
        await loadAdminControls()
      } catch (err) {
        alert('Failed to halt: ' + err.message)
      }
    })
    document.getElementById('admin-resume-btn')?.addEventListener('click', async () => {
      try {
        await fetchJson('/api/admin/resume', { method: 'POST' })
        await loadAdminControls()
      } catch (err) {
        alert('Failed to resume: ' + err.message)
      }
    })
  } catch {
    el.innerHTML = '<div class="muted">Unable to load system status (admin access required).</div>'
  }
}
