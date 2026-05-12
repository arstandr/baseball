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
import { loadModel, predictPk } from '../../lib/pkModel.js'
import { correlatedKellyDivide } from '../../lib/kelly.js'
import { getAvailablePool } from '../../lib/bankrollState.js'
import {
  NB_R, LEAGUE_K9, LEAGUE_AVG_IP, LEAGUE_K_PCT, LEAGUE_PA_PER_IP, LEAGUE_WHIFF_PCT,
  nbCDF, pAtLeast, archetypeR, ipToDecimal,
} from '../../lib/strikeout-model.js'
import { parseArgs } from '../../lib/cli-args.js'
import { recordPipelineStep } from '../../lib/pipelineLog.js'
import { getRules } from '../../lib/bettingRules.js'
import { buildSnapshotRow, writeSnapshotBatch } from '../../lib/marketSnapshotWriter.js'

const opts     = parseArgs({
  date:          { default: new Date().toISOString().slice(0, 10) },
  minEdge:       { flag: 'min-edge', type: 'number', default: 0.08 },
  json:          { type: 'boolean' },
  triggerSource: { flag: 'trigger-source', default: 'morning' },
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
// Apr 2026 data: 8-12¢ NO bucket was 30 bets, 26.7% win rate, -$101. Raised from 8¢.
const NO_MIN_EDGE  = 0.12    // NO bets require edge ≥ 12¢

// Batting order slot weights: leadoff (slot 1) sees ~15% more PAs than #9.
// Research: slots 1-2 see ~4.4 PA/game, slot 9 ~3.6. Weights are PA-proportional,
// normalized so equal-weight lineup (all weights=1.0) would give the same result.
const LINEUP_SLOT_WEIGHTS = [1.15, 1.10, 1.10, 1.05, 1.00, 0.95, 0.90, 0.85, 0.80]

const MLB_BASE = 'https://statsapi.mlb.com/api/v1'
const KALSHI_BASE = 'https://api.elections.kalshi.com/trade-api/v2'

const _pkModel = loadModel()


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
    `SELECT player_id, k_pct, swstr_pct, fb_velo, fb_spin, gb_pct, bb_pct, ip, pa, k_pct_vs_l, k_pct_vs_r, nb_r, manager_leash_factor
       FROM pitcher_statcast WHERE season = ? AND fetch_date = ?`,
    [season, today],
  )
  if (!rows.length) {
    rows = await db.all(
      `SELECT player_id, k_pct, swstr_pct, fb_velo, fb_spin, gb_pct, bb_pct, ip, pa, k_pct_vs_l, k_pct_vs_r, nb_r, manager_leash_factor
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
    `SELECT gl.game_id, gl.team_abbr, gl.vs_hand, gl.lineup_k_pct, gl.batter_count, gl.lineup_json
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
      _lineupsCache.set(key, { k_pct: r.lineup_k_pct, batter_count: r.batter_count, lineup_json: r.lineup_json })
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
 * Slot-weighted lineup K% using batting order position.
 * lineup_json = [{id, vs_r, vs_l}] where index = batting order slot (0-based, percent space).
 * Leadoff sees ~15% more PAs per game than #9 → higher slot weight inflates their K% contribution.
 * Missing per-batter data falls back to LEAGUE_K_PCT.
 */
function computeSlotWeightedKpct(lineupJson, pitcherHand) {
  try {
    const batters = typeof lineupJson === 'string' ? JSON.parse(lineupJson) : lineupJson
    if (!Array.isArray(batters) || !batters.length) return null

    const field = pitcherHand === 'L' ? 'vs_l' : 'vs_r'
    const leaguePct = LEAGUE_K_PCT * 100  // percent space (e.g. 22.5)

    let weightedSum = 0, totalWeight = 0
    for (let i = 0; i < Math.min(9, batters.length); i++) {
      const w    = LINEUP_SLOT_WEIGHTS[i] ?? 1.0
      const kPct = batters[i]?.[field] ?? leaguePct
      weightedSum += w * kPct
      totalWeight += w
    }

    return totalWeight > 0 ? (weightedSum / totalWeight) / 100 : null  // back to decimal
  } catch {
    return null
  }
}

/**
 * Fetch opposing lineup K% vs pitcher's hand.
 * Priority: game_lineups slot-weighted → game_lineups equal-weight → historical_team_offense → MLB API → league avg.
 */
async function fetchOpponentKpct(teamAbbr, gameDate, pitcherHand, gameId, lineupsCache) {
  // 1. Official lineup from game_lineups — prefer slot-weighted over equal-weight
  if (lineupsCache && gameId) {
    const key = `${gameId}-${teamAbbr}-${pitcherHand}`
    const lu = lineupsCache.get(key)
    if (lu?.lineup_json) {
      const slotWt = computeSlotWeightedKpct(lu.lineup_json, pitcherHand)
      if (slotWt != null) {
        return { kpct: slotWt, source: `lineup_slot(${lu.batter_count ?? '?'})` }
      }
    }
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
      // Only floor short starts when they're anomalous (< 40% of sample).
      // When early exits are common (pitcher is genuinely a short-leash arm or had weather/injury)
      // use actual IPs so we don't inflate expected BF for the current start.
      const useFloor = earlyExits / nStarts < 0.4
      const adjIPs   = useFloor
        ? last5.map(r => Math.floor(r.ip) < 3 ? 3.0 : r.ip)
        : last5.map(r => r.ip)
      const avgIpRaw   = adjIPs.reduce((s, v) => s + v, 0) / nStarts
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

  // ── Manager leash factor: scale expectedBF by pitcher-specific pull tendency ──
  // Built by buildManagerLeash.js from historical starts (requires ≥10 starts).
  // <1.0 = pitcher tends to get pulled earlier than λ predicts (haircut BF).
  // >1.0 = pitcher tends to go deeper than λ predicts (bonus BF).
  const leashFactor = savant?.manager_leash_factor ?? 1.0
  if (leashFactor !== 1.0) {
    expectedBF = expectedBF * leashFactor
    bfSource   += `×leash(${leashFactor.toFixed(2)})`
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

    // ── Asymmetric L5 shrinkage toward career (May 2 audit) ──
    // k9_l5 has only 0.273 Pearson correlation with next-start K count, so
    // recent K rate is mostly noise — but the prior code weighted it ~30% of
    // the lambda blend. Hot/avg pitchers showed +28-30% upside bias; cold
    // pitchers showed +4% (calibrated). Diagnosis: the model treats hot
    // streaks as stable skill signal when they're actually noise.
    //
    // Fix: shrink hot L5 → career heavily (keep only 50% of gap), shrink cold
    // L5 → career lightly (keep 85%). Replaces the prior hard 1.25× cap with
    // a continuous, asymmetric correction. Tunable via env.
    const HOT_KEEP  = Number(process.env.L5_HOT_KEEP  ?? 0.50)
    const COLD_KEEP = Number(process.env.L5_COLD_KEEP ?? 0.85)
    const _gap = k9_l5 - careerK9
    const _keep = _gap > 0 ? HOT_KEEP : COLD_KEEP
    const _adjusted = careerK9 + _gap * _keep
    if (Math.abs(_adjusted - k9_l5) > 0.01) {
      console.log(`[strikeout-edge] L5 ${_gap > 0 ? 'hot' : 'cold'} shrinkage: k9_l5 ${k9_l5.toFixed(2)} → ${_adjusted.toFixed(2)} (career ${careerK9.toFixed(2)}, gap ${_gap.toFixed(2)} × keep=${_keep})`)
      k9_l5 = _adjusted
      pK_l5 = _adjusted / (LEAGUE_PA_PER_IP * 9)
    }
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
    w_season   = Math.min(0.60, savant.ip / 30)
    savantNote = `K%=${(pK_season*100).toFixed(1)}% IP=${savant.ip.toFixed(1)}`
    if (savant.swstr_pct != null) {
      const k_implied = savant.swstr_pct * (LEAGUE_K_PCT / LEAGUE_WHIFF_PCT)
      const gap = k_implied - pK_season
      // SwStr%-implied K% correction (formula path only — ML model handles this via savant_whiff).
      // When SwStr% and actual K% diverge meaningfully, blend pK_season 20% toward k_implied.
      // This corrects for pitchers whose K% hasn't yet caught up with their true swing-and-miss rate.
      // Only runs when the ML model won't override (pitchers with <5 IP 2026 data = rookies, openers).
      const mlWillRun = _pkModel != null && savant.ip >= 5
      if (!mlWillRun && Math.abs(gap) > 0.04) {
        const adj = 0.20 * gap
        pK_season = pK_season + adj
        k9_season = pK_season * paPerIp * 9  // keep k9_season aligned with adjusted pK_season
        savantNote = `${savantNote} swstr-adj=${adj > 0 ? '+' : ''}${(adj * 100).toFixed(1)}%`
      }
      // whiffFlag reflects remaining discrepancy after correction (for logging only)
      const remainingGap = k_implied - pK_season
      if (Math.abs(remainingGap) > 0.08) whiffFlag = remainingGap < 0 ? 'K%-may-regress' : 'K%-may-improve'
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

  let pK_blended_formula
  if (pK_career != null && pK_season != null) {
    pK_blended_formula = (w_career * pK_career + w_season * pK_season + w_l5 * pK_l5) / total
  } else if (pK_season != null) {
    // Career data missing — re-normalize between season and L5 only.
    // Old code used (1-w_season) as the L5 weight, but w_career was still non-zero
    // (e.g. 0.40 for a rookie), making the complement wrong and inflating L5 share.
    const tSL = w_season + w_l5
    pK_blended_formula = tSL > 0 ? (w_season * pK_season + w_l5 * pK_l5) / tSL : pK_l5
  } else if (pK_career != null) {
    // Season data missing — re-normalize between career and L5 only.
    const tCL = w_career + w_l5
    pK_blended_formula = tCL > 0 ? (w_career * pK_career + w_l5 * pK_l5) / tCL : pK_l5
  } else {
    pK_blended_formula = pK_l5
  }

  // ML model replaces the hand-tuned pK_blended when weights are available.
  // Requires ≥5 IP of 2026 Statcast coverage — without it, log_ip_proxy=log1p(0)
  // sits 3+ σ below the training mean and inflates pK to the clip ceiling.
  const hasSavantCoverage = savant?.ip != null && savant.ip >= 5
  const ml_pK = (_pkModel && hasSavantCoverage) ? predictPk({
    k9_l5:               k9_l5,
    k9_career:           k9_career,
    k9_season:           k9_season,
    savant_k_pct:        savant?.k_pct,
    savant_whiff:        savant?.swstr_pct,
    savant_fbv:          savant?.fb_velo,
    savant_gb_pct:       savant?.gb_pct,
    savant_bb_pct:       savant?.bb_pct,
    k_pct_vs_l:          savant?.k_pct_vs_l,
    k_pct_vs_r:          savant?.k_pct_vs_r,
    savant_ip:           savant?.ip,
    savant_pa:           savant?.pa,
    manager_leash_factor: savant?.manager_leash_factor,
    expected_bf:         expectedBF,
    early_exit_rate_l5:  earlyExitRate,
    w_season, w_career, w_l5,
    pK_blended_prod:     pK_blended_formula,
  }, _pkModel) : null

  const pK_blended = ml_pK ?? pK_blended_formula

  // Apply velocity adjustment to blended K% before computing lambda
  const pK_afterVelo = pK_blended * veloAdj

  // BB% penalty DISABLED 2026-04-24 — backtest with n=28,973 predictions showed
  // BB_THRESHOLD=1.0 (disabled) produces better Brier score than the active penalty.
  // The rolling game-log BB% is too noisy; season Savant BB% doesn't add signal here.
  const bbPenalty = 1.0

  // ── TTO (Times Through Order) penalty ───────────────────────────────────
  // K rate drops ~15% on the 3rd pass through the lineup — hitters adjust.
  // Only meaningful when pitcher is projected to face ≥19 batters (TTO3+ zone).
  // Apply proportionally: fraction of expectedBF in TTO3+ gets ×0.85.
  // Value matches inGameEdge.js (TTO_PENALTY=0.85) so pre-game and live models agree.
  const TTO_LINEUP = 9          // batters in a lineup
  const TTO3_BF    = TTO_LINEUP * 2  // BF threshold where TTO3 begins (18)
  const TTO3_DECAY = 0.85        // K rate multiplier in TTO3+ (unified with live model)
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
    pK_formula: pK_blended_formula, ml_pK,
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
    if (res.status === 401 || res.status === 403) {
      console.error(`[edge] Kalshi auth failed (${res.status}) — check KALSHI_KEY_ID / key file. No markets will be priced.`)
      return []
    }
    if (res.status >= 400) {
      console.warn(`[edge] Kalshi API error for ${eventTicker}: HTTP ${res.status}`)
      return []
    }
    return res.data?.markets || []
  } catch (err) {
    console.warn(`[edge] fetchKsMarkets(${eventTicker}) error: ${err.message}`)
    return []
  }
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

// ── Pitcher calibration scale loader ─────────────────────────────────────────
// Loads per-pitcher reliability from the most recent calibration run.
// reliability = actual_roi / expected_roi — values > 1 mean the model
// under-estimated this pitcher; < 1 means it over-estimated. Requires ≥10 bets.
// Clamped to [0.5, 1.5] to prevent extreme sizing swings on noisy small samples.

async function loadPitcherCalibration() {
  try {
    const rows = await db.all(
      `SELECT pitcher_id, reliability FROM pitcher_calibration
       WHERE n_bets >= 10
         AND run_id = (SELECT run_id FROM pitcher_calibration ORDER BY updated_at DESC LIMIT 1)`,
    )
    if (rows.length) {
      console.log(`[ks-edge] Loaded calibration scales for ${rows.length} pitchers`)
    }
    return new Map(rows.map(r => [String(r.pitcher_id), Math.max(0.5, Math.min(1.5, Number(r.reliability)))]))
  } catch {
    return new Map()
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  await db.migrate()

  const season = new Date(TODAY).getFullYear()

  const [games, statcastMap, careerMap, recentStartsMap, lineupsCache, careerVeloMap, pitcherCalMap] = await Promise.all([
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
    loadPitcherCalibration(),
  ])

  if (!games.length) {
    console.log(`[ks-edge] No games found for ${TODAY}`)
    await db.close()
    return
  }

  // ── Sync game_pulse lineup flags from confirmed lineup data ───────────────
  // When we have lineup_json, the lineup is officially posted — mark game_pulse.
  // This is how strikeoutEdge feeds into the intelligence layer (gamePulse).
  for (const game of games) {
    const gamePk = String(game.id)
    const homeKey = `${game.id}-${game.team_home}-`
    const awayKey = `${game.id}-${game.team_away}-`
    const homePosted = [...lineupsCache.keys()].some(k => k.startsWith(homeKey))
    const awayPosted = [...lineupsCache.keys()].some(k => k.startsWith(awayKey))
    if (homePosted || awayPosted) {
      await db.run(
        `UPDATE game_pulse
         SET home_lineup_posted = CASE WHEN ? THEN 1 ELSE home_lineup_posted END,
             away_lineup_posted = CASE WHEN ? THEN 1 ELSE away_lineup_posted END,
             last_updated       = ?
         WHERE game_pk = ? AND bet_date = ?`,
        [homePosted ? 1 : 0, awayPosted ? 1 : 0, Date.now(), gamePk, TODAY],
      ).catch(() => {})
    }
  }

  // ── Bankroll + drawdown state ──────────────────────────────────────────────
  // availablePool feeds Kelly sizing — uses committed-adjusted pool so morning bets
  // reduce afternoon bet sizes proportionally. Falls back to env var on error.
  const availablePool = await getAvailablePool(TODAY).catch(() => null)
  // drawdownScale reduces bet sizes when 7-day P&L is in a losing streak.
  const ddFlagRow = await db.one(`SELECT value FROM system_flags WHERE key='drawdown_scale'`).catch(() => null)
  const drawdownScale = Math.max(0.1, Math.min(1.0, Number(ddFlagRow?.value ?? 1.0)))
  if (availablePool != null) {
    console.log(`[ks-edge] Kelly base: available_pool=$${availablePool.toFixed(2)}  drawdown_scale=${drawdownScale}×`)
  }

  // ── DK line direction — confidence modifier from game_pulse ──────────────
  // Rising line (+1): sharp money agrees with our model → +5% edge confidence
  // Falling line (-1): market correcting against our edge → -10% edge confidence
  const dkDirectionMap = new Map()  // String(pitcherId) → direction (+1/-1/0)
  try {
    const pulseRows = await db.all(
      `SELECT home_pitcher_id, away_pitcher_id, dk_home_direction, dk_away_direction
       FROM game_pulse WHERE bet_date=?`,
      [TODAY],
    )
    for (const r of pulseRows) {
      if (r.home_pitcher_id && r.dk_home_direction != null) {
        dkDirectionMap.set(String(r.home_pitcher_id), r.dk_home_direction)
      }
      if (r.away_pitcher_id && r.dk_away_direction != null) {
        dkDirectionMap.set(String(r.away_pitcher_id), r.dk_away_direction)
      }
    }
    if (dkDirectionMap.size > 0) {
      console.log(`[ks-edge] DK line directions loaded: ${dkDirectionMap.size} pitchers`)
    }
  } catch {}

  // Apr 28 — apply betting_rules DB tunings to pre-game gates. Hardcoded constants
  // remain as fallbacks. Adam tuned the DB but pre-game pipeline never read them.
  const _R = await getRules().catch(() => ({}))
  const EFF_YES_MIN_PROB    = Number(_R.yes_pregame_min_prob ?? YES_MIN_PROB)
  const EFF_YES_MAX_MID     = _R.yes_pregame_max_mid != null ? Number(_R.yes_pregame_max_mid) : null
  const EFF_NO_MIN_EDGE     = Number(_R.no_min_edge ?? NO_MIN_EDGE)
  const EFF_NO_MAX_MARK_MID = _R.no_max_market_mid != null ? Number(_R.no_max_market_mid) : null
  const EFF_YES_MAX_STRIKE  = _R.yes_max_strike != null ? Number(_R.yes_max_strike) : null
  const EFF_NO_MAX_STRIKE   = _R.no_max_strike  != null ? Number(_R.no_max_strike)  : null
  // Apr 28 — tail-strike protection. For high-K thresholds (>=8) the model has more
  // uncertainty (Cease scenario: 80%-confident on 8+/9+/10+, actual 5K → −$50).
  // Require a stricter min_prob on tail strikes than the base gate.
  const TAIL_STRIKE_MIN     = 8
  const TAIL_STRIKE_MIN_PROB = 0.55
  console.log(`[ks-edge] ${games.length} games on ${TODAY} | NB r=${NB_R} | min edge ${(MIN_EDGE*100).toFixed(0)}¢ (floor=${(MIN_EDGE_FLOOR*100).toFixed(0)}¢+spread/2)`)
  console.log(`[ks-edge] effective rules: YES min_prob=${EFF_YES_MIN_PROB} max_mid=${EFF_YES_MAX_MID ?? 'off'}¢ max_strike=${EFF_YES_MAX_STRIKE ?? 'off'} | NO min_edge=${EFF_NO_MIN_EDGE} max_mid=${EFF_NO_MAX_MARK_MID ?? 'off'}¢ max_strike=${EFF_NO_MAX_STRIKE ?? 'off'} | tail (strike≥${TAIL_STRIKE_MIN}) min_prob=${TAIL_STRIKE_MIN_PROB}`)
  console.log()

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
      // Capped at ±12% to allow legitimate extreme platoon pitchers (e.g. LOOGY arms,
      // extreme same-side dominance) to be reflected while still bounding noisy small samples.
      let splitAdj = 1.0
      let splitNote = ''
      if (savant?.k_pct_vs_l != null && savant?.k_pct_vs_r != null && (savant.k_pct ?? 0) > 0.01) {
        const LHB_PCT = 0.40  // MLB default; refined when confirmed lineups are available
        const splitK  = LHB_PCT * savant.k_pct_vs_l + (1 - LHB_PCT) * savant.k_pct_vs_r
        const raw     = splitK / savant.k_pct
        splitAdj = Math.max(0.88, Math.min(1.12, raw))
        if (Math.abs(splitAdj - 1.0) > 0.015) {
          splitNote = ` | splitK×${splitAdj.toFixed(2)}(vsL=${(savant.k_pct_vs_l*100).toFixed(1)}%,vsR=${(savant.k_pct_vs_r*100).toFixed(1)}%)`
        }
      } else if (savant) {
        console.warn(`  [edge] ⚠ ${meta.name}: no Savant L/R splits — platoon adjustment skipped (blended K% used)`)
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

      // Resolve Kalshi market group here so lambda_calc can log n_markets without TDZ
      const kalshiTeam = toKalshiAbbr(team)
      let group = null
      for (const [key, g] of pitcherGroups) {
        if (key.startsWith(kalshiTeam)) { group = g; break }
      }

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
      // Apr 29 — capture every evaluated market into market_snapshots so we have
      // queryable backtest data going forward (was previously only the live engine).
      // Filtered AND placed bets both get rows; eval_mode='pre-game'.
      const _preGameSnapshots = []

      for (const mkt of group.markets) {
        // Archetype-driven NB dispersion: power/contact/mixed pitchers have different tail shapes.
        // archetypeR() prefers a fitted nb_r from fitDispersion.js, then groups by k_pct.
        const pitcherNbR   = archetypeR(savant)
        const rawModelProb = Math.max(0, 1 - nbCDF(lambda, pitcherNbR, mkt.strike - 1))
        const mid    = mkt.yes_ask != null && mkt.yes_bid != null ? (mkt.yes_ask + mkt.yes_bid) / 2 : null
        const spread = mkt.yes_ask != null && mkt.yes_bid != null ? mkt.yes_ask - mkt.yes_bid : null

        // ── Full-distribution shadow audit ──────────────────────────────────
        // Capture EVERY (pitcher, strike, side) pair the model can score, even
        // ones production filters will later reject. Lets us audit "what NO
        // bets at high strikes were blocked despite positive calibrated edge?"
        // Fire-and-forget — never block production on shadow write.
        try {
          const { recordFullDistribution } = await import('../../lib/shadowInversion.js')
          for (const _shadowSide of ['YES', 'NO']) {
            let allowed = true, reason = null
            if (_shadowSide === 'YES') {
              if (EFF_YES_MAX_STRIKE != null && mkt.strike > EFF_YES_MAX_STRIKE) { allowed = false; reason = `yes_max_strike=${EFF_YES_MAX_STRIKE}` }
              else if (EFF_YES_MAX_MID != null && mid != null && mid > EFF_YES_MAX_MID) { allowed = false; reason = `yes_max_mid=${EFF_YES_MAX_MID}` }
              else if (rawModelProb < EFF_YES_MIN_PROB) { allowed = false; reason = `yes_min_prob=${EFF_YES_MIN_PROB}` }
            } else {
              if (EFF_NO_MAX_STRIKE != null && mkt.strike > EFF_NO_MAX_STRIKE) { allowed = false; reason = `no_max_strike=${EFF_NO_MAX_STRIKE}` }
              else if (EFF_NO_MAX_MARK_MID != null && mid != null && mid > EFF_NO_MAX_MARK_MID) { allowed = false; reason = `no_max_market_mid=${EFF_NO_MAX_MARK_MID}` }
            }
            await recordFullDistribution({
              betDate:      TODAY,
              pitcherId:    meta?.id ?? null,
              pitcherName:  meta?.name ?? '(unknown)',
              strike:       mkt.strike,
              side:         _shadowSide,
              ticker:       mkt.ticker ?? null,
              lambda,
              pitcherNbR,
              rawModelProb,
              yesBid:       mkt.yes_bid ?? null,
              yesAsk:       mkt.yes_ask ?? null,
              noBid:        mkt.no_bid  ?? null,
              noAsk:        mkt.no_ask  ?? null,
              marketMid:    mid,
              spread,
              productionAllowed: allowed,
              productionFilterReason: reason,
            }).catch(() => {})
          }
        } catch { /* shadow optional */ }

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
        // Apr 28 — effective values come from betting_rules table when present (was
        // hardcoded only). Strict-side rule wins via Math.max so we never RELAX.
        const sideMinEdge   = edge.side === 'YES' ? YES_MIN_EDGE : Math.max(NO_MIN_EDGE, EFF_NO_MIN_EDGE)
        // Tail-strike gate: stricter prob threshold on high-K bets (strike >= 8).
        const effYesMinProb = edge.side === 'YES' && mkt.strike >= TAIL_STRIKE_MIN
                              ? Math.max(YES_MIN_PROB, EFF_YES_MIN_PROB, TAIL_STRIKE_MIN_PROB)
                              : Math.max(YES_MIN_PROB, EFF_YES_MIN_PROB)
        const yesFiltered   = edge.side === 'YES' && modelProb < effYesMinProb
        const yesMidFilt    = edge.side === 'YES' && EFF_YES_MAX_MID != null && mid != null && mid > EFF_YES_MAX_MID
        const noMidFilt     = edge.side === 'NO'  && EFF_NO_MAX_MARK_MID != null && mid != null && mid > EFF_NO_MAX_MARK_MID
        const yesStrikeFilt = edge.side === 'YES' && EFF_YES_MAX_STRIKE != null && mkt.strike > EFF_YES_MAX_STRIKE
        const noStrikeFilt  = edge.side === 'NO'  && EFF_NO_MAX_STRIKE  != null && mkt.strike > EFF_NO_MAX_STRIKE
        const ruleFiltered  = yesMidFilt || noMidFilt || yesStrikeFilt || noStrikeFilt
        const hasEdge       = !isLocked && !noCapKills && !tooThin && !yesFiltered && !ruleFiltered
                              && edge.bestEdge >= Math.max(edgeThreshold, sideMinEdge)
        const hasRawEdge    = !isLocked && !hasEdge && (noCapKills || tooThin || yesFiltered || ruleFiltered || edge.bestEdge >= MIN_EDGE)

        const _ruleTag = yesMidFilt ? ` [YES-mid>${EFF_YES_MAX_MID}¢]`
                       : noMidFilt  ? ` [NO-yes-mid>${EFF_NO_MAX_MARK_MID}¢]`
                       : yesStrikeFilt ? ` [YES-strike>${EFF_YES_MAX_STRIKE}]`
                       : noStrikeFilt  ? ` [NO-strike>${EFF_NO_MAX_STRIKE}]`
                       : ''
        console.log(
          `    ${mkt.strike}+ Ks: model=${(modelProb*100).toFixed(1)}%` +
          ` | mid=${mid != null ? mid.toFixed(0)+'¢' : 'n/a'}` +
          ` | spread=${spread != null ? spread+'¢' : 'n/a'}` +
          ` | edge(${edge.side})=${(edge.bestEdge*100).toFixed(1)}¢` +
          ` | thr=${(edgeThreshold*100).toFixed(1)}¢` +
          ` | vol=${mkt.volume != null ? Math.round(mkt.volume) : 'n/a'}` +
          (isLocked ? ' [locked]' : hasEdge ? ' ← EDGE' : noCapKills ? ' [NO-cap>80¢]' : tooThin ? ' [thin<10]' : yesFiltered ? ` [YES-prob<${(Math.max(YES_MIN_PROB, EFF_YES_MIN_PROB)*100).toFixed(0)}%]` : ruleFiltered ? _ruleTag : hasRawEdge ? ' [spread-kills-edge]' : '')
        )

        const _rejectReason = isLocked ? 'locked'
                            : noCapKills ? 'no_cap_gt_80'
                            : tooThin ? 'thin_lt_10vol'
                            : yesFiltered ? 'yes_low_prob'
                            : ruleFiltered ? (yesMidFilt ? 'yes_mid_cap' : noMidFilt ? 'no_mid_cap' : yesStrikeFilt ? 'yes_strike_cap' : 'no_strike_cap')
                            : !hasEdge ? 'below_threshold'
                            : null

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
          reason: _rejectReason,
          ticker: mkt.ticker,
        })

        // Persist every pre-game evaluation to market_snapshots so we can backtest
        // counterfactually. Same table the live engine writes to — eval_mode='pre-game'
        // distinguishes them. Captures: filtered AND placed, with reject reason.
        try {
          _preGameSnapshots.push(buildSnapshotRow({
            ticker:       mkt.ticker,
            pitcherId:    String(id),
            pitcherName:  meta.name,
            strike:       mkt.strike,
            gameDate:     TODAY,
            capturedAt:   new Date().toISOString(),
            gameId:       game.id,
            gameLabel:    label,
            yesBidCents:  mkt.yes_bid,
            yesAskCents:  mkt.yes_ask,
            midCents:     mid,
            volume:       mkt.volume,
            yesAskSize:   mkt.yes_ask_size ?? mkt.yes_ask_size_fp ?? (mkt.raw_market?.yes_ask_size_fp ? parseFloat(mkt.raw_market.yes_ask_size_fp) : null),
            yesBidSize:   mkt.yes_bid_size ?? mkt.yes_bid_size_fp ?? (mkt.raw_market?.yes_bid_size_fp ? parseFloat(mkt.raw_market.yes_bid_size_fp) : null),
            modelProb,
            edgeYes:      edge.yesEdge,
            edgeNo:       edge.noEdge,
            bestSide:     edge.side,
            bestEdge:     edge.bestEdge,
            evalMode:     'pre-game',
            qualified:    hasEdge,
            rejectReason: _rejectReason,
          }))
        } catch { /* fire-and-forget */ }

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
        // Pass available_pool so Kelly sizes against the real committed-adjusted bankroll,
        // not the static BANKROLL env var. Falls back to env var when pool unavailable.
        const kellyResults = correlatedKellyDivide(kellyInputs, true, availablePool ?? undefined)

        // Per-pitcher calibration scale: multiply bet size by historical reliability.
        // A pitcher the model consistently over-estimates gets smaller bets; one it
        // under-estimates gets larger bets (clamped to [0.5×, 1.5×]).
        const pitcherCalScale = pitcherCalMap.get(String(id)) ?? 1.0

        // DK line direction modifier: market consensus signal.
        // Rising line (+1) = confidence +5%; falling (-1) = discount -10%.
        const dkDir     = dkDirectionMap.get(String(id)) ?? 0
        const dkDirMult = dkDir > 0 ? 1.05 : dkDir < 0 ? 0.90 : 1.0
        if (dkDir !== 0) {
          console.log(`    [dk-dir] ${meta.name}: line direction=${dkDir > 0 ? 'rising↑' : 'falling↓'} → ${(dkDirMult * 100).toFixed(0)}% size modifier`)
        }

        for (let i = 0; i < pitcherEdgesThisGame.length; i++) {
          const e = pitcherEdgesThisGame[i]
          const k = kellyResults[i]
          const rawBet  = k?.betSize ?? null
          // Apply: calibration × drawdown protection × DK line direction
          const calBet  = rawBet != null
            ? Math.min(Number(process.env.MAX_BET ?? 500), rawBet * pitcherCalScale * drawdownScale * dkDirMult)
            : null
          if ((pitcherCalScale !== 1.0 || drawdownScale < 1.0 || dkDir !== 0) && rawBet != null) {
            console.log(`    [size] ${meta.name}: raw=$${rawBet.toFixed(0)} cal=${pitcherCalScale.toFixed(2)}x dd=${drawdownScale}x dk=${dkDirMult}x → $${(calBet ?? 0).toFixed(0)}`)
          }
          allEdges.push({
            ...e,
            bet_size:              calBet,
            kelly_fraction:        k?.kellyFraction ?? null,
            kelly_scale:           k?.scaleFactor ?? null,
            kelly_scale_pitcher:   pitcherCalScale,
            kelly_rationale:       k?.rationale ?? null,
            raw_model_prob:        e.rawModelProb ?? null,
          })
        }
      }

      // ── Persist pre-game snapshots for backtest queryability ──────────────
      // Captures every evaluated market (filtered + placed). eval_mode='pre-game'.
      // Same table/schema as live snapshots so backtest queries are uniform.
      if (_preGameSnapshots.length) {
        writeSnapshotBatch(_preGameSnapshots).catch(() => {})
      }

      // ── Cross-strike candidate generation (Strategy B) ────────────────────
      // For this pitcher, fit a Poisson distribution to the market prices
      // across all strikes. Strikes that deviate from the fit by > threshold
      // are mispriced. Emit them as candidates with strategy_mode='pregame_cross_strike'.
      // Math-based (not model-based), validated by 78% win rate POC on 2026-05-05.
      try {
        const { generateCrossStrikeCandidates } = await import('../../lib/crossStrikeCandidates.js')
        const pitcherMarkets = group.markets.map(m => ({
          strike: m.strike, ticker: m.ticker,
          yes_bid: m.yes_bid, yes_ask: m.yes_ask,
          no_bid: m.no_bid, no_ask: m.no_ask,
          market_mid: m.yes_ask != null && m.yes_bid != null ? (m.yes_ask + m.yes_bid) / 2 : null,
        }))
        const csCandidates = generateCrossStrikeCandidates(pitcherMarkets, {
          minResidual: Number(_R.cross_strike_min_residual ?? 0.04),
          maxResidual: Number(_R.cross_strike_max_residual ?? 0.20),
          maxPerPitcher: Number(_R.cross_strike_max_per_pitcher ?? 2),
        })
        if (csCandidates.length > 0) {
          console.log(`  [cross-strike] ${meta?.name ?? 'pitcher'}: ${csCandidates.length} mispriced strikes (λ-fit=${csCandidates[0].cross_strike_fit_lambda.toFixed(2)})`)
          for (const c of csCandidates) {
            const market_mid = c.market_mid ?? 50
            const _fill = (c.askCents) / 100
            allEdges.push({
              pitcher_id:     id,
              pitcher:        meta?.name,
              team:           team,
              game:           _gameLabel,
              strike:         c.strike,
              side:           c.side,
              ticker:         c.ticker,
              market_mid,
              spread:         (c.yesAsk ?? 50) - (c.yesBid ?? 50),
              // Kelly needs our believed probability (the fit), not market's.
              // For YES side: edge = fit - market_yes_ask. For NO: edge = (1-fit) - no_ask.
              // strategy_mode='pregame_cross_strike' tells downstream this is fit-based.
              model_prob:     c.cross_strike_fit_prob,
              raw_model_prob: c.cross_strike_fit_prob,
              edge:           Math.abs(c.cross_strike_residual),
              best_edge:      Math.abs(c.cross_strike_residual),
              _edgeVal:       Math.abs(c.cross_strike_residual),
              lambda,         // pitcher's lambda from main model (for audit)
              k9_career:      k9_career,
              k9_season:      k9_season,
              k9_l5:          k9_l5,
              opp_k_pct:      oppKpct,
              n_starts:       nStarts,
              confidence:     c.cross_strike_fit_quality === 'good' ? 'high' : c.cross_strike_fit_quality === 'ok' ? 'med' : 'low',
              strategy_mode:  c.strategy_mode,
              strategy_submode: c.strategy_submode,
              cross_strike_residual:    c.cross_strike_residual,
              cross_strike_market_prob: c.cross_strike_market_prob,
              cross_strike_fit_prob:    c.cross_strike_fit_prob,
              cross_strike_fit_lambda:  c.cross_strike_fit_lambda,
              cross_strike_fit_sse:     c.cross_strike_fit_sse,
              cross_strike_fit_quality: c.cross_strike_fit_quality,
              _fill,
              _ask_cents: c.askCents,
              // Defaults to satisfy downstream summary rendering (avoids toFixed-on-undefined)
              adj_factor:     1,
              raw_adj_factor: 1,
              park_factor:    1,
              weather_mult:   1,
              ump_factor:     1,
              ump_name:       null,
              velo_adj:       1,
              velo_trend_mph: null,
              savant_k_pct:   null,
              savant_whiff:   null,
              savant_fbv:     null,
              whiff_flag:     null,
              bb_penalty:     1,
            })
          }
        }
      } catch (csErr) {
        console.warn(`  [cross-strike] error for ${meta?.name}: ${csErr.message}`)
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

      // ── Write pitcher_edge_cache (freshness gate for ksBets.js) ──────────
      // ksBets checks edge_computed_at; if < 180s old it skips recomputation,
      // preventing double-edge-compute on the lineup_posted event trigger path.
      await db.run(
        `INSERT OR REPLACE INTO pitcher_edge_cache (pitcher_id, bet_date, edge_computed_at, trigger_source, edges_json)
         VALUES (?, ?, ?, ?, ?)`,
        [String(id), TODAY, new Date().toISOString(), opts.triggerSource ?? 'morning', JSON.stringify(_pipelineEdges)],
      ).catch(() => {})

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

// Run main() only when this file is invoked directly, not when imported.
// (The Layer 1 parity harness imports harvestLayer1MathFixture below; we
// don't want the production main loop firing during fixture harvesting.)
const __isDirectInvoke = import.meta.url === `file://${process.argv[1]}`
if (__isDirectInvoke) {
  main().catch(err => {
    console.error('[ks-edge] fatal:', err.message)
    process.exit(1)
  })
}

// ─────────────────────────────────────────────────────────────────────────
// Layer 1 Math extraction-only export.
//
// `computeLambdaBase` is the production calibrated lambda computation. It is
// called by the production main loop AND by the Oracle Layer 1 module
// (`oracle/layers/1-math/impl.js`), which composes a clean Layer 1 API around
// it without rewriting the math.
//
// Do NOT change `computeLambdaBase` without updating Layer 1 parity fixtures
// in `oracle/layers/1-math/parity-fixtures.json`.
// ─────────────────────────────────────────────────────────────────────────
export { computeLambdaBase }

// ─────────────────────────────────────────────────────────────────────────
// Layer 1 Math parity-harness helper.
//
// This is NOT production betting logic. It exists only so the Oracle Layer 1
// extraction harness can load the same production inputs and call the same
// production lambda computation without duplicating loader logic.
//
// Do not modify this helper to change betting behavior.
// Do not use this helper in live order placement.
//
// Limitations (recorded in fixture metadata for future reference):
//   - fetchGameLog(pitcherId) hits the live MLB API and returns CURRENT
//     season-to-date data, not historical as-of bet_date. Parity fixtures
//     therefore capture a SNAPSHOT of inputs+outputs at fixture-build time,
//     not a true historical replay. For real historical replay, raw inputs
//     would need to be persisted at decision time (a v1.1 enhancement).
//   - loadStatcastData / loadCareerData / loadRecentStarts / loadCareerVelo
//     are module-level caches. Subsequent calls within the same process
//     reuse cached state.
// ─────────────────────────────────────────────────────────────────────────
export async function harvestLayer1MathFixture({ pitcher_id, bet_date }) {
  if (!pitcher_id) throw new Error('harvestLayer1MathFixture: pitcher_id required')
  if (!bet_date)   throw new Error('harvestLayer1MathFixture: bet_date required (YYYY-MM-DD)')

  const pid    = String(pitcher_id)
  const season = Number(bet_date.slice(0, 4)) || new Date().getFullYear()

  // Same loaders the production main loop uses.
  const statcastMap     = await loadStatcastData(season)
  const careerMap       = await loadCareerData()
  const log             = await fetchGameLog(pid)
  const recentStartsMap = await loadRecentStarts(season)
  const careerVeloMap   = await loadCareerVelo()

  const savant            = statcastMap.get(pid) ?? null
  const career            = careerMap.get(pid) ?? null
  const recentStartsData  = recentStartsMap.get(pid) ?? []
  const careerAvgFbVelo   = careerVeloMap.get(pid) ?? null

  const result = computeLambdaBase(
    log, bet_date, savant, career, recentStartsData, careerAvgFbVelo,
  )

  return {
    inputs: { log, gameDate: bet_date, savant, career, recentStartsData, careerAvgFbVelo },
    result,
    snapshot_taken_at: new Date().toISOString(),
  }
}
