# Oracle End-of-Day Eval — 2026-05-01

Generated: 2026-05-02T12:23:39.821Z
Records: 83 (52 pass, 8 size_down, 23 skip)
ks_bets joined: 16
Pitcher actuals available: 0
CLV snapshot: absent

## Q1–Q2: P&L and Win-Rate by Oracle Class

| class | n | settled | wins | losses | win_rate | production_pnl | oracle_pnl | Δ |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| pass | 52 | 0 | 0 | 0 | — | $0.00 | $0.00 | $0.00 |
| size_down | 8 | 0 | 0 | 0 | — | $0.00 | $0.00 | $0.00 |
| skip | 23 | 0 | 0 | 0 | — | $0.00 | $0.00 | $0.00 |
| ALL | 83 | 0 | 0 | 0 | — | $0.00 | $0.00 | $0.00 |

## Q3: Critic Effectiveness (per verdict)

| verdict | n | settled | win_rate of underlying pick | applied | reason_text sample |
|---|---:|---:|---:|---|---|
| proceed | 40 | 0 | — | no_change |  |
| none | 24 | 0 | — | — |  |
| skip | 17 | 0 | — | skip_redundant+skip |  |
| concern | 2 | 0 | — | concern_downgrade |  |

## Q4: Per-bucket breakdown (feasibility × trust_level)

| bucket | n | pass | sd | skip | settled | win_rate | Δ pnl |
|---|---:|---:|---:|---:|---:|---:|---:|
| — × — | 24 | 24 | 0 | 0 | 0 | — | $0.00 |
| dead × low | 19 | 0 | 0 | 19 | 0 | — | $0.00 |
| viable × high | 16 | 14 | 0 | 2 | 0 | — | $0.00 |
| strong × high | 12 | 10 | 0 | 2 | 0 | — | $0.00 |
| fragile × low | 6 | 0 | 6 | 0 | 0 | — | $0.00 |
| viable × medium | 5 | 4 | 1 | 0 | 0 | — | $0.00 |
| strong × medium | 1 | 0 | 1 | 0 | 0 | — | $0.00 |

## Q5: CLV (Closing Line Value) on skipped bets

_(No CLV snapshot — run scripts/live/captureClosingLines.js at slate close.)_

## Q6: Edge cases

- Fail-opens / errors: **24**
  - Joel Embiid 2NO: no_decision_pipeline_json
  - Jamal Murray 3NO: no_decision_pipeline_json
  - Derrick White 3NO: no_decision_pipeline_json
  - Nikola Jokić 2NO: no_decision_pipeline_json
  - Mikal Bridges 2NO: no_decision_pipeline_json
  - Derrick White 4NO: no_decision_pipeline_json
  - Nikola Jokić 3NO: no_decision_pipeline_json
  - Nikola Vučević 1YES: no_decision_pipeline_json
  - Josh Hart 3NO: no_decision_pipeline_json
  - Jaylen Brown 2YES: no_decision_pipeline_json
- Slow calls (>2s): **1**

## Q7: Latency / cost

- p50: 105ms · p90: 1186ms · p99: 2578ms

---

Per-row CSV: `oracle-eval-2026-05-01.csv`
