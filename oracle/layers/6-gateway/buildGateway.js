// oracle/layers/6-gateway/buildGateway.js
//
// Layer 6: Gateway — production composer.
// Where tested pieces become production behavior (Q-C1..Q-C5 lock).
//
// Responsibilities:
//   1. Resolve config + env vars (mode, secrets, paths, commit).
//   2. Run the readiness gate — verify every dep is healthy BEFORE returning:
//        DB, Trace, killswitch, dead-letter, halt, accounts, env, enums,
//        plus mode-specific checks (volume required in production, etc).
//   3. Wire all deps the route handlers need.
//   4. Return { deps, mode, readiness, mount(app), shutdown() }.
//   5. Throw on any readiness failure → caller crashes process → Railway
//      restarts. Partial-up is forbidden (Q-C4).

import { buildDataPlane } from './dataPlane.js'
import { makeKillswitchCache } from './killswitchCache.js'
import { makeTraceAdapter } from './traceAdapter.js'
import { makeDeadLetter } from './deadLetter.js'
import { makeHaltState } from './halt.js'
import { makeKalshiClient } from './kalshiClient.js'
import { makeRateLimiter, mountGatewayRoutes } from './route.js'
import { AGENTS, STRATEGY_MODES } from './enums.js'

const DEFAULT_DEAD_LETTER_PATH = '/data/oracle/dead-letter'
const DEFAULT_KALSHI_TIMEOUT_MS = 2000
const DEFAULT_RATE_LIMIT = 120

// ────────────────────────────────────────────────────────────────────────
// Config resolution
// ────────────────────────────────────────────────────────────────────────

export function resolveConfigFromEnv({ env = process.env, db, kalshiLib, traceModule } = {}) {
  if (!db) throw new Error('resolveConfigFromEnv: db is required')

  const explicitMode = env.GATEWAY_MODE
  const isProduction = env.NODE_ENV === 'production'
  const mode = explicitMode === 'production' ? 'production' : 'shadow'
  const modeDefaultedFromEnv = !explicitMode && isProduction  // for warn alert

  return {
    mode,
    modeDefaultedFromEnv,
    db,
    kalshiLib,
    traceModule,
    commitHash: env.COMMIT_HASH ?? env.RAILWAY_GIT_COMMIT_SHA ?? 'unknown',
    deadLetterPath: env.GATEWAY_DEAD_LETTER_PATH ?? DEFAULT_DEAD_LETTER_PATH,
    adminSecret: env.GATEWAY_ADMIN_SECRET ?? null,
    agentSecrets: collectAgentSecrets(env),
    requiredAgents: parseList(env.GATEWAY_REQUIRED_AGENTS) ?? ['closer-legacy'],
    defaultRateLimit: parseIntOr(env.GATEWAY_DEFAULT_RATE_LIMIT, DEFAULT_RATE_LIMIT),
    kalshiTimeoutMs: parseIntOr(env.GATEWAY_KALSHI_TIMEOUT_MS, DEFAULT_KALSHI_TIMEOUT_MS),
    rawJsonMiddleware: null,  // mount() asks for it
  }
}

function collectAgentSecrets(env) {
  const out = {}
  // Convention: GATEWAY_SECRET_<AGENT_UPPER_SNAKE> e.g. GATEWAY_SECRET_CLOSER_LEGACY
  for (const a of AGENTS) {
    const key = `GATEWAY_SECRET_${a.toUpperCase().replace(/[-]/g, '_')}`
    if (env[key]) out[a] = env[key]
  }
  return out
}

function parseList(s) {
  if (!s) return null
  return s.split(',').map(x => x.trim()).filter(Boolean)
}
function parseIntOr(s, dflt) {
  const n = Number(s)
  return Number.isFinite(n) && n > 0 ? n : dflt
}

// ────────────────────────────────────────────────────────────────────────
// Readiness checks — each throws on failure; readiness object updated in-place
// ────────────────────────────────────────────────────────────────────────

