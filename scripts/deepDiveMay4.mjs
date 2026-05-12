import 'dotenv/config'
import { createClient } from '@libsql/client'
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })
const DATE = '2026-05-04'

function $(n) { return (n >= 0 ? '+' : '') + '$' + Math.abs(n).toFixed(2).replace(/^/, n < 0 ? '-' : '') }
function pct(n) { return n != null ? (n * 100).toFixed(1) + '%' : '—' }

console.log('═'.repeat(95))
console.log(`  DEEP DIVE — ${DATE} (last night's paper test)`)
console.log('═'.repeat(95))

// 1. Today's actual fires
console.log('\n── 1. ALL FIRES ──')
const fires = await db.execute({
  sql: `SELECT id, user_id, pitcher_name, side, strike, capital_at_risk, pnl, result, actual_ks,
               model_prob, market_mid, k9_l5, k9_career, strategy_mode, bet_mode,
               logged_at, paper, live_bet
        FROM ks_bets WHERE bet_date = ? AND order_id IS NOT NULL ORDER BY logged_at`,
  args: [DATE]
})
const usrName = id => id === 1 ? 'Adam' : id === 2 ? 'Isaiah' : id === 284 ? 'Adam-Live' : `u${id}`
for (const f of fires.rows) {
  const tag = f.live_bet ? '🔴' : '📋'
  const res = f.result ? `${f.result === 'win' ? '✓' : '✗'} K=${f.actual_ks} ${$(f.pnl)}` : 'open'
  const mp = Number(f.model_prob).toFixed(2)
  const gap = f.k9_career > 0 ? (Number(f.k9_l5) - Number(f.k9_career)).toFixed(2) : '?'
  console.log(`  ${tag} #${f.id} ${f.logged_at.slice(11,19)}Z ${f.pitcher_name.padEnd(20)} ${f.side}${f.strike} ${usrName(f.user_id).padEnd(10)} mp=${mp} gap=${gap} mid=${f.market_mid}¢ $${f.capital_at_risk}  ${res}  ${f.strategy_mode}`)
}

// 2. Schedule outcomes — what was scheduled and what happened
console.log('\n── 2. BET_SCHEDULE — what got scheduled and outcomes ──')
const sched = await db.execute({
  sql: `SELECT pitcher_name, game_label, status, fired_at, allocated_usd, preflight, preflight_outcome
        FROM bet_schedule WHERE bet_date = ? ORDER BY game_time`,
  args: [DATE]
})
const byStatus = {}
for (const s of sched.rows) {
  byStatus[s.status] = (byStatus[s.status] || 0) + 1
}
console.log(`  Status counts: ${Object.entries(byStatus).map(([k,v]) => `${k}=${v}`).join(', ')}`)
console.log(`  Total scheduled: ${sched.rows.length}`)

// 3. Skipped pitchers — why?
console.log('\n── 3. SKIPPED PITCHERS (potential missed edges) ──')
const skipped = sched.rows.filter(s => s.status === 'skipped')
for (const s of skipped) {
  const skipReason = s.preflight ? s.preflight.slice(0, 80) : 'unknown'
  console.log(`  ${s.pitcher_name.padEnd(22)} ${s.game_label}  ${skipReason}`)
}

// 4. Pending rule evaluations status
console.log('\n── 4. PENDING RULE EVALUATIONS ──')
const pending = await db.execute(`SELECT rule_name, current_sample, min_sample_size, current_pnl, current_roi, decision_status FROM pending_rule_evaluations`)
for (const p of pending.rows) {
  console.log(`  ${p.rule_name.padEnd(40)} ${p.decision_status}  n=${p.current_sample}/${p.min_sample_size}  pnl=${$(p.current_pnl)}  ROI=${pct(p.current_roi)}`)
}

