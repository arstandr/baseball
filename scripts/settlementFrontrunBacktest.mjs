// scripts/settlementFrontrunBacktest.mjs
//
// Question: when a starter is pulled, the NO side of every strike above their
// final K count becomes a guaranteed 100¢ settlement. Is there a window where
// Kalshi's NO ask hasn't yet caught up — i.e. can we buy NO@<100 right after
// the pull and capture the gap as risk-free P&L?
//
// Method (no future bias):
//   1. For each game in the window, fetch /feed/live.
//   2. From boxscore, identify each starter (teams.{side}.pitchers[0]) and
//      their final K count.
//   3. From playEvents (type=action, eventType=pitching_substitution), find
//      the substitution event whose description names the starter as the one
//      being replaced. Record the event's startTime as sub_time.
//   4. For every strike S where finalK < S (NO is guaranteed at settlement):
//        For each latency band Δ ∈ {0s, 30s, 60s, 180s, 600s}:
//          Pull the first market_snapshots row for (pitcher_id, strike=S)
//          with captured_at ≥ sub_time + Δ. Record no_ask at that snapshot.
//          Edge = 100 - no_ask cents (the fill cost vs. guaranteed payout).
//        Also pull the LAST pre-sub snapshot to baseline what the price was
//        before the news broke.
//   5. Aggregate per latency band: n, mean edge, median, p25/p75, %>=10¢,
//      %>=5¢, %<=0¢, mean spread.
//
// What this does NOT model (yet — backtest only):
//   - Kalshi 7% fees (subtracted from gross edge at report time)
//   - Volume / slippage (we assume the printed ask is fillable for 1 contract)
//   - Latency in our own polling loop (assumes /feed/live delivers the event
//     at sub_time; in production the API lags ~15-30s behind real time)
//
// Outputs:
//   - /tmp/settlement_frontrun_per_event.csv  (one row per (sub, strike, Δ))
//   - /tmp/settlement_frontrun_summary.txt    (aggregate stats)

import 'dotenv/config'
import { createClient } from '@libsql/client'
import { writeFile } from 'fs/promises'

const WINDOW_START = '2026-04-27'
const WINDOW_END   = '2026-05-10'
const LATENCY_S    = [0, 30, 60, 180, 600]
const FEE_PCT      = 0.07   // Kalshi taker fee for fee-aware view
const STRIKES      = [3, 4, 5, 6, 7, 8, 9, 10]   // KXMLBKS market strikes
const MLB_DELAY_MS = 150

const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })

function argv(name) {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : null
}
const LIMIT = Number(argv('limit') ?? 0) || null

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function mlbFetch(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(15_000) })
      if (!r.ok) { await sleep(500); continue }
      return await r.json()
    } catch { await sleep(500) }
  }
  return null
}

// Collect distinct (game_id, game_date) pairs we have market_snapshots for.
async function getGames() {
  const r = await db.execute({
    sql: `SELECT DISTINCT game_id, game_date
          FROM market_snapshots
          WHERE game_date BETWEEN ? AND ?
            AND game_id IS NOT NULL
          ORDER BY game_date, game_id`,
    args: [WINDOW_START, WINDOW_END],
  })
  return r.rows
}

// For a starter, find the substitution event in playEvents where they're the
// one being replaced. Returns ISO startTime or null if they were never pulled
// (complete game, or only one pitcher in the data which means starter == only).
function findStarterSubTime(feed, starterFullName) {
  const plays = feed?.liveData?.plays?.allPlays ?? []
  const escName = starterFullName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`replaces\\s+${escName}\\b`, 'i')
  for (const p of plays) {
    for (const ev of p.playEvents ?? []) {
      if (ev?.type !== 'action') continue
      if (ev?.details?.eventType !== 'pitching_substitution') continue
      const desc = ev?.details?.description ?? ''
      if (re.test(desc)) return ev.startTime ?? null
    }
  }
  return null
}

function extractStarter(box, side) {
  const team = box?.teams?.[side]
  if (!team) return null
  const pitcherIds = team.pitchers ?? []
  if (!pitcherIds.length) return null
  const sid = pitcherIds[0]
  const pl = team.players?.[`ID${sid}`]
  if (!pl) return null
  const st = pl.stats?.pitching
  if (!st) return null
  return {
    id:       String(sid),
    name:     pl.person?.fullName ?? String(sid),
    finalKs:  Number(st.strikeOuts ?? 0),
    finalIp:  Number(st.inningsPitched ?? 0),
  }
}

