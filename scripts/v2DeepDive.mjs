// Deep-dive on v2 — searches for refinements that beat the current filter set.
// Tests each potential signal against the actual fade fires + shadow data.

import 'dotenv/config'
import { createClient } from '@libsql/client'

const FEE = 0.07
const STARTING = 5000
const TEST_START = '2026-05-07'

const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })

// Load all settled fade fires with full intelligence
const fires = await db.execute(`
  SELECT b.id, b.bet_date, b.pitcher_name, b.strike, b.fill_price, b.filled_contracts,
         b.model_prob, b.edge AS live_edge, b.result, b.pnl, b.actual_ks,
         p.confidence, p.swstr_pct, p.avg_innings_l5, p.fstrike_pct, p.bb9, p.era_l5,
         p.hand, p.days_rest, p.season_start_num, p.tto_penalty,
         f.production_model_prob, f.park_k_factor, f.park
  FROM ks_bets b
  LEFT JOIN pitcher_signals p ON p.pitcher_id = b.pitcher_id AND p.signal_date = b.bet_date
  LEFT JOIN fade_paper_test_candidates f ON f.pitcher_id = b.pitcher_id AND f.target_date = b.bet_date AND f.strike = b.strike
  WHERE b.strategy_mode = 'pregame_fade_yes' AND b.bet_date >= ?
    AND b.result IN ('win', 'loss')
`, [TEST_START])
console.log(`Settled fires: ${fires.rows.length}`)

const wins = fires.rows.filter(f => f.result === 'win')
const losses = fires.rows.filter(f => f.result === 'loss')
console.log(`Wins: ${wins.length}, Losses: ${losses.length}\n`)

// Helper to score a filter
function score(label, keepFn) {
  const sub = fires.rows.filter(keepFn)
  const w = sub.filter(f => f.result === 'win').length
  const l = sub.filter(f => f.result === 'loss').length
  const pnl = sub.reduce((s, f) => s + Number(f.pnl ?? 0), 0)
  const stake = sub.reduce((s, f) => s + Number(f.filled_contracts) * Number(f.fill_price) / 100, 0)
  const winPct = sub.length > 0 ? (w / sub.length * 100).toFixed(1) : '—'
  const roi = stake > 0 ? (pnl / stake * 100).toFixed(1) : '—'
  console.log(`  ${label.padEnd(50)} n=${String(sub.length).padStart(3)}  ${w}W/${l}L  ${String(winPct).padStart(5)}%  P&L=${pnl >= 0 ? '+' : ''}$${pnl.toFixed(0).padStart(5)}  ROI=${roi}%`)
  return { sub, pnl, w, l }
}

// v2 baseline (current live filter)
const passV2 = f => (f.avg_innings_l5 == null || Number(f.avg_innings_l5) >= 5.0) &&
                    (f.confidence == null || Number(f.confidence) > 0.3)

console.log('═══ V2 baseline ═══')
score('v2 (H-H + H-I)', passV2)

// Win/loss profiling
console.log('\n═══ Wins vs Losses — Signal Profiles ═══')
console.log('  metric                    wins (avg)        losses (avg)')
const fmt = vs => vs.length === 0 ? '—' : (vs.reduce((s, v) => s + Number(v ?? 0), 0) / vs.length).toFixed(2)
for (const m of ['fill_price', 'live_edge', 'model_prob', 'avg_innings_l5', 'confidence', 'swstr_pct', 'fstrike_pct', 'bb9', 'era_l5', 'park_k_factor']) {
  const wv = wins.map(f => f[m]).filter(v => v != null)
  const lv = losses.map(f => f[m]).filter(v => v != null)
  console.log(`  ${m.padEnd(25)} ${fmt(wv).padStart(10)}        ${fmt(lv).padStart(10)}`)
}

console.log('\n═══ TWEAK 1: Tighter ask cap ═══')
score('v2 + ask ≤ 40',           f => passV2(f) && f.fill_price <= 40)
score('v2 + ask ≤ 30',           f => passV2(f) && f.fill_price <= 30)
score('v2 + ask ≤ 25',           f => passV2(f) && f.fill_price <= 25)
score('v2 + ask ≤ 20',           f => passV2(f) && f.fill_price <= 20)

console.log('\n═══ TWEAK 2: Edge cap (skip too-high edges) ═══')
score('v2 + edge ≤ 20c',         f => passV2(f) && Number(f.live_edge) <= 0.20)
score('v2 + edge ≤ 15c',         f => passV2(f) && Number(f.live_edge) <= 0.15)
score('v2 + edge in [5,15]c',    f => passV2(f) && Number(f.live_edge) >= 0.05 && Number(f.live_edge) <= 0.15)
score('v2 + edge in [8,15]c',    f => passV2(f) && Number(f.live_edge) >= 0.08 && Number(f.live_edge) <= 0.15)

