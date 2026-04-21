# MLBIE — Observations & Bankroll Simulation Log

**Last updated**: April 21, 2026
**Simulation run on**: April 20, 2026 settled bets (73 total, all from one day)

---

## April 20, 2026 — First Full Day Results

### Raw Performance
- Total bets: 73
- Wins: 37 | Losses: 36
- Win rate: 50.7%
- Avg edge: 11.8%
- Total P&L (flat $100/bet): +$910.50

---

## Bankroll Simulation Results

Starting bankroll assumption: $1,000

### Flat $100/bet
- Final bankroll: $1,910.50
- Total P&L: +$910.50
- ROI: +91.0%
- Max drawdown: 12.4%

### Quarter-Kelly (0.25x, max 3% bankroll, min $25) — current Phase 1 config
- Final bankroll: $1,293.32
- Total P&L: +$293.32
- ROI: +29.3%
- Max drawdown: 4.0%
- Avg bet size: $28.87

### Half-Kelly (0.50x, max 3% bankroll, min $25)
- Final bankroll: $1,308.29
- Total P&L: +$308.29
- ROI: +30.8%
- Max drawdown: 5.2%
- Avg bet size: $33.60

**Note on Kelly sizing**: The Kelly/flat gap here (+29% Kelly vs +91% flat) reflects that almost all bets are hitting the $25 minimum floor — at a $1,000 bankroll, 3% max = $30, and avg bet size of $28.87 confirms near-floor sizing for most bets. Kelly would diverge from flat more meaningfully with a larger starting bankroll.

---

## Filter Analysis

### Medium-confidence only (52 bets, flat $100)
- P&L: +$1,007.00
- Win rate: 55.8%
- Observation: Medium-confidence significantly outperforms low-confidence. This is the clearest signal from one day of data.

### Low-confidence only (21 bets, flat $100)
- P&L: -$96.50
- Win rate: 38.1%
- Observation: Low-confidence bets lost money. Consider raising minimum confidence threshold.

### High-edge only (>=10%, 33 bets, flat $100)
- P&L: +$767.50
- Win rate: 63.6%
- Observation: High-edge filter shows strong win rate (63.6%). Concentrating on >= 10% edge bets would have been more efficient.

---

## Side Analysis

| Side | N  | Wins | Win% | P&L      | Avg Edge | Avg Mid |
|------|----|------|------|----------|----------|---------|
| NO   | 26 | 19   | 73.1%| +$542.50 | 15.1%    | 52¢     |
| YES  | 47 | 18   | 38.3%| +$368.00 | 10.0%    | 30¢     |

**Key observation**: NO bets (betting under on K thresholds) won at 73.1% vs YES bets at 38.3%. NO bets also had higher avg edge (15.1% vs 10.0%). This is a one-day sample but the gap is large enough to monitor.

Possible explanations:
- The model may be structurally overestimating K probability for some pitchers (YES bets too optimistic)
- Market may be pricing YES too high on these strikeout thresholds (NO has more genuine edge)
- Low-confidence YES bets are dragging down YES win rate (18/47 with 7 zero-win pitchers in YES column)

---

## Edge Band Analysis

| Edge Band | N  | Wins | Win% | P&L     |
|-----------|----|------|------|---------|
| 5-7%      | 21 | 9    | 42.9%| +$87    |
| 7-10%     | 19 | 7    | 36.8%| +$56    |
| 10-15%    | 13 | 6    | 46.2%| +$181   |
| 15%+      | 20 | 15   | 75.0%| +$586.50|

**Key observation**: The 15%+ edge band is the standout — 75% win rate and $586.50 P&L from 20 bets. The 5-7% and 7-10% bands are barely positive and show below-50% win rates. This supports raising the minimum edge threshold or heavily weighting the high-edge tier.

---

## Calibration Check (one-day sample — treat with caution)

| Prob Bucket | N  | Actual Win% | Avg Model% | Delta   |
|-------------|----|-----------  |------------|---------|
| 0-10%       | 5  | 100%        | 5%         | +95.0%  |
| 10-20%      | 13 | 31%         | 15%        | +15.9%  |
| 20-30%      | 12 | 33%         | 25%        | +8.3%   |
| 30-40%      | 9  | 44%         | 34%        | +10.5%  |
| 40-50%      | 11 | 45%         | 44%        | +1.0%   |
| 50-60%      | 7  | 57%         | 55%        | +1.8%   |
| 60-70%      | 5  | 60%         | 64%        | -4.1%   |
| 70-80%      | 6  | 67%         | 74%        | -6.9%   |
| 80-90%      | 4  | 75%         | 83%        | -8.3%   |
| 90-100%     | 1  | 100%        | 94%        | +6.4%   |

