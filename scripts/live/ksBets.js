// scripts/live/ksBets.js — Paper bet tracker for KXMLBKS strikeout markets.
//
// Two modes:
//   log   — record edge calls from strikeoutEdge.js output into ks_bets table
//   settle — fetch actual K totals from MLB API and mark bets won/lost
//   report — print P&L summary
//
// The table stores each edge call with the market price at time of call.
// After games finish, settle fills in actual_ks and result (win/loss).
//
// Usage:
//   node scripts/live/ksBets.js log    [--date YYYY-MM-DD] [--min-edge 0.05]
//   node scripts/live/ksBets.js settle [--date YYYY-MM-DD]
//   node scripts/live/ksBets.js report [--days 30]

import 'dotenv/config'
import axios from 'axios'
import * as db from '../../lib/db.js'
import { toKalshiAbbr, getAuthHeaders } from '../../lib/kalshi.js'
import { notifyEdges, notifyDailyReport } from '../../lib/discord.js'

const args = process.argv.slice(2)
const MODE     = args[0] || 'report'
const dateArg  = args.includes('--date')     ? args[args.indexOf('--date')     + 1] : null
const daysArg  = args.includes('--days')     ? Number(args[args.indexOf('--days')     + 1]) : 30
const minEdge  = args.includes('--min-edge') ? Number(args[args.indexOf('--min-edge') + 1]) : 0.05
const BET_SIZE = args.includes('--bet-size') ? Number(args[args.indexOf('--bet-size') + 1]) : 100

const TODAY    = dateArg || new Date().toISOString().slice(0, 10)
const MLB_BASE = 'https://statsapi.mlb.com/api/v1'
const KALSHI_BASE = 'https://api.elections.kalshi.com/trade-api/v2'

// ── Table setup ───────────────────────────────────────────────────────────────

async function ensureTable() {
  await db.run(`
    CREATE TABLE IF NOT EXISTS ks_bets (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      bet_date      TEXT NOT NULL,
      logged_at     TEXT NOT NULL,
      pitcher_id    TEXT,
      pitcher_name  TEXT NOT NULL,
      team          TEXT,
      game          TEXT,
      strike        INTEGER NOT NULL,
      side          TEXT NOT NULL,
      model_prob    REAL NOT NULL,
      market_mid    REAL,
      edge          REAL NOT NULL,
      lambda        REAL,
      k9_career     REAL,
      k9_season     REAL,
      k9_l5         REAL,
      opp_k_pct     REAL,
      adj_factor    REAL,
      n_starts      INTEGER,
      confidence    TEXT,
      savant_k_pct  REAL,
      savant_whiff  REAL,
      savant_fbv    REAL,
      whiff_flag    TEXT,
      ticker        TEXT,
      bet_size      REAL DEFAULT 100,
      kelly_fraction REAL,
      capital_at_risk REAL,
      paper         INTEGER DEFAULT 1,
      live_bet      INTEGER DEFAULT 0,
      actual_ks     INTEGER,
      result        TEXT,
      settled_at    TEXT,
      pnl           REAL,
      -- Analysis columns (added for weekly review)
      park_factor   REAL,                    -- park K-rate multiplier applied
      weather_mult  REAL,                    -- weather multiplier applied
      ump_factor    REAL,                    -- umpire K-rate multiplier
      ump_name      TEXT,                    -- HP umpire name
      velo_adj      REAL,                    -- velocity trend adjustment
      velo_trend_mph REAL,                   -- fb_velo vs career avg (mph)
      bb_penalty    REAL,                    -- BB% penalty applied (1.0 = none)
      raw_adj_factor REAL,                   -- raw opp adj before selectivity filter
      spread        REAL,                    -- market spread in cents
      UNIQUE(bet_date, pitcher_name, strike, side, live_bet)
    )
  `)
  await db.run(`CREATE INDEX IF NOT EXISTS idx_ks_bets_date ON ks_bets(bet_date)`)
  await db.run(`CREATE INDEX IF NOT EXISTS idx_ks_bets_pitcher ON ks_bets(pitcher_id)`)
  await db.run(`CREATE INDEX IF NOT EXISTS idx_ks_bets_result ON ks_bets(result)`)

  // Backfill new columns for existing rows (safe no-ops if columns already exist)
  for (const col of [
    'park_factor REAL', 'weather_mult REAL', 'ump_factor REAL', 'ump_name TEXT',
    'velo_adj REAL', 'velo_trend_mph REAL', 'bb_penalty REAL', 'raw_adj_factor REAL', 'spread REAL',
  ]) {
    try { await db.run(`ALTER TABLE ks_bets ADD COLUMN ${col}`) } catch {}
  }
}

