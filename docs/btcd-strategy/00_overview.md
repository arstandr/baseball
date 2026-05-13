# Kalshi Crypto Strategy — Overview & Decisions Log

> **Self-sufficient entry point.** Reading this single file should give you everything you need to know what is running, where, how to check on it, what's been tried, what's been killed, and what the open questions are. If you need detail on a specific strategy, see the linked files.

**Status as of 2026-05-13 14:30 UTC**: Paper-trading active (Day 2.4). One validated edge (closest-bucket BTC + ETH T-5min). Shadow tracker active for filter-expansion candidates. ETH live trigger rate currently 0% — watching. No real money committed.

## TL;DR — the actual system right now

- **What's running:** local Mac Python process `dual_paper_v2.py` (PID 76909 since 2026-05-11 02:49 UTC). NOT on Railway, NOT in the Node.js `lib/btcd*.js` modules (those are an unrelated, unwired build attempt — ignore them).
- **What it does:** every hour at top-of-hour minus 5:30, evaluates the closest range bucket on KXBTC and KXETH; if it passes filters (`mid ∈ [0.40, 0.65]`, `ask ≤ 0.70`, `spread ≤ 0.10`, `dist ≤ $30 BTC / $6 ETH`) buy YES at the ask; settles on CF Benchmarks BRTI 60-sec TWAP at top of hour.
- **Where the data lives:** all in `/tmp/` — see "File map" section below.
- **How to check status in one command:** `python3 /tmp/btcd_paper_status.py`
- **Shadow tracker (added 2026-05-13):** observationally logs the counterfactual outcome of every SKIPPED signal so we can see whether the filter is rejecting winners — without retuning on a tiny sample. Runs hourly via launchd. Status: `python3 /tmp/btcd_shadow_tracker.py --report`.
- **Day-30 gate (hard rule before any real money):** ≥60 BTC trades + ≥60% win rate + ≥ +$0.02 avg EV per contract. Currently: 11 trades, 45.5% win, −$0.13 EV. 2.4/30 days elapsed.

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

### Filter config (refined 2026-05-11)

| Filter | Value | Why |
|---|---|---|
| `mid_min` | 0.40 | Below this, payout / risk asymmetry too unfavorable on losses |
| `mid_max` | 0.65 | Above this, breakeven win rate too high — narrow margin for error |
| `ask_cap` | 0.70 | Hard cap — see "ask ≥ 0.95" finding in shadow tracker |
| `spread_cap` | 0.10 | Wider spreads ⇒ market less efficient → suspect |
| `btc_dist_cap` | $30 | Spot within $30 of bucket center (~half a bucket) |
| `eth_dist_cap` | $6 | Same idea, smaller ETH bucket size |

### Live snapshots

**2026-05-11 ~23:00 UTC (20h in):** 5 BTC trades placed (26% trigger rate, matches backtest), 0 ETH trades (ETH closest-bucket ask consistently 0.91-1.00 → refined filter rejects), 2W-3L on BTC = 40% win rate, −$0.94 P&L. Sample n=5 is meaningless. ETH zero-trigger is a concern to watch — may need to widen ETH filter if pattern persists past day 3.

**2026-05-13 ~14:30 UTC (Day 2.4):** 55 BTC decision points → 11 trades (20% trigger), 5W/6L (45.5% win, CI 21-72%), avg cost $0.585, P&L −$1.43 on $6.43 deployed (−$0.13/contract). Breakeven win rate at avg cost = 58.5%; lower CI bound (21%) is below breakeven — can't yet distinguish "edge eroded" from "small-sample noise". ETH: 55 decisions, 0 trades — filter still rejecting every signal (ask consistently 0.91-1.00). Update this section by running `python3 /tmp/btcd_paper_status.py`.

**2026-05-13 15:12 UTC — trader restarted with depth logging:** The dual-paper trader (`/tmp/dual_paper_v2.py`) was patched to capture and log `yes_ask_size`, `yes_bid_size`, and `vol_24h` on **every signal** (taken or skipped). Old instance (PID 76909, ran 2 days 12h) killed gracefully; new instance running. Reason: we cannot answer "how many contracts could I actually fill" from a snapshot-and-estimate process — the orderbook moves. Now we'll have ground-truth depth at every decision point inside `/tmp/dual_paper_log.jsonl`, and the shadow log carries it through. After ~1 week of accumulated rows we can answer "if I sized to $5K, what would have actually filled" from measured data, not from a single live-snapshot estimate of the next-hour event. Fields added to log: `yes_ask_size`, `yes_bid_size`, `vol_24h`. Existing rows pre-15:12 UTC don't have these — null is fine.

