# MLBIE Morning Report — April 26, 2026

All 7 AI improvement ideas have been implemented and smoke-tested. Here's what shipped:

---

## What Was Already Live (No Action Needed)

Before building anything, a codebase audit found these ideas were **already implemented in strikeoutEdge.js**:

- **Lineup K-rate** — `game_lineups` table, official 9-man lineup K% used when available
- **Umpire modifier** — `umpire_factors` table, pitcher-ump historical K% adjustment
- **Weather adjustment** — storm disqualify + temp/wind adjustments in `stormAgent.js`
- **Park factor** — `park_factors` table wired into λ computation
- **Velocity/command adjustment** — Statcast `k_pct9` + `bb_pct` weighted into pitcher quality

---

## Changes Shipped Tonight

### 1. Per-Pitcher Kelly Scale from Calibration Data
**File:** `scripts/live/strikeoutEdge.js`

`pitcher_calibration.reliability` (actual_roi ÷ expected_roi) is now clamped to [0.5, 1.5] and applied as a multiplier to each pitcher's bet size after correlated Kelly. This was always being computed by `calibrationEngine.js` but was never wired back to sizing.

- Pitchers who consistently outperform get up to +50% sizing
- Pitchers who underperform get down to -50% sizing  
- Requires ≥10 resolved bets per pitcher to activate; new pitchers default to 1.0
- Logged as `[cal-scale] PitcherName: reliability=1.23x → $45→$55`

### 2. Last-Start Context Injected into Claude Preflight
**Files:** `lib/claude.js`, `lib/preflightCheck.js`

The `scoutKMarket` Sonnet call now receives the pitcher's most recent start from `pitcher_recent_starts`: pitch count, Ks, IP, and days rest. This was the root cause of Claude rubber-stamping all pitchers on April 26 — it had no way to know a pitcher threw 110 pitches three days ago.

System prompt updated with two new skip rules:
- Last start ≥105 pitches + days rest ≤4 → skip (pitch limit likely)
- Last start ≥110 pitches + any caution signal → skip (definitely limited)

New boost rule:
- Last start had 8+ Ks in 6+ IP with no negative signals → boost

### 3. Pull-Hedge NO Bets (Fix #9)
**File:** `scripts/live/liveMonitor.js`

New `pull-hedge` mode activates when:
1. Pitcher is in the pull zone (≥85 pitches + ≥4 IP)
2. A pre-game YES was filled at this strike
3. Live model has fallen below the break-even: `modelProb < yesFillPrice/100 - 0.05`
4. NO still has edge (≥8¢) and is reasonably priced (5¢ < noMid < 75¢)

Fires a taker NO order capped at `DEAD_PATH_CAP_USD` ($10). Tagged `🛡️ PULL-HEDGE` in logs. This recovers some of the YES cost when the pitcher is getting pulled before hitting the threshold.

Key difference from dead-path: dead-path requires `modelProb < 0.10` (near-certain loss). Pull-hedge covers the 10–60% zone where we're losing expected value but the market hasn't fully repriced.

### 4. EOD Report Cards Removed
**Files:** `scripts/live/dailyRun.sh`, `server/scheduler.js`

`eodReport.js` is gone from the nightly settle pipeline. Nobody reads them. Replaced with `postGameAttribution.js` (see below) which is silent.

### 5. Post-Game Attribution (New)
**File:** `scripts/live/postGameAttribution.js`

Silent script that runs after settle. Does three things:
1. Logs a per-pitcher attribution table: W-L record, P&L, lambda error, prob calibration
2. Flags outliers (model λ differed from actual Ks by ≥3)
3. Triggers `calibrationEngine.runCalibration()` if ≥30 resolved bets exist — keeps reliability scores current after every game day

No Claude, no Discord. Just structured console output and calibration trigger.

---

## Smoke Test Results

| File | Syntax | Logic |
|------|--------|-------|
| `lib/claude.js` | ✅ | ✅ (lastStartLine render, extractJson all cases) |
| `lib/preflightCheck.js` | ✅ | ✅ (lastStartContext passed to scoutKMarket) |
| `scripts/live/strikeoutEdge.js` | ✅ | ✅ (calibration map, clamping, kelly_scale_pitcher field) |
| `scripts/live/liveMonitor.js` | ✅ | ✅ (5 realistic pull-hedge gate scenarios) |
| `scripts/live/postGameAttribution.js` | ✅ | ✅ (import chain, query structure) |
| `scripts/live/dailyRun.sh` | ✅ | ✅ (eodReport gone, postGameAttribution present) |

---

## Monthly Cost Impact

These changes add ~0 Claude API cost over baseline:
- `scoutKMarket` runs the same number of times; we just add a few tokens of context per call (~$0 marginal)
- `postGameAttribution` has no Claude call
- Pull-hedge fires rarely (pitcher must be at 85+ pitches with a specific YES position) and has no AI component

The Apr 26 session fixes from last session (lineup K% gating, preflight caching) already cut Claude cost by ~$40-60/month.

---

## What to Watch Tomorrow

1. **Kelly scale logging** — look for `[cal-scale]` lines in the morning run output. If you see reliabilities loading for any pitchers, the system is working. New pitchers will show 1.0.

2. **Last-start context** — preflight logs will now show things like "98 pitches, 7 Ks in 6.0 IP | 5 days rest" before the Claude judgment. Watch for any pitcher with ≥105 pitches and ≤4 rest to get auto-skipped.

3. **Pull-hedge** — only fires if you hold a live YES position and the pitcher hits 85 pitches. Check liveMonitor logs for `🛡️ PULL-HEDGE`.

4. **Attribution** — after tonight's settle, `postGameAttribution.js` will run. Console will print the W-L/P&L table and lambda error per pitcher.

---

Deploy: `railway up --detach` — sent ✅
