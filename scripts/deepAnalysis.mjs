// Deep YES/NO system analysis from real settled data + today's shadow.
// Goal: empirically identify where we're picking too aggressively, too
// conservatively, or missing structural edges. Real numbers, no speculation.

import 'dotenv/config'
import { createClient } from '@libsql/client'
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })

const TODAY = '2026-05-04'

function $(n) { return (n >= 0 ? '+' : '') + '$' + Math.abs(n).toFixed(2).replace(/^/, n < 0 ? '-' : '') }
function pct(n) { return (n * 100).toFixed(1) + '%' }
function pad(s, n) { return String(s ?? '').padEnd(n) }
function rpad(s, n) { return String(s ?? '').padStart(n) }

console.log('═'.repeat(92))
console.log('  YES/NO SYSTEM DEEP ANALYSIS')
console.log('  Window: last 30 days of settled bets')
console.log('═'.repeat(92))

// ── 1. Calibration check: does model_prob match reality? ──────────────────
console.log('\n── 1. MODEL CALIBRATION (last 30 days, settled YES bets) ──')
console.log('   Compares what the model claimed vs what actually happened.\n')
const cal = await db.execute(`
  SELECT
    CASE
      WHEN model_prob < 0.42 THEN '1: <0.42'
      WHEN model_prob < 0.52 THEN '2: 0.42-0.52'
      WHEN model_prob < 0.65 THEN '3: 0.52-0.65'
      ELSE                          '4: >=0.65'
    END AS bucket,
    COUNT(*) AS n,
    ROUND(AVG(model_prob), 3) AS avg_claim,
    ROUND(SUM(CASE WHEN result='win' THEN 1 ELSE 0 END) * 1.0 / COUNT(*), 3) AS actual_rate,
    ROUND(SUM(pnl), 2) AS pnl,
    ROUND(SUM(capital_at_risk), 2) AS risk
  FROM ks_bets
  WHERE bet_date >= date('now','-30 days')
    AND live_bet = 0 AND side = 'YES' AND result IN ('win','loss')
  GROUP BY bucket
  ORDER BY bucket
`)
console.log(`   bucket          n     avg_claim   actual    gap       pnl        risk      ROI`)
console.log('   ' + '─'.repeat(85))
for (const r of cal.rows) {
  const gap = Number(r.actual_rate) - Number(r.avg_claim)
  const roi = r.risk > 0 ? Number(r.pnl) / Number(r.risk) : 0
  console.log(`   ${pad(r.bucket, 14)} ${rpad(r.n, 4)}   ${pct(Number(r.avg_claim)).padStart(6)}   ${pct(Number(r.actual_rate)).padStart(6)}    ${(gap >= 0 ? '+' : '') + pct(gap).padStart(6)}   ${$(r.pnl).padStart(9)}  ${$(r.risk).padStart(8)}  ${pct(roi).padStart(6)}`)
}

// ── 2. Profit by strike level ─────────────────────────────────────────────
console.log('\n── 2. WIN RATE & PROFIT BY STRIKE LEVEL (YES bets, last 30 days) ──')
console.log('   Where on the strike curve are we actually making/losing money?\n')
const byStrike = await db.execute(`
  SELECT strike,
    COUNT(*) AS n,
    SUM(CASE WHEN result='win' THEN 1 ELSE 0 END) AS wins,
    ROUND(AVG(model_prob), 3) AS avg_claim,
    ROUND(SUM(CASE WHEN result='win' THEN 1 ELSE 0 END) * 1.0 / COUNT(*), 3) AS win_rate,
    ROUND(SUM(pnl), 2) AS pnl,
    ROUND(SUM(capital_at_risk), 2) AS risk,
    ROUND(AVG(market_mid), 1) AS avg_mid
  FROM ks_bets
  WHERE bet_date >= date('now','-30 days')
    AND live_bet = 0 AND side = 'YES' AND result IN ('win','loss')
  GROUP BY strike ORDER BY strike
`)
console.log(`   strike  n      wins   claim    actual    pnl        risk      ROI       avg_mid`)
console.log('   ' + '─'.repeat(85))
for (const r of byStrike.rows) {
  const roi = r.risk > 0 ? Number(r.pnl) / Number(r.risk) : 0
  console.log(`   K${r.strike}      ${rpad(r.n, 4)}   ${rpad(r.wins, 4)}   ${pct(Number(r.avg_claim)).padStart(6)}   ${pct(Number(r.win_rate)).padStart(6)}   ${$(r.pnl).padStart(9)}  ${$(r.risk).padStart(8)}  ${pct(roi).padStart(6)}     ${r.avg_mid}¢`)
}

