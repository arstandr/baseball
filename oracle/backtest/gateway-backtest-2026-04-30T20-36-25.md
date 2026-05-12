# Gateway Backtest — Pregame Only

Run at: 2026-04-30T20:36:25.058Z
Bets simulated: 708
Coverage: 2026-04-20 → 2026-04-30 (since 2026-04-15)

## Headline numbers per config

| config | accepted | rejected | rejected_pct | blocked_losing_pnl (saved) | blocked_winning_pnl (cost) | net effect |
|---|---|---|---|---|---|---|
| **defaults** | 418 | 0 | 0.0% | $1520.79 | $1513.78 | **$7.01** |
| **v1-realistic** | 402 | 16 | 2.3% | $2217.42 | $1882.52 | **$334.90** |
| **tight** | 348 | 70 | 9.9% | $3335.78 | $2707.89 | **$627.89** |

> *Saved* = sum of pnl Gateway would have blocked from losing bets (positive number = good).
> *Cost* = sum of pnl Gateway would have blocked from winning bets (positive number = missed wins).
> *Net saved* = Saved − Cost.

---

## Config: `defaults`

*No killswitches — pure structural baseline.*

### Reject reason breakdown

No rejects under this config.

### Per-account

| account | total | accepted | rejected | sum blocked pnl |
|---|---|---|---|---|
| adam | 223 | 223 | 0 | $0.00 |
| isaiah | 195 | 195 | 0 | $0.00 |

### Per-day (where Gateway rejected ≥1 bet)

No day had any rejected bets under this config.

---

## Config: `v1-realistic`

*Reasonable V1 limits: daily_loss=$500 adam / $250 isaiah; max_order=$200 pregame.*

### Reject reason breakdown

| reason | count | sum of blocked pnl | sum of blocked size | sample bet ids |
|---|---|---|---|---|
| `ORDER_USD_OVER_LIMIT` | 16 | -$327.89 | $5665.00 | 87, 172, 201, 3486, 3490 |

### Per-account

| account | total | accepted | rejected | sum blocked pnl |
|---|---|---|---|---|
| adam | 223 | 212 | 11 | -$93.53 |
| isaiah | 195 | 190 | 5 | -$234.36 |

### Per-day (where Gateway rejected ≥1 bet)

| date | total | rejected | sum blocked pnl |
|---|---|---|---|
| 2026-04-21 | 107 | 3 | -$36.34 |
| 2026-04-22 | 113 | 12 | -$266.83 |
| 2026-04-23 | 28 | 1 | -$24.72 |

---

## Config: `tight`

*Tight limits: daily_loss=$200 adam / $100 isaiah; max_order=$100 pregame.*

### Reject reason breakdown

| reason | count | sum of blocked pnl | sum of blocked size | sample bet ids |
|---|---|---|---|---|
| `ORDER_USD_OVER_LIMIT` | 68 | -$609.21 | $12576.00 | 78, 79, 80, 87, 95 |
| `ACCOUNT_DAILY_LOSS_BREACHED` | 2 | -$11.67 | $200.00 | 7278, 7279 |

### Per-account

| account | total | accepted | rejected | sum blocked pnl |
|---|---|---|---|---|
| adam | 223 | 185 | 38 | -$186.18 |
| isaiah | 195 | 163 | 32 | -$434.70 |

### Per-day (where Gateway rejected ≥1 bet)

| date | total | rejected | sum blocked pnl |
|---|---|---|---|
| 2026-04-21 | 107 | 17 | -$6.39 |
| 2026-04-22 | 113 | 26 | -$420.48 |
| 2026-04-23 | 28 | 5 | -$110.90 |
| 2026-04-25 | 60 | 3 | -$52.20 |
| 2026-04-26 | 108 | 3 | $124.29 |
| 2026-04-28 | 24 | 9 | -$110.63 |
| 2026-04-29 | 41 | 3 | $34.08 |
| 2026-04-30 | 42 | 4 | -$78.65 |

