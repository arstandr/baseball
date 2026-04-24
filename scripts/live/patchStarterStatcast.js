// scripts/live/patchStarterStatcast.js — Patch statcast gaps for today's starters.
//
// The bulk Savant fetch (fetchPitcherStatcast.js) requires MIN_IP=5, which excludes:
//   - Injury returnees (< 5 IP so far in 2026)
//   - Early-season callups
//   - Pitchers with split-year situations
//
// This script runs AFTER the bulk fetch and targets only today's scheduled starters.
// For any starter missing a 2026 statcast row (or last fetched > 7 days ago), it hits
// the MLB Stats API directly for their individual season line.
//
// MLB Stats API fields used:
//   strikeOuts, battersFaced, baseOnBalls, inningsPitched
//
// Note: fb_velo / swstr_pct / gb_pct will be null for these patched rows.
// k_pct is the critical field for the model — that alone unblocks λ blending.
//
// Usage:
//   node scripts/live/patchStarterStatcast.js [--date YYYY-MM-DD] [--dry-run]

import 'dotenv/config'
import axios from 'axios'
import * as db from '../../lib/db.js'

const args = process.argv.slice(2)
const DATE    = args.includes('--date')    ? args[args.indexOf('--date') + 1]    : new Date().toISOString().slice(0, 10)
const DRY_RUN = args.includes('--dry-run')
const SEASON  = parseInt(DATE.slice(0, 4), 10)
const STALE_DAYS = 7

async function fetchMlbSeasonStats(playerId, season) {
  const url = `https://statsapi.mlb.com/api/v1/people/${playerId}/stats`
  try {
    const res = await axios.get(url, {
      params: { stats: 'season', group: 'pitching', season },
      timeout: 8000,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    })
    const splits = res.data?.stats?.[0]?.splits
    if (!Array.isArray(splits) || splits.length === 0) return null
    const s = splits[0].stat
    if (!s) return null

    const bf  = Number(s.battersFaced  || 0)
    const ks  = Number(s.strikeOuts    || 0)
    const bb  = Number(s.baseOnBalls   || 0)
    const ipStr = String(s.inningsPitched || '0')

    // Parse MLB API IP format "16.1" → decimal innings
    const ipN = parseFloat(ipStr)
    const whole = Math.floor(ipN)
    const frac = Math.round((ipN % 1) * 10)
    const ip = whole + frac / 3

    if (bf === 0) return null

    return {
      k_pct:  ks / bf,
      bb_pct: bb / bf,
      pa:     bf,
      ip,
      // Savant-specific fields not available from MLB Stats API
      swstr_pct: null,
      fb_velo:   null,
      gb_pct:    null,
    }
  } catch (err) {
    console.warn(`  [patch] MLB API error for ${playerId}: ${err.message}`)
    return null
  }
}

async function fetchPlayerName(playerId) {
  try {
    const res = await axios.get(`https://statsapi.mlb.com/api/v1/people/${playerId}`, {
      timeout: 5000,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    })
    const p = res.data?.people?.[0]
    return p ? `${p.firstName} ${p.lastName}` : String(playerId)
  } catch {
    return String(playerId)
  }
}

async function main() {
  await db.migrate()

  // Get today's starters
  const games = await db.all(
    `SELECT pitcher_home_id, pitcher_away_id FROM games WHERE date = ?`,
    [DATE],
  )

  if (!games.length) {
    console.log(`[patch-statcast] No games found for ${DATE}`)
    await db.close()
    return
  }

  const pitcherIds = [...new Set(
    games.flatMap(g => [g.pitcher_home_id, g.pitcher_away_id]).filter(Boolean)
  )]

  console.log(`[patch-statcast] ${pitcherIds.length} starters on ${DATE}: ${pitcherIds.join(', ')}`)

  const cutoff = new Date(Date.now() - STALE_DAYS * 86400_000).toISOString().slice(0, 10)
  const today  = new Date().toISOString().slice(0, 10)

  let patched = 0
  let skipped = 0

  for (const pid of pitcherIds) {
    // Check for a fresh 2026 row
    const existing = await db.one(
      `SELECT player_id, player_name, fetch_date, k_pct
         FROM pitcher_statcast
        WHERE player_id = ? AND season = ?
        ORDER BY fetch_date DESC LIMIT 1`,
      [String(pid), SEASON],
    )

    if (existing && existing.fetch_date >= cutoff && existing.k_pct != null) {
      console.log(`  [patch-statcast] ${existing.player_name || pid}: fresh (${existing.fetch_date}, k%=${(existing.k_pct*100).toFixed(1)}%) — skip`)
      skipped++
      continue
    }

    const reason = !existing ? 'no 2026 row' : existing.k_pct == null ? 'k_pct null' : `stale (${existing.fetch_date})`
    console.log(`  [patch-statcast] ${existing?.player_name || pid}: ${reason} — fetching MLB API...`)

    const [stats, name] = await Promise.all([
      fetchMlbSeasonStats(pid, SEASON),
      existing?.player_name ? Promise.resolve(existing.player_name) : fetchPlayerName(pid),
    ])

    if (!stats) {
      console.warn(`  [patch-statcast] ${name} (${pid}): no ${SEASON} stats available`)
      skipped++
      continue
    }

    const row = {
      player_id:   String(pid),
      player_name: name,
      season:      SEASON,
      fetch_date:  today,
      ...stats,
    }

    console.log(
      `  [patch-statcast] ${name}: k%=${(row.k_pct*100).toFixed(1)}%` +
      ` bb%=${(row.bb_pct*100).toFixed(1)}%` +
      ` ip=${row.ip.toFixed(1)}` +
      ` pa=${row.pa}`
    )

    if (!DRY_RUN) {
      await db.upsert('pitcher_statcast', row, ['player_id', 'season', 'fetch_date'])
    }
    patched++
  }

  console.log(`\n[patch-statcast] Done — patched=${patched} skipped=${skipped}`)
  await db.close()
}

main().catch(err => {
  console.error('[patch-statcast] fatal:', err.message)
  process.exit(1)
})