// ── 3. NO bet history (small sample) ──────────────────────────────────────
console.log('\n── 3. NO BET HISTORY (last 30 days, all that fired) ──')
const noByStrike = await db.execute(`
  SELECT strike, strategy_mode,
    COUNT(*) AS n,
    SUM(CASE WHEN result='win' THEN 1 ELSE 0 END) AS wins,
    ROUND(SUM(pnl), 2) AS pnl,
    ROUND(SUM(capital_at_risk), 2) AS risk
  FROM ks_bets
  WHERE bet_date >= date('now','-30 days')
    AND live_bet = 0 AND side = 'NO' AND result IN ('win','loss')
  GROUP BY strike, strategy_mode ORDER BY strike, strategy_mode
`)
if (!noByStrike.rows.length) {
  console.log('   (no NO bets fired in window)')
} else {
  console.log(`   strike  mode                        n     wins   pnl        risk`)
  console.log('   ' + '─'.repeat(75))
  for (const r of noByStrike.rows) {
    console.log(`   K${r.strike}      ${pad(r.strategy_mode ?? '', 24)}    ${rpad(r.n, 3)}   ${rpad(r.wins, 4)}   ${$(r.pnl).padStart(9)}  ${$(r.risk)}`)
  }
}

// ── 4. Today's full-distribution shadow — what blocked candidates exist? ──
console.log('\n── 4. TODAY\'S FULL-DISTRIBUTION SHADOW (every (pitcher×strike×side) the model scored) ──')
const fd = await db.execute({
  sql: `SELECT side, strike,
          COUNT(*) AS n,
          SUM(CASE WHEN production_allowed = 1 THEN 1 ELSE 0 END) AS allowed,
          SUM(CASE WHEN production_allowed = 0 THEN 1 ELSE 0 END) AS blocked,
          SUM(CASE WHEN proposed_kelly_size > 0 THEN 1 ELSE 0 END) AS would_fire_cal,
          SUM(CASE WHEN production_allowed = 0 AND proposed_kelly_size > 0 THEN 1 ELSE 0 END) AS blocked_with_edge,
          ROUND(SUM(CASE WHEN proposed_kelly_size > 0 THEN proposed_kelly_size ELSE 0 END), 2) AS total_size_if_fired,
          ROUND(AVG(CASE WHEN proposed_kelly_size > 0 THEN calibrated_edge END), 3) AS avg_cal_edge_when_firing
        FROM shadow_full_distribution
        WHERE bet_date = ?
        GROUP BY side, strike
        ORDER BY side, strike`,
  args: [TODAY],
})
console.log(`   side  strike    n      allowed  blocked  cal_fire  blocked+edge  $size   avg_edge`)
console.log('   ' + '─'.repeat(88))
for (const r of fd.rows) {
  const ce = r.avg_cal_edge_when_firing != null ? pct(Number(r.avg_cal_edge_when_firing)) : '—'
  console.log(`   ${pad(r.side, 4)}  K${r.strike}        ${rpad(r.n, 4)}   ${rpad(r.allowed, 6)}   ${rpad(r.blocked, 6)}   ${rpad(r.would_fire_cal, 7)}    ${rpad(r.blocked_with_edge, 11)}    $${rpad(Number(r.total_size_if_fired ?? 0).toFixed(0), 4)}   ${ce}`)
}

// ── 5. Hot/cold pattern (k9_l5 - k9_career) ───────────────────────────────
console.log('\n── 5. HOT/COLD PATTERN: settled YES bets by L5 - career K9 gap ──')
console.log('   Tests the inversion thesis: "model overreacts on hot streaks"\n')
const hot = await db.execute(`
  SELECT
    CASE
      WHEN (k9_l5 - k9_career) < -1   THEN '1: very cold (<-1)'
      WHEN (k9_l5 - k9_career) < 0    THEN '2: cold (-1 to 0)'
      WHEN (k9_l5 - k9_career) < 0.5  THEN '3: neutral (0 to 0.5)'
      WHEN (k9_l5 - k9_career) < 1    THEN '4: hot (0.5-1)'
      ELSE                                  '5: very hot (1+)'
    END AS bucket,
    COUNT(*) AS n,
    ROUND(SUM(CASE WHEN result='win' THEN 1 ELSE 0 END) * 1.0 / COUNT(*), 3) AS win_rate,
    ROUND(SUM(pnl), 2) AS pnl,
    ROUND(SUM(capital_at_risk), 2) AS risk
  FROM ks_bets
  WHERE bet_date >= date('now','-30 days')
    AND live_bet = 0 AND side = 'YES' AND result IN ('win','loss')
    AND k9_career > 0
  GROUP BY bucket ORDER BY bucket
`)
console.log(`   gap bucket             n      win_rate    pnl         risk      ROI`)
console.log('   ' + '─'.repeat(75))
for (const r of hot.rows) {
  const roi = r.risk > 0 ? Number(r.pnl) / Number(r.risk) : 0
  console.log(`   ${pad(r.bucket, 22)}  ${rpad(r.n, 4)}   ${pct(Number(r.win_rate)).padStart(6)}     ${$(r.pnl).padStart(9)}   ${$(r.risk).padStart(8)}   ${pct(roi).padStart(6)}`)
}

