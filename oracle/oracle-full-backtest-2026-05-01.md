# Full Oracle Pipeline Backtest — 2026-05-01

**Pipeline:** Layer 1 (Math) → Layer 2 (Path) → Layer 3 (Trust) → Layer 5 (Judge v0.1)
**Layer 4 (Critic) is NOT included** — Judge v0.1 has a no-AI path. Adding Critic
would tighten the fire→skip rate further.

Window: 2026-03-02 → 2026-05-01
Bankroll for sizing: $1000

## Sample

| Metric | Value |
|---|---:|
| Settled placed pre-game bets in window | 622 |
| Replayable through full pipeline | 312 |
| Skipped (no decision_pipeline JSON) | 308 |
| Skipped (parse / judge failure) | 2 |

## Headline numbers

| Metric | Production | Oracle (fixed-size) | Oracle (Kelly-resized) |
|---|---:|---:|---:|
| Total bets fired | 312 | 170 | 170 |
| Total bets sized_down | — | 24 (×0.5) | 24 (×Kelly) |
| Total bets skipped | 0 | 118 | 118 |
| Total size deployed | $14214.00 | $14214.00 (held) | $35527.21 |
| Total P&L | $-617.03 | $62.03 | $-1164.68 |
| Oracle Δ vs production | — | **$679.05** | $-547.65 |
| P&L on bets Oracle would have skipped | — | $-495.67 | $-495.67 |

> **Fixed-size** holds production's bet_size and just applies Oracle's
> decision (skip/fire/half). This isolates decision quality from sizing.
> **Kelly-resized** uses Judge v0.1's Kelly-based size at the configured
> bankroll, which can differ wildly from production's actual sizes.
> The fixed-size column is the cleaner read for whether the chain helps.

## By Judge decision

| decision | n | wins | losses | win_rate | production_pnl | oracle_pnl |
|---|---:|---:|---:|---:|---:|---:|
| fire | 170 | 64 | 76 | 45.7% | $245.41 | $-779.47 |
| size_down | 24 | 4 | 20 | 16.7% | $-366.77 | $-385.21 |
| skip | 118 | 29 | 78 | 27.1% | $-495.67 | $0.00 |

## By Layer 2 feasibility

| feasibility | n | wins | losses | win_rate | production_pnl |
|---|---:|---:|---:|---:|---:|
| strong | 128 | 52 | 40 | 56.5% | $-9.73 |
| viable | 81 | 23 | 57 | 28.7% | $-250.49 |
| fragile | 18 | 4 | 14 | 22.2% | $-220.65 |
| dead | 85 | 18 | 63 | 22.2% | $-136.16 |

## By Layer 3 trust level

| trust_level | n | wins | losses | win_rate | production_pnl |
|---|---:|---:|---:|---:|---:|
| high | 177 | 67 | 73 | 47.9% | $85.75 |
| medium | 30 | 8 | 22 | 26.7% | $-310.59 |
| low | 105 | 22 | 79 | 21.8% | $-392.19 |

## By account (user_id)

| user_id | n | wins | losses | production_pnl | oracle_pnl |
|---|---:|---:|---:|---:|---:|
| 2 | 162 | 53 | 93 | $-417.01 | $-1150.47 |
| 284 | 150 | 44 | 81 | $-200.02 | $-14.20 |

## Outliers

- 29 bets that Oracle would SKIP but production WON
- 76 bets that Oracle would FIRE but production LOST
- 4 sized_down bets that won
- 20 sized_down bets that lost

## Caveats

1. Layer 1 envelope is synthetic (rebuilt from decision_pipeline JSON).
2. Today's pitcher_statcast used for r — may diverge from production-time r.
3. Judge sizing assumes \$1000 bankroll uniformly. Real production used
   varying bankroll per account; Oracle size shown is theoretical at this bankroll.
4. `production_size` reflects the actual size production placed; `oracle_size` is
   what Judge v0.1 would size at the configured bankroll.
5. Counterfactual pnl = production pnl × (oracle_size / production_size). This
   assumes the same fill at the same price — does not simulate liquidity changes.
6. **Layer 4 (Critic / AI) is NOT in this run.** Adding Critic typically tightens
   fire→skip and would change these numbers.
7. Production data only goes back to 2026-04-20 in this DB; effective replay
   coverage is shorter due to decision_pipeline JSON capture cutover.
