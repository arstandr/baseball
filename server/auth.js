// server/auth.js — Username + PIN authentication backed by the users DB table.
//
// Uses signed cookies (HMAC-SHA256) instead of express-session so auth
// survives Railway redeploys without any server-side session storage.

import { createHmac, timingSafeEqual } from 'node:crypto'
import * as db from '../lib/db.js'

const COOKIE_NAME = 'mlbie.auth'
const COOKIE_MAX_AGE = 7 * 24 * 60 * 60 * 1000  // 7 days ms

function getSecret() {
  return process.env.SESSION_SECRET || 'ksbets-2026-secret-key-baseball'
}

// ── Token helpers ────────────────────────────────────────────────────────────

function signToken(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig  = createHmac('sha256', getSecret()).update(data).digest('base64url')
  return `${data}.${sig}`
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null
  const dot = token.lastIndexOf('.')
  if (dot < 0) return null
  const data = token.slice(0, dot)
  const sig  = token.slice(dot + 1)
  const expected = createHmac('sha256', getSecret()).update(data).digest('base64url')
  try {
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null
  } catch { return null }
  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString())
    if (payload.exp && Date.now() > payload.exp) return null
    return payload
  } catch { return null }
}

// ── Session-compatible shim so existing req.session.user references keep working ──

function attachUserToReq(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME]
  const payload = verifyToken(token)
  if (payload?.name) {
    req.session = req.session || {}
    req.session.user = { id: payload.id ?? null, name: payload.name }
  } else {
    req.session = req.session || {}
    req.session.user = null
  }
  next()
}

// ── Seed default users ───────────────────────────────────────────────────────

const DEFAULT_USERS = [
  { name: 'Adam',   pin: '1031'  },
  { name: 'Isaiah', pin: '4994' },
]

export async function seedUsersFromEnv() {
  for (let i = 1; i <= 9; i++) {
    const name = process.env[`USER${i}_NAME`]
    const pin  = process.env[`USER${i}_PIN`]
    if (!name || !pin) continue
    try {
      await db.run(`INSERT OR IGNORE INTO users (name, pin) VALUES (?, ?)`, [name.trim(), pin.trim()])
    } catch { /* table may not exist yet */ }
  }
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

// ── Middleware ───────────────────────────────────────────────────────────────

export function sessionMiddleware() {
  return attachUserToReq
}

export function requireAuth(req, res, next) {
  if (req.session?.user) return next()
  if ((req.originalUrl || '').startsWith('/api/') || req.xhr) {
    return res.status(401).json({ error: 'unauthenticated' })
  }
  return res.redirect('/login')
}

// ── Auth routes ──────────────────────────────────────────────────────────────

export function registerAuthRoutes(app) {
  // POST /auth/login
  app.post('/auth/login', async (req, res) => {
    const { username, pin } = req.body || {}
    if (!username || !pin) {
      return res.status(400).json({ error: 'Username and PIN required' })
    }
    try {
      const user = await db.one(
        `SELECT id, name FROM users WHERE name = ? AND pin = ? COLLATE NOCASE`,
        [String(username).trim(), String(pin).trim()],
      )
      if (!user) return res.status(401).json({ error: 'Invalid username or PIN' })

      const token = signToken({
        id:   user.id,
        name: user.name,
        exp:  Date.now() + COOKIE_MAX_AGE,
      })
      const isProd = process.env.NODE_ENV === 'production'
      res.cookie(COOKIE_NAME, token, {
        httpOnly: true,
        sameSite: 'lax',
        secure:   isProd,
        maxAge:   COOKIE_MAX_AGE,
        path:     '/',
      })
      res.json({ ok: true, name: user.name })
    } catch (err) {
      console.error('[auth] login error:', err.message)
      res.status(500).json({ error: 'Server error' })
    }
  })

  // GET /auth/logout
  app.get('/auth/logout', (req, res) => {
    res.clearCookie(COOKIE_NAME, { path: '/' })
    res.redirect('/login')
  })

  // GET /auth/me
  app.get('/auth/me', (req, res) => {
    if (req.session?.user) return res.json({ user: req.session.user })
    res.status(401).json({ user: null })
  })
}
