#!/usr/bin/env node
// histBacktestPkModel.js — historical pK model backtest using 2022-2025 data.
//
// Uses historical_pitcher_stats (rolling end-of-season L5 stats) joined with
// pitcher_statcast (season totals: whiff%, velo, splits) to train a Ridge
// regression on 2022-2024 seasons and test on 2025.
//
// Target: k_pct_l5 (actual K% per BF over last 5 starts, end of each season)
// This is a genuine out-of-sample test because train/test are different seasons.
//
// Usage:
//   node scripts/live/histBacktestPkModel.js
//   node scripts/live/histBacktestPkModel.js --dry-run

import 'dotenv/config'
import * as db from '../../lib/db.js'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT      = path.join(__dirname, '../../')
const TMP       = '/tmp/shadow_pk_hist'
const MODEL_DEST = path.join(ROOT, 'models/pk_ridge_weights.json')
const DRY_RUN = process.argv.includes('--dry-run')

const LEAGUE_PA_PER_IP = 4.3
const TRAIN_SEASONS = [2022, 2023, 2024]
const TEST_SEASON   = 2025

// ── Fetch last-date-per-pitcher-season joined with Statcast ──────────────────
// libSQL CTE picks MAX(as_of_date) per pitcher+season, then joins pitcher_statcast.
// Statcast uses latest fetch_date per player+season.
async function fetchHistRows(seasons) {
  const seasonList = seasons.join(',')

  // Step 1: get last as_of_date per pitcher per season
  const lastDates = await db.all(`
    SELECT pitcher_id, season, MAX(as_of_date) AS last_date
    FROM historical_pitcher_stats
    WHERE season IN (${seasonList})
      AND k_pct_l5 IS NOT NULL
      AND avg_innings_l5 IS NOT NULL
      AND avg_innings_l5 > 1
    GROUP BY pitcher_id, season
  `)
  if (!lastDates.length) return []

  // Step 2: fetch the actual rows for those dates
  // Build lookup for fast filter
  const lookup = new Set(lastDates.map(r => `${r.pitcher_id}|${r.season}|${r.last_date}`))

  // Batch: fetch all HPS rows for those seasons, then filter in JS
  const hpsRows = await db.all(`
    SELECT pitcher_id, pitcher_name, season, as_of_date,
           k9_l5, bb9_l5, k_pct_l5, avg_innings_l5, early_exit_rate_l5, days_rest
    FROM historical_pitcher_stats
    WHERE season IN (${seasonList})
      AND k_pct_l5 IS NOT NULL
      AND avg_innings_l5 IS NOT NULL
      AND avg_innings_l5 > 1
  `)
  const canonical = hpsRows.filter(r => lookup.has(`${r.pitcher_id}|${r.season}|${r.as_of_date}`))

  // Step 3: fetch Statcast (latest fetch per player+season)
  const scLastDates = await db.all(`
    SELECT player_id, season, MAX(fetch_date) AS last_fetch
    FROM pitcher_statcast
    WHERE season IN (${seasonList})
    GROUP BY player_id, season
  `)
  const scLookup = new Map(scLastDates.map(r => [`${r.player_id}|${r.season}`, r.last_fetch]))

  const scRows = await db.all(`
    SELECT player_id, season, fetch_date,
           k_pct, bb_pct, swstr_pct, fb_velo, gb_pct,
           k_pct_vs_l, k_pct_vs_r, ip, pa, manager_leash_factor
    FROM pitcher_statcast
    WHERE season IN (${seasonList})
  `)
  // Index by player_id|season|fetch_date
  const scMap = new Map()
  for (const sc of scRows) {
    const key = `${sc.player_id}|${sc.season}`
    const wantFetch = scLookup.get(key)
    if (sc.fetch_date === wantFetch) scMap.set(key, sc)
  }

  // Step 4: join
  return canonical.map(h => {
    const sc = scMap.get(`${h.pitcher_id}|${h.season}`) ?? {}
    return { ...h, ...sc, player_id: undefined }
  })
}

