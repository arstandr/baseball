// agents/lineup/index.js — Lineup agent orchestrator
// See AGENTS.md §Agent 2.

import { computeLineupSignals, runsPerGame14d, top6WeightedOps } from './signals.js'
import { classify as classifyChanges } from './changes.js'
import { fetchConfirmedLineups, fetchExpectedLineups } from '../../lib/rotowire.js'
import { saveAgentOutput, saveLineupSignal } from '../../lib/db.js'
import * as db from '../../lib/db.js'

/**
 * Run Lineup agent for one game.
 *
 * @param {object} game   - game row
 * @param {object} scout  - scout agent output (needed for pitcher handedness)
 */
export async function run(game, scout) {
  const season = new Date(game.game_time).getUTCFullYear()
  // Home lineup faces AWAY starter's handedness; away lineup faces HOME starter's.
  const homeVsHand = scout?.pitcher_away?.hand || 'R'
  const awayVsHand = scout?.pitcher_home?.hand || 'R'

  // Pull both expected and confirmed lineups once for the day
  const [expected, confirmed] = await Promise.all([
    fetchExpectedLineups(game.date).catch(() => ({})),
    fetchConfirmedLineups(game.date).catch(() => ({})),
  ])

  const [home, away] = await Promise.all([
    runOneTeam({
      team: game.team_home,
      vsHand: homeVsHand,
      season,
      game,
      expected: expected[game.team_home?.toUpperCase()]?.lineup,
      confirmed: confirmed[game.team_home?.toUpperCase()],
      homeAway: 'home',
    }),
    runOneTeam({
      team: game.team_away,
      vsHand: awayVsHand,
      season,
      game,
      expected: expected[game.team_away?.toUpperCase()]?.lineup,
      confirmed: confirmed[game.team_away?.toUpperCase()],
      homeAway: 'away',
    }),
  ])

  const out = {
    agent: 'lineup',
    game_id: game.id,
    generated_at: new Date().toISOString(),
    lineup_home: home,
    lineup_away: away,
  }
  await saveAgentOutput(game.id, 'lineup', out)
  return out
}

async function runOneTeam({ team, vsHand, season, game, expected, confirmed, homeAway }) {
  if (!team) {
    return {
      team: null,
      vs_handedness: vsHand,
      offensive_rating: 100,
      k_pct: 0.22,
      runs_per_game_14d: 4.5,
      lob_pct_14d: 0.72,
      changes_detected: false,
      key_players_scratched: [],
      adjustment_factor: 0,
      key_signals: ['team unknown'],
      confidence: 0.2,
      features: null,
    }
  }

  // Schedule fatigue — games in the last 7 days from our own DB
  const scheduleFatigue = await countGamesInLast7Days(team, game.date)
  const sig = await computeLineupSignals({
    team,
    vsHand,
    season,
    scheduleFatigue,
    homeAway,
  })
  sig.runs_pg_14d = await runsPerGame14d({ team, gameDate: game.date, db })

  // Lineup-change detection
  const changes = await classifyChanges({
    team,
    expectedLineup: expected || [],
    actualLineup: confirmed?.lineup || [],
  })

  // Top-6 OPS from confirmed lineup (optional, uses empty stats -> league avg fallback)
  const top6 = top6WeightedOps(confirmed?.lineup || [], {}) // hitterStats TBD — we use league avg

  // Persist lineup_signals row
  await saveLineupSignal({
    team_id: team,
    game_id: game.id,
    signal_date: game.date,
    vs_handedness: vsHand,
    wrc_plus_14d: sig.wrc_plus_14d,
    wrc_plus_30d: sig.wrc_plus_30d,
    k_pct_14d: sig.k_pct_14d,
    hard_contact_14d: sig.hard_contact_14d,
    iso_14d: sig.iso_14d,
    runs_pg_14d: sig.runs_pg_14d,
    lob_pct_14d: sig.lob_pct_14d,
    top6_weighted_ops: top6,
    schedule_fatigue: scheduleFatigue,
    changes_detected: changes.changes_detected ? 1 : 0,
    key_players_scratched: JSON.stringify(changes.key_players_scratched || []),
    change_adjustment: changes.adjustment_factor,
    confidence: sig.confidence,
    raw_data_json: JSON.stringify({ sig, changes, top6 }),
  })

  const keySignals = []
  if (sig.wrc_plus_14d > 110) keySignals.push(`strong vs ${vsHand}HP wRC+ ${sig.wrc_plus_14d}`)
  if (sig.wrc_plus_14d < 90) keySignals.push(`weak vs ${vsHand}HP wRC+ ${sig.wrc_plus_14d}`)
  if (sig.k_pct_14d != null) {
    const k = (sig.k_pct_14d * 100).toFixed(0)
    if (sig.k_pct_14d > 0.26) keySignals.push(`high K% ${k}%`)
    if (sig.k_pct_14d < 0.20) keySignals.push(`low K% ${k}%`)
  }
  if (changes.changes_detected) keySignals.push(`${changes.key_players_scratched.length} key hitter(s) scratched`)
  if (scheduleFatigue >= 7) keySignals.push(`7 games in last 7d`)

  return {
    team,
    vs_handedness: vsHand,
    offensive_rating: sig.wrc_plus_14d,
    k_pct: sig.k_pct_14d,
    iso: sig.iso_14d,
    hard_contact: sig.hard_contact_14d,
    runs_per_game_14d: sig.runs_pg_14d,
    lob_pct_14d: sig.lob_pct_14d,
    top6_weighted_ops: top6,
    changes_detected: changes.changes_detected,
    key_players_scratched: changes.key_players_scratched,
    adjustment_factor: changes.adjustment_factor,
    key_signals: keySignals,
    confidence: Math.min(sig.confidence, changes.source === 'stale' ? 0.6 : 1.0),
    features: { ...sig, change_adjustment: changes.adjustment_factor, top6_weighted_ops: top6 },
  }
}

async function countGamesInLast7Days(team, gameDate) {
  try {
    const cutoff = new Date(new Date(gameDate).getTime() - 7 * 24 * 3600 * 1000)
      .toISOString()
      .slice(0, 10)
    const rows = await db.all(
      `SELECT COUNT(*) AS n FROM games
       WHERE date BETWEEN ? AND ?
         AND (team_home = ? OR team_away = ?)
         AND status = 'final'`,
      [cutoff, gameDate, team, team],
    )
    return rows[0]?.n || 0
  } catch {
    return 0
  }
}
