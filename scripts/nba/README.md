# NBA Scripts — Isolation Contract

These scripts share the same process and database as the MLB pipeline but are
a **conceptually separate product**. The following rules keep them isolated:

## What is shared (intentional)
- `lib/db.js` — same SQLite database file
- `lib/kalshi.js` — Kalshi API client (same account)
- `lib/kelly.js` — Kelly sizing
- `lib/discord.js` — notifications
- `lib/cli-args.js` — argument parsing

## What is NOT shared
- No imports from `scripts/live/` (MLB live monitor, edge finder, ksBets)
- No imports from `agents/` (MLB-specific signal agents)
- No writes to MLB-specific tables (`games`, `pitchers`, `projections`, etc.)

## DB namespace rules
- NBA-only tables use the `nba_` prefix: `nba_games`, `nba_team_stats`,
  `nba_player_3pt_stats`, `nba_opp_3pt_defense`, `nba_ref_assignments`
- Bets land in the shared `ks_bets` table, tagged with `model='nba_totals'`
  or `model='nba_3pt'` — all queries must include this filter
- Analytics routes (`/api/ks/stats`, `/api/ks/bets`, etc.) filter by
  `paper=0` and optionally `model` — NBA rows are excluded from MLB views
  as long as the model tag is set correctly

## Run order
```
node scripts/nba/fetchNBASchedule.js   # populate nba_games
node scripts/nba/fetchNBATeamStats.js  # populate nba_team_stats
node scripts/nba/nbaTotalsEdge.js      # compute edges
node scripts/nba/nbaBets.js log        # log + place bets
node scripts/nba/nbaBets.js settle     # settle after games finish
```
