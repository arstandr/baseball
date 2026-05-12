# Gateway Backtest — Pregame Only

Run at: 2026-04-30T20:44:48.762Z
Bets simulated: 708
Coverage: 2026-04-20 → 2026-04-30 (since 2026-04-15)

## Headline numbers per config

| config | accepted | rejected | rejected_pct | blocked_losing_pnl (saved) | blocked_winning_pnl (cost) | net effect |
|---|---|---|---|---|---|---|
| **defaults** | 418 | 0 | 0.0% | $0.00 | $0.00 | **$0.00** |
| **v1-realistic** | 402 | 16 | 2.3% | $696.63 | $368.74 | **$327.89** |
| **tight** | 348 | 70 | 9.9% | $1830.44 | $1194.11 | **$636.33** |
| **pregame-100** | 350 | 68 | 9.6% | $1818.77 | $1194.11 | **$624.66** |
| **pregame-125** | 379 | 39 | 5.5% | $1377.54 | $450.99 | **$926.55** |
| **pregame-150** | 390 | 28 | 4.0% | $1091.89 | $368.74 | **$723.15** |

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

### Per-pitcher rollup (descending block count)

No bets blocked.

### Blocked bet details (sorted by impact)

No bets blocked under this config.

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
| 2026-04-22 | 54 | 12 | -$266.83 |
| 2026-04-23 | 15 | 1 | -$24.72 |

### Per-pitcher rollup (descending block count)

| pitcher | blocks | distinct dates | sum blocked pnl | reject reasons | sample bet ids |
|---|---|---|---|---|---|
| José Soriano | 4 | 1 | -$338.48 | ORDER_USD_OVER_LIMIT | 3486, 3490, 3488, 3489 |
| Eduardo Rodriguez | 2 | 1 | -$129.17 | ORDER_USD_OVER_LIMIT | 5284, 5281 |
| Ryan Weiss | 1 | 1 | -$13.08 | ORDER_USD_OVER_LIMIT | 87 |
| Luis Castillo | 1 | 1 | -$14.14 | ORDER_USD_OVER_LIMIT | 172 |
| Parker Messick | 1 | 1 | -$9.12 | ORDER_USD_OVER_LIMIT | 201 |
| Peter Lambert | 1 | 1 | $215.36 | ORDER_USD_OVER_LIMIT | 3501 |
| Max Fried | 1 | 1 | -$21.15 | ORDER_USD_OVER_LIMIT | 3571 |
| Connor Prielipp | 1 | 1 | $153.38 | ORDER_USD_OVER_LIMIT | 3714 |
| Eric Lauer | 1 | 1 | -$66.30 | ORDER_USD_OVER_LIMIT | 3854 |
| Tomoyuki Sugano | 1 | 1 | -$38.51 | ORDER_USD_OVER_LIMIT | 5450 |
| Shohei Ohtani | 1 | 1 | -$41.96 | ORDER_USD_OVER_LIMIT | 5448 |
| Cristopher Sánchez | 1 | 1 | -$24.72 | ORDER_USD_OVER_LIMIT | 6421 |

### Blocked bet details (sorted by impact)

| id | date | account | pitcher | K | side | size | limit¢ | model | mid | edge | pnl | result | reason |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 3501 | 2026-04-22 | adam | Peter Lambert | 6 | YES | $279.00 | 50¢ | 0.378 | — | 0.208 | $215.36 | win | `ORDER_USD_OVER_LIMIT` |
| 3714 | 2026-04-22 | adam | Connor Prielipp | 6 | YES | $217.00 | 50¢ | 0.406 | — | 0.166 | $153.38 | win | `ORDER_USD_OVER_LIMIT` |
| 3488 | 2026-04-22 | adam | José Soriano | 7 | YES | $874.00 | 50¢ | 0.567 | — | 0.417 | -$131.10 | loss | `ORDER_USD_OVER_LIMIT` |
| 3489 | 2026-04-22 | adam | José Soriano | 6 | YES | $328.00 | 50¢ | 0.715 | — | 0.365 | -$114.80 | loss | `ORDER_USD_OVER_LIMIT` |
| 5281 | 2026-04-22 | isaiah | Eduardo Rodriguez | 4 | NO | $575.00 | 2600¢ | 0.518 | — | 0.182 | -$81.77 | loss | `ORDER_USD_OVER_LIMIT` |
| 3854 | 2026-04-22 | adam | Eric Lauer | 5 | YES | $510.00 | 50¢ | 0.341 | — | 0.211 | -$66.30 | loss | `ORDER_USD_OVER_LIMIT` |
| 3486 | 2026-04-22 | adam | José Soriano | 8 | YES | $238.00 | 50¢ | 0.429 | — | 0.219 | -$49.98 | loss | `ORDER_USD_OVER_LIMIT` |
| 5284 | 2026-04-22 | isaiah | Eduardo Rodriguez | 3 | NO | $353.00 | 1500¢ | 0.715 | — | 0.105 | -$47.40 | loss | `ORDER_USD_OVER_LIMIT` |
| 3490 | 2026-04-22 | adam | José Soriano | 9 | YES | $355.00 | 50¢ | 0.307 | — | 0.187 | -$42.60 | loss | `ORDER_USD_OVER_LIMIT` |
| 5448 | 2026-04-22 | isaiah | Shohei Ohtani | 6 | NO | $299.00 | 2100¢ | 0.655 | — | 0.185 | -$41.96 | loss | `ORDER_USD_OVER_LIMIT` |
| 5450 | 2026-04-22 | isaiah | Tomoyuki Sugano | 4 | NO | $325.00 | 4700¢ | 0.406 | — | 0.114 | -$38.51 | loss | `ORDER_USD_OVER_LIMIT` |
| 6421 | 2026-04-23 | isaiah | Cristopher Sánchez | 6 | YES | $353.00 | 700¢ | 0.693 | — | 0.613 | -$24.72 | loss | `ORDER_USD_OVER_LIMIT` |
| 3571 | 2026-04-22 | adam | Max Fried | 3 | NO | $235.00 | 50¢ | 0.817 | — | 0.093 | -$21.15 | loss | `ORDER_USD_OVER_LIMIT` |
| 172 | 2026-04-21 | adam | Luis Castillo | 3 | NO | $202.00 | 50¢ | 0.806 | — | 0.124 | -$14.14 | loss | `ORDER_USD_OVER_LIMIT` |
| 87 | 2026-04-21 | adam | Ryan Weiss | 7 | YES | $218.00 | 50¢ | 0.175 | — | 0.115 | -$13.08 | loss | `ORDER_USD_OVER_LIMIT` |
| 201 | 2026-04-21 | adam | Parker Messick | 10 | YES | $304.00 | 50¢ | 0.110 | — | 0.080 | -$9.12 | loss | `ORDER_USD_OVER_LIMIT` |

---

## Config: `tight`

*Tight limits: daily_loss=$200 adam / $100 isaiah; max_order=$100 pregame.*

### Reject reason breakdown

| reason | count | sum of blocked pnl | sum of blocked size | sample bet ids |
|---|---|---|---|---|
| `ORDER_USD_OVER_LIMIT` | 68 | -$624.66 | $12576.00 | 78, 79, 80, 87, 95 |
| `ACCOUNT_DAILY_LOSS_BREACHED` | 2 | -$11.67 | $200.00 | 7278, 7279 |

### Per-account

| account | total | accepted | rejected | sum blocked pnl |
|---|---|---|---|---|
| adam | 223 | 185 | 38 | -$186.18 |
| isaiah | 195 | 163 | 32 | -$450.15 |

### Per-day (where Gateway rejected ≥1 bet)

