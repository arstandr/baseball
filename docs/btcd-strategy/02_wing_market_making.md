# Strategy 2: Wing Market-Making (Lottery Bucket Maker Fills)

**Status**: ❌ **DEAD — confirmed no-go 2026-05-11 05:30 UTC.** Retroactive backtest using real Kalshi trade tape (5,177 buckets, 93,870 simulated fills) showed every variant loses money. Adverse selection is structural, not tunable.

## VERDICT (2026-05-11)

**Wing market-making does NOT work on KXBTC.** Don't deploy. Don't paper-trade. Don't revisit unless underlying retail behavior changes dramatically.

### The killer finding — adverse selection by price runup

| Pre-fill price runup (5min before fill) | n filled | YES settle rate | P&L |
|---|---|---|---|
| <1¢ (calm) | 658 | **3.3%** | **+$605** |
| 1-3¢ | 302 | 5.0% | +$99 |
| 3-6¢ | 355 | 11.0% | −$1,015 |
| 6-10¢ | 234 | 15.4% | −$1,718 |
| 10¢+ (runaway) | 202 | **24.8%** | **−$3,374** |

Filled buckets settle YES 9.3%; unfilled settle YES 1.7%. **5.5× higher loss rate on filled vs unfilled.** This is causal (monotone with price runup), not noise.

### Why it's dead

The market IS overpricing wing YES asks at the population level (3-7¢ overpricing exists). But to capture that, you'd need to fill on the FULL distribution of buckets. In reality, our orders fill disproportionately on the buckets that are MOVING toward our strike — exactly the ones that are about to win YES. The selection bias on fills eats the entire population-level edge and then some.

This isn't a tunable parameter. You can't "filter out" the runaway fills because by the time you know it's a runaway, you've already filled.

### Test summary

- 5,177 wing buckets (distance ≥$100, ya in [0.03, 0.20])
- 159,600 real trades walked chronologically
- 93,870 simulated fills (50% queue share base case)
- Variants tested: 1¢ inside / 2¢ inside / at-the-ask
- Fill share sensitivity: 20% / 50% / 80%
- Fee sensitivity: standard / no floor / maker-free
- **Every combination loses money.** −4.7% to −12% ROI.

### Statistical confidence

5,177 buckets is a huge sample. Per-bucket P&L std error: $0.35. Average −$1.04. **~3 standard deviations from zero.** This is not a borderline result.

### Data preserved (in case anyone wants to verify)

- `/tmp/wing_targets.json` — 5,177 wing buckets evaluated
- `/tmp/wing_trades_by_market.json` — 159,600 raw trades (~37MB)
- `/tmp/wing_mm_results.json` — full simulation output
- `/tmp/wing_mm_test.py` — reusable simulator
- `/tmp/wing_step1_targets.py`, `/tmp/wing_step2_trades.py`

### What you'd theoretically need for wing market-making to work

You'd need a price-move predictor that beats the order book in real-time. If you could refuse fills on buckets where 5-min realized vol > X, you might capture the calm-bucket edge. But:
- The realized vol info is available to everyone, including the HFTs whose orders sit ahead of you
- A price-move predictor that good is its own profitable strategy
- Not buildable from cold data; requires live tick-level book reconstruction

Not worth pursuing.

### UPDATE 2026-05-11 — Calm-cohort dynamic-cancel test ALSO confirmed dead

Tested 81 parameter combinations of "cancel resting offer when realized 5-min range > THRESHOLD". Best variant: threshold=1¢, lookback=3min, never re-enter, zero latency: **−$19.62 net P&L on 36,023 fills (essentially break-even, ROI −0.06%).**

**Why it doesn't work — the causality problem.** The 658-bucket "calm cohort" from the prior test that showed +$605 profit was identified with POST-HOC knowledge. When you cancel CAUSALLY (using only data up to the current moment):

| | Post-hoc selection | Causal selection |
|---|---|---|
| Method | Filter trades by pre-fill runup | Cancel when running range > threshold |
| Uses future info | Yes | No |
| Result | +$605 on 658 fills | −$19.62 on 36,023 fills |

