// scripts/historical/buildFeatureMatrix.js — assemble the backtest CSV.
//
// For each game in historical_games:
//   1. Skip if no opening line available
//   2. Skip if postponed/suspended (no runs)
//   3. Fetch pitcher stats for both starters (historical_pitcher_stats)
//   4. Fetch team offense for both teams (historical_team_offense)
//   5. Fetch bullpen for both teams (historical_bullpen_stats)
//   6. Fetch weather via Open-Meteo
//   7. Park factors from venues table
//   8. Build feature vector using buildFeatureVector()
//   9. Add target: over = 1 if actual_runs_total > full_line_open
//  10. Write CSV row

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
 * Build the feature matrix for a given season and write {DATA_DIR}/feature_matrix_{season}.csv.
 */
export async function buildSeason(season, { skipWeather = false } = {}) {
  await fs.promises.mkdir(DATA_DIR, { recursive: true })
  const outPath = path.join(DATA_DIR, `feature_matrix_${season}.csv`)

  const games = await db.all(
    `SELECT * FROM historical_games
       WHERE season = ?
         AND full_line_open IS NOT NULL
         AND actual_runs_total IS NOT NULL
       ORDER BY date ASC`,
    [season],
  )
  if (!games.length) {
    process.stderr.write(
      `[buildMatrix] season ${season}: no eligible games (need full_line_open + actual_runs_total)\n`,
    )
    return { season, written: 0, outPath }
  }

  // Seed venues once so resolveVenue() works without DB dependency
  // (VENUES is already imported; no DB needed)

  const headerColumns = [
    'game_id', 'date', 'season', 'home_team', 'away_team',
    'full_line', 'actual_runs_total', 'target',
  ]
  let featureNames = null
  let written = 0
  let skipped = 0
  const ws = fs.createWriteStream(outPath)

  for (const g of games) {
    try {
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
      const target = g.actual_runs_total > g.full_line_open ? 1 : 0

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
        target,
        ...featureNames.map(k => {
          const v = feat[k]
          if (v == null) return ''
          if (typeof v === 'number') return Number.isFinite(v) ? v : ''
          return csvEscape(String(v))
        }),
      ]
      ws.write(row.join(',') + '\n')
      written++

      await db.run(
        `UPDATE historical_games SET features_built = 1, target = ? WHERE id = ?`,
        [target, g.id],
      )

      if (written % 250 === 0) {
        process.stderr.write(`[buildMatrix] season ${season}: ${written}/${games.length}\n`)
      }
    } catch (err) {
      skipped++
      process.stderr.write(
        `[buildMatrix] ${g.id} ${g.date}: ${err.message?.slice(0, 120)}\n`,
      )
    }
  }
  ws.end()
  return { season, written, skipped, outPath }
}

function csvEscape(s) {
  if (s == null) return ''
  const t = String(s)
  if (/[",\n]/.test(t)) return `"${t.replace(/"/g, '""')}"`
  return t
}

/**
 * Build matrix for all seasons present in historical_games and concatenate
 * into feature_matrix_all.csv.
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
    process.stderr.write(`[buildMatrix] season ${s}: wrote ${r.written} to ${r.outPath}\n`)
  }

  // Concatenate into feature_matrix_all.csv
  const all = path.join(DATA_DIR, 'feature_matrix_all.csv')
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