| date | total | rejected | sum blocked pnl |
|---|---|---|---|
| 2026-04-21 | 107 | 17 | -$6.39 |
| 2026-04-22 | 54 | 26 | -$420.48 |
| 2026-04-23 | 15 | 5 | -$110.90 |
| 2026-04-25 | 30 | 3 | -$52.20 |
| 2026-04-26 | 36 | 3 | $124.29 |
| 2026-04-28 | 13 | 9 | -$110.63 |
| 2026-04-29 | 25 | 3 | $34.08 |
| 2026-04-30 | 9 | 4 | -$94.10 |

### Per-pitcher rollup (descending block count)

| pitcher | blocks | distinct dates | sum blocked pnl | reject reasons | sample bet ids |
|---|---|---|---|---|---|
| José Soriano | 6 | 2 | -$458.20 | ORDER_USD_OVER_LIMIT | 3486, 3490, 3488, 3489, 3491 |
| Cristopher Sánchez | 4 | 1 | -$198.45 | ORDER_USD_OVER_LIMIT | 6348, 6355, 6350, 6421 |
| Max Fried | 3 | 1 | -$97.87 | ORDER_USD_OVER_LIMIT | 3571, 3560, 3567 |
| Ryan Weiss | 2 | 1 | -$31.42 | ORDER_USD_OVER_LIMIT | 78, 87 |
| Jesús Luzardo | 2 | 1 | -$24.10 | ORDER_USD_OVER_LIMIT | 79, 95 |
| Keider Montero | 2 | 1 | -$21.66 | ORDER_USD_OVER_LIMIT | 110, 114 |
| Shota Imanaga | 2 | 1 | -$20.62 | ORDER_USD_OVER_LIMIT | 116, 122 |
| Parker Messick | 2 | 1 | -$21.51 | ORDER_USD_OVER_LIMIT | 117, 201 |
| Chris Bassitt | 2 | 1 | $10.53 | ORDER_USD_OVER_LIMIT | 3485, 3493 |
| Peter Lambert | 2 | 1 | $297.61 | ORDER_USD_OVER_LIMIT | 3499, 3501 |
| Eric Lauer | 2 | 1 | -$93.82 | ORDER_USD_OVER_LIMIT | 3630, 3854 |
| Ranger Suarez | 2 | 1 | $6.22 | ORDER_USD_OVER_LIMIT | 3487, 3494 |
| Braxton Ashcraft | 2 | 1 | -$84.80 | ORDER_USD_OVER_LIMIT | 3558, 3561 |
| Walker Buehler | 2 | 2 | $70.28 | ORDER_USD_OVER_LIMIT | 3776, 8900 |
| Eduardo Rodriguez | 2 | 1 | -$129.17 | ORDER_USD_OVER_LIMIT | 5284, 5281 |
| Walbert Ureña | 2 | 1 | -$11.67 | ACCOUNT_DAILY_LOSS_BREACHED | 7278, 7279 |
| Simeon Woods Richardson | 1 | 1 | $83.42 | ORDER_USD_OVER_LIMIT | 80 |
| Jacob Lopez | 1 | 1 | $87.19 | ORDER_USD_OVER_LIMIT | 141 |
| Landen Roupp | 1 | 1 | -$17.04 | ORDER_USD_OVER_LIMIT | 161 |
| Luis Castillo | 1 | 1 | -$14.14 | ORDER_USD_OVER_LIMIT | 172 |
| Carmen Mlodzinski | 1 | 1 | -$12.24 | ORDER_USD_OVER_LIMIT | 189 |
| Reynaldo López | 1 | 1 | -$7.20 | ORDER_USD_OVER_LIMIT | 216 |
| Chris Paddack | 1 | 1 | -$7.07 | ORDER_USD_OVER_LIMIT | 217 |
| Matthew Boyd | 1 | 1 | -$47.04 | ORDER_USD_OVER_LIMIT | 3679 |
| Connor Prielipp | 1 | 1 | $153.38 | ORDER_USD_OVER_LIMIT | 3714 |
| Tomoyuki Sugano | 1 | 1 | -$38.51 | ORDER_USD_OVER_LIMIT | 5450 |
| Anthony Kay | 1 | 1 | -$31.05 | ORDER_USD_OVER_LIMIT | 5449 |
| Shohei Ohtani | 1 | 1 | -$41.96 | ORDER_USD_OVER_LIMIT | 5448 |
| Tyler Glasnow | 1 | 1 | $87.55 | ORDER_USD_OVER_LIMIT | 6440 |
| Cole Ragans | 1 | 1 | -$40.53 | ORDER_USD_OVER_LIMIT | 7080 |
| Spencer Arrighetti | 1 | 1 | $76.08 | ORDER_USD_OVER_LIMIT | 7499 |
| Ryne Nelson | 1 | 1 | -$12.80 | ORDER_USD_OVER_LIMIT | 7533 |
| Michael King | 1 | 1 | $61.01 | ORDER_USD_OVER_LIMIT | 7539 |
| Nick Martinez | 1 | 1 | -$0.62 | ORDER_USD_OVER_LIMIT | 8874 |
| Payton Tolle | 1 | 1 | -$35.19 | ORDER_USD_OVER_LIMIT | 8877 |
| Casey Mize | 1 | 1 | -$49.28 | ORDER_USD_OVER_LIMIT | 8878 |
| Kai-Wei Teng | 1 | 1 | -$29.70 | ORDER_USD_OVER_LIMIT | 8881 |
| Cam Schlittler | 1 | 1 | $68.08 | ORDER_USD_OVER_LIMIT | 8888 |
| Merrill Kelly | 1 | 1 | $0.00 | ORDER_USD_OVER_LIMIT | 8891 |
| Kris Bubic | 1 | 1 | $0.00 | ORDER_USD_OVER_LIMIT | 8894 |
| David Peterson | 1 | 1 | -$28.50 | ORDER_USD_OVER_LIMIT | 9173 |
| Andre Pallante | 1 | 1 | $80.52 | ORDER_USD_OVER_LIMIT | 9178 |
| Michael Wacha | 1 | 1 | -$17.94 | ORDER_USD_OVER_LIMIT | 9299 |
| Bryce Elder | 1 | 1 | -$40.25 | ORDER_USD_OVER_LIMIT | 9362 |
| Lance McCullers Jr. | 1 | 1 | -$38.40 | ORDER_USD_OVER_LIMIT | 9391 |
| Jeffrey Springs | 1 | 1 | -$15.45 | ORDER_USD_OVER_LIMIT | 9399 |
| Bailey Ober | 1 | 1 | $0.00 | ORDER_USD_OVER_LIMIT | 9424 |

### Blocked bet details (sorted by impact)

