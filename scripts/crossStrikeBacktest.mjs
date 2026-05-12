// Cross-Strike backtest: for every pitcher-day in market_snapshots (Apr 28+),
// reconstruct the strike chain near game start, run generateCrossStrikeCandidates,
// resolve actual K outcome (ks_bets first, MLB API fallback), and compute P&L
// using current sizing rules (3% bankroll cap, $5 tail cap when ask < 25¢).
//
// Caveats:
//   - Fill price = yes_ask (taker, worst case). Real fires often get post-only fills.
//   - Bankroll modeled at $1000 (override with BANKROLL=2000 ...). No daily P&L cascade.
//   - Today's 6 actual cross-strike fires excluded to avoid double-counting.
//   - Skipped pitcher-days: missing strike chain near game start, or unresolvable outcome.

import 'dotenv/config'
import { createClient } from '@libsql/client'
import { generateCrossStrikeCandidates } from '../lib/crossStrikeCandidates.js'

const BANKROLL    = Number(process.env.BANKROLL ?? 1000)
const PCT_CAP     = 0.03            // 3% of bankroll per bet
const TAIL_CAP_USD = 5              // $5 dollar cap when ask < 25¢
const TAIL_THRESH = 25              // ask cents below which tail cap applies
const KALSHI_FEE  = 0.07            // ~7% fee on win
const MIN_BET_USD = 1               // $1 floor
const TODAY       = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })

const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })

const MONTHS = { JAN:'01', FEB:'02', MAR:'03', APR:'04', MAY:'05', JUN:'06', JUL:'07', AUG:'08', SEP:'09', OCT:'10', NOV:'11', DEC:'12' }
function parseGameStartIso(ticker) {
  const m = /^KXMLBKS-(\d{2})([A-Z]{3})(\d{2})(\d{2})(\d{2})/.exec(ticker || '')
  if (!m) return null
  const [, yy, mmm, dd, hh, mn] = m
  const mo = MONTHS[mmm]
  return mo ? `20${yy}-${mo}-${dd}T${hh}:${mn}:00.000Z` : null
}

// Outcome cache: pitcher_id|date → ks (or null if unresolvable)
const outcomeCache = new Map()
async function fetchKsFromKsBets(pitcherId, betDate) {
  const r = await db.execute({
    sql: `SELECT actual_ks FROM ks_bets
          WHERE pitcher_id = ? AND bet_date = ? AND actual_ks IS NOT NULL
          LIMIT 1`,
    args: [String(pitcherId), betDate],
  })
  return r.rows[0]?.actual_ks != null ? Number(r.rows[0].actual_ks) : null
}
async function fetchKsFromMlbApi(pitcherId, betDate) {
  const url = `https://statsapi.mlb.com/api/v1/people/${pitcherId}/stats?stats=gameLog&season=2026&group=pitching`
  const res = await fetch(url).then(r => r.ok ? r.json() : null).catch(() => null)
  if (!res) return null
  const splits = res?.stats?.[0]?.splits || []
  const match = splits.find(s => s.date === betDate)
  return match ? Number(match.stat?.strikeOuts ?? 0) : null
}
async function getActualKs(pitcherId, betDate) {
  const key = `${pitcherId}|${betDate}`
  if (outcomeCache.has(key)) return outcomeCache.get(key)
  let ks = await fetchKsFromKsBets(pitcherId, betDate)
  if (ks == null) ks = await fetchKsFromMlbApi(pitcherId, betDate)
  outcomeCache.set(key, ks)
  return ks
}

// Sizing: 3% of bankroll cap, $5 tail cap when ask < 25¢, $1 floor.
function sizeBet(askCents) {
  const baseUsd = Math.min(BANKROLL * PCT_CAP, askCents < TAIL_THRESH ? TAIL_CAP_USD : Infinity)
  const usd = Math.max(MIN_BET_USD, baseUsd)
  const contracts = Math.max(1, Math.floor(usd / (askCents / 100)))
  return { usd: contracts * (askCents / 100), contracts }
}

