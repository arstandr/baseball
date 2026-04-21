// agents/scout/index.js — Scout agent orchestrator
// Combines signals.js (XGBoost features) + news.js (Claude Haiku) into the
// output schema from AGENTS.md §Agent 1.

import { computePitcherSignals, LEAGUE_AVG } from './signals.js'
import { classify as classifyNews } from './news.js'
import { saveAgentOutput, savePitcherSignal } from '../../lib/db.js'

/**
 * Quality score: blend of the key predictive features. Higher == BETTER
 * pitcher (lower expected runs allowed). Tuned for full-game run totals —
 * full-game ERA and TTO3 now weighted heaviest because they capture
 * post-F5 bullpen/fatigue exposure that F5-era scores ignored.
 *
 *   swstr:       1.0 pt per +1% above 11%
 *   fip:         -1.0 pt per +1.0 above league avg
 *   era_l5:      -0.6 pt per +1.0 above league avg (full-game-specific recent form)
 *   gb_pct:      0.2 pt per +1% above 43%
 *   hard_pct:    -0.2 pt per +1% above 36%
 *   k9:          0.1 pt per +1 above 8.8
 *   bb9:        -0.1 pt per +1 above 3.2
 *   fstrike:     0.1 pt per +1% above 60%
 *   tto_penalty: -0.6 pt per +1 above 0.35
 *   tto3_penalty: -1.2 pt per +1 above 0.90 (heavily penalized, full-game key)
 *
 * Sum + 3.5 center = "quality" (~3.5 is average, >5 is great, <2 is poor)
 */
export function computeQualityScore(sig) {
  if (!sig) return null
  const s =
    ((sig.swstr_pct || LEAGUE_AVG.swstr_pct) - 0.11) * 100 * 1.0 +
    ((sig.fip_weighted || LEAGUE_AVG.fip) - LEAGUE_AVG.fip) * -1.0 +
    ((sig.era_l5 ?? LEAGUE_AVG.era) - LEAGUE_AVG.era) * -0.6 +
    ((sig.gb_pct || LEAGUE_AVG.gb_pct) - 0.43) * 100 * 0.2 +
    ((sig.hard_contact_pct || LEAGUE_AVG.hard_contact_pct) - 0.36) * 100 * -0.2 +
    ((sig.k9 || LEAGUE_AVG.k9) - LEAGUE_AVG.k9) * 0.1 +
    ((sig.bb9 || LEAGUE_AVG.bb9) - LEAGUE_AVG.bb9) * -0.1 +
    ((sig.fstrike_pct || LEAGUE_AVG.fstrike_pct) - 0.60) * 100 * 0.1 +
    ((sig.tto_penalty ?? LEAGUE_AVG.tto_penalty) - LEAGUE_AVG.tto_penalty) * -0.6 +
    ((sig.tto3_penalty ?? LEAGUE_AVG.tto3_penalty) - LEAGUE_AVG.tto3_penalty) * -1.2
  return Number((3.5 + s).toFixed(2))
}

/**
 * Produce a short list of "key signals" — human-readable notes surfaced in
 * the UI / Telegram alerts. Pulled from the metrics that deviate most from
 * league average.
 */
export function keySignals(sig) {
  if (!sig) return []
  const out = []
  if (sig.swstr_pct != null) {
    const pct = (sig.swstr_pct * 100).toFixed(1)
    if (sig.swstr_pct < 0.09) out.push(`SwStr% ${pct}% (low)`)
    else if (sig.swstr_pct > 0.13) out.push(`SwStr% ${pct}% (elite)`)
  }
  if (sig.tto_penalty != null) {
    if (sig.tto_penalty > 0.8) out.push(`TTO penalty ${sig.tto_penalty.toFixed(2)} (high)`)
  }
  if (sig.tto3_penalty != null) {
    if (sig.tto3_penalty > 1.4) out.push(`TTO3 penalty ${sig.tto3_penalty.toFixed(2)} (severe — full-game risk)`)
    else if (sig.tto3_penalty > 1.1) out.push(`TTO3 penalty ${sig.tto3_penalty.toFixed(2)} (elevated)`)
  }
  if (sig.era_l5 != null && sig.era_l5 > 5.5) out.push(`ERA L5 ${sig.era_l5.toFixed(2)} (struggling)`)
  if (sig.era_l5 != null && sig.era_l5 < 2.5) out.push(`ERA L5 ${sig.era_l5.toFixed(2)} (dominant)`)
  if (sig.gb_pct != null) {
    const pct = (sig.gb_pct * 100).toFixed(0)
    if (sig.gb_pct > 0.52) out.push(`GB% ${pct}% (elite)`)
    else if (sig.gb_pct < 0.38) out.push(`GB% ${pct}% (flyball-prone)`)
  }
  if (sig.hard_contact_pct != null && sig.hard_contact_pct > 0.42) {
    out.push(`Hard-hit% ${(sig.hard_contact_pct * 100).toFixed(0)}% (elevated)`)
  }
  if (sig.fip_weighted != null && sig.fip_weighted > 5.0) out.push(`FIP ${sig.fip_weighted} (poor)`)
  if (sig.fip_weighted != null && sig.fip_weighted < 3.5) out.push(`FIP ${sig.fip_weighted} (strong)`)
  if (sig.days_rest != null && sig.days_rest < 4) out.push(`only ${sig.days_rest}d rest`)
  if (sig.pitch_count_last_start != null && sig.pitch_count_last_start > 105) {
    out.push(`${sig.pitch_count_last_start} pitches last start`)
  }
  return out
}

