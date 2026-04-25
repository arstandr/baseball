// scripts/live/fetchLineups.js — Fetch official lineups + per-batter K% splits.
//
// For each game today, reads the official batting order from the MLB boxscore and
// looks up each batter's K% vs RHP and vs LHP for the current season. Stores
// lineup-weighted K% in game_lineups so strikeoutEdge.js replaces the blunt
// team-level opponent adjustment with the actual nine batters' K profiles.
//
// Run after lineups post (typically 3-4 PM ET for evening games, ~1 hr pre-game
// for afternoon games). Safe to re-run — upserts on (game_id, team_abbr, vs_hand, fetch_date).
//
// Fall-back: games with no posted lineup are skipped. strikeoutEdge.js falls
// back to historical_team_offense K% for those games.
//
// Usage:
//   node scripts/live/fetchLineups.js [--date YYYY-MM-DD]

import 'dotenv/config'
import axios from 'axios'
import * as db from '../../lib/db.js'

const args    = process.argv.slice(2)
const dateArg = args.includes('--date') ? args[args.indexOf('--date') + 1] : null
const TODAY   = dateArg || new Date().toISOString().slice(0, 10)

const MLB_BASE    = 'https://statsapi.mlb.com/api/v1'
const LEAGUE_K_PCT = 0.22
const MIN_PA       = 20   // minimum PA for batter split to be trusted; else use league avg

// ── Batter K% split lookup ────────────────────────────────────────────────────

// Simple in-memory cache so we don't hit the API twice per batter (home+away)
const _batterCache = new Map()

async function fetchBatterSplits(batterId, season) {
  const key = `${batterId}-${season}`
  if (_batterCache.has(key)) return _batterCache.get(key)

  try {
    const res = await axios.get(`${MLB_BASE}/people/${batterId}/stats`, {
      params: {
        stats: 'statSplits', group: 'hitting', season, sportId: 1, sitCodes: 'vr,vl',
      },
      timeout: 8000,
      validateStatus: s => s >= 200 && s < 500,
    })
    if (res.status >= 400) { _batterCache.set(key, null); return null }

    const result = {}
    for (const s of (res.data?.stats?.[0]?.splits || [])) {
      const code = s.split?.code   // 'vr' or 'vl'
      if (!code) continue
      const pa = Number(s.stat?.plateAppearances || 0)
      const k  = Number(s.stat?.strikeOuts || 0)
      if (pa >= MIN_PA) result[code] = { k_pct: k / pa, pa }
    }

    const out = Object.keys(result).length ? result : null
    _batterCache.set(key, out)
    return out
  } catch { _batterCache.set(key, null); return null }
}

// ── Batting order position weights ───────────────────────────────────────────
//
// Batters at the top of the order get more plate appearances than those at the
// bottom, especially when the starter is pulled early. Position 1 gets the most
// PAs; positions 7-9 may not even bat a 3rd time in a 5-inning start.
//
// Weights for positions 1-9 (index 0 = position 1):
//   Inspired by expected PA distribution for a 5-6 IP start.
//   Re-normalized so they sum to 1 inside aggregateLineupKPct.
const BATTING_ORDER_WEIGHTS = [1.00, 0.97, 0.95, 0.93, 0.92, 0.91, 0.88, 0.86, 0.84]

// ── Lineup K% aggregation ────────────────────────────────────────────────────

