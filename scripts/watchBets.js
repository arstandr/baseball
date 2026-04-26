// scripts/watchBets.js — Real-time bet monitor. Polls Railway DB every 30s.
//
// Usage: node scripts/watchBets.js [--interval 30]
//
// Shows:
//   • bet_schedule status (pending/fired/done/error) per pitcher
//   • Kelly fractions, edges, sizes for today's bets
//   • Live P&L on settled bets
//   • Any errors or anomalies flagged in red

import 'dotenv/config'
import * as db from '../lib/db.js'
import { parseArgs } from '../lib/cli-args.js'

const opts    = parseArgs({ interval: { type: 'number', default: 30 } })
const REFRESH = opts.interval * 1000

const R = '\x1b[31m', Y = '\x1b[33m', G = '\x1b[32m', C = '\x1b[36m', B = '\x1b[1m', DIM = '\x1b[2m', RST = '\x1b[0m'

function etNow() {
  return new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false,
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function etDate() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
}

function bar(used, total, width = 20) {
  const pct   = Math.min(1, total > 0 ? used / total : 0)
  const filled = Math.round(pct * width)
  const color  = pct > 0.90 ? R : pct > 0.60 ? Y : G
  return color + '█'.repeat(filled) + DIM + '░'.repeat(width - filled) + RST
}

function pnlColor(n) {
  return n > 0 ? G : n < 0 ? R : DIM
}

