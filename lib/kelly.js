// lib/kelly.js — Kelly criterion bet sizing
//
// Quarter-Kelly against a configured bankroll.
// Kelly fraction = edge / (1 - price) for YES bets
//                = edge / price        for NO bets
// where edge = model_prob - market_price (for YES)
//           or (1 - model_prob) - (1 - market_price) (for NO)
//
// Bet size = bankroll × kelly_fraction × KELLY_MULT
// Capped at MAX_BET_PCT × bankroll. No floor — if Kelly says $0, bet $0.

import 'dotenv/config'

const BANKROLL     = Number(process.env.BANKROLL     || 5000)
const KELLY_MULT   = Number(process.env.KELLY_MULT   || 0.25)   // quarter-Kelly
const MAX_BET_PCT  = Number(process.env.MAX_BET_PCT  || 0.10)   // 10% max per bet

const MAX_BET = BANKROLL * MAX_BET_PCT

/**
 * Discount factor for remaining opportunity count.
 * Reduces sizing when many games are still ahead — preserving capital
 * for later opportunities that may have stronger edge.
 * Approaches 1.0 as remaining count narrows to 1.
 */
export function opportunityDiscount(remaining) {
  if (remaining >= 7) return 0.65
  if (remaining >= 4) return 0.80
  if (remaining >= 2) return 0.90
  return 1.0
}

/**
 * Compute Kelly bet size in dollars for a single market.
 *
 * @param {number} modelProb   - model's true probability (0-1)
 * @param {number} marketPrice - market mid price (0-1)
 * @param {string} side        - 'YES' | 'NO'
 * @param {boolean} isMaker    - maker vs taker order
 * @param {number} [bankroll]  - override module-level BANKROLL (use live pre-game pool)
 * @returns {{ betSize, kellyFraction, edge, rationale }}
 */
const KALSHI_FEE      = 0.07    // taker fee: 0.07 × C × (1-C) per contract
const MAKER_FEE_FLAT  = 0.001   // maker fee: ~$0.001 per contract (flat, Kalshi tier)

export function kellySizing(modelProb, marketPrice, side, isMaker = false, bankroll) {
  const _bankroll = bankroll ?? BANKROLL
  const _maxBet   = _bankroll * MAX_BET_PCT

  // Price we pay and win/loss amounts per contract
  const price     = side === 'YES' ? marketPrice : (1 - marketPrice)
  // Maker orders pay ~$0.001/contract flat; taker orders pay 0.07×C×(1-C)
  const winPerUnit  = isMaker
    ? (1 - price) - MAKER_FEE_FLAT
    : (1 - price) * (1 - KALSHI_FEE * price)
  const losePerUnit = price

  if (price <= 0) return { betSize: 0, kellyFraction: 0, edge: 0, rationale: 'price too low' }

  // For YES bets modelProb is P(YES wins). For NO bets it's P(YES wins) too,
  // so P(NO wins) = 1 - modelProb.
  const probWin = side === 'YES' ? modelProb : (1 - modelProb)
  // Fee-adjusted edge: E[profit per unit] = p_win × net_win - p_lose × cost
  const feeEdge = probWin * winPerUnit - (1 - probWin) * losePerUnit
  if (feeEdge <= 0) return { betSize: 0, kellyFraction: 0, edge: feeEdge, rationale: 'no edge after fee' }

  // Raw edge (pre-fee, for logging)
  const edge = side === 'YES' ? modelProb - marketPrice : (1 - modelProb) - (1 - marketPrice)

  // Full Kelly = feeEdge / winPerUnit
  const fullKelly = feeEdge / winPerUnit
  const fraction  = fullKelly * KELLY_MULT

  const raw     = _bankroll * fraction
  const betSize = Math.min(_maxBet, raw)  // no floor — edge drives size

  return {
    betSize,
    kellyFraction: fraction,
    fullKelly,
    edge,
    rationale: `${(fraction * 100).toFixed(1)}% Kelly → $${raw.toFixed(0)} → $${betSize.toFixed(2)} (cap=$${_maxBet.toFixed(0)})`,
  }
}

/**
 * Estimate total capital at risk given a bet size and market price.
 * This is what you actually lose if the bet goes wrong.
 */