function aggregateLineupKPct(splits, vsHand) {
  const code = vsHand === 'R' ? 'vr' : 'vl'
  let weightedSum = 0, totalWeight = 0, dataCount = 0

  for (let i = 0; i < splits.length; i++) {
    const s    = splits[i]
    const kpct = s?.[code]?.k_pct ?? null
    // Position weight: use defined weight if available, else last defined weight
    const w    = BATTING_ORDER_WEIGHTS[i] ?? BATTING_ORDER_WEIGHTS[BATTING_ORDER_WEIGHTS.length - 1]
    weightedSum += w * (kpct !== null ? kpct : LEAGUE_K_PCT)
    totalWeight += w
    if (kpct !== null) dataCount++
  }

  return {
    lineup_k_pct: totalWeight > 0 ? weightedSum / totalWeight : LEAGUE_K_PCT,
    batter_count: dataCount,
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  await db.migrate()

  const season = new Date(TODAY).getFullYear()
  const games  = await db.all(
    `SELECT id, team_home, team_away FROM games WHERE date = ?`,
    [TODAY],
  )

  if (!games.length) {
    console.log(`[lineups] No games for ${TODAY}`)
    await db.close()
    return
  }

  // Pre-load which teams already have lineup data for today (skip re-fetching splits)
  const alreadyFetched = new Set()
  const existingRows = await db.all(
    `SELECT game_id, team_abbr FROM game_lineups WHERE fetch_date = ? GROUP BY game_id, team_abbr`,
    [TODAY],
  ).catch(() => [])
  for (const r of existingRows) alreadyFetched.add(`${r.game_id}:${r.team_abbr}`)

  const pendingGames = games.filter(g =>
    !alreadyFetched.has(`${g.id}:${g.team_home}`) || !alreadyFetched.has(`${g.id}:${g.team_away}`)
  )

  if (!pendingGames.length) {
    console.log(`[lineups] All ${games.length} games already have lineups for ${TODAY} — skipping`)
    await db.close()
    return
  }

  console.log(`[lineups] Checking ${pendingGames.length}/${games.length} games still needing lineups on ${TODAY}…`)
  let lineupsSaved = 0, gamesWithLineup = 0

  for (const game of pendingGames) {
    const boxRes = await axios.get(`${MLB_BASE}/game/${game.id}/boxscore`, {
      timeout: 10000, validateStatus: s => s >= 200 && s < 500,
    }).catch(() => null)
    if (!boxRes || boxRes.status >= 400) continue

    let gameSaved = false
    for (const [side, teamAbbr] of [['home', game.team_home], ['away', game.team_away]]) {
      if (alreadyFetched.has(`${game.id}:${teamAbbr}`)) continue  // already have this team's lineup

      const team  = boxRes.data?.teams?.[side]
      const order = team?.battingOrder || []
      if (!order.length) {
        console.log(`  ${teamAbbr}: lineup not posted yet`)
        continue
      }

      // Fetch batter splits in parallel (9 calls per team)
      const splits = await Promise.all(order.map(id => fetchBatterSplits(id, season)))

      for (const hand of ['R', 'L']) {
        const { lineup_k_pct, batter_count } = aggregateLineupKPct(splits, hand)
        const lineupJson = JSON.stringify(
          order.map((id, i) => ({
            id,
            vs_r: splits[i]?.vr?.k_pct != null ? +(splits[i].vr.k_pct * 100).toFixed(1) : null,
            vs_l: splits[i]?.vl?.k_pct != null ? +(splits[i].vl.k_pct * 100).toFixed(1) : null,
          })),
        )

        await db.upsert('game_lineups', {
          game_id:      String(game.id),
          team_abbr:    teamAbbr,
          vs_hand:      hand,
          fetch_date:   TODAY,
          lineup_k_pct,
          batter_count,
          source:       'official',
          lineup_json:  lineupJson,
        }, ['game_id', 'team_abbr', 'vs_hand', 'fetch_date'])

        lineupsSaved++
      }

      const { lineup_k_pct: kR, batter_count: bcR } = aggregateLineupKPct(splits, 'R')
      const { lineup_k_pct: kL }                     = aggregateLineupKPct(splits, 'L')
      console.log(
        `  ${teamAbbr} (${order.length} batters): ` +
        `vsR=${(kR * 100).toFixed(1)}% ` +
        `vsL=${(kL * 100).toFixed(1)}% ` +
        `(${bcR}/${order.length} with real data)`
      )
      gameSaved = true
    }
    if (gameSaved) gamesWithLineup++
  }

  console.log(`[lineups] Done — ${gamesWithLineup}/${games.length} games have lineups, ${lineupsSaved} rows saved`)
  await db.close()
}

main().catch(err => {
  console.error('[lineups] fatal:', err.message)
  process.exit(1)
})
