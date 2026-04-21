// agents/market/synthesis.js — Claude Sonnet synthesis layer
// Called after XGBoost projection. See AGENTS.md §Agent 5.

import { marketSynthesize } from '../../lib/claude.js'

/**
 * Run synthesis. Returns the JSON shape from AGENTS.md.
 */
export async function synthesize({ scout, lineup, park, storm, market, projection }) {
  try {
    const out = await marketSynthesize({ scout, lineup, park, storm, market, projection })
    return {
      unusual_flags: Array.isArray(out.unusual_flags) ? out.unusual_flags : [],
      signal_coherence: ['aligned', 'mixed', 'contradictory'].includes(out.signal_coherence)
        ? out.signal_coherence
        : 'mixed',
      confidence_check: ['pass', 'warn', 'fail'].includes(out.confidence_check)
        ? out.confidence_check
        : 'warn',
      synthesis: out.synthesis || '',
      recommendation: ['proceed', 'caution', 'reject'].includes(out.recommendation)
        ? out.recommendation
        : 'caution',
      source: 'claude-sonnet',
    }
  } catch (err) {
    return {
      unusual_flags: [`synthesis_failed: ${err.message}`],
      signal_coherence: 'mixed',
      confidence_check: 'warn',
      synthesis: 'Market synthesis LLM failed; defaulting to caution.',
      recommendation: 'caution',
      source: 'claude-sonnet-failed',
    }
  }
}
