// lib/kalshi.js — Kalshi Trading API client
//
// Authentication: RSA-PSS key signing (Kalshi API key auth).
//   Credentials come from env: KALSHI_KEY_ID, KALSHI_KEY_PATH.
//   Each request is signed: HMAC = SHA256(timestamp + METHOD + /path)
//
// Markets (MLB full-game totals):
//   Series:  KXMLBTOTAL
//   Ticker:  KXMLBTOTAL-{YY}{MMM}{DD}{HHMM}{AWAYABBR}{HOMEABBR}-{LINE}
//   Example: KXMLBTOTAL-26APR161310KCDET-7
//
// Markets (MLB first-5-innings totals):
//   Series:  KXMLBF5TOTAL
//   Event:   KXMLBF5TOTAL-{YY}{MMM}{DD}{HHMM}{AWAYABBR}{HOMEABBR}
//   Ticker:  KXMLBF5TOTAL-{YY}{MMM}{DD}{HHMM}{AWAYABBR}{HOMEABBR}-{IDX}
//   Lines:   floor_strike values 0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5 (idx 1-7)
//
// Key methods:
//   getBalance()                -> { balance }
//   findMarket(away, home, date, line) -> market record
//   findBestMarket(away, home, date, modelProbabilities)
//                               -> full-game market with highest edge
//   findF5Market(away, home, date, line) -> F5-total market record
//   findBestF5Market(away, home, date, modelProbabilities)
//                               -> F5-total market with highest edge
//   placeOrder(ticker, side, contracts, price)
//                               -> order result
//   getPortfolio()              -> positions
//   getPosition(ticker)         -> position for a ticker

import { createSign } from 'crypto'
import { readFileSync } from 'fs'
import axios from 'axios'
import 'dotenv/config'

const BASE = 'https://api.elections.kalshi.com/trade-api/v2'

// ------------------------------------------------------------------
// Team name → Kalshi abbreviation map (30 teams)
// Examples confirmed from API: LAA, NYY, KC, DET, SEA, SD, BAL, CLE, SF,
// CIN, TOR, MIL, TB, CWS, COL, HOU. The rest follow standard MLB abbrev
// conventions Kalshi uses in ticker keys.
// ------------------------------------------------------------------
export const TEAM_TO_KALSHI = {
  // AL East
  BAL: 'BAL', BOS: 'BOS', NYY: 'NYY', TB: 'TB', TOR: 'TOR',
  // AL Central
  CWS: 'CWS', CLE: 'CLE', DET: 'DET', KC: 'KC', MIN: 'MIN',
  // AL West
  HOU: 'HOU', LAA: 'LAA', OAK: 'ATH', SEA: 'SEA', TEX: 'TEX', ATH: 'ATH',
  // NL East
  ATL: 'ATL', MIA: 'MIA', NYM: 'NYM', PHI: 'PHI', WSH: 'WSH',
  // NL Central
  CHC: 'CHC', CIN: 'CIN', MIL: 'MIL', PIT: 'PIT', STL: 'STL',
  // NL West
  ARI: 'AZ', COL: 'COL', LAD: 'LAD', SD: 'SD', SF: 'SF',
  // Aliases seen across different APIs
  CHW: 'CWS', WAS: 'WSH', KCR: 'KC', SFG: 'SF', SDP: 'SD', TBR: 'TB',
  AZ: 'AZ',
}

export function toKalshiAbbr(team) {
  if (!team) return null
  const t = String(team).toUpperCase()
  return TEAM_TO_KALSHI[t] || t
}

