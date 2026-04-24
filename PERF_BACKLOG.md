# MLBIE Performance & Refactor Backlog

> Last updated: 2026-04-24
> All items complete. ✅

---

## P0 — Correctness / Reliability ✅

### ✅ WS fill daemon integrated into server process
### ✅ `ks_bets` DDL moved to schema.sql

---

## P2 — Maintainability / Refactor ✅

### ✅ `server/api.js` god-file split (was 2,451 lines → now 30-line shim)
### ✅ `public/app.js` god-file split (was 3,259 lines → now ~230-line boot entry)

### ✅ `scripts/live/liveMonitor.js` — Kelly logic
Already imported from `lib/kelly.js`. No inline duplication existed.

### ✅ `scripts/live/strikeoutEdge.js` — venue/dome data deduplication
Removed 40-line inline `VENUE_COORDS` map + `DOME_TEAMS` set. Now derived
from `agents/park/venues.js` (the existing single source of truth for
lat/lng and roof_type). Aliases handled via flatMap.

### ✅ `scripts/nba/` — isolation verified + documented
Isolation already structurally sound: `nba_` table prefix, `model=` tag in
`ks_bets`, no cross-imports with `scripts/live/`. Added `scripts/nba/README.md`
documenting the contract.

---

## P3 — Future-proofing ✅

### ✅ Pagination / SQL pushdown on `/api/ks/stats` and `/api/ks/edge-breakdown`
- `/ks/stats`: 3 parallel SQL queries — aggregate scalars (wins, losses, pnl,
  wagered, expected_wins, avg_edge, winning_days) all in SQL. JS sequential
  loop reduced to `(pnl, result)` tuples only for drawdown + streak.
- `/ks/edge-breakdown`: 3 parallel GROUP BY queries replace full table scan
  + JS bucketing entirely.

### ✅ `lib/http.js` wrapper — MLB Stats API consolidated
Added `mlbGet(url, { params })` to `lib/mlb-live.js` — wraps `lib/http.js`
with retry + circuit breaker under the `'mlb-stats'` breaker key (8s timeout).
Updated `liveMonitor.js`, `ksBets.js`, `strikeoutEdge.js` to use `mlbGet`
instead of raw `axios.get` for all MLB Stats API calls. `axios` import
removed from `ksBets.js`; kept in `liveMonitor.js` and `strikeoutEdge.js`
for their respective Kalshi auth fetches.

### ✅ Python model persistent subprocess pool
- `predict.py`: `--daemon <model_dir>` mode loads model once, then loops
  on NDJSON stdin → NDJSON stdout. Emits `READY` on stderr when model loaded.
- `lib/model.js`: `predict()` defaults to daemon mode. Persistent child
  process cached per model dir; promise chain serializes all calls.
  One-shot spawn preserved via `{ daemon: false }` for batch scripts.
  Eliminates 50-200ms per-prediction spawn latency in live pipeline.

### ✅ `requirements.txt` Python deps pinned
Exact versions frozen from training environment:
xgboost==2.1.3, scikit-learn==1.6.1, pandas==2.3.3, numpy==2.0.2,
joblib==1.5.3, shap==0.49.1, cryptography==43.0.3
