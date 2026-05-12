# Gateway Backtest — Pregame Only

Run at: 2026-04-30T20:48:36.920Z
Bets simulated: 708
Coverage: 2026-04-20 → 2026-04-30 (since 2026-04-15)

## Headline numbers per config

| config | accepted | rejected | rejected_pct | blocked_losing_pnl (saved) | blocked_winning_pnl (cost) | net effect |
|---|---|---|---|---|---|---|
| **sweep-500** | 379 | 39 | 5.5% | $1377.54 | $450.99 | **$926.55** |

> *Saved* = sum of pnl Gateway would have blocked from losing bets (positive number = good).
> *Cost* = sum of pnl Gateway would have blocked from winning bets (positive number = missed wins).
> *Net saved* = Saved − Cost.

---

## Config: `sweep-500`

*Daily-loss sweep: $500/account; pregame=$125.*

### Reject reason breakdown

| reason | count | sum of blocked pnl | sum of blocked size | sample bet ids |
|---|---|---|---|---|
| `ORDER_USD_OVER_LIMIT` | 39 | -$926.55 | $9345.00 | 78, 87, 95, 114, 116 |

### Per-account

| account | total | accepted | rejected | sum blocked pnl |
|---|---|---|---|---|
| adam | 223 | 198 | 25 | -$379.24 |
| isaiah | 195 | 181 | 14 | -$547.31 |

### Per-day (where Gateway rejected ≥1 bet)

| date | total | rejected | sum blocked pnl |
|---|---|---|---|
| 2026-04-21 | 107 | 9 | -$109.98 |
| 2026-04-22 | 54 | 21 | -$509.95 |
| 2026-04-23 | 15 | 2 | -$85.12 |
| 2026-04-25 | 30 | 1 | -$40.53 |
| 2026-04-26 | 36 | 1 | -$12.80 |
| 2026-04-28 | 13 | 4 | -$168.17 |
| 2026-04-30 | 9 | 1 | $0.00 |

### Per-pitcher rollup (descending block count)

| pitcher | blocks | distinct dates | sum blocked pnl | reject reasons | sample bet ids |
|---|---|---|---|---|---|
| José Soriano | 5 | 2 | -$392.48 | ORDER_USD_OVER_LIMIT | 3486, 3490, 3488, 3489, 8886 |
| Ryan Weiss | 2 | 1 | -$31.42 | ORDER_USD_OVER_LIMIT | 78, 87 |
| Parker Messick | 2 | 1 | -$21.51 | ORDER_USD_OVER_LIMIT | 117, 201 |
| Peter Lambert | 2 | 1 | $297.61 | ORDER_USD_OVER_LIMIT | 3499, 3501 |
| Max Fried | 2 | 1 | -$53.79 | ORDER_USD_OVER_LIMIT | 3571, 3567 |
| Eric Lauer | 2 | 1 | -$93.82 | ORDER_USD_OVER_LIMIT | 3630, 3854 |
| Braxton Ashcraft | 2 | 1 | -$84.80 | ORDER_USD_OVER_LIMIT | 3558, 3561 |
| Eduardo Rodriguez | 2 | 1 | -$129.17 | ORDER_USD_OVER_LIMIT | 5284, 5281 |
| Cristopher Sánchez | 2 | 1 | -$85.12 | ORDER_USD_OVER_LIMIT | 6355, 6421 |
| Jesús Luzardo | 1 | 1 | -$8.65 | ORDER_USD_OVER_LIMIT | 95 |
| Keider Montero | 1 | 1 | -$8.70 | ORDER_USD_OVER_LIMIT | 114 |
| Shota Imanaga | 1 | 1 | -$8.52 | ORDER_USD_OVER_LIMIT | 116 |
| Landen Roupp | 1 | 1 | -$17.04 | ORDER_USD_OVER_LIMIT | 161 |
| Luis Castillo | 1 | 1 | -$14.14 | ORDER_USD_OVER_LIMIT | 172 |
| Chris Bassitt | 1 | 1 | -$48.28 | ORDER_USD_OVER_LIMIT | 3493 |
| Ranger Suarez | 1 | 1 | -$54.04 | ORDER_USD_OVER_LIMIT | 3494 |
| Matthew Boyd | 1 | 1 | -$47.04 | ORDER_USD_OVER_LIMIT | 3679 |
| Connor Prielipp | 1 | 1 | $153.38 | ORDER_USD_OVER_LIMIT | 3714 |
| Tomoyuki Sugano | 1 | 1 | -$38.51 | ORDER_USD_OVER_LIMIT | 5450 |
| Anthony Kay | 1 | 1 | -$31.05 | ORDER_USD_OVER_LIMIT | 5449 |
| Shohei Ohtani | 1 | 1 | -$41.96 | ORDER_USD_OVER_LIMIT | 5448 |
| Cole Ragans | 1 | 1 | -$40.53 | ORDER_USD_OVER_LIMIT | 7080 |
| Ryne Nelson | 1 | 1 | -$12.80 | ORDER_USD_OVER_LIMIT | 7533 |
| Payton Tolle | 1 | 1 | -$35.19 | ORDER_USD_OVER_LIMIT | 8877 |
| Casey Mize | 1 | 1 | -$49.28 | ORDER_USD_OVER_LIMIT | 8878 |
| Kai-Wei Teng | 1 | 1 | -$29.70 | ORDER_USD_OVER_LIMIT | 8881 |
| Bailey Ober | 1 | 1 | $0.00 | ORDER_USD_OVER_LIMIT | 9424 |

