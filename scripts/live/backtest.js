// scripts/live/backtest.js — Calibration backtest for the strikeout model.
//
// For each season's starts (pitchers in our DB), reconstructs what the model would
// have predicted using only pre-game data, then compares to actual K totals.
//
// No Kalshi prices needed — this tests model calibration:
//   "When we say P(K≥n) = 60%, does the pitcher actually hit K≥n 60% of the time?"
//
// ── FINAL PARAMETER CHOICES (validated 2026-04-21) ───────────────────────────
//
// Improvements tested on 2025 season (n=28,931 predictions), validated on 2024 OOS:
//
//   A. BB% penalty from game log: REJECTED (hurts both 2025 and 2024 OOS)
//      - Rolling game log BB% is too noisy (small per-pitcher sample within season)
//      - Keep BB% penalty in strikeoutEdge.js ONLY where it uses Savant season BB%
//        (much more reliable — full season of data, not just 5-10 starts)
//
//   B. Opp adj selectivity (|adj-1| > threshold): CONFIRMED threshold=0.28
//      - baseline (no adj): Brier 0.1658
//      - original threshold 0.15: Brier 0.1664 (worse than no adj!)
//      - best threshold 0.28: Brier 0.1649 (best on 2025, validated on 2024 OOS)
//      - Interpretation: only apply when team K% is >28% off league avg
//        (i.e., team K% < 15.8% or > 28.2%, vs league avg 22%)
//
//   C. Threshold shrinkage: CONFIRMED 0.97/0.95/0.93
//      - Baseline: 7+ over by -1.6%, 8+ over by -2.2%, 9+ over by -2.7%
//      - After: 7+ off by -0.7%, 8+ off by -1.1%, 9+ off by -1.7%
//      - Wins on 7+, 8+, 9+ thresholds in BOTH 2025 and 2024 OOS
//
//   D. Brier score fix: DONE — now per-prediction mean((p-y)²), not bucket MSE
//
// Final parameters (all defaults):
//   BB_THRESHOLD=1.0 (disabled), SHRINK7=0.97, SHRINK8=0.95, SHRINK9=0.93, ADJ_THRESHOLD=0.28
//
// ─────────────────────────────────────────────────────────────────────────────
//
// Usage:
//   node scripts/live/backtest.js [--season 2025] [--min-starts 5] [--verbose]
//   node scripts/live/backtest.js --season 2024  (OOS validation, uses 2022-2023 career)

import 'dotenv/config'
import axios from 'axios'
import * as db from '../../lib/db.js'
import { NB_R, LEAGUE_K_PCT, LEAGUE_PA_PER_IP, nbCDF, pAtLeast, ipToDecimal } from '../../lib/strikeout-model.js'

import { parseArgs } from '../../lib/cli-args.js'

// ── Tuning parameters (override via CLI for parameter search) ────────────────
// --bb-threshold  : BB% breakeven (default 1.0 = disabled; rolling game log BB% too noisy)
// --bb-slope      : BB% penalty slope (default 1.5; higher = steeper penalty)
// --shrink7       : P(7+) shrinkage multiplier (default 0.97)
// --shrink8       : P(8+) shrinkage multiplier (default 0.95)
// --shrink9       : P(9+) shrinkage multiplier (default 0.93)
// --adj-threshold : Opp adj selectivity threshold (calibrated optimum = 0.28)
const opts = parseArgs({
  season:       { type: 'number', default: 2025 },
  minStarts:    { flag: 'min-starts',    type: 'number',  default: 5 },
  verbose:      { type: 'boolean' },
  bbThreshold:  { flag: 'bb-threshold',  type: 'number',  default: 1.0 },
  bbSlope:      { flag: 'bb-slope',      type: 'number',  default: 1.5 },
  shrink7:      { flag: 'shrink7',       type: 'number',  default: 0.97 },
  shrink8:      { flag: 'shrink8',       type: 'number',  default: 0.95 },
  shrink9:      { flag: 'shrink9',       type: 'number',  default: 0.93 },
  adjThreshold: { flag: 'adj-threshold', type: 'number',  default: 0.28 },
  bankroll:     { type: 'number', default: 5000 },
  sweepNbr:     { flag: 'sweep-nbr',     type: 'boolean', default: false },
})
const SEASON        = opts.season
const MIN_STARTS    = opts.minStarts
const VERBOSE       = opts.verbose
const BB_THRESHOLD  = opts.bbThreshold
const BB_SLOPE      = opts.bbSlope
const SHRINK7       = opts.shrink7
const SHRINK8       = opts.shrink8
const SHRINK9       = opts.shrink9
const ADJ_THRESHOLD = opts.adjThreshold

const MLB_BASE = 'https://statsapi.mlb.com/api/v1'


// ── Career loader (2023-2024 only — no 2025 to avoid look-ahead) ─────────────

