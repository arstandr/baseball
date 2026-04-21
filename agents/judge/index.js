// agents/judge/index.js — Judge agent
// Hard disqualifiers + confidence multipliers + edge + position sizing.
// See AGENTS.md §Agent 6.

import { saveAgentOutput } from '../../lib/db.js'
import { detectEdgeCase, classify as classifyEdgeCase } from './edgecase.js'

const EDGE_THRESHOLD = Number(process.env.EDGE_THRESHOLD || 0.06)
const MIN_BET = Number(process.env.MIN_BET || 25)
const MAX_BET_PCT = Number(process.env.MAX_BET_PCT || 0.03)
const BANKROLL_DEFAULT = Number(process.env.BANKROLL || 5000)

// ------------------------------------------------------------------
// Disqualifiers
// ------------------------------------------------------------------
export function checkDisqualifiers({ scout, lineup, storm, market, bullpen, game }) {
  const reasons = []
  if (storm?.disqualify) reasons.push(`storm:${storm.disqualify_reason || 'precip'}`)
  if (scout?.pitcher_home?.news_flag === 'disqualify') reasons.push('scout_home:news_disqualify')
  if (scout?.pitcher_away?.news_flag === 'disqualify') reasons.push('scout_away:news_disqualify')
  if (market?.disqualify) reasons.push(`market:${market.disqualify_reason || 'movement'}`)
  if (Math.abs(market?.movement || 0) > 0.5) reasons.push('market:movement>0.5')

  // Bullpen disqualifier: both bullpens ERA>6 over last 14d means the model's
  // post-F5 innings estimate is essentially a coin flip — variance too high.
  const bpH = bullpen?.bullpen_home?.era_14d
  const bpA = bullpen?.bullpen_away?.era_14d
  if (bpH != null && bpA != null && bpH > 6.0 && bpA > 6.0) {
    reasons.push('bullpen:both_era_14d>6.0')
  }

  const spHomeRest = scout?.pitcher_home?.features?.days_rest
  const spAwayRest = scout?.pitcher_away?.features?.days_rest
  if (spHomeRest != null && spHomeRest < 4) reasons.push(`home_sp_rest_${spHomeRest}d`)
  if (spAwayRest != null && spAwayRest < 4) reasons.push(`away_sp_rest_${spAwayRest}d`)

  if (scout?.pitcher_home?.confidence != null && scout.pitcher_home.confidence < 0.4) {
    reasons.push('home_sp_confidence<0.4')
  }
  if (scout?.pitcher_away?.confidence != null && scout.pitcher_away.confidence < 0.4) {
    reasons.push('away_sp_confidence<0.4')
  }
  if (market?.synthesis?.recommendation === 'reject') {
    reasons.push('synthesis:reject')
  }
  return reasons
}

// ------------------------------------------------------------------
// Confidence multiplier
// ------------------------------------------------------------------
export function computeConfidenceMultiplier({ scout, lineup, storm, market }) {
  let m = 1.0
  if (scout?.pitcher_home?.news_flag === 'caution') m *= 0.8
  if (scout?.pitcher_away?.news_flag === 'caution') m *= 0.8
  if (lineup?.lineup_home?.changes_detected) m *= 0.85
  if (lineup?.lineup_away?.changes_detected) m *= 0.85
  if (scout?.pitcher_home?.confidence != null && scout.pitcher_home.confidence < 0.65) m *= 0.75
  if (scout?.pitcher_away?.confidence != null && scout.pitcher_away.confidence < 0.65) m *= 0.75
  if (market?.synthesis?.recommendation === 'caution') m *= 0.7
  if (storm?.precip_probability != null && storm.precip_probability > 0.2) m *= 0.9
  return Number(m.toFixed(3))
}

// ------------------------------------------------------------------
// Edge calculation
// ------------------------------------------------------------------
export function calculateEdge(modelProbability, marketImpliedProbability, marketEfficiency) {
  const raw = modelProbability - marketImpliedProbability
  const adjusted = raw * (marketEfficiency ?? 1.0)
  return { raw_edge: Number(raw.toFixed(4)), adjusted_edge: Number(adjusted.toFixed(4)) }
}

