// scripts/live/strikeoutEdge.js — Kalshi strikeout market edge finder.
//
// Model: λ = E[BF] × pK_blended × lineup_adj × park_factor × weather_mult
//           × ump_factor × velo_adj
//
//   pK_blended = three-way K% blend (career / season / L5):
//     pK_career = historical_pitcher_stats career K% (2023-25 weighted 0.5/0.3/0.2)
//     pK_season = pitcher_statcast 2026 Savant K%
//     pK_l5     = last-5-starts K/BF from game log
//     w_career  = max(0, 0.40 × (1 - ip_2026/40))   fades to 0 by 40 IP
//     w_season  = min(0.60, ip_2026/50)              grows to 0.60 by 50 IP
//     w_l5      = 1 - w_career - w_season
//
//   E[BF] = avg BF from pitcher_recent_starts (last 3-5 starts)
//           falls back to avg_ip × LEAGUE_PA_PER_IP when data is missing
//   Leash flag: avg pitch count < 85 over recent starts
//
//   lineup_adj = game_lineups lineup K% / LEAGUE_K_PCT  (official 9-man lineup)
//                falls back to historical_team_offense team K% if lineup not yet posted
//                lineup K% is position-weighted (batting order positions 1-9)
//
//   park_factor = lib/parkFactors.js K-rate multiplier by home team
//
//   weather_mult = applied for outdoor parks only:
//     wind_mph > 15  → ×0.97  (hard to locate breaking balls)
//     temp_f  < 45   → ×0.96  (cold reduces grip/spin rate)
//     humidity > 0.80 → ×1.02 (damp air = slightly more K%)
//     multipliers stack (all three can apply simultaneously)
//
//   ump_factor = lib/umpireFactors.js HP umpire K% tendency multiplier
//
//   velo_adj = velocity trend vs career average:
//     fb_velo up >1 mph vs career  → ×1.03 (more swing-and-miss)
//     fb_velo down >1.5 mph        → ×0.96 (hittable, less movement)
//
//   P(K ≥ n) via Negative Binomial(λ, r=30)
//
// Edge threshold: edge > spread/2 + MIN_EDGE_FLOOR (spread-adjusted)
//   Ensures we're not betting on markets where the spread eats the edge.
//
// Kelly sizing: correlated Kelly across thresholds for the same pitcher.
//   Total exposure per pitcher ≤ max single-threshold Kelly fraction.
//
// Run order each morning:
//   fetchSchedule → fetchPitcherStatcast → fetchTeamKpct → fetchPitcherRecentStarts
//   → fetchLineups (after lineups post ~3-4 PM ET) → strikeoutEdge
//
// Usage:
//   node scripts/live/strikeoutEdge.js [--date YYYY-MM-DD] [--min-edge 0.05] [--json]

import 'dotenv/config'
import axios from 'axios'
import { mlbGet } from '../../lib/mlb-live.js'
import * as db from '../../lib/db.js'
import { toKalshiAbbr, getAuthHeaders } from '../../lib/kalshi.js'
import { getParkFactor } from '../../lib/parkFactors.js'
import { fetchGameWeather } from '../../lib/weather.js'
import { VENUES } from '../../agents/park/venues.js'
import { fetchUmpiresForGames } from './fetchUmpire.js'
import { getUmpireFactor } from '../../lib/umpireFactors.js'
import { correlatedKellyDivide } from '../../lib/kelly.js'
import {
  NB_R, LEAGUE_K9, LEAGUE_AVG_IP, LEAGUE_K_PCT, LEAGUE_PA_PER_IP, LEAGUE_WHIFF_PCT,
  nbCDF, pAtLeast, ipToDecimal,
} from '../../lib/strikeout-model.js'
import { parseArgs } from '../../lib/cli-args.js'
import { recordPipelineStep } from '../../lib/pipelineLog.js'

const opts     = parseArgs({
  date:    { default: new Date().toISOString().slice(0, 10) },
  minEdge: { flag: 'min-edge', type: 'number', default: 0.08 },
  json:    { type: 'boolean' },
})
const TODAY    = opts.date
const MIN_EDGE = opts.minEdge
const JSON_OUT = opts.json  // emit [EDGES_JSON]...[/EDGES_JSON] block for ksBets.js

// ── Edge threshold constants ─────────────────────────────────────────────────
// Spread-adjusted: require edge > spread/2 + MIN_EDGE_FLOOR
// Rationale: in a wide-spread market, the vig alone is large; a raw 5¢ edge
// against a 10¢ spread is not really exploitable — you need clearance above half
// the spread so you're genuinely on the right side of the market, not just
// sitting in the noise band of the bid/ask.
const MIN_EDGE_FLOOR = 0.04   // absolute floor (4¢) regardless of spread

// ── YES/NO asymmetric filters (calibrated from Apr 20-21 live data) ──────────
// YES bets at model_prob < 0.25 went 0-for-14 across 180 bets — market prices
// low-prob YES correctly; we were betting into efficient pricing.
// NO side wins at 74% vs YES at 35% — require stricter entry on YES.
const YES_MIN_PROB = 0.25    // YES bets require model_prob ≥ 25%
const YES_MIN_EDGE = 0.12    // YES bets require edge ≥ 12¢
const NO_MIN_EDGE  = 0.08    // NO bets require edge ≥ 8¢ (vs old global 5¢)

const MLB_BASE = 'https://statsapi.mlb.com/api/v1'
const KALSHI_BASE = 'https://api.elections.kalshi.com/trade-api/v2'


// Venue coord + dome lookups — derived from agents/park/venues.js (single source of truth)
const _venueByTeam = new Map(VENUES.flatMap(v => {
  const entries = [[ v.team.toUpperCase(), v ]]
  if (v.team === 'OAK') entries.push(['ATH', v])  // Athletics alias
  if (v.team === 'WSH') entries.push(['WAS', v])  // Washington alias
  if (v.team === 'CWS') entries.push(['CHW', v])  // Chicago White Sox alias
  return entries
}))
const VENUE_COORDS = Object.fromEntries(
  [..._venueByTeam.entries()].map(([t, v]) => [t, { lat: v.lat, lng: v.lng }])
)
const DOME_TEAMS = new Set(
  [..._venueByTeam.entries()]
    .filter(([, v]) => v.roof_type === 'dome' || v.roof_type === 'retractable')
    .map(([t]) => t)
)

// Standard MLB numeric team IDs → abbreviations (used for opponent K% lookup)
const TEAM_ABBR_TO_MLB_ID = {
  LAA: 108, ARI: 109, AZ: 109, BAL: 110, BOS: 111, CHC: 112,
  CIN: 113, CLE: 114, COL: 115, DET: 116, HOU: 117, KC:  118,
  LAD: 119, WSH: 120, WAS: 120, NYM: 121, OAK: 133, ATH: 133,
  PIT: 134, SD:  135, SEA: 136, SF:  137, STL: 138, TB:  139,
  TEX: 140, TOR: 141, MIN: 142, PHI: 143, ATL: 144, CWS: 145,
  CHW: 145, MIA: 146, NYY: 147, MIL: 158,
}


