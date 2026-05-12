# Live Monitor Audit Report — April 26-27, 2026

## Executive Summary

Deep-dive overnight audit of every system component. Root cause of zero in-game hedging on Apr 26-27 was that **liveMonitor was not running** — Railway scheduler had a comment saying Windows agent ("The Closer") managed it, but The Closer was not active. Secondary issues: pitcher refresh lag, timing, data bugs, and one live betting loop that fired YES bets on a pulled pitcher's dead market.

---

## WHAT COST MONEY

### 1. liveMonitor Not Running (Entire Session)
**Impact**: $0 in potential hedging profit missed. All Boyd/Paddack/Vásquez NO bets during pulls not fired.  
**Root cause**: `scheduler.js` had comment: `// liveMonitor managed by The Closer`. The Closer (Windows agent) was not running on Railway.  
**Fix**: Added startup auto-launch when game hours (5pm–2am ET) detected. Monitor now starts on Railway boot.

### 2. Pitcher Refresh Lag (Late-Added Pitchers)  
**Impact**: Boyd, Paddack tracked as "late-added pitchers" — bets placed after monitor start. Pull detection fired correctly but on restart.  
**Root cause**: `allPitcherIds` loaded once at startup; pitchers whose bets were placed by the pipeline after monitor start were never tracked.  
**Fix** (already existed): `iteration % 10 === 0` refreshes pitcher list. Confirmed working.

### 3. Vásquez Infinite Pull Loop  
**Impact**: "PULL CONFIRMED (stale)" fired every 5s poll cycle after confirmation. Wasted API calls and log spam.  
**Root cause**: `notCurrentSince` entry not deleted after stale confirmation path. Loop re-fired each cycle.  
**Fix**: Added `_pullFired = new Set()` outside while loop. Stale and reliever confirmation paths both call `_pullFired.add(pitcherId)`. Pull detection block gates on `_pullFired.has(pitcherId)`.

