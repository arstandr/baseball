// oracle/layers/6-gateway/dataPlane.js
//
// All DB-backed loaders + stores the orchestrator needs, in one place.
// Accepts a `db` argument with the lib/db.js interface ({ run, all, one }).
// Production passes lib/db.js directly; tests pass a thin libsql wrapper.
//
// What's here:
//   - loaders.insertNonce        — INSERT-or-throw for HMAC nonce uniqueness
//   - loaders.loadAccount        — gateway_accounts row
//   - loaders.loadAccountState   — gateway_account_daily_state row
//   - loaders.loadDecisionEvent  — oracle_trace_events row by decision_id
//   - loaders.loadIdempotency    — gateway_idempotency row
//   - idempotencyStore.upsert    — write idempotency row post-exchange
//   - idempotencyStore.get       — alias of loaders.loadIdempotency
//   - idempotencyStore.sweepExpired
//   - unknownsStore.enqueue      — write gateway_unknowns row
//   - unknownsStore.markResolved
//   - unknownsStore.listUnresolved
//   - killswitchFetcher          — for makeKillswitchCache
//   - killswitchStore.set        — admin writes (HMAC-protected at route level)
//   - nonceSweeper.sweepExpired
//
// SQL-only: no business logic. Validation/orchestration owns policy.

function asIso(unixMs) {
  return new Date(unixMs).getTime() ? new Date(unixMs).toISOString() : new Date().toISOString()
}

