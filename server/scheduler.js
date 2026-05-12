// server/scheduler.js — Automated daily pipeline scheduler.
//
// Runs daily jobs (all times ET):
//   7:00 AM        — early schedule + Savant fetch (slate visibility before Kalshi opens)
//   8:30 AM        — full morning run (schedule + Savant + edges + build bet_schedule; 20min timeout)
//   */10 8am–8pm   — continuous edge rescan + bet_schedule rebuild
//   */30 9am–5pm   — fill sync (keeps order_status current; prevents sour-check false cancels)
//   */30 9am–5pm   — K prop refresh (DK/FD consensus; starts 9am not 11am to cover 1pm games)
//   */30 8:30am–6pm— schedule refresh (extends to 6pm to catch late postponement announcements)
//   */5  3am–11pm  — lineup check + firePendingBets (extended Apr 28 for late west-coast first pitches)
//   2:00 PM        — afternoon Savant refresh (fresh pitcher K% for evening games)
//   3:30 PM        — lineup refresh (official 9-man lineups → re-price edges)
//   4:05 PM        — second lineup pass (staggered from 4pm settle to avoid CPU spike)
//   4/6/8/10 PM    — mid-game partial settles
//   */5  11pm–11pm — CLV capture (starts 11am, was 2pm, to cover 1pm games at ≥25min mark)
//   3:00 AM        — settle + EOD report (Claude analysis → Discord; after west coast games finish)
//
// Baked into the server so Railway keeps it alive with the web process.
// All output is streamed to stdout so Railway logs capture it.

import cron from 'node-cron'
import { exec, spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pLimit from 'p-limit'
import { one as dbOne, all as dbAll, run as dbRun } from '../lib/db.js'
import { runPreflightCheck } from '../lib/preflightCheck.js'
import { notifyPreflightResult, getAllWebhooks, notifyAlert, notifyParlay } from '../lib/discord.js'
import { buildPreGameParlay, parlayKey } from '../lib/dkParlay.js'
import { recordPipelineStep } from '../lib/pipelineLog.js'
import { initOracle } from '../oracle/init.js'
import { runReconciliation } from '../oracle/layers/6-gateway/reconciler.js'
import { refreshGatewayAccountDailyState } from '../scripts/oracle/seedGatewayAccountDailyState.js'
import { runDailyBacktestCron } from '../scripts/oracle/dailyBacktestCron.js'
import { traceHealthProbe } from '../oracle/layers/0-trace/healthProbe.js'
import { checkQueueBacklog } from '../oracle/layers/0-trace/alerts.js'
import { queueStats as oracleQueueStats } from '../oracle/layers/0-trace/impl.js'
import { cancelOrder, getMarket } from '../lib/kalshi.js'
import { startPulseLoop, pulseEvents } from '../lib/gamePulse.js'
import { initBankrollState, reconcileBankrollState, addRealized, releaseCommitted } from '../lib/bankrollState.js'
import { cleanStaleLocks } from '../lib/betLock.js'
import { watchProcess, alertError, wrapCron } from '../lib/errorSentinel.js'
import { buildEodSummary } from '../lib/eodSummary.js'

const preflightLimit = pLimit(3)  // max 3 concurrent preflight checks

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

function etDate() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
}

// Track which parlay leg combinations have already been notified today (prevents duplicate alerts)
const _parlayFiredKeys = new Set()

async function runParlayCheck(date) {
  try {
    const parlay = await buildPreGameParlay({ all: dbAll, one: dbOne }, date)
    if (!parlay) return
    const key = parlayKey(parlay.legs)
    if (_parlayFiredKeys.has(key)) return
    _parlayFiredKeys.add(key)
    const webhooks = await getAllWebhooks({ all: dbAll }).catch(() => [])
    await notifyParlay(parlay, webhooks)
    console.log(`[scheduler] 🎲 parlay alert: ${parlay.legs.map(l => l.pitcherName).join(' + ')}  combined ${Math.round(parlay.combinedProb * 100)}%  odds ${parlay.parlayOdds ?? 'n/a'}`)
  } catch (err) {
    console.error(`[scheduler] parlay check error: ${err.message}`)
  }
}

function run(label, cmd, timeoutMs = 10 * 60 * 1000) {
  const date = etDate()
  console.log(`\n[scheduler] ▶ ${label} (${date})\n[scheduler] cmd: ${cmd}`)

  const child = exec(cmd, { cwd: ROOT, timeout: timeoutMs })
  const stderr = []

  child.stdout.on('data', d => process.stdout.write(d))
  child.stderr.on('data', d => { process.stderr.write(d); stderr.push(String(d)) })
  child.on('close', code => {
    if (code === 0) {
      console.log(`[scheduler] ✓ ${label} done`)
    } else {
      const msg = `${label} exited with code ${code}`
      console.error(`[scheduler] ✗ ${msg}`)
      alertError('scheduler:run', new Error(msg), {
        cmd: cmd.slice(0, 120),
        stderr: stderr.join('').slice(-600) || '(none)',
      }).catch(() => {})
    }
  })
}

function runAsync(label, cmd, timeoutMs = 10 * 60 * 1000) {
  const date = etDate()
  console.log(`\n[scheduler] ▶ ${label} (${date})\n[scheduler] cmd: ${cmd}`)
  return new Promise((resolve, reject) => {
    const child = exec(cmd, { cwd: ROOT, timeout: timeoutMs })
    child.stdout.on('data', d => process.stdout.write(d))
    child.stderr.on('data', d => process.stderr.write(d))
    child.on('close', code => {
      if (code === 0) { console.log(`[scheduler] ✓ ${label} done`); resolve() }
      else            { console.error(`[scheduler] ✗ ${label} exited with code ${code}`); reject(new Error(`exit ${code}`)) }
    })
  })
}

// Full daily pipeline (morning run, lineup refresh, settle) can take 12-15 min on a full slate.
// Use 20-min timeout so a slow fetch doesn't silently kill bet_schedule mid-build.
const MLB_RUN_TIMEOUT = 20 * 60 * 1000

