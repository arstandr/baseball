// agents/lineup/changes.js — Claude Haiku lineup-change classifier
//
// Compares expected vs actual lineups, calls Haiku to classify the impact.
// Falls back to a conservative heuristic if Claude is unavailable.

import { lineupChangeClassify } from '../../lib/claude.js'

/**
 * Heuristic fallback — identifies any player in the expected lineup missing
 * from the actual lineup and returns a conservative adjustment.
 */
function heuristicClassify(expected, actual) {
  const actualNames = new Set((actual || []).map(p => p.name?.toLowerCase()))
  const missing = (expected || [])
    .filter(p => !actualNames.has(p.name?.toLowerCase()))
    .map(p => p.name)
  const changes = missing.length > 0
  const adjustment = Math.max(-0.2, -0.1 * Math.min(missing.length, 2))
  return {
    changes_detected: changes,
    key_players_scratched: missing.slice(0, 4),
    adjustment_factor: adjustment,
    reasoning: changes
      ? `heuristic fallback: ${missing.length} expected starter(s) missing`
      : 'no differences detected',
    source: 'heuristic',
  }
}

export async function classify({ team, expectedLineup, actualLineup }) {
  if (!actualLineup || !actualLineup.length) {
    return {
      changes_detected: false,
      key_players_scratched: [],
      adjustment_factor: -0.05, // small penalty for stale/missing lineup
      reasoning: 'confirmed lineup not yet posted',
      source: 'stale',
    }
  }
  if (!expectedLineup || !expectedLineup.length) {
    // Nothing to compare against — no changes to flag
    return {
      changes_detected: false,
      key_players_scratched: [],
      adjustment_factor: 0,
      reasoning: 'no expected lineup baseline',
      source: 'baseline-missing',
    }
  }
  try {
    const out = await lineupChangeClassify({ team, expectedLineup, actualLineup })
    return {
      changes_detected: !!out.changes_detected,
      key_players_scratched: Array.isArray(out.key_players_scratched)
        ? out.key_players_scratched.slice(0, 6)
        : [],
      adjustment_factor: typeof out.adjustment_factor === 'number' ? out.adjustment_factor : 0,
      reasoning: out.reasoning || '',
      source: 'claude-haiku',
    }
  } catch (err) {
    return {
      ...heuristicClassify(expectedLineup, actualLineup),
      reasoning: `llm failed, heuristic used: ${err.message}`,
      source: 'claude-haiku-failed',
    }
  }
}
