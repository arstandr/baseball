// Daily fade-model paper test progress report.
// Reads ks_bets WHERE strategy_mode='pregame_fade_yes', computes:
//   - Cumulative fires, win rate, ROI, P&L
//   - Day count toward milestones
//   - Per-pitcher breakdown (last 7 days)
//   - Posts to Discord

import 'dotenv/config'
import { createClient } from '@libsql/client'

const STARTING_BANKROLL = 5000
const DISCORD_WEBHOOK = process.env.FADE_DISCORD_WEBHOOK || process.env.DISCORD_PERSONAL_WEBHOOK
const TEST_START_DATE = '2026-05-07'  // Day 1 of paper test

const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })

async function main() {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })

  // Cumulative stats from start of test
  const cum = await db.execute({
    sql: `SELECT
      COUNT(*) AS fires,
      SUM(CASE WHEN result='win' THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN result='loss' THEN 1 ELSE 0 END) AS losses,
      SUM(CASE WHEN result IS NULL OR result='pending' THEN 1 ELSE 0 END) AS pending,
      ROUND(SUM(CASE WHEN result IN ('win','loss') THEN pnl ELSE 0 END), 2) AS total_pnl,
      ROUND(SUM(CASE WHEN result IN ('win','loss') THEN filled_contracts * fill_price / 100 ELSE 0 END), 2) AS total_stake
      FROM ks_bets WHERE strategy_mode='pregame_fade_yes' AND bet_date >= ?`,
    args: [TEST_START_DATE],
  })
  const c = cum.rows[0]
  const settled = Number(c.wins) + Number(c.losses)
  const winPct = settled > 0 ? (Number(c.wins) / settled * 100) : 0
  const roi = Number(c.total_stake) > 0 ? (Number(c.total_pnl) / Number(c.total_stake) * 100) : 0
  const bankroll = STARTING_BANKROLL + Number(c.total_pnl ?? 0)
  const ret = (bankroll / STARTING_BANKROLL - 1) * 100

  // Today's fires
  const tod = await db.execute({
    sql: `SELECT pitcher_name, strike, fill_price, filled_contracts, model_prob, edge, result, pnl
          FROM ks_bets WHERE strategy_mode='pregame_fade_yes' AND bet_date = ? ORDER BY logged_at`,
    args: [today],
  })

  // Per-day P&L last 7 days
  const recent = await db.execute({
    sql: `SELECT bet_date,
      COUNT(*) AS n,
      SUM(CASE WHEN result='win' THEN 1 ELSE 0 END) AS w,
      ROUND(SUM(CASE WHEN result IN ('win','loss') THEN pnl ELSE 0 END), 2) AS pnl
      FROM ks_bets WHERE strategy_mode='pregame_fade_yes' AND bet_date >= ?
      GROUP BY bet_date ORDER BY bet_date`,
    args: [TEST_START_DATE],
  })

  // Strike-bucket breakdown — K=6 (favorite fade), K=7-9 (mid), K≥10 (long-tail convexity).
  // Per ChatGPT 2026-05-12: K=6 and K≥10 are different products — separate hit-rate
  // expectations and promotion criteria. Track them apart.
  const byStrike = await db.execute({
    sql: `SELECT
      CASE WHEN strike = 6 THEN 'K=6 (favorite fade)'
           WHEN strike BETWEEN 7 AND 9 THEN 'K=7-9 (mid)'
           ELSE 'K≥10 (tail convexity)' END AS bucket,
      COUNT(*) AS n,
      SUM(CASE WHEN result='win' THEN 1 ELSE 0 END) AS w,
      SUM(CASE WHEN result='loss' THEN 1 ELSE 0 END) AS l,
      ROUND(SUM(CASE WHEN result IN ('win','loss') THEN pnl ELSE 0 END), 2) AS pnl,
      ROUND(SUM(CASE WHEN result IN ('win','loss') THEN filled_contracts * fill_price / 100 ELSE 0 END), 2) AS stake
      FROM ks_bets WHERE strategy_mode='pregame_fade_yes' AND bet_date >= ?
      GROUP BY bucket ORDER BY MIN(strike)`,
    args: [TEST_START_DATE],
  })

  // Ask-bucket breakdown — P&L by entry price. Per ChatGPT 2026-05-12: the real edge
  // may be "cheap tails only" (ask ≤ 25¢) rather than the model. Surface it.
  const byAsk = await db.execute({
    sql: `SELECT
      CASE WHEN fill_price <= 10 THEN 'ask ≤ 10¢'
           WHEN fill_price <= 25 THEN 'ask 11-25¢'
           ELSE 'ask 26-50¢' END AS bucket,
      COUNT(*) AS n,
      SUM(CASE WHEN result='win' THEN 1 ELSE 0 END) AS w,
      SUM(CASE WHEN result='loss' THEN 1 ELSE 0 END) AS l,
      ROUND(SUM(CASE WHEN result IN ('win','loss') THEN pnl ELSE 0 END), 2) AS pnl,
      ROUND(SUM(CASE WHEN result IN ('win','loss') THEN filled_contracts * fill_price / 100 ELSE 0 END), 2) AS stake
      FROM ks_bets WHERE strategy_mode='pregame_fade_yes' AND bet_date >= ?
      GROUP BY bucket ORDER BY MIN(fill_price)`,
    args: [TEST_START_DATE],
  })

  const daysIn = Math.floor((Date.parse(today) - Date.parse(TEST_START_DATE)) / 86400000) + 1
  const milestone = daysIn < 7 ? 'pre-Day-7' :
                    daysIn < 14 ? 'Day-7 → Day-14' :
                    daysIn < 30 ? 'Day-14 → Day-30' : 'Day-30+'

  // Build report
  const lines = []
  lines.push(`📊 **FADE MODEL PAPER TEST — Day ${daysIn}** (${milestone})`)
  lines.push(`Bankroll: $${bankroll.toFixed(0)} (${ret >= 0 ? '+' : ''}${ret.toFixed(1)}%)`)
  lines.push(`Fires: ${c.fires} (${c.wins}W / ${c.losses}L / ${c.pending} pending)`)
  if (settled > 0) {
    lines.push(`Win rate: ${winPct.toFixed(1)}% · Per-bet ROI: ${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%`)
    lines.push(`Total P&L: ${c.total_pnl >= 0 ? '+' : ''}$${Number(c.total_pnl).toFixed(2)} on $${Number(c.total_stake).toFixed(0)} staked`)
  }

  if (tod.rows.length > 0) {
    lines.push('')
    lines.push(`**Today's fires:**`)
    for (const f of tod.rows) {
      const status = f.result === 'win' ? '✅ WIN' :
                     f.result === 'loss' ? '❌ LOSS' :
                     '⏳ pending'
      const pnl = f.pnl != null ? ` (${f.pnl >= 0 ? '+' : ''}$${Number(f.pnl).toFixed(2)})` : ''
      lines.push(`  ${f.pitcher_name} K≥${f.strike} @ ${f.fill_price}¢ × ${f.filled_contracts}c — edge +${(Number(f.edge)*100).toFixed(1)}c — ${status}${pnl}`)
    }
  }

  if (recent.rows.length > 1) {
    lines.push('')
    lines.push(`**Daily P&L:**`)
    for (const r of recent.rows) {
      const pnl = Number(r.pnl ?? 0)
      lines.push(`  ${r.bet_date}: ${r.n} fires (${r.w}W) — ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`)
    }
  }

  // Helper to render a bucket row: name — n fires, win%, P&L, per-bet ROI
  const bucketLine = (b) => {
    const n = Number(b.n), w = Number(b.w), l = Number(b.l)
    const s = w + l
    const wp = s > 0 ? (w / s * 100).toFixed(0) + '%' : '—'
    const pnl = Number(b.pnl ?? 0), stake = Number(b.stake ?? 0)
    const r = stake > 0 ? (pnl / stake * 100) : 0
    return `  ${String(b.bucket).padEnd(22)} ${String(n).padStart(3)} fires · ${s}W/L · ${wp.padStart(4)} win · ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${r >= 0 ? '+' : ''}${r.toFixed(0)}% ROI)`
  }

  if (byStrike.rows.length > 0) {
    lines.push('')
    lines.push(`**By strike bucket** (K=6 favorite-fade vs K≥10 tail are different trades):`)
    for (const b of byStrike.rows) lines.push(bucketLine(b))
  }
  if (byAsk.rows.length > 0) {
    lines.push('')
    lines.push(`**By ask price** (is the edge just cheap tails?):`)
    for (const b of byAsk.rows) lines.push(bucketLine(b))
  }

  // Milestone gate hints
  if (daysIn === 7) {
    lines.push('')
    lines.push(`🎯 **DAY 7 SANITY CHECK**: Win rate ≥25%? Direction positive?`)
    lines.push(`  Currently: ${winPct.toFixed(1)}% win, ${roi >= 0 ? '+' : ''}${roi.toFixed(1)}% ROI`)
  }
  if (daysIn === 14) {
    lines.push('')
    lines.push(`🎯 **DAY 14 DECISION POINT**: Real-money go/no-go`)
    lines.push(`  Backtest target: ROI within 50% of +127% test backtest`)
    lines.push(`  Currently: ${roi >= 0 ? '+' : ''}${roi.toFixed(1)}% ROI`)
  }

  const report = lines.join('\n')
  console.log(report)

  if (DISCORD_WEBHOOK) {
    await fetch(DISCORD_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: report }),
    }).catch(() => {})
  }
}

main().catch(err => { console.error(err); process.exit(1) })