// ------------------------------------------------------------------
// RSA-PSS key signing auth
// Each request header set: KALSHI-ACCESS-KEY, KALSHI-ACCESS-SIGNATURE,
// KALSHI-ACCESS-TIMESTAMP. Signature = RSA-PSS-SHA256(ts + METHOD + /path)
// ------------------------------------------------------------------
function _buildAuthHeaders(method, path, { json = false, keyId: explicitKeyId, privateKey: explicitPem } = {}) {
  const keyId = explicitKeyId || process.env.KALSHI_KEY_ID
  if (!keyId) throw new Error('kalshi: missing KALSHI_KEY_ID')
  let pem = explicitPem
  if (!pem) {
    if (process.env.KALSHI_KEY_CONTENT) {
      pem = process.env.KALSHI_KEY_CONTENT.replace(/\\n/g, '\n')
    } else {
      const keyPath = process.env.KALSHI_KEY_PATH
      if (!keyPath) throw new Error('kalshi: missing KALSHI_KEY_PATH or KALSHI_KEY_CONTENT')
      pem = readFileSync(keyPath, 'utf8')
    }
  }
  const ts  = Date.now().toString()
  const msg = ts + method.toUpperCase() + path
  const sign = createSign('SHA256')
  sign.update(msg)
  const signature = sign.sign({ key: pem, padding: 6 /* RSA_PKCS1_PSS_PADDING */ }, 'base64')
  const headers = {
    'KALSHI-ACCESS-KEY':       keyId,
    'KALSHI-ACCESS-SIGNATURE': signature,
    'KALSHI-ACCESS-TIMESTAMP': ts,
    'Accept': 'application/json',
  }
  // Only send Content-Type on requests with a body — sending it on GET
  // triggers CloudFront 403 on Kalshi's API gateway.
  if (json) headers['Content-Type'] = 'application/json'
  return headers
}

async function authedRequest(method, url, body, params, creds = {}) {
  // Kalshi signs only the path (no query string) per their API docs
  const sigPath = `/trade-api/v2${url}`
  const headers = _buildAuthHeaders(method, sigPath, { json: !!body, ...creds })
  const res = await axios({
    method,
    url: `${BASE}${url}`,
    data: body,
    params,
    timeout: 20000,
    headers,
    validateStatus: s => s >= 200 && s < 500,
  })
  if (res.status >= 400) {
    throw new Error(`kalshi ${method} ${url} -> ${res.status} ${JSON.stringify(res.data)}`)
  }
  return res.data
}

/**
 * Build auth headers for raw fetch calls.
 * Pass json=true when making a POST/PUT with a JSON body.
 * Returns headers object ready to pass to fetch().
 */
export function getAuthHeaders(method, path, { json = false } = {}, creds = {}) {
  return _buildAuthHeaders(method, path, { json, ...creds })
}

// ------------------------------------------------------------------
// Public methods
// ------------------------------------------------------------------

/**
 * Portfolio balance. Kalshi returns `{ balance: <cents> }` (integer cents).
 */
export async function getBalance(creds = {}) {
  const data = await authedRequest('GET', '/portfolio/balance', null, null, creds)
  return {
    balance_cents: data.balance,
    balance_usd: (data.balance || 0) / 100,
  }
}

/**
 * Extract date/time parts in Eastern Time (ET) from an ISO UTC timestamp.
 * Kalshi tickers use ET local time (e.g. "1420" for a 2:20 PM ET game).
 * MLB season is always EDT (UTC-4); no DST edge cases since there are no
 * meaningful games in November–March.
 */
function toETDateParts(gameTime, fallbackDate) {
  const t = gameTime ? new Date(gameTime) : new Date(`${fallbackDate}T19:05:00Z`)
  if (Number.isNaN(t.getTime())) return null
  // EDT = UTC-4. Apply offset in milliseconds.
  const ET_OFFSET_MS = -4 * 60 * 60 * 1000
  const et = new Date(t.getTime() + ET_OFFSET_MS)
  return {
    yy:  String(et.getUTCFullYear()).slice(-2),
    mmm: ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'][et.getUTCMonth()],
    dd:  String(et.getUTCDate()).padStart(2, '0'),
    hh:  String(et.getUTCHours()).padStart(2, '0'),
    mi:  String(et.getUTCMinutes()).padStart(2, '0'),
  }
}

/**
 * Build the Kalshi ticker for a single line on a single game.
 * Format: KXMLBTOTAL-{YY}{MMM}{DD}{HHMM}{AWAY}{HOME}-{LINE}
 *
 *   date: YYYY-MM-DD
 *   gameTime: ISO timestamp (first pitch)
 */
