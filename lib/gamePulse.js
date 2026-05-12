// lib/gamePulse.js — Layer 1: Slate awareness + live game state tracker.
//
// Permanent server-resident loop (not a cron). Boots with the server at 3am,
// runs until all west-coast games finish (~3am next day). Maintains game_pulse
// table as the single source of truth for every game's state:
//
//   phase: pre_lineup → pre_game → live → final | postponed
//   Lineup confirmation (both sides), pitcher confirmed, pull events, pitch counts.
//   Scratch watch: T-60 check — if MLB API shows different pitcher → scratch_alert=1.
//   Line direction: DK K prop snapshots at T-180, T-90, T-30.
//
// Feeding intelligence: game_pulse events emit to EventEmitter → scheduler
//   fires Layer 2 (strikeoutEdge rescan) on lineup posted or scratch.
// Feeding Kelly: game_pulse.home/away_lineup_posted tells ksBets lineup is ready.
//
// External deps: mlb-live.js (live game state), kalshi.js (market fetch for lines),
//   db.js (game_pulse writes). No AI calls — zero cost.
//
// Usage: import and call startPulseLoop(date) in server/scheduler.js

import * as db from './db.js'
import { mlbGet, mlbFeedLive } from './mlb-live.js'
import { EventEmitter } from 'node:events'
import { alertError } from './errorSentinel.js'

export const pulseEvents = new EventEmitter()
pulseEvents.setMaxListeners(50)

// Event names emitted:
//   'lineup_posted'  { gamePk, side, date }      — when lineup confirmed for home or away
//   'scratch_alert'  { gamePk, pitcherId, date }  — when expected pitcher not in lineup at T-60
//   'phase_change'   { gamePk, from, to, date }   — phase transitions
//   'pull_detected'  { gamePk, side, confirmed, date }
//   'game_final'     { gamePk, date }              — triggers immediate settle

const MLB_BASE = 'https://statsapi.mlb.com/api/v1'

// ET date string
function etDate(d = new Date()) {
  return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
}

// ET now
function etNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }))
}

// Minutes until game time from now
function minutesUntilGame(gameTimeIso) {
  try {
    const t = new Date(gameTimeIso)
    return (t - Date.now()) / 60000
  } catch { return null }
}

// ET-aware ms timestamp for a (bet_date, "HH:MM" ET) pair.
// Apr 28 fix — replaces `new Date(now).setHours(h,m,0,0)` which used the runtime
// timezone (UTC on Railway), causing all phase windows to fire 4h off in EDT.
// MLB regular season is always EDT (UTC-4); EST (UTC-5) covers offseason play-in
// edge cases. DST transitions never fall inside the season window.
function gameTimeMsET(betDate, gameTimeEt) {
  if (!betDate || !gameTimeEt) return null
  const [h, m] = String(gameTimeEt).split(':').map(Number)
  if (Number.isNaN(h) || Number.isNaN(m)) return null
  const month = parseInt(betDate.slice(5, 7), 10)  // 1–12
  const offset = (month >= 3 && month <= 10) ? '-04:00' : '-05:00'  // EDT in-season, EST shoulder
  const iso = `${betDate}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00${offset}`
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : null
}

// ── MLB schedule fetch ────────────────────────────────────────────────────────

async function fetchTodaySchedule(date) {
  try {
    const data = await mlbGet(`${MLB_BASE}/schedule`, {
      params: { sportId: 1, date, hydrate: 'probablePitcher,linescore,team' },
    })
    return data?.dates?.[0]?.games ?? []
  } catch (err) {
    console.error(`[gamePulse] schedule fetch error: ${err.message}`)
    return []
  }
}

// ── DK K prop line fetch (for line direction tracking) ───────────────────────

