// scripts/live/inGameEdge.js — Live in-game strikeout edge finder.
//
// Polls active games every POLL_INTERVAL seconds, fetches live pitcher K totals
// and innings pitched from MLB Stats API, Bayesian-updates λ based on observed
// pace, then re-prices open Kalshi KXMLBKS thresholds.
//
// In-game model:
//   1. Observed rate:  k9_live = (actual_Ks / ip_so_far) × 9
//   2. Blend with pre-game prior: k9_updated = w × k9_live + (1-w) × k9_prior
//      w = min(0.75, ip_so_far / 3)  — live data earns up to 75% weight by 3 IP
//   3. TTO penalty: K rate drops ~15% once a starter is in their 3rd time through
//      the order (approx. innings 6+, or after 18 batters faced)
//   4. IP remaining: estimated from historical avg_ip and current ip_so_far
//      ip_remaining = max(0, expected_total_ip - ip_so_far)
//   5. λ_remaining = k9_updated / 9 × ip_remaining
//   6. P(total ≥ n) = P(remaining ≥ n - current_Ks)  via NB(λ_remaining, r)
//
// Edges fire when |model_prob - market_mid| > MIN_EDGE on an open market.
//
// Usage:
//   node scripts/live/inGameEdge.js [--date YYYY-MM-DD] [--interval 120] [--min-edge 0.06]
//   Ctrl+C to stop.

import 'dotenv/config'
import axios from 'axios'
import * as db from '../../lib/db.js'
import { toKalshiAbbr, getAuthHeaders } from '../../lib/kalshi.js'
import { NB_R, LEAGUE_PA_PER_IP, nbCDF, pAtLeast, ipToDecimal } from '../../lib/strikeout-model.js'
import { parseArgs } from '../../lib/cli-args.js'

const opts     = parseArgs({
  date:     { default: new Date().toISOString().slice(0, 10) },
  interval: { type: 'number', default: 120 },
  minEdge:  { flag: 'min-edge', type: 'number', default: 0.06 },
})
const TODAY    = opts.date
const POLL_SEC = opts.interval
const MIN_EDGE = opts.minEdge

const MLB_BASE    = 'https://statsapi.mlb.com/api/v1'
const KALSHI_BASE = 'https://api.elections.kalshi.com/trade-api/v2'

const TTO_PENALTY   = 0.85   // K rate multiplier once into 3rd time through order (~inning 6+)
const TTO_BF_THRESH = 18    // batters faced threshold for TTO3

// ── MLB live data ─────────────────────────────────────────────────────────────

async function fetchLiveBoxScore(gamePk) {
  try {
    const res = await axios.get(`${MLB_BASE}/game/${gamePk}/boxscore`, {
      timeout: 10000,
      validateStatus: s => s >= 200 && s < 500,
    })
    if (res.status >= 400) return null
    return res.data
  } catch { return null }
}

async function fetchLiveLinescore(gamePk) {
  try {
    const res = await axios.get(`${MLB_BASE}/game/${gamePk}/linescore`, {
      timeout: 8000,
      validateStatus: s => s >= 200 && s < 500,
    })
    if (res.status >= 400) return null
    return res.data
  } catch { return null }
}

// Extract starting pitcher live stats from boxscore
function getStarterStats(boxscore, side) {
  const team = boxscore?.teams?.[side]
  if (!team) return null

  const pitcherIds = team.pitchers || []
  if (!pitcherIds.length) return null

  const starterId = pitcherIds[0]  // first pitcher = starter
  const player = team.players?.[`ID${starterId}`]
  if (!player) return null

  const stats = player.stats?.pitching
  if (!stats) return null

  return {
    id:          String(starterId),
    name:        player.person?.fullName || String(starterId),
    ks:          Number(stats.strikeOuts || 0),
    ip:          ipToDecimal(Number(stats.inningsPitched || 0)),
    bf:          Number(stats.battersFaced || 0),
    pitchCount:  Number(stats.pitchesThrown || 0),
    still_in:    pitcherIds[0] === pitcherIds[pitcherIds.length - 1] || pitcherIds.length === 1,
  }
}

