// scripts/f5Backtest.mjs
//
// Question: does our pitcher-signal model predict F5 (first 5 innings) total
// runs well enough to disagree with Kalshi's pre-game market at a profitable
// margin?
//
// Test discipline:
//   - Pre-registered model and strategy. Coded BEFORE looking at results.
//   - No future bias: pitcher_signals.signal_date locked to game_date; all
//     model inputs are values available before first pitch. Market price is
//     pulled from a candlestick BEFORE the scheduled game start.
//   - No cherry picking: every strike (>0.5 … >6.5) is evaluated and reported
//     independently. Aggregate stats include all of them. Per-strike breakdown
//     is shown so the reader sees if profitability concentrates anywhere.
//   - Honest accounting: 7¢ Kalshi taker fee subtracted from every bet. Show
//     gross AND net.
//
// Pre-registered model:
//   For each starter:
//     lambda_starter_F5 = era_l5 × min(avg_innings_l5, 5) / 9
//     bullpen_innings_F5 = max(5 − avg_innings_l5, 0)
//     lambda_bullpen_F5 = 4.20 × bullpen_innings_F5 / 9       (MLB-avg bullpen ERA)
//     lambda_team_runs_allowed_F5 = lambda_starter_F5 + lambda_bullpen_F5
//
//   Combined game lambda:
//     λ = home_starter.lambda_team_runs_allowed_F5 + away_starter.lambda_team_runs_allowed_F5
//     (Each starter's "runs allowed" = runs scored by the opposing team they
//     face, which sums to total game F5 runs.)
//
//   Outcome probability:
//     P(F5_total > strike) = 1 − Poisson_CDF(floor(strike), λ)
//
// Pre-registered strategies:
//   For each (game, strike) we have model_p_yes and market_yes_ask, market_no_ask.
//   We evaluate three edge thresholds × two sides:
//     YES-side edge ≥ 0, ≥ 0.05, ≥ 0.10
//     NO-side  edge ≥ 0, ≥ 0.05, ≥ 0.10
//   Fire only if edge ≥ threshold. Bet size = 1 contract (uniform).
//   Fill price = ask side (taker assumption — pessimistic).
//
// Outputs:
//   /tmp/f5_backtest_per_bet.csv
//   /tmp/f5_backtest_per_game.csv
//   /tmp/f5_backtest_summary.txt
//   /tmp/f5_backtest_calibration.txt

import 'dotenv/config'
import { createClient } from '@libsql/client'
import { writeFile } from 'fs/promises'

const WINDOW_START = '2026-04-27'
const WINDOW_END   = '2026-05-10'
const STRIKES      = [0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5]
const FEE_PCT      = 0.07
const BULLPEN_ERA  = 4.20  // MLB-average bullpen ERA assumption — held constant
const PRICE_LOOKBACK_MIN = 120   // look for quote within T-120min..T-15min
const PRICE_BLACKOUT_MIN = 15
const MLB_DELAY_MS = 120
const KALSHI_DELAY_MS = 80

const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })

function argv(name) {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : null
}
const LIMIT = Number(argv('limit') ?? 0) || null

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// ─ Math helpers ──────────────────────────────────────────────────────────────
// Poisson CDF: P(X ≤ k) for X ~ Poisson(λ). Stable for small λ (≤ 30).
function poissonPmf(k, λ) {
  if (k < 0) return 0
  let p = Math.exp(-λ)
  for (let i = 1; i <= k; i++) p *= λ / i
  return p
}
function poissonCdf(k, λ) {
  let s = 0
  for (let i = 0; i <= k; i++) s += poissonPmf(i, λ)
  return s
}
function pOverStrike(strike, λ) {
  // strike is a half-integer like 4.5. P(X > 4.5) = P(X ≥ 5) = 1 − P(X ≤ 4)
  const k = Math.floor(strike)
  return 1 - poissonCdf(k, λ)
}

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

async function kalshiFetch(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(15_000) })
      if (!r.ok) { await sleep(500); continue }
      return await r.json()
    } catch { await sleep(500) }
  }
  return null
}

