// scripts/oracle/traceOrphanInjectionTest.js
//
// TRACE-ORPHAN INJECTION TEST — proves the trace-match watchdog actually
// halts trading when a real-money ks_bets row appears with no matching
// oracle_bet_traces row. This is the worst-possible state pre-launch
// (uncategorized risk on a real Kalshi position).
//
// HOW IT WORKS:
//   1. Insert a fake ks_bets row matching the watchdog's criteria:
//        bet_date         = today (ET)
//        live_bet         = 0
//        order_id         = 'real-uuid-fake-test-001' (looks real, NOT 'paper-')
//        strategy_mode    = 'pregame_inversion'
//        strategy_submode = NULL (so it isn't excluded)
//        pitcher_id       = '99999999'
//        logged_at        = 11 seconds ago (past 10s grace, within 30 min)
//        pitcher_name     = 'TEST_INJECTION'
//      No matching oracle_bet_traces row is inserted.
//   2. Wait ~65 seconds for the every-minute cron in server/scheduler.js to run.
//   3. Verify system_flags.trading_halted == '1' with updated_by='trace-watchdog'.
//   4. Cleanup: delete the sentinel ks_bets row, restore trading_halted to its
//      original snapshot value.
//
// IMPORTANT — WHERE TO RUN THIS:
//   The trace-watchdog cron lives in server/scheduler.js, which only runs on
//   the Railway worker (service `successful-acceptance`). Running this script
//   locally will INSERT the orphan but no cron will catch it. To exercise the
//   real watchdog, run via Railway shell so DB writes hit the same Turso DB
//   the live scheduler is reading:
//
//     railway run --service successful-acceptance \
//       node scripts/oracle/traceOrphanInjectionTest.js
//
//   Running locally with TURSO_DATABASE_URL pointed at production also works
//   provided the Railway scheduler is up; the orphan row is visible to the
//   live cron immediately. The script always prints which mode it's in.
//
// Usage:
//   node scripts/oracle/traceOrphanInjectionTest.js
//   node scripts/oracle/traceOrphanInjectionTest.js --wait-seconds 75
//
// Exit: 0 if watchdog halted within the wait window, 1 otherwise.

import 'dotenv/config'

import * as db from '../../lib/db.js'
import { parseArgs } from '../../lib/cli-args.js'

// ── CLI / constants ───────────────────────────────────────────────
const opts = parseArgs({
  waitSeconds: { flag: 'wait-seconds', type: 'number', default: 65 },
})

const SENTINEL_PITCHER_ID   = '99999999'
const SENTINEL_PITCHER_NAME = 'TEST_INJECTION'
const SENTINEL_ORDER_ID     = `real-uuid-fake-test-001-${Date.now()}` // unique per run

function todayET() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
}
const TODAY = todayET()

