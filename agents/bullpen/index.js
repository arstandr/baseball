// agents/bullpen/index.js — Bullpen agent orchestrator (Group I, full-game only).
//
// See DEC-019 — added as the 7th agent when MLBIE pivoted from F5 to
// full-game totals on Kalshi. Bullpen quality is ~0 signal for F5 (starter
// still in) but dominates innings 6-9.

import { computeBullpenSignals } from './signals.js'
import { saveAgentOutput, upsert } from '../../lib/db.js'

/**
 * Run the Bullpen agent for one game. Computes rolling 14-day bullpen stats
 * for both teams and persists to agent_outputs + bullpen_signals.
 */
export async function run(game) {
  const season = new Date(game.game_time).getUTCFullYear()

  const [bpHome, bpAway] = await Promise.all([
    safeCompute(game.team_home_id || game.team_home, game.date, season),
    safeCompute(game.team_away_id || game.team_away, game.date, season),
  ])

  const out = {
    agent: 'bullpen',
    game_id: game.id,
    generated_at: new Date().toISOString(),
    bullpen_home: bpHome,
    bullpen_away: bpAway,
  }

  await saveAgentOutput(game.id, 'bullpen', out)

  // Persist per-team rolling signal for reuse + historical backfill
  for (const [teamId, sig] of [
    [game.team_home_id || game.team_home, bpHome],
    [game.team_away_id || game.team_away, bpAway],
  ]) {
    if (!teamId || !sig) continue
    const safe = v => (v == null || (typeof v === 'number' && !Number.isFinite(v)) ? null : v)
    await upsert(
      'bullpen_signals',
      {
        team_id: String(teamId),
        signal_date: game.date,
        era_14d: safe(sig.era_14d),
        whip_14d: safe(sig.whip_14d),
        k_pct_14d: safe(sig.k_pct_14d),
        hr_per_9_14d: safe(sig.hr_per_9_14d),
        inherited_score_pct: safe(sig.inherited_score_pct),
        quality_score: safe(sig.quality_score),
        confidence: safe(sig.confidence),
        raw_data_json: JSON.stringify(sig),
      },
      ['team_id', 'signal_date'],
    )
  }

  return out
}

async function safeCompute(teamId, gameDate, season) {
  try {
    return await computeBullpenSignals({ teamId, gameDate, season })
  } catch (err) {
    return {
      team_id: String(teamId || ''),
      era_14d: 4.20,
      whip_14d: 1.30,
      k_pct_14d: 0.24,
      hr_per_9_14d: 1.15,
      inherited_score_pct: 0.33,
      quality_score: 3.5,
      confidence: 0.2,
      _error: err.message,
    }
  }
}