// ── Savant / pitcher_statcast lookup ─────────────────────────────────────────

let _statcastCache = null  // Map<player_id, row>

async function loadStatcastData(season) {
  if (_statcastCache) return _statcastCache
  const today = new Date().toISOString().slice(0, 10)

  // Prefer today's fetch; fall back to most recent available
  let rows = await db.all(
    `SELECT player_id, k_pct, swstr_pct, fb_velo, fb_spin, gb_pct, bb_pct, ip, pa, k_pct_vs_l, k_pct_vs_r
       FROM pitcher_statcast WHERE season = ? AND fetch_date = ?`,
    [season, today],
  )
  if (!rows.length) {
    rows = await db.all(
      `SELECT player_id, k_pct, swstr_pct, fb_velo, fb_spin, gb_pct, bb_pct, ip, pa, k_pct_vs_l, k_pct_vs_r
         FROM pitcher_statcast WHERE season = ?
         ORDER BY fetch_date DESC LIMIT 500`,
      [season],
    )
  }
  _statcastCache = new Map(rows.map(r => [String(r.player_id), r]))
  console.log(`[ks-edge] Loaded ${_statcastCache.size} pitcher Savant rows (season=${season})`)
  return _statcastCache
}

// ── Career K% loader (pitcher_statcast 2023-2025) ────────────────────────────
// Reads from pitcher_statcast (same table as career velo) — no separate table needed.
// k9 derived as: k_pct × (pa / ip) × 9   (K/9 = K% × BF/IP × 9)
// avg_ip left null — falls back to pitcher_recent_starts or LEAGUE_AVG_IP at runtime.
// Weight: 2025=0.50, 2024=0.30, 2023=0.20

let _careerCache = null  // Map<pitcher_id, { k_pct, k9, avg_ip, seasons }>

async function loadCareerData() {
  if (_careerCache) return _careerCache

  const SEASON_WEIGHTS = { 2025: 0.50, 2024: 0.30, 2023: 0.20 }

  const rows = await db.all(
    `SELECT player_id AS pitcher_id, season, k_pct, ip, pa,
            CASE WHEN ip > 0 AND pa > 0 THEN k_pct * (CAST(pa AS REAL) / ip) * 9 ELSE NULL END AS k9
       FROM pitcher_statcast
      WHERE season BETWEEN 2023 AND 2025
        AND k_pct IS NOT NULL AND ip IS NOT NULL`,
  )

  const byPitcher = new Map()
  for (const r of rows) {
    const id = String(r.pitcher_id)
    if (!byPitcher.has(id)) byPitcher.set(id, [])
    byPitcher.get(id).push(r)
  }

  _careerCache = new Map()
  for (const [id, seasons] of byPitcher) {
    let totalW = 0, wK9 = 0, wKpct = 0
    const usedSeasons = []
    for (const s of seasons) {
      const w = SEASON_WEIGHTS[s.season]
      if (!w || s.k_pct == null) continue
      totalW  += w
      wKpct   += w * s.k_pct
      if (s.k9 != null) wK9 += w * s.k9
      usedSeasons.push(s.season)
    }
    if (totalW > 0) {
      _careerCache.set(id, {
        k_pct:   wKpct / totalW,
        k9:      totalW > 0 && wK9 > 0 ? wK9 / totalW : null,
        avg_ip:  null,   // falls back to pitcher_recent_starts or LEAGUE_AVG_IP
        seasons: usedSeasons,
        weight:  totalW,
      })
    }
  }

  console.log(`[ks-edge] Loaded career profiles for ${_careerCache.size} pitchers (2023-2025)`)
  return _careerCache
}

// ── Career velocity loader (pitcher_statcast 2023-2025) ──────────────────────
//
// Used for improvement 7: velo trend signal.
// We average fb_velo across 2023-2025 seasons to get career baseline.

let _careerVeloCache = null  // Map<pitcher_id, careerAvgFbVelo>

async function loadCareerVelo() {
  if (_careerVeloCache) return _careerVeloCache

  const rows = await db.all(
    `SELECT player_id, AVG(fb_velo) as avg_velo
       FROM pitcher_statcast
      WHERE season BETWEEN 2023 AND 2025 AND fb_velo IS NOT NULL
      GROUP BY player_id`,
  )

  _careerVeloCache = new Map(rows.map(r => [String(r.player_id), Number(r.avg_velo)]))
  if (_careerVeloCache.size > 0) {
    console.log(`[ks-edge] Loaded career fb_velo for ${_careerVeloCache.size} pitchers (2023-2025)`)
  }
  return _careerVeloCache
}

// ── Recent starts cache (pitcher_recent_starts) ───────────────────────────────

let _recentStartsCache = null  // Map<pitcher_id, start[]>

async function loadRecentStarts(season) {
  if (_recentStartsCache) return _recentStartsCache

  const today = new Date().toISOString().slice(0, 10)
  // Prefer today's fetch; fall back to most recent available per pitcher
  const rows = await db.all(
    `SELECT pitcher_id, game_date, ip, bf, ks, pitches, bb
       FROM pitcher_recent_starts
      WHERE season = ?
      ORDER BY pitcher_id, game_date DESC`,
    [season],
  )

  _recentStartsCache = new Map()
  for (const r of rows) {
    const id = String(r.pitcher_id)
    if (!_recentStartsCache.has(id)) _recentStartsCache.set(id, [])
    if (_recentStartsCache.get(id).length < 5) _recentStartsCache.get(id).push(r)
  }

  const count = _recentStartsCache.size
  if (count > 0) console.log(`[ks-edge] Loaded recent starts for ${count} pitchers`)
  return _recentStartsCache
}

// ── Lineup K% cache (game_lineups) ────────────────────────────────────────────

let _lineupsCache = null  // Map<"gameId-teamAbbr-hand", lineup_k_pct>

async function loadLineups(date) {
  if (_lineupsCache) return _lineupsCache
  _lineupsCache = new Map()

  const rows = await db.all(
    `SELECT gl.game_id, gl.team_abbr, gl.vs_hand, gl.lineup_k_pct, gl.batter_count
       FROM game_lineups gl
       INNER JOIN games g ON g.id = gl.game_id
      WHERE g.date = ?
      ORDER BY gl.fetch_date DESC`,
    [date],
  )

  // Keep most recent fetch per (game, team, hand) tuple
  for (const r of rows) {
    const key = `${r.game_id}-${r.team_abbr}-${r.vs_hand}`
    if (!_lineupsCache.has(key)) {
      _lineupsCache.set(key, { k_pct: r.lineup_k_pct, batter_count: r.batter_count })
    }
  }

  if (_lineupsCache.size > 0) {
    console.log(`[ks-edge] Loaded lineup K% for ${_lineupsCache.size / 2} team-games`)
  }
  return _lineupsCache
}

// ── MLB API fetches ───────────────────────────────────────────────────────────

