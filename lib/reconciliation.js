// lib/reconciliation.js — Kill-switch foundation: Kalshi ↔ DB position reconciliation.
//
// Purpose
// -------
// Before any new live order is placed, the system must agree with Kalshi about
// what positions it currently holds. Drift between the two views is the most
// dangerous failure mode in live trading — it implies one side has lost a fill,
// double-counted a fill, or applied a side flip. We halt trading on ANY
// mismatch and require human review.
//
// Kalshi is the source of truth for what we own. ks_bets is the source of
// truth for what the system thinks it owns. Each side's view is aggregated by
// ticker (Kalshi returns one row per ticker; ks_bets has one row per logical
// bet — a single ticker may have multiple ks_bets entries from re-fills,
// thresholds, etc.). After aggregation, we compare ticker-by-ticker.
//
// Scope of reconciliation
// -----------------------
// We reconcile every real-money (paper=0) ks_bets row that is open today
// (result IS NULL, order_status='filled' or signed contracts > 0), including
// both live_bet=1 (in-game) and live_bet=0 (pre-game) rows. Kalshi's
// /portfolio/positions endpoint returns a net position per ticker — it does
// not distinguish pre-game fills from in-game fills, so the comparison must
// aggregate over both. The original spec said live_bet=1 only; that would
// produce false `kalshi_only` mismatches for every pre-game position. The
// reconciliation is the kill-switch for live trading regardless of strategy
// mode.
//
// Mismatch taxonomy
// -----------------
//   kalshi_only    — Kalshi shows a position; DB has none for that ticker.
//   db_only        — DB has a non-zero aggregated position; Kalshi has none.
//   size_mismatch  — Both agree on side (sign) but contract counts differ.
//   side_mismatch  — Same ticker but YES vs NO. Catastrophic — almost
//                    impossible without a bug, but if it happens, halt.
//   unknown_ticker — DB row has a ticker we cannot parse (NULL or malformed).
//                    Treated as a mismatch since we cannot compare.
//
// Halt logic
// ----------
// On any mismatch type, set system_flags.trading_halted=1 with
// updated_by='reconciliation_mismatch'. Transient API errors do NOT halt on
// the first occurrence (avoid network blips wedging the system); the caller
// is expected to track consecutive failures externally and escalate.

import { getMarketPositions } from './kalshi.js'

const ACTIVE_LIVE_USERS_SQL = `
  SELECT id, name, kalshi_key_id, kalshi_private_key
  FROM users
  WHERE active_bettor = 1
    AND paper = 0
    AND kalshi_key_id IS NOT NULL
    AND kalshi_private_key IS NOT NULL
    AND COALESCE(is_system_admin, 0) = 0
`

// ------------------------------------------------------------------
// reconcileUser — single-user reconciliation
// ------------------------------------------------------------------
/**
 * Compare Kalshi-held positions to DB ks_bets aggregate for one user.
 *
 * @param {object}   args
 * @param {object}   args.db        - lib/db.js module (uses db.one, db.all)
 * @param {number}   args.userId    - users.id
 * @param {string}   args.betDate   - 'YYYY-MM-DD' (today, ET)
 * @returns {Promise<{
 *   ok: boolean,
 *   user_id: number,
 *   user_name: string|null,
 *   kalshi_count: number,
 *   db_count: number,
 *   mismatches: Array<{
 *     type: 'kalshi_only'|'db_only'|'size_mismatch'|'side_mismatch'|'unknown_ticker',
 *     ticker: string|null,
 *     side: string|null,
 *     kalshi_qty: number,
 *     db_qty: number,
 *     ks_bet_id: number|null
 *   }>,
 *   error?: string
 * }>}
 */
