#!/bin/bash
# scripts/nba/nbaRun.sh — NBA game totals daily pipeline.
#
# Usage:
#   bash scripts/nba/nbaRun.sh [YYYY-MM-DD]           # morning run
#   bash scripts/nba/nbaRun.sh --settle [YYYY-MM-DD]  # settle + EOD

set -e

SETTLE_MODE=false
DATE=""
for arg in "$@"; do
  if [ "$arg" = "--settle" ]; then SETTLE_MODE=true
  elif [[ "$arg" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then DATE="$arg"
  fi
done
DATE=${DATE:-$(date +%Y-%m-%d)}

cd "$(dirname "$0")/../.."

if [ "$SETTLE_MODE" = true ]; then
  echo "════════════════════════════════════════"
  echo " NBA Totals — Settle ${DATE}"
  echo "════════════════════════════════════════"
  node scripts/nba/nbaBets.js settle --date "$DATE"
  exit 0
fi

echo "════════════════════════════════════════"
echo " NBA Totals — Morning Run ${DATE}"
echo "════════════════════════════════════════"

echo ""
echo "── 1. Fetch NBA schedule from Kalshi ──"
node scripts/nba/fetchNBASchedule.js --date "$DATE"

echo ""
echo "── 2. Fetch team ratings (OffRtg / DefRtg / Pace) ──"
node scripts/nba/fetchNBATeamStats.js --date "$DATE"

echo ""
echo "── 3. Fetch referee assignments ──"
node scripts/nba/fetchNBARefs.js --date "$DATE" || true

echo ""
echo "── 4. Fetch player 3PT stats ──"
node scripts/nba/fetchNBA3PTStats.js --date "$DATE" || true

echo ""
echo "── 5. Find edges (totals + 3PT) and log bets ──"
node scripts/nba/nbaBets.js log --date "$DATE"

echo ""
echo "── 6. 3PT edge scan ──"
node scripts/nba/nba3PTEdge.js --date "$DATE"

echo ""
echo "════════════════════════════════════════"
echo " NBA morning run done."
echo "════════════════════════════════════════"
