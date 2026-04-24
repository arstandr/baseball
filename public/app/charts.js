import { state } from './state.js'
import { fmt$, fmtPct, chartOpts } from './utils.js'

export function drawBankrollChart(series) {
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

export function drawDailyChart(series) {
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

export function drawWeeklyChart(weekly) {
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
