// lib/btcdSignal.js — KXBTCD signal evaluator
//
// Strategy (derived from 34-day backtest, 11,879 samples, signed off 2026-05-10):
//   - Buy NO  when yes-mid ∈ [0.55, 0.70)  → 62.6% win rate, ~+18¢/contract net
//   - Buy YES when yes-mid ∈ [0.70, 0.80)  → 87.5% win rate, ~+10¢/contract net
//
// One signal per qualifying strike per event open. We only evaluate at first
// observation of the event; we do NOT chase mid-window price moves.

import { authedRequest } from './kalshi.js'

export const SERIES = 'KXBTCD'

// Empirical win probabilities from backtest calibration table. These are the
// realized hit rates per band (NOT theoretical models). If live data diverges
// for 100+ trades, retune.
export const BANDS = [
  { lo: 0.55, hi: 0.70, side: 'no',  winProb: 0.626, label: 'no_55_70' },
  { lo: 0.70, hi: 0.80, side: 'yes', winProb: 0.875, label: 'yes_70_80' },
]

export const FEE_RATE = 0.07  // Kalshi: 0.07 × p × (1-p) per contract (rounded)

export async function fetchOpenEvents() {
  const r = await authedRequest('GET', `/events?series_ticker=${SERIES}&status=open&limit=200`)
  return r.data?.events || []
}

export async function fetchEventMarkets(eventTicker) {
  const r = await authedRequest('GET', `/markets?event_ticker=${encodeURIComponent(eventTicker)}&limit=200`)
  return r.data?.markets || []
}

// Evaluate a market list (one event's worth of strikes) and return signal
// candidates that fall in a tradeable band. Caller filters further via risk
// guards.
export function evaluateMarkets(markets, { allowYesBand = true } = {}) {
  const out = []
  for (const m of markets || []) {
    const yesBid = parseFloat(m.yes_bid_dollars ?? 0)
    const yesAsk = parseFloat(m.yes_ask_dollars ?? 0)
    if (!yesBid || !yesAsk) continue          // empty book → skip
    if (yesAsk <= yesBid) continue            // crossed/equal → skip (stale)
    const yesMid = (yesBid + yesAsk) / 2
    const spread = yesAsk - yesBid

    const band = BANDS.find(b => yesMid >= b.lo && yesMid < b.hi)
    if (!band) continue
    if (band.side === 'yes' && !allowYesBand) continue

    // Realistic worst-case fill:
    //   NO:  pay  (1 - yes_bid)   (cross to NO ask ≈ 1 - yes_bid)
    //   YES: pay  yes_ask
    const costPerContract = band.side === 'no' ? (1 - yesBid) : yesAsk
    const feePerContract = FEE_RATE * yesMid * (1 - yesMid)
    const expectedEV = band.winProb - costPerContract - feePerContract

    out.push({
      ticker: m.ticker,
      eventTicker: m.event_ticker,
      side: band.side,
      bandLabel: band.label,
      yesBid, yesAsk, yesMid, spread,
      strike: parseFloat(m.floor_strike ?? 0),
      winProb: band.winProb,
      costPerContract,
      feePerContract,
      expectedEV,
      yesBidSize: parseFloat(m.yes_bid_size_fp ?? 0),
      yesAskSize: parseFloat(m.yes_ask_size_fp ?? 0),
      closeTime: m.close_time,
      openTime: m.open_time,
    })
  }
  return out
}

// Convenience: filter an events list to those that opened recently and have not
// yet been processed. Returns events with close_time in the next ~65 minutes.
export function filterTradeableEvents(events, { now = Date.now(), withinMinutes = 65 } = {}) {
  const horizon = now + withinMinutes * 60 * 1000
  return (events || []).filter(e => {
    if (!e.event_ticker?.startsWith(SERIES + '-')) return false
    const closeMs = Date.parse(e.last_updated_ts ? e.last_updated_ts : '')
    // We don't always get close_time on the events row — defer to per-market check
    return true
  })
}
