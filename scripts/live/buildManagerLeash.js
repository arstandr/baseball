import 'dotenv/config'
import * as db from '../../lib/db.js'
import axios from 'axios'

const MLB_BASE = 'https://statsapi.mlb.com/api/v1'

async function fetchManagerId(gameId) {
  try {
    const res = await axios.get(`${MLB_BASE}/game/${gameId}/boxscore`, { timeout: 5000 })
    const home = res.data?.teams?.home?.team?.id
    return res.data?.teams?.home?.coaches?.find(c => c.position?.code === 'M')?.person?.id || null
  } catch { return null }
}

async function main() {
  await db.migrate()

  // Add manager leash columns to pitcher_statcast if not exist
  await db.run(`ALTER TABLE pitcher_statcast ADD COLUMN manager_leash_factor REAL`).catch(() => {})

  // Query historical game results — we want starters who were pulled early vs. late
  // Use ks_bets: actual_ks is our proxy (pitchers pulled early get fewer Ks)
  // and n_starts tells us IP data is available
  const starters = await db.all(
    `SELECT pitcher_id, pitcher_name, game, actual_ks, lambda, n_starts,
            live_ip_at_bet, live_bf_at_bet
     FROM ks_bets
     WHERE live_bet = 0 AND actual_ks IS NOT NULL AND result IS NOT NULL
       AND result != 'void' AND lambda IS NOT NULL
     ORDER BY pitcher_id, bet_date`,
  )

  if (!starters.length) {
    console.log('No historical data available for leash model')
    await db.close()
    return
  }

  // Group by pitcher and compute how often they go deep vs. get pulled early
  // "deep" = actual_ks >= 0.85 * lambda (pitcher used close to full predicted λ)
  // "short" = actual_ks < 0.5 * lambda (pitcher pulled well before predicted λ)
  const byPitcher = new Map()
  for (const row of starters) {
    const key = String(row.pitcher_id)
    if (!byPitcher.has(key)) byPitcher.set(key, { name: row.pitcher_name, deep: 0, short: 0, total: 0 })
    const p = byPitcher.get(key)
    p.total++
    const ratio = row.lambda > 0 ? row.actual_ks / row.lambda : 1
    if (ratio >= 0.85) p.deep++
    else if (ratio < 0.50) p.short++
  }

  console.log(`\nManager/pitcher leash analysis (${starters.length} starts)\n`)
  console.log(`${'Pitcher'.padEnd(28)} ${'N'.padStart(4)} ${'DeepPct'.padStart(9)} ${'ShortPct'.padStart(10)} ${'LeashFactor'.padStart(13)}`)
  console.log('-'.repeat(68))

  let updated = 0
  for (const [pitcherId, p] of byPitcher) {
    if (p.total < 10) continue
    const deepPct  = p.deep  / p.total
    const shortPct = p.short / p.total
    // Leash factor: 1.0 = normal, <1 = pulled early (haircut expected BF), >1 = goes deep
    const leashFactor = Math.max(0.75, Math.min(1.15, 1.0 + (deepPct - shortPct) * 0.3))
    console.log(`${p.name.padEnd(28)} ${String(p.total).padStart(4)} ${(deepPct*100).toFixed(1).padStart(8)}% ${(shortPct*100).toFixed(1).padStart(9)}% ${leashFactor.toFixed(3).padStart(13)}`)

    await db.run(
      `UPDATE pitcher_statcast SET manager_leash_factor = ? WHERE player_id = ?`,
      [leashFactor, pitcherId],
    ).catch(() => {})
    updated++
  }
  console.log(`\nUpdated leash factor for ${updated} pitchers.`)

  await db.close()
}

main().catch(err => { console.error(err.message); process.exit(1) })