| id | date | account | pitcher | K | side | size | limit¢ | model | mid | edge | pnl | result | reason |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 3501 | 2026-04-22 | adam | Peter Lambert | 6 | YES | $279.00 | 50¢ | 0.378 | — | 0.208 | $215.36 | win | `ORDER_USD_OVER_LIMIT` |
| 3714 | 2026-04-22 | adam | Connor Prielipp | 6 | YES | $217.00 | 50¢ | 0.406 | — | 0.166 | $153.38 | win | `ORDER_USD_OVER_LIMIT` |
| 3488 | 2026-04-22 | adam | José Soriano | 7 | YES | $874.00 | 50¢ | 0.567 | — | 0.417 | -$131.10 | loss | `ORDER_USD_OVER_LIMIT` |
| 3489 | 2026-04-22 | adam | José Soriano | 6 | YES | $328.00 | 50¢ | 0.715 | — | 0.365 | -$114.80 | loss | `ORDER_USD_OVER_LIMIT` |
| 6440 | 2026-04-23 | isaiah | Tyler Glasnow | 9 | YES | $103.00 | 1500¢ | 0.317 | — | 0.157 | $87.55 | win | `ORDER_USD_OVER_LIMIT` |
| 141 | 2026-04-21 | adam | Jacob Lopez | 4 | NO | $125.00 | 50¢ | 0.475 | — | 0.275 | $87.19 | win | `ORDER_USD_OVER_LIMIT` |
| 80 | 2026-04-21 | adam | Simeon Woods Richardson | 3 | NO | $115.00 | 50¢ | 0.559 | — | 0.221 | $83.42 | win | `ORDER_USD_OVER_LIMIT` |
| 3499 | 2026-04-22 | adam | Peter Lambert | 5 | YES | $134.00 | 50¢ | 0.540 | — | 0.200 | $82.25 | win | `ORDER_USD_OVER_LIMIT` |
| 5281 | 2026-04-22 | isaiah | Eduardo Rodriguez | 4 | NO | $575.00 | 2600¢ | 0.518 | — | 0.182 | -$81.77 | loss | `ORDER_USD_OVER_LIMIT` |
| 9178 | 2026-04-29 | isaiah | Andre Pallante | 6 | YES | $111.00 | 2200¢ | 0.481 | — | 0.261 | $80.52 | win | `ORDER_USD_OVER_LIMIT` |
| 3776 | 2026-04-22 | adam | Walker Buehler | 3 | NO | $112.00 | 50¢ | 0.688 | — | 0.082 | $80.20 | win | `ORDER_USD_OVER_LIMIT` |
| 6350 | 2026-04-23 | isaiah | Cristopher Sánchez | 7 | YES | $101.00 | 3500¢ | 0.541 | — | 0.371 | -$79.78 | loss | `ORDER_USD_OVER_LIMIT` |
| 7499 | 2026-04-26 | isaiah | Spencer Arrighetti | 8 | YES | $101.00 | 1900¢ | 0.529 | — | 0.339 | $76.08 | win | `ORDER_USD_OVER_LIMIT` |
| 8888 | 2026-04-28 | isaiah | Cam Schlittler | 7 | YES | $122.00 | 4000¢ | 0.606 | — | 0.206 | $68.08 | win | `ORDER_USD_OVER_LIMIT` |
| 3854 | 2026-04-22 | adam | Eric Lauer | 5 | YES | $510.00 | 50¢ | 0.341 | — | 0.211 | -$66.30 | loss | `ORDER_USD_OVER_LIMIT` |
| 3491 | 2026-04-22 | adam | José Soriano | 5 | YES | $106.00 | 50¢ | 0.829 | — | 0.209 | -$65.72 | loss | `ORDER_USD_OVER_LIMIT` |
| 7539 | 2026-04-26 | isaiah | Michael King | 6 | YES | $109.00 | 1800¢ | 0.532 | — | 0.352 | $61.01 | win | `ORDER_USD_OVER_LIMIT` |
| 6355 | 2026-04-23 | isaiah | Cristopher Sánchez | 9 | YES | $199.00 | 1000¢ | 0.321 | — | 0.221 | -$60.40 | loss | `ORDER_USD_OVER_LIMIT` |
| 3487 | 2026-04-22 | adam | Ranger Suarez | 5 | NO | $120.00 | 50¢ | 0.364 | — | 0.176 | $60.26 | win | `ORDER_USD_OVER_LIMIT` |
| 3485 | 2026-04-22 | adam | Chris Bassitt | 4 | NO | $124.00 | 50¢ | 0.244 | — | 0.266 | $58.81 | win | `ORDER_USD_OVER_LIMIT` |
| 3494 | 2026-04-22 | adam | Ranger Suarez | 4 | NO | $193.00 | 50¢ | 0.548 | — | 0.172 | -$54.04 | loss | `ORDER_USD_OVER_LIMIT` |
| 8886 | 2026-04-28 | isaiah | José Soriano | 7 | YES | $135.00 | 4000¢ | 0.615 | — | 0.215 | -$54.00 | loss | `ORDER_USD_OVER_LIMIT` |
| 3486 | 2026-04-22 | adam | José Soriano | 8 | YES | $238.00 | 50¢ | 0.429 | — | 0.219 | -$49.98 | loss | `ORDER_USD_OVER_LIMIT` |
| 8878 | 2026-04-28 | isaiah | Casey Mize | 6 | YES | $154.00 | 3200¢ | 0.503 | — | 0.183 | -$49.28 | loss | `ORDER_USD_OVER_LIMIT` |
| 3493 | 2026-04-22 | adam | Chris Bassitt | 3 | NO | $142.00 | 50¢ | 0.448 | — | 0.212 | -$48.28 | loss | `ORDER_USD_OVER_LIMIT` |
| 5284 | 2026-04-22 | isaiah | Eduardo Rodriguez | 3 | NO | $353.00 | 1500¢ | 0.715 | — | 0.105 | -$47.40 | loss | `ORDER_USD_OVER_LIMIT` |
| 3679 | 2026-04-22 | adam | Matthew Boyd | 7 | YES | $196.00 | 50¢ | 0.390 | — | 0.150 | -$47.04 | loss | `ORDER_USD_OVER_LIMIT` |
| 3561 | 2026-04-22 | adam | Braxton Ashcraft | 7 | YES | $140.00 | 50¢ | 0.463 | — | 0.143 | -$44.80 | loss | `ORDER_USD_OVER_LIMIT` |
| 3560 | 2026-04-22 | adam | Max Fried | 5 | NO | $116.00 | 50¢ | 0.479 | — | 0.141 | -$44.08 | loss | `ORDER_USD_OVER_LIMIT` |
| 3490 | 2026-04-22 | adam | José Soriano | 9 | YES | $355.00 | 50¢ | 0.307 | — | 0.187 | -$42.60 | loss | `ORDER_USD_OVER_LIMIT` |
| 5448 | 2026-04-22 | isaiah | Shohei Ohtani | 6 | NO | $299.00 | 2100¢ | 0.655 | — | 0.185 | -$41.96 | loss | `ORDER_USD_OVER_LIMIT` |
| 7080 | 2026-04-25 | isaiah | Cole Ragans | 5 | NO | $136.00 | 7500¢ | 0.447 | — | 0.293 | -$40.53 | loss | `ORDER_USD_OVER_LIMIT` |
| 9362 | 2026-04-30 | isaiah | Bryce Elder | 6 | YES | $115.00 | 3500¢ | 0.581 | — | 0.231 | -$40.25 | loss | `ORDER_USD_OVER_LIMIT` |
| 3558 | 2026-04-22 | adam | Braxton Ashcraft | 8 | YES | $200.00 | 50¢ | 0.327 | — | 0.127 | -$40.00 | loss | `ORDER_USD_OVER_LIMIT` |
| 5450 | 2026-04-22 | isaiah | Tomoyuki Sugano | 4 | NO | $325.00 | 4700¢ | 0.406 | — | 0.114 | -$38.51 | loss | `ORDER_USD_OVER_LIMIT` |
| 9391 | 2026-04-30 | isaiah | Lance McCullers Jr. | 6 | YES | $120.00 | 3200¢ | 0.662 | — | 0.342 | -$38.40 | loss | `ORDER_USD_OVER_LIMIT` |
| 8877 | 2026-04-28 | isaiah | Payton Tolle | 7 | YES | $153.00 | 2300¢ | 0.553 | — | 0.323 | -$35.19 | loss | `ORDER_USD_OVER_LIMIT` |
| 6348 | 2026-04-23 | isaiah | Cristopher Sánchez | 8 | YES | $110.00 | 2000¢ | 0.444 | — | 0.244 | -$33.55 | loss | `ORDER_USD_OVER_LIMIT` |
| 3567 | 2026-04-22 | adam | Max Fried | 4 | NO | $136.00 | 50¢ | 0.656 | — | 0.104 | -$32.64 | loss | `ORDER_USD_OVER_LIMIT` |
| 5449 | 2026-04-22 | isaiah | Anthony Kay | 3 | YES | $197.00 | 5800¢ | 0.705 | — | 0.385 | -$31.05 | loss | `ORDER_USD_OVER_LIMIT` |
| 8881 | 2026-04-28 | isaiah | Kai-Wei Teng | 6 | YES | $198.00 | 1500¢ | 0.631 | — | 0.481 | -$29.70 | loss | `ORDER_USD_OVER_LIMIT` |
| 9173 | 2026-04-29 | isaiah | David Peterson | 7 | YES | $114.00 | 2500¢ | 0.511 | — | 0.261 | -$28.50 | loss | `ORDER_USD_OVER_LIMIT` |
| 3630 | 2026-04-22 | adam | Eric Lauer | 3 | NO | $172.00 | 50¢ | 0.719 | — | 0.121 | -$27.52 | loss | `ORDER_USD_OVER_LIMIT` |
| 6421 | 2026-04-23 | isaiah | Cristopher Sánchez | 6 | YES | $353.00 | 700¢ | 0.693 | — | 0.613 | -$24.72 | loss | `ORDER_USD_OVER_LIMIT` |
| 3571 | 2026-04-22 | adam | Max Fried | 3 | NO | $235.00 | 50¢ | 0.817 | — | 0.093 | -$21.15 | loss | `ORDER_USD_OVER_LIMIT` |
| 78 | 2026-04-21 | adam | Ryan Weiss | 6 | YES | $131.00 | 50¢ | 0.300 | — | 0.160 | -$18.34 | loss | `ORDER_USD_OVER_LIMIT` |
| 9299 | 2026-04-29 | isaiah | Michael Wacha | 6 | YES | $103.00 | 2600¢ | 0.556 | — | 0.296 | -$17.94 | loss | `ORDER_USD_OVER_LIMIT` |
| 161 | 2026-04-21 | adam | Landen Roupp | 8 | YES | $142.00 | 50¢ | 0.270 | — | 0.150 | -$17.04 | loss | `ORDER_USD_OVER_LIMIT` |
| 79 | 2026-04-21 | adam | Jesús Luzardo | 9 | YES | $103.00 | 50¢ | 0.286 | — | 0.136 | -$15.45 | loss | `ORDER_USD_OVER_LIMIT` |
| 9399 | 2026-04-30 | isaiah | Jeffrey Springs | 7 | YES | $103.00 | 1500¢ | 0.469 | — | 0.319 | -$15.45 | loss | `ORDER_USD_OVER_LIMIT` |
| 172 | 2026-04-21 | adam | Luis Castillo | 3 | NO | $202.00 | 50¢ | 0.806 | — | 0.124 | -$14.14 | loss | `ORDER_USD_OVER_LIMIT` |
| 87 | 2026-04-21 | adam | Ryan Weiss | 7 | YES | $218.00 | 50¢ | 0.175 | — | 0.115 | -$13.08 | loss | `ORDER_USD_OVER_LIMIT` |
| 110 | 2026-04-21 | adam | Keider Montero | 7 | YES | $108.00 | 50¢ | 0.234 | — | 0.114 | -$12.96 | loss | `ORDER_USD_OVER_LIMIT` |
| 7533 | 2026-04-26 | isaiah | Ryne Nelson | 6 | YES | $128.00 | 1000¢ | 0.328 | — | 0.228 | -$12.80 | loss | `ORDER_USD_OVER_LIMIT` |
| 117 | 2026-04-21 | adam | Parker Messick | 9 | YES | $177.00 | 50¢ | 0.179 | — | 0.109 | -$12.39 | loss | `ORDER_USD_OVER_LIMIT` |
| 189 | 2026-04-21 | adam | Carmen Mlodzinski | 7 | YES | $102.00 | 50¢ | 0.227 | — | 0.107 | -$12.24 | loss | `ORDER_USD_OVER_LIMIT` |
| 122 | 2026-04-21 | adam | Shota Imanaga | 10 | YES | $121.00 | 50¢ | 0.206 | — | 0.106 | -$12.10 | loss | `ORDER_USD_OVER_LIMIT` |
| 8900 | 2026-04-28 | isaiah | Walker Buehler | 5 | YES | $102.00 | 3200¢ | 0.467 | — | 0.147 | -$9.92 | loss | `ORDER_USD_OVER_LIMIT` |
| 201 | 2026-04-21 | adam | Parker Messick | 10 | YES | $304.00 | 50¢ | 0.110 | — | 0.080 | -$9.12 | loss | `ORDER_USD_OVER_LIMIT` |
| 114 | 2026-04-21 | adam | Keider Montero | 8 | YES | $145.00 | 50¢ | 0.136 | — | 0.076 | -$8.70 | loss | `ORDER_USD_OVER_LIMIT` |
| 95 | 2026-04-21 | adam | Jesús Luzardo | 11 | YES | $173.00 | 50¢ | 0.126 | — | 0.076 | -$8.65 | loss | `ORDER_USD_OVER_LIMIT` |
| 116 | 2026-04-21 | adam | Shota Imanaga | 11 | YES | $142.00 | 50¢ | 0.135 | — | 0.075 | -$8.52 | loss | `ORDER_USD_OVER_LIMIT` |
| 7279 | 2026-04-25 | isaiah | Walbert Ureña | 4 | YES | $100.00 | 4600¢ | 0.500 | — | 0.000 | -$7.88 | loss | `ACCOUNT_DAILY_LOSS_BREACHED` |
| 216 | 2026-04-21 | adam | Reynaldo López | 8 | YES | $120.00 | 50¢ | 0.123 | — | 0.063 | -$7.20 | loss | `ORDER_USD_OVER_LIMIT` |
| 217 | 2026-04-21 | adam | Chris Paddack | 8 | YES | $101.00 | 50¢ | 0.132 | — | 0.062 | -$7.07 | loss | `ORDER_USD_OVER_LIMIT` |
| 7278 | 2026-04-25 | isaiah | Walbert Ureña | 7 | YES | $100.00 | 800¢ | 0.500 | — | 0.000 | -$3.79 | loss | `ACCOUNT_DAILY_LOSS_BREACHED` |
| 8874 | 2026-04-28 | isaiah | Nick Martinez | 5 | YES | $117.00 | 3100¢ | 0.477 | — | 0.167 | -$0.62 | loss | `ORDER_USD_OVER_LIMIT` |
| 8891 | 2026-04-28 | isaiah | Merrill Kelly | 6 | YES | $120.00 | 3400¢ | 0.532 | — | 0.192 | $0.00 | loss | `ORDER_USD_OVER_LIMIT` |
| 8894 | 2026-04-28 | isaiah | Kris Bubic | 8 | YES | $107.00 | 2200¢ | 0.569 | — | 0.349 | $0.00 | loss | `ORDER_USD_OVER_LIMIT` |
| 9424 | 2026-04-30 | isaiah | Bailey Ober | 6 | YES | $157.00 | 2100¢ | 0.524 | — | 0.314 | $0.00 | — | `ORDER_USD_OVER_LIMIT` |

