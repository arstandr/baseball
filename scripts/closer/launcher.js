// scripts/closer/launcher.js — The Closer
//
// Self-contained Windows agent launcher. Manages liveMonitor.js as a child
// process, writes heartbeat to Turso every 60s, and auto-updates from GitHub
// every 2 minutes — restarting if new code is found.
//
// Run with: node scripts/closer/launcher.js

import { spawn, execSync, exec } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import 'dotenv/config'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT      = path.resolve(__dirname, '../..')

// ── Module-level state ────────────────────────────────────────────────────────

let _db                    = null   // cached DB client (Fix 9)
let _discordMod            = null   // cached discord module (Fix 9)
let _webhooksCache         = null   // cached webhook list (Fix 9)
let _webhooksCacheAt       = 0
let _heartbeatFailures     = 0
let _heartbeatDiscordAlerted = false  // latch so we only alert once per outage (Fix 10)
let _currentHash           = null
let _stopPromise           = null   // serialize concurrent stop calls (Fix 1)
let _logStream             = null   // shared write stream for closer.log (module-level so startMonitor can also write)

// ── Cached helpers ────────────────────────────────────────────────────────────

async function getDb() {
  if (_db) return _db
  const { getClient } = await import('../../lib/db.js')
  _db = getClient()
  return _db
}

async function getDiscord() {
  if (!_discordMod) _discordMod = await import('../../lib/discord.js')
  return _discordMod
}

async function getWebhooks() {
  const now = Date.now()
  if (_webhooksCache && now - _webhooksCacheAt < 10 * 60_000) return _webhooksCache
  try {
    const db = await getDb()
    const { getAllWebhooks } = await getDiscord()
    _webhooksCache = await getAllWebhooks({
      all: (sql, args) => db.execute({ sql, args }).then(r => r.rows),
    })
    _webhooksCacheAt = now
  } catch {
    _webhooksCache = []
  }
  return _webhooksCache
}

// Count pending bet_schedule rows for a given date — used by Fix 2 and startup
async function countScheduledPending(date) {
  try {
    const db = await getDb()
    const r = await db.execute({
      sql:  `SELECT COUNT(*) AS n FROM bet_schedule WHERE bet_date = ? AND status = 'pending'`,
      args: [date],
    })
    return Number(r.rows?.[0]?.n ?? 0)
  } catch {
    return -1  // sentinel: unknown — caller treats as "do not suppress"
  }
}

// Lightweight DB stats included in every heartbeat (Fix 5)
async function fetchHeartbeatStats(date) {
  try {
    const db = await getDb()
    const [restingR, todayR, nextR] = await Promise.all([
      db.execute({
        sql:  `SELECT COUNT(*) AS n FROM ks_bets WHERE order_status = 'resting' AND result IS NULL AND bet_date = ?`,
        args: [date],
      }),
      db.execute({
        sql:  `SELECT COUNT(*) AS n FROM ks_bets WHERE bet_date = ? AND live_bet = 0`,
        args: [date],
      }),
      db.execute({
        sql:  `SELECT MIN(scheduled_at) AS t FROM bet_schedule WHERE status = 'pending' AND bet_date = ?`,
        args: [date],
      }),
    ])
    return {
      bets_resting:   Number(restingR.rows?.[0]?.n ?? 0),
      bets_today:     Number(todayR.rows?.[0]?.n ?? 0),
      next_scheduled: nextR.rows?.[0]?.t ?? null,
    }
  } catch {
    return null  // skip enrichment on error — heartbeat still works
  }
}

// ── DB heartbeat ──────────────────────────────────────────────────────────────