## Shadow tracker (added 2026-05-13)

The shadow tracker is observational: for every signal the live filter SKIPS, it fetches the actual Kalshi settlement and computes the counterfactual P&L "had we taken it." Lets us see whether the filter is rejecting winners — without falling into the trap of retuning on a tiny sample.

**Files & infra:**
- `/tmp/btcd_shadow_tracker.py` — fetches settlements, writes shadow log, prints summary. Idempotent.
- `/tmp/dual_paper_shadow.jsonl` — one row per resolved skipped signal.
- `~/Library/LaunchAgents/com.btcd.shadow.plist` — runs the tracker hourly at minute :15.
- `/tmp/btcd_shadow_cron.log` / `.err` — launchd stdout/stderr.

**Commands:**
```bash
python3 /tmp/btcd_shadow_tracker.py            # fetch any new + print summary
python3 /tmp/btcd_shadow_tracker.py --report   # summary only, no fetch
launchctl list | grep btcd                     # confirm scheduled
launchctl unload ~/Library/LaunchAgents/com.btcd.shadow.plist   # disable
```

### Patterns we're explicitly tracking

Two patterns flagged 2026-05-13 from the initial 99-skip backfill — each surfaced because the rejected signals were winning above the bucket's breakeven on this 2-day window. **DO NOT act on them yet** — see "Bar to act" below.

| Pattern | What filter says | Initial backfill (2.4 days) |
|---|---|---|
| **BTC mid > 0.65** | Filter caps mid at 0.65 | n=24, 21W (88%), +$1.84, breakeven 78% — above |
| **ETH ask 0.85-0.95** | Filter caps ask at 0.70 | n=16, 16W (100%), +$1.08, breakeven 92% — above |
| ETH ask ≥ 0.95 (control) | Filter correctly rejects | n=32, 31W (97%), −$0.95, breakeven 99% — **structurally bad, filter is right** |

The third row is the key control: at 99¢ entry you need 99% win, you get 97%, you lose money. **That's the filter actually earning its keep.** Confirms the upper end of the ask cap is doing real work even if the lower end may be too tight.

### Bar to act on a pattern (pre-committed 2026-05-13)

All four must be true before flipping a filter:

1. **n ≥ 30** in the bucket
2. **Per-bet P&L positive** AND **win% > avg_ask × 100 + 2pp** (above breakeven by a margin, not just at it)
3. **Pattern persists across ≥2 separate weekly windows** (not concentrated in one streak — guards against the v3-fade "lucky 4 days" trap)
4. **Even then**: validate the proposed change on the proper 23k-snapshot backtest (`/tmp/kxbtc_backtest_data.json`), not the shadow log alone

### 2026-05-13 backtest result — BOTH PATTERNS KILLED

Ran step 4 of the bar against both patterns on the existing 23k BTC / 1.4k ETH backtest datasets (these were collected *before* the live paper trader started, so they're truly independent of the patterns' discovery in the 2.4-day live shadow). Both patterns **collapsed**:

| Pattern | Live shadow (2.4d) | Full backtest | OOS test half |
|---|---|---:|---|
| BTC mid > 0.65 (closest-bucket, T-5min) | n=24, +21pp, ROI~10% | n=241, **+2.3pp, ROI+1%** | n=93, **+0.6pp, ROI-1%** |
| BTC mid 0.65-0.85 (subset) | — | n=176, +1.6pp, ROI 0% | n=61, **−2.2pp, ROI−5%** |
| ETH ask 0.85-0.95 (closest-bucket) | n=18, 100% win, +8pp | n=323, **+0.1pp, ROI−1%** | n=133, **−2.9pp, ROI−4%** |

The 88% / 100% live-shadow win rates were variance, not signal. The shadow tracker observed two patterns in a 2.4-day window that don't replicate on independent historical data.

**Decision: do not flip the filter.** Continue shadow-tracking the patterns (zero cost) so we have ongoing data; do not act on them unless they keep printing edge across many more weeks AND clear all four bar criteria again. This is the third "found edge" in this session (after v3-strikeout-fade and KXBTCD-directional) to die under disciplined OOS testing — the structural lesson is that 2-4 week in-sample patterns on Kalshi crypto markets reliably *find* artifacts and reliably *fail* on independent data. Pattern-matching is not a viable edge source here.