async function fetchDkLine(pitcherId, _ignoredArg, date) {
  // Read from dk_k_props (populated by fetchKProps.js).
  // Apr 28 — bug fix: this used to receive teamAbbr (e.g. "CLE") as second arg from
  // updateLineDirections call site, then ran `LIKE '%CLE%'` against pitcher_name → no
  // match → currentLine null → snapshot skipped for every game. Now resolves the
  // pitcher name from bet_schedule (or pitcher_statcast as fallback) by pitcher_id.
  try {
    let pitcherName = null
    const bs = await db.one(
      `SELECT pitcher_name FROM bet_schedule WHERE bet_date = ? AND pitcher_id = ? LIMIT 1`,
      [date, String(pitcherId)],
    ).catch(() => null)
    if (bs?.pitcher_name) pitcherName = bs.pitcher_name
    if (!pitcherName) {
      const ps = await db.one(
        `SELECT player_name FROM pitcher_statcast WHERE player_id = ? ORDER BY id DESC LIMIT 1`,
        [String(pitcherId)],
      ).catch(() => null)
      if (ps?.player_name) pitcherName = ps.player_name
    }
    if (!pitcherName) return null
    const lastName = pitcherName.split(' ').slice(-1)[0]
    if (!lastName) return null
    const row = await db.one(
      `SELECT dk_line FROM dk_k_props WHERE prop_date = ? AND pitcher_name LIKE ? LIMIT 1`,
      [date, `%${lastName}%`],
    )
    return row?.dk_line ?? null
  } catch { return null }
}

// ── Live game state fetch ─────────────────────────────────────────────────────

async function fetchLiveState(gamePk) {
  try {
    const data = await mlbFeedLive(gamePk, 'linescore,decisions,plays')
    const ls   = data?.gameData?.status
    const live = data?.liveData?.linescore
    const plays = data?.liveData?.plays?.currentPlay
    const teams  = data?.liveData?.linescore?.teams

    if (!live) return null

    const status = ls?.abstractGameState ?? 'Preview'
    let phase
    if (status === 'Final')       phase = 'final'
    else if (status === 'Live')   phase = 'live'
    else if (status === 'Preview') phase = minutesUntilGame(data?.gameData?.datetime?.dateTime) < 180 ? 'pre_game' : 'pre_lineup'
    else if (/postponed/i.test(ls?.detailedState ?? '')) phase = 'postponed'
    else phase = 'pre_lineup'

    const inning = live.currentInning ?? null
    const half   = live.inningHalf?.toLowerCase() === 'top' ? 'top' : 'bottom'
    const outs   = live.outs ?? 0

    // Pitch counts from current play or totals — MLB API has pitchIndex on current play
    const homePitches = data?.liveData?.boxscore?.teams?.home?.pitchers?.reduce((s, pid) => {
      const p = data?.liveData?.boxscore?.teams?.home?.players?.[`ID${pid}`]
      return s + (p?.stats?.pitching?.numberOfPitches ?? 0)
    }, 0) ?? 0
    const awayPitches = data?.liveData?.boxscore?.teams?.away?.pitchers?.reduce((s, pid) => {
      const p = data?.liveData?.boxscore?.teams?.away?.players?.[`ID${pid}`]
      return s + (p?.stats?.pitching?.numberOfPitches ?? 0)
    }, 0) ?? 0

    // BF from boxscore
    const homeBF = data?.liveData?.boxscore?.teams?.home?.pitchers?.reduce((s, pid) => {
      const p = data?.liveData?.boxscore?.teams?.home?.players?.[`ID${pid}`]
      return s + (p?.stats?.pitching?.battersFaced ?? 0)
    }, 0) ?? 0
    const awayBF = data?.liveData?.boxscore?.teams?.away?.pitchers?.reduce((s, pid) => {
      const p = data?.liveData?.boxscore?.teams?.away?.players?.[`ID${pid}`]
      return s + (p?.stats?.pitching?.battersFaced ?? 0)
    }, 0) ?? 0

    return {
      phase,
      inning,
      half,
      outs,
      home_score: teams?.home?.runs ?? 0,
      away_score: teams?.away?.runs ?? 0,
      home_pitch_count: homePitches,
      away_pitch_count: awayPitches,
      home_bf: homeBF,
      away_bf: awayBF,
    }
  } catch (err) {
    console.error(`[gamePulse] live fetch ${gamePk}: ${err.message}`)
    return null
  }
}