async function loadCareerData(backSeason) {
  const SEASON_WEIGHTS = { [backSeason - 2]: 0.20, [backSeason - 1]: 0.50 }

  const rows = await db.all(
    `SELECT pitcher_id, season,
            AVG(k_pct_l5) as k_pct,
            AVG(k9_l5) as k9,
            AVG(avg_innings_l5) as avg_ip
       FROM historical_pitcher_stats
      WHERE season IN (?, ?)
      GROUP BY pitcher_id, season`,
    [backSeason - 2, backSeason - 1],
  )

  const byPitcher = new Map()
  for (const r of rows) {
    const id = String(r.pitcher_id)
    if (!byPitcher.has(id)) byPitcher.set(id, [])
    byPitcher.get(id).push(r)
  }

  const career = new Map()
  for (const [id, seasons] of byPitcher) {
    let totalW = 0, wKpct = 0, wK9 = 0, wIp = 0
    for (const s of seasons) {
      const w = SEASON_WEIGHTS[s.season]
      if (!w) continue
      totalW += w; wKpct += w * s.k_pct; wK9 += w * s.k9; wIp += w * s.avg_ip
    }
    if (totalW > 0) career.set(id, { k_pct: wKpct / totalW, k9: wK9 / totalW, avg_ip: wIp / totalW })
  }
  return career
}

// ── Team ID map (abbr → MLB numeric ID) ──────────────────────────────────────

const ABBR_TO_ID = {
  LAA: 108, ARI: 109, BAL: 110, BOS: 111, CHC: 112, CIN: 113, CLE: 114,
  COL: 115, DET: 116, HOU: 117, KC: 118, LAD: 119, WSH: 120, NYM: 121,
  OAK: 133, ATH: 133, PIT: 134, SD: 135, SEA: 136, SF: 137, STL: 138,
  TB: 139, TEX: 140, TOR: 141, MIN: 142, PHI: 143, ATL: 144, CWS: 145,
  MIA: 146, NYY: 147, MIL: 158,
}

// ── Fetch full season game log (includes opponent team ID) ───────────────────

async function fetchGameLog(pitcherId, season) {
  try {
    const res = await axios.get(`${MLB_BASE}/people/${pitcherId}/stats`, {
      params: { stats: 'gameLog', group: 'pitching', season, sportId: 1 },
      timeout: 20000,
      validateStatus: s => s >= 200 && s < 500,
    })
    if (res.status >= 400) return []
    return (res.data?.stats?.[0]?.splits || [])
      .filter(s => s.stat?.gamesStarted === 1)
      .map(s => ({
        date:       s.date,
        ip:         ipToDecimal(Number(s.stat?.inningsPitched || 0)),
        k:          Number(s.stat?.strikeOuts || 0),
        bf:         Number(s.stat?.battersFaced || 0),
        bb:         Number(s.stat?.baseOnBalls || 0),
        pitches:    Number(s.stat?.numberOfPitches || 0),
        opponent:   s.opponent?.id ? String(s.opponent.id) : null,
        isHome:     s.isHome,
      }))
      .sort((a, b) => a.date.localeCompare(b.date))
  } catch { return [] }
}

// ── Opponent K% adjustment ────────────────────────────────────────────────────

async function fetchOppKpct(oppTeamId, gameDate, pitcherHand, teamOffenseCache) {
  if (!oppTeamId) return 1.0
  const key = `${oppTeamId}-${gameDate}-${pitcherHand}`
  if (teamOffenseCache.has(key)) return teamOffenseCache.get(key)

  // Find most recent entry on or before gameDate for this team + hand
  const rows = await db.all(
    `SELECT k_pct_14d FROM historical_team_offense
      WHERE team_id = ? AND vs_hand = ? AND as_of_date <= ?
      ORDER BY as_of_date DESC LIMIT 1`,
    [Number(oppTeamId), pitcherHand, gameDate],
  )
  const adj = rows.length ? rows[0].k_pct_14d / LEAGUE_K_PCT : 1.0
  // Cap adjustment: 0.70–1.40 (same as strikeoutEdge.js)
  const capped = Math.min(1.40, Math.max(0.70, adj))
  teamOffenseCache.set(key, capped)
  return capped
}

// ── Compute λ for a single start ─────────────────────────────────────────────
// Uses only starts BEFORE gameDate (strict look-ahead safety)
// Returns { lambda, lambdaRaw } — improved vs baseline (no BB% penalty, no adj selectivity)

