# Kalshi Crypto Strategy — Overview & Decisions Log

**Status as of 2026-05-11 04:20 UTC**: Paper-trading active. One validated edge (closest-bucket). One promising untested edge (wing market-making). One pending test (cross-product arb).

## Strategies in scope

| # | Strategy | Status | Files |
|---|---|---|---|
| 1 | Closest-bucket YES buy (BTC + ETH, T-5min) | ✅ **Validated, paper-trading live** | `01_closest_bucket_strategy.md` |
| 2 | Wing market-making (lottery bucket maker fills) | ❌ **DEAD (confirmed 2026-05-11)** — adverse selection structural | `02_wing_market_making.md` |
| 3 | KXBTCD vs KXBTC cross-product arb | ❌ **DEAD (confirmed 2026-05-11)** | `03_cross_product_arb.md` |

## What we eliminated (don't waste time revisiting)

- **NO band buying YES** [0.55-0.70): was lookback bias. Win rate 36.5% not 62.6% on real-book prices. Dead.
- **Multi-bucket extension (2nd/3rd closest)**: empirically negative EV. 2nd closest YES = -$0.10/contract. Dead.
- **T-15min, T-30min, T-60min snapshot times**: all negative EV. Only T-5min works. Dead.
- **Cross-strike monotonicity arb**: 0 arbs in 1,100 events. Kalshi MMs prevent this. Dead.
- **Wing NO-side buying as taker**: marginal at best (CI straddles zero). Dead as taker.
- **ATP Challenger tennis ELO model**: Kalshi market beats ELO. Win rate 21.5% on disagreement trades. Dead.
- **Original $150K backtest claim**: methodology error (used stale-book "open" mid prices). Real edge is ~5x smaller.
- **3-5 traders running same strategy**: liquidity-capped, cannibalizes itself. Don't share.
- **Cross-product arb (KXBTCD vs KXBTC)**: structurally infeasible. Synthetic via 5+ range buckets has 25¢ of bid-ask drag vs directional's 1¢. Confirmed 2026-05-11.
- **Wing market-making (maker)**: backtest showed −5% to −8% ROI across all variants. Adverse selection: filled buckets settle YES 5.5× more than unfilled. Confirmed 2026-05-11 with 5,177 buckets + 93,870 fills.
- **Tennis mirror-market parity**: HFTs keep both sides at ±1 tick. 2,466 pairs analyzed, 0 capturable arbs.
- **Distance-to-boundary filter on closest-bucket**: existing `dist ≤ $30` filter already captures this. Test A confirmed.
- **Pre-decision realized vol filter on closest-bucket**: no statistically significant signal. Test B confirmed.

## Bankroll & expected outcomes

| Bankroll | 12-month outcome (median) | Limit |
|---|---|---|
| $7K | $30-50K | Strategy ceiling |
| $25K | $50-70K | Same strategy, more capital idle |
| $50K+ | Only useful with multiple uncorrelated edges | Diversification required |

## Critical operational facts (Kalshi platform)

- **Maker fee**: 0.0175 × C × P × (1-P), rounded up to next cent at TRADE level (not per contract). For 100 contracts at $0.05: $0.09 fee (~0.09¢ per contract).
- **Taker fee**: 0.07 × C × P × (1-P), rounded up at trade level. For 100 contracts at $0.50: $1.75.
- **Collateral**: full max-loss locked when resting order placed. Cannot lose more than locked capital.
- **Mutually-exclusive collateral return**: KXBTC/KXETH range buckets are mutually exclusive → only one can lose → Kalshi auto-returns redundant collateral. Major capital efficiency boost.
- **Settlement source**: CF Benchmarks BRTI 60-second TWAP at top of hour.

## Active paper-trading

Process PID 76909 (dual_paper_v2.py). Logs to `/tmp/dual_paper_log.jsonl`. Started 2026-05-11 02:49 UTC.

Decision time: every hour at top-of-hour minus 5:30. Evaluates BOTH KXBTC and KXETH. Records every signal (taken or skipped) with reasoning.

Status check anytime: `python3 /tmp/btcd_paper_status.py`

**Snapshot 2026-05-11 ~23:00 UTC (20h in)**: 5 BTC trades placed (26% trigger rate, matches backtest), 0 ETH trades (ETH closest-bucket ask consistently 0.91-1.00 → refined filter rejects), 2W-3L on BTC = 40% win rate, −$0.94 P&L. Sample n=5 is meaningless. ETH zero-trigger is a concern to watch — may need to widen ETH filter if pattern persists past day 3.

## Decision log

| Date | Decision | Reasoning |
|---|---|---|
| 2026-05-10 | Walk away from KXBTCD directional bucket strategy | Methodology error revealed: stale mids drove fake edge. Real win rate at refined ask is 36% NO, not 62%. |
| 2026-05-10 | Walk away from tennis Challenger ELO | Kalshi market beats ELO by 14 pp log-loss. Market is right when ELO disagrees by 10+ cents 80% of the time. |
| 2026-05-10 | Adopt closest-bucket KXBTC/KXETH T-5min strategy | Passed in-sample, out-of-sample, cross-asset, walk-forward, bootstrap. Multi-bucket extension proven negative. |
| 2026-05-11 | Refined filters: mid ∈ [0.40, 0.65], dist ≤$30 (BTC) / $6 (ETH) | Stratified analysis showed +60% per-trade EV with these filters. Paper trader updated. |
| 2026-05-11 | Defer wing market-making | Math looks profitable but fill-rate assumption (30%) is unverified. Need 1 week of trade-tape logging first. |
| 2026-05-11 | Pull cross-product arb data | Cheap test, math is risk-free if arb exists. Likely HFT-arbed but worth checking. |

## Pre-deploy checklist

Before committing real capital to ANY of these strategies:

1. [ ] 30+ days of paper-trading data on the validated strategy
2. [ ] Live fill prices within 2¢ of backtest assumption
3. [ ] Win rate within 5pp of backtest (60% BTC, 72% ETH)
4. [ ] Realistic per-trade slippage measured
5. [ ] Discord alerting wired up for daily summaries (not real-time signals)
6. [ ] Daily loss cap implemented (-10% of starting bankroll halts trading until midnight UTC)
7. [ ] Per-event cap implemented (max 2 strikes per event — though current strategy is 1)

## Hard rules (from prior incidents)

- Discord notifications: daily summary only, NEVER per-signal
- No live deployment until refined paper trader confirms backtest in production
- Stop trading if 30-day rolling EV/contract drops below +$0.02
- Never amend prior commits or use --no-verify

## Reference files

- `/tmp/dual_paper_v2.py` — current paper trader (v2 with refined filters)
- `/tmp/dual_paper_log.jsonl` — paper trade log (jsonl, one event per line)
- `/tmp/kxbtc_backtest.py` — reusable no-bias backtester
- `/tmp/kxbtc_backtest_data.json` — 23K T-5/T-15/T-30/T-60 snapshots
- `/tmp/kxeth_outsample_data.json` — 1,477 ETH T-5 snapshots
- `/tmp/kxbtc_outsample_trades.json` — 493 out-of-sample BTC trades
- `/tmp/recalibrate_summary.json` — combined calibration tables
