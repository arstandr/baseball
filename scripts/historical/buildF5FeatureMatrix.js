// scripts/historical/buildF5FeatureMatrix.js — assemble the F5 (first 5 innings) backtest CSV.
//
// Fork of buildFeatureMatrix.js with F5-specific changes:
//   1. Target: f5_target = f5_runs_total > f5_line_open ? 1 : 0
//      - Skip if f5_runs_total IS NULL (backfill not done yet)
//      - Skip if f5_line_open IS NULL and no proxy available
//      - Use full_line_open * 0.47 as proxy if f5_line_open is missing (proxy until fetchF5Lines runs)
//   2. After buildFeatureVector():
//      - sp_h_tto3_penalty and sp_a_tto3_penalty zeroed out (third-time-through irrelevant for F5)
//      - All bp_h_* and bp_a_* columns set to their season mean (bullpen irrelevant for F5)
//   3. Output: data/f5_feature_matrix_{year}.csv and data/f5_feature_matrix_all.csv
//      - Same columns as regular feature matrix PLUS: f5_runs_total, f5_line_open, f5_target
//      - full_target retained; f5_target added as new primary target

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as db from '../../lib/db.js'
import { buildFeatureVector } from '../../lib/features.js'
import { fetchGameWeather } from './fetchWeather.js'
import { VENUES, resolveVenue } from '../../agents/park/venues.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const DATA_DIR = path.resolve(__dirname, '..', '..', 'data')

function venueLookup(venueId) {
  if (!venueId) return null
  return resolveVenue({ id: String(venueId) })
}

function wxCategoryFromTemp(temp) {
  if (temp == null) return null
  if (temp < 50) return 'cold'
  if (temp < 65) return 'cool'
  if (temp < 80) return 'warm'
  return 'hot'
}

function windDirectionRelative(windBearing, parkOrientation) {
  if (windBearing == null || parkOrientation == null) return 'crosswind'
  const outBearing = (parkOrientation + 180) % 360
  const rel = ((windBearing - outBearing + 540) % 360) - 180
  if (Math.abs(rel) <= 45) return 'out'
  if (Math.abs(rel) >= 135) return 'in'
  return 'crosswind'
}

async function loadPitcherFeatures(pitcherId, asOfDate) {
  if (!pitcherId) return null
  const row = await db.one(
    `SELECT * FROM historical_pitcher_stats WHERE pitcher_id = ? AND as_of_date = ?`,
    [String(pitcherId), asOfDate],
  )
  if (!row) return null
  return {
    fip_weighted: row.fip_l5 ?? 4.10,
    xfip_weighted: row.fip_l5 ?? 4.10,
    swstr_pct: row.swstr_pct_l5 ?? 0.11,
    gb_pct: row.gb_pct_l5 ?? 0.43,
    hard_contact_pct: row.hard_contact_l5 ?? 0.36,
    k9: row.k9_l5 ?? 8.8,        // real last-5-start K/9
    k9_l5: row.k9_l5 ?? 8.8,
    bb9: row.bb9_l5 ?? 3.2,       // real last-5-start BB/9
    bb9_l5: row.bb9_l5 ?? 3.2,
    fstrike_pct: 0.60,
    tto_penalty: row.tto_penalty ?? 0.35,
    tto3_penalty: row.tto3_penalty ?? 0.90,
    era_l5: row.era_l5 ?? 4.3,
    era_f5_l5: row.era_f5_l5 ?? row.era_l5 ?? 4.3,
    early_exit_rate_l5: row.early_exit_rate_l5 ?? 0.29,
    avg_innings_l5: row.avg_innings_l5 ?? 5.5,
    pitch_efficiency_l5: 5.8,
    days_rest: row.days_rest ?? 5,
    season_start_num: 10,
    venue_era_career: row.venue_era ?? 4.3,
    vs_lhb_fip: 4.10,
    vs_rhb_fip: 4.10,
  }
}

async function loadLineupFeatures(teamId, asOfDate) {
  if (!teamId) return null
  const row = await db.one(
    `SELECT * FROM historical_team_offense WHERE team_id = ? AND as_of_date = ? ORDER BY id DESC LIMIT 1`,
    [Number(teamId), asOfDate],
  )
  if (!row) return null
  return {
    wrc_plus_14d: 100, // not exposed by Stats API game log; neutral default
    wrc_plus_30d: 100,
    k_pct_14d: row.k_pct_14d ?? 0.22,
    hard_contact_14d: 0.36,
    iso_14d: 0.155,
    runs_pg_14d: row.runs_pg_14d ?? 4.5,
    lob_pct_14d: 0.72,
    top6_weighted_ops: 0.740,
  }
}

