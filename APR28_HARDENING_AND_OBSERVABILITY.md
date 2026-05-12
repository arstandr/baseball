# Apr 28 — Hardening + Observability

Adam — read me before first pitch. This is the third pass tonight, focused on
making sure every lever in pulse / intelligence / Kelly / in-game / free-money /
hedging does what it claims to do, and adding Discord alerts for failure modes.

Deploy: `5afd5cf6-e415-4996-b3d9-0d0474951c36` SUCCESS at 12:04 UTC / 8:04 AM ET.

## 1. Wired betting_rules into strikeoutEdge.js (pre-game)

**Gap closed:** Pre-game edge calculation was using hardcoded constants
(`YES_MIN_PROB=0.25`, `NO_MIN_EDGE=0.12`) and ignoring the DB tunings. Only
liveMonitor read `betting_rules`. Today the DB has:

- `yes_pregame_min_prob = 0.40`  (was hardcoded as 0.25)
- `yes_pregame_max_mid = 50¢`     (was not enforced at all)
- `no_min_edge = 0.15`            (was hardcoded as 0.12)
- `yes_max_strike = 10`           (now enforced pre-game)
- `no_max_strike = 6`              (now enforced pre-game)

**Wire-in:** `scripts/live/strikeoutEdge.js`
- Imported `getRules` from `lib/bettingRules.js`
- Loaded effective values at top of `run()` with hardcoded fallback
- Strict-side wins via `Math.max(hardcoded, dbValue)` — we never relax, only tighten
- Effective values are now logged at startup so you can see what's in force:
  ```
  [ks-edge] effective rules: YES min_prob=0.40 max_mid=50¢ max_strike=10 |
                              NO min_edge=0.15 max_mid=45¢ max_strike=6
  ```

## 2. drawdown_scale = 0.5× ACTIVE today

**Verified intentional:** `recomputeDrawdownScale()` in `scheduler.js:687` runs
every 30 min. Computes 7-day rolling P&L from `daily_pnl_events` with `ks_bets`
fallback. Triggers:
- ≤ −10% drawdown → `0.5×`
- ≤ −5% drawdown → `0.75×`
- otherwise → `1.0×`

Yesterday's losses pushed us past −10%, so the dampener correctly engaged.

**Today's bet sizes are halved** until the rolling drawdown recovers above −5%.
That's working as designed — leave it on.

`trading_halted = 0`, `kalshi_outage = 0` — both clean.

## 3. Bankroll wiring confirmed correct

`getPerUserAvailablePool` in `lib/bankrollState.js:78-83` reads live
`kalshi_balance` first, falls back to `starting_bankroll` only when null. Kelly
sizing in liveMonitor is correctly scaled against the true live balance:

- Isaiah: live $1,206.98 (vs stale starting_bankroll $1,000)
- Adam-Live: live $792.08 (vs stale starting_bankroll $500)

`starting_bankroll` is only used by the drawdown calc (intentional — measures
drawdown vs original deposit, which is the right semantic).

## 4. lib/healthAlerts.js — 13 alert types

New file. Per-event Discord alerts with their own dedup windows. Goes to your
ADAM_WEBHOOK channel.

| Function | Trigger | Cooldown |
|---|---|---|
| `alertLiveMonitorStalled` | heartbeat > 2 min stale during game window | 5 min |
| `alertGamePulseStalled` | pulse heartbeat > 3 min stale | 5 min |
| `alertWsDown` | Kalshi WS disconnected | 3 min per source |
| `alertTradingHalted` | trading_halted = 1 (or back to 0) | 1 min |
| `alertDrawdownChange` | drawdown_scale changed | 1 min per from→to |
| `alertKalshiOutage` | kalshi_outage flag flipped | 1 min |
| `alertStaleFireBlocked` | stale-fire guard rejected a bet | 30 min per pitcher/strike/side |
| `alertExtremeDivergence` | extreme-divergence guard rejected | 30 min per pitcher/strike |
| `alertNearLossLimit` | user at ≥80% of daily loss cap | 30 min per user |
| `alertHighConvictionCapHit` | LIVE_HIGH_CONVICTION_CAP binding | 30 min per pitcher/strike |
| (existing) `notifyAlert` for drawdown change | already wired | - |

Wired into:
- `liveMonitor.js` halt branch → `alertTradingHalted`
- `liveMonitor.js` settled-game guard → `alertStaleFireBlocked`
- `liveMonitor.js` 4.5h-after-first-pitch guard → `alertStaleFireBlocked`
- `liveMonitor.js` extreme-divergence reject → `alertExtremeDivergence`

## 5. liveMonitor + gamePulse heartbeats

Each loop iteration writes to `system_flags`:
- `liveMonitor_heartbeat` (~5–15s cadence)
- `gamePulse_heartbeat` (60s cadence)
- `gamePulse_updateGamePulse_at` (60s)
- `gamePulse_lineDir_at` (5 min)
- `gamePulse_scheduleRefresh_at` (30 min)

Sentinel reads these every minute and alerts Discord if any heartbeat is stale
relative to its expected cadence (using 3× tolerance for sub-components).

## 6. Per-game phase milestone alerts

Sentinel computes `minToGame` for each game on the slate using the same
`-04:00`-anchored math that fixed C5. For each pre_game game:

- T-180 passed and no `dk_*_line_t180` snapshot → 🛑 alert
- T-90 passed and no `dk_*_line_t90` snapshot → 🛑 alert
- T-30 passed and phase still `pre_lineup` (no lineups posted) → 🛑 alert

Each alert is session-deduped per game/milestone so you get one ping per missed
window, not a flood.

## 7. Sentinel cron — every minute during game window

`scheduler.js:runHealthSentinel()` registered at the bottom of `startScheduler`:
```js
cron.schedule('* * * * *', () => {
  runHealthSentinel().catch(...)
}, { timezone: 'America/New_York' })
```

Only fires alerts inside the 11am–2am ET game window so off-hours idleness
doesn't trigger noise.

---

## What this means for today

You will see Discord alerts when:
- The system itself is misbehaving (stalled loops, dropped WS, halt active)
- A scheduled action didn't fire (line snapshot, lineup post, scratch check)
- A guard rail caught something (stale fire, extreme divergence, cap binding)
- A user is approaching their daily loss limit

You will NOT see Discord alerts for normal operations — that's still the existing
`discord.js` event channel (live bets, dead bets, game results, daily report).

Per memory `feedback_discord_scope.md`, this respects the agreed-on scope:
**failures and major events only — no status spam.**

---

## Earlier deploys still live
- `b6d0d09c` (07:48 ET) — stability sprint (C1, C4, C5, R1, R2, false-pull removal, stale-fire guards, hedge timing)
- `e21229a0` (00:57 ET) — budget bypass fixes
- `8a323a12` (00:42 ET) — Yesterday-card void-bet display fix

## Backlog deferred
- A1: hardcoded NB_R in lib/strikeout-model.js (archetypeR exists, not wired)
- 7 stuck Apr 27 resting orders (auto-void at settlement)
- Historical capital_at_risk values from before fix

## Stack-rank for first pitch
1. ✅ Code is hardened. Levers are wired. Guards are armed.
2. ✅ Drawdown dampener at 0.5× is doing its job.
3. ✅ Discord will tell you when something breaks.
4. ⚠️ First-pitch is approaching. Watch for the first wave of pulse-milestone
   alerts (T-180 around 9:30 AM ET for a 12:30 game) — that's the litmus test
   that the sentinel is wired correctly.