### 4. YES Bet on Dead Market — Paddack 2+ (CRITICAL)
**Impact**: ~$940 total loss. Isaiah: ~$667 (16,667c @ 4¢), Adam: ~$275 (9,145c @ 3¢) — placed on Paddack 2+ YES after Paddack pulled at 1K. Immediately settled as losses.  
**Root cause**: In MODE 1 (pulled pitcher), when YES market for 2+ was priced at 1¢ (noMid=99), the illiquid guard caused `continue` to skip MODE 1 but FALL THROUGH to MODE 2 edge detection. Model still showed 60.7% probability (hadn't updated), giving 59.7% edge → system bet $500 each on guaranteed loss.  
**Fix**:  
1. `_pullFired` prevents pull re-detection when already confirmed  
2. New guard at top of `for (const mkt of markets)` loop: if `_pullFired.has(pitcherId) && !isCurrent && n > currentKs` → `rejectReasonByN.set(n, 'pulled_dead'); continue` — blocks ALL bet modes for dead thresholds

### 5. ksFillSync UTC Date Bug
**Impact**: Fill sync misses resting orders placed after midnight ET (midnight UTC = 8pm ET, well within game hours). Orders don't get fill updates.  
**Root cause**: `WHERE bet_date = date('now')` uses SQLite UTC date, but bets stored with ET date. After midnight UTC (8pm ET), fills for today's bets fail to match.  
**Fix**: `syncFillsForBettor(user, todayET)` now accepts ET date parameter; computes ET internally as fallback.

---

## CRITICAL BUGS FIXED

### C1: manageRestingOrder Contract Count Bug
**Status**: Identified — NOT yet fixed  
**Impact**: `manageRestingOrder` uses `bet.bet_size` (USD) instead of computing contracts from `bet_size / (ask_cents / 100)`. Causes incorrect amendment sizing.  
**Location**: `scripts/live/liveMonitor.js` around `manageRestingOrder`  
**TODO**: Fix contracts calculation: `Math.round(bet.bet_size / (askCents / 100))`

### C2: NO Bet False Settlement Between Half-Innings
**Status**: FIXED  
**Root cause**: `if (bet.side === 'NO' && !isCurrent && ...)` used raw `!isCurrent` which triggers between half-innings when pitcher's team is batting. Same bug that YES-dead already had a fix for.  
**Fix**: Added `(_pullConfirmedEarly || _pullConfirmedStale)` requirement to NO-won settlement, matching YES-dead logic.

### C3: ksFillSync UTC Date Bug
**Status**: FIXED (see above)

### C4: gamePulse Boxscore Hydration Missing Pitch Count
**Status**: Identified — NOT yet fixed  
**Impact**: `gamePulse` hydration string lacks `boxscore` — pitch count not available from linescore alone. Pull-risk detection uses pitch count from liveMonitor's direct boxscore fetch, so this is lower priority.  
**Location**: `server/scheduler.js` gamePulse hydration string

### C5: gamePulse minUntil Timezone
**Status**: Identified — NOT yet fixed  
**Impact**: `setHours` uses UTC on Railway servers, not ET. Game scheduling may be off by 4-5h.  
**Location**: `server/scheduler.js` game start time parsing  
**TODO**: Use ET-aware date parsing instead of raw `setHours`

---

## RELIABILITY GAPS

### R1: Kalshi WS Doesn't Resubscribe for Late-Added Pitchers
**Status**: Identified — NOT yet fixed  
**Impact**: Pitchers added after monitor startup (via iteration-10 refresh) don't get Kalshi ticker monitoring. Miss early pull signal from sharp YES mid drops.  
**Location**: `scripts/live/liveMonitor.js` Kalshi ticker IIFE  
**Fix**: Re-subscribe to new pitcher tickers when `allPitcherIds` expands

### R2: liveMonitor Not Started for Non-Game-Hours Redeploys
**Status**: PARTIALLY fixed  
**Current**: Startup check uses 5pm–2am ET time window. Afternoon games (1pm ET) missed.  
**Better fix**: Query `game_pulse` for active games and start if any exist AND haven't reached 'final' phase

### R3: Fill Sync Gap 5pm–8pm ET
**Status**: Identified — NOT yet fixed  
**Impact**: `ksFillSync.js` (server-side) is called from `/api/ks/live` route, but the fill sync cron might not cover early game hours.  
**TODO**: Verify cron schedule extends through 10pm ET

---

## ACCURACY ISSUES

### A1: Hardcoded NB Dispersion
**Status**: Identified — NOT yet fixed  
**Impact**: `strikeoutEdge.js` uses fixed NB dispersion instead of per-pitcher archetype from `archetypeR()` in `strikeout-model.js`. Model over/underestimates variance for outlier pitcher types.  
**TODO**: Import `archetypeR` and pass pitcher-specific r parameter

---

## TIMING ISSUES

### T1: Market Scan Runs After Dead Settlements in Same Cycle
**Status**: FIXED (via `_pullFired` + `pulled_dead` guard)  
**Impact**: When pull is confirmed in cycle N, dead bets settle AND the market scan runs in the same cycle. Without the guards, the scan fires YES bets on dead markets where the model hasn't updated yet.

### T2: Free Money Window — Market Reprices Faster Than 5s Poll
**Status**: Known limitation — NOT fixed  
**Impact**: For pulls that Kalshi's market prices in immediately (e.g., reliever announced on TV), by the time we detect the pull, noMid is already >96 → free money NO bet rejected as illiquid.  
**Mitigation**: Kalshi ticker WS provides early warning. Works when the mid drops sharply before boxscore updates.

---

## FIXES DEPLOYED TONIGHT

| # | Bug | Status | Impact |
|---|-----|--------|--------|
| 1 | liveMonitor not starting on Railway | ✅ Fixed | Critical — zero in-game hedging |
| 2 | Vásquez infinite pull loop | ✅ Fixed | Log spam, wasted API calls |
| 3 | YES bet on Paddack dead market | ✅ Fixed | ~$940 loss prevented going forward |
| 4 | NO bet false settlement (half-inning) | ✅ Fixed | False wins/losses on NO bets |
| 5 | ksFillSync UTC date bug | ✅ Fixed | Late-game fill misses after midnight UTC |
| 6 | Best-case not updating after live buys | ✅ Fixed | Dashboard showed stale best-case post stack-YES |
| 7 | /ks/live-bets missing fill_price/filled_contracts | ✅ Fixed | Best-case calc used estimates not actual fills |
| 8 | liveMonitor startup auto-start | ✅ Fixed | Monitor never started on redeploy |

---

## TONIGHT'S GAME RESULTS (as of deploy)

| Pitcher | Game | Result | Notes |
|---------|------|--------|-------|
| Parker Messick | Final | 9K | Win on 5+/6+ |
| Dylan Cease | Final | 5K | Depends on threshold |
| Jack Leiter | Final | 4K | |
| Max Fried | Final | 5K | |
| Luis Castillo | Final | 3K | |
| Matthew Boyd | Final | 4K | Pulled at 91pc, 4.0 IP |
| Randy Vásquez | Final | 4K | Pulled at 106pc, 5.0 IP |
| Chris Paddack | Out | 1K | Pulled at 67pc, 4.0 IP — COSTLY |
| Anthony Kay | Active | 2K, 4th inn | CWS, 90pc — approaching pull |
| Jack Kochanowicz | Active | 3K, 4th inn | LAA, 35pc — efficient, strong pace |

**Active monitoring**: Kochanowicz (LAA, 3K/35pc) is the key remaining bet. Stack-YES for 5+ already placed. Model 84.7% for 5+. Isaiah deduped, Adam capped at live limit.

---

## BACKLOG (Not Fixed Tonight)

1. **C1**: `manageRestingOrder` contract count bug (uses bet_size USD as contracts)
2. **C4**: gamePulse boxscore hydration missing pitch count data  
3. **C5**: gamePulse `setHours` UTC timezone on Railway  
4. **R1**: Kalshi WS no resubscription for late-added pitchers  
5. **R2**: liveMonitor startup not game-state-aware (afternoon games)  
6. **R3**: Fill sync cron gap 5pm–8pm ET  
7. **A1**: Hardcoded NB dispersion in strikeoutEdge.js  

---

*Report generated: 2026-04-27 ~03:50 UTC*  
*Session: Overnight audit and watch while user slept*
