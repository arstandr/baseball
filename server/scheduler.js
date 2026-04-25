// server/scheduler.js — Automated daily pipeline scheduler.
//
// Runs daily jobs (all times ET):
//   7:00 AM  — early schedule + Savant fetch (slate visibility before Kalshi opens)
//   2:00 PM  — afternoon Savant refresh (fresh pitcher K% for evening games)
//   8:30 AM  — full morning run (schedule + Savant + edges + build bet_schedule)
//   */5 min  — firePendingBets: fires when BOTH lineups posted (T-90 backstop if late)
//   3:30 PM  — lineup refresh (official 9-man lineups → re-price edges)
//   3:00 AM  — settle + EOD report (Claude analysis → Discord; after west coast games finish)
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
import { recordPipelineStep } from '../lib/pipelineLog.js'

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
       WHERE result IN ('win','loss') AND paper = 0 AND live_bet = 0
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

// When a pitcher is skipped (scratch, preflight fail, dup-guard), redistribute
// their pre-allocated budget proportionally across remaining pending entries.
// This ensures no money is left on the table just because one game was skipped.
async function _redistributeAllocation(date, skippedId, freedUsd) {
  try {
    const pending = await dbAll(
      `SELECT id, allocated_usd FROM bet_schedule
       WHERE bet_date = ? AND status = 'pending' AND id != ? AND allocated_usd > 0`,
      [date, skippedId],
    )
    if (!pending.length) return
    const totalAlloc = pending.reduce((s, r) => s + (r.allocated_usd || 0), 0)
    if (totalAlloc <= 0) return
    for (const row of pending) {
      const bonus = freedUsd * (row.allocated_usd / totalAlloc)
      const newAlloc = Math.round((row.allocated_usd + bonus) * 100) / 100
      await dbRun(`UPDATE bet_schedule SET allocated_usd = ? WHERE id = ?`, [newAlloc, row.id])
    }
    console.log(`[scheduler] Redistributed $${freedUsd.toFixed(0)} from skipped entry to ${pending.length} remaining pitchers`)
  } catch (err) {
    console.warn(`[scheduler] _redistributeAllocation error: ${err.message}`)
  }
}