async function writeHeartbeat(status, extra = {}) {
  try {
    const db = await getDb()
    const payload = JSON.stringify({ status, ...extra, ts: new Date().toISOString() })
    await db.execute({
      sql: `INSERT INTO agent_heartbeat (key, value, updated_at)
            VALUES ('closer', ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      args: [payload],
    })
    _heartbeatFailures        = 0
    _heartbeatDiscordAlerted  = false  // reset latch on successful write (Fix 10)
  } catch (err) {
    _heartbeatFailures++
    if (_heartbeatFailures >= 3) {
      console.error(`[closer] ⚠ HEARTBEAT FAILING (${_heartbeatFailures} consecutive): ${err.message}`)
    } else {
      console.error('[closer] heartbeat write failed:', err.message)
    }
    // Fix 10: Discord alert once per outage after 5 consecutive failures
    if (_heartbeatFailures >= 5 && !_heartbeatDiscordAlerted) {
      _heartbeatDiscordAlerted = true
      try {
        const { notifyAlert } = await getDiscord()
        const webhooks = await getWebhooks()
        await notifyAlert({
          title:       '⚠️ THE CLOSER — heartbeat failing',
          description: `${_heartbeatFailures} consecutive heartbeat write failures.\nLast error: ${err.message}`,
          color:       0xff0000,
        }, webhooks)
      } catch { /* best-effort */ }
    }
  }
}

async function writeUpdate(commitHash, commitMsg) {
  try {
    const db = await getDb()
    const payload = JSON.stringify({ hash: commitHash, msg: commitMsg, ts: new Date().toISOString() })
    await db.execute({
      sql: `INSERT INTO agent_heartbeat (key, value, updated_at)
            VALUES ('closer_last_update', ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      args: [payload],
    })
  } catch {}
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function etNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }))
}

function isGameHours() {
  const h = etNow().getHours()
  return h >= 11 || h < 2  // 11am–2am ET (covers day games + west coast late innings)
}

function etDate() {
  return etNow().toLocaleDateString('en-CA')
}

function git(cmd) {
  return execSync(`git ${cmd}`, { cwd: ROOT, encoding: 'utf8' }).trim()
}

// ── Child process manager ─────────────────────────────────────────────────────

let _child          = null
let _date           = null
let _running        = false
let _noBeatsDate    = null  // date where monitor exited fast with no bets — suppress respawn

async function startMonitor() {
  if (_child) return  // already running

  const date = etDate()

  // Fix 2: if suppressed, re-verify — scheduler may have written bets since we set the flag
  if (_noBeatsDate === date) {
    const pending = await countScheduledPending(date)
    if (pending > 0) {
      console.log(`[closer] ${pending} pending bets appeared after no-beat suppression — clearing flag`)
      _noBeatsDate = null
    } else if (pending === 0) {
      return  // still nothing scheduled — stay suppressed
    } else {
      return  // DB error (pending === -1) — be conservative, stay suppressed
    }
  }

  _date    = date
  _running = true

  console.log(`\n[closer] Starting liveMonitor for ${date}`)
  await writeHeartbeat('running', { date })

  const spawnedAt = Date.now()
  const child = spawn(
    process.execPath,  // absolute path to current Node binary — immune to PATH shifts
    ['scripts/live/liveMonitor.js', '--date', date],
    // stdio: stdin inherits (interactive kill signals work), stdout/stderr piped so
    // we can tee them to _logStream (closer.log) while still writing to process.stdout.
    { cwd: ROOT, stdio: ['inherit', 'pipe', 'pipe'], shell: false }
  )
  _child = child

  child.stdout.on('data', chunk => {
    process.stdout.write(chunk)
    if (_logStream) try { _logStream.write(chunk) } catch {}
  })
  child.stderr.on('data', chunk => {
    process.stderr.write(chunk)
    if (_logStream) try { _logStream.write(chunk) } catch {}
  })

  child.on('close', async code => {
    const elapsed = Date.now() - spawnedAt
    console.log(`[closer] liveMonitor exited (code ${code})`)
    _child   = null
    _running = false
    writeHeartbeat('idle')

    // Fix 4: Discord crash alert on unexpected exit during game hours
    if (code !== 0 && isGameHours() && elapsed > 30_000) {
      try {
        const { notifyAlert } = await getDiscord()
        const webhooks = await getWebhooks()
        await notifyAlert({
          title:       '🛑 THE CLOSER — liveMonitor crash',
          description:
            `Exit code: **${code}**\n` +
            `Date: ${date}\n` +
            `Elapsed: ${(elapsed / 1000).toFixed(0)}s\n` +
            `Commit: ${_currentHash?.slice(0, 7) ?? 'unknown'}`,
          color: 0xff0000,
        }, webhooks)
      } catch { /* best-effort */ }
    }

    // Fix 2: only suppress respawn if bet_schedule confirms no pending bets
    if (code === 0 && elapsed < 30_000) {
      const pending = await countScheduledPending(date)
      if (pending === 0) {
        _noBeatsDate = date
        console.log(`[closer] no bets for ${_noBeatsDate} — suppressing respawn until tomorrow`)
      } else if (pending > 0) {
        console.log(`[closer] monitor exited fast but ${pending} pending bets exist — NOT suppressing`)
      } else {
        console.log('[closer] monitor exited fast but bet_schedule check failed — NOT suppressing (DB error)')
      }
    }
  })
}

