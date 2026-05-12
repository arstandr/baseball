# Layer 2 (Path) Backtest — 2026-05-01

**STATUS:** PRELIMINARY — Layer 2 was just built; this is the first replay.
**Window:** 2026-03-02 → 2026-05-01

## Sample

| Metric | Value |
|---|---:|
| Settled placed pre-game bets in window | 622 |
| Replayable through Layer 2 (with decision_pipeline JSON) | 314 |
| Skipped (no decision_pipeline) | 308 |
| Skipped (parse / replay failure) | 0 |
| Total baseline P&L | $-628.37 |
| Total baseline size | $14311.00 |

> Reconstruction caveat: Layer 1 envelopes are synthesized from
> decision_pipeline.lambda_calc_json + model_input_json. Today's
> pitcher_statcast is used for r (archetypeR). This may diverge
> from production-time r if the pitcher pitched after bet_date.
> Layer 2 verdicts are based on production-logged inner math.

## Distribution by feasibility class

| class | n | wins | losses | voids | win_rate | total_pnl | avg_pnl | sum_size | roi_on_size |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| strong | 128 | 52 | 40 | 36 | 56.5% | $-9.73 | $-0.08 | $3782.00 | -0.26% |
| viable | 81 | 23 | 57 | 1 | 28.7% | $-250.49 | $-3.09 | $4596.00 | -5.45% |
| fragile | 18 | 4 | 14 | 0 | 22.2% | $-220.65 | $-12.26 | $1143.00 | -19.30% |
| dead | 87 | 18 | 65 | 4 | 21.7% | $-147.50 | $-1.70 | $4790.00 | -3.08% |

## Counterfactual P&L under feasibility filters

| filter | bets fired | bets skipped | counterfactual P&L | Δ vs baseline | skipped P&L (forgone or saved) |
|---|---:|---:|---:|---:|---:|
| baseline (production) | 314 | 0 | $-628.37 | — | — |
| skip_dead | 227 | 87 | $-480.87 | +$147.50 | $-147.50 |
| skip_dead+fragile | 209 | 105 | $-260.22 | +$368.15 | $-368.15 |
| skip_dead+halfsize_fragile | 227 | 87 | $-370.54 | +$257.82 | $-257.83 |

> "skipped P&L" = sum of pnl on the bets we would NOT have placed.
> Negative skipped P&L = filter would have SAVED that money (skipped losing bets).
> Positive skipped P&L = filter would have FORGONE that money (skipped winning bets).

## By side

| side | n | wins | losses | win_rate | total_pnl |
|---|---:|---:|---:|---:|---:|
| NO | 90 | 32 | 25 | 56.1% | $-298.33 |
| YES | 224 | 65 | 151 | 30.1% | $-330.04 |

## By strike bucket

| strike bucket | n | wins | losses | win_rate | total_pnl |
|---|---:|---:|---:|---:|---:|
| 3-4 | 37 | 13 | 17 | 43.3% | $-83.21 |
| 5-6 | 172 | 62 | 88 | 41.3% | $-132.18 |
| 7-8 | 97 | 22 | 65 | 25.3% | $-312.46 |
| 9+ | 8 | 0 | 6 | 0.0% | $-100.52 |

## By bf_source_tier

| tier | n | wins | losses | win_rate | total_pnl |
|---|---:|---:|---:|---:|---:|
| medium | 12 | 2 | 10 | 16.7% | $-118.03 |
| strong | 290 | 93 | 156 | 37.3% | $-313.01 |
| weak | 12 | 2 | 10 | 16.7% | $-197.33 |

## By account

| user_id | n | wins | losses | total_pnl |
|---|---:|---:|---:|---:|
| 2 | 163 | 53 | 94 | $-423.09 |
| 284 | 151 | 44 | 82 | $-205.28 |

## Reason-code distribution (top 15)

| reason_code | n | wins | losses | win_rate | total_pnl |
|---|---:|---:|---:|---:|---:|
| workload_ceiling | 78 | 16 | 58 | 21.6% | $-69.79 |
| normal_path | 67 | 16 | 50 | 24.2% | $-134.33 |
| comfortable_buffer | 55 | 29 | 23 | 55.8% | $229.65 |
| no_path_ample_cushion | 42 | 15 | 6 | 71.4% | $15.12 |
| leash_supports_no | 22 | 6 | 11 | 35.3% | $-147.36 |
| workload_ceiling_supports_no | 17 | 7 | 3 | 70.0% | $-142.90 |
| bf_gap_fragile | 12 | 2 | 10 | 16.7% | $-131.38 |
| bf_source_weak_cap | 8 | 2 | 6 | 25.0% | $-141.00 |
| no_path_overrun | 7 | 2 | 5 | 28.6% | $-37.46 |
| no_path_thin | 2 | 2 | 0 | 100.0% | $14.27 |
| pk_extreme_fragile | 2 | 0 | 2 | 0.0% | $-42.94 |
| pk_extreme_dead | 2 | 0 | 2 | 0.0% | $-40.25 |