function mlbRun(label, args = '') {
  const date = etDate()
  run(label, `bash scripts/live/dailyRun.sh ${args} ${date}`.trim(), MLB_RUN_TIMEOUT)
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

// Apr 28 — IOC partial-fill reconcile. Fixes ks_bets.capital_at_risk for rows where
// the IOC order partially filled and the unfilled portion was cancelled. The stored
// capital_at_risk was set at order-place-time based on intended size; needs to be
// updated to reflect actual cost (filled_contracts × fill_price / 100). Without this,
// dashboard P&L / exposure / ROI all overstate cost on partial-fill bets. Runs every
// firePendingBets cycle — idempotent and cheap.
async function reconcileIocPartialCar() {
  try {
    const today = etDate()
    const stale = await dbAll(
      `SELECT id, filled_contracts, fill_price, capital_at_risk
       FROM ks_bets
       WHERE bet_date = ? AND order_status = 'cancelled' AND filled_contracts > 0
         AND ABS(capital_at_risk - (filled_contracts * fill_price / 100.0)) > 0.50`,
      [today],
    )
    if (!stale.length) return
    for (const r of stale) {
      const real = (Number(r.filled_contracts) * Number(r.fill_price)) / 100
      await dbRun(`UPDATE ks_bets SET capital_at_risk = ? WHERE id = ?`, [real, r.id]).catch(() => {})
    }
    console.log(`[scheduler] reconcileIocPartialCar: corrected ${stale.length} IOC partial-fill row(s)`)
  } catch (err) {
    console.error('[scheduler] reconcileIocPartialCar error:', err.message)
  }
}

async function firePendingBets() {
  const date = etDate()
  const now  = new Date().toISOString()

  // Reconcile IOC partial-fill capital_at_risk before everything else so per-user
  // bankroll math (line ~424) sees the true committed amount.
  await reconcileIocPartialCar().catch(() => {})

  // ── Kill switch (Item 2) ──
  try {
    const haltRow = await dbOne(`SELECT value FROM system_flags WHERE key='trading_halted'`)
    if (haltRow?.value === '1') {
      console.log('[scheduler] firePendingBets: HALTED via system_flags')
      return
    }
  } catch { /* system_flags may not exist yet on first boot — proceed */ }

  // ── Kalshi outage guard ──
  try {
    const outageRow = await dbOne(`SELECT value FROM system_flags WHERE key='kalshi_outage'`)
    if (outageRow?.value === '1') {
      console.log('[scheduler] firePendingBets: HALTED — Kalshi API outage in effect')
      return
    }
  } catch {}

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
      `SELECT id, game_id, game_label, pitcher_id, pitcher_name, pitcher_side, game_time, allocated_usd,
              preflight, notes AS preflight_notes, preflight_checked_at
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
      claimed = (r?.rowsAffected ?? r?.changes ?? 0) > 0
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

    // Check monitor_state: if liveMonitor already settled this game, don't attempt pre-game bets.
    // Catches late-night restarts where the game finished hours ago but ks_bets has no result yet.
    const gameSettledRow = await dbOne(
      `SELECT 1 FROM monitor_state WHERE game_id=? AND bet_date=? AND game_settled=1 LIMIT 1`,
      [entry.game_id, date],
    ).catch(() => null)
    if (gameSettledRow) {
      console.log(`[scheduler] ⛔ GAME SETTLED ${entry.pitcher_name} — game already settled in monitor_state — skipping`)
      dbRun(`UPDATE bet_schedule SET status='skipped', notes='game already settled' WHERE id=? AND status='fired'`, [entry.id]).catch(() => {})
      continue
    }

    // ── Lineup gate: skip Sonnet entirely until both official lineups are posted ──
    let lineupReady = false
    try {
      const lineupRow = await dbOne(
        `SELECT COUNT(DISTINCT team_abbr) as teams FROM game_lineups
         WHERE game_id = ? AND fetch_date >= date('now', '-1 day', 'localtime')`,
        [entry.game_id],
      ).catch(() => null)
      lineupReady = (lineupRow?.teams ?? 0) >= 2
    } catch { /* treat as not ready */ }

    // Fetch game_time from games table (UTC from MLB API) — shared by the lineup gate and
    // game-elapsed guard. bet_schedule.game_time may be stored as naive ET, which after
    // 'Z' normalization is mis-interpreted as UTC, making a 7pm ET game appear to have
    // started at 3pm ET and triggering false in-progress skips.
    const _fgRow = await dbOne('SELECT game_time FROM games WHERE id=?', [entry.game_id]).catch(() => null)
    const _fgNorm = _fgRow?.game_time
      ? (!String(_fgRow.game_time).endsWith('Z') && !String(_fgRow.game_time).includes('+')
        ? _fgRow.game_time + 'Z' : _fgRow.game_time)
      : null

    if (!lineupReady) {
      const minsToGame = _fgNorm ? (new Date(_fgNorm) - Date.now()) / 60_000 : 0

      if (minsToGame < -5) {
        // Game already started and lineups were never posted (scratch / postponed / Senga-style).
        // Continuing to hold burns a slot all day — cancel immediately.
        console.log(`[scheduler] ⛔ LINEUP TIMEOUT ${entry.pitcher_name} — game started ${Math.abs(minsToGame).toFixed(0)}min ago, lineups never posted — skipping`)
        dbRun(`UPDATE bet_schedule SET status='skipped', notes='game started without lineup' WHERE id=? AND status='fired'`, [entry.id]).catch(() => {})
        continue
      }

      if (minsToGame <= 20) {
        // T-20 backstop: within 20min of first pitch — fire now even without full lineups.
        // Lineups often post within 5-10min of first pitch, so waiting means firing at pitch time.
        console.log(`[scheduler] ⏰ T-20 BACKSTOP ${entry.pitcher_name} — ${minsToGame.toFixed(0)}min to game, proceeding without full lineup`)
        // fall through to fire
      } else {
        console.log(`[scheduler] ⏳ HOLD ${entry.pitcher_name} — lineups not posted (${minsToGame.toFixed(0)}min to game)`)
        dbRun(`UPDATE bet_schedule SET status='pending', fired_at=NULL WHERE id=?`, [entry.id]).catch(() => {})
        continue
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    // Game-elapsed guard: even with lineups posted, don't fire pre-game bets once the game is
    // well underway. Pre-game Kalshi prices become stale within minutes of first pitch; firing
    // 30+ min into a game risks adverse fills and mis-sized positions.
    // Note: the lineup-timeout above catches the no-lineup case; this catches the "lineups posted
    // hours ago but scheduler missed the window" case (e.g. late-night restart at 11pm).
    {
      const _minsElapsed = _fgNorm ? (Date.now() - new Date(_fgNorm).getTime()) / 60_000 : 0
      if (_minsElapsed > 30) {
        console.log(`[scheduler] ⛔ GAME IN PROGRESS ${entry.pitcher_name} — game started ${Math.round(_minsElapsed)}min ago — skipping pre-game bet`)
        dbRun(`UPDATE bet_schedule SET status='skipped', notes='game 30+ min in progress' WHERE id=? AND status='fired'`, [entry.id]).catch(() => {})
        continue
      }
    }

    // ── Late-scratch re-check (Item 4): verify pitcher still appears as probable starter ──
    // Preflight ran at T-2.5h; a scratch at T-90min leaves lineups posted but pitcher gone.
    // Lightweight MLB Stats API probe — no Sonnet call.
    if (entry.pitcher_id && entry.game_id) {
      try {
        const mlbUrl = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&gamePk=${entry.game_id}&hydrate=probablePitcher`
        const mlbRes = await fetch(mlbUrl, { signal: AbortSignal.timeout(5000) }).then(r => r.json()).catch(() => null)
        const mlbGame = mlbRes?.dates?.[0]?.games?.[0]
        if (mlbGame) {
          const homeProb = String(mlbGame.teams?.home?.probablePitcher?.id ?? '')
          const awayProb = String(mlbGame.teams?.away?.probablePitcher?.id ?? '')
          const stillIn  = homeProb === String(entry.pitcher_id) || awayProb === String(entry.pitcher_id)
          if (!stillIn && (homeProb || awayProb)) {
            console.log(`[scheduler] ⛔ LATE SCRATCH ${entry.pitcher_name} — no longer probable starter for ${entry.game_label}`)
            dbRun(`UPDATE bet_schedule SET status='scratched', notes='late scratch: not in MLB probable pitchers at fire-time' WHERE id=? AND status='fired'`, [entry.id]).catch(() => {})
            getAllWebhooks({ all: dbAll }).then(webhooks =>
              notifyAlert({
                title: `⛔ Late scratch: ${entry.pitcher_name}`,
                description: `Removed from probable pitchers for **${entry.game_label}** between schedule build and bet fire.\nBet cancelled.`,
                color: 0xff8800,
              }, webhooks)
            ).catch(() => {})
            continue
          }
        }
      } catch { /* non-fatal — proceed to fire */ }
    }

    // Flag whether this is a top-up (existing unsettled bet) — affects budget flag passed to ksBets
    const existingBet = await dbOne(
      `SELECT id FROM ks_bets WHERE bet_date=? AND pitcher_id=? AND live_bet=0 LIMIT 1`,
      [date, entry.pitcher_id],
    ).catch(() => null)

    eligible.push({ ...entry, _isTopup: !!existingBet })
  }

  if (!eligible.length) return

  // ── Phase 2: run preflight checks in parallel (skip if cached result ≤4h old) ─
  // Previously sequential — each preflight takes 5-20s (10 HTTP calls + optional AI).
  // With 6+ pitchers sharing a window this caused 1-2 min slippage on later entries.
  const needsCheck = eligible.filter(e => {
    if (!e.preflight || !e.preflight_checked_at) return true
    const ageHours = (Date.now() - new Date(e.preflight_checked_at)) / 3_600_000
    return ageHours >= 4
  })
  const cached = eligible.filter(e => !needsCheck.includes(e))
  if (cached.length) {
    console.log(`[scheduler] ♻  reusing cached preflight for: ${cached.map(e => e.pitcher_name).join(', ')}`)
  }
  if (needsCheck.length > 1) {
    console.log(`[scheduler] running ${needsCheck.length} preflight checks in parallel`)
  }
  const freshResults = await Promise.allSettled(
    needsCheck.map(entry =>
      preflightLimit(() =>
        runPreflightCheck(entry).catch(err => {
          console.error(`[scheduler] preflight error for ${entry.pitcher_name}: ${err.message}`)
          return { action: 'proceed', reason: '' }
        })
      )
    )
  )
  // Reassemble results in eligible[] order
  const preflightResults = eligible.map(entry => {
    const ci = cached.indexOf(entry)
    if (ci !== -1) return { status: 'fulfilled', value: { action: entry.preflight, reason: entry.preflight_notes || '' } }
    const ni = needsCheck.indexOf(entry)
    return freshResults[ni] ?? { status: 'fulfilled', value: { action: 'proceed', reason: '' } }
  })

  // ── Phase 3: persist results + fire bets (sequential — Kalshi rate limits) ─
  const webhooks = await getAllWebhooks({ all: dbAll }).catch(() => [])

  for (let i = 0; i < eligible.length; i++) {
    const entry = eligible[i]

    // Use games.game_time (UTC from MLB API) for the in-progress check — bet_schedule.game_time
    // may be stored as naive ET and after 'Z' normalization would appear 4 hours early.
    const freshGame = await dbOne('SELECT game_time FROM games WHERE id = ?', [entry.game_id]).catch(() => null)
    const gameTime  = freshGame?.game_time ?? entry.game_time

    console.log(`[scheduler] ▶ both lineups confirmed for ${entry.game_label} — running preflight+fire for ${entry.pitcher_name}`)

    const check = preflightResults[i].status === 'fulfilled'
      ? preflightResults[i].value
      : { action: 'proceed', reason: '' }

    dbRun(
      `UPDATE bet_schedule SET preflight=?, notes=?, preflight_checked_at=? WHERE id=?`,
      [check.action, check.reason || null, new Date().toISOString(), entry.id],
    ).catch(() => {})

    const isSkip  = check.action === 'skip'
    const isBoost = check.action === 'boost'
    const skipCount   = (check.headlines ?? []).filter(h => h.signal === 'skip').length
    const boostCount  = (check.headlines ?? []).filter(h => h.signal === 'boost').length
    const totalNews   = (check.headlines ?? []).length
    const newsLine    = totalNews === 0
      ? 'No relevant headlines were found.'
      : `${totalNews} headline${totalNews !== 1 ? 's' : ''} scanned${skipCount ? `, ${skipCount} flagged as cautionary` : ''}${boostCount ? `, ${boostCount} as bullish` : ''}.`

    const actionLine = check.action === 'skip'
      ? `The preflight check decided to skip this bet.`
      : check.action === 'boost'
      ? `The preflight check cleared this bet and flagged it for a boosted stake.`
      : `The preflight check cleared this bet to proceed normally.`

    const summaryText = [actionLine, check.reason || null, newsLine].filter(Boolean).join(' ')

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
        headlines: check.headlines ?? [],
        summary_text: summaryText,
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
      continue
    }

    if (check.action === 'boost') {
      console.log(`[scheduler] ⚡  BOOST ${entry.pitcher_name}  —  ${check.reason}`)
      notifyPreflightResult({ pitcherName: entry.pitcher_name, action: 'boost', reason: check.reason, game: entry.game_label, sources: check.sources }, webhooks)
    }

    console.log(`[scheduler] ▶ ${entry._isTopup ? 'top-up' : 'scheduled'} bet: ${entry.pitcher_name} — ${entry.game_label}`)
    try {
      await runAsync(
        `Scheduled bet: ${entry.pitcher_name} (${entry.game_label})`,
        `node scripts/live/ksBets.js log --date ${date} --pitcher-id ${entry.pitcher_id}`,
      )
      // Mark done, or retry if no bet placed yet and game hasn't started
      const placed = await dbOne(
        `SELECT id FROM ks_bets WHERE bet_date=? AND pitcher_id=? AND live_bet=0 AND paper=0 LIMIT 1`,
        [date, entry.pitcher_id],
      ).catch(() => null)
      if (placed) {
        await dbRun(`UPDATE bet_schedule SET status='done' WHERE id=? AND status='fired'`, [entry.id]).catch(() => {})
        // Notify each bettor on their own webhook with their specific bet details
        const betRows = await dbAll(
          `SELECT k.side, k.strike, k.filled_contracts, k.fill_price, k.capital_at_risk, k.bet_size, k.paper,
                  u.name, u.discord_webhook
           FROM ks_bets k JOIN users u ON u.id = k.user_id
           WHERE k.bet_date=? AND k.pitcher_id=? AND k.live_bet=0 AND k.paper=0`,
          [date, entry.pitcher_id],
        ).catch(() => [])
        for (const row of betRows) {
          if (!row.discord_webhook) continue
          const side     = row.side ?? '?'
          const strike   = row.strike ?? '?'
          const price    = row.fill_price != null ? `${Math.round(row.fill_price)}¢` : '?¢'
          const contracts = row.filled_contracts ?? '?'
          const risk     = row.capital_at_risk != null ? `$${Number(row.capital_at_risk).toFixed(2)}` : row.bet_size != null ? `$${Number(row.bet_size).toFixed(2)}` : '?'
          await notifyAlert({
            title:       `⚾ Pre-game bet placed — ${entry.pitcher_name}`,
            description: `**${side} ${strike}+** · ${entry.game_label}\n${contracts} contracts @ ${price} · risk ${risk}`,
            color:       0x3498db,
          }, [row.discord_webhook]).catch(() => {})
        }
      } else {
        // Normalize gameTime to UTC before comparing — strings without 'Z' suffix can be
        // misinterpreted as local time, causing false "already in progress" marks hours early.
        // Hard guard: if game is more than 5 min in the future, in-progress can never be true.
        const _gtRaw = gameTime
        const _gtStr = _gtRaw && !String(_gtRaw).endsWith('Z') && !String(_gtRaw).includes('+') ? _gtRaw + 'Z' : _gtRaw
        const _gameMs = _gtStr ? new Date(_gtStr).getTime() : 0
        const gameStarted = !!_gtStr && !isNaN(_gameMs) && _gameMs <= Date.now() + 5 * 60_000 && _gameMs <= Date.now()
        if (gameStarted) {
          dbRun(`UPDATE bet_schedule SET status='skipped', notes='game already in progress' WHERE id=? AND status='fired'`, [entry.id]).catch(() => {})
          console.log(`[scheduler] ⛔ ${entry.pitcher_name} — no bet placed, game already started`)
        } else {
          // No edge found yet — retry in 15 min, but only if the retry window clears before game start
          const retryAt   = new Date(Date.now() + 15 * 60 * 1000)
          const gtStr     = gameTime && !gameTime.endsWith('Z') && !gameTime.includes('+') ? gameTime + 'Z' : gameTime
          const gameStart = gtStr ? new Date(gtStr) : null
          if (gameStart && retryAt >= gameStart) {
            dbRun(`UPDATE bet_schedule SET status='skipped', notes='no edge — game starts before next retry' WHERE id=? AND status='fired'`, [entry.id]).catch(() => {})
            console.log(`[scheduler] ⛔ ${entry.pitcher_name} — no edge, game starts in ${Math.round((gameStart - Date.now()) / 60000)}min — no retry window`)
          } else {
            dbRun(`UPDATE bet_schedule SET status='pending', fired_at=NULL, scheduled_at=? WHERE id=? AND status='fired'`, [retryAt.toISOString(), entry.id]).catch(() => {})
            console.log(`[scheduler] ↺ ${entry.pitcher_name} — no edge yet, retrying in 15min`)
          }
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

// checkSouredOrders — runs after every 10-min edge rescan.
// Reads the freshly-written daily_plan.pitchers_json to find pitchers that no longer
// have any edge at current Kalshi prices. For each resting (unfilled) pre-game order
// on a pitcher that dropped out of the plan entirely, cancels the Kalshi order and
// resets the bet_schedule entry to 'pending' so firePendingBets re-evaluates at the
// current price. If edge is still gone, ksBets.js will mark it 'skipped'; if prices
// have moved back into edge territory, a fresh order will be placed.
async function checkSouredOrders() {
  const date = etDate()

  const plan = await dbOne(`SELECT pitchers_json FROM daily_plan WHERE bet_date = ?`, [date]).catch(() => null)
  if (!plan?.pitchers_json) return

  let pitchersWithEdge
  try {
    const parsed = JSON.parse(plan.pitchers_json)
    pitchersWithEdge = new Set(parsed.filter(p => (p.edge_weighted ?? 0) > 0).map(p => String(p.pitcher_id)))
  } catch { return }

  // Only target fully unfilled orders — if any contracts have been filled, real money
  // is in the position and we must not cancel unilaterally (partial fills can't be undone).
  const resting = await dbAll(
    `SELECT k.id, k.order_id, k.user_id, k.pitcher_id, k.pitcher_name, k.side, k.strike,
            s.id AS sched_id
     FROM ks_bets k
     LEFT JOIN bet_schedule s ON s.bet_date = k.bet_date AND s.pitcher_id = k.pitcher_id
     WHERE k.bet_date = ? AND k.order_status = 'resting' AND k.result IS NULL
       AND k.live_bet = 0 AND k.paper = 0
       AND (k.filled_contracts IS NULL OR k.filled_contracts = 0)`,
    [date],
  ).catch(() => [])

  for (const bet of resting) {
    if (pitchersWithEdge.has(String(bet.pitcher_id))) continue  // edge still present

    console.log(`[sour-check] ${bet.pitcher_name} ${bet.side}${bet.strike}+ — dropped from daily_plan, cancelling resting order`)

    const user = await dbOne(`SELECT kalshi_key_id, kalshi_private_key FROM users WHERE id = ?`, [bet.user_id]).catch(() => null)
    if (!user?.kalshi_key_id) {
      console.warn(`[sour-check] no creds for user ${bet.user_id} — skipping`)
      continue
    }

    const creds = { keyId: user.kalshi_key_id, privateKey: user.kalshi_private_key }
    try {
      await cancelOrder(bet.order_id, creds)
      await dbRun(
        `UPDATE ks_bets SET order_status='cancelled', notes='edge gone: sour check' WHERE id = ?`,
        [bet.id],
      )
      if (bet.sched_id) {
        await dbRun(
          `UPDATE bet_schedule SET status='pending', fired_at=NULL WHERE id = ?`,
          [bet.sched_id],
        )
      }
      console.log(`[sour-check] ✓ ${bet.pitcher_name} — order cancelled, re-queued for re-evaluation`)
    } catch (err) {
      console.error(`[sour-check] cancel failed for ${bet.pitcher_name}: ${err.message}`)
    }
  }
}

// ── Item 1: CLV capture — snapshot market mid at game start ──────────────────
// Runs every 5 min from 2pm–11pm ET. For filled pre-game bets whose game started
// ≥25 min ago (markets closed), fetches the Kalshi market and stores the last
// market mid as closing_line_cents. CLV = mid − fill (YES) or fill − mid (NO).
async function captureClosingLines() {
  const bets = await dbAll(
    `SELECT k.id, k.ticker, k.side, k.fill_price, k.game_id
     FROM ks_bets k
     LEFT JOIN games g ON g.id = k.game_id
     WHERE k.live_bet = 0 AND k.paper = 0
       AND k.ticker IS NOT NULL
       AND k.closing_line_cents IS NULL
       AND k.fill_price IS NOT NULL
       AND k.fill_price > 0
       AND (k.order_status = 'filled' OR k.filled_contracts > 0)
       AND g.game_time < datetime('now', '-25 minutes')`,
  ).catch(() => [])

  if (!bets.length) return

  for (const bet of bets) {
    try {
      const m = await getMarket(bet.ticker)
      if (!m) continue

      let mid = null
      if (m.yes_bid != null && m.yes_ask != null && m.status !== 'finalized') {
        mid = (Number(m.yes_bid) + Number(m.yes_ask)) / 2
      } else if (m.last_price != null) {
        mid = Number(m.last_price)
      } else if (m.status === 'finalized') {
        mid = m.result === 'yes' ? 97 : 3
      }
      if (mid == null) continue

      const clv = bet.side === 'YES' ? mid - bet.fill_price : bet.fill_price - mid
      await dbRun(
        `UPDATE ks_bets SET closing_line_cents=?, clv_cents=?, closing_line_captured_at=? WHERE id=?`,
        [Math.round(mid), Math.round(clv * 10) / 10, new Date().toISOString(), bet.id],
      )
    } catch { /* non-fatal */ }
  }
}

// ── Item 6: Drawdown response curve ──────────────────────────────────────────
// Runs every 30 min. Reads 7-day rolling P&L across all active bettors.
// If rolling drawdown > 10% of starting capital: set drawdown_scale = 0.5.
// If rolling drawdown 5–10%: scale = 0.75.  Otherwise: scale = 1.0.
// Writes to system_flags.drawdown_scale — liveMonitor and scheduler both read it.
async function recomputeDrawdownScale() {
  try {
    // 7-day P&L from daily_pnl_events (Kalshi-confirmed) — most accurate source
    const sevenAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)
    const pnlRow = await dbOne(
      `SELECT COALESCE(SUM(pnl_usd), 0) AS rolling_pnl
       FROM daily_pnl_events
       WHERE date >= ?`,
      [sevenAgo],
    ).catch(() => null)

    // Fallback: ks_bets.pnl if daily_pnl_events is empty
    let rollingPnl = pnlRow?.rolling_pnl != null ? Number(pnlRow.rolling_pnl) : null
    if (rollingPnl == null || (Math.abs(rollingPnl) < 0.01)) {
      const kbRow = await dbOne(
        `SELECT COALESCE(SUM(pnl), 0) AS rolling_pnl
         FROM ks_bets WHERE bet_date >= ? AND result IN ('win','loss') AND paper = 0`,
        [sevenAgo],
      ).catch(() => null)
      rollingPnl = kbRow?.rolling_pnl != null ? Number(kbRow.rolling_pnl) : 0
    }

    // Starting capital = sum of active bettors' starting_bankroll
    const capRow = await dbOne(
      `SELECT COALESCE(SUM(starting_bankroll), 1000) AS capital
       FROM users WHERE active_bettor = 1 AND is_system_admin = 0`,
    ).catch(() => null)
    const capital = Math.max(Number(capRow?.capital ?? 1000), 100)

    const drawdownPct = rollingPnl / capital  // negative = drawdown

    let newScale = 1.0
    if (drawdownPct <= -0.10) newScale = 0.5
    else if (drawdownPct <= -0.05) newScale = 0.75

    // Read current scale to avoid unnecessary writes
    const cur = await dbOne(`SELECT value FROM system_flags WHERE key='drawdown_scale'`).catch(() => null)
    const curScale = Number(cur?.value ?? 1.0)

    if (Math.abs(curScale - newScale) > 0.01) {
      await dbRun(
        `INSERT INTO system_flags (key, value, updated_at, updated_by) VALUES ('drawdown_scale', ?, ?, 'auto')
         ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
        [String(newScale), new Date().toISOString()],
      )
      console.log(`[drawdown] scale ${curScale} → ${newScale}  (7d P&L: $${rollingPnl.toFixed(2)} / capital $${capital.toFixed(0)} = ${(drawdownPct*100).toFixed(1)}%)`)
      if (newScale < 1.0) {
        const webhooks = await getAllWebhooks({ all: dbAll }).catch(() => [])
        await notifyAlert({
          title:       `⚠️ Drawdown scale: ${newScale}× — bet sizing reduced`,
          description: `7-day P&L: **$${rollingPnl.toFixed(2)}** (${(drawdownPct*100).toFixed(1)}% of capital)\nBet sizes will be scaled to **${newScale}×** until drawdown recovers above 5%.`,
          color:       0xff8800,
        }, webhooks).catch(() => {})
      } else if (newScale === 1.0 && curScale < 1.0) {
        const webhooks = await getAllWebhooks({ all: dbAll }).catch(() => [])
        await notifyAlert({
          title:       '✅ Drawdown scale restored to 1.0× — full sizing resumed',
          description: `7-day P&L: **$${rollingPnl.toFixed(2)}** (${(drawdownPct*100).toFixed(1)}% of capital)\nDrawdown has recovered — normal bet sizing resumes.`,
          color:       0x2ecc71,
        }, webhooks).catch(() => {})
      }
    }
  } catch (err) {
    console.error('[drawdown] recomputeDrawdownScale error:', err.message)
  }
}

// ── Health sentinel — runs every 60s during game window (Apr 28). ────────────
// Reads heartbeat timestamps written by liveMonitor and gamePulse loops; alerts
// Discord when any is stale. Also checks per-game phase milestones (T-180 / T-90
// / T-30 line snapshots and lineup posting) and alerts if a window passed without
// the expected action firing. Adam's "is anything broken right now" pager.
let _phaseAlerted = new Set()  // session-scoped dedup for per-game milestones
async function runHealthSentinel() {
  try {
    const { alertLiveMonitorStalled, alertGamePulseStalled } =
      await import('../lib/healthAlerts.js')
    const now = Date.now()

    // Game-hours window — 11am ET to 2am ET next day. Outside this, monitors
    // are intentionally idle and we shouldn't alert on stale heartbeats.
    const hm = etHHMM()
    const inWindow = hm >= 8 * 60 || hm < 2 * 60   // 8am–2am ET (matches liveMonitor start window)
    if (!inWindow) return

    // 1. liveMonitor heartbeat (expected every iteration, ~5–15s).
    //    Alert if >2 min stale. If >3 min stale, force-kill the child and respawn —
    //    the in-process watchdog at line 118 / 970 only checks `exitCode !== null`,
    //    which doesn't catch zombie state where the DB client died mid-run but the
    //    process is still alive (4/28 incident: Turso "Client was manually closed"
    //    cascaded into a 16-min stall with the process still up).
    // Apr 30: when liveMonitor exits cleanly via daily-loss / drawdown halt it
    // sets system_flags.drawdown_halted=<TODAY>. Suppress the stale-heartbeat
    // alert and the force-kill+respawn for the rest of the day; otherwise the
    // monitor would respawn, hit the same halt, and loop forever.
    const haltedRow = await dbOne(`SELECT value FROM system_flags WHERE key='drawdown_halted'`).catch(() => null)
    const haltedToday = haltedRow?.value === etDate()

    const lm = await dbOne(`SELECT value, updated_at FROM system_flags WHERE key='liveMonitor_heartbeat'`).catch(() => null)
    if (lm && !haltedToday) {
      const lastMs = Number(lm.value) || Date.parse(lm.updated_at) || 0
      const ageMs = now - lastMs
      if (ageMs > 2 * 60 * 1000) {
        await alertLiveMonitorStalled({ lastHeartbeatMs: lastMs, ageMs }).catch(() => {})
      }
      if (ageMs > 3 * 60 * 1000) {
        try {
          if (_liveMonitorChild && _liveMonitorChild.pid) {
            console.warn(`[healthSentinel] liveMonitor heartbeat ${Math.round(ageMs/1000)}s stale — force-killing pid ${_liveMonitorChild.pid} and respawning`)
            try { _liveMonitorChild.kill('SIGKILL') } catch {}
            _liveMonitorChild = null
          }
          startLiveMonitor(etDate())
        } catch (err) {
          console.error('[healthSentinel] respawn error:', err.message)
        }
      }
    }

    // 2. gamePulse main loop heartbeat (60s tick). Alert if >3 min stale.
    const gp = await dbOne(`SELECT value, updated_at FROM system_flags WHERE key='gamePulse_heartbeat'`).catch(() => null)
    if (gp) {
      const lastMs = Number(gp.value) || Date.parse(gp.updated_at) || 0
      const ageMs = now - lastMs
      if (ageMs > 3 * 60 * 1000) {
        await alertGamePulseStalled({ lastUpdateMs: lastMs, ageMs }).catch(() => {})
      }
    }

    // 3. Sub-component cadences. updateGamePulse should fire every 60s; line
    //    direction every 5min; schedule refresh every 30min. We alert if any
    //    sub-component is materially behind its expected cadence (3× tolerance).
    for (const [key, expectedMs, label] of [
      ['gamePulse_updateGamePulse_at', 60 * 1000,         'updateGamePulse'],
      ['gamePulse_lineDir_at',         5 * 60 * 1000,     'updateLineDirections'],
      ['gamePulse_scheduleRefresh_at', 30 * 60 * 1000,    'initGamePulse refresh'],
    ]) {
      const row = await dbOne(`SELECT value FROM system_flags WHERE key=?`, [key]).catch(() => null)
      if (!row) continue   // never run yet — initial boot
      const lastMs = Number(row.value) || 0
      const ageMs  = now - lastMs
      if (ageMs > expectedMs * 3) {
        const { alertGamePulseStalled: pulseAlert } = await import('../lib/healthAlerts.js')
        // Reuse stalled-pulse alert with sub-label by appending to description
        await pulseAlert({ lastUpdateMs: lastMs, ageMs }).catch(() => {})
        console.warn(`[healthSentinel] ${label} stale by ${Math.round(ageMs/60000)}min (expected every ${Math.round(expectedMs/60000)}min)`)
      }
    }

    // 4. Per-game phase milestones. For each pre_game game on today's slate:
    //    - If T-180 passed >5 min ago AND no t180 line snapshot → alert
    //    - If T-90 passed >5 min ago AND no t90 line snapshot → alert
    //    - If T-30 passed >5 min ago AND phase still pre_lineup (no lineups) → alert
    const date = etDate()
    const games = await dbAll(`
      SELECT game_pk, bet_date, home_team, away_team, game_time_et, phase,
             dk_home_line_t180, dk_home_line_t90, dk_away_line_t180, dk_away_line_t90,
             home_lineup_posted, away_lineup_posted
      FROM game_pulse
      WHERE bet_date=? AND phase NOT IN ('final','postponed')
    `, [date]).catch(() => [])
    const { alertGamePulseStalled: pulseAlert } = await import('../lib/healthAlerts.js')
    const _post = async (key, msg) => {
      if (_phaseAlerted.has(key)) return
      _phaseAlerted.add(key)
      // Reuse pulseAlert with a synthetic age — but really we want a custom message
      try {
        const ADAM_WEBHOOK = process.env.ADAM_WEBHOOK_URL ||
          'https://discord.com/api/webhooks/1495964427382558740/e6Q7pZPQWSjghWSx9XYYeXWBVXIFV1kPvSG-lmE9YSDiRbnaABSLCvYTUUNLE_Feer6W'
        await fetch(ADAM_WEBHOOK, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ embeds: [{ title: '⏰ Pulse milestone missed', description: msg, color: 0xfb8c00, timestamp: new Date().toISOString(), footer: { text: 'healthSentinel · baseball' } }] }),
        }).catch(() => {})
      } catch {}
    }
    for (const g of games) {
      if (!g.game_time_et || !g.bet_date) continue
      const [h, m] = String(g.game_time_et).split(':').map(Number)
      const month  = parseInt(g.bet_date.slice(5, 7), 10)
      const offset = (month >= 3 && month <= 10) ? '-04:00' : '-05:00'
      const gameMs = Date.parse(`${g.bet_date}T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00${offset}`)
      if (!Number.isFinite(gameMs)) continue
      const minToGame = (gameMs - now) / 60000
      const tag = `${g.bet_date}|${g.game_pk}`
      // T-180 line snapshot. Alert only on true NULL (snapshot never attempted —
      // real fetcher failure). Sentinel 0 means "DK had no line for this
      // pitcher" — gamePulse already recorded the attempt; not a bug.
      if (minToGame < 175 && minToGame > -10) {
        if (g.dk_home_line_t180 == null && g.dk_away_line_t180 == null) {
          _post(`${tag}|t180`, `**${g.away_team}@${g.home_team}** — T-180 passed without DK line snapshot. Check fetchKProps & line direction.`)
        }
      }
      // T-90 line snapshot — same null-vs-sentinel-0 distinction
      if (minToGame < 85 && minToGame > -10) {
        if (g.dk_home_line_t90 == null && g.dk_away_line_t90 == null) {
          _post(`${tag}|t90`, `**${g.away_team}@${g.home_team}** — T-90 passed without DK line snapshot.`)
        }
      }
      // T-30 lineup expected
      if (minToGame < 25 && minToGame > -10) {
        if (g.phase === 'pre_lineup') {
          _post(`${tag}|t30`, `**${g.away_team}@${g.home_team}** — T-30 passed but phase is still **pre_lineup** (lineups not posted to game_pulse). Bets gated on lineup posting will not fire.`)
        }
      }
    }

    // ── The Oracle: Layer 0 (Trace) — health probe + queue backlog ─────────
    // Synthetic write+read roundtrip every minute. 2 consecutive failures →
    // ORACLE-HEALTH alert (handled inside traceHealthProbe).
    // Async queue backlog: alert if length > 500 OR oldest > 60s.
    try {
      await traceHealthProbe().catch(err => {
        console.error('[oracle.healthProbe] sentinel-level error:', err.message)
      })
      const qs = oracleQueueStats()
      await checkQueueBacklog(qs).catch(err => {
        console.error('[oracle.checkQueueBacklog] error:', err.message)
      })
    } catch (err) {
      console.error('[oracle.health] sentinel error:', err.message)
    }
  } catch (err) {
    console.error('[healthSentinel] error:', err.message)
  }
}

export async function startScheduler({ gateway = null } = {}) {
  // ── The Oracle: Layer 0 (Trace) initialization ───────────────────────────
  // Wires critical-failure handler to ORACLE-HEALTH webhook + starts async flusher.
  // Idempotent — safe to call on every startup.
  // Tables already migrated; this just wires runtime hooks.
  try {
    initOracle()
  } catch (err) {
    console.error('[oracle] init failed:', err.message)
  }

  // Safe column migrations for bet_schedule (no-op if already exist)
  for (const col of ['preflight TEXT', 'notes TEXT', 'allocated_usd REAL', 'preflight_outcome TEXT', 'preflight_checked_at TEXT']) {
    await dbRun(`ALTER TABLE bet_schedule ADD COLUMN ${col}`).catch(() => {})
  }

  // ── Bat Sonar: Layer 1 + bankrollState init ────────────────────────────────
  const date = etDate()

  // Init bankrollState (atomic daily singleton — safe to re-init on redeploy)
  await initBankrollState(date).catch(err => console.error('[scheduler] bankrollState init error:', err.message))

  // Reconcile bankroll from ks_bets on startup to recover from crash/redeploy
  await reconcileBankrollState(date).catch(() => {})

  // Clean any stale bet locks from previous process
  await cleanStaleLocks().catch(() => {})

  // Start Layer 1 permanent pulse loop (slate awareness + scratch watch)
  startPulseLoop(date).catch(err => console.error('[gamePulse] startup error:', err.message))

  // ── Event-driven bet firing: lineup posted → immediate fire ───────────────
  // When game_pulse detects both lineups confirmed, fire pending bets NOW
  // rather than waiting for the next 5-min cron tick. This is the key speed fix
  // that reduces lineup-to-bet latency from up to 5 minutes to under 30 seconds.
  pulseEvents.on('lineup_posted', ({ gamePk, side, date: eventDate }) => {
    if (eventDate !== etDate()) return
    console.log(`[scheduler] EVENT: lineup posted ${gamePk} (${side}) — triggering immediate bet fire`)
    // Small delay to let fetchLineups DB write settle before ksBets reads it
    setTimeout(() => {
      firePendingBets().catch(err => console.error('[scheduler] event-driven firePendingBets error:', err.message))
    }, 5_000)
  })

  // Scratch alert → cancel any open resting orders for scratched pitcher
  pulseEvents.on('scratch_alert', ({ gamePk, pitcherId, side, date: eventDate }) => {
    if (eventDate !== etDate()) return
    console.log(`[scheduler] EVENT: scratch alert ${gamePk} pitcher ${pitcherId}`)
    // Run ksBets cancel-scratched to clean up open orders
    run('Cancel scratched orders', `node scripts/live/ksBets.js cancel-scratched --date ${eventDate} --pitcher-id ${pitcherId}`)
    // Also invalidate preflight cache for this pitcher
    dbRun(`UPDATE bet_schedule SET preflight=NULL, notes='scratch alert — preflight invalidated', preflight_checked_at=NULL WHERE bet_date=? AND pitcher_id=? AND status='pending'`,
      [eventDate, pitcherId]).catch(() => {})
  })

  // Pull detected → invalidate edge cache + cancel pre-game orders if confirmed pull
  // Confirmed pull = reliever on mound. Edge cache invalidation ensures next plan
  // re-runs strikeoutEdge without this pitcher's stale edge.
  pulseEvents.on('pull_detected', ({ gamePk, pitcherId, side, confirmed, date: eventDate }) => {
    if (eventDate !== etDate()) return
    console.log(`[scheduler] EVENT: pull detected ${gamePk} pitcher ${pitcherId} (confirmed=${confirmed})`)
    dbRun(
      `UPDATE pitcher_edge_cache SET edge_computed_at='1970-01-01T00:00:00.000Z'
       WHERE pitcher_id=? AND bet_date=?`,
      [String(pitcherId), eventDate],
    ).catch(() => {})
    // Confirmed pull → cancel any resting pre-game orders (same pipeline as scratch)
    if (confirmed) {
      run('Cancel pulled pitcher orders', `node scripts/live/ksBets.js cancel-scratched --date ${eventDate} --pitcher-id ${pitcherId}`)
    }
  })

  // Phase change → pre_game entering live means first pitch — start live monitor immediately
  pulseEvents.on('phase_change', ({ gamePk, from, to, date: eventDate }) => {
    if (eventDate !== etDate()) return
    if (to === 'live' && from === 'pre_game') {
      console.log(`[scheduler] EVENT: phase_change ${gamePk} pre_game→live — ensuring live monitor is up`)
      if (!_liveMonitorChild || _liveMonitorChild.exitCode !== null) {
        startLiveMonitor(eventDate)
      }
    }
    // pre_lineup → pre_game (lineups just confirmed) → re-run edge immediately
    if (to === 'pre_game' && from === 'pre_lineup') {
      console.log(`[scheduler] EVENT: phase_change ${gamePk} pre_lineup→pre_game — triggering edge rescan`)
      setTimeout(() => {
        run('Edge rescan (lineup confirmed)', `node scripts/live/ksBets.js plan --date ${eventDate}`)
      }, 3_000)
    }
  })

  // Sharp DK line move → immediate edge rescan (sharp money is signal)
  pulseEvents.on('sharp_line_move', ({ gamePk, side, pitcherId, from, to, delta, date: eventDate }) => {
    if (eventDate !== etDate()) return
    console.log(`[scheduler] EVENT: sharp line move ${gamePk} ${side} pitcher ${pitcherId} ${from}→${to} (Δ${delta > 0 ? '+' : ''}${delta.toFixed(1)}) — triggering edge rescan`)
    setTimeout(() => {
      run('Edge rescan (sharp line move)', `node scripts/live/ksBets.js plan --date ${eventDate}`)
    }, 2_000)
  })

  // Game final → immediate bankroll settle reconciliation
  pulseEvents.on('game_final', ({ gamePk, date: eventDate }) => {
    if (eventDate !== etDate()) return
    console.log(`[scheduler] EVENT: game final ${gamePk} — triggering immediate settle`)
    setTimeout(() => {
      run('Immediate settle (game final)', `node scripts/live/ksBets.js settle --date ${eventDate}`)
      // Wait 90s — settle pipeline (syncFills + ksBets settle + syncSettlements) takes ~50s.
      // Reconciling before it completes reads partial P&L and corrupts available_pool.
      setTimeout(() => reconcileBankrollState(eventDate).catch(() => {}), 90_000)
    }, 10_000)
  })

  // Bankroll state: 3am reinit for new day
  cron.schedule('1 3 * * *', async () => {
    const newDate = etDate()
    await initBankrollState(newDate).catch(err => console.error('[scheduler] bankrollState 3am reinit:', err.message))
    // Restart pulse loop for new day
    const { stopPulseLoop } = await import('../lib/gamePulse.js')
    stopPulseLoop()
    setTimeout(() => startPulseLoop(newDate).catch(() => {}), 5_000)
  }, { timezone: 'America/New_York' })

  // Safe column migrations for ks_bets — CLV tracking (Item 1)
  for (const col of ['closing_line_cents INTEGER', 'clv_cents REAL', 'closing_line_captured_at TEXT']) {
    await dbRun(`ALTER TABLE ks_bets ADD COLUMN ${col}`).catch(() => {})
  }
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_ks_bets_clv ON ks_bets(bet_date, clv_cents)`).catch(() => {})

  // Ensure system_flags table exists with default rows (Item 2 / Item 6)
  await dbRun(`CREATE TABLE IF NOT EXISTS system_flags (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by TEXT
  )`).catch(() => {})
  await dbRun(`INSERT OR IGNORE INTO system_flags (key, value, updated_by) VALUES ('trading_halted','0','system')`).catch(() => {})
  await dbRun(`INSERT OR IGNORE INTO system_flags (key, value, updated_by) VALUES ('drawdown_scale','1.0','system')`).catch(() => {})

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

  // Wire process-level error sentinel — catches any uncaught exception/rejection
  // and immediately sends a raw alert to Adam's Discord webhook.
  watchProcess()

  // On startup, fire any jobs whose window has already passed today
  const hm = etHHMM()
  // date already declared above (etDate()) — reuse it here

  // Cleanup stale 'fired' rows from crashed sessions
  // 1a. Any 'fired' row older than 4h WITH matching ks_bets → mark done (bets were placed, status update was lost)
  const fourHoursAgo = new Date(Date.now() - 4 * 3600 * 1000).toISOString()
  await dbRun(
    `UPDATE bet_schedule SET status='done',
      notes=COALESCE(notes,'') || ' [recovered-done ' || datetime('now') || ']'
     WHERE status='fired' AND fired_at IS NOT NULL AND fired_at < ?
       AND EXISTS (
         SELECT 1 FROM ks_bets k
         WHERE k.bet_date = bet_schedule.bet_date
           AND k.pitcher_id = bet_schedule.pitcher_id
           AND k.live_bet = 0 AND k.paper = 0
       )`,
    [fourHoursAgo],
  ).catch(() => {})
  // 1b. Any 'fired' row older than 4h WITHOUT ks_bets → error (process truly never completed)
  await dbRun(
    `UPDATE bet_schedule SET status='error',
      notes=COALESCE(notes,'') || ' [stale-fired ' || datetime('now') || ']'
     WHERE status='fired' AND fired_at IS NOT NULL AND fired_at < ?
       AND NOT EXISTS (
         SELECT 1 FROM ks_bets k
         WHERE k.bet_date = bet_schedule.bet_date
           AND k.pitcher_id = bet_schedule.pitcher_id
           AND k.live_bet = 0 AND k.paper = 0
       )`,
    [fourHoursAgo],
  ).catch(() => {})

  // 2. 'Fired' rows older than 5 min with no matching ks_bets.
  //    Check decision_pipeline to distinguish "no edge found" from "process crashed".
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString()
  // 2a. decision_pipeline shows a clean no_edge/preflight outcome → mark skipped (not error)
  await dbRun(
    `UPDATE bet_schedule SET status='skipped',
      notes=COALESCE(notes,'') || ' [no-edge ' || datetime('now') || ']'
     WHERE status='fired' AND fired_at IS NOT NULL AND fired_at < ?
       AND NOT EXISTS (
         SELECT 1 FROM ks_bets k
         WHERE k.bet_date = bet_schedule.bet_date
           AND k.pitcher_id = bet_schedule.pitcher_id
           AND k.live_bet = 0 AND k.paper = 0
       )
       AND EXISTS (
         SELECT 1 FROM decision_pipeline dp
         WHERE dp.bet_date = bet_schedule.bet_date
           AND dp.pitcher_id = CAST(bet_schedule.pitcher_id AS TEXT)
           AND dp.final_action IN ('no_edge','no_markets','preflight_skip','filtered_out')
       )`,
    [fiveMinAgo],
  ).catch(() => {})
  // 2b. No decision_pipeline entry → true process crash → mark error
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
    const existingBets  = await dbOne(`SELECT COUNT(*) AS n FROM ks_bets WHERE bet_date = ? AND live_bet = 0`, [date]).catch(() => ({ n: 0 }))
    const existingSched = await dbOne(`SELECT COUNT(*) AS n FROM bet_schedule WHERE bet_date = ?`, [date]).catch(() => ({ n: 0 }))
    const firedSched    = await dbOne(`SELECT COUNT(*) AS n FROM bet_schedule WHERE bet_date = ? AND status IN ('fired','skipped','error')`, [date]).catch(() => ({ n: 0 }))
    if (!existingBets?.n && !existingSched?.n && !firedSched?.n) {
      console.log('[scheduler] startup catch-up: MLB morning run')
      mlbRun('MLB morning run (catch-up)')
    } else {
      console.log(`[scheduler] startup: morning pipeline already ran for ${date} (${existingBets?.n ?? 0} bets, ${existingSched?.n ?? 0} scheduled, ${firedSched?.n ?? 0} fired/skipped/error) — skipping`)
    }
  }
  // liveMonitor is managed by The Closer (Windows agent), but Railway also starts it on
  // phase_change events AND on startup during game hours. Apr 28 — widened from 5pm–2am
  // to 11am–2am ET so afternoon games (1pm starts) restart correctly after a midday
  // redeploy. The monitor idles cheaply when there's nothing to track, so a wider
  // window costs little and prevents missed-game blackouts.
  {
    const hmNow = etHHMM()
    const inGameWindow = hmNow >= 8 * 60 || hmNow < 2 * 60   // 8am–2am ET (Apr 28: widened from 11am to capture earlier prep)
    if (inGameWindow) {
      console.log('[scheduler] startup: game hours — starting live monitor')
      startLiveMonitor(date)
    }
  }

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
  await firePendingBets().catch(err => console.error('[scheduler] startup firePendingBets error:', err.message))
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

  // 3:30pm post-lineup portfolio plan
  if (hm >= 15 * 60 + 30 && await cronMissed('portfolio-plan-post-lineup', 15, 30)) {
    const plan = await dbOne(`SELECT bet_date FROM daily_plan WHERE bet_date = ?`, [date]).catch(() => null)
    if (plan) {
      console.log('[scheduler] startup catch-up: post-lineup portfolio plan (3:30pm missed)')
      run('Portfolio plan post-lineup (catch-up)', `node scripts/live/ksBets.js plan --date ${date}`)
      logCronRun('portfolio-plan-post-lineup')
    }
  }

  // 4:05pm second lineup pass (staggered from settle batch at :00)
  if (hm >= 16 * 60 + 5 && await cronMissed('lineup-refresh-4pm', 16, 5)) {
    console.log('[scheduler] startup catch-up: 4:05pm lineup refresh missed')
    mlbRun('MLB lineup refresh (4pm catch-up)', '--lineups')
    logCronRun('lineup-refresh-4pm')
    setTimeout(() => {
      run('Portfolio plan (4pm catch-up)', `node scripts/live/ksBets.js plan --date ${date}`)
      logCronRun('portfolio-plan-4pm')
    }, 90_000)
  }

  // 7:00 AM ET — early schedule + Savant refresh (slate visibility, pitcher data).
  cron.schedule('0 7 * * *', () => {
    const d = etDate()
    run('Early schedule fetch', `node scripts/live/fetchSchedule.js --date ${d} --days 1`)
    setTimeout(() => run('Early Savant fetch', `node scripts/live/fetchPitcherStatcast.js`), 30_000)
    logCronRun('early-schedule')
  }, { timezone: 'America/New_York' })

  // 9:00 AM ET daily — contra-test experiment decision-date reminder.
  // Fires ONCE on or after 2026-05-20 with current status. Self-dedups via
  // system_flags `contra_test_reminder_sent`. See memory: project_baseball_contra_test_apr29.
  cron.schedule('0 9 * * *', async () => {
    try {
      const DECISION_DATE = '2026-05-20'
      const today = etDate()
      if (today < DECISION_DATE) return
      const sentRow = await dbOne(`SELECT value FROM system_flags WHERE key='contra_test_reminder_sent'`).catch(() => null)
      if (sentRow?.value === '1') return
      const summary = await dbOne(`
        SELECT COUNT(*) AS bets,
               SUM(CASE WHEN result='win'  THEN 1 ELSE 0 END) AS wins,
               SUM(CASE WHEN result='loss' THEN 1 ELSE 0 END) AS losses,
               SUM(CASE WHEN result IS NULL THEN 1 ELSE 0 END) AS pending,
               ROUND(SUM(pnl), 2) AS total_pnl,
               ROUND(SUM(capital_at_risk), 2) AS total_risk
        FROM ks_bets
        WHERE bet_mode='contra-test' AND user_id=2
      `).catch(() => null)
      const bets = Number(summary?.bets || 0)
      const totalPnl = Number(summary?.total_pnl || 0)
      const totalRisk = Number(summary?.total_risk || 0)
      const roi = totalRisk > 0 ? (totalPnl / totalRisk * 100) : 0
      const sufficient = bets >= 50
      const recommend = !sufficient ? 'EXTEND — sample too small' : roi >= 3 ? 'GRADUATE — ship Undertaker (#48)' : roi <= 0 ? 'KILL — thesis falsified' : 'EXTEND — marginal'
      const ADAM_WEBHOOK = process.env.ADAM_WEBHOOK_URL ||
        'https://discord.com/api/webhooks/1495964427382558740/e6Q7pZPQWSjghWSx9XYYeXWBVXIFV1kPvSG-lmE9YSDiRbnaABSLCvYTUUNLE_Feer6W'
      const color = roi >= 3 ? 0x2ecc71 : roi <= 0 ? 0xe74c3c : 0xf39c12
      await fetch(ADAM_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ embeds: [{
          title: '🔬 Contra-test decision date',
          description:
            `**${bets}** bets · **${summary?.wins || 0}**W / **${summary?.losses || 0}**L · **${roi.toFixed(1)}%** ROI\n` +
            `P&L **${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}** on $${totalRisk.toFixed(2)} risk\n\n` +
            `**Recommendation:** ${recommend}\n\n` +
            `Memory: project_baseball_contra_test_apr29.md`,
          color,
          timestamp: new Date().toISOString(),
          footer: { text: 'contra-test reminder · baseball' },
        }] }),
      }).catch(() => {})
      // Mark sent so we don't re-fire daily
      await dbRun(
        `INSERT INTO system_flags (key, value, updated_at, updated_by)
         VALUES ('contra_test_reminder_sent', '1', ?, 'scheduler')
         ON CONFLICT(key) DO UPDATE SET value='1', updated_at=excluded.updated_at`,
        [new Date().toISOString()],
      ).catch(() => {})
      console.log('[scheduler] contra-test decision-date reminder sent to Adam Discord')
    } catch (err) {
      console.error('[scheduler] contra-test reminder error:', err.message)
    }
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
    logCronRun('morning-run')
    try {
      const plan = await dbOne(`SELECT bet_date FROM daily_plan WHERE bet_date = ?`, [d])
      if (plan) {
        console.log(`[scheduler] 8:30am: daily_plan already exists — morning pipeline ran early, skipping`)
        return
      }
    } catch { /* proceed */ }
    mlbRun('MLB morning run')
  }, { timezone: 'America/New_York' })

  // Refresh K prop lines every 30 min from 9am–9pm ET.
  // Starts at 9am so that 1pm ET games have fresh DK/FD consensus when lineups post.
  // Apr 28 — extended from 9-17 to 9-21 to keep DK lines fresh for west-coast 22:10 ET
  // first-pitches (T-90 ≈ 20:40, T-30 ≈ 21:40). Previously stale by 5pm.
  cron.schedule('*/30 9-21 * * *', () => {
    run('K prop refresh', `node scripts/live/fetchKProps.js --date ${etDate()}`)
  }, { timezone: 'America/New_York' })

  // NBA morning run disabled

  // Every 30 min, 8:30am–8pm ET — re-fetch MLB schedule from API.
  // Apr 28 — extended from 8-17 to 8-19 to catch late postponement announcements that
  // can affect 22:10 ET starts. Most postponements still fall in 4-6pm ET window.
  cron.schedule('30 8-19 * * *', () => {
    run('Schedule refresh', `node scripts/live/fetchSchedule.js --date ${etDate()} --days 1`)
  }, { timezone: 'America/New_York' })

  // 4:00 PM and 5:00 PM ET — dedicated postponement detection passes.
  // Weather postponements are most commonly announced between 3-6pm ET. This ensures
  // any bet_schedule rows for postponed games are cancelled before markets close.
  for (const hour of [16, 17]) {
    cron.schedule(`0 ${hour} * * *`, async () => {
      const d = etDate()
      run(`Postponement check (${hour}:00)`, `node scripts/live/fetchSchedule.js --date ${d} --days 1`)
      // Cancel any pending bets for games now marked postponed
      setTimeout(async () => {
        try {
          const postponed = await dbAll(
            `SELECT DISTINCT pitcher_id FROM bet_schedule bs
             WHERE bs.bet_date = ? AND bs.status = 'pending'
               AND EXISTS (
                 SELECT 1 FROM games g
                 WHERE g.date = bs.bet_date AND g.status = 'postponed'
                   AND (g.pitcher_home_id = bs.pitcher_id OR g.pitcher_away_id = bs.pitcher_id)
               )`,
            [d],
          )
          if (postponed.length) {
            console.log(`[scheduler] Postponement check: cancelling ${postponed.length} pending bets for postponed games`)
            for (const row of postponed) {
              await dbRun(
                `UPDATE bet_schedule SET status='cancelled', notes='game postponed' WHERE bet_date=? AND pitcher_id=? AND status='pending'`,
                [d, row.pitcher_id],
              ).catch(() => {})
            }
          }
        } catch (err) {
          console.error(`[scheduler] postponement cancel error: ${err.message}`)
        }
      }, 60_000)
    }, { timezone: 'America/New_York' })
  }

  // Every 10 min, 8am–8pm ET — continuous edge rescan + bet_schedule rebuild.
  // plan re-runs strikeoutEdge.js with fresh Kalshi prices, recomputes Kelly sizing,
  // and rewrites daily_plan. build-schedule adds any newly-listed probable starters.
  // Catches price movements that create new edges throughout the day — including for
  // morning games before lineups post and for late additions to the probable-starter list.
  // Apr 28 — extended from 8-20 to 8-22 so late west-coast first-pitches (22:10 ET) still
  // get edge rescans through their T-30 window and beyond.
  cron.schedule('*/10 8-22 * * *', () => {
    const d = etDate()
    logCronRun('edge-rescan')
    run('Edge rescan', `node scripts/live/ksBets.js plan --date ${d}`)
    // Wait 2 min for plan (which runs strikeoutEdge internally) to finish
    setTimeout(() => {
      run('bet_schedule rebuild', `node scripts/live/ksBets.js build-schedule --date ${d}`)
      // Check resting orders for pitchers that dropped out of the fresh plan
      checkSouredOrders().catch(err => console.error('[sour-check] error:', err.message))
    }, 120_000)
  }, { timezone: 'America/New_York' })

  // Every 5 min, 3am–11pm ET — fetch lineups then fire pending bets.
  // Apr 28 — extended from 3-20 to 3-22 so west-coast 22:10 ET first-pitches still
  // get lineup fetches through their T-30/T-60 windows. Late lineup confirmations
  // (typical for west-coast 22:10 starts) post 19:00–21:00 ET — would miss them at 20:55.
  cron.schedule('*/5 3-22 * * *', () => {
    const d = etDate()
    logCronRun('fire-pending-bets')
    run('Lineup check', `node scripts/live/fetchLineups.js --date ${d}`)
    setTimeout(() => firePendingBets().catch(err => console.error('[scheduler] firePendingBets error:', err.message)), 30_000)
    // Top-up: after firePendingBets runs, try to fill remaining allocation on partially-filled positions.
    // Checks edge at current ask and buys up to original Kelly target. Runs 60s after lineup fetch settles.
    setTimeout(() => run('Pre-game top-up', `node scripts/live/ksBets.js topup --date ${d}`), 60_000)
  }, { timezone: 'America/New_York' })

  // Every 5 min outside lineup-check hours — fire pending bets only (no lineup fetch).
  // Apr 28 — narrowed range since lineup-check cron now covers 3-22.
  cron.schedule('*/5 0-2,23 * * *', () => {
    logCronRun('fire-pending-bets')
    firePendingBets().catch(err => console.error('[scheduler] firePendingBets error:', err.message))
  }, { timezone: 'America/New_York' })

  // ── Paper-flag integrity sweep (May 4 hardening) ────────────────
  // Runs every minute. Auto-corrects any ks_bets row where order_id starts
  // with 'paper-' (synthetic from KALSHI_PAPER_MODE wrapper) but paper=0
  // (flagged as real money). Both the May 3 startup-backfill bug and the
  // May 4 contra-test hardcoded-paper=0 bug created this exact mismatch
  // and tripped reconciliation halts. Self-healing instead of halting on
  // any future occurrence of this bug class. Logs each correction so we
  // can identify which code path is regressing.
  cron.schedule('* * * * *', async () => {
    try {
      const rows = await dbAll(
        `SELECT id, pitcher_name, side, strike, strategy_mode, bet_mode
         FROM ks_bets
         WHERE live_bet = 0 AND paper = 0 AND order_id LIKE 'paper-%'`,
      ).catch(() => [])
      if (!rows.length) return
      await dbRun(`UPDATE ks_bets SET paper = 1 WHERE live_bet = 0 AND paper = 0 AND order_id LIKE 'paper-%'`).catch(() => {})
      for (const r of rows) {
        console.warn(`[paper-flag-sweep] auto-corrected #${r.id} ${r.pitcher_name} ${r.side}${r.strike} (mode=${r.strategy_mode}/bet=${r.bet_mode}) — paper=0→1 because synthetic order_id`)
      }
      console.warn(`[paper-flag-sweep] corrected ${rows.length} row(s) — investigate which code path created them`)
    } catch (err) {
      console.error('[paper-flag-sweep] error:', err.message)
    }
  }, { timezone: 'America/New_York' })

  // ── Reconciliation loop (May 3 operational layer) ──────────────
  // Every 5 min: pull Kalshi positions for both live users, diff against DB.
  // Halt on any mismatch — drift means we don't actually know our exposure.
  // Tracks consecutive Kalshi API failures to avoid halting on transient errors.
  let _reconErrorStreak = { 2: 0, 284: 0 }
  cron.schedule('*/5 * * * *', async () => {
    try {
      const recon = await import('../lib/reconciliation.js')
      const cage  = await import('../lib/cageAlerts.js')
      const today = etDate()
      const result = await recon.reconcileAll({ db: { all: dbAll, one: dbOne, run: dbRun }, betDate: today })
      await recon.persistReconciliationResult({ db: { all: dbAll, one: dbOne, run: dbRun }, result })

      // Track per-user consecutive errors; halt only on 2+ in a row
      for (const u of (result.users || [])) {
        if (!u.ok && u.error) {
          _reconErrorStreak[u.user_id] = (_reconErrorStreak[u.user_id] || 0) + 1
          if (_reconErrorStreak[u.user_id] >= 2) {
            console.error(`[reconciliation] HALT — ${u.user_name} API errors x${_reconErrorStreak[u.user_id]}: ${u.error}`)
            await dbRun(
              `INSERT OR REPLACE INTO system_flags (key, value, updated_by, updated_at)
               VALUES ('trading_halted','1','reconciliation_api_error',?)`,
              [new Date().toISOString()],
            ).catch(() => {})
            await cage.alertHalt({ reason: 'reconciliation_api_error', detail: `${u.user_name}: ${u.error}`, user_id: u.user_id })
          }
        } else {
          _reconErrorStreak[u.user_id] = 0
        }
      }

      const halt = await recon.maybeHaltOnMismatch({ db: { all: dbAll, one: dbOne, run: dbRun }, result })
      if (halt.halted) {
        const allMismatches = (result.users || []).flatMap(u => (u.mismatches || []).map(m => ({ ...m, user: u.user_name })))
        console.error(`[reconciliation] HALT — ${allMismatches.length} mismatches`)
        for (const u of (result.users || [])) {
          if (u.mismatches?.length) {
            await cage.alertReconciliationMismatch({
              user_id: u.user_id, user_name: u.user_name, mismatches: u.mismatches,
            })
          }
        }
      }
    } catch (err) {
      console.error('[reconciliation] cron error:', err.message)
    }
  }, { timezone: 'America/New_York' })

  // ── Heartbeat to Discord (May 3 operational layer) ─────────────
  // Every 60s: write heartbeat to system_flags. A separate watchdog detects
  // staleness and alerts.
  cron.schedule('* * * * *', async () => {
    try {
      await dbRun(
        `INSERT OR REPLACE INTO system_flags (key, value, updated_by, updated_at)
         VALUES ('scheduler_heartbeat', ?, 'scheduler', ?)`,
        [String(Date.now()), new Date().toISOString()],
      ).catch(() => {})
    } catch {}
  }, { timezone: 'America/New_York' })

  // ── Heartbeat-lost watchdog (every 60s) ─────────────────────────
  // If liveMonitor's heartbeat hasn't fired in >90s during game hours, alert.
  // The scheduler heartbeat itself can't detect its own loss; this watches
  // the LIVE monitor (which is the at-risk component for live placements).
  //
  // Suppression rules (don't alert when liveMonitor isn't expected to be alive):
  //   - Outside game-hours window (currently ET 09:00-23:59 inclusive)
  //   - When trading_halted=1 (system intentionally off; monitor may be down by design)
  //   - When drawdown_halted = TODAY (monitor was killed today by drawdown protection)
  let _lastHeartbeatLostAlertAt = 0
  cron.schedule('* * * * *', async () => {
    try {
      // Game-hours suppression — only alert during ET 09:00 to 23:59
      const etHourStr = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false })
      const etHour = Number(etHourStr) || 0
      if (etHour < 9) return  // pre-game-day quiet hours

      // Halt suppression — if intentionally halted, monitor may be intentionally not running
      const haltRow = await dbOne(`SELECT value FROM system_flags WHERE key='trading_halted'`).catch(() => null)
      if (haltRow?.value === '1') return

      // Drawdown-today suppression — monitor was killed today by drawdown protection
      const ddRow = await dbOne(`SELECT value FROM system_flags WHERE key='drawdown_halted'`).catch(() => null)
      const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
      if (ddRow?.value === todayET) return

      const row = await dbOne(`SELECT value FROM system_flags WHERE key='liveMonitor_heartbeat'`).catch(() => null)
      if (!row?.value) return
      const lastMs = Number(row.value)
      const ageS = Math.round((Date.now() - lastMs) / 1000)
      if (ageS > 90) {
        // Don't spam — only alert once per 5 min if persistently lost
        if (Date.now() - _lastHeartbeatLostAlertAt > 5 * 60 * 1000) {
          _lastHeartbeatLostAlertAt = Date.now()
          console.error(`[heartbeat-watchdog] liveMonitor heartbeat stale ${ageS}s — alerting`)
          try {
            const cage = await import('../lib/cageAlerts.js')
            await cage.alertHeartbeatLost({ component: 'liveMonitor', last_seen_seconds_ago: ageS })
          } catch {}
        }
      }
    } catch {}
  }, { timezone: 'America/New_York' })

  // ── Dynamic pitcher blocklist (11:00 PM ET daily, before EOD) ──
  // Auto-add pitchers with poor rolling performance, auto-remove inactive
  // ones. Replaces the original static-list deployment.
  cron.schedule('0 23 * * *', async () => {
    try {
      const { evaluateBlocklist } = await import('../lib/dynamicBlocklist.js')
      const result = await evaluateBlocklist({ dryRun: false })
      console.log(`[dynamic-blocklist] daily eval: +${result.adds.length} added, -${result.removes.length} removed`)
    } catch (err) {
      console.error('[dynamic-blocklist] error:', err.message)
    }
  }, { timezone: 'America/New_York' })

  // ── EOD report (11:30 PM ET daily) ──────────────────────────────
  // After the last late-west-coast game completes, build the day's summary
  // and push to Discord. Reports paper + live separately so paper-test days
  // are clearly labeled. Posts even when DISCORD_ERRORS_ONLY=true if the
  // explicit DISCORD_DAILY_REPORT_ENABLED=true opt-in is set.
  cron.schedule('30 23 * * *', async () => {
    try {
      const today = etDate()
      const summary = await buildEodSummary(today)
      if (summary && (summary.live.fires > 0 || summary.paper.fires > 0)) {
        const cage = await import('../lib/cageAlerts.js')
        await cage.notifyEod({ date: today, summary })
      }
    } catch (err) {
      console.error('[eod-report] error:', err.message)
    }
  }, { timezone: 'America/New_York' })

  // ── Closing-line value writeback (11:45 PM ET daily) ─────────
  // For every fire today (and any earlier fires still missing closing data),
  // fetch the snapshot closest to game start from market_snapshots and write
  // closing_line_cents / clv_cents. CLV = "are we sharp?" metric, broken out
  // by strategy_mode in the next morning's EOD report.
  cron.schedule('45 23 * * *', () => {
    run('closing-line-writeback', 'node scripts/backtestCLV.mjs')
  }, { timezone: 'America/New_York' })

  // ── Outcome harvest (1:15 AM ET daily) ────────────────────────
  // Fetch actual K/IP/BF/etc from MLB Stats API for every pitcher_id seen in
  // market_snapshots that day. Closes the outcome gap for non-bet pitchers
  // (~20/day) so future backtests have ground truth across all candidates,
  // not just ones we actually wagered on.
  cron.schedule('15 1 * * *', () => {
    run('outcome-harvest', 'node scripts/harvestOutcomes.mjs')
  }, { timezone: 'America/New_York' })

  // ── Cross-strike candidate registry (1:30 AM ET daily) ────────
  // Logs every candidate the engine WOULD have evaluated (whether it fires
  // under current filters or not), with Poisson + NB fit metadata, prices,
  // ask, would_fire flag, filter reason, fired_actual cross-link, and
  // outcome (joined from pitcher_recent_starts after the harvest). Lets
  // future filter sweeps run as a single SQL query.
  cron.schedule('30 1 * * *', () => {
    const date = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10)
    run('cross-strike-shadow', `node scripts/logCrossStrikeShadow.mjs ${date}`)
  }, { timezone: 'America/New_York' })

  // ── Cross-Strike-Total candidate registry (1:35 AM ET daily) ────
  // Same pattern as cross-strike-shadow but for KXMLBTOTAL run-line ladders.
  // Logs every Cross-Strike candidate the math would surface on game-total
  // markets, with outcome backfilled from settled TOTAL expiration_value.
  cron.schedule('35 1 * * *', () => {
    const date = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10)
    run('cross-strike-total-shadow', `node scripts/logCrossStrikeTotalShadow.mjs ${date}`)
  }, { timezone: 'America/New_York' })

  // ── IDEAL fade model paper test (every 30 min, 11 AM – 11 PM ET) ───
  // Validated config from extended backtest: NB r=8 distribution from K9_l5,
  // strike ≥6, edge ≥5c, ask ≤50c, YES-only, per-pitcher cap=1, edge-weighted
  // sizing (1% base × 1-5×, $200 cap). Paper mode synthetic fills. One bet
  // per pitcher per day. Skips pitchers already fired.
  cron.schedule('*/30 11-23 * * *', () => {
    run('fade-fire', 'node scripts/fireFadeModel.mjs')
  }, { timezone: 'America/New_York' })

  // ── Fade test daily progress report (11:55 PM ET) ─────────────────
  cron.schedule('55 23 * * *', () => {
    run('fade-progress', 'node scripts/fadeTestProgress.mjs')
  }, { timezone: 'America/New_York' })

  // ── F5 Kalshi snapshot capture (every 10 min, 10 AM – 11 PM ET) ──
  // Paper-test data collection only. Polls Kalshi for all open + recently-closed
  // KXMLBF5TOTAL markets; writes to f5_market_snapshots. Goal: collect 14+ days
  // of forward Kalshi-specific price history to validate the wing-strike NO
  // edge identified in v1 backtest. NOT placing live bets — read-only.
  cron.schedule('*/10 10-23 * * *', () => {
    run('f5-snapshot-capture', 'node scripts/captureF5Snapshots.mjs')
  }, { timezone: 'America/New_York' })

  // ── Fade filter-sweep test (12:00 AM ET nightly) ──────────────────
  // Runs all open hypothesis filters (H-H, H-I, H-J, H-K, H-M, combined)
  // against cumulative fade fires + signal data. Posts comparison to
  // Discord. Tracks every refinement in real-time.
  cron.schedule('0 0 * * *', () => {
    run('fade-filter-sweep', 'node scripts/dailyFilterSweep.mjs')
  }, { timezone: 'America/New_York' })

  // ── Fade intelligence backfill (12:30 AM ET nightly) ──────────────
  // Joins pitcher_signals + pitcher_edge_cache into fade_paper_test_candidates
  // so the filter-sweep tests have current data each day.
  cron.schedule('30 0 * * *', () => {
    run('fade-intel-backfill', 'node scripts/backfillFadeIntelligence.mjs')
  }, { timezone: 'America/New_York' })

  // ── Daily news check for fade fires (multiple windows pre-game) ──
  // Hits ESPN/Google News/Rotowire RSS for each scheduled starter; classifies
  // headlines + Sonnet synthesis. Persists to pitcher_news_log. Fade fire
  // script reads this table to skip pitchers with action='skip'.
  // Windows: 9 AM (early-game prep), 12 PM, 3 PM, 6 PM ET (catches news drops).
  for (const hour of [9, 12, 15, 18]) {
    cron.schedule(`0 ${hour} * * *`, () => {
      run(`news-check-${hour}`, 'node scripts/runDailyNewsCheck.mjs')
    }, { timezone: 'America/New_York' })
  }

  // ── Hypothesis registry evaluation (12:15 AM ET nightly) ─────────
  // Scores every active hypothesis against in-sample (informational) and
  // out-of-sample (binding) fire data. Auto-flags promote/reject candidates.
  cron.schedule('15 0 * * *', () => {
    run('hypothesis-evaluate', 'node scripts/hypothesisRegistry.mjs evaluate')
  }, { timezone: 'America/New_York' })

  // ── Fade comprehensive shadow log (1:40 AM ET daily) ──────────────
  // Captures EVERY pitcher-day-strike under 6 model variants (Poisson l5,
  // NB r=8/10/12 l5, NB r=8 l10, Poisson career) with full feature pyramid.
  // Lets future model variants be tested as a single SQL query against
  // fade_paper_test_candidates.
  cron.schedule('40 1 * * *', () => {
    const date = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10)
    run('fade-shadow', `node scripts/logFadeShadow.mjs ${date}`)
  }, { timezone: 'America/New_York' })

  // ── Trace-match watchdog (Day 1 cage, May 3) ─────────────────
  // Every 60s: find pregame ks_bets rows with no matching oracle_bet_traces
  // row (after 10s grace for async write timing). If found, halt trading
  // immediately — uncategorized risk on a real Kalshi position is the worst
  // possible state (we can't track it, can't cap it, can't audit it).
  cron.schedule('* * * * *', async () => {
    try {
      const today = etDate()
      // Only check pregame strategies that should have a trace; live + topup
      // don't go through Oracle gate. Look for rows older than 10s with
      // order_id set (real placement) and no trace match.
      // Trace match required only for system-placed pregame bets that hit
      // REAL Kalshi (order_id is a real UUID, not a paper-mode synthetic id).
      // Excluded:
      //   - paper-prefix order_ids (synthetic fills from KALSHI_PAPER_MODE wrapper)
      //   - smoke_test / contra_test_legacy / reconciled_from_kalshi submodes
      //   - rows older than 30 min (an aged orphan isn't a fresh race condition)
      //   - rows with no order_id (never actually placed)
      const orphans = await dbAll(`
        SELECT b.id, b.user_id, b.pitcher_id, b.pitcher_name, b.strike, b.side,
               b.strategy_mode, b.strategy_submode, b.order_id, b.logged_at
        FROM ks_bets b
        WHERE b.bet_date = ?
          AND b.live_bet = 0
          AND b.order_id IS NOT NULL
          AND b.order_id NOT LIKE 'paper-%'
          AND b.strategy_mode IN ('pregame_normal','pregame_inversion')
          AND COALESCE(b.strategy_submode,'') NOT IN ('smoke_test','contra_test_legacy','reconciled_from_kalshi')
          AND datetime(b.logged_at) < datetime('now', '-10 seconds')
          AND datetime(b.logged_at) > datetime('now', '-30 minutes')
          AND NOT EXISTS (
            SELECT 1 FROM oracle_bet_traces t
            WHERE t.bet_date = b.bet_date
              AND t.pitcher_id = b.pitcher_id
              AND t.strike = b.strike
              AND t.side = b.side
              AND t.system LIKE '%user' || b.user_id
          )
      `, [today]).catch(() => [])

      if (orphans.length > 0) {
        const ids = orphans.map(o => `id=${o.id}/${o.pitcher_name} ${o.strike}+ ${o.side}`).join('; ')
        console.error(`[trace-watchdog] CRITICAL: ${orphans.length} ks_bets rows have no matching oracle_bet_traces — HALTING TRADING. Rows: ${ids}`)
        await dbRun(
          `INSERT OR REPLACE INTO system_flags (key, value, updated_by, updated_at)
           VALUES ('trading_halted', '1', 'trace-watchdog', ?)`,
          [new Date().toISOString()],
        ).catch(() => {})
        // Discord critical alert (cage layer)
        try {
          const cage = await import('../lib/cageAlerts.js')
          await cage.alertTraceOrphan({ rows: orphans })
        } catch {}
      }
    } catch (err) {
      // non-fatal: log but don't halt on watchdog error itself
      console.error('[trace-watchdog] error:', err.message)
    }
  }, { timezone: 'America/New_York' })

  // 3:30 PM ET — MLB lineup refresh; 90s later re-run portfolio plan with fresh prices
  cron.schedule('30 15 * * *', () => {
    mlbRun('MLB lineup refresh', '--lineups')
    logCronRun('lineup-refresh')
    setTimeout(() => {
      const d = etDate()
      run('Portfolio plan (post-lineup)', `node scripts/live/ksBets.js plan --date ${d}`)
      logCronRun('portfolio-plan-post-lineup')
      // 60s after plan finishes (plan takes ~30s) — run parlay builder with fresh model probs
      setTimeout(() => runParlayCheck(d), 90_000)
    }, 90_000)
  }, { timezone: 'America/New_York' })

  // 4:05 PM ET — second lineup pass for evening games whose lineups post after the 3:30 run.
  // Staggered to :05 (not :00) to avoid colliding with the 4pm mid-game settle batch.
  // The :00 settle spawns: syncFills + ksBets settle + syncSettlements + postGameAttribution.
  // The :00 lineup refresh spawns: fetchLineups + fetchKProps + strikeoutEdge + F5 pipeline.
  // Running all 8 subprocesses simultaneously on Railway causes a CPU spike that can OOM.
  cron.schedule('5 16 * * *', () => {
    mlbRun('MLB lineup refresh (4pm)', '--lineups')
    logCronRun('lineup-refresh-4pm')
    setTimeout(() => {
      const d = etDate()
      run('Portfolio plan (4pm post-lineup)', `node scripts/live/ksBets.js plan --date ${d}`)
      logCronRun('portfolio-plan-4pm')
      setTimeout(() => runParlayCheck(d), 90_000)
    }, 90_000)
  }, { timezone: 'America/New_York' })

  // Mid-game partial settles — resolve guaranteed YES wins as they happen
  // 4 PM, 6 PM, 8 PM, 10 PM ET
  for (const hour of [16, 18, 20, 22]) {
    cron.schedule(`0 ${hour} * * *`, () => {
      logCronRun(`settle-batch-${hour}`)
      mlbRun(`MLB mid-game settle (${hour}:00)`, '--settle')
    }, { timezone: 'America/New_York' })
  }

  // 3:00 AM ET — MLB settle + EOD + check tomorrow for early games.
  // Runs at 3am so west coast games are finished. Calendar day has rolled over —
  // settle uses yesterday's ET date. Then checks tomorrow's schedule (already fetched
  // via --days 2) and if any game starts before 10am ET, runs the full morning
  // pipeline for tomorrow right now so daily_plan exists well before first pitch.
  //
  // ORDERING GUARANTEE: dailyRun.sh --settle runs these steps in sequence:
  //   1. syncFills.js           — pull filled_contracts / order_status from Kalshi
  //   2. ksBets.js settle       — mark bets won/lost, write ks_bets.pnl
  //   3. syncSettlements.js     — rebuild daily_pnl_events from Kalshi API (ksSettlementSync)
  //   4. postGameAttribution.js — silent per-bet Statcast attribution, feeds calibration
  // Step 3 MUST come after step 2 so ksSettlementSync can reconcile ks_bets.pnl for
  // the per-bet allocation split. Step 4 reads daily_pnl_events for authoritative P&L
  // but produces no Discord output.
  cron.schedule('0 3 * * *', async () => {
    logCronRun('settle-eod')
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
    // Mark as skipped (not error) when decision_pipeline confirms clean no_edge outcome
    await dbRun(
      `UPDATE bet_schedule SET status='skipped',
        notes=COALESCE(notes,'') || ' [no-edge ' || datetime('now') || ']'
       WHERE status='fired' AND fired_at IS NOT NULL AND fired_at < ?
         AND NOT EXISTS (
           SELECT 1 FROM ks_bets k
           WHERE k.bet_date = bet_schedule.bet_date AND k.pitcher_id = bet_schedule.pitcher_id
             AND k.live_bet = 0 AND k.paper = 0
         )
         AND EXISTS (
           SELECT 1 FROM decision_pipeline dp
           WHERE dp.bet_date = bet_schedule.bet_date
             AND dp.pitcher_id = CAST(bet_schedule.pitcher_id AS TEXT)
             AND dp.final_action IN ('no_edge','no_markets','preflight_skip','filtered_out')
         )`,
      [ago],
    ).catch(() => {})
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

  // Every Monday 3:00 AM ET — weekly self-calibration engine (after all Sunday games settle)
  cron.schedule('0 3 * * 1', async () => {
    try {
      const { runCalibration } = await import('../lib/calibrationEngine.js')
      await runCalibration({ trigger: 'cron' })
    } catch (err) {
      console.error('[cron] calibration engine failed:', err.message)
      try {
        const { saveLog } = await import('../lib/liveLog.js')
        await saveLog({ tag: 'ERROR', level: 'error', msg: `calibration engine failed: ${err.message?.slice(0, 300)}` })
        const webhooks = await getAllWebhooks({ all: dbAll }).catch(() => [])
        await notifyAlert({ title: '⚠️ Calibration Engine Failed', description: err.message?.slice(0, 1000) ?? 'unknown error' }, webhooks)
      } catch { /* notification failure — already logged above */ }
    }
  }, { timezone: 'America/New_York' })

  // Every 30 min during settlement window — backfill snapshot outcomes from ks_bets
  cron.schedule('*/30 20-23 * * *', async () => {
    try {
      const { backfillOutcome } = await import('../lib/marketSnapshotWriter.js')
      const rows = await dbAll(
        `SELECT DISTINCT pitcher_id, bet_date AS game_date, actual_ks
         FROM ks_bets WHERE actual_ks IS NOT NULL AND bet_date >= date('now','-2 days')`,
      ).catch(() => [])
      for (const r of rows) {
        if (r.pitcher_id && r.actual_ks != null) {
          await backfillOutcome({ pitcherId: r.pitcher_id, gameDate: r.game_date, actualKs: r.actual_ks }).catch(() => {})
        }
      }
    } catch (err) {
      console.error('[cron] snapshot backfill failed:', err.message)
    }
  }, { timezone: 'America/New_York' })

  // Every Monday 8:00 AM ET — NB model calibration check (alerts on drift > 7%)
  cron.schedule('0 8 * * 1', () => {
    run('NB calibration check', 'node scripts/live/calibrateNB.js --days 90 --min-bets 10')
  }, { timezone: 'America/New_York' })

  // ── Dead-man's switch: alert if THE CLOSER stops heartbeating during game hours ──
  // Runs every 30 min from 3:30pm–1:30am ET. If the live monitor hasn't written a
  // heartbeat in 90+ minutes, something crashed and didn't recover. Fires once per
  // outage (latch resets when the heartbeat comes back).
  let _closerDownAlerted = false
  async function checkCloserHeartbeat() {
    try {
      const row = await dbOne(
        `SELECT updated_at FROM agent_heartbeat WHERE key = 'closer'`,
      ).catch(() => null)
      const ts    = row?.updated_at
      const stale = !ts || (Date.now() - new Date(ts.endsWith('Z') ? ts : ts + 'Z').getTime()) > 90 * 60 * 1000
      if (stale && !_closerDownAlerted) {
        _closerDownAlerted = true
        const ago = ts ? Math.round((Date.now() - new Date(ts.endsWith('Z') ? ts : ts + 'Z').getTime()) / 60000) + 'm ago' : 'never'
        const webhooks = await getAllWebhooks({ all: dbAll }).catch(() => [])
        await notifyAlert({
          title:       `⚠️ THE CLOSER — offline during game hours`,
          description: `Last heartbeat: **${ago}**\nThe live monitor isn't running. No in-game bets will fire until it restarts.\nCheck the Windows process or Railway logs.`,
          color:       0xff4444,
        }, webhooks)
      } else if (!stale && _closerDownAlerted) {
        _closerDownAlerted = false  // back online — reset latch silently
      }
    } catch (err) {
      console.error('[closer-watch] check failed:', err.message)
    }
  }
  // 3:30pm–1:30am ET every 30 min — covers the full game window
  cron.schedule('*/30 15-23,0,1 * * *', () => checkCloserHeartbeat(), { timezone: 'America/New_York' })

  // Every 5 min, 11am–11pm ET — capture closing lines for pre-game bets (Item 1: CLV).
  // Starts at 11am (was 2pm) so that 1pm ET games are captured at the ≥25min mark (1:25pm).
  // The function no-ops when no games have started ≥25min ago, so early ticks are cheap.
  cron.schedule('*/5 11-23 * * *', () => {
    captureClosingLines().catch(err => console.error('[clv-capture] error:', err.message))
  }, { timezone: 'America/New_York' })

  // Every 30 min, 9am–5pm ET — sync Kalshi fill status into ks_bets.
  // Maker orders can fill at any time after placement. Without this, order_status stays
  // 'resting' all day, causing two bugs:
  //   1. checkSouredOrders tries to cancel already-filled orders → Kalshi API errors on every
  //      10-min rescan, and partial fills get cancelled incorrectly.
  //   2. captureClosingLines queries filled_contracts > 0 — finds nothing until 3am settle,
  //      so CLV is never captured for morning bets.
  // Stopping at 5pm avoids overlapping with the settle batch; settle runs its own syncFills.
  cron.schedule('*/30 9-17 * * *', () => {
    run('Fill sync', `node scripts/live/syncFills.js --date ${etDate()}`)
  }, { timezone: 'America/New_York' })

  // Every 30 min — recompute drawdown scale from 7-day rolling P&L (Item 6).
  cron.schedule('*/30 * * * *', () => {
    recomputeDrawdownScale().catch(err => console.error('[drawdown] error:', err.message))
  }, { timezone: 'America/New_York' })
  // Run once on startup too
  recomputeDrawdownScale().catch(() => {})

  // Every minute — health sentinel: heartbeat staleness, missed phase milestones,
  // pulse sub-component cadence checks. Sends Discord alerts when anything is off.
  cron.schedule('* * * * *', () => {
    runHealthSentinel().catch(err => console.error('[healthSentinel] error:', err.message))
  }, { timezone: 'America/New_York' })

  // ── Layer 6 Gateway: exchange_unknown reconciliation (every 15s) ────────────
  // Per spec §6 + locked Q-RC8: fixed 15s cron, internal per-row cadence
  // throttles (15s ≤5min old, 60s thereafter). One-at-a-time via the
  // reconciler's _running flag — this catch is just a belt-and-suspenders
  // wrapper so a thrown exception can't kill the cron loop.
  if (gateway) {
    let _reconcilerRunning = false
    cron.schedule('*/15 * * * * *', async () => {
      if (_reconcilerRunning) return
      _reconcilerRunning = true
      try {
        await runReconciliation({
          kalshi:        gateway.deps.kalshi,
          dataPlane:     gateway.deps.dataPlane,
          traceAdapter:  gateway.deps.traceAdapter,
          mode:          gateway.mode,
        })
      } catch (err) {
        console.error('[gateway-reconciler] cycle failed:', err?.message ?? err)
        // Best-effort: emit a critical Trace event so we notice
        try {
          const sysT = gateway.deps.traceAdapter.forSystem({ agent_id: 'gateway-reconciler', mode: 'production' })
          gateway.deps.trace.writeAsync(sysT.makeEvent({
            decision_id:  `gateway-reconciler-error-${Date.now()}`,
            event_type:   'gateway_reconciler_cycle_failed',
            decision:     'critical',
            reason_code:  'GATEWAY_RECONCILER_ERROR',
            reasoning:    { message: err?.message ?? String(err) },
            metrics:      {},
            pitcher_id:   '0', pitcher_name: 'reconciler',
            bet_date:     '', strike: 0, side: 'YES',
          })).catch(() => {})
        } catch { /* best-effort */ }
      } finally {
        _reconcilerRunning = false
      }
    })
    console.log(`[gateway-reconciler] cron scheduled — every 15s (mode=${gateway.mode})`)

    // ── Layer 6 Gateway: account-state seeder (every 60s) ─────────────────
    // V1 hack — recomputes gateway_account_daily_state from ks_bets so the
    // validator's daily-loss / daily-risk / submitted_order checks have fresh
    // data without waiting for V2's settlement-driven updater.
    cron.schedule('* * * * *', async () => {
      try {
        const r = await refreshGatewayAccountDailyState()
        if (r.note) console.log(`[gw-account-state] ${r.note}`)
      } catch (err) {
        console.error('[gw-account-state] cycle failed:', err?.message ?? err)
      }
    })
    console.log('[gw-account-state] cron scheduled — every 60s')

    // ── Layer 6 Gateway: daily backtest cron (6am ET) ─────────────────────
    // Replays yesterday's pre-game bets through the locked V1 config; posts
    // Discord summary only on material change.
    cron.schedule('0 6 * * *', async () => {
      try {
        const r = await runDailyBacktestCron()
        console.log(`[daily-backtest] ${r.date}: ${r.today.accepted} accepted / ${r.today.rejected} rejected / material=${r.change.material}`)
      } catch (err) {
        console.error('[daily-backtest] cycle failed:', err?.message ?? err)
      }
    }, { timezone: 'America/New_York' })
    console.log('[daily-backtest] cron scheduled — 6am ET')
  } else {
    console.warn('[gateway-reconciler] not scheduled — no gateway passed to startScheduler')
  }

  // Daily 8:00am ET — start liveMonitor. Belt-and-suspenders: the startup gate at
  // scheduler boot only fires when the service restarts (deploys, crashes), so
  // a long-stable Railway service would never restart liveMonitor on its own.
  // This cron guarantees a clean daily start. startLiveMonitor() has internal
  // dedup so this is idempotent if liveMonitor is already running.
  cron.schedule('0 8 * * *', () => {
    console.log('[scheduler] 8am cron: ensuring live monitor running')
    startLiveMonitor(etDate())
  }, { timezone: 'America/New_York' })

  // Every 15 min during 8am–2am ET — safety check: if liveMonitor isn't running,
  // start it. Catches crashes, OOMs, and the case where the daily 8am cron fired
  // but the spawn failed silently. Idempotent via internal dedup.
  // Apr 30: skip restart when drawdown_halted=<TODAY> — the monitor exited on
  // purpose for daily-loss / drawdown halt; restarting would just re-trip it.
  cron.schedule('*/15 8-23 * * *', async () => {
    if (!_liveMonitorChild || _liveMonitorChild.exitCode !== null) {
      const haltedRow = await dbOne(`SELECT value FROM system_flags WHERE key='drawdown_halted'`).catch(() => null)
      if (haltedRow?.value === etDate()) {
        console.log('[scheduler] 15min safety check: live monitor halted today (drawdown) — skipping restart')
        return
      }
      console.log('[scheduler] 15min safety check: live monitor not running — restarting')
      startLiveMonitor(etDate())
    }
  }, { timezone: 'America/New_York' })

  console.log('[scheduler] daily jobs (ET): 3:00am settle+early-game check | 7:00am schedule+Savant | 8:30am full pipeline (skipped if early-game pre-run) | */5min 3am-8pm lineup+bets | 3:30pm lineup refresh | 4/6/8/10pm partial settle | health sentinel every 60s')
}
