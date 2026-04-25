// scripts/live/syncSettlements.js — Rebuild daily_pnl_events from Kalshi API for all active bettors.
//
// Called from dailyRun.sh --settle (after ksBets.js settle) so that daily_pnl_events
// is authoritative before eodReport.js reads it and before the next SSE poll.
//
// Uses forceSync (bypasses the 60s rate-limit guard) because this runs once nightly.
//
// Usage:
//   node scripts/live/syncSettlements.js

import 'dotenv/config'
import * as db from '../../lib/db.js'
import { forceSync } from '../../lib/ksSettlementSync.js'

async function main() {
  await db.migrate()

  const bettors = await db.all(
    `SELECT id, name, kalshi_key_id, kalshi_private_key
     FROM users
     WHERE kalshi_key_id IS NOT NULL AND kalshi_private_key IS NOT NULL
     ORDER BY id`,
  )

  if (!bettors.length) {
    console.log('[sync-settlements] No users with Kalshi credentials')
    await db.close()
    return
  }

  for (const u of bettors) {
    console.log(`[sync-settlements] ${u.name}: rebuilding daily_pnl_events…`)
    try {
      const r = await forceSync(u)
      if (r) {
        console.log(`[sync-settlements] ${u.name}: kalshi_pnl=$${r.kalshiPnl} updated=${r.updated} settlements=${r.totalSettlements}`)
      } else {
        console.log(`[sync-settlements] ${u.name}: no settlements returned (no active positions?)`)
      }
    } catch (err) {
      console.error(`[sync-settlements] ${u.name}: ERROR — ${err.message}`)
    }
  }

  console.log('[sync-settlements] Done')
  await db.close()
}

main().catch(err => {
  console.error('[sync-settlements] fatal:', err.message)
  process.exit(1)
})
