import express from 'express'
import { execSync } from 'node:child_process'
import * as db from '../../lib/db.js'
import { wrap } from '../shared.js'

let _serverCommit = null
try {
  _serverCommit = (process.env.RAILWAY_GIT_COMMIT_SHA || '').slice(0, 7) || null
  if (!_serverCommit) _serverCommit = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim()
} catch {}

const router = express.Router()

router.get('/users', wrap(async (req, res) => {
  const rows = await db.all(`
    SELECT id, name, created_at,
           active_bettor, starting_bankroll, daily_risk_pct, paper,
           kalshi_key_id,
           CASE WHEN kalshi_private_key IS NOT NULL AND kalshi_private_key != '' THEN 1 ELSE 0 END AS has_kalshi_key,
           discord_webhook
    FROM users ORDER BY created_at ASC`)
  res.json(rows)
}))

router.post('/users', wrap(async (req, res) => {
  const { name, pin } = req.body || {}
  if (!name || !pin) return res.status(400).json({ error: 'name and pin required' })
  if (String(pin).length < 4) return res.status(400).json({ error: 'PIN must be at least 4 digits' })
  try {
    await db.run(`INSERT INTO users (name, pin) VALUES (?, ?)`, [String(name).trim(), String(pin).trim()])
    res.json({ ok: true })
  } catch (err) {
    if (err.message?.includes('UNIQUE')) return res.status(409).json({ error: 'Username already exists' })
    throw err
  }
}))

router.put('/users/:id', wrap(async (req, res) => {
  const id = Number(req.params.id)
  if (!id) return res.status(400).json({ error: 'invalid id' })
  const {
    active_bettor, starting_bankroll, daily_risk_pct, paper,
    kalshi_key_id, kalshi_private_key, discord_webhook, pin,
  } = req.body || {}

  const sets = []
  const vals = []

  if (active_bettor     != null) { sets.push('active_bettor = ?');     vals.push(active_bettor     ? 1 : 0) }
  if (starting_bankroll != null) { sets.push('starting_bankroll = ?'); vals.push(Number(starting_bankroll)) }
  if (daily_risk_pct    != null) { sets.push('daily_risk_pct = ?');    vals.push(Number(daily_risk_pct)) }
  if (paper             != null) { sets.push('paper = ?');             vals.push(paper ? 1 : 0) }
  if (kalshi_key_id     != null) { sets.push('kalshi_key_id = ?');     vals.push(String(kalshi_key_id).trim() || null) }
  if (kalshi_private_key != null && String(kalshi_private_key).trim()) {
    sets.push('kalshi_private_key = ?')
    vals.push(String(kalshi_private_key).trim())
  }
  if (discord_webhook   != null) { sets.push('discord_webhook = ?');   vals.push(String(discord_webhook).trim() || null) }
  if (pin               != null) {
    if (String(pin).length < 4) return res.status(400).json({ error: 'PIN must be at least 4 digits' })
    sets.push('pin = ?'); vals.push(String(pin).trim())
  }

  if (!sets.length) return res.status(400).json({ error: 'nothing to update' })
  vals.push(id)
  await db.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, vals)
  res.json({ ok: true })
}))

router.post('/users/:id/toggle-live', wrap(async (req, res) => {
  const id = Number(req.params.id)
  if (!id) return res.status(400).json({ error: 'invalid id' })
  const user = await db.one(`SELECT paper FROM users WHERE id = ?`, [id])
  if (!user) return res.status(404).json({ error: 'not found' })
  const newPaper = user.paper === 0 ? 1 : 0
  await db.run(`UPDATE users SET paper = ?, paper_temp = 0 WHERE id = ?`, [newPaper, id])
  res.json({ ok: true, paper: newPaper, live: newPaper === 0 })
}))

router.delete('/users/:name', wrap(async (req, res) => {
  const target = req.params.name
  if (req.session?.user?.name?.toLowerCase() === target.toLowerCase()) {
    return res.status(400).json({ error: "Can't remove your own account" })
  }
  await db.run(`DELETE FROM users WHERE name = ? COLLATE NOCASE`, [target])
  res.json({ ok: true })
}))

router.get('/agent/status', wrap(async (req, res) => {
  const rows = await db.all(`SELECT key, value, updated_at FROM agent_heartbeat WHERE key IN ('closer','closer_last_update')`)
  const byKey = {}
  for (const r of rows) {
    try { byKey[r.key] = { ...JSON.parse(r.value), updated_at: r.updated_at } } catch { byKey[r.key] = { updated_at: r.updated_at } }
  }
  const closerCommit = byKey['closer']?.commit ?? null
  const isCurrent    = closerCommit && _serverCommit ? closerCommit === _serverCommit : null
  res.json({
    heartbeat:     byKey['closer']             || null,
    last_update:   byKey['closer_last_update'] || null,
    server_commit: _serverCommit,
    is_current:    isCurrent,
  })
}))

export default router