async function fetchGameLog(pitcherId) {
  const data = await mlbGet(`${MLB_BASE}/people/${pitcherId}/stats`, {
    params: { stats: 'gameLog', group: 'pitching', season: 2026, sportId: 1 },
  })
  if (!data) return []
  return (data.stats?.[0]?.splits || []).map(s => ({
    date:    s.date,
    ip:      ipToDecimal(Number(s.stat?.inningsPitched || 0)),
    k:       Number(s.stat?.strikeOuts || 0),
    bf:      Number(s.stat?.battersFaced || 0),
    pitches: Number(s.stat?.numberOfPitches || 0),
    bb:      Number(s.stat?.baseOnBalls || 0),
    started: s.stat?.gamesStarted === 1,
  }))
}

async function fetchPitcherMeta(pitcherId) {
  const data = await mlbGet(`${MLB_BASE}/people/${pitcherId}`)
  const p = data?.people?.[0]
  return {
    name: p?.fullName || String(pitcherId),
    hand: p?.pitchHand?.code || 'R',
  }
}

// ── Opponent K% lookup ────────────────────────────────────────────────────────

/**
 * Fetch opposing lineup K% vs pitcher's hand.
 * Priority: game_lineups (official 9-man lineup) → historical_team_offense → MLB API → league avg.
 */
async function fetchOpponentKpct(teamAbbr, gameDate, pitcherHand, gameId, lineupsCache) {
  // 1. Official lineup from game_lineups
  if (lineupsCache && gameId) {
    const key = `${gameId}-${teamAbbr}-${pitcherHand}`
    const lu = lineupsCache.get(key)
    if (lu?.k_pct != null) {
      return { kpct: lu.k_pct, source: `lineup(${lu.batter_count}batters)` }
    }
  }
  const teamId = TEAM_ABBR_TO_MLB_ID[teamAbbr?.toUpperCase()]
  if (!teamId) return { kpct: LEAGUE_K_PCT, source: 'league_avg' }

  // DB lookup: most recent available date <= gameDate, matching hand split
  const row = await db.one(
    `SELECT k_pct_14d, as_of_date FROM historical_team_offense
     WHERE team_id = ? AND as_of_date <= ? AND vs_hand = ? AND k_pct_14d IS NOT NULL
     ORDER BY as_of_date DESC LIMIT 1`,
    [teamId, gameDate, pitcherHand],
  )
  if (row?.k_pct_14d != null) {
    return { kpct: row.k_pct_14d, source: `db(${row.as_of_date})` }
  }

  // MLB API season totals (no platoon split, but better than league avg)
  const season = new Date(gameDate).getFullYear()
  const teamData = await mlbGet(`${MLB_BASE}/teams/${teamId}/stats`, {
    params: { stats: 'season', group: 'hitting', season },
  })
  if (teamData) {
    const stat = teamData.stats?.[0]?.splits?.[0]?.stat
    if (stat?.strikeOuts && stat?.plateAppearances && stat.plateAppearances > 0) {
      return { kpct: stat.strikeOuts / stat.plateAppearances, source: `mlb_api(${season})` }
    }
  }

  return { kpct: LEAGUE_K_PCT, source: 'league_avg' }
}

// ── Lambda computation ────────────────────────────────────────────────────────

/**
 * Compute λ = E[BF] × pK_blended for a pitcher on a given game date.
 *
 * pK_blended: three-way K% blend (career / season / L5) in per-BF space.
 * E[BF]: from pitcher_recent_starts actual BF history; falls back to ip × PA/IP.
 * Leash: flagged when avg pitch count < 85.
 * Opponent adjustment applied by caller (lineup K% or team K%).
 * Velo trend: compare current season fb_velo vs career average (2023-2025).
 *   +>1 mph → whiffFlag='velo-up', ×1.03; down>1.5 mph → 'velo-down', ×0.96.
 *
 * @param {Array} log - fetchGameLog result
 * @param {string} gameDate
 * @param {object|null} savant - current season pitcher_statcast row
 * @param {object|null} career - career stats from loadCareerData
 * @param {Array} recentStartsData - pitcher_recent_starts rows
 * @param {number|null} careerAvgFbVelo - career average fb_velo from 2023-2025
 */
