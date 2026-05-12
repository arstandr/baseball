// Cross-strike candidate generator. Identifies pricing inconsistencies
// across a single pitcher's K markets and emits bet candidates for the
// mispriced strikes.
//
// Math: fit a probability distribution (Poisson) to the market-implied
// P(K >= strike) at each strike. Compute residuals (market - fit). Strikes
// where |residual| > threshold are mispriced. Bet the side market is
// underpricing (residual < 0 → buy YES; residual > 0 → buy NO).
//
// Validated by 18-bet POC on 2026-05-05: 14W/4L, 78% win rate, 62% ROI.

// ── Probability math ────────────────────────────────────────────────────────

export function poissonGEqN(lambda, n) {
  if (n <= 0) return 1
  let cumulative = Math.exp(-lambda)
  let term = cumulative
  for (let k = 1; k < n; k++) {
    term = term * lambda / k
    cumulative += term
  }
  return Math.max(0, Math.min(1, 1 - cumulative))
}

// Negative binomial CDF for fallback when Poisson fits poorly.
// Uses the (r, p) parameterization: P(X = k) = C(k+r-1, k) * (1-p)^k * p^r
function nbGEqN(lambda, r, n) {
  if (n <= 0) return 1
  // Convert (mean, dispersion) to (r, p): mean = r(1-p)/p ⇒ p = r/(r+mean)
  const p = r / (r + lambda)
  let cumulative = Math.pow(p, r)
  let term = cumulative
  for (let k = 1; k < n; k++) {
    term = term * (k + r - 1) / k * (1 - p)
    cumulative += term
  }
  return Math.max(0, Math.min(1, 1 - cumulative))
}

// Fit a Poisson distribution that minimizes SSE between fit and market probabilities.
export function fitDistribution(strikes, marketProbs, opts = {}) {
  const lambdaMin = opts.lambdaMin ?? 1
  const lambdaMax = opts.lambdaMax ?? 15
  const lambdaStep = opts.lambdaStep ?? 0.05

  let bestLambda = 5, bestSSE = Infinity
  for (let lambda = lambdaMin; lambda <= lambdaMax; lambda += lambdaStep) {
    let sse = 0
    for (let i = 0; i < strikes.length; i++) {
      const fit = poissonGEqN(lambda, strikes[i])
      sse += (marketProbs[i] - fit) ** 2
    }
    if (sse < bestSSE) { bestSSE = sse; bestLambda = lambda }
  }
  // Fit quality: average residual across strikes
  const avgResidual = Math.sqrt(bestSSE / strikes.length)
  return {
    lambda: bestLambda,
    sse: bestSSE,
    avgResidual,
    distribution: 'poisson',
    quality: avgResidual < 0.05 ? 'good' : avgResidual < 0.10 ? 'ok' : 'poor',
  }
}

// ── Candidate identification ────────────────────────────────────────────────

// Find all strikes where market price deviates from fit by > threshold.
// Returns sorted by absolute residual magnitude (largest mispricing first).
export function findMispricedStrikes(strikes, marketProbs, fit, threshold = 0.04) {
  const mispricings = []
  for (let i = 0; i < strikes.length; i++) {
    const market = marketProbs[i]
    const fitProb = poissonGEqN(fit.lambda, strikes[i])
    const residual = market - fitProb
    if (Math.abs(residual) < threshold) continue
    // residual < 0: market underprices YES (P market < P fit) → buy YES
    // residual > 0: market overprices YES (P market > P fit) → buy NO
    const side = residual < 0 ? 'YES' : 'NO'
    mispricings.push({
      strike: strikes[i],
      side,
      marketProb: market,
      fitProb,
      residual,
      magnitude: Math.abs(residual),
    })
  }
  return mispricings.sort((a, b) => b.magnitude - a.magnitude)
}

// Filter candidates by quality / safety rules.
export function filterCandidates(candidates, marketDataByStrike, opts = {}) {
  const minResidual    = opts.minResidual    ?? 0.04
  const maxResidual    = opts.maxResidual    ?? 0.20  // outlier filter
  const minAskCents    = opts.minAskCents    ?? 3     // can't trade below this
  const maxAskCents    = opts.maxAskCents    ?? 88    // adverse selection guard
  const maxPerPitcher  = opts.maxPerPitcher  ?? 2     // concentration cap

  const out = []
  for (const c of candidates) {
    if (c.magnitude < minResidual) continue
    if (c.magnitude > maxResidual) continue
    const md = marketDataByStrike.get(c.strike)
    if (!md) continue
    // Compute ask price for the chosen side
    const askCents = c.side === 'YES'
      ? md.yes_ask
      : (md.yes_bid != null ? 100 - md.yes_bid : null)
    if (askCents == null) continue
    if (askCents < minAskCents) continue
    if (askCents > maxAskCents) continue
    out.push({
      ...c,
      askCents,
      ticker: md.ticker,
      yesBid: md.yes_bid,
      yesAsk: md.yes_ask,
      marketMid: md.market_mid ?? md.mid,
    })
    if (out.length >= maxPerPitcher) break
  }
  return out
}

// ── Top-level entry: given a pitcher's full market data, return candidates ──

// Input: array of market objects per strike, e.g.
//   [{strike:5, yes_ask:65, yes_bid:60, market_mid:62.5, ticker:'...'}, ...]
// Returns: array of candidate objects with strategy_mode='pregame_cross_strike'
export function generateCrossStrikeCandidates(pitcherMarkets, opts = {}) {
  if (!pitcherMarkets || pitcherMarkets.length < 4) return []  // need ≥4 strikes
  // Use market_mid as the implied probability source
  const valid = pitcherMarkets.filter(m =>
    m && m.strike != null && m.market_mid != null &&
    m.market_mid > 1 && m.market_mid < 99 &&
    m.yes_ask != null && m.yes_bid != null
  )
  if (valid.length < 4) return []

  const strikes      = valid.map(m => Number(m.strike))
  const marketProbs  = valid.map(m => Number(m.market_mid) / 100)
  const fit          = fitDistribution(strikes, marketProbs, opts)
  const mispricings  = findMispricedStrikes(strikes, marketProbs, fit, opts.minResidual ?? 0.04)
  const dataByStrike = new Map(valid.map(m => [Number(m.strike), m]))
  const filtered     = filterCandidates(mispricings, dataByStrike, opts)

  return filtered.map(c => ({
    strategy_mode:        'pregame_cross_strike',
    strategy_submode:     `crosssstrike_${c.side.toLowerCase()}_resid${(c.residual * 100).toFixed(0)}`,
    strike:               c.strike,
    side:                 c.side,
    ticker:               c.ticker,
    yes_bid:              c.yesBid,
    yes_ask:              c.yesAsk,
    market_mid:           c.marketMid,
    cross_strike_residual:    c.residual,
    cross_strike_market_prob: c.marketProb,
    cross_strike_fit_prob:    c.fitProb,
    cross_strike_fit_lambda:  fit.lambda,
    cross_strike_fit_sse:     fit.sse,
    cross_strike_fit_quality: fit.quality,
    ask_cents:            c.askCents,
  }))
}