async function loadBullpenFeatures(teamId, asOfDate) {
  if (!teamId) return null
  const row = await db.one(
    `SELECT * FROM historical_bullpen_stats WHERE team_id = ? AND as_of_date = ?`,
    [Number(teamId), asOfDate],
  )
  if (!row) return null
  return {
    era_14d: row.era_14d ?? 4.20,
    whip_14d: row.whip_14d ?? 1.30,
    k_pct_14d: row.k_pct_14d ?? 0.24,
    hr_per_9_14d: row.hr_per_9_14d ?? 1.15,
    inherited_score_pct: row.inherited_score_pct ?? 0.33,
  }
}

async function loadUmpireFeatures(umpireId, asOfDate) {
  if (!umpireId) return null
  const row = await db.one(
    `SELECT * FROM historical_umpire_stats WHERE umpire_id = ? AND as_of_date = ?`,
    [umpireId, asOfDate],
  )
  if (!row) return null
  return {
    runs_pg: row.runs_pg,
    over_rate: row.over_rate,
    n_games: row.n_games,
  }
}

/**
 * Compute per-season means for all bp_h_* and bp_a_* feature columns
 * from an array of feature objects. Used to neutralize bullpen features
 * for the F5 model.
 */
function computeBullpenMeans(featureRows) {
  const sums = {}
  const counts = {}
  for (const feat of featureRows) {
    for (const [k, v] of Object.entries(feat)) {
      if (!k.startsWith('bp_h_') && !k.startsWith('bp_a_')) continue
      if (typeof v !== 'number' || !Number.isFinite(v)) continue
      sums[k] = (sums[k] ?? 0) + v
      counts[k] = (counts[k] ?? 0) + 1
    }
  }
  const means = {}
  for (const k of Object.keys(sums)) {
    means[k] = counts[k] > 0 ? sums[k] / counts[k] : 0
  }
  return means
}

/**
 * Apply F5-specific feature adjustments to a feature vector (mutates in place):
 *   - sp_h_tto3_penalty and sp_a_tto3_penalty → 0.0
 *   - All bp_h_* and bp_a_* → season mean
 */
function applyF5Adjustments(feat, bullpenMeans) {
  // Third-time-through penalty is irrelevant for F5 — starters are still fresh
  feat.sp_h_tto3_penalty = 0.0
  feat.sp_a_tto3_penalty = 0.0

  // Bullpen irrelevant for F5 — replace with season mean so the model ignores them
  for (const k of Object.keys(feat)) {
    if (k.startsWith('bp_h_') || k.startsWith('bp_a_')) {
      feat[k] = bullpenMeans[k] ?? feat[k]
    }
  }
}

/**
 * Detect which game IDs are the second game (G2) of a doubleheader.
 * Two games on the same date at the same venue (same home_team_id) with
 * start times within 4 hours of each other constitute a doubleheader.
 * The game with the later start time is G2.
 *
 * @param {Array} games - full list of games for the season (objects with id, date, home_team_id, game_time)
 * @returns {Set<number|string>} set of game IDs that are G2
 */
function detectDoubleheaderG2(games) {
  // Group games by (date, home_team_id)
  const groups = {}
  for (const g of games) {
    const key = `${g.date}__${g.home_team_id}`
    if (!groups[key]) groups[key] = []
    groups[key].push(g)
  }

  const g2Set = new Set()
  for (const group of Object.values(groups)) {
    if (group.length < 2) continue
    // Check all pairs within the group
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i]
        const b = group[j]
        if (!a.game_time || !b.game_time) continue
        const tA = new Date(a.game_time).getTime()
        const tB = new Date(b.game_time).getTime()
        const diffHours = Math.abs(tA - tB) / (1000 * 60 * 60)
        if (diffHours <= 4) {
          // The later game is G2
          const g2 = tA > tB ? a : b
          g2Set.add(g2.id)
        }
      }
    }
  }
  return g2Set
}

/**
 * Build the F5 feature matrix for a given season and write
 * {DATA_DIR}/f5_feature_matrix_{season}.csv.
 */
