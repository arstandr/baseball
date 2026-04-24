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
import { one as dbOne, all as dbAll, run as dbRun } from '../lib/db.js'
import { runPreflightCheck } from '../lib/preflightCheck.js'
import { notifyPreflightResult, getAllWebhooks, notifyAlert } from '../lib/discord.js'

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

function runAsync(label, cmd) {
  const date = etDate()
  console.log(`\n[scheduler] ▶ ${label} (${date})\n[scheduler] cmd: ${cmd}`)
  return new Promise((resolve, reject) => {
    const child = exec(cmd, { cwd: ROOT, timeout: 10 * 60 * 1000 })
    child.stdout.on('data', d => process.stdout.write(d))
    child.stderr.on('data', d => process.stderr.write(d))
    child.on('close', code => {
      if (code === 0) { console.log(`[scheduler] ✓ ${label} done`); resolve() }
      else            { console.error(`[scheduler] ✗ ${label} exited with code ${code}`); reject(new Error(`exit ${code}`)) }
    })
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

async function checkBetSanity() {
  // Last 20 settled non-paper bets — if win rate < 30%, something is wrong.
  // Not a calibration tool; a break-detector. Normal variance won't trigger it.
  let bets
  try {
    bets = await dbAll(
      `SELECT result FROM ks_bets
       WHERE result IS NOT NULL AND paper = 0 AND live_bet = 0
       ORDER BY settled_at DESC LIMIT 20`,
    )
  } catch { return }

  if (bets.length < 10) return  // not enough data yet

  const wins    = bets.filter(b => b.result === 'win').length
  const winRate = wins / bets.length

  console.log(`[sanity] last ${bets.length} bets: ${wins}W/${bets.length - wins}L  win%=${(winRate*100).toFixed(1)}%`)

  if (winRate < 0.30) {
    console.error(`[sanity] ⚠ WIN RATE ALARM: ${(winRate*100).toFixed(1)}% over last ${bets.length} bets`)
    try {
      const webhooks = await getAllWebhooks({ all: dbAll })
      await notifyAlert({
        title:       `⚠️ WIN RATE ALARM`,
        description: `Last **${bets.length}** settled bets: **${wins}W / ${bets.length - wins}L** (${(winRate*100).toFixed(1)}%)\nExpected ≥ 35%. Model or data pipeline may be broken — check immediately.`,
        color:       0xff0000,
      }, webhooks)
    } catch {}
  }
}

async function firePendingBets() {
  const date = etDate()
  const now  = new Date().toISOString()

  let rows
  try {
    rows = await dbAll(
      `SELECT id, game_id, game_label, pitcher_id, pitcher_name, pitcher_side
       FROM bet_schedule
       WHERE bet_date = ? AND status = 'pending' AND scheduled_at <= ?
       ORDER BY scheduled_at ASC`,
      [date, now],
    )
  } catch { return }

  if (!rows.length) return

  for (const entry of rows) {
    // Atomically claim the row — prevents double-fire on concurrent poll cycles
    let claimed = false
    try {
      const r = await dbRun(
        `UPDATE bet_schedule SET status='fired', fired_at=? WHERE id=? AND status='pending'`,
        [now, entry.id],
      )
      claimed = (r?.changes ?? 0) > 0
    } catch { continue }
    if (!claimed) continue

    // Guard 1: if a sibling row for same pitcher+game already fired/skipped, don't double-bet
    const sibling = await dbOne(
      `SELECT id, status FROM bet_schedule
       WHERE bet_date=? AND game_id=? AND pitcher_id=? AND id != ?
         AND status IN ('fired','skipped','error')`,
      [date, entry.game_id, entry.pitcher_id, entry.id],
    ).catch(() => null)
    if (sibling) {
      console.log(`[scheduler] dup-guard: ${entry.pitcher_name} already ${sibling.status} (row ${sibling.id}) — marking skipped`)
      dbRun(`UPDATE bet_schedule SET status='skipped', notes=? WHERE id=?`,
        [`dup-guard: sibling row ${sibling.id} ${sibling.status}`, entry.id]).catch(() => {})
      continue
    }

    // Guard 2: if ks_bets already has a row for this pitcher today, skip
    const existingBet = await dbOne(
      `SELECT id FROM ks_bets WHERE bet_date=? AND pitcher_id=? AND live_bet=0 LIMIT 1`,
      [date, entry.pitcher_id],
    ).catch(() => null)
    if (existingBet) {
      console.log(`[scheduler] dup-guard: ${entry.pitcher_name} already has ks_bets row — marking skipped`)
      dbRun(`UPDATE bet_schedule SET status='skipped', notes=? WHERE id=?`,
        [`dup-guard: ks_bets row ${existingBet.id} exists`, entry.id]).catch(() => {})
      continue
    }

    // AI preflight check: confirm pitcher still probable, check news for skip/boost signals
    let check = { action: 'proceed', reason: '' }
    try {
      check = await runPreflightCheck(entry)
    } catch (err) {
      console.error(`[scheduler] preflight error for ${entry.pitcher_name}: ${err.message}`)
    }

    // Persist the preflight result regardless of action
    dbRun(
      `UPDATE bet_schedule SET preflight=?, notes=? WHERE id=?`,
      [check.action, check.reason || null, entry.id],
    ).catch(() => {})

    if (check.action === 'skip') {
      dbRun(`UPDATE bet_schedule SET status='skipped' WHERE id=?`, [entry.id]).catch(() => {})
      console.log(`[scheduler] ⏭  SKIP  ${entry.pitcher_name}  —  ${check.reason}`)
      try {
        const webhooks = await getAllWebhooks({ all: dbAll })
        notifyPreflightResult({ pitcherName: entry.pitcher_name, action: 'skip', reason: check.reason, game: entry.game_label, sources: check.sources }, webhooks)
      } catch {}
      continue
    }

    if (check.action === 'boost') {
      console.log(`[scheduler] ⚡  BOOST ${entry.pitcher_name}  —  ${check.reason}`)
      try {
        const webhooks = await getAllWebhooks({ all: dbAll })
        notifyPreflightResult({ pitcherName: entry.pitcher_name, action: 'boost', reason: check.reason, game: entry.game_label, sources: check.sources }, webhooks)
      } catch {}
    }

    console.log(`[scheduler] ▶ scheduled bet: ${entry.pitcher_name} — ${entry.game_label}`)
    try {
      await runAsync(
        `Scheduled bet: ${entry.pitcher_name} (${entry.game_label})`,
        `node scripts/live/ksBets.js log --date ${date} --pitcher-id ${entry.pitcher_id}`,
      )
    } catch (err) {
      console.error(`[scheduler] ksBets failed for ${entry.pitcher_name}: ${err.message}`)
      dbRun(
        `UPDATE bet_schedule SET status='error', notes=? WHERE id=?`,
        [`ksBets crash: ${String(err.message).slice(0, 250)}`, entry.id],
      ).catch(() => {})
    }
  }
}

export async function startScheduler() {
  // Safe column migrations for bet_schedule (no-op if already exist)
  for (const col of ['preflight TEXT', 'notes TEXT']) {
    await dbRun(`ALTER TABLE bet_schedule ADD COLUMN ${col}`).catch(() => {})
  }

  // On startup, fire any jobs whose window has already passed today
  const hm = etHHMM()
  const date = etDate()

  // Cleanup stale 'fired' rows from crashed sessions (older than 4h → error)
  const fourHoursAgo = new Date(Date.now() - 4 * 3600 * 1000).toISOString()
  await dbRun(
    `UPDATE bet_schedule SET status='error',
      notes=COALESCE(notes,'') || ' [stale-fired ' || datetime('now') || ']'
     WHERE status='fired' AND fired_at IS NOT NULL AND fired_at < ?`,
    [fourHoursAgo],
  ).catch(() => {})

  if (hm >= 9 * 60) {        // past 9:00am — MLB morning run missed?
    // Skip if either bets OR schedule entries exist for today (morning run writes to bet_schedule now)
    const existingBets  = await dbOne(`SELECT COUNT(*) AS n FROM ks_bets WHERE bet_date = ? AND live_bet = 0`, [date])
    const existingSched = await dbOne(`SELECT COUNT(*) AS n FROM bet_schedule WHERE bet_date = ?`, [date]).catch(() => ({ n: 0 }))
    const firedSched    = await dbOne(`SELECT COUNT(*) AS n FROM bet_schedule WHERE bet_date = ? AND status IN ('fired','skipped','error')`, [date]).catch(() => ({ n: 0 }))
    if (!existingBets?.n && !existingSched?.n && !firedSched?.n) {
      console.log('[scheduler] startup catch-up: MLB morning run')
      mlbRun('MLB morning run (catch-up)')
    } else {
      console.log(`[scheduler] startup: morning pipeline already ran for ${date} (${existingBets?.n ?? 0} bets, ${existingSched?.n ?? 0} scheduled, ${firedSched?.n ?? 0} fired/skipped/error) — skipping`)
    }
  }
  // NOTE: liveMonitor is managed by The Closer (Windows agent) — not started here
  // NBA morning run disabled
  // Fire any scheduled bets that came due while server was down
  await firePendingBets()
  if (hm >= 15 * 60 + 30 && hm < 16 * 60 + 30) {  // 3:30–4:30pm window only — prevents re-running on late redeploys
    console.log('[scheduler] startup catch-up: MLB lineup refresh')
    mlbRun('MLB lineup refresh (catch-up)', '--lineups')
  }

  // 9:00 AM ET — MLB morning run (liveMonitor handled by The Closer)
  cron.schedule('0 9 * * *', () => {
    mlbRun('MLB morning run')
  }, { timezone: 'America/New_York' })

  // NBA morning run disabled

  // Every 5 min — fire any scheduled bets whose T-2.5h window has arrived
  cron.schedule('*/5 * * * *', () => firePendingBets(), { timezone: 'America/New_York' })

  // 3:30 PM ET — MLB lineup refresh
  cron.schedule('30 15 * * *', () => mlbRun('MLB lineup refresh', '--lineups'), { timezone: 'America/New_York' })

  // Mid-game partial settles — resolve guaranteed YES wins as they happen
  // 4 PM, 6 PM, 8 PM, 10 PM ET
  for (const hour of [16, 18, 20, 22]) {
    cron.schedule(`0 ${hour} * * *`, () => mlbRun(`MLB mid-game settle (${hour}:00)`, '--settle'), { timezone: 'America/New_York' })
  }

  // 11:55 PM ET — MLB settle + EOD reports + sanity check
  cron.schedule('55 23 * * *', () => {
    mlbRun('MLB settle + EOD', '--settle')
    setTimeout(() => checkBetSanity(), 5 * 60 * 1000)  // run 5 min after settle finishes
  }, { timezone: 'America/New_York' })

  // Every Monday 8:00 AM ET — NB model calibration check (alerts on drift > 7%)
  cron.schedule('0 8 * * 1', () => {
    run('NB calibration check', 'node scripts/live/calibrateNB.js --days 90 --min-bets 10')
  }, { timezone: 'America/New_York' })

  console.log('[scheduler] daily jobs (ET): 9:00am data+schedule | */5min bet poll | 3:30pm lineups | 4/6/8/10pm partial settle | 11:55pm settle all')
}
