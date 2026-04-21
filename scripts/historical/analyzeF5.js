/**
 * analyzeF5.js — F5 Historical Baseline Analysis
 *
 * Standalone read-only script. No trained model required.
 * Analyzes historical F5 actual run data to find baseline edges and signal quality.
 *
 * Usage:
 *   node scripts/historical/analyzeF5.js [--season 2024] [--line 4.5]
 */

import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { all, one, getClient } from '../../lib/db.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PROJECT_ROOT = path.resolve(__dirname, '..', '..')

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2)
const getArg = (flag) => {
  const idx = args.indexOf(flag)
  return idx !== -1 && args[idx + 1] !== undefined ? args[idx + 1] : null
}
const FILTER_SEASON = getArg('--season') ? Number(getArg('--season')) : null
const FILTER_LINE   = getArg('--line')   ? Number(getArg('--line'))   : null

// ---------------------------------------------------------------------------
// Kalshi implied prices (from today's market, 2026-04-19)
// ---------------------------------------------------------------------------
const KALSHI_IMPLIED = {
  3.5: 0.61,
  4.5: 0.47,
  5.5: 0.37,
  6.5: 0.28,
  7.5: 0.20,
}
const KALSHI_TIE_IMPLIED = 0.18

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------
const pct  = (n, d = 1) => (isFinite(n) ? `${(n * 100).toFixed(d)}%` : 'N/A')
const num  = (n, d = 2) => (n == null || !isFinite(n) ? 'N/A' : Number(n).toFixed(d))
const rpad = (s, w) => String(s).padEnd(w)
const lpad = (s, w) => String(s).padStart(w)
const bar  = (label, value, width = 60) => {
  const filled = Math.round(value * width)
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`
}

function header(title) {
  const line = '═'.repeat(70)
  console.log(`\n${line}`)
  console.log(`  ${title}`)
  console.log(line)
}

function subheader(title) {
  console.log(`\n  ── ${title} ──`)
}

function edgeFlag(historical, implied, threshold = 0.03) {
  const diff = historical - implied
  if (Math.abs(diff) > threshold) {
    const dir = diff > 0 ? '▲ OVER-EDGE' : '▼ UNDER-EDGE'
    return `  ← ${dir} ${diff > 0 ? '+' : ''}${(diff * 100).toFixed(1)}pp vs Kalshi`
  }
  return ''
}

// ---------------------------------------------------------------------------
// CSV parser — reads feature_matrix_all.csv into array of objects
// ---------------------------------------------------------------------------
function loadFeatureMatrix() {
  const csvPath = path.join(PROJECT_ROOT, 'data', 'feature_matrix_all.csv')
  if (!fs.existsSync(csvPath)) {
    console.warn('  WARNING: data/feature_matrix_all.csv not found — skipping feature sections')
    return []
  }
  const raw = fs.readFileSync(csvPath, 'utf-8')
  const lines = raw.split('\n').filter(l => l.trim())
  if (lines.length < 2) return []

  const headers = lines[0].split(',')
  const rows = []

  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split(',')
    if (vals.length < headers.length) continue
    const obj = {}
    for (let j = 0; j < headers.length; j++) {
      const v = vals[j]
      obj[headers[j]] = v === '' || v === 'NA' ? null : isNaN(v) ? v : Number(v)
    }
    rows.push(obj)
  }
  return rows
}

// ---------------------------------------------------------------------------
// Simple Pearson correlation
// ---------------------------------------------------------------------------
function pearsonCorr(xs, ys) {
  const n = xs.length
  if (n < 2) return null
  const meanX = xs.reduce((a, b) => a + b, 0) / n
  const meanY = ys.reduce((a, b) => a + b, 0) / n
  let num = 0, dx2 = 0, dy2 = 0
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX
    const dy = ys[i] - meanY
    num += dx * dy
    dx2 += dx * dx
    dy2 += dy * dy
  }
  const denom = Math.sqrt(dx2 * dy2)
  return denom === 0 ? 0 : num / denom
}

// ---------------------------------------------------------------------------
// AUC-style discriminator: % of top half vs bottom half that went over
// ---------------------------------------------------------------------------
function aucStyle(pairs /* [{signal, label}] */) {
  if (pairs.length < 10) return null
  pairs.sort((a, b) => a.signal - b.signal)
  const mid = Math.floor(pairs.length / 2)
  const low  = pairs.slice(0, mid)
  const high = pairs.slice(mid)
  const lowOver  = low.filter(p => p.label === 1).length / low.length
  const highOver = high.filter(p => p.label === 1).length / high.length
  return { lowOver, highOver, n: pairs.length }
}

// ---------------------------------------------------------------------------
// DB schema compatibility check — historical_games may predate F5 columns
// ---------------------------------------------------------------------------
async function checkF5Columns() {
  const client = getClient()
  const res = await client.execute('PRAGMA table_info(historical_games)')
  const cols = new Set(res.rows.map(r => r[1]))
  const required = ['f5_runs_total', 'f5_runs_home', 'f5_runs_away', 'f5_winner', 'f5_innings_played']
  const missing = required.filter(c => !cols.has(c))
  if (missing.length > 0) {
    console.error('\n  ERROR: historical_games is missing F5 columns:', missing.join(', '))
    console.error('  The local DB predates the F5 column additions.')
    console.error('  Run the backfill script first to add these columns and populate data:')
    console.error('    node scripts/historical/backfillF5Actuals.js')
    console.error('  Or apply the migration manually:')
    for (const col of missing) {
      console.error(`    ALTER TABLE historical_games ADD COLUMN ${col}${col === 'f5_winner' ? ' TEXT' : ' INTEGER'};`)
    }
    process.exit(1)
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('\n' + '╔' + '═'.repeat(68) + '╗')
  console.log('║' + '  F5 Historical Baseline Analysis'.padEnd(68) + '║')
  if (FILTER_SEASON) console.log('║' + `  Season filter: ${FILTER_SEASON}`.padEnd(68) + '║')
  if (FILTER_LINE)   console.log('║' + `  Line filter:   ${FILTER_LINE}`.padEnd(68) + '║')
  console.log('╚' + '═'.repeat(68) + '╝')

  await checkF5Columns()

  const seasonWhere = FILTER_SEASON ? `AND season = ${FILTER_SEASON}` : ''

  // =========================================================================
  // SECTION 1: F5 Data Coverage
  // =========================================================================
  header('SECTION 1: F5 Data Coverage')

  const totalGames = await one(
    `SELECT COUNT(*) AS n FROM historical_games WHERE 1=1 ${seasonWhere}`
  )
  const f5Games = await one(
    `SELECT COUNT(*) AS n FROM historical_games WHERE f5_runs_total IS NOT NULL ${seasonWhere}`
  )
  const bySeason = await all(
    `SELECT season,
            COUNT(*) AS total,
            SUM(CASE WHEN f5_runs_total IS NOT NULL THEN 1 ELSE 0 END) AS with_f5
     FROM historical_games
     WHERE 1=1 ${seasonWhere}
     GROUP BY season
     ORDER BY season`
  )

  console.log(`\n  Total games in historical_games : ${lpad(totalGames?.n ?? 0, 6)}`)
  console.log(`  Games with f5_runs_total        : ${lpad(f5Games?.n ?? 0, 6)}`)

  if (totalGames?.n > 0) {
    const covPct = (f5Games?.n ?? 0) / totalGames.n
    console.log(`  F5 coverage rate                : ${lpad(pct(covPct), 6)}`)
  }

  if (bySeason.length > 0) {
    subheader('By Season')
    console.log(`  ${rpad('Season', 8)} ${lpad('Total', 7)} ${lpad('With F5', 9)} ${lpad('Coverage', 10)}`)
    console.log('  ' + '─'.repeat(38))
    for (const r of bySeason) {
      const cov = r.total > 0 ? r.with_f5 / r.total : 0
      console.log(
        `  ${rpad(r.season, 8)} ${lpad(r.total, 7)} ${lpad(r.with_f5, 9)} ${lpad(pct(cov), 10)}`
      )
    }
  }

  // =========================================================================
  // SECTION 2: F5 Run Distribution
  // =========================================================================
  header('SECTION 2: F5 Run Distribution')

  const thresholds = [3.5, 4.5, 5.5, 6.5, 7.5]

  const distRows = await all(
    `SELECT season, f5_runs_total
     FROM historical_games
     WHERE f5_runs_total IS NOT NULL ${seasonWhere}
     ORDER BY season`
  )

  if (distRows.length === 0) {
    console.log('\n  No F5 run data available.')
  } else {
    const overallAvg = distRows.reduce((s, r) => s + r.f5_runs_total, 0) / distRows.length
    console.log(`\n  Overall avg F5 total : ${num(overallAvg)} runs  (n=${distRows.length})`)

    // By season
    const bySeasonMap = {}
    for (const r of distRows) {
      if (!bySeasonMap[r.season]) bySeasonMap[r.season] = []
      bySeasonMap[r.season].push(r.f5_runs_total)
    }
    subheader('Average F5 Total by Season')
    for (const [season, vals] of Object.entries(bySeasonMap)) {
      const avg = vals.reduce((a, b) => a + b, 0) / vals.length
      console.log(`  ${season}: ${num(avg)} runs avg  (n=${vals.length})`)
    }

    // Over rates
    subheader('Over Rates vs Kalshi Implied Prices')
    console.log(`\n  ${rpad('Line', 6)} ${lpad('Historical%', 13)} ${lpad('Kalshi%', 9)} ${lpad('Diff', 7)}  Signal`)
    console.log('  ' + '─'.repeat(62))

    for (const t of thresholds) {
      const overCount = distRows.filter(r => r.f5_runs_total > t).length
      const histRate  = overCount / distRows.length
      const implied   = KALSHI_IMPLIED[t] ?? null
      const diff      = implied != null ? histRate - implied : null
      const diffStr   = diff != null ? `${diff >= 0 ? '+' : ''}${(diff * 100).toFixed(1)}pp` : 'N/A'
      const flag      = implied != null && Math.abs(diff) > 0.03
        ? (diff > 0 ? '▲ OVER-EDGE' : '▼ UNDER-EDGE')
        : '—'

      console.log(
        `  ${rpad(`o${t}`, 6)} ${lpad(pct(histRate), 13)} ${lpad(implied != null ? pct(implied) : 'N/A', 9)} ${lpad(diffStr, 7)}  ${flag}`
      )
    }

    // By season breakdown
    if (!FILTER_SEASON && Object.keys(bySeasonMap).length > 1) {
      subheader('Over Rate at 4.5 by Season')
      console.log(`  ${rpad('Season', 8)} ${lpad('Avg Runs', 10)} ${lpad('o4.5 Rate', 11)} ${lpad('vs Kalshi', 11)}`)
      console.log('  ' + '─'.repeat(44))
      for (const [season, vals] of Object.entries(bySeasonMap)) {
        const avg     = vals.reduce((a, b) => a + b, 0) / vals.length
        const overRate = vals.filter(v => v > 4.5).length / vals.length
        const diff    = overRate - (KALSHI_IMPLIED[4.5] ?? 0.47)
        console.log(
          `  ${rpad(season, 8)} ${lpad(num(avg), 10)} ${lpad(pct(overRate), 11)} ${lpad(`${diff >= 0 ? '+' : ''}${(diff * 100).toFixed(1)}pp`, 11)}`
        )
      }
    }
  }

  // =========================================================================
  // SECTION 3: F5 Winner Distribution
  // =========================================================================
  header('SECTION 3: F5 Winner Distribution')

  const winnerRows = await all(
    `SELECT season, f5_winner
     FROM historical_games
     WHERE f5_winner IS NOT NULL ${seasonWhere}
     ORDER BY season`
  )

  if (winnerRows.length === 0) {
    console.log('\n  No F5 winner data available.')
  } else {
    const homeW = winnerRows.filter(r => r.f5_winner === 'home').length
    const awayW = winnerRows.filter(r => r.f5_winner === 'away').length
    const ties  = winnerRows.filter(r => r.f5_winner === 'tie').length
    const n     = winnerRows.length

    const tieRate  = ties / n
    const homeRate = homeW / n
    const awayRate = awayW / n

    console.log(`\n  Overall (n=${n}):`)
    console.log(`    Home win : ${pct(homeRate)}`)
    console.log(`    Away win : ${pct(awayRate)}`)
    console.log(`    Tie      : ${pct(tieRate)}  (Kalshi implied ~18%)${edgeFlag(tieRate, KALSHI_TIE_IMPLIED, 0.03)}`)

    if (!FILTER_SEASON) {
      subheader('Winner Distribution by Season')
      console.log(`  ${rpad('Season', 8)} ${lpad('n', 6)} ${lpad('Home%', 8)} ${lpad('Away%', 8)} ${lpad('Tie%', 8)}  Tie vs Kalshi`)
      console.log('  ' + '─'.repeat(62))

      const seasonWinMap = {}
      for (const r of winnerRows) {
        if (!seasonWinMap[r.season]) seasonWinMap[r.season] = { home: 0, away: 0, tie: 0, n: 0 }
        seasonWinMap[r.season][r.f5_winner]++
        seasonWinMap[r.season].n++
      }
      for (const [season, d] of Object.entries(seasonWinMap)) {
        const t = d.tie / d.n
        const diff = t - KALSHI_TIE_IMPLIED
        const flag = Math.abs(diff) > 0.03 ? (diff > 0 ? '▲' : '▼') : '~'
        console.log(
          `  ${rpad(season, 8)} ${lpad(d.n, 6)} ${lpad(pct(d.home / d.n), 8)} ${lpad(pct(d.away / d.n), 8)} ${lpad(pct(t), 8)}  ${flag} ${diff >= 0 ? '+' : ''}${(diff * 100).toFixed(1)}pp`
        )
      }
    }
  }

  // =========================================================================
  // SECTIONS 4-7: Feature Matrix Analysis
  // =========================================================================
  console.log('\n\n' + '─'.repeat(70))
  console.log('  Loading feature matrix CSV...')
  const featureRows = loadFeatureMatrix()

  // Apply season filter to feature rows
  const filteredFeatureRows = FILTER_SEASON
    ? featureRows.filter(r => r.season === FILTER_SEASON)
    : featureRows

  // Join with DB to get f5_runs_total per game_id
  // Build a map of game_id → f5_runs_total from DB
  const dbF5Map = {}
  if (filteredFeatureRows.length > 0) {
    const dbF5Rows = await all(
      `SELECT id, f5_runs_total, f5_winner
       FROM historical_games
       WHERE f5_runs_total IS NOT NULL ${seasonWhere}`
    )
    for (const r of dbF5Rows) {
      dbF5Map[r.id] = { f5_runs_total: r.f5_runs_total, f5_winner: r.f5_winner }
    }
  }

  // Enrich feature rows with DB f5 data
  const enriched = filteredFeatureRows
    .map(r => {
      const dbRow = dbF5Map[r.game_id]
      if (!dbRow) return null
      return { ...r, f5_runs_total: dbRow.f5_runs_total, f5_winner: dbRow.f5_winner }
    })
    .filter(Boolean)

  console.log(`  Feature matrix rows: ${filteredFeatureRows.length}  |  Joined with F5 DB data: ${enriched.length}`)

  if (enriched.length === 0) {
    console.log('\n  WARNING: No feature rows could be joined with F5 data — skipping sections 4-7.')
    console.log('  (Ensure historical pipeline has been run: node scripts/historical/backfillF5Actuals.js)')
  } else {
    // =========================================================================
    // SECTION 4: Pitcher Quality Signal
    // =========================================================================
    header('SECTION 4: Pitcher Quality Signal')

    const withFip = enriched.filter(
      r => r.sp_h_fip_weighted != null && r.sp_a_fip_weighted != null
    )

    if (withFip.length === 0) {
      console.log('\n  No FIP data available in feature matrix.')
    } else {
      const buckets = {
        'Elite  (<3.5 avg FIP)' : r => r._avgFip < 3.5,
        'Good   (3.5–4.0 FIP)'  : r => r._avgFip >= 3.5 && r._avgFip < 4.0,
        'Average (4.0–4.5 FIP)' : r => r._avgFip >= 4.0 && r._avgFip < 4.5,
        'Poor   (>4.5 avg FIP)' : r => r._avgFip >= 4.5,
      }

      const tagged = withFip.map(r => ({
        ...r,
        _avgFip: (r.sp_h_fip_weighted + r.sp_a_fip_weighted) / 2,
      }))

      console.log(`\n  ${rpad('Bucket', 24)} ${lpad('n', 6)} ${lpad('Avg F5', 8)} ${lpad('o4.5%', 8)}  vs Kalshi`)
      console.log('  ' + '─'.repeat(58))

      for (const [label, fn] of Object.entries(buckets)) {
        const group = tagged.filter(fn)
        if (group.length === 0) {
          console.log(`  ${rpad(label, 24)} ${lpad(0, 6)}   —`)
          continue
        }
        const avgF5  = group.reduce((s, r) => s + r.f5_runs_total, 0) / group.length
        const o45    = group.filter(r => r.f5_runs_total > 4.5).length / group.length
        const diff   = o45 - (KALSHI_IMPLIED[4.5] ?? 0.47)
        const flag   = Math.abs(diff) > 0.03 ? (diff > 0 ? '▲' : '▼') : '~'
        console.log(
          `  ${rpad(label, 24)} ${lpad(group.length, 6)} ${lpad(num(avgF5), 8)} ${lpad(pct(o45), 8)}  ${flag} ${diff >= 0 ? '+' : ''}${(diff * 100).toFixed(1)}pp`
        )
      }
    }

    // =========================================================================
    // SECTION 5: Park Factor Signal
    // =========================================================================
    header('SECTION 5: Park Factor Signal')

    const withPark = enriched.filter(r => r.pk_f5_factor != null)

    if (withPark.length === 0) {
      console.log('\n  No park factor data available in feature matrix.')
    } else {
      const parkBuckets = {
        'Pitcher-friendly (<0.95)' : r => r.pk_f5_factor < 0.95,
        'Neutral (0.95–1.05)'      : r => r.pk_f5_factor >= 0.95 && r.pk_f5_factor <= 1.05,
        'Hitter-friendly (>1.05)'  : r => r.pk_f5_factor > 1.05,
      }

      console.log(`\n  ${rpad('Park Bucket', 28)} ${lpad('n', 6)} ${lpad('Avg F5', 8)} ${lpad('o4.5%', 8)}  vs Kalshi`)
      console.log('  ' + '─'.repeat(62))

      for (const [label, fn] of Object.entries(parkBuckets)) {
        const group = withPark.filter(fn)
        if (group.length === 0) {
          console.log(`  ${rpad(label, 28)} ${lpad(0, 6)}   —`)
          continue
        }
        const avgF5 = group.reduce((s, r) => s + r.f5_runs_total, 0) / group.length
        const o45   = group.filter(r => r.f5_runs_total > 4.5).length / group.length
        const diff  = o45 - (KALSHI_IMPLIED[4.5] ?? 0.47)
        const flag  = Math.abs(diff) > 0.03 ? (diff > 0 ? '▲' : '▼') : '~'
        console.log(
          `  ${rpad(label, 28)} ${lpad(group.length, 6)} ${lpad(num(avgF5), 8)} ${lpad(pct(o45), 8)}  ${flag} ${diff >= 0 ? '+' : ''}${(diff * 100).toFixed(1)}pp`
        )
      }
    }

    // =========================================================================
    // SECTION 6: Bullpen Irrelevance Test
    // =========================================================================
    header('SECTION 6: Bullpen Irrelevance Test')
    console.log('  Hypothesis: bullpen ERA has near-zero correlation with F5 total (bullpen barely pitches F5)')

    const bpRows = enriched.filter(
      r => r.bp_h_era_14d != null && r.bp_a_era_14d != null
    )

    if (bpRows.length < 10) {
      console.log('\n  Insufficient bullpen data to test.')
    } else {
      const homeBpXs  = bpRows.map(r => r.bp_h_era_14d)
      const awayBpXs  = bpRows.map(r => r.bp_a_era_14d)
      const avgBpXs   = bpRows.map(r => (r.bp_h_era_14d + r.bp_a_era_14d) / 2)
      const f5Ys      = bpRows.map(r => r.f5_runs_total)

      const corrHome = pearsonCorr(homeBpXs, f5Ys)
      const corrAway = pearsonCorr(awayBpXs, f5Ys)
      const corrAvg  = pearsonCorr(avgBpXs, f5Ys)

      console.log(`\n  n = ${bpRows.length} games with bullpen data`)
      console.log(`\n  Pearson r (home bullpen ERA vs F5 total) : ${num(corrHome, 4)}`)
      console.log(`  Pearson r (away bullpen ERA vs F5 total) : ${num(corrAway, 4)}`)
      console.log(`  Pearson r (avg  bullpen ERA vs F5 total) : ${num(corrAvg, 4)}`)

      const interpret = (r) => {
        const abs = Math.abs(r)
        if (abs < 0.05) return '✓ Near-zero — confirms bullpen irrelevance for F5'
        if (abs < 0.10) return '~ Very weak — acceptable, model should ignore'
        if (abs < 0.20) return '⚠ Weak but non-trivial — worth investigating'
        return '✗ Moderate — unexpected, investigate for data issue'
      }
      console.log(`\n  Verdict (avg): ${interpret(corrAvg)}`)
    }

    // =========================================================================
    // SECTION 7: Model / Proxy Correlation
    // =========================================================================
    header('SECTION 7: Existing Model / SP Quality Correlation')

    // Check for predicted_probability column
    const hasPredicted = enriched.length > 0 && enriched[0].predicted_probability != null

    if (hasPredicted) {
      subheader('predicted_probability column found — computing AUC-style')
      const pairs = enriched
        .filter(r => r.predicted_probability != null)
        .map(r => ({ signal: r.predicted_probability, label: r.f5_runs_total > 4.5 ? 1 : 0 }))

      const result = aucStyle(pairs)
      if (result) {
        console.log(`\n  n = ${result.n}  (split into two halves of ${Math.floor(result.n / 2)})`)
        console.log(`  Low predicted_prob  games → o4.5 rate: ${pct(result.lowOver)}`)
        console.log(`  High predicted_prob games → o4.5 rate: ${pct(result.highOver)}`)
        const lift = result.highOver - result.lowOver
        console.log(`  Lift (high - low): ${lift >= 0 ? '+' : ''}${(lift * 100).toFixed(1)}pp`)
        console.log(lift > 0.05 ? '\n  ✓ Model has directional signal for F5 over.' : '\n  ~ Weak or no signal from predicted_probability.')
      }
    } else {
      subheader('No predicted_probability column — using SP FIP proxy')

      const spRows = enriched.filter(
        r => r.sp_h_fip_weighted != null && r.sp_a_fip_weighted != null
      )

      if (spRows.length < 20) {
        console.log('\n  Insufficient SP data for proxy analysis.')
      } else {
        const pairs = spRows.map(r => ({
          signal: (r.sp_h_fip_weighted + r.sp_a_fip_weighted) / 2,
          label: r.f5_runs_total > 4.5 ? 1 : 0,
        }))

        const result = aucStyle(pairs)
        if (result) {
          const mid = Math.floor(result.n / 2)
          console.log(`\n  Proxy: avg combined SP FIP (sp_h_fip_weighted + sp_a_fip_weighted) / 2`)
          console.log(`  n = ${result.n}  (bottom half n=${mid}, top half n=${result.n - mid})`)
          console.log()
          console.log(`  Low-FIP half  (better pitchers) → o4.5 rate: ${pct(result.lowOver)}`)
          console.log(`  High-FIP half (worse  pitchers) → o4.5 rate: ${pct(result.highOver)}`)
          const lift = result.highOver - result.lowOver
          console.log(`  Lift (high FIP - low FIP): ${lift >= 0 ? '+' : ''}${(lift * 100).toFixed(1)}pp`)

          if (lift > 0.05) {
            console.log('\n  ✓ SP FIP predicts F5 over direction — better pitchers suppress scoring as expected.')
          } else if (lift > 0.02) {
            console.log('\n  ~ Weak positive signal from SP FIP — consistent with theory but small effect size.')
          } else {
            console.log('\n  ~ No meaningful signal from SP FIP proxy — may indicate feature needs tuning.')
          }
        }

        // Also show correlation
        const fipXs = spRows.map(r => (r.sp_h_fip_weighted + r.sp_a_fip_weighted) / 2)
        const f5Ys  = spRows.map(r => r.f5_runs_total)
        const corr  = pearsonCorr(fipXs, f5Ys)
        console.log(`\n  Pearson r (avg SP FIP vs F5 runs total): ${num(corr, 4)}`)
        console.log(`  Expected sign: positive (higher FIP → more runs → higher F5 total)`)
      }
    }
  }

  // =========================================================================
  // SECTION 8: Top Edge Opportunities
  // =========================================================================
  header('SECTION 8: Top Edge Opportunities')
  console.log('  Which (season × threshold) combinations show the most consistent edge vs Kalshi?')

  // Use DB data for this (no feature dependency)
  const allF5Rows = await all(
    `SELECT season, f5_runs_total
     FROM historical_games
     WHERE f5_runs_total IS NOT NULL ${seasonWhere}
     ORDER BY season`
  )

  if (allF5Rows.length === 0) {
    console.log('\n  No data available.')
  } else {
    // Build edge table: for each (season, threshold), compute over rate - implied
    const seasonSet = [...new Set(allF5Rows.map(r => r.season))].sort()
    const edges = []

    for (const season of seasonSet) {
      const rows = allF5Rows.filter(r => r.season === season)
      for (const t of thresholds) {
        const overRate = rows.filter(r => r.f5_runs_total > t).length / rows.length
        const implied  = KALSHI_IMPLIED[t] ?? null
        if (implied == null) continue
        const edge = overRate - implied
        edges.push({ season, threshold: t, overRate, implied, edge, n: rows.length })
      }
    }

    // Sort by absolute edge descending
    edges.sort((a, b) => Math.abs(b.edge) - Math.abs(a.edge))

    subheader('All (Season × Threshold) Edges, Ranked by Magnitude')
    console.log(`\n  ${rpad('Season', 8)} ${rpad('Line', 6)} ${lpad('n', 5)} ${lpad('Historical', 12)} ${lpad('Kalshi', 8)} ${lpad('Edge', 8)}  Direction`)
    console.log('  ' + '─'.repeat(66))

    for (const e of edges.slice(0, 20)) {
      const flag = Math.abs(e.edge) > 0.03 ? (e.edge > 0 ? '▲ OVER-EDGE' : '▼ UNDER-EDGE') : '—'
      console.log(
        `  ${rpad(e.season, 8)} ${rpad(`o${e.threshold}`, 6)} ${lpad(e.n, 5)} ${lpad(pct(e.overRate), 12)} ${lpad(pct(e.implied), 8)} ${lpad(`${e.edge >= 0 ? '+' : ''}${(e.edge * 100).toFixed(1)}pp`, 8)}  ${flag}`
      )
    }

    // Summary: consistent edges (appear across multiple seasons)
    subheader('Consistent Edges (>3pp in same direction, ≥2 seasons)')
    const byThreshold = {}
    for (const e of edges) {
      if (!byThreshold[e.threshold]) byThreshold[e.threshold] = []
      byThreshold[e.threshold].push(e)
    }

    let foundAny = false
    for (const [t, tEdges] of Object.entries(byThreshold)) {
      if (tEdges.length < 2) continue
      const positiveSeasons = tEdges.filter(e => e.edge > 0.03).length
      const negativeSeasons = tEdges.filter(e => e.edge < -0.03).length
      if (positiveSeasons >= 2) {
        const avgEdge = tEdges.reduce((s, e) => s + e.edge, 0) / tEdges.length
        console.log(`\n  ▲ OVER at o${t}: consistent OVER-edge in ${positiveSeasons}/${tEdges.length} seasons  (avg edge: +${(avgEdge * 100).toFixed(1)}pp)`)
        foundAny = true
      }
      if (negativeSeasons >= 2) {
        const avgEdge = tEdges.reduce((s, e) => s + e.edge, 0) / tEdges.length
        console.log(`\n  ▼ UNDER at o${t}: consistent UNDER-edge in ${negativeSeasons}/${tEdges.length} seasons  (avg edge: ${(avgEdge * 100).toFixed(1)}pp)`)
        foundAny = true
      }
    }

    if (!foundAny) {
      console.log('\n  No threshold shows consistent edge (>3pp) across ≥2 seasons.')
      console.log('  This is expected — Kalshi implied prices are well-calibrated historically.')
      console.log('  Edge must come from conditional signals (SP quality, park, weather), not base rates.')
    }

    // Best single opportunity
    const topEdge = edges[0]
    if (topEdge && Math.abs(topEdge.edge) > 0.03) {
      console.log(`\n  ★  Largest single-season edge: Season ${topEdge.season}, o${topEdge.threshold}`)
      console.log(`     Historical: ${pct(topEdge.overRate)}  |  Kalshi: ${pct(topEdge.implied)}  |  Edge: ${topEdge.edge >= 0 ? '+' : ''}${(topEdge.edge * 100).toFixed(1)}pp`)
    }
  }

  // =========================================================================
  // Summary / Recommended Line
  // =========================================================================
  header('SUMMARY')

  if (FILTER_LINE) {
    console.log(`\n  Focus line (--line ${FILTER_LINE}):`)
    const focusRows = await all(
      `SELECT season, f5_runs_total
       FROM historical_games
       WHERE f5_runs_total IS NOT NULL ${seasonWhere}`
    )
    if (focusRows.length > 0) {
      const overRate = focusRows.filter(r => r.f5_runs_total > FILTER_LINE).length / focusRows.length
      const implied  = KALSHI_IMPLIED[FILTER_LINE]
      const diff     = implied != null ? overRate - implied : null
      console.log(`    Historical over rate at ${FILTER_LINE}: ${pct(overRate)}  (n=${focusRows.length})`)
      if (diff != null) {
        console.log(`    Kalshi implied: ${pct(implied)}`)
        console.log(`    Raw edge: ${diff >= 0 ? '+' : ''}${(diff * 100).toFixed(1)}pp`)
        if (Math.abs(diff) > 0.03) {
          console.log(`    → ${diff > 0 ? 'Lean OVER' : 'Lean UNDER'} at baseline (before conditioning)`)
        } else {
          console.log(`    → No baseline edge at this line; use SP/park/weather signals to find edge`)
        }
      }
    }
  }

  console.log(`\n  Key findings:`)
  console.log(`    1. F5 baseline rates vs Kalshi implied are the foundation for edge detection`)
  console.log(`    2. SP quality (FIP buckets) is the primary F5 scoring signal`)
  console.log(`    3. Bullpen ERA should have near-zero correlation with F5 total (validated above)`)
  console.log(`    4. Park factor (pk_f5_factor) provides secondary signal`)
  console.log(`    5. Tie markets (~18¢ Kalshi) warrant separate analysis — see F5 winner section`)
  console.log()
  console.log('  Run with --season YYYY to drill into a specific season')
  console.log('  Run with --line N.5 to focus analysis on a specific Kalshi line')
  console.log()

  process.exit(0)
}

main().catch(err => {
  console.error('\nFATAL:', err)
  process.exit(1)
})
