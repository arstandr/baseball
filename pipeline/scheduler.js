// pipeline/scheduler.js — cron scheduling for the data pipeline.
//
// Schedule (Eastern Time — configure TZ in .env):
//   08:00 AM ET   fetch --type schedule,starters
//   08:30 AM ET   logPaperBets (CLV open prices, after morning signal run)
//   12:00 PM ET   fetch --type lineups,stats
//   Every 30 min  fetch --type weather,lines (game-day only)
//   Every 5 min   closeOutLines — fills closing price 5min before each first pitch
//   09:00 PM ET   settle (pull F5 outcomes for finished games)
//   09:15 PM ET   report --yesterday (daily summary)
//
// Invoked by `node pipeline/scheduler.js` — runs indefinitely.

import cron from 'node-cron'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import 'dotenv/config'
import * as fetchPipeline from './fetch.js'
import * as orchestrate from './orchestrate.js'
import * as execute from './execute.js'
import * as db from '../lib/db.js'
import { alertPipelineFailure } from '../lib/telegram.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname  = path.dirname(__filename)
const ROOT       = path.resolve(__dirname, '..')

const TZ = process.env.TZ || 'America/New_York'

async function safe(name, fn) {
  try {
    const res = await fn()
    console.log(`[scheduler:${name}]`, JSON.stringify(res))
  } catch (err) {
    console.error(`[scheduler:${name}] failed:`, err.message)
    await alertPipelineFailure({ source: name, error: err })
  }
}

/**
 * Run a CLV script as a child process so it doesn't block the scheduler
 * event loop. Logs stdout/stderr inline.
 */
function runCLVScript(scriptPath) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath], {
      env: process.env,
      cwd: ROOT,
    })
    child.stdout.on('data', d => process.stdout.write(`[clv] ${d}`))
    child.stderr.on('data', d => process.stderr.write(`[clv:err] ${d}`))
    child.on('close', code => resolve({ code, script: scriptPath }))
  })
}

/**
 * closeOutLines guard — only runs if:
 *   1. There are open CLV entries for today, AND
 *   2. At least one game's first pitch is within the next 10 minutes
 *      (i.e. we are in the 5-minute pre-game window).
 *
 * Runs every minute; the guard keeps it cheap.
 */
async function maybeCloseOutLines() {
  const today = new Date().toISOString().slice(0, 10)
  const open  = await db.getOpenCLVEntries(today).catch(() => [])
  if (!open.length) return

  const nowMs = Date.now()
  const hasImminent = open.some(entry => {
    if (!entry.game_time) return false
    const pitchMs = new Date(entry.game_time).getTime()
    const diffMin = (pitchMs - nowMs) / 60000
    // Window: 2 min to 10 min before first pitch
    return diffMin >= 2 && diffMin <= 10
  })

  if (!hasImminent) return

  await safe('clv_close', () =>
    runCLVScript(path.join(ROOT, 'scripts', 'clv', 'closeOutLines.js')),
  )
}

// 08:00 ET — initial schedule ingest
cron.schedule('0 8 * * *', () => safe('morning_fetch', () => fetchPipeline.fetch({
  date: 'today',
  types: ['schedule', 'starters', 'lines'],
})), { timezone: TZ })

// 12:00 ET — lineup refresh + signal compute
cron.schedule('0 12 * * *', async () => {
  await safe('midday_fetch', () => fetchPipeline.fetch({
    date: 'today',
    types: ['lineups', 'lines'],
  }))
}, { timezone: TZ })

// Every 30 minutes — line/weather refresh + signal recompute
cron.schedule('*/30 * * * *', async () => {
  const date = new Date().toISOString().slice(0, 10)
  const games = await db.getGamesByDate(date)
  if (!games.length) return
  await safe('slate_refresh', () => fetchPipeline.fetch({
    date,
    types: ['lines'],
  }))
  await safe('slate_signal', () => orchestrate.runSlate(games, { concurrency: 4 }))
}, { timezone: TZ })

// 09:00 ET — settlement
cron.schedule('0 21 * * *', () => safe('settle', () => execute.settlePending()), { timezone: TZ })

// 09:15 ET — daily report
cron.schedule('15 21 * * *', () => safe('report', () => execute.buildDailyReport({
  date: new Date().toISOString().slice(0, 10),
  mode: 'paper',
})), { timezone: TZ })

console.log(`[scheduler] started in ${TZ}`)

// Keep the process alive
process.on('SIGTERM', () => {
  console.log('[scheduler] SIGTERM — exiting')
  process.exit(0)
})