// ── Kalshi live market fetch ──────────────────────────────────────────────────

function buildKsEventTicker(awayTeam, homeTeam, gameTime, date) {
  const away = toKalshiAbbr(awayTeam)
  const home = toKalshiAbbr(homeTeam)
  if (!away || !home) return null
  const t = gameTime ? new Date(gameTime) : new Date(`${date}T19:05:00Z`)
  if (Number.isNaN(t.getTime())) return null
  const et = new Date(t.getTime() - 4 * 3600 * 1000)
  const yy  = String(et.getUTCFullYear()).slice(-2)
  const mmm = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'][et.getUTCMonth()]
  const dd  = String(et.getUTCDate()).padStart(2, '0')
  const hh  = String(et.getUTCHours()).padStart(2, '0')
  const mi  = String(et.getUTCMinutes()).padStart(2, '0')
  return `KXMLBKS-${yy}${mmm}${dd}${hh}${mi}${away}${home}`
}

async function fetchOpenMarkets(eventTicker) {
  try {
    const headers = getAuthHeaders('GET', `/trade-api/v2/markets`)
    const res = await axios.get(`${KALSHI_BASE}/markets`, {
      params: { event_ticker: eventTicker, limit: 50, status: 'open' },
      headers,
      timeout: 12000,
      validateStatus: s => s >= 200 && s < 500,
    })
    if (res.status >= 400) return []
    return res.data?.markets || []
  } catch { return [] }
}

function parseMarkets(markets) {
  const out = []
  const parseCents = v => {
    if (v == null) return null
    const n = typeof v === 'string' ? parseFloat(v) : v
    return Number.isFinite(n) ? Math.round(n * 100) : null
  }
  for (const m of markets) {
    const titleMatch = m.title?.match(/^(.+?):\s*(\d+)\+ strikeouts?/i)
    if (!titleMatch) continue
    const strike = parseInt(titleMatch[2], 10)
    const yes_ask = parseCents(m.yes_ask_dollars)
    const yes_bid = parseCents(m.yes_bid_dollars)
    const no_ask  = parseCents(m.no_ask_dollars)

    // Skip locked markets
    if (yes_ask == null || yes_ask >= 99) continue
    if (yes_bid != null && yes_bid <= 1 && yes_ask <= 2) continue

    out.push({ strike, yes_ask, yes_bid, no_ask, mid: yes_ask != null && yes_bid != null ? (yes_ask + yes_bid) / 2 : null, spread: yes_ask != null && yes_bid != null ? yes_ask - yes_bid : null, ticker: m.ticker, volume: m.volume_fp != null ? Number(m.volume_fp) : null })
  }
  return out.sort((a, b) => a.strike - b.strike)
}

// ── In-game λ computation ─────────────────────────────────────────────────────

function computeLiveProbs(starter, priorK9, priorAvgIp) {
  const { ks, ip, bf } = starter

  if (ip < 0.1) return null  // game hasn't started yet for this pitcher

  // Observed K rate
  const k9_live = (ks / ip) * 9

  // Blend live rate with pre-game prior — weight grows with IP pitched
  const w_live = Math.min(0.75, ip / 3)
  const k9_blended = w_live * k9_live + (1 - w_live) * priorK9

  // TTO3 penalty: if pitcher has faced 18+ batters, they're 3rd time through
  const tto3 = bf >= TTO_BF_THRESH
  const k9_adjusted = tto3 ? k9_blended * TTO_PENALTY : k9_blended

  // Expected remaining IP
  const ip_remaining = Math.max(0, priorAvgIp - ip)

  // λ for remaining Ks
  const lambda_remaining = (k9_adjusted / 9) * ip_remaining

  return {
    ks_so_far:     ks,
    ip_so_far:     ip,
    k9_live,
    k9_blended,
    k9_adjusted,
    lambda_remaining,
    ip_remaining,
    tto3,
    w_live,
  }
}

// ── Pre-game prior lookup ─────────────────────────────────────────────────────

