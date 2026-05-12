// Cross-Strike filter sweep. Reuses the same data pipeline as
// crossStrikeBacktest.mjs but evaluates 5+ candidate filter sets and prints a
// comparison table so we can see which knob actually moves the needle.
//
// Configs tested:
//   1. baseline       — current production (4-20¢ resid, 3-88¢ ask)
//   2. resid≥6c       — tighter mispricing band (filters noise)
//   3. reject-poor    — skip days where Poisson fit quality is 'poor'
//   4. ask 25-75      — avoid deep ITM/OTM where Poisson is least accurate
//   5. combined       — resid≥6 + reject-poor + ask 25-75
//   6. yes-only       — disable NO side entirely

import 'dotenv/config'
import { createClient } from '@libsql/client'
import { generateCrossStrikeCandidates } from '../lib/crossStrikeCandidates.js'

const BANKROLL    = Number(process.env.BANKROLL ?? 1000)
const PCT_CAP     = 0.03
const TAIL_CAP_USD = 5
const TAIL_THRESH = 25
const KALSHI_FEE  = 0.07
const MIN_BET_USD = 1

const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })

const MONTHS = { JAN:'01', FEB:'02', MAR:'03', APR:'04', MAY:'05', JUN:'06', JUL:'07', AUG:'08', SEP:'09', OCT:'10', NOV:'11', DEC:'12' }
function parseGameStartIso(ticker) {
  const m = /^KXMLBKS-(\d{2})([A-Z]{3})(\d{2})(\d{2})(\d{2})/.exec(ticker || '')
  if (!m) return null
  return `20${m[1]}-${MONTHS[m[2]]}-${m[3]}T${m[4]}:${m[5]}:00.000Z`
}

const outcomeCache = new Map()
async function getActualKs(pitcherId, betDate) {
  const key = `${pitcherId}|${betDate}`
  if (outcomeCache.has(key)) return outcomeCache.get(key)
  let ks = null
  const r = await db.execute({
    sql: `SELECT actual_ks FROM ks_bets WHERE pitcher_id = ? AND bet_date = ? AND actual_ks IS NOT NULL LIMIT 1`,
    args: [String(pitcherId), betDate],
  })
  ks = r.rows[0]?.actual_ks != null ? Number(r.rows[0].actual_ks) : null
  if (ks == null) {
    const url = `https://statsapi.mlb.com/api/v1/people/${pitcherId}/stats?stats=gameLog&season=2026&group=pitching`
    const res = await fetch(url).then(r => r.ok ? r.json() : null).catch(() => null)
    const splits = res?.stats?.[0]?.splits || []
    const match = splits.find(s => s.date === betDate)
    ks = match ? Number(match.stat?.strikeOuts ?? 0) : null
  }
  outcomeCache.set(key, ks)
  return ks
}

function sizeBet(askCents) {
  const baseUsd = Math.min(BANKROLL * PCT_CAP, askCents < TAIL_THRESH ? TAIL_CAP_USD : Infinity)
  const usd = Math.max(MIN_BET_USD, baseUsd)
  const contracts = Math.max(1, Math.floor(usd / (askCents / 100)))
  return { usd: contracts * (askCents / 100), contracts }
}
function computePnl(side, askCents, contracts, actualKs, strike) {
  const won = side === 'YES' ? actualKs >= strike : actualKs < strike
  return won ? contracts * ((100 - askCents) / 100) * (1 - KALSHI_FEE) : -contracts * (askCents / 100)
}

// 1) Pull data once
const groupRows = await db.execute(`
  SELECT pitcher_id, pitcher_name, game_date, ticker, strike, yes_bid, yes_ask, captured_at
  FROM market_snapshots
  WHERE game_date >= '2026-04-28' AND game_date <= '2026-05-05'
    AND yes_bid IS NOT NULL AND yes_ask IS NOT NULL
    AND (yes_bid + yes_ask) > 2 AND (yes_bid + yes_ask) < 198
    AND ticker IS NOT NULL AND pitcher_id IS NOT NULL AND strike IS NOT NULL
`)
const closest = new Map()
for (const r of groupRows.rows) {
  const startIso = parseGameStartIso(r.ticker)
  if (!startIso) continue
  const dt = Math.abs(Date.parse(r.captured_at) - Date.parse(startIso))
  const isBefore = Date.parse(r.captured_at) <= Date.parse(startIso)
  const score = (isBefore ? 0 : 1e15) + dt
  const key = `${r.pitcher_id}|${r.game_date}|${r.strike}`
  const cur = closest.get(key)
  if (!cur || score < cur.score) {
    closest.set(key, {
      pitcher_id: String(r.pitcher_id), pitcher_name: r.pitcher_name,
      game_date: r.game_date, ticker: r.ticker, strike: Number(r.strike),
      yes_bid: Number(r.yes_bid), yes_ask: Number(r.yes_ask),
      market_mid: (Number(r.yes_bid) + Number(r.yes_ask)) / 2, score,
    })
  }
}
const byPitcherDay = new Map()
for (const v of closest.values()) {
  const k = `${v.pitcher_id}|${v.game_date}`
  if (!byPitcherDay.has(k)) byPitcherDay.set(k, [])
  byPitcherDay.get(k).push(v)
}
console.log(`Data: ${byPitcherDay.size} pitcher-days from market_snapshots\n`)

