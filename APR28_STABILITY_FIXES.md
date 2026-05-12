# Apr 28 — Stability fixes (overnight pre-slate hardening)

Adam — read me before first pitch. This summarizes everything we landed overnight against
yesterday's failure modes. Verification matrix at the bottom.

## Deployed code changes

| File | Lines | Change |
|---|---|---|
| `scripts/live/liveMonitor.js` | ~78 | Lowered `PULL_PITCH_COUNT` default 85 → 70 (hedge arms earlier) |
| `scripts/live/liveMonitor.js` | ~590 | Added two stale-fire guards in `executeBet`: settled-game guard + 4.5h-after-first-pitch guard |
| `scripts/live/liveMonitor.js` | ~1543 | C1 — `manageRestingOrder` now converts USD→contracts using taker price, subtracts `filled_contracts` |
| `scripts/live/liveMonitor.js` | ~2102 | Lifted `tickerWs` + `tickerToPitcher` to outer scope so resub is callable |
| `scripts/live/liveMonitor.js` | ~2175 | Pitcher refresh loop now also calls `tickerWs.addTickers()` for late-added pitchers (R1) |
| `scripts/live/liveMonitor.js` | ~2395 | Added `pitchCountStale` flag — `currentPitches===0 && currentIP>=5` |
| `scripts/live/liveMonitor.js` | ~2624 | **Removed false-pull stale-fallback branch.** Pull now requires reliever-on-mound, substitution event, or Kalshi signal. |
| `scripts/live/liveMonitor.js` | ~3062 | High-conviction YES gate now rejects when `pitchCountStale` (C4) |
| `lib/gamePulse.js` | 49–67 | Added `gameTimeMsET()` ET-aware ms helper |
| `lib/gamePulse.js` | 295–303, 425–434 | Replaced broken `setHours()` (ran UTC on Railway) with `gameTimeMsET()` (C5) |
| `lib/kalshiWs.js` | ~74 | Added `addTickers()` method to ticker WS |
| `server/scheduler.js` | 1001 | Widened liveMonitor startup window 5pm–2am → 11am–2am ET (R2) |
| `scripts/nba/nbaBets.js` | 113 | `dailyUsed += betSize` (cash) instead of broken `capitalAtRisk` |

## Verification matrix — every Apr 27 incident → bug → fix → confidence

| # | Incident (Apr 27) | Root bug | Fix | Confidence |
|---|---|---|---|---|
| 1 | Paddack 2+ YES disaster (−$941 across 2 users at 2-3¢ market) | Stale live model (lambda=0.95 with stale pitch count) + budget bypass on cheap-side bets | Earlier deploy: `LIVE_HIGH_CONVICTION_CAP_USD=$200`, extreme-divergence guard, `daily_risk_pct=0.20`, `capital_at_risk=cash`. This deploy: `pitchCountStale` gate prevents the staleness from feeding lambda → blocks the trigger upstream. | **High** — three independent layers now reject this exact scenario |
| 2 | Kochanowicz false pull at 3K → bought NO 5+ for $499.85 → he then got 5 K → NO loss | `liveMonitor.js:2630` stale-fallback fired `pitcherPulledEarly=true` on inning-break `isCurrent=false` after 2 cycles | Removed stale-fallback branch entirely. Pull requires reliever-on-mound OR substitution OR Kalshi signal. | **High** — branch deleted; only confirmed signals fire |
| 3 | Kochanowicz 5+ YES bet placed at 03:14, 215 min after first pitch (game over) | No stale-bet guard in executeBet | Two new guards: reject if game in `settledGames` set; reject if game started >4.5h ago | **High** — both guards run before any sizing/order |
| 4 | 7 resting orders never filled (Messick 7+/9+/9+, Kochanowicz 6+, etc.) | `manageRestingOrder` line 1543 used `Math.round(bet.bet_size)` as contracts (USD treated as count) | Now: `(bet_size * 100) / takerCents - filled_contracts` | **High** — math is correct; manual cleanup of yesterday's stuck orders deferred (tier 3) |
| 5 | gamePulse phase windows fired 4h late (T-30, T-90, T-180 wrong) | `lib/gamePulse.js:300, 431` `setHours()` runs UTC on Railway | Replaced with `gameTimeMsET()` helper using EDT (-04:00) anchor; verified math: ET 19:40 → 23:40 UTC ✓ | **High** — math test confirmed |
| 6 | liveMonitor missed afternoon games on Railway redeploy | `scheduler.js:1001` startup window 5pm–2am only | Widened to 11am–2am ET | **High** — covers all afternoon starts |
| 7 | Hedging armed too late | Three-way: PULL_PITCH_COUNT=85 too high; gamePulse phases were UTC-shifted (C5); pitch-count staleness suppressed structural ceiling | Lowered PULL_PITCH_COUNT 85→70; C5 fixes phase timing; C4 ensures we don't gate on stale 0-pitch reads | **Medium-High** — three improvements, but timing only fully observable in live game |
| 8 | Late-lineup pitchers got no Kalshi WS pull signals | WS subscribed once at startup, never updated | Added `tickerWs.addTickers()`; pitcher refresh loop now subscribes new tickers | **High** — code path exercised every 10 ticks |
| 9 | "15 missed pitchers" claim from first investigation | Investigation artifact — 5 pitchers had ALL edges legitimately rejected (locked / below threshold / prob<25%) | No fix needed | **High** — confirmed not a bug |

## Earlier same-night deploy (still live)
Before tonight's stability sprint we shipped budget-bypass fixes:
- `capital_at_risk` now equals USD cash committed (not buggy `betSize × marketPrice`)
- `LIVE_HIGH_CONVICTION_CAP_USD = $200` hard ceiling
- Extreme-divergence guard: reject high-conviction YES when `marketPrice<5¢` AND `edge>30¢`
- `daily_risk_pct = 0.20` for both users (was 62.5% / 42%)

## Backlog still open (deferred — not blocking today)
- A1: Hardcoded NB_R in `lib/strikeout-model.js:12`. `archetypeR()` exists but isn't wired in.
- 7 stuck resting orders from Apr 27 (Messick 7+, 9+, 9+ etc.) — should be reconciled / cancelled. They're already past the game so they'll auto-void at settlement, but cleaner to cancel.
- C1 historical capital_at_risk values are wrong for Apr 27 bets — analytics will undercount old exposure but new bets are correct.

## What I did NOT change
- Kelly sizing math itself (`lib/kelly.js`) — still works as designed; the bug was at call sites that misused `capitalAtRisk`.
- The pre-game pipeline / lineup gate — not implicated in Apr 27 failures.
- `strikeoutEdge.js` model code — A1 is on backlog but didn't cause yesterday's incidents.

## Sleep well. The system is materially safer than it was 4 hours ago.