export function capitalAtRisk(betSize, marketPrice, side) {
  const price = side === 'YES' ? marketPrice : (1 - marketPrice)
  // contracts = betSize / 1.00 (each contract is $1 face value at Kalshi)
  // cost = contracts × price (per contract)
  // but betSize = notional, so actual cost = betSize × price
  return betSize * price
}

/**
 * Correlated Kelly divider for a pitcher with multiple threshold markets.
 *
 * Problem: if we bet YES on 5+, 6+, 7+ Ks for the same pitcher, these bets
 * are highly correlated — an 8K outing pays ALL of them. Summing full Kelly
 * fractions would massively over-size the total exposure.
 *
 * Fix: the total Kelly fraction for a pitcher = max single-threshold Kelly
 * (not the sum), because the bets are essentially redundant from a risk
 * standpoint. We then divide each bet proportionally within that cap.
 *
 * @param {Array<{modelProb, marketPrice, side, edge}>} edges - array of edge
 *   objects for thresholds on the same pitcher (same direction preferred)
 * @returns {Array<{betSize, kellyFraction, scaleFactor, rationale}>}
 *   adjusted bet sizes aligned 1-to-1 with input edges array
 *
 * Example:
 *   5+K YES: full Kelly = 8%  → becomes 8% (largest)
 *   6+K YES: full Kelly = 6%  → scaled to 6/8 × 8% = 6%  (unchanged, within cap)
 *   7+K YES: full Kelly = 3%  → scaled to 3/8 × 8% = 3%  (unchanged, within cap)
 *   Sum = 17% but max single = 8%, so scale all by 8/17 → 3.8% + 2.8% + 1.4%
 *   Total exposure = 8% (= 1 Kelly unit)
 *
 * When there is only 1 edge, returns regular kellySizing result (no scaling).
 * When bets have different sides (YES and NO), they are NOT correlated so
 * each side-group is scaled independently.
 */
export function correlatedKellyDivide(edges, isMaker = false, bankroll) {
  if (!edges || edges.length === 0) return []
  if (edges.length === 1) {
    const { modelProb, marketPrice, side } = edges[0]
    const result = kellySizing(modelProb, marketPrice, side, isMaker, bankroll)
    return [{ ...result, scaleFactor: 1.0 }]
  }

  // Separate YES and NO groups — different sides are not correlated with each other
  const groups = { YES: [], NO: [] }
  for (const e of edges) {
    groups[e.side] = groups[e.side] || []
    groups[e.side].push(e)
  }

  const resultMap = new Map()

  for (const side of ['YES', 'NO']) {
    const group = groups[side] || []
    if (!group.length) continue

    // Compute raw Kelly fractions for each edge in this side-group
    const raw = group.map(e => {
      const k = kellySizing(e.modelProb, e.marketPrice, e.side, isMaker, bankroll)
      return { ...e, raw: k, originalIndex: edges.indexOf(e) }
    })

    const totalRawFraction = raw.reduce((s, r) => s + (r.raw.kellyFraction || 0), 0)
    const maxSingleFraction = Math.max(...raw.map(r => r.raw.kellyFraction || 0))

    // Scale factor = maxSingle / totalRaw  (≤ 1.0, = 1.0 if only 1 edge)
    const scaleFactor = totalRawFraction > 0 ? Math.min(1.0, maxSingleFraction / totalRawFraction) : 1.0

    const _bankroll = bankroll ?? BANKROLL
    const _maxBet   = _bankroll * MAX_BET_PCT

    for (const r of raw) {
      const adjFraction = (r.raw.kellyFraction || 0) * scaleFactor
      const rawDollars  = _bankroll * adjFraction
      const betSize     = Math.min(_maxBet, rawDollars)  // no floor

      resultMap.set(r.originalIndex, {
        betSize,
        kellyFraction: adjFraction,
        fullKelly: r.raw.fullKelly,
        edge: r.raw.edge,
        scaleFactor,
        rationale:
          `corr-Kelly: raw=${(r.raw.kellyFraction * 100).toFixed(1)}% ` +
          `× scale=${scaleFactor.toFixed(3)} ` +
          `= ${(adjFraction * 100).toFixed(1)}% → $${rawDollars.toFixed(0)} → $${betSize.toFixed(2)}`,
      })
    }
  }

  return edges.map((_, i) => resultMap.get(i) ?? null)
}

export const config = { BANKROLL, KELLY_MULT, MAX_BET_PCT, MAX_BET }