// ------------------------------------------------------------------
// Position sizing (half-Kelly with hard floor/ceiling)
// ------------------------------------------------------------------
export function positionSize(edge, confidence, bankroll, {
  MIN_BET: minBet = MIN_BET,
  MAX_PCT: maxPct = MAX_BET_PCT,
} = {}) {
  if (edge <= 0) return 0
  const kelly_fraction = (edge / (1 - edge)) * 0.5
  const adjusted_fraction = kelly_fraction * confidence
  const raw_size = bankroll * adjusted_fraction
  const max_size = bankroll * maxPct
  return Math.round(Math.min(max_size, Math.max(minBet, raw_size)))
}

// ------------------------------------------------------------------
// Primary driver attribution
// ------------------------------------------------------------------
function attribution({ scout, lineup, storm, park, market }) {
  const scores = {
    scout: 0,
    lineup: 0,
    storm: 0,
    park: 0,
    market: 0,
  }
  // Scout: how far each pitcher's quality is from league-average 3.5
  const sH = scout?.pitcher_home?.quality_score
  const sA = scout?.pitcher_away?.quality_score
  if (sH != null) scores.scout += Math.abs(sH - 3.5)
  if (sA != null) scores.scout += Math.abs(sA - 3.5)
  // Lineup: how far offensive rating is from 100
  const lH = lineup?.lineup_home?.offensive_rating
  const lA = lineup?.lineup_away?.offensive_rating
  if (lH != null) scores.lineup += Math.abs(lH - 100) / 20
  if (lA != null) scores.lineup += Math.abs(lA - 100) / 20
  // Storm
  scores.storm = Math.abs(storm?.weather_score || 0) * 2
  // Park
  scores.park = Math.abs((park?.run_factor || 1) - 1) * 5
  // Market
  scores.market = Math.abs(market?.movement || 0) * 2

  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1])
  const primary = sorted[0][0]
  const supporting = sorted.filter(([k, v]) => v > 0.5 && k !== primary).map(([k]) => k)
  const neutral = sorted.filter(([, v]) => v <= 0.5).map(([k]) => k)
  return { primary_driver: primary, supporting, neutral, opposing: [] }
}