function computeLambdaBase(log, gameDate, savant, career, recentStartsData, careerAvgFbVelo = null) {
  const cutoff = new Date(gameDate).getTime()
  const priorStarts = (log || [])
    .filter(r => r.started && r.ip >= 0.1 && new Date(r.date).getTime() < cutoff)
    .sort((a, b) => (a.date < b.date ? 1 : -1))

  const last5    = priorStarts.slice(0, 5)
  const nStarts  = last5.length
  const careerIp = career?.avg_ip ?? LEAGUE_AVG_IP

  // ── E[BF] from recent starts or IP fallback ──────────────────────────────
  let expectedBF, bfSource, leashFlag = false, avgPitches = null

  const rsData = (recentStartsData || []).filter(s => s.bf > 0)
  if (rsData.length >= 2) {
    expectedBF = rsData.reduce((s, r) => s + r.bf, 0) / rsData.length
    bfSource   = `BF×${rsData.length}`
    const withPitches = rsData.filter(s => s.pitches > 0)
    if (withPitches.length >= 2) {
      avgPitches = withPitches.reduce((s, r) => s + r.pitches, 0) / withPitches.length
      if (avgPitches < 85) leashFlag = true
      bfSource += `(${avgPitches.toFixed(0)}pc)`
    }
  } else if (nStarts > 0) {
    const logWithBf = last5.filter(r => r.bf > 0)
    if (logWithBf.length >= 2) {
      expectedBF = logWithBf.reduce((s, r) => s + r.bf, 0) / logWithBf.length
      bfSource   = `logBF×${logWithBf.length}`
    } else {
      const earlyExits = last5.filter(r => Math.floor(r.ip) < 3).length
      const cappedIPs  = last5.map(r => Math.floor(r.ip) < 3 ? 3.0 : r.ip)
      const avgIpRaw   = cappedIPs.reduce((s, v) => s + v, 0) / nStarts
      const w_ip = Math.min(1, nStarts / 5)
      expectedBF = (w_ip * avgIpRaw + (1 - w_ip) * careerIp) * LEAGUE_PA_PER_IP
      bfSource   = `ip×PA/IP`
    }
  } else {
    expectedBF = careerIp * LEAGUE_PA_PER_IP
    bfSource   = `career_ip×PA/IP`
  }

  // ── Leash cap: short-leash pitchers face fewer batters ───────────────────
  // If avgPitches < 85, the pitcher is being pulled early. Cap expectedBF at
  // what their actual pitch rate implies (avgPitches / LEAGUE_PITCHES_PER_BF).
  const LEAGUE_PITCHES_PER_BF = 3.8
  if (leashFlag && avgPitches != null) {
    const bfCap = avgPitches / LEAGUE_PITCHES_PER_BF
    if (bfCap < expectedBF) {
      expectedBF = bfCap
      bfSource   += `→capped(${bfCap.toFixed(1)}BF)`
    }
  }

  const avgIp = expectedBF / LEAGUE_PA_PER_IP  // kept for display / legacy logging
  const earlyExitRate = nStarts > 0
    ? last5.filter(r => Math.floor(r.ip) < 3).length / nStarts : null

  // ── pK_l5: last-5 K% per BF ──────────────────────────────────────────────
  const careerKpct = career?.k_pct ?? (LEAGUE_K9 / (LEAGUE_PA_PER_IP * 9))
  const careerK9   = career?.k9   ?? LEAGUE_K9

  let pK_l5, k9_l5
  if (nStarts > 0) {
    const totalBF = last5.reduce((s, r) => s + (r.bf || 0), 0)
    const totalK  = last5.reduce((s, r) => s + r.k, 0)
    const totalIP = last5.reduce((s, r) => s + r.ip, 0)
    const pK_raw  = totalBF > 0 ? totalK / totalBF
                  : totalIP > 0 ? (totalK / totalIP) / LEAGUE_PA_PER_IP : careerKpct
    const w       = Math.min(1, nStarts / 5)
    pK_l5 = w * pK_raw + (1 - w) * careerKpct
    k9_l5 = pK_l5 * LEAGUE_PA_PER_IP * 9
  } else {
    pK_l5 = careerKpct
    k9_l5 = careerK9
  }

  // ── pK_season: 2026 Savant K% ────────────────────────────────────────────
  let pK_season = null, k9_season = null, w_season = 0
  let whiffFlag = null, savantNote = null

  if (savant?.k_pct != null && savant?.ip != null && savant.ip > 0) {
    pK_season  = savant.k_pct
    const paPerIp = (savant.pa != null && savant.pa > 0) ? savant.pa / savant.ip : LEAGUE_PA_PER_IP
    k9_season  = pK_season * paPerIp * 9
    w_season   = Math.min(0.60, savant.ip / 50)
    savantNote = `K%=${(pK_season*100).toFixed(1)}% IP=${savant.ip.toFixed(1)}`
    if (savant.swstr_pct != null) {
      const k_implied = savant.swstr_pct * (LEAGUE_K_PCT / LEAGUE_WHIFF_PCT)
      const gap = k_implied - pK_season
      if (Math.abs(gap) > 0.08) whiffFlag = gap < 0 ? 'K%-may-regress' : 'K%-may-improve'
    }
  }

  // ── Velocity trend signal ────────────────────────────────────────────────
  // Compare current season fb_velo vs career average (2023-2025).
  // Velo up >1 mph → swing-and-miss boost; down >1.5 mph → contact regression.
  let veloTrendMph = null, veloAdj = 1.0

  if (savant?.fb_velo != null && careerAvgFbVelo != null) {
    veloTrendMph = savant.fb_velo - careerAvgFbVelo
    if (veloTrendMph > 1.0) {
      veloAdj  = 1.03
      // Only overwrite whiffFlag if not already set to a K%/whiff signal
      if (!whiffFlag) whiffFlag = 'velo-up'
    } else if (veloTrendMph < -1.5) {
      veloAdj  = 0.96
      if (!whiffFlag) whiffFlag = 'velo-down'
    }
  }

  // ── pK_career: multi-year weighted anchor ────────────────────────────────
  let pK_career = null, k9_career = null, w_career = 0, careerNote = null

  if (career?.k_pct != null) {
    pK_career  = career.k_pct
    k9_career  = pK_career * LEAGUE_PA_PER_IP * 9
    const ip26 = savant?.ip ?? 0
    w_career   = Math.max(0, 0.40 * (1 - ip26 / 40))
    careerNote = `career K%=${(pK_career*100).toFixed(1)}% (${career.seasons?.join('/')||'?'}) w=${w_career.toFixed(2)}`
  }

  // ── Three-way blend in K% space ──────────────────────────────────────────
  const w_l5  = Math.max(0, 1 - w_career - w_season)
  const total = w_career + w_season + w_l5

  let pK_blended
  if (pK_career != null && pK_season != null) {
    pK_blended = (w_career * pK_career + w_season * pK_season + w_l5 * pK_l5) / total
  } else if (pK_season != null) {
    pK_blended = w_season * pK_season + (1 - w_season) * pK_l5
  } else if (pK_career != null) {
    pK_blended = w_career * pK_career + (1 - w_career) * pK_l5
  } else {
    pK_blended = pK_l5
  }

  // Apply velocity adjustment to blended K% before computing lambda
  const pK_afterVelo = pK_blended * veloAdj

  // BB% penalty DISABLED 2026-04-24 — backtest with n=28,973 predictions showed
  // BB_THRESHOLD=1.0 (disabled) produces better Brier score than the active penalty.
  // The rolling game-log BB% is too noisy; season Savant BB% doesn't add signal here.
  const bbPenalty = 1.0

  // ── TTO (Times Through Order) penalty ───────────────────────────────────
  // K rate drops ~18% on the 3rd pass through the lineup — hitters adjust.
  // Only meaningful when pitcher is projected to face ≥19 batters (TTO3+ zone).
  // Apply proportionally: fraction of expectedBF in TTO3+ gets ×0.82.
  const TTO_LINEUP = 9          // batters in a lineup
  const TTO3_BF    = TTO_LINEUP * 2  // BF threshold where TTO3 begins (18)
  const TTO3_DECAY = 0.82        // K rate multiplier in TTO3+
  let ttoPenalty = 1.0, ttoNote = null

  if (expectedBF > TTO3_BF) {
    const bfInTTO3   = expectedBF - TTO3_BF
    const fracTTO3   = bfInTTO3 / expectedBF
    ttoPenalty = 1 - fracTTO3 * (1 - TTO3_DECAY)
    ttoNote = `TTO3=${bfInTTO3.toFixed(1)}BF(${(fracTTO3*100).toFixed(0)}%)→×${ttoPenalty.toFixed(3)}`
  }

  const pK_final   = pK_afterVelo * bbPenalty * ttoPenalty
  const k9         = pK_final * LEAGUE_PA_PER_IP * 9
  const lambdaBase = expectedBF * pK_final

  const dataTag  = [pK_career != null ? 'career' : '', pK_season != null ? 'savant' : '', 'l5'].filter(Boolean).join('+')
  const confidence = nStarts >= 5 ? `high(${dataTag})` : nStarts >= 3 ? `medium(${dataTag})` : `low(${dataTag})`

  return {
    lambdaBase, k9, pK_blended: pK_final,
    k9_l5, k9_season, k9_career,
    w_career, w_season, w_l5,
    expectedBF, avgIp, bfSource, avgPitches, leashFlag,
    nStarts, confidence, earlyExitRate,
    whiffFlag, savantNote, careerNote,
    veloTrendMph, veloAdj,
    bbPenalty,
    ttoPenalty, ttoNote,
  }
}

// ── Weather multiplier helper ─────────────────────────────────────────────────