// ── Helpers ───────────────────────────────────────────────────────
async function cleanupSentinelBet(insertedId) {
  if (insertedId != null) {
    await db.run(`DELETE FROM ks_bets WHERE id = ?`, [insertedId])
  }
  // Belt-and-suspenders — also wipe by sentinel marker in case of repeat runs.
  await db.run(
    `DELETE FROM ks_bets
     WHERE pitcher_id = ?
       AND pitcher_name = ?`,
    [SENTINEL_PITCHER_ID, SENTINEL_PITCHER_NAME],
  )
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

// ── Main ──────────────────────────────────────────────────────────
async function main() {
  console.log('[TRACE ORPHAN INJECTION TEST]')
  console.log(`  bet_date=${TODAY}  pitcher=${SENTINEL_PITCHER_ID}/${SENTINEL_PITCHER_NAME}`)
  console.log(`  order_id=${SENTINEL_ORDER_ID}`)
  console.log(`  TURSO_DATABASE_URL=${(process.env.TURSO_DATABASE_URL || '(unset)').slice(0, 80)}`)
  if (!process.env.RAILWAY_ENVIRONMENT) {
    console.log('  WARN: RAILWAY_ENVIRONMENT not set — this is likely a local invocation.')
    console.log('        Watchdog cron lives in server/scheduler.js on Railway. If your')
    console.log('        Turso URL is shared with prod the live cron will still see this row.')
  }

  // 1. Snapshot original trading_halted state.
  const before = await db.one(
    `SELECT value, updated_by FROM system_flags WHERE key='trading_halted'`,
  )
  const originalValue   = before?.value ?? '0'
  const originalUpdater = before?.updated_by ?? 'system'
  console.log(`  snapshot trading_halted='${originalValue}' updated_by='${originalUpdater}'`)

  if (String(originalValue) === '1' && String(originalUpdater) === 'trace-watchdog') {
    console.log('  WARN: trading_halted is already 1 and was set by trace-watchdog.')
    console.log('        This test cannot distinguish "test-triggered" from "pre-existing"')
    console.log('        in that state. Resolve the prior halt first or accept the noise.')
  }

  let insertedId = null
  let pass = false

  try {
    // 2. Insert the fake orphan ks_bets row matching the watchdog query.
    //
    //    Watchdog filter (server/scheduler.js):
    //      bet_date           = today
    //      live_bet           = 0
    //      order_id           IS NOT NULL
    //      strategy_mode      IN ('pregame_normal','pregame_inversion')
    //      strategy_submode  NOT IN ('smoke_test','contra_test_legacy','reconciled_from_kalshi')
    //      logged_at          BETWEEN now()-30min AND now()-10s
    //      no matching oracle_bet_traces row
    //
    //    NOT NULL columns required: bet_date, logged_at, pitcher_name, strike,
    //    side, model_prob, edge.
    const loggedAt = new Date(Date.now() - 11_000).toISOString()  // 11s ago
    const insertResult = await db.run(
      `INSERT INTO ks_bets (
         bet_date, logged_at, pitcher_id, pitcher_name, strike, side,
         model_prob, market_mid, edge,
         live_bet, paper, user_id,
         strategy_mode, strategy_submode,
         capital_at_risk, bet_size,
         order_id, order_status, fill_price, filled_contracts
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 284, 'pregame_inversion', NULL, ?, ?, ?, 'resting', NULL, NULL)`,
      [
        TODAY, loggedAt,
        SENTINEL_PITCHER_ID, SENTINEL_PITCHER_NAME,
        6, 'NO',
        0.55, 35, 0.05,
        10, 10,
        SENTINEL_ORDER_ID,
      ],
    )
    insertedId = Number(insertResult.lastInsertRowid)
    console.log(`  Inserting fake orphan ks_bets row id=${insertedId}...`)

    // Sanity: verify the row matches the watchdog query.
    const wouldMatch = await db.one(
      `SELECT b.id FROM ks_bets b
       WHERE b.bet_date = ?
         AND b.live_bet = 0
         AND b.order_id IS NOT NULL
         AND b.strategy_mode IN ('pregame_normal','pregame_inversion')
         AND COALESCE(b.strategy_submode,'') NOT IN ('smoke_test','contra_test_legacy','reconciled_from_kalshi')
         AND datetime(b.logged_at) < datetime('now', '-10 seconds')
         AND datetime(b.logged_at) > datetime('now', '-30 minutes')
         AND b.id = ?
         AND NOT EXISTS (
           SELECT 1 FROM oracle_bet_traces t
           WHERE t.bet_date = b.bet_date
             AND t.pitcher_id = b.pitcher_id
             AND t.strike = b.strike
             AND t.side = b.side
             AND t.system LIKE '%user' || b.user_id
         )`,
      [TODAY, insertedId],
    )
    console.log(`  watchdog-filter sanity: ${wouldMatch ? 'MATCHES (orphan visible to watchdog)' : 'DOES NOT MATCH (test setup wrong)'}`)
    if (!wouldMatch) {
      console.log('  RESULT: FAIL — sentinel row does not satisfy watchdog query. Test cannot continue.')
      return false
    }

    // 3. Wait for one cron cycle (default 65s).
    console.log(`  Waiting ${opts.waitSeconds}s for watchdog cycle...`)
    await sleep(opts.waitSeconds * 1000)

    // 4. Check trading_halted.
    const after = await db.one(
      `SELECT value, updated_by, updated_at FROM system_flags WHERE key='trading_halted'`,
    )
    console.log(`  trading_halted final state: ${JSON.stringify(after)}`)

    const halted = String(after?.value) === '1' && String(after?.updated_by) === 'trace-watchdog'
    if (halted) {
      console.log('  RESULT: PASS — watchdog halted on injected orphan')
      pass = true
    } else {
      console.log('  RESULT: FAIL — watchdog did NOT halt within the wait window')
      console.log('          Likely cause: scheduler not running on this DB, or watchdog disabled.')
    }
  } finally {
    // 5. Cleanup.
    console.log('')
    console.log('Cleanup:')
    try {
      await cleanupSentinelBet(insertedId)
      console.log(`  - deleted ks_bets row id=${insertedId ?? '(none)'}`)
    } catch (err) {
      console.log(`  - FAILED to delete ks_bets row id=${insertedId ?? '(none)'}: ${err.message}`)
    }

    try {
      await db.run(
        `INSERT OR REPLACE INTO system_flags (key, value, updated_by, updated_at)
         VALUES ('trading_halted', ?, ?, ?)`,
        [originalValue, originalUpdater, new Date().toISOString()],
      )
      console.log(`  - restored trading_halted to value='${originalValue}' updated_by='${originalUpdater}'`)
    } catch (err) {
      console.log(`  - FAILED to restore trading_halted: ${err.message}`)
    }
  }

  await db.close()
  return pass
}

main()
  .then((pass) => process.exit(pass ? 0 : 1))
  .catch(async (err) => {
    console.error('[traceOrphanInjectionTest] FATAL:', err.message)
    console.error(err.stack)
    try { await db.close() } catch {}
    process.exit(1)
  })
