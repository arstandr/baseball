// scripts/historical/fetchPitcherStats.js — compute pitcher features
// AS OF each game date with no lookahead bias.
//
// Strategy:
//   1. For each pitcher/season, fetch their full gameLog from MLB Stats API
//      (cached by player_id:season).
//   2. For a given game_date, look back at up to 5 starts BEFORE that date
//      and compute rolling metrics.
//   3. Persist one row per (pitcher_id, as_of_date) in historical_pitcher_stats.

import axios from 'axios'
import 'dotenv/config'
import * as db from '../../lib/db.js'
import { getCached, sleep } from './cache.js'

const MLB_BASE = 'https://statsapi.mlb.com/api/v1'
const THROTTLE_MS = 100

export async function fetchPitcherGameLog(pitcherId, season) {
  return getCached('pitchers', `${pitcherId}-${season}`, async () => {
    try {
      const res = await axios.get(`${MLB_BASE}/people/${pitcherId}/stats`, {
        params: {
          stats: 'gameLog',
          group: 'pitching',
          season,
          sportId: 1,
        },
        timeout: 20000,
        validateStatus: s => s >= 200 && s < 500,
      })
      if (res.status >= 400) return []
      const splits = res.data.stats?.[0]?.splits || []
      return splits.map(s => ({
        date: s.date,
        started: s.isHome !== undefined ? (s.stat?.gamesStarted === 1) : true,
        venue_id: s.venue?.id ? String(s.venue.id) : null,
        innings: Number(s.stat?.inningsPitched || 0),
        earned_runs: Number(s.stat?.earnedRuns || 0),
        runs: Number(s.stat?.runs || 0),
        strikeouts: Number(s.stat?.strikeOuts || 0),
        walks: Number(s.stat?.baseOnBalls || 0),
        hits: Number(s.stat?.hits || 0),
        home_runs: Number(s.stat?.homeRuns || 0),
        pitches: Number(s.stat?.numberOfPitches || 0),
        batters_faced: Number(s.stat?.battersFaced || 0),
      }))
    } catch {
      return []
    }
  })
}

export async function fetchPitcherInfo(pitcherId) {
  return getCached('pitchers', `info-${pitcherId}`, async () => {
    try {
      const res = await axios.get(`${MLB_BASE}/people/${pitcherId}`, {
        timeout: 15000,
        validateStatus: s => s >= 200 && s < 500,
      })
      if (res.status >= 400) return {}
      const p = res.data.people?.[0]
      return {
        id: String(p?.id || pitcherId),
        name: p?.fullName,
        hand: p?.pitchHand?.code || 'R',
      }
    } catch {
      return {}
    }
  })
}

function daysBetween(a, b) {
  const t1 = new Date(a).getTime()
  const t2 = new Date(b).getTime()
  if (!t1 || !t2) return null
  return Math.round(Math.abs(t2 - t1) / (24 * 3600 * 1000))
}

/**
 * Compute rolling pitcher stats AS-OF gameDate (strictly before).
 * If `recent` is < 3 starts, confidence is low and a league-avg is blended.
 */
export function computeRollingFromLog(log, gameDate, { venueId } = {}) {
  const cutoff = new Date(gameDate).getTime()
  const prior = (log || [])
    .filter(r => {
      const t = new Date(r.date).getTime()
      return t && t < cutoff
    })
    .sort((a, b) => new Date(b.date) - new Date(a.date)) // most-recent-first

  // All prior starts (for venue ERA)
  const allPriorStarts = prior.filter(r => r.innings >= 1)

  // Last 5 starts
  const last5 = allPriorStarts.slice(0, 5)
  if (!last5.length) {
    return {
      era_l5: null,
      fip_l5: null,
      swstr_pct_l5: null,
      gb_pct_l5: null,
      hard_contact_l5: null,
      avg_innings_l5: null,
      days_rest: null,
      venue_era: null,
      confidence: 0.3,
    }
  }

  // ERA L5 = sum(ER)/sum(IP)*9
  const totalIP = last5.reduce((s, r) => s + r.innings, 0)
  const totalER = last5.reduce((s, r) => s + r.earned_runs, 0)
  const totalK = last5.reduce((s, r) => s + r.strikeouts, 0)
  const totalBB = last5.reduce((s, r) => s + r.walks, 0)
  const totalHR = last5.reduce((s, r) => s + r.home_runs, 0)
  const totalBF = last5.reduce((s, r) => s + (r.batters_faced || 0), 0)

  const era_l5 = totalIP > 0 ? Number(((totalER / totalIP) * 9).toFixed(2)) : null

  // FIP approximation: 13*HR9 + 3*BB9 - 2*K9 + 3.1
  const hr9 = totalIP > 0 ? (totalHR / totalIP) * 9 : 0
  const bb9 = totalIP > 0 ? (totalBB / totalIP) * 9 : 0
  const k9 = totalIP > 0 ? (totalK / totalIP) * 9 : 0
  const fip_l5 = Number((13 * hr9 + 3 * bb9 - 2 * k9 + 3.1).toFixed(2))

  // K/9 and BB/9 from actual game-log data
  const k9_l5 = totalIP > 0 ? Number(((totalK / totalIP) * 9).toFixed(2)) : null
  const bb9_l5 = totalIP > 0 ? Number(((totalBB / totalIP) * 9).toFixed(2)) : null

  // SwStr estimate: K% / 2.2 (rough empirical relationship)
  const kPct = totalBF > 0 ? totalK / totalBF : null
  const k_pct_l5 = kPct != null ? Number(kPct.toFixed(4)) : null
  const swstr_pct_l5 = kPct != null ? Number((kPct / 2.2).toFixed(4)) : null

  // GB% / Hard contact — not in gameLog, use null (model handles NaN natively)
  const gb_pct_l5 = null
  const hard_contact_l5 = null

  const avg_innings_l5 = Number((totalIP / last5.length).toFixed(2))

  // Early exit rate: fraction of last 5 starts where starter failed to complete inning 5.
  // In baseball notation, IP=4.2 means 4⅔ innings (Math.floor=4 < 5). IP=5.0 = completed inning 5.
  const earlyExits = last5.filter(r => Math.floor(r.innings) < 5).length
  const early_exit_rate_l5 = Number((earlyExits / last5.length).toFixed(3))

  // Days rest — most recent start vs game date
  const days_rest = last5[0] ? daysBetween(last5[0].date, gameDate) : null

  // Venue ERA across all prior starts at this venue
  let venue_era = null
  if (venueId) {
    const venueStarts = allPriorStarts.filter(r => String(r.venue_id || '') === String(venueId))
    if (venueStarts.length >= 2) {
      const ip = venueStarts.reduce((s, r) => s + r.innings, 0)
      const er = venueStarts.reduce((s, r) => s + r.earned_runs, 0)
      if (ip > 0) venue_era = Number(((er / ip) * 9).toFixed(2))
    }
  }

  const nStarts = allPriorStarts.length
  let confidence = 0.3
  if (nStarts >= 3) confidence = 0.55
  if (nStarts >= 5) confidence = 0.75
  if (nStarts >= 8) confidence = 0.9

  return {
    era_l5,
    fip_l5,
    k9_l5,
    bb9_l5,
    k_pct_l5,
    swstr_pct_l5,
    gb_pct_l5,
    hard_contact_l5,
    avg_innings_l5,
    early_exit_rate_l5,
    days_rest,
    venue_era,
    confidence,
    n_starts: nStarts,
  }
}