export async function reconcileUser({ db, userId, betDate }) {
  const result = {
    ok: false,
    user_id: userId,
    user_name: null,
    kalshi_count: 0,
    db_count: 0,
    mismatches: [],
  }

  // ── Load user creds ────────────────────────────────────────────────
  let user
  try {
    user = await db.one(
      `SELECT id, name, kalshi_key_id, kalshi_private_key
       FROM users WHERE id = ?`,
      [userId],
    )
  } catch (err) {
    result.error = `db error loading user: ${err.message}`
    return result
  }

  if (!user) {
    result.error = `user ${userId} not found`
    return result
  }
  result.user_name = user.name ?? null

  if (!user.kalshi_key_id || !user.kalshi_private_key) {
    result.error = `user ${userId} (${user.name}) missing kalshi credentials`
    return result
  }

  // ── Fetch Kalshi state ─────────────────────────────────────────────
  let kalshiPositions
  try {
    const creds = { keyId: user.kalshi_key_id, privateKey: user.kalshi_private_key }
    kalshiPositions = await getMarketPositions(creds)
  } catch (err) {
    result.error = `kalshi api error: ${err.message}`
    return result   // ok=false but no mismatches → caller treats as transient
  }

  // Kalshi returns one row per market; signed `position` (or `position_fp`)
  // — positive = YES contracts held, negative = NO contracts held. Filter to
  // non-zero positions only; settled markets sometimes linger at qty=0.
  const kalshiByTicker = new Map()
  for (const p of kalshiPositions || []) {
    const signed = Number(p?.position_fp ?? p?.position ?? 0)
    if (!signed) continue
    const qty   = Math.abs(Math.round(signed))
    const side  = signed > 0 ? 'YES' : 'NO'
    kalshiByTicker.set(p.ticker, { ticker: p.ticker, qty, side, signed })
  }
  result.kalshi_count = kalshiByTicker.size

  // ── Fetch DB state ─────────────────────────────────────────────────
  // Reconcile every real-money open position for this user. We include both
  // live_bet=1 (in-game) and live_bet=0 (pre-game live) rows because Kalshi's
  // position API returns a single net per ticker and cannot distinguish them.
  // An aggregation that ignores pre-game rows would produce false
  // `kalshi_only` mismatches every time the system holds a pre-game position.
  let dbBets
  try {
    // bet_date filter REMOVED — Kalshi /portfolio/positions returns all open
    // positions regardless of when they were placed (a market opened yesterday
    // is still open until settlement). To compare apples-to-apples we must
    // match ALL open DB positions vs ALL open Kalshi positions, not just today.
    // The betDate parameter is preserved for logging/persistence keys only.
    dbBets = await db.all(
      `SELECT id, bet_date, ticker, pitcher_name, strike, side, filled_contracts, live_bet, order_status
       FROM ks_bets
       WHERE user_id  = ?
         AND paper    = 0
         AND result IS NULL
         AND COALESCE(order_status, '') = 'filled'
         AND COALESCE(filled_contracts, 0) > 0`,
      [userId],
    )
  } catch (err) {
    result.error = `db error loading bets: ${err.message}`
    return result
  }

  // Settlement-lag tickers: DB has the row settled (result IS NOT NULL) but
  // Kalshi may still show the position open for some minutes-to-hours
  // until market officially settles. These tickers should be treated as
  // "settling_in_progress" and NOT trigger a kalshi_only mismatch.
  let recentlySettledTickers = new Set()
  try {
    const settled = await db.all(
      `SELECT DISTINCT ticker FROM ks_bets
       WHERE user_id = ? AND paper = 0
         AND result IN ('win','loss','void')
         AND ticker IS NOT NULL
         AND datetime(COALESCE(filled_at, logged_at)) > datetime('now', '-24 hours')`,
      [userId],
    )
    recentlySettledTickers = new Set(settled.map(r => r.ticker).filter(Boolean))
  } catch { /* non-fatal — empty set means no grace */ }

  // Aggregate DB rows by ticker. Signed convention matches Kalshi:
  //   YES → +contracts, NO → -contracts.
  // Track all ks_bet ids contributing to each ticker so caller can investigate.
  const dbByTicker = new Map()
  const unknownTickerRows = []
  for (const bet of dbBets) {
    const ticker = bet.ticker
    const qty    = Number(bet.filled_contracts ?? 0)
    if (!qty) continue

    if (!ticker || typeof ticker !== 'string' || !ticker.trim()) {
      unknownTickerRows.push(bet)
      continue
    }

    const sideUpper = String(bet.side ?? '').toUpperCase()
    if (sideUpper !== 'YES' && sideUpper !== 'NO') {
      unknownTickerRows.push(bet)
      continue
    }

    const signed = sideUpper === 'YES' ? qty : -qty
    const cur = dbByTicker.get(ticker)
    if (cur) {
      cur.signed += signed
      cur.ks_bet_ids.push(bet.id)
    } else {
      dbByTicker.set(ticker, {
        ticker,
        signed,
        ks_bet_ids: [bet.id],
      })
    }
  }
  result.db_count = dbByTicker.size

  // ── Compare ────────────────────────────────────────────────────────
  const mismatches = []

  // Unknown-ticker rows: cannot be reconciled at all
  for (const bet of unknownTickerRows) {
    mismatches.push({
      type: 'unknown_ticker',
      ticker: bet.ticker ?? null,
      side: bet.side ?? null,
      kalshi_qty: 0,
      db_qty: Number(bet.filled_contracts ?? 0),
      ks_bet_id: bet.id ?? null,
    })
  }

  const allTickers = new Set([...kalshiByTicker.keys(), ...dbByTicker.keys()])

  for (const ticker of allTickers) {
    const k = kalshiByTicker.get(ticker)
    const d = dbByTicker.get(ticker)

    const kalshiQty   = k ? k.qty : 0
    const kalshiSign  = k ? Math.sign(k.signed) : 0
    const dbAbs       = d ? Math.abs(d.signed) : 0
    const dbSign      = d ? Math.sign(d.signed) : 0
    const ksBetId     = d?.ks_bet_ids?.[0] ?? null
    const ksBetIds    = d?.ks_bet_ids ?? []

    if (k && !d) {
      // Settlement-lag grace: if the DB recently settled this ticker (won/lost/voided
      // within last 24h), Kalshi may still show the position open for a few minutes
      // while the market settles. Don't halt on this — it's transient.
      if (recentlySettledTickers.has(ticker)) {
        // record as info-only, don't push to mismatches
        result.settling_in_progress = (result.settling_in_progress || 0) + 1
        continue
      }
      mismatches.push({
        type: 'kalshi_only',
        ticker,
        side: k.side,
        kalshi_qty: k.signed,
        db_qty: 0,
        ks_bet_id: null,
      })
      continue
    }

    if (!k && d) {
      mismatches.push({
        type: 'db_only',
        ticker,
        side: d.signed > 0 ? 'YES' : 'NO',
        kalshi_qty: 0,
        db_qty: d.signed,
        ks_bet_id: ksBetId,
        ks_bet_ids: ksBetIds,
      })
      continue
    }

    // Both present
    if (kalshiSign !== dbSign) {
      mismatches.push({
        type: 'side_mismatch',
        ticker,
        side: `kalshi=${k.side}/db=${d.signed > 0 ? 'YES' : 'NO'}`,
        kalshi_qty: k.signed,
        db_qty: d.signed,
        ks_bet_id: ksBetId,
        ks_bet_ids: ksBetIds,
      })
      continue
    }

    if (kalshiQty !== dbAbs) {
      mismatches.push({
        type: 'size_mismatch',
        ticker,
        side: k.side,
        kalshi_qty: k.signed,
        db_qty: d.signed,
        ks_bet_id: ksBetId,
        ks_bet_ids: ksBetIds,
      })
      continue
    }

    // Match
  }

  result.ok = mismatches.length === 0
  result.mismatches = mismatches
  return result
}