The 23% problem: even at zero latency, ~23% of fill volume comes during the "cancel-pending" tick — the same moment we decided to cancel. These fills happen at 10.8% YES vs 7.3% for clean fills. **By the time the range trigger fires, you've already been hit by the trade that caused the range expansion.**

Latency makes this dramatically worse:
- 0s latency: −$19.62 (essentially zero)
- 30s latency: −$517
- 60s latency: −$628

Realistic Kalshi WebSocket latency for retail is 1-5s. Strategy is firmly negative under realistic conditions.

### Final verdict (no more revisits)

Wing market-making is **structurally impossible** for a retail trader on Kalshi crypto. The calm cohort exists precisely because nothing happened. There is no causal way to position to capture only that cohort. Stop hunting here.

Files: `/tmp/wing_calm_results.json`, `/tmp/wing_calm_test.py`

---

## (Original analysis below, preserved for context)

## The strategy in one sentence

On Kalshi BTC range markets, post passive YES offers (= NO bids) on far-from-spot "lottery" buckets at prices slightly inside retail's displayed ask, collecting premium from gambling YES buyers who almost always lose.

## Mechanism (why it should work)

Far-from-spot buckets (e.g., "$83,000-$83,100" when BTC is at $81,000) settle YES less than 1% of the time. But retail buyers pay $0.05-$0.10 for them as lottery tickets — they think "what if BTC moons in the next hour."

The market maker who sells those YES tickets at $0.05 keeps the premium 99% of the time. Our hypothesis: by posting offers slightly inside the displayed retail ask, we'd capture some of that flow.

## Backtest results (simulation only)

For each historical wing bucket where:
- Distance from spot >= $100
- yes_ask in [0.03, 0.20] (lottery range)
- spread <= 0.10
- bucket volume > 10 (some retail flow happened)

Simulated placing YES offer at (yes_ask - 1¢), assumed 30% fill rate on bucket volume:

| Distance from spot | n positions | NO win rate | Avg PnL/contract | Simulated 30-day P&L |
|---|---|---|---|---|
| $100-150 | 435 | 92.6% | **−$0.006** | −$2,486 (loses) |
| $150-200 | 325 | 96.0% | +$0.021 | +$6,790 |
| **$200-300** | **270** | **99.6%** | **+$0.055** | **+$15,987** |
| $300-500 | 54 | 98.1% | +$0.032 | +$1,650 |

**Sweet spot: $150-500 from spot** at +$0.02-$0.05 per filled contract.

## Sensitivity to fill rate (THE BIG UNKNOWN)

| Fill rate | Simulated monthly P&L |
|---|---|
| 10% | $7,300 |
| 20% | $14,600 |
| 30% (base case) | $21,900 |
| 50% | $36,600 |

**The 30% assumption is a guess.** Real fill rate depends on:
- Queue position (how many other makers in front of us)
- Whether other makers undercut our price
- Whether KXBTC has active wing market-making competition
- Adverse selection (when retail buys, are they informed?)

## Real fee math (verified from Kalshi PDF)

**Maker fee**: `round_up(0.0175 × C × P × (1-P))` per trade, not per contract.

At p=0.05, 100 contracts in one fill:
- Total fee = round_up(0.0175 × 100 × 0.05 × 0.95) = round_up($0.083) = **$0.09**
- Per contract: ~$0.0009 (essentially negligible)

At p=0.05, 1 contract per fill (worst case batching):
- Per fill = round_up($0.00083) = **$0.01** (rounded up to minimum)
- Per contract: $0.01 (eats 20% of $0.05 revenue)

**Strategy implication**: post LARGER offer sizes per resting order. Batches of 50-200 contracts per fill is optimal. Single-contract trades get murdered by fee rounding.

## Liability and collateral (REAL math)

Posting a YES offer at $0.05 = equivalent to buying NO at $0.95.

- **Per contract collateral locked**: $0.95
- **Max loss per contract if YES wins**: $0.95 (your locked collateral)
- **Cannot lose more than locked** — no margin, no surprise calls

