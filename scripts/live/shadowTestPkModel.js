#!/usr/bin/env node
// shadowTestPkModel.js — shadow pK backtest: train Ridge on settled bets, score this week.
//
// Usage:
//   node scripts/live/shadowTestPkModel.js                 (defaults: train=before this week, test=this week)
//   node scripts/live/shadowTestPkModel.js --train-end 2026-04-13 --test-start 2026-04-14 --test-end 2026-04-20
//   node scripts/live/shadowTestPkModel.js --dry-run       (SQL only, no Python)
//
// What it does:
//   1. Queries ks_bets (deduped to one row per pitcher/date) with all feature columns
//   2. Reconstructs expected_BF from pitcher_recent_starts (avg of last 5 starts with bf>0)
//   3. Exports train.csv / test.csv to /tmp/shadow_pk/
//   4. Spawns shadowTestPkModel.py (Ridge regression)
//   5. Reads predictions.json back; reconstructs new_lambda
//   6. Replays bet selection gates to count how many bets change
//   7. Prints a P&L comparison report (flat $100/bet hypothetical)

import 'dotenv/config'
import * as db from '../../lib/db.js'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TMP = '/tmp/shadow_pk'

// ── CLI args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : null
}
const DRY_RUN = args.includes('--dry-run')

// Default: this week = Mon–Sun of the current ISO week
function isoWeekBounds(offsetWeeks = 0) {
  const now = new Date()
  const dow = (now.getUTCDay() + 6) % 7  // Mon=0 … Sun=6
  const mon = new Date(now)
  mon.setUTCDate(now.getUTCDate() - dow + offsetWeeks * 7)
  const sun = new Date(mon)
  sun.setUTCDate(mon.getUTCDate() + 6)
  const fmt = d => d.toISOString().slice(0, 10)
  return { start: fmt(mon), end: fmt(sun) }
}

const thisWeek = isoWeekBounds(0)
const TEST_START = flag('--test-start')  || thisWeek.start
const TEST_END   = flag('--test-end')    || thisWeek.end
const TRAIN_END  = flag('--train-end')   || new Date(new Date(TEST_START) - 86400000).toISOString().slice(0, 10)

console.log(`[shadow-pk] train: up to ${TRAIN_END}  |  test: ${TEST_START} → ${TEST_END}`)

// ── Gate constants (mirror ksBets.js) ────────────────────────────────────────
const MIN_EDGE_FLOOR  = 0.04
const YES_MIN_PROB    = 0.25
const YES_MIN_EDGE    = 0.12
const NO_MIN_EDGE     = 0.12
const LEAGUE_K_PCT    = 0.225   // fallback opp K% when opp_k_pct is null
const LEAGUE_PA_PER_IP = 4.3

// ── SQL: one canonical row per (pitcher_id, bet_date) ────────────────────────
// libSQL has no ROW_NUMBER, so we use MIN(id) to pick the first row per pitcher/date.
// All multipliers (park, weather, ump, velo, split/opp adj) are taken from that row.
// actual_ks is taken from the first settled row for the pitcher that day.
const FEATURE_COLS = `
  b.pitcher_id,
  b.pitcher_name,
  b.bet_date,
  b.k9_career,
  b.k9_season,
  b.k9_l5,
  b.savant_k_pct,
  b.savant_whiff,
  b.savant_fbv,
  b.opp_k_pct,
  b.adj_factor,
  b.n_starts,
  b.lambda,
  b.velo_adj,
  b.bb_penalty,
  b.tto_penalty,
  b.split_adj,
  b.opp_adj,
  b.park_factor,
  b.weather_mult,
  b.ump_factor,
  b.raw_adj_factor,
  b.actual_ks
`.trim()

// Columns stored differently: split_adj and tto_penalty are in ks_bets as of the
// schema at line 67 (ksBets.js). opp_adj = adj_factor after effectiveAdj clamping —
// but ks_bets stores adj_factor (raw) and raw_adj_factor (pre-clamp).
// We'll use adj_factor as effectiveAdj proxy.

