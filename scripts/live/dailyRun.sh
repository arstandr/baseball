#!/bin/bash
# scripts/live/dailyRun.sh — Full morning pipeline for strikeout edge finding.
#
# Run this each morning after 9am ET when Kalshi markets open.
# Takes ~60 seconds total.
#
# Usage:
#   bash scripts/live/dailyRun.sh [YYYY-MM-DD]
#
# Steps:
#   1. Fetch schedule for today + tomorrow (probables, game times)
#   2. Refresh Baseball Savant pitcher Statcast data
#   3. Refresh live 2026 team K% platoon splits (fallback if lineups not posted)
#   4. Fetch per-start BF + pitch count for today's starters (leash model)
#   5. Run edge finder and print results (uses BF-based λ, team K% fallback)
#   6. Log any edges ≥5¢ to ks_bets table for tracking
#
# Run again after lineups post (~3-4 PM ET for evening games):
#   bash scripts/live/dailyRun.sh --lineups [YYYY-MM-DD]
#   → fetches official lineup K% and re-runs edge finder with actual 9-man lineups

set -e

LINEUPS_MODE=false
MIDDAY_MODE=false
DATE=""
SETTLE_MODE=false
for arg in "$@"; do
  if [ "$arg" = "--lineups" ]; then LINEUPS_MODE=true
  elif [ "$arg" = "--midday" ]; then MIDDAY_MODE=true
  elif [ "$arg" = "--settle" ]; then SETTLE_MODE=true
  elif [[ "$arg" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then DATE="$arg"
  fi
done
DATE=${DATE:-$(date +%Y-%m-%d)}

cd "$(dirname "$0")/../.."

# --settle: settle bets + run EOD report (run this after games are done ~midnight ET)
if [ "$SETTLE_MODE" = true ]; then
  echo "════════════════════════════════════════"
  echo " MLBIE End of Day — $DATE"
  echo "════════════════════════════════════════"

  echo ""
  echo "── Pre-settle fill sync ──"
  node scripts/live/syncFills.js --date "$DATE" || true

  echo ""
  echo "── Settle bets ──"
  node scripts/live/ksBets.js settle --date "$DATE"

  echo ""
  echo "── EOD report (Claude analysis → Discord) ──"
  node scripts/live/eodReport.js --date "$DATE"

  echo ""
  echo "════════════════════════════════════════"
  echo " EOD done."
  echo "════════════════════════════════════════"
  exit 0
fi

if [ "$MIDDAY_MODE" = true ]; then
  echo "════════════════════════════════════════"
  echo " MLBIE Midday Re-scan — $DATE"
  echo "════════════════════════════════════════"

  echo ""
  echo "── Fill rate on morning orders ──"
  node -e "
    import('../../lib/db.js').then(async db => {
      const rows = await db.all(
        \`SELECT order_status, COUNT(*) as n FROM ks_bets
          WHERE bet_date=? AND live_bet=0 AND order_status IS NOT NULL
          GROUP BY order_status\`,
        ['$DATE']
      )
      const total = rows.reduce((s, r) => s + Number(r.n), 0)
      rows.forEach(r => console.log(\`  \${r.order_status}: \${r.n}/\${total} (\${(r.n/total*100).toFixed(0)}%)\`))
      process.exit(0)
    }).catch(e => { console.error(e.message); process.exit(1) })
  "

  echo ""
  echo "── Sync Kalshi fills ──"
  node scripts/live/syncFills.js --date "$DATE" || true

  echo ""
  echo "── Refresh recent starts (updated pitch counts) ──"
  node scripts/live/fetchPitcherRecentStarts.js --date "$DATE"

  echo ""
  echo "── Re-run edge finder with current market prices ──"
  node scripts/live/strikeoutEdge.js --date "$DATE" --json

  echo ""
  echo "── Log any new edges (dedup skips existing orders) ──"
  node scripts/live/ksBets.js log --date "$DATE"

  echo ""
  echo "════════════════════════════════════════"
  echo " Midday re-scan done."
  echo "════════════════════════════════════════"
  exit 0
fi

if [ "$LINEUPS_MODE" = true ]; then
  echo "════════════════════════════════════════"
  echo " MLBIE Lineup Refresh — $DATE"
  echo "════════════════════════════════════════"

  echo ""
  echo "── Fetch official lineups ──"
  node scripts/live/fetchLineups.js --date "$DATE"

  echo ""
  echo "── Refresh DK/FD K prop lines (updated market signal) ──"
  node scripts/live/fetchKProps.js --date "$DATE" || true

  echo ""
  echo "── Re-run edge finder with lineup K% ──"
  node scripts/live/strikeoutEdge.js --date "$DATE" --json
  # NOTE: do NOT call ksBets.js log here — all bets go through the T-2.5h schedule.
  # firePendingBets() polls every 5 min and will pick up the updated lineup data.

  echo ""
  echo "── Re-run F5 XGBoost pipeline with official lineups ──"
  node cli.js signal --date "$DATE"
  node cli.js trade --date "$DATE"

  echo ""
  echo "════════════════════════════════════════"
  echo " Lineup refresh done."
  echo "════════════════════════════════════════"
  exit 0
fi

echo "════════════════════════════════════════"
echo " MLBIE Daily Run — $DATE"
echo "════════════════════════════════════════"

echo ""
echo "── 1. Schedule ──"
node scripts/live/fetchSchedule.js --date "$DATE" --days 2

echo ""
echo "── 2. Pitcher Statcast (Baseball Savant) ──"
node scripts/live/fetchPitcherStatcast.js
# Backfill prior seasons if missing (runs fast, idempotent — skips if data already exists)
PRIOR_YEAR=$(( $(date +%Y) - 1 ))
PRIOR_COUNT=$(node -e "
  import('../../lib/db.js').then(db =>
    db.one('SELECT COUNT(*) as n FROM pitcher_statcast WHERE season = ?', [$PRIOR_YEAR])
      .then(r => { console.log(r?.n || 0); process.exit(0) })
  ).catch(() => { console.log(0); process.exit(0) })
" 2>/dev/null || echo 0)
if [ "$PRIOR_COUNT" -lt 100 ] 2>/dev/null; then
  echo "[statcast] backfilling prior seasons..."
  node scripts/live/fetchPitcherStatcast.js --season $(( PRIOR_YEAR - 1 )) || true
  node scripts/live/fetchPitcherStatcast.js --season $PRIOR_YEAR || true
fi

echo ""
echo "── 2b. Patch statcast gaps for today's starters ──"
node scripts/live/patchStarterStatcast.js --date "$DATE"

echo ""
echo "── 3. Team K% splits (live 2026) ──"
node scripts/live/fetchTeamKpct.js

echo ""
echo "── 4. Pitcher recent starts (BF + pitch count) ──"
node scripts/live/fetchPitcherRecentStarts.js --date "$DATE"

echo ""
echo "── 5. DK/FD pitcher K prop lines (sharp market signal for preflight) ──"
node scripts/live/fetchKProps.js --date "$DATE" || true

echo ""
echo "── 6. Edge finder (lineup fallback: team K%) ──"
node scripts/live/strikeoutEdge.js --date "$DATE" --json

echo ""
echo "── 7. Build bet schedule (bets fire at T-2.5h via polling job) ──"
node scripts/live/ksBets.js build-schedule --date "$DATE"

echo ""
echo "── 7b. Sync initial Kalshi fills ──"
node scripts/live/syncFills.js --date "$DATE" || true

echo ""
echo "── 8. Snapshot Kalshi F5 opening prices ──"
node scripts/live/collectF5Lines.js --date "$DATE" || true

echo ""
echo "── 9. F5 XGBoost pipeline: fetch games + run agents + judge ──"
node cli.js fetch --date "$DATE"
node cli.js signal --date "$DATE"
node cli.js trade --date "$DATE"

echo ""
echo "════════════════════════════════════════"
echo " Morning run done."
echo ""
echo " After lineups post (~3-4 PM ET):"
echo "   bash scripts/live/dailyRun.sh --lineups $DATE"
echo ""
echo " After games finish (~midnight ET):"
echo "   bash scripts/live/dailyRun.sh --settle $DATE"
echo "   → Settles all bets + sends Claude EOD report to Discord"
echo ""
echo " Live monitor (paper trade by default):"
echo "   node scripts/live/liveMonitor.js --date $DATE"
echo " To go live: set LIVE_TRADING=true in .env first."
echo "════════════════════════════════════════"
