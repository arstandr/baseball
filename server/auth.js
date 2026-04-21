// server/auth.js — Username + PIN authentication backed by the users DB table.
//
// Users are stored in the `users` table (see db/schema.sql).
// On server startup, any USERn_NAME / USERn_PIN env vars are seeded into the
// table so existing .env configs keep working without manual migration.
//
// To add a user via CLI: node scripts/addUser.js --name Isaiah --pin 1234

import session from 'express-session'
import * as db from '../lib/db.js'

// ------------------------------------------------------------------
// Session middleware
// ------------------------------------------------------------------
export function sessionMiddleware() {
  const secret = process.env.SESSION_SECRET || 'ksbets-2026-secret-key-baseball'
  const isProd = process.env.NODE_ENV === 'production'
  return session({
    secret,
    resave: false,
    saveUninitialized: false,
    name: 'mlbie.sid',
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: isProd,
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    },
  })
}

// ------------------------------------------------------------------
// Seed ENV users (USER1_NAME/USER1_PIN ... USER9_NAME/USER9_PIN)
// Called once at server startup. Safe to call repeatedly (INSERT OR IGNORE).
// ------------------------------------------------------------------
const DEFAULT_USERS = [
  { name: 'adam',   pin: '1031'  },
  { name: 'isaiah', pin: '49994' },
]

export async function seedUsersFromEnv() {
  // Seed from env vars first
  for (let i = 1; i <= 9; i++) {
    const name = process.env[`USER${i}_NAME`]
    const pin  = process.env[`USER${i}_PIN`]
    if (!name || !pin) continue
    try {
      await db.run(`INSERT OR IGNORE INTO users (name, pin) VALUES (?, ?)`, [name.trim(), pin.trim()])
    } catch { /* table may not exist yet */ }
  }
  // Always ensure default users exist (upsert so PIN stays correct)
  for (const u of DEFAULT_USERS) {
    try {
      await db.run(
        `INSERT INTO users (name, pin) VALUES (?, ?)
         ON CONFLICT(name) DO UPDATE SET pin = excluded.pin`,
        [u.name, u.pin],
      )
    } catch { /* ignore */ }
  }
}

// ------------------------------------------------------------------
// requireAuth middleware
// ------------------------------------------------------------------
export function requireAuth(req, res, next) {
  if (req.session?.user) return next()
  if ((req.originalUrl || '').startsWith('/api/') || req.xhr) {
    return res.status(401).json({ error: 'unauthenticated' })
  }
  return res.redirect('/login')
}

// ------------------------------------------------------------------
// Auth routes
// ------------------------------------------------------------------
export function registerAuthRoutes(app) {
  // POST /auth/login
  app.post('/auth/login', async (req, res) => {
    const { username, pin } = req.body || {}
    if (!username || !pin) {
      return res.status(400).json({ error: 'Username and PIN required' })
    }
    try {
      const user = await db.one(
        `SELECT name FROM users WHERE name = ? AND pin = ? COLLATE NOCASE`,
        [String(username).trim(), String(pin).trim()],
      )
      if (!user) return res.status(401).json({ error: 'Invalid username or PIN' })
      req.session.user = { name: user.name }
      req.session.save(err => {
        if (err) return res.status(500).json({ error: 'Session error' })
        res.json({ ok: true, name: user.name })
      })
    } catch (err) {
      console.error('[auth] login error:', err.message)
      res.status(500).json({ error: 'Server error' })
    }
  })

  // GET /auth/logout
  app.get('/auth/logout', (req, res) => {
    req.session?.destroy(() => {
      res.clearCookie('mlbie.sid')
      res.redirect('/login')
    })
  })

  // GET /auth/me
  app.get('/auth/me', (req, res) => {
    if (req.session?.user) return res.json({ user: req.session.user })
    res.status(401).json({ user: null })
  })
}
