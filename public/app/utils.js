// Always returns today's date in ET, never UTC.
// Prevents $0 P&L bug that occurs after 8 PM ET when UTC flips to tomorrow.
export function todayET() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
}

export function fmtAgo(ts) {
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

export function fmt$(n, noSign = false) {
  if (n == null || Number.isNaN(n)) return '$—'
  const v = Number(n)
  const abs = Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  if (noSign) return '$' + abs
  return (v < 0 ? '-$' : '$') + abs
}

export function fmtPct(n, dp = 1) {
  if (n == null || Number.isNaN(n)) return '—'
  return (n * 100).toFixed(dp) + '%'
}

export function fmtTs(iso) {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
  } catch { return '' }
}

export function fmtDatePill(d) {
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

export function fmtDateFull(d) {
  if (!d) return '—'
  try {
    return new Date(d + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
  } catch { return d }
}

export function fmtGameTime(utc) {
  if (!utc) return ''
  try {
    return new Date(utc).toLocaleTimeString('en-US', {
      hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York', hour12: true,
    }) + ' ET'
  } catch { return '' }
}

export function esc(s) {
  if (s == null) return ''
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]))
}

export function setText(id, text) {
  const el = document.getElementById(id)
  if (!el) return
  el.classList.remove('skel')
  el.textContent = text
}

export function setHtml(id, html) {
  const el = document.getElementById(id)
  if (!el) return
  el.classList.remove('skel')
  el.innerHTML = html
}

export function setDelta(id, val) {
  const el = document.getElementById(id)
  if (!el) return
  el.classList.remove('skel')
  const v = Number(val || 0)
  el.className = v > 0 ? 'good' : v < 0 ? 'bad' : 'muted'
  el.textContent = (v >= 0 ? '+' : '') + fmt$(v)
}

// ── Poisson probability helpers ───────────────────────────────────────────

export function poissonCDF(k, lambda) {
  if (lambda <= 0) return k >= 0 ? 1 : 0
  let cdf = 0, term = Math.exp(-lambda)
  for (let i = 0; i <= Math.floor(k); i++) {
    cdf += term
    term *= lambda / (i + 1)
  }
  return Math.min(1, cdf)
}

export function probAtLeast(needed, remainLambda) {
  if (needed <= 0) return 1
  return 1 - poissonCDF(needed - 1, remainLambda)
}

export function remainingLambda(ks, ip, pitches) {
  if (ip <= 0 || pitches <= 0) return null
  const kPerIp         = ks / ip
  const pitchPerIp     = pitches / ip
  const AVG_PITCH_LIMIT = 95
  const remainIp       = Math.max(0, AVG_PITCH_LIMIT - pitches) / pitchPerIp
  return kPerIp * remainIp
}

// ── Bet financials / coverage helpers ────────────────────────────────────

export function calcBetFinancials(b) {
  const FEE = 0.07
  const hasFill = b.filled_contracts > 0 && b.fill_price != null
  let winProfit, cost
  if (hasFill) {
    const yp = b.fill_price / 100
    const wf = b.side === 'YES' ? (1 - yp) : yp
    winProfit = b.filled_contracts * wf * (1 - FEE)
    cost      = b.filled_contracts * (b.side === 'YES' ? yp : (1 - yp))
  } else {
    const mid = b.market_mid != null ? Number(b.market_mid) / 100 : 0.5
    const hs  = (b.spread ?? 4) / 200
    const ff  = b.side === 'YES' ? (mid + hs) : ((1 - mid) + hs)
    winProfit = (b.bet_size ?? 0) * (1 - ff) * (1 - FEE)
    cost      = (b.bet_size ?? 0) * ff
  }
  return { winProfit: Math.max(0, winProfit), cost: Math.max(0, cost) }
}

export function liveCoverProb(b, live) {
  if (b.result === 'win') return 1
  if (b.result === 'loss') return 0
  if (!live) return b.side === 'NO' ? 1 - (b.model_prob ?? 0.5) : (b.model_prob ?? 0.5)
  const ks = live.ks ?? 0
  if (live.is_final || live.still_in === false)
    return b.side === 'YES' ? (ks >= b.strike ? 1 : 0) : (ks < b.strike ? 1 : 0)
  if (live.ip > 0 && live.pitches > 0 && (ks > 0 || live.ip >= 2)) {
    const remLam = remainingLambda(ks, live.ip, live.pitches)
    if (remLam != null) {
      if (b.side === 'YES') return b.strike - ks <= 0 ? 1 : probAtLeast(b.strike - ks, remLam)
      return poissonCDF(b.strike - ks - 1, remLam)
    }
  }
  return b.side === 'NO' ? 1 - (b.model_prob ?? 0.5) : (b.model_prob ?? 0.5)
}

// ── Sparkline ────────────────────────────────────────────────────────────

export function renderSparkline(el, candles, { fillPrice, result, side } = {}) {
  const W = 200, H = 40, PAD = 4
  const pts = candles.filter(c => c.mid != null)
  if (pts.length < 2) { el.innerHTML = ''; return }

  const minTs = pts[0].ts, maxTs = pts[pts.length - 1].ts
  const tsRange = maxTs - minTs || 1

  const toX = ts => PAD + ((ts - minTs) / tsRange) * (W - PAD * 2)
  const toY = v  => H - PAD - ((v / 100) * (H - PAD * 2))

  const polyPts  = pts.map(c => `${toX(c.ts).toFixed(1)},${toY(c.mid).toFixed(1)}`).join(' ')
  const lastPt   = pts[pts.length - 1]
  const areaPath = `M${toX(pts[0].ts).toFixed(1)},${toY(pts[0].mid).toFixed(1)} ` +
    pts.slice(1).map(c => `L${toX(c.ts).toFixed(1)},${toY(c.mid).toFixed(1)}`).join(' ') +
    ` L${toX(lastPt.ts).toFixed(1)},${(H - PAD).toFixed(1)} L${toX(pts[0].ts).toFixed(1)},${(H - PAD).toFixed(1)} Z`

  const lineColor = result === 'win' ? '#22c55e' : result === 'loss' ? '#ef4444' : '#60a5fa'

  let markers = ''
  if (fillPrice != null) {
    const fx = toX(pts[0].ts), fy = toY(fillPrice)
    markers += `<circle cx="${fx.toFixed(1)}" cy="${fy.toFixed(1)}" r="3" fill="white" stroke="${lineColor}" stroke-width="1.5"/>`
  }
  if (result) {
    const settleY = toY(result === 'win' ? (side === 'YES' ? 100 : 0) : (side === 'YES' ? 0 : 100))
    markers += `<circle cx="${toX(lastPt.ts).toFixed(1)}" cy="${settleY.toFixed(1)}" r="3" fill="${lineColor}" stroke="none"/>`
  }

  el.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="display:block;width:100%;height:${H}px">
      <path d="${areaPath}" fill="${lineColor}" fill-opacity="0.12" stroke="none"/>
      <polyline points="${polyPts}" fill="none" stroke="${lineColor}" stroke-width="1.5" stroke-linejoin="round"/>
      ${markers}
    </svg>`
}

// ── Chart.js options factory ──────────────────────────────────────────────

export function chartOpts({ tooltip, yFmt }) {
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
