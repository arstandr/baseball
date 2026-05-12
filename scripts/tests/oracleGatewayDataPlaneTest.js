// scripts/tests/oracleGatewayDataPlaneTest.js
//
// Integration tests for oracle/layers/6-gateway/dataPlane.js — runs every
// CRUD path against a real local libsql DB.
//
// Spins up a temp file-backed libsql client, applies Layer 0 and Layer 6
// schemas, seeds reference data, and exercises every loader + store.
//
// Run: node scripts/tests/oracleGatewayDataPlaneTest.js

import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import url from 'node:url'
import crypto from 'node:crypto'
import { createClient } from '@libsql/client'
import { buildDataPlane } from '../../oracle/layers/6-gateway/dataPlane.js'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))

let _passed = 0, _failed = 0
const ok  = (c, l) => c ? _passed++ : (_failed++, console.error(`FAIL [${l}]`))
const eq  = (a, b, l) => a === b ? _passed++ : (_failed++, console.error(`FAIL [${l}]: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`))
const expectThrows = async (fn, l) => {
  try { await fn(); _failed++; console.error(`FAIL [${l}]: expected throw`) }
  catch { _passed++ }
}
const section = n => console.log(`\n── ${n} ──`)

// ─── Setup: temp DB + schema ─────────────────────────────────────────
const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ogw-data-'))
const dbFile = path.join(tmpDir, 'test.db')
const client = createClient({ url: `file:${dbFile}` })

const db = {
  run:  async (sql, args = []) => client.execute({ sql, args }),
  all:  async (sql, args = []) => (await client.execute({ sql, args })).rows,
  one:  async (sql, args = []) => (await client.execute({ sql, args })).rows[0] ?? null,
}

function parseStatements(raw) {
  return raw
    .replace(/\r/g, '')
    .split('\n')
    .map(line => line.replace(/--.*$/, ''))
    .filter(line => line.trim())
    .join('\n')
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0)
}

async function applySchema(file) {
  const raw = await fs.readFile(file, 'utf-8')
  const stmts = parseStatements(raw)
  for (const s of stmts) await client.execute(s)
  return stmts.length
}

const layer0Sql = path.resolve(__dirname, '../../oracle/layers/0-trace/schema.sql')
const layer6Sql = path.resolve(__dirname, '../../oracle/layers/6-gateway/schema.sql')
const n0 = await applySchema(layer0Sql)
const n6 = await applySchema(layer6Sql)
console.log(`schema applied: layer0=${n0} stmts, layer6=${n6} stmts → ${dbFile}`)

const dp = buildDataPlane(db)

// ─── Constructor checks ────────────────────────────────────────────
section('buildDataPlane constructor')
{
  let threw = false
  try { buildDataPlane(null) } catch { threw = true }
  ok(threw, 'null db throws')
}
{
  let threw = false
  try { buildDataPlane({ run: () => {} }) } catch { threw = true }
  ok(threw, 'partial interface throws')
}

// ─── Nonces ────────────────────────────────────────────────────────
section('nonceStore.insertNonce + sweepExpired')
{
  await dp.loaders.insertNonce('nonce-1', 'closer-legacy', Date.now())
  await dp.loaders.insertNonce('nonce-2', 'closer-legacy', Date.now())
  const rows = await db.all(`SELECT nonce FROM gateway_nonces ORDER BY nonce`)
  eq(rows.length, 2, 'two nonces stored')
  eq(rows[0].nonce, 'nonce-1', 'nonce-1 stored')
}
{
  // Replay → conflict
  await expectThrows(() => dp.loaders.insertNonce('nonce-1', 'closer-legacy', Date.now()), 'nonce-1 replay throws')
}
{
  // Sweep expired (rewrite expires_at into the past)
  await db.run(`UPDATE gateway_nonces SET expires_at = ? WHERE nonce = 'nonce-1'`, ['2020-01-01T00:00:00.000Z'])
  const r = await dp.nonceSweeper.sweepExpired()
  ok(r.deleted >= 1, 'sweep deleted ≥1 row')
  const remaining = await db.one(`SELECT count(*) as n FROM gateway_nonces`)
  eq(Number(remaining.n), 1, 'one nonce remains after sweep')
}

