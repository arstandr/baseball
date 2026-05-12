# Oracle Money-on-the-Table Audit — 2026-05-01

Sample: 312 settled placed pre-game bets (the replayable subset).

## 1. Headline scoreboard

| Strategy | P&L | ROI on production size |
|---|---:|---:|
| Production | $-617.03 | -4.3% |
| Oracle (no Critic) | $62.03 | 0.4% |
| Oracle (with Critic) | $197.31 | 1.4% |

Total production size deployed: $14214.00

## 2. Probability calibration (production model)

If Layer 1 said 70% but actual win rate at that bucket is 50%, the model is overconfident in that range. Bias = predicted − actual.

| bucket | n | avg predicted | actual win rate | bias | total pnl |
|---|---:|---:|---:|---:|---:|
| [0.0,0.1) | 6 | 9.0% | 33.3% | -24.3pp | $-34.79 |
| [0.1,0.2) | 21 | 14.9% | 19.0% | -4.1pp | $-56.71 |
| [0.2,0.3) | 27 | 25.3% | 37.0% | -11.7pp | $11.56 |
| [0.3,0.4) | 42 | 34.6% | 16.7% | +17.9pp | $-279.09 |
| [0.4,0.5) | 58 | 45.7% | 27.6% | +18.1pp | $-55.79 |
| [0.5,0.6) | 62 | 54.4% | 37.1% | +17.3pp | $129.52 |
| [0.6,0.7) | 55 | 63.8% | 40.0% | +23.8pp | $65.42 |
| [0.7,0.8) | 29 | 74.2% | 24.1% | +50.0pp | $-315.57 |
| [0.8,0.9) | 10 | 85.4% | 60.0% | +25.4pp | $-29.22 |
| [0.9,1.0) | 2 | 90.9% | 0.0% | +90.9pp | $-52.36 |

**Calibration insight:** buckets where the model is overconfident by ≥5pp lost a net $732.03. If we could correct that bias, we'd recover roughly that amount over time.

## 3. Per-pitcher P&L (worst 10)

Pitchers who systematically lost. Production may be over-betting these, or the model has a per-pitcher blind spot.

| pitcher | n | wins | losses | production pnl | oracle pnl (full) |
|---|---:|---:|---:|---:|---:|
| Cole Ragans | 8 | 0 | 8 | $-182.26 | $-61.45 |
| Luis Castillo | 4 | 0 | 4 | $-148.02 | $-114.12 |
| Chris Paddack | 8 | 0 | 7 | $-142.04 | $-128.04 |
| Dylan Cease | 6 | 0 | 6 | $-125.96 | $-64.24 |
| Matthew Boyd | 4 | 0 | 4 | $-112.53 | $-56.27 |
| Kai-Wei Teng | 4 | 0 | 4 | $-112.25 | $-56.13 |
| Anthony Kay | 4 | 0 | 4 | $-111.82 | $-25.46 |
| Garrett Crochet | 4 | 2 | 2 | $-103.80 | $67.80 |
| Jeffrey Springs | 9 | 0 | 9 | $-101.09 | $-50.71 |
| José Soriano | 2 | 0 | 2 | $-93.60 | $-93.60 |

## 3b. Per-pitcher P&L (best 10)

| pitcher | n | wins | losses | production pnl |
|---|---:|---:|---:|---:|
| Michael King | 6 | 6 | 0 | $252.90 |
| Spencer Arrighetti | 6 | 6 | 0 | $192.35 |
| Parker Messick | 4 | 4 | 0 | $179.37 |
| Andre Pallante | 2 | 2 | 0 | $134.93 |
| Lance McCullers Jr. | 2 | 0 | 2 | $126.48 |
| Cam Schlittler | 2 | 2 | 0 | $118.30 |
| Luis Severino | 3 | 3 | 0 | $102.83 |
| Jack Kochanowicz | 8 | 4 | 1 | $87.50 |
| Drew Rasmussen | 6 | 4 | 2 | $70.23 |
| Erick Fedde | 2 | 2 | 0 | $66.21 |