// Pre-resolve outcomes once for all pitcher-days that could fire
const outcomes = new Map()
for (const key of byPitcherDay.keys()) {
  const [pid, d] = key.split('|')
  outcomes.set(key, await getActualKs(pid, d))
}
console.log(`Outcomes resolved (${[...outcomes.values()].filter(v => v != null).length}/${outcomes.size})\n`)

// 2) Run a config and return summary
function runConfig(name, opts, { sideFilter = null, rejectPoor = false } = {}) {
  let n = 0, w = 0, stake = 0, pnl = 0
  const dayMap = new Map()
  let may3 = { n: 0, w: 0, pnl: 0 }

  for (const [key, chain] of byPitcherDay) {
    const [pid, betDate] = key.split('|')
    if (chain.length < 4) continue
    const cands = generateCrossStrikeCandidates(chain, opts)
    if (cands.length === 0) continue
    if (rejectPoor && cands[0].cross_strike_fit_quality === 'poor') continue
    const actualKs = outcomes.get(key)
    if (actualKs == null) continue
    for (const c of cands) {
      if (sideFilter && c.side !== sideFilter) continue
      const ask = c.ask_cents
      const { usd, contracts } = sizeBet(ask)
      const p = computePnl(c.side, ask, contracts, actualKs, c.strike)
      const won = (c.side === 'YES' ? actualKs >= c.strike : actualKs < c.strike) ? 1 : 0
      n++; w += won; stake += usd; pnl += p
      const day = dayMap.get(betDate) ?? { n: 0, w: 0, pnl: 0 }
      day.n++; day.w += won; day.pnl += p; dayMap.set(betDate, day)
      if (betDate === '2026-05-03') { may3.n++; may3.w += won; may3.pnl += p }
    }
  }
  return { name, n, w, l: n - w, winPct: n ? w/n*100 : 0, stake, pnl, roi: stake ? pnl/stake*100 : 0, may3, dayMap }
}

const configs = [
  ['baseline (resid 4-20, ask 3-88)',     {}, {}],
  ['resid ≥ 6¢',                           { minResidual: 0.06 }, {}],
  ['ask ≤ 65¢ (avoid heavy ITM)',          { maxAskCents: 65 }, {}],
  ['ask ≤ 65¢ + resid ≥ 6¢',               { minResidual: 0.06, maxAskCents: 65 }, {}],
  ['ask ≤ 50¢ + resid ≥ 6¢',               { minResidual: 0.06, maxAskCents: 50 }, {}],
  ['resid 6-12¢ (cut wild outliers)',      { minResidual: 0.06, maxResidual: 0.12 }, {}],
  ['NO-only + resid ≥ 6¢',                 { minResidual: 0.06 }, { sideFilter: 'NO' }],
  ['YES-only + resid ≥ 6¢ + ask ≤ 65',     { minResidual: 0.06, maxAskCents: 65 }, { sideFilter: 'YES' }],
]

const results = configs.map(([name, opts, extra]) => runConfig(name, opts, extra))

console.log(`══════════════════════════════════════════════════════════════════════════════════════════`)
console.log(`  CROSS-STRIKE FILTER SWEEP  Apr 28 → May 5  (bankroll=$${BANKROLL}, 3%/$5 tail sizing)`)
console.log(`══════════════════════════════════════════════════════════════════════════════════════════\n`)
console.log('config'.padEnd(40), 'fires'.padStart(6), 'win%'.padStart(7), 'staked'.padStart(10), 'P&L'.padStart(11), 'ROI%'.padStart(8), 'May3 (n W$)'.padStart(15))
for (const r of results) {
  const may3Str = `${r.may3.n}/${r.may3.w}/${r.may3.pnl >= 0 ? '+' : ''}${r.may3.pnl.toFixed(0)}`
  console.log(
    r.name.padEnd(40),
    String(r.n).padStart(6),
    `${r.winPct.toFixed(1)}%`.padStart(7),
    `$${r.stake.toFixed(0)}`.padStart(10),
    `${r.pnl >= 0 ? '+' : ''}$${r.pnl.toFixed(0)}`.padStart(11),
    `${r.roi.toFixed(1)}%`.padStart(8),
    may3Str.padStart(15),
  )
}

// Per-day comparison for top 3 by ROI
console.log('\nDay-by-day (top 3 configs by ROI):')
const top = [...results].sort((a, b) => b.roi - a.roi).slice(0, 3)
const allDays = [...new Set(results.flatMap(r => [...r.dayMap.keys()]))].sort()
console.log('day'.padEnd(13), ...top.map(c => c.name.slice(0, 22).padEnd(24)))
for (const d of allDays) {
  console.log(d.padEnd(13), ...top.map(c => {
    const s = c.dayMap.get(d)
    if (!s) return '       —                '
    return `${s.n}b ${s.w}W ${s.pnl >= 0 ? '+' : ''}$${s.pnl.toFixed(0)}`.padEnd(24)
  }))
}
