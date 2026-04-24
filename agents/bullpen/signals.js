// agents/bullpen/signals.js — bullpen feature computation per team.
//
// Data source: MLB Stats API team roster + per-pitcher gameLog. We identify
// relief pitchers (role != 'SP' OR 0 starts in the window) and aggregate
// their last-14-day innings. Fangraphs team-pitching-splits (Starters vs
// Relievers) is the fallback when the Stats API data is thin.
//
// Returns per-team:
//   era_14d, whip_14d, k_pct_14d, hr_per_9_14d, inherited_score_pct,
//   quality_score, confidence

import { fetch } from '../../lib/http.js'

const MLB_BASE = 'https://statsapi.mlb.com/api/v1'

export const LEAGUE_AVG_BULLPEN = {
  era_14d: 4.20,
  whip_14d: 1.30,
  k_pct_14d: 0.24,
  hr_per_9_14d: 1.15,
  inherited_score_pct: 0.33,
}

// Cache roster + gamelogs per season so we don't refetch per team
const _rosterCache = new Map() // key: teamId:season
const _pitcherLogCache = new Map() // key: pitcherId:season

/**
 * Fetch a team's active roster for a given season. Returns an array of
 * { person_id, position, is_pitcher }.
 */
async function fetchTeamRoster(teamId, season) {
  const key = `${teamId}:${season}`
  if (_rosterCache.has(key)) return _rosterCache.get(key)
  const res = await fetch('mlbapi.roster', {
    method: 'GET',
    url: `${MLB_BASE}/teams/${teamId}/roster`,
    params: { season, rosterType: 'active' },
  })
  if (!res.ok) {
    _rosterCache.set(key, [])
    return []
  }
  const roster = (res.data?.roster || []).map(r => ({
    person_id: String(r.person?.id ?? ''),
    person_name: r.person?.fullName,
    position: r.position?.abbreviation,
    is_pitcher: (r.position?.abbreviation || '').toUpperCase() === 'P',
  }))
  _rosterCache.set(key, roster)
  return roster
}

/**
 * Pull a pitcher's gameLog for the season. Cached per-pitcher.
 */
async function fetchPitcherGameLog(pitcherId, season) {
  const key = `${pitcherId}:${season}`
  if (_pitcherLogCache.has(key)) return _pitcherLogCache.get(key)
  const res = await fetch('mlbapi.pitcher_gamelog_bullpen', {
    method: 'GET',
    url: `${MLB_BASE}/people/${pitcherId}/stats`,
    params: {
      stats: 'gameLog',
      group: 'pitching',
      season,
      sportId: 1,
    },
  })
  if (!res.ok) {
    _pitcherLogCache.set(key, [])
    return []
  }
  const splits = res.data.stats?.[0]?.splits || []
  const rows = splits.map(s => ({
    date: s.date,
    started: s.stat?.gamesStarted === 1 || Number(s.stat?.gamesStarted) === 1,
    innings: Number(s.stat?.inningsPitched || 0),
    earned_runs: Number(s.stat?.earnedRuns || 0),
    hits: Number(s.stat?.hits || 0),
    walks: Number(s.stat?.baseOnBalls || 0),
    strikeouts: Number(s.stat?.strikeOuts || 0),
    home_runs: Number(s.stat?.homeRuns || 0),
    batters_faced: Number(s.stat?.battersFaced || 0),
    inherited_runners: Number(s.stat?.inheritedRunners || 0),
    inherited_scored: Number(s.stat?.inheritedRunnersScored || 0),
  }))
  _pitcherLogCache.set(key, rows)
  return rows
}

/**
 * Compute rolling 14-day bullpen stats for a team up to (but not including)
 * gameDate.
 */
