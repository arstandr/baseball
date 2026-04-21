// pipeline/execute.js — trade execution for full-game totals on Kalshi.
//
// Paper mode (default): logs a trade row with mode='paper'; no external
// calls. Settlement happens later when `mlbie settle` runs.
//
// Live mode (EXECUTION_PLATFORM=kalshi): routes to the Kalshi REST adapter
// in `lib/kalshi.js`.

import * as db from '../lib/db.js'
import * as kalshi from '../lib/kalshi.js'
import { fetchGameResult } from '../lib/mlbapi.js'
import { alertTradeSignal, alertDailyReport } from '../lib/telegram.js'

const MODE_PAPER = 'paper'
const MODE_LIVE = 'live'

/**
 * Persist a trade row built from a Judge decision. Also alerts via Telegram.
 * Returns the new trades.id.
 */
export async function logTrade({ game, decision, mode = MODE_PAPER }) {
  if (decision.decision !== 'TRADE' || decision.position_size <= 0) return null
  const tradeId = await db.saveTrade({
    game_id: game.id,
    trade_date: game.date,
    mode,
    side: decision.recommended_side,
    line: decision.line,
    contract_price: decision.contract_price,
    contracts: Math.max(1, Math.round(decision.position_size / Math.max(0.01, decision.contract_price))),
    position_size_usd: decision.position_size,
    model_probability: decision.model_probability,
    market_implied_probability: decision.market_implied_probability,
    raw_edge: decision.raw_edge,
    adjusted_edge: decision.adjusted_edge,
    confidence_multiplier: decision.confidence_multiplier,
    bankroll_at_trade: decision.bankroll,
    primary_driver_agent: decision.agent_attribution?.primary_driver,
    agent_attribution_json: JSON.stringify(decision.agent_attribution),
    explanation: decision.explanation,
  })
  await alertTradeSignal({ game, decision })
  return tradeId
}

/**
 * Live execution dispatcher. Default platform is paper. Setting
 * EXECUTION_PLATFORM=kalshi routes through the real Kalshi REST adapter.
 */
export async function executeLive({ tradeId, game, decision }) {
  const platform = (process.env.EXECUTION_PLATFORM || 'paper').toLowerCase()
  if (platform === 'kalshi') return executeKalshi({ tradeId, game, decision })
  // Unknown / paper-only -> mark and skip
  await db.run(
    `UPDATE trades SET execution_confirmation = ?, executed_at = datetime('now') WHERE id = ?`,
    [`platform_not_live:${platform}`, tradeId],
  )
  return { ok: false, reason: 'platform_not_live' }
}

async function executeKalshi({ tradeId, game, decision }) {
  try {
    // 1. Find the best Kalshi market for this game at the decision's line.
    //    Kalshi side convention: YES = over, NO = under.
    const side = decision.recommended_side === 'OVER' ? 'yes' : 'no'

    let market = await kalshi.findMarket(
      game.team_away,
      game.team_home,
      game.date,
      decision.line,
      game.game_time,
    )

    // Fall back to best-edge market scan if exact line not available
    if (!market) {
      market = await kalshi.findBestMarket(
        game.team_away,
        game.team_home,
        game.date,
        decision.model_probability,
        game.game_time,
      )
      if (!market) {
        await db.run(
          `UPDATE trades SET execution_confirmation = ?, executed_at = datetime('now') WHERE id = ?`,
          [`kalshi:no_market_found`, tradeId],
        )
        return { ok: false, reason: 'no_market_found' }
      }
    }

    // 2. Decide fill price — use the ask of our chosen side (market order proxy)
    const priceCents = side === 'yes' ? market.yes_ask : market.no_ask
    if (priceCents == null) {
      await db.run(
        `UPDATE trades SET execution_confirmation = ?, executed_at = datetime('now') WHERE id = ?`,
        [`kalshi:no_ask_price`, tradeId],
      )
      return { ok: false, reason: 'no_ask_price' }
    }

    // 3. Place the order
    const contracts = Math.max(
      1,
      Math.round(decision.position_size / Math.max(0.01, priceCents / 100)),
    )
    const orderRes = await kalshi.placeOrder(market.ticker, side, contracts, priceCents)

    await db.run(
      `UPDATE trades SET
          kalshi_ticker = ?,
          kalshi_order_id = ?,
          execution_confirmation = ?,
          executed_at = datetime('now')
       WHERE id = ?`,
      [
        market.ticker,
        orderRes.order?.order_id || orderRes.order_id || null,
        `kalshi:filled:${orderRes.order?.status || 'submitted'}`,
        tradeId,
      ],
    )
    return { ok: true, ticker: market.ticker, order: orderRes, contracts, priceCents }
  } catch (err) {
    await db.run(
      `UPDATE trades SET execution_confirmation = ?, executed_at = datetime('now') WHERE id = ?`,
      [`kalshi:error:${(err.message || '').slice(0, 180)}`, tradeId],
    )
    return { ok: false, reason: 'kalshi_error', error: err.message }
  }
}

/**
 * Settle outcomes — pull full-game results for every trade without an outcome row.
 */
export async function settlePending() {
  const open = await db.getOpenTrades()
  const settled = []
  for (const trade of open) {
    const game = await db.getGame(trade.game_id)
    if (!game) continue
    const result = await fetchGameResult(game.id).catch(() => null)
    if (!result || result.actual_runs_total == null) continue
    const actualTotal = result.actual_runs_total
    const line = trade.line
    let outcome = 'PUSH'
    if (actualTotal > line) outcome = trade.side === 'OVER' ? 'WIN' : 'LOSS'
    else if (actualTotal < line) outcome = trade.side === 'OVER' ? 'LOSS' : 'WIN'
    const pnl = computePnL(trade, outcome)
    await db.saveOutcome({
      trade_id: trade.id,
      game_id: trade.game_id,
      actual_runs_total: actualTotal,
      line,
      result: outcome,
      pnl_usd: pnl,
      settled_at: new Date().toISOString(),
    })
    // Also populate the games table actuals so lineup agent can read them
    await db.run(
      `UPDATE games SET actual_runs_home = ?, actual_runs_away = ?, actual_runs_total = ?,
                        status = 'final', updated_at = datetime('now')
       WHERE id = ?`,
      [result.actual_runs_home, result.actual_runs_away, actualTotal, trade.game_id],
    )
    settled.push({ trade_id: trade.id, outcome, pnl })
  }
  return settled
}

function computePnL(trade, outcome) {
  if (outcome === 'PUSH' || outcome === 'VOID') return 0
  const stake = trade.position_size_usd || 0
  const price = trade.contract_price || 0.5
  if (outcome === 'WIN') {
    // Kalshi-style: you paid `price` per contract, you get $1 on win.
    return Number((stake * (1 / Math.max(price, 0.01) - 1)).toFixed(2))
  }
  return Number((-stake).toFixed(2))
}

/**
 * Daily P&L report for a given mode.
 */
export async function buildDailyReport({ date, mode = MODE_PAPER } = {}) {
  const actualDate = date || new Date().toISOString().slice(0, 10)
  const row = await db.getPnLSince(actualDate, mode)
  const report = {
    date: actualDate,
    mode,
    n: row?.n || 0,
    wins: row?.wins || 0,
    losses: row?.losses || 0,
    pushes: row?.pushes || 0,
    pnl: row?.pnl || 0,
  }
  await alertDailyReport(report)
  return report
}

export { MODE_PAPER, MODE_LIVE }