---

## Config: `pregame-100`

*Pregame sweep: daily_loss=$400/account; max_order=$100 pregame.*

### Reject reason breakdown

| reason | count | sum of blocked pnl | sum of blocked size | sample bet ids |
|---|---|---|---|---|
| `ORDER_USD_OVER_LIMIT` | 68 | -$624.66 | $12576.00 | 78, 79, 80, 87, 95 |

### Per-account

| account | total | accepted | rejected | sum blocked pnl |
|---|---|---|---|---|
| adam | 223 | 185 | 38 | -$186.18 |
| isaiah | 195 | 165 | 30 | -$438.48 |

### Per-day (where Gateway rejected ≥1 bet)

| date | total | rejected | sum blocked pnl |
|---|---|---|---|
| 2026-04-21 | 107 | 17 | -$6.39 |
| 2026-04-22 | 54 | 26 | -$420.48 |
| 2026-04-23 | 15 | 5 | -$110.90 |
| 2026-04-25 | 30 | 1 | -$40.53 |
| 2026-04-26 | 36 | 3 | $124.29 |
| 2026-04-28 | 13 | 9 | -$110.63 |
| 2026-04-29 | 25 | 3 | $34.08 |
| 2026-04-30 | 9 | 4 | -$94.10 |

### Per-pitcher rollup (descending block count)

