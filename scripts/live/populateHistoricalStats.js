// scripts/live/populateHistoricalStats.js — One-time backfill of historical_pitcher_stats.
//
// Fetches full-season game logs from the MLB Stats API for every pitcher in
// pitcher_statcast, computes rolling L5 stats (look-ahead safe) for each
// start, and writes one row per start to historical_pitcher_stats.
//
// Once populated, run:
//   node scripts/live/backtest.js --season 2025 --sweep-nbr
//
// Usage:
//   node scripts/live/populateHistoricalStats.js
//   node scripts/live/populateHistoricalStats.js --seasons 2022,2023,2024,2025
//   node scripts/live/populateHistoricalStats.js --pitcher-id 543037
//   node scripts/live/populateHistoricalStats.js --limit 50 --delay 200
//   node scripts/live/populateHistoricalStats.js --dry-run

import 'dotenv/config'
import axios from 'axios'
import * as db from '../../lib/db.js'
import { ipToDecimal } from '../../lib/strikeout-model.js'
import { parseArgs } from '../../lib/cli-args.js'

const opts = parseArgs({
  seasons:   { type: 'string',  default: '2022,2023,2024,2025' },
  pitcherId: { flag: 'pitcher-id', type: 'string',  default: null },
  limit:     { type: 'number',  default: 0 },
  delay:     { type: 'number',  default: 150 },   // ms between API calls
  dryRun:    { flag: 'dry-run', type: 'boolean' },
})

const MLB_BASE = 'https://statsapi.mlb.com/api/v1'
const SEASONS  = opts.seasons.split(',').map(Number)

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

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
        date:    s.date,
        ip:      ipToDecimal(Number(s.stat?.inningsPitched || 0)),
        k:       Number(s.stat?.strikeOuts      || 0),
        bf:      Number(s.stat?.battersFaced    || 0),
        bb:      Number(s.stat?.baseOnBalls     || 0),
        er:      Number(s.stat?.earnedRuns      || 0),
        pitches: Number(s.stat?.numberOfPitches || 0),
      }))
      .sort((a, b) => a.date.localeCompare(b.date))
  } catch { return [] }
}

async function fetchPitcherHand(pitcherId) {
  try {
    const res = await axios.get(`${MLB_BASE}/people/${pitcherId}`, {
      timeout: 8000,
      validateStatus: s => s < 500,
    })
    return res.data?.people?.[0]?.pitchHand?.code || 'R'
  } catch { return 'R' }
}

function computeRollingL5(prev) {
  if (!prev.length) return null
  const l5 = prev.slice(-5)

  const sumK  = l5.reduce((s, r) => s + r.k, 0)
  const sumBF = l5.reduce((s, r) => s + r.bf, 0)
  const sumIP = l5.reduce((s, r) => s + r.ip, 0)
  const sumBB = l5.reduce((s, r) => s + r.bb, 0)
  const sumER = l5.reduce((s, r) => s + r.er, 0)

  return {
    k_pct_l5:          sumBF > 0 ? sumK / sumBF : null,
    k9_l5:             sumIP > 0 ? (sumK / sumIP) * 9 : null,
    bb9_l5:            sumIP > 0 ? (sumBB / sumIP) * 9 : null,
    avg_innings_l5:    l5.length > 0 ? sumIP / l5.length : null,
    era_l5:            sumIP > 0 ? (sumER / sumIP) * 9 : null,
    early_exit_rate_l5: l5.filter(r => r.ip < 5.0).length / l5.length,
    confidence:        Math.min(1.0, prev.length / 10),
  }
}