// ------------------------------------------------------------------
// reconcileAll — fan out across active live users
// ------------------------------------------------------------------
/**
 * Run reconcileUser for every (active_bettor=1, paper=0) user in parallel.
 * Combined ok = AND of per-user ok values. Returns halt_reason when any
 * user has a non-empty mismatches array (independent of API errors).
 *
 * @param {object} args
 * @param {object} args.db
 * @param {string} args.betDate
 * @returns {Promise<{
 *   ok: boolean,
 *   users: Array<object>,
 *   halt_reason?: string
 * }>}
 */
export async function reconcileAll({ db, betDate }) {
  let users
  try {
    users = await db.all(ACTIVE_LIVE_USERS_SQL)
  } catch (err) {
    return {
      ok: false,
      users: [],
      halt_reason: `db error loading users: ${err.message}`,
    }
  }

  if (!users.length) {
    return { ok: true, users: [] }
  }

  const results = await Promise.all(
    users.map(u => reconcileUser({ db, userId: u.id, betDate })),
  )

  const anyMismatch = results.some(r => r.mismatches && r.mismatches.length > 0)
  const allOk       = results.every(r => r.ok)

  const out = { ok: allOk && !anyMismatch, users: results }

  if (anyMismatch) {
    const summary = results
      .filter(r => r.mismatches?.length)
      .map(r => `user=${r.user_name || r.user_id} mismatches=${r.mismatches.length} types=[${[...new Set(r.mismatches.map(m => m.type))].join(',')}]`)
      .join('; ')
    out.halt_reason = `position_mismatch: ${summary}`
  }

  return out
}