| pitcher | blocks | distinct dates | sum blocked pnl | reject reasons | sample bet ids |
|---|---|---|---|---|---|
| José Soriano | 6 | 2 | -$458.20 | ORDER_USD_OVER_LIMIT | 3486, 3490, 3488, 3489, 3491 |
| Cristopher Sánchez | 4 | 1 | -$198.45 | ORDER_USD_OVER_LIMIT | 6348, 6355, 6350, 6421 |
| Max Fried | 3 | 1 | -$97.87 | ORDER_USD_OVER_LIMIT | 3571, 3560, 3567 |
| Ryan Weiss | 2 | 1 | -$31.42 | ORDER_USD_OVER_LIMIT | 78, 87 |
| Jesús Luzardo | 2 | 1 | -$24.10 | ORDER_USD_OVER_LIMIT | 79, 95 |
| Keider Montero | 2 | 1 | -$21.66 | ORDER_USD_OVER_LIMIT | 110, 114 |
| Shota Imanaga | 2 | 1 | -$20.62 | ORDER_USD_OVER_LIMIT | 116, 122 |
| Parker Messick | 2 | 1 | -$21.51 | ORDER_USD_OVER_LIMIT | 117, 201 |
| Chris Bassitt | 2 | 1 | $10.53 | ORDER_USD_OVER_LIMIT | 3485, 3493 |
| Peter Lambert | 2 | 1 | $297.61 | ORDER_USD_OVER_LIMIT | 3499, 3501 |
| Eric Lauer | 2 | 1 | -$93.82 | ORDER_USD_OVER_LIMIT | 3630, 3854 |
| Ranger Suarez | 2 | 1 | $6.22 | ORDER_USD_OVER_LIMIT | 3487, 3494 |
| Braxton Ashcraft | 2 | 1 | -$84.80 | ORDER_USD_OVER_LIMIT | 3558, 3561 |
| Walker Buehler | 2 | 2 | $70.28 | ORDER_USD_OVER_LIMIT | 3776, 8900 |
| Eduardo Rodriguez | 2 | 1 | -$129.17 | ORDER_USD_OVER_LIMIT | 5284, 5281 |
| Simeon Woods Richardson | 1 | 1 | $83.42 | ORDER_USD_OVER_LIMIT | 80 |
| Jacob Lopez | 1 | 1 | $87.19 | ORDER_USD_OVER_LIMIT | 141 |
| Landen Roupp | 1 | 1 | -$17.04 | ORDER_USD_OVER_LIMIT | 161 |
| Luis Castillo | 1 | 1 | -$14.14 | ORDER_USD_OVER_LIMIT | 172 |
| Carmen Mlodzinski | 1 | 1 | -$12.24 | ORDER_USD_OVER_LIMIT | 189 |
| Reynaldo López | 1 | 1 | -$7.20 | ORDER_USD_OVER_LIMIT | 216 |
| Chris Paddack | 1 | 1 | -$7.07 | ORDER_USD_OVER_LIMIT | 217 |
| Matthew Boyd | 1 | 1 | -$47.04 | ORDER_USD_OVER_LIMIT | 3679 |
| Connor Prielipp | 1 | 1 | $153.38 | ORDER_USD_OVER_LIMIT | 3714 |
| Tomoyuki Sugano | 1 | 1 | -$38.51 | ORDER_USD_OVER_LIMIT | 5450 |
| Anthony Kay | 1 | 1 | -$31.05 | ORDER_USD_OVER_LIMIT | 5449 |
| Shohei Ohtani | 1 | 1 | -$41.96 | ORDER_USD_OVER_LIMIT | 5448 |
| Tyler Glasnow | 1 | 1 | $87.55 | ORDER_USD_OVER_LIMIT | 6440 |
| Cole Ragans | 1 | 1 | -$40.53 | ORDER_USD_OVER_LIMIT | 7080 |
| Spencer Arrighetti | 1 | 1 | $76.08 | ORDER_USD_OVER_LIMIT | 7499 |
| Ryne Nelson | 1 | 1 | -$12.80 | ORDER_USD_OVER_LIMIT | 7533 |
| Michael King | 1 | 1 | $61.01 | ORDER_USD_OVER_LIMIT | 7539 |
| Nick Martinez | 1 | 1 | -$0.62 | ORDER_USD_OVER_LIMIT | 8874 |
| Payton Tolle | 1 | 1 | -$35.19 | ORDER_USD_OVER_LIMIT | 8877 |
| Casey Mize | 1 | 1 | -$49.28 | ORDER_USD_OVER_LIMIT | 8878 |
| Kai-Wei Teng | 1 | 1 | -$29.70 | ORDER_USD_OVER_LIMIT | 8881 |
| Cam Schlittler | 1 | 1 | $68.08 | ORDER_USD_OVER_LIMIT | 8888 |
| Merrill Kelly | 1 | 1 | $0.00 | ORDER_USD_OVER_LIMIT | 8891 |
| Kris Bubic | 1 | 1 | $0.00 | ORDER_USD_OVER_LIMIT | 8894 |
| David Peterson | 1 | 1 | -$28.50 | ORDER_USD_OVER_LIMIT | 9173 |
| Andre Pallante | 1 | 1 | $80.52 | ORDER_USD_OVER_LIMIT | 9178 |
| Michael Wacha | 1 | 1 | -$17.94 | ORDER_USD_OVER_LIMIT | 9299 |
| Bryce Elder | 1 | 1 | -$40.25 | ORDER_USD_OVER_LIMIT | 9362 |
| Lance McCullers Jr. | 1 | 1 | -$38.40 | ORDER_USD_OVER_LIMIT | 9391 |
| Jeffrey Springs | 1 | 1 | -$15.45 | ORDER_USD_OVER_LIMIT | 9399 |
| Bailey Ober | 1 | 1 | $0.00 | ORDER_USD_OVER_LIMIT | 9424 |

### Blocked bet details (sorted by impact)

