# The Oracle

> *The system that judges every bet.*
> *Math defends. AI prosecutes. Deterministic rules adjudicate.*
> *Replaces the patchwork of gates and kill switches that failed the night of 2026-04-29.*

---

## Architecture at a glance

```
                        ┌──────────────────┐
                        │   Layer 0: Trace  │  ← foundation; everything writes here
                        │  (audit + shadow) │
                        └────────┬──────────┘
                                 │  (all layers below write to Trace)
            ┌────────────────────┼────────────────────────┐
            │                    │                        │
            │   Decision Stack (bet flows top to bottom)  │
            │                                             │
            │   1. Math       ─→  prices, computes edge   │
            │   2. Path       ─→  feasibility check       │
            │   3. Trust      ─→  data-quality + sizing   │
            │   4. Critic     ─→  AI review (gray-zone)   │
            │   5. Judge      ─→  final action            │
            │   6. Gateway    ─→  execution safety floor  │
            │                                             │
            └────────────────────┼────────────────────────┘
                                 │
                        ┌────────▼──────────┐
                        │   Kalshi orders   │
                        └───────────────────┘

       Infrastructure (no decision authority):
         • Signals       — outside data ingestion
         • Calibration   — meta-layer adjusting thresholds
```

---

## Layer index

Click each for the full spec.

| # | Layer | Type | Status |
|---|---|---|---|
| 0 | [Trace](./layers/0-trace/spec.md) | Foundation | 📝 Drafted |
| 1 | [Math](./layers/1-math/spec.md) | Decision (deterministic) | ⏳ Pending |
| 2 | [Path](./layers/2-path/spec.md) | Decision (deterministic) | ⏳ Pending |
| 3 | [Trust](./layers/3-trust/spec.md) | Decision (deterministic) | ⏳ Pending |
| 4 | [Critic](./layers/4-critic/spec.md) | Decision (AI, gray-zone only) | ⏳ Pending |
| 5 | [Judge](./layers/5-judge/spec.md) | Decision (deterministic) | ⏳ Pending |
| 6 | [Gateway](./layers/6-gateway/spec.md) | Execution safety | ⏳ Pending |
| - | [Signals](./infrastructure/signals/spec.md) | Infrastructure | ⏳ Pending |
| - | [Calibration](./infrastructure/calibration/spec.md) | Infrastructure | ⏳ Pending |

---

## Project-wide rules

These apply to every layer. Non-negotiable.

1. **Max think for planning, careful execution.** Spec → discuss → lock → code → test → next.
2. **Quality over speed.** No layer ships without spec + code + fixtures + health probe + Trace integration.
3. **Easy diagnosis.** Cause findable in <5 min by reading Trace. No silent failures. No `.catch(() => null)`.
4. **Tiered observability:**
   - sub-second: in-process exception → fail-closed → Trace logged
   - seconds: Discord webhook (Adam-only) on any layer failure
   - <1 min: dashboard updates with red status
   - <5 min: Sentinel cron catches missing heartbeats
5. **Fail-closed everywhere.** Uncertainty = don't trade.
6. **DB is single source of truth for safety state.** Kill switches, halt flags, exposure caps in DB only. Gateway enforces.
7. **Test against code as we build.** No separate scenario validator phase.
8. **Discord-only-to-Adam alerts on any failure.** Dedicated webhook (URL TBD).

---

## Deployment modes

Every layer must support both:

| Mode | Behavior |
|---|---|
| **Production** | Layer's verdict gates real action (bet placed or skipped) |
| **Shadow** | Layer runs all logic, writes verdict to Trace, but does NOT influence execution |

**v1 ships in shadow mode, pre-game only.** Oracle observes the same inputs as the current system, logs verdicts, accumulates evidence. No real money on Oracle's verdicts until shadow data shows it's at least as good as current.

---

## Locked decisions (see [NEW_ENGINE_DESIGN.md](../NEW_ENGINE_DESIGN.md))

- 12-field spec template
- Trust → Critic gating numbers
- Hybrid test fixtures (synthetic + real-history regression)
- Output schema requires `layerVersion` + `commitHash`
- Build order: Trace → Gateway → Math → Path → Trust → Critic → Judge

---

*Last updated: 2026-04-30*
