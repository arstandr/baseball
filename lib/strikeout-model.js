// lib/strikeout-model.js — Shared strikeout model constants and NB distribution.
//
// Imported by:
//   scripts/live/strikeoutEdge.js  — pre-game edge computation
//   scripts/live/liveMonitor.js    — in-game Kalshi auto-trader
//   scripts/live/inGameEdge.js     — in-game edge finder
//   scripts/live/backtest.js       — calibration backtest

// Dispersion parameter for the Negative Binomial.
// Calibrated from 4,255 starts (2023-2025): actual var/Poisson var = 1.17
// → implied r = mean_λ / (var_ratio - 1) ≈ 30.  Re-calibrate yearly.
export const NB_R = 30

// League-average constants for starters
export const LEAGUE_K9        = 8.8    // MLB avg K/9 for starters
export const LEAGUE_AVG_IP    = 5.2    // MLB avg IP/start
export const LEAGUE_K_PCT     = 0.22   // MLB avg batter K% vs starters
export const LEAGUE_PA_PER_IP = 4.44   // League avg PA/IP for starters
export const LEAGUE_WHIFF_PCT = 0.25   // League avg Savant Whiff% (swings-and-misses/swings)
                                        // NB: Savant Whiff% is per-swing; FanGraphs SwStr% is per-pitch
                                        // K% ≈ Whiff% × (LEAGUE_K_PCT / LEAGUE_WHIFF_PCT) ≈ Whiff% × 0.88

/**
 * Negative Binomial CDF — P(K ≤ k) with mean μ and dispersion r.
 * Uses stable PMF recursion: P(K=i) = P(K=i-1) × (i-1+r)/i × μ/(μ+r)
 * When r → ∞ converges to Poisson(μ).
 */
export function nbCDF(mu, r, k) {
  if (mu <= 0) return k >= 0 ? 1 : 0
  const p_success = r / (r + mu)
  const q = 1 - p_success
  let term = Math.pow(p_success, r)
  let sum  = term
  for (let i = 1; i <= Math.floor(k); i++) {
    term *= (i - 1 + r) / i * q
    sum  += term
    if (sum >= 1 - 1e-10) return 1
  }
  return Math.min(1, sum)
}

/** P(K ≥ n) under NB(μ, NB_R) */
export function pAtLeast(mu, n) {
  return Math.max(0, 1 - nbCDF(mu, NB_R, n - 1))
}

/**
 * Convert baseball IP notation (e.g. 5.2 = 5⅔ innings) to decimal.
 * MLB API stores innings as X.Y where Y ∈ {0,1,2} (thirds of an inning).
 */
export function ipToDecimal(ip) {
  const n = Number(ip || 0)
  return Math.floor(n) + Math.round((n % 1) * 10) / 3
}
