// scripts/nba/nba3PTBets.js — Paper-trade log + settle for NBA 3PT Kalshi markets.
//
// Modes:
//   log    — run nba3PTEdge.js, log top edges as paper bets in ks_bets (model='nba_3pt')
//   settle — fetch box scores, settle open 3PT bets with actual 3PM
//
// Usage:
//   node scripts/nba/nba3PTBets.js log    [--date YYYY-MM-DD] [--min-edge 0.05]
//   node scripts/nba/nba3PTBets.js settle [--date YYYY-MM-DD]

import 'dotenv/config'
import { execSync } from 'node:child_process'
import * as db from '../../lib/db.js'
import { parseArgs } from '../../lib/cli-args.js'

const opts     = parseArgs({ date: { default: new Date().toISOString().slice(0, 10) }, 'min-edge': { type: 'number', default: 0.05 } })
const TODAY    = opts.date
const MIN_EDGE = opts['min-edge']
const [,, mode = 'log'] = process.argv

const NBA_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Referer':    'https://www.nba.com',
  'Origin':     'https://www.nba.com',
  'Accept':     'application/json',
  'x-nba-stats-origin': 'stats',
  'x-nba-stats-token':  'true',
}

await db.migrate()

if (mode === 'log')    await logEdges()
else if (mode === 'settle') await settleEdges()
else { console.error(`Unknown mode: ${mode}`); process.exit(1) }

await db.close()

// ── LOG ──────────────────────────────────────────────────────────────────────

async function logEdges() {
  // Run edge finder and capture output
  let edgesJson = []
  try {
    const out = execSync(
      `node scripts/nba/nba3PTEdge.js --date ${TODAY} --min-edge ${MIN_EDGE}`,
      { cwd: process.cwd(), timeout: 60_000, encoding: 'utf8', env: { ...process.env, JSON_OUTPUT: '1' } },
    )
    const match = out.match(/__EDGES_JSON__\n([\s\S]+?)(\n|$)/)
    if (!match) { console.log('[3pt-bets] No edges output'); return }
    edgesJson = JSON.parse(match[1])
  } catch (err) {
    console.error('[3pt-bets] Edge finder error:', err.message)
    return
  }

  if (!edgesJson.length) { console.log('[3pt-bets] No 3PT edges today'); return }

  const PAPER_BET = 10  // flat $10 paper bet per contract
  const now = new Date().toISOString()
  let logged = 0

  for (const e of edgesJson) {
    const key = `${e.player}|${e.threshold}|${e.side}`
    try {
      await db.upsert('ks_bets', {
        bet_date:     TODAY,
        logged_at:    now,
        pitcher_name: e.player,
        pitcher_id:   null,
        team:         e.team,
        game:         `${e.team} vs ${e.defTeam}`,
        strike:       e.threshold,
        side:         e.side,
        model_prob:   e.modelProb,
        market_mid:   e.yesMid,
        edge:         e.edge,
        lambda:       e.lambda,
        bet_size:     PAPER_BET,
        ticker:       null,
        paper:        1,
        live_bet:     0,
        model:        'nba_3pt',
        user_id:      null,
        spread:       e.spread ?? null,
      }, ['bet_date', 'pitcher_name', 'strike', 'side', 'live_bet', 'user_id'])
      logged++
    } catch (err) {
      console.warn(`[3pt-bets] skip ${e.player} ${e.threshold}+ ${e.side}: ${err.message}`)
    }
  }

  console.log(`[3pt-bets] Logged ${logged} paper 3PT bets for ${TODAY}`)
}

// ── SETTLE ───────────────────────────────────────────────────────────────────