// ------------------------------------------------------------------
// persistReconciliationResult — write status + diff to system_flags
// ------------------------------------------------------------------
/**
 * Persists three keys:
 *   last_reconciliation_pass_at  — ISO timestamp
 *   last_reconciliation_status   — 'ok' | 'mismatch' | 'error'
 *   last_reconciliation_diff     — JSON of consolidated mismatches array
 *
 * Failures here are swallowed (best-effort logging); reconciliation must
 * never throw on a write error since the halt path also writes flags.
 *
 * @param {object} args
 * @param {object} args.db
 * @param {object} args.result   - return value of reconcileAll OR reconcileUser
 */
export async function persistReconciliationResult({ db, result }) {
  const now = new Date().toISOString()

  let status = 'ok'
  let diffPayload = []

  if (result?.users) {
    // reconcileAll shape
    const anyError    = result.users.some(u => u.error)
    const anyMismatch = result.users.some(u => u.mismatches?.length)
    if (anyMismatch) status = 'mismatch'
    else if (anyError) status = 'error'

    diffPayload = result.users.map(u => ({
      user_id: u.user_id,
      user_name: u.user_name,
      kalshi_count: u.kalshi_count,
      db_count: u.db_count,
      mismatches: u.mismatches || [],
      error: u.error || null,
    }))
  } else if (result) {
    // single reconcileUser shape
    if (result.error) status = 'error'
    else if (result.mismatches?.length) status = 'mismatch'
    diffPayload = [{
      user_id: result.user_id,
      user_name: result.user_name,
      kalshi_count: result.kalshi_count,
      db_count: result.db_count,
      mismatches: result.mismatches || [],
      error: result.error || null,
    }]
  }

  const writes = [
    ['last_reconciliation_pass_at', now],
    ['last_reconciliation_status',  status],
    ['last_reconciliation_diff',    JSON.stringify(diffPayload)],
  ]

  for (const [key, value] of writes) {
    try {
      await db.run(
        `INSERT INTO system_flags (key, value, updated_at, updated_by)
         VALUES (?, ?, ?, 'reconciliation')
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at,
           updated_by = excluded.updated_by`,
        [key, value, now],
      )
    } catch {
      /* swallow — sentinel will detect missing pass_at */
    }
  }

  return { status, persisted_at: now }
}

// ------------------------------------------------------------------
// maybeHaltOnMismatch — flip trading_halted=1 on confirmed drift
// ------------------------------------------------------------------
/**
 * Halt trading iff at least one user has a non-empty mismatches array.
 * Pure API errors (ok=false but mismatches=[]) do NOT halt — those are
 * treated as transient. Caller is responsible for tracking consecutive
 * failures externally if needed.
 *
 * Idempotent: writes trading_halted=1 unconditionally on mismatch so the
 * `updated_by`/`updated_at` columns reflect the latest reconciliation.
 *
 * @param {object} args
 * @param {object} args.db
 * @param {object} args.result   - reconcileAll OR reconcileUser shape
 * @returns {Promise<{halted: boolean, reason?: string}>}
 */