async function render() {
  const TODAY = etDate()

  // ── Bettors ───────────────────────────────────────────────────────────────
  const bettors = await db.all(
    `SELECT id, name, starting_bankroll, kalshi_key_id,
            pregame_risk_pct, live_daily_risk_pct, free_money_risk_pct, paper
     FROM users WHERE active_bettor = 1 ORDER BY id`,
  )

  // ── Today ks_bets ─────────────────────────────────────────────────────────
  const bets = await db.all(
    `SELECT user_id, pitcher_name, strike, side, edge, model_prob, market_mid,
            kelly_fraction, bet_size, capital_at_risk, order_id, order_status, result, pnl,
            logged_at, live_bet
     FROM ks_bets
     WHERE bet_date = ? ORDER BY logged_at ASC`,
    [TODAY],
  )
  const pregameLive  = bets.filter(b => b.live_bet === 0 && b.paper === 0)
  const settled      = pregameLive.filter(b => b.result && b.result !== 'void')
  const open         = pregameLive.filter(b => !b.result || b.result === 'void')
  const totalRisk    = pregameLive.reduce((s, b) => s + (b.capital_at_risk || 0), 0)
  const settledPnl   = settled.reduce((s, b) => s + (b.pnl || 0), 0)
  const noKellyBets  = pregameLive.filter(b => b.live_bet === 0 && (b.kelly_fraction === null || b.kelly_fraction === 0))

  // ── bet_schedule ──────────────────────────────────────────────────────────
  const sched = await db.all(
    `SELECT bs.id, bs.pitcher_name, bs.game_label, bs.game_time, bs.status,
            bs.fired_at, bs.notes, bs.preflight,
            g.status as game_status
     FROM bet_schedule bs
     LEFT JOIN games g ON g.id = bs.game_id
     WHERE bs.bet_date = ?
     ORDER BY bs.game_time ASC`,
    [TODAY],
  )
  const pending = sched.filter(s => s.status === 'pending')
  const done    = sched.filter(s => s.status === 'done')
  const errors  = sched.filter(s => s.status === 'error')
  const skipped = sched.filter(s => s.status === 'skipped')

  // ── daily_plan ────────────────────────────────────────────────────────────
  const plan = await db.one(`SELECT * FROM daily_plan WHERE bet_date = ?`, [TODAY]).catch(() => null)

  // ── Balance snapshots ─────────────────────────────────────────────────────
  const snaps = await db.all(
    `SELECT user_id, balance_usd FROM balance_snapshots WHERE date = ?`, [TODAY],
  ).catch(() => [])
  const snapMap = {}
  for (const s of snaps) snapMap[s.user_id] = s.balance_usd

  // ── Render ────────────────────────────────────────────────────────────────
  process.stdout.write('\x1Bc')  // clear terminal

  const W = 80
  console.log(B + '═'.repeat(W) + RST)
  console.log(B + ` LIVE BET MONITOR  ${etNow()} ET  (refreshing every ${opts.interval}s)` + RST)
  console.log(B + '═'.repeat(W) + RST)

  // ── Bettor summary ────────────────────────────────────────────────────────
  console.log(`\n${B}── BETTORS ──────────────────────────────────────────────────────────────────${RST}`)
  for (const u of bettors) {
    const snap       = snapMap[u.id]
    const bankroll   = snap ?? u.starting_bankroll ?? 5000
    const pregPct    = u.pregame_risk_pct ?? 0.60
    const pregPool   = bankroll * pregPct
    const myRisk     = pregameLive.filter(b => b.user_id === u.id).reduce((s, b) => s + (b.capital_at_risk || 0), 0)
    const myPnl      = settled.filter(b => b.user_id === u.id).reduce((s, b) => s + (b.pnl || 0), 0)
    const pctUsed    = pregPool > 0 ? myRisk / pregPool : 0
    const pnlStr     = pnlColor(myPnl) + (myPnl >= 0 ? '+' : '') + myPnl.toFixed(2) + RST
    console.log(
      `  ${B}${u.name.padEnd(14)}${RST} ${u.paper ? DIM+'paper'+RST : G+'LIVE'+RST} ` +
      `bal=$${bankroll.toFixed(0).padStart(6)}  pregame pool $${pregPool.toFixed(0).padStart(5)}  ` +
      `risk $${myRisk.toFixed(0).padStart(4)} ${bar(myRisk, pregPool, 15)} ${(pctUsed*100).toFixed(0).padStart(3)}%  P&L ${pnlStr}`,
    )
  }

  // ── daily_plan guard ──────────────────────────────────────────────────────
  if (!plan) {
    console.log(`\n  ${Y}⚠ daily_plan NOT created yet — bets will hold until morning pipeline completes${RST}`)
  } else {
    console.log(`\n  ${G}✓ daily_plan exists${RST}  pregame_pool=$${plan.pregame_pool?.toFixed(0) ?? '?'}  total_edge=${plan.total_edge_weighted?.toFixed(3) ?? '?'}`)
  }

  // ── Schedule grid ─────────────────────────────────────────────────────────
  console.log(`\n${B}── BET SCHEDULE  ${done.length} done / ${pending.length} pending / ${skipped.length} skipped / ${errors.length} error ──────────────${RST}`)

  for (const s of sched) {
    const gameEt = s.game_time
      ? new Date(s.game_time).toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false })
      : '??:??'
    const statusStr = {
      done:    G + '✓ done   ' + RST,
      pending: Y + '⏳ pending' + RST,
      fired:   C + '⚡ fired  ' + RST,
      skipped: DIM + '– skipped' + RST,
      error:   R + '✗ error  ' + RST,
    }[s.status] ?? DIM + s.status.padEnd(9) + RST

    let note = ''
    if (s.status === 'error' && s.notes) note = R + `  ← ${s.notes.slice(0, 40)}` + RST
    if (s.status === 'skipped' && s.notes) note = DIM + `  ← ${s.notes.slice(0, 40)}` + RST
    if (s.preflight === 'skip') note += Y + ' [preflight skip]' + RST
    if (s.preflight === 'boost') note += G + ' [preflight boost]' + RST

    console.log(`  ${statusStr} ${gameEt}  ${s.pitcher_name.padEnd(24)} ${(s.game_label || '').slice(0, 15).padEnd(15)}${note}`)
  }

  // ── Today's bets ──────────────────────────────────────────────────────────
  console.log(`\n${B}── TODAY'S BETS  ${pregameLive.length} total · $${totalRisk.toFixed(2)} risk · P&L ${pnlColor(settledPnl)}${settledPnl >= 0 ? '+' : ''}$${settledPnl.toFixed(2)}${RST}${B} ─────────${RST}`)

  // Group by pitcher
  const byPitcher = new Map()
  for (const b of pregameLive) {
    const key = b.pitcher_name
    if (!byPitcher.has(key)) byPitcher.set(key, [])
    byPitcher.get(key).push(b)
  }

  for (const [pitcher, pbets] of byPitcher) {
    const pitcherRisk = pbets.reduce((s, b) => s + (b.capital_at_risk || 0), 0)
    const pitcherPnl  = pbets.filter(b => b.result).reduce((s, b) => s + (b.pnl || 0), 0)
    const allSettled  = pbets.every(b => b.result && b.result !== 'void')
    const pnlStr      = allSettled
      ? pnlColor(pitcherPnl) + (pitcherPnl >= 0 ? '+' : '') + '$' + pitcherPnl.toFixed(2) + RST
      : DIM + 'open' + RST

    console.log(`\n  ${B}${pitcher}${RST}  risk=$${pitcherRisk.toFixed(2)}  ${pnlStr}`)
    for (const b of pbets.sort((a, z) => a.strike - z.strike)) {
      const kf        = b.kelly_fraction != null ? (b.kelly_fraction * 100).toFixed(2) + '%' : R + 'NULL' + RST
      const kfColor   = (!b.kelly_fraction || b.kelly_fraction === 0) ? R : ''
      const resultStr = b.result
        ? (b.result === 'win' ? G + 'W' : b.result === 'loss' ? R + 'L' : DIM + b.result) + RST
        : DIM + '?' + RST
      const ordStr    = b.order_id ? G + '✓' + RST : R + '✗' + RST
      const anomaly   = !b.order_id ? R + ' ← NO ORDER ID' + RST :
                        (!b.kelly_fraction || b.kelly_fraction === 0) ? Y + ' ← kf=0 (old sizing)' + RST : ''

      console.log(
        `    ${String(b.strike).padStart(2)}+${b.side.padEnd(4)} ` +
        `edge=${b.edge?.toFixed(3) ?? '?'}  mkt=${String(b.market_mid).padStart(3)}  mp=${b.model_prob?.toFixed(3) ?? '?'} ` +
        `kf=${kfColor}${kf}${kfColor ? RST : ''}  ` +
        `size=${String(b.bet_size).padStart(4)}c  risk=$${(b.capital_at_risk || 0).toFixed(2).padStart(6)}  ` +
        `ord=${ordStr}  [${resultStr}]${anomaly}`,
      )
    }
  }

  // ── Anomalies section ─────────────────────────────────────────────────────
  const anomalies = []

  if (errors.length > 0 && !errors.every(e => e.notes?.includes('recovered-done'))) {
    const realErrors = errors.filter(e => !e.notes?.includes('recovered-done'))
    if (realErrors.length) anomalies.push(`${R}✗ ${realErrors.length} bet_schedule error(s):${RST}`)
    for (const e of realErrors) anomalies.push(`  ${R}→ ${e.pitcher_name}: ${e.notes?.slice(0, 80) ?? 'no notes'}${RST}`)
  }

  if (noKellyBets.length > 0) {
    anomalies.push(`${Y}⚠ ${noKellyBets.length} bet(s) with kf=0 (placed by old sizing system — not a live error)${RST}`)
  }

  const betsWithoutOrders = pregameLive.filter(b => !b.order_id)
  if (betsWithoutOrders.length > 0) {
    anomalies.push(`${R}✗ ${betsWithoutOrders.length} bet(s) missing Kalshi order_id:${RST}`)
    for (const b of betsWithoutOrders) anomalies.push(`  ${R}→ ${b.pitcher_name} ${b.strike}+${b.side}${RST}`)
  }

  if (!plan && new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }) >= 9) {
    anomalies.push(`${R}✗ daily_plan missing after 9am ET — morning pipeline may have failed${RST}`)
  }

  if (anomalies.length) {
    console.log(`\n${B}── ANOMALIES ────────────────────────────────────────────────────────────────${RST}`)
    for (const a of anomalies) console.log(a)
  } else {
    console.log(`\n  ${G}✓ No anomalies detected${RST}`)
  }

  console.log(`\n${DIM}${'─'.repeat(W)}${RST}`)
  console.log(`${DIM}Next refresh in ${opts.interval}s  ·  Ctrl+C to stop  ·  Railway logs: ! railway logs --follow${RST}`)
}

async function main() {
  await db.migrate()
  while (true) {
    try {
      await render()
    } catch (err) {
      process.stdout.write('\x1Bc')
      console.error(`[watchBets] render error: ${err.message}`)
      console.log(err.stack)
    }
    await new Promise(r => setTimeout(r, REFRESH))
  }
}

main().catch(err => { console.error(err); process.exit(1) })
