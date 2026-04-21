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

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public')

export function createApp() {
  const app = express()

  // Behind Railway / any HTTPS reverse proxy, trust X-Forwarded-Proto so
  // secure cookies actually land. Harmless in dev.
  app.set('trust proxy', 1)

  app.use(express.json({ limit: '1mb' }))
  app.use(cookieParser())
  app.use(sessionMiddleware())

  // Public health check — shows DB status and user count (no auth required)
  app.get('/health', async (req, res) => {
    try {
      const users = await db.all('SELECT name FROM users')
      const bets  = await db.one('SELECT COUNT(*) as n FROM ks_bets')
      res.json({ ok: true, users: users.map(u => u.name), bets: bets?.n, db: 'turso' })
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

  // Static assets that aren't behind auth (css/js shipped to the browser).
  // The login page's /style.css and friends must be reachable without a session.
  app.use('/style.css', express.static(path.join(PUBLIC_DIR, 'style.css')))
  app.use('/app.js', express.static(path.join(PUBLIC_DIR, 'app.js')))

  // Gated API.
  app.use('/api', requireAuth, apiRouter)

  // Gated dashboard HTML.
  app.get('/', requireAuth, (req, res) => {
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

export function startServer() {
  const port = Number(process.env.PORT || 3001)
  const app = createApp()
  return app.listen(port, async () => {
    await db.migrate()
    await seedUsersFromEnv()
    console.log(`[mlbie] dashboard listening on http://localhost:${port}`)
  })
}

// Allow `node server/index.js` to boot standalone too.
if (import.meta.url === `file://${process.argv[1]}`) {
  startServer()
}