console.log('\n═══ TWEAK 3: Strike floor variations ═══')
score('v2 + strike ≥ 7',         f => passV2(f) && Number(f.strike) >= 7)
score('v2 + strike ≥ 8',         f => passV2(f) && Number(f.strike) >= 8)
score('v2 + strike 6 or ≥10',    f => passV2(f) && (Number(f.strike) === 6 || Number(f.strike) >= 10))

console.log('\n═══ TWEAK 4: Park factor adjustments ═══')
score('v2 + skip park ≤ 0.95',   f => passV2(f) && (f.park_k_factor == null || Number(f.park_k_factor) > 0.95))
score('v2 + park ≥ 1.0',         f => passV2(f) && (f.park_k_factor == null || Number(f.park_k_factor) >= 1.0))

console.log('\n═══ TWEAK 5: Pitcher quality (swstr) ═══')
score('v2 + swstr ≥ 22%',        f => passV2(f) && (f.swstr_pct == null || Number(f.swstr_pct) >= 0.22))
score('v2 + swstr ≥ 25%',        f => passV2(f) && (f.swstr_pct == null || Number(f.swstr_pct) >= 0.25))
score('v2 + fstrike ≥ 60%',      f => passV2(f) && (f.fstrike_pct == null || Number(f.fstrike_pct) >= 0.60))

console.log('\n═══ TWEAK 6: Combined low-ask + edge band ═══')
score('v2 + ask ≤ 25 + edge ≥ 8c',  f => passV2(f) && f.fill_price <= 25 && Number(f.live_edge) >= 0.08)
score('v2 + ask ≤ 30 + edge ≥ 10c', f => passV2(f) && f.fill_price <= 30 && Number(f.live_edge) >= 0.10)
score('v2 + ask ≤ 25 + edge ≤ 20c', f => passV2(f) && f.fill_price <= 25 && Number(f.live_edge) <= 0.20)
score('v2 + ask ≤ 25 + edge in 8-20c', f => passV2(f) && f.fill_price <= 25 && Number(f.live_edge) >= 0.08 && Number(f.live_edge) <= 0.20)

console.log('\n═══ TWEAK 7: Days rest sensitivity ═══')
score('v2 + days_rest = 4',      f => passV2(f) && Number(f.days_rest) === 4)
score('v2 + days_rest ≥ 5',      f => passV2(f) && Number(f.days_rest) >= 5)
score('v2 + days_rest 4-6',      f => passV2(f) && Number(f.days_rest) >= 4 && Number(f.days_rest) <= 6)

console.log('\n═══ TWEAK 8: Strike RELATIVE to lambda ═══')
// Strike vs market K rate — maybe model edge in absolute strike terms differs from strike-as-fraction-of-lambda
// E.g., strike = lambda+1 vs lambda+3 (tail extremity)
const enriched = fires.rows.map(f => {
  const lam = Number(f.avg_innings_l5 ?? 0) > 0 && Number(f.swstr_pct) > 0
    ? null  // can't directly compute lambda from these without K9
    : null
  // Better: use model_prob inversely — if model_prob = 0.4 at strike 8, that implies lambda ≈ ?
  return { ...f, ratio: Number(f.strike) / (Number(f.model_prob) > 0 ? Math.log(1 - Number(f.model_prob)) : 1) }
})
score('v2 + model_prob ≥ 25%',   f => passV2(f) && Number(f.model_prob) >= 0.25)
score('v2 + model_prob ≥ 30%',   f => passV2(f) && Number(f.model_prob) >= 0.30)
score('v2 + model_prob 25-50%',  f => passV2(f) && Number(f.model_prob) >= 0.25 && Number(f.model_prob) <= 0.50)

console.log('\n═══ Sample wins detail ═══')
for (const w of wins) {
  console.log(`  ${w.bet_date} ${(w.pitcher_name??'?').padEnd(20)} K≥${w.strike} @ ${w.fill_price}c · edge=${(Number(w.live_edge)*100).toFixed(1)}c · model=${(Number(w.model_prob)*100).toFixed(0)}% · ipL5=${w.avg_innings_l5} · conf=${w.confidence} · swstr=${(Number(w.swstr_pct)*100).toFixed(0)}% · pnl=+$${Number(w.pnl).toFixed(0)}`)
}

console.log('\n═══ Sample losses detail (worst 10) ═══')
losses.sort((a, b) => Number(a.pnl) - Number(b.pnl))
for (const l of losses.slice(0, 10)) {
  console.log(`  ${l.bet_date} ${(l.pitcher_name??'?').padEnd(20)} K≥${l.strike} @ ${l.fill_price}c · edge=${(Number(l.live_edge)*100).toFixed(1)}c · model=${(Number(l.model_prob)*100).toFixed(0)}% · ipL5=${l.avg_innings_l5} · conf=${l.confidence} · swstr=${(Number(l.swstr_pct)*100).toFixed(0)}% · actual=${l.actual_ks} · pnl=-$${Math.abs(Number(l.pnl)).toFixed(0)}`)
}