/**
 * Compute a weather K-rate multiplier and note from a fetchGameWeather result.
 *
 * Conditions applied (each stacks multiplicatively):
 *   wind_mph > 15  → ×0.97  (difficult to locate/spin breaking balls)
 *   temp_f  < 45   → ×0.96  (cold reduces grip, reduces spin on secondary pitches)
 *   humidity > 0.80 → ×1.02 (damp/humid air = slightly more swing-and-miss)
 *
 * @param {object} wx - result from fetchGameWeather (may have ok=false)
 * @returns {{ mult: number, note: string }}
 */
function computeWeatherMult(wx) {
  if (!wx?.ok) return { mult: 1.0, note: 'weather=n/a' }

  let mult = 1.0
  const parts = []

  if (wx.wind_mph != null && wx.wind_mph > 15) {
    mult *= 0.97
    parts.push(`wind=${wx.wind_mph.toFixed(0)}mph→×0.97`)
  }
  if (wx.temp_f != null && wx.temp_f < 45) {
    mult *= 0.96
    parts.push(`temp=${wx.temp_f.toFixed(0)}°F→×0.96`)
  }
  if (wx.humidity != null && wx.humidity > 0.80) {
    mult *= 1.02
    parts.push(`humid=${(wx.humidity * 100).toFixed(0)}%→×1.02`)
  }

  const note = parts.length > 0
    ? parts.join(' ') + ` (net×${mult.toFixed(3)})`
    : `wind=${wx.wind_mph?.toFixed(0) ?? '?'}mph temp=${wx.temp_f?.toFixed(0) ?? '?'}°F (neutral)`
  return { mult, note }
}

// ── Kalshi market fetches ─────────────────────────────────────────────────────

function buildKsEventTicker(awayTeam, homeTeam, gameTime, date) {
  const away = toKalshiAbbr(awayTeam)
  const home = toKalshiAbbr(homeTeam)
  if (!away || !home) return null

  const t = gameTime ? new Date(gameTime) : new Date(`${date}T19:05:00Z`)
  if (Number.isNaN(t.getTime())) return null
  const et = new Date(t.getTime() + (-4 * 60 * 60 * 1000))
  const yy  = String(et.getUTCFullYear()).slice(-2)
  const mmm = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'][et.getUTCMonth()]
  const dd  = String(et.getUTCDate()).padStart(2, '0')
  const hh  = String(et.getUTCHours()).padStart(2, '0')
  const mi  = String(et.getUTCMinutes()).padStart(2, '0')

  return `KXMLBKS-${yy}${mmm}${dd}${hh}${mi}${away}${home}`
}

async function fetchKsMarkets(eventTicker) {
  try {
    const headers = getAuthHeaders('GET', `/trade-api/v2/markets`)
    const res = await axios.get(`${KALSHI_BASE}/markets`, {
      params: { event_ticker: eventTicker, limit: 50, status: 'open' },
      headers,
      timeout: 15000,
      validateStatus: s => s >= 200 && s < 500,
    })
    if (res.status >= 400) return []
    return res.data?.markets || []
  } catch { return [] }
}

function groupByPitcher(markets) {
  const groups = new Map()
  const parseCents = v => {
    if (v == null) return null
    const n = typeof v === 'string' ? parseFloat(v) : v
    return Number.isFinite(n) ? Math.round(n * 100) : null
  }

  for (const m of markets) {
    const titleMatch = m.title?.match(/^(.+?):\s*(\d+)\+ strikeouts?/i)
    if (!titleMatch) continue
    const playerName = titleMatch[1].trim()
    const strike = parseInt(titleMatch[2], 10)
    const tickerParts = m.ticker?.split('-')
    const key = tickerParts?.[tickerParts.length - 2] || playerName

    if (!groups.has(key)) groups.set(key, { name: playerName, key, markets: [] })
    groups.get(key).markets.push({
      strike,
      yes_ask: parseCents(m.yes_ask_dollars),
      yes_bid: parseCents(m.yes_bid_dollars),
      no_ask:  parseCents(m.no_ask_dollars),
      no_bid:  parseCents(m.no_bid_dollars),
      volume:  m.volume_fp != null ? Number(m.volume_fp) : null,
      ticker:  m.ticker,
    })
  }

  for (const g of groups.values()) g.markets.sort((a, b) => a.strike - b.strike)
  return groups
}

// ── Edge calculation ──────────────────────────────────────────────────────────