// For a pitcher × strike, find the snapshot whose captured_at is the first
// one ≥ target ISO timestamp. Returns { captured_at, no_ask, no_bid, yes_ask,
// volume } or null.
async function snapAtOrAfter({ pitcherId, strike, targetIso, gameDate }) {
  const r = await db.execute({
    sql: `SELECT captured_at, no_ask, no_bid, yes_ask, yes_bid, volume, spread
          FROM market_snapshots
          WHERE pitcher_id = ? AND strike = ? AND game_date = ?
            AND captured_at >= ?
          ORDER BY captured_at ASC
          LIMIT 1`,
    args: [pitcherId, strike, gameDate, targetIso],
  })
  return r.rows[0] ?? null
}

async function snapJustBefore({ pitcherId, strike, targetIso, gameDate }) {
  const r = await db.execute({
    sql: `SELECT captured_at, no_ask, no_bid, yes_ask, yes_bid, volume, spread
          FROM market_snapshots
          WHERE pitcher_id = ? AND strike = ? AND game_date = ?
            AND captured_at < ?
          ORDER BY captured_at DESC
          LIMIT 1`,
    args: [pitcherId, strike, gameDate, targetIso],
  })
  return r.rows[0] ?? null
}

function addSeconds(iso, secs) {
  const t = new Date(iso).getTime()
  return new Date(t + secs * 1000).toISOString()
}

function quantile(arr, q) {
  if (!arr.length) return null
  const sorted = [...arr].sort((a, b) => a - b)
  const idx = (sorted.length - 1) * q
  const lo = Math.floor(idx), hi = Math.ceil(idx)
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
}