function computeLambda(pitcherId, gameDate, allStarts, careerData, oppAdj = 1.0) {
  const prev = allStarts.filter(s => s.date < gameDate)
  const career = careerData.get(String(pitcherId))

  // pK_career
  const pK_career = career?.k_pct ?? LEAGUE_K_PCT
  const avgIp     = career?.avg_ip ?? 5.2

  // Season K% from prev starts this season (acts as pK_season proxy)
  const seasonBF = prev.reduce((s, r) => s + (r.bf || 0), 0)
  const seasonK  = prev.reduce((s, r) => s + (r.k  || 0), 0)
  const pK_season = seasonBF >= 20 ? seasonK / seasonBF : pK_career

  // pK_l5 from last 5 starts
  const l5 = prev.slice(-5)
  const l5BF = l5.reduce((s, r) => s + (r.bf || 0), 0)
  const l5K  = l5.reduce((s, r) => s + (r.k  || 0), 0)
  const pK_l5 = l5BF > 0 ? l5K / l5BF : pK_season

  // Season IP so far
  const seasonIP = prev.reduce((s, r) => s + (r.ip || 0), 0)

  // Blend weights (same formula as strikeoutEdge.js)
  const w_career = Math.max(0, 0.40 * (1 - seasonIP / 40))
  const w_season = Math.min(0.60, seasonIP / 50)
  const w_l5     = Math.max(0, 1 - w_career - w_season)
  const total    = w_career + w_season + w_l5

  const pK_blended = total > 0
    ? (w_career * pK_career + w_season * pK_season + w_l5 * pK_l5) / total
    : pK_career

  // E[BF] from recent starts
  const recent = l5.filter(s => s.bf > 0)
  const expectedBF = recent.length >= 2
    ? recent.reduce((s, r) => s + r.bf, 0) / recent.length
    : avgIp * LEAGUE_PA_PER_IP

  // ── Improvement A: BB% penalty (look-ahead safe — rolling from prev starts) ─
  // Compute rolling BB% from starts BEFORE this game (no look-ahead)
  const prevBB = prev.reduce((s, r) => s + (r.bb || 0), 0)
  const prevBF = prev.reduce((s, r) => s + (r.bf || 0), 0)
  const rollingBbPct = prevBF > 20 ? prevBB / prevBF : null
  let bbPenalty = 1.0
  if (rollingBbPct != null && rollingBbPct > BB_THRESHOLD) {
    bbPenalty = Math.max(0.80, 1 - (rollingBbPct - (BB_THRESHOLD - 0.01)) * BB_SLOPE)
  }

  // ── Improvement B: Opp adj selectivity ────────────────────────────────────
  // Only apply adj when the mismatch is extreme (|adj-1| > ADJ_THRESHOLD)
  const effectiveOppAdj = Math.abs(oppAdj - 1.0) > ADJ_THRESHOLD ? oppAdj : 1.0

  // Base lambda (no improvements — for comparison)
  const lambdaRaw = expectedBF * pK_blended * oppAdj

  // Improved lambda
  const lambda = expectedBF * pK_blended * bbPenalty * effectiveOppAdj

  return { lambda, lambdaRaw }
}

// ── Calibration bins ─────────────────────────────────────────────────────────