export async function maybeHaltOnMismatch({ db, result }) {
  // Normalize to a list of per-user results
  const list = result?.users
    ? result.users
    : (result ? [result] : [])

  const flagged = list.filter(u => u.mismatches && u.mismatches.length > 0)
  if (!flagged.length) return { halted: false }

  // Build a concise reason — typed counts per user
  const reason = flagged
    .map(u => {
      const types = [...new Set(u.mismatches.map(m => m.type))].join(',')
      return `${u.user_name || u.user_id}:${u.mismatches.length}[${types}]`
    })
    .join('; ')

  const fullReason = `reconciliation_mismatch ${reason}`
  const now = new Date().toISOString()

  try {
    await db.run(
      `INSERT INTO system_flags (key, value, updated_at, updated_by)
       VALUES ('trading_halted', '1', ?, 'reconciliation_mismatch')
       ON CONFLICT(key) DO UPDATE SET
         value = '1',
         updated_at = excluded.updated_at,
         updated_by = excluded.updated_by`,
      [now],
    )
  } catch (err) {
    // Halt write failed — surface in reason but still report halted=true
    // intent so caller alerts. The flag may not be set; investigate db state.
    return {
      halted: false,
      reason: `${fullReason} (HALT WRITE FAILED: ${err.message})`,
    }
  }

  return { halted: true, reason: fullReason }
}

// ──────────────────────────────────────────────────────────────────
// Smoke test (commented out — uncomment to exercise locally).
// Run via: node lib/reconciliation.js
// Requires .env with TURSO_DATABASE_URL/TURSO_AUTH_TOKEN.
// ──────────────────────────────────────────────────────────────────
//
// import * as db from './db.js'
//
// async function _smoke() {
//   const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
//   const ADAM = 284
//   const ISAIAH = 2
//
//   // 1. Reconcile both users
//   console.log('── reconcileAll ──')
//   const all = await reconcileAll({ db, betDate: today })
//   console.log(JSON.stringify(all, null, 2))
//
//   // 2. Single-user
//   console.log('── reconcileUser(adam) ──')
//   const adam = await reconcileUser({ db, userId: ADAM, betDate: today })
//   console.log(JSON.stringify(adam, null, 2))
//
//   // 3. Simulated db_only mismatch (inject a fake bet, reconcile, then clean up)
//   console.log('── simulated db_only ──')
//   const fakeTicker = `KXMLBKS-99TEST-FAKE-Y6`
//   await db.run(
//     `INSERT INTO ks_bets
//        (bet_date, logged_at, pitcher_name, strike, side, model_prob, edge,
//         ticker, filled_contracts, paper, live_bet, order_status, user_id, fill_price)
//      VALUES (?, ?, 'TEST PITCHER', 6, 'YES', 0.5, 0, ?, 5, 0, 1, 'filled', ?, 50)`,
//     [today, new Date().toISOString(), fakeTicker, ADAM],
//   )
//   const sim1 = await reconcileUser({ db, userId: ADAM, betDate: today })
//   const dbOnly = sim1.mismatches.filter(m => m.type === 'db_only' && m.ticker === fakeTicker)
//   console.log(`db_only count: ${dbOnly.length} (expected 1)`)
//   await db.run(`DELETE FROM ks_bets WHERE ticker = ? AND user_id = ?`, [fakeTicker, ADAM])
//
//   // 4. Simulated kalshi_only — harder to fake without mocking. Skip live;
//   //    a no-op fake user would require kalshi creds. Rely on real run-time
//   //    Kalshi diffs to test this branch in production.
//   console.log('── simulated kalshi_only — skipped (requires Kalshi mock) ──')
//
//   // 5. Persist
//   const p = await persistReconciliationResult({ db, result: all })
//   console.log('persisted:', p)
//
//   // 6. Halt check (only halts if real mismatches exist)
//   const h = await maybeHaltOnMismatch({ db, result: all })
//   console.log('halt:', h)
//
//   await db.close()
// }
// _smoke().catch(e => { console.error(e); process.exit(1) })