async function checkDb(db, readiness) {
  try {
    const r = await db.one(`SELECT 1 AS one`)
    if (!r || Number(r.one) !== 1) throw new Error('SELECT 1 returned unexpected')
    readiness.db = 'ok'
  } catch (err) {
    readiness.db = `fail:${err.message}`
    throw new Error(`buildGateway: DB unreachable — ${err.message}`)
  }
}

async function checkTrace(traceModule, commitHash, readiness) {
  if (!traceModule || typeof traceModule.writeSync !== 'function' || typeof traceModule.makeEvent !== 'function') {
    readiness.trace = 'fail:missing_traceModule'
    throw new Error('buildGateway: traceModule { writeSync, makeEvent } required')
  }
  try {
    const probe = traceModule.makeEvent({
      decision_id: `gateway-init-probe-${Date.now()}`,
      layer_name: 'gateway',
      layer_version: '1.0.0',
      commit_hash: commitHash,
      agent_id: 'gateway-init-probe',
      agent_version: '1.0.0',
      mode: 'production',
      system: 'oracle',
      event_type: 'health_check',  // Apr 30 patch: was 'gateway_init_probe' but TraceEvent validator only accepts: decision, health_check, heartbeat, config_change, error
      pitcher_id: '0',
      pitcher_name: 'init',
      bet_date: '',
      strike: 0,
      side: 'YES',
      decision: 'pass',
      reason_code: 'gateway_init_probe',
      reasoning: { startedAt: new Date().toISOString() },
      metrics: {},
      input_hash: 'a'.repeat(64),
      output_hash: 'a'.repeat(64),
      evidence_used: [],
    })
    await traceModule.writeSync(probe)
    readiness.trace = 'ok'
  } catch (err) {
    readiness.trace = `fail:${err.message}`
    throw new Error(`buildGateway: Trace round-trip failed — ${err.message}`)
  }
}

async function checkKillswitch(killswitchCache, readiness) {
  try {
    const snap = await killswitchCache.get()
    if (!snap || typeof snap !== 'object') throw new Error('snapshot not an object')
    readiness.killswitch = 'ok'
  } catch (err) {
    readiness.killswitch = `fail:${err.message}`
    throw new Error(`buildGateway: killswitch fetch failed — ${err.message}`)
  }
}

async function checkDeadLetter(deadLetter, mode, readiness) {
  // init() can throw (e.g. mkdir EACCES). probe() returns { ok, error }.
  // Production: any failure aborts boot. Shadow: warn-only.
  let initRes = null
  try {
    initRes = await deadLetter.init()
  } catch (err) {
    if (mode === 'production') {
      readiness.deadLetter = `fail:init:${err.message}`
      throw new Error(`buildGateway: dead-letter init failed — ${err.message}`)
    }
    readiness.deadLetter = `warn:init_failed:${(err.message ?? '').slice(0, 120)}`
    console.warn(`[buildGateway] dead-letter init failed in shadow (warn-only): ${err.message}`)
    return
  }
  const probe = await deadLetter.probe()
  if (!probe.ok) {
    if (mode === 'production') {
      readiness.deadLetter = `fail:probe:${probe.error}`
      throw new Error(`buildGateway: dead-letter probe failed in production — ${probe.error}`)
    }
    readiness.deadLetter = `warn:probe_failed:${probe.error}`
    console.warn(`[buildGateway] dead-letter probe failed in shadow (warn-only): ${probe.error}`)
    return
  }
  readiness.deadLetter = initRes.had_prior_sentinel ? 'ok' : 'ok:fresh_volume'
}

