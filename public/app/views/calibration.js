import { fetchJson } from '../api.js'
import { fmt$ } from '../utils.js'

export async function refreshCalibrationView() {
  const [curve, edge, topPitchers, botPitchers, runs, snapStats] = await Promise.all([
    fetchJson('/api/ks/calibration/curve').catch(() => null),
    fetchJson('/api/ks/calibration/edge').catch(() => null),
    fetchJson('/api/ks/calibration/pitchers?direction=top&limit=10').catch(() => null),
    fetchJson('/api/ks/calibration/pitchers?direction=bottom&limit=5').catch(() => null),
    fetchJson('/api/ks/calibration/runs?limit=1').catch(() => null),
    fetchJson('/api/ks/snapshots/stats').catch(() => null),
  ])

  renderCalibCurve(curve?.rows ?? [])
  renderEdgeChart(edge?.rows ?? [])
  renderPitcherTable(topPitchers?.rows ?? [], botPitchers?.rows ?? [])
  renderLastRun(runs?.rows?.[0] ?? null)
  renderSnapshotStats(snapStats)
  wireButtons()
}

// ── Calibration curve ─────────────────────────────────────────────────────────

function renderCalibCurve(rows) {
  const canvas = document.getElementById('calib-curve-chart')
  const empty  = document.getElementById('calib-curve-empty')
  if (!canvas) return
  if (!rows.length) { canvas.style.display = 'none'; if (empty) empty.style.display = ''; return }
  if (empty) empty.style.display = 'none'
  canvas.style.display = ''

  const ctx = canvas.getContext('2d')
  const W = canvas.width = canvas.offsetWidth || 400
  const H = canvas.height = 220
  ctx.clearRect(0, 0, W, H)

  const pad = { l: 40, r: 16, t: 16, b: 32 }
  const cw  = W - pad.l - pad.r
  const ch  = H - pad.t - pad.b

  // Grid
  ctx.strokeStyle = 'rgba(255,255,255,0.08)'
  ctx.lineWidth = 1
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + ch * (1 - i / 4)
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + cw, y); ctx.stroke()
    ctx.fillStyle = 'rgba(255,255,255,0.4)'
    ctx.font = '10px var(--mono)'
    ctx.textAlign = 'right'
    ctx.fillText(`${i * 25}%`, pad.l - 4, y + 4)
  }

  // Perfect calibration line
  ctx.strokeStyle = 'rgba(255,255,255,0.2)'
  ctx.setLineDash([4, 4])
  ctx.beginPath()
  ctx.moveTo(pad.l, pad.t + ch)
  ctx.lineTo(pad.l + cw, pad.t)
  ctx.stroke()
  ctx.setLineDash([])

  // Actual calibration
  const xs = rows.map(r => pad.l + (r.predicted - 0.5) / 0.5 * cw)
  const ys = rows.map(r => pad.t + ch - r.actual * ch)

  ctx.strokeStyle = '#4ade80'
  ctx.lineWidth = 2
  ctx.beginPath()
  xs.forEach((x, i) => i === 0 ? ctx.moveTo(x, ys[i]) : ctx.lineTo(x, ys[i]))
  ctx.stroke()

  // Dots + CI
  rows.forEach((r, i) => {
    if (r.ci_low != null && r.ci_high != null) {
      const yLo = pad.t + ch - r.ci_high * ch
      const yHi = pad.t + ch - r.ci_low  * ch
      ctx.fillStyle = 'rgba(74,222,128,0.15)'
      ctx.fillRect(xs[i] - 6, yLo, 12, yHi - yLo)
    }
    ctx.fillStyle = '#4ade80'
    ctx.beginPath()
    ctx.arc(xs[i], ys[i], 4, 0, Math.PI * 2)
    ctx.fill()

    ctx.fillStyle = 'rgba(255,255,255,0.5)'
    ctx.font = '9px var(--mono)'
    ctx.textAlign = 'center'
    ctx.fillText(`n=${r.sample_size}`, xs[i], ys[i] - 7)
  })

  // X axis labels
  ctx.fillStyle = 'rgba(255,255,255,0.4)'
  ctx.font = '10px var(--mono)'
  ctx.textAlign = 'center'
  for (let v = 50; v <= 95; v += 10) {
    const x = pad.l + (v / 100 - 0.5) / 0.5 * cw
    ctx.fillText(`${v}%`, x, H - 4)
  }
}