// ─── Accounts ──────────────────────────────────────────────────────
section('loadAccount')
{
  const now = new Date().toISOString()
  await db.run(
    `INSERT INTO gateway_accounts (account_id, display_name, kalshi_credential_ref, enabled, daily_loss_limit_usd, daily_risk_limit_usd, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ['adam', 'Adam', 'KALSHI_ADAM_KEY', 1, 500, 1000, now, now],
  )
  await db.run(
    `INSERT INTO gateway_accounts (account_id, display_name, kalshi_credential_ref, enabled, daily_loss_limit_usd, daily_risk_limit_usd, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ['isaiah', 'Isaiah', 'KALSHI_ISAIAH_KEY', 0, 250, 500, now, now],
  )
  const adam = await dp.loaders.loadAccount('adam')
  ok(adam, 'adam exists')
  eq(adam.enabled, 1, 'adam enabled')
  eq(Number(adam.daily_loss_limit_usd), 500, 'adam loss limit')

  const isaiah = await dp.loaders.loadAccount('isaiah')
  eq(isaiah.enabled, 0, 'isaiah disabled')

  const missing = await dp.loaders.loadAccount('nobody')
  eq(missing, null, 'unknown account = null')
}

section('accountStateStore.upsert + loadAccountState')
{
  await dp.accountStateStore.upsert({
    account_id: 'adam',
    trading_date: '2026-04-30',
    realized_pnl_usd: -50,
    open_risk_usd: -10,
    submitted_order_usd: 100,
    daily_loss_limit_usd: 500,
    daily_risk_limit_usd: 1000,
  })
  const s = await dp.loaders.loadAccountState('adam', '2026-04-30')
  ok(s, 'state row loaded')
  eq(Number(s.realized_pnl_usd), -50, 'realized_pnl')
  eq(Number(s.open_risk_usd), -10, 'open_risk')
  eq(Number(s.submitted_order_usd), 100, 'submitted')
  ok(s.updated_at, 'updated_at present')

  // Upsert again with new values
  await dp.accountStateStore.upsert({
    account_id: 'adam',
    trading_date: '2026-04-30',
    realized_pnl_usd: -75,
    open_risk_usd: -10,
    submitted_order_usd: 150,
  })
  const s2 = await dp.loaders.loadAccountState('adam', '2026-04-30')
  eq(Number(s2.realized_pnl_usd), -75, 'realized_pnl updated')
  eq(Number(s2.submitted_order_usd), 150, 'submitted updated')

  // Different trading_date is independent
  const missing = await dp.loaders.loadAccountState('adam', '2026-05-01')
  eq(missing, null, 'different date = null')
}

// ─── Decision Trace lookup ──────────────────────────────────────────
section('loadDecisionEvent — pulls from oracle_trace_events')
{
  const decision_id = 'dec-' + crypto.randomUUID()
  const now = new Date().toISOString()
  await db.run(
    `INSERT INTO oracle_trace_events
       (id, decision_id, parent_event_id, trace_schema_version, created_at,
        layer_name, layer_version, commit_hash, agent_id, agent_version,
        mode, system, event_type,
        pitcher_id, pitcher_name, bet_date, strike, side,
        decision, reason_code, reasoning, metrics,
        evidence_used, input_hash, output_hash,
        status, severity, latency_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      crypto.randomUUID(), decision_id, null, '1.0.0', now,
      'gateway', '1.0.0', 'a'.repeat(40), 'closer-legacy', '0.7.3',
      'production', 'oracle', 'closer_legacy_decision',
      '547179', 'Lorenzen', '2026-04-30', 5, 'NO',
      'pass', 'closer_legacy_decision', '{}', '{}',
      '[]', 'a'.repeat(64), 'b'.repeat(64),
      'success', 'info', 0,
    ],
  )
  const e = await dp.loaders.loadDecisionEvent(decision_id)
  ok(e, 'decision event found')
  eq(e.agent_id, 'closer-legacy', 'agent_id=closer-legacy')

  const missing = await dp.loaders.loadDecisionEvent('does-not-exist')
  eq(missing, null, 'unknown decision_id = null')
}

// ─── Idempotency ────────────────────────────────────────────────────
section('idempotencyStore.upsert + get')
{
  const decision_id = 'idem-' + crypto.randomUUID()
  const body_hash = 'h'.repeat(64)
  await dp.idempotencyStore.upsert({
    decision_id, body_hash,
    last_status: 'accepted',
    exchange_request_sent: 1,
    kalshi_order_id: 'KS-100',
    exchange_status: 'placed',
    response_json: '{"status":"accepted"}',
  })
  const r = await dp.idempotencyStore.get(decision_id)
  ok(r, 'row exists')
  eq(r.last_status, 'accepted', 'last_status=accepted')
  eq(Number(r.exchange_request_sent), 1, 'request_sent=1')
  eq(r.kalshi_order_id, 'KS-100', 'order_id stored')
  ok(r.created_at && r.expires_at, 'timestamps set')

  // Upsert overwrites
  await dp.idempotencyStore.upsert({
    decision_id, body_hash,
    last_status: 'exchange_unknown',
    exchange_request_sent: 1,
    kalshi_order_id: null,
    exchange_status: 'unknown',
    response_json: '{"status":"exchange_unknown"}',
  })
  const r2 = await dp.idempotencyStore.get(decision_id)
  eq(r2.last_status, 'exchange_unknown', 'last_status updated')
  eq(r2.kalshi_order_id, null, 'order_id cleared')
}

section('idempotencyStore.sweepExpired')
{
  // Force a row's expires_at into the past
  const decision_id = 'idem-old'
  await dp.idempotencyStore.upsert({
    decision_id, body_hash: 'g'.repeat(64),
    last_status: 'accepted',
    exchange_request_sent: 1,
    kalshi_order_id: 'KS-OLD',
    exchange_status: 'placed',
    response_json: null,
  })
  await db.run(`UPDATE gateway_idempotency SET expires_at = ? WHERE decision_id = ?`,
    ['2020-01-01T00:00:00.000Z', decision_id])
  const before = await dp.idempotencyStore.get(decision_id)
  ok(before, 'old row exists pre-sweep')

  const r = await dp.idempotencyStore.sweepExpired()
  ok(r.deleted >= 1, 'sweep removed ≥1 row')

  const after = await dp.idempotencyStore.get(decision_id)
  eq(after, null, 'old row gone post-sweep')
}

// ─── Unknowns queue ─────────────────────────────────────────────────
section('unknownsStore.enqueue + listUnresolved + markResolved + bumpAttempt')
{
  const decision_id_a = 'unk-' + crypto.randomUUID()
  const decision_id_b = 'unk-' + crypto.randomUUID()
  await dp.unknownsStore.enqueue({
    decision_id: decision_id_a,
    account_id: 'adam',
    market_ticker: 'KX-MARKET-A',
    submitted_at: new Date(Date.now() - 120_000).toISOString(),
  })
  await dp.unknownsStore.enqueue({
    decision_id: decision_id_b,
    account_id: 'adam',
    market_ticker: 'KX-MARKET-B',
    submitted_at: new Date().toISOString(),
  })
  const all = await dp.unknownsStore.listUnresolved({ olderThanMs: 0 })
  eq(all.length, 2, 'two unresolved')
  // Older first (ASC by submitted_at)
  eq(all[0].decision_id, decision_id_a, 'older first')

  const stale = await dp.unknownsStore.listUnresolved({ olderThanMs: 60_000 })
  eq(stale.length, 1, 'only the >60s-old one matches threshold')
  eq(stale[0].decision_id, decision_id_a, 'stale = older one')

  // Bump attempts
  await dp.unknownsStore.bumpAttempt(all[0].id)
  await dp.unknownsStore.bumpAttempt(all[0].id)
  const afterBump = (await dp.unknownsStore.listUnresolved({ olderThanMs: 0 }))[0]
  eq(Number(afterBump.attempts), 2, 'attempts=2 after two bumps')
  ok(afterBump.last_check_at, 'last_check_at set')

  // Resolve A
  await dp.unknownsStore.markResolved(all[0].id, {
    resolved_status: 'placed',
    resolved_at: new Date().toISOString(),
    kalshi_order_id: 'KS-RES-A',
    last_check_response: '{"status":"placed"}',
  })
  const remaining = await dp.unknownsStore.listUnresolved({ olderThanMs: 0 })
  eq(remaining.length, 1, 'one remains after resolve')
  eq(remaining[0].decision_id, decision_id_b, 'resolved one is gone from list')
}

// ─── Killswitch ─────────────────────────────────────────────────────
section('killswitchFetcher + killswitchStore.set')
{
  // Empty fetcher initially returns []
  const empty = await dp.killswitchFetcher()
  eq(empty.length, 0, 'no killswitch rows initially')

  await dp.killswitchStore.set('gateway_kill_all', 'true', 'admin')
  await dp.killswitchStore.set('gateway_kill_agent', ['closer-legacy'], 'admin')
  await dp.killswitchStore.set('min_version_by_agent', { 'closer-legacy': '0.7.3' }, 'admin')
  const rows = await dp.killswitchFetcher()
  eq(rows.length, 3, '3 keys stored')
  const byKey = Object.fromEntries(rows.map(r => [r.key, r.value]))
  eq(byKey.gateway_kill_all, 'true', 'kill_all stored as string "true"')
  ok(byKey.gateway_kill_agent.includes('closer-legacy'), 'kill_agent JSON contains closer-legacy')
  ok(byKey.min_version_by_agent.includes('0.7.3'), 'min_version JSON contains 0.7.3')

  // Update existing key
  await dp.killswitchStore.set('gateway_kill_all', 'false', 'admin2')
  const row = await db.one(`SELECT value, updated_by FROM gateway_killswitch WHERE key='gateway_kill_all'`)
  eq(row.value, 'false', 'value updated')
  eq(row.updated_by, 'admin2', 'updated_by recorded')
}

// ─── client_order_id persistence (Bite 1 plumbing) ─────────────────
section('client_order_id persists through idempotency upsert + load')
{
  const decision_id = 'idem-coid-' + crypto.randomUUID()
  const COID = 'gateway_abc123def456'  // synthetic
  await dp.idempotencyStore.upsert({
    decision_id, body_hash: 'b'.repeat(64),
    client_order_id: COID,
    last_status: 'exchange_unknown',
    exchange_request_sent: 1,
    kalshi_order_id: null,
    exchange_status: 'unknown',
    response_json: '{"status":"exchange_unknown"}',
  })
  const r = await dp.idempotencyStore.get(decision_id)
  eq(r.client_order_id, COID, 'client_order_id persisted on idempotency')

  // Re-upsert without client_order_id should preserve existing (COALESCE)
  await dp.idempotencyStore.upsert({
    decision_id, body_hash: 'b'.repeat(64),
    last_status: 'accepted',
    exchange_request_sent: 1,
    kalshi_order_id: 'KS-RESOLVED',
    exchange_status: 'placed',
    response_json: '{"status":"accepted"}',
  })
  const r2 = await dp.idempotencyStore.get(decision_id)
  eq(r2.client_order_id, COID, 'client_order_id preserved on subsequent upsert')
  eq(r2.last_status, 'accepted', 'other fields update')
}

section('client_order_id persists through unknowns enqueue + listUnresolved')
{
  const decision_id = 'unk-coid-' + crypto.randomUUID()
  const COID = 'gateway_deadbeef00112233'
  await dp.unknownsStore.enqueue({
    decision_id,
    client_order_id: COID,
    account_id: 'adam',
    market_ticker: 'KX-COID',
    submitted_at: new Date().toISOString(),
  })
  const all = await dp.unknownsStore.listUnresolved({ olderThanMs: 0 })
  const row = all.find(r => r.decision_id === decision_id)
  ok(row, 'enqueued row visible')
  eq(row.client_order_id, COID, 'client_order_id surfaced on list')
}

section('bumpUnknownAttempt records error_code + last_check_response')
{
  const decision_id = 'unk-bump-' + crypto.randomUUID()
  await dp.unknownsStore.enqueue({
    decision_id,
    client_order_id: 'gateway_test1234567890ab',
    account_id: 'adam',
    market_ticker: 'KX-BUMP',
    submitted_at: new Date().toISOString(),
  })
  const [row] = (await dp.unknownsStore.listUnresolved({ olderThanMs: 0 })).filter(r => r.decision_id === decision_id)
  await dp.unknownsStore.bumpAttempt(row.id, { error_code: 'lookup_5xx', response: '{"http":503}' })
  const [after] = (await dp.unknownsStore.listUnresolved({ olderThanMs: 0 })).filter(r => r.decision_id === decision_id)
  eq(Number(after.attempts), 1, 'attempts incremented')
  eq(after.last_check_error_code, 'lookup_5xx', 'error_code recorded')
  eq(after.last_check_response, '{"http":503}', 'response recorded')
}

// ─── Cleanup ────────────────────────────────────────────────────────
console.log(`\n${_passed} passed, ${_failed} failed`)
client.close()
await fs.rm(tmpDir, { recursive: true, force: true })
process.exit(_failed > 0 ? 1 : 0)