// ── Write CSV ─────────────────────────────────────────────────────────────────
function writeCSV(filePath, rows) {
  const headers = [
    'pitcher_id', 'pitcher_name', 'season', 'as_of_date',
    // L5 rolling signals (from historical_pitcher_stats)
    'k9_l5', 'bb9_l5', 'avg_innings_l5', 'early_exit_rate_l5', 'days_rest',
    // Statcast season signals
    'savant_k_pct', 'savant_whiff', 'savant_fbv', 'savant_gb_pct',
    'savant_bb_pct', 'k_pct_vs_l', 'k_pct_vs_r', 'savant_ip', 'savant_pa',
    'manager_leash_factor',
    // Expected BF (for sample weighting)
    'expected_bf',
    // Target
    'target_pK',
  ]

  const lines = [headers.join(',')]
  let written = 0, skipped = 0

  for (const r of rows) {
    const target_pK = Math.min(0.55, Math.max(0.05, r.k_pct_l5))
    const expected_bf = (r.avg_innings_l5 ?? 5.0) * LEAGUE_PA_PER_IP

    const row = [
      `"${r.pitcher_id}"`, `"${r.pitcher_name ?? ''}"`, r.season, `"${r.as_of_date}"`,
      r.k9_l5 ?? '', r.bb9_l5 ?? '', r.avg_innings_l5 ?? '', r.early_exit_rate_l5 ?? '', r.days_rest ?? '',
      r.k_pct ?? '', r.swstr_pct ?? '', r.fb_velo ?? '', r.gb_pct ?? '',
      r.bb_pct ?? '', r.k_pct_vs_l ?? '', r.k_pct_vs_r ?? '', r.ip ?? '', r.pa ?? '',
      r.manager_leash_factor ?? '',
      expected_bf.toFixed(2),
      target_pK.toFixed(4),
    ]
    lines.push(row.join(','))
    written++
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, lines.join('\n') + '\n')
  return { written, skipped }
}

