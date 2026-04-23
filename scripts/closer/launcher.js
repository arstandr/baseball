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
import 'dotenv/config'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT      = path.resolve(__dirname, '../..')

// ── DB heartbeat ──────────────────────────────────────────────────────────────

async function writeHeartbeat(status, extra = {}) {
  try {
    const { getClient } = await import('../../lib/db.js')
    const db = getClient()
    const payload = JSON.stringify({ status, ...extra, ts: new Date().toISOString() })
    await db.execute({
      sql: `INSERT INTO agent_heartbeat (key, value, updated_at)
            VALUES ('closer', ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      args: [payload],
    })
  } catch (err) {
    console.error('[closer] heartbeat write failed:', err.message)
  }
}

async function writeUpdate(commitHash, commitMsg) {
  try {
    const { getClient } = await import('../../lib/db.js')
    const db = getClient()
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
  return h >= 12 && h < 24  // noon–midnight ET
}

function etDate() {
  return etNow().toLocaleDateString('en-CA')
}

function git(cmd) {
  return execSync(`git ${cmd}`, { cwd: ROOT, encoding: 'utf8' }).trim()
}

// ── Child process manager ─────────────────────────────────────────────────────

let _child   = null
let _date    = null
let _running = false

async function startMonitor() {
  if (_child) return  // already running

  const date = etDate()
  _date = date
  _running = true

  console.log(`\n[closer] ▶ Starting liveMonitor for ${date}`)
  await writeHeartbeat('running', { date })

  const child = spawn(
    'node',
    ['scripts/live/liveMonitor.js', '--date', date],
    { cwd: ROOT, stdio: 'inherit', shell: false }
  )
  _child = child

  child.on('close', code => {
    console.log(`[closer] liveMonitor exited (code ${code})`)
    _child   = null
    _running = false
    writeHeartbeat('idle')
  })
}

function stopMonitor() {
  if (!_child) return
  console.log('[closer] stopping liveMonitor…')
  _child.kill('SIGTERM')
  _child   = null
  _running = false
}

// ── Auto-updater ──────────────────────────────────────────────────────────────

let _currentHash = null

async function checkForUpdates() {
  try {
    execSync('git fetch origin main --quiet', { cwd: ROOT })
    const remote = git('rev-parse origin/main')
    const local  = _currentHash || git('rev-parse HEAD')

    if (remote === local) return  // no update

    const msg = git(`log --oneline -1 ${remote}`)
    console.log(`\n[closer] 🔄 New code detected: ${msg}`)
    console.log('[closer] Pulling + restarting…')

    stopMonitor()
    execSync('git pull origin main --quiet', { cwd: ROOT })
    execSync('npm install --quiet', { cwd: ROOT })

    _currentHash = remote
    await writeUpdate(remote.slice(0, 7), msg)
    await writeHeartbeat('restarting', { reason: 'code update', commit: remote.slice(0, 7) })

    // Re-launch self via new code
    console.log('[closer] ✅ Update applied — relaunching…')
    const child = spawn(process.execPath, ['scripts/closer/launcher.js'], {
      cwd: ROOT, stdio: 'inherit', detached: true,
    })
    child.unref()
    process.exit(0)
  } catch (err) {
    console.error('[closer] update check failed:', err.message)
  }
}

// ── Main loop ─────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔════════════════════════════════════╗')
  console.log('║         THE CLOSER  ⚾              ║')
  console.log('║   Money Tree 2.0 — Live Monitor    ║')
  console.log('╚════════════════════════════════════╝')

  // Repo is public — strip any embedded token from remote so pulls never need auth
  try {
    const remoteUrl = git('remote get-url origin')
    if (remoteUrl.includes('@github.com')) {
      execSync('git remote set-url origin https://github.com/arstandr/baseball.git', { cwd: ROOT })
      console.log('[closer] remote URL updated to public HTTPS (no token needed)')
    }
  } catch {}

  _currentHash = git('rev-parse HEAD')
  console.log(`[closer] version: ${_currentHash.slice(0, 7)}`)

  await writeHeartbeat('idle')

  // Heartbeat every 60s
  setInterval(() => {
    writeHeartbeat(_running ? 'running' : 'idle', _date ? { date: _date } : {})
  }, 60_000)

  // Check for updates every 2 minutes
  setInterval(checkForUpdates, 2 * 60_000)

  // Game hours check every 5 minutes — start/stop monitor as needed
  async function tick() {
    if (isGameHours() && !_child) {
      startMonitor()
    } else if (!isGameHours() && _child) {
      console.log('[closer] outside game hours — stopping monitor')
      stopMonitor()
    }
  }

  await tick()
  setInterval(tick, 5 * 60_000)
}

main().catch(err => {
  console.error('[closer] fatal:', err)
  process.exit(1)
})
