// scripts/live/fetchPitcherRecentStarts.js — Fetch last N starts per pitcher.
//
// Stores per-start pitch count, BF, Ks, and IP into pitcher_recent_starts so
// strikeoutEdge.js can estimate E[BF] from actual workload history instead of
// a fixed avg_ip × league_constant.
//
// Run once each morning before strikeoutEdge.js. Takes ~10s for 15-20 pitchers.
//
// Usage:
//   node scripts/live/fetchPitcherRecentStarts.js [--date YYYY-MM-DD] [--n 5]

import 'dotenv/config'
import axios from 'axios'
import * as db from '../../lib/db.js'

const args    = process.argv.slice(2)
const dateArg = args.includes('--date') ? args[args.indexOf('--date') + 1] : null
const TODAY   = dateArg || new Date().toISOString().slice(0, 10)
const N       = args.includes('--n') ? Number(args[args.indexOf('--n') + 1]) : 5

const MLB_BASE = 'https://statsapi.mlb.com/api/v1'

function ipToDecimal(ip) {
  const n = Number(ip)
  const whole = Math.floor(n)
  const frac = Math.round((n % 1) * 10)
  return whole + frac / 3
}

async function fetchStartsForPitcher(pitcherId, season) {
  try {
    const res = await axios.get(`${MLB_BASE}/people/${pitcherId}/stats`, {
      params: { stats: 'gameLog', group: 'pitching', season, sportId: 1 },
      timeout: 15000,
      validateStatus: s => s >= 200 && s < 500,
    })
    if (res.status >= 400) return []

    const splits = (res.data?.stats?.[0]?.splits || [])
      .filter(s => s.stat?.gamesStarted === 1 && s.date < TODAY)
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, N)

    return splits.map(s => ({
      pitcher_id: String(pitcherId),
      game_id:    String(s.game?.gamePk || `${pitcherId}-${s.date}`),
      game_date:  s.date,
      season,
      ip:         ipToDecimal(Number(s.stat?.inningsPitched || 0)),
      bf:         Number(s.stat?.battersFaced || 0),
      ks:         Number(s.stat?.strikeOuts || 0),
      pitches:    Number(s.stat?.numberOfPitches || 0),
      bb:         Number(s.stat?.baseOnBalls || 0),
      fetch_date: TODAY,
    }))
  } catch { return [] }
}

async function main() {
  await db.migrate()

  const season = new Date(TODAY).getFullYear()
  const games  = await db.all(
    `SELECT pitcher_home_id, pitcher_away_id FROM games WHERE date = ?`,
    [TODAY],
  )

  const pitcherIds = [...new Set(
    games.flatMap(g => [g.pitcher_home_id, g.pitcher_away_id]).filter(Boolean),
  )]

  if (!pitcherIds.length) {
    console.log(`[recent-starts] No pitchers found for ${TODAY}`)
    await db.close()
    return
  }

  console.log(`[recent-starts] Fetching last ${N} starts for ${pitcherIds.length} pitchers (${season})…`)
  let saved = 0, hasPitches = 0

  for (const id of pitcherIds) {
    const starts = await fetchStartsForPitcher(id, season)
    for (const s of starts) {
      await db.upsert('pitcher_recent_starts', s, ['pitcher_id', 'game_id'])
      saved++
      if (s.pitches > 0) hasPitches++
    }

    if (starts.length) {
      const avgPitches = starts.filter(s => s.pitches > 0).reduce((a, s) => a + s.pitches, 0) /
                         (starts.filter(s => s.pitches > 0).length || 1)
      const avgBF      = starts.reduce((a, s) => a + (s.bf || 0), 0) / starts.length
      const avgKpct    = starts.reduce((a, s) => a + (s.bf > 0 ? s.ks / s.bf : 0), 0) / starts.length
      console.log(
        `  ${id}: ${starts.length} starts | ` +
        `avg pitches=${avgPitches.toFixed(0)} | avg BF=${avgBF.toFixed(1)} | ` +
        `avg K%=${(avgKpct * 100).toFixed(1)}%`
      )
    } else {
      console.log(`  ${id}: no ${season} starts found`)
    }
  }

  console.log(`[recent-starts] Done — ${saved} rows (${hasPitches} with pitch count data)`)
  await db.close()
}

main().catch(err => {
  console.error('[recent-starts] fatal:', err.message)
  process.exit(1)
})