// ── Pitcher pull detection ────────────────────────────────────────────────────

async function checkPullStatus(gamePk, side, expectedPitcherId) {
  // Returns { pulled, confirmed }
  // confirmed = true when a different pitcher is actively ON THE MOUND (not just a bullpen warm)
  try {
    const data = await mlbFeedLive(gamePk, 'boxscore,linescore')
    const box   = data?.liveData?.boxscore?.teams?.[side]
    if (!box) return { pulled: false, confirmed: false }

    const currentPitchers = box.pitchers ?? []
    if (!currentPitchers.length) return { pulled: false, confirmed: false }

    const currentActive = String(currentPitchers[currentPitchers.length - 1])
    const expectedStr   = String(expectedPitcherId)

    if (currentActive === expectedStr) return { pulled: false, confirmed: false }
    if (currentPitchers.includes(Number(expectedStr))) {
      // Starter appeared earlier but reliever is now active → confirmed pull
      return { pulled: true, confirmed: true }
    }
    return { pulled: true, confirmed: false }
  } catch { return { pulled: false, confirmed: false } }
}

// ── Scratch watch ─────────────────────────────────────────────────────────────
// At T-60 min before first pitch, check MLB API probable pitcher.
// If it differs from what we have stored, fire scratch_alert.

async function checkScratch(row) {
  const { game_pk, bet_date, home_pitcher_id, away_pitcher_id } = row
  try {
    const data = await mlbGet(`${MLB_BASE}/schedule`, {
      params: { sportId: 1, gamePk: game_pk, hydrate: 'probablePitcher' },
    })
    const game = data?.dates?.[0]?.games?.[0]
    if (!game) return

    for (const [side, storedId] of [['home', home_pitcher_id], ['away', away_pitcher_id]]) {
      if (!storedId) continue
      const probableId = String(game.teams?.[side]?.probablePitcher?.id ?? '')
      if (probableId && probableId !== String(storedId)) {
        console.log(`[gamePulse] SCRATCH ALERT ${game_pk} ${side}: expected ${storedId}, MLB API shows ${probableId}`)
        await db.run(
          `UPDATE game_pulse SET scratch_alert=1, scratch_pitcher_id=?, last_updated=?
           WHERE game_pk=? AND bet_date=?`,
          [storedId, Date.now(), game_pk, bet_date],
        )
        pulseEvents.emit('scratch_alert', { gamePk: game_pk, pitcherId: storedId, side, date: bet_date })
      }
    }
  } catch (err) {
    console.error(`[gamePulse] scratch check ${game_pk}: ${err.message}`)
  }
}

// ── Init: seed game_pulse from today's schedule ───────────────────────────────