export async function computeBullpenSignals({ teamId, gameDate, season }) {
  if (!teamId) return null
  const roster = await fetchTeamRoster(teamId, season)
  const pitchers = roster.filter(p => p.is_pitcher)
  if (!pitchers.length) {
    return {
      team_id: String(teamId),
      ...LEAGUE_AVG_BULLPEN,
      confidence: 0.2,
      _fallback: 'no_roster',
    }
  }

  const cutoff = new Date(gameDate).getTime()
  const windowStart = cutoff - 14 * 24 * 3600 * 1000

  // Aggregate relief appearances across all pitchers on the roster
  let innings = 0
  let er = 0
  let hits = 0
  let walks = 0
  let k = 0
  let hr = 0
  let inheritedRunners = 0
  let inheritedScored = 0
  let reliefAppearances = 0

  for (const p of pitchers) {
    const log = await fetchPitcherGameLog(p.person_id, season)
    for (const r of log) {
      const t = new Date(r.date).getTime()
      if (!t || t < windowStart || t >= cutoff) continue
      // Skip starts — bullpen only
      if (r.started) continue
      reliefAppearances++
      innings += r.innings
      er += r.earned_runs
      hits += r.hits
      walks += r.walks
      k += r.strikeouts
      hr += r.home_runs
      inheritedRunners += r.inherited_runners
      inheritedScored += r.inherited_scored
    }
  }

  if (innings < 1) {
    return {
      team_id: String(teamId),
      ...LEAGUE_AVG_BULLPEN,
      confidence: 0.3,
      _fallback: 'no_relief_innings',
    }
  }

  const bf = Math.max(1, hits + walks + k + (innings * 3 - k)) // rough estimate if batters_faced missing
  const era_14d = Number(((er / innings) * 9).toFixed(2))
  const whip_14d = Number(((hits + walks) / innings).toFixed(3))
  const k_pct_14d = Number((k / bf).toFixed(4))
  const hr_per_9_14d = Number(((hr / innings) * 9).toFixed(3))
  const inherited_score_pct =
    inheritedRunners > 0
      ? Number((inheritedScored / inheritedRunners).toFixed(3))
      : LEAGUE_AVG_BULLPEN.inherited_score_pct

  // quality_score: higher = BETTER bullpen (suppresses runs). Center at 3.5
  // like scout.
  const quality_score = Number(
    (
      3.5 +
      (LEAGUE_AVG_BULLPEN.era_14d - era_14d) * 0.6 +
      (LEAGUE_AVG_BULLPEN.whip_14d - whip_14d) * 2.0 +
      (k_pct_14d - LEAGUE_AVG_BULLPEN.k_pct_14d) * 5.0 +
      (LEAGUE_AVG_BULLPEN.hr_per_9_14d - hr_per_9_14d) * 0.8
    ).toFixed(2),
  )

  // Confidence scales with sample size
  let confidence = 0.4
  if (reliefAppearances >= 5) confidence = 0.6
  if (reliefAppearances >= 15) confidence = 0.8
  if (reliefAppearances >= 30) confidence = 0.9

  return {
    team_id: String(teamId),
    era_14d,
    whip_14d,
    k_pct_14d,
    hr_per_9_14d,
    inherited_score_pct,
    quality_score,
    confidence,
    relief_appearances: reliefAppearances,
    innings_14d: Number(innings.toFixed(1)),
  }
}

/**
 * Fetch recent bullpen workload for a team — last 2 and 3 days of reliever IP.
 *
 * High IP in last 2 days → tired bullpen → starter gets a longer leash → E[BF] ↑
 * Low IP in last 2 days  → fresh bullpen → quick hook → E[BF] ↓
 *
 * @param {string|number} teamId  - MLB team ID
 * @param {string}        date    - YYYY-MM-DD (game date, exclusive cutoff)
 * @returns {{ ip_2d, ip_3d, appearances_2d, signal: 'tired'|'fresh'|'normal' }}
 */
export async function fetchRecentBullpenWorkload(teamId, date) {
  const cutoff    = new Date(date)
  const day2Start = new Date(cutoff - 2 * 86_400_000)
  const day3Start = new Date(cutoff - 3 * 86_400_000)
  const season    = cutoff.getFullYear()

  const roster = await fetchTeamRoster(String(teamId), season)
  const pitchers = roster.filter(p => p.is_pitcher)

  let ip2d = 0, ip3d = 0, app2d = 0

  for (const p of pitchers) {
    const log = await fetchPitcherGameLog(p.person_id, season)
    for (const r of log) {
      if (r.started) continue  // starters only — bullpen only
      const t = new Date(r.date).getTime()
      if (t >= day3Start.getTime() && t < cutoff.getTime()) {
        ip3d += r.innings
        if (t >= day2Start.getTime()) {
          ip2d += r.innings
          app2d++
        }
      }
    }
  }

  ip2d = Number(ip2d.toFixed(1))
  ip3d = Number(ip3d.toFixed(1))

  // Thresholds calibrated to league average: ~5-7 IP/day for a typical bullpen
  const signal = ip2d >= 11 ? 'tired' : ip2d <= 3 ? 'fresh' : 'normal'

  return { ip_2d: ip2d, ip_3d: ip3d, appearances_2d: app2d, signal }
}