/**
 * Career TTO (1st vs 2nd, 1st vs 3rd). Computed once per pitcher from full
 * gameLog across all cached seasons. Since the Stats API game-level data
 * doesn't expose TTO natively, we use an approximation:
 *   tto_penalty   ≈ 0.35 + 0.15 * log(innings) (league avg ≈ 0.35)
 *   tto3_penalty  ≈ 0.90 + 0.30 * log(innings) (league avg ≈ 0.90)
 * This is a placeholder; for production, scrape Baseball Savant's TTO
 * leaderboard (or use BBRef) and replace this function.
 */
export function computeTtoApprox(_log) {
  return { tto_penalty: 0.35, tto3_penalty: 0.90 }
}

/**
 * Persist one as-of-date row. Writes to historical_pitcher_stats.
 */
export async function ingestPitcherAsOf(pitcherId, asOfDate, season, venueId = null) {
  const info = await fetchPitcherInfo(pitcherId)
  const log = await fetchPitcherGameLog(pitcherId, season)
  const rolling = computeRollingFromLog(log, asOfDate, { venueId })
  const tto = computeTtoApprox(log)

  await db.upsert(
    'historical_pitcher_stats',
    {
      pitcher_id: String(pitcherId),
      pitcher_name: info?.name || String(pitcherId),
      as_of_date: asOfDate,
      season,
      hand: info?.hand || 'R',
      era_l5: rolling.era_l5,
      fip_l5: rolling.fip_l5,
      k9_l5: rolling.k9_l5,
      bb9_l5: rolling.bb9_l5,
      k_pct_l5: rolling.k_pct_l5,
      swstr_pct_l5: rolling.swstr_pct_l5,
      gb_pct_l5: rolling.gb_pct_l5,
      hard_contact_l5: rolling.hard_contact_l5,
      avg_innings_l5: rolling.avg_innings_l5,
      early_exit_rate_l5: rolling.early_exit_rate_l5,
      days_rest: rolling.days_rest,
      tto_penalty: tto.tto_penalty,
      tto3_penalty: tto.tto3_penalty,
      venue_era: rolling.venue_era,
      confidence: rolling.confidence,
    },
    ['pitcher_id', 'as_of_date'],
  )

  return { ...rolling, ...tto, name: info?.name, hand: info?.hand }
}

/**
 * Ingest every pitcher appearing in a given season's games table.
 */
export async function ingestSeason(season) {
  const games = await db.all(
    `SELECT DISTINCT pitcher_home_id AS pid, date, venue_id FROM historical_games
       WHERE season = ? AND pitcher_home_id IS NOT NULL
     UNION
     SELECT DISTINCT pitcher_away_id AS pid, date, venue_id FROM historical_games
       WHERE season = ? AND pitcher_away_id IS NOT NULL`,
    [season, season],
  )
  let done = 0
  for (const r of games) {
    if (!r.pid) continue
    try {
      await ingestPitcherAsOf(r.pid, r.date, season, r.venue_id)
      await sleep(THROTTLE_MS)
    } catch (err) {
      process.stderr.write(
        `[pitchers] pid=${r.pid} ${r.date}: ${err.message?.slice(0, 120)}\n`,
      )
    }
    done++
    if (done % 200 === 0) {
      process.stderr.write(`[pitchers] season ${season}: ${done}/${games.length}\n`)
    }
  }
  return { season, processed: done }
}