export function buildTicker({ awayTeam, homeTeam, date, gameTime, line }) {
  const away = toKalshiAbbr(awayTeam)
  const home = toKalshiAbbr(homeTeam)
  if (!away || !home || !date || line == null) return null

  const parts = toETDateParts(gameTime, date)
  if (!parts) return null
  const { yy, mmm, dd, hh, mi } = parts

  // Kalshi strips decimal + sign from line string (7 for 7.0, 75 for 7.5)
  const lineStr = String(line).includes('.')
    ? String(line).replace('.', '')
    : String(line)

  return `KXMLBTOTAL-${yy}${mmm}${dd}${hh}${mi}${away}${home}-${lineStr}`
}

/**
 * List markets matching a filter. Kalshi's GET /markets endpoint accepts
 * `event_ticker`, `series_ticker`, `status`, `limit`.
 */
export async function listMarkets({ eventTicker, seriesTicker = 'KXMLBTOTAL', status = 'open', limit = 200, cursor } = {}) {
  const params = { series_ticker: seriesTicker, status, limit }
  if (eventTicker) params.event_ticker = eventTicker
  if (cursor) params.cursor = cursor
  const data = await authedRequest('GET', '/markets', null, params)
  return data
}

/**
 * Find the specific market for a game at a specific line.
 * Returns { ticker, yes_ask, no_ask, yes_bid, no_bid, volume } or null.
 */
export async function findMarket(awayTeam, homeTeam, date, line, gameTime) {
  const eventTicker = buildEventTicker({ awayTeam, homeTeam, date, gameTime })
  const res = await listMarkets({ eventTicker })
  const markets = res?.markets || []
  const want = Math.round(Number(line) * 10) / 10 // one-decimal normalisation
  for (const m of markets) {
    const floor = Number(m.floor_strike ?? m.strike ?? m.cap_strike)
    if (!Number.isFinite(floor)) continue
    if (Math.abs(floor - want) < 0.01) {
      return normalizeMarket(m)
    }
  }
  return null
}

/**
 * Scan all available lines for a game and return the market with highest
 * edge given our model's `P(over)`. `modelProbabilities` can be either
 *   a number (P(over)) which is rescaled for each line via the projection, or
 *   a map { line -> P(over at that line) }.
 */
export async function findBestMarket(awayTeam, homeTeam, date, modelProbabilities, gameTime) {
  const eventTicker = buildEventTicker({ awayTeam, homeTeam, date, gameTime })
  const res = await listMarkets({ eventTicker })
  const markets = (res?.markets || []).map(normalizeMarket)
  if (!markets.length) return null

  const minOI = Number(process.env.MIN_MARKET_OI ?? 200)

  let best = null
  let bestEdge = 0
  for (const m of markets) {
    // Skip illiquid lines — not enough open interest to fill cleanly
    if (m.open_interest != null && m.open_interest < minOI) continue

    const line = m.line
    const overModelProb = resolveModelProb(modelProbabilities, line, markets)
    if (overModelProb == null) continue

    // Kalshi yes = over on *floor* ticker (convention: strike X, YES = over X)
    const yesPrice = (m.yes_ask ?? 50) / 100
    const overEdge = overModelProb - yesPrice
    const underEdge = (1 - overModelProb) - (m.no_ask ?? 50) / 100

    const edge = Math.max(overEdge, underEdge)
    if (edge > bestEdge) {
      bestEdge = edge
      best = {
        ...m,
        recommended_side: overEdge >= underEdge ? 'yes' : 'no',
        model_prob: overEdge >= underEdge ? overModelProb : 1 - overModelProb,
        implied_prob: overEdge >= underEdge ? yesPrice : (m.no_ask ?? 50) / 100,
        edge,
      }
    }
  }
  return best
}

