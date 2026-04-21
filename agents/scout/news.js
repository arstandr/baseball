// agents/scout/news.js — Scout news layer (Claude Haiku wrapper)
//
// Pulls injury report entries + any beat-writer snippets available for the
// starter and classifies risk. Returns { flag, adjustment, reasoning, confidence }.
//
// Fallbacks (never throw):
//   - No API key / LLM failure  -> flag: 'none', adjustment: 0, low confidence
//   - No injury text + no news  -> skip LLM call, return 'none' immediately

import { scoutNewsClassify } from '../../lib/claude.js'
import { fetchInjuryReport } from '../../lib/mlbapi.js'

let _injuryReportCache = null
let _injuryReportFetchedAt = 0
const INJURY_TTL_MS = 30 * 60 * 1000 // refresh injury list every 30 min

async function getInjuryReport() {
  const now = Date.now()
  if (_injuryReportCache && now - _injuryReportFetchedAt < INJURY_TTL_MS) {
    return _injuryReportCache
  }
  try {
    _injuryReportCache = await fetchInjuryReport()
    _injuryReportFetchedAt = now
  } catch {
    _injuryReportCache = []
  }
  return _injuryReportCache
}

function findPitcherInjuries(injuries, pitcherName, pitcherId) {
  if (!Array.isArray(injuries)) return []
  const nameLower = (pitcherName || '').toLowerCase()
  return injuries.filter(inj => {
    if (inj.playerId && String(inj.playerId) === String(pitcherId)) return true
    if (inj.name && nameLower && inj.name.toLowerCase() === nameLower) return true
    if (inj.player && inj.player.fullName && inj.player.fullName.toLowerCase() === nameLower) return true
    return false
  })
}

/**
 * Classify news for one pitcher. Accepts optional externally-provided news
 * snippets (RSS beat-writer feed in v2); falls back to the MLB injury report.
 */
export async function classify({ pitcherId, pitcherName, newsSnippets = [] }) {
  const injuries = await getInjuryReport()
  const pitcherInjuries = findPitcherInjuries(injuries, pitcherName, pitcherId)
  const injuryText = pitcherInjuries
    .map(i => `[${i.status || 'day-to-day'}] ${i.description || i.comment || i.type || ''}`)
    .join('\n')

  if (!injuryText && !newsSnippets.length) {
    return {
      flag: 'none',
      adjustment: 0,
      reasoning: 'no injury report or news found',
      confidence: 0.9,
      source: 'heuristic',
    }
  }

  try {
    const out = await scoutNewsClassify({
      pitcherName,
      injuryReport: injuryText,
      newsSnippets,
    })
    // Defensive normalisation — Claude returns strings/numbers but we validate
    return {
      flag: ['none', 'caution', 'disqualify'].includes(out.flag) ? out.flag : 'none',
      adjustment: typeof out.adjustment === 'number' ? out.adjustment : 0,
      reasoning: out.reasoning || '',
      confidence: typeof out.confidence === 'number' ? out.confidence : 0.7,
      source: 'claude-haiku',
    }
  } catch (err) {
    // LLM failure — default to no-op but keep confidence low so the Judge
    // weights this pitcher's score less aggressively.
    return {
      flag: 'none',
      adjustment: 0,
      reasoning: `news layer failed: ${err.message}`,
      confidence: 0.4,
      source: 'claude-haiku-failed',
    }
  }
}
