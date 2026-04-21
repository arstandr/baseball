// scripts/historical/validate.js — sanity check the feature matrix CSV.
//
//   - Null rate per feature (flag >20%)
//   - Target balance (expect ~48-52% over)
//   - Line distribution (expect 7.5-9.5 cluster)
//   - ERA/FIP basic sanity (0 < x < 15)

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import readline from 'node:readline'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const DATA_DIR = path.resolve(__dirname, '..', '..', 'data')

export async function validate({ csvPath = path.join(DATA_DIR, 'feature_matrix_all.csv') } = {}) {
  if (!fs.existsSync(csvPath)) {
    return { ok: false, error: `csv not found: ${csvPath}` }
  }
  const stream = fs.createReadStream(csvPath)
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })

  let header = null
  let headerCols = []
  let n = 0
  let targetSum = 0
  const lineDist = []
  const featureStats = {} // { colName: { nonNull, nulls, min, max, sum } }

  for await (const line of rl) {
    if (!header) {
      header = line
      headerCols = header.split(',')
      for (const c of headerCols) {
        featureStats[c] = { nonNull: 0, nulls: 0, min: Infinity, max: -Infinity, sum: 0 }
      }
      continue
    }
    if (!line.trim()) continue
    const cells = splitCsv(line)
    if (cells.length !== headerCols.length) continue
    n++
    const targetIdx = headerCols.indexOf('target')
    if (targetIdx >= 0) targetSum += Number(cells[targetIdx]) || 0
    const lineIdx = headerCols.indexOf('full_line')
    if (lineIdx >= 0) {
      const lv = Number(cells[lineIdx])
      if (Number.isFinite(lv)) lineDist.push(lv)
    }

    for (let i = 0; i < headerCols.length; i++) {
      const c = headerCols[i]
      const v = cells[i]
      const stats = featureStats[c]
      if (v === '' || v == null) {
        stats.nulls++
        continue
      }
      stats.nonNull++
      const num = Number(v)
      if (!Number.isNaN(num) && Number.isFinite(num)) {
        if (num < stats.min) stats.min = num
        if (num > stats.max) stats.max = num
        stats.sum += num
      }
    }
  }

  if (n === 0) return { ok: false, error: 'no rows in CSV' }

  // Build report
  const highNullFeatures = []
  for (const c of headerCols) {
    const s = featureStats[c]
    const pct = s.nulls / n
    if (pct > 0.20) highNullFeatures.push({ feature: c, null_pct: Number(pct.toFixed(3)) })
  }

  const targetRate = targetSum / n

  // Line distribution percentiles
  lineDist.sort((a, b) => a - b)
  const p = pct => lineDist.length ? lineDist[Math.floor(lineDist.length * pct)] : null
  const lineSummary = {
    n: lineDist.length,
    min: lineDist[0] ?? null,
    p25: p(0.25),
    p50: p(0.5),
    p75: p(0.75),
    max: lineDist[lineDist.length - 1] ?? null,
  }

  // Pitcher stat sanity
  const saneEra = sanityCheck(featureStats['sp_h_era_l5'], 0.5, 15)
  const saneEraA = sanityCheck(featureStats['sp_a_era_l5'], 0.5, 15)
  const saneFip = sanityCheck(featureStats['sp_h_fip_weighted'], 1.0, 8)

  const report = {
    ok: true,
    rows: n,
    features: headerCols.length,
    target_balance: {
      over_rate: Number(targetRate.toFixed(3)),
      expected: '0.48 - 0.52',
      alert: targetRate < 0.40 || targetRate > 0.60,
    },
    line_distribution: lineSummary,
    pitcher_sanity: {
      era_home_l5: saneEra,
      era_away_l5: saneEraA,
      fip_home_weighted: saneFip,
    },
    high_null_features: highNullFeatures,
    warnings: [],
  }

  if (highNullFeatures.length > 0) {
    report.warnings.push(`${highNullFeatures.length} features have >20% nulls`)
  }
  if (report.target_balance.alert) {
    report.warnings.push(`target rate ${targetRate.toFixed(3)} outside expected 48-52% band`)
  }
  if (lineSummary.p50 != null && (lineSummary.p50 < 7 || lineSummary.p50 > 10)) {
    report.warnings.push(`median line ${lineSummary.p50} outside 7.5-9.5 cluster`)
  }

  return report
}

function sanityCheck(stats, low, high) {
  if (!stats || stats.nonNull === 0) return { ok: false, reason: 'no non-null values' }
  const mean = stats.sum / stats.nonNull
  return {
    ok: stats.min >= low && stats.max <= high,
    min: Number.isFinite(stats.min) ? stats.min : null,
    max: Number.isFinite(stats.max) ? stats.max : null,
    mean: Number(mean.toFixed(3)),
    n: stats.nonNull,
  }
}

function splitCsv(line) {
  const out = []
  let cur = ''
  let inQ = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++ }
      else inQ = !inQ
    } else if (ch === ',' && !inQ) {
      out.push(cur); cur = ''
    } else {
      cur += ch
    }
  }
  out.push(cur)
  return out
}