async function main() {
  let games = await getGames()
  if (LIMIT) games = games.slice(0, LIMIT)
  console.log(`Window: ${WINDOW_START} → ${WINDOW_END}${LIMIT ? ` (LIMIT=${LIMIT})` : ''}`)
  console.log(`Games to scan: ${games.length}\n`)

  const events = []        // one row per (sub, strike, latency band)
  const baselines = []     // one row per (sub, strike) — pre-sub no_ask
  const starterIndex = []  // diagnostic: starter found / pulled / has snapshots

  let scanned = 0
  for (const g of games) {
    scanned++
    if (scanned % 25 === 0) console.log(`  ...${scanned}/${games.length} games`)
    const feed = await mlbFetch(`https://statsapi.mlb.com/api/v1.1/game/${g.game_id}/feed/live`)
    await sleep(MLB_DELAY_MS)
    if (!feed) { starterIndex.push({ game_id: g.game_id, date: g.game_date, status: 'feed_fetch_failed' }); continue }

    const box = feed?.liveData?.boxscore
    for (const side of ['home', 'away']) {
      const starter = extractStarter(box, side)
      if (!starter) { starterIndex.push({ game_id: g.game_id, date: g.game_date, side, status: 'no_starter' }); continue }

      const subTime = findStarterSubTime(feed, starter.name)
      if (!subTime) {
        // Starter wasn't pulled mid-game (CG / still in / data gap).
        starterIndex.push({ game_id: g.game_id, date: g.game_date, side, pitcher: starter.name, pitcher_id: starter.id, finalKs: starter.finalKs, status: 'no_sub_event' })
        continue
      }

      starterIndex.push({ game_id: g.game_id, date: g.game_date, side, pitcher: starter.name, pitcher_id: starter.id, finalKs: starter.finalKs, sub_time: subTime, status: 'pulled' })

      // For each strike where the NO side is guaranteed payout (finalKs < strike).
      for (const strike of STRIKES) {
        if (starter.finalKs >= strike) continue  // NO would settle at 0¢ — not free money

        // Pre-sub baseline: last snapshot before sub_time
        const pre = await snapJustBefore({ pitcherId: starter.id, strike, targetIso: subTime, gameDate: g.game_date })
        if (pre) {
          const lagS = (new Date(subTime).getTime() - new Date(pre.captured_at).getTime()) / 1000
          baselines.push({
            game_id: g.game_id, date: g.game_date, pitcher_id: starter.id, pitcher: starter.name,
            finalKs: starter.finalKs, strike, sub_time: subTime,
            pre_snap_at: pre.captured_at, pre_lag_s: Math.round(lagS),
            pre_no_ask: pre.no_ask, pre_no_bid: pre.no_bid, pre_spread: pre.spread,
          })
        }

        for (const Δ of LATENCY_S) {
          const target = addSeconds(subTime, Δ)
          const snap = await snapAtOrAfter({ pitcherId: starter.id, strike, targetIso: target, gameDate: g.game_date })
          if (!snap) continue
          const observedLagS = (new Date(snap.captured_at).getTime() - new Date(subTime).getTime()) / 1000
          // Skip if the "matched" snapshot is more than 5 minutes past the
          // target — sparse data, no honest fill at that latency.
          if (observedLagS - Δ > 300) continue

          const noAsk = snap.no_ask
          if (noAsk == null) continue
          const grossEdgeC = 100 - noAsk
          // Fee on entry: pay 0.07 × (cost in ¢). At settlement Kalshi takes
          // fee from the winning side too. Net edge ≈ gross − 0.07*100 (worst case
          // assuming full taker fees on both legs). Simpler conservative model:
          const feeC = FEE_PCT * 100
          const netEdgeC = grossEdgeC - feeC

          events.push({
            game_id: g.game_id, date: g.game_date,
            pitcher_id: starter.id, pitcher: starter.name,
            finalKs: starter.finalKs, strike,
            sub_time: subTime, latency_target_s: Δ,
            snap_at: snap.captured_at,
            actual_lag_s: Math.round(observedLagS),
            no_ask: noAsk, no_bid: snap.no_bid, spread: snap.spread, volume: snap.volume,
            gross_edge_c: grossEdgeC,
            net_edge_c: netEdgeC,
          })
        }
      }
    }
  }

  console.log(`\nDone scanning. Events captured: ${events.length}, baselines: ${baselines.length}`)

  // ── Aggregates ────────────────────────────────────────────────────────────
  const byLatency = new Map()
  for (const Δ of LATENCY_S) byLatency.set(Δ, [])
  for (const e of events) byLatency.get(e.latency_target_s)?.push(e)

  const lines = []
  lines.push(`Settlement Frontrun Backtest — ${WINDOW_START} → ${WINDOW_END}`)
  lines.push(`Generated: ${new Date().toISOString()}`)
  lines.push(``)
  lines.push(`Diagnostics:`)
  const totalStarters = starterIndex.filter(s => s.status === 'pulled' || s.status === 'no_sub_event').length
  const pulled = starterIndex.filter(s => s.status === 'pulled').length
  const noSub = starterIndex.filter(s => s.status === 'no_sub_event').length
  const noStarter = starterIndex.filter(s => s.status === 'no_starter').length
  const feedFail = starterIndex.filter(s => s.status === 'feed_fetch_failed').length
  lines.push(`  Games scanned:     ${games.length}`)
  lines.push(`  /feed/live failed: ${feedFail}`)
  lines.push(`  Starters found:    ${totalStarters} (${noStarter} no starter data)`)
  lines.push(`  Starters pulled:   ${pulled}`)
  lines.push(`  Starters not pulled (CG / data gap): ${noSub}`)
  lines.push(`  (Sub × Strike × Latency) rows: ${events.length}`)
  lines.push(``)

  // Pre-sub baseline (so we know whether the market was already at 99¢ before
  // the sub — if so, there's nothing to capture).
  if (baselines.length) {
    const preAsks = baselines.map(b => b.pre_no_ask).filter(v => v != null)
    const preEdges = preAsks.map(a => 100 - a)
    lines.push(`Pre-sub baseline (last snapshot < sub_time):`)
    lines.push(`  n=${preAsks.length}`)
    lines.push(`  no_ask  mean=${(preAsks.reduce((s,v) => s+v, 0)/preAsks.length).toFixed(1)}  median=${quantile(preAsks, 0.5).toFixed(1)}  p25=${quantile(preAsks, 0.25).toFixed(1)}  p75=${quantile(preAsks, 0.75).toFixed(1)}`)
    lines.push(`  gross edge (100 − no_ask)  mean=${(preEdges.reduce((s,v) => s+v, 0)/preEdges.length).toFixed(2)}¢  median=${quantile(preEdges, 0.5).toFixed(1)}¢`)
    lines.push(`  pct gross_edge ≥ 10¢: ${(100 * preEdges.filter(e => e >= 10).length / preEdges.length).toFixed(1)}%`)
    lines.push(`  pct gross_edge ≥  5¢: ${(100 * preEdges.filter(e => e >=  5).length / preEdges.length).toFixed(1)}%`)
    lines.push(`  median pre_lag from sub: ${quantile(baselines.map(b => b.pre_lag_s), 0.5)?.toFixed(0)}s  p75: ${quantile(baselines.map(b => b.pre_lag_s), 0.75)?.toFixed(0)}s`)
    lines.push(``)
  }

  lines.push(`Per-latency results (post-sub):`)
  lines.push(`  latency │     n │ mean gross │ median │   p25 │   p75 │ %≥10¢ │ %≥5¢ │ %≤0¢ │ mean net (post-fee) │ median actual lag`)
  for (const Δ of LATENCY_S) {
    const arr = byLatency.get(Δ) ?? []
    if (!arr.length) { lines.push(`  ${String(Δ).padStart(4)}s    │     0 │       -    │      - │     - │     - │     - │    - │    - │           -         │        -`); continue }
    const gross = arr.map(e => e.gross_edge_c)
    const net = arr.map(e => e.net_edge_c)
    const lags = arr.map(e => e.actual_lag_s)
    const pct10 = 100 * gross.filter(e => e >= 10).length / gross.length
    const pct5  = 100 * gross.filter(e => e >=  5).length / gross.length
    const pctNeg = 100 * gross.filter(e => e <= 0).length / gross.length
    const mean = (a) => a.reduce((s,v) => s+v, 0) / a.length
    lines.push(`  ${String(Δ).padStart(4)}s    │ ${String(arr.length).padStart(5)} │ ${mean(gross).toFixed(2).padStart(8)}¢  │ ${quantile(gross, 0.5).toFixed(1).padStart(5)}¢ │ ${quantile(gross, 0.25).toFixed(1).padStart(4)}¢ │ ${quantile(gross, 0.75).toFixed(1).padStart(4)}¢ │ ${pct10.toFixed(1).padStart(4)}% │ ${pct5.toFixed(1).padStart(3)}% │ ${pctNeg.toFixed(1).padStart(3)}% │  ${mean(net).toFixed(2).padStart(7)}¢          │  ${quantile(lags, 0.5).toFixed(0)}s`)
  }
  lines.push(``)

  lines.push(`Decision criteria (per the build-plan):`)
  lines.push(`  +30s mean gross ≥ 10¢ → build live system`)
  lines.push(`  +30s mean gross ≤  2¢ → drop strategy`)
  lines.push(`  middle (3–9¢)         → build $50/bet experimental version`)
  const e30 = (byLatency.get(30) ?? []).map(e => e.gross_edge_c)
  if (e30.length) {
    const m30 = e30.reduce((s,v) => s+v, 0) / e30.length
    let verdict
    if (m30 >= 10) verdict = `🟢 BUILD LIVE — +30s mean gross edge = ${m30.toFixed(2)}¢`
    else if (m30 <= 2) verdict = `🔴 DROP — +30s mean gross edge = ${m30.toFixed(2)}¢`
    else verdict = `🟡 EXPERIMENT — +30s mean gross edge = ${m30.toFixed(2)}¢`
    lines.push(`  ${verdict}`)
  }
  lines.push(``)

  // CSV per-event detail
  const csvHeader = ['game_id','date','pitcher','pitcher_id','finalKs','strike','sub_time','latency_target_s','snap_at','actual_lag_s','no_ask','no_bid','spread','volume','gross_edge_c','net_edge_c']
  const csvRows = events.map(e => csvHeader.map(k => e[k]).join(','))
  await writeFile('/tmp/settlement_frontrun_per_event.csv', csvHeader.join(',') + '\n' + csvRows.join('\n'))

  const baseHeader = ['game_id','date','pitcher','pitcher_id','finalKs','strike','sub_time','pre_snap_at','pre_lag_s','pre_no_ask','pre_no_bid','pre_spread']
  const baseRows = baselines.map(b => baseHeader.map(k => b[k]).join(','))
  await writeFile('/tmp/settlement_frontrun_baselines.csv', baseHeader.join(',') + '\n' + baseRows.join('\n'))

  await writeFile('/tmp/settlement_frontrun_summary.txt', lines.join('\n'))
  console.log('\n' + lines.join('\n'))
  console.log(`\nWrote:`)
  console.log(`  /tmp/settlement_frontrun_per_event.csv  (${events.length} rows)`)
  console.log(`  /tmp/settlement_frontrun_baselines.csv  (${baselines.length} rows)`)
  console.log(`  /tmp/settlement_frontrun_summary.txt`)
}

main().catch(err => { console.error(err); process.exit(1) })
