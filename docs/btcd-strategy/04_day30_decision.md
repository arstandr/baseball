# Day-30 Deploy Decision Framework

**Paper-trade start**: 2026-05-11 02:49 UTC
**Day-30 review date**: 2026-06-10
**Decision deadline**: 2026-06-11 (allow 1 day for review)

## What we're trying to confirm

The closest-bucket strategy validated in backtest produces:
- Win rate: 60% BTC, 72% ETH (refined filters expected ~5pp higher)
- EV per contract: +$0.046 BTC, +$0.151 ETH
- Trigger frequency: ~30% of BTC hours, ~5% of ETH hours

The paper trade tests whether these numbers HOLD in live execution (real fills, real timing, real market conditions).

## Pass / fail gates (must clear ALL to deploy)

### Gate 1: Trigger frequency
- BTC paper-trades placed: must be 60-150 over 30 days (refined filter expected ~150)
- ETH paper-trades placed: 0-30 acceptable (ETH was always sparse)
- If BTC trigger rate is <50 trades in 30 days, refined filter is too strict — re-evaluate

### Gate 2: Win rate (PRIMARY GATE)
Compute win rate on BTC paper trades (closed and settled):
- **PASS**: ≥60% (within backtest range)
- **MARGINAL**: 55-60% (proceed with reduced size)
- **FAIL**: <55% (DO NOT DEPLOY — strategy is broken)

Wilson 95% CI on win rate:
- At n=60 trades: CI = ±12pp (wide, accept lower bound 48%)
- At n=100 trades: CI = ±10pp (tighter, accept lower bound 50%)
- At n=150 trades: CI = ±8pp (accept lower bound 52%)

### Gate 3: Realized EV per contract
- Compute average net P&L per contract across all paper trades
- **PASS**: ≥+$0.02 per contract net (after fees)
- **MARGINAL**: $0 to +$0.02 (deploy at minimum size)
- **FAIL**: <$0 net per contract — strategy is losing real money

### Gate 4: No catastrophic streaks
- Longest losing streak: max 8 trades
- Max drawdown over the 30-day window: <25%
- If either is violated, the variance is higher than backtest suggested

### Gate 5: Live-execution slippage
For each paper trade, the log records the `yes_ask_dollars` we paid (live) and we can compare to the candle-close ask from the backtest:
- **PASS**: live fill within 1¢ of candle-close ask on average
- **FAIL**: live fill consistently 2¢+ worse → real-world friction kills the edge

### Gate 6: ETH-specific check
If ETH has zero trades after 30 days, the refined filter may be too strict for ETH market structure:
- Investigate: what % of ETH hours had yes_ask in [0.40, 0.65]?
- Consider relaxing the ETH filter to mid in [0.35, 0.70] OR drop ETH entirely

## Deploy mode if all gates pass

Phase 1 (Week 1 of live trading):
- 1 contract per trade only (max $1 per trade at risk)
- Manual oversight, check log every 6 hours
- Stop trading if any single-day drawdown >5%

Phase 2 (Weeks 2-3):
- 5 contracts per trade
- Daily Discord summary
- Stop if rolling 7-day P&L turns negative

Phase 3 (Week 4+):
- Scale to 2% sizing capped at $150/trade
- Run continuously
- Edge-decay halt: if 30-day rolling EV < +$0.02/contract, STOP

## Rolling-decay halt criteria (apply post-deploy)

After 30 days of LIVE trading at any size, if any of these trigger, stop:
- 30-day rolling EV per contract < +$0.01
- 30-day rolling win rate < 52%
- Single-day P&L < −10% of bankroll
- Max drawdown over rolling 14 days > 20%

These are NOT the same as paper-trade gates. Live edge decay is the eventual death of this strategy. Detect it early.

## Files for day-30 review

By 2026-06-10, these should be available:
- `/tmp/dual_paper_log.jsonl` — full event log (signals, skips, settles)
- Optional: a daily-summary script to extract metrics

## Monitoring script

A simple script to check current paper-trade status: see `/tmp/btcd_paper_status.py` (to be created).

## What to do if it fails

If the 30-day paper trade doesn't pass gates:
1. Don't deploy. The strategy is either broken or the edge wasn't real.
2. Don't immediately rebuild — review the data first to understand why.
3. Possible failure modes:
   - Market makers tightened quotes → edge died (most likely)
   - Backtest had a methodology bug we missed
   - Regime changed (BTC vol environment shifted)
4. Cost of failure: lost time. No real capital at risk.

## Realistic timeline

- 2026-05-11: paper trading starts
- 2026-06-10: 30-day review
- 2026-06-11: deploy or kill decision
- 2026-06-12 to 2026-06-18: Phase 1 (1 contract/trade)
- 2026-06-19 to 2026-07-02: Phase 2 (5 contracts/trade)
- 2026-07-03 onwards: Phase 3 (full sizing)

First meaningful live P&L: probably ~2026-07-15 onwards.

First "is this actually working at full size" answer: ~2026-08-15 (30 days at full size).

If passing all gates and edge persists: realistic 2026 outcome on $7K bankroll is **$15-25K profit by year-end**. That's not the $150K fantasy but it's real money.