function resolveModelProb(modelProbabilities, line, markets) {
  if (typeof modelProbabilities === 'number') {
    // Shift p(over) linearly across neighboring lines (approx — the XGBoost
    // model only outputs P(over > current_line); for other lines we shift
    // by ~8%/run change in line).
    const anchorLine = markets[0]?.line ?? line
    const delta = anchorLine - line
    return Math.max(0.01, Math.min(0.99, modelProbabilities + delta * 0.08))
  }
  if (modelProbabilities && typeof modelProbabilities === 'object') {
    const exact = modelProbabilities[line]
    if (exact != null) return exact
    // Find closest line
    let best = null
    let bestDist = Infinity
    for (const k of Object.keys(modelProbabilities)) {
      const dist = Math.abs(Number(k) - Number(line))
      if (dist < bestDist) {
        best = modelProbabilities[k]
        bestDist = dist
      }
    }
    return best
  }
  return null
}

function normalizeMarket(m) {
  const line = Number(m.floor_strike ?? m.strike ?? m.cap_strike)
  // API returns prices as dollar strings ("0.4700") in *_dollars fields.
  // Normalise to integer cents (0-100) for backward compat with placeOrder
  // and edge calculations; also expose raw dollar floats for display.
  const parseCents = v => {
    if (v == null) return undefined
    const n = typeof v === 'string' ? parseFloat(v) : v
    return Number.isFinite(n) ? Math.round(n * 100) : undefined
  }
  const yes_ask = m.yes_ask   != null ? m.yes_ask   : parseCents(m.yes_ask_dollars)
  const no_ask  = m.no_ask    != null ? m.no_ask    : parseCents(m.no_ask_dollars)
  const yes_bid = m.yes_bid   != null ? m.yes_bid   : parseCents(m.yes_bid_dollars)
  const no_bid  = m.no_bid    != null ? m.no_bid    : parseCents(m.no_bid_dollars)
  const volume        = m.volume_fp        != null ? Number(m.volume_fp)        : (m.volume        ?? null)
  const open_interest = m.open_interest_fp != null ? Number(m.open_interest_fp) : (m.open_interest ?? null)
  return {
    ticker: m.ticker,
    event_ticker: m.event_ticker,
    line,
    yes_ask,
    no_ask,
    yes_bid,
    no_bid,
    volume,
    open_interest,
    status: m.status,
    close_ts: m.close_time,
    raw: m,
  }
}

function buildEventTicker({ awayTeam, homeTeam, date, gameTime }) {
  const away = toKalshiAbbr(awayTeam)
  const home = toKalshiAbbr(homeTeam)
  const parts = toETDateParts(gameTime, date)
  if (!parts) return null
  const { yy, mmm, dd, hh, mi } = parts
  return `KXMLBTOTAL-${yy}${mmm}${dd}${hh}${mi}${away}${home}`
}

/**
 * Place an order. Kalshi POST /portfolio/orders expects:
 *   { action: 'buy'|'sell', side: 'yes'|'no', ticker, count, type, yes_price / no_price }
 * We only use limit orders (default `type: 'limit'`).
 *
 *   side: 'yes' | 'no'
 *   contracts: integer
 *   price: 0.01 - 0.99 (fraction) OR 1-99 (cents)
 */
