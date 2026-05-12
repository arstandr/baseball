# The Oracle — Money Tree 2.0 Decision Engine

**Status:** Planning phase. No code being written until layer specs are agreed.
**Started:** 2026-04-29
**Named:** 2026-04-30
**Owner:** Adam (final call) + Claude (planning + implementation)

---

> *The Oracle:* the system that judges every bet. Math defends, AI prosecutes,
> deterministic rules adjudicate. Replaces the patchwork of gates and kill
> switches that failed the night of 2026-04-29.

---

## Why we're rebuilding

The current system is a logic-first Bayesian model + Kelly sizing with a generic news preflight. It works, but barely:

| | Last 7 days |
|---|---|
| Pre-game `normal` mode | +1.2% ROI ($62 on $5,146 risk) |
| Live `high-conviction` | -102.5% ROI ($-1,385 on $1,352 risk) |
| Live `pulled` (free money) | -72% ROI ($-766 on $1,064 risk) |
| Total | ~$-1,900 net for the week |

What's structurally wrong:

1. **Math is over-confident at high probabilities.** 90%+ buckets win 33% in reality. 60-70% buckets win 0% (4-bet sample).
2. **No pull-probability in the model.** Math computes `P(K | faces N batters)` correctly but doesn't model `P(faces N batters)`. Most live losses trace to pitchers being pulled before reaching the K threshold.
3. **AI layer (preflight) is asking the wrong question.** Currently scans for "red flags" with binary skip/proceed. Defaults to proceed on absence of flags. Sonnet's own reasoning text is predictive (the `low_conf_flags_dismissed` pattern was -58% ROI vs `fresh_bullpen_neutral` at +130%) but we're not extracting that signal.
4. **Kill-switches live in client code.** When Closer (Windows agent) ran stale code yesterday, `trading_halted=1` and `DISABLED_LIVE_MODES` env var did nothing — Closer's binary didn't have those checks. Bets fired anyway.
5. **No counterfactual ledger.** We track P&L of fired bets but not "what would the bets we skipped have done?" Without that data, we can't tell if any new gate is helping or hurting.
6. **Layers fail silently.** `db.one(...).catch(() => null)` patterns mean a DB hiccup makes a halt check evaluate as "not halted." We've seen this happen.

The new engine addresses all six.

---

## Project-wide quality rules (apply to ALL phases of this build)

These are non-negotiable. Every layer, every spec, every implementation decision must satisfy them.

1. **Max think for planning, careful execution.** Spend the time on design BEFORE writing code. Every spec is reviewed and agreed before implementation.

2. **Quality over speed.** No layer ships without spec + code + fixtures + health probe + Trace integration. No "we'll add tests later."

3. **Easy diagnosis.** When something breaks, the cause must be findable in <5 minutes by reading Trace. No silent failures, no `.catch(() => null)`, no behavior that isn't logged.

4. **Instant observability with tiered alerting.** Every layer must support all four tiers:
   - **Sub-second**: in-process exception → fail-closed → Trace logged
   - **Seconds**: Discord webhook (Adam-only channel) on any layer failure
   - **<1 min**: dashboard updates with red status
   - **<5 min**: Sentinel cron catches missing heartbeats

   5 minutes is the slowest acceptable detection time. Anything longer is a bug in the layer's observability.

5. **Fail-closed everywhere.** Any uncertainty about state defaults to NOT trading. Lost edge from being conservative is recoverable; lost capital from firing on bad state is not.

