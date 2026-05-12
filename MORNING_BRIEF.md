# Morning Brief — Multi-User Implementation
**Completed overnight · Deployed to Railway**

---

## What Was Done

### Phase 0 — Pre-flight audit
Full grep across 155 JS files. Found 8 places with `id != 1` hardcodes, one critical loss-limit cancel bug in liveMonitor, and confirmed liveMonitor's `activeBettors` loop was already multi-user capable.

---

### Phase 1 — Schema migrations (`db/schema.sql`)
Two new columns added to `users` (safe ALTER TABLE no-ops on existing DBs):
- `is_system_admin INTEGER DEFAULT 0` — replaces the hardcoded `id != 1` filter everywhere
- `daily_loss_limit REAL DEFAULT NULL` — per-user loss cap (falls back to global env var)

New table added:
- `user_betting_rules (user_id, key, value)` — per-user overrides that shadow global `betting_rules`

---

### Phase 2 — id != 1 → is_system_admin = 0 (8 files)
**Replaced in:**
- `server/sse.js:89,99`
- `server/wsDaemon.js:15`
- `server/routes/ks-analytics.js:126,307`
- `scripts/live/wsFillSync.js:19`
- `scripts/live/syncFills.js:25`
- `scripts/live/liveMonitor.js:2643` (end-of-day cancel)
- `scripts/live/ksBets.js:1329` (cancel-all mode)

**Impact:** New users (id=3, 4, 5…) now appear correctly in all bettor lists. Before, only `id != 1` was excluded — Adam's admin status is now explicit via `is_system_admin=1`.

**Also fixed (critical bug):** `liveMonitor.js` loss-limit cancel was using `creds = {}` which only cancelled the env-var user's Kalshi orders when the daily loss limit was hit. Now loops all `activeBettors` with per-user credentials.

---

### Phase 3 — Per-user closer heartbeat (`scripts/closer/launcher.js`, `server/routes/users.js`)
**Launcher:** Reads `BETTOR_USER_ID` env var. If set, writes heartbeat to `closer_<id>` (e.g. `closer_2`). Falls back to `closer` for single-user/legacy mode.

**Server route:** `/api/agent/status` now queries `key LIKE 'closer%'` and returns an `agents` array with one card per running agent. Legacy fields (`heartbeat`, `is_current`) still present for backward compat.

**Action required (Windows):** Each person who runs The Closer needs to add `BETTOR_USER_ID=<their_user_id>` to their `.env` file (or bat file). Isaiah's ID is 2, so `BETTOR_USER_ID=2`. Without it, both agents would write to the same `closer` key and overwrite each other.

---

### Phase 4 — Per-user betting rules (`lib/bettingRules.js`)
**Changed signatures:**
- `getRules(userId?)` — when userId provided, merges `user_betting_rules` overrides on top of global `betting_rules`. Global-only when userId is null/undefined.
- `setRule(key, value, updatedBy, userId?)` — writes to `user_betting_rules` when userId provided, global `betting_rules` otherwise.
- `invalidateCache(userId?)` — clears only the specified user's cache, or everything if null.
- `getAllRules(userId?)` — same merge logic, with `user_override: true` flag for UI display.

**Impact:** All existing callers still work (getRules() with no arg = global as before). Per-user rules are additive on top.

---

### Phase 5 — ksBets.js per-user
Already largely multi-user capable. The one `id != 1` in cancel-all mode was fixed in Phase 2. The bettor loop (lines 400+) already iterates all `active_bettor=1` users with per-user bankroll and Kalshi credentials. No structural changes needed.

---

### Phase 6 — liveMonitor.js per-user
**Two changes:**

1. **Per-user daily loss check** (in bettor loop at ~line 2550):
   ```
   Before: Global LOSS_LIMIT would halt ALL trading when combined loss hit $500.
   After:  Each bettor is checked individually against bettor.daily_loss_limit ?? LOSS_LIMIT
           before placing. A user who hits their personal cap is skipped; others continue.
   ```
   New helper: `getUserDailyLoss(userId)` queries balance_snapshots vs current kalshi_balance per-user.

2. **Loss-limit cancel bug** (fixed in Phase 2 — listed here for clarity):
   The global halt now cancels orders for each live bettor with their own creds.

---

### Phase 7 — Scheduler (no changes needed)
The scheduler correctly spawns `ksBets.js` which already loops all bettors. liveMonitor is managed by The Closer, not the scheduler. Multi-user ready as-is.

---

