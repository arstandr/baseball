# Oracle Sensitivity Grid — 2026-05-01

Window: 2026-04-24 → 2026-05-01
Sample: 50 bets × 11 price offsets (±5¢ in 1¢ steps)
Selection: stratified by production edge bucket (near_threshold / medium / comfortable / large)

## Verdict

**GATE IS ROBUST**

45 of 50 (90%) bets are stable across the full ±5¢ window. Most flips are around the size_down boundary, not fire/skip.

## Brittleness distribution

| class | count | % | meaning |
|---|---:|---:|---|
| stable | 45 | 90% | no flip in ±5¢ — gate stays on same decision regardless of price jiggle |
| 1c_brittle | 1 | 2% | flips on a 1¢ move — knife-edge, fragile |
| 2c_brittle | 1 | 2% | flips on a 2¢ move — borderline |
| 3to5c_sensitive | 3 | 6% | flips somewhere in 3-5¢ range — acceptable sensitivity |

## Transition types — ALL flips observed across the grid

| transition | count |
|---|---:|
| skip→fire | 9 |
| fire→skip | 6 |

## Knife-edge analysis — closest-flip transitions on 1¢/2¢ brittle bets

| brittleness | transition | count |
|---|---|---:|
| 1c_brittle | skip→fire | 1 |
| 2c_brittle | skip→fire | 1 |

Most dangerous: `fire ↔ skip` flips on 1¢ moves. Currently observed: 1.
Less dangerous: any flip involving `size_down` (half-size cushion).

## Per-bet brittleness

| bet_date | pitcher | strike-side | bucket | feasibility | trust | critic | baseline | min_flip(¢) | class | flips |
|---|---|---|---|---|---|---|---|---:|---|---|
| 2026-04-24 | Gavin Williams | 8YES | near_threshold | dead | low | proceed | skip | — | stable | — |
| 2026-04-24 | Max Scherzer | 5NO | near_threshold | strong | high | proceed | fire | — | stable | — |
| 2026-04-24 | Brayan Bello | 6NO | near_threshold | strong | high | proceed | fire | — | stable | — |
| 2026-04-24 | Framber Valdez | 8NO | near_threshold | strong | high | proceed | fire | — | stable | — |
| 2026-04-24 | Grant Holmes | 5NO | near_threshold | strong | high | proceed | skip | — | stable | — |
| 2026-04-24 | Drew Rasmussen | 7YES | near_threshold | dead | low | skip | skip | — | stable | — |
| 2026-04-24 | Noah Cameron | 6NO | near_threshold | strong | high | proceed | fire | — | stable | — |
| 2026-04-25 | Jack Flaherty | 6NO | near_threshold | dead | low | skip | skip | — | stable | — |
| 2026-04-26 | Kyle Harrison | 6NO | near_threshold | strong | high | proceed | skip | — | stable | — |
| 2026-04-26 | Kyle Bradish | 7YES | near_threshold | viable | high | skip | skip | — | stable | — |
| 2026-04-26 | Aaron Nola | 4YES | near_threshold | strong | high | proceed | fire | — | stable | — |
| 2026-04-27 | Anthony Kay | 4YES | near_threshold | strong | high | proceed | skip | 1 | 1c_brittle | -1:skip→fire / -2:skip→fire / -3:skip→fire |
| 2026-04-27 | Max Fried | 6YES | near_threshold | viable | high | proceed | fire | 3 | 3to5c_sensitive | +3:fire→skip / +4:fire→skip / +5:fire→skip |
| 2026-04-24 | Paul Skenes | 7NO | medium | strong | high | proceed | fire | — | stable | — |
| 2026-04-24 | Brandon Woodruff | 8NO | medium | strong | high | proceed | fire | — | stable | — |
| 2026-04-24 | Paul Skenes | 8NO | medium | strong | high | proceed | fire | — | stable | — |
| 2026-04-25 | Garrett Crochet | 7NO | medium | strong | high | proceed | skip | — | stable | — |
| 2026-04-25 | Germán Márquez | 4YES | medium | viable | medium | proceed | fire | — | stable | — |
| 2026-04-25 | Mitch Keller | 5NO | medium | strong | high | proceed | skip | 2 | 2c_brittle | -2:skip→fire / -3:skip→fire / -4:skip→fire |
| 2026-04-26 | Aaron Nola | 5YES | medium | strong | high | proceed | fire | 5 | 3to5c_sensitive | +5:fire→skip |
| 2026-04-26 | Slade Cecconi | 6YES | medium | dead | low | proceed | skip | — | stable | — |
| 2026-04-26 | Carmen Mlodzinski | 6YES | medium | viable | medium | concern | size_down | — | stable | — |
| 2026-04-27 | Parker Messick | 6YES | medium | strong | high | proceed | fire | — | stable | — |
| 2026-04-27 | Jack Kochanowicz | 3YES | medium | strong | high | proceed | fire | 4 | 3to5c_sensitive | +4:fire→skip / +5:fire→skip |
| 2026-04-28 | Casey Mize | 6YES | medium | viable | high | proceed | fire | — | stable | — |
| 2026-04-29 | Drew Rasmussen | 5YES | medium | strong | high | proceed | fire | — | stable | — |
| 2026-04-24 | Paul Skenes | 6NO | comfortable | strong | high | proceed | skip | — | stable | — |
| 2026-04-25 | Jeffrey Springs | 6YES | comfortable | viable | high | proceed | fire | — | stable | — |
| 2026-04-25 | Walbert Urena | 4YES | comfortable | viable | low | proceed | size_down | — | stable | — |
| 2026-04-25 | Cole Ragans | 5NO | comfortable | fragile | medium | proceed | skip | — | stable | — |
| 2026-04-26 | Spencer Arrighetti | 7YES | comfortable | viable | medium | proceed | fire | — | stable | — |
| 2026-04-26 | Ryne Nelson | 5YES | comfortable | dead | low | proceed | skip | — | stable | — |
| 2026-04-26 | Max Meyer | 7YES | comfortable | dead | low | proceed | skip | — | stable | — |
| 2026-04-27 | Jack Kochanowicz | 5YES | comfortable | dead | low | proceed | skip | — | stable | — |
| 2026-04-27 | Dylan Cease | 8YES | comfortable | strong | high | proceed | fire | — | stable | — |
| 2026-04-28 | Kris Bubic | 8YES | comfortable | dead | low | proceed | skip | — | stable | — |
| 2026-04-29 | David Peterson | 7YES | comfortable | fragile | low | proceed | size_down | — | stable | — |
| 2026-04-29 | Luis Severino | 7YES | comfortable | dead | low | proceed | skip | — | stable | — |
| 2026-04-30 | Chris Bassitt | 5NO | comfortable | strong | high | proceed | fire | — | stable | — |
| 2026-04-25 | Jeffrey Springs | 8YES | large | dead | low | proceed | skip | — | stable | — |
| 2026-04-25 | Jeffrey Springs | 8YES | large | dead | low | proceed | skip | — | stable | — |
| 2026-04-26 | Michael King | 5YES | large | strong | high | proceed | fire | — | stable | — |
| 2026-04-26 | Michael King | 6YES | large | viable | high | proceed | fire | — | stable | — |
| 2026-04-26 | Michael King | 5YES | large | strong | high | proceed | fire | — | stable | — |
| 2026-04-26 | Michael King | 6YES | large | viable | high | proceed | fire | — | stable | — |
| 2026-04-27 | Dylan Cease | 10YES | large | dead | low | proceed | skip | — | stable | — |
| 2026-04-27 | Dylan Cease | 10YES | large | dead | low | proceed | skip | — | stable | — |
| 2026-04-28 | Kai-Wei Teng | 4YES | large | viable | low | proceed | size_down | — | stable | — |
| 2026-04-28 | Kai-Wei Teng | 6YES | large | viable | low | proceed | size_down | — | stable | — |
| 2026-04-28 | Kai-Wei Teng | 4YES | large | viable | low | proceed | size_down | — | stable | — |