export function buildDataPlane(db) {
  if (!db || typeof db.run !== 'function' || typeof db.one !== 'function' || typeof db.all !== 'function') {
    throw new Error('buildDataPlane: db must expose { run, one, all }')
  }

  // ── Loaders ────────────────────────────────────────────────────────────

  async function insertNonce(nonce, agent_id, nowMs) {
    const usedAt = asIso(nowMs)
    const expiresAt = asIso(nowMs + 60_000)
    // PRIMARY KEY on nonce → INSERT throws on conflict
    await db.run(
      `INSERT INTO gateway_nonces (nonce, agent_id, used_at, expires_at) VALUES (?, ?, ?, ?)`,
      [nonce, agent_id, usedAt, expiresAt],
    )
  }

  async function loadAccount(account_id) {
    return db.one(
      `SELECT account_id, display_name, kalshi_credential_ref, enabled,
              daily_loss_limit_usd, daily_risk_limit_usd
         FROM gateway_accounts
        WHERE account_id = ?`,
      [account_id],
    )
  }

  async function loadAccountState(account_id, trading_date) {
    return db.one(
      `SELECT account_id, trading_date, realized_pnl_usd, open_risk_usd,
              submitted_order_usd, daily_loss_limit_usd, daily_risk_limit_usd,
              updated_at
         FROM gateway_account_daily_state
        WHERE account_id = ? AND trading_date = ?`,
      [account_id, trading_date],
    )
  }

  async function loadDecisionEvent(decision_id) {
    // Looks up the most recent Trace event for this decision_id. The validator
    // checks created_at + agent_id; multiple events may exist (math, path,
    // trust, judge, etc.), but for V1 (closer-legacy) we expect exactly one
    // upstream event per decision_id.
    return db.one(
      `SELECT decision_id, agent_id, created_at, layer_name, event_type,
              agent_version, mode
         FROM oracle_trace_events
        WHERE decision_id = ?
        ORDER BY created_at DESC
        LIMIT 1`,
      [decision_id],
    )
  }

  async function loadIdempotency(decision_id) {
    return db.one(
      `SELECT decision_id, body_hash, client_order_id, exchange_request_sent,
              kalshi_order_id, exchange_status, last_status, response_json,
              created_at, updated_at, expires_at
         FROM gateway_idempotency
        WHERE decision_id = ?`,
      [decision_id],
    )
  }

  // ── idempotencyStore ────────────────────────────────────────────────────

  async function upsertIdempotency(row) {
    const now = new Date().toISOString()
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString()
    await db.run(
      `INSERT INTO gateway_idempotency
         (decision_id, body_hash, client_order_id, exchange_request_sent,
          kalshi_order_id, exchange_status, last_status, response_json,
          created_at, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(decision_id) DO UPDATE SET
         body_hash             = excluded.body_hash,
         client_order_id       = COALESCE(excluded.client_order_id, gateway_idempotency.client_order_id),
         exchange_request_sent = excluded.exchange_request_sent,
         kalshi_order_id       = excluded.kalshi_order_id,
         exchange_status       = excluded.exchange_status,
         last_status           = excluded.last_status,
         response_json         = excluded.response_json,
         updated_at            = excluded.updated_at,
         expires_at            = excluded.expires_at`,
      [
        row.decision_id,
        row.body_hash,
        row.client_order_id ?? null,
        row.exchange_request_sent ?? 0,
        row.kalshi_order_id ?? null,
        row.exchange_status ?? null,
        row.last_status,
        row.response_json ?? null,
        now,
        now,
        expiresAt,
      ],
    )
  }

  // Reconciler updates the idempotency row when an exchange_unknown resolves.
  // Doesn't require body_hash (the reconciler doesn't have the original raw body).
  // last_status flips from 'exchange_unknown' to the resolved truth so retries
  // don't replay stale unknown responses.
  async function markIdempotencyResolved(decision_id, fields) {
    const now = new Date().toISOString()
    await db.run(
      `UPDATE gateway_idempotency
          SET last_status = ?,
              kalshi_order_id = COALESCE(?, kalshi_order_id),
              exchange_status = ?,
              response_json = ?,
              updated_at = ?
        WHERE decision_id = ?`,
      [
        fields.last_status,
        fields.kalshi_order_id ?? null,
        fields.exchange_status ?? null,
        fields.response_json ?? null,
        now,
        decision_id,
      ],
    )
  }

  async function sweepExpiredIdempotency(nowMs = Date.now()) {
    const cutoff = new Date(nowMs).toISOString()
    const res = await db.run(
      `DELETE FROM gateway_idempotency WHERE expires_at < ?`,
      [cutoff],
    )
    return { deleted: res?.rowsAffected ?? 0 }
  }

  // ── unknownsStore ──────────────────────────────────────────────────────

  async function enqueueUnknown({ decision_id, client_order_id = null, account_id, market_ticker, submitted_at }) {
    await db.run(
      `INSERT INTO gateway_unknowns
         (decision_id, client_order_id, account_id, market_ticker, submitted_at)
       VALUES (?, ?, ?, ?, ?)`,
      [decision_id, client_order_id, account_id, market_ticker, submitted_at],
    )
  }

  async function markUnknownResolved(id, { resolved_status, resolved_at, kalshi_order_id, last_check_response }) {
    await db.run(
      `UPDATE gateway_unknowns
          SET resolved_status = ?,
              resolved_at = ?,
              resolved_kalshi_order_id = ?,
              last_check_response = ?,
              last_check_at = ?
        WHERE id = ?`,
      [
        resolved_status,
        resolved_at,
        kalshi_order_id ?? null,
        last_check_response ?? null,
        new Date().toISOString(),
        id,
      ],
    )
  }

  async function listUnresolvedUnknowns({ olderThanMs = 0, limit = 100 } = {}) {
    const cutoff = new Date(Date.now() - olderThanMs).toISOString()
    return db.all(
      `SELECT id, decision_id, client_order_id, account_id, market_ticker,
              submitted_at, attempts, last_check_at, last_check_response,
              last_check_error_code
         FROM gateway_unknowns
        WHERE resolved_at IS NULL
          AND submitted_at <= ?
        ORDER BY submitted_at ASC
        LIMIT ?`,
      [cutoff, limit],
    )
  }

  async function bumpUnknownAttempt(id, { error_code = null, response = null } = {}) {
    await db.run(
      `UPDATE gateway_unknowns
          SET attempts = attempts + 1,
              last_check_at = ?,
              last_check_error_code = ?,
              last_check_response = COALESCE(?, last_check_response)
        WHERE id = ?`,
      [new Date().toISOString(), error_code, response, id],
    )
  }

  // ── killswitch ────────────────────────────────────────────────────────

  async function killswitchFetcher() {
    return db.all(`SELECT key, value FROM gateway_killswitch`)
  }

  async function killswitchSet(key, value, updated_by) {
    const now = new Date().toISOString()
    const v = typeof value === 'string' ? value : JSON.stringify(value)
    await db.run(
      `INSERT INTO gateway_killswitch (key, value, updated_at, updated_by)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at,
         updated_by = excluded.updated_by`,
      [key, v, now, updated_by],
    )
  }

  // ── nonces ────────────────────────────────────────────────────────────

  async function sweepExpiredNonces(nowMs = Date.now()) {
    const cutoff = new Date(nowMs).toISOString()
    const res = await db.run(
      `DELETE FROM gateway_nonces WHERE expires_at < ?`,
      [cutoff],
    )
    return { deleted: res?.rowsAffected ?? 0 }
  }

  // ── account state (for settlement updater) ─────────────────────────────

  async function upsertAccountDailyState({
    account_id, trading_date,
    realized_pnl_usd, open_risk_usd, submitted_order_usd,
    daily_loss_limit_usd, daily_risk_limit_usd,
  }) {
    const now = new Date().toISOString()
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
        account_id, trading_date,
        realized_pnl_usd ?? 0, open_risk_usd ?? 0, submitted_order_usd ?? 0,
        daily_loss_limit_usd ?? null, daily_risk_limit_usd ?? null,
        now,
      ],
    )
  }

  return {
    loaders: {
      insertNonce,
      loadAccount,
      loadAccountState,
      loadDecisionEvent,
      loadIdempotency,
    },
    idempotencyStore: {
      upsert: upsertIdempotency,
      get: loadIdempotency,
      markResolved: markIdempotencyResolved,
      sweepExpired: sweepExpiredIdempotency,
    },
    unknownsStore: {
      enqueue: enqueueUnknown,
      markResolved: markUnknownResolved,
      listUnresolved: listUnresolvedUnknowns,
      bumpAttempt: bumpUnknownAttempt,
    },
    killswitchFetcher,
    killswitchStore: {
      set: killswitchSet,
    },
    nonceSweeper: {
      sweepExpired: sweepExpiredNonces,
    },
    accountStateStore: {
      upsert: upsertAccountDailyState,
    },
  }
}