function checkEnvSecrets(cfg, readiness) {
  const missing = []
  if (!cfg.adminSecret) missing.push('GATEWAY_ADMIN_SECRET')
  for (const agent of cfg.requiredAgents) {
    if (!cfg.agentSecrets[agent]) missing.push(`GATEWAY_SECRET_${agent.toUpperCase().replace(/-/g, '_')}`)
  }
  if (missing.length) {
    readiness.env = `fail:missing:${missing.join(',')}`
    throw new Error(`buildGateway: missing required env vars — ${missing.join(', ')}`)
  }
  readiness.env = 'ok'
}

async function checkAccounts(dataPlane, mode, readiness) {
  try {
    // Cheapest viable check: read every gateway_accounts row.
    // Composer doesn't validate enabled accounts have a corresponding daily_state
    // row — that comes from the settlement updater and may briefly lag.
    const rows = await dataPlane._db?.all?.(`SELECT * FROM gateway_accounts`)
      ?? await directQuery(dataPlane, `SELECT account_id, display_name, kalshi_credential_ref, enabled, daily_loss_limit_usd, daily_risk_limit_usd FROM gateway_accounts`)

    if (!Array.isArray(rows)) throw new Error('account query returned non-array')

    const enabled = rows.filter(r => Number(r.enabled) === 1)
    const issues = []
    for (const a of enabled) {
      if (!a.account_id || typeof a.account_id !== 'string') issues.push(`bad_account_id:${a.account_id}`)
      if (mode === 'production' && !a.kalshi_credential_ref) issues.push(`missing_credential_ref:${a.account_id}`)
      // limits checked at runtime per spec — composer just verifies row exists
    }
    if (issues.length) {
      readiness.accounts = `fail:${issues.join(',')}`
      throw new Error(`buildGateway: account sanity check failed — ${issues.join('; ')}`)
    }
    readiness.accounts = `ok:${enabled.length}_enabled`
    return enabled
  } catch (err) {
    if (readiness.accounts == null || readiness.accounts === 'pending') {
      readiness.accounts = `fail:${err.message}`
    }
    throw new Error(`buildGateway: account validation failed — ${err.message}`)
  }
}

// Helper because dataPlane doesn't expose db directly
async function directQuery(dataPlane, sql) {
  // dataPlane internally holds the db; we don't expose it. So fall back to
  // a closure trick: callers that want to validate accounts pass the db.
  // (In practice, buildGateway has db on the config and uses it directly.)
  throw new Error('directQuery: require db passed to checkAccounts')
}

function buildKalshiCredentials(accounts, env, mode, readiness) {
  const credentials = {}
  if (mode !== 'production') {
    // shadow: empty map; kalshi client never reached via the GATEWAY_MODE override
    return credentials
  }
  const missing = []
  for (const a of accounts) {
    const ref = a.kalshi_credential_ref
    const keyId = env[`${ref}_KEY_ID`]
    const pem   = env[`${ref}_PRIVATE_KEY_PEM`]
    if (!keyId || !pem) {
      missing.push(`${a.account_id}: ${ref}_KEY_ID/_PRIVATE_KEY_PEM`)
      continue
    }
    credentials[a.account_id] = { KALSHI_API_KEY_ID: keyId, KALSHI_PRIVATE_KEY_PEM: pem }
  }
  if (missing.length) {
    readiness.kalshi = `fail:missing_creds:${missing.join('|')}`
    throw new Error(`buildGateway: missing Kalshi credentials in production — ${missing.join('; ')}`)
  }
  readiness.kalshi = `ok:${Object.keys(credentials).length}_accounts`
  return credentials
}

// ────────────────────────────────────────────────────────────────────────
// Main composer
// ────────────────────────────────────────────────────────────────────────

