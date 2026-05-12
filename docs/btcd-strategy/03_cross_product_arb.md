# Strategy 3: KXBTCD vs KXBTC Cross-Product Consistency Arb

**Status**: ❌ **DEAD — confirmed no-go 2026-05-11 04:55 UTC.** Test completed, 0 arbs found across 1,666 (event, strike) pairs.

## VERDICT (2026-05-11)

**Cross-product arb does not exist on KXBTCD vs KXBTC.** Don't waste more time on it.

### Why it doesn't work — structural reason

- KXBTCD directional median spread: **$0.01**
- KXBTC range buckets median spread: $0.05 each
- Median 5+ above-strike buckets summed: **$0.25 of aggregated bid-ask spread on synthetic side**
- Synthetic replication of directional is ALWAYS more expensive than buying directional outright

The market microstructure itself prevents the arb. HFT competition not even required.

### Test results summary

- 612 events matched (Apr 11 - May 11 2026), 1,666 (event, strike) pairs analyzed
- **Path A (synthetic via range asks + directional NO)**: 0/1,666 gross-positive. Median gap: -$0.22. Max gross profit: -$0.01.
- **Path B (directional YES + buy NO on every above-bucket)**: 3/1,666 questionable cases, all in one event at T-5min where strike was already decided (yb=0.99). +$0.03 on $8 capital, requires 10 simultaneous fills, not exploitable.
- **Settlement consistency**: 612/612 events agreed perfectly between products. No settlement-source arb either.

### Data preserved

- `/tmp/btcd_arb_events.json`
- `/tmp/btcd_arb_markets_by_event.json` (235MB)
- `/tmp/btcd_arb_candles.json` (10K candles at T-5min)
- `/tmp/btcd_arb_results.json` (1,666 per-strike computations)
- `/tmp/btcd_arb_analyze.py`, `/tmp/btcd_arb_test.py`
- `/tmp/btcd_arb_report.txt`

### Open caveat (mostly irrelevant)

Only T-5min was tested. T-15/T-30 would likely be WORSE (wider range spreads further from close), not better. Test agent confirmed this prediction structurally.

---

## (Original analysis below, preserved for context)

## The strategy in one sentence

Both products trade against the same outcome (BTC price at top of hour) but through different mechanics. If their pricing ever diverges by more than the spread, free arbitrage exists.

## The math

For any strike $X at any close time T:

**Synthetic position via ranges**: Buy YES on every KXBTC range bucket above $X. Total cost: sum of those yes_asks. Payout: $1 if BTC > $X at T (exactly one of those buckets wins).

**Direct position via directional**: Buy YES on KXBTCD-T-X. Cost: directional yes_ask. Payout: $1 if BTC > $X at T.

**Equivalent positions** ⇒ **must cost the same**. If they don't, arb.

## The arb structure

When `sum(KXBTC yes_asks above $X) + (1 - KXBTCD yes_bid for $X) < $1.00`:

1. Buy YES on every KXBTC range bucket above $X (cost: sum of asks)
2. Buy NO on KXBTCD strike $X (cost: 1 - yes_bid)
3. Total cost: < $1.00
4. Guaranteed payout: $1.00 (one path wins regardless of BTC outcome)
5. **Profit: $1.00 - total cost, risk-free**

## Why it might exist

- Two products have different audiences (directional = simple bettors; range = lottery/sophisticated)
- Kalshi market makers may quote them independently
- Settlement is the same source (BRTI 60s TWAP) so no settlement-source risk

## Why it might NOT exist

- HFTs likely watching for this exact inconsistency (Susquehanna et al.)
- Any persistent 2¢+ gap gets arbed in seconds
- Kalshi MMs may consciously price these to match
- Bid-ask spread on both sides eats edge

## Expected outcomes

| Likelihood | Result |
|---|---|
| 70% | Range-sum and directional within 1-2¢. No exploitable arb. |
| 25% | Transient 3-5¢ gaps during thin liquidity hours. ~$0.02-0.04/trade net edge. Low frequency. |
| 5% | Persistent 5+ cent gaps. ~$2-4K/month edge. Probably Kalshi fixes it within a quarter. |

## Test methodology (the right way, no future bias)

### Data needed

1. **KXBTCD events** for the same time window as existing KXBTC data (Apr 11-May 11, 2026)
2. **KXBTCD strike markets** for each event (all strikes)
3. **1-min candle at T-5min** for each KXBTCD strike (`yes_bid.close_dollars`, `yes_ask.close_dollars`)
4. **Match by close_ts** to the existing KXBTC range bucket data

### Analysis steps

For each matched event at T-5min:
1. For each KXBTCD strike $X:
   - Get directional yes_bid, yes_ask
   - Compute sum of KXBTC range bucket yes_asks above $X
   - Compute sum of KXBTC range bucket yes_bids above $X
2. Check arb condition:
   - Lower bound: `sum_above_yes_ask` vs `yes_bid_directional`
   - If `sum_above_yes_ask < yes_bid_directional` by more than fees+spread, arb exists
3. Tally: number of arb opportunities, magnitude, persistence over time
4. Sanity: do BTCD and KXBTC settlements actually agree? (They should.)

### Pass criteria

Real arb exists if:
- At least 10 events per week show clear gap > spread+fees
- Gap is persistent for >30 seconds (capturable)
- Combined size of both sides is tradeable at our bankroll

## Capital efficiency note

Even IF arb exists, it's CAPITAL-INTENSIVE:
- Buy YES on ~30 range buckets (each ~$0.01-0.05) = ~$1-2 collateral per contract
- Buy NO on 1 directional ($0.40 cost typical) = $0.40 collateral
- For 100-contract arb: ~$150-250 capital tied up per event

Collateral return doesn't fully apply here because the two products are NOT in the same mutually-exclusive group from Kalshi's perspective.

## Decision criteria

If test finds:
- **0-1 arbs per week**: skip the strategy
- **5-10 arbs per week, $0.02-0.05 each**: maybe worth building (~$300-500/month)
- **20+ arbs per week, $0.05+ each**: clear deploy, $1-3K/month potential

## Files (will be created during test)

- `/tmp/btcd_arb_events.json` — KXBTCD events matched to KXBTC
- `/tmp/btcd_arb_candles.json` — 1-min candles for BTCD strikes
- `/tmp/btcd_arb_results.json` — gap analysis + arb opportunity tally
- `/tmp/btcd_arb_test.py` — re-runnable test script

## Status updates will go here

(awaiting test completion)
