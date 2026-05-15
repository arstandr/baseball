#!/usr/bin/env node
// scripts/replayFadeMultiVariant.mjs
//
// Multi-variant fade backtest using market_snapshots ladder.
// Replays v3 / v1h / pkLight over a configurable date window with
// fade-pipeline-correct math (NB r=8, lambda from last 5 starts) and
// production-realistic liquidity caps.
//
// Usage:
//   node scripts/replayFadeMultiVariant.mjs                          # default: rolling 28-day window ending today
//   node scripts/replayFadeMultiVariant.mjs --from 2026-04-27 --to 2026-05-15
//   node scripts/replayFadeMultiVariant.mjs --json /tmp/out.json     # write results to JSON
//   node scripts/replayFadeMultiVariant.mjs --discord                # post summary to FADE_DISCORD_WEBHOOK
//
// Methodology (corrected per audit/v3-postmortem-may15):
//   M-fix: model_prob uses fade pipeline's NB(r=8) + lambda from last 5 starts
//          (NOT market_snapshots.model_prob which uses archetype r=20-50).
//   K-fix: snapshots from 09:00-11:00 ET window (fade-cron fire time).
//   L-fix: stake capped at 10% of depth (= MAX_PCT_OF_VOLUME in production).
//
// Validation invariant (before flipping FADE_VARIANT):
//   Any variant change must beat the active variant by >= +$800 over a
//   >= 14-day window with bootstrap P(positive delta) >= 95%.

import { createClient } from '@libsql/client'
import { parseArgs } from '../lib/cli-args.js'

const opts = parseArgs({
  from:    { flag: 'from', type: 'string', default: null },
  to:      { flag: 'to',   type: 'string', default: null },
  json:    { flag: 'json', type: 'string', default: null },
  discord: { flag: 'discord', type: 'boolean', default: false },
})

// Default: rolling 28-day window ending today (in ET)
function todayET() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
}
function daysAgoET(n) {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
}
const TO   = opts.to   || todayET()
const FROM = opts.from || daysAgoET(28)

const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })

// ── Constants (must match fireFadeModel.mjs) ───────────────────────────────
const NB_R         = 8
const EDGE_MIN     = 0.05
const EDGE_MAX     = 0.20
const ASK_MAX_C    = 50
const MIN_STRIKE   = 6
const STAKE_BASE   = 100
const LIQ_PCT      = 0.10

// ── Probability math (matches fireFadeModel.mjs nbGEqN) ────────────────────
function nbGe(lam, r, n) {
  if (n <= 0) return 1
  const p = r / (r + lam)
  let cum = Math.pow(p, r), term = cum
  for (let k = 1; k < n; k++) { term = term * (k + r - 1) / k * (1 - p); cum += term }
  return Math.max(0, Math.min(1, 1 - cum))
}
function ipToDecimal(ip) {
  const n = Number(ip || 0)
  const whole = Math.floor(n)
  const frac = n - whole
  if (Math.abs(frac - 0.1) < 0.05) return whole + 1/3
  if (Math.abs(frac - 0.2) < 0.05) return whole + 2/3
  return n
}
function num(v, d = null) { return v == null || Number.isNaN(Number(v)) ? d : Number(v) }

// ── Fade lambda (last 5 starts before bet_date) ────────────────────────────
function fadeLambda(history, beforeDate) {
  const prior = history.filter(s => s.date < beforeDate)
  if (!prior.length) return null
  const recent = prior.slice(-5)
  const totalK = recent.reduce((s, g) => s + g.ks, 0)
  const totalIp = recent.reduce((s, g) => s + ipToDecimal(g.ip), 0)
  if (totalIp <= 0) return null
  const k9 = totalK / totalIp * 9
  const avgIp = totalIp / recent.length
  if (k9 < 4 || k9 > 18) return null
  return { lambda: k9 * avgIp / 9, k9, avgIp }
}

// ── pkLight lambda (multi-feature, judgment-priors) ────────────────────────
function pkLightLambda(sig) {
  if (!sig) return null
  const k9 = num(sig.k9); const ip = num(sig.avg_innings_l5)
  if (k9 == null || ip == null) return null
  const ipA = Math.max(4.5, Math.min(6.5, ip))
  let lam = k9 * ipA / 9
  const swstr = num(sig.swstr_pct, 0.11)
  lam *= 1 + 0.05 * (swstr - 0.11) / 0.02
  const era = num(sig.era_l5, 4.0)
  lam *= 1 - 0.02 * Math.max(0, era - 4.5)
  const tto3 = num(sig.tto3_penalty, 0.9)
  lam *= 1 - 0.05 * tto3
  return lam
}

function passHi(sig) {
  if (!sig) return true
  const c = num(sig.confidence)
  return c == null || c > 0.3
}
function passHh(sig) {
  if (!sig) return false
  const ip = num(sig.avg_innings_l5)
  return ip != null && ip >= 5
}