function extractStarter(box, side) {
  const team = box?.teams?.[side]
  const pitchers = team?.pitchers ?? []
  if (!pitchers.length) return null
  const sid = pitchers[0]
  const pl = team.players?.[`ID${sid}`]
  if (!pl) return null
  return {
    id:   String(sid),
    name: pl.person?.fullName ?? String(sid),
  }
}

function computeF5Lambda({ era_l5, avg_innings_l5 }) {
  const ip5 = Math.min(avg_innings_l5, 5)
  const bullpenIp = Math.max(5 - avg_innings_l5, 0)
  return (era_l5 * ip5) / 9 + (BULLPEN_ERA * bullpenIp) / 9
}

function computeActualF5(linescore) {
  const innings = linescore?.innings ?? []
  let total = 0
  for (let i = 0; i < Math.min(5, innings.length); i++) {
    total += Number(innings[i]?.away?.runs ?? 0)
    total += Number(innings[i]?.home?.runs ?? 0)
  }
  return total
}

async function getStarterSignal(pitcherId, gameDate) {
  const r = await db.execute({
    sql: `SELECT pitcher_name, era_l5, avg_innings_l5, confidence
          FROM pitcher_signals
          WHERE pitcher_id = ? AND signal_date = ?
          LIMIT 1`,
    args: [pitcherId, gameDate],
  })
  return r.rows[0] ?? null
}

// Build Kalshi F5 event ticker for a game. Kalshi convention: YYMMMDDHHMMAWAYHOME
// in ET local time. The /feed/live response has gameData.datetime.dateTime in UTC.
function buildF5EventTicker({ gameDateTimeUtc, awayAbbr, homeAbbr }) {
  const d = new Date(gameDateTimeUtc)
  // Convert UTC to ET. ET = UTC-4 during DST (Apr-Nov), UTC-5 otherwise.
  // Our window is May 2026 — fully in DST. Use -4h.
  const et = new Date(d.getTime() - 4 * 3600_000)
  const yy = String(et.getUTCFullYear()).slice(-2)
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC']
  const mmm = months[et.getUTCMonth()]
  const dd = String(et.getUTCDate()).padStart(2, '0')
  const hh = String(et.getUTCHours()).padStart(2, '0')
  const mi = String(et.getUTCMinutes()).padStart(2, '0')
  return `KXMLBF5TOTAL-${yy}${mmm}${dd}${hh}${mi}${awayAbbr}${homeAbbr}`
}

// Best pre-game quote in the lookback window. Returns { yes_bid, yes_ask, ts }
// or null. Uses the LATEST 1-min candle in [game_start - 120m, game_start - 15m]
// with both bid and ask present.
async function getPreGameQuote(ticker, gameStartUtc) {
  const startTs = Math.floor(new Date(gameStartUtc).getTime() / 1000) - PRICE_LOOKBACK_MIN * 60
  const endTs   = Math.floor(new Date(gameStartUtc).getTime() / 1000) - PRICE_BLACKOUT_MIN * 60
  const url = `https://api.elections.kalshi.com/trade-api/v2/series/KXMLBF5TOTAL/markets/${ticker}/candlesticks?start_ts=${startTs}&end_ts=${endTs}&period_interval=1`
  const d = await kalshiFetch(url)
  await sleep(KALSHI_DELAY_MS)
  if (!d?.candlesticks?.length) return null
  // Take the last candle that has both bid and ask close defined.
  for (let i = d.candlesticks.length - 1; i >= 0; i--) {
    const c = d.candlesticks[i]
    const bid = Number(c?.yes_bid?.close_dollars)
    const ask = Number(c?.yes_ask?.close_dollars)
    if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0) {
      return { yes_bid: bid, yes_ask: ask, ts: c.end_period_ts }
    }
  }
  return null
}

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

function quantile(arr, q) {
  if (!arr.length) return null
  const sorted = [...arr].sort((a, b) => a - b)
  const idx = (sorted.length - 1) * q
  const lo = Math.floor(idx), hi = Math.ceil(idx)
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
}
function mean(arr) { return arr.length ? arr.reduce((s,v) => s+v, 0) / arr.length : 0 }

