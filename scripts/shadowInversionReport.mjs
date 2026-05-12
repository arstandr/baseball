// Shadow inversion audit report.
//
// Preview today's shadow data:
//   node scripts/shadowInversionReport.mjs
//
// Specific date:
//   node scripts/shadowInversionReport.mjs 2026-05-03
//
// Multi-day (rolls up by threshold across the range):
//   node scripts/shadowInversionReport.mjs 2026-04-26 2026-05-03

import 'dotenv/config'
import { buildShadowReport, buildCalibratedYesReport } from '../lib/shadowInversion.js'
import { all as dbAll } from '../lib/db.js'

const args = process.argv.slice(2).filter(a => /^\d{4}-\d{2}-\d{2}$/.test(a))
const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
const start = args[0] || todayET
const end   = args[1] || start

function pad(s, n) { return String(s ?? '').padEnd(n) }
function rpad(s, n) { return String(s ?? '').padStart(n) }
function $(n) { return (n >= 0 ? '+' : '') + '$' + Number(n ?? 0).toFixed(2) }
function pct(n) { return n == null ? '—' : `${n.toFixed(1)}%` }

// Single-date report
async function reportDay(date) {
  const r = await buildShadowReport({ betDate: date })
  console.log(`\n══════════════════════════════════════════════════`)
  console.log(`  Shadow Audit — ${date}`)
  console.log(`══════════════════════════════════════════════════`)

  console.log(`\n── Per-threshold (NO inversion candidates) ──`)
  console.log(`thresh  cands  fires  med_edge  p25/p75    avg_edge  W-L     pnl       risk     ROI    pitch  max_conc`)
  for (const t of r.thresholds) {
    const med = t.median_edge != null ? `${(t.median_edge * 100).toFixed(1)}¢` : '—'
    const p   = (t.p25_edge != null && t.p75_edge != null)
      ? `${(t.p25_edge * 100).toFixed(0)}/${(t.p75_edge * 100).toFixed(0)}¢`
      : '—'
    const avg = t.avg_edge != null ? `${(t.avg_edge * 100).toFixed(1)}¢` : '—'
    console.log(`${pad('≥' + t.threshold, 7)} ${rpad(t.candidates, 5)}  ${rpad(t.would_fire, 5)}  ${pad(med, 8)}  ${pad(p, 9)}  ${pad(avg, 8)}  ${pad(t.wins + '-' + t.losses, 7)} ${pad($(t.total_pnl), 9)} ${pad('$' + t.total_risk.toFixed(2), 8)} ${pad(pct(t.roi_pct), 6)} ${rpad(t.distinct_pitchers, 5)}  ${rpad(t.max_concentration, 4)}`)
  }

  console.log(`\n── YES-hot audit (real fires by gap bucket) ──`)
  if (!r.yes_hot.length) {
    console.log('(no real YES fires for this date — nothing to bucket)')
  } else {
    console.log(`bucket    n   W-L    pnl       risk     ROI    win%   avg_mp  cal_yp  avg_mid`)
    for (const b of r.yes_hot) {
      console.log(`${pad(b.bucket, 9)} ${rpad(b.n, 3)} ${pad(b.wins + '-' + b.losses, 6)} ${pad($(b.pnl), 9)} ${pad('$' + (b.risk ?? 0).toFixed(2), 8)} ${pad(pct(b.roi_pct), 6)} ${pad(pct(b.win_rate), 6)} ${pad(b.avg_mp, 6)}  ${pad(b.calibrated_yes_prob, 6)}  ${rpad(b.avg_mid + '¢', 7)}`)
    }
  }

  // Calibrated YES shadow
  const cal = await buildCalibratedYesReport({ betDate: date })
  console.log(`\n── Calibrated-YES shadow (fire YES only when calibrated_prob beats yes_ask + fees) ──`)
  console.log(`edge≥   cands  fires  med_edge  p25/p75    avg_edge  W-L     pnl       risk     ROI    pitch`)
  for (const t of cal.thresholds) {
    const med = t.median_edge != null ? `${(t.median_edge * 100).toFixed(1)}¢` : '—'
    const p   = (t.p25_edge != null && t.p75_edge != null)
      ? `${(t.p25_edge * 100).toFixed(0)}/${(t.p75_edge * 100).toFixed(0)}¢`
      : '—'
    const avg = t.avg_edge != null ? `${(t.avg_edge * 100).toFixed(1)}¢` : '—'
    console.log(`${pad('≥' + t.edge_threshold, 7)} ${rpad(t.candidates, 5)}  ${rpad(t.would_fire, 5)}  ${pad(med, 8)}  ${pad(p, 9)}  ${pad(avg, 8)}  ${pad(t.wins + '-' + t.losses, 7)} ${pad($(t.total_pnl), 9)} ${pad('$' + t.total_risk.toFixed(2), 8)} ${pad(pct(t.roi_pct), 6)} ${rpad(t.distinct_pitchers, 5)}`)
  }
}

// Multi-day rollup
async function reportRange(s, e) {
  const dates = await dbAll(
    `SELECT DISTINCT bet_date FROM shadow_inversion WHERE bet_date BETWEEN ? AND ? ORDER BY bet_date`,
    [s, e],
  ).catch(() => [])
  if (!dates.length) { console.log(`No shadow data between ${s} and ${e}.`); return }
  console.log(`\nShadow data covers ${dates.length} day(s): ${dates.map(d => d.bet_date).join(', ')}`)

  // Per-threshold rollup across the range
  const rolledByThresh = new Map()
  for (const d of dates) {
    const r = await buildShadowReport({ betDate: d.bet_date })
    for (const t of r.thresholds) {
      const key = t.threshold
      const prev = rolledByThresh.get(key) ?? {
        threshold: key, candidates: 0, would_fire: 0, wins: 0, losses: 0, total_pnl: 0, total_risk: 0,
      }
      prev.candidates += t.candidates
      prev.would_fire += t.would_fire
      prev.wins       += t.wins
      prev.losses     += t.losses
      prev.total_pnl  += t.total_pnl
      prev.total_risk += t.total_risk
      rolledByThresh.set(key, prev)
    }
  }
  console.log(`\n── Range rollup (${s} → ${e}) ──`)
  console.log(`thresh  cands  fires  W-L     pnl        risk      ROI`)
  for (const r of rolledByThresh.values()) {
    const roi = r.total_risk > 0 ? Math.round((r.total_pnl / r.total_risk) * 1000) / 10 : null
    console.log(`${pad('≥' + r.threshold, 7)} ${rpad(r.candidates, 5)}  ${rpad(r.would_fire, 5)}  ${pad(r.wins + '-' + r.losses, 7)} ${pad($(r.total_pnl), 10)} ${pad('$' + r.total_risk.toFixed(2), 9)} ${pad(pct(roi), 6)}`)
  }
}

if (start === end) {
  await reportDay(start)
} else {
  await reportRange(start, end)
}