// ── Edge quality chart ────────────────────────────────────────────────────────

function renderEdgeChart(rows) {
  const canvas = document.getElementById('edge-quality-chart')
  const empty  = document.getElementById('edge-quality-empty')
  if (!canvas) return
  if (!rows.length) { canvas.style.display = 'none'; if (empty) empty.style.display = ''; return }
  if (empty) empty.style.display = 'none'
  canvas.style.display = ''

  const ctx = canvas.getContext('2d')
  const W   = canvas.width = canvas.offsetWidth || 400
  const H   = canvas.height = 220
  ctx.clearRect(0, 0, W, H)

  const pad  = { l: 44, r: 16, t: 16, b: 32 }
  const cw   = W - pad.l - pad.r
  const ch   = H - pad.t - pad.b
  const bw   = rows.length > 0 ? Math.max(4, (cw / rows.length) * 0.7) : 20

  const allRoi = rows.map(r => r.actual_roi ?? 0)
  const maxRoi = Math.max(...allRoi.map(Math.abs), 0.05)

  // Zero line
  const zeroY = pad.t + ch / 2
  ctx.strokeStyle = 'rgba(255,255,255,0.3)'
  ctx.lineWidth = 1
  ctx.beginPath(); ctx.moveTo(pad.l, zeroY); ctx.lineTo(pad.l + cw, zeroY); ctx.stroke()

  rows.forEach((r, i) => {
    const x   = pad.l + i * (cw / rows.length) + (cw / rows.length - bw) / 2
    const roi = r.actual_roi ?? 0
    const h   = Math.min(ch / 2, Math.abs(roi / maxRoi) * (ch / 2))
    const y   = roi >= 0 ? zeroY - h : zeroY
    ctx.fillStyle = roi >= 0 ? 'rgba(74,222,128,0.8)' : 'rgba(248,113,113,0.8)'
    ctx.fillRect(x, y, bw, h)

    ctx.fillStyle = 'rgba(255,255,255,0.5)'
    ctx.font = '9px var(--mono)'
    ctx.textAlign = 'center'
    ctx.fillText(`${(r.bucket_lo * 100).toFixed(0)}¢`, x + bw / 2, H - 4)
    ctx.fillText(`n=${r.sample_size}`, x + bw / 2, roi >= 0 ? y - 4 : y + h + 12)
  })

  // Y labels
  ctx.fillStyle = 'rgba(255,255,255,0.4)'
  ctx.font = '10px var(--mono)'
  ctx.textAlign = 'right'
  ctx.fillText(`+${(maxRoi * 100).toFixed(0)}%`, pad.l - 4, pad.t + 12)
  ctx.fillText(`0%`, pad.l - 4, zeroY + 4)
  ctx.fillText(`-${(maxRoi * 100).toFixed(0)}%`, pad.l - 4, H - pad.b - 4)
}

// ── Pitcher reliability table ─────────────────────────────────────────────────

function renderPitcherTable(top, bottom) {
  const el = document.getElementById('pitcher-reliability-table')
  if (!el) return

  const all = [
    ...top.map(p => ({ ...p, tier: 'top' })),
    ...bottom.map(p => ({ ...p, tier: 'bottom' })),
  ]

  if (!all.length) {
    el.innerHTML = `<div class="muted" style="padding:16px">Needs 10+ resolved bets per pitcher.</div>`
    return
  }

  el.innerHTML = `
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead><tr style="color:var(--text-dim);text-align:left">
        <th style="padding:6px 0">Pitcher</th>
        <th style="padding:6px;text-align:right">Bets</th>
        <th style="padding:6px;text-align:right">Actual ROI</th>
        <th style="padding:6px;text-align:right">Expected</th>
        <th style="padding:6px;text-align:right">Reliability</th>
      </tr></thead>
      <tbody>
        ${all.map(p => {
          const relCls = p.reliability >= 1.1 ? 'good' : p.reliability < 0.7 ? 'bad' : ''
          const roiStr = p.actual_roi != null ? `${(p.actual_roi * 100).toFixed(1)}%` : '—'
          const expStr = p.expected_roi != null ? `${(p.expected_roi * 100).toFixed(1)}%` : '—'
          return `<tr style="border-top:1px solid rgba(255,255,255,0.06)">
            <td style="padding:6px 0;font-weight:600">${p.pitcher_name ?? p.pitcher_id}</td>
            <td style="padding:6px;text-align:right;color:var(--text-dim)">${p.n_bets}</td>
            <td style="padding:6px;text-align:right" class="${roiStr.startsWith('-') ? 'bad' : 'good'}">${roiStr}</td>
            <td style="padding:6px;text-align:right;color:var(--text-dim)">${expStr}</td>
            <td style="padding:6px;text-align:right" class="${relCls}">${p.reliability?.toFixed(2) ?? '—'}×</td>
          </tr>`
        }).join('')}
      </tbody>
    </table>`
}