**Observations**:
- Low-probability buckets (0-30%) are significantly outperforming model predictions. The 0-10% bucket hitting 100% (5/5) is notable — these are near-certain NO bets the model has catching misses.
- High-probability buckets (70-90%) are slightly underperforming. Model overestimates probability here.
- Middle buckets (40-60%) are well-calibrated.
- **CAVEAT**: 73 bets from a single day is far too small for calibration conclusions. Need 500+ settled bets across multiple pitching environments.

---

## Pitcher-Level Analysis

### Strong performers (April 20)
| Pitcher         | N | Wins | P&L     | Notes |
|-----------------|---|------|---------|-------|
| Dylan Cease     | 7 | 7    | +$443.50| Perfect, all wins |
| Sonny Gray      | 6 | 6    | +$292.50| Perfect, all wins |
| Kyle Bradish    | 8 | 5    | +$205.00| |
| Justin Wrobleski| 8 | 5    | +$138.50| Mixed YES/NO |

### Weak performers (April 20)
| Pitcher           | N | Wins | P&L     | Notes |
|-------------------|---|------|---------|-------|
| Spencer Arrighetti| 7 | 0    | -$202.50| All losses |
| Emerson Hancock   | 5 | 0    | -$149.00| All losses |
| Jack Flaherty     | 5 | 0    | -$121.50| All losses |
| Colin Rea         | 2 | 0    | -$106.50| All losses |

**Observation**: Three pitchers with 0/N records (Arrighetti, Hancock, Flaherty) accounted for $473 of losses. The model took YES positions on most of these. Worth reviewing whether the model is systematically overrating certain pitcher profiles.

---

## Strike Threshold Analysis

| Threshold | N  | Wins | Win% | P&L    |
|-----------|----|------|------|--------|
| 2+        | 2  | 1    | 50%  | -$73.50|
| 3+        | 6  | 5    | 83%  | +$24   |
| 4+        | 8  | 5    | 63%  | -$15   |
| 5+        | 11 | 5    | 45%  | -$48.50|
| 6+        | 12 | 7    | 58%  | +$220.50|
| 7+        | 12 | 6    | 50%  | +$286  |
| 8+        | 8  | 3    | 38%  | +$141  |
| 9+        | 7  | 2    | 29%  | +$123.50|
| 10+       | 5  | 1    | 20%  | +$68.50|
| 11+       | 1  | 1    | 100% | +$89   |
| 12+       | 1  | 1    | 100% | +$95   |

**Observations**:
- Low thresholds (2+, 4+, 5+) are underperforming. May reflect YES bets on near-certain events where the market is correctly priced.
- High thresholds (8+, 9+, 10+) show low win rates but positive P&L — these are mostly NO bets at correct pricing.
- 6+ and 7+ thresholds show the most balanced performance and highest total volume.

---

## Model Structural Observations

1. **Confidence filter matters**: Medium confidence (55.8% win rate, +$1,007) vs Low confidence (38.1% win rate, -$97). If the model is running daily, consider filtering to medium+ confidence only.

2. **NO bets have higher edge**: 73.1% win rate on NO vs 38.3% on YES. This warrants investigation — either the model is systematically overestimating K-probabilities or the market is consistently overpricing YES contracts.

3. **15%+ edge is the value tier**: 75% win rate on high-edge signals. The 5-10% edge range is showing modest positive returns but inconsistent win rates.

4. **Correlated Kelly is working correctly**: Multiple thresholds for the same pitcher (e.g. Justin Wrobleski had 8 simultaneous bets) are correctly handled. Total exposure to one pitcher outcome is capped.

5. **Single-day sample**: All 73 bets are from April 20, 2026. No multi-day trends are observable yet. All observations above are directionally useful but not statistically confirmed.

---

## Action Items / Things to Watch

- [ ] Track NO vs YES win rate differential over next 2 weeks — if NO continues to outperform at 70%+ win rate, consider whether the YES edge threshold needs raising
- [ ] Monitor low-confidence bets — one day of -38% win rate isn't enough to drop them, but if it persists after 10+ days, consider raising minimum confidence to medium
- [ ] Watch Arrighetti, Hancock, Flaherty going forward — either the model has a structural miss on these pitcher types or it was bad variance on one day
- [ ] The 0-10% model probability bucket hitting 100% actual win rate is interesting — these are near-lock NO bets. Ensure the correlated Kelly cap isn't under-sizing these
- [ ] Add dates as they accumulate — need at minimum 20 betting days (200+ bets) before any parameter changes are justified

---

## Session Log

| Date       | Bets | Wins | Losses | P&L (flat $100) | Notes |
|------------|------|------|--------|-----------------|-------|
| 2026-04-20 | 73   | 37   | 36     | +$910.50        | First full day |