6. **DB is the single source of truth for safety state.** Kill switches, halt flags, exposure caps live in DB. Never in env vars (env vars don't propagate to all clients). Gateway enforces.

7. **Test against code as we build.** No separate "scenario validator" phase. Each layer ships with fixtures that are actual unit tests. After Layer 0 (Trace) is built, every subsequent layer's tests run end-to-end against real Trace.

8. **Discord-only-to-Adam alerts on any failure.** A dedicated webhook just for Oracle health alerts. Not the team channel — separate. Configured per-layer in spec.

---

## Locked decisions (2026-04-30)

- **Kill switch storage:** DB-only, Gateway-enforced, fail-closed on read failure
- **Output schema:** Every layer output includes `layerVersion` (semantic) + `commitHash` (auto from build)
- **Spec location:** `oracle/layers/N-name/spec.md` (directory per layer; code, fixtures, probes co-located there)
- **Template:** 12 fields per spec (1. Purpose, 2. Inputs, 3. Outputs, 4. Failure modes, 5. Test fixtures, 6. Health probe, 7. Performance budget, 8. Kill switch, 9. Drift detector, 10. Success metric / SLO, 11. Rollback plan, 12. Dependencies)
- **Pre-filled drafts:** Each spec.md starts as my proposal; reviewed and edited together during each layer's discussion
- **Discussion order:** Option A (Foundation first). Build order: Layer 0 (Trace) → Layer 6 (Gateway in shadow mode) → Layers 1-5.
- **Build approach:** Spec → discuss → lock → code → test → next layer. No layer ships without spec agreement first. NOT auto-rolling through layers.
- **v1 deployment mode:** Shadow only, pre-game only. Oracle observes same inputs as current system, logs verdicts to shadow ledger, no Kalshi orders. Live remains disabled via existing DISABLED_LIVE_MODES.
- **Trust → Critic gating (locked numbers):**
  - `trust ≥ 80 AND bet_size ≤ $25` → skip Critic
  - `trust ≥ 80 AND bet_size > $25` → skip Critic UNLESS hard-risk flag OR high-threshold YES
  - `trust 50-79 AND bet_size > $50` → run Critic
  - `trust 50-79 AND bet_size ≤ $50` → skip Critic UNLESS edge ≥ 20¢ or high-risk flag
  - `trust < 50 AND edge ≥ 20¢` → run Critic only if otherwise eligible
  - `trust < 50 AND edge < 20¢` → skip bet, no Critic
  - **Mandatory Critic rule:** any YES at strike ≥ 8 with bet_size > $25 → run Critic UNLESS trust ≥ 90
- **Test fixtures (hybrid):**
  - Synthetic primary: deterministic, version-pinned, define intended behavior per layer
  - Real-history regression: actual past bets in named groups (Cease 8+/9+, Tolle rookie, Davis Martin good win, King good win, pulled cases, dead-path NO cases)
- **Closer credentials:** Currently restored. Will be revoked again (via Kalshi key rotation) before Gateway is wired to production. Until then, accept Closer-bypass risk during build phase.

---

## Adam's four design constraints

These shape every decision in the build.

### 1. A/B/C testability against current AND old systems

Decision logic must be separated from execution. Three system implementations (`currentSystem`, `oldSystem`, `newSystem`) all run on the same input; only ONE executes; the others log to a shadow ledger with their verdicts.

This is the **strategy pattern**. Implication: every layer must be deterministic given its inputs (no "the system was set up this way on Tuesday"). Replay must produce identical verdicts.

### 2. Every layer checkable and fixable

Each layer must expose:
- Defined input contract (validated on entry)
- Defined output contract (verdict + reasoning + metrics + version)
- Health probe (synthetic test fixture)
- Drift detector (historical baseline vs recent behavior)
- Replay capability

**Hard rule: no `.catch(() => null)` patterns in decision logic.** Every layer either returns a defined result or throws. Silent failure is what caused yesterday's halt-bypass.

### 3. Plan before implementation

Layer specs written and agreed BEFORE any code. ~1-2 weeks of design work upfront. We will not auto-roll through layers.

### 4. Token/cost minimization

Match model to task. Most layers are deterministic and use zero tokens. AI is reserved for tasks where reasoning quality matters AND deterministic logic isn't enough.

| Task | Model | Cost/call | Frequency |
|---|---|---|---|
| News classification | Haiku | ~$0.001 | Per pitcher |
| Adversarial critic (gray-zone only) | Sonnet 3.5 | ~$0.02 | 5-10/slate |
| Daily post-mortem | Sonnet 3.5 | ~$0.05 | 1/day |
| Big-stakes review ($200+) | Opus | ~$0.10 | ~1-2/week |
| Routine logic | NO MODEL | $0 | Always |

**Budget targets:** <$0.30/slate, <$1/day, <$30/month. If we ever exceed $50/month, the architecture is wrong, not the price.

Token-saving tactics: Haiku-first cascade → Sonnet only on ambiguous; structured input only (no raw news dumps); JSON-only output; cached system prompts; conditional invocation; batch within calls.

---

## Locked layer enumeration (2026-04-30)

```
Layer 0:  Trace / Audit Ledger        — foundation; everything writes here
                                        (per-bet trace + shadow + probe + counterfactual)

Decision Stack (bet flows through these in order):
Layer 1:  Math / Price Engine          — Bayesian model + Kelly. Deterministic.
Layer 2:  Path / Feasibility Engine    — Side-aware required-BF (pK_low/pK_high). Deterministic.
Layer 3:  Trust Score                  — Data quality 0-100 + sizing multiplier. Deterministic.
Layer 4:  AI Critic                    — Adversarial review. Exceptions only, gated by Trust.
Layer 5:  Deterministic Judge          — Lexicographic priority hierarchy. Combines all upstream.
Layer 6:  Server-Side Gateway          — Execution safety floor. Last line of defense.

Infrastructure (no decision authority):
  • Signals Collector  — news, Pinnacle/aggregator, statcast, weather, ump
  • Calibration Engine — meta-layer, adjusts thresholds in 2/3/4/5 over time
```

### Trust → Critic gating rule (locked)

```
trustScore >= 80 AND bet_size small  → skip Critic (no AI call)
trustScore 50-79 AND bet_size meaningful → run Critic
trustScore < 50                       → skip YES automatically;
                                         run Critic only if edge is huge
```

### preflightCheck.js dismantling

The current monolithic preflight splits into three new files:

```
preflightCheck.js  →  collectPregameSignals.js  (news → structured signals)
                  →   criticReview.js            (Sonnet adversarial call)
                  →   Judge consumes structured objection (no separate file)
```

---

## Architectural shape (agreed direction)

```
┌─────────────────────────────────────────────────────────────┐
│  Math layer (price engine)                                  │
│  - Negative Binomial K-distribution + archetype dispersion  │
│  - Outputs: per-strike modelProb, edge, suggested Kelly     │
└─────────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  Diagnostic layer (assumption checker, deterministic)       │
│  - Required-BF gate (side-aware: pK_low for YES, pK_high    │
│    for NO)                                                  │
│  - Path feasibility check                                   │
│  - Outputs: per-strike feasibility verdict + bfMargin       │
└─────────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  Trust score (deterministic)                                │
│  - Drops on rookie/thin sample/DK disagreement/IL return    │
│  - Rises on stable veteran/recent BF stability/clean news   │
│  - Outputs: trust 0-100, sizing multiplier                  │
└─────────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  AI critic (gray-zone only)                                 │
│  - Triggered when: trust < 60 OR strike ≥ 8 OR              │
│    DK disagreement OR soft news flag                        │
│  - Sonnet with adversarial prompt — argue why each bet      │
│    will fail, cite specific assumption + evidence source    │
│  - Constrained schema: primary_risk enum (8 categories)     │
│  - Returns "no_objection" if no real risk identified        │
│  - Cannot say "size up"                                     │
└─────────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  Judge (deterministic)                                      │
│  - Lexicographic priority hierarchy                         │
│  - Hard-block risks at conf ≥ 65 → skip                     │
│  - Soft risks at conf ≥ 70 → size down 50%                  │
│  - Soft risks at conf 50-69 → size down 25%                 │
│  - No objection → fire as planned                           │
└─────────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  Server-side order gateway (the load-bearing piece)         │
│  - All Kalshi orders flow through this single endpoint      │
│  - Validates: version pinning, kill-switch flags, exposure  │
│    caps, freshness, idempotency                             │
│  - Closer (Windows agent) does NOT have Kalshi credentials  │
│  - Closer can compute signals but cannot place orders       │
└─────────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  Telemetry / Counterfactual ledger                          │
│  - Real ledger: actual orders placed                        │
│  - Shadow ledger: every proposed/skipped/sized-down bet     │
│    with market snapshot at decision time, virtually settled │
│  - Probe ledger: 1-3% of skipped bets fired at $1 to        │
│    validate fill assumptions                                │
└─────────────────────────────────────────────────────────────┘
```

**The reframe:** AI moves from front-line filter to last-line auditor of math's specific assumptions. Most bets get decided by deterministic math + diagnostics + trust gates. AI sees only the genuinely ambiguous ones.

---

## Why we rejected the multi-agent design

Considered (and rejected): math + AI advocate + AI critic + AI judge with consensus voting.

Rejection reasons:
1. Math is already the advocate — adding a second AI saying "yeah, fire it" gives zero additional signal
2. Consensus voting = lowest common denominator, not best decision
3. More agents = more places for bugs
4. Theater rather than productive disagreement

The clean version is **two voices with asymmetric roles**:
- Math = optimist (defends the bet)
- AI critic = prosecutor (attacks the assumptions)
- Judge = deterministic rule (not a third LLM)

Adam's intuition that AI and logic should "compete" is correct. The implementation is two voices + deterministic adjudication, not multi-agent consensus.

---

## Known flaws and resolutions

These were identified in critique cycles and must be addressed in the design before code.

### F1: pK circularity (most serious)

**Problem:** The "deterministic" required-BF gate uses pK from the same Bayesian model we know is over-confident. If pK is wrong, requiredBF is wrong by 6+ batters — exactly at the gate threshold. The gate isn't actually independent of the model.

**Resolution:** Use a conservative pK *range*, not a single pK. For YES feasibility, take `min(calibrated_pK, career_pK, season_pK, DK_implied_pK)`. For NO feasibility, take the `max`. DK line is the only genuinely independent signal — use it as a sanity anchor, not a replacement.

For thin-sample pitchers (rookies), the ranges may collapse to similar values. We accept this limitation and flag those bets via trust score.

### F2: NO bets break the gate

**Problem:** Required-BF framing was YES-only. For NO bets, math inverts: if expectedBF < requiredBF, NO is FAVORED, not disfavored. The gate as originally specified would skip NO bets we should fire.

**Resolution:** Side-aware gate. Pseudocode (from critique):

```
For YES at threshold T:
  requiredBF = ksNeeded / pK_low
  bfMargin   = expectedRemainingBF - requiredBF
  margin >= 3   → pass
  margin 0-3    → size_down
  margin < 0    → skip

For NO at threshold T:
  requiredBF = ksNeeded / pK_high
  bfMargin   = expectedRemainingBF - requiredBF
  margin <= -2 → strong NO path (pass)
  margin -2..2 → size_down
  margin > 2   → skip (path too easy)
```

YES asks: "Can he realistically produce enough Ks?" NO asks: "Even under generous K assumptions, is the path still hard?"

### F3: Counterfactual ledger has selection bias

**Problem:** Filtered bets are not in the firing population, so we never observe how filtered bets actually perform. The filter validates itself by absence of contradicting data.

**Resolution:** Three-ledger design:
- **Real ledger:** what we actually bet
- **Shadow ledger:** every proposed/skipped/sized-down bet logged with market snapshot at decision time, virtually settled later. Most filtered bets get this — costs $0 in capital.
- **Probe ledger:** 1-3% of skipped bets fired at $1 minimum size to validate fill assumptions only. Never on hard-red-flag cases.

Shadow ledger is mandatory. Probe ledger is small.

### F4: Pre-game architecture while live bleeds more

**Problem:** Last week pre-game losses ~$400; live losses ~$1,500. The proposed AI-heavy architecture says nothing about live betting (30s decision windows where Sonnet doesn't fit).

**Resolution:** Same four conceptual layers (prediction → trust → price → action) but different implementations:
- Pre-game: math + diagnostics + AI critic for ambiguous + deterministic judge
- Live: math + deterministic state gates + deterministic path gates + server order guard. **NO AI in live decision loop.**

AI can run BEFORE the game and mark live constraints (e.g., "for Tolle: maxLiveYesStrike=6, allowStackYes=false"). Live engine consumes those precomputed restrictions deterministically.

### F5: Closer-bypass vulnerability

**Problem:** Yesterday's incident — code-level kill switches and DB halt flags were ignored because Closer ran stale code that didn't include those checks. Any new architecture has the same vulnerability if gates live in client code.

**Resolution:** Server-side order gateway. **No client should have Kalshi order credentials.** Closer becomes a signal generator that POSTs order intents to a Railway endpoint. The gateway validates version pinning, kill-switches, exposure, freshness, and idempotency BEFORE placing the order with Kalshi.

This is the single most important architectural fix. Every other layer is theoretical until orders can't bypass the gateway.

### F6: Multi-signal disagreement unspecified

**Problem:** With 4 gates × 3 outcomes = 81 possible combinations. Default rules don't cover them.

**Resolution:** Lexicographic priority hierarchy with size multipliers (no weighted scoring yet — we don't have calibration data for that):

```
Priority 0 — System safety (always wins)
  - global halt, stale code, unauthorized agent, stale data,
    bad quote, daily loss limit, exposure cap
  - Any true → reject

Priority 1 — Resolved state
  - crossed YES, pulled NO, scratched, wrong starter
  - Handled by state logic before everything else

Priority 2 — Hard red flags
  - scratched, opener/bulk ambiguity, confirmed pitch limit,
    return-from-IL, expectedBF impossible
  - Skip

Priority 3 — Path feasibility (side-aware required-BF gate)
  - Skip / size_down / pass

Priority 4 — Trust score
  - Sizing multiplier, not raw decision
  - Very low → skip YES specifically

Priority 5 — AI critic (only for gray-zone)
  - Hard risk + high conf → skip
  - Soft risk + high conf → size_down
  - Low conf → no effect

Priority 6 — Economics
  - Edge sufficient? Spread OK? Liquidity OK? Below min size?
```

### F7: Calibration drift with no auto-recalibrate

**Problem:** Trust score and AI critic confidence calibrated in April will drift by July as managers adjust, pitchers evolve, bullpen state varies.

**Resolution:** Bayesian update with sample-based half-lives (NOT calendar):
- Market/result calibration: weekly rebuild, ~30-45 day half-life
- Pitcher trust / E[BF]: 14-21 day half-life, min 30 samples before adjustment
- AI critic accuracy: 45-60 day half-life, min 50 calls per risk type before changing rules

Guardrails: small samples observe only; medium samples cap adjustment to ±10%; large samples allow full adjustment.

### F8: Gate correlation creates false safety (added in critique)

**Problem:** If trust score, required-BF, and AI critic all use "rookie" as a feature, three "agreeing" gates is really one signal counted thrice.

**Resolution:** Track evidence_source per gate. Same evidence cannot trigger more than one independent penalty. If "rookie" is what dropped trust, AI critic citing rookie cannot independently size-down further.

### F9: Over-filtering = edge starvation (added in critique)

**Problem:** A beautiful 40% ROI on $20 capacity is worse than 5% on $2k. Adding more skips can improve ROI while reducing total profit.

**Resolution:** Track BOTH absolute dollars saved/lost AND ROI by gate. Counterfactual ledger reports include "profit lost by false skips" and "capacity reduced by gate."

### F10: Hedging hides model failure (added in critique)

**Problem:** If hedges save losing pre-game bets, total P&L looks okay while pre-game math remains negative.

**Resolution:** Report pre-game standalone P&L, hedge P&L, combined P&L separately. Each layer's P&L attribution must be auditable.

### F11: Fill assumption dominates edge (added in critique)

**Problem:** Edge computed against mid-price ≠ executable edge. If we compute edge vs mid but execute at ask, real edge is smaller than displayed.

**Resolution:** Use side-aware edges:
```
takerEdge = modelProb - askPrice   (what we'd actually pay as taker)
makerEdge = modelProb - desiredBid (what we'd capture if filled at maker price)
```
Mid-edge does not drive taker orders except for true stale-state trades.

### F12: AI hallucinates within enum

**Problem:** Categorical schemas prevent freeform rationalization but not miscategorization. Sonnet can pick `workload_bf_risk` for a stable veteran.

**Resolution:**
- Source-backed objections required: AI cannot claim risk type X without citing specific evidence (recent pitch counts, news source, DK disagreement, etc.). No evidence → "no_objection."
- Confidence caps by evidence type:
  - No hard source: max confidence 55
  - Soft pattern only: max 65
  - Verified news / DK disagreement / role issue: max 85
- Shadow mode for first 1-2 weeks: critic decisions logged but don't act unless hard news flag present.

---

## Operational state going into the rebuild

As of 2026-04-30 morning:

- ✅ All 9 live modes disabled via `DISABLED_LIVE_MODES` env var (`high-conviction, stack-yes, blowout, early-blowout, late-inning-no, crossed-yes, dead-path, pulled, pull-hedge`)
- ✅ `trading_halted=0` in system_flags (cleared overnight; live engine is halted via DISABLED_LIVE_MODES regardless)
- ✅ Pre-game `normal` mode with reverted Rule K rules (yes_pregame_min_prob=0.45, yes_pregame_min_prob_hi=0.65, yes_pregame_max_mid=35) — pre-Sunday-relax state
- ✅ Contra-test experiment running on Adam's account only (1-contract NO bets at strikes 6+/7+/8+ when implied NO ∈ [35,65]¢; bet_mode='contra-test'; decision date 2026-05-20)
- ✅ Pre-game `market_snapshots` capture wired (every evaluated market logged)
- ⚠️ Closer (Windows agent) running stale code (commit fd73fd35 from April 25) — auto-update appears broken; ignored both code-level kill switches and DB halt flags yesterday
- ⚠️ Multiple bugs in current settlement: `pnl=0` on actually-filled losing live bets; premature `result='loss'` settlement while pitcher still in game

The current system continues to run pre-game. Live is halted. The rebuild does not block any of this — it runs in parallel as the new architecture is designed and validated.

---

## Build plan

### Discussion ordering: Option A (Foundation first)

Agreed: server-side order gateway is layer 1. Without it, every other layer is theoretical because client code can be bypassed.

### Pre-layer-spec discussion (next session)

Before opening any layer, three meta-decisions:

1. **Layer enumeration.** Agree on the full list. Currently sketched as 7 layers (math, diagnostics, trust, AI critic, judge, server gateway, telemetry) but the list is open. What's a layer vs sub-layer? What's the dependency graph?

2. **Spec template.** What fields does every layer's spec contain? Currently sketched: purpose, inputs, outputs, side effects, failure modes, test fixtures, performance budget, kill switch, dependencies, SLOs. Lock the format before applying it.

3. **Discussion order within Option A.** Server gateway first is agreed. After that — telemetry/replay framework next? Or jump to math layer? Or proceed by data flow?

### Per-layer discipline

For each layer:
- Spec written and reviewed
- Test fixtures defined
- Health probe defined
- Failure modes enumerated
- Dependencies on other layers explicit
- Performance/token budget set
- Then and only then: implementation

No moving on until both Adam and Claude are genuinely satisfied with the spec.

### Phase ordering (after layer specs are done)

1. **Phase 1: Testing framework first.** Strategy pattern interface. Three trivial implementations (current/old/new) that just log. Shadow ledger that records all three verdicts. Per-layer health probes. Replay capability. Ships no new betting behavior — only enables measurement.

2. **Phase 2: Implement layers in order.** Server gateway first. Then required-BF. Then trust score. Then AI critic. Then judge. Each ships with: spec, code, health probe, test fixtures, shadow ledger integration. No layer ships without all five.

3. **Phase 3: Parallel run.** Real money still on current system. Old + new run in shadow. After ≥2 weeks of clean shadow data, switch default. Compare per-bet decision overlap, counterfactual P&L, drift over time.

---

## What we are NOT doing

- Multi-agent consensus voting (rejected)
- AI critic on every bet (rejected — gray zone only)
- AI in live decision loop (rejected — too slow, deterministic only)
- Calendar-based recalibration (rejected — sample-based instead)
- Trained ML for calibration matrix at start (rejected — deterministic first; train only when we have thousands of labeled samples)
- Replacing math model with DK line (rejected — DK is sanity anchor only)
- Auto-rolling through layer implementation (rejected — every layer discussed first, per Adam's directive)

---

## Open questions for next session

1. What's the complete layer enumeration? (we've sketched 7; lock the list)
2. What's the spec template? (lock the format)
3. After server gateway, what's layer 2 in the discussion order?
4. How do we handle the existing Closer? (it's currently running stale code; the gateway design assumes Closer becomes a signal-only client)
5. Does the gateway also handle pre-game order placement, or is it live-only initially?
6. What's the rollback plan if Phase 2 reveals the new system is worse than current?

---

## Appendix: Decisions log

This section captures decisions made during planning so we don't relitigate them.

| Date | Decision | Rationale |
|---|---|---|
| 2026-04-29 | Two-voice architecture (math optimist + AI critic prosecutor + deterministic judge), not 4-agent consensus | Adversarial framing produces real signal; consensus = LCD |
| 2026-04-29 | Server-side order gateway is layer 1 | Closer-bypass is the load-bearing operational risk |
| 2026-04-29 | Lexicographic priority hierarchy for judge, not weighted scoring | We don't have calibration data for weights yet |
| 2026-04-29 | Shadow ledger + small probe ledger, not 5-10% real probes | Cheaper, less biased counterfactual measurement |
| 2026-04-29 | Side-aware required-BF gate using pK_low (YES) / pK_high (NO) | YES-only formulation breaks for NO side |
| 2026-04-29 | AI on exception only (gray zone trigger rules), not universal | Token efficiency + signal focus |
| 2026-04-29 | Sample-based half-lives for recalibration, not calendar | Volume varies week-to-week |
| 2026-04-29 | Decision logic separate from execution (strategy pattern) | A/B/C testability against current/old/new |
| 2026-04-29 | Plan before implementation, no auto-rolling through layers | Ounce of planning > pound of implementation |
| 2026-04-30 | Pre-game `normal` continues to run on current system during rebuild | Don't break what marginally works |

---

*This document is the source of truth for the rebuild. Updates here BEFORE any code is written.*