### Mutually-exclusive collateral return (THE KEY EFFICIENCY)

KXBTC range buckets within an event are mutually exclusive (only ONE wins). If you have NO bids on 10 different wing buckets at $0.95 each:

- Naive lock: 10 × N contracts × $0.95
- Kalshi auto-returns redundant collateral because you can only lose on ONE bucket
- **Effective lock per event: ~N contracts × $0.95** (one bucket's worth)

This is a ~10x capital efficiency gain. **A $1K bankroll could potentially support 100-contract bids on 10+ wing buckets per event.**

## Projected economics (with realistic assumptions)

Per event:
- 10 wing buckets quoted at 100 contracts each
- Effective collateral lock (with collateral return): ~$95
- Fill rate at 20% (conservative): 200 contracts total filled across buckets at avg $0.05
- Revenue: 200 × $0.05 × 0.99 = $9.90 collected
- Losses: 200 × $0.95 × 0.01 = $1.90 paid out
- Maker fees: ~$0.50-1.00 across fills
- **Net per event: $6-7**

Per day (24 events): ~$150-170
Per month (30 days): **$4,500-5,000**

If fill rate is 30% (base case): $7-9K/month
If fill rate is 5% (pessimistic): $1-2K/month
If adverse selection eats half: cut all numbers by 50%

## Why this might NOT work in production

1. **Adverse selection**: when retail buys lottery YES, sometimes news just hit. The 99.6% NO win rate is the all-volume average — informed flow wins more often. Could cluster into bad days.
2. **Queue position**: posting at ask-1¢ makes us inside, but other makers can immediately undercut us. Queue dynamics not modeled.
3. **Maker fee on rounding**: small orders pay full $0.01 minimum, killing edge on 1-contract fills.
4. **Liquidity pulls in volatile moments**: when BTC moves fast, MMs cancel resting orders. Our fills cluster in moments when we're most likely wrong.

## Validation plan (DO THIS BEFORE DEPLOYING)

### Step 1: Trade-tape logging (cost: 1-2 hours code, 1 week wait)

Add to existing paper trader:
- Subscribe to Kalshi WebSocket trade feed for KXBTC events
- For each trade, log: ticker, timestamp, price, side (taker_side), size
- After 1 week, compute:
  - What fraction of wing-bucket trades happen at the inside ask vs walk the book
  - What size distribution looks like (lots of 1-contract trades or batches)
  - Whether trades cluster around price moves (adverse selection signal)

### Step 2: Paper market-making (cost: 1 week)

Build a paper bot that:
- Identifies wing buckets each event
- Computes "if I posted X contracts at Y price, would I have filled?"
- Tracks simulated fills against the real trade tape
- Computes realistic P&L

### Step 3: Small live test (cost: $100-300 capital, 2 weeks)

Place actual maker orders on wing buckets. Measure:
- Actual fill rate
- Actual win rate when filled
- Slippage vs simulation
- Operational issues

## Decision criteria

Deploy at meaningful size only if:
- Real fill rate >= 15% (under simulation assumption of 30%, half is acceptable)
- Win rate >= 95% on wing buckets (matches simulation)
- No adverse selection clustering (no week where YES win rate spikes >5%)
- Maker fee structure confirmed (KXBTC uses standard 0.0175 schedule)

## Sized estimate (if validation passes)

Conservative live estimate: **$2-5K/month additional on top of closest-bucket strategy**.

Combined with closest-bucket: **$5-10K/month total at the $7-20K bankroll level**.

## Open implementation questions

- How wide to post? At ask-1¢ (most aggressive) vs ask-2¢ (less competition)?
- How many wing buckets per event to quote?
- Per-bucket size: 50, 100, 200 contracts?
- Cancel-and-reprice cadence: when spot moves, when to update?
- Maker-only flag (`post_only`) on order placement?

## Reference

- Test #2 backtest: `/tmp/proper_tests.py`
- Wing volume analysis: `/tmp/volume_analysis.py`
- Fee verification: screenshots of Kalshi PDF in conversation 2026-05-11 04:09 UTC