/**
 * Run Scout for one game. Kicks off both pitchers in parallel, each gets
 * full signals + news classification.
 */
export async function run(game) {
  const season = new Date(game.game_time).getUTCFullYear()
  const [home, away] = await Promise.all([
    runOnePitcher({
      pitcher_id: game.pitcher_home_id,
      pitcher_name: game.pitcher_home_name,
      gameDate: game.date,
      venueId: game.venue_id,
      season,
    }),
    runOnePitcher({
      pitcher_id: game.pitcher_away_id,
      pitcher_name: game.pitcher_away_name,
      gameDate: game.date,
      venueId: game.venue_id,
      season,
    }),
  ])

  const out = {
    agent: 'scout',
    game_id: game.id,
    generated_at: new Date().toISOString(),
    pitcher_home: home,
    pitcher_away: away,
  }
  await saveAgentOutput(game.id, 'scout', out)
  return out
}

async function runOnePitcher({ pitcher_id, pitcher_name, gameDate, venueId, season }) {
  if (!pitcher_id) {
    return {
      id: null,
      name: null,
      hand: 'R',
      quality_score: null,
      confidence: 0.1,
      sample_size_starts: 0,
      key_signals: ['no starter confirmed'],
      news_flag: 'caution',
      news_adjustment: -0.1,
      news_reasoning: 'no confirmed starter',
      features: null,
    }
  }
  const features = await computePitcherSignals({
    pitcherId: pitcher_id,
    pitcherName: pitcher_name,
    gameDate,
    venueId,
    season,
  })
  const news = await classifyNews({
    pitcherId: pitcher_id,
    pitcherName: pitcher_name,
  })
  const quality = computeQualityScore(features)
  const signals = keySignals(features)

  // Persist pitcher_signals row for the Turso cache
  if (features) {
    await savePitcherSignal({
      pitcher_id,
      pitcher_name: features.pitcher_name,
      signal_date: gameDate,
      hand: features.hand,
      fip_weighted: features.fip_weighted,
      xfip_weighted: features.xfip_weighted,
      swstr_pct: features.swstr_pct,
      gb_pct: features.gb_pct,
      hard_contact_pct: features.hard_contact_pct,
      k9: features.k9,
      bb9: features.bb9,
      fstrike_pct: features.fstrike_pct,
      tto_penalty: features.tto_penalty,
      tto3_penalty: features.tto3_penalty,
      era_l5: features.era_l5,
      avg_innings_l5: features.avg_innings_l5,
      pitch_efficiency_l5: features.pitch_efficiency_l5,
      days_rest: features.days_rest,
      season_start_num: features.season_start_num,
      confidence: features.confidence,
      news_flag: news.flag,
      news_adjustment: news.adjustment,
      news_reasoning: news.reasoning,
      raw_data_json: JSON.stringify(features),
    })
  }

  return {
    id: pitcher_id,
    name: features?.pitcher_name || pitcher_name,
    hand: features?.hand || 'R',
    quality_score: quality,
    confidence: features?.confidence ?? 0.1,
    sample_size_starts: features?.sample_size_starts ?? 0,
    key_signals: signals,
    news_flag: news.flag,
    news_adjustment: news.adjustment,
    news_reasoning: news.reasoning,
    features,
  }
}