## Notable outliers

### Bets classified DEAD that actually WON (n=18)
If non-zero, these are bets Layer 2 would have skipped but were profitable.

| date | pitcher | strike-side | actual_ks | pnl | reason_code |
|---|---|---|---:|---:|---|
| 2026-04-25 | Jack Flaherty | 6NO | 4 | $7.88 | no_path_overrun |
| 2026-04-25 | Jack Flaherty | 6NO | 4 | $2.46 | no_path_overrun |
| 2026-04-26 | Keider Montero | 5YES | 5 | $38.67 | workload_ceiling |
| 2026-04-26 | Keider Montero | 5YES | 5 | $13.56 | workload_ceiling |
| 2026-04-26 | Slade Cecconi | 5YES | 5 | $27.48 | workload_ceiling |
| 2026-04-26 | Slade Cecconi | 5YES | 5 | $9.16 | workload_ceiling |
| 2026-04-26 | Spencer Arrighetti | 8YES | 8 | $76.08 | workload_ceiling |
| 2026-04-26 | Spencer Arrighetti | 8YES | 8 | $26.37 | workload_ceiling |
| 2026-04-26 | Justin Wrobleski | 5YES | 5 | $51.56 | workload_ceiling |
| 2026-04-26 | Justin Wrobleski | 5YES | 6 | $0.00 | workload_ceiling |
| 2026-04-27 | Jack Kochanowicz | 5YES | 5 | $50.40 | workload_ceiling |
| 2026-04-28 | Chad Patrick | 5YES | 5 | $9.23 | workload_ceiling |
| 2026-04-29 | Taj Bradley | 7YES | 7 | $14.30 | workload_ceiling |
| 2026-04-29 | Nathan Eovaldi | 7YES | 7 | $10.20 | workload_ceiling |
| 2026-04-29 | Nathan Eovaldi | 7YES | 4 | $0.00 | workload_ceiling |
| 2026-04-29 | Andre Pallante | 6YES | 6 | $54.41 | workload_ceiling |
| 2026-04-29 | Andre Pallante | 6YES | 6 | $80.52 | workload_ceiling |
| 2026-04-29 | Luis Severino | 7YES | 7 | $54.14 | workload_ceiling |

### Bets classified STRONG that LOST (n=40)
If non-zero, these are bets Layer 2 was confident on but lost.

| date | pitcher | strike-side | actual_ks | pnl | reason_code |
|---|---|---|---:|---:|---|
| 2026-04-24 | Paul Skenes | 6NO | 6 | $-11.78 | leash_supports_no |
| 2026-04-24 | Gavin Williams | 6YES | 4 | $-6.41 | comfortable_buffer |
| 2026-04-24 | Freddy Peralta | 8NO | 8 | $-4.69 | no_path_ample_cushion |
| 2026-04-24 | Gavin Williams | 6YES | 4 | $-5.49 | comfortable_buffer |
| 2026-04-24 | Freddy Peralta | 8NO | 8 | $-4.02 | no_path_ample_cushion |
| 2026-04-25 | Cole Ragans | 7NO | 7 | $-16.88 | leash_supports_no |
| 2026-04-25 | Garrett Crochet | 7NO | 7 | $-167.51 | workload_ceiling_supports_no |
| 2026-04-25 | Ryan Weathers | 6YES | 4 | $-8.24 | comfortable_buffer |
| 2026-04-25 | Mitch Keller | 5NO | 5 | $-9.86 | leash_supports_no |
| 2026-04-25 | Cole Ragans | 7NO | 7 | $-5.28 | leash_supports_no |
| 2026-04-25 | Garrett Crochet | 7NO | 7 | $-4.09 | workload_ceiling_supports_no |
| 2026-04-25 | Ryan Weathers | 6YES | 4 | $-2.75 | comfortable_buffer |
| 2026-04-25 | Mitch Keller | 5NO | 5 | $-3.29 | leash_supports_no |
| 2026-04-25 | Cole Ragans | 6NO | 6 | $-39.71 | leash_supports_no |
| 2026-04-25 | Cole Ragans | 8NO | 9 | $-25.99 | no_path_ample_cushion |
| 2026-04-25 | Cole Ragans | 6NO | 6 | $-20.50 | leash_supports_no |
| 2026-04-25 | Cole Ragans | 8NO | 9 | $-13.30 | no_path_ample_cushion |
| 2026-04-26 | Kumar Rocker | 5YES | 3 | $-11.04 | comfortable_buffer |
| 2026-04-26 | Kumar Rocker | 5YES | 3 | $-3.68 | comfortable_buffer |
| 2026-04-26 | Kyle Harrison | 6NO | 6 | $-34.02 | leash_supports_no |

### Bets classified FRAGILE that won (n=4)