async function settleEdges() {
  const openBets = await db.all(
    `SELECT * FROM ks_bets WHERE bet_date = ? AND result IS NULL AND model = 'nba_3pt' AND live_bet = 0`,
    [TODAY],
  )

  if (!openBets.length) {
    console.log(`[3pt-bets] No open 3PT bets for ${TODAY}`)
    return
  }

  console.log(`[3pt-bets] Settling ${openBets.length} 3PT bet(s) for ${TODAY}…`)

  const playerThrees = await fetchPlayer3PM(TODAY)
  if (!playerThrees.size) {
    console.log('[3pt-bets] No box score data yet')
    return
  }

  const now = new Date().toISOString()
  let settled = 0

  for (const bet of openBets) {
    const nameLower = bet.pitcher_name.toLowerCase()
    const actual3pm = playerThrees.get(nameLower)

    if (actual3pm == null) {
      console.log(`  [skip] ${bet.pitcher_name} — not in box score yet`)
      continue
    }

    const won = bet.side === 'YES' ? actual3pm >= bet.strike : actual3pm < bet.strike
    const result = won ? 'win' : 'loss'
    const mid = bet.market_mid ?? 50
    const pnl = won
      ? bet.bet_size * ((100 - mid) / mid)
      : -bet.bet_size

    await db.run(
      `UPDATE ks_bets SET actual_ks=?, result=?, settled_at=?, pnl=? WHERE id=?`,
      [actual3pm, result, now, Math.round(pnl * 100) / 100, bet.id],
    )

    console.log(`  ${bet.pitcher_name} ${bet.strike}+ ${bet.side}: made ${actual3pm} threes → ${result.toUpperCase()} ${pnl >= 0 ? '+' : ''}$${Math.round(pnl * 100) / 100}`)
    settled++
  }

  if (settled) {
    const all = await db.all(
      `SELECT result, pnl FROM ks_bets WHERE bet_date = ? AND model = 'nba_3pt' AND result IN ('win','loss')`,
      [TODAY],
    )
    const dayPnl = all.reduce((s, b) => s + (b.pnl || 0), 0)
    const wins   = all.filter(b => b.result === 'win').length
    const losses = all.filter(b => b.result === 'loss').length
    console.log(`\n[3pt-bets] Today: ${wins}W-${losses}L  P&L: ${dayPnl >= 0 ? '+' : ''}$${dayPnl.toFixed(2)}`)

    const season = await db.one(
      `SELECT SUM(pnl) as pnl, SUM(CASE WHEN result='win' THEN 1 ELSE 0 END) as w, SUM(CASE WHEN result='loss' THEN 1 ELSE 0 END) as l
       FROM ks_bets WHERE model='nba_3pt' AND result IN ('win','loss')`,
    )
    console.log(`[3pt-bets] Season: ${season.w}W-${season.l}L  P&L: ${(season.pnl||0) >= 0 ? '+' : ''}$${(season.pnl||0).toFixed(2)}`)
  }

  console.log(`[3pt-bets] Settled ${settled}/${openBets.length} bets.`)
}

// ── Box score fetcher ─────────────────────────────────────────────────────────

async function fetchPlayer3PM(date) {
  // Returns Map<player_name_lower, fg3m>
  const players = new Map()
  try {
    const [y, m, d] = date.split('-')
    const dateStr = `${m}/${d}/${y}`

    // Get game IDs for today
    const sbRes = await fetch(
      `https://stats.nba.com/stats/scoreboardv2?GameDate=${dateStr}&LeagueID=00&DayOffset=0`,
      { headers: NBA_HEADERS, signal: AbortSignal.timeout(15000) },
    )
    const sbData = await sbRes.json()
    const gameHeader = sbData?.resultSets?.find(r => r.name === 'GameHeader')
    if (!gameHeader) return players

    const ghHeaders = gameHeader.headers
    const finalGames = gameHeader.rowSet.filter(row => {
      const status = row[ghHeaders.indexOf('GAME_STATUS_TEXT')]
      return String(status).toLowerCase().includes('final')
    })

    // Fetch box score for each final game
    for (const row of finalGames) {
      const gameId = row[ghHeaders.indexOf('GAME_ID')]
      try {
        const bsRes = await fetch(
          `https://stats.nba.com/stats/boxscoretraditionalv2?GameID=${gameId}&StartPeriod=0&EndPeriod=10&StartRange=0&EndRange=0&RangeType=0`,
          { headers: NBA_HEADERS, signal: AbortSignal.timeout(15000) },
        )
        const bsData = await bsRes.json()
        const playerStats = bsData?.resultSets?.find(r => r.name === 'PlayerStats')
        if (!playerStats) continue

        const headers = playerStats.headers
        const nameIdx = headers.indexOf('PLAYER_NAME')
        const fg3mIdx = headers.indexOf('FG3M')

        for (const pRow of playerStats.rowSet) {
          const name  = String(pRow[nameIdx] || '').toLowerCase()
          const fg3m  = pRow[fg3mIdx]
          if (name && fg3m != null) players.set(name, Number(fg3m))
        }
        await new Promise(r => setTimeout(r, 500))
      } catch (err) {
        console.warn(`[3pt-bets] box score fetch failed for game ${gameId}:`, err.message)
      }
    }
  } catch (err) {
    console.warn('[3pt-bets] scoreboard fetch failed:', err.message)
  }
  return players
}
