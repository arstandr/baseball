# Layer 6 Gateway — V1 Deploy Manifest

**Locked: 2026-04-30**
**Mode:** Production (NO shadow phase — operator-accepted beta posture)
**Cutover from spec §10 prereqs:** modified — see §"Risk acceptances" below.

---

## Locked V1 config

```
max_order_usd_by_mode = { pregame_model: 125 }
daily_loss_limit_by_account = { adam: 400, isaiah: 400 }
```

**Edge basis:** 10-day backtest (2026-04-20 → 04-30, 418 attributable bets):
- 39 bets blocked (5.5% of placed)
- $1,377 sum-of-losing-pnl blocked (saved)
- $451 sum-of-winning-pnl blocked (cost)
- **Net saved: $926**
- Daily-loss tripwire didn't fire above $300/account in this sample — $400 is a defensive floor, not the active edge

**Active edge:** the per-bet pregame cap. José Soriano blocked 5× across 2 days, –$392 of that was real losses. Same-pitcher correlated oversized exposure caught.

---

## Required Railway env vars

Set BEFORE first deploy. Boot fails fast (no partial-up) without these.

```
GATEWAY_MODE=production
GATEWAY_ADMIN_SECRET=<generate via: openssl rand -hex 32>
GATEWAY_SECRET_CLOSER_LEGACY=<generate via: openssl rand -hex 32>
COMMIT_HASH=<auto-set by Railway or via `railway variables set COMMIT_SHA=$(git rev-parse --short HEAD)`>

# Account credentials — already set in production for live trading
KALSHI_ADAM_KEY_ID=<existing>
KALSHI_ADAM_PRIVATE_KEY_PEM=<existing>
KALSHI_ISAIAH_KEY_ID=<existing>
KALSHI_ISAIAH_PRIVATE_KEY_PEM=<existing>

# Optional Discord webhook for daily backtest alerts
GATEWAY_DAILY_BACKTEST_WEBHOOK_URL=<adam's discord webhook>
```

---

## Persistent volume requirement

Production mode requires `/data/oracle/dead-letter` to be writable AND survive container restarts. **Deploy will fail readiness if not.**

**Steps in Railway dashboard:**
1. Service → Volumes → Add Volume
2. Mount path: `/data`
3. Size: 5GB (overkill for JSONL files; cheap)

---

## Pre-deploy SQL (run once on production Turso)

```sql
-- Seed gateway_accounts with the two operating accounts.
-- The kalshi_credential_ref points to the env var prefix the composer reads.
INSERT INTO gateway_accounts
  (account_id, display_name, kalshi_credential_ref, enabled,
   daily_loss_limit_usd, daily_risk_limit_usd, created_at, updated_at)
VALUES
  ('adam',   'Adam',   'KALSHI_ADAM',   1, 400, NULL, datetime('now'), datetime('now')),
  ('isaiah', 'Isaiah', 'KALSHI_ISAIAH', 1, 400, NULL, datetime('now'), datetime('now'));

-- Seed the locked killswitch values.
INSERT INTO gateway_killswitch (key, value, updated_at, updated_by) VALUES
  ('max_order_usd_by_mode',       '{"pregame_model":125}',         datetime('now'), 'v1-deploy'),
  ('daily_loss_limit_by_account', '{"adam":400,"isaiah":400}',     datetime('now'), 'v1-deploy'),
  ('gateway_kill_all',            'false',                          datetime('now'), 'v1-deploy');
```

The schema migration is already applied (per `migrateGatewaySchema.js` + `migrateGatewayClientOrderId.js`).

---

## Pre-deploy verification (local first)

```
# 1. Backtest with locked V1 config — confirm baseline numbers
node scripts/oracle/backtestGateway.js --config sweep-400

# 2. Account state updater — runs once and seeds today's row
node scripts/oracle/seedGatewayAccountDailyState.js

# 3. Daily backtest cron — runs once for yesterday
node scripts/oracle/dailyBacktestCron.js

# 4. Full Layer 6 test suite — sanity that nothing regressed
for t in oracleGatewayEnumsTest oracleGatewayHmacTest oracleGatewayValidatorTest \
         oracleGatewayOrchestratorTest oracleGatewayDataPlaneTest \
         oracleGatewayInProcessTest oracleGatewayKalshiClientTest \
         oracleGatewayRouteTest oracleGatewayBuildTest \
         oracleGatewayIntegrationTest oracleGatewayReconcilerTest; do
  node scripts/tests/$t.js | tail -1
done
```

---

## Deploy procedure

```
cd ~/Documents/projects/baseball
railway variables set COMMIT_SHA=$(git rev-parse --short HEAD)
railway up --detach
```

Watch Railway logs for the boot banner — if the readiness gate fails it'll throw with a specific reason and exit. Required line:

```
════════════════════════════════════════
  Gateway initialized
  mode=production
  accountsLoaded=2
  routesMounted=true
  productionWrites=true
  commit=<sha>
  persistentVolume=ok
════════════════════════════════════════
```