// ── Last calibration run ──────────────────────────────────────────────────────

function renderLastRun(run) {
  const el = document.getElementById('calib-last-run')
  if (!el) return
  if (!run) {
    el.innerHTML = `<div class="muted">No calibration run yet.</div>`
    return
  }
  const ago = run.finished_at ? _fmtAgo(run.finished_at) : null
  const promoted = run.promoted ? '✅ Promoted' : '⏸ Not promoted'
  el.innerHTML = `
    <div style="font-size:13px;line-height:1.8">
      <div><span class="muted">Last run:</span> ${ago ?? run.started_at}</div>
      <div><span class="muted">Status:</span> ${run.status} · ${promoted}</div>
      <div><span class="muted">Resolved bets:</span> ${run.n_resolved_bets ?? '—'}</div>
      <div><span class="muted">Buckets updated:</span> ${run.buckets_updated ?? '—'}</div>
      <div><span class="muted">Pitchers scored:</span> ${run.pitchers_scored ?? '—'}</div>
      ${run.walkforward_delta_pct != null ? `<div><span class="muted">Sharpe delta:</span> ${(run.walkforward_delta_pct * 100).toFixed(1)}%</div>` : ''}
    </div>`
}

// ── Snapshot stats ────────────────────────────────────────────────────────────

function renderSnapshotStats(stats) {
  const el = document.getElementById('snapshot-stats')
  if (!el || !stats) return
  const pct = stats.total > 0 ? Math.round((stats.resolved / stats.total) * 100) : 0
  el.innerHTML = `
    <div class="stat-box"><div class="stat-val">${stats.total.toLocaleString()}</div><div class="stat-label">Total snapshots</div></div>
    <div class="stat-box"><div class="stat-val">${stats.resolved.toLocaleString()}</div><div class="stat-label">Resolved (${pct}%)</div></div>
    <div class="stat-box"><div class="stat-val">${stats.recent.toLocaleString()}</div><div class="stat-label">Last 7 days</div></div>`
}

// ── Button wiring ─────────────────────────────────────────────────────────────

