import express from 'express'
import { execSync } from 'node:child_process'
import * as db from '../../lib/db.js'
import { wrap } from '../shared.js'

async function isAdmin(req) {
  const uid = req.session?.user?.id
  if (!uid) return false
  const u = await db.one(`SELECT is_system_admin FROM users WHERE id = ?`, [uid]).catch(() => null)
  return u?.is_system_admin === 1
}

let _serverCommit = null
try {
  _serverCommit = (process.env.RAILWAY_GIT_COMMIT_SHA || '').slice(0, 7) || null
  if (!_serverCommit) _serverCommit = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim()
} catch {}

const router = express.Router()

router.get('/users', wrap(async (req, res) => {
  const rows = await db.all(`
    SELECT id, name, created_at,
           active_bettor, starting_bankroll, daily_risk_pct,
           pregame_risk_pct, live_daily_risk_pct, free_money_risk_pct,
           paper, kalshi_key_id,
           CASE WHEN kalshi_private_key IS NOT NULL AND kalshi_private_key != '' THEN 1 ELSE 0 END AS has_kalshi_key,
           discord_webhook, daily_loss_limit, is_system_admin
    FROM users ORDER BY created_at ASC`)
  res.json(rows)
}))

router.post('/users', wrap(async (req, res) => {
  if (!await isAdmin(req)) return res.status(403).json({ error: 'Admin access required' })
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
  const id      = Number(req.params.id)
  const selfId  = req.session?.user?.id
  if (!id) return res.status(400).json({ error: 'invalid id' })
  // Allow self-edit (own PIN change); admin required to edit anyone else
  if (id !== selfId && !await isAdmin(req)) return res.status(403).json({ error: 'Admin access required' })
  const {
    active_bettor, starting_bankroll, daily_risk_pct,
    pregame_risk_pct, live_daily_risk_pct, free_money_risk_pct,
    paper, kalshi_key_id, kalshi_private_key, discord_webhook, pin,
    daily_loss_limit,
  } = req.body || {}

  const sets = []
  const vals = []

  if (active_bettor       != null) { sets.push('active_bettor = ?');       vals.push(active_bettor       ? 1 : 0) }
  if (starting_bankroll   != null) { sets.push('starting_bankroll = ?');   vals.push(Number(starting_bankroll)) }
  if (daily_risk_pct      != null) { sets.push('daily_risk_pct = ?');      vals.push(Number(daily_risk_pct)) }
  if (pregame_risk_pct    != null) { sets.push('pregame_risk_pct = ?');    vals.push(Number(pregame_risk_pct)) }
  if (live_daily_risk_pct != null) { sets.push('live_daily_risk_pct = ?'); vals.push(Number(live_daily_risk_pct)) }
  if (free_money_risk_pct != null) { sets.push('free_money_risk_pct = ?'); vals.push(Number(free_money_risk_pct)) }
  if (paper               != null) { sets.push('paper = ?');               vals.push(paper ? 1 : 0) }
  if (kalshi_key_id     != null) { sets.push('kalshi_key_id = ?');     vals.push(String(kalshi_key_id).trim() || null) }
  if (kalshi_private_key != null && String(kalshi_private_key).trim()) {
    sets.push('kalshi_private_key = ?')
    vals.push(String(kalshi_private_key).trim())
  }
  if (discord_webhook   != null) { sets.push('discord_webhook = ?');   vals.push(String(discord_webhook).trim() || null) }
  if (daily_loss_limit  != null) { sets.push('daily_loss_limit = ?');  vals.push(daily_loss_limit === '' ? null : Number(daily_loss_limit)) }
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
  if (!await isAdmin(req)) return res.status(403).json({ error: 'Admin access required' })
  const target = req.params.name
  if (req.session?.user?.name?.toLowerCase() === target.toLowerCase()) {
    return res.status(400).json({ error: "Can't remove your own account" })
  }
  // Soft-delete: zero credentials and deactivate rather than destroying P&L history
  await db.run(
    `UPDATE users SET active_bettor=0, kalshi_key_id=NULL, kalshi_private_key=NULL, paper=1 WHERE name = ? COLLATE NOCASE`,
    [target],
  )
  res.json({ ok: true })
}))

