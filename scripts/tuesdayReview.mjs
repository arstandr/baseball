import 'dotenv/config'
import { createClient } from '@libsql/client'
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })

const DATE = '2026-05-05'
function $(n) { return (n >= 0 ? '+' : '') + '$' + Math.abs(n).toFixed(2).replace(/^/, n < 0 ? '-' : '') }

console.log(`═══════════════════════════════════════════════════════════════════════`)
console.log(`  TUESDAY ${DATE} — DAY REVIEW`)
console.log(`═══════════════════════════════════════════════════════════════════════\n`)

// 1. All fires with outcomes
console.log(`── 1. ALL FIRES ──`)
const fires = await db.execute({
  sql: `SELECT id, user_id, pitcher_name, side, strike, model_prob, capital_at_risk, pnl,
               result, actual_ks, k9_career, n_starts, strategy_mode, bet_mode, live_bet, paper, logged_at
        FROM ks_bets WHERE bet_date = ? AND order_id IS NOT NULL ORDER BY logged_at ASC`,
  args: [DATE],
})
const usrName = id => id === 1 ? 'Adam' : id === 2 ? 'Isaiah' : id === 284 ? 'Adam-Live' : `u${id}`
for (const f of fires.rows) {
  const tag = f.live_bet ? '🔴' : '📋'
  const res = f.result ? `${f.result === 'win' ? '✓' : '✗'} K=${f.actual_ks}` : 'open'
  const pnl = f.pnl != null ? $(Number(f.pnl)) : '—'
  const career = f.k9_career == null ? 'rookie' : Number(f.k9_career).toFixed(1)
  console.log(`  ${tag} ${f.logged_at.slice(11,19)}Z ${f.pitcher_name.padEnd(20)} ${f.side}${f.strike} ${usrName(f.user_id).padEnd(10)} mp=${Number(f.model_prob).toFixed(2)} risk=$${f.capital_at_risk} career=${career} ${res} pnl=${pnl} ${f.strategy_mode}`)
}

// 2. Day P&L summary
const settled = fires.rows.filter(f => f.result)
const wins = settled.filter(f => f.result === 'win').length
const losses = settled.filter(f => f.result === 'loss').length
const totalPnl = settled.reduce((s, f) => s + Number(f.pnl ?? 0), 0)
const totalRisk = fires.rows.reduce((s, f) => s + Number(f.capital_at_risk ?? 0), 0)
console.log(`\n── 2. DAY SUMMARY ──`)
console.log(`  Total fires: ${fires.rows.length}, settled: ${settled.length}`)
console.log(`  ${wins}W / ${losses}L`)
console.log(`  Total risk: ${$(totalRisk)}`)
console.log(`  P&L: ${$(totalPnl)}, ROI: ${totalRisk > 0 ? (totalPnl/totalRisk*100).toFixed(1) : '0'}%`)

// 3. Strategy mode breakdown
console.log(`\n── 3. BY STRATEGY MODE ──`)
const byMode = await db.execute({
  sql: `SELECT strategy_mode, live_bet, COUNT(*) AS n,
               SUM(CASE WHEN result='win' THEN 1 ELSE 0 END) AS wins,
               SUM(CASE WHEN result='loss' THEN 1 ELSE 0 END) AS losses,
               ROUND(SUM(pnl), 2) AS pnl, ROUND(SUM(capital_at_risk), 2) AS risk
        FROM ks_bets WHERE bet_date = ? AND order_id IS NOT NULL
        GROUP BY strategy_mode, live_bet ORDER BY live_bet, strategy_mode`,
  args: [DATE],
})
for (const m of byMode.rows) {
  const tag = m.live_bet ? '🔴 LIVE' : '📋 pre'
  console.log(`  ${tag}  ${(m.strategy_mode ?? '?').padEnd(28)} ${m.n} fires, ${m.wins}W/${m.losses}L, ${$(Number(m.pnl ?? 0))} on ${$(Number(m.risk ?? 0))}`)
}