async function fetchRows(dateFilter) {
  // Dedup: MIN(id) picks first bet logged for pitcher+date. We need actual_ks from
  // any settled row (result IN ('win','loss')) for that pitcher+date.
  const rows = await db.all(`
    WITH canonical AS (
      SELECT MIN(id) AS cid, pitcher_id, bet_date
      FROM ks_bets
      WHERE live_bet = 0
        AND paper = 0
        AND pitcher_id IS NOT NULL
        AND result IS NOT 'void'
        ${dateFilter}
      GROUP BY pitcher_id, bet_date
    ),
    actual AS (
      SELECT pitcher_id, bet_date, actual_ks
      FROM ks_bets
      WHERE actual_ks IS NOT NULL
        AND result IN ('win','loss')
        AND live_bet = 0
        AND paper = 0
      GROUP BY pitcher_id, bet_date
    )
    SELECT
      b.pitcher_id,
      b.pitcher_name,
      b.bet_date,
      b.k9_career,
      b.k9_season,
      b.k9_l5,
      b.savant_k_pct,
      b.savant_whiff,
      b.savant_fbv,
      b.opp_k_pct,
      b.adj_factor,
      b.n_starts,
      b.lambda,
      b.velo_adj,
      b.bb_penalty,
      b.raw_adj_factor,
      b.park_factor,
      b.weather_mult,
      b.ump_factor,
      a.actual_ks
    FROM canonical c
    JOIN ks_bets b ON b.id = c.cid
    LEFT JOIN actual a ON a.pitcher_id = c.pitcher_id AND a.bet_date = c.bet_date
  `)
  return rows
}

// ── expected_BF: avg of last 5 starts with bf > 0 before bet_date ────────────
// Fetches all pitcher_recent_starts for relevant pitchers in one query,
// then filters/ranks in JS (avoids ROW_NUMBER and VALUES table — libSQL limits).
async function buildExpectedBF(rows) {
  if (!rows.length) return new Map()

  const pitcherIds = [...new Set(rows.map(r => r.pitcher_id).filter(Boolean))]
  const idList = pitcherIds.map(id => `'${id}'`).join(',')

  const starts = await db.all(
    `SELECT pitcher_id, game_date, bf
     FROM pitcher_recent_starts
     WHERE pitcher_id IN (${idList}) AND bf > 0
     ORDER BY pitcher_id, game_date DESC`,
  )

  // Group by pitcher_id
  const byPitcher = new Map()
  for (const s of starts) {
    if (!byPitcher.has(s.pitcher_id)) byPitcher.set(s.pitcher_id, [])
    byPitcher.get(s.pitcher_id).push(s)
  }

  const map = new Map()
  for (const row of rows) {
    const key = `${row.pitcher_id}|${row.bet_date}`
    if (map.has(key)) continue
    const allStarts = byPitcher.get(row.pitcher_id) || []
    // Last 5 starts strictly before bet_date
    const eligible = allStarts.filter(s => s.game_date < row.bet_date).slice(0, 5)
    if (!eligible.length) continue
    const avg_bf = eligible.reduce((s, r) => s + r.bf, 0) / eligible.length
    map.set(key, { avg_bf, n_starts_bf: eligible.length })
  }
  return map
}