// ── 6. Sizing decile analysis ─────────────────────────────────────────────
console.log('\n── 6. KELLY SIZING DECILE ANALYSIS (settled YES bets) ──')
console.log('   Are large bets winning/losing at expected rates? Variance check.\n')
const sized = await db.execute(`
  SELECT id, capital_at_risk, pnl, result, model_prob, strike, pitcher_name
  FROM ks_bets
  WHERE bet_date >= date('now','-30 days')
    AND live_bet = 0 AND side = 'YES' AND result IN ('win','loss')
    AND capital_at_risk > 0
  ORDER BY capital_at_risk
`)
const rows = sized.rows
const decileSize = Math.ceil(rows.length / 10)
console.log(`   decile  size_range            n     win_rate    pnl         ROI`)
console.log('   ' + '─'.repeat(75))
for (let d = 0; d < 10; d++) {
  const slice = rows.slice(d * decileSize, (d + 1) * decileSize)
  if (!slice.length) continue
  const minSize = Number(slice[0].capital_at_risk)
  const maxSize = Number(slice[slice.length - 1].capital_at_risk)
  const wins = slice.filter(r => r.result === 'win').length
  const wr = wins / slice.length
  const pnl = slice.reduce((s, r) => s + Number(r.pnl ?? 0), 0)
  const risk = slice.reduce((s, r) => s + Number(r.capital_at_risk ?? 0), 0)
  const roi = risk > 0 ? pnl / risk : 0
  console.log(`   D${d + 1}      $${minSize.toFixed(2)}-$${maxSize.toFixed(2)}    ${rpad(slice.length, 4)}   ${pct(wr).padStart(6)}     ${$(pnl).padStart(9)}   ${pct(roi).padStart(6)}`)
}

// ── 7. Top winners and losers ─────────────────────────────────────────────
console.log('\n── 7. PITCHER WINNERS & LOSERS (≥3 bets, last 30 days) ──')
const pitchers = await db.execute(`
  SELECT pitcher_name,
    COUNT(*) AS n,
    SUM(CASE WHEN result='win' THEN 1 ELSE 0 END) AS wins,
    ROUND(SUM(pnl), 2) AS pnl,
    ROUND(SUM(capital_at_risk), 2) AS risk,
    ROUND(AVG(model_prob), 3) AS avg_claim
  FROM ks_bets
  WHERE bet_date >= date('now','-30 days')
    AND live_bet = 0 AND side = 'YES' AND result IN ('win','loss')
  GROUP BY pitcher_name HAVING n >= 3
  ORDER BY pnl DESC
`)
const top10 = pitchers.rows.slice(0, 10)
const bot10 = pitchers.rows.slice(-10).reverse()
console.log('\n   TOP 10 (most profitable):')
for (const r of top10) console.log(`     ${pad(r.pitcher_name, 22)} n=${r.n} wins=${r.wins} pnl=${$(r.pnl)} (claim ${pct(Number(r.avg_claim))})`)
console.log('\n   BOTTOM 10 (most unprofitable):')
for (const r of bot10) console.log(`     ${pad(r.pitcher_name, 22)} n=${r.n} wins=${r.wins} pnl=${$(r.pnl)} (claim ${pct(Number(r.avg_claim))})`)

// ── 8. Aggregate totals ───────────────────────────────────────────────────
console.log('\n── 8. AGGREGATE — last 30 days ──')
const tot = await db.execute(`
  SELECT
    SUM(CASE WHEN side='YES' THEN 1 ELSE 0 END) AS yes_n,
    SUM(CASE WHEN side='NO'  THEN 1 ELSE 0 END) AS no_n,
    SUM(CASE WHEN side='YES' AND result='win' THEN 1 ELSE 0 END) AS yes_w,
    SUM(CASE WHEN side='NO'  AND result='win' THEN 1 ELSE 0 END) AS no_w,
    ROUND(SUM(CASE WHEN side='YES' THEN pnl END), 2) AS yes_pnl,
    ROUND(SUM(CASE WHEN side='NO'  THEN pnl END), 2) AS no_pnl,
    ROUND(SUM(CASE WHEN side='YES' THEN capital_at_risk END), 2) AS yes_risk,
    ROUND(SUM(CASE WHEN side='NO'  THEN capital_at_risk END), 2) AS no_risk
  FROM ks_bets
  WHERE bet_date >= date('now','-30 days')
    AND live_bet = 0 AND result IN ('win','loss')
`)
const t = tot.rows[0]
console.log(`   YES: ${t.yes_n} fires, ${t.yes_w}W, ${$(t.yes_pnl)} on ${$(t.yes_risk)} risk (ROI ${pct(t.yes_risk > 0 ? t.yes_pnl/t.yes_risk : 0)})`)
console.log(`   NO:  ${t.no_n} fires, ${t.no_w}W, ${$(t.no_pnl ?? 0)} on ${$(t.no_risk ?? 0)} risk (ROI ${pct(t.no_risk > 0 ? (t.no_pnl ?? 0)/t.no_risk : 0)})`)
const totPnl = Number(t.yes_pnl ?? 0) + Number(t.no_pnl ?? 0)
const totRisk = Number(t.yes_risk ?? 0) + Number(t.no_risk ?? 0)
console.log(`   COMBINED: ${$(totPnl)} on ${$(totRisk)} risk (ROI ${pct(totRisk > 0 ? totPnl/totRisk : 0)})`)

console.log('\n' + '═'.repeat(92))
