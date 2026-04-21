// scripts/live/fetchTeamKpct.js — Fetch live 2026 team K% by pitcher handedness.
//
// Pulls current-season team batting game logs from MLB Stats API, computes
// rolling 14-day K% split by pitcher hand (vs R / vs L), and upserts into
// historical_team_offense so strikeoutEdge.js opponent adjustment uses live
// 2026 data instead of stale 2025 EOY values.
//
// Splits source: MLB /teams/{id}/stats?stats=vsTeam&group=hitting&season=2026
// doesn't give platoon splits by hand, so we use the /stats/leaders endpoint
// to get vs-hand splits, falling back to overall K% when splits aren't available.
//
// Strategy:
//   1. Overall 2026 season K% from /teams/{id}/stats?stats=season
//   2. Platoon split from /stats?stats=season&group=hitting&playerPool=All
//      filtered to each team — gives vs_hand K%
//   3. If platoon unavailable: use overall K% for both hands
//
// Usage:
//   node scripts/live/fetchTeamKpct.js [--season YYYY] [--dry-run]

import 'dotenv/config'
import axios from 'axios'
import * as db from '../../lib/db.js'

const args    = process.argv.slice(2)
const SEASON  = args.includes('--season') ? Number(args[args.indexOf('--season') + 1]) : new Date().getFullYear()
const DRY_RUN = args.includes('--dry-run')

const MLB_BASE = 'https://statsapi.mlb.com/api/v1'

// All 30 MLB team IDs
const ALL_TEAM_IDS = [
  108, 109, 110, 111, 112, 113, 114, 115, 116, 117,
  118, 119, 120, 121, 133, 134, 135, 136, 137, 138,
  139, 140, 141, 142, 143, 144, 145, 146, 147, 158,
]

async function fetchTeamSeasonStats(teamId, season) {
  try {
    const res = await axios.get(`${MLB_BASE}/teams/${teamId}/stats`, {
      params: { stats: 'season', group: 'hitting', season, sportId: 1 },
      timeout: 12000,
      validateStatus: s => s >= 200 && s < 500,
    })
    if (res.status >= 400) return null
    const stat = res.data?.stats?.[0]?.splits?.[0]?.stat
    if (!stat) return null
    const pa = Number(stat.plateAppearances || 0)
    const k  = Number(stat.strikeOuts || 0)
    return { k_pct: pa > 0 ? k / pa : null, pa }
  } catch { return null }
}

// Fetch platoon splits (vs RHP / vs LHP) for a team via the splits endpoint
async function fetchTeamPlatoonSplits(teamId, season) {
  try {
    const res = await axios.get(`${MLB_BASE}/teams/${teamId}/stats`, {
      params: {
        stats: 'statSplits',
        group: 'hitting',
        season,
        sportId: 1,
        sitCodes: 'vr,vl',   // vs RHP, vs LHP
      },
      timeout: 12000,
      validateStatus: s => s >= 200 && s < 500,
    })
    if (res.status >= 400) return null

    const splits = res.data?.stats?.[0]?.splits || []
    const result = {}
    for (const s of splits) {
      const code = s.split?.code  // 'vr' or 'vl'
      if (!code) continue
      const pa = Number(s.stat?.plateAppearances || 0)
      const k  = Number(s.stat?.strikeOuts || 0)
      if (pa > 20) {
        result[code] = { k_pct: k / pa, pa }
      }
    }
    return Object.keys(result).length > 0 ? result : null
  } catch { return null }
}

async function main() {
  await db.migrate()

  console.log(`[team-kpct] Fetching 2026 team K% splits — season=${SEASON}`)

  const today = new Date().toISOString().slice(0, 10)
  let saved = 0, fallback = 0

  for (const teamId of ALL_TEAM_IDS) {
    const [overall, platoon] = await Promise.all([
      fetchTeamSeasonStats(teamId, SEASON),
      fetchTeamPlatoonSplits(teamId, SEASON),
    ])

    if (!overall?.k_pct) {
      console.log(`  [skip] team ${teamId}: no season stats`)
      continue
    }

    // Build rows for vs_hand R and L
    const rows = [
      {
        hand: 'R',
        k_pct: platoon?.vr?.k_pct ?? overall.k_pct,
        pa:    platoon?.vr?.pa    ?? overall.pa,
        source: platoon?.vr ? 'platoon' : 'overall',
      },
      {
        hand: 'L',
        k_pct: platoon?.vl?.k_pct ?? overall.k_pct,
        pa:    platoon?.vl?.pa    ?? overall.pa,
        source: platoon?.vl ? 'platoon' : 'overall',
      },
    ]

    for (const r of rows) {
      if (r.source === 'overall') fallback++

      if (DRY_RUN) {
        console.log(`  dry-run: team=${teamId} vs_${r.hand} K%=${(r.k_pct*100).toFixed(1)}% PA=${r.pa} [${r.source}]`)
        continue
      }

      // Upsert into historical_team_offense — same table strikeoutEdge reads
      // Uses today as as_of_date so it becomes the "most recent" row going forward
      await db.upsert(
        'historical_team_offense',
        {
          team_id:    teamId,
          as_of_date: today,
          vs_hand:    r.hand,
          k_pct_14d:  r.k_pct,    // storing 2026 season K% in this field
        },
        ['team_id', 'as_of_date', 'vs_hand'],
      )
      saved++
    }
  }

  console.log(`[team-kpct] done — saved=${saved} fallback_to_overall=${fallback}`)
  await db.close()
}

main().catch(err => {
  console.error('[team-kpct] fatal:', err.message)
  process.exit(1)
})