router.get('/agent/status', wrap(async (req, res) => {
  // Fetch all closer heartbeats (per-user: closer_<id>) + legacy single key 'closer'.
  // Also fetch the last-update row which is always keyed 'closer_last_update'.
  const rows = await db.all(
    `SELECT key, value, updated_at FROM agent_heartbeat
     WHERE key LIKE 'closer%'`
  )
  const byKey = {}
  for (const r of rows) {
    try { byKey[r.key] = { ...JSON.parse(r.value), updated_at: r.updated_at } } catch { byKey[r.key] = { updated_at: r.updated_at } }
  }

  // Build per-agent list from all closer_<N> and legacy 'closer' keys.
  const agentKeys = Object.keys(byKey).filter(k => k === 'closer' || /^closer_\d+$/.test(k))
  const agents = agentKeys.map(k => {
    const hb = byKey[k]
    const commit = hb?.commit ?? null
    return {
      key:       k,
      user_id:   k === 'closer' ? null : Number(k.replace('closer_', '')),
      heartbeat: hb,
      is_current: commit && _serverCommit ? commit === _serverCommit : null,
    }
  })

  // Legacy single-agent fields for backward compatibility with existing dashboard code.
  const primaryHb     = byKey['closer'] ?? agents[0]?.heartbeat ?? null
  const primaryCommit = primaryHb?.commit ?? null
  res.json({
    heartbeat:     primaryHb,
    last_update:   byKey['closer_last_update'] || null,
    server_commit: _serverCommit,
    is_current:    primaryCommit && _serverCommit ? primaryCommit === _serverCommit : null,
    agents,        // full per-user agent list for multi-user dashboard
  })
}))

// ── Kill switch + system flags (Items 2, 6) ───────────────────────────────────

router.get('/admin/status', wrap(async (_req, res) => {
  const rows = await db.all(`SELECT key, value, updated_at, updated_by FROM system_flags`).catch(() => [])
  const flags = Object.fromEntries(rows.map(r => [r.key, r]))

  const now = Date.now()
  const heartbeatAge = (k) => {
    const v = Number(flags[k]?.value)
    return Number.isFinite(v) ? Math.round((now - v) / 1000) : null
  }

  // Today's bet activity by strategy_mode (live placements only — paper=0)
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  const fires = await db.all(
    `SELECT strategy_mode,
            COUNT(*) AS n,
            ROUND(SUM(capital_at_risk), 2) AS risk,
            ROUND(SUM(pnl), 2) AS pnl
     FROM ks_bets
     WHERE bet_date = ? AND order_id IS NOT NULL AND order_id NOT LIKE 'paper-%' AND paper = 0
     GROUP BY strategy_mode`,
    [today],
  ).catch(() => [])

  // Open Kalshi-position count via reconciliation last-known
  let lastReconDiff = null
  try { lastReconDiff = JSON.parse(flags.last_reconciliation_diff?.value || '[]') } catch {}

  res.json({
    // Existing fields (kept for backward compat)
    trading_halted:  flags.trading_halted?.value === '1',
    drawdown_scale:  Number(flags.drawdown_scale?.value ?? 1.0),
    flags,
    // ── Cage health ─────────────────────────────────────────────
    cage: {
      scheduler_heartbeat_age_s:     heartbeatAge('scheduler_heartbeat'),
      liveMonitor_heartbeat_age_s:   heartbeatAge('liveMonitor_heartbeat'),
      last_reconciliation_at:        flags.last_reconciliation_pass_at?.value ?? null,
      last_reconciliation_status:    flags.last_reconciliation_status?.value ?? null,
      last_reconciliation_diff:      lastReconDiff,
      drawdown_halted:               flags.drawdown_halted?.value ?? null,
      kalshi_outage:                 flags.kalshi_outage?.value === '1',
    },
    // Strategy posture (read from process env where available)
    strategy: {
      oracle_stage:        Number(process.env.ORACLE_STAGE ?? 0),
      invert_yes_to_no:    String(process.env.INVERT_YES_TO_NO ?? '').toLowerCase() === 'true',
      tier1_enabled:       String(process.env.TIER1_ENABLED ?? '').toLowerCase() === 'true',
      tier2_enabled:       String(process.env.TIER2_ENABLED ?? '').toLowerCase() === 'true',
      tier3_enabled:       String(process.env.TIER3_ENABLED ?? '').toLowerCase() === 'true',
      kalshi_paper_mode:   String(process.env.KALSHI_PAPER_MODE ?? '').toLowerCase() === 'true',
      live_trading:        String(process.env.LIVE_TRADING ?? '').toLowerCase() === 'true',
      discord_errors_only: String(process.env.DISCORD_ERRORS_ONLY ?? 'true').toLowerCase() === 'true',
    },
    // Caps (current Day 1 values — also from env)
    caps: {
      invert_daily:         Number(process.env.INVERT_DAILY_LOSS_LIMIT ?? 150),
      max_invert_per_pitcher: Number(process.env.MAX_INVERT_RISK_PER_PITCHER ?? 50),
      live_daily:           Number(process.env.LIVE_DAILY_LOSS_LIMIT ?? 300),
      max_live_per_pitcher: Number(process.env.MAX_LIVE_RISK_PER_PITCHER ?? 75),
      global_daily:         Number(process.env.GLOBAL_DAILY_LOSS_LIMIT ?? 500),
    },
    // Today's fires
    today: {
      bet_date: today,
      fires_by_mode: fires,
    },
    // Deployed commit
    commit_sha: process.env.COMMIT_SHA ?? 'unknown',
  })
}))