### Blocked bet details (sorted by impact)

| id | date | account | pitcher | K | side | size | limit¢ | model | mid | edge | pnl | result | reason |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 3501 | 2026-04-22 | adam | Peter Lambert | 6 | YES | $279.00 | 50¢ | 0.378 | — | 0.208 | $215.36 | win | `ORDER_USD_OVER_LIMIT` |
| 3714 | 2026-04-22 | adam | Connor Prielipp | 6 | YES | $217.00 | 50¢ | 0.406 | — | 0.166 | $153.38 | win | `ORDER_USD_OVER_LIMIT` |
| 3488 | 2026-04-22 | adam | José Soriano | 7 | YES | $874.00 | 50¢ | 0.567 | — | 0.417 | -$131.10 | loss | `ORDER_USD_OVER_LIMIT` |
| 3489 | 2026-04-22 | adam | José Soriano | 6 | YES | $328.00 | 50¢ | 0.715 | — | 0.365 | -$114.80 | loss | `ORDER_USD_OVER_LIMIT` |
| 3499 | 2026-04-22 | adam | Peter Lambert | 5 | YES | $134.00 | 50¢ | 0.540 | — | 0.200 | $82.25 | win | `ORDER_USD_OVER_LIMIT` |
| 5281 | 2026-04-22 | isaiah | Eduardo Rodriguez | 4 | NO | $575.00 | 2600¢ | 0.518 | — | 0.182 | -$81.77 | loss | `ORDER_USD_OVER_LIMIT` |
| 3854 | 2026-04-22 | adam | Eric Lauer | 5 | YES | $510.00 | 50¢ | 0.341 | — | 0.211 | -$66.30 | loss | `ORDER_USD_OVER_LIMIT` |
| 6355 | 2026-04-23 | isaiah | Cristopher Sánchez | 9 | YES | $199.00 | 1000¢ | 0.321 | — | 0.221 | -$60.40 | loss | `ORDER_USD_OVER_LIMIT` |
| 3494 | 2026-04-22 | adam | Ranger Suarez | 4 | NO | $193.00 | 50¢ | 0.548 | — | 0.172 | -$54.04 | loss | `ORDER_USD_OVER_LIMIT` |
| 8886 | 2026-04-28 | isaiah | José Soriano | 7 | YES | $135.00 | 4000¢ | 0.615 | — | 0.215 | -$54.00 | loss | `ORDER_USD_OVER_LIMIT` |
| 3486 | 2026-04-22 | adam | José Soriano | 8 | YES | $238.00 | 50¢ | 0.429 | — | 0.219 | -$49.98 | loss | `ORDER_USD_OVER_LIMIT` |
| 8878 | 2026-04-28 | isaiah | Casey Mize | 6 | YES | $154.00 | 3200¢ | 0.503 | — | 0.183 | -$49.28 | loss | `ORDER_USD_OVER_LIMIT` |
| 3493 | 2026-04-22 | adam | Chris Bassitt | 3 | NO | $142.00 | 50¢ | 0.448 | — | 0.212 | -$48.28 | loss | `ORDER_USD_OVER_LIMIT` |
| 5284 | 2026-04-22 | isaiah | Eduardo Rodriguez | 3 | NO | $353.00 | 1500¢ | 0.715 | — | 0.105 | -$47.40 | loss | `ORDER_USD_OVER_LIMIT` |
| 3679 | 2026-04-22 | adam | Matthew Boyd | 7 | YES | $196.00 | 50¢ | 0.390 | — | 0.150 | -$47.04 | loss | `ORDER_USD_OVER_LIMIT` |
| 3561 | 2026-04-22 | adam | Braxton Ashcraft | 7 | YES | $140.00 | 50¢ | 0.463 | — | 0.143 | -$44.80 | loss | `ORDER_USD_OVER_LIMIT` |
| 3490 | 2026-04-22 | adam | José Soriano | 9 | YES | $355.00 | 50¢ | 0.307 | — | 0.187 | -$42.60 | loss | `ORDER_USD_OVER_LIMIT` |
| 5448 | 2026-04-22 | isaiah | Shohei Ohtani | 6 | NO | $299.00 | 2100¢ | 0.655 | — | 0.185 | -$41.96 | loss | `ORDER_USD_OVER_LIMIT` |
| 7080 | 2026-04-25 | isaiah | Cole Ragans | 5 | NO | $136.00 | 7500¢ | 0.447 | — | 0.293 | -$40.53 | loss | `ORDER_USD_OVER_LIMIT` |
| 3558 | 2026-04-22 | adam | Braxton Ashcraft | 8 | YES | $200.00 | 50¢ | 0.327 | — | 0.127 | -$40.00 | loss | `ORDER_USD_OVER_LIMIT` |
| 5450 | 2026-04-22 | isaiah | Tomoyuki Sugano | 4 | NO | $325.00 | 4700¢ | 0.406 | — | 0.114 | -$38.51 | loss | `ORDER_USD_OVER_LIMIT` |
| 8877 | 2026-04-28 | isaiah | Payton Tolle | 7 | YES | $153.00 | 2300¢ | 0.553 | — | 0.323 | -$35.19 | loss | `ORDER_USD_OVER_LIMIT` |
| 3567 | 2026-04-22 | adam | Max Fried | 4 | NO | $136.00 | 50¢ | 0.656 | — | 0.104 | -$32.64 | loss | `ORDER_USD_OVER_LIMIT` |
| 5449 | 2026-04-22 | isaiah | Anthony Kay | 3 | YES | $197.00 | 5800¢ | 0.705 | — | 0.385 | -$31.05 | loss | `ORDER_USD_OVER_LIMIT` |
| 8881 | 2026-04-28 | isaiah | Kai-Wei Teng | 6 | YES | $198.00 | 1500¢ | 0.631 | — | 0.481 | -$29.70 | loss | `ORDER_USD_OVER_LIMIT` |
| 3630 | 2026-04-22 | adam | Eric Lauer | 3 | NO | $172.00 | 50¢ | 0.719 | — | 0.121 | -$27.52 | loss | `ORDER_USD_OVER_LIMIT` |
| 6421 | 2026-04-23 | isaiah | Cristopher Sánchez | 6 | YES | $353.00 | 700¢ | 0.693 | — | 0.613 | -$24.72 | loss | `ORDER_USD_OVER_LIMIT` |
| 3571 | 2026-04-22 | adam | Max Fried | 3 | NO | $235.00 | 50¢ | 0.817 | — | 0.093 | -$21.15 | loss | `ORDER_USD_OVER_LIMIT` |
| 78 | 2026-04-21 | adam | Ryan Weiss | 6 | YES | $131.00 | 50¢ | 0.300 | — | 0.160 | -$18.34 | loss | `ORDER_USD_OVER_LIMIT` |
| 161 | 2026-04-21 | adam | Landen Roupp | 8 | YES | $142.00 | 50¢ | 0.270 | — | 0.150 | -$17.04 | loss | `ORDER_USD_OVER_LIMIT` |
| 172 | 2026-04-21 | adam | Luis Castillo | 3 | NO | $202.00 | 50¢ | 0.806 | — | 0.124 | -$14.14 | loss | `ORDER_USD_OVER_LIMIT` |
| 87 | 2026-04-21 | adam | Ryan Weiss | 7 | YES | $218.00 | 50¢ | 0.175 | — | 0.115 | -$13.08 | loss | `ORDER_USD_OVER_LIMIT` |
| 7533 | 2026-04-26 | isaiah | Ryne Nelson | 6 | YES | $128.00 | 1000¢ | 0.328 | — | 0.228 | -$12.80 | loss | `ORDER_USD_OVER_LIMIT` |
| 117 | 2026-04-21 | adam | Parker Messick | 9 | YES | $177.00 | 50¢ | 0.179 | — | 0.109 | -$12.39 | loss | `ORDER_USD_OVER_LIMIT` |
| 201 | 2026-04-21 | adam | Parker Messick | 10 | YES | $304.00 | 50¢ | 0.110 | — | 0.080 | -$9.12 | loss | `ORDER_USD_OVER_LIMIT` |
| 114 | 2026-04-21 | adam | Keider Montero | 8 | YES | $145.00 | 50¢ | 0.136 | — | 0.076 | -$8.70 | loss | `ORDER_USD_OVER_LIMIT` |
| 95 | 2026-04-21 | adam | Jesús Luzardo | 11 | YES | $173.00 | 50¢ | 0.126 | — | 0.076 | -$8.65 | loss | `ORDER_USD_OVER_LIMIT` |
| 116 | 2026-04-21 | adam | Shota Imanaga | 11 | YES | $142.00 | 50¢ | 0.135 | — | 0.075 | -$8.52 | loss | `ORDER_USD_OVER_LIMIT` |
| 9424 | 2026-04-30 | isaiah | Bailey Ober | 6 | YES | $157.00 | 2100¢ | 0.524 | — | 0.314 | $0.00 | — | `ORDER_USD_OVER_LIMIT` |

