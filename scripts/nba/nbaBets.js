// scripts/nba/nbaBets.js — Log and settle NBA game total bets.
//
// Mirrors ksBets.js structure but for NBA totals.
//
// Modes:
//   log    — run nbaTotalsEdge.js, size bets via Kelly, upsert into ks_bets
//   settle — fetch actual game totals from NBA Stats API, settle open bets
//
// Usage:
//   node scripts/nba/nbaBets.js log    [--date YYYY-MM-DD] [--min-edge 0.05]
//   node scripts/nba/nbaBets.js settle [--date YYYY-MM-DD]

import 'dotenv/config'
import { execSync } from 'node:child_process'
import axios from 'axios'
import * as db from '../../lib/db.js'
import { kellySizing, capitalAtRisk } from '../../lib/kelly.js'
import { placeOrder } from '../../lib/kalshi.js'
import { notifyEdges, notifyDailyReport } from '../../lib/discord.js'
import { parseArgs } from '../../lib/cli-args.js'

const opts    = parseArgs({
  date:       { default: new Date().toISOString().slice(0, 10) },
  'min-edge': { type: 'number', default: 0.05 },
})
const TODAY   = opts.date
const MIN_EDGE = opts['min-edge']
const [,, mode = 'log'] = process.argv

const NBA_STATS_BASE = 'https://stats.nba.com/stats'
const NBA_HEADERS = {
  'User-Agent':  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  'Referer':     'https://www.nba.com',
  'Origin':      'https://www.nba.com',
  'Accept':      'application/json',
  'x-nba-stats-origin': 'stats',
  'x-nba-stats-token':  'true',
}

await db.migrate()

if (mode === 'log') await logEdges()
else if (mode === 'settle') await settleEdges()
else { console.error(`Unknown mode: ${mode}`); process.exit(1) }

await db.close()

// ── LOG mode ─────────────────────────────────────────────────────────────────