export async function placeOrder(ticker, side, contracts, price, creds = {}) {
  if (!ticker) throw new Error('kalshi.placeOrder: ticker required')
  if (!['yes', 'no'].includes(side)) throw new Error('kalshi.placeOrder: side must be yes|no')
  if (!Number.isInteger(contracts) || contracts <= 0) {
    throw new Error('kalshi.placeOrder: contracts must be a positive integer')
  }
  // Normalise price to 1-99 cents
  let priceCents
  if (price < 1) priceCents = Math.round(price * 100)
  else priceCents = Math.round(price)
  if (priceCents < 1) priceCents = 1
  if (priceCents > 99) priceCents = 99

  const body = {
    action: 'buy',
    side,
    ticker,
    count: contracts,
    type: 'limit',
    client_order_id: `mlbie-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
  }
  if (side === 'yes') body.yes_price = priceCents
  else body.no_price = priceCents

  const data = await authedRequest('POST', '/portfolio/orders', body, null, creds)
  return data
}

/**
 * Get a single order by ID.
 * Returns the order object or null.
 */
export async function getOrder(orderId, creds = {}) {
  if (!orderId) return null
  const data = await authedRequest('GET', `/portfolio/orders/${orderId}`, null, null, creds)
  return data?.order ?? data ?? null
}

/**
 * Cancel an open order by ID.
 * Silently succeeds if the order is already filled or cancelled.
 */
export async function cancelOrder(orderId, creds = {}) {
  if (!orderId) return null
  try {
    const data = await authedRequest('DELETE', `/portfolio/orders/${orderId}`, null, null, creds)
    return data
  } catch (err) {
    // 404 = already filled/cancelled — not a real error
    if (err.message?.includes('404')) return null
    throw err
  }
}

/**
 * Portfolio positions.
 */
export async function getPortfolio() {
  const data = await authedRequest('GET', '/portfolio/positions')
  return data?.positions || []
}

/**
 * Single position for a ticker.
 */
export async function getPosition(ticker) {
  const positions = await getPortfolio()
  return positions.find(p => p.ticker === ticker) || null
}

/**
 * Fetch current bid/ask prices and depth for a market ticker.
 * Returns { price_over, price_under, bid, ask, depth_over, depth_under }
 * where price_over = mid-price of yes (over) contracts (0.0-1.0).
 */
export async function getMarketPrice(ticker) {
  try {
    const data = await authedRequest('GET', `/markets/${ticker}`)
    const mkt = data?.market || data
    if (!mkt) return null
    // API returns prices as dollar strings (*_dollars) or integer cents (*_bid/*_ask).
    // Normalise everything to 0.0-1.0 fractions.
    const parseFrac = (cents, dolStr, fallback) => {
      if (cents != null) return cents / 100
      if (dolStr != null) return parseFloat(dolStr)
      return fallback / 100
    }
    const lastCents = mkt.last_price_dollars != null
      ? Math.round(parseFloat(mkt.last_price_dollars) * 100)
      : (mkt.last_price ?? 50)
    const yes_bid = parseFrac(mkt.yes_bid, mkt.yes_bid_dollars, lastCents)
    const yes_ask = parseFrac(mkt.yes_ask, mkt.yes_ask_dollars, lastCents)
    const no_bid  = parseFrac(mkt.no_bid,  mkt.no_bid_dollars,  100 - lastCents)
    const no_ask  = parseFrac(mkt.no_ask,  mkt.no_ask_dollars,  100 - lastCents)
    const volume  = mkt.volume_fp != null ? Number(mkt.volume_fp) : (mkt.volume ?? null)
    return {
      ticker,
      price_over:  (yes_bid + yes_ask) / 2,
      price_under: (no_bid + no_ask) / 2,
      bid: yes_bid,
      ask: yes_ask,
      depth_over_contracts:  volume,
      depth_under_contracts: volume,
    }
  } catch {
    return null
  }
}

// ------------------------------------------------------------------
// F5 (first 5 innings total runs) — series KXMLBF5TOTAL
//
// Event ticker: KXMLBF5TOTAL-{YY}{MMM}{DD}{HHMM}{AWAY}{HOME}
// Market tickers: same event + "-{IDX}" where IDX is a sequential integer
//   (Kalshi internal index, NOT the line value).
// Line values (floor_strike): 0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5
// Always use floor_strike from the API response — do not derive from IDX.
// ------------------------------------------------------------------

function buildF5EventTicker({ awayTeam, homeTeam, date, gameTime }) {
  const away = toKalshiAbbr(awayTeam)
  const home = toKalshiAbbr(homeTeam)
  const parts = toETDateParts(gameTime, date)
  if (!parts) return null
  const { yy, mmm, dd, hh, mi } = parts
  return `KXMLBF5TOTAL-${yy}${mmm}${dd}${hh}${mi}${away}${home}`
}

/**
 * Find the F5-total market for a specific line.
 * line: a run total (e.g. 4.5) — matched against floor_strike.
 * Returns normalized market record or null.
 */
export async function findF5Market(awayTeam, homeTeam, date, line, gameTime) {
  const eventTicker = buildF5EventTicker({ awayTeam, homeTeam, date, gameTime })
  if (!eventTicker) return null
  const res = await listMarkets({ eventTicker, seriesTicker: 'KXMLBF5TOTAL' })
  const markets = res?.markets || []
  const want = Math.round(Number(line) * 10) / 10
  for (const m of markets) {
    const floor = Number(m.floor_strike ?? m.strike ?? m.cap_strike)
    if (!Number.isFinite(floor)) continue
    if (Math.abs(floor - want) < 0.01) return normalizeMarket(m)
  }
  return null
}

/**
 * Scan all F5-total lines for a game and return the market with highest
 * edge given our model's P(over in first 5).
 * modelProbabilities: number (P(over)) or map { line -> P(over) }.
 */
export async function findBestF5Market(awayTeam, homeTeam, date, modelProbabilities, gameTime) {
  const eventTicker = buildF5EventTicker({ awayTeam, homeTeam, date, gameTime })
  if (!eventTicker) return null
  const res = await listMarkets({ eventTicker, seriesTicker: 'KXMLBF5TOTAL' })
  const markets = (res?.markets || []).map(normalizeMarket)
  if (!markets.length) return null

  let best = null
  let bestEdge = 0
  for (const m of markets) {
    const overModelProb = resolveModelProb(modelProbabilities, m.line, markets)
    if (overModelProb == null) continue
    const yesPrice  = (m.yes_ask ?? 50) / 100
    const overEdge  = overModelProb - yesPrice
    const underEdge = (1 - overModelProb) - (m.no_ask ?? 50) / 100
    const edge = Math.max(overEdge, underEdge)
    if (edge > bestEdge) {
      bestEdge = edge
      best = {
        ...m,
        recommended_side: overEdge >= underEdge ? 'yes' : 'no',
        model_prob: overEdge >= underEdge ? overModelProb : 1 - overModelProb,
        implied_prob: overEdge >= underEdge ? yesPrice : (m.no_ask ?? 50) / 100,
        edge,
      }
    }
  }
  return best
}

/**
 * Fetch live price for an F5-total market by event (returns all lines for
 * a game). Useful for price collection without needing a specific line.
 * Returns array of normalized markets sorted by floor_strike ascending.
 */
export async function getF5MarketPrices(awayTeam, homeTeam, date, gameTime) {
  const eventTicker = buildF5EventTicker({ awayTeam, homeTeam, date, gameTime })
  if (!eventTicker) return []
  const res = await listMarkets({ eventTicker, seriesTicker: 'KXMLBF5TOTAL' })
  return (res?.markets || [])
    .map(normalizeMarket)
    .sort((a, b) => a.line - b.line)
}

// ===========================================================================
// NBA Totals helpers
// ===========================================================================

// Standard NBA team abbreviations used in Kalshi tickers
export const NBA_TEAM_TO_KALSHI = {
  ATL: 'ATL', BOS: 'BOS', BKN: 'BKN', CHA: 'CHA', CHI: 'CHI',
  CLE: 'CLE', DAL: 'DAL', DEN: 'DEN', DET: 'DET', GSW: 'GS',
  HOU: 'HOU', IND: 'IND', LAC: 'LAC', LAL: 'LAL', MEM: 'MEM',
  MIA: 'MIA', MIL: 'MIL', MIN: 'MIN', NOP: 'NO',  NYK: 'NYK',
  OKC: 'OKC', ORL: 'ORL', PHI: 'PHI', PHX: 'PHX', POR: 'POR',
  SAC: 'SAC', SAS: 'SAS', TOR: 'TOR', UTA: 'UTA', WSH: 'WSH',
  // Aliases
  GS: 'GS', NO: 'NO', NY: 'NYK',
}

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
      const suffix = e.event_ticker.slice(prefix.length) // e.g. 'DENMIN'
      return { eventTicker: e.event_ticker, matchupCode: suffix, title: e.title || '' }
    })
}