function addToBin(bins, prob, hit) {
  const bucket = Math.floor(prob * 10) / 10  // 0.0, 0.1, ..., 0.9
  if (!bins[bucket]) bins[bucket] = { pred: 0, actual: 0, n: 0 }
  bins[bucket].pred   += prob
  bins[bucket].actual += hit ? 1 : 0
  bins[bucket].n++
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  await db.migrate()

  console.log(`[backtest] Loading career data (${SEASON - 2}–${SEASON - 1})…`)
  const careerData = await loadCareerData(SEASON)
  console.log(`[backtest] ${careerData.size} pitchers with career profiles`)
  console.log(`[backtest] Params: BB_THRESHOLD=${BB_THRESHOLD} BB_SLOPE=${BB_SLOPE} SHRINK7=${SHRINK7} SHRINK8=${SHRINK8} SHRINK9=${SHRINK9} ADJ_THRESHOLD=${ADJ_THRESHOLD}`)

  // Get pitchers with enough 2025 starts in our historical DB
  const pitcherRows = await db.all(
    `SELECT pitcher_id, COUNT(*) as n
       FROM historical_pitcher_stats WHERE season = ?
      GROUP BY pitcher_id HAVING n >= ?`,
    [SEASON, MIN_STARTS],
  )
  console.log(`[backtest] ${pitcherRows.length} pitchers with ≥${MIN_STARTS} starts in ${SEASON}`)

  const predictions = []
  const teamOffenseCache = new Map()
  let fetched = 0

  // Fetch pitcher hand info for opponent adjustment
  const pitcherHandCache = new Map()

  for (const { pitcher_id } of pitcherRows) {
    const starts = await fetchGameLog(pitcher_id, SEASON)
    if (starts.length < MIN_STARTS) continue

    // Determine pitcher hand (sample from career data or default R)
    let hand = 'R'
    try {
      const res = await axios.get(`${MLB_BASE}/people/${pitcher_id}`, { timeout: 8000, validateStatus: s => s < 500 })
      hand = res.data?.people?.[0]?.pitchHand?.code || 'R'
    } catch {}

    for (let i = 0; i < starts.length; i++) {
      const start = starts[i]
      if (i < 2) continue

      // Opponent adjustment (with look-ahead safety via as_of_date)
      const oppAdj = start.opponent
        ? await fetchOppKpct(start.opponent, start.date, hand, teamOffenseCache)
        : 1.0

      // computeLambda now returns { lambda, lambdaRaw }
      // lambdaRaw = no BB% penalty, no adj selectivity (old behavior with raw oppAdj)
      // lambda    = improved: BB% penalty + adj selectivity
      const resNoAdj = computeLambda(pitcher_id, start.date, starts, careerData, 1.0)
      const resAdj   = computeLambda(pitcher_id, start.date, starts, careerData, oppAdj)

      // Baseline: raw adj, no BB% penalty, no selectivity = lambdaRaw from resAdj
      const lambdaBaseline = resAdj.lambdaRaw
      // Improved: BB% penalty + adj selectivity applied
      const lambdaImproved = resAdj.lambda
      // No-adj version for opp-adj comparison section
      const lambdaNoAdj    = resNoAdj.lambda

      if (!lambdaImproved || lambdaImproved <= 0) continue

      // Leash flag: avg pitches from last 5 starts before this game
      const prev5 = starts.filter(s => s.date < start.date).slice(-5)
      const pitchStarts = prev5.filter(s => s.pitches > 0)
      const avgPitches = pitchStarts.length ? pitchStarts.reduce((s, r) => s + r.pitches, 0) / pitchStarts.length : null
      const leash = avgPitches !== null && avgPitches < 85

      for (let n = 3; n <= 9; n++) {
        // ── Improvement C: Threshold shrinkage ──────────────────────────────
        const rawImproved = pAtLeast(lambdaImproved, n)
        const prob = n >= 9 ? rawImproved * SHRINK9
                   : n >= 8 ? rawImproved * SHRINK8
                   : n >= 7 ? rawImproved * SHRINK7
                   : rawImproved

        // Raw (baseline) prob — no improvements applied (for diff table comparison)
        const probRaw    = pAtLeast(lambdaBaseline, n)
        // No-adj prob — for opp adj section
        const probNoAdj  = pAtLeast(lambdaNoAdj, n)

        const hit = start.k >= n
        predictions.push({
          prob, probRaw, probNoAdj, hit, n,
          pitcher_id, gameDate: start.date, actual_k: start.k,
          lambda: lambdaImproved, oppAdj, leash,
          avgPitches,
        })
      }
    }

    fetched++
    if (fetched % 25 === 0) process.stdout.write(`\r[backtest] Fetched ${fetched}/${pitcherRows.length}…`)
  }

  console.log(`\n[backtest] ${fetched} pitchers, ${predictions.length} predictions`)

  // ── Calibration by probability bucket ────────────────────────────────────────

  console.log('\n══ CALIBRATION REPORT ══')
  console.log('(When model says X%, pitcher actually hits threshold Y% of the time)')
  console.log()

  const bins = {}
  for (const p of predictions) addToBin(bins, p.prob, p.hit)

  console.log('Prob bucket | Actual win rate | N    | Deviation')
  console.log('─────────────────────────────────────────────────')
  for (const bucket of Object.keys(bins).sort((a, b) => Number(a) - Number(b))) {
    const b = bins[bucket]
    const actual = b.actual / b.n
    const dev    = actual - Number(bucket) - 0.05  // center of bucket
    const bar    = dev > 0 ? '▲'.repeat(Math.round(Math.abs(dev) * 20)) : '▼'.repeat(Math.round(Math.abs(dev) * 20))
    console.log(
      `  ${(Number(bucket) * 100).toFixed(0).padStart(2)}–${(Number(bucket) * 100 + 10).toFixed(0).padStart(2)}%   | ` +
      `${(actual * 100).toFixed(1)}%`.padEnd(10) + `     | ${String(b.n).padEnd(5)} | ${bar || '●'}`
    )
  }

  // ── Improvement D: Per-prediction Brier score (correct formula) ──────────────
  const brier = predictions.reduce((s, p) => s + Math.pow(p.prob - (p.hit ? 1 : 0), 2), 0) / predictions.length
  const brierRaw = predictions.reduce((s, p) => s + Math.pow(p.probRaw - (p.hit ? 1 : 0), 2), 0) / predictions.length
  console.log(`\nBrier score (improved): ${brier.toFixed(4)}  (lower = better; random = 0.25)`)
  console.log(`Brier score (baseline): ${brierRaw.toFixed(4)}  (${brier < brierRaw ? '✓ improved wins' : brier > brierRaw ? '✗ baseline wins' : '= same'})`)

  // ── NB_R sweep: find optimal dispersion from historical predictions ────────────
  if (opts.sweepNbr) {
    console.log(`\n══ NB_R SWEEP (n=${predictions.length} predictions) ══`)
    console.log('Finds the dispersion parameter that minimizes Brier score on this season\'s data.')
    console.log()
    // Fine-grained search: 8 through 60
    const testRs = [8, 10, 12, 15, 18, 20, 22, 25, 28, 30, 35, 40, 50, 60]
    let bestR = NB_R, bestBrier = Infinity
    for (const r of testRs) {
      const brierR = predictions.reduce((s, p) => {
        const raw = Math.max(0, 1 - nbCDF(p.lambda, r, p.n - 1))
        const adj = p.n >= 9 ? raw * SHRINK9
                  : p.n >= 8 ? raw * SHRINK8
                  : p.n >= 7 ? raw * SHRINK7
                  : raw
        return s + (adj - (p.hit ? 1 : 0)) ** 2
      }, 0) / predictions.length
      if (brierR < bestBrier) { bestBrier = brierR; bestR = r }
      const mark = r === NB_R ? ' ← CURRENT' : r === bestR ? ' ← BEST SO FAR' : ''
      console.log(`  r=${String(r).padEnd(4)}  Brier=${brierR.toFixed(5)}${mark}`)
    }
    console.log()
    if (bestR !== NB_R) {
      const improvement = ((brier - bestBrier) / brier * 100).toFixed(2)
      console.log(`  ⚡ Optimal NB_R = ${bestR}  (Brier ${bestBrier.toFixed(5)}, ${improvement}% better than current)`)
      console.log(`     Update: lib/strikeout-model.js line 12  →  export const NB_R = ${bestR}`)
    } else {
      console.log(`  ✓ Current NB_R = ${NB_R} is optimal for ${SEASON} data.`)
    }
  }

  // ── By K threshold ────────────────────────────────────────────────────────────

  console.log('\n══ BY K THRESHOLD ══')
  console.log('(Avg model prob vs actual hit rate)')
  for (let n = 3; n <= 9; n++) {
    const ps = predictions.filter(p => p.n === n)
    if (!ps.length) continue
    const avgProb   = ps.reduce((s, p) => s + p.prob, 0) / ps.length
    const actualRate = ps.filter(p => p.hit).length / ps.length
    const diff = actualRate - avgProb
    const flag = Math.abs(diff) > 0.05 ? (diff > 0 ? ' ← model UNDER' : ' ← model OVER') : ''
    console.log(
      `  ${n}+ Ks: model=${(avgProb*100).toFixed(1)}%  actual=${(actualRate*100).toFixed(1)}%` +
      `  diff=${diff > 0 ? '+' : ''}${(diff*100).toFixed(1)}%  n=${ps.length}${flag}`
    )
  }

  // ── Improvement F: Calibration diff table (improved vs raw) ──────────────────

  console.log('\n══ CALIBRATION DIFF TABLE (Improved vs Baseline) ══')
  console.log('K thr | Raw model | Improved | Actual | Raw diff | Imp diff | Winner')
  console.log('──────────────────────────────────────────────────────────────────────')
  for (let n = 3; n <= 9; n++) {
    const ps = predictions.filter(p => p.n === n)
    if (!ps.length) continue
    const avgImproved = ps.reduce((s, p) => s + p.prob, 0) / ps.length
    const avgRaw      = ps.reduce((s, p) => s + p.probRaw, 0) / ps.length
    const actualRate  = ps.filter(p => p.hit).length / ps.length
    const rawDiff     = actualRate - avgRaw
    const impDiff     = actualRate - avgImproved
    const winner      = Math.abs(impDiff) < Math.abs(rawDiff) ? 'IMPROVED' : Math.abs(impDiff) > Math.abs(rawDiff) ? 'BASELINE' : 'TIE'
    console.log(
      `  ${n}+  | ${(avgRaw*100).toFixed(1).padStart(6)}%  | ${(avgImproved*100).toFixed(1).padStart(6)}%  | ` +
      `${(actualRate*100).toFixed(1).padStart(5)}%  | ` +
      `${rawDiff >= 0 ? '+' : ''}${(rawDiff*100).toFixed(1).padStart(5)}%  | ` +
      `${impDiff >= 0 ? '+' : ''}${(impDiff*100).toFixed(1).padStart(5)}%  | ${winner}`
    )
  }

  // ── Opponent adjustment: does it help? ───────────────────────────────────────

  console.log('\n══ OPPONENT ADJUSTMENT IMPACT ══')
  const adjBuckets = { improved: 0, hurt: 0, neutral: 0 }
  let adjMSE = 0, noAdjMSE = 0

  for (const p of predictions) {
    const outcome = p.hit ? 1 : 0
    adjMSE   += Math.pow(p.prob - outcome, 2)
    noAdjMSE += Math.pow(p.probNoAdj - outcome, 2)
    const diff = Math.abs(p.prob - outcome) - Math.abs(p.probNoAdj - outcome)
    if (diff < -0.005) adjBuckets.improved++
    else if (diff > 0.005) adjBuckets.hurt++
    else adjBuckets.neutral++
  }
  adjMSE   /= predictions.length
  noAdjMSE /= predictions.length
  console.log(`  MSE without opp adj: ${noAdjMSE.toFixed(4)}`)
  console.log(`  MSE with opp adj:    ${adjMSE.toFixed(4)}  (${adjMSE < noAdjMSE ? '✓ BETTER' : '✗ WORSE'})`)
  console.log(`  Per-prediction: improved=${adjBuckets.improved} hurt=${adjBuckets.hurt} neutral=${adjBuckets.neutral}`)

  // Calibration with vs without adj on high-adjustment starts (|adj-1| > 0.15)
  const highAdj = predictions.filter(p => Math.abs(p.oppAdj - 1.0) > 0.15 && p.n === 6)
  if (highAdj.length > 50) {
    const adjErr   = highAdj.reduce((s, p) => s + Math.abs(p.prob - (p.hit ? 1 : 0)), 0) / highAdj.length
    const noAdjErr = highAdj.reduce((s, p) => s + Math.abs(p.probNoAdj - (p.hit ? 1 : 0)), 0) / highAdj.length
    console.log(`\n  On high-adjustment starts (|adj|>15%, 6+Ks, n=${highAdj.length}):`)
    console.log(`    Without adj: avg error ${(noAdjErr*100).toFixed(1)}%`)
    console.log(`    With adj:    avg error ${(adjErr*100).toFixed(1)}%  (${adjErr < noAdjErr ? '✓ adj helps' : '✗ adj hurts'})`)
  }

  // ── Leash flag analysis ───────────────────────────────────────────────────────

  console.log('\n══ LEASH FLAG ANALYSIS (<85 avg pitches) ══')
  for (const n of [5, 6, 7]) {
    const leashStarts   = predictions.filter(p => p.leash && p.n === n)
    const normalStarts  = predictions.filter(p => !p.leash && p.n === n && p.avgPitches !== null)
    if (leashStarts.length < 20) continue
    const leashHR  = leashStarts.filter(p => p.hit).length / leashStarts.length
    const normalHR = normalStarts.filter(p => p.hit).length / normalStarts.length
    const leashAvgProb  = leashStarts.reduce((s, p) => s + p.prob, 0) / leashStarts.length
    const normalAvgProb = normalStarts.reduce((s, p) => s + p.prob, 0) / normalStarts.length
    console.log(`  ${n}+ Ks: leash actual=${(leashHR*100).toFixed(1)}% (model=${(leashAvgProb*100).toFixed(1)}%, n=${leashStarts.length}) | normal actual=${(normalHR*100).toFixed(1)}% (model=${(normalAvgProb*100).toFixed(1)}%, n=${normalStarts.length})`)
  }

  // ── Simulated P&L ─────────────────────────────────────────────────────────────

  console.log('\n══ SIMULATED EV (market = naive league-avg λ) ══')
  const LEAGUE_LAMBDA = (8.8 / 9) * 5.2
  let simPnl = 0, simBets = 0, simWins = 0
  let simPnlNoAdj = 0, simBetsNoAdj = 0, simWinsNoAdj = 0

  for (const p of predictions) {
    const marketProb = pAtLeast(LEAGUE_LAMBDA, p.n)

    for (const [prob, pnlAcc, betsAcc, winsAcc] of [
      [p.prob, 'adj'], [p.probNoAdj, 'noAdj'],
    ]) {
      const edge = prob - marketProb
      if (Math.abs(edge) < 0.05) continue
      const side = edge > 0 ? 'YES' : 'NO'
      const mktPrice = side === 'YES' ? marketProb : (1 - marketProb)
      const won = side === 'YES' ? p.hit : !p.hit
      const pnl = won ? 100 * (1 - mktPrice) : -100 * mktPrice
      if (pnlAcc === 'adj') { simPnl += pnl; simBets++; if (won) simWins++ }
      else { simPnlNoAdj += pnl; simBetsNoAdj++; if (won) simWinsNoAdj++ }
    }
  }

  console.log(`  With opp adj:    ${simBets} bets | WR=${(simWins/simBets*100).toFixed(1)}% | P&L=$${simPnl.toFixed(0)} | EV/bet=$${(simPnl/simBets).toFixed(2)}`)
  console.log(`  Without opp adj: ${simBetsNoAdj} bets | WR=${(simWinsNoAdj/simBetsNoAdj*100).toFixed(1)}% | P&L=$${simPnlNoAdj.toFixed(0)} | EV/bet=$${(simPnlNoAdj/simBetsNoAdj).toFixed(2)}`)
  console.log('  (market = naive league-average λ — real Kalshi edges will be smaller)')

  // ── Bankroll Simulation ────────────────────────────────────────────────────

  const STARTING_BANKROLL = opts.bankroll ?? 5000
  const KELLY_FRACTION    = 0.25   // fractional Kelly multiplier
  const KELLY_CAP         = 0.05   // max fraction of bankroll per bet
  const MIN_BET           = 25     // floor per bet in dollars
  const MAX_BET           = 250    // hard cap in dollars (Kalshi liquidity + sanity limit)
  const LEAGUE_LAMBDA_BK  = (8.8 / 9) * 5.2

  function runBankrollSim(label, edgeThreshold, marketFn) {
    // marketFn(p) → marketProb for each prediction (defaults to naive league-avg)
    marketFn = marketFn || (p => pAtLeast(LEAGUE_LAMBDA_BK, p.n))

    // Group predictions by game date + pitcher (for correlated Kelly)
    // Sort predictions by date ascending
    const sorted = [...predictions].sort((a, b) => a.gameDate.localeCompare(b.gameDate))

    // Build bets: one per prediction that clears edge threshold
    // Then apply correlated Kelly per pitcher-start
    const rawBets = []
    for (const p of sorted) {
      const marketProb = marketFn(p)
      const edge = p.prob - marketProb
      const absEdge = Math.abs(edge)
      if (absEdge < edgeThreshold) continue

      const side = edge > 0 ? 'YES' : 'NO'
      const mktPrice = side === 'YES' ? marketProb : (1 - marketProb)
      const won = side === 'YES' ? p.hit : !p.hit

      // Raw Kelly fraction: f = edge / (1 - mktPrice) * KELLY_FRACTION
      // For YES: edge = model_prob - market_prob; win payout = (1-mktPrice)/mktPrice
      // Kelly: f = (p*b - q) / b where b = (1-mktPrice)/mktPrice, p=model_prob, q=1-model_prob
      const b = (1 - mktPrice) / mktPrice
      const pModel = side === 'YES' ? p.prob : (1 - p.prob)
      const qModel = 1 - pModel
      const kellyRaw = Math.max(0, (pModel * b - qModel) / b)
      const kellyFrac = Math.min(KELLY_CAP, KELLY_FRACTION * kellyRaw)

      rawBets.push({
        gameDate: p.gameDate,
        pitcher_id: p.pitcher_id,
        n: p.n,
        kellyFrac,
        mktPrice,
        won,
        side,
      })
    }

    // Correlated Kelly: group by date + pitcher, cap total exposure to max single-threshold Kelly
    // Then divide proportionally across thresholds on same pitcher
    const pitcherStartKey = b => `${b.gameDate}|${b.pitcher_id}`
    const groups = new Map()
    for (const b of rawBets) {
      const key = pitcherStartKey(b)
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(b)
    }

    const finalBets = []
    for (const bets of groups.values()) {
      if (bets.length === 1) {
        finalBets.push({ ...bets[0], adjKellyFrac: bets[0].kellyFrac })
        continue
      }
      // Max single-threshold Kelly fraction = cap for total exposure on this start
      const maxKelly = Math.max(...bets.map(b => b.kellyFrac))
      const totalRaw = bets.reduce((s, b) => s + b.kellyFrac, 0)
      // Scale each bet proportionally so total = maxKelly
      const scale = totalRaw > 0 ? maxKelly / totalRaw : 0
      for (const b of bets) {
        finalBets.push({ ...b, adjKellyFrac: b.kellyFrac * scale })
      }
    }

    // Sort final bets by date
    finalBets.sort((a, b) => a.gameDate.localeCompare(b.gameDate))

    // Simulate bankroll progression
    let bankroll = STARTING_BANKROLL
    let peakBankroll = STARTING_BANKROLL
    let peakDate = finalBets[0]?.gameDate ?? ''
    let troughBankroll = STARTING_BANKROLL
    let maxDrawdown = 0
    let maxDrawdownPct = 0
    let totalBets = 0
    let totalWins = 0
    let totalBetAmount = 0

    const dailyPnL = new Map()    // date -> pnl
    const monthlyPnL = new Map()  // YYYY-MM -> { start, end, bets }

    for (const bet of finalBets) {
      const betSize = Math.min(MAX_BET, Math.max(MIN_BET, bet.adjKellyFrac * bankroll))
      const pnl = bet.won
        ? betSize * (1 - bet.mktPrice) / bet.mktPrice
        : -betSize

      const prevBankroll = bankroll
      bankroll += pnl
      totalBets++
      totalBetAmount += betSize
      if (bet.won) totalWins++

      // Track daily P&L
      const prev = dailyPnL.get(bet.gameDate) || 0
      dailyPnL.set(bet.gameDate, prev + pnl)

      // Track monthly
      const month = bet.gameDate.slice(0, 7)
      if (!monthlyPnL.has(month)) monthlyPnL.set(month, { start: prevBankroll, end: bankroll, bets: 1 })
      else {
        const m = monthlyPnL.get(month)
        m.end = bankroll
        m.bets++
      }

      // Peak / drawdown
      if (bankroll > peakBankroll) {
        peakBankroll = bankroll
        peakDate = bet.gameDate
      }
      const drawdown = peakBankroll - bankroll
      const drawdownPct = drawdown / peakBankroll
      if (drawdownPct > maxDrawdownPct) {
        maxDrawdown = drawdown
        maxDrawdownPct = drawdownPct
        troughBankroll = bankroll
      }
    }

    // Best/worst day
    let bestDay = { date: '', pnl: -Infinity }
    let worstDay = { date: '', pnl: Infinity }
    for (const [date, pnl] of dailyPnL) {
      if (pnl > bestDay.pnl)  bestDay  = { date, pnl }
      if (pnl < worstDay.pnl) worstDay = { date, pnl }
    }

    const netPnl = bankroll - STARTING_BANKROLL
    const pct    = (netPnl / STARTING_BANKROLL * 100)
    const avgBet = totalBets ? totalBetAmount / totalBets : 0
    const winRate = totalBets ? totalWins / totalBets * 100 : 0

    console.log(`\n══ BANKROLL SIMULATION — ${label}`)
    console.log(`   ($${STARTING_BANKROLL.toLocaleString()} start, ${SEASON} season) ══`)
    console.log('WARNING: All simulations use proxy market prices, NOT real Kalshi data.')
    console.log('         These are upper-bound estimates. Real live edge will be much smaller.')
    console.log('══════════════════════════════════════════════════════════════════════')
    console.log(`  Starting bankroll: $${STARTING_BANKROLL.toLocaleString()}`)
    console.log(`  Ending bankroll:   $${bankroll.toFixed(2)}  (${netPnl >= 0 ? '+' : ''}${pct.toFixed(1)}%)`)
    console.log(`  Peak bankroll:     $${peakBankroll.toFixed(2)} on ${peakDate}`)
    console.log(`  Max drawdown:      -$${maxDrawdown.toFixed(2)} (-${(maxDrawdownPct*100).toFixed(1)}%)`)
    console.log(`  Total bets:        ${totalBets}`)
    console.log(`  Win rate:          ${winRate.toFixed(1)}%`)
    console.log(`  Avg bet size:      $${avgBet.toFixed(2)}`)
    console.log(`  Best day:          ${bestDay.date}  +$${bestDay.pnl.toFixed(2)}`)
    console.log(`  Worst day:         ${worstDay.date}  -$${Math.abs(worstDay.pnl).toFixed(2)}`)

    console.log('\n  Monthly breakdown:')
    console.log('  Month     | Start      | End        | Net P&L    | Bets')
    console.log('  ──────────────────────────────────────────────────────────')
    for (const [month, m] of [...monthlyPnL.entries()].sort()) {
      const net = m.end - m.start
      console.log(
        `  ${month}   | $${m.start.toFixed(0).padStart(8)} | $${m.end.toFixed(0).padStart(8)} | ` +
        `${net >= 0 ? '+' : ''}$${net.toFixed(0).padStart(7)} | ${m.bets}`
      )
    }
    console.log('══════════════════════════════════════════════════════════════════════')

    return { bankroll, netPnl, pct, peakBankroll, peakDate, maxDrawdown, maxDrawdownPct, totalBets, winRate, avgBet, bestDay, worstDay }
  }

  const sim5  = runBankrollSim('5¢+ edge (naive market — UPPER BOUND, not realistic)', 0.05)
  const sim10 = runBankrollSim('10¢+ edge (naive market — UPPER BOUND)', 0.10)

  // Realistic market proxy: Kalshi anchors toward 50¢, so use midpoint of model_prob and 0.50
  // This simulates an efficient but not perfect market — real live edge will be somewhere in here
  const realisticMarket = p => (p.prob + 0.50) / 2
  const sim5r  = runBankrollSim('5¢+ edge (realistic market proxy — midpoint toward 50¢)', 0.05, realisticMarket)
  const sim10r = runBankrollSim('10¢+ edge (realistic market proxy — midpoint toward 50¢)', 0.10, realisticMarket)

  await db.close()
}

main().catch(err => {
  console.error('[backtest] fatal:', err.message)
  process.exit(1)
})