async function main() {
  await db.migrate()

  // ── Build pitcher list ─────────────────────────────────────────────────────
  let pitcherRows
  if (opts.pitcherId) {
    pitcherRows = await db.all(
      `SELECT DISTINCT player_id, player_name FROM pitcher_statcast WHERE player_id = ?`,
      [opts.pitcherId],
    )
    if (!pitcherRows.length) {
      // Pitcher may not have statcast data — still try to populate
      pitcherRows = [{ player_id: opts.pitcherId, player_name: `pitcher_${opts.pitcherId}` }]
    }
  } else {
    pitcherRows = await db.all(
      `SELECT DISTINCT player_id, player_name
         FROM pitcher_statcast
        WHERE season IN (${SEASONS.map(() => '?').join(',')})
        ORDER BY player_id`,
      SEASONS,
    )
  }

  if (opts.limit > 0) pitcherRows = pitcherRows.slice(0, opts.limit)

  console.log(`\n${'═'.repeat(62)}`)
  console.log(`  POPULATE HISTORICAL PITCHER STATS`)
  console.log(`${'═'.repeat(62)}`)
  console.log(`  Pitchers:    ${pitcherRows.length}`)
  console.log(`  Seasons:     ${SEASONS.join(', ')}`)
  console.log(`  Est. calls:  ~${pitcherRows.length * (SEASONS.length + 1)} (${pitcherRows.length} hand + ${pitcherRows.length * SEASONS.length} game logs)`)
  console.log(`  Delay:       ${opts.delay}ms between calls`)
  if (opts.dryRun) console.log(`  DRY RUN — no DB writes`)
  console.log()

  let totalInserted = 0
  let totalSkipped  = 0
  let totalPitchers = 0
  let totalStarts   = 0
  let apiErrors     = 0

  for (const { player_id, player_name } of pitcherRows) {
    // Fetch hand once (reused across seasons)
    const hand = await fetchPitcherHand(player_id)
    await sleep(opts.delay)

    for (const season of SEASONS) {
      const starts = await fetchGameLog(player_id, season)
      await sleep(opts.delay)

      if (!starts.length) continue
      totalStarts += starts.length

      for (let i = 0; i < starts.length; i++) {
        const start = starts[i]
        const prev  = starts.slice(0, i)   // strict look-ahead safety
        const stats = computeRollingL5(prev)

        const days_rest = prev.length > 0
          ? Math.round((new Date(start.date) - new Date(prev[prev.length - 1].date)) / 86400000)
          : null

        if (opts.dryRun) {
          totalInserted++
          continue
        }

        try {
          const r = await db.run(
            `INSERT OR IGNORE INTO historical_pitcher_stats
               (pitcher_id, pitcher_name, as_of_date, season, hand,
                k_pct_l5, k9_l5, bb9_l5, avg_innings_l5, era_l5,
                early_exit_rate_l5, days_rest, confidence)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              player_id, player_name, start.date, season, hand,
              stats?.k_pct_l5          ?? null,
              stats?.k9_l5             ?? null,
              stats?.bb9_l5            ?? null,
              stats?.avg_innings_l5    ?? null,
              stats?.era_l5            ?? null,
              stats?.early_exit_rate_l5 ?? null,
              days_rest,
              stats?.confidence ?? 0,
            ],
          )
          // libSQL: rowsAffected on INSERT OR IGNORE is 1 if inserted, 0 if skipped
          if ((r?.rowsAffected ?? 1) > 0) totalInserted++
          else totalSkipped++
        } catch (err) {
          if (err.message?.includes('UNIQUE') || err.message?.includes('constraint')) {
            totalSkipped++
          } else {
            apiErrors++
            if (apiErrors <= 10) console.error(`\n[populate] error: ${player_name} ${start.date}: ${err.message}`)
          }
        }
      }
    }

    totalPitchers++
    if (totalPitchers % 25 === 0 || totalPitchers === pitcherRows.length) {
      process.stdout.write(
        `\r[populate] ${totalPitchers}/${pitcherRows.length} pitchers | ${totalInserted} inserted | ${totalSkipped} skipped | ${apiErrors} errors  `,
      )
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n\n${'═'.repeat(62)}`)
  console.log(`  DONE`)
  console.log(`  Pitchers processed: ${totalPitchers}`)
  console.log(`  Total game starts:  ${totalStarts}`)
  console.log(`  Rows inserted:      ${totalInserted}`)
  console.log(`  Rows skipped:       ${totalSkipped} (already existed)`)
  console.log(`  API errors:         ${apiErrors}`)

  if (!opts.dryRun && totalInserted > 0) {
    const check = await db.all(
      `SELECT season, COUNT(*) as n FROM historical_pitcher_stats GROUP BY season ORDER BY season`,
    )
    console.log(`\n  historical_pitcher_stats row counts:`)
    for (const r of check) console.log(`    ${r.season}: ${r.n} rows`)
  }

  console.log(`\n  Next steps:`)
  console.log(`    node scripts/live/backtest.js --season 2025 --sweep-nbr`)
  console.log(`    node scripts/live/backtest.js --season 2024 --sweep-nbr  (OOS validation)`)
  console.log(`${'═'.repeat(62)}\n`)

  await db.close()
}

main().catch(e => { console.error('[populate] fatal:', e.message); process.exit(1) })
