// scripts/live/livePositions.js — Live position dashboard
//
// Prints a per-pitcher real-time view of:
//   - Current K count + batters faced (from MLB live API)
//   - Contracts held per K threshold (from ks_bets)
//   - Current Kalshi ask price vs. break-even price
//   - Live posterior P(win) using Bayesian λ update
//   - Game reserve budget remaining
//
// Usage: node scripts/live/livePositions.js [--date YYYY-MM-DD] [--watch]
//        --watch: refresh every 30 seconds

import 'dotenv/config'
import axios from 'axios'
import * as db from '../../lib/db.js'
import { getAuthHeaders, getMarketPrice } from '../../lib/kalshi.js'
import { parseArgs } from '../../lib/cli-args.js'
import { NB_R, pAtLeast } from '../../lib/strikeout-model.js'

const opts = parseArgs({
  date:  { default: new Date().toISOString().slice(0, 10) },
  watch: { type: 'boolean', default: false },
})
const TODAY = opts.date
const MLB   = 'https://statsapi.mlb.com/api/v1'

// Bayesian posterior blend (mirrors liveMonitor.js computeLiveProb)
function computeLiveProb(lambda, currentKs, currentBF, estimatedTotalBF, strike, nbR = NB_R) {
  if (currentKs >= strike) return 1.0
  if (!lambda || lambda <= 0) return 0

  const observedRate    = currentBF > 0 ? currentKs / currentBF : lambda / Math.max(estimatedTotalBF, 1)
  const PRIOR_WEIGHT_BF = 9
  const priorRate       = lambda / Math.max(estimatedTotalBF, 1)
  const posteriorRate   = (priorRate * PRIOR_WEIGHT_BF + observedRate * currentBF) / (PRIOR_WEIGHT_BF + currentBF)
  const remainingBF     = Math.max(0, estimatedTotalBF - currentBF)
  const lambdaRemaining = posteriorRate * remainingBF
  const needed          = strike - currentKs
  if (needed <= 0) return 1.0
  if (lambdaRemaining <= 0) return 0

  return pAtLeast(lambdaRemaining, needed)
}

async function fetchLiveBoxscore(gameId) {
  try {
    const res = await axios.get(`${MLB}/game/${gameId}/linescore`, { timeout: 5000 })
    return res.data
  } catch { return null }
}

async function fetchBoxscore(gameId) {
  try {
    const res = await axios.get(`${MLB}/game/${gameId}/boxscore`, {
      params: { fields: 'teams.home.pitchers,teams.away.pitchers,teams.home.players,teams.away.players' },
      timeout: 5000,
    })
    return res.data
  } catch { return null }
}

function extractStarterKs(boxscore, pitcherId) {
  for (const side of ['home', 'away']) {
    const team = boxscore?.teams?.[side]
    if (!team?.pitchers?.length) continue
    const starterId = String(team.pitchers[0])
    if (starterId !== String(pitcherId)) continue
    const playerKey = `ID${pitcherId}`
    const stats = team.players?.[playerKey]?.stats?.pitching
    return {
      ks:       stats?.strikeOuts      ?? null,
      bf:       stats?.battersFaced    ?? null,
      pitches:  stats?.pitchesThrown   ?? null,
      ip:       stats?.inningsPitched  ?? null,
      isCurrent: true,
    }
  }
  return null
}

async function getKalshiPrice(ticker, creds) {
  try {
    // ticker is baseTicker without threshold — e.g. KXMLBKS-26APR241840DETCIN-DETFVALDEZ59
    // We need all threshold markets for this pitcher
    const eventTicker = ticker.split('-').slice(0, -1).join('-')
    const headers = getAuthHeaders('GET', `/trade-api/v2/markets`, creds)
    const res = await axios.get('https://api.elections.kalshi.com/trade-api/v2/markets', {
      params: { event_ticker: eventTicker, series_ticker: 'KXMLBKS', status: 'open', limit: 20 },
      headers,
      timeout: 8000,
    })
    const markets = (res.data?.markets || []).filter(m => m.ticker.startsWith(ticker + '-'))
    const priceMap = {}
    for (const m of markets) {
      const suffix = m.ticker.replace(ticker + '-', '')
      const strike = parseInt(suffix, 10)
      if (!isNaN(strike)) {
        priceMap[strike] = {
          yes_ask: m.yes_ask,
          yes_bid: m.yes_bid,
          no_ask:  m.no_ask,
          no_bid:  m.no_bid,
        }
      }
    }
    return priceMap
  } catch { return {} }
}

