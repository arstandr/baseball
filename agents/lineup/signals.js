// agents/lineup/signals.js — XGBoost feature computation for a team lineup
// vs the opposing starter's handedness.

import { fetchTeamOffense } from '../../lib/fangraphs.js'

export const LEAGUE_AVG_OFFENSE = {
  wrc_plus: 100,
  k_pct: 0.22,
  iso: 0.155,
  hard_pct: 0.36,
  runs_pg: 4.5,          // full-game runs per game (was f5_runs_pg 2.1)
  lob_pct: 0.72,         // league-average left-on-base %
  top6_ops: 0.740,
}

const _cache = new Map() // key: `${season}:${hand}`

async function getTeamTable(season, hand) {
  const key = `${season}:${hand}`
  if (_cache.has(key)) return _cache.get(key)
  const data = await fetchTeamOffense(season, hand)
  _cache.set(key, data)
  return data
}

/**
 * Compute offensive features for a team vs opposing pitcher handedness.
 * Fallback to league-average if team data is missing.
 */
export async function computeLineupSignals({ team, vsHand, season, scheduleFatigue, homeAway }) {
  const [table14, table30] = await Promise.all([
    getTeamTable(season, vsHand),
    // 30-day split not exposed on the same endpoint; Fangraphs doesn't have
    // a clean 30d handed split, so we use season-wide as the 30d proxy. This
    // is the same strategy BetTracker uses for similar data.
    getTeamTable(season, vsHand),
  ])
  const t = table14?.[team.toUpperCase()] || null
  const wrc14 = t?.wrc_plus ?? LEAGUE_AVG_OFFENSE.wrc_plus
  const wrc30 = table30?.[team.toUpperCase()]?.wrc_plus ?? wrc14
  const k14 = t?.k_pct ?? LEAGUE_AVG_OFFENSE.k_pct
  const iso = t?.iso ?? LEAGUE_AVG_OFFENSE.iso
  const hardPct = t?.hard_pct ?? LEAGUE_AVG_OFFENSE.hard_pct

  return {
    team,
    vs_handedness: vsHand,
    wrc_plus_14d: round1(wrc14),
    wrc_plus_30d: round1(wrc30),
    k_pct_14d: round4(k14),
    hard_contact_14d: round4(hardPct),
    iso_14d: round4(iso),
    runs_pg_14d: LEAGUE_AVG_OFFENSE.runs_pg, // placeholder — recomputed from outcomes table
    lob_pct_14d: t?.lob_pct ?? LEAGUE_AVG_OFFENSE.lob_pct,
    top6_weighted_ops: LEAGUE_AVG_OFFENSE.top6_ops, // filled in by the orchestrator once confirmed lineup arrives
    schedule_fatigue: scheduleFatigue ?? 0,
    home_away_split: homeAway === 'home' ? 1 : 0,
    confidence: t ? 0.85 : 0.4,
  }
}

/**
 * Recompute full-game runs-per-game over the last 14 days from our own outcomes
 * table. Before any outcomes exist, falls back to league average.
 */
export async function runsPerGame14d({ team, gameDate, db }) {
  if (!db) return LEAGUE_AVG_OFFENSE.runs_pg
  const cutoff = new Date(new Date(gameDate).getTime() - 14 * 24 * 3600 * 1000)
    .toISOString()
    .slice(0, 10)
  const rows = await db.all(
    `SELECT g.actual_runs_home, g.actual_runs_away, g.team_home, g.team_away
     FROM games g
     WHERE g.date BETWEEN ? AND ?
       AND (g.team_home = ? OR g.team_away = ?)
       AND g.actual_runs_total IS NOT NULL`,
    [cutoff, gameDate, team, team],
  )
  if (!rows.length) return LEAGUE_AVG_OFFENSE.runs_pg
  const runs = rows
    .map(r => (r.team_home === team ? r.actual_runs_home : r.actual_runs_away))
    .filter(v => v != null)
  if (!runs.length) return LEAGUE_AVG_OFFENSE.runs_pg
  return Number((runs.reduce((a, b) => a + b, 0) / runs.length).toFixed(2))
}

// Back-compat alias (some callers may still reference the old name)
export const f5RunsPerGame14d = runsPerGame14d

/**
 * Weighted OPS of batters 1-6 using the confirmed lineup ordering.
 * Each hitter's OPS is weighted by their batting order's F5 PA share.
 */
export function top6WeightedOps(lineup, hitterStats) {
  if (!lineup?.length || !hitterStats) return LEAGUE_AVG_OFFENSE.top6_ops
  // Approximate PA share across the first 5 innings by batting order position:
  // leadoff sees ~2.7 PA, #6 sees ~2.1, #9 sees ~1.8. Normalise to sum 1.
  const paShare = [2.7, 2.6, 2.5, 2.4, 2.3, 2.1]
  const totalShare = paShare.reduce((a, b) => a + b, 0)
  let weightedSum = 0
  let weightSum = 0
  for (let i = 0; i < Math.min(6, lineup.length); i++) {
    const stats = hitterStats[lineup[i].name] || hitterStats[lineup[i].id]
    if (!stats) continue
    const ops = stats.ops ?? stats.OPS
    if (ops == null) continue
    weightedSum += ops * paShare[i]
    weightSum += paShare[i]
  }
  if (!weightSum) return LEAGUE_AVG_OFFENSE.top6_ops
  return Number((weightedSum / weightSum).toFixed(3))
}

function round1(v) {
  if (v == null) return null
  return Number(Number(v).toFixed(1))
}
function round4(v) {
  if (v == null) return null
  return Number(Number(v).toFixed(4))
}