async function main() {
  let games = await getGames()
  if (LIMIT) games = games.slice(0, LIMIT)
  console.log(`F5 Backtest — ${WINDOW_START} → ${WINDOW_END}${LIMIT ? ` (LIMIT=${LIMIT})` : ''}`)
  console.log(`Games to scan: ${games.length}\n`)

  const perGame = []   // one row per game
  const perBet  = []   // one row per (game, strike) — model output + market quote + outcome
  const skipped = []

  let scanned = 0
  for (const g of games) {
    scanned++
    if (scanned % 25 === 0) console.log(`  ...${scanned}/${games.length} games`)

    const feed = await mlbFetch(`https://statsapi.mlb.com/api/v1.1/game/${g.game_id}/feed/live`)
    await sleep(MLB_DELAY_MS)
    if (!feed) { skipped.push({ game_id: g.game_id, reason: 'feed_fetch' }); continue }

    const gameStartUtc = feed?.gameData?.datetime?.dateTime
    const awayAbbr = feed?.gameData?.teams?.away?.abbreviation
    const homeAbbr = feed?.gameData?.teams?.home?.abbreviation
    if (!gameStartUtc || !awayAbbr || !homeAbbr) { skipped.push({ game_id: g.game_id, reason: 'missing_meta' }); continue }

    const box = feed?.liveData?.boxscore
    const linescore = feed?.liveData?.linescore
    const homeStarter = extractStarter(box, 'home')
    const awayStarter = extractStarter(box, 'away')
    if (!homeStarter || !awayStarter) { skipped.push({ game_id: g.game_id, reason: 'missing_starter' }); continue }

    const homeSig = await getStarterSignal(homeStarter.id, g.game_date)
    const awaySig = await getStarterSignal(awayStarter.id, g.game_date)
    if (!homeSig || !awaySig) { skipped.push({ game_id: g.game_id, reason: 'missing_signal', home: !!homeSig, away: !!awaySig }); continue }
    if (homeSig.era_l5 == null || awaySig.era_l5 == null || homeSig.avg_innings_l5 == null || awaySig.avg_innings_l5 == null) {
      skipped.push({ game_id: g.game_id, reason: 'null_signal_fields' }); continue
    }

    const lambdaHome = computeF5Lambda({ era_l5: Number(homeSig.era_l5), avg_innings_l5: Number(homeSig.avg_innings_l5) })
    const lambdaAway = computeF5Lambda({ era_l5: Number(awaySig.era_l5), avg_innings_l5: Number(awaySig.avg_innings_l5) })
    const λ = lambdaHome + lambdaAway

    const actualF5 = computeActualF5(linescore)
    const innings = linescore?.innings ?? []
    if (innings.length < 5) { skipped.push({ game_id: g.game_id, reason: 'short_game' }); continue }

    const eventTicker = buildF5EventTicker({ gameDateTimeUtc: gameStartUtc, awayAbbr, homeAbbr })

    const gameRow = {
      game_id: g.game_id, date: g.game_date, event: eventTicker,
      away: awayStarter.name, home: homeStarter.name,
      away_era_l5: awaySig.era_l5, home_era_l5: homeSig.era_l5,
      away_ip_l5: awaySig.avg_innings_l5, home_ip_l5: homeSig.avg_innings_l5,
      away_conf: awaySig.confidence, home_conf: homeSig.confidence,
      lambda_away: lambdaAway, lambda_home: lambdaHome, lambda_total: λ,
      actual_f5: actualF5,
      game_start_utc: gameStartUtc,
    }
    perGame.push(gameRow)

    // For each strike, pull pre-game quote and evaluate
    for (let s = 0; s < STRIKES.length; s++) {
      const strike = STRIKES[s]
      const ticker = `${eventTicker}-${s + 1}`
      const quote = await getPreGameQuote(ticker, gameStartUtc)
      const model_p_yes = pOverStrike(strike, λ)
      const actual_yes = actualF5 > strike ? 1 : 0
      const bet = {
        game_id: g.game_id, date: g.game_date, ticker, strike,
        lambda: λ, model_p_yes, actual_f5: actualF5, actual_yes,
        yes_ask: quote?.yes_ask ?? null,
        yes_bid: quote?.yes_bid ?? null,
        quote_ts: quote?.ts ?? null,
      }
      if (quote) {
        // Ask side prices (what we'd pay to enter as a taker)
        const yes_ask_c = quote.yes_ask * 100
        const no_ask_c  = (1 - quote.yes_bid) * 100  // buying NO = selling YES bid
        bet.market_p_yes = quote.yes_ask    // conservative: ask side as implied prob
        bet.edge_yes = model_p_yes - quote.yes_ask
        bet.edge_no  = (1 - model_p_yes) - (1 - quote.yes_bid)
        bet.yes_settle = actual_yes ? 100 : 0
        bet.no_settle  = actual_yes ? 0   : 100
        bet.yes_pnl_gross = bet.yes_settle - yes_ask_c
        bet.no_pnl_gross  = bet.no_settle  - no_ask_c
        bet.yes_pnl_net   = bet.yes_pnl_gross - FEE_PCT * yes_ask_c
        bet.no_pnl_net    = bet.no_pnl_gross  - FEE_PCT * no_ask_c
      }
      perBet.push(bet)
    }
  }

  console.log(`\nGames evaluated: ${perGame.length}`)
  console.log(`Skipped: ${skipped.length} — ${JSON.stringify(skipped.reduce((m, s) => { m[s.reason] = (m[s.reason] ?? 0) + 1; return m }, {}))}`)
  console.log(`Per-strike rows: ${perBet.length}`)
  const betsWithQuote = perBet.filter(b => b.yes_ask != null)
  console.log(`  with market quote: ${betsWithQuote.length}`)

  // ── Reports ─────────────────────────────────────────────────────────────────
  const out = []
  out.push(`F5 Backtest — ${WINDOW_START} → ${WINDOW_END}`)
  out.push(`Generated: ${new Date().toISOString()}`)
  out.push(``)
  out.push(`Pre-registered model:`)
  out.push(`  per starter: λ = era_l5 × min(avg_ip_l5, 5)/9 + ${BULLPEN_ERA} × max(5 − avg_ip_l5, 0)/9`)
  out.push(`  game total:  λ_combined = home + away`)
  out.push(`  P(F5 > strike) = 1 − Poisson_CDF(floor(strike), λ_combined)`)
  out.push(``)
  out.push(`Diagnostics:`)
  out.push(`  Games scanned:       ${games.length}`)
  out.push(`  Games evaluated:     ${perGame.length}`)
  out.push(`  Games skipped:       ${skipped.length}`)
  for (const [reason, count] of Object.entries(skipped.reduce((m, s) => { m[s.reason] = (m[s.reason] ?? 0) + 1; return m }, {}))) {
    out.push(`    ${reason}: ${count}`)
  }
  out.push(`  Per-strike rows:     ${perBet.length}`)
  out.push(`  Rows with quote:     ${betsWithQuote.length} (${(100*betsWithQuote.length/perBet.length).toFixed(1)}%)`)
  out.push(``)

  // Model calibration: bin model_p_yes into deciles, show actual yes rate per bin
  out.push(`Model calibration (ALL strikes, no market filter):`)
  out.push(`  bin    model_p_yes range │ n bets │ actual yes rate │ mean model p │ Δ (actual − model)`)
  out.push(`  ─────────────────────────────────────────────────────────────────────────────`)
  const bins = [[0,0.1],[0.1,0.2],[0.2,0.3],[0.3,0.4],[0.4,0.5],[0.5,0.6],[0.6,0.7],[0.7,0.8],[0.8,0.9],[0.9,1.001]]
  for (const [lo, hi] of bins) {
    const inBin = perBet.filter(b => b.model_p_yes >= lo && b.model_p_yes < hi)
    if (!inBin.length) continue
    const actualRate = mean(inBin.map(b => b.actual_yes))
    const meanModel = mean(inBin.map(b => b.model_p_yes))
    out.push(`  [${lo.toFixed(1)}, ${hi.toFixed(1)})  │ ${String(inBin.length).padStart(5)}  │      ${(100*actualRate).toFixed(1).padStart(5)}%     │     ${(100*meanModel).toFixed(1).padStart(5)}%   │   ${(100*(actualRate-meanModel)).toFixed(1).padStart(6)}pp`)
  }
  // Brier score = mean((model_p - actual)^2). Lower is better. 0.25 = random.
  const brier = mean(perBet.map(b => (b.model_p_yes - b.actual_yes) ** 2))
  out.push(`  Brier score: ${brier.toFixed(4)}  (0.25 = random binary baseline; lower is better)`)
  out.push(``)

  // Per-strike summary
  out.push(`Per-strike summary:`)
  out.push(`  strike │  n  │ actual yes% │ mean model p │ mean yes_ask │ mean yes_bid │ pp gap (actual − market_ask)`)
  out.push(`  ───────────────────────────────────────────────────────────────────────────────────────`)
  for (const strike of STRIKES) {
    const arr = perBet.filter(b => b.strike === strike)
    const arrQ = arr.filter(b => b.yes_ask != null)
    const actualRate = mean(arr.map(b => b.actual_yes))
    const meanModel = mean(arr.map(b => b.model_p_yes))
    const meanAsk = arrQ.length ? mean(arrQ.map(b => b.yes_ask)) : null
    const meanBid = arrQ.length ? mean(arrQ.map(b => b.yes_bid)) : null
    const gap = meanAsk != null ? actualRate - meanAsk : null
    out.push(`  >${strike} │ ${String(arr.length).padStart(3)} │   ${(100*actualRate).toFixed(1).padStart(5)}%   │    ${(100*meanModel).toFixed(1).padStart(5)}%   │    ${meanAsk != null ? (100*meanAsk).toFixed(1).padStart(5) : '  -  '}%   │    ${meanBid != null ? (100*meanBid).toFixed(1).padStart(5) : '  -  '}%   │   ${gap != null ? (100*gap).toFixed(1).padStart(6) : '  -  '}pp`)
  }
  out.push(``)

  // Strategy backtest — fire only if edge >= threshold, take ask side
  out.push(`Strategy results (taker fills @ ask side, ${(FEE_PCT*100).toFixed(0)}% fee per side):`)
  out.push(`  side │ edge_thresh │  n bets │ win % │ gross PnL │ gross ROI │ net PnL │ net ROI`)
  out.push(`  ──────────────────────────────────────────────────────────────────────────────`)
  for (const side of ['yes', 'no']) {
    for (const t of [0.0, 0.05, 0.10]) {
      const bets = betsWithQuote.filter(b => (side === 'yes' ? b.edge_yes : b.edge_no) >= t)
      const n = bets.length
      if (!n) {
        out.push(`  ${side.toUpperCase().padEnd(3)}  │   ≥${(100*t).toFixed(0).padStart(3)}%    │    0   │   -   │     -     │     -     │    -    │    -`)
        continue
      }
      const win = bets.filter(b => (side === 'yes' ? b.actual_yes : !b.actual_yes)).length
      const grossPnl = bets.reduce((s, b) => s + (side === 'yes' ? b.yes_pnl_gross : b.no_pnl_gross), 0)
      const netPnl   = bets.reduce((s, b) => s + (side === 'yes' ? b.yes_pnl_net   : b.no_pnl_net  ), 0)
      const stake    = bets.reduce((s, b) => s + (side === 'yes' ? b.yes_ask : (1 - b.yes_bid)) * 100, 0)
      const grossRoi = stake > 0 ? grossPnl / stake : 0
      const netRoi   = stake > 0 ? netPnl   / stake : 0
      out.push(`  ${side.toUpperCase().padEnd(3)}  │   ≥${(100*t).toFixed(0).padStart(3)}%    │ ${String(n).padStart(4)}   │ ${(100*win/n).toFixed(1).padStart(4)}% │ ${grossPnl >= 0 ? '+' : ''}$${(grossPnl/100).toFixed(2).padStart(7)}  │ ${(100*grossRoi).toFixed(1).padStart(6)}%   │ ${netPnl >= 0 ? '+' : ''}$${(netPnl/100).toFixed(2).padStart(6)} │ ${(100*netRoi).toFixed(1).padStart(5)}%`)
    }
  }
  out.push(``)

  // Per-strike P/L breakdown for the headline strategy (edge ≥ 5%)
  out.push(`Per-strike breakdown @ edge ≥ 5% (no cherry picking — shows which strikes carry the strategy):`)
  out.push(`  side │ strike │  n  │ win% │ gross PnL │ net PnL`)
  out.push(`  ──────────────────────────────────────────────────`)
  for (const side of ['yes', 'no']) {
    for (const strike of STRIKES) {
      const arr = betsWithQuote.filter(b => b.strike === strike && (side === 'yes' ? b.edge_yes : b.edge_no) >= 0.05)
      if (!arr.length) continue
      const win = arr.filter(b => (side === 'yes' ? b.actual_yes : !b.actual_yes)).length
      const grossPnl = arr.reduce((s, b) => s + (side === 'yes' ? b.yes_pnl_gross : b.no_pnl_gross), 0)
      const netPnl   = arr.reduce((s, b) => s + (side === 'yes' ? b.yes_pnl_net   : b.no_pnl_net  ), 0)
      out.push(`  ${side.toUpperCase().padEnd(3)}  │  >${strike}  │ ${String(arr.length).padStart(3)} │ ${(100*win/arr.length).toFixed(1).padStart(4)}% │ ${grossPnl >= 0 ? '+' : ''}$${(grossPnl/100).toFixed(2).padStart(7)}  │ ${netPnl >= 0 ? '+' : ''}$${(netPnl/100).toFixed(2).padStart(6)}`)
    }
  }
  out.push(``)

  out.push(`Notes / caveats:`)
  out.push(`  • Bullpen ERA fixed at ${BULLPEN_ERA} — does not differentiate strong vs weak pens.`)
  out.push(`  • No park-factor adjustment for runs (we have park_k_factor for Ks, not for runs).`)
  out.push(`  • No weather/umpire adjustment for runs in v0.`)
  out.push(`  • Poisson is under-dispersed vs real run distributions; expect mild miscalibration on the tails.`)
  out.push(`  • Bets within a game are correlated (>4.5 NO and >5.5 NO win together if F5≤4); aggregate ROI may overstate independent-bet performance.`)
  out.push(`  • Pre-game quote is the LAST 1-min candle in [T−120m, T−15m] with both bid+ask > 0; ~liquidity-permitting.`)

  // CSV per-bet detail
  const betHeader = ['game_id','date','ticker','strike','lambda','model_p_yes','actual_f5','actual_yes','yes_bid','yes_ask','edge_yes','edge_no','yes_pnl_gross','no_pnl_gross','yes_pnl_net','no_pnl_net']
  const betCsv = perBet.map(b => betHeader.map(k => b[k] ?? '').join(','))
  await writeFile('/tmp/f5_backtest_per_bet.csv', betHeader.join(',') + '\n' + betCsv.join('\n'))

  const gameHeader = ['game_id','date','event','away','home','away_era_l5','home_era_l5','away_ip_l5','home_ip_l5','lambda_away','lambda_home','lambda_total','actual_f5']
  const gameCsv = perGame.map(g => gameHeader.map(k => g[k] ?? '').join(','))
  await writeFile('/tmp/f5_backtest_per_game.csv', gameHeader.join(',') + '\n' + gameCsv.join('\n'))

  await writeFile('/tmp/f5_backtest_summary.txt', out.join('\n'))
  console.log('\n' + out.join('\n'))
  console.log(`\nWrote:`)
  console.log(`  /tmp/f5_backtest_per_game.csv  (${perGame.length} games)`)
  console.log(`  /tmp/f5_backtest_per_bet.csv   (${perBet.length} bets)`)
  console.log(`  /tmp/f5_backtest_summary.txt`)
}

main().catch(err => { console.error(err); process.exit(1) })
