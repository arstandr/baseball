// lib/kalshiNBA.js — Kalshi NBA totals market helpers.
// Extracted from lib/kalshi.js; re-exported from there for backward compatibility.

import { NBA_TEAM_TO_KALSHI } from './teams.js'
import { listMarkets, authedRequest, normalizeMarket } from './kalshi.js'

function toNBAKalshiAbbr(team) {
  return NBA_TEAM_TO_KALSHI[team?.toUpperCase()] ?? team?.toUpperCase() ?? 'UNK'
}

/**
 * Build a KXNBATOTAL event ticker.
 * Format: KXNBATOTAL-26APR25DENMIN
 */
export function buildNBATotalEventTicker(awayTeam, homeTeam, date) {
  const away = toNBAKalshiAbbr(awayTeam)
  const home = toNBAKalshiAbbr(homeTeam)
  const d = new Date(date + 'T12:00:00Z')
  const yy  = String(d.getUTCFullYear()).slice(-2)
  const mmm = d.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' }).toUpperCase()
  const dd  = String(d.getUTCDate()).padStart(2, '0')
  return `KXNBATOTAL-${yy}${mmm}${dd}${away}${home}`
}

/**
 * Fetch all NBA total lines for a game and return the one with best edge.
 * modelProbabilities: { [line]: P(total > line) } — e.g. { 226: 0.54, 229: 0.41 }
 * Returns best market record with edge, recommended_side, model_prob.
 */
export async function findBestNBATotalMarket(awayTeam, homeTeam, date, modelProbabilities) {
  const eventTicker = buildNBATotalEventTicker(awayTeam, homeTeam, date)
  if (!eventTicker) return null
  const res = await listMarkets({ eventTicker, seriesTicker: 'KXNBATOTAL' })
  const markets = (res?.markets || []).map(normalizeMarket).sort((a, b) => a.line - b.line)
  if (!markets.length) return null

  const minOI = Number(process.env.MIN_MARKET_OI ?? 200)

  let best = null
  let bestEdge = 0
  for (const m of markets) {
    if (m.open_interest != null && m.open_interest < minOI) continue
    const modelProb = modelProbabilities[m.line]
    if (modelProb == null) continue

    const yesPrice   = (m.yes_ask ?? 50) / 100
    const noAsk      = (m.no_ask  ?? 50) / 100
    const overEdge   = modelProb - yesPrice
    const underEdge  = (1 - modelProb) - noAsk
    const edge = Math.max(overEdge, underEdge)

    if (edge > bestEdge) {
      bestEdge = edge
      best = {
        ...m,
        event_ticker: eventTicker,
        recommended_side: overEdge >= underEdge ? 'yes' : 'no',
        model_prob:   overEdge >= underEdge ? modelProb       : 1 - modelProb,
        implied_prob: overEdge >= underEdge ? yesPrice         : noAsk,
        edge,
      }
    }
  }
  return best
}

/**
 * Fetch all NBA total market lines for a game (for schedule discovery).
 */
export async function getNBATotalMarkets(awayTeam, homeTeam, date) {
  const eventTicker = buildNBATotalEventTicker(awayTeam, homeTeam, date)
  if (!eventTicker) return []
  const res = await listMarkets({ eventTicker, seriesTicker: 'KXNBATOTAL' })
  return (res?.markets || []).map(normalizeMarket).sort((a, b) => a.line - b.line)
}

/**
 * List all open KXNBATOTAL events for a given date — used for schedule discovery.
 * Returns array of { eventTicker, awayTeam, homeTeam } objects.
 */
export async function listNBAGamesFromKalshi(date) {
  const d = new Date(date + 'T12:00:00Z')
  const yy  = String(d.getUTCFullYear()).slice(-2)
  const mmm = d.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' }).toUpperCase()
  const dd  = String(d.getUTCDate()).padStart(2, '0')
  const prefix = `KXNBATOTAL-${yy}${mmm}${dd}`

  const res = await authedRequest('GET', '/events', null, {
    series_ticker: 'KXNBATOTAL',
    status: 'open',
    limit: 50,
  })
  const events = res?.events || []
  return events
    .filter(e => e.event_ticker?.startsWith(prefix))
    .map(e => {
      const suffix = e.event_ticker.slice(prefix.length)
      return { eventTicker: e.event_ticker, matchupCode: suffix, title: e.title || '' }
    })
}