If `persistentVolume=NOT_OK`, the volume isn't mounted — fix before traffic.
If `productionWrites=true` but `accountsLoaded=0`, the SQL seed didn't run.

---

## Post-deploy verification

```
# Healthz returns 200 with mode=production, halted=false
curl -sS https://<railway-url>/gateway/healthz | jq

# Killswitch values in DB
node -e "import('./lib/db.js').then(async db => {
  const r = await db.all('SELECT key, value FROM gateway_killswitch')
  console.log(JSON.stringify(r, null, 2))
})"

# Account state should populate within 1 minute (cron runs every minute)
node -e "import('./lib/db.js').then(async db => {
  const r = await db.all('SELECT * FROM gateway_account_daily_state')
  console.log(JSON.stringify(r, null, 2))
})"
```

---

## What happens on deploy day 1

| component | live? | traffic? |
|---|---|---|
| `/gateway/place` HTTP route | YES | NO — Closer not yet wired |
| Reconciler cron (15s) | YES | NO — no `exchange_unknown` rows yet |
| Account-state-seeder cron (1min) | YES | YES — populates state for any active accounts |
| Daily backtest cron (6am ET) | YES | YES — runs against ks_bets |
| Killswitch admin endpoints | YES | YES — operator can adjust without redeploy |
| Healthz | YES | YES — Railway probes this |

**Closer / liveMonitor / ksBets continue placing direct.** Gateway is deployed but receives no real bets until the Closer-wiring bite lands. Account state is maintained passively via the seeder cron.

This is the user-accepted deferred path. The Closer wiring bite is tracked separately and will route the existing 7+ `placeOrder` call sites in `liveMonitor.js` + `ksBets.js` through `/gateway/place`.

---

## Risk acceptances (modified from spec §10)

The user has explicitly opted to:

1. **Skip the 14-day shadow validation period.** Rationale: "this whole thing is one beta project anyway." Old system continues running; comparison to "what we used to do" is the historical `ks_bets` baseline.
2. **Deploy to production mode immediately** rather than `GATEWAY_MODE=shadow` first.
3. **Defer Closer wiring** — Gateway deployed with no traffic on day 1; wiring lands as a separate iteration.

What this means:
- The first time real Gateway traffic flows will be when Closer is wired. There is no "Gateway proves itself in shadow first" phase.
- A bug in the validator that rejects valid bets would block ALL placements once Closer is wired. Mitigation: Closer wiring includes a fallback (described in its own bite).
- The 1049 tests we've written are mostly unit/integration — production-traffic edge cases will surface for the first time post-Closer-wiring.

---

## Rollback procedure

If Gateway misbehaves after Closer is wired:

1. **Operator killswitch (fastest, no redeploy)**:
   ```
   POST /gateway/admin/killswitch
   body: { "key": "gateway_kill_all", "value": "true", "updated_by": "operator" }
   ```
   This rejects every Gateway request with `KILLSWITCH_ALL`. Closer falls back to direct placement (per the wiring's safety design).

2. **Code rollback**: `railway up --detach` from a prior commit.

3. **Last-resort: revert Closer to direct-only**: change `GATEWAY_BYPASS=true` env var (documented in the Closer-wiring bite).

There is no `GATEWAY_DISABLED` env var to disable the Gateway routes themselves — the spec deliberately removed that escape hatch. Killing via killswitch is the documented path.

---

## What's next (sequence)

1. ✅ This deploy doc
2. ✅ Account state updater + cron
3. ✅ Daily backtest cron
4. ⏳ **DEPLOY** — Railway env vars + SQL seed + `railway up --detach`
5. ⏳ Verify boot banner + healthz + killswitch reads
6. ⏳ Closer wiring bite — route 7+ existing `placeOrder` calls through Gateway
7. ⏳ Observe daily backtest reports + Gateway Trace events for ≥7 days
8. ⏳ V1.1 tuning (config adjustments based on real traffic)
9. ⏳ V2 prereqs (per spec §10): persistent volume verified active, chaos test passing, cancel/amend wired

---

## Daily backtest cron — what to watch in Discord

The cron runs every morning at 6am ET against yesterday's pre-game bets. **Discord posts only on material change** (per `MATERIAL_CHANGE_THRESHOLDS` in `dailyBacktestCron.js`):

- Reject count delta ≥ 3 vs prior day
- Net saved swung ≥ $200
- A new `reject_reason` appeared
- Any `ACCOUNT_DAILY_LOSS_BREACHED` triggered (the trip-wire fired)

A post like this is a real signal worth investigating:

> Gateway daily backtest — 2026-05-12
> accepted=21  rejected=8  net_saved=$420  loss_breaches=1
> change reasons: daily_loss_breaches:1, new_reject_reasons:ACCOUNT_DAILY_LOSS_BREACHED
> reasons: ORDER_USD_OVER_LIMIT=7, ACCOUNT_DAILY_LOSS_BREACHED=1

A silent day means yesterday was within normal envelope — Gateway working as expected.