**Concentration:** the worst 3 pitchers account for $-472.32 of the production loss. If Oracle could have flagged these structurally, that's the largest single recovery opportunity.

## 4. Per-side × strike bucket

| key | n | wins | losses | win_rate | production pnl |
|---|---:|---:|---:|---:|---:|
| YES_3-4 | 27 | 11 | 13 | 45.8% | $-81.27 |
| YES_5-6 | 122 | 40 | 77 | 34.2% | $-26.70 |
| YES_7-8 | 69 | 14 | 55 | 20.3% | $-121.55 |
| YES_9+ | 6 | 0 | 6 | 0.0% | $-100.52 |
| NO_3-4 | 8 | 2 | 2 | 50.0% | $9.40 |
| NO_5-6 | 50 | 22 | 11 | 66.7% | $-105.48 |
| NO_7-8 | 28 | 8 | 10 | 44.4% | $-190.91 |
| NO_9+ | 2 | 0 | 0 | — | $0.00 |

**Pattern flagged:** these (side, strike-bucket) combinations lost > $50 in this window:
  - YES_3-4: $-81.27 on 27 bets (win rate 45.8%)
  - YES_7-8: $-121.55 on 69 bets (win rate 20.3%)
  - YES_9+: $-100.52 on 6 bets (win rate 0.0%)
  - NO_5-6: $-105.48 on 50 bets (win rate 66.7%)
  - NO_7-8: $-190.91 on 28 bets (win rate 44.4%)
Worth a per-bucket rule audit. Could be that high-strike YES is the wrong play for some pitchers.

## 5. Critic effectiveness audit

Critic changed Oracle's decision on **17** of 312 bets.

### 5a. Critic forced skip (n=7)
Production placed these. Oracle (no-Critic) would have placed at full or half size. Critic said no.

- wins (Critic forgone wins, BAD for Critic): 0
- losses (Critic correctly skipped losers): 7
- Production P&L on these bets: $-50.54  ← Critic SAVED this loss

Top concerns Critic cited:
  - generic_concern: 7

### 5b. Critic downgraded fire → size_down (n=10)
Production placed at full size. Oracle (no-Critic) would have fired full. Critic said size_down.

- wins (half loss vs full win — small marginal cost): 0
- losses (half loss vs full loss — half saved): 10
- Production P&L on these bets: $-169.49
- Marginal savings vs full-size: $84.74  (negative = Critic gave up wins)

### 5c. Critic 'proceed' bets that lost (n=79)

These are bets where Critic gave a clean signal AND Oracle fired or sized_down AND production lost.
Total production loss on Critic-cleared bets: $-1368.44.
If we could improve Critic to catch even 20% of these, that's ~$-273.69 additional savings.

## 6. Sizing inefficiency

Production sizes are determined by ks_bets.kelly_fraction × actual_bankroll. Oracle sizing is independent of production sizing — but there's signal in the production sizes.

- Avg production size on Oracle-fire bets:      $39.77
- Avg production size on Oracle-size_down bets: $61.56

On Oracle-fire bets:
  - winning bets: 64, total production size $2522.00
  - losing bets:  59, total production size $3069.00
  ✗ Production sized LOSERS larger than winners — sizing was anti-correlated with outcome (random luck or bad sizing signal)

## 7. The 308 unreplayable bets

These bets predate decision_pipeline JSON capture, so Layer 1 envelope cannot be reconstructed and Oracle cannot replay them.

| date | n | wins | pnl |
|---|---:|---:|---:|
| 2026-04-20 | 73 | 37 | $879.50 |
| 2026-04-21 | 107 | 54 | $755.38 |
| 2026-04-22 | 98 | 44 | $-337.19 |
| 2026-04-23 | 28 | 15 | $1237.60 |
| 2026-04-25 | 2 | 0 | $-13.76 |