export async function initGamePulse(date) {
  const games = await fetchTodaySchedule(date)
  if (!games.length) {
    console.log(`[gamePulse] No games found for ${date}`)
    return
  }

  const now = etNow()
  let inserted = 0, early = 0

  for (const g of games) {
    const gamePk   = String(g.gamePk)
    const gameTime = g.gameDate ?? g.gameTime
    const minUntil = minutesUntilGame(gameTime)
    // "Early" = game starts before noon ET (catches 10am/1pm games, not evening games)
    // Must use real ET conversion — late-night games cross midnight UTC and would
    // look "early" if compared only on UTC hour.
    const isEarly = (() => {
      if (!gameTime) return false
      const etStr = new Date(gameTime).toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false })
      const etHour = parseInt(etStr, 10)
      return !isNaN(etHour) && etHour < 12
    })()

    if (isEarly) {
      early++
      console.log(`[gamePulse] EARLY GAME: ${g.teams?.away?.team?.abbreviation}@${g.teams?.home?.team?.abbreviation} ${gameTime}`)
    }

    // Convert game_time to ET HH:MM
    let gameTimeEt = null
    try {
      const gt = new Date(gameTime)
      gameTimeEt = gt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York', hour12: false })
    } catch {}

    const existing = await db.one(
      `SELECT game_pk FROM game_pulse WHERE game_pk=? AND bet_date=?`,
      [gamePk, date],
    ).catch(() => null)

    if (!existing) {
      await db.run(
        `INSERT OR IGNORE INTO game_pulse
          (game_pk, bet_date, home_team, away_team, home_pitcher_id, away_pitcher_id,
           game_time_et, phase, early_game, last_updated)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [
          gamePk, date,
          g.teams?.home?.team?.abbreviation ?? null,
          g.teams?.away?.team?.abbreviation ?? null,
          String(g.teams?.home?.probablePitcher?.id ?? '') || null,
          String(g.teams?.away?.probablePitcher?.id ?? '') || null,
          gameTimeEt,
          'pre_lineup',
          isEarly ? 1 : 0,
          Date.now(),
        ],
      ).catch(() => {})
      inserted++
    } else {
      // Update probable pitchers and team names if missing (e.g., rows seeded before team hydration)
      const homePid  = String(g.teams?.home?.probablePitcher?.id ?? '') || null
      const awayPid  = String(g.teams?.away?.probablePitcher?.id ?? '') || null
      const homeAbbr = g.teams?.home?.team?.abbreviation ?? null
      const awayAbbr = g.teams?.away?.team?.abbreviation ?? null
      await db.run(
        `UPDATE game_pulse
         SET home_pitcher_id = COALESCE(home_pitcher_id, ?),
             away_pitcher_id = COALESCE(away_pitcher_id, ?),
             home_team       = COALESCE(home_team, ?),
             away_team       = COALESCE(away_team, ?),
             last_updated    = ?
         WHERE game_pk=? AND bet_date=?`,
        [homePid, awayPid, homeAbbr, awayAbbr, Date.now(), gamePk, date],
      ).catch(() => {})
    }
  }

  console.log(`[gamePulse] Initialized ${inserted} new game_pulse rows for ${date} (${early} early games)`)
}

// ── Main update loop: refresh all active games ────────────────────────────────

export async function updateGamePulse(date) {
  const rows = await db.all(
    `SELECT * FROM game_pulse WHERE bet_date=? AND phase NOT IN ('final','postponed')`,
    [date],
  ).catch(() => [])

  for (const row of rows) {
    const gameMs = gameTimeMsET(row.bet_date, row.game_time_et)
    const minUntil = gameMs != null ? (gameMs - Date.now()) / 60000 : 0

    // ── Scratch watch: T-30 to T-90 window ─────────────────────────────────
    // Widened from T-50/T-70 (20-min window) to T-30/T-90 (60-min window)
    // so a 60s loop firing slightly off-schedule never misses a scratch.
    if (minUntil > 30 && minUntil < 90 && !row.scratch_alert) {
      await checkScratch(row)
    }

    // ── T-30 weather update ─────────────────────────────────────────────────
    // (already handled by weather.js in scheduler; just flag in pulse notes)

    // ── Phase transition checks ─────────────────────────────────────────────
    if (row.phase === 'pre_lineup' || row.phase === 'pre_game') {
      // Check if lineups are now in game_lineups table
      const lineupRow = await db.one(
        `SELECT COUNT(DISTINCT team_abbr) as teams FROM game_lineups
         WHERE game_id=? AND fetch_date >= date('now','-1 day','localtime')`,
        [row.game_pk],
      ).catch(() => null)
      const homePosted = lineupRow?.teams >= 1
      const bothPosted = lineupRow?.teams >= 2

      // Check if lineup_posted changed.
      // Apr 28 — bug fix: condition was `bothPosted && !row.home_lineup_posted` which
      // failed when `home_lineup_posted` got set to 1 elsewhere without phase being
      // updated, leaving phase stuck at 'pre_lineup' forever. Now keyed on phase
      // directly so any pre_lineup row with both lineups posted gets transitioned.
      if (bothPosted && row.phase === 'pre_lineup') {
        await db.run(
          `UPDATE game_pulse SET home_lineup_posted=1, away_lineup_posted=1, phase='pre_game', last_updated=?
           WHERE game_pk=? AND bet_date=?`,
          [Date.now(), row.game_pk, date],
        )
        pulseEvents.emit('lineup_posted', { gamePk: row.game_pk, side: 'both', date })
        console.log(`[gamePulse] Lineups posted: ${row.away_team}@${row.home_team}`)
      }
    }

    // ── Live game refresh ───────────────────────────────────────────────────
    if (row.phase === 'live' || (row.phase === 'pre_game' && minUntil < 10)) {
      const live = await fetchLiveState(row.game_pk)
      if (!live) continue

      const prevPhase = row.phase
      const changes = {
        phase: live.phase,
        inning: live.inning,
        half: live.half,
        outs: live.outs,
        home_score: live.home_score,
        away_score: live.away_score,
        home_pitch_count: live.home_pitch_count,
        away_pitch_count: live.away_pitch_count,
        home_bf: live.home_bf,
        away_bf: live.away_bf,
        last_updated: Date.now(),
      }

      await db.run(
        `UPDATE game_pulse SET phase=?, inning=?, half=?, outs=?, home_score=?, away_score=?,
          home_pitch_count=?, away_pitch_count=?, home_bf=?, away_bf=?, last_updated=?
         WHERE game_pk=? AND bet_date=?`,
        [live.phase, live.inning, live.half, live.outs, live.home_score, live.away_score,
         live.home_pitch_count, live.away_pitch_count, live.home_bf, live.away_bf, Date.now(),
         row.game_pk, date],
      ).catch(() => {})

      // Phase change events
      if (prevPhase !== live.phase) {
        pulseEvents.emit('phase_change', { gamePk: row.game_pk, from: prevPhase, to: live.phase, date })
        if (live.phase === 'final') {
          console.log(`[gamePulse] GAME FINAL: ${row.away_team}@${row.home_team}`)
          pulseEvents.emit('game_final', { gamePk: row.game_pk, date })
        }
        if (live.phase === 'postponed') {
          console.log(`[gamePulse] POSTPONED: ${row.away_team}@${row.home_team}`)
        }
      }

      // Pull detection for live games
      if (!row.home_pitcher_pulled && row.home_pitcher_id) {
        const pull = await checkPullStatus(row.game_pk, 'home', row.home_pitcher_id)
        if (pull.pulled) {
          await db.run(
            `UPDATE game_pulse SET home_pitcher_pulled=1, pull_confirmed_home=?, last_updated=?
             WHERE game_pk=? AND bet_date=?`,
            [pull.confirmed ? 1 : 0, Date.now(), row.game_pk, date],
          ).catch(() => {})
          pulseEvents.emit('pull_detected', { gamePk: row.game_pk, side: 'home', confirmed: pull.confirmed, date })
          console.log(`[gamePulse] PULL DETECTED home ${row.home_team} (confirmed=${pull.confirmed})`)
        }
      }
      if (!row.away_pitcher_pulled && row.away_pitcher_id) {
        const pull = await checkPullStatus(row.game_pk, 'away', row.away_pitcher_id)
        if (pull.pulled) {
          await db.run(
            `UPDATE game_pulse SET away_pitcher_pulled=1, pull_confirmed_away=?, last_updated=?
             WHERE game_pk=? AND bet_date=?`,
            [pull.confirmed ? 1 : 0, Date.now(), row.game_pk, date],
          ).catch(() => {})
          pulseEvents.emit('pull_detected', { gamePk: row.game_pk, side: 'away', confirmed: pull.confirmed, date })
          console.log(`[gamePulse] PULL DETECTED away ${row.away_team} (confirmed=${pull.confirmed})`)
        }
      }
    }
  }
}

// ── DK line direction tracking ────────────────────────────────────────────────
// Snapshots DK K prop at T-180, T-90, T-30 from first pitch.
// direction = sign(current - T_180): +1 rising (bullish), -1 falling (bearish).

export async function updateLineDirections(date) {
  const rows = await db.all(
    `SELECT game_pk, bet_date, home_team, away_team,
            home_pitcher_id, away_pitcher_id, game_time_et,
            dk_home_ks_line, dk_away_ks_line,
            dk_home_line_t180, dk_home_line_t90,
            dk_away_line_t180, dk_away_line_t90,
            dk_home_direction, dk_away_direction
     FROM game_pulse WHERE bet_date=? AND phase IN ('pre_lineup','pre_game')`,
    [date],
  ).catch(() => [])

  for (const row of rows) {
    const gameMs   = gameTimeMsET(row.bet_date, row.game_time_et)
    const minUntil = gameMs != null ? (gameMs - Date.now()) / 60000 : 9999

    for (const [side, pidField, lineField, t180Field, t90Field, dirField] of [
      ['home', 'home_pitcher_id', 'dk_home_ks_line', 'dk_home_line_t180', 'dk_home_line_t90', 'dk_home_direction'],
      ['away', 'away_pitcher_id', 'dk_away_ks_line', 'dk_away_line_t180', 'dk_away_line_t90', 'dk_away_direction'],
    ]) {
      const pitcherId = row[pidField]
      if (!pitcherId) continue

      // Fetch team name for this side
      const teamAbbr = side === 'home' ? row.home_team : row.away_team
      const currentLine = await fetchDkLine(pitcherId, teamAbbr, date)

      const updates = {}
      if (currentLine != null) updates[lineField] = currentLine

      // Snapshot at T-180. Apr 30: when DK has no line for this pitcher
      // (currentLine null) and we're more than 5 min past T-180, write sentinel
      // 0 to mark "snapshot attempted, DK had no line." This prevents the
      // healthSentinel milestone alert from firing for legitimate "DK didn't
      // post a line for this pitcher" cases while still alerting on true
      // fetcher failures (column stays NULL → alert fires).
      if (minUntil <= 180 && minUntil > -30 && row[t180Field] == null) {
        if (currentLine != null) updates[t180Field] = currentLine
        else if (minUntil < 175)  updates[t180Field] = 0
      }
      // Snapshot at T-90 — same logic
      if (minUntil <= 90 && minUntil > -30 && row[t90Field] == null) {
        if (currentLine != null) updates[t90Field] = currentLine
        else if (minUntil < 85)   updates[t90Field] = 0
      }

      // Direction: compare current vs T-180 baseline. Skip when baseline is
      // sentinel 0 (DK had no line at T-180) — no real baseline to compare.
      if (currentLine != null && row[t180Field] != null && row[t180Field] > 0) {
        const dir = currentLine > row[t180Field] ? 1 : currentLine < row[t180Field] ? -1 : 0
        updates[dirField] = dir

        // Sharp move detection: delta ≥ 0.5 K vs T-180 baseline
        // Emit event so scheduler can trigger immediate edge rescan
        const prevDir   = row[dirField]
        const prevLine  = row[lineField] ?? row[t180Field]
        const delta     = currentLine - row[t180Field]
        const absDelta  = Math.abs(delta)
        if (absDelta >= 0.5 && dir !== prevDir) {
          console.log(`[gamePulse] SHARP LINE MOVE ${row.game_pk} ${side}: ${prevLine}→${currentLine} (Δ${delta > 0 ? '+' : ''}${delta.toFixed(1)})`)
          pulseEvents.emit('sharp_line_move', {
            gamePk:    row.game_pk,
            side,
            pitcherId: row[pidField],
            from:      row[t180Field],
            to:        currentLine,
            delta,
            date,
          })
        }
      }

      if (Object.keys(updates).length === 0) continue
      updates.last_updated = Date.now()

      const setClauses = Object.keys(updates).map(k => `${k}=?`).join(', ')
      const vals = [...Object.values(updates), row.game_pk, date]
      await db.run(
        `UPDATE game_pulse SET ${setClauses} WHERE game_pk=? AND bet_date=?`,
        vals,
      ).catch(() => {})
    }
  }
}

// ── Get all active pulse rows for today ───────────────────────────────────────

export async function getActivePulse(date) {
  return db.all(
    `SELECT * FROM game_pulse WHERE bet_date=? ORDER BY game_time_et ASC`,
    [date],
  ).catch(() => [])
}

// ── Get pulse for a specific game ─────────────────────────────────────────────

export async function getGamePulseRow(gamePk, date) {
  return db.one(
    `SELECT * FROM game_pulse WHERE game_pk=? AND bet_date=?`,
    [String(gamePk), date],
  ).catch(() => null)
}

// ── Compute adaptive poll delay for liveMonitor ───────────────────────────────
// Returns ms to wait before next check for this pitcher based on BF distance
// to nearest unmet threshold.

export function adaptivePollDelayMs(currentBF, thresholds = []) {
  if (!thresholds.length) return 60_000

  // Thresholds at or above currentBF (includes exact hits so minDist can be 0)
  const remaining = thresholds.filter(t => t >= currentBF)
  if (!remaining.length) return 60_000  // all hit — check less often

  const minDist = Math.min(...remaining.map(t => t - currentBF))

  if (minDist === 0) return 0           // exactly at threshold — fire immediately
  if (minDist <= 3)  return 10_000      // 10s — very close
  if (minDist <= 5)  return 15_000      // 15s
  if (minDist <= 10) return 30_000      // 30s
  return 60_000                          // 60s default
}

// ── Permanent pulse loop ──────────────────────────────────────────────────────

let _pulseRunning = false

export async function startPulseLoop(date) {
  if (_pulseRunning) {
    console.log('[gamePulse] loop already running')
    return
  }
  _pulseRunning = true
  console.log(`[gamePulse] Starting permanent loop for ${date}`)

  await initGamePulse(date)

  let tick = 0
  const loop = async () => {
    while (_pulseRunning) {
      tick++
      // Heartbeat — sentinel reads this to detect stalled loop. Fire-and-forget.
      db.run(
        `INSERT INTO system_flags (key, value, updated_at, updated_by) VALUES ('gamePulse_heartbeat', ?, ?, 'gamePulse')
         ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
        [String(Date.now()), new Date().toISOString()],
      ).catch(() => {})
      try {
        await updateGamePulse(date)
        // Sub-component heartbeats — record so sentinel can alert if a sub-task missed its cadence.
        db.run(
          `INSERT INTO system_flags (key, value, updated_at, updated_by) VALUES ('gamePulse_updateGamePulse_at', ?, ?, 'gamePulse')
           ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
          [String(Date.now()), new Date().toISOString()],
        ).catch(() => {})

        // Line direction update every 5 ticks (~5 min with 60s loop)
        if (tick % 5 === 0) {
          await updateLineDirections(date)
          db.run(
            `INSERT INTO system_flags (key, value, updated_at, updated_by) VALUES ('gamePulse_lineDir_at', ?, ?, 'gamePulse')
             ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
            [String(Date.now()), new Date().toISOString()],
          ).catch(() => {})
        }

        // Schedule refresh every 30 ticks (~30 min) to catch late announcements
        if (tick % 30 === 0) {
          await initGamePulse(date)
          db.run(
            `INSERT INTO system_flags (key, value, updated_at, updated_by) VALUES ('gamePulse_scheduleRefresh_at', ?, ?, 'gamePulse')
             ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
            [String(Date.now()), new Date().toISOString()],
          ).catch(() => {})
        }
      } catch (err) {
        console.error(`[gamePulse] loop error: ${err.message}`)
        alertError('gamePulse:loop', err).catch(() => {})
      }

      // Check if all games final — if so, stop loop
      const active = await db.all(
        `SELECT COUNT(*) as n FROM game_pulse WHERE bet_date=? AND phase NOT IN ('final','postponed')`,
        [date],
      ).catch(() => [{ n: 1 }])
      if ((active[0]?.n ?? 1) === 0 && tick > 60) {
        console.log(`[gamePulse] All games final for ${date} — stopping loop`)
        _pulseRunning = false
        break
      }

      await new Promise(r => setTimeout(r, 60_000))
    }
  }

  loop().catch(err => {
    console.error(`[gamePulse] fatal loop error: ${err.message}`)
    alertError('gamePulse:fatalLoop', err, { fatal: true }).catch(() => {})
    _pulseRunning = false
  })
}

export function stopPulseLoop() {
  _pulseRunning = false
}
