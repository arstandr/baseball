// No-lookahead replay of the fade model over a recent window.
//
// ⚠️ NOTE (2026-05-12): this script reads `market_snapshots` (the argus 12:00-ET
// pre-game scan) — that is NOT the same universe the fade model fires on
// (fireFadeModel.mjs pulls live orderbooks at T-60min and uses its own NB r=8 λ).
// On a recent run it only matched ~6 of the 65 actual fade fires → tiny, mismatched
// sample, not a real test. The PROPER source is `fade_fire_snapshots`, which
// fireFadeModel.mjs began writing 2026-05-12 (every strike's fire-time ask + model
// λ/prob/edge + confidence + variant). Once that table has ≥2–3 weeks of rows, this
// script should be pointed at it (join actual_ks from ks_bets / MLB API). Until then
// the real no-lookahead record is just the live ks_bets rows for strategy_mode=
// 'pregame_fade_yes' — those bets were placed pre-game, so no future bias is possible.
//
// "No BS": for each pitcher-day we use ONLY the pre-game ladder snapshot (yes_ask +
// the live model_prob computed at capture time, ~12:00 ET, before lineups) and the
// pitcher_signals row for that date. We re-run v1h's selection logic on that, then
// score against actual_ks (the resolved outcome). Nothing from after the snapshot is
// used to pick the bet. Compares v1h (live default), v1 (no H-I), v3 (full filters).
//
// Default window: 2026-05-07 .. 2026-05-12 (the fade paper-test era so far).
//
// Usage:  railway run node scripts/replayFadeNoLookahead.mjs [--from YYYY-MM-DD] [--to YYYY-MM-DD]

import 'dotenv/config'
import { createClient } from '@libsql/client'

const argv = process.argv.slice(2)
const arg = (name, def) => { const i = argv.indexOf(name); return i > 0 ? argv[i + 1] : def }
const FROM = arg('--from', '2026-05-07')
const TO   = arg('--to',   '2026-05-12')

const FEE = 0.07, FIXED_BASE = 5000, SIZE_PCT = 0.01, SIZE_EDGE_MAX = 5
const MIN_EDGE = 0.05, MAX_EDGE = 0.20, MAX_ASK = 50, MIN_STRIKE = 6
const SLIPPAGE_C = 1, CAP_PER_BET = 100

const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })

// ── Pull the LAST pre-game snapshot per (ticker, game_date) in the window ────
const snapRows = await db.execute({
  sql: `SELECT ms.game_date, ms.pitcher_id, ms.pitcher_name, ms.ticker, ms.strike,
               ms.yes_ask, ms.model_prob, ms.volume, ms.actual_ks
        FROM market_snapshots ms
        JOIN (
          SELECT ticker, game_date, MAX(captured_at) AS mc
          FROM market_snapshots
          WHERE eval_mode = 'pre-game' AND game_date BETWEEN ? AND ?
          GROUP BY ticker, game_date
        ) last ON last.ticker = ms.ticker AND last.game_date = ms.game_date AND last.mc = ms.captured_at
        WHERE ms.eval_mode = 'pre-game'`,
  args: [FROM, TO],
})

// actual_ks may be null on the snapshot row but set on a later (post-game) row — backfill
const aksRows = await db.execute({
  sql: `SELECT pitcher_id, game_date, MAX(actual_ks) AS aks FROM market_snapshots
        WHERE game_date BETWEEN ? AND ? AND actual_ks IS NOT NULL GROUP BY pitcher_id, game_date`,
  args: [FROM, TO],
})
const aksMap = new Map(aksRows.rows.map(r => [`${r.pitcher_id}|${r.game_date}`, Number(r.aks)]))

// pitcher_signals for the H-I confidence filter
const sigRows = await db.execute({
  sql: `SELECT pitcher_id, signal_date, confidence FROM pitcher_signals WHERE signal_date BETWEEN ? AND ?`,
  args: [FROM, TO],
})
const sigMap = new Map(sigRows.rows.map(r => [`${r.pitcher_id}|${r.signal_date}`, r.confidence]))