## 1¢ knife-edge bets (full grid)

### 2026-04-27 Anthony Kay K4 YES

baseline market_mid: 57.5¢ → decision=skip

| offset | mid_cents | decision | reason | edge |
|---:|---:|---|---|---:|
| -5¢ | 52.5 | fire | fire | 16.8¢ |
| -4¢ | 53.5 | fire | fire | 15.8¢ |
| -3¢ | 54.5 | fire | fire | 14.8¢ |
| -2¢ | 55.5 | fire | fire | 13.8¢ |
| -1¢ | 56.5 | fire | fire | 12.8¢ |
| +0¢ | 57.5 | skip | insufficient_edge | 11.8¢ |
| +1¢ | 58.5 | skip | insufficient_edge | 10.8¢ |
| +2¢ | 59.5 | skip | insufficient_edge | 9.8¢ |
| +3¢ | 60.5 | skip | insufficient_edge | 8.8¢ |
| +4¢ | 61.5 | skip | insufficient_edge | 7.8¢ |
| +5¢ | 62.5 | skip | insufficient_edge | 6.8¢ |

## Method

- For each bet: run L1→L2→L3 once (deterministic, market_mid-independent).
- Critic call once per bet (cache key independent of market_mid).
- Judge re-runs per offset with adjusted market_mid; verdict can flip.
- Brittleness = min |offset| where Judge's decision differs from baseline (offset=0).

## Caveats

1. Edge threshold = max(SIDE_MIN_EDGE=0.12, spread/2 + 0.04). Most flips occur at the 12¢ floor.
2. Sample stratified by production edge bucket — over-represents near-threshold cases by design (those are most likely to flip).
3. Critic verdict held constant per bet (cache); we're measuring Judge sensitivity to edge, not Critic sensitivity to news.
4. Production market_mid stored as integer cents in ks_bets; we vary in 1¢ steps (matches Kalshi tick size).