// Load pre-game λ and avg_ip estimates from ks_bets table (logged this morning)
let _priorCache = null
async function loadPriors() {
  if (_priorCache) return _priorCache
  const rows = await db.all(
    `SELECT pitcher_name, pitcher_id, lambda, k9_l5, k9_season, k9_career
       FROM ks_bets WHERE bet_date = ?
       GROUP BY pitcher_name`,
    [TODAY],
  )
  // Load per-pitcher avg IP from recent starts (last 5 starts with IP > 0)
  const ipRows = await db.all(
    `SELECT pitcher_id, AVG(ip) as avg_ip
       FROM (
         SELECT pitcher_id, ip FROM pitcher_recent_starts
         WHERE season = ? AND ip > 0
         ORDER BY pitcher_id, game_date DESC
       )
       GROUP BY pitcher_id`,
    [new Date(TODAY).getFullYear()],
  ).catch(() => [])
  const avgIpByPitcher = new Map(ipRows.map(r => [String(r.pitcher_id), Number(r.avg_ip)]))

  _priorCache = new Map()
  for (const r of rows) {
    const k9_prior = r.k9_season ?? r.k9_l5 ?? 8.8
    const avg_ip = avgIpByPitcher.get(String(r.pitcher_id)) ?? 5.2
    _priorCache.set(r.pitcher_id,                  { k9: k9_prior, avg_ip, name: r.pitcher_name })
    _priorCache.set(r.pitcher_name?.toLowerCase(), { k9: k9_prior, avg_ip })
  }
  return _priorCache
}

// ── Main poll loop ────────────────────────────────────────────────────────────