function liqCappedStake(askC, volume) {
  const contracts = STAKE_BASE / (askC / 100)
  if (volume == null || volume <= 0) return { stake: STAKE_BASE, contracts }
  const maxC = volume * LIQ_PCT
  if (contracts <= maxC) return { stake: STAKE_BASE, contracts }
  return { stake: maxC * (askC / 100), contracts: maxC }
}

// ── Candidate selection per variant ────────────────────────────────────────
function pickCandidates(ladderRows, sig, variant, pid, date, history) {
  if (!passHi(sig)) return []
  if (variant === 'v3' && !passHh(sig)) return []

  const cands = []
  for (const r of ladderRows) {
    const askC = num(r.yes_ask)
    const s    = Number(r.strike)
    if (askC == null || askC >= ASK_MAX_C || askC < 3) continue
    if (s < MIN_STRIKE) continue

    let lam = null
    if (variant === 'pkLight') {
      const v = pkLightLambda(sig)
      lam = v != null ? { lambda: v } : null
    } else {
      lam = fadeLambda(history, date)
    }
    if (!lam) continue
    const mp = nbGe(lam.lambda, NB_R, s)
    const edge = mp - askC / 100
    if (edge < EDGE_MIN || edge > EDGE_MAX) continue

    const { stake, contracts } = liqCappedStake(askC, num(r.volume))
    cands.push({ strike: s, edge, mp, askC, ticker: r.ticker, stake, contracts, volume: num(r.volume) })
  }
  if (!cands.length) return []

  if (variant === 'v3') {
    const k6 = cands.filter(c => c.strike === 6)
    const tail = cands.filter(c => c.strike >= 10)
    const out = []
    if (k6.length) out.push(k6.reduce((a, b) => b.edge > a.edge ? b : a))
    if (tail.length) out.push(tail.reduce((a, b) => b.edge > a.edge ? b : a))
    return out
  }
  return [cands.reduce((a, b) => b.edge > a.edge ? b : a)]
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`[replayFadeMultiVariant] window: ${FROM} → ${TO}`)

  // Fire-window ladder (09:00-11:00 ET = 13:00-15:00 UTC), earliest snapshot per (pitcher, day, strike)
  const ladderSql = `
    WITH morning AS (
      SELECT pitcher_id, game_date, strike, captured_at, yes_bid, yes_ask, ticker, volume,
             pitcher_name,
             ROW_NUMBER() OVER (PARTITION BY pitcher_id, game_date, strike ORDER BY captured_at) rn
      FROM market_snapshots
      WHERE game_date BETWEEN ? AND ?
        AND pitcher_id IS NOT NULL
        AND strike >= 6 AND strike <= 16
        AND SUBSTR(captured_at, 12, 2) IN ('13','14','15')
        AND yes_ask IS NOT NULL AND yes_ask > 0
    )
    SELECT pitcher_id, pitcher_name, game_date, strike, ticker, yes_bid, yes_ask,
           volume, captured_at
    FROM morning WHERE rn = 1
  `
  const ladder = (await db.execute({ sql: ladderSql, args: [FROM, TO] })).rows
  console.log(`  ladder rows: ${ladder.length}`)

  const signals = (await db.execute({
    sql: `SELECT pitcher_id, signal_date, k9, swstr_pct, xfip_weighted, avg_innings_l5,
                 tto3_penalty, era_l5, confidence
          FROM pitcher_signals WHERE signal_date BETWEEN ? AND ?`,
    args: [FROM, TO],
  })).rows
  const sigByKey = new Map(signals.map(s => [`${s.pitcher_id}|${s.signal_date}`, s]))

  const starts = (await db.execute({
    sql: `SELECT pitcher_id, game_date, ks FROM pitcher_recent_starts WHERE game_date BETWEEN ? AND ?`,
    args: [FROM, TO],
  })).rows
  const ksByKey = new Map()
  for (const s of starts) if (s.ks != null) ksByKey.set(`${s.pitcher_id}|${s.game_date}`, Number(s.ks))
  const fallback = (await db.execute({
    sql: `SELECT bet_date, pitcher_id, MAX(actual_ks) ks FROM ks_bets
          WHERE bet_date BETWEEN ? AND ? AND actual_ks IS NOT NULL GROUP BY bet_date, pitcher_id`,
    args: [FROM, TO],
  })).rows
  for (const r of fallback) {
    const k = `${r.pitcher_id}|${r.bet_date}`
    if (!ksByKey.has(k)) ksByKey.set(k, Number(r.ks))
  }

  const allStarts = (await db.execute({
    sql: `SELECT pitcher_id, game_date, ks, ip FROM pitcher_recent_starts ORDER BY pitcher_id, game_date`,
    args: [],
  })).rows
  const histByPitcher = new Map()
  for (const s of allStarts) {
    if (s.ks == null || s.ip == null) continue
    if (!histByPitcher.has(s.pitcher_id)) histByPitcher.set(s.pitcher_id, [])
    histByPitcher.get(s.pitcher_id).push({ date: s.game_date, ks: Number(s.ks), ip: Number(s.ip) })
  }
  console.log(`  signals: ${signals.length}  outcomes: ${ksByKey.size}  histories: ${histByPitcher.size}`)

  const laddersByPD = new Map()
  for (const r of ladder) {
    const k = `${r.pitcher_id}|${r.game_date}`
    if (!laddersByPD.has(k)) laddersByPD.set(k, [])
    laddersByPD.get(k).push(r)
  }

  const variants = ['v3', 'v1h', 'pkLight']
  const results = Object.fromEntries(variants.map(v => [v, {
    fires: [], pnl: 0, w: 0, l: 0, skippedNoOutcome: 0,
    k6w: 0, k6l: 0, k79w: 0, k79l: 0, tailw: 0, taill: 0,
    totalStake: 0, liqCappedN: 0,
  }]))

  for (const [key, rows] of laddersByPD) {
    const [pid, date] = key.split('|')
    const sig = sigByKey.get(`${pid}|${date}`)
    const aks = ksByKey.get(`${pid}|${date}`)
    const history = histByPitcher.get(pid) || []
    for (const v of variants) {
      const picks = pickCandidates(rows, sig, v, pid, date, history)
      for (const p of picks) {
        results[v].fires.push({ date, pid, ...p, actual_ks: aks })
        results[v].totalStake += p.stake
        if (p.stake < STAKE_BASE) results[v].liqCappedN += 1
        if (aks == null) { results[v].skippedNoOutcome += 1; continue }
        const askDec = p.askC / 100
        const won = aks >= p.strike
        const pnl = won ? p.stake * (1 / askDec - 1) : -p.stake
        results[v].pnl += pnl
        const isTail = p.strike >= 10; const isK6 = p.strike === 6
        if (won) {
          results[v].w++
          if (isTail) results[v].tailw++; else if (isK6) results[v].k6w++; else results[v].k79w++
        } else {
          results[v].l++
          if (isTail) results[v].taill++; else if (isK6) results[v].k6l++; else results[v].k79l++
        }
      }
    }
  }

  // ── Report ────────────────────────────────────────────────────────────────
  console.log(`\n${'='.repeat(100)}\nMULTI-VARIANT FADE REPLAY (M+K+L correct): ${FROM} → ${TO}\n${'='.repeat(100)}\n`)
  const lines = [
    'Variant   Fires   W-L      Win%    P&L            TotalStake   LiqCapped   K=6        K7-9       K≥10',
  ]
  for (const v of variants) {
    const r = results[v]
    const settled = r.w + r.l
    const wr = settled ? (r.w / settled * 100).toFixed(1) : '0.0'
    const total = r.fires.length
    lines.push(`  ${v.padEnd(7)} ${String(total).padEnd(7)} ${`${r.w}-${r.l}`.padEnd(8)} ${wr.padStart(5)}%  $${r.pnl.toFixed(2).padStart(10)}   $${Math.round(r.totalStake).toString().padStart(7)}    ${r.liqCappedN}/${total}(${Math.round(r.liqCappedN/Math.max(1,total)*100)}%)  ${`${r.k6w}-${r.k6l}`.padEnd(7)} ${`${r.k79w}-${r.k79l}`.padEnd(7)} ${`${r.tailw}-${r.taill}`}`)
  }
  console.log(lines.join('\n'))

  const v3pnl = results.v3.pnl
  console.log(`\nValidation (must beat v3 by ≥+$800):`)
  for (const v of ['v1h', 'pkLight']) {
    const d = results[v].pnl - v3pnl
    const flag = d >= 800 ? '✓' : (d >= 0 ? '·' : '⚠')
    console.log(`  ${v}: P&L $${results[v].pnl.toFixed(2)}  Δ vs v3 $${d.toFixed(2)} ${flag}`)
  }

  if (opts.json) {
    const fs = await import('fs')
    fs.writeFileSync(opts.json, JSON.stringify(results, null, 2))
    console.log(`\n  Wrote JSON: ${opts.json}`)
  }

  if (opts.discord && process.env.FADE_DISCORD_WEBHOOK) {
    const body = {
      content: `🔁 **Fade Multi-Variant Replay** ${FROM} → ${TO}\n\`\`\`\n${lines.join('\n')}\n\`\`\``,
    }
    await fetch(process.env.FADE_DISCORD_WEBHOOK, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).catch(() => {})
  }
}

main().catch(e => { console.error(e); process.exit(1) })