// ── Group snapshots into per-pitcher-day ladders ────────────────────────────
const games = new Map()  // key = pitcher_id|game_date
for (const r of snapRows.rows) {
  const key = `${r.pitcher_id}|${r.game_date}`
  if (!games.has(key)) games.set(key, { pitcher_id: r.pitcher_id, name: r.pitcher_name, date: r.game_date, ladder: [], aks: null })
  const g = games.get(key)
  g.ladder.push({ strike: Number(r.strike), ask: Number(r.yes_ask), modelProb: Number(r.model_prob), vol: Number(r.volume ?? 0) })
  if (r.actual_ks != null) g.aks = Number(r.actual_ks)
}
for (const g of games.values()) {
  if (g.aks == null) g.aks = aksMap.get(`${g.pitcher_id}|${g.date}`) ?? null
}

console.log(`\n═══ No-lookahead fade replay — ${FROM} .. ${TO} ═══`)
console.log(`Pitcher-days with a pre-game ladder snapshot: ${games.size}`)
console.log(`Sizing: flat 1%×edge-mult off fixed $${FIXED_BASE}, $${CAP_PER_BET}/bet cap, ${SLIPPAGE_C}¢ slippage, ${(FEE*100)|0}% fee.`)
console.log(`Bet = best YES candidate w/ edge ∈ [${MIN_EDGE},${MAX_EDGE}], ask ∈ [3,${MAX_ASK}]¢, strike ≥ ${MIN_STRIKE}.\n`)

function replay(variant) {
  const USE_HI = variant === 'v1h' || variant === 'v3'
  const USE_HH = false                       // can't recompute avg_innings_l5 from snapshots; H-H not testable here
  const STRIKE_SPLIT = variant === 'v3'
  const bets = []
  let skippedHI = 0, skippedNoAks = 0, noCand = 0
  for (const g of games.values()) {
    if (g.aks == null) { skippedNoAks++; continue }
    if (USE_HI) {
      const conf = sigMap.get(`${g.pitcher_id}|${g.date}`)
      if (conf != null && Number(conf) <= 0.3) { skippedHI++; continue }
    }
    const elig = g.ladder.filter(l => l.ask >= 3 && l.ask <= MAX_ASK && l.strike >= MIN_STRIKE
      && (l.modelProb - l.ask / 100) >= MIN_EDGE && (l.modelProb - l.ask / 100) <= MAX_EDGE)
      .map(l => ({ ...l, edge: l.modelProb - l.ask / 100 }))
    let pick = []
    if (STRIKE_SPLIT) {
      const f = elig.filter(l => l.strike === 6).sort((a, b) => b.edge - a.edge)[0]
      const t = elig.filter(l => l.strike >= 10).sort((a, b) => b.edge - a.edge)[0]
      pick = [f, t].filter(Boolean)
    } else {
      const best = elig.sort((a, b) => b.edge - a.edge)[0]
      pick = best ? [best] : []
    }
    if (!pick.length) { noCand++; continue }
    for (const c of pick) {
      const entry = Math.min(99, c.ask + SLIPPAGE_C)
      const edgeMult = Math.min(SIZE_EDGE_MAX, 1 + (c.edge - MIN_EDGE) / MIN_EDGE)
      const wantUsd = Math.min(CAP_PER_BET, FIXED_BASE * SIZE_PCT * edgeMult)
      const contracts = Math.max(1, Math.floor(wantUsd / (entry / 100)))
      const stake = contracts * (entry / 100)
      const won = g.aks >= c.strike
      const pnl = won ? contracts * ((100 - entry) / 100) * (1 - FEE) : -stake
      bets.push({ date: g.date, name: g.name, strike: c.strike, ask: c.ask, edge: c.edge, won, stake, pnl })
    }
  }
  return { bets, skippedHI, skippedNoAks, noCand }
}