// P&L: win = contracts × (100 - askCents)/100 × (1 - fee)
//      loss = -contracts × askCents/100
function computePnl(side, askCents, contracts, actualKs, strike) {
  const won = side === 'YES' ? actualKs >= strike : actualKs < strike
  if (won) return contracts * ((100 - askCents) / 100) * (1 - KALSHI_FEE)
  return -contracts * (askCents / 100)
}

// 1) Pull all (pitcher_id, game_date, ticker) groups since Apr 28, excluding today's
//    actual cross-strike fires. We use the snapshot row closest to game start per ticker.
const groupRows = await db.execute(`
  SELECT pitcher_id, pitcher_name, game_date, ticker, strike,
         yes_bid, yes_ask, yes_price,
         captured_at
  FROM market_snapshots
  WHERE game_date >= '2026-04-28' AND game_date <= '2026-05-05'
    AND yes_bid IS NOT NULL AND yes_ask IS NOT NULL
    AND (yes_bid + yes_ask) > 2 AND (yes_bid + yes_ask) < 198
    AND ticker IS NOT NULL AND pitcher_id IS NOT NULL AND strike IS NOT NULL
`)
console.log(`Loaded ${groupRows.rows.length} pre-game snapshot rows`)

// Group by (pitcher_id, game_date, strike) → keep snapshot closest to game start
const closest = new Map()
for (const r of groupRows.rows) {
  const startIso = parseGameStartIso(r.ticker)
  if (!startIso) continue
  const dt = Math.abs(Date.parse(r.captured_at) - Date.parse(startIso))
  // prefer at-or-before game start
  const isBefore = Date.parse(r.captured_at) <= Date.parse(startIso)
  const score = (isBefore ? 0 : 1e15) + dt
  const key = `${r.pitcher_id}|${r.game_date}|${r.strike}`
  const cur = closest.get(key)
  if (!cur || score < cur.score) {
    closest.set(key, {
      pitcher_id: String(r.pitcher_id),
      pitcher_name: r.pitcher_name,
      game_date: r.game_date,
      ticker: r.ticker,
      strike: Number(r.strike),
      yes_bid: Number(r.yes_bid),
      yes_ask: Number(r.yes_ask),
      market_mid: (Number(r.yes_bid) + Number(r.yes_ask)) / 2,
      score,
    })
  }
}
console.log(`Reduced to ${closest.size} (pitcher, day, strike) chain rows`)

// Group by (pitcher_id, game_date) → array of strike rows
const byPitcherDay = new Map()
for (const v of closest.values()) {
  const key = `${v.pitcher_id}|${v.game_date}`
  if (!byPitcherDay.has(key)) byPitcherDay.set(key, [])
  byPitcherDay.get(key).push(v)
}
console.log(`${byPitcherDay.size} pitcher-day combinations to evaluate\n`)

// 2) Generate candidates and simulate fills
const fills = []
const skipped = { fewStrikes: 0, noCandidates: 0, noOutcome: 0, today: 0 }

for (const [key, chain] of byPitcherDay) {
  const [pitcherId, betDate] = key.split('|')
  const pitcherName = chain[0].pitcher_name
  if (chain.length < 4) { skipped.fewStrikes++; continue }
  if (betDate === TODAY) { skipped.today++; continue }

  const candidates = generateCrossStrikeCandidates(chain)
  if (candidates.length === 0) { skipped.noCandidates++; continue }

  const actualKs = await getActualKs(pitcherId, betDate)
  if (actualKs == null) { skipped.noOutcome++; continue }

  for (const c of candidates) {
    const ask = c.ask_cents
    const { usd, contracts } = sizeBet(ask)
    const pnl = computePnl(c.side, ask, contracts, actualKs, c.strike)
    fills.push({
      bet_date:    betDate,
      pitcher:     pitcherName,
      side:        c.side,
      strike:      c.strike,
      residual_c:  Math.round(c.cross_strike_residual * 100),  // cents
      fit_lambda:  c.cross_strike_fit_lambda,
      ask_cents:   ask,
      contracts,
      stake_usd:   usd,
      actual_ks:   actualKs,
      won:         (c.side === 'YES' ? actualKs >= c.strike : actualKs < c.strike) ? 1 : 0,
      pnl_usd:     pnl,
    })
  }
}