// ── Write CSV ─────────────────────────────────────────────────────────────────
function writeCSV(filePath, rows, bfMap, includeTarget) {
  const headers = [
    'pitcher_id', 'pitcher_name', 'bet_date',
    'k9_career', 'k9_season', 'k9_l5',
    'savant_k_pct', 'savant_whiff', 'savant_fbv',
    'opp_k_pct', 'adj_factor', 'n_starts',
    'velo_adj', 'bb_penalty', 'raw_adj_factor',
    'park_factor', 'weather_mult', 'ump_factor',
    'lambda', 'expected_bf', 'n_starts_bf',
  ]
  if (includeTarget) headers.push('actual_ks', 'actual_pK')

  const lines = [headers.join(',')]
  let written = 0, skipped = 0

  for (const r of rows) {
    const key = `${r.pitcher_id}|${r.bet_date}`
    const bf = bfMap.get(key)
    const expected_bf = bf?.avg_bf ?? null
    const n_starts_bf = bf?.n_starts_bf ?? 0

    // For training rows: skip if no actual_ks or no expected_bf
    if (includeTarget && (r.actual_ks == null || expected_bf == null)) {
      skipped++
      continue
    }

    const actual_pK = includeTarget && expected_bf
      ? Math.min(0.55, Math.max(0.05, r.actual_ks / expected_bf))
      : null

    const row = [
      `"${r.pitcher_id}"`, `"${r.pitcher_name}"`, `"${r.bet_date}"`,
      r.k9_career ?? '', r.k9_season ?? '', r.k9_l5 ?? '',
      r.savant_k_pct ?? '', r.savant_whiff ?? '', r.savant_fbv ?? '',
      r.opp_k_pct ?? '', r.adj_factor ?? '', r.n_starts ?? '',
      r.velo_adj ?? '', r.bb_penalty ?? '', r.raw_adj_factor ?? '',
      r.park_factor ?? '', r.weather_mult ?? '', r.ump_factor ?? '',
      r.lambda ?? '', expected_bf ?? '', n_starts_bf,
    ]
    if (includeTarget) row.push(r.actual_ks ?? '', actual_pK ?? '')
    lines.push(row.join(','))
    written++
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, lines.join('\n') + '\n')
  return { written, skipped }
}

// ── Reconstruct new_lambda from predicted pK ──────────────────────────────────
// lambda = predicted_pK × expected_bf × (park × weather × ump × velo × effectiveAdj × bbPenalty)
// We keep all external multipliers unchanged; only pK_blended is replaced.
function buildNewLambda(row, predicted_pK, expected_bf) {
  const park    = row.park_factor    ?? 1.0
  const weather = row.weather_mult   ?? 1.0
  const ump     = row.ump_factor     ?? 1.0
  const velo    = row.velo_adj       ?? 1.0
  const effAdj  = row.adj_factor     ?? 1.0
  const bb      = row.bb_penalty     ?? 1.0
  // tto_penalty: not stored in ks_bets — extracted from original lambda
  // lambda = pK_blended × expected_bf × velo × bb × tto × effAdj × park × weather × ump
  // tto_penalty = lambda / (pK_blended × expected_bf × velo × bb × effAdj × park × weather × ump)
  let tto = 1.0
  if (row.lambda && expected_bf) {
    const pK_orig = row.savant_k_pct ?? (row.k9_season / (LEAGUE_PA_PER_IP * 9)) ?? 0.22
    const denom = pK_orig * expected_bf * velo * bb * effAdj * park * weather * ump
    if (denom > 0) tto = Math.min(1.0, Math.max(0.7, row.lambda / denom))
  }
  return predicted_pK * expected_bf * velo * bb * tto * effAdj * park * weather * ump
}

// ── Model prob from lambda (Poisson P(K >= n)) ────────────────────────────────
function poissonCDF(lambda, k) {
  // P(X <= k) via recursion
  let p = Math.exp(-lambda), cum = p
  for (let i = 1; i <= k; i++) {
    p *= lambda / i
    cum += p
  }
  return cum
}
function modelProb(lambda, strike) {
  return 1 - poissonCDF(lambda, strike - 1)
}

