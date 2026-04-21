// agents/judge/edgecase.js — Claude Sonnet edge-case handler
//
// Invoked ONLY when Judge detects a situation outside the normal rules
// (doubleheader game 2, makeup game, rain delay, weather outside training
// distribution). Falls back to 'reduce 25%' if the LLM fails.

import { judgeEdgeCase } from '../../lib/claude.js'

/**
 * Classify edge case. Returns { action, size_reduction_pct, reasoning }.
 */
export async function classify({ situation, context }) {
  try {
    const out = await judgeEdgeCase({ situation, context })
    return {
      action: ['proceed', 'reduce', 'reject'].includes(out.action) ? out.action : 'reduce',
      size_reduction_pct:
        typeof out.size_reduction_pct === 'number'
          ? Math.max(0, Math.min(100, out.size_reduction_pct))
          : 25,
      reasoning: out.reasoning || '',
      source: 'claude-sonnet',
    }
  } catch (err) {
    return {
      action: 'reduce',
      size_reduction_pct: 25,
      reasoning: `edge-case LLM failed, default reduce 25%: ${err.message}`,
      source: 'claude-sonnet-failed',
    }
  }
}

/**
 * Heuristic: when to trigger the edge case handler.
 */
export function detectEdgeCase(game, context) {
  const flags = []
  if (game.double_header) flags.push('doubleheader')
  if (context.storm?.temp_f != null && (context.storm.temp_f < 35 || context.storm.temp_f > 100)) {
    flags.push(`extreme_temp_${context.storm.temp_f}F`)
  }
  if (context.storm?.wind_mph != null && context.storm.wind_mph > 25) {
    flags.push(`extreme_wind_${context.storm.wind_mph}mph`)
  }
  if (game.status === 'postponed') flags.push('postponed')
  // Pitcher on very short rest
  const sp = context.scout?.pitcher_home?.features || context.scout?.pitcher_away?.features
  if (sp?.days_rest != null && sp.days_rest <= 3) flags.push(`short_rest_${sp.days_rest}d`)
  return flags
}
