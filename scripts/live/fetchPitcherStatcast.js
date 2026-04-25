// scripts/live/fetchPitcherStatcast.js — Daily Baseball Savant pitcher stat refresh.
//
// Fetches season-to-date Statcast metrics from Baseball Savant (baseballsavant.mlb.com)
// for every pitcher with ≥ MIN_IP innings in the current season and upserts into
// the pitcher_statcast table.  Runs in ~1 second (single HTTP call, CSV response).
//
// Key fields stored:
//   whiff_pct  — Whiff% (swings & misses / swings). Direct Statcast equivalent of
//                FanGraphs SwStr%. Leading K predictor; more stable than K/9 because
//                it measures stuff quality, not strikeout luck.
//   k_pct      — Season K% (K/PA). Actual outcome rate.
//   fb_velo    — Fastball velocity. Velocity drop mid-season = early injury/fatigue signal.
//   gb_pct     — Ground ball %. Low GB% = more fly balls = more HR risk.
//   bb_pct     — Walk rate. Pairs with K% for dominance profile.
//
// Note: player_id from Savant IS the MLB player ID (xMLBAMID) — no mapping needed.
//
// Usage:
//   node scripts/live/fetchPitcherStatcast.js [--season YYYY] [--min-ip N] [--dry-run]
//
// Consumed by: scripts/live/strikeoutEdge.js (λ blending)

import 'dotenv/config'
import axios from 'axios'
import { parse as csvParse } from 'csv-parse/sync'
import * as db from '../../lib/db.js'

const args = process.argv.slice(2)
const SEASON  = args.includes('--season')  ? Number(args[args.indexOf('--season')  + 1]) : new Date().getFullYear()
const MIN_IP  = args.includes('--min-ip')  ? Number(args[args.indexOf('--min-ip')  + 1]) : 5
const DRY_RUN = args.includes('--dry-run')

// Baseball Savant custom leaderboard — CSV export (no auth, no Cloudflare challenge)
const SAVANT_URL = 'https://baseballsavant.mlb.com/leaderboard/custom'

const SAVANT_PARAMS = {
  year: SEASON,
  type: 'pitcher',
  filter: '',
  min: MIN_IP,
  selections: 'k_percent,whiff_percent,fastball_avg_speed,fastball_avg_spin,groundballs_percent,bb_percent,pa,p_formatted_ip',
  csv: 'true',
}

// Separate params for LHB and RHB splits — opponent_bat_side filter
const SAVANT_PARAMS_VS_L = { ...SAVANT_PARAMS, opponent_bat_side: 'L' }
const SAVANT_PARAMS_VS_R = { ...SAVANT_PARAMS, opponent_bat_side: 'R' }

