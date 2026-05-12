// Single-Pick edge backtest, BOTH sides.
//
// For each pitcher-day, find the strike with biggest |model − market| disagreement.
// Bet that side. Test top-1, top-3, top-5 per day across edge thresholds.
//
// Score = max(edge_yes, edge_no) per strike.
// edge_yes = model_prob − yes_ask/100  (YES underpriced when positive)
// edge_no  = yes_bid/100 − model_prob  (NO underpriced when positive)

import 'dotenv/config'
import { createClient } from '@libsql/client'

const FROM = '2026-04-27', TO = '2026-05-05'
const BET_USD = 50
const FEE = 0.07
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })

const cache = await db.execute(`SELECT pitcher_id, bet_date, edges_json FROM pitcher_edge_cache WHERE bet_date BETWEEN '${FROM}' AND '${TO}'`)
const out = await db.execute(`SELECT pitcher_id, game_date, ks FROM pitcher_recent_starts WHERE game_date BETWEEN '${FROM}' AND '${TO}'`)
const outcomes = new Map(out.rows.map(r => [`${r.pitcher_id}|${r.game_date}`, Number(r.ks)]))
const names = await db.execute(`SELECT DISTINCT pitcher_id, pitcher_name FROM market_snapshots WHERE game_date BETWEEN '${FROM}' AND '${TO}'`)
const pNames = new Map(names.rows.map(r => [String(r.pitcher_id), r.pitcher_name]))

// Build candidates from BOTH sides
const cands = []
for (const r of cache.rows) {
  const j = JSON.parse(r.edges_json)
  for (const e of j) {
    const yb = Number(e.yes_bid), ya = Number(e.yes_ask)
    const mp = Number(e.model_prob)
    if (!Number.isFinite(yb) || !Number.isFinite(ya) || !Number.isFinite(mp)) continue
    if (yb <= 0 || ya >= 100 || ya - yb > 25) continue  // skip broken/wide markets
    // YES side: edge = model_prob − yes_ask/100, ask = yes_ask
    const edgeYes = mp - ya/100
    if (edgeYes > 0 && ya >= 3 && ya <= 88) {
      cands.push({
        bet_date: r.bet_date, pitcher_id: String(r.pitcher_id),
        pitcher_name: pNames.get(String(r.pitcher_id)) ?? '?',
        strike: Number(e.strike), side: 'YES', model_prob: mp,
        ask: ya, market_price: ya, edge: edgeYes, ticker: e.ticker,
      })
    }
    // NO side: edge = yes_bid/100 − model_prob, ask = no_ask = 100 − yes_bid
    const edgeNo = yb/100 - mp
    const noAsk = 100 - yb
    if (edgeNo > 0 && noAsk >= 3 && noAsk <= 88) {
      cands.push({
        bet_date: r.bet_date, pitcher_id: String(r.pitcher_id),
        pitcher_name: pNames.get(String(r.pitcher_id)) ?? '?',
        strike: Number(e.strike), side: 'NO', model_prob: mp,
        ask: noAsk, market_price: yb, edge: edgeNo, ticker: e.ticker,
      })
    }
  }
}
console.log(`${cands.length} candidates across ${cache.rows.length} pitcher-days`)
const yesC = cands.filter(c => c.side === 'YES').length
const noC = cands.filter(c => c.side === 'NO').length
console.log(`  YES side: ${yesC}, NO side: ${noC}`)

function settle(c) {
  const k = outcomes.get(`${c.pitcher_id}|${c.bet_date}`)
  if (k == null) return null
  const won = c.side === 'YES' ? k >= c.strike : k < c.strike
  const contracts = Math.max(1, Math.floor(BET_USD / (c.ask / 100)))
  const stake = contracts * (c.ask / 100)
  const pnl = won ? contracts * ((100 - c.ask) / 100) * (1 - FEE) : -stake
  return { ...c, actual_k: k, won: won ? 1 : 0, contracts, stake, pnl }
}