// ── Print comparison report ───────────────────────────────────────────────────
function printReport(testRows, preds) {
  const predMap = new Map(preds.map(p => [`${p.pitcher_id}|${p.season}`, p]))

  // Errors: ML vs baseline (just savant_k_pct or k9_l5/(PA/IP×9))
  let mlSumSqErr = 0, baseSumSqErr = 0, n = 0
  const errors = []

  for (const r of testRows) {
    const key = `${r.pitcher_id}|${r.season}`
    const pred = predMap.get(key)
    if (!pred) continue

    const actual = r.k_pct_l5
    if (actual == null) continue

    const ml_pred = pred.predicted_pK
    // Baseline 1: just use Statcast season K%
    const base_pred = r.k_pct ?? (r.k9_l5 / (LEAGUE_PA_PER_IP * 9)) ?? 0.22

    mlSumSqErr   += (ml_pred - actual) ** 2
    baseSumSqErr += (base_pred - actual) ** 2
    n++

    const ml_err   = Math.abs(ml_pred - actual)
    const base_err = Math.abs(base_pred - actual)
    errors.push({ name: r.pitcher_name, actual, ml_pred, base_pred, ml_err, base_err, gain: base_err - ml_err })
  }

  const ml_mae   = errors.reduce((s, e) => s + e.ml_err, 0) / n
  const base_mae = errors.reduce((s, e) => s + e.base_err, 0) / n
  const totalSS  = errors.reduce((s, e) => s + (e.actual - errors.reduce((a, b) => a + b.actual, 0) / n) ** 2, 0)
  const ml_r2    = 1 - mlSumSqErr / totalSS
  const base_r2  = 1 - baseSumSqErr / totalSS

  // Top 10 most improved / most degraded
  errors.sort((a, b) => b.gain - a.gain)
  const improved  = errors.slice(0, 8)
  const degraded  = errors.slice(-5)

  const lines = []
  lines.push('\n═══════════════════════════════════════════════════════════════')
  lines.push(` HISTORICAL pK MODEL BACKTEST — train: 2022-2024  test: 2025`)
  lines.push(`═══════════════════════════════════════════════════════════════`)
  lines.push(`\n Pitchers in test set: ${n}`)
  lines.push(`\n           R²       MAE`)
  lines.push(` Baseline: ${base_r2.toFixed(3)}   ${(base_mae*100).toFixed(2)}%   (just Statcast season K%)`)
  lines.push(` ML Ridge: ${ml_r2.toFixed(3)}   ${(ml_mae*100).toFixed(2)}%   (trained on all signals)`)
  lines.push(` Improvement: ${((base_mae - ml_mae)*100).toFixed(2)}% MAE reduction`)
  lines.push(`\n CV R²: ${preds[0]?.cv_r2?.toFixed(3) ?? '?'}`)

  lines.push(`\n Top pitchers ML improved (vs baseline):`)
  for (const e of improved) {
    const dir = e.gain >= 0 ? '✓' : '✗'
    lines.push(`  ${dir} ${e.name.padEnd(22)} actual=${(e.actual*100).toFixed(1)}%  ml=${(e.ml_pred*100).toFixed(1)}%  base=${(e.base_pred*100).toFixed(1)}%  gain=${(e.gain*100).toFixed(2)}%`)
  }

  lines.push(`\n Pitchers ML hurt most (vs baseline):`)
  for (const e of degraded) {
    lines.push(`  ✗ ${e.name.padEnd(22)} actual=${(e.actual*100).toFixed(1)}%  ml=${(e.ml_pred*100).toFixed(1)}%  base=${(e.base_pred*100).toFixed(1)}%  gain=${(e.gain*100).toFixed(2)}%`)
  }

  lines.push('\n═══════════════════════════════════════════════════════════════\n')
  console.log(lines.join('\n'))
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('[hist-pk] Fetching training rows (2022-2024)…')
  const trainRows = await fetchHistRows(TRAIN_SEASONS)
  console.log(`[hist-pk] Training rows: ${trainRows.length}`)

  console.log('[hist-pk] Fetching test rows (2025)…')
  const testRows = await fetchHistRows([TEST_SEASON])
  console.log(`[hist-pk] Test rows:     ${testRows.length}`)

  if (DRY_RUN) {
    const scHit = trainRows.filter(r => r.k_pct != null).length
    console.log(`[hist-pk] --dry-run: ${trainRows.length} train, ${testRows.length} test, Statcast hit rate: ${(scHit/trainRows.length*100).toFixed(1)}%`)
    process.exit(0)
  }

  if (trainRows.length < 100) {
    console.error(`[hist-pk] Not enough training data (${trainRows.length} rows). Exiting.`)
    process.exit(1)
  }

  fs.mkdirSync(TMP, { recursive: true })
  const trainPath = path.join(TMP, 'train.csv')
  const testPath  = path.join(TMP, 'test.csv')
  const predPath  = path.join(TMP, 'predictions.json')

  const { written: tw } = writeCSV(trainPath, trainRows)
  const { written: ew } = writeCSV(testPath, testRows)
  console.log(`[hist-pk] train.csv: ${tw} rows  test.csv: ${ew} rows`)

  const pyScript = path.join(__dirname, 'shadowTestPkModel.py')
  console.log('[hist-pk] Running Python trainer…')
  const result = spawnSync(
    'python3', [pyScript, trainPath, testPath, predPath],
    { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 120_000 },
  )

  if (result.stderr) process.stderr.write(result.stderr)
  if (result.status !== 0) {
    console.error(`[hist-pk] Python exited ${result.status}`)
    if (result.stdout) console.error(result.stdout)
    process.exit(1)
  }

  const preds = JSON.parse(fs.readFileSync(predPath, 'utf8'))
  console.log(`[hist-pk] Predictions: ${preds.length}`)

  // Copy model weights to models/ for runtime use by strikeoutEdge.js
  const srcModel = path.join(TMP, 'model.json')
  if (fs.existsSync(srcModel)) {
    fs.mkdirSync(path.dirname(MODEL_DEST), { recursive: true })
    fs.copyFileSync(srcModel, MODEL_DEST)
    console.log(`[hist-pk] Model weights saved → ${MODEL_DEST}`)
  }

  printReport(testRows, preds)
}

main().catch(err => {
  console.error('[hist-pk] Fatal:', err)
  process.exit(1)
})
