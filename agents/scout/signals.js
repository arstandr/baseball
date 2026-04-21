// agents/scout/signals.js — XGBoost feature computation for one pitcher
//
// Inputs come from multiple sources; we normalise and blend. Each function
// tolerates missing data by falling back to the next best source (or a
// league-average neutral value) and tagging the final output with a
// `confidence` score derived from sample size.

import {
  fetchPitcherSeasonStats,
  fetchPitcherGameLog as mlbGameLog,
  fetchPitcherHand,
} from '../../lib/mlbapi.js'
import { fetchPitcherStatcastLeaderboard } from '../../lib/savant.js'
import {
  fetchPitcherLeaderboard as fgLeaderboard,
  fetchPitcherPlatoonSplits,
} from '../../lib/fangraphs.js'
import {
  resolveBbrefSlug,
  fetchPitcherGameLog as bbrefGameLog,
  fetchVenueSplits,
  fetchTtoSplits,
} from '../../lib/bbref.js'

// League-average fallbacks (2024 regular season, baseline values)
export const LEAGUE_AVG = {
  fip: 4.10,
  xfip: 4.10,
  swstr_pct: 0.110,
  gb_pct: 0.43,
  hard_contact_pct: 0.36,
  k9: 8.8,
  bb9: 3.2,
  fstrike_pct: 0.60,
  tto_penalty: 0.35,
  tto3_penalty: 0.90, // 3rd time through penalty — full-game critical
  era: 4.30,
  vs_lhb_fip: 4.10,
  vs_rhb_fip: 4.10,
}

// Cache leaderboards per-season so we don't refetch per pitcher
const _savantCache = new Map()
const _fgCache = new Map()

async function getSavant(season) {
  if (_savantCache.has(season)) return _savantCache.get(season)
  const data = await fetchPitcherStatcastLeaderboard(season)
  _savantCache.set(season, data)
  return data
}

async function getFangraphs(season) {
  if (_fgCache.has(season)) return _fgCache.get(season)
  const data = await fgLeaderboard(season, { min_ip: 10 })
  _fgCache.set(season, data)
  return data
}

/**
 * Recency-weighted aggregator. Half-life 4 starts means the weight of the nth
 * most recent start is (0.5)^(n/4). We normalise weights to sum to 1.
 *
 * @param {number[]} values   - most-recent-first ordered list of per-start values
 * @param {number}   halfLife - default 4 starts
 */
export function recencyWeighted(values, halfLife = 4) {
  const clean = values.filter(v => typeof v === 'number' && !Number.isNaN(v))
  if (!clean.length) return null
  const weights = clean.map((_, i) => Math.pow(0.5, i / halfLife))
  const sumW = weights.reduce((a, b) => a + b, 0)
  const weighted = clean.reduce((a, v, i) => a + v * weights[i], 0)
  return weighted / sumW
}

/**
 * Confidence score based on sample size.
 * 0 starts: 0.1 (hard floor)
 * 1-2 starts: 0.3
 * 3-4 starts: 0.55
 * 5-7 starts: 0.75
 * 8+ starts: 0.9
 */
export function confidenceFromSampleSize(nStarts) {
  if (!nStarts || nStarts <= 0) return 0.1
  if (nStarts <= 2) return 0.3
  if (nStarts <= 4) return 0.55
  if (nStarts <= 7) return 0.75
  return 0.9
}

/**
 * Compute days between two ISO dates.
 */
function daysBetween(iso1, iso2) {
  const d1 = new Date(iso1).getTime()
  const d2 = new Date(iso2).getTime()
  if (!d1 || !d2) return null
  return Math.round(Math.abs(d2 - d1) / (24 * 3600 * 1000))
}

/**
 * Main entrypoint — compute the full pitcher feature vector for a given
 * (pitcher_id, game) pair.
 */