// Fix 1: async stop with SIGKILL escalation after 5s
async function stopMonitor() {
  if (!_child) return
  if (_stopPromise) return _stopPromise  // concurrent callers share the same wait

  const child = _child
  console.log('[closer] stopping liveMonitor...')

  _stopPromise = new Promise(resolve => {
    let resolved = false

    const onExit = () => {
      if (resolved) return
      resolved = true
      clearTimeout(killTimer)
      resolve()
    }

    child.once('exit', onExit)

    try { child.kill('SIGTERM') } catch {}

    // Escalate to SIGKILL if still alive after 5s
    const killTimer = setTimeout(() => {
      if (resolved) return
      console.warn('[closer] liveMonitor did not exit after 5s — sending SIGKILL')
      try { child.kill('SIGKILL') } catch {}
      setTimeout(onExit, 2000)  // give SIGKILL 2s, then give up waiting
    }, 5000)
  })

  await _stopPromise
  _stopPromise = null
  // _child and _running are nulled by the 'close' handler — don't null here
}

// ── Auto-updater ──────────────────────────────────────────────────────────────

async function checkForUpdates() {
  try {
    // Fix 3: async git fetch with 15s timeout — no longer blocks the event loop
    await new Promise((resolve, reject) => {
      exec('git fetch origin main --quiet', { cwd: ROOT, timeout: 15_000 },
        err => err ? reject(err) : resolve())
    })

    const remote = git('rev-parse origin/main')
    const local  = _currentHash || git('rev-parse HEAD')
    if (remote === local) return

    const msg = git(`log --oneline -1 ${remote}`)
    console.log(`\n[closer] New code detected: ${msg}`)

    // Skip reset if working tree has local changes (hotfixes waiting to be pushed)
    try {
      execSync('git diff --quiet HEAD', { cwd: ROOT })
    } catch {
      console.log('[closer] working tree has local changes — skipping auto-update until clean')
      return
    }

    // Fix 7 + Fix 8: capture changed files BEFORE the reset
    const changedFiles = git(`diff --name-only ${local}..${remote}`)
      .split('\n').map(s => s.trim()).filter(Boolean)
    const lockfileChanged = changedFiles.includes('package-lock.json') ||
                            changedFiles.includes('package.json')

    console.log('[closer] Pulling + restarting...')
    await stopMonitor()  // Fix 1: await actual process exit before resetting files

    try {
      execSync('git reset --hard origin/main', { cwd: ROOT })

      // Only run npm install when deps actually changed
      let ranNpmCi = false
      if (lockfileChanged) {
        console.log('[closer] package-lock.json changed — running npm ci')
        try {
          execSync('npm ci --quiet', { cwd: ROOT })
          ranNpmCi = true
        } catch (ciErr) {
          // npm ci deletes node_modules before reinstalling — if it fails mid-way,
          // node_modules is empty and the process crashes on next require. Fall back
          // to npm install which is more tolerant of network blips and lockfile drift.
          console.warn(`[closer] npm ci failed (${ciErr.message.split('\n')[0]}) — falling back to npm install`)
          execSync('npm install --quiet', { cwd: ROOT })
          ranNpmCi = true
        }
      } else {
        console.log('[closer] no dependency changes — skipping npm install')
      }

      _currentHash = remote
      await writeUpdate(remote.slice(0, 7), msg)
      await writeHeartbeat('restarting', { reason: 'code update', commit: remote.slice(0, 7) })

      // Fix 8: Discord notification with diff
      try {
        const { notifyAlert } = await getDiscord()
        const webhooks = await getWebhooks()
        const fileList = changedFiles.length > 20
          ? `${changedFiles.slice(0, 20).join('\n')}…and ${changedFiles.length - 20} more`
          : changedFiles.join('\n')
        await notifyAlert({
          title:       '🔄 THE CLOSER — code updated',
          description:
            `Commit: \`${remote.slice(0, 7)}\` — ${msg}\n` +
            `deps: ${ranNpmCi ? 'reinstalled' : 'skipped (no lockfile change)'}\n` +
            `Changed (${changedFiles.length}):\n\`\`\`\n${fileList}\n\`\`\``,
          color: 0x0099ff,
        }, webhooks)
      } catch { /* best-effort */ }

      console.log('[closer] Update applied — restarting...')
    } finally {
      // Always exit so the bat loop relaunches with fresh code (or recovers from partial failure)
      process.exit(0)
    }
  } catch (err) {
    console.error('[closer] update check failed:', err.message)
  }
}