| id | date | account | pitcher | K | side | size | limit¢ | model | mid | edge | pnl | result | reason |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 3501 | 2026-04-22 | adam | Peter Lambert | 6 | YES | $279.00 | 50¢ | 0.378 | — | 0.208 | $215.36 | win | `ORDER_USD_OVER_LIMIT` |
| 3714 | 2026-04-22 | adam | Connor Prielipp | 6 | YES | $217.00 | 50¢ | 0.406 | — | 0.166 | $153.38 | win | `ORDER_USD_OVER_LIMIT` |
| 3488 | 2026-04-22 | adam | José Soriano | 7 | YES | $874.00 | 50¢ | 0.567 | — | 0.417 | -$131.10 | loss | `ORDER_USD_OVER_LIMIT` |
| 3489 | 2026-04-22 | adam | José Soriano | 6 | YES | $328.00 | 50¢ | 0.715 | — | 0.365 | -$114.80 | loss | `ORDER_USD_OVER_LIMIT` |
| 6440 | 2026-04-23 | isaiah | Tyler Glasnow | 9 | YES | $103.00 | 1500¢ | 0.317 | — | 0.157 | $87.55 | win | `ORDER_USD_OVER_LIMIT` |
| 141 | 2026-04-21 | adam | Jacob Lopez | 4 | NO | $125.00 | 50¢ | 0.475 | — | 0.275 | $87.19 | win | `ORDER_USD_OVER_LIMIT` |
| 80 | 2026-04-21 | adam | Simeon Woods Richardson | 3 | NO | $115.00 | 50¢ | 0.559 | — | 0.221 | $83.42 | win | `ORDER_USD_OVER_LIMIT` |
| 3499 | 2026-04-22 | adam | Peter Lambert | 5 | YES | $134.00 | 50¢ | 0.540 | — | 0.200 | $82.25 | win | `ORDER_USD_OVER_LIMIT` |
| 5281 | 2026-04-22 | isaiah | Eduardo Rodriguez | 4 | NO | $575.00 | 2600¢ | 0.518 | — | 0.182 | -$81.77 | loss | `ORDER_USD_OVER_LIMIT` |
| 9178 | 2026-04-29 | isaiah | Andre Pallante | 6 | YES | $111.00 | 2200¢ | 0.481 | — | 0.261 | $80.52 | win | `ORDER_USD_OVER_LIMIT` |
| 3776 | 2026-04-22 | adam | Walker Buehler | 3 | NO | $112.00 | 50¢ | 0.688 | — | 0.082 | $80.20 | win | `ORDER_USD_OVER_LIMIT` |
| 6350 | 2026-04-23 | isaiah | Cristopher Sánchez | 7 | YES | $101.00 | 3500¢ | 0.541 | — | 0.371 | -$79.78 | loss | `ORDER_USD_OVER_LIMIT` |
| 7499 | 2026-04-26 | isaiah | Spencer Arrighetti | 8 | YES | $101.00 | 1900¢ | 0.529 | — | 0.339 | $76.08 | win | `ORDER_USD_OVER_LIMIT` |
| 8888 | 2026-04-28 | isaiah | Cam Schlittler | 7 | YES | $122.00 | 4000¢ | 0.606 | — | 0.206 | $68.08 | win | `ORDER_USD_OVER_LIMIT` |
| 3854 | 2026-04-22 | adam | Eric Lauer | 5 | YES | $510.00 | 50¢ | 0.341 | — | 0.211 | -$66.30 | loss | `ORDER_USD_OVER_LIMIT` |
| 3491 | 2026-04-22 | adam | José Soriano | 5 | YES | $106.00 | 50¢ | 0.829 | — | 0.209 | -$65.72 | loss | `ORDER_USD_OVER_LIMIT` |
| 7539 | 2026-04-26 | isaiah | Michael King | 6 | YES | $109.00 | 1800¢ | 0.532 | — | 0.352 | $61.01 | win | `ORDER_USD_OVER_LIMIT` |
| 6355 | 2026-04-23 | isaiah | Cristopher Sánchez | 9 | YES | $199.00 | 1000¢ | 0.321 | — | 0.221 | -$60.40 | loss | `ORDER_USD_OVER_LIMIT` |
| 3487 | 2026-04-22 | adam | Ranger Suarez | 5 | NO | $120.00 | 50¢ | 0.364 | — | 0.176 | $60.26 | win | `ORDER_USD_OVER_LIMIT` |
| 3485 | 2026-04-22 | adam | Chris Bassitt | 4 | NO | $124.00 | 50¢ | 0.244 | — | 0.266 | $58.81 | win | `ORDER_USD_OVER_LIMIT` |
| 3494 | 2026-04-22 | adam | Ranger Suarez | 4 | NO | $193.00 | 50¢ | 0.548 | — | 0.172 | -$54.04 | loss | `ORDER_USD_OVER_LIMIT` |
| 8886 | 2026-04-28 | isaiah | José Soriano | 7 | YES | $135.00 | 4000¢ | 0.615 | — | 0.215 | -$54.00 | loss | `ORDER_USD_OVER_LIMIT` |
| 3486 | 2026-04-22 | adam | José Soriano | 8 | YES | $238.00 | 50¢ | 0.429 | — | 0.219 | -$49.98 | loss | `ORDER_USD_OVER_LIMIT` |
| 8878 | 2026-04-28 | isaiah | Casey Mize | 6 | YES | $154.00 | 3200¢ | 0.503 | — | 0.183 | -$49.28 | loss | `ORDER_USD_OVER_LIMIT` |
| 3493 | 2026-04-22 | adam | Chris Bassitt | 3 | NO | $142.00 | 50¢ | 0.448 | — | 0.212 | -$48.28 | loss | `ORDER_USD_OVER_LIMIT` |
| 5284 | 2026-04-22 | isaiah | Eduardo Rodriguez | 3 | NO | $353.00 | 1500¢ | 0.715 | — | 0.105 | -$47.40 | loss | `ORDER_USD_OVER_LIMIT` |
| 3679 | 2026-04-22 | adam | Matthew Boyd | 7 | YES | $196.00 | 50¢ | 0.390 | — | 0.150 | -$47.04 | loss | `ORDER_USD_OVER_LIMIT` |
| 3561 | 2026-04-22 | adam | Braxton Ashcraft | 7 | YES | $140.00 | 50¢ | 0.463 | — | 0.143 | -$44.80 | loss | `ORDER_USD_OVER_LIMIT` |
| 3560 | 2026-04-22 | adam | Max Fried | 5 | NO | $116.00 | 50¢ | 0.479 | — | 0.141 | -$44.08 | loss | `ORDER_USD_OVER_LIMIT` |
| 3490 | 2026-04-22 | adam | José Soriano | 9 | YES | $355.00 | 50¢ | 0.307 | — | 0.187 | -$42.60 | loss | `ORDER_USD_OVER_LIMIT` |
| 5448 | 2026-04-22 | isaiah | Shohei Ohtani | 6 | NO | $299.00 | 2100¢ | 0.655 | — | 0.185 | -$41.96 | loss | `ORDER_USD_OVER_LIMIT` |
| 7080 | 2026-04-25 | isaiah | Cole Ragans | 5 | NO | $136.00 | 7500¢ | 0.447 | — | 0.293 | -$40.53 | loss | `ORDER_USD_OVER_LIMIT` |
| 9362 | 2026-04-30 | isaiah | Bryce Elder | 6 | YES | $115.00 | 3500¢ | 0.581 | — | 0.231 | -$40.25 | loss | `ORDER_USD_OVER_LIMIT` |
| 3558 | 2026-04-22 | adam | Braxton Ashcraft | 8 | YES | $200.00 | 50¢ | 0.327 | — | 0.127 | -$40.00 | loss | `ORDER_USD_OVER_LIMIT` |
| 5450 | 2026-04-22 | isaiah | Tomoyuki Sugano | 4 | NO | $325.00 | 4700¢ | 0.406 | — | 0.114 | -$38.51 | loss | `ORDER_USD_OVER_LIMIT` |
| 9391 | 2026-04-30 | isaiah | Lance McCullers Jr. | 6 | YES | $120.00 | 3200¢ | 0.662 | — | 0.342 | -$38.40 | loss | `ORDER_USD_OVER_LIMIT` |
| 8877 | 2026-04-28 | isaiah | Payton Tolle | 7 | YES | $153.00 | 2300¢ | 0.553 | — | 0.323 | -$35.19 | loss | `ORDER_USD_OVER_LIMIT` |
| 6348 | 2026-04-23 | isaiah | Cristopher Sánchez | 8 | YES | $110.00 | 2000¢ | 0.444 | — | 0.244 | -$33.55 | loss | `ORDER_USD_OVER_LIMIT` |
| 3567 | 2026-04-22 | adam | Max Fried | 4 | NO | $136.00 | 50¢ | 0.656 | — | 0.104 | -$32.64 | loss | `ORDER_USD_OVER_LIMIT` |
| 5449 | 2026-04-22 | isaiah | Anthony Kay | 3 | YES | $197.00 | 5800¢ | 0.705 | — | 0.385 | -$31.05 | loss | `ORDER_USD_OVER_LIMIT` |
| 8881 | 2026-04-28 | isaiah | Kai-Wei Teng | 6 | YES | $198.00 | 1500¢ | 0.631 | — | 0.481 | -$29.70 | loss | `ORDER_USD_OVER_LIMIT` |
| 9173 | 2026-04-29 | isaiah | David Peterson | 7 | YES | $114.00 | 2500¢ | 0.511 | — | 0.261 | -$28.50 | loss | `ORDER_USD_OVER_LIMIT` |
| 3630 | 2026-04-22 | adam | Eric Lauer | 3 | NO | $172.00 | 50¢ | 0.719 | — | 0.121 | -$27.52 | loss | `ORDER_USD_OVER_LIMIT` |
| 6421 | 2026-04-23 | isaiah | Cristopher Sánchez | 6 | YES | $353.00 | 700¢ | 0.693 | — | 0.613 | -$24.72 | loss | `ORDER_USD_OVER_LIMIT` |
| 3571 | 2026-04-22 | adam | Max Fried | 3 | NO | $235.00 | 50¢ | 0.817 | — | 0.093 | -$21.15 | loss | `ORDER_USD_OVER_LIMIT` |
| 78 | 2026-04-21 | adam | Ryan Weiss | 6 | YES | $131.00 | 50¢ | 0.300 | — | 0.160 | -$18.34 | loss | `ORDER_USD_OVER_LIMIT` |
| 9299 | 2026-04-29 | isaiah | Michael Wacha | 6 | YES | $103.00 | 2600¢ | 0.556 | — | 0.296 | -$17.94 | loss | `ORDER_USD_OVER_LIMIT` |
| 161 | 2026-04-21 | adam | Landen Roupp | 8 | YES | $142.00 | 50¢ | 0.270 | — | 0.150 | -$17.04 | loss | `ORDER_USD_OVER_LIMIT` |
| 79 | 2026-04-21 | adam | Jesús Luzardo | 9 | YES | $103.00 | 50¢ | 0.286 | — | 0.136 | -$15.45 | loss | `ORDER_USD_OVER_LIMIT` |
| 9399 | 2026-04-30 | isaiah | Jeffrey Springs | 7 | YES | $103.00 | 1500¢ | 0.469 | — | 0.319 | -$15.45 | loss | `ORDER_USD_OVER_LIMIT` |
| 172 | 2026-04-21 | adam | Luis Castillo | 3 | NO | $202.00 | 50¢ | 0.806 | — | 0.124 | -$14.14 | loss | `ORDER_USD_OVER_LIMIT` |
| 87 | 2026-04-21 | adam | Ryan Weiss | 7 | YES | $218.00 | 50¢ | 0.175 | — | 0.115 | -$13.08 | loss | `ORDER_USD_OVER_LIMIT` |
| 110 | 2026-04-21 | adam | Keider Montero | 7 | YES | $108.00 | 50¢ | 0.234 | — | 0.114 | -$12.96 | loss | `ORDER_USD_OVER_LIMIT` |
| 7533 | 2026-04-26 | isaiah | Ryne Nelson | 6 | YES | $128.00 | 1000¢ | 0.328 | — | 0.228 | -$12.80 | loss | `ORDER_USD_OVER_LIMIT` |
| 117 | 2026-04-21 | adam | Parker Messick | 9 | YES | $177.00 | 50¢ | 0.179 | — | 0.109 | -$12.39 | loss | `ORDER_USD_OVER_LIMIT` |
| 189 | 2026-04-21 | adam | Carmen Mlodzinski | 7 | YES | $102.00 | 50¢ | 0.227 | — | 0.107 | -$12.24 | loss | `ORDER_USD_OVER_LIMIT` |
| 122 | 2026-04-21 | adam | Shota Imanaga | 10 | YES | $121.00 | 50¢ | 0.206 | — | 0.106 | -$12.10 | loss | `ORDER_USD_OVER_LIMIT` |
| 8900 | 2026-04-28 | isaiah | Walker Buehler | 5 | YES | $102.00 | 3200¢ | 0.467 | — | 0.147 | -$9.92 | loss | `ORDER_USD_OVER_LIMIT` |
| 201 | 2026-04-21 | adam | Parker Messick | 10 | YES | $304.00 | 50¢ | 0.110 | — | 0.080 | -$9.12 | loss | `ORDER_USD_OVER_LIMIT` |
| 114 | 2026-04-21 | adam | Keider Montero | 8 | YES | $145.00 | 50¢ | 0.136 | — | 0.076 | -$8.70 | loss | `ORDER_USD_OVER_LIMIT` |
| 95 | 2026-04-21 | adam | Jesús Luzardo | 11 | YES | $173.00 | 50¢ | 0.126 | — | 0.076 | -$8.65 | loss | `ORDER_USD_OVER_LIMIT` |
| 116 | 2026-04-21 | adam | Shota Imanaga | 11 | YES | $142.00 | 50¢ | 0.135 | — | 0.075 | -$8.52 | loss | `ORDER_USD_OVER_LIMIT` |
| 216 | 2026-04-21 | adam | Reynaldo López | 8 | YES | $120.00 | 50¢ | 0.123 | — | 0.063 | -$7.20 | loss | `ORDER_USD_OVER_LIMIT` |
| 217 | 2026-04-21 | adam | Chris Paddack | 8 | YES | $101.00 | 50¢ | 0.132 | — | 0.062 | -$7.07 | loss | `ORDER_USD_OVER_LIMIT` |
| 8874 | 2026-04-28 | isaiah | Nick Martinez | 5 | YES | $117.00 | 3100¢ | 0.477 | — | 0.167 | -$0.62 | loss | `ORDER_USD_OVER_LIMIT` |
| 8891 | 2026-04-28 | isaiah | Merrill Kelly | 6 | YES | $120.00 | 3400¢ | 0.532 | — | 0.192 | $0.00 | loss | `ORDER_USD_OVER_LIMIT` |
| 8894 | 2026-04-28 | isaiah | Kris Bubic | 8 | YES | $107.00 | 2200¢ | 0.569 | — | 0.349 | $0.00 | loss | `ORDER_USD_OVER_LIMIT` |
| 9424 | 2026-04-30 | isaiah | Bailey Ober | 6 | YES | $157.00 | 2100¢ | 0.524 | — | 0.314 | $0.00 | — | `ORDER_USD_OVER_LIMIT` |