function run(label, opts) {
  const { topN = 1, minEdge = 0, sideOnly = null, minStrike = 0, maxAsk = 88, scoreFn = c => c.edge } = opts
  const byDate = new Map()
  for (const c of cands) {
    if (sideOnly && c.side !== sideOnly) continue
    if (c.edge < minEdge) continue
    if (c.strike < minStrike) continue
    if (c.ask > maxAsk) continue
    if (!byDate.has(c.bet_date)) byDate.set(c.bet_date, [])
    byDate.get(c.bet_date).push(c)
  }
  const fires = []
  for (const [d, arr] of byDate) {
    arr.sort((a, b) => scoreFn(b) - scoreFn(a))
    for (let i = 0; i < Math.min(topN, arr.length); i++) {
      const r = settle(arr[i])
      if (r) fires.push(r)
    }
  }
  const w = fires.filter(f => f.won).length
  const stake = fires.reduce((s, f) => s + f.stake, 0)
  const pnl = fires.reduce((s, f) => s + f.pnl, 0)
  const winPct = fires.length ? (w / fires.length * 100).toFixed(1) : 0
  const roi = stake ? (pnl / stake * 100).toFixed(1) : 0
  console.log(`  ${label.padEnd(45)} n=${String(fires.length).padStart(3)}  W=${String(w).padStart(2)}  win=${winPct.padStart(5)}%  stake=$${stake.toFixed(0).padStart(5)}  P&L=${pnl >= 0 ? '+' : ''}$${pnl.toFixed(0).padStart(5)}  ROI=${roi.padStart(6)}%`)
  return fires
}

console.log('\n═══ Both-sided fade — full sweep ═══')
console.log('config'.padEnd(47) + 'fires  W   win%   stake    P&L    ROI')
console.log('─'.repeat(100))

run('top-1/day, both sides',                    { topN: 1 })
run('top-1/day, edge ≥ 5c',                      { topN: 1, minEdge: 0.05 })
run('top-1/day, edge ≥ 8c',                      { topN: 1, minEdge: 0.08 })
run('top-1/day, edge ≥ 12c',                     { topN: 1, minEdge: 0.12 })
run('top-1/day, YES-only',                       { topN: 1, sideOnly: 'YES' })
run('top-1/day, NO-only',                        { topN: 1, sideOnly: 'NO' })
run('top-1/day, YES + edge ≥ 8c',                { topN: 1, sideOnly: 'YES', minEdge: 0.08 })
run('top-1/day, NO + edge ≥ 8c',                 { topN: 1, sideOnly: 'NO', minEdge: 0.08 })
run('top-3/day',                                 { topN: 3 })
run('top-3/day, edge ≥ 8c',                      { topN: 3, minEdge: 0.08 })
run('top-3/day, ask ≤ 50c',                      { topN: 3, maxAsk: 50 })
run('top-3/day, edge ≥ 5c, ask ≤ 50c',           { topN: 3, minEdge: 0.05, maxAsk: 50 })
run('top-5/day',                                 { topN: 5 })
run('top-5/day, edge ≥ 8c',                      { topN: 5, minEdge: 0.08 })
run('top-5/day, ask ≤ 50c',                      { topN: 5, maxAsk: 50 })
run('top-5/day, edge ≥ 5c, ask ≤ 50c, NO-only',  { topN: 5, minEdge: 0.05, maxAsk: 50, sideOnly: 'NO' })
run('top-5/day, edge ≥ 5c, ask ≤ 50c, YES-only', { topN: 5, minEdge: 0.05, maxAsk: 50, sideOnly: 'YES' })

// Score by edge × cheapness (tail bias — cheap asks have favorable fee math)
run('top-1/day, score=edge/ask',                  { topN: 1, scoreFn: c => c.edge / (c.ask / 100) })
run('top-3/day, score=edge/ask',                  { topN: 3, scoreFn: c => c.edge / (c.ask / 100) })
run('top-3/day, edge ≥ 5, score=edge/ask',        { topN: 3, minEdge: 0.05, scoreFn: c => c.edge / (c.ask / 100) })

// Sample best variant
console.log('\n═══ Sample fires: top-3/day, edge ≥ 5c, ask ≤ 50c ═══')
const sample = run('SAMPLED', { topN: 3, minEdge: 0.05, maxAsk: 50 })
sample.sort((a,b) => a.bet_date.localeCompare(b.bet_date))
console.log('  date         pitcher                K   side  modelP  ask   edge   actK  W/L   pnl')
for (const f of sample) {
  console.log(`  ${f.bet_date}  ${(f.pitcher_name ?? '').padEnd(22).slice(0,22)}  ${String(f.strike).padStart(2)}+  ${f.side.padEnd(3)}  ${(f.model_prob*100).toFixed(0).padStart(3)}%   ${String(f.ask).padStart(3)}c  ${(f.edge*100).toFixed(1).padStart(4)}c  ${String(f.actual_k).padStart(2)}    ${f.won ? 'W' : 'L'}    ${f.pnl >= 0 ? '+' : ''}$${f.pnl.toFixed(2)}`)
}