async function firePendingBets() {
  const date = etDate()
  const now  = new Date().toISOString()

  // Guard: don't fire any bets until daily_plan exists for today.
  // daily_plan is written by `ksBets.js plan` at the end of the morning pipeline.
  // Without it, ksBets can't size bets against the full day's portfolio.
  try {
    const plan = await dbOne(`SELECT bet_date FROM daily_plan WHERE bet_date = ?`, [date])
    if (!plan) {
      console.log(`[scheduler] firePendingBets: daily_plan not yet created for ${date} — holding all bets`)
      return
    }
  } catch { return }  // DB error — hold bets to be safe

  let rows
  try {
    rows = await dbAll(
      `SELECT id, game_id, game_label, pitcher_id, pitcher_name, pitcher_side, game_time, allocated_usd
       FROM bet_schedule
       WHERE bet_date = ? AND status = 'pending' AND scheduled_at <= ?
       ORDER BY scheduled_at ASC`,
      [date, now],
    )
  } catch { return }

  if (!rows.length) return

  // ── Phase 1: claim rows + dup-guard (fast sequential DB ops) ──────────────
  const eligible = []
  for (const entry of rows) {
    let claimed = false
    try {
      const r = await dbRun(
        `UPDATE bet_schedule SET status='fired', fired_at=? WHERE id=? AND status='pending'`,
        [now, entry.id],
      )
      claimed = (r?.changes ?? 0) > 0
    } catch { continue }
    if (!claimed) continue

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

    // Check for settled bets — can't add to a position once the game is resolved
    const settledBet = await dbOne(
      `SELECT id FROM ks_bets WHERE bet_date=? AND pitcher_id=? AND live_bet=0 AND result IS NOT NULL LIMIT 1`,
      [date, entry.pitcher_id],
    ).catch(() => null)
    if (settledBet) {
      console.log(`[scheduler] dup-guard: ${entry.pitcher_name} already has settled bet — marking skipped`)
      dbRun(`UPDATE bet_schedule SET status='skipped', notes=? WHERE id=?`,
        [`settled bet exists: ${settledBet.id}`, entry.id]).catch(() => {})
      continue
    }

    // Flag whether this is a top-up (existing unsettled bet) — affects budget flag passed to ksBets
    const existingBet = await dbOne(
      `SELECT id FROM ks_bets WHERE bet_date=? AND pitcher_id=? AND live_bet=0 LIMIT 1`,
      [date, entry.pitcher_id],
    ).catch(() => null)

    eligible.push({ ...entry, _isTopup: !!existingBet })
  }

  if (!eligible.length) return

  // ── Phase 2: run ALL preflight checks in parallel ─────────────────────────
  // Previously sequential — each preflight takes 5-20s (10 HTTP calls + optional AI).
  // With 6+ pitchers sharing a window this caused 1-2 min slippage on later entries.
  if (eligible.length > 1) {
    console.log(`[scheduler] running ${eligible.length} preflight checks in parallel`)
  }
  const preflightResults = await Promise.allSettled(
    eligible.map(entry =>
      runPreflightCheck(entry).catch(err => {
        console.error(`[scheduler] preflight error for ${entry.pitcher_name}: ${err.message}`)
        return { action: 'proceed', reason: '' }
      })
    )
  )

  // ── Phase 3: persist results + fire bets (sequential — Kalshi rate limits) ─
  const webhooks = await getAllWebhooks({ all: dbAll }).catch(() => [])

  for (let i = 0; i < eligible.length; i++) {
    const entry = eligible[i]

    // ── Lineup gate: hold until official lineups are posted, or T-90 backstop ─
    // game_lineups table exists (per schema.sql) — check if lineup row is present.
    // Refresh game_time from games table in case MLB adjusted the schedule
    const freshGame = await dbOne('SELECT game_time FROM games WHERE id = ?', [entry.game_id]).catch(() => null)
    const gameTime = freshGame?.game_time ?? entry.game_time
    const minsToGame = gameTime ? (new Date(gameTime) - Date.now()) / 60_000 : 0
    const pastBackstop = minsToGame <= 90

    let lineupReady = false
    try {
      const lineupRow = await dbOne(
        `SELECT COUNT(DISTINCT team_abbr) as teams FROM game_lineups
         WHERE game_id = ? AND fetch_date >= date('now', '-1 day', 'localtime')`,
        [entry.game_id],
      ).catch(() => null)
      lineupReady = (lineupRow?.teams ?? 0) >= 2
    } catch { /* table missing or query failed — treat as not ready */ }

    if (!lineupReady && !pastBackstop) {
      // Both lineups not posted yet and we're not at the T-90 backstop — hold
      console.log(`[scheduler] ⏳ HOLD ${entry.pitcher_name} — waiting for both lineups (${minsToGame.toFixed(0)}min to game)`)
      // Un-claim the row so it can be picked up next poll
      dbRun(`UPDATE bet_schedule SET status='pending', fired_at=NULL WHERE id=?`, [entry.id]).catch(() => {})
      continue
    }

    if (lineupReady) {
      console.log(`[scheduler] ✓ both lineups posted for ${entry.game_label} — firing ${entry.pitcher_name}`)
    } else {
      console.log(`[scheduler] ⚡ T-90 backstop — firing ${entry.pitcher_name} without both lineups (${minsToGame.toFixed(0)}min to game)`)
    }
    // ─────────────────────────────────────────────────────────────────────────

    const check = preflightResults[i].status === 'fulfilled'
      ? preflightResults[i].value
      : { action: 'proceed', reason: '' }

    dbRun(
      `UPDATE bet_schedule SET preflight=?, notes=? WHERE id=?`,
      [check.action, check.reason || null, entry.id],
    ).catch(() => {})

    const isSkip  = check.action === 'skip'
    const isBoost = check.action === 'boost'
    recordPipelineStep({
      bet_date: date,
      pitcher_id: String(entry.pitcher_id),
      pitcher_name: entry.pitcher_name,
      game_id: entry.game_id,
      game_label: entry.game_label,
      pitcher_side: entry.pitcher_side,
      game_time: entry.game_time,
      step: 'preflight',
      payload: {
        action: check.action,
        reason: check.reason || null,
        confidence: check.confidence ?? null,
        sources: check.sources ?? [],
        k_prop_gap: check.k_prop_gap ?? null,
        dk_line: check.dk_line ?? null,
      },
      summary: isSkip ? {
        final_action: 'preflight_skip',
        status: 'skipped',
        skip_reason: check.reason?.slice(0, 200) ?? 'preflight skip',
      } : isBoost ? {
        final_action: 'preflight_boost',
      } : {},
    }).catch(() => {})

    if (check.action === 'skip') {
      dbRun(`UPDATE bet_schedule SET status='skipped' WHERE id=?`, [entry.id]).catch(() => {})
      console.log(`[scheduler] ⏭  SKIP  ${entry.pitcher_name}  —  ${check.reason}`)
      notifyPreflightResult({ pitcherName: entry.pitcher_name, action: 'skip', reason: check.reason, game: entry.game_label, sources: check.sources }, webhooks)
      // Redistribute this pitcher's allocation to remaining pending entries
      if (entry.allocated_usd > 0) _redistributeAllocation(date, entry.id, entry.allocated_usd).catch(() => {})
      continue
    }

    if (check.action === 'boost') {
      console.log(`[scheduler] ⚡  BOOST ${entry.pitcher_name}  —  ${check.reason}`)
      notifyPreflightResult({ pitcherName: entry.pitcher_name, action: 'boost', reason: check.reason, game: entry.game_label, sources: check.sources }, webhooks)
    }

    // Pass the pre-allocated budget so this pitcher only draws from its slate share.
    // If allocated_usd is NULL (planPortfolio hasn't run yet — e.g. early-morning bets
    // fire before the 10am plan), cap at dailyBudget / totalPending instead of letting
    // the fallback path use the full remaining budget for the first bet.
    let effectiveAlloc = entry.allocated_usd > 0 ? entry.allocated_usd : null
    if (!effectiveAlloc) {
      try {
        const pendingCount = await dbOne(
          `SELECT COUNT(*) as n FROM bet_schedule WHERE bet_date=? AND status='pending'`,
          [date],
        )
        // Approximate daily budget from first active bettor's bankroll (best available without running ksBets)
        const firstBettor = await dbOne(
          `SELECT starting_bankroll, daily_risk_pct FROM users WHERE active_bettor=1 AND paper=0 LIMIT 1`,
        ).catch(() => null)
        if (firstBettor?.starting_bankroll) {
          const DAILY_RISK_PCT = firstBettor.daily_risk_pct ?? 0.04
          const dailyBudget = firstBettor.starting_bankroll * DAILY_RISK_PCT
          const totalPending = Math.max(1, (pendingCount?.n ?? 1) + 1) // +1 for self (already fired)
          effectiveAlloc = Math.round((dailyBudget / totalPending) * 100) / 100
          console.log(`[scheduler] ⚠ allocated_usd NULL for ${entry.pitcher_name} — safe cap $${effectiveAlloc.toFixed(0)} (budget $${dailyBudget.toFixed(0)} ÷ ${totalPending} entries)`)
        }
      } catch { /* safe cap not critical — ksBets will still run, just without the --max-risk flag */ }
    }
    // Top-up fires skip --max-risk so natural dailyBudget-spentToday math sizes the delta correctly
    const maxRiskFlag = (!entry._isTopup && effectiveAlloc > 0) ? ` --max-risk ${effectiveAlloc.toFixed(2)}` : ''
    console.log(`[scheduler] ▶ ${entry._isTopup ? 'top-up' : 'scheduled'} bet: ${entry.pitcher_name} — ${entry.game_label}${!entry._isTopup && effectiveAlloc ? ` (alloc $${effectiveAlloc.toFixed(0)})` : ''}`)
    try {
      await runAsync(
        `Scheduled bet: ${entry.pitcher_name} (${entry.game_label})`,
        `node scripts/live/ksBets.js log --date ${date} --pitcher-id ${entry.pitcher_id}${maxRiskFlag}`,
      )
      // Mark done, or retry if no bet placed yet and game hasn't started
      const placed = await dbOne(
        `SELECT id FROM ks_bets WHERE bet_date=? AND pitcher_id=? AND live_bet=0 AND paper=0 LIMIT 1`,
        [date, entry.pitcher_id],
      ).catch(() => null)
      if (placed) {
        dbRun(`UPDATE bet_schedule SET status='done' WHERE id=? AND status='fired'`, [entry.id]).catch(() => {})
      } else {
        const gameStarted = gameTime && new Date(gameTime) <= new Date()
        if (gameStarted) {
          dbRun(`UPDATE bet_schedule SET status='skipped', notes='game already in progress' WHERE id=? AND status='fired'`, [entry.id]).catch(() => {})
          console.log(`[scheduler] ⛔ ${entry.pitcher_name} — no bet placed, game already started`)
        } else {
          // No edge found yet — retry in 15 min (edge may emerge as lines move or lineups update)
          const retryAt = new Date(Date.now() + 15 * 60 * 1000).toISOString()
          dbRun(`UPDATE bet_schedule SET status='pending', fired_at=NULL, scheduled_at=? WHERE id=? AND status='fired'`, [retryAt, entry.id]).catch(() => {})
          console.log(`[scheduler] ↺ ${entry.pitcher_name} — no edge yet, retrying in 15min`)
        }
      }
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
  for (const col of ['preflight TEXT', 'notes TEXT', 'allocated_usd REAL', 'preflight_outcome TEXT']) {
    await dbRun(`ALTER TABLE bet_schedule ADD COLUMN ${col}`).catch(() => {})
  }

  // Persistent cron run log — survives Railway redeploys so catch-up can detect missed windows.
  await dbRun(`CREATE TABLE IF NOT EXISTS cron_run_log (
    job_name    TEXT PRIMARY KEY,
    last_run_at TEXT
  )`).catch(() => {})

  async function logCronRun(name) {
    await dbRun(
      `INSERT INTO cron_run_log (job_name, last_run_at) VALUES (?, ?)
       ON CONFLICT(job_name) DO UPDATE SET last_run_at = excluded.last_run_at`,
      [name, new Date().toISOString()],
    ).catch(() => {})
  }

  // Returns true if a scheduled job hasn't run today since its scheduled ET time.
  async function cronMissed(name, scheduledEtH, scheduledEtM = 0) {
    const row = await dbOne(`SELECT last_run_at FROM cron_run_log WHERE job_name = ?`, [name]).catch(() => null)
    if (!row?.last_run_at) return true
    const lastRunET = new Date(new Date(row.last_run_at).toLocaleString('en-US', { timeZone: 'America/New_York' }))
    const todayET   = etNow()
    const sameDay   = lastRunET.toDateString() === todayET.toDateString()
    if (!sameDay) return true
    return lastRunET.getHours() * 60 + lastRunET.getMinutes() < scheduledEtH * 60 + scheduledEtM
  }

  // On startup, fire any jobs whose window has already passed today
  const hm = etHHMM()
  const date = etDate()

  // Cleanup stale 'fired' rows from crashed sessions
  // 1. Any 'fired' row older than 4h → error unconditionally (process never finished)
  const fourHoursAgo = new Date(Date.now() - 4 * 3600 * 1000).toISOString()
  await dbRun(
    `UPDATE bet_schedule SET status='error',
      notes=COALESCE(notes,'') || ' [stale-fired ' || datetime('now') || ']'
     WHERE status='fired' AND fired_at IS NOT NULL AND fired_at < ?`,
    [fourHoursAgo],
  ).catch(() => {})

  // 2. 'Fired' rows older than 5 min with no matching ks_bets → error immediately.
  //    These are rows that were claimed but ksBets never ran (process crash mid-loop).
  //    5-minute window avoids racing with in-flight ksBets runs.
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString()
  const { rowsAffected: strandedFixed } = await dbRun(
    `UPDATE bet_schedule SET status='error',
      notes=COALESCE(notes,'') || ' [no-bets-fired ' || datetime('now') || ']'
     WHERE status='fired' AND fired_at IS NOT NULL AND fired_at < ?
       AND NOT EXISTS (
         SELECT 1 FROM ks_bets k
         WHERE k.bet_date = bet_schedule.bet_date
           AND k.pitcher_id = bet_schedule.pitcher_id
           AND k.live_bet = 0 AND k.paper = 0
       )`,
    [fiveMinAgo],
  ).catch(() => ({ rowsAffected: 0 }))
  if (strandedFixed > 0) {
    console.log(`[cleanup] Recovered ${strandedFixed} stranded fired bet_schedule rows with no ks_bets`)
  }

  if (hm >= 8 * 60 + 30) {   // past 8:30am — MLB morning run missed?
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

  // Always ensure games table is populated on startup — fetchLineups silently no-ops if games is empty.
  // Extend window to 8pm so late-day redeploys don't kill the lineup pipeline.
  const gamesRow = await dbOne(`SELECT COUNT(*) AS n FROM games WHERE date = ?`, [date]).catch(() => ({ n: 0 }))
  if (!gamesRow?.n || (hm >= 8 * 60 + 30 && hm < 20 * 60)) {
    if (!gamesRow?.n) console.log('[scheduler] startup: games table empty for today — running schedule fetch immediately')
    run('Schedule refresh (startup)', `node scripts/live/fetchSchedule.js --date ${date} --days 1`)
    if (hm >= 8 * 60 + 30 && hm < 15 * 60 + 30) {
      setTimeout(() => {
        run('bet_schedule rebuild (startup)', `node scripts/live/ksBets.js build-schedule --date ${date}`)
      }, 60_000)
    }
  }

  // Fire any scheduled bets that came due while server was down
  await firePendingBets()
  if (hm >= 15 * 60 + 30 && hm < 20 * 60) {  // 3:30–8pm — catch up on lineup refresh if server redeployed mid-day
    console.log('[scheduler] startup catch-up: MLB lineup refresh')
    mlbRun('MLB lineup refresh (catch-up)', '--lineups')
    logCronRun('lineup-refresh')
  }

  // ── Catch-up: jobs missed during redeploy windows ─────────────────────────────
  // Each job is only fired if its scheduled window has passed today AND the
  // cron_run_log confirms it hasn't run since its scheduled ET time.

  // 10am portfolio plan — only if daily_plan already exists (morning pipeline ran)
  if (hm >= 10 * 60 && await cronMissed('portfolio-plan', 10, 0)) {
    const plan = await dbOne(`SELECT bet_date FROM daily_plan WHERE bet_date = ?`, [date]).catch(() => null)
    if (plan) {
      console.log('[scheduler] startup catch-up: portfolio plan (10am missed)')
      run('Portfolio plan (catch-up)', `node scripts/live/ksBets.js plan --date ${date}`)
      logCronRun('portfolio-plan')
    }
  }

  // 2pm Savant refresh
  if (hm >= 14 * 60 && await cronMissed('savant-refresh', 14, 0)) {
    console.log('[scheduler] startup catch-up: Savant refresh (2pm missed)')
    run('Afternoon Savant refresh (catch-up)', `node scripts/live/fetchPitcherStatcast.js`)
    logCronRun('savant-refresh')
  }

  // Intra-day price check — fires at most once per startup if inside the 11am–5pm window
  if (hm >= 11 * 60 && hm < 17 * 60 && await cronMissed('intra-day', Math.floor(hm / 60), 0)) {
    const plan = await dbOne(`SELECT bet_date FROM daily_plan WHERE bet_date = ?`, [date]).catch(() => null)
    if (plan) {
      console.log('[scheduler] startup catch-up: intra-day price check (missed hourly window)')
      run('Intra-day price check (catch-up)', `node scripts/live/ksBets.js log --date ${date} --min-hours 3`)
      logCronRun('intra-day')
    }
  }

  // 3:30pm post-lineup portfolio plan
  if (hm >= 15 * 60 + 30 && await cronMissed('portfolio-plan-post-lineup', 15, 30)) {
    const plan = await dbOne(`SELECT bet_date FROM daily_plan WHERE bet_date = ?`, [date]).catch(() => null)
    if (plan) {
      console.log('[scheduler] startup catch-up: post-lineup portfolio plan (3:30pm missed)')
      run('Portfolio plan post-lineup (catch-up)', `node scripts/live/ksBets.js plan --date ${date}`)
      logCronRun('portfolio-plan-post-lineup')
    }
  }

  // 7:00 AM ET — early schedule + Savant refresh (slate visibility, pitcher data).
  cron.schedule('0 7 * * *', () => {
    const d = etDate()
    run('Early schedule fetch', `node scripts/live/fetchSchedule.js --date ${d} --days 1`)
    setTimeout(() => run('Early Savant fetch', `node scripts/live/fetchPitcherStatcast.js`), 30_000)
  }, { timezone: 'America/New_York' })

  // 2:00 PM ET — afternoon Savant refresh (fresh pitcher K% data for evening games).
  // Statcast data fetched at 7am can be 7+ hours stale by game time. Re-fetching at 2pm
  // ensures evening-game edge calculations use the most recent K% before bets fire.
  cron.schedule('0 14 * * *', () => {
    run('Afternoon Savant refresh', `node scripts/live/fetchPitcherStatcast.js`)
    logCronRun('savant-refresh')
  }, { timezone: 'America/New_York' })

  // 8:30 AM ET — MLB morning run (skipped if early-game pipeline already ran at 3am).
  cron.schedule('30 8 * * *', async () => {
    const d = etDate()
    try {
      const plan = await dbOne(`SELECT bet_date FROM daily_plan WHERE bet_date = ?`, [d])
      if (plan) {
        console.log(`[scheduler] 8:30am: daily_plan already exists — morning pipeline ran early, skipping`)
        return
      }
    } catch { /* proceed */ }
    mlbRun('MLB morning run')
  }, { timezone: 'America/New_York' })

  // 10:00 AM ET — portfolio plan: scan ALL of today's edges and write daily_plan.
  // Each ksBets.js call reads this denominator to size proportionally.
  cron.schedule('0 10 * * *', () => {
    const d = etDate()
    run('Portfolio plan (10am)', `node scripts/live/ksBets.js plan --date ${d}`)
    logCronRun('portfolio-plan')
  }, { timezone: 'America/New_York' })

  // Every hour 11am–5pm ET — intra-day price check.
  // Re-runs the edge finder for pitchers whose game is still >3h away.
  // If Kalshi prices moved in our favor since morning, buys in early at the better price.
  // Skips pitchers already bet (dedup in logEdges) and anything inside the T-3.5h window.
  cron.schedule('0 11-17 * * *', () => {
    const d = etDate()
    run('Intra-day price check', `node scripts/live/ksBets.js log --date ${d} --min-hours 3`)
    logCronRun('intra-day')
  }, { timezone: 'America/New_York' })

  // Refresh K prop lines every 30 min during pre-game window (11am–5pm ET)
  // Ensures preflight has fresh DK/FD consensus before each lineup-triggered bet fires.
  cron.schedule('*/30 11-17 * * *', () => {
    run('K prop refresh', `node scripts/live/fetchKProps.js --date ${etDate()}`)
  }, { timezone: 'America/New_York' })

  // NBA morning run disabled

  // Every 30 min, 9:30am–3:30pm ET — re-fetch schedule + rebuild bet_schedule.
  // Corrects MLB API blips that mark live games as 'postponed' at morning fetch time,
  // which would otherwise cause buildSchedule() to skip them (it filters out 'postponed').
  // fetchSchedule.js is a full upsert — idempotent, safe to run repeatedly.
  // build-schedule uses INSERT OR IGNORE — only adds rows for games not yet scheduled.
  cron.schedule('30 8-15 * * *', async () => {
    const d = etDate()
    run('Schedule refresh', `node scripts/live/fetchSchedule.js --date ${d} --days 1`)
    // Short delay to let fetchSchedule finish before rebuilding bet_schedule
    setTimeout(() => {
      run('bet_schedule rebuild', `node scripts/live/ksBets.js build-schedule --date ${d}`)
    }, 60_000)
  }, { timezone: 'America/New_York' })

  // Every 5 min, 3am–8pm ET — fetch lineups then fire pending bets.
  // Starts at 3am to cover Tokyo Series games (~6am ET, lineups post ~3–3:30am ET).
  // daily_plan guard ensures no bet fires before the morning pipeline completes.
  // fetchLineups.js skips teams already captured (cheap no-op once all lineups posted).
  cron.schedule('*/5 3-20 * * *', () => {
    const d = etDate()
    run('Lineup check', `node scripts/live/fetchLineups.js --date ${d}`)
    setTimeout(() => firePendingBets(), 30_000)
  }, { timezone: 'America/New_York' })

  // Every 5 min outside lineup-check hours — fire pending bets only (no lineup fetch).
  cron.schedule('*/5 0-2,21-23 * * *', () => firePendingBets(), { timezone: 'America/New_York' })

  // 3:30 PM ET — MLB lineup refresh; 90s later re-run portfolio plan with fresh prices
  cron.schedule('30 15 * * *', () => {
    mlbRun('MLB lineup refresh', '--lineups')
    logCronRun('lineup-refresh')
    setTimeout(() => {
      const d = etDate()
      run('Portfolio plan (post-lineup)', `node scripts/live/ksBets.js plan --date ${d}`)
      logCronRun('portfolio-plan-post-lineup')
    }, 90_000)
  }, { timezone: 'America/New_York' })

  // Mid-game partial settles — resolve guaranteed YES wins as they happen
  // 4 PM, 6 PM, 8 PM, 10 PM ET
  for (const hour of [16, 18, 20, 22]) {
    cron.schedule(`0 ${hour} * * *`, () => mlbRun(`MLB mid-game settle (${hour}:00)`, '--settle'), { timezone: 'America/New_York' })
  }

  // 3:00 AM ET — MLB settle + EOD + check tomorrow for early games.
  // Runs at 3am so west coast games are finished. Calendar day has rolled over —
  // settle uses yesterday's ET date. Then checks tomorrow's schedule (already fetched
  // via --days 2) and if any game starts before 10am ET, runs the full morning
  // pipeline for tomorrow right now so daily_plan exists well before first pitch.
  //
  // ORDERING GUARANTEE: dailyRun.sh --settle runs these steps in sequence:
  //   1. syncFills.js       — pull filled_contracts / order_status from Kalshi
  //   2. ksBets.js settle   — mark bets won/lost, write ks_bets.pnl
  //   3. syncSettlements.js — rebuild daily_pnl_events from Kalshi API (ksSettlementSync)
  //   4. eodReport.js       — read daily_pnl_events for authoritative Discord P&L
  // Step 3 MUST come after step 2 so ksSettlementSync can reconcile ks_bets.pnl for
  // the per-bet allocation split. Step 3 also ensures daily_pnl_events includes any
  // West Coast game settlements (games ending 1-2am ET) before eodReport runs.
  cron.schedule('0 3 * * *', async () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
      .toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
    run('MLB settle + EOD', `bash scripts/live/dailyRun.sh --settle ${yesterday}`)
    setTimeout(() => checkBetSanity(), 5 * 60 * 1000)

    // Check tomorrow's schedule for early games (before 10am ET = 14:00 UTC in EDT)
    const tomorrow = etDate()  // at 3am ET, etDate() = today = tomorrow's games
    setTimeout(async () => {
      try {
        const cutoffUtc = new Date()
        cutoffUtc.setUTCHours(14, 0, 0, 0)  // 10am ET (UTC-4 EDT)
        const early = await dbOne(
          `SELECT id, game_time FROM games
           WHERE date = ? AND game_time IS NOT NULL AND game_time < ?
             AND status NOT IN ('final','postponed') LIMIT 1`,
          [tomorrow, cutoffUtc.toISOString()],
        )
        if (early) {
          console.log(`[scheduler] Early game detected for ${tomorrow} (${early.game_time}) — running morning pipeline now`)
          mlbRun(`MLB morning run (early-game pre-run for ${tomorrow})`)
        } else {
          console.log(`[scheduler] No early games for ${tomorrow} — morning pipeline runs at 8:30am`)
        }
      } catch (err) {
        console.warn(`[scheduler] Early-game check failed: ${err.message}`)
      }
    }, 10 * 60 * 1000)  // 10 min after settle starts (give EOD time to finish)
  }, { timezone: 'America/New_York' })

  // Midnight ET — prune stale game_lineups rows, keeping only latest per (game_id, team_abbr, vs_hand).
  // Lineups are fetched repeatedly throughout the day; only the newest row per group is used.
  // Also prune monitor_state rows older than 14 days to prevent unbounded table growth.
  cron.schedule('0 0 * * *', async () => {
    await dbRun(
      `DELETE FROM game_lineups WHERE rowid NOT IN (
         SELECT MAX(rowid) FROM game_lineups GROUP BY game_id, team_abbr, vs_hand
       )`,
    ).catch(() => null)
    const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 10)
    const { rowsAffected } = await dbRun(
      `DELETE FROM monitor_state WHERE bet_date < ?`, [cutoff],
    ).catch(() => ({ rowsAffected: 0 }))
    console.log(`[cleanup] Pruned stale game_lineups and ${rowsAffected} old monitor_state rows`)
  }, { timezone: 'America/New_York' })

  // Hourly at :15 — recover stranded 'fired' rows that never produced ks_bets.
  // Covers the case where the Railway process crashes between claiming a row and
  // completing ksBets, leaving the row stuck in 'fired' forever.
  cron.schedule('15 * * * *', async () => {
    const ago = new Date(Date.now() - 5 * 60 * 1000).toISOString()
    const { rowsAffected } = await dbRun(
      `UPDATE bet_schedule SET status='error',
        notes=COALESCE(notes,'') || ' [no-bets-fired ' || datetime('now') || ']'
       WHERE status='fired' AND fired_at IS NOT NULL AND fired_at < ?
         AND NOT EXISTS (
           SELECT 1 FROM ks_bets k
           WHERE k.bet_date = bet_schedule.bet_date
             AND k.pitcher_id = bet_schedule.pitcher_id
             AND k.live_bet = 0 AND k.paper = 0
         )`,
      [ago],
    ).catch(() => ({ rowsAffected: 0 }))
    if (rowsAffected > 0) {
      console.log(`[cleanup] Hourly: recovered ${rowsAffected} stranded fired bet_schedule rows`)
    }
  }, { timezone: 'America/New_York' })

  // Every Monday 8:00 AM ET — NB model calibration check (alerts on drift > 7%)
  cron.schedule('0 8 * * 1', () => {
    run('NB calibration check', 'node scripts/live/calibrateNB.js --days 90 --min-bets 10')
  }, { timezone: 'America/New_York' })

  console.log('[scheduler] daily jobs (ET): 3:00am settle+early-game check | 7:00am schedule+Savant | 8:30am full pipeline (skipped if early-game pre-run) | */5min 3am-8pm lineup+bets | 3:30pm lineup refresh | 4/6/8/10pm partial settle')
}
