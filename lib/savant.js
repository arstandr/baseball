// lib/savant.js — Baseball Savant (Statcast) fetchers
//
// Savant doesn't publish a stable public JSON API, but its leaderboard +
// expected stats endpoints return CSV/JSON and are safe to hit at daily
// cadence from a single client. We pull:
//   - Pitcher Statcast leaderboard (SwStr%, xwOBA, spin, velocity)
//   - Individual pitcher player page JSON (rolling 30d / 14d splits)
//
// Umpire scorecards are deferred to V2 per DEC-009.

import { fetch } from './http.js'

const BASE = 'https://baseballsavant.mlb.com'

/**
 * Pitcher leaderboard (season stats) — used for SwStr%, Hard%, xERA.
 * Returns a map keyed by MLB player_id.
 *
 * Endpoint: /leaderboard/custom
 * We use the "expected_statistics" leaderboard which exposes SwStr%, Whiff%,
 * xwOBA, xERA, GB%, BB%, K% in one payload.
 */
export async function fetchPitcherStatcastLeaderboard(season) {
  const url = `${BASE}/leaderboard/custom`
  const res = await fetch('savant.leaderboard', {
    method: 'GET',
    url,
    params: {
      year: season,
      type: 'pitcher',
      filter: '',
      sort: 'pitches',
      sortDir: 'desc',
      min: 50,
      selections:
        'p_game,player_age,pitch_count,swing_miss_percent,whiff_percent,xera,xwoba,hard_hit_percent,gb_percent,fb_percent,ld_percent,k_percent,bb_percent,first_pitch_strike_percent,zone_percent,release_speed_avg,effective_speed_avg',
      chart: false,
      x: 'player_name',
      y: 'swing_miss_percent',
      r: 'no',
      chartType: 'beeswarm',
      csv: true,
    },
  })
  if (!res.ok) return {}
  // Savant returns CSV with header row; parse defensively
  const rows = parseCsv(res.data)
  const out = {}
  for (const row of rows) {
    const pid = String(row.player_id || row.mlbam_id || '')
    if (!pid) continue
    out[pid] = {
      player_id: pid,
      name: row.player_name,
      age: Number(row.player_age) || null,
      pitches: Number(row.pitch_count) || 0,
      swstr_pct: numPct(row.swing_miss_percent),
      whiff_pct: numPct(row.whiff_percent),
      xera: Number(row.xera) || null,
      xwoba: Number(row.xwoba) || null,
      hard_contact_pct: numPct(row.hard_hit_percent),
      gb_pct: numPct(row.gb_percent),
      fb_pct: numPct(row.fb_percent),
      ld_pct: numPct(row.ld_percent),
      k_pct: numPct(row.k_percent),
      bb_pct: numPct(row.bb_percent),
      fstrike_pct: numPct(row.first_pitch_strike_percent),
      zone_pct: numPct(row.zone_percent),
      release_speed: Number(row.release_speed_avg) || null,
      effective_speed: Number(row.effective_speed_avg) || null,
    }
  }
  return out
}

function numPct(v) {
  if (v == null || v === '') return null
  const n = Number(v)
  if (Number.isNaN(n)) return null
  // Savant sometimes returns 0-1, sometimes 0-100. Normalise to 0-1.
  return n > 1.5 ? n / 100 : n
}

/**
 * Pull recency-weighted splits from the pitcher's Savant profile page.
 * Returns `{ last_14: {...}, last_30: {...}, season: {...} }` or `null`.
 *
 * Uses the public JSON endpoint at /player-services/statcast.
 */
export async function fetchPitcherRollingSplits(pitcherId) {
  const res = await fetch('savant.rolling', {
    method: 'GET',
    url: `${BASE}/player-services/statcast`,
    params: {
      playerId: pitcherId,
      gameType: 'R',
      position: 'pitcher',
    },
  })
  if (!res.ok) return null
  return res.data || null
}

/**
 * DEFERRED TO V2 — stub as documented in DEC-009.
 */
export async function fetchUmpireScorecard(_gameId) {
  return null
}

// ------------------------------------------------------------------
// Tiny CSV parser (handles Savant's quoted headers)
// ------------------------------------------------------------------
function parseCsv(text) {
  if (!text || typeof text !== 'string') return []
  const lines = text.trim().split(/\r?\n/)
  if (lines.length < 2) return []
  const headers = splitCsvLine(lines[0])
  return lines.slice(1).map(line => {
    const cells = splitCsvLine(line)
    const row = {}
    for (let i = 0; i < headers.length; i++) {
      row[headers[i]] = cells[i]
    }
    return row
  })
}

function splitCsvLine(line) {
  const out = []
  let cur = ''
  let inQuote = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') {
        cur += '"'
        i++
      } else {
        inQuote = !inQuote
      }
    } else if (ch === ',' && !inQuote) {
      out.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  out.push(cur)
  return out
}
