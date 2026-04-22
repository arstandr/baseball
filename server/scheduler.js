// server/scheduler.js — Automated daily pipeline scheduler.
//
// Runs four jobs every day (all times ET):
//   9:00 AM  — morning run (schedule + Savant + edges + log bets + Discord picks)
//              → spawns live monitor as a background daemon (self-exits when games end)
//   3:30 PM  — lineup refresh (official 9-man lineups → re-price edges)
//  11:55 PM  — settle + EOD report (Claude analysis → Discord)
//
// Baked into the server so Railway keeps it alive with the web process.
// All output is streamed to stdout so Railway logs capture it.

import cron from 'node-cron'
import { exec, spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

function etDate() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
}

function run(label, cmd) {
  const date = etDate()
  console.log(`\n[scheduler] ▶ ${label} (${date})\n[scheduler] cmd: ${cmd}`)

  const child = exec(cmd, { cwd: ROOT, timeout: 10 * 60 * 1000 })

  child.stdout.on('data', d => process.stdout.write(d))
  child.stderr.on('data', d => process.stderr.write(d))
  child.on('close', code => {
    if (code === 0) console.log(`[scheduler] ✓ ${label} done`)
    else            console.error(`[scheduler] ✗ ${label} exited with code ${code}`)
  })
}

function mlbRun(label, args = '') {
  const date = etDate()
  run(label, `bash scripts/live/dailyRun.sh ${args} ${date}`.trim())
}

function nbaRun(label, args = '') {
  const date = etDate()
  run(label, `bash scripts/nba/nbaRun.sh ${args} ${date}`.trim())
}

let _liveMonitorChild = null

function startLiveMonitor(date) {
  if (_liveMonitorChild && _liveMonitorChild.exitCode === null) {
    console.log('[scheduler] live monitor already running — skipping spawn')
    return
  }
  console.log(`[scheduler] ▶ live monitor start (${date})`)
  const child = spawn(
    'node', ['scripts/live/liveMonitor.js', '--date', date],
    { cwd: ROOT, stdio: 'inherit', detached: false },
  )
  _liveMonitorChild = child
  child.on('close', code => {
    console.log(`[scheduler] live monitor exited (code ${code})`)
    _liveMonitorChild = null
  })
}

function etNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }))
}

function etHHMM() {
  const now = etNow()
  return now.getHours() * 60 + now.getMinutes()
}

export function startScheduler() {
  // On startup, fire any jobs whose window has already passed today
  const hm = etHHMM()
  const date = etDate()

  if (hm >= 9 * 60) {        // past 9:00am — MLB morning run missed?
    console.log('[scheduler] startup catch-up: MLB morning run')
    mlbRun('MLB morning run (catch-up)')
    setTimeout(() => startLiveMonitor(date), 90_000)
  }
  if (hm >= 9 * 60 + 30) {   // past 9:30am — NBA morning run missed?
    console.log('[scheduler] startup catch-up: NBA morning run')
    setTimeout(() => nbaRun('NBA morning run (catch-up)'), 120_000)  // 2min after MLB
  }
  if (hm >= 15 * 60 + 30) {  // past 3:30pm — lineup refresh missed?
    console.log('[scheduler] startup catch-up: MLB lineup refresh')
    mlbRun('MLB lineup refresh (catch-up)', '--lineups')
  }

  // 9:00 AM ET — MLB morning run, then spawn live monitor
  cron.schedule('0 9 * * *', () => {
    const date = etDate()
    mlbRun('MLB morning run')
    setTimeout(() => startLiveMonitor(date), 90_000)
  }, { timezone: 'America/New_York' })

  // 9:30 AM ET — NBA morning run (after MLB finishes)
  cron.schedule('30 9 * * *', () => nbaRun('NBA morning run'), { timezone: 'America/New_York' })

  // 3:30 PM ET — MLB lineup refresh
  cron.schedule('30 15 * * *', () => mlbRun('MLB lineup refresh', '--lineups'), { timezone: 'America/New_York' })

  // Mid-game partial settles — resolve guaranteed YES wins as they happen
  // 4 PM, 6 PM, 8 PM, 10 PM ET
  for (const hour of [16, 18, 20, 22]) {
    cron.schedule(`0 ${hour} * * *`, () => mlbRun(`MLB mid-game settle (${hour}:00)`, '--settle'), { timezone: 'America/New_York' })
  }

  // 11:55 PM ET — settle both MLB + NBA + EOD reports
  cron.schedule('55 23 * * *', () => {
    mlbRun('MLB settle + EOD', '--settle')
    nbaRun('NBA settle', '--settle')
  }, { timezone: 'America/New_York' })

  console.log('[scheduler] daily jobs (ET): 9:00am MLB+monitor | 9:30am NBA | 3:30pm lineups | 4/6/8/10pm partial settle | 11:55pm settle all')
}