### Hypothetical v3 filter (if both patterns clear the bar)

```python
# CURRENT v2 (since 2026-05-11):
{ 'mid_min': 0.40, 'mid_max': 0.65,
  'ask_cap': 0.70, 'spread_cap': 0.10,
  'btc_dist_cap': 30, 'eth_dist_cap': 6 }

# Hypothetical v3 — DO NOT FLIP, here for reference:
{ 'mid_min': 0.40, 'mid_max': 0.85,   # was 0.65
  'ask_cap': 0.95, 'spread_cap': 0.10, # was 0.70
  'btc_dist_cap': 30, 'eth_dist_cap': 6 }
```

Projected impact based on the 2.4-day backfill (NOT a forecast):

| | Trades | Wins | Win% | P&L | Per-day |
|---|---:|---:|---:|---:|---:|
| Current v2 (live, BTC only) | 11 | 5 | 45% | −$1.43 | −$0.60 |
| Hypothetical v3 (BTC+ETH) | ~55 | ~46 | 84% | +$2.42 | +$1.00 |

**Note:** ~$1/day, ~$365/year run-rate — still capacity-constrained, small absolute dollars. The high projected win rates (84%) come with thin breakeven margins (avg ask in v3 ≈ 0.80), so one bad week of vol can wipe out 10+ wins. This is reference math; the decision to flip lives behind the four-point bar above.

## File map

All under `/tmp/` (local Mac process, not deployed anywhere).

| File | Purpose |
|---|---|
| `/tmp/dual_paper_v2.py` | The live paper trader. Decides + writes log. |
| `/tmp/dual_paper_log.jsonl` | Every signal (taken or skipped), one event per line. |
| `/tmp/dual_paper_state.json` | Trader's persistent state (positions, totals). |
| `/tmp/dual_paper_v2_stdout.log` | Trader stdout. |
| `/tmp/dual_paper_err.log` | Trader stderr. |
| `/tmp/btcd_paper_status.py` | Print full status: trades, win rate, CI, day-30 gate. |
| `/tmp/btcd_shadow_tracker.py` | Shadow tracker — fetches skipped-signal settlements. |
| `/tmp/dual_paper_shadow.jsonl` | One row per resolved skipped signal w/ counterfactual P&L. |
| `/tmp/btcd_shadow_cron.log` | launchd stdout for hourly shadow runs. |
| `/tmp/kxbtc_backtest.py` | Reusable no-bias backtester (proper 23k sample). |
| `/tmp/kxbtc_backtest_data.json` | 23,000 T-5/T-15/T-30/T-60 snapshots — the proper sample. |
| `/tmp/kxeth_outsample_data.json` | 1,477 ETH T-5 snapshots. |
| `/tmp/kxbtc_outsample_trades.json` | 493 out-of-sample BTC trades. |
| `/tmp/recalibrate_summary.json` | Combined calibration tables (killed KXBTCD analysis). |
| `~/Library/LaunchAgents/com.btcd.shadow.plist` | launchd job, runs shadow tracker hourly at :15. |

## Common commands cheat sheet

```bash
# Is the live trader running?
ps aux | grep dual_paper_v2

# Full status of live trader (trades, win rate, CI, day-30 gate progress)
python3 /tmp/btcd_paper_status.py

# Shadow tracker — what would have happened on rejected signals?
python3 /tmp/btcd_shadow_tracker.py --report

# Tail trader log live
tail -f /tmp/dual_paper_log.jsonl

# Watch shadow cron
tail -f /tmp/btcd_shadow_cron.log

# Stop everything
kill 76909                                                                 # live trader (replace PID)
launchctl unload ~/Library/LaunchAgents/com.btcd.shadow.plist              # shadow tracker
```

## Decision log