function report(variant) {
  const { bets, skippedHI, skippedNoAks, noCand } = replay(variant)
  const n = bets.length, w = bets.filter(b => b.won).length
  const pnl = bets.reduce((s, b) => s + b.pnl, 0), stake = bets.reduce((s, b) => s + b.stake, 0)
  const roi = stake > 0 ? pnl / stake * 100 : 0
  const days = new Set(bets.map(b => b.date)).size || 1
  console.log(`── ${variant} ──  (skipped: ${skippedNoAks} no-outcome, ${skippedHI} H-I, ${noCand} no-candidate)`)
  console.log(`  ${n} bets · ${w}W (${(w/n*100||0).toFixed(0)}% win) · staked $${stake.toFixed(0)} · P&L ${pnl>=0?'+':''}$${pnl.toFixed(2)} · per-bet ROI ${roi>=0?'+':''}${roi.toFixed(0)}% · ${pnl>=0?'+':''}$${(pnl/days).toFixed(0)}/day`)
  // per-day
  const byDay = new Map()
  for (const b of bets) { const c = byDay.get(b.date) ?? { n: 0, w: 0, pnl: 0 }; c.n++; if (b.won) c.w++; c.pnl += b.pnl; byDay.set(b.date, c) }
  for (const [d, v] of [...byDay].sort()) console.log(`    ${d}: ${v.n} bets (${v.w}W) ${v.pnl>=0?'+':''}$${v.pnl.toFixed(2)}`)
  // per strike bucket
  const sb = new Map()
  for (const b of bets) { const k = b.strike === 6 ? 'K=6' : (b.strike <= 9 ? 'K=7-9' : 'K≥10'); const v = sb.get(k) ?? { n: 0, w: 0, pnl: 0, stake: 0 }; v.n++; if (b.won) v.w++; v.pnl += b.pnl; v.stake += b.stake; sb.set(k, v) }
  console.log(`    by strike:`)
  for (const [k, v] of [...sb].sort()) console.log(`      ${k.padEnd(8)} ${v.n} bets · ${v.w}W (${(v.w/v.n*100).toFixed(0)}%) · ${v.pnl>=0?'+':''}$${v.pnl.toFixed(2)} · ${v.stake>0?(v.pnl/v.stake*100>=0?'+':'')+(v.pnl/v.stake*100).toFixed(0)+'%':'—'} ROI`)
  // per ask bucket
  const ab = new Map()
  for (const b of bets) { const k = b.ask <= 10 ? 'ask ≤10¢' : (b.ask <= 25 ? 'ask 11-25¢' : 'ask 26-50¢'); const v = ab.get(k) ?? { n: 0, w: 0, pnl: 0, stake: 0 }; v.n++; if (b.won) v.w++; v.pnl += b.pnl; v.stake += b.stake; ab.set(k, v) }
  console.log(`    by ask:`)
  for (const [k, v] of [...ab].sort()) console.log(`      ${k.padEnd(11)} ${v.n} bets · ${v.w}W (${(v.w/v.n*100).toFixed(0)}%) · ${v.pnl>=0?'+':''}$${v.pnl.toFixed(2)} · ${v.stake>0?(v.pnl/v.stake*100>=0?'+':'')+(v.pnl/v.stake*100).toFixed(0)+'%':'—'} ROI`)
  console.log()
}

report('v1')
report('v1h')
report('v3')

// ── Cross-check: what the live system ACTUALLY fired & made over the same window ──
const actual = await db.execute({
  sql: `SELECT bet_date, COUNT(*) n, SUM(CASE WHEN result='win' THEN 1 ELSE 0 END) w,
               ROUND(SUM(CASE WHEN result IN ('win','loss') THEN pnl ELSE 0 END),2) pnl
        FROM ks_bets WHERE strategy_mode='pregame_fade_yes' AND bet_date BETWEEN ? AND ?`,
  args: [FROM, TO],
})
const a = actual.rows[0]
console.log(`── ACTUAL live fires (ks_bets, whatever variant was live: v1→v2→v3) ──`)
console.log(`  ${a.n} bets · ${a.w}W · P&L ${a.pnl>=0?'+':''}$${a.pnl}`)
console.log()
console.log('Notes: model_prob is the live model\'s pre-game estimate at snapshot time — no future data.')
console.log('H-H is not testable here (needs avg_innings_l5 recomputed; snapshots don\'t carry it).')
console.log('Fills assume you got ~the recorded pre-game ask + 1¢ — still optimistic on thin tails.')
process.exit(0)
