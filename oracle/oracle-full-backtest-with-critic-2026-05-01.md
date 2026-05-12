# Full Oracle Pipeline + Critic Backtest — 2026-05-01

**Pipeline:** L1 Math → L2 Path → L3 Trust → L4 Critic (real Haiku 4.5) → L5 Judge v0.2

Window: 2026-03-02 → 2026-05-01
Bankroll: $1000

## Sample

| Metric | Value |
|---|---:|
| Settled placed pre-game bets in window | 622 |
| Replayable through full pipeline | 312 |
| Skipped (no decision_pipeline) | 308 |
| Skipped (cost cap reached) | 0 |

## Cost

| Metric | Value |
|---|---:|
| Total Critic cost | $0.0197 |
| Total API calls | 83 |
| Avg cost per call | $0.00024 |
| Cost cap | $2.00 |

## Headline P&L

| Strategy | P&L | Δ vs production |
|---|---:|---:|
| Production (baseline) | $-617.03 | — |
| Oracle (L1-L3-L5, no Critic) — fixed-size | $62.03 | $679.05 |
| **Oracle FULL (L1-L4-L5 with Critic) — fixed-size** | **$197.31** | **$814.34** |

## Critic verdict distribution

| verdict | n |
|---|---:|
| skip | 50 |
| concern | 12 |
| proceed | 250 |
| boost | 0 |
| unavailable | 0 |

## Decision distribution (Oracle vs Critic-on)

| decision | no Critic | with Critic | Δ |
|---|---:|---:|---:|
| fire | 170 | 153 | -17 |
| size_down | 24 | 34 | +10 |
| skip | 118 | 125 | +7 |

## Critic effect on Oracle decisions

- Total bets where Critic changed Oracle decision: **17** of 312
- Forced fire/size_down → skip:  7
- Downgraded fire → size_down:    10
- Upgraded size_down → fire:      0

## ROI by Critic verdict (with-Critic chain, fixed-size)

| verdict | n | wins | losses | win_rate | Oracle pnl | production pnl |
|---|---:|---:|---:|---:|---:|---:|
| skip | 50 | 13 | 36 | 26.5% | $0.00 | $-97.91 |
| concern | 12 | 0 | 12 | 0.0% | $-84.74 | $-183.36 |
| proceed | 250 | 84 | 126 | 40.0% | $282.06 | $-335.76 |
| boost | 0 | 0 | 0 | — | $0.00 | $0.00 |

## Notable Critic effects

### Critic forced SKIP on bets Oracle would have fired/size_downed (n=7)
Were these wins or losses?
- wins: 0 (loss avoided ≠ ✓ — these were forgone wins)
- losses: 7 (loss avoided = ✓ Critic helped)
- production pnl on these bets: $-50.54 (Critic skipping all of them removes this from Oracle)

### Critic upgraded size_down → fire (n=0)
- wins: 0
- losses: 0

### Critic downgraded fire → size_down (n=10)
- wins: 0
- losses: 10

## Caveats

1. preflight_json from production is what production saw at decision time
   (headlines + summary). NOT full live news; production may have used
   richer context that wasn't persisted.
2. Today's pitcher_statcast used for r — drift caveat carries over.
3. Synthetic Layer 1 envelope hashes are not validated against true
   production envelopes (Layer 1 wasn't running in production).
4. Sample is small; one weather window is not enough to ship.
5. Cost cap at $2 per run; if exceeded, remaining bets get verdict=proceed.