| Date | Decision | Reasoning |
|---|---|---|
| 2026-05-10 | Walk away from KXBTCD directional bucket strategy | Methodology error revealed: stale mids drove fake edge. Real win rate at refined ask is 36% NO, not 62%. |
| 2026-05-10 | Walk away from tennis Challenger ELO | Kalshi market beats ELO by 14 pp log-loss. Market is right when ELO disagrees by 10+ cents 80% of the time. |
| 2026-05-10 | Adopt closest-bucket KXBTC/KXETH T-5min strategy | Passed in-sample, out-of-sample, cross-asset, walk-forward, bootstrap. Multi-bucket extension proven negative. |
| 2026-05-11 | Refined filters: mid ∈ [0.40, 0.65], dist ≤$30 (BTC) / $6 (ETH) | Stratified analysis showed +60% per-trade EV with these filters. Paper trader updated. |
| 2026-05-11 | Defer wing market-making | Math looks profitable but fill-rate assumption (30%) is unverified. Need 1 week of trade-tape logging first. |
| 2026-05-11 | Pull cross-product arb data | Cheap test, math is risk-free if arb exists. Likely HFT-arbed but worth checking. |
| 2026-05-13 | Build shadow tracker for filter-rejected signals | n=11 live trades is meaningless; need to also observe rejected signals so we can see if the filter's leaving money on the table without retuning on tiny samples (v3-fade trap). Hourly launchd job. |
| 2026-05-13 | Flag BTC mid > 0.65 and ETH ask 0.85-0.95 as patterns to track | Both above breakeven on the 99-skip backfill (BTC mid>0.65: 88% / +$1.84; ETH 0.85-0.95: 100% / +$1.08). DO NOT act yet — pre-committed bar: n≥30 + above breakeven + persists across ≥2 weekly windows + validate on 23k backtest before flipping. |
| 2026-05-13 | Confirm ETH ask ≥ 0.95 stays rejected | Shadow tracker shows 31W of 32 (97%) but P&L −$0.95 — breakeven at 99% impossible to clear at any sustainable rate. Filter cap is correct at this band. |
| 2026-05-13 | Patch trader to log yes_ask_size / yes_bid_size / vol_24h on every signal | Could not answer "what could I have actually filled at $5K size" from a single live-snapshot — needed measured depth at the moment of each decision. Trader restarted 15:12 UTC; ~1 week of rows needed before depth-aware sizing analysis is meaningful. |
| 2026-05-13 | KXBTCD directional fade (BUY NO [0.55-0.70]) — investigated and KILLED | 33-day in-sample backtest showed +21pp edge, ROI +49%. 33-day chronological OOS confirmed at +23pp. But truly-OOS forward slice (May 11-13, n=50 trades, real bid/ask from candle API) collapsed to +0.8pp / ROI -3%. The control bands REVERSED sign. Same v3-fade pattern: in-sample finding doesn't generalize forward. Strategy dead, no paper trader built. |
| 2026-05-13 | Backtest the BTC mid>0.65 and ETH ask 0.85-0.95 shadow-tracker patterns — BOTH KILLED | Live shadow (2.4d) showed BTC +21pp / ETH 100% win. Proper 23k-BTC / 1.4k-ETH backtest: BTC +2.3pp (basically zero), ETH +0.1pp (zero); OOS test halves both slightly negative. Patterns are noise from a low-vol 2.4-day window. Filter NOT changed. Shadow tracker keeps logging (free). Third "found edge" this session to die on proper OOS — the structural lesson sticks: pattern-matching on small Kalshi crypto windows finds artifacts. |

## Pre-deploy checklist

Before committing real capital to ANY of these strategies:

1. [ ] 30+ days of paper-trading data on the validated strategy
2. [ ] Live fill prices within 2¢ of backtest assumption
3. [ ] Win rate within 5pp of backtest (60% BTC, 72% ETH)
4. [ ] Realistic per-trade slippage measured
5. [ ] Discord alerting wired up for daily summaries (not real-time signals)
6. [ ] Daily loss cap implemented (-10% of starting bankroll halts trading until midnight UTC)
7. [ ] Per-event cap implemented (max 2 strikes per event — though current strategy is 1)

### Day-30 gate (the explicit numbers)

Must be cleared before any real money:

| Metric | Target | Current (2026-05-13, Day 2.4) |
|---|---|---|
| BTC trades (sample size) | 60–150 | 11 (8% there) |
| BTC win rate | ≥ 60% | 45.5% (n=11, CI 21–72%) |
| Avg EV per contract | ≥ +$0.02 | −$0.13 |

The win rate target (60%) is comfortably above the strategy's avg-cost breakeven (~58.5%). The EV target (+$0.02/contract) is conservative — close to the deflated backtest expectation.

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