// ── LOG mode: run edge finder and record edges ────────────────────────────────

async function logEdges() {
  // Import edge finder logic inline by spawning it as a subprocess
  // to avoid circular dependency — capture JSON output
  const { default: { execSync } } = await import('child_process')
  console.log(`[ks-bets] Running edge finder for ${TODAY}…`)

  let edgesJson
  try {
    const out = execSync(
      `node scripts/live/strikeoutEdge.js --date ${TODAY} --min-edge ${minEdge} --json`,
      { cwd: process.cwd(), timeout: 120000, encoding: 'utf8' }
    )
    // Look for the JSON block at the end of output
    const jsonMatch = out.match(/\[EDGES_JSON\]([\s\S]+)\[\/EDGES_JSON\]/)
    if (!jsonMatch) {
      console.log('[ks-bets] No JSON block in edge output — add --json support to strikeoutEdge.js')
      console.log('[ks-bets] Raw output preview:\n', out.slice(-500))
      await db.close()
      return
    }
    edgesJson = JSON.parse(jsonMatch[1])
  } catch (err) {
    console.error('[ks-bets] Edge finder failed:', err.message)
    await db.close()
    return
  }

  if (!edgesJson.length) {
    console.log('[ks-bets] No edges to log')
    await db.close()
    return
  }

  const now = new Date().toISOString()
  let logged = 0
  for (const e of edgesJson) {
    await db.upsert('ks_bets', {
      bet_date:     TODAY,
      logged_at:    now,
      pitcher_id:   e.pitcher_id || null,
      pitcher_name: e.pitcher,
      team:         e.team,
      game:         e.game,
      strike:       e.strike,
      side:         e.side,
      model_prob:   e.model_prob,
      market_mid:   e.market_mid,
      edge:         e.edge,
      lambda:       e.lambda,
      k9_career:    e.k9_career ?? null,
      k9_season:    e.k9_season ?? null,
      k9_l5:        e.k9_l5 ?? null,
      opp_k_pct:    e.opp_k_pct,
      adj_factor:   e.adj_factor,
      n_starts:     e.n_starts,
      confidence:   e.confidence,
      savant_k_pct: e.savant_k_pct ?? null,
      savant_whiff: e.savant_whiff ?? null,
      savant_fbv:    e.savant_fbv    ?? null,
      whiff_flag:    e.whiff_flag    ?? null,
      ticker:        e.ticker,
      bet_size:      BET_SIZE,
      park_factor:   e.park_factor   ?? null,
      weather_mult:  e.weather_note  ? (e.weather_mult ?? null) : null,
      ump_factor:    e.ump_factor    ?? null,
      ump_name:      e.ump_name      ?? null,
      velo_adj:      e.velo_adj      ?? null,
      velo_trend_mph: e.velo_trend_mph ?? null,
      bb_penalty:    e.bb_penalty    ?? null,
      raw_adj_factor: e.raw_adj_factor ?? null,
      spread:        e.spread        ?? null,
    }, ['bet_date', 'pitcher_name', 'strike', 'side'])
    logged++
  }

  console.log(`[ks-bets] Logged ${logged} edge bets for ${TODAY}`)

  // Cache today's Kalshi open prices for real-price backtest
  try {
    const { default: { execSync } } = await import('child_process')
    execSync(`node scripts/live/backtestKalshi.js --cache --date ${TODAY}`, {
      cwd: process.cwd(), timeout: 30000, encoding: 'utf8',
    })
  } catch (err) {
    console.warn('[ks-bets] Price cache step failed (non-fatal):', err.message?.slice(0, 100))
  }

  // Log model config for this run
  await db.run(
    `INSERT INTO model_config_log
       (run_date, edge_threshold, adj_threshold, shrink7, shrink8, shrink9,
        kelly_mult, max_bet_pct, min_bet, bb_penalty_on, no_cap_cents, bets_logged)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      TODAY,
      minEdge,
      0.28,   // ADJ_THRESHOLD — update manually when changed
      0.97, 0.95, 0.93,
      Number(process.env.KELLY_MULT  || 0.25),
      Number(process.env.MAX_BET_PCT || 0.05),
      Number(process.env.MIN_BET     || 25),
      1,      // bb_penalty active in live model via Savant data
      80,     // NO cap at 80¢
      logged,
    ],
  )

  // Discord: post morning picks
  if (logged > 0) {
    const discordEdges = edgesJson.map(e => ({ ...e, bet_size: BET_SIZE }))
    await notifyEdges(discordEdges, TODAY)
  }
}

// ── SETTLE mode: look up actual Ks and mark results ──────────────────────────

async function isGameFinal(gamePk) {
  try {
    const res = await axios.get(`${MLB_BASE}/schedule`, {
      params: { gamePk, sportId: 1 },
      timeout: 8000, validateStatus: s => s >= 200 && s < 500,
    })
    const state = res.data?.dates?.[0]?.games?.[0]?.status?.abstractGameState || ''
    return state === 'Final'
  } catch { return false }
}

async function fetchActualKs(pitcherName, gameDate) {
  // Search games table for the pitcher on this date, then fetch box score
  try {
    const games = await db.all(
      `SELECT id, pitcher_home_id, pitcher_away_id, team_home, team_away
         FROM games WHERE date = ?`,
      [gameDate],
    )

    for (const g of games) {
      // Only settle from Final games
      const final = await isGameFinal(g.id)
      if (!final) continue

      for (const [pid, side] of [[g.pitcher_home_id, 'home'], [g.pitcher_away_id, 'away']]) {
        if (!pid) continue
        // Fetch pitcher name to match
        try {
          const res = await axios.get(`${MLB_BASE}/people/${pid}`, {
            timeout: 8000, validateStatus: s => s >= 200 && s < 500,
          })
          const name = res.data?.people?.[0]?.fullName || ''
          if (!name.toLowerCase().includes(pitcherName.split(' ').pop()?.toLowerCase() || '')) continue

          // Fetch game box score for Ks
          const box = await axios.get(`${MLB_BASE}/game/${g.id}/boxscore`, {
            timeout: 10000, validateStatus: s => s >= 200 && s < 500,
          })
          const pitchers = box.data?.teams?.[side]?.pitchers || []
          const playerStats = box.data?.teams?.[side]?.players || {}

          // Find this pitcher's K total
          for (const pitcherId of pitchers) {
            const player = playerStats[`ID${pitcherId}`]
            if (!player) continue
            const pName = player.person?.fullName || ''
            if (!pName.toLowerCase().includes(pitcherName.split(' ').pop()?.toLowerCase() || '')) continue
            const ks = player.stats?.pitching?.strikeOuts
            if (ks != null) return { ks: Number(ks), pitcher_id: String(pitcherId) }
          }
        } catch { continue }
      }
    }
  } catch {}
  return null
}

async function settleBets() {
  const open = await db.all(
    `SELECT * FROM ks_bets WHERE bet_date = ? AND result IS NULL`,
    [TODAY],
  )

  if (!open.length) {
    console.log(`[ks-bets] No open bets for ${TODAY}`)
    await db.close()
    return
  }

  console.log(`[ks-bets] Settling ${open.length} open bets for ${TODAY}`)

  // Group by pitcher to avoid redundant box score fetches
  const pitcherKs = new Map()
  for (const bet of open) {
    if (!pitcherKs.has(bet.pitcher_name)) {
      const result = await fetchActualKs(bet.pitcher_name, bet.bet_date)
      pitcherKs.set(bet.pitcher_name, result)
      if (result) {
        console.log(`  ${bet.pitcher_name}: ${result.ks} Ks`)
      } else {
        console.log(`  ${bet.pitcher_name}: could not find K total`)
      }
    }
  }

  const now = new Date().toISOString()
  let wins = 0, losses = 0, unknown = 0

  for (const bet of open) {
    const data = pitcherKs.get(bet.pitcher_name)
    if (!data) { unknown++; continue }

    const actualKs = data.ks
    const hit = actualKs >= bet.strike   // did pitcher reach the threshold?
    const won = bet.side === 'YES' ? hit : !hit

    // P&L: if YES at mid price p, win = bet_size * (1 - p/100), lose = -bet_size * p/100
    // Approximation using market_mid as fill price
    const p = bet.market_mid != null ? bet.market_mid / 100 : bet.model_prob
    const pnl = won
      ? bet.bet_size * (1 - p)
      : -bet.bet_size * p

    await db.run(
      `UPDATE ks_bets SET actual_ks=?, result=?, settled_at=?, pnl=? WHERE id=?`,
      [actualKs, won ? 'win' : 'loss', now, Math.round(pnl * 100) / 100, bet.id],
    )
    if (won) wins++; else losses++
  }

  console.log(`[ks-bets] Settled: ${wins} wins, ${losses} losses, ${unknown} unknown`)

  // Backfill outcomes into Kalshi price cache
  try {
    const { default: { execSync } } = await import('child_process')
    execSync(`node scripts/live/backtestKalshi.js --settle --date ${TODAY}`, {
      cwd: process.cwd(), timeout: 20000, encoding: 'utf8',
    })
  } catch (err) {
    console.warn('[ks-bets] Cache settle step failed (non-fatal):', err.message?.slice(0, 100))
  }

  // Discord end-of-day report
  const allSettled = await db.all(`SELECT * FROM ks_bets WHERE bet_date = ? AND result IS NOT NULL`, [TODAY])
  const season = await db.all(
    `SELECT SUM(pnl) as pnl, COUNT(*) as n, SUM(CASE WHEN result='win' THEN 1 ELSE 0 END) as w, SUM(bet_size) as wagered FROM ks_bets WHERE result IS NOT NULL`,
  )
  const sp = season[0] || {}
  const dayPnl = allSettled.reduce((s, b) => s + (b.pnl || 0), 0)
  await notifyDailyReport({
    date:         TODAY,
    bets:         allSettled,
    dayPnl,
    seasonPnl:    sp.pnl     || 0,
    seasonW:      sp.w       || 0,
    seasonL:      (sp.n || 0) - (sp.w || 0),
    totalWagered: sp.wagered || 0,
  })
}

// ── REPORT mode ───────────────────────────────────────────────────────────────

async function report() {
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - daysArg)
  const since = cutoff.toISOString().slice(0, 10)

  const bets = await db.all(
    `SELECT * FROM ks_bets WHERE bet_date >= ? ORDER BY bet_date DESC, edge DESC`,
    [since],
  )

  if (!bets.length) {
    console.log(`[ks-bets] No bets found since ${since}`)
    await db.close()
    return
  }

  const settled   = bets.filter(b => b.result != null)
  const wins      = settled.filter(b => b.result === 'win')
  const totalPnl  = settled.reduce((s, b) => s + (b.pnl || 0), 0)
  const avgEdge   = bets.reduce((s, b) => s + b.edge, 0) / bets.length
  const winRate   = settled.length > 0 ? wins.length / settled.length : null

  console.log(`\n══ KS BETS REPORT (last ${daysArg} days) ══`)
  console.log(`  Total bets:  ${bets.length} (${settled.length} settled, ${bets.length - settled.length} open)`)
  console.log(`  Win rate:    ${winRate != null ? (winRate*100).toFixed(1)+'%' : 'n/a'} (${wins.length}W / ${settled.length - wins.length}L)`)
  console.log(`  Total P&L:   $${totalPnl.toFixed(2)}`)
  console.log(`  Avg edge:    ${(avgEdge*100).toFixed(1)}¢`)
  console.log(`  Avg bet:     $${(bets[0]?.bet_size || 100).toFixed(0)}`)
  console.log(`  EV/bet:      $${settled.length > 0 ? (totalPnl / settled.length).toFixed(2) : 'n/a'}`)

  // By confidence tier
  const tiers = {}
  for (const b of settled) {
    const tier = b.confidence?.includes('high') ? 'high' : b.confidence?.includes('medium') ? 'medium' : 'low'
    if (!tiers[tier]) tiers[tier] = { n: 0, wins: 0, pnl: 0 }
    tiers[tier].n++
    if (b.result === 'win') tiers[tier].wins++
    tiers[tier].pnl += b.pnl || 0
  }
  console.log('\n  By confidence:')
  for (const [tier, t] of Object.entries(tiers)) {
    console.log(`    ${tier.padEnd(8)}: ${t.wins}W/${t.n - t.wins}L  P&L=$${t.pnl.toFixed(2)}  WR=${(t.wins/t.n*100).toFixed(0)}%`)
  }

  // By whiff flag
  const flagged   = settled.filter(b => b.whiff_flag)
  const unflagged = settled.filter(b => !b.whiff_flag)
  if (flagged.length) {
    const fPnl = flagged.reduce((s,b)=>s+(b.pnl||0),0)
    const uPnl = unflagged.reduce((s,b)=>s+(b.pnl||0),0)
    console.log('\n  Whiff flag analysis:')
    console.log(`    Flagged ⚑:   ${flagged.filter(b=>b.result==='win').length}W/${flagged.length} P&L=$${fPnl.toFixed(2)}`)
    console.log(`    Clean:        ${unflagged.filter(b=>b.result==='win').length}W/${unflagged.length} P&L=$${uPnl.toFixed(2)}`)
  }

  // Recent bets list
  console.log('\n  Recent settled bets:')
  for (const b of settled.slice(0, 20)) {
    const resultStr = b.result === 'win' ? '✓' : '✗'
    console.log(
      `  ${resultStr} ${b.bet_date} ${b.pitcher_name.padEnd(22)} ${b.strike}+Ks ${b.side.padEnd(3)}` +
      `  model=${(b.model_prob*100).toFixed(0)}%` +
      `  mid=${b.market_mid != null ? b.market_mid.toFixed(0)+'¢' : '?'}` +
      `  edge=${(b.edge*100).toFixed(1)}¢` +
      `  actual=${b.actual_ks ?? '?'}Ks` +
      `  P&L=$${b.pnl?.toFixed(2) ?? '?'}` +
      `${b.whiff_flag ? ' ⚑' : ''}`
    )
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  await db.migrate()
  await ensureTable()

  if (MODE === 'log')    await logEdges()
  else if (MODE === 'settle') await settleBets()
  else if (MODE === 'report') await report()
  else {
    console.error(`Unknown mode: ${MODE}. Use log | settle | report`)
    process.exit(1)
  }

  await db.close()
}

main().catch(err => {
  console.error('[ks-bets] fatal:', err.message)
  process.exit(1)
})