export async function buildGateway(config = {}) {
  if (!config.db) throw new Error('buildGateway: config.db required')
  if (!config.traceModule) throw new Error('buildGateway: config.traceModule required (e.g. import * as trace from "../0-trace/impl.js")')
  if (!config.kalshiLib && config.mode === 'production') {
    throw new Error('buildGateway: config.kalshiLib required in production mode')
  }

  const startedAt = Date.now()
  const mode = config.mode === 'production' ? 'production' : 'shadow'
  const commitHash = config.commitHash ?? 'unknown'

  const readiness = {
    db:           'pending',
    trace:        'pending',
    killswitch:   'pending',
    deadLetter:   'pending',
    halt:         'pending',
    env:          'pending',
    accounts:     'pending',
    kalshi:       mode === 'production' ? 'pending' : 'skipped:shadow',
    ready:        false,
    mode,
    commit:       commitHash,
    started_at:   new Date(startedAt).toISOString(),
    server_clock_iso: new Date().toISOString(),
  }

  // 1. ENV — fail fast
  checkEnvSecrets(config, readiness)

  // 2. DB
  await checkDb(config.db, readiness)

  // 3. Trace round-trip
  await checkTrace(config.traceModule, commitHash, readiness)

  // 4. Build dataPlane (uses verified DB)
  const dataPlane = buildDataPlane(config.db)

  // 5. Killswitch cache (first load doubles as health check)
  const killswitchCache = makeKillswitchCache({
    fetcher: dataPlane.killswitchFetcher,
    ttlMs: 1000,
  })
  await checkKillswitch(killswitchCache, readiness)

  // 6. Dead-letter init + probe
  const deadLetter = makeDeadLetter({
    basePath: config.deadLetterPath,
    commitHash,
  })
  await checkDeadLetter(deadLetter, mode, readiness)

  // 7. Halt state
  const halt = makeHaltState()
  readiness.halt = 'ok'

  // 8. Account sanity — query DB directly (we have it on config)
  const enabled = await (async () => {
    try {
      const rows = await config.db.all(
        `SELECT account_id, display_name, kalshi_credential_ref, enabled,
                daily_loss_limit_usd, daily_risk_limit_usd
           FROM gateway_accounts`,
      )
      const enabledRows = rows.filter(r => Number(r.enabled) === 1)
      const issues = []
      for (const a of enabledRows) {
        if (!a.account_id) issues.push(`missing_account_id`)
        if (mode === 'production' && !a.kalshi_credential_ref) issues.push(`missing_credential_ref:${a.account_id}`)
      }
      if (issues.length) {
        readiness.accounts = `fail:${issues.join(',')}`
        throw new Error(`account sanity failed — ${issues.join('; ')}`)
      }
      readiness.accounts = `ok:${enabledRows.length}_enabled`
      return enabledRows
    } catch (err) {
      if (!readiness.accounts.startsWith('fail:')) readiness.accounts = `fail:${err.message}`
      throw new Error(`buildGateway: account validation failed — ${err.message}`)
    }
  })()

  // 9. Kalshi credentials (production only)
  const env = config.env ?? process.env
  const credentials = buildKalshiCredentials(enabled, env, mode, readiness)

  // 10. Build kalshi client (real in production, stub in shadow)
  let kalshiClient
  if (mode === 'production') {
    kalshiClient = makeKalshiClient({
      kalshiLib: config.kalshiLib,
      credentials,
      timeoutMs: config.kalshiTimeoutMs ?? DEFAULT_KALSHI_TIMEOUT_MS,
    })
  } else {
    // Shadow stub: orchestrator should never reach this because route forces
    // execution_mode=shadow upstream. If somehow called, return error so
    // we notice loudly.
    kalshiClient = {
      place: async () => ({ outcome: 'error', error_code: 'shadow_mode_should_not_call_kalshi', raw_response: null }),
      cancel: async () => ({ outcome: 'error', error_code: 'shadow_mode_should_not_call_kalshi', raw_response: null }),
      amend: async () => ({ outcome: 'error', error_code: 'shadow_mode_should_not_call_kalshi', raw_response: null }),
    }
  }

  // 11. Trace adapter
  const traceAdapter = makeTraceAdapter(config.traceModule, {
    layerName: 'gateway',
    layerVersion: '1.0.0',
    environment: env.NODE_ENV ?? 'production',
  })

  // 12. Rate limiter
  const rateLimiter = makeRateLimiter({
    defaultLimitPerMin: config.defaultRateLimit ?? DEFAULT_RATE_LIMIT,
    perAgentLimit: { admin: 20 },
  })

  readiness.ready = true

  // Optional warn: NODE_ENV=production but GATEWAY_MODE defaulted (Q-C5 guard)
  if (config.modeDefaultedFromEnv && mode === 'shadow') {
    console.warn('[buildGateway] WARNING: NODE_ENV=production but GATEWAY_MODE not set — defaulting to shadow')
    try {
      const sysT = traceAdapter.forSystem({ agent_id: 'gateway-init', mode: 'production' })
      const ev = sysT.makeEvent({
        decision_id:  `gateway-mode-default-warn-${Date.now()}`,
        event_type:   'gateway_mode_defaulted',
        decision:     'warn',
        reason_code:  'GATEWAY_MODE_DEFAULTED_TO_SHADOW',
        reasoning:    { reason: 'NODE_ENV=production but GATEWAY_MODE missing' },
        metrics:      {},
        pitcher_id:   '0', pitcher_name: 'init',
        bet_date:     '', strike: 0, side: 'YES',
      })
      config.traceModule.writeAsync(ev)?.catch?.(() => {})
    } catch { /* best-effort */ }
  }

  // ────────────────────────────────────────────────────────────────────
  const deps = {
    trace: {
      writeSync:  config.traceModule.writeSync,
      writeAsync: config.traceModule.writeAsync,
      makeEvent:  config.traceModule.makeEvent,
    },
    kalshi:           kalshiClient,
    // Flat shape — used by route handlers + orchestrator (preserved for compat)
    idempotencyStore: dataPlane.idempotencyStore,
    unknownsStore:    dataPlane.unknownsStore,
    // Nested shape — used by the reconciler, which expects { dataPlane.unknownsStore, dataPlane.idempotencyStore }
    dataPlane: {
      unknownsStore:    dataPlane.unknownsStore,
      idempotencyStore: dataPlane.idempotencyStore,
      loaders:          dataPlane.loaders,
      killswitchFetcher: dataPlane.killswitchFetcher,
      killswitchStore:  dataPlane.killswitchStore,
      nonceSweeper:     dataPlane.nonceSweeper,
      accountStateStore: dataPlane.accountStateStore,
    },
    deadLetter,
    halt,
    killswitchCache,
    killswitchStore:  dataPlane.killswitchStore,
    agentSecrets:     config.agentSecrets,
    loaders:          dataPlane.loaders,
    traceAdapter,
    adminSecret:      config.adminSecret,
    tradingDateFn:    config.tradingDateFn ?? (() => new Date().toISOString().slice(0, 10)),
    now:              config.now ?? Date.now,
    rateLimiter,
    gatewayMode:      mode,
    readiness,
    startedAt,
    commitHash,
  }

  function mount(app, opts = {}) {
    const rawJsonMiddleware = opts.rawJsonMiddleware ?? config.rawJsonMiddleware
    if (typeof rawJsonMiddleware !== 'function') {
      throw new Error('mount: rawJsonMiddleware required — pass express.raw({ type: "application/json", limit: "1mb" })')
    }
    return mountGatewayRoutes(app, deps, { rawJsonMiddleware })
  }

  async function shutdown() {
    // Best-effort: flush Trace queue, close DB if it has a close method
    try {
      if (typeof config.traceModule.shutdown === 'function') {
        await config.traceModule.shutdown(5000)
      }
    } catch { /* ignore */ }
    try {
      if (typeof config.db.close === 'function') config.db.close()
    } catch { /* ignore */ }
  }

  return {
    deps,
    mode,
    readiness,
    mount,
    shutdown,
  }
}