### Phase 8 — Admin onboarding UI (`server/routes/users.js`, `public/app/views/settings.js`)
**Route security added:**
- `POST /api/users` — now requires `is_system_admin=1`
- `PUT /api/users/:id` — requires admin OR self (users can change own PIN)
- `DELETE /api/users/:name` — requires admin; now soft-deletes (zeros creds, deactivates) instead of hard-deleting to preserve P&L history

**Settings UI additions (Edit form for each user):**
- Daily Loss Limit field (`$, leave blank = system default`)
- Closer Agent hint: shows `BETTOR_USER_ID=<id>` to configure the Windows .env

**GET /api/users** now returns `daily_loss_limit` and `is_system_admin` fields.

---

## Smoke Test Results

28 tests, 28 passed, 0 failed.

**Covered:**
1. bettingRules.js signatures (3 tests)
2. Schema + is_system_admin filtering (5 tests)
3. Per-user rule overrides and cache (6 tests)
4. Static grep — no `id != 1` remaining in 155 JS files (2 tests)
5. Closer heartbeat key routing (5 tests)
6. Per-user daily loss limit (4 tests)
7. seedUsersFromEnv admin marking (2 tests)
8. Soft-delete behavior (2 tests)
9. Loss-limit cancel bug fix (2 tests — bonus, caught by source grep)

Run again anytime: `node scripts/smokeTestMultiUser.js`

---

## How to Add a New User (Right Now, No Redeploy Needed)

1. Log in to the dashboard as Adam (admin)
2. Go to Settings → Users
3. Click "Add User" — enter name + PIN
4. Click Edit on the new user row
5. Set: Active Bettor ✓, Mode = Paper first, Starting Bankroll, paste Kalshi Key ID + PEM, Discord webhook
6. Save
7. The next morning pipeline will include them automatically

To go live: flip Mode from Paper → Live in the Edit form.

---

## Manual Action Required (Windows)

**BETTOR_USER_ID in each closer's .env:**

Each person running The Closer needs to add to their Windows `.env` (or bat file):
```
BETTOR_USER_ID=2   # Isaiah = 2, a new user 3 would put BETTOR_USER_ID=3
```
Without this, both closers write to the same `closer` heartbeat key and overwrite each other. Your existing setup (no BETTOR_USER_ID set) will continue to work as `key=closer` — backward compatible.

---

## Files Changed

| File | Change |
|------|--------|
| `db/schema.sql` | +`is_system_admin`, +`daily_loss_limit` on users; +`user_betting_rules` table |
| `server/auth.js` | `seedUsersFromEnv()` marks USER1 as `is_system_admin=1` |
| `server/sse.js` | `id != 1` → `is_system_admin = 0` (2 places) |
| `server/wsDaemon.js` | `id != 1` → `is_system_admin = 0` |
| `server/routes/ks-analytics.js` | `id != 1` → `is_system_admin = 0` (2 places) |
| `server/routes/users.js` | Admin guards on POST/PUT/DELETE; soft-delete; `agents` array on `/agent/status`; exposes `daily_loss_limit`, `is_system_admin` |
| `lib/bettingRules.js` | `getRules/setRule/resetRule/invalidateCache/getAllRules` all accept `userId`; per-user cache Map |
| `scripts/live/ksBets.js` | `id != 1` → `is_system_admin = 0` in cancel-all |
| `scripts/live/liveMonitor.js` | `id != 1` → `is_system_admin = 0` (end-of-day cancel); loss-limit cancel loops activeBettors; `getUserDailyLoss()`; per-user daily loss check in bettor loop |
| `scripts/live/wsFillSync.js` | `id != 1` → `is_system_admin = 0` |
| `scripts/live/syncFills.js` | `id != 1` → `is_system_admin = 0` |
| `scripts/closer/launcher.js` | `BETTOR_USER_ID` env var; `_HB_KEY = closer_<id>` or `closer` |
| `public/app/views/settings.js` | Daily loss limit field; Closer Agent `BETTOR_USER_ID` hint |

---

## What's Left (Future Work, Not Blocking)

1. **Per-user edge filtering** — rules like `yes_max_strike` apply to the global market analysis pass. User-specific rules shadow the global values but only affect liveMonitor's in-game bet placement, not the morning ksBets edge-filtering that builds `daily_plan`. Would require restructuring the bettor loop to run edge filtering per-user. Low priority.

2. **Dashboard agent status UI** — the `/api/agent/status` response now has an `agents` array but the dashboard still renders only the primary heartbeat. A future tweak would show one card per agent.

3. **Per-user model calibration** — calibration weights are global. If user 3 gets different fill rates (different Kalshi tier), that slowly degrades the shared calibration. Non-issue at 3-5 users; add user-scoped calibration if/when needed.