// Parse "16.1" baseball IP notation → decimal innings (e.g. 16.1 → 16⅓ → 16.33)
function parseIpField(raw) {
  const s = String(raw || '').trim().replace(/"/g, '')
  if (!s || s === '') return null
  const n = parseFloat(s)
  if (isNaN(n)) return null
  const whole = Math.floor(n)
  const frac = Math.round((n % 1) * 10)  // 0, 1, or 2 partial outs
  return whole + frac / 3
}

function parseNum(v) {
  if (v == null || v === '' || v === '"' ) return null
  const n = Number(String(v).replace(/"/g, '').trim())
  return isNaN(n) ? null : n
}

function mapRow(r) {
  const ipDecimal = parseIpField(r['p_formatted_ip'])
  if (ipDecimal !== null && ipDecimal < MIN_IP) return null  // double-check filter

  const raw_k    = parseNum(r['k_percent'])
  const raw_whiff = parseNum(r['whiff_percent'])
  const raw_fbv  = parseNum(r['fastball_avg_speed'])
  const raw_spin = parseNum(r['fastball_avg_spin'])
  const raw_gb   = parseNum(r['groundballs_percent'])
  const raw_bb   = parseNum(r['bb_percent'])
  const raw_pa   = parseNum(r['pa'])

  return {
    player_id:   r['player_id'] ? String(r['player_id']).trim() : null,
    player_name: (() => {
      // Savant returns "Last, First" — normalize to "First Last"
      const raw = (r['last_name, first_name'] || '').replace(/"/g, '').trim()
      const parts = raw.split(',').map(s => s.trim())
      return parts.length === 2 ? `${parts[1]} ${parts[0]}` : raw
    })(),
    ip:          ipDecimal,
    k_pct:       raw_k   != null ? raw_k   / 100 : null,   // Savant gives 0-100, store as 0-1
    swstr_pct:   raw_whiff != null ? raw_whiff / 100 : null,
    fb_velo:     raw_fbv,
    fb_spin:     raw_spin,    // fastball spin rate (RPM) — spin drop signals injury/fatigue
    gb_pct:      raw_gb  != null ? raw_gb   / 100 : null,
    bb_pct:      raw_bb  != null ? raw_bb   / 100 : null,
    pa:          raw_pa,
  }
}

// mapRow for split data — only extracts k_pct and pa (other columns not available in split views)
function mapSplitRow(r) {
  const pid     = r['player_id'] ? String(r['player_id']).trim() : null
  const raw_k   = parseNum(r['k_percent'])
  const raw_pa  = parseNum(r['pa'])
  if (!pid) return null
  return {
    player_id: pid,
    k_pct:     raw_k  != null ? raw_k  / 100 : null,
    pa:        raw_pa,
  }
}

async function main() {
  await db.migrate()

  // Safe column additions — no-ops if already exist
  for (const col of ['fb_spin REAL', 'k_pct_vs_l REAL', 'k_pct_vs_r REAL']) {
    await db.run(`ALTER TABLE pitcher_statcast ADD COLUMN ${col}`).catch(() => {})
  }

  console.log(`[statcast] Fetching Baseball Savant pitcher data — season=${SEASON} min_ip=${MIN_IP}`)

  let rows
  try {
    const res = await axios.get(SAVANT_URL, {
      params: SAVANT_PARAMS,
      timeout: 20000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'text/csv,text/plain,*/*',
      },
      responseType: 'text',
      validateStatus: s => s >= 200 && s < 500,
    })
    if (res.status >= 400) throw new Error(`HTTP ${res.status}`)

    const csv = res.data
    if (!csv || !csv.includes(',')) throw new Error('unexpected response shape')

    // Strip BOM if present
    const clean = csv.replace(/^\uFEFF/, '')
    rows = csvParse(clean, { columns: true, skip_empty_lines: true, relax_quotes: true })
    if (!Array.isArray(rows)) throw new Error('csv parse failed')
  } catch (err) {
    // Non-fatal: stale DB data from yesterday is better than killing the whole pipeline.
    // dailyRun.sh has set -e; exiting 1 would abort all downstream steps (no bets placed).
    console.error(`[statcast] ⚠ Savant fetch failed: ${err.message}`)
    console.error(`[statcast] Continuing with stale data from last successful fetch.`)
    process.exit(0)
  }

  console.log(`[statcast] ${rows.length} rows returned from Savant`)

  const today = new Date().toISOString().slice(0, 10)
  let saved = 0
  let skipped = 0

  for (const r of rows) {
    const row = mapRow(r)
    if (!row || !row.player_id) { skipped++; continue }

    row.season     = SEASON
    row.fetch_date = today

    if (DRY_RUN) {
      if (saved < 5) console.log('  dry-run:', row.player_name, row)
      saved++
      continue
    }

    await db.upsert('pitcher_statcast', row, ['player_id', 'season', 'fetch_date'])
    saved++
  }

  console.log(`[statcast] saved=${saved} skipped=${skipped}`)

  // ── Fetch K% splits vs LHB and RHB ──────────────────────────────────────
  // These are stored as k_pct_vs_l / k_pct_vs_r in the same pitcher_statcast row.
  // Having split K% lets strikeoutEdge.js weight by the actual handedness mix of the lineup.
  if (!DRY_RUN) {
    console.log('[statcast] Fetching handedness splits (vs LHB / vs RHB)…')

    async function fetchSplitData(params, side) {
      try {
        const res = await axios.get(SAVANT_URL, {
          params,
          timeout: 20000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
            'Accept': 'text/csv,text/plain,*/*',
          },
          responseType: 'text',
          validateStatus: s => s >= 200 && s < 500,
        })
        if (res.status >= 400) { console.warn(`[statcast] splits ${side}: HTTP ${res.status}`); return [] }
        const clean = res.data.replace(/^﻿/, '')
        const splitRows = csvParse(clean, { columns: true, skip_empty_lines: true, relax_quotes: true })
        return splitRows.map(r => ({ ...mapSplitRow(r), vs_hand: side })).filter(r => r.player_id)
      } catch (err) {
        console.warn(`[statcast] splits ${side} failed: ${err.message}`)
        return []
      }
    }

    const [vsL, vsR] = await Promise.all([
      fetchSplitData(SAVANT_PARAMS_VS_L, 'L'),
      fetchSplitData(SAVANT_PARAMS_VS_R, 'R'),
    ])

    // Build maps for O(1) lookup
    const vsLMap = new Map(vsL.map(r => [r.player_id, r.k_pct]))
    const vsRMap = new Map(vsR.map(r => [r.player_id, r.k_pct]))

    let splitsSaved = 0
    for (const [pid, kL] of vsLMap) {
      const kR = vsRMap.get(pid)
      if (kL == null && kR == null) continue
      await db.run(
        `UPDATE pitcher_statcast SET k_pct_vs_l=?, k_pct_vs_r=?
         WHERE player_id=? AND season=? AND fetch_date=?`,
        [kL ?? null, kR ?? null, pid, SEASON, today],
      )
      splitsSaved++
    }
    // Any RHB-only entries
    for (const [pid, kR] of vsRMap) {
      if (vsLMap.has(pid)) continue
      if (kR == null) continue
      await db.run(
        `UPDATE pitcher_statcast SET k_pct_vs_r=? WHERE player_id=? AND season=? AND fetch_date=?`,
        [kR, pid, SEASON, today],
      )
      splitsSaved++
    }
    console.log(`[statcast] handedness splits saved for ${splitsSaved} pitchers`)
  }

  // Print top K% pitchers summary
  if (!DRY_RUN) {
    const top = await db.all(
      `SELECT player_name, k_pct, swstr_pct, fb_velo, gb_pct, ip
         FROM pitcher_statcast
        WHERE season = ? AND fetch_date = ?
        ORDER BY k_pct DESC LIMIT 10`,
      [SEASON, today],
    )
    console.log('\nTop K% starters today:')
    for (const p of top) {
      console.log(
        `  ${(p.player_name || '?').padEnd(22)}` +
        `  K%=${p.k_pct != null ? (p.k_pct*100).toFixed(1)+'%' : 'n/a'}` +
        `  Whiff%=${p.swstr_pct != null ? (p.swstr_pct*100).toFixed(1)+'%' : 'n/a'}` +
        `  FBv=${p.fb_velo != null ? p.fb_velo.toFixed(1) : 'n/a'}` +
        `  IP=${p.ip != null ? p.ip.toFixed(1) : 'n/a'}`
      )
    }
  }

  await db.close()
}

main().catch(err => {
  console.error('[statcast] fatal:', err.message)
  process.exit(1)
})
