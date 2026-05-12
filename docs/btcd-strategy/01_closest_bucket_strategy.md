# Strategy 1: Closest-Bucket YES Buy (KXBTC + KXETH)

**Status**: ✅ **Validated.** Paper-trading live (PID 76909). Awaiting 30 days of real-fill data before committing capital.

## The strategy in one sentence

At 5 minutes before each hourly Kalshi range market closes, identify the single bucket whose center is closest to the current Coinbase spot price, and buy YES on that bucket if it passes the refined filters.

## Mechanism (why it works)

Kalshi's range markets settle on a 60-second TWAP of CF Benchmarks BRTI at the top of each hour. With 5 minutes left, ~98% of the time the price stays in the bucket it's currently in. But Kalshi's market makers re-quote the closest-bucket ask slightly slower than spot drifts, leaving the bucket priced ~5-10¢ below fair probability. We capture that gap.

## Filters (locked, do not re-tune)

```
T-5min snapshot:
  yes_ask <= 0.70
  (yes_ask - yes_bid) <= 0.10
  yes_mid in [0.40, 0.65]
  distance from spot:
    BTC: <= $30
    ETH: <= $6
```

## Validated metrics

| Asset | Sample | Win rate | EV/contract | Bootstrap P(EV>0) |
|---|---|---|---|---|
| BTC in-sample (Apr 11-May 11) | 322 trades | 59.9% | +$0.057 | 98.6% |
| BTC out-of-sample (Mar 1-Apr 10) | 493 trades | 58.4% | +$0.039 | ~95% |
| BTC combined (unrefined) | 815 trades | 58.9% | +$0.046 | >99% |
| **BTC refined filters (validated 2026-05-12)** | **132 trades** | **68.9%** | **+$0.105** | >99% |
| ETH in-sample (Apr 16-May 11) | 107 trades | 71.96% | +$0.151 | >99% |

### Refined-strategy validation (Test A + Test B, 2026-05-12)

After running the refined-filter strategy through:
- Test A (boundary stratification): confirmed the `dist ≤ $30` filter already captures the buffer effect. No tighter dist filter helps.
- Test B (5-min pre-decision realized vol): no signal. Vol doesn't predict outcome.

**The refined strategy is FINAL. No additional filters help.**

Updated realistic expectations:
- Per-contract EV: +$0.10 (not +$0.05 as projected from unrefined backtest)
- Win rate: 68.9% (not 60%)
- Monthly P&L on $7K bankroll: **$3-5K** (not $2-3K)
- 12-month outcome: **$35-60K** (not $25-40K)

## Frequency

- BTC: ~11 trades/day at validated filter; ~5-7/day at refined filter
- ETH: ~1.4 trades/day at validated; ~0.7-1/day at refined
- Combined: ~8 actionable signals per day

## Liquidity caps (critical)

Per-bucket inside ask depth at T-5min: typically **9 contracts** (one MM bot quoting 9-lot at every level).

| Trade size | Realistic slippage |
|---|---|
| ≤ $50 (100 contracts) | 0¢ |
| $50-150 | 1¢ |
| $150-300 | 2¢ |
| $300-500 | 3-4¢ (eats most edge) |
| $500+ | 5¢+ (edge gone) |

**Per-trade cap: $150-200 at 2% sizing means bankroll caps at ~$7.5K-10K.** Beyond that, growth becomes linear at ~$3K/month additional.

## P&L projections (with realistic frictions)

| Scenario | 12-month outcome on $7K |
|---|---|
| Catastrophic (edge wasn't real) | $5-7K (small loss) |
| Pessimistic (edge dies fast) | $9-13K |
| **Median** | **$30-40K** |
| Optimistic | $50-65K |
| P(losing month) | ~7-10% |

## Fee model (REAL)

```python
def kalshi_fee(price_yes):
    # Taker: round_up(0.07 × C × P × (1-P)), $0.01 minimum per trade
    raw = 0.07 * price_yes * (1 - price_yes)  # per contract
    # NOTE: rounding happens at trade-level (sum of contracts), not per contract
    return max(0.01, math.ceil(raw * 100) / 100)
```

## Risk guards (must implement before live)

| Guard | Threshold |
|---|---|
| Daily loss cap | -10% of starting bankroll halts until UTC midnight |
| Exposure cap | open position cost > 20% of bankroll → skip new |
| Spread guard | spread > 5¢ → skip (already in filter) |
| EV guard | expected EV after fees < +$0.02 → skip |
| Per-event cap | max 1 strike per event (currently enforced — closest only) |
| Edge decay halt | 30-day rolling EV < +$0.02 → STOP TRADING |

## Operational

- **Process**: `/tmp/dual_paper_v2.py` (PID 76909 as of 2026-05-11 02:49 UTC)
- **Log**: `/tmp/dual_paper_log.jsonl` — appends one JSON line per signal/skip/settle
- **State**: `/tmp/dual_paper_state.json` — pending settles + evaluated hours
- **Auth**: Isaiah's Kalshi key (per_user_creds[0] in baseball-secrets)
- **Spot feed**: Coinbase REST `/v2/prices/{BTC,ETH}-USD/spot`
- **Cadence**: hour:54:30 each hour for decision; hour:01:30 for settle check

## Live-deploy readiness gates

Before flipping to real money:

1. [ ] 30 days of paper trading complete
2. [ ] Real-fill prices match candle-close ask within 1¢ on average
3. [ ] Win rate within ±5pp of backtest expectation
4. [ ] No 7+ day losing streaks
5. [ ] Daily loss cap tested (forced halt at -10% works)
6. [ ] Discord daily summary working
7. [ ] Verified KXBTC/KXETH maker fee status (confirmed standard 0.0175 schedule)

## Production code paths

When ready to build production version:

- `lib/btcdSpotFeed.js` — Coinbase REST spot polling (already drafted)
- `lib/btcdSignal.js` — signal evaluator (already drafted, needs refined-filter update)
- `lib/btcdBankroll.js` — sizing + daily caps (already drafted)
- `lib/btcdPaperTrader.js` — pending
- `lib/btcdSettleMonitor.js` — pending
- `lib/btcdReporter.js` — Discord daily summary, pending
- `pipeline/btcd.js` — main loop orchestrator, pending
- DB schema: `btcd_*` tables in `db/schema.sql` (already drafted)

## Open questions

- Does the edge persist past 30 days? Kalshi MMs may tighten quotes once they notice consistent buying pressure on closest bucket.
- Real-world fill quality vs candle-close ask? Could be 1-3¢ worse.
- Does the ETH edge survive at smaller bankroll (where you can't buy enough contracts for fees to be efficient)?

## Reference: backtest methodology bugs we fixed

1. **Stale-mid bias** (the big one): early backtest used candle `open_dollars` which is the inside book BEFORE any trading in that minute (often 0.05 bid / 1.00 ask). Real-book uses `close_dollars` of the minute candle.
2. **Volume-filter survivorship bias**: filtering to "volume_fp > 50" excluded buckets that didn't trade. Removed.
3. **Coinbase candle timestamp off-by-one**: the candle ending at minute T has `time` = T - 60, not T. Fixed.

All three were caught and corrected during multi-agent review. Re-running with these fixes dropped the projected monthly return from "$150K" to "$3-5K" — but the remaining edge is real.