async function render() {
  if (opts.watch) process.stdout.write('\x1Bc')  // clear screen in watch mode

  const header = `LIVE POSITIONS  ${TODAY}  ${new Date().toLocaleTimeString('en-US', { hour12: false })}`
  console.log(`\n${'═'.repeat(70)}`)
  console.log(header)
  console.log(`${'═'.repeat(70)}`)

  // Active games today
  const games = await db.all(
    `SELECT g.id, g.team_home, g.team_away, g.pitcher_home_id, g.pitcher_away_id,
            g.game_time, g.status
     FROM games g
     WHERE g.date = ?
       AND g.status IN ('in_progress', 'scheduled', 'final')
     ORDER BY g.game_time`,
    [TODAY],
  )

  if (!games.length) {
    console.log('No games found for today.')
    await db.close()
    return
  }

  // Load active bettors
  const users = await db.all(
    `SELECT id, name, kalshi_key_id, kalshi_private_key FROM users WHERE active_bettor = 1`,
  )
  const primaryUser = users[0] ?? {}
  const primaryCreds = { keyId: primaryUser.kalshi_key_id, privateKey: primaryUser.kalshi_private_key }

  for (const game of games) {
    const label = `${game.team_away}@${game.team_home}`
    const status = game.status === 'in_progress' ? '🟢 LIVE' : game.status === 'final' ? '✓ FINAL' : '⏳ PRE'

    // Open positions for this game
    const positions = await db.all(
      `SELECT pitcher_id, pitcher_name, strike, side, model_prob, lambda,
              fill_price, filled_contracts, capital_at_risk, ticker, result,
              actual_ks, bet_mode, market_mid
       FROM ks_bets
       WHERE bet_date = ? AND (pitcher_id = ? OR pitcher_id = ?)
         AND paper = 0
       ORDER BY pitcher_name, side, strike`,
      [TODAY, String(game.pitcher_home_id), String(game.pitcher_away_id)],
    )

    if (!positions.length) continue

    // Group by pitcher
    const byPitcher = new Map()
    for (const p of positions) {
      if (!byPitcher.has(p.pitcher_id)) byPitcher.set(p.pitcher_id, { name: p.pitcher_name, lambda: p.lambda, ticker: p.ticker, bets: [] })
      byPitcher.get(p.pitcher_id).bets.push(p)
    }

    // Live boxscore for in_progress games
    let lsData = null
    let boxData = null
    if (game.status === 'in_progress') {
      ;[lsData, boxData] = await Promise.all([fetchLiveBoxscore(game.id), fetchBoxscore(game.id)])
    }

    // Game reserves
    const reserves = await db.all(
      `SELECT pitcher_id, reserved_usd, used_usd
       FROM game_reserves
       WHERE game_id = ? AND bet_date = ?`,
      [game.id, TODAY],
    )
    const reserveMap = new Map(reserves.map(r => [r.pitcher_id, r]))

    console.log(`\n${status}  ${label}`)
    console.log(`${'─'.repeat(60)}`)

    for (const [pitcherId, info] of byPitcher) {
      // Live K count
      let currentKs = null
      let currentBF = null
      let pitches   = null
      if (boxData) {
        const s = extractStarterKs(boxData, pitcherId)
        if (s) { currentKs = s.ks; currentBF = s.bf; pitches = s.pitches }
      }
      if (game.status === 'final') {
        const settled = info.bets.find(b => b.actual_ks != null)
        if (settled) currentKs = settled.actual_ks
      }

      const lambda  = info.lambda
      const estBF   = lambda != null ? lambda / 0.22 : 27  // ~22% K rate → BF estimate

      // Kalshi prices for this pitcher's base ticker
      const baseTicker = info.ticker?.replace(/-\d+$/, '')
      const priceMap = baseTicker && game.status === 'in_progress'
        ? await getKalshiPrice(baseTicker, primaryCreds)
        : {}

      const reserve = reserveMap.get(String(pitcherId))
      const reserveStr = reserve
        ? `reserve $${(reserve.reserved_usd - reserve.used_usd).toFixed(0)} remain / $${reserve.reserved_usd.toFixed(0)}`
        : ''

      const ksStr   = currentKs != null ? `${currentKs}K` : '?K'
      const bfStr   = currentBF != null ? `${currentBF}BF` : ''
      const ptcStr  = pitches != null ? `${pitches}P` : ''
      const lamStr  = lambda  != null ? `λ=${lambda.toFixed(1)}` : ''
      const live    = [ksStr, bfStr, ptcStr].filter(Boolean).join(' ')
      console.log(`\n  ${info.name}  ${lamStr}  [${live}]  ${reserveStr}`)

      // Per-position rows
      const openBets   = info.bets.filter(b => !b.result)
      const settledBets = info.bets.filter(b => b.result === 'win' || b.result === 'loss')

      if (openBets.length) {
        console.log(`  ${'Strike'.padEnd(8)} ${'Side'.padEnd(5)} ${'Qty'.padEnd(5)} ${'Entry'.padEnd(7)} ${'Market'.padEnd(8)} ${'BEven'.padEnd(8)} ${'P(win)'.padEnd(8)} Mode`)
        for (const b of openBets) {
          const qty    = b.filled_contracts ?? '?'
          const entry  = b.fill_price != null ? (b.fill_price * 100).toFixed(0) + '¢' : b.market_mid != null ? `~${b.market_mid.toFixed(0)}¢` : '?'
          const mkt    = priceMap[b.strike]
          const mktStr = mkt
            ? (b.side === 'NO'
                ? (mkt.no_ask != null ? mkt.no_ask + '¢' : '?')
                : (mkt.yes_ask != null ? mkt.yes_ask + '¢' : '?'))
            : '—'

          // Break-even = 1 / (fill_price of the other side)
          const breakEven = b.fill_price != null ? (1 - b.fill_price) * 100 : null
          const beStr  = breakEven != null ? breakEven.toFixed(0) + '¢' : '?'

          // Posterior probability
          let pWinStr = '?'
          if (currentKs != null && currentBF != null && lambda != null) {
            const pWin = computeLiveProb(lambda, currentKs, currentBF, estBF, b.strike)
            pWinStr = (pWin * 100).toFixed(0) + '%'
          }

          const mode = b.bet_mode ? b.bet_mode.replace('dead-path', 'dead').replace('normal', 'norm') : 'norm'
          console.log(`  ${String(b.strike + '+').padEnd(8)} ${b.side.padEnd(5)} ${String(qty).padEnd(5)} ${entry.padEnd(7)} ${mktStr.padEnd(8)} ${beStr.padEnd(8)} ${pWinStr.padEnd(8)} ${mode}`)
        }
      }

      if (settledBets.length) {
        const wins   = settledBets.filter(b => b.result === 'win')
        const losses = settledBets.filter(b => b.result === 'loss')
        const pnl    = settledBets.reduce((s, b) => s + (b.pnl ?? 0), 0)
        console.log(`  Settled: ${wins.length}W / ${losses.length}L  pnl=${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`)
      }
    }
  }

  // Daily P&L summary — use actual pnl field (not capital_at_risk proxy)
  const dailyRows = await db.all(
    `SELECT result, SUM(pnl) AS pnl, COUNT(*) AS n
     FROM ks_bets
     WHERE bet_date = ? AND (paper = 0 OR paper IS NULL) AND result IN ('win','loss')
     GROUP BY result`,
    [TODAY],
  )
  if (dailyRows.length) {
    const wins   = dailyRows.find(r => r.result === 'win')
    const losses = dailyRows.find(r => r.result === 'loss')
    const pnl    = (wins?.pnl ?? 0) + (losses?.pnl ?? 0)
    console.log(`\n${'─'.repeat(60)}`)
    console.log(`Daily settled: ${wins?.n ?? 0}W / ${losses?.n ?? 0}L  pnl=${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`)
  }

  console.log('')
}

async function main() {
  await db.migrate()

  if (opts.watch) {
    await render()
    setInterval(async () => {
      try { await render() } catch (err) { console.error('[watch error]', err.message) }
    }, 30_000)
  } else {
    await render()
    await db.close()
  }
}

main().catch(err => { console.error(err); process.exit(1) })