// ── Main loop ─────────────────────────────────────────────────────────────────

function repairBatFile() {
  try {
    const bat = path.join(ROOT, 'start-closer.bat')
    // Always restart on any exit with a 10s backoff — no pause, no keypress needed.
    // Marker: 'COMMIT_SHA=%%i' — presence means bat is up-to-date with git hash export.
    const correct = `@echo off\r\n:loop\r\ntitle The Closer - Money Tree 2.0\r\ncd /d "${ROOT}"\r\nFOR /F "tokens=*" %%i IN ('git rev-parse HEAD 2^>nul') DO SET COMMIT_SHA=%%i\r\necho.\r\necho  THE CLOSER - Money Tree 2.0\r\necho.\r\nnode scripts/closer/launcher.js\r\necho.\r\necho  The Closer restarting in 10s...\r\ntimeout /t 10 /nobreak >nul\r\ngoto loop\r\n`
    const current = fs.existsSync(bat) ? fs.readFileSync(bat, 'ascii') : ''
    if (!current.includes('COMMIT_SHA=%%i')) {
      fs.writeFileSync(bat, correct, 'ascii')
      console.log('[closer] bat file updated: now restarts on any exit with 10s backoff')
    }
  } catch {}
}

// ── File logging with rotation ────────────────────────────────────────────────
// Intercepts console.log/warn/error and mirrors to logs/closer.log.
// Also captures liveMonitor child output via the shared _logStream (since child
// uses stdio:['inherit','pipe','pipe'] so its output flows through the launcher).
// Rotates at 10 MB, keeps one backup (.log.1).
//
// EBUSY guard: if stdout is already redirected to a file (e.g. by a watchdog bat
// with `>> logs\closer.log 2>&1`), we skip opening closer.log ourselves — two
// independent writers on the same file on Windows causes EBUSY crash-loops.
// In that case liveMonitor child output still flows to process.stdout → the bat's
// redirect file, so nothing is lost.

const LOG_PATH      = path.join(ROOT, 'logs', 'closer.log')
const LOG_MAX_BYTES = 10 * 1024 * 1024  // 10 MB

function setupFileLogging() {
  // If stdout is already being redirected by a wrapper script, skip our own file
  // writer — two writers on the same path on Windows = EBUSY crash-loop.
  if (!process.stdout.isTTY) return

  try {
    fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true })
    try {
      if (fs.existsSync(LOG_PATH) && fs.statSync(LOG_PATH).size > LOG_MAX_BYTES) {
        const bak = LOG_PATH + '.1'
        if (fs.existsSync(bak)) fs.unlinkSync(bak)
        fs.renameSync(LOG_PATH, bak)
      }
    } catch {}

    _logStream = fs.createWriteStream(LOG_PATH, { flags: 'a' })

    const write = (level, args) => {
      try {
        const ts   = new Date().toISOString().slice(0, 19).replace('T', ' ')
        const text = args.map(a => (typeof a === 'string' ? a : String(a))).join(' ')
        _logStream.write(`[${ts}] [${level}] ${text}\n`)
      } catch {}
    }

    const wrap = (orig, level) => (...args) => { orig(...args); write(level, args) }

    console.log   = wrap(console.log.bind(console),   'INFO')
    console.warn  = wrap(console.warn.bind(console),  'WARN')
    console.error = wrap(console.error.bind(console), 'ERROR')
  } catch (err) {
    process.stderr.write(`[closer] file logging setup failed: ${err.message}\n`)
  }
}

// ── Crash-loop guard ──────────────────────────────────────────────────────────
// Tracks recent launcher start timestamps in logs/restart_count.json.
// If >5 restarts happen within 5 minutes, alert Discord and pause 5 minutes.

const CRASH_LOOP_WINDOW_MS = 5 * 60 * 1000   // 5 minutes
const CRASH_LOOP_MAX       = 5                // restarts allowed in window
const RESTART_LOG_PATH     = path.join(ROOT, 'logs', 'restart_count.json')