async function logEdges() {
  // Load active bettors (same multi-user pattern as ksBets.js)
  let bettors = await db.all(`
    SELECT id, name, starting_bankroll, daily_risk_pct, paper, kalshi_key_id, kalshi_private_key
    FROM users WHERE active_bettor = 1 ORDER BY id ASC`)
  if (!bettors.length) {
    bettors = [{
      id: null, name: 'default',
      starting_bankroll: Number(process.env.STARTING_BANKROLL ?? 5000),
      daily_risk_pct:    Number(process.env.DAILY_RISK_PCT ?? 0.20),
      paper: process.env.LIVE_TRADING !== 'true' ? 1 : 0,
      kalshi_key_id: process.env.KALSHI_KEY_ID ?? null,
      kalshi_private_key: null,
    }]
  }

  // Run edge finder
  console.log(`[nba-bets] Running NBA totals edge finder for ${TODAY}…`)
  let edgesJson = []
  try {
    const out = execSync(
      `node scripts/nba/nbaTotalsEdge.js --date ${TODAY} --min-edge ${MIN_EDGE} --json`,
      { cwd: process.cwd(), timeout: 60_000, encoding: 'utf8' },
    )
    const match = out.match(/\[EDGES_JSON\]([\s\S]+?)\[\/EDGES_JSON\]/)
    if (!match) { console.log('[nba-bets] No edges output'); return }
    edgesJson = JSON.parse(match[1])
  } catch (err) {
    console.error('[nba-bets] Edge finder error:', err.message)
    return
  }

  if (!edgesJson.length) { console.log('[nba-bets] No NBA edges today'); return }

  console.log(`[nba-bets] ${edgesJson.length} edge(s) found — sizing and logging…`)

  const STAGGER_MS = 45_000
  for (let bi = 0; bi < bettors.length; bi++) {
    if (bi > 0) await new Promise(r => setTimeout(r, STAGGER_MS))
    const bettor = bettors[bi]
    const isPaper = true  // NBA totals paper-only until explicitly enabled

    // Per-user bankroll = starting + settled P&L
    const pnlRow = await db.one(`
      SELECT COALESCE(SUM(pnl), 0) AS pnl
      FROM ks_bets
      WHERE result IN ('win','loss') AND model = 'nba_totals'
        AND (? IS NULL OR user_id = ?)`, [bettor.id, bettor.id])
    const bankroll = (bettor.starting_bankroll ?? 5000) + (pnlRow?.pnl ?? 0)
    const dailyBudget = bankroll * (bettor.daily_risk_pct ?? 0.20)

    let dailyUsed = 0
    const discordEdges = []

    for (const e of edgesJson) {
      if (dailyUsed >= dailyBudget) break

      const mid   = (e.market_mid ?? 50) / 100
      const edge  = Math.max(Number(e.edge) || 0, 0.001)
      const sizing = kellySizing({ prob: e.model_prob, price: mid, bankroll, edge, fraction: 0.25 })
      const betSize = Math.min(sizing.bet_size, (dailyBudget - dailyUsed), bankroll * 0.05)
      if (betSize < 10) continue

      const car = capitalAtRisk(betSize, mid, e.side === 'YES' ? 'yes' : 'no')
      dailyUsed += car

      const row = {
        bet_date:      TODAY,
        logged_at:     new Date().toISOString(),
        pitcher_name:  e.matchup,          // reuse pitcher_name for matchup
        pitcher_id:    null,
        team:          `${e.team_away}/${e.team_home}`,
        game:          `${e.team_away} @ ${e.team_home}`,
        strike:        e.line,             // total line reuses strike column
        side:          e.side,
        model_prob:    e.model_prob,
        market_mid:    e.market_mid,
        edge:          e.edge,
        lambda:        e.mu,               // store μ in lambda column
        ticker:        e.ticker,
        bet_size:      Math.round(betSize),
        kelly_fraction: sizing.kelly_fraction,
        capital_at_risk: car,
        paper:         isPaper ? 1 : 0,
        live_bet:      0,
        open_interest: e.open_interest,
        model:         'nba_totals',
        user_id:       bettor.id,
        spread:        e.yes_ask != null && e.no_ask != null
                         ? (e.yes_ask + e.no_ask - 100)
                         : null,
      }

      try {
        await db.upsert('ks_bets', row,
          ['bet_date', 'pitcher_name', 'strike', 'side', 'live_bet', 'user_id'])
        console.log(`  [${bettor.name}] ${e.matchup} ${e.line}+ ${e.side} @ ${e.side === 'YES' ? e.yes_ask : e.no_ask}¢  edge +${(e.edge*100).toFixed(1)}¢  $${Math.round(betSize)}${isPaper ? ' (paper)' : ''}`)
        discordEdges.push({ ...e, bet_size: Math.round(betSize), pitcher: e.matchup, strike: e.line, market_mid: e.market_mid })
      } catch (err) {
        console.warn(`  [${bettor.name}] upsert failed:`, err.message)
      }

      if (!isPaper && e.ticker) {
        try {
          // If user has explicit key, use it; otherwise fall through to env creds
          const creds = bettor.kalshi_key_id
            ? { keyId: bettor.kalshi_key_id, privateKey: bettor.kalshi_private_key }
            : {}
          const contracts = Math.max(1, Math.round(betSize))
          const price = e.side === 'YES' ? e.yes_ask : e.no_ask
          await placeOrder(e.ticker, e.side.toLowerCase(), contracts, price, creds)
          console.log(`  [${bettor.name}] ORDER PLACED: ${e.ticker} ${e.side} ${contracts}x${price}¢`)
        } catch (err) {
          console.error(`  [${bettor.name}] order failed:`, err.message)
        }
      }
    }

    if (discordEdges.length) await notifyEdges(discordEdges, TODAY).catch(() => {})
  }
}

// ── SETTLE mode ───────────────────────────────────────────────────────────────

