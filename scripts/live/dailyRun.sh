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
DATE=""
SETTLE_MODE=false
for arg in "$@"; do
  if [ "$arg" = "--lineups" ]; then LINEUPS_MODE=true
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

if [ "$LINEUPS_MODE" = true ]; then
  echo "════════════════════════════════════════"
  echo " MLBIE Lineup Refresh — $DATE"
  echo "════════════════════════════════════════"

  echo ""
  echo "── Fetch official lineups ──"
  node scripts/live/fetchLineups.js --date "$DATE"

  echo ""
  echo "── Re-run edge finder with lineup K% ──"
  node scripts/live/strikeoutEdge.js --date "$DATE" --json

  echo ""
  echo "── Update ks_bets with refined edges ──"
  node scripts/live/ksBets.js log --date "$DATE"

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

echo ""
echo "── 3. Team K% splits (live 2026) ──"
node scripts/live/fetchTeamKpct.js

echo ""
echo "── 4. Pitcher recent starts (BF + pitch count) ──"
node scripts/live/fetchPitcherRecentStarts.js --date "$DATE"

echo ""
echo "── 5. Edge finder (lineup fallback: team K%) ──"
node scripts/live/strikeoutEdge.js --date "$DATE" --json

echo ""
echo "── 6. Log edges to ks_bets ──"
node scripts/live/ksBets.js log --date "$DATE"

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