export async function buildSeason(season, { skipWeather = false } = {}) {
  await fs.promises.mkdir(DATA_DIR, { recursive: true })
  const outPath = path.join(DATA_DIR, `f5_feature_matrix_${season}.csv`)

  const games = await db.all(
    `SELECT * FROM historical_games
       WHERE season = ?
         AND full_line_open IS NOT NULL
         AND actual_runs_total IS NOT NULL
         AND f5_runs_total IS NOT NULL
       ORDER BY date ASC`,
    [season],
  )
  if (!games.length) {
    process.stderr.write(
      `[buildF5Matrix] season ${season}: no eligible games (need full_line_open + actual_runs_total + f5_runs_total)\n`,
    )
    return { season, written: 0, skipped: 0, outPath }
  }

  const headerColumns = [
    'game_id', 'date', 'season', 'home_team', 'away_team',
    'full_line', 'actual_runs_total', 'full_target',
    'f5_runs_total', 'f5_line_open', 'f5_target',
  ]
  let featureNames = null
  let written = 0
  let skipped = 0

  // Pre-compute which game IDs are G2 doubleheaders (needs the full season list)
  const g2Set = detectDoubleheaderG2(games)

  // Two-pass approach: first pass builds all feature vectors so we can compute
  // bullpen means; second pass writes the CSV with adjusted features.
  const builtRows = []

  for (const g of games) {
    try {
      // Resolve F5 line — require real line or proxy from full line
      // Real Kalshi F5/full median ratio is 0.529 (measured from live API Apr 2026).
      // The prior 0.47 ratio produced a 58% over rate and inflated all backtest ROI.
      const f5LineOpen = g.f5_line_open != null
        ? g.f5_line_open
        : (g.full_line_open != null ? g.full_line_open * 0.529 : null)
      if (f5LineOpen == null) {
        skipped++
        process.stderr.write(
          `[buildF5Matrix] ${g.id} ${g.date}: no f5_line_open and no full_line_open proxy — skipping\n`,
        )
        continue
      }

      const asOfDate = g.date
      const [spH, spA, luH, luA, bpH, bpA, umpFeatures] = await Promise.all([
        loadPitcherFeatures(g.pitcher_home_id, asOfDate),
        loadPitcherFeatures(g.pitcher_away_id, asOfDate),
        loadLineupFeatures(g.home_team_id, asOfDate),
        loadLineupFeatures(g.away_team_id, asOfDate),
        loadBullpenFeatures(g.home_team_id, asOfDate),
        loadBullpenFeatures(g.away_team_id, asOfDate),
        loadUmpireFeatures(g.hp_umpire_id, asOfDate),
      ])

      const venue = venueLookup(g.venue_id)
      const park = venue
        ? {
            run_factor: venue.run_factor,
            hr_factor: venue.hr_factor,
            f5_factor: venue.f5_factor,
            altitude_feet: venue.altitude_feet,
            roof: venue.roof_type,
            surface: venue.surface,
            orientation_degrees: venue.orientation_degrees,
          }
        : null

      let storm = null
      if (!skipWeather && venue) {
        const wx = await fetchGameWeather({
          lat: venue.lat,
          lng: venue.lng,
          date: g.date,
          gameTime: g.game_time,
        })
        if (wx) {
          const windDir = windDirectionRelative(
            wx.wind_bearing_degrees,
            venue.orientation_degrees,
          )
          storm = {
            temp_f: wx.temp_f,
            temp_category: wxCategoryFromTemp(wx.temp_f),
            wind_mph: wx.wind_mph,
            wind_bearing_degrees: wx.wind_bearing_degrees,
            wind_direction_relative: venue.roof_type === 'dome' ? 'crosswind' : windDir,
            humidity_pct: wx.humidity_pct,
            precip_probability: venue.roof_type === 'dome' ? 0 : (wx.precip_probability ?? 0),
          }
        }
      }

      const scout = {
        pitcher_home: { features: spH, confidence: spH ? 0.75 : 0.3 },
        pitcher_away: { features: spA, confidence: spA ? 0.75 : 0.3 },
      }
      const lineup = {
        lineup_home: { features: luH },
        lineup_away: { features: luA },
      }
      const bullpen = {
        bullpen_home: bpH,
        bullpen_away: bpA,
      }
      const market = {
        opening_line: g.full_line_open,
        current_line: g.full_line_open,
        movement: 0,
        efficiency_score: 1.0,
        platform_gap: 0,
        over_price: 0.5,
        under_price: 0.5,
      }

      const feat = buildFeatureVector(scout, lineup, park, storm, market, bullpen, umpFeatures)
      const fullTarget = g.actual_runs_total > g.full_line_open ? 1 : 0
      const f5Target = g.f5_runs_total > f5LineOpen ? 1 : 0

      // pk_day_game: 1 if game starts before 4 PM ET (EDT = UTC-4, covers entire MLB season Apr-Sep)
      const etHour = g.game_time
        ? (new Date(g.game_time).getUTCHours() - 4 + 24) % 24
        : 20 // default to 8 PM ET (night game) when game_time is null
      const pkDayGame = etHour < 16 ? 1 : 0

      // pk_doubleheader_g2: 1 if this game is the second game of a doubleheader
      const pkDoubleheaderG2 = g2Set.has(g.id) ? 1 : 0

      builtRows.push({ g, feat, fullTarget, f5Target, f5LineOpen, f5LineUsedProxy: g.f5_line_open == null, pkDayGame, pkDoubleheaderG2 })
    } catch (err) {
      skipped++
      process.stderr.write(
        `[buildF5Matrix] ${g.id} ${g.date}: ${err.message?.slice(0, 120)}\n`,
      )
    }
  }

  if (!builtRows.length) {
    process.stderr.write(
      `[buildF5Matrix] season ${season}: no rows built after first pass\n`,
    )
    return { season, written: 0, skipped, outPath }
  }

  // Compute bullpen column means across all built rows for this season
  const bullpenMeans = computeBullpenMeans(builtRows.map(r => r.feat))

  const ws = fs.createWriteStream(outPath)

  for (const { g, feat, fullTarget, f5Target, f5LineOpen, pkDayGame, pkDoubleheaderG2 } of builtRows) {
    // Apply F5 adjustments: zero tto3 penalties, set bullpen cols to season mean
    applyF5Adjustments(feat, bullpenMeans)

    // Park/context features added after buildFeatureVector so lib/features.js is untouched
    feat.pk_day_game = pkDayGame
    feat.pk_doubleheader_g2 = pkDoubleheaderG2

    if (!featureNames) {
      featureNames = Object.keys(feat)
      ws.write([...headerColumns, ...featureNames].join(',') + '\n')
    }

    const row = [
      g.id,
      g.date,
      season,
      csvEscape(g.home_team),
      csvEscape(g.away_team),
      g.full_line_open,
      g.actual_runs_total,
      fullTarget,
      g.f5_runs_total,
      f5LineOpen,
      f5Target,
      ...featureNames.map(k => {
        const v = feat[k]
        if (v == null) return ''
        if (typeof v === 'number') return Number.isFinite(v) ? v : ''
        return csvEscape(String(v))
      }),
    ]
    ws.write(row.join(',') + '\n')
    written++

    if (written % 250 === 0) {
      process.stderr.write(`[buildF5Matrix] season ${season}: ${written}/${builtRows.length}\n`)
    }
  }
  await new Promise((resolve, reject) => { ws.end(); ws.on('finish', resolve); ws.on('error', reject) })
  return { season, written, skipped, outPath }
}