function calcEdge(modelProb, yes_ask, yes_bid, no_ask, no_bid) {
  if (yes_ask == null || no_ask == null) return null
  const yesEdge = modelProb - yes_ask / 100
  const noEdge  = (1 - modelProb) - no_ask / 100
  const bestEdge = Math.max(yesEdge, noEdge)
  return { yesEdge, noEdge, bestEdge, side: yesEdge >= noEdge ? 'YES' : 'NO' }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  await db.migrate()

  const season = new Date(TODAY).getFullYear()

  const [games, statcastMap, careerMap, recentStartsMap, lineupsCache, careerVeloMap] = await Promise.all([
    db.all(
      `SELECT id, date, game_time, team_home, team_away, pitcher_home_id, pitcher_away_id
         FROM games WHERE date = ? ORDER BY game_time`,
      [TODAY],
    ),
    loadStatcastData(season),
    loadCareerData(),
    loadRecentStarts(season),
    loadLineups(TODAY),
    loadCareerVelo(),
  ])

  if (!games.length) {
    console.log(`[ks-edge] No games found for ${TODAY}`)
    await db.close()
    return
  }

  console.log(`[ks-edge] ${games.length} games on ${TODAY} | NB r=${NB_R} | min edge ${(MIN_EDGE*100).toFixed(0)}¢ (floor=${(MIN_EDGE_FLOOR*100).toFixed(0)}¢+spread/2)\n`)

  // Fetch HP umpires for all games concurrently
  const umpMap = await fetchUmpiresForGames(games.map(g => g.id))
  console.log(`[ks-edge] Ump assignments loaded: ${[...umpMap.values()].filter(u => u.umpName).length}/${games.length} posted`)

  // Fetch weather for all outdoor games concurrently
  const weatherMap = new Map()  // gameId → { mult, note }
  const weatherFetches = games
    .filter(g => !DOME_TEAMS.has(g.team_home?.toUpperCase()))
    .map(async g => {
      const coords  = VENUE_COORDS[g.team_home?.toUpperCase()]
      if (!coords) { weatherMap.set(String(g.id), { mult: 1.0, note: 'venue=unknown' }); return }
      const gameTime = g.game_time || `${g.date}T19:05:00Z`
      const wx = await fetchGameWeather({ lat: coords.lat, lng: coords.lng, gameTime })
      weatherMap.set(String(g.id), computeWeatherMult(wx))
    })
  await Promise.all(weatherFetches)
  // Dome teams get neutral weather
  for (const g of games) {
    if (!weatherMap.has(String(g.id))) {
      weatherMap.set(String(g.id), { mult: 1.0, note: 'dome' })
    }
  }
  console.log(`[ks-edge] Weather loaded for ${weatherMap.size} games`)

  const allEdges = []

  for (const game of games) {
    const label = `${game.team_away}@${game.team_home}`
    const pitcherSlots = [
      { id: game.pitcher_home_id, team: game.team_home, oppTeam: game.team_away },
      { id: game.pitcher_away_id, team: game.team_away, oppTeam: game.team_home },
    ].filter(p => p.id)

    if (!pitcherSlots.length) { console.log(`[skip] ${label}: no pitcher IDs`); continue }

    const eventTicker = buildKsEventTicker(game.team_away, game.team_home, game.game_time, game.date)
    if (!eventTicker) { console.log(`[skip] ${label}: could not build ticker`); continue }

    const rawMarkets = await fetchKsMarkets(eventTicker)
    if (!rawMarkets.length) {
      console.log(`[none] ${label}: no KS markets (${eventTicker})`)
      continue
    }

    const pitcherGroups = groupByPitcher(rawMarkets)
    console.log(`── ${label} ──`)

    for (const { id, team, oppTeam } of pitcherSlots) {
      // Collect all threshold edges for this pitcher before applying correlated Kelly
      const pitcherEdgesThisGame = []

      const [log, meta] = await Promise.all([
        fetchGameLog(id),
        fetchPitcherMeta(id),
      ])

      const savant        = statcastMap.get(String(id)) || null
      const career        = careerMap.get(String(id)) || null
      const recentStarts  = recentStartsMap.get(String(id)) || []
      const careerAvgFbVelo = careerVeloMap.get(String(id)) ?? null

      const { lambdaBase, k9, pK_blended,
              k9_l5, k9_season, k9_career,
              w_career, w_season, w_l5,
              expectedBF, avgIp, bfSource, avgPitches, leashFlag,
              nStarts, confidence, earlyExitRate,
              whiffFlag, savantNote, careerNote,
              veloTrendMph, veloAdj, bbPenalty,
              ttoPenalty, ttoNote } =
        computeLambdaBase(log, TODAY, savant, career, recentStarts, careerAvgFbVelo)

      const { kpct: oppKpct, source: kpctSource } =
        await fetchOpponentKpct(oppTeam, TODAY, meta.hand, game.id, lineupsCache)
      const adjFactor = oppKpct / LEAGUE_K_PCT
      // Official lineup K% (from game_lineups) = real signal, apply continuously with soft cap.
      // Team-average fallback = noisy, keep 0.28 extreme-only gate (calibrated 2024-2025 OOS).
      let effectiveAdj
      if (kpctSource.startsWith('lineup')) {
        // Soft cap ±15% to prevent outlier single-game lineup distortions
        effectiveAdj = Math.max(0.85, Math.min(1.15, adjFactor))
      } else {
        effectiveAdj = Math.abs(adjFactor - 1.0) > 0.28 ? adjFactor : 1.0
      }

      // Park factor (improvement 1)
      const parkFactor = getParkFactor(game.team_home)

      // Weather multiplier (improvement 4) — already computed at startup
      const { mult: weatherMult, note: weatherNote } = weatherMap.get(String(game.id)) || { mult: 1.0, note: 'n/a' }

      // Umpire factor (improvement 5)
      const umpInfo   = umpMap.get(String(game.id)) || {}
      const umpFactor = getUmpireFactor(umpInfo.umpName)
      const umpName   = umpInfo.umpName || null

      // Handedness split adjustment: pitcher's K% vs LHB/RHB vs typical MLB lineup composition.
      // MLB lineups are ~40% LHB on average. This corrects for extreme platoon mismatches
      // (e.g., RHP who dominates LHB facing a lineup that's 75% RHB → reduce lambda).
      // Capped at ±7% since the 40% LHB assumption is a league average, not lineup-specific.
      let splitAdj = 1.0
      let splitNote = ''
      if (savant?.k_pct_vs_l != null && savant?.k_pct_vs_r != null && (savant.k_pct ?? 0) > 0.01) {
        const LHB_PCT = 0.40  // MLB default; refined when confirmed lineups are available
        const splitK  = LHB_PCT * savant.k_pct_vs_l + (1 - LHB_PCT) * savant.k_pct_vs_r
        const raw     = splitK / savant.k_pct
        splitAdj = Math.max(0.93, Math.min(1.07, raw))
        if (Math.abs(splitAdj - 1.0) > 0.015) {
          splitNote = ` | splitK×${splitAdj.toFixed(2)}(vsL=${(savant.k_pct_vs_l*100).toFixed(1)}%,vsR=${(savant.k_pct_vs_r*100).toFixed(1)}%)`
        }
      }

      const lambda    = lambdaBase * splitAdj * effectiveAdj * parkFactor * weatherMult * umpFactor

      const adjStr = ` | opp=${(oppKpct*100).toFixed(1)}% [${kpctSource}] ×${adjFactor.toFixed(2)}→${effectiveAdj.toFixed(2)}`
      const parkStr = ` | park×${parkFactor.toFixed(2)}(${game.team_home})`
      const wxStr   = weatherMult !== 1.0 ? ` | wx:${weatherNote}` : ''
      const umpStr  = umpName ? ` | ump=${umpName}(×${umpFactor.toFixed(2)})` : ' | ump=TBD'
      const bfStr   = ` E[BF]=${expectedBF.toFixed(1)}[${bfSource}]${leashFlag ? ' ⚠leash' : ''}${avgPitches ? ` ${avgPitches.toFixed(0)}pc` : ''}`

      const blendParts = []
      if (k9_career != null) blendParts.push(`career=${k9_career.toFixed(1)}(w=${w_career.toFixed(2)})`)
      if (k9_season != null) blendParts.push(`savant=${k9_season.toFixed(1)}(w=${w_season.toFixed(2)})`)
      blendParts.push(`l5=${k9_l5.toFixed(1)}(w=${w_l5.toFixed(2)})`)
      const blendStr = ` K/9=${k9.toFixed(1)} [${blendParts.join(' ')}]`

      const flagStr   = whiffFlag ? ` ⚑${whiffFlag}` : ''
      const savantStr = savantNote ? ` | ${savantNote}${flagStr}` : ' | [no savant]'
      const careerStr = careerNote ? ` | ${careerNote}` : ' | [no career]'

      const veloStr = veloTrendMph != null
        ? ` | velo${veloTrendMph >= 0 ? '+' : ''}${veloTrendMph.toFixed(1)}mph→×${veloAdj.toFixed(2)}`
        : ''
      const bbStr    = bbPenalty  < 1.0 ? ` | bb%×${bbPenalty.toFixed(3)}`  : ''
      const ttoStr   = ttoNote         ? ` | ${ttoNote}`                     : ''

      console.log(
        `  ${meta.name} (${team} ${meta.hand}HP) | λ=${lambda.toFixed(2)} (base=${lambdaBase.toFixed(2)})` +
        `${blendStr} |${bfStr} | starts=${nStarts} [${confidence}]` +
        `${earlyExitRate != null ? ` | exit%=${(earlyExitRate*100).toFixed(0)}%` : ''}${adjStr}` +
        `${parkStr}${wxStr}${umpStr}${veloStr}${bbStr}${ttoStr}${splitNote}${savantStr}${careerStr}`
      )

      // ── Pipeline: emit model_input + lambda_calc ──────────────────────────
      const _gameLabel = label || `${game.team_away}@${game.team_home}`
      recordPipelineStep({
        bet_date: TODAY, pitcher_id: String(id), pitcher_name: meta.name,
        game_id: game.id, game_label: _gameLabel,
        pitcher_side: team === game.team_home ? 'home' : 'away',
        game_time: game.game_time,
        step: 'model_input',
        payload: {
          k_pct_career: career?.k_pct ?? null,
          k9_career:    k9_career ?? null,
          k_pct_l5:     savant?.k_pct ?? null,
          k9_l5,
          bb9_l5:       null,
          avg_ip_l5:    avgIp ?? null,
          velo_trend_mph: veloTrendMph ?? null,
          savant_fbv:   savant?.fb_velo ?? null,
          savant_whiff: savant?.swstr_pct ?? null,
          opp_team:     oppTeam,
          opp_k_pct:    oppKpct,
          opp_kpct_source: kpctSource,
          expected_bf:  expectedBF,
          bf_source:    bfSource,
          confidence,
          n_starts:     nStarts,
          hand:         meta.hand,
        },
        summary: { confidence },
      }).catch(() => {})
      recordPipelineStep({
        bet_date: TODAY, pitcher_id: String(id), pitcher_name: meta.name,
        game_id: game.id, game_label: _gameLabel,
        step: 'lambda_calc',
        payload: {
          lambda_base: lambdaBase,
          lambda_final: lambda,
          p_k_blended: pK_blended,
          velo_adj: veloAdj ?? 1.0,
          bb_penalty: bbPenalty,
          tto_penalty: ttoPenalty ?? 1.0,
          tto_note: ttoNote ?? null,
          split_adj: splitAdj,
          opp_adj: effectiveAdj,
          raw_adj_factor: adjFactor,
          park_factor: parkFactor,
          park_team: game.team_home,
          weather_mult: weatherMult,
          weather_note: weatherNote ?? null,
          ump_factor: umpFactor,
          ump_name: umpName,
          leash_flag: leashFlag,
          avg_pitches: avgPitches ?? null,
        },
        summary: { lambda, n_markets: group?.markets?.length ?? 0 },
      }).catch(() => {})

      const kalshiTeam = toKalshiAbbr(team)
      let group = null
      for (const [key, g] of pitcherGroups) {
        if (key.startsWith(kalshiTeam)) { group = g; break }
      }

      if (!group) {
        console.log(`    [no market] no Kalshi group for ${meta.name} (${kalshiTeam})`)
        console.log('')
        recordPipelineStep({
          bet_date: TODAY, pitcher_id: String(id), pitcher_name: meta.name,
          step: 'edges',
          payload: [],
          summary: { n_markets: 0, n_edges: 0, best_edge: null, final_action: 'no_markets', status: 'processed', skip_reason: 'no Kalshi group' },
        }).catch(() => {})
        continue
      }

      const _pipelineEdges = []

      for (const mkt of group.markets) {
        const rawModelProb = pAtLeast(lambda, mkt.strike)
        const mid    = mkt.yes_ask != null && mkt.yes_bid != null ? (mkt.yes_ask + mkt.yes_bid) / 2 : null
        const spread = mkt.yes_ask != null && mkt.yes_bid != null ? mkt.yes_ask - mkt.yes_bid : null

        // Live data shows model UNDER-predicts the upper tail (K≥7+ wins at 44-45%
        // when model says 30-40%); shrinkage was making it worse. Use raw probability.
        const modelProb = rawModelProb

        const edge = calcEdge(modelProb, mkt.yes_ask, mkt.yes_bid, mkt.no_ask, mkt.no_bid)
        if (!edge) continue

        // Skip in-game locked prices (resolved markets push to 0¢ or 99¢+)
        const isLocked = (mkt.yes_ask != null && mkt.yes_ask >= 99) ||
                         (mkt.yes_bid != null && mkt.yes_bid <= 1 && mkt.yes_ask != null && mkt.yes_ask <= 2)

        // ── Spread-adjusted edge threshold (improvement 3) ───────────────────
        // Require: edge > spread/2 + MIN_EDGE_FLOOR
        // Rationale: if spread=10¢, you need to be at least 5¢ above the
        // midpoint to have a real directional edge. A flat 5¢ threshold ignores
        // that the market maker's vig is already embedded in the spread.
        const spreadHalf    = spread != null ? spread / 2 / 100 : 0   // convert ¢ → decimal
        const edgeThreshold = spread != null ? spreadHalf + MIN_EDGE_FLOOR : MIN_EDGE

        // ── NO bet 80¢ cap (loss prevention fix) ─────────────────────────────
        // When NO mid > 80¢ (YES mid < 20¢), risk/reward is terrible:
        // you're risking ~85¢ to win ~15¢. Tail blowups wipe out many wins.
        // Evidence: Wrobleski 2+ NO at 93¢ mid → -$92.50 on single bet.
        const noMid = mid != null ? 100 - mid : null
        const noCapKills = edge.side === 'NO' && noMid != null && noMid > 80

        // Skip markets with too little volume — price isn't real
        const tooThin = mkt.volume != null && mkt.volume < 10

        // ── YES/NO asymmetric quality filter ─────────────────────────────────
        const sideMinEdge   = edge.side === 'YES' ? YES_MIN_EDGE : NO_MIN_EDGE
        const yesFiltered   = edge.side === 'YES' && modelProb < YES_MIN_PROB
        const hasEdge       = !isLocked && !noCapKills && !tooThin && !yesFiltered
                              && edge.bestEdge >= Math.max(edgeThreshold, sideMinEdge)
        const hasRawEdge    = !isLocked && !hasEdge && (noCapKills || tooThin || yesFiltered || edge.bestEdge >= MIN_EDGE)

        console.log(
          `    ${mkt.strike}+ Ks: model=${(modelProb*100).toFixed(1)}%` +
          ` | mid=${mid != null ? mid.toFixed(0)+'¢' : 'n/a'}` +
          ` | spread=${spread != null ? spread+'¢' : 'n/a'}` +
          ` | edge(${edge.side})=${(edge.bestEdge*100).toFixed(1)}¢` +
          ` | thr=${(edgeThreshold*100).toFixed(1)}¢` +
          ` | vol=${mkt.volume != null ? Math.round(mkt.volume) : 'n/a'}` +
          (isLocked ? ' [locked]' : hasEdge ? ' ← EDGE' : noCapKills ? ' [NO-cap>80¢]' : tooThin ? ' [thin<10]' : yesFiltered ? ' [YES-prob<25%]' : hasRawEdge ? ' [spread-kills-edge]' : '')
        )

        _pipelineEdges.push({
          strike: mkt.strike,
          yes_ask: mkt.yes_ask,
          yes_bid: mkt.yes_bid,
          mid,
          spread,
          model_prob: modelProb,
          raw_model_prob: rawModelProb,
          edge_yes: edge.yesEdge,
          edge_no: edge.noEdge,
          best_edge: edge.bestEdge,
          side: edge.side,
          threshold_cents: edgeThreshold * 100,
          passed: hasEdge,
          reason: isLocked ? 'locked' : noCapKills ? 'NO-cap>80¢' : tooThin ? 'thin<10vol' : yesFiltered ? 'YES-prob<25%' : !hasEdge ? 'below threshold' : null,
          ticker: mkt.ticker,
        })

        if (hasEdge) {
          pitcherEdgesThisGame.push({
            game: label, pitcher: meta.name, pitcher_id: String(id), hand: meta.hand, team,
            strike: mkt.strike, side: edge.side,
            model_prob: modelProb, raw_model_prob: rawModelProb, market_mid: mid,
            edge: edge.bestEdge, spread: spread,
            volume: mkt.volume, ticker: mkt.ticker,
            lambda, lambda_base: lambdaBase, k9, k9_l5, k9_season, k9_career,
            w_career, w_season, w_l5, avg_ip: avgIp,
            opp_k_pct: oppKpct, adj_factor: effectiveAdj, raw_adj_factor: adjFactor,
            bb_penalty: bbPenalty,
            park_factor: parkFactor,
            weather_mult: weatherMult,
            weather_note: weatherNote,
            ump_name: umpName, ump_factor: umpFactor,
            velo_trend_mph: veloTrendMph, velo_adj: veloAdj,
            n_starts: nStarts, confidence,
            savant_k_pct: savant?.k_pct ?? null,
            savant_whiff: savant?.swstr_pct ?? null,
            savant_fbv:   savant?.fb_velo ?? null,
            whiff_flag: whiffFlag,
            // correlated Kelly will be added below after all thresholds are collected
            modelProb, marketPrice: mid != null ? mid / 100 : null,
          })
        }
      }

      // ── Correlated Kelly sizing (improvement 2) ───────────────────────────
      // All YES bets on the same pitcher are correlated: if he throws 8K, every
      // YES at 5+, 6+, 7+, 8+ all win. Sizing each independently at full Kelly
      // would massively over-expose the bankroll to one pitcher outcome.
      // Fix: total pitcher exposure = max single-threshold Kelly; divide proportionally.
      if (pitcherEdgesThisGame.length > 0) {
        const kellyInputs = pitcherEdgesThisGame.map(e => ({
          modelProb:   e.model_prob,
          marketPrice: e.marketPrice,
          side:        e.side,
          edge:        e.edge,
        }))
        const kellyResults = correlatedKellyDivide(kellyInputs, true)  // morning bets post as maker orders

        for (let i = 0; i < pitcherEdgesThisGame.length; i++) {
          const e = pitcherEdgesThisGame[i]
          const k = kellyResults[i]
          allEdges.push({
            ...e,
            bet_size:        k?.betSize ?? null,
            kelly_fraction:  k?.kellyFraction ?? null,
            kelly_scale:     k?.scaleFactor ?? null,
            kelly_rationale: k?.rationale ?? null,
            raw_model_prob:  e.rawModelProb ?? null,
          })
        }
      }

      // ── Pipeline: emit edges step ──────────────────────────────────────────
      const _passedEdges = _pipelineEdges.filter(e => e.passed)
      const _bestEdge = _passedEdges.length > 0 ? Math.max(..._passedEdges.map(e => e.best_edge)) : null
      recordPipelineStep({
        bet_date: TODAY, pitcher_id: String(id), pitcher_name: meta.name,
        game_id: game.id, game_label: _gameLabel,
        step: 'edges',
        payload: _pipelineEdges,
        summary: {
          n_markets: _pipelineEdges.length,
          n_edges: _passedEdges.length,
          best_edge: _bestEdge,
          final_action: _passedEdges.length === 0 ? 'no_edge' : null,
          skip_reason: _passedEdges.length === 0 ? 'edge below threshold' : null,
        },
      }).catch(() => {})

      console.log('')
    }
  }

  if (!allEdges.length) {
    console.log('No edges found above threshold.')
    await db.close()
    return
  }

  console.log('\n═══ EDGE SUMMARY ═══')
  allEdges
    .sort((a, b) => b.edge - a.edge)
    .forEach(e => {
      const adjTag  = e.adj_factor !== 1 ? ` adj×${e.adj_factor.toFixed(2)}` : ''
      const parts = []
      if (e.k9_career != null) parts.push(`${e.k9_career.toFixed(1)}c`)
      if (e.k9_season != null) parts.push(`${e.k9_season.toFixed(1)}s`)
      parts.push(`${e.k9_l5.toFixed(1)}l5`)
      const k9Tag     = ` k9=blend(${parts.join('/')})`
      const savantTag = e.savant_k_pct != null
        ? ` K%=${(e.savant_k_pct*100).toFixed(1)}% Whiff%=${e.savant_whiff != null ? (e.savant_whiff*100).toFixed(1)+'%' : 'n/a'} FBv=${e.savant_fbv != null ? e.savant_fbv.toFixed(1) : 'n/a'}`
        : ''
      const warnTag   = e.whiff_flag ? ` ⚑${e.whiff_flag}` : ''
      const parkTag   = e.park_factor != null && e.park_factor !== 1.0 ? ` park×${e.park_factor.toFixed(2)}` : ''
      const umpTag    = e.ump_name ? ` ump=${e.ump_name}(×${e.ump_factor?.toFixed(2)})` : ''
      const veloTag   = e.velo_trend_mph != null && e.velo_adj !== 1.0
        ? ` velo${e.velo_trend_mph >= 0 ? '+' : ''}${e.velo_trend_mph.toFixed(1)}→×${e.velo_adj?.toFixed(2)}`
        : ''
      const betTag    = e.bet_size != null
        ? `  BET=$${e.bet_size}(${(e.kelly_fraction * 100).toFixed(1)}%Kelly` +
          (e.kelly_scale != null && e.kelly_scale < 1 ? ` corrScale×${e.kelly_scale.toFixed(2)}` : '') + ')'
        : ''
      console.log(
        `  ${e.pitcher} (${e.game})  ${e.strike}+ Ks  ${e.side}` +
        `  model=${(e.model_prob*100).toFixed(1)}%` +
        `  mid=${e.market_mid != null ? e.market_mid.toFixed(0)+'¢' : 'n/a'}` +
        `  edge=${(e.edge*100).toFixed(1)}¢` +
        `  λ=${e.lambda.toFixed(2)}${adjTag}${k9Tag}` +
        `${parkTag}${umpTag}${veloTag}${savantTag}${warnTag}` +
        `  [${e.confidence}]${betTag}` +
        `  ${e.ticker}`
      )
    })

  if (JSON_OUT) {
    process.stdout.write(`\n[EDGES_JSON]${JSON.stringify(allEdges)}[/EDGES_JSON]\n`)
  }

  await db.close()
}

main().catch(err => {
  console.error('[ks-edge] fatal:', err.message)
  process.exit(1)
})