Total unreplayable bet count: 308
Total production P&L on unreplayable bets: $2521.53

**Money implication:** if Oracle had been running on these 308 bets too with similar +5pp ROI improvement, that would have been roughly $2647.61 in additional value (rough estimate). The fix is to make sure decision_pipeline JSON gets captured going forward.

## 8. Perfect Oracle upper bound

If we had perfect foresight (skip every loser, fire every winner at production size), what's the cap?

- Bets we'd fire (winners): $2067.98 ROI
- Bets we'd skip (losers): saved 2685.01
- Perfect-Oracle P&L: $2067.98
- Production P&L:    $-617.03
- Maximum possible Δ: **$2685.01**

Current Oracle (with Critic) captures **$814.34** of the $2685.01 possible.
Capture rate: 30.3%

**Money still on the table: $1870.67** (the gap between current Oracle and perfect Oracle)

## 9. Top recommendations (ranked by dollar impact)

| # | recommendation | est. dollar impact | action |
|---|---|---:|---|
| 1 | Recalibrate model probability buckets where bias > 5pp | $732.03 | Bias-corrected predictions would save approximately $732.03 on this sample. |
| 2 | Add pitcher-specific blacklist or per-pitcher prior for: Cole Ragans, Luis Castillo, Chris Paddack | $472.32 | These 3 pitchers account for $472.32 of losses. Oracle is firing on them at full or partial size. Investigate why model is over-predicting K rate; consider per-pitcher manual override. |
| 3 | Improve Critic prompt to catch ~20% of "proceed-and-lose" cases | $273.69 | Current Critic is conservative; lots of clean-proceed-then-loss happen. Audit prompt; add more concern triggers. |
| 4 | Investigate NO_7-8 bucket: $-190.91 loss on 28 bets | $190.91 | Win rate 44.4%. Consider banning this bucket entirely or raising min_edge for it. |
| 5 | Ensure decision_pipeline JSON is captured for every bet going forward | $126.08 | 308 bets had no JSON snapshot. Future Oracle can't learn from them. Verify the production logging path always writes to decision_pipeline. |
| 6 | Investigate YES_7-8 bucket: $-121.55 loss on 69 bets | $121.55 | Win rate 20.3%. Consider banning this bucket entirely or raising min_edge for it. |
| 7 | Investigate NO_5-6 bucket: $-105.48 loss on 50 bets | $105.48 | Win rate 66.7%. Consider banning this bucket entirely or raising min_edge for it. |
| 8 | Investigate YES_9+ bucket: $-100.52 loss on 6 bets | $100.52 | Win rate 0.0%. Consider banning this bucket entirely or raising min_edge for it. |
| 9 | Investigate YES_3-4 bucket: $-81.27 loss on 27 bets | $81.27 | Win rate 45.8%. Consider banning this bucket entirely or raising min_edge for it. |

**Total estimated upside if all recommendations executed:** $2203.84

## 10. Bottom line — money on the table

In this 312-bet sample window:

| Layer | P&L delta from production |
|---|---:|
| Already capturing (Oracle deterministic) | +$679.05 |
| Critic adds | +$135.28 |
| Captured by current Oracle | +$814.34 |
| Gap to perfect Oracle | +$1870.67 |
| Estimated recoverable from recommendations | +$2203.84 |

**Honest take:** the deterministic chain + Critic captured 30% of the available improvement. The remaining 70% is structurally unreachable without:
1. Better per-pitcher modeling (the worst-pitcher concentration)
2. More AI signal (Critic v1.1: catch clean-then-lose patterns)
3. Better data capture (the 308 unreplayable bets)
4. Calibration corrections (bias buckets)

On a 7-10 day sample, $2203.84 of additional upside is the conservative ceiling. Annualized at the same rate that's roughly $79338.40 per year (rough — sample is small).