async function checkCrashLoop() {
  try {
    fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true })
    let timestamps = []
    try {
      const raw = fs.readFileSync(RESTART_LOG_PATH, 'utf8')
      timestamps = JSON.parse(raw)
    } catch { /* first run or corrupt — start fresh */ }

    const now = Date.now()
    timestamps = timestamps.filter(t => now - t < CRASH_LOOP_WINDOW_MS)
    timestamps.push(now)
    fs.writeFileSync(RESTART_LOG_PATH, JSON.stringify(timestamps))

    if (timestamps.length > CRASH_LOOP_MAX) {
      console.error(`[closer] ⚠ CRASH LOOP: ${timestamps.length} restarts in last 5 min — pausing 5 min`)
      try {
        const { notifyAlert } = await getDiscord()
        const webhooks = await getWebhooks()
        await notifyAlert({
          title:       '⚠️ THE CLOSER — CRASH LOOP',
          description: `${timestamps.length} restarts in the last 5 minutes. Pausing 5 min before retry. Check logs on Windows.`,
          color:       0xff8800,
        }, webhooks)
      } catch { /* best-effort */ }
      await new Promise(r => setTimeout(r, CRASH_LOOP_WINDOW_MS))
    }
  } catch (err) {
    console.error('[closer] crash-loop check failed:', err.message)
  }
}

async function main() {
  setupFileLogging()

  console.log('THE CLOSER - Money Tree 2.0')
  console.log('============================')

  await checkCrashLoop()
  repairBatFile()

  // Repo is public — strip any embedded token from remote so pulls never need auth
  try {
    const remoteUrl = git('remote get-url origin')
    if (remoteUrl.includes('@github.com') && remoteUrl.includes(':')) {
      execSync('git remote set-url origin https://github.com/arstandr/baseball.git', { cwd: ROOT })
      console.log('[closer] remote URL updated to public HTTPS (no token needed)')
    }
  } catch {}

  try {
    _currentHash = git('rev-parse HEAD')
  } catch {
    _currentHash = process.env.COMMIT_SHA || null
  }
  let commitDate = ''
  try { commitDate = git('log -1 --format=%cd --date=format:"%b %d %Y %I:%M %p"') } catch {}
  console.log(`[closer] commit: ${_currentHash?.slice(0, 7) ?? 'unknown'}  ${commitDate ? `(${commitDate})` : '(git unavailable)'}` )

  const today = etDate()

  // Fix 5: enriched initial heartbeat
  const initStats = await fetchHeartbeatStats(today)
  await writeHeartbeat('idle', {
    commit: _currentHash?.slice(0, 7) ?? 'unknown',
    ...(initStats || {}),
  })

  // Fix 4: Discord startup notification
  try {
    const { notifyAlert } = await getDiscord()
    const webhooks = await getWebhooks()
    const pending = await countScheduledPending(today)
    await notifyAlert({
      title:       '🚀 THE CLOSER — started',
      description:
        `Commit: \`${_currentHash?.slice(0, 7) ?? 'unknown'}\`${commitDate ? ` (${commitDate})` : ''}\n` +
        `Date: ${today}\n` +
        `Pending scheduled bets: ${pending < 0 ? 'unknown (DB error)' : pending}\n` +
        `Game hours now: ${isGameHours() ? 'yes' : 'no'}`,
      color: 0x2ecc71,
    }, webhooks)
  } catch { /* best-effort */ }

  // Fix 5: enriched heartbeat every 60s
  setInterval(async () => {
    const date = _date || etDate()
    const stats = await fetchHeartbeatStats(date)
    writeHeartbeat(_running ? 'running' : 'idle', {
      ...(_date ? { date: _date } : {}),
      commit: _currentHash?.slice(0, 7) ?? 'unknown',
      ...(stats || {}),
    })
  }, 60_000)

  // Check for updates every 2 minutes
  setInterval(checkForUpdates, 2 * 60_000)

  // Fix 6: 1-minute tick — game-hours transitions caught within 1 min instead of 5
  async function tick() {
    if (isGameHours() && !_child) {
      startMonitor()
    } else if (!isGameHours() && _child) {
      console.log('[closer] outside game hours — stopping monitor')
      await stopMonitor()  // Fix 1: await actual exit
    }
  }

  await tick()
  setInterval(tick, 60_000)  // Fix 6
}

main().catch(err => {
  console.error('[closer] fatal:', err)
  process.exit(1)
})