// 5. Today's shadow_full_distribution — what was BLOCKED that had positive cal edge?
console.log('\n── 5. SHADOW FULL-DISTRIBUTION — blocked candidates with edge ──')
const fd = await db.execute({
  sql: `SELECT side, strike, COUNT(*) AS n,
               SUM(CASE WHEN production_allowed=1 THEN 1 ELSE 0 END) AS allowed,
               SUM(CASE WHEN production_allowed=0 AND proposed_kelly_size > 0 THEN 1 ELSE 0 END) AS blocked_with_edge,
               SUM(CASE WHEN production_allowed=0 AND proposed_kelly_size > 0 AND result='win' THEN 1 ELSE 0 END) AS blocked_wins,
               SUM(CASE WHEN production_allowed=0 AND proposed_kelly_size > 0 AND result='loss' THEN 1 ELSE 0 END) AS blocked_losses,
               ROUND(SUM(CASE WHEN production_allowed=0 AND proposed_kelly_size > 0 THEN shadow_pnl ELSE 0 END), 2) AS blocked_pnl
        FROM shadow_full_distribution WHERE bet_date = ?
        GROUP BY side, strike ORDER BY side, strike`,
  args: [DATE]
})
console.log(`  side  strike   total  allowed  blocked+edge  blocked W-L   blocked PnL`)
console.log('  ' + '─'.repeat(75))
for (const r of fd.rows) {
  console.log(`  ${r.side.padEnd(4)}  K${r.strike}        ${String(r.n).padEnd(4)}  ${String(r.allowed).padEnd(7)}  ${String(r.blocked_with_edge).padEnd(11)}  ${r.blocked_wins}-${r.blocked_losses}         ${$(r.blocked_pnl ?? 0)}`)
}

// 6. Shadow inversion summary
console.log('\n── 6. SHADOW INVERSION (gap thresholds) ──')
const inv = await db.execute({
  sql: `SELECT threshold, COUNT(*) AS cands, SUM(would_fire) AS fires,
               SUM(CASE WHEN would_fire=1 AND result='win' THEN 1 ELSE 0 END) AS wins,
               SUM(CASE WHEN would_fire=1 AND result='loss' THEN 1 ELSE 0 END) AS losses,
               ROUND(SUM(CASE WHEN would_fire=1 THEN shadow_pnl ELSE 0 END), 2) AS pnl
        FROM shadow_inversion WHERE bet_date = ? GROUP BY threshold ORDER BY threshold`,
  args: [DATE]
})
for (const r of inv.rows) {
  console.log(`  gap≥${r.threshold}: ${r.cands} cands, ${r.fires} fires, ${r.wins}W-${r.losses}L, pnl=${$(r.pnl ?? 0)}`)
}

// 7. Calibrate-Kelly comparison
console.log('\n── 7. CALIBRATE-KELLY SHADOW (real vs calibrated sizing) ──')
const ck = await db.execute({
  sql: `SELECT COUNT(*) AS n, SUM(CASE WHEN calibrated_size = 0 THEN 1 ELSE 0 END) AS skipped_by_cal,
               ROUND(SUM(raw_size), 2) AS raw_risk, ROUND(SUM(calibrated_size), 2) AS cal_risk,
               ROUND(SUM(raw_pnl), 2) AS raw_pnl, ROUND(SUM(calibrated_pnl), 2) AS cal_pnl
        FROM shadow_calibrate_kelly WHERE bet_date = ? AND result IS NOT NULL`,
  args: [DATE]
})
const c = ck.rows[0]
console.log(`  ${c.n} settled. Skipped by cal-Kelly: ${c.skipped_by_cal}`)
console.log(`  Raw sizing:  ${$(c.raw_pnl ?? 0)} on ${$(c.raw_risk ?? 0)} risk`)
console.log(`  Cal-Kelly:   ${$(c.cal_pnl ?? 0)} on ${$(c.cal_risk ?? 0)} risk`)
console.log(`  Swing:       ${$((c.cal_pnl ?? 0) - (c.raw_pnl ?? 0))}`)

// 8. In-game (live_bet=1) activity check
console.log('\n── 8. IN-GAME TIER ACTIVITY ──')
const live = await db.execute({
  sql: `SELECT strategy_mode, bet_mode, COUNT(*) AS n FROM ks_bets WHERE bet_date = ? AND live_bet = 1 GROUP BY strategy_mode, bet_mode`,
  args: [DATE]
})
if (live.rows.length === 0) {
  console.log('  ZERO in-game fires across all tiers (Tier 1/2/3 all silent)')
} else {
  for (const r of live.rows) console.log(`  ${r.strategy_mode}/${r.bet_mode}: ${r.n}`)
}

// 9. Aggregate summary
console.log('\n── 9. DAY SUMMARY ──')
const settled = fires.rows.filter(f => f.result)
const wins = settled.filter(f => f.result === 'win').length
const losses = settled.filter(f => f.result === 'loss').length
const totalPnl = settled.reduce((s, f) => s + Number(f.pnl ?? 0), 0)
const totalRisk = fires.rows.reduce((s, f) => s + Number(f.capital_at_risk ?? 0), 0)
console.log(`  Total fires: ${fires.rows.length}, settled: ${settled.length}, ${wins}W-${losses}L`)
console.log(`  Total risk: ${$(totalRisk)}`)
console.log(`  Settled P&L: ${$(totalPnl)} (ROI ${pct(totalPnl/totalRisk)})`)
