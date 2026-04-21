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
for arg in "$@"; do
  if [ "$arg" = "--lineups" ]; then LINEUPS_MODE=true
  elif [[ "$arg" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then DATE="$arg"
  fi
done
DATE=${DATE:-$(date +%Y-%m-%d)}

cd "$(dirname "$0")/../.."

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
echo " Re-run with --lineups after ~3-4 PM ET:"
echo "   bash scripts/live/dailyRun.sh --lineups $DATE"
echo " Run 'node scripts/live/ksBets.js report' for P&L."
echo ""
echo " Live monitor (paper trade by default):"
echo "   node scripts/live/liveMonitor.js --date $DATE"
echo " To go live: set LIVE_TRADING=true in .env first."
echo "════════════════════════════════════════"