router.post('/admin/halt', wrap(async (req, res) => {
  if (!await isAdmin(req)) return res.status(403).json({ error: 'Admin access required' })
  const who = req.session?.user?.name ?? 'admin'
  await db.run(
    `INSERT INTO system_flags (key,value,updated_at,updated_by) VALUES ('trading_halted','1',?,?)
     ON CONFLICT(key) DO UPDATE SET value='1', updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
    [new Date().toISOString(), who],
  )
  console.log(`[admin] TRADING HALTED by ${who}`)
  res.json({ ok: true, halted: true })
}))

router.post('/admin/resume', wrap(async (req, res) => {
  if (!await isAdmin(req)) return res.status(403).json({ error: 'Admin access required' })
  const who = req.session?.user?.name ?? 'admin'
  await db.run(
    `UPDATE system_flags SET value='0', updated_at=?, updated_by=? WHERE key='trading_halted'`,
    [new Date().toISOString(), who],
  )
  console.log(`[admin] TRADING RESUMED by ${who}`)
  res.json({ ok: true, halted: false })
}))

// On-demand EOD report. Two modes:
//   GET  /admin/eod-report?date=YYYY-MM-DD  → return the summary as JSON (preview)
//   POST /admin/eod-report?date=YYYY-MM-DD  → also push it to Discord
router.get('/admin/eod-report', wrap(async (req, res) => {
  if (!await isAdmin(req)) return res.status(403).json({ error: 'Admin access required' })
  const { buildEodSummary } = await import('../../lib/eodSummary.js')
  const date = req.query.date || new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  const summary = await buildEodSummary(date)
  res.json({ date, summary })
}))

router.post('/admin/eod-report', wrap(async (req, res) => {
  if (!await isAdmin(req)) return res.status(403).json({ error: 'Admin access required' })
  const { buildEodSummary } = await import('../../lib/eodSummary.js')
  const cage = await import('../../lib/cageAlerts.js')
  const date = req.query.date || new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  const summary = await buildEodSummary(date)
  const result = await cage.notifyEod({ date, summary })
  res.json({ date, summary, posted: result })
}))

export default router