---

## Config: `pregame-125`

*Pregame sweep: daily_loss=$400/account; max_order=$125 pregame.*

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

---

## Config: `pregame-150`

*Pregame sweep: daily_loss=$400/account; max_order=$150 pregame.*

### Reject reason breakdown

| reason | count | sum of blocked pnl | sum of blocked size | sample bet ids |
|---|---|---|---|---|
| `ORDER_USD_OVER_LIMIT` | 28 | -$723.15 | $7834.00 | 87, 95, 117, 172, 201 |

### Per-account

| account | total | accepted | rejected | sum blocked pnl |
|---|---|---|---|---|
| adam | 223 | 206 | 17 | -$283.17 |
| isaiah | 195 | 184 | 11 | -$439.98 |

### Per-day (where Gateway rejected ≥1 bet)

| date | total | rejected | sum blocked pnl |
|---|---|---|---|
| 2026-04-21 | 107 | 5 | -$57.38 |
| 2026-04-22 | 54 | 17 | -$466.48 |
| 2026-04-23 | 15 | 2 | -$85.12 |
| 2026-04-28 | 13 | 3 | -$114.17 |
| 2026-04-30 | 9 | 1 | $0.00 |

### Per-pitcher rollup (descending block count)

| pitcher | blocks | distinct dates | sum blocked pnl | reject reasons | sample bet ids |
|---|---|---|---|---|---|
| José Soriano | 4 | 1 | -$338.48 | ORDER_USD_OVER_LIMIT | 3486, 3490, 3488, 3489 |
| Parker Messick | 2 | 1 | -$21.51 | ORDER_USD_OVER_LIMIT | 117, 201 |
| Eric Lauer | 2 | 1 | -$93.82 | ORDER_USD_OVER_LIMIT | 3630, 3854 |
| Eduardo Rodriguez | 2 | 1 | -$129.17 | ORDER_USD_OVER_LIMIT | 5284, 5281 |
| Cristopher Sánchez | 2 | 1 | -$85.12 | ORDER_USD_OVER_LIMIT | 6355, 6421 |
| Ryan Weiss | 1 | 1 | -$13.08 | ORDER_USD_OVER_LIMIT | 87 |
| Jesús Luzardo | 1 | 1 | -$8.65 | ORDER_USD_OVER_LIMIT | 95 |
| Luis Castillo | 1 | 1 | -$14.14 | ORDER_USD_OVER_LIMIT | 172 |
| Peter Lambert | 1 | 1 | $215.36 | ORDER_USD_OVER_LIMIT | 3501 |
| Max Fried | 1 | 1 | -$21.15 | ORDER_USD_OVER_LIMIT | 3571 |
| Ranger Suarez | 1 | 1 | -$54.04 | ORDER_USD_OVER_LIMIT | 3494 |
| Braxton Ashcraft | 1 | 1 | -$40.00 | ORDER_USD_OVER_LIMIT | 3558 |
| Matthew Boyd | 1 | 1 | -$47.04 | ORDER_USD_OVER_LIMIT | 3679 |
| Connor Prielipp | 1 | 1 | $153.38 | ORDER_USD_OVER_LIMIT | 3714 |
| Tomoyuki Sugano | 1 | 1 | -$38.51 | ORDER_USD_OVER_LIMIT | 5450 |
| Anthony Kay | 1 | 1 | -$31.05 | ORDER_USD_OVER_LIMIT | 5449 |
| Shohei Ohtani | 1 | 1 | -$41.96 | ORDER_USD_OVER_LIMIT | 5448 |
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
| 5281 | 2026-04-22 | isaiah | Eduardo Rodriguez | 4 | NO | $575.00 | 2600¢ | 0.518 | — | 0.182 | -$81.77 | loss | `ORDER_USD_OVER_LIMIT` |
| 3854 | 2026-04-22 | adam | Eric Lauer | 5 | YES | $510.00 | 50¢ | 0.341 | — | 0.211 | -$66.30 | loss | `ORDER_USD_OVER_LIMIT` |
| 6355 | 2026-04-23 | isaiah | Cristopher Sánchez | 9 | YES | $199.00 | 1000¢ | 0.321 | — | 0.221 | -$60.40 | loss | `ORDER_USD_OVER_LIMIT` |
| 3494 | 2026-04-22 | adam | Ranger Suarez | 4 | NO | $193.00 | 50¢ | 0.548 | — | 0.172 | -$54.04 | loss | `ORDER_USD_OVER_LIMIT` |
| 3486 | 2026-04-22 | adam | José Soriano | 8 | YES | $238.00 | 50¢ | 0.429 | — | 0.219 | -$49.98 | loss | `ORDER_USD_OVER_LIMIT` |
| 8878 | 2026-04-28 | isaiah | Casey Mize | 6 | YES | $154.00 | 3200¢ | 0.503 | — | 0.183 | -$49.28 | loss | `ORDER_USD_OVER_LIMIT` |
| 5284 | 2026-04-22 | isaiah | Eduardo Rodriguez | 3 | NO | $353.00 | 1500¢ | 0.715 | — | 0.105 | -$47.40 | loss | `ORDER_USD_OVER_LIMIT` |
| 3679 | 2026-04-22 | adam | Matthew Boyd | 7 | YES | $196.00 | 50¢ | 0.390 | — | 0.150 | -$47.04 | loss | `ORDER_USD_OVER_LIMIT` |
| 3490 | 2026-04-22 | adam | José Soriano | 9 | YES | $355.00 | 50¢ | 0.307 | — | 0.187 | -$42.60 | loss | `ORDER_USD_OVER_LIMIT` |
| 5448 | 2026-04-22 | isaiah | Shohei Ohtani | 6 | NO | $299.00 | 2100¢ | 0.655 | — | 0.185 | -$41.96 | loss | `ORDER_USD_OVER_LIMIT` |
| 3558 | 2026-04-22 | adam | Braxton Ashcraft | 8 | YES | $200.00 | 50¢ | 0.327 | — | 0.127 | -$40.00 | loss | `ORDER_USD_OVER_LIMIT` |
| 5450 | 2026-04-22 | isaiah | Tomoyuki Sugano | 4 | NO | $325.00 | 4700¢ | 0.406 | — | 0.114 | -$38.51 | loss | `ORDER_USD_OVER_LIMIT` |
| 8877 | 2026-04-28 | isaiah | Payton Tolle | 7 | YES | $153.00 | 2300¢ | 0.553 | — | 0.323 | -$35.19 | loss | `ORDER_USD_OVER_LIMIT` |
| 5449 | 2026-04-22 | isaiah | Anthony Kay | 3 | YES | $197.00 | 5800¢ | 0.705 | — | 0.385 | -$31.05 | loss | `ORDER_USD_OVER_LIMIT` |
| 8881 | 2026-04-28 | isaiah | Kai-Wei Teng | 6 | YES | $198.00 | 1500¢ | 0.631 | — | 0.481 | -$29.70 | loss | `ORDER_USD_OVER_LIMIT` |
| 3630 | 2026-04-22 | adam | Eric Lauer | 3 | NO | $172.00 | 50¢ | 0.719 | — | 0.121 | -$27.52 | loss | `ORDER_USD_OVER_LIMIT` |
| 6421 | 2026-04-23 | isaiah | Cristopher Sánchez | 6 | YES | $353.00 | 700¢ | 0.693 | — | 0.613 | -$24.72 | loss | `ORDER_USD_OVER_LIMIT` |
| 3571 | 2026-04-22 | adam | Max Fried | 3 | NO | $235.00 | 50¢ | 0.817 | — | 0.093 | -$21.15 | loss | `ORDER_USD_OVER_LIMIT` |
| 172 | 2026-04-21 | adam | Luis Castillo | 3 | NO | $202.00 | 50¢ | 0.806 | — | 0.124 | -$14.14 | loss | `ORDER_USD_OVER_LIMIT` |
| 87 | 2026-04-21 | adam | Ryan Weiss | 7 | YES | $218.00 | 50¢ | 0.175 | — | 0.115 | -$13.08 | loss | `ORDER_USD_OVER_LIMIT` |
| 117 | 2026-04-21 | adam | Parker Messick | 9 | YES | $177.00 | 50¢ | 0.179 | — | 0.109 | -$12.39 | loss | `ORDER_USD_OVER_LIMIT` |
| 201 | 2026-04-21 | adam | Parker Messick | 10 | YES | $304.00 | 50¢ | 0.110 | — | 0.080 | -$9.12 | loss | `ORDER_USD_OVER_LIMIT` |
| 95 | 2026-04-21 | adam | Jesús Luzardo | 11 | YES | $173.00 | 50¢ | 0.126 | — | 0.076 | -$8.65 | loss | `ORDER_USD_OVER_LIMIT` |
| 9424 | 2026-04-30 | isaiah | Bailey Ober | 6 | YES | $157.00 | 2100¢ | 0.524 | — | 0.314 | $0.00 | — | `ORDER_USD_OVER_LIMIT` |