// ── Bet gate (mirrors ksBets.js rules A, D, F) ───────────────────────────────
function passesGate(prob, edge, side, market_mid) {
  if (Math.abs(edge) < MIN_EDGE_FLOOR) return false
  if (side === 'NO' && (market_mid ?? 50) >= 65 && prob >= 0.50) return false   // Rule A
  if (side === 'YES' && prob < YES_MIN_PROB && edge < 0.18) return false         // Rule D
  if (side === 'YES' && edge < YES_MIN_EDGE) return false
  if (side === 'NO'  && edge < NO_MIN_EDGE)  return false
  return true
}

// ── Fetch per-bet rows for test dates (for P&L replay) ────────────────────────
async function fetchTestBets(testDates) {
  if (!testDates.length) return []
  const dateIn = testDates.map(d => `'${d}'`).join(',')
  return db.all(`
    SELECT pitcher_id, pitcher_name, bet_date, strike, side,
           model_prob, market_mid, edge, lambda,
           actual_ks, result, pnl, bet_size
    FROM ks_bets
    WHERE bet_date IN (${dateIn})
      AND live_bet = 0 AND paper = 0
      AND result IS NOT 'void'
    ORDER BY bet_date, pitcher_id, strike
  `)
}

// ── Comparison report ─────────────────────────────────────────────────────────
function printReport(testRows, bfMap, preds, testBets) {
  const predMap = new Map(preds.map(p => [`${p.pitcher_id}|${p.bet_date}`, p]))

  const lines = []
  lines.push('\n═══════════════════════════════════════════════════════════════')
  lines.push(' SHADOW pK MODEL BACKTEST — ' + TEST_START + ' → ' + TEST_END)
  lines.push('═══════════════════════════════════════════════════════════════')

  // Per-pitcher lambda comparison
  for (const row of testRows) {
    const key = `${row.pitcher_id}|${row.bet_date}`
    const pred = predMap.get(key)
    const bf = bfMap.get(key)
    if (!pred || !bf?.avg_bf) continue

    const expected_bf = bf.avg_bf
    const new_lambda = buildNewLambda(row, pred.predicted_pK, expected_bf)
    const orig_lambda = row.lambda ?? (row.savant_k_pct ?? 0.22) * expected_bf
    const orig_pK = orig_lambda / expected_bf

    const pKdiff = (pred.predicted_pK - orig_pK) * 100
    const diffStr = pKdiff >= 0 ? `+${pKdiff.toFixed(1)}%` : `${pKdiff.toFixed(1)}%`
    const actual = row.actual_ks != null ? `actual=${row.actual_ks}K` : 'unsettled'

    lines.push(`\n  ${row.pitcher_name.padEnd(22)} ${row.bet_date}`)
    lines.push(`    pK:  prod=${(orig_pK*100).toFixed(1)}%  ml=${(pred.predicted_pK*100).toFixed(1)}%  Δ=${diffStr}`)
    lines.push(`    λ:   prod=${orig_lambda.toFixed(2)}  ml=${new_lambda.toFixed(2)}  ${actual}`)
  }

  // Per-bet P&L replay (only for settled bets with actual outcomes)
  let prodBets = 0, prodWins = 0, prodLosses = 0, prodPnl = 0
  let mlBets = 0, mlWins = 0, mlLosses = 0, mlPnl = 0
  let newBets = 0, droppedBets = 0

  const settledBets = testBets.filter(b => b.result === 'win' || b.result === 'loss')

  for (const b of settledBets) {
    const key = `${b.pitcher_id}|${b.bet_date}`
    const pred = predMap.get(key)
    const bf = bfMap.get(key)
    const market_mid = b.market_mid ?? 50

    // Production bet: what we actually placed
    prodBets++
    if (b.result === 'win') { prodWins++; prodPnl += (b.pnl ?? 0) }
    else { prodLosses++; prodPnl += (b.pnl ?? 0) }

    // ML shadow: what ML model would have bid on same market
    if (pred && bf?.avg_bf) {
      const new_lambda = buildNewLambda(b, pred.predicted_pK, bf.avg_bf)
      const ml_prob = modelProb(new_lambda, b.strike)
      const ml_edge = b.side === 'YES'
        ? ml_prob - market_mid / 100
        : (1 - ml_prob) - (1 - market_mid / 100)

      const prodWouldBet = true  // already bet (we're iterating settled bets)
      const mlWouldBet = passesGate(ml_prob, ml_edge, b.side, market_mid)

      if (mlWouldBet) {
        mlBets++
        const flatPnl = b.result === 'win'
          ? 100 * ((1 - market_mid / 100) / (market_mid / 100))
          : -100
        if (b.result === 'win') { mlWins++; mlPnl += flatPnl }
        else { mlLosses++; mlPnl += flatPnl }
      }

      if (!mlWouldBet) droppedBets++
    }
  }

  // Count ML-only bets (this would require scanning all markets, not just placed bets —
  // we can't reliably compute this without the full market snapshot, so we skip it)

  lines.push('\n───────────────────────────────────────────────────────────────')
  lines.push(' AGGREGATE COMPARISON (settled bets only, flat $100/bet)')
  lines.push('───────────────────────────────────────────────────────────────')

  if (settledBets.length === 0) {
    lines.push(' No settled bets in test window yet.')
  } else {
    const prodRoi = prodBets ? (prodPnl / (prodBets * 100) * 100).toFixed(1) : '—'
    const mlRoi   = mlBets   ? (mlPnl   / (mlBets   * 100) * 100).toFixed(1) : '—'
    lines.push(` Production: ${prodBets} bets  ${prodWins}W-${prodLosses}L  P&L=$${prodPnl.toFixed(2)}  ROI=${prodRoi}%`)
    lines.push(` ML shadow:  ${mlBets} bets  ${mlWins}W-${mlLosses}L  P&L=$${mlPnl.toFixed(2)}  ROI=${mlRoi}%`)
    lines.push(` Existing bets ML would DROP: ${droppedBets}  (of ${settledBets.length} placed)`)
    lines.push(` Note: new ML-only bets not counted (requires full market scan)`)
  }

  lines.push(`\n CV R²: ${preds[0]?.cv_r2?.toFixed(3) ?? '?'} — ${
    (preds[0]?.cv_r2 ?? 0) < 0
      ? 'negative (too little data — model defaulting near mean; need 4+ weeks of starts)'
      : (preds[0]?.cv_r2 ?? 0) < 0.10
        ? 'weak signal (keep collecting data)'
        : 'meaningful signal — model is learning'
  }`)
  lines.push('═══════════════════════════════════════════════════════════════\n')

  console.log(lines.join('\n'))
}