// ------------------------------------------------------------------
// Decision engine
// ------------------------------------------------------------------
export async function decide({ game, scout, lineup, park, storm, market, bullpen, projection, bankroll }) {
  const currentBankroll = bankroll ?? BANKROLL_DEFAULT
  const reasons = checkDisqualifiers({ scout, lineup, storm, market, bullpen, game })

  // Base rejection case
  if (reasons.length) {
    const out = {
      agent: 'judge',
      game_id: game.id,
      decision: 'REJECT',
      rejection_reason: reasons.join('; '),
      raw_edge: 0,
      adjusted_edge: 0,
      market_efficiency: market?.efficiency_score ?? 1.0,
      confidence_multiplier: 0,
      model_probability: projection?.over_probability ?? null,
      market_implied_probability: market?.over_price ?? null,
      recommended_side: null,
      position_size: 0,
      bankroll: currentBankroll,
      agent_attribution: attribution({ scout, lineup, storm, park, market }),
      explanation: `Rejected by disqualifier(s): ${reasons.join('; ')}`,
    }
    await saveAgentOutput(game.id, 'judge', out)
    return out
  }

  // Determine side: if model_prob > market_over_prob, OVER; else UNDER
  const overPrice = market?.over_price ?? 0.5
  const underPrice = market?.under_price ?? 1 - overPrice
  const modelProb = projection?.over_probability ?? 0.5
  const side = modelProb >= overPrice ? 'OVER' : 'UNDER'
  const marketImplied = side === 'OVER' ? overPrice : underPrice
  const modelSideProb = side === 'OVER' ? modelProb : 1 - modelProb

  const { raw_edge, adjusted_edge } = calculateEdge(
    modelSideProb,
    marketImplied,
    market?.efficiency_score ?? 1.0,
  )
  const confMult = computeConfidenceMultiplier({ scout, lineup, storm, market })
  const effectiveEdge = adjusted_edge * confMult

  // Edge-case handler — trigger if any non-standard flags detected
  const edgeCaseFlags = detectEdgeCase(game, { scout, lineup, storm, market })
  let edgeCase = null
  let sizeReduction = 0
  if (edgeCaseFlags.length) {
    edgeCase = await classifyEdgeCase({
      situation: edgeCaseFlags.join(', '),
      context: { scout, lineup, storm, market, projection },
    })
    if (edgeCase.action === 'reject') {
      const out = {
        agent: 'judge',
        game_id: game.id,
        decision: 'REJECT',
        rejection_reason: `edge_case:${edgeCaseFlags.join(',')}; ${edgeCase.reasoning}`,
        raw_edge,
        adjusted_edge: effectiveEdge,
        market_efficiency: market?.efficiency_score ?? 1.0,
        confidence_multiplier: confMult,
        model_probability: modelSideProb,
        market_implied_probability: marketImplied,
        recommended_side: side,
        position_size: 0,
        bankroll: currentBankroll,
        agent_attribution: attribution({ scout, lineup, storm, park, market }),
        edge_case: edgeCase,
        explanation: `Edge case rejected: ${edgeCase.reasoning}`,
      }
      await saveAgentOutput(game.id, 'judge', out)
      return out
    }
    if (edgeCase.action === 'reduce') {
      sizeReduction = edgeCase.size_reduction_pct / 100
    }
  }

  // Threshold gate
  if (effectiveEdge < EDGE_THRESHOLD) {
    const out = {
      agent: 'judge',
      game_id: game.id,
      decision: 'REJECT',
      rejection_reason: `edge_below_threshold (${(effectiveEdge * 100).toFixed(1)}% < ${(EDGE_THRESHOLD * 100).toFixed(1)}%)`,
      raw_edge,
      adjusted_edge: effectiveEdge,
      market_efficiency: market?.efficiency_score ?? 1.0,
      confidence_multiplier: confMult,
      model_probability: modelSideProb,
      market_implied_probability: marketImplied,
      recommended_side: side,
      position_size: 0,
      bankroll: currentBankroll,
      agent_attribution: attribution({ scout, lineup, storm, park, market }),
      edge_case: edgeCase,
      explanation: `Edge ${(effectiveEdge * 100).toFixed(1)}% below ${(EDGE_THRESHOLD * 100).toFixed(1)}% threshold.`,
    }
    await saveAgentOutput(game.id, 'judge', out)
    return out
  }

  // Compute position size — Kelly scaled by confidence and any edge-case reduction
  const confidence = Math.min(
    scout?.pitcher_home?.confidence ?? 1,
    scout?.pitcher_away?.confidence ?? 1,
    lineup?.lineup_home?.confidence ?? 1,
    lineup?.lineup_away?.confidence ?? 1,
  )
  let size = positionSize(effectiveEdge, confidence, currentBankroll)
  if (sizeReduction > 0) size = Math.round(size * (1 - sizeReduction))

  const attr = attribution({ scout, lineup, storm, park, market })
  const explanation = buildExplanation({
    side,
    edge: effectiveEdge,
    modelProb: modelSideProb,
    marketImplied,
    driver: attr.primary_driver,
    confMult,
    edgeCase,
  })

  const out = {
    agent: 'judge',
    game_id: game.id,
    decision: 'TRADE',
    rejection_reason: null,
    raw_edge,
    adjusted_edge: effectiveEdge,
    market_efficiency: market?.efficiency_score ?? 1.0,
    confidence_multiplier: confMult,
    model_probability: modelSideProb,
    market_implied_probability: marketImplied,
    recommended_side: side,
    line: market?.current_line,
    contract_price: marketImplied,
    position_size: size,
    bankroll: currentBankroll,
    agent_attribution: attr,
    edge_case: edgeCase,
    explanation,
  }
  await saveAgentOutput(game.id, 'judge', out)
  return out
}

function buildExplanation({ side, edge, modelProb, marketImplied, driver, confMult, edgeCase }) {
  const parts = [
    `Model sees ${(modelProb * 100).toFixed(1)}% probability vs market ${(marketImplied * 100).toFixed(1)}% implied.`,
    `Net edge ${(edge * 100).toFixed(1)}% on the ${side}.`,
    `Primary driver: ${driver}. Confidence x${confMult.toFixed(2)}.`,
  ]
  if (edgeCase && edgeCase.action !== 'proceed') {
    parts.push(`Edge-case: ${edgeCase.action} (${edgeCase.reasoning}).`)
  }
  return parts.join(' ')
}