function csvEscape(s) {
  if (s == null) return ''
  const t = String(s)
  if (/[",\n]/.test(t)) return `"${t.replace(/"/g, '""')}"`
  return t
}

/**
 * Build F5 matrix for all seasons present in historical_games and concatenate
 * into f5_feature_matrix_all.csv.
 */
export async function buildAll({ seasons, skipWeather = false } = {}) {
  const years = seasons?.length
    ? seasons
    : (await db.all(`SELECT DISTINCT season FROM historical_games ORDER BY season ASC`))
        .map(r => r.season)
  const results = []
  for (const s of years) {
    const r = await buildSeason(s, { skipWeather })
    results.push(r)
    process.stderr.write(`[buildF5Matrix] season ${s}: wrote ${r.written} to ${r.outPath}\n`)
  }

  // Concatenate into f5_feature_matrix_all.csv
  const all = path.join(DATA_DIR, 'f5_feature_matrix_all.csv')
  const wsAll = fs.createWriteStream(all)
  let wroteHeader = false
  for (const r of results) {
    if (!fs.existsSync(r.outPath)) continue
    const data = await fs.promises.readFile(r.outPath, 'utf-8')
    const [header, ...rest] = data.split('\n')
    if (!wroteHeader) {
      wsAll.write(header + '\n')
      wroteHeader = true
    }
    for (const line of rest) {
      if (line.trim()) wsAll.write(line + '\n')
    }
  }
  wsAll.end()
  return { seasons: years, results, combined: all }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const seasonArg = process.argv.includes('--season')
    ? Number(process.argv[process.argv.indexOf('--season') + 1])
    : null
  if (seasonArg) {
    buildSeason(seasonArg).then(r => { console.log(JSON.stringify(r)); process.exit(0) })
  } else {
    buildAll().then(r => { console.log(JSON.stringify(r)); process.exit(0) })
  }
}