// ── Auto-split: when pre-week window is empty, split all settled dates 75/25 ──
async function autoSplitDates() {
  const dates = await db.all(
    `SELECT DISTINCT bet_date FROM ks_bets
     WHERE live_bet=0 AND paper=0 AND result IN ('win','loss') AND actual_ks IS NOT NULL
     ORDER BY bet_date ASC`,
  )
  if (dates.length < 2) return null
  const all = dates.map(r => r.bet_date)
  const splitAt = Math.max(1, Math.floor(all.length * 0.75))
  return { trainDates: all.slice(0, splitAt), testDates: all.slice(splitAt) }
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  // 1. Fetch training rows (settled, before test window)
  console.log('[shadow-pk] Fetching training rows…')
  let trainRows = await fetchRows(`AND bet_date <= '${TRAIN_END}' AND actual_ks IS NOT NULL AND result IN ('win','loss')`)
  console.log(`[shadow-pk] Training rows: ${trainRows.length}`)

  // 2. Fetch test rows (this week)
  console.log('[shadow-pk] Fetching test rows…')
  let testRows = await fetchRows(`AND bet_date >= '${TEST_START}' AND bet_date <= '${TEST_END}'`)
  console.log(`[shadow-pk] Test rows:     ${testRows.length}`)

  // Fallback: if no pre-week data exists, do a chrono split of all available settled dates
  if (trainRows.length < 15 && !flag('--train-end')) {
    console.log('[shadow-pk] Pre-week training window empty — auto-splitting available settled dates…')
    const split = await autoSplitDates()
    if (!split || split.trainDates.length === 0) {
      console.error('[shadow-pk] Not enough settled data for any split. Exiting.')
      process.exit(1)
    }
    const trainIn = split.trainDates.map(d => `'${d}'`).join(',')
    const testIn  = split.testDates.map(d => `'${d}'`).join(',')
    console.log(`[shadow-pk] Auto-split → train: [${split.trainDates.join(', ')}]  test: [${split.testDates.join(', ')}]`)
    trainRows = await fetchRows(`AND bet_date IN (${trainIn}) AND actual_ks IS NOT NULL AND result IN ('win','loss')`)
    testRows  = await fetchRows(`AND bet_date IN (${testIn})`)
    console.log(`[shadow-pk] After auto-split → train: ${trainRows.length}  test: ${testRows.length}`)
  }

  if (DRY_RUN) {
    console.log('[shadow-pk] --dry-run: stopping after row count check.')
    process.exit(0)
  }

  if (trainRows.length < 10) {
    console.error(`[shadow-pk] Not enough training data (${trainRows.length} rows, need 10+). Exiting.`)
    process.exit(1)
  }

  // 3. Build expected_BF maps
  const allRows = [...trainRows, ...testRows]
  const bfMap = await buildExpectedBF(allRows)
  console.log(`[shadow-pk] BF map entries: ${bfMap.size}`)

  // 4. Write CSVs
  fs.mkdirSync(TMP, { recursive: true })
  const trainPath = path.join(TMP, 'train.csv')
  const testPath  = path.join(TMP, 'test.csv')
  const predPath  = path.join(TMP, 'predictions.json')

  const { written: tw, skipped: ts } = writeCSV(trainPath, trainRows, bfMap, true)
  const { written: ew } = writeCSV(testPath, testRows, bfMap, false)
  console.log(`[shadow-pk] train.csv: ${tw} rows (${ts} skipped — no actual_ks or expected_bf)`)
  console.log(`[shadow-pk] test.csv:  ${ew} rows`)

  if (tw < 15) {
    console.error(`[shadow-pk] Only ${tw} usable training rows after filtering. Need more settled data.`)
    process.exit(1)
  }

  // 5. Run Python
  const pyScript = path.join(__dirname, 'shadowTestPkModel.py')
  console.log('[shadow-pk] Running Python trainer…')
  const result = spawnSync(
    'python3', [pyScript, trainPath, testPath, predPath],
    { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 120_000 },
  )

  if (result.stderr) {
    // Python writes feature importance + CV scores to stderr intentionally
    process.stderr.write(result.stderr)
  }

  if (result.status !== 0) {
    console.error(`[shadow-pk] Python exited with status ${result.status}`)
    if (result.stdout) console.error(result.stdout)
    process.exit(1)
  }

  // 6. Read predictions
  if (!fs.existsSync(predPath)) {
    console.error('[shadow-pk] predictions.json not found after Python run.')
    process.exit(1)
  }
  const preds = JSON.parse(fs.readFileSync(predPath, 'utf8'))
  console.log(`[shadow-pk] Predictions received: ${preds.length}`)

  // 7. Fetch per-bet rows for P&L replay
  const testDates = [...new Set(testRows.map(r => r.bet_date))]
  const testBets = await fetchTestBets(testDates)
  console.log(`[shadow-pk] Per-bet test rows: ${testBets.length} (${testBets.filter(b=>b.result==='win'||b.result==='loss').length} settled)`)

  // 8. Print report
  printReport(testRows, bfMap, preds, testBets)
}

main().catch(err => {
  console.error('[shadow-pk] Fatal error:', err)
  process.exit(1)
})