// 3) Report
fills.sort((a, b) => a.bet_date.localeCompare(b.bet_date) || a.pitcher.localeCompare(b.pitcher))

const totalStake = fills.reduce((s, f) => s + f.stake_usd, 0)
const totalPnl   = fills.reduce((s, f) => s + f.pnl_usd, 0)
const wins       = fills.filter(f => f.won).length
const losses     = fills.length - wins

console.log(`══════════════════════════════════════════════════════════════════`)
console.log(`  CROSS-STRIKE BACKTEST  Apr 28 → May 5  (bankroll=$${BANKROLL})`)
console.log(`══════════════════════════════════════════════════════════════════\n`)
console.log(`Pitcher-days evaluated: ${byPitcherDay.size}`)
console.log(`  skipped (<4 strikes):     ${skipped.fewStrikes}`)
console.log(`  skipped (no candidates):  ${skipped.noCandidates}`)
console.log(`  skipped (no outcome):     ${skipped.noOutcome}`)
console.log(`  skipped (today):          ${skipped.today}`)

console.log(`\nFires: ${fills.length}  ·  Wins: ${wins}  ·  Losses: ${losses}  ·  Win rate: ${fills.length ? (wins/fills.length*100).toFixed(1) : 0}%`)
console.log(`Total staked: $${totalStake.toFixed(2)}`)
console.log(`Total P&L:    ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`)
console.log(`ROI:          ${totalStake ? ((totalPnl/totalStake)*100).toFixed(1) : 0}%\n`)

console.log('By day:')
const byDay = new Map()
for (const f of fills) {
  const cur = byDay.get(f.bet_date) ?? { n: 0, w: 0, stake: 0, pnl: 0 }
  cur.n++; if (f.won) cur.w++; cur.stake += f.stake_usd; cur.pnl += f.pnl_usd
  byDay.set(f.bet_date, cur)
}
for (const [d, s] of [...byDay.entries()].sort()) {
  console.log(`  ${d}: ${s.n} bets · ${s.w}W/${s.n-s.w}L (${(s.w/s.n*100).toFixed(0)}%) · staked $${s.stake.toFixed(2)} · P&L ${s.pnl >= 0 ? '+' : ''}$${s.pnl.toFixed(2)}`)
}

console.log('\nBy side:')
for (const side of ['YES','NO']) {
  const sub = fills.filter(f => f.side === side)
  if (!sub.length) continue
  const w = sub.filter(f => f.won).length
  const stake = sub.reduce((s,f) => s + f.stake_usd, 0)
  const pnl   = sub.reduce((s,f) => s + f.pnl_usd, 0)
  console.log(`  ${side}: ${sub.length} bets · ${w}W/${sub.length-w}L (${(w/sub.length*100).toFixed(0)}%) · staked $${stake.toFixed(2)} · P&L ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`)
}

console.log('\nFire detail:')
console.log('  date       pitcher                 side  K    ask  c   stake   resid  λ      ks  W/L   pnl')
for (const f of fills) {
  console.log(`  ${f.bet_date}  ${(f.pitcher ?? '').padEnd(22).slice(0,22)}  ${f.side.padEnd(3)}  ${String(f.strike).padStart(2)}+  ${String(f.ask_cents).padStart(3)}¢  ${String(f.contracts).padStart(2)}  $${f.stake_usd.toFixed(2).padStart(5)}  ${(f.residual_c >= 0 ? '+' : '') + f.residual_c}c   ${f.fit_lambda.toFixed(2).padStart(5)}  ${String(f.actual_ks).padStart(2)}  ${f.won ? '  W ' : '  L '}  ${f.pnl_usd >= 0 ? '+' : ''}$${f.pnl_usd.toFixed(2)}`)
}