function wireButtons() {
  const btnCalib = document.getElementById('btn-run-calib')
  if (btnCalib && !btnCalib._wired) {
    btnCalib._wired = true
    btnCalib.addEventListener('click', async () => {
      btnCalib.disabled = true
      btnCalib.textContent = 'Running…'
      try {
        const res = await fetch('/api/ks/calibration/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        const data = await res.json()
        btnCalib.textContent = data.promoted ? '✅ Promoted' : '⏸ Done (not promoted)'
        await refreshCalibrationView()
      } catch { btnCalib.textContent = '❌ Error' }
      setTimeout(() => { btnCalib.textContent = 'Run calibration now'; btnCalib.disabled = false }, 3000)
    })
  }

  const form    = document.getElementById('backtest-form')
  const btnBack = document.getElementById('btn-run-backtest')
  const status  = document.getElementById('backtest-status')
  const results = document.getElementById('backtest-results')
  if (btnBack && !btnBack._wired) {
    btnBack._wired = true
    btnBack.addEventListener('click', async () => {
      if (!form) return
      const fd = new FormData(form)
      const config = {
        dateStart:        fd.get('dateStart') || null,
        dateEnd:          fd.get('dateEnd')   || null,
        minEdge:          parseFloat(fd.get('minEdge')) / 100,
        kellyFraction:    parseFloat(fd.get('kellyFraction')),
        maxPctBankroll:   parseFloat(fd.get('maxPctBankroll')) / 100,
        startingBankroll: parseFloat(fd.get('startingBankroll')),
        sidesAllowed:     fd.get('sidesAllowed'),
        gameStatusFilter: fd.get('gameStatusFilter'),
        useCalibration:   fd.get('useCalibration') === 'true',
        label:            fd.get('label') || null,
      }
      if (!config.dateStart || !config.dateEnd) { if (status) status.textContent = 'Set a date range first.'; return }
      btnBack.disabled = true
      if (status) status.textContent = 'Running…'
      try {
        const res  = await fetch('/api/ks/backtest/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config) })
        const data = await res.json()
        if (status) status.textContent = ''
        renderBacktestResults(results, data)
      } catch (err) {
        if (status) status.textContent = `Error: ${err.message}`
      }
      btnBack.disabled = false
    })
  }
}

function renderBacktestResults(el, data) {
  if (!el) return
  if (data.message) { el.innerHTML = `<div class="muted">${data.message}</div>`; return }

  const sign = v => v >= 0 ? '+' : ''
  const roiPct = v => `${(v * 100).toFixed(2)}%`

  el.innerHTML = `
    <div style="display:flex;gap:24px;flex-wrap:wrap;margin-bottom:16px">
      <div class="stat-box"><div class="stat-val ${data.totalPnl >= 0 ? 'good' : 'bad'}">${sign(data.totalPnl)}${fmt$(data.totalPnl)}</div><div class="stat-label">Total P&L</div></div>
      <div class="stat-box"><div class="stat-val">${data.totalBets}</div><div class="stat-label">Bets</div></div>
      <div class="stat-box"><div class="stat-val">${(data.winRate * 100).toFixed(1)}%</div><div class="stat-label">Win rate</div></div>
      <div class="stat-box"><div class="stat-val ${data.roi >= 0 ? 'good' : 'bad'}">${sign(data.roi)}${roiPct(data.roi)}</div><div class="stat-label">ROI</div></div>
      <div class="stat-box"><div class="stat-val">${data.sharpe?.toFixed(2)}</div><div class="stat-label">Daily Sharpe</div></div>
      <div class="stat-box"><div class="stat-val bad">-${fmt$(data.maxDrawdown)}</div><div class="stat-label">Max drawdown</div></div>
    </div>
    ${data.comparison ? `<div style="font-size:12px;color:var(--text-dim);margin-bottom:16px">
      Sim bets: ${data.comparison.simBets} · Real bets: ${data.comparison.realBets} · Overlap: ${data.comparison.overlap} ·
      Sim P&L on overlap: ${sign(data.comparison.realPnl)}${fmt$(data.comparison.realPnl)}
    </div>` : ''}
    <div style="overflow-x:auto">
      <table style="width:100%;border-collapse:collapse;font-size:12px;margin-top:8px">
        <thead><tr style="color:var(--text-dim)">
          <th style="text-align:left;padding:4px">Strike</th>
          <th style="text-align:right;padding:4px">Bets</th>
          <th style="text-align:right;padding:4px">Win%</th>
          <th style="text-align:right;padding:4px">ROI</th>
          <th style="text-align:right;padding:4px">P&L</th>
        </tr></thead>
        <tbody>
          ${(data.perStrike ?? []).map(s => `<tr style="border-top:1px solid rgba(255,255,255,0.05)">
            <td style="padding:4px">${s.strike}+K</td>
            <td style="text-align:right;padding:4px;color:var(--text-dim)">${s.bets}</td>
            <td style="text-align:right;padding:4px">${(s.winRate * 100).toFixed(1)}%</td>
            <td style="text-align:right;padding:4px" class="${s.roi >= 0 ? 'good' : 'bad'}">${sign(s.roi)}${roiPct(s.roi)}</td>
            <td style="text-align:right;padding:4px" class="${s.pnl >= 0 ? 'good' : 'bad'}">${sign(s.pnl)}${fmt$(s.pnl)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`
}

function _fmtAgo(ts) {
  if (!ts) return null
  const diffMin = Math.round((Date.now() - new Date(ts.endsWith('Z') ? ts : ts + 'Z').getTime()) / 60000)
  return diffMin < 2 ? 'just now' : diffMin < 60 ? `${diffMin}m ago` : diffMin < 1440 ? `${Math.round(diffMin/60)}h ago` : `${Math.round(diffMin/1440)}d ago`
}