// 4. Cross-strike POC settlement
console.log(`\n── 4. CROSS-STRIKE POC SETTLEMENT ──`)
const poc = await db.execute({
  sql: `SELECT p.pitcher_name, p.strike, p.side, p.market_implied, p.fit_implied, p.residual,
               p.ask_cents, p.fit_lambda, p.engine_lambda
        FROM crossstrike_poc_predictions p WHERE p.bet_date = ?`,
  args: [DATE],
})
const FEE_FRACTION = 0.07
let pocFires = 0, pocWins = 0, pocLosses = 0, pocPnl = 0
for (const p of poc.rows) {
  // Get actual_ks for this pitcher from any settled bet OR shadow row
  const ksRow = await db.execute({
    sql: `SELECT MAX(actual_ks) AS actual_ks FROM ks_bets WHERE bet_date=? AND pitcher_name=? AND actual_ks IS NOT NULL`,
    args: [DATE, p.pitcher_name],
  }).catch(() => ({ rows: [] }))
  let actualKs = ksRow.rows?.[0]?.actual_ks
  if (actualKs == null) {
    const sh = await db.execute({
      sql: `SELECT MAX(actual_ks) AS actual_ks FROM shadow_full_distribution WHERE bet_date=? AND pitcher_name=? AND actual_ks IS NOT NULL`,
      args: [DATE, p.pitcher_name],
    }).catch(() => ({ rows: [] }))
    actualKs = sh.rows?.[0]?.actual_ks
  }
  if (actualKs == null) continue

  const won = p.side === 'YES' ? actualKs >= p.strike : actualKs < p.strike
  const askPrice = Number(p.ask_cents) / 100
  if (askPrice <= 0 || askPrice >= 1) continue

  const grossProfit = won ? (1 - askPrice) / askPrice : -1
  const fee = won ? FEE_FRACTION * Math.min(askPrice, 1 - askPrice) : 0
  const pnl = grossProfit - (won ? fee : 0)

  pocFires++
  if (won) pocWins++; else pocLosses++
  pocPnl += pnl
}
const pocWinRate = pocFires > 0 ? (pocWins / pocFires * 100).toFixed(1) : '0'
const pocROI = pocFires > 0 ? (pocPnl / pocFires * 100).toFixed(1) : '0'
console.log(`  Predictions made yesterday: ${poc.rows.length}`)
console.log(`  Settled (have actual_ks):   ${pocFires}`)
console.log(`  Win rate: ${pocWinRate}% (${pocWins}W / ${pocLosses}L)`)
console.log(`  P&L per $1 bet: ${pocPnl >= 0 ? '+' : ''}$${pocPnl.toFixed(2)}`)
console.log(`  ROI per fire:   ${pocROI}%`)

if (pocFires > 0 && pocFires <= 25) {
  console.log(`\n  Per-prediction outcomes:`)
  for (const p of poc.rows) {
    const ksRow = await db.execute({
      sql: `SELECT MAX(actual_ks) AS actual_ks FROM ks_bets WHERE bet_date=? AND pitcher_name=? AND actual_ks IS NOT NULL`,
      args: [DATE, p.pitcher_name],
    }).catch(() => ({ rows: [] }))
    let actualKs = ksRow.rows?.[0]?.actual_ks
    if (actualKs == null) {
      const sh = await db.execute({
        sql: `SELECT MAX(actual_ks) AS actual_ks FROM shadow_full_distribution WHERE bet_date=? AND pitcher_name=? AND actual_ks IS NOT NULL`,
        args: [DATE, p.pitcher_name],
      }).catch(() => ({ rows: [] }))
      actualKs = sh.rows?.[0]?.actual_ks
    }
    if (actualKs == null) {
      console.log(`  ⏳ ${p.pitcher_name.padEnd(22)} K${p.strike} ${p.side.padEnd(3)} resid=${Number(p.residual).toFixed(3)} ask=${p.ask_cents}¢ — UNSETTLED`)
      continue
    }
    const won = p.side === 'YES' ? actualKs >= p.strike : actualKs < p.strike
    const askPrice = p.ask_cents / 100
    const grossProfit = won ? (1 - askPrice) / askPrice : -1
    const fee = won ? FEE_FRACTION * Math.min(askPrice, 1 - askPrice) : 0
    const pnl = grossProfit - (won ? fee : 0)
    console.log(`  ${won ? '✓' : '✗'} ${p.pitcher_name.padEnd(22)} K${p.strike} ${p.side.padEnd(3)} resid=${Number(p.residual).toFixed(3)} ask=${p.ask_cents}¢ K=${actualKs} pnl=${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`)
  }
}

// 5. Tier diagnostic check
console.log(`\n── 5. TIER 1/2/3 DIAGNOSTIC ──`)
console.log(`  (querying railway logs separately below)`)

// 6. Pending rule evaluations
console.log(`\n── 6. PENDING RULE EVALUATIONS ──`)
const pending = await db.execute(`SELECT rule_name, current_sample, min_sample_size, current_pnl, current_roi, decision_status, last_evaluated_at FROM pending_rule_evaluations`)
for (const p of pending.rows) {
  const evalAt = p.last_evaluated_at?.slice(0, 16) ?? 'never'
  console.log(`  ${p.rule_name.padEnd(40)} ${p.decision_status} n=${p.current_sample}/${p.min_sample_size} pnl=${$(Number(p.current_pnl ?? 0))} ROI=${(Number(p.current_roi ?? 0) * 100).toFixed(1)}% eval=${evalAt}`)
}

// 7. Pitcher blocklist (was the dynamic eval cron supposed to run?)
console.log(`\n── 7. PITCHER BLOCKLIST ──`)
const bl = await db.execute(`SELECT pitcher_name, added_by, added_at FROM pitcher_blocklist ORDER BY added_at`)
for (const b of bl.rows) {
  console.log(`  ${b.pitcher_name.padEnd(24)} added_by=${b.added_by} at=${(b.added_at ?? '').slice(0, 16)}`)
}
