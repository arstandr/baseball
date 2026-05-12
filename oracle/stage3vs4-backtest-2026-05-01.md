# Stage 3 vs Stage 4 Backtest — 2026-05-01

**One question:** did Stage 4 (boost upgrade) add value over Stage 3 (boost reverted)?

Window: 2026-03-02 → 2026-05-01
Bankroll: $1000

## Verdict

**INCONCLUSIVE — no boost activations**

Critic never produced boost verdicts on this sample; Stage 3 and Stage 4 produced identical decisions everywhere.

## Headline

| Metric | Value |
|---|---:|
| Sample (replayable bets) | 312 |
| Production P&L | $-617.03 |
| Oracle Stage 3 P&L (fixed-size) | $197.31 |
| Oracle Stage 4 P&L (fixed-size) | $197.31 |
| **Stage 4 minus Stage 3** | **$0.00** |
| Divergent decisions | 0 of 312 |

## Boost activation summary

| Metric | Value |
|---|---:|
| Boost activations | 0 |
| - wins | 0 |
| - losses | 0 |
| - voids | 0 |
| Boosted win rate (excl. voids) | — |
| Boosted P&L Stage 3 (size_down) | $0.00 |
| Boosted P&L Stage 4 (fire) | $0.00 |
| Stage 4 boost delta | $0.00 |

Boost only fires when ALL of: feasibility != fragile, baseline reason was LOW_TRUST_SIZE_DOWN, trust_score >= 0.50, edge >= threshold. So all guards passed for these activations.

## Concentration

Top pitchers by absolute Stage 4 delta on boosted bets:

| pitcher | delta | % of |delta| total |
|---|---:|---:|

Top dates by absolute Stage 4 delta on boosted bets:

| date | delta |
|---|---:|


## Top 5 helped (Stage 4 won where Stage 3 sized down)

| date | pitcher | strike-side | result | actual_ks | production_pnl | Stage 3 pnl | Stage 4 pnl | delta |
|---|---|---|---|---:|---:|---:|---:|---:|

## Top 5 hurt (Stage 4 amplified loss where Stage 3 half-saved)

| date | pitcher | strike-side | result | actual_ks | production_pnl | Stage 3 pnl | Stage 4 pnl | delta |
|---|---|---|---|---:|---:|---:|---:|---:|

## All boost activations

| date | pitcher | strike-side | result | concerns | Stage 3 pnl | Stage 4 pnl | delta |
|---|---|---|---|---|---:|---:|---:|

## Method

- One Critic call per bet (real Haiku 4.5; cached per (pitcher, bet_date)).
- Judge v0.2 produces final decision incorporating Critic ladder.
- Stage 3 = revert Critic boost (size_down stays size_down even if Critic said boost).
- Stage 4 = respect Critic boost (size_down → fire when guards pass).
- Both scored on fixed-size P&L: skip→0, size_down→0.5×production_pnl, fire→production_pnl.
- Boost guards (must ALL pass): feasibility != fragile, baseline_reason = LOW_TRUST_SIZE_DOWN, trust_score >= 0.50, edge >= threshold.

## Caveats

1. Sample is the same ~7-10 day window of replayable settled pre-game bets.
2. Today's pitcher_statcast used for r — drift caveat carries over.
3. Critic prompt and guards locked at v1; future tuning may change boost behavior.
4. Calibration is OFF (NO-GO from L1.5.2). Probability bias may distort edge calc.
