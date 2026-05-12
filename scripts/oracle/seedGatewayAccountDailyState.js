// scripts/oracle/seedGatewayAccountDailyState.js
//
// Maintains gateway_account_daily_state from ks_bets every minute.
//
// Why this exists: the Gateway validator reads gateway_account_daily_state for
// daily_loss / daily_risk / submitted_order checks. Without something writing to
// that table, the validator rejects every request with ACCOUNT_STATE_STALE.
//
// This is the V1 hack — a periodic recompute. The "real" path (per spec §12) is
// the settlement updater writing on every fill/settle event, which gets us O(1)
// reads and ≤60s freshness. This recompute approximates that with a 1-minute
// cron job.
//
// What it computes per (account, today_ET):
//   realized_pnl_usd     = SUM(pnl)      WHERE settled_at IS NOT NULL
//   open_risk_usd        = SUM(bet_size) WHERE settled_at IS NULL
//   submitted_order_usd  = SUM(bet_size) (all placed bets, regardless of settled state)
//   daily_loss_limit_usd = pulled from gateway_accounts
//   daily_risk_limit_usd = pulled from gateway_accounts
//
// Wired in scheduler.js as a 1-minute cron alongside healthSentinel.

import * as db from '../../lib/db.js'

// user_id → account_id mapping (matches Closer's BETTOR_USER_ID convention)
const ACCOUNT_MAP = { 1: 'adam', 2: 'isaiah' }

function etDateToday(now = new Date()) {
  // Convert to America/New_York calendar date
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  })
  return fmt.format(now)  // YYYY-MM-DD
}

export async function refreshGatewayAccountDailyState({ now = new Date() } = {}) {
  const date = etDateToday(now)
  const updated = []

  // Fetch limits for each enabled account
  const accountRows = await db.all(
    `SELECT account_id, daily_loss_limit_usd, daily_risk_limit_usd FROM gateway_accounts WHERE enabled = 1`,
  )
  if (accountRows.length === 0) return { updated, date, note: 'no_enabled_accounts' }

  for (const acct of accountRows) {
    // Map account_id back to user_id for the ks_bets join
    const user_id = Object.entries(ACCOUNT_MAP).find(([, a]) => a === acct.account_id)?.[0]
    if (!user_id) continue   // account configured but no user mapping

    // Aggregate ks_bets for today
    const r = await db.one(
      `SELECT
         COALESCE(SUM(CASE WHEN settled_at IS NOT NULL THEN COALESCE(pnl, 0) ELSE 0 END), 0) AS realized,
         COALESCE(SUM(CASE WHEN settled_at IS NULL     THEN COALESCE(bet_size, 0) ELSE 0 END), 0) AS open_risk,
         COALESCE(SUM(COALESCE(bet_size, 0)), 0) AS submitted
       FROM ks_bets
       WHERE bet_date = ? AND user_id = ?`,
      [date, user_id],
    )

    await db.run(
      `INSERT INTO gateway_account_daily_state
         (account_id, trading_date, realized_pnl_usd, open_risk_usd,
          submitted_order_usd, daily_loss_limit_usd, daily_risk_limit_usd,
          updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id, trading_date) DO UPDATE SET
         realized_pnl_usd      = excluded.realized_pnl_usd,
         open_risk_usd         = excluded.open_risk_usd,
         submitted_order_usd   = excluded.submitted_order_usd,
         daily_loss_limit_usd  = excluded.daily_loss_limit_usd,
         daily_risk_limit_usd  = excluded.daily_risk_limit_usd,
         updated_at            = excluded.updated_at`,
      [
        acct.account_id, date,
        Number(r.realized) || 0,
        Number(r.open_risk) || 0,
        Number(r.submitted) || 0,
        acct.daily_loss_limit_usd,
        acct.daily_risk_limit_usd,
        new Date(now).toISOString(),
      ],
    )
    updated.push({
      account_id: acct.account_id,
      trading_date: date,
      realized_pnl_usd: Number(r.realized) || 0,
      open_risk_usd: Number(r.open_risk) || 0,
      submitted_order_usd: Number(r.submitted) || 0,
    })
  }

  return { updated, date }
}

// CLI entrypoint — useful for backfill or manual refresh
if (import.meta.url === `file://${process.argv[1]}`) {
  const dotenv = await import('dotenv')
  const path = await import('node:path')
  const url = await import('node:url')
  const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
  dotenv.default.config({ path: path.resolve(__dirname, '../../.env') })

  refreshGatewayAccountDailyState()
    .then(r => {
      console.log('[gw-account-state] refreshed:')
      for (const u of r.updated) {
        console.log(`  ${u.account_id} ${u.trading_date}  realized=${u.realized_pnl_usd}  open=${u.open_risk_usd}  submitted=${u.submitted_order_usd}`)
      }
      if (r.note) console.log(`  note: ${r.note}`)
      process.exit(0)
    })
    .catch(err => { console.error('[gw-account-state] FATAL:', err); process.exit(1) })
}