async function settleEdges() {
  const openBets = await db.all(`
    SELECT * FROM ks_bets
    WHERE bet_date = ? AND result IS NULL AND model = 'nba_totals' AND live_bet = 0`,
    [TODAY])

  if (!openBets.length) {
    console.log(`[nba-bets] No open NBA bets for ${TODAY}`)
    return
  }

  console.log(`[nba-bets] Settling ${openBets.length} NBA bet(s) for ${TODAY}…`)

  // Fetch today's NBA box scores
  const scores = await fetchNBAScores(TODAY)
  if (!scores.size) {
    console.log('[nba-bets] No final scores available yet')
    return
  }

  const now = new Date().toISOString()
  let settled = 0

  for (const bet of openBets) {
    // bet.pitcher_name is the matchup key e.g. 'DEN@MIN'
    const [away, home] = bet.pitcher_name.split('@')
    const actualTotal = scores.get(`${away}@${home}`) ?? scores.get(`${home}@${away}`)

    if (actualTotal == null) {
      console.log(`  [skip] ${bet.pitcher_name} — no score yet`)
      continue
    }

    const won = bet.side === 'YES' ? actualTotal > bet.strike : actualTotal <= bet.strike
    const result = won ? 'win' : 'loss'
    const pnl = won
      ? bet.bet_size * ((100 - bet.market_mid) / bet.market_mid)
      : -bet.bet_size

    await db.run(`
      UPDATE ks_bets SET actual_ks=?, result=?, settled_at=?, pnl=?
      WHERE id=?`, [actualTotal, result, now, Math.round(pnl * 100) / 100, bet.id])

    // Update nba_games with actual total
    await db.run(`UPDATE nba_games SET actual_total=?, status='final' WHERE team_away=? AND team_home=? AND game_date=?`,
      [actualTotal, away, home, TODAY])

    console.log(`  ${bet.pitcher_name} ${bet.strike}+ ${bet.side}: actual=${actualTotal} → ${result.toUpperCase()} ${pnl >= 0 ? '+' : ''}$${Math.round(pnl * 100) / 100}`)
    settled++
  }

  console.log(`[nba-bets] Settled ${settled}/${openBets.length} bets.`)

  // Discord EOD report for NBA
  const allSettled = await db.all(`
    SELECT * FROM ks_bets WHERE bet_date = ? AND result IN ('win','loss') AND model = 'nba_totals' AND live_bet = 0`,
    [TODAY])
  if (allSettled.length) {
    const dayPnl   = allSettled.reduce((s, b) => s + (b.pnl || 0), 0)
    const wins     = allSettled.filter(b => b.result === 'win').length
    const losses   = allSettled.filter(b => b.result === 'loss').length
    const seasonRow = await db.one(`
      SELECT COALESCE(SUM(pnl),0) AS pnl,
             SUM(CASE WHEN result='win' THEN 1 ELSE 0 END) AS w,
             SUM(CASE WHEN result='loss' THEN 1 ELSE 0 END) AS l,
             COALESCE(SUM(bet_size),0) AS wagered
      FROM ks_bets WHERE result IN ('win','loss') AND model = 'nba_totals' AND live_bet = 0`)
    await notifyDailyReport({
      date: `${TODAY} (NBA Totals)`,
      bets: allSettled.map(b => ({
        pitcher_name: b.pitcher_name, strike: b.strike, actual_ks: b.actual_ks,
        result: b.result, pnl: b.pnl,
      })),
      dayPnl, seasonPnl: seasonRow?.pnl ?? 0,
      seasonW: seasonRow?.w ?? wins, seasonL: seasonRow?.l ?? losses,
      totalWagered: seasonRow?.wagered ?? 0,
    }).catch(() => {})
  }
}

// ── NBA box score fetcher ─────────────────────────────────────────────────────

async function fetchNBAScores(date) {
  // Returns Map<'AWAY@HOME', actualTotal>
  const scores = new Map()
  try {
    const [y, m, d] = date.split('-')
    const dateStr = `${m}/${d}/${y}`
    const res = await axios.get(`${NBA_STATS_BASE}/scoreboardv2`, {
      headers: NBA_HEADERS,
      timeout: 15000,
      params: { GameDate: dateStr, LeagueID: '00', DayOffset: 0 },
    })
    const gameHeader = res.data?.resultSets?.find(r => r.name === 'GameHeader')
    const lineScore  = res.data?.resultSets?.find(r => r.name === 'LineScore')
    if (!gameHeader || !lineScore) return scores

    const ghIdx = idx => h => gameHeader.headers.indexOf(h) === idx
    const ghHeaders = gameHeader.headers
    const lsHeaders = lineScore.headers

    // Build game → teams map from LineScore
    const gameTeams = {}
    for (const row of lineScore.rowSet) {
      const gameId  = row[lsHeaders.indexOf('GAME_ID')]
      const abbr    = row[lsHeaders.indexOf('TEAM_ABBREVIATION')]
      const pts     = row[lsHeaders.indexOf('PTS')]
      if (!gameTeams[gameId]) gameTeams[gameId] = []
      gameTeams[gameId].push({ abbr, pts })
    }

    // Build away/home from GameHeader
    for (const row of gameHeader.rowSet) {
      const gameId   = row[ghHeaders.indexOf('GAME_ID')]
      const status   = row[ghHeaders.indexOf('GAME_STATUS_TEXT')]
      if (!String(status).toLowerCase().includes('final')) continue

      const teams = gameTeams[gameId]
      if (!teams || teams.length < 2) continue

      const awayRow = teams[0]
      const homeRow = teams[1]
      if (awayRow.pts == null || homeRow.pts == null) continue

      const total = awayRow.pts + homeRow.pts
      scores.set(`${awayRow.abbr}@${homeRow.abbr}`, total)
    }
  } catch (err) {
    console.warn('[nba-bets] score fetch error:', err.message)
  }
  return scores
}
