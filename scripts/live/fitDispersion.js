// scripts/live/fitDispersion.js — Per-pitcher NB dispersion fitting
//
// Loads all settled pre-game bets from ks_bets where actual_ks IS NOT NULL,
// groups by pitcher_id, and for pitchers with ≥ 20 unique game dates (starts)
// fits the Negative Binomial dispersion parameter r from their K distribution
// and our pre-game λ values. Writes fitted r values back to pitcher_statcast.
//
// The math: For NB(λ, r), the log-likelihood of observing K=k is:
//   logΓ(k+r) - logΓ(r) - logΓ(k+1) + r*log(r/(r+λ)) + k*log(λ/(r+λ))
//
// Grid search over r ∈ [0.5, 200] in steps of 0.5 to find MLE.
//
// Usage:
//   node scripts/live/fitDispersion.js

import 'dotenv/config'
import * as db from '../../lib/db.js'

const MIN_STARTS = 20

// ── Lanczos log-gamma approximation ──────────────────────────────────────────
// Accurate to ~15 significant digits for x > 0.
function logGamma(n) {
  if (n <= 0) return Infinity
  if (n < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * n)) - logGamma(1 - n)
  const g = 7
  const c = [
    0.99999999999980993,
    676.5203681218851,
    -1259.1392167224028,
    771.32342877765313,
    -176.61502916214059,
    12.507343278686905,
    -0.13857109526572012,
    9.9843695780195716e-6,
    1.5056327351493116e-7,
  ]
  let x = n
  x -= 1
  let a = c[0]
  const t = x + g + 0.5
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i)
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a)
}

// ── NB log-likelihood ─────────────────────────────────────────────────────────
// observations: array of {k, lambda} where k = actual Ks, lambda = predicted λ
function nbLogLik(r, observations) {
  let ll = 0
  for (const { k, lambda } of observations) {
    if (lambda <= 0 || k < 0) continue
    const p = r / (r + lambda)   // NB parameterization: P(success) = r/(r+λ)
    ll += logGamma(k + r) - logGamma(r) - logGamma(k + 1)
       + r * Math.log(p) + k * Math.log(1 - p)
    if (!isFinite(ll)) return -Infinity
  }
  return ll
}

// ── Grid-search MLE for r ─────────────────────────────────────────────────────
function fitR(observations) {
  let bestR = 30, bestLL = -Infinity
  for (let r = 0.5; r <= 200; r += 0.5) {
    const ll = nbLogLik(r, observations)
    if (ll > bestLL) { bestLL = ll; bestR = r }
  }
  return { r: bestR, logLik: bestLL }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  await db.migrate()

  // Add nb_r column to pitcher_statcast if not exists (safe no-op)
  await db.run(`ALTER TABLE pitcher_statcast ADD COLUMN nb_r REAL`).catch(() => {})

  // Load all settled pre-game bets with actual Ks and lambda
  const bets = await db.all(
    `SELECT pitcher_id, pitcher_name, actual_ks, lambda, bet_date
     FROM ks_bets
     WHERE actual_ks IS NOT NULL
       AND result NOT IN ('void')
       AND result IS NOT NULL
       AND live_bet = 0
       AND lambda IS NOT NULL
       AND lambda > 0
     ORDER BY pitcher_id, bet_date`,
  )

  if (!bets.length) {
    console.log('No settled pre-game bets with actual_ks found — nothing to fit.')
    await db.close()
    return
  }

  console.log(`Loaded ${bets.length} settled bets across all pitchers.\n`)

  // Group by pitcher — use unique game dates to count "starts" (dedup same-day multiple bets)
  const byPitcher = new Map()
  for (const b of bets) {
    const key = String(b.pitcher_id || b.pitcher_name)
    if (!byPitcher.has(key)) {
      byPitcher.set(key, {
        pitcher_id:   b.pitcher_id,
        pitcher_name: b.pitcher_name,
        byDate:       new Map(),   // date → first obs (lambda + k)
      })
    }
    const entry = byPitcher.get(key)
    // One observation per game date — use first bet's lambda as the game's λ estimate
    if (!entry.byDate.has(b.bet_date)) {
      entry.byDate.set(b.bet_date, { k: b.actual_ks, lambda: b.lambda })
    }
  }

  console.log(`${'Pitcher'.padEnd(28)} ${'Starts'.padStart(6)} ${'r_fit'.padStart(8)} ${'r_default'.padStart(10)} ${'LogLik'.padStart(10)}`)
  console.log('-'.repeat(66))

  let updated = 0
  for (const [, { pitcher_id, pitcher_name, byDate }] of byPitcher) {
    const obs = [...byDate.values()]
    if (obs.length < MIN_STARTS) continue

    const { r, logLik } = fitR(obs)
    const nameStr = (pitcher_name || pitcher_id || '?').toString().padEnd(28).slice(0, 28)
    console.log(
      `${nameStr} ${String(obs.length).padStart(6)} ${r.toFixed(1).padStart(8)} ${'30.0'.padStart(10)} ${logLik.toFixed(1).padStart(10)}`,
    )

    // Write to most recent pitcher_statcast row for this pitcher
    if (pitcher_id) {
      await db.run(
        `UPDATE pitcher_statcast SET nb_r = ? WHERE player_id = ?`,
        [r, String(pitcher_id)],
      ).catch(() => {})
      updated++
    }
  }

  const skipped = [...byPitcher.values()].filter(e => e.byDate.size < MIN_STARTS).length
  console.log(`\nUpdated nb_r for ${updated} pitchers.`)
  console.log(`Skipped ${skipped} pitcher(s) with < ${MIN_STARTS} starts (use default r=30).`)

  await db.close()
}

main().catch(err => { console.error(err); process.exit(1) })