async function pollOnce(games, priors) {
  const timestamp = new Date().toISOString().slice(11, 19)
  const foundEdges = []

  for (const game of games) {
    // Fetch live game state
    const [linescore, boxscore] = await Promise.all([
      fetchLiveLinescore(game.id),
      fetchLiveBoxScore(game.id),
    ])

    const gameState = linescore?.currentInningOrdinal || linescore?.inningState || ''
    const abstractState = linescore?.teams ? 'Live' : 'Preview'

    // Skip games that haven't started or are over
    if (!boxscore?.teams) continue

    const eventTicker = buildKsEventTicker(game.team_away, game.team_home, game.game_time, game.date)
    if (!eventTicker) continue

    const label = `${game.team_away}@${game.team_home}`

    for (const [side, pitcherIdField] of [['home', 'pitcher_home_id'], ['away', 'pitcher_away_id']]) {
      const starter = getStarterStats(boxscore, side)
      if (!starter || !starter.still_in) continue
      if (starter.ip < 0.1) continue  // hasn't pitched yet

      // Get prior K9
      const prior = priors.get(starter.id) || priors.get(starter.name?.toLowerCase())
      const priorK9   = prior?.k9    ?? 8.8
      const priorAvgIp = prior?.avg_ip ?? 5.2

      const live = computeLiveProbs(starter, priorK9, priorAvgIp)
      if (!live) continue

      // Fetch open Kalshi markets for this event
      const rawMarkets = await fetchOpenMarkets(eventTicker)
      const markets = parseMarkets(rawMarkets)

      if (!markets.length) continue

      // Filter to markets relevant to this pitcher by ticker prefix
      const kalshiTeam = toKalshiAbbr(side === 'home' ? game.team_home : game.team_away)
      const pitcherMarkets = markets.filter(m => m.ticker?.includes(kalshiTeam))
      if (!pitcherMarkets.length) continue

      let headerPrinted = false
      for (const mkt of pitcherMarkets) {
        // Remaining Ks needed to hit threshold
        const needed = mkt.strike - live.ks_so_far
        if (needed <= 0) continue  // already hit — market should be locking

        const modelProb = pAtLeast(live.lambda_remaining, needed)
        const marketMid = mkt.mid != null ? mkt.mid / 100 : null
        if (marketMid == null) continue

        const yesEdge = modelProb - mkt.yes_ask / 100
        const noEdge  = (1 - modelProb) - mkt.no_ask / 100
        const bestEdge = Math.max(yesEdge, noEdge)
        const side_str = yesEdge >= noEdge ? 'YES' : 'NO'

        if (bestEdge < MIN_EDGE) continue

        if (!headerPrinted) {
          console.log(`\n[${timestamp}] ── ${label} ${gameState} ──`)
          console.log(
            `  ${starter.name}: ${starter.ks}Ks / ${starter.ip.toFixed(1)}IP | ` +
            `k9_live=${live.k9_live.toFixed(1)} → k9_adj=${live.k9_adjusted.toFixed(1)}` +
            `${live.tto3 ? ' [TTO3 -15%]' : ''} | ` +
            `λ_remain=${live.lambda_remaining.toFixed(2)} (${live.ip_remaining.toFixed(1)}IP left)`
          )
          headerPrinted = true
        }

        console.log(
          `  ★ ${mkt.strike}+ Ks (need ${needed} more)  ${side_str}  ` +
          `model=${(modelProb*100).toFixed(1)}%  mid=${mkt.mid?.toFixed(0)}¢  ` +
          `edge=${(bestEdge*100).toFixed(1)}¢  spread=${mkt.spread}¢  ` +
          `vol=${mkt.volume != null ? Math.round(mkt.volume) : 'n/a'}  ` +
          `${mkt.ticker}`
        )

        const edgeObj = {
          game: label, pitcher: starter.name, pitcher_id: starter.id,
          strike: mkt.strike, side: side_str,
          model_prob: modelProb, market_mid: marketMid,
          edge: bestEdge, ticker: mkt.ticker,
          ks_so_far: live.ks_so_far, ip_so_far: live.ip_so_far,
          lambda_remaining: live.lambda_remaining,
          k9_live: live.k9_live, tto3: live.tto3,
        }
        foundEdges.push(edgeObj)

        // Log as paper bet (live_bet=1). UNIQUE constraint prevents re-logging
        // same pitcher/strike/side across multiple polls.
        try {
          const mid100  = marketMid * 100
          const hs      = (mkt.spread ?? 4) / 200
          const fill    = side_str === 'YES' ? marketMid + hs : (1 - marketMid) + hs
          const capRisk = Math.round(100 * fill * 100) / 100  // 100 contracts × fill
          await db.run(
            `INSERT OR IGNORE INTO ks_bets
               (bet_date, logged_at, pitcher_name, pitcher_id, game, team, strike, side,
                model_prob, market_mid, edge, lambda, ticker, bet_size, capital_at_risk, spread, paper, live_bet)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,100,?,?,1,1)`,
            [
              TODAY, new Date().toISOString(),
              starter.name, starter.id,
              label,
              side === 'home' ? game.team_home : game.team_away,
              mkt.strike, side_str,
              modelProb, mid100,
              bestEdge, live.lambda_remaining,
              mkt.ticker,
              capRisk, mkt.spread ?? 4,
            ],
          )
        } catch { /* non-fatal — UNIQUE conflict means already logged */ }
      }
    }
  }

  if (!foundEdges.length) {
    process.stdout.write(`\r[${timestamp}] No live edges above ${(MIN_EDGE*100).toFixed(0)}¢ threshold   `)
  }

  return foundEdges
}

async function main() {
  await db.migrate()

  const games = await db.all(
    `SELECT id, date, game_time, team_home, team_away, pitcher_home_id, pitcher_away_id
       FROM games WHERE date = ? ORDER BY game_time`,
    [TODAY],
  )

  if (!games.length) {
    console.log(`[in-game] No games found for ${TODAY}`)
    await db.close()
    return
  }

  const priors = await loadPriors()
  console.log(`[in-game] Watching ${games.length} games on ${TODAY} | poll every ${POLL_SEC}s | min edge ${(MIN_EDGE*100).toFixed(0)}¢`)
  console.log(`[in-game] Pre-game priors loaded for ${priors.size / 2} pitchers`)
  console.log('[in-game] Ctrl+C to stop\n')

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await pollOnce(games, priors)
    } catch (err) {
      process.stdout.write(`\n[in-game] poll error: ${err.message}\n`)
    }
    await new Promise(r => setTimeout(r, POLL_SEC * 1000))
  }
}

main().catch(err => {
  console.error('[in-game] fatal:', err.message)
  process.exit(1)
})
