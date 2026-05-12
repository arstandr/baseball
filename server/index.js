// server/index.js — Express entry point for the MLBIE dashboard.
//
// Mounts:
//   - express-session (cookie-backed sessions)
//   - /auth/*           Google OAuth flow (auth.js)
//   - /api/*            dashboard JSON (api.js) — gated by requireAuth
//   - /                 dashboard HTML       (public/index.html) — gated
//   - /login            login page           (public/login.html)
//   - public/           static assets        (public/)
//
// The CLI launches this via `mlbie serve`.

import express from 'express'
import cookieParser from 'cookie-parser'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import 'dotenv/config'

import { sessionMiddleware, registerAuthRoutes, requireAuth, seedUsersFromEnv } from './auth.js'
import * as db from '../lib/db.js'
import apiRouter from './api.js'
import { startScheduler } from './scheduler.js'
import { startWsDaemon, getWsDaemonStatus } from './wsDaemon.js'
import { initOracle } from '../oracle/init.js'
import * as traceImpl from '../oracle/layers/0-trace/impl.js'
import * as kalshiLib from '../lib/kalshi.js'
import { buildGateway, resolveConfigFromEnv } from '../oracle/layers/6-gateway/buildGateway.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public')

export function createApp({ gateway = null } = {}) {
  const app = express()

  // Behind Railway / any HTTPS reverse proxy, trust X-Forwarded-Proto so
  // secure cookies actually land. Harmless in dev.
  app.set('trust proxy', 1)

  // Layer 6 Gateway routes mount FIRST so their express.raw middleware sees
  // the original request bytes — required for HMAC body-hash verification.
  // The global express.json below applies to every other route.
  if (gateway) {
    gateway.mount(app, {
      rawJsonMiddleware: express.raw({ type: 'application/json', limit: '1mb' }),
    })
  }

  app.use(express.json({ limit: '1mb' }))
  app.use(cookieParser())
  app.use(sessionMiddleware())

  // Public health check — shows DB status, user count, and WS daemon status (no auth required)
  app.get('/health', async (req, res) => {
    try {
      const users = await db.all('SELECT name FROM users')
      const bets  = await db.one('SELECT COUNT(*) as n FROM ks_bets')
      const wsClients = getWsDaemonStatus()
      const wsOk = wsClients.length > 0 && wsClients.every(
        c => c.state === 'subscribed' && (c.lastMsgAgoMs === null || c.lastMsgAgoMs < 5 * 60 * 1000)
      )
      res.json({ ok: true, users: users.map(u => u.name), bets: bets?.n, db: 'turso', ws: { ok: wsOk, clients: wsClients } })
    } catch (err) {
      res.json({ ok: false, error: err.message })
    }
  })

  // Auth routes (public).
  registerAuthRoutes(app)

  // Login page (public). Already logged in? bounce to the dashboard.
  app.get('/login', (req, res) => {
    if (req.session?.user) return res.redirect('/')
    res.sendFile(path.join(PUBLIC_DIR, 'login.html'))
  })

  // Public deploy-date endpoint for login page footer
  const _startedAt = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
  app.get('/api/deploy-date', (req, res) => res.json({ date: _startedAt }))

  // Static assets that aren't behind auth (css/js shipped to the browser).
  // The login page's /style.css and friends must be reachable without a session.
  const noCache = { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate') }
  app.use('/style.css', express.static(path.join(PUBLIC_DIR, 'style.css'), noCache))
  app.use('/app.js',    express.static(path.join(PUBLIC_DIR, 'app.js'),    noCache))
  app.use('/app/',      express.static(path.join(PUBLIC_DIR, 'app'),       noCache))

  // Gated API.
  app.use('/api', requireAuth, apiRouter)

  // Gated dashboard HTML.
  app.get('/', requireAuth, (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'))
  })

  // Any other static files inside public/ are also gated (future images, etc.)
  app.use(requireAuth, express.static(PUBLIC_DIR))

  // Fallback 404 → JSON for /api, HTML redirect otherwise.
  app.use((req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'not_found' })
    res.redirect('/')
  })

  return app
}

function printGatewayBanner(gateway) {
  const accountsMatch = String(gateway.readiness.accounts ?? '').match(/(\d+)_enabled/)
  const accountsLoaded = accountsMatch ? Number(accountsMatch[1]) : 0
  const lines = [
    '════════════════════════════════════════',
    '  Gateway initialized',
    `  mode=${gateway.mode}`,
    `  accountsLoaded=${accountsLoaded}`,
    `  routesMounted=true`,
    `  productionWrites=${gateway.mode === 'production'}`,
    `  commit=${gateway.readiness.commit}`,
  ]
  if (gateway.mode === 'production') {
    const dl = String(gateway.readiness.deadLetter ?? '')
    lines.push(`  persistentVolume=${dl.startsWith('ok') ? 'ok' : 'NOT_OK'}`)
  } else {
    lines.push(`  deadLetter=${gateway.readiness.deadLetter}`)
  }
  lines.push('════════════════════════════════════════')
  console.log('\n' + lines.join('\n') + '\n')
}

export async function startServer() {
  const port = Number(process.env.PORT || 3001)

  // ── Startup ordering (locked Q-S1) ─────────────────────────────────────
  // 1. DB ready
  await db.migrate()
  await seedUsersFromEnv()

  // 2. Layer 0 Trace (idempotent — scheduler.js also calls this; second is no-op)
  initOracle()

  // 3. Layer 6 Gateway readiness gate — throws on any unhealthy dep.
  //    If this throws, we never start listening; Railway healthcheck fails;
  //    container restarts. No partial-up.
  const gateway = await buildGateway(resolveConfigFromEnv({
    db,
    kalshiLib,
    traceModule: traceImpl,
  }))

  // 4. Loud startup banner — impossible to miss whether shadow vs production
  printGatewayBanner(gateway)

  // 5. Build Express app with Gateway mounted before global express.json
  const app = createApp({ gateway })

  // 6. Listen + start cron jobs
  return app.listen(port, async () => {
    try {
      // Backfill paper=0 for any pre-game bets that placed real Kalshi orders
      // (paper defaults to 1 at INSERT; the post-order UPDATE sometimes missed them).
      // Exclude synthetic paper-XXX order_ids — those come from the KALSHI_PAPER_MODE
      // wrapper and must stay paper=1 forever, otherwise the recon watchdog will halt
      // on every restart (DB sees real-money positions; Kalshi has none).
      await db.run(
        `UPDATE ks_bets SET paper = 0
         WHERE live_bet = 0 AND paper = 1
           AND (order_id IS NOT NULL OR filled_contracts > 0)
           AND (order_id IS NULL OR order_id NOT LIKE 'paper-%')`
      ).catch(e => console.warn('[startup] paper backfill failed:', e.message))

      startScheduler({ gateway }).catch(e => console.error('[scheduler] startup failed:', e.message))
      startWsDaemon().catch(e => console.error('[ws-daemon] startup failed:', e.message))
      console.log(`[mlbie] dashboard listening on http://localhost:${port}`)
      console.log(`[mlbie] Gateway routes mounted: true (mode=${gateway.mode})`)
    } catch (err) {
      // The listen callback can't propagate errors; log loudly.
      console.error('[startup] uncaught error in post-listen init:', err)
    }
  })
}

// Allow `node server/index.js` to boot standalone too.
if (import.meta.url === `file://${process.argv[1]}`) {
  startServer()
}