export async function computePitcherSignals({
  pitcherId,
  pitcherName,
  gameDate,
  venueId,
  season,
}) {
  if (!pitcherId) return null
  const [savant, fg, hand, gameLog, slug] = await Promise.all([
    getSavant(season).catch(() => ({})),
    getFangraphs(season).catch(() => ({})),
    fetchPitcherHand(pitcherId).catch(() => 'R'),
    mlbGameLog(pitcherId, season).catch(() => []),
    resolveBbrefSlug(pitcherName).catch(() => null),
  ])

  const sv = savant?.[pitcherId] || null
  const fgRow = fg?.[pitcherId] || null

  // --- Last 5 starts metrics from the MLB game log
  const recent = [...(gameLog || [])].reverse().slice(0, 5) // most-recent-first
  const eraL5 = computeFullEraL5(recent)
  const avgInnings = recent.length
    ? recent.reduce((a, r) => a + (r.innings || 0), 0) / recent.length
    : null
  const pitchEff = computePitchEfficiencyL5(recent)
  const lastStart = recent[0]
  const daysRest = lastStart ? daysBetween(lastStart.date, gameDate) : null
  const seasonStartNum = (gameLog || []).length + 1
  const rolling21dPitches = sumPitchesWithinDays(gameLog, gameDate, 21)

  // --- Recency-weighted season metrics (per-start when we can, else season agg)
  const fipWeighted = sv?.xera ?? fgRow?.fip ?? LEAGUE_AVG.fip
  const xfipWeighted = fgRow?.xfip ?? LEAGUE_AVG.xfip
  const swstrPct = sv?.swstr_pct ?? LEAGUE_AVG.swstr_pct
  const gbPct = sv?.gb_pct ?? fgRow?.gb_pct ?? LEAGUE_AVG.gb_pct
  const hardPct = sv?.hard_contact_pct ?? LEAGUE_AVG.hard_contact_pct
  const k9 = fgRow?.k9 ?? sv?.k_pct != null ? (sv.k_pct * 38) : LEAGUE_AVG.k9
  const bb9 = fgRow?.bb9 ?? LEAGUE_AVG.bb9
  const fstrike = sv?.fstrike_pct ?? fgRow?.fstrike_pct ?? LEAGUE_AVG.fstrike_pct

  // --- Platoon splits (Fangraphs splits page — optional)
  const splits = await fetchPitcherPlatoonSplits(pitcherId, season).catch(
    () => ({ vs_lhb: null, vs_rhb: null }),
  )

  // --- TTO penalty + venue history (BBRef career splits)
  const tto = slug ? await fetchTtoSplits(slug).catch(() => null) : null
  const venueSplits = slug ? await fetchVenueSplits(slug).catch(() => []) : []
  const venueRow = venueSplits.find(v => (v.venue || '').toLowerCase().includes(String(venueId || '').toLowerCase()))

  // --- Sample size confidence
  const nStarts = (gameLog || []).length
  const confidence = confidenceFromSampleSize(nStarts)

  return {
    pitcher_id: pitcherId,
    pitcher_name: pitcherName || fgRow?.name || sv?.name || pitcherId,
    hand: hand || 'R',
    signal_date: gameDate,
    // --- Recency-weighted season metrics
    fip_weighted: round3(fipWeighted),
    xfip_weighted: round3(xfipWeighted),
    swstr_pct: round4(swstrPct),
    gb_pct: round4(gbPct),
    hard_contact_pct: round4(hardPct),
    k9: round3(k9),
    bb9: round3(bb9),
    fstrike_pct: round4(fstrike),
    // --- TTO
    tto_penalty: tto?.penalty ?? LEAGUE_AVG.tto_penalty,
    tto3_penalty: tto?.tto3_penalty ?? LEAGUE_AVG.tto3_penalty,
    // --- L5 specific (full-game ERA replaces F5 ERA)
    era_l5: eraL5,
    avg_innings_l5: avgInnings != null ? Number(avgInnings.toFixed(2)) : null,
    pitch_efficiency_l5: pitchEff,
    // --- Rest / workload
    days_rest: daysRest,
    pitch_count_last_start: lastStart?.pitches || null,
    season_start_num: seasonStartNum,
    rolling_21d_pitches: rolling21dPitches,
    // --- Venue history
    venue_era_career: venueRow?.era ?? null,
    venue_innings_career: venueRow?.innings ?? null,
    // --- Platoon splits
    vs_lhb_fip: splits?.vs_lhb?.fip ?? LEAGUE_AVG.vs_lhb_fip,
    vs_rhb_fip: splits?.vs_rhb?.fip ?? LEAGUE_AVG.vs_rhb_fip,
    vs_lhb_swstr: splits?.vs_lhb?.swstr_pct ?? null,
    vs_rhb_swstr: splits?.vs_rhb?.swstr_pct ?? null,
    // --- Confidence
    confidence,
    sample_size_starts: nStarts,
    // --- Raw sources for audit trail
    _sources: {
      savant: !!sv,
      fangraphs: !!fgRow,
      bbref_slug: slug,
      mlb_gamelog_starts: nStarts,
    },
  }
}

// -------- Helper math --------

function computeFullEraL5(recent) {
  // Full-game ERA across last 5 starts: sum earned runs / sum innings * 9
  if (!recent?.length) return null
  let er = 0
  let ip = 0
  for (const r of recent) {
    if (!r.innings) continue
    er += r.earnedRuns || 0
    ip += r.innings
  }
  if (ip === 0) return null
  return Number(((er / ip) * 9).toFixed(2))
}

function computePitchEfficiencyL5(recent) {
  // pitches per out
  if (!recent?.length) return null
  let pitches = 0
  let outs = 0
  for (const r of recent) {
    pitches += r.pitches || 0
    outs += Math.round((r.innings || 0) * 3)
  }
  if (!outs) return null
  return Number((pitches / outs).toFixed(2))
}

function sumPitchesWithinDays(gameLog, referenceDate, days) {
  if (!gameLog?.length || !referenceDate) return 0
  const cutoff = new Date(referenceDate).getTime() - days * 24 * 3600 * 1000
  return gameLog
    .filter(r => new Date(r.date).getTime() >= cutoff)
    .reduce((a, r) => a + (r.pitches || 0), 0)
}

function round3(v) {
  if (v == null || Number.isNaN(v)) return null
  return Number(Number(v).toFixed(3))
}
function round4(v) {
  if (v == null || Number.isNaN(v)) return null
  return Number(Number(v).toFixed(4))
}
