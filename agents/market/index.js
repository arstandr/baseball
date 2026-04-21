// agents/market/index.js — Market agent orchestrator
// See AGENTS.md §Agent 5.

import { getMarketRaw, fetchAndPersistAllLines } from './lines.js'
import { synthesize as synthesizeLlm } from './synthesis.js'
import { saveAgentOutput } from '../../lib/db.js'

/**
 * First half — raw market data, independent of the model projection.
 * Produces the line-movement signals the Judge disqualifiers consume.
 */
export async function fetchLines(game) {
  const raw = await getMarketRaw(game.id)
  return raw
}

/**
 * Second half — called after XGBoost projection. Wraps the Claude synthesis.
 */
export async function synthesize(raw, projection, context) {
  const synth = await synthesizeLlm({
    scout: context.scout,
    lineup: context.lineup,
    park: context.park,
    storm: context.storm,
    market: raw,
    projection,
  })

  const out = {
    agent: 'market',
    game_id: raw.game_id,
    opening_line: raw.opening_line,
    current_line: raw.current_line,
    movement: raw.movement,
    movement_direction: raw.movement_direction,
    over_price: raw.over_price,
    under_price: raw.under_price,
    sharp_signal: raw.sharp_signal,
    efficiency_score: raw.efficiency_score,
    platform_line: raw.platform_line,
    platform_gap: raw.platform_gap,
    disqualify: raw.disqualify,
    disqualify_reason: raw.disqualify_reason,
    synthesis: synth,
  }
  await saveAgentOutput(raw.game_id, 'market', out)
  return out
}

/**
 * Master ingest — called by pipeline/fetch.js to pull lines for the whole slate
 * before any per-game orchestration starts.
 */
export async function ingestSlate(scheduleGames) {
  return fetchAndPersistAllLines(scheduleGames)
}

export { getMarketRaw }
