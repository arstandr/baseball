// server/api.js — JSON endpoints for the MLBIE dashboard.
//
// Every route reads from the same Turso/libSQL database the CLI writes to
// (lib/db.js). All routes require auth (mount under requireAuth in index.js).
// All routes handle an empty DB gracefully — return [] / zeros, never 500.
//
// Agent outputs in `agent_outputs.output_json` are JSON strings; we parse
// them before returning. Calibration and agent-accuracy stats are computed
// server-side from the `projections` + `outcomes` + `agent_outputs` joins.

import express from 'express'
import * as db from '../lib/db.js'
import { getBalance as getKalshiBalance } from '../lib/kalshi.js'

// Optional modules — loaded dynamically so server starts even if files are missing
let computeModeSummary, computeCalibration, computeBankrollRollup, runningBankroll
let mlbFetch, extractStarterFromBoxscore
try {
  const analytics = await import('../lib/analytics.js')
  computeModeSummary   = analytics.computeModeSummary
  computeCalibration   = analytics.computeCalibration
  computeBankrollRollup = analytics.computeBankrollRollup
  runningBankroll      = analytics.runningBankroll
} catch { /* routes using these will return empty gracefully */ }
try {
  const mlbLive = await import('../lib/mlb-live.js')
  mlbFetch                = mlbLive.mlbFetch
  extractStarterFromBoxscore = mlbLive.extractStarterFromBoxscore
} catch { /* live polling gracefully degrades */ }

const router = express.Router()
const SERVER_START = new Date().toISOString()

// ------------------------------------------------------------------
// SSE: push state changes to all connected browser clients
// ------------------------------------------------------------------
const _sseClients = new Set()
let _sseState = { settledCount: -1, liveBetCount: -1, lastSettledAt: null, lastLoggedAt: null }
let _lastDataUpdate = null

function _broadcastSSE(type, data = {}) {
  const msg = `data: ${JSON.stringify({ type, ...data })}\n\n`
  for (const client of [..._sseClients]) {
    try { client.write(msg) } catch { _sseClients.delete(client) }
  }
}

// Poll DB every 10s; push diffs to connected clients
setInterval(async () => {
  if (!_sseClients.size) return
  try {
    const today = todayISO()
    const [settlRow, liveRow] = await Promise.all([
      db.one(`SELECT COUNT(*) as n, MAX(settled_at) as last_settled, MAX(logged_at) as last_logged
               FROM ks_bets WHERE bet_date=?`, [today]),
      db.one(`SELECT COUNT(*) as n FROM ks_bets WHERE bet_date=? AND live_bet=1`, [today]),
    ])
    const newSettled    = settlRow?.n ?? 0
    const newLive       = liveRow?.n ?? 0
    const newLastSettled = settlRow?.last_settled ?? null
    const newLastLogged  = settlRow?.last_logged ?? null

    // Track "last data update" as the most recent write to today's bets
    const newDataUpdate = [newLastSettled, newLastLogged].filter(Boolean).sort().pop() ?? null
    if (newDataUpdate && newDataUpdate !== _lastDataUpdate) {
      _lastDataUpdate = newDataUpdate
    }

    if (newSettled !== _sseState.settledCount || newLastSettled !== _sseState.lastSettledAt) {
      _broadcastSSE('settled', { count: newSettled, lastSettledAt: newLastSettled, lastDataUpdate: _lastDataUpdate })
      _sseState.settledCount  = newSettled
      _sseState.lastSettledAt = newLastSettled
    }
    if (newLive !== _sseState.liveBetCount || newLastLogged !== _sseState.lastLoggedAt) {
      _broadcastSSE('live_bet', { count: newLive, lastDataUpdate: _lastDataUpdate })
      _sseState.liveBetCount  = newLive
      _sseState.lastLoggedAt  = newLastLogged
    }
  } catch { /* ignore DB errors */ }
}, 10_000)

function safeJson(str, fallback = null) {
  if (str == null) return fallback
  try { return JSON.parse(str) } catch { return fallback }
}
function todayISO() { return new Date().toISOString().slice(0, 10) }
function roundTo(n, d = 4) {
  if (n == null || Number.isNaN(n)) return 0
  return Math.round(n * 10 ** d) / 10 ** d
}
function winRate(wins, losses) {
  const d = (wins || 0) + (losses || 0)
  return d > 0 ? (wins || 0) / d : 0
}
function fmtShort(d) {
  const m = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  return `${m[d.getUTCMonth()]} ${d.getUTCDate()}`
}

// Returns SQL fragment + args to scope ks_bets to a user.
// Honors ?user_id= override (for bettor drawer — viewing another user's bets).
function userFilter(req) {
  const override = req.query?.user_id ? Number(req.query.user_id) : null
  const uid = override || (req.session?.user?.id ?? null)
  if (uid == null) return { clause: '', args: [] }
  return { clause: `AND user_id = ?`, args: [uid] }
}

// Wrap an async handler so unhandled errors become a 500 with a safe JSON body.
function wrap(fn) {
  return async (req, res) => {
    try {
      await fn(req, res)
    } catch (err) {
      console.error(`[api] ${req.method} ${req.path} failed:`, err.stack || err.message)
      res.status(500).json({ error: 'internal_error', message: err.message })
    }
  }
}

// ------------------------------------------------------------------
// GET /api/summary
// Returns both paper and live top-line stats in a single call so the
// dashboard can render its stat-card rows without fanning out.
// ------------------------------------------------------------------
router.get('/summary', wrap(async (req, res) => {
  // Count every Judge output ever written — "signals evaluated".
  const judgeRows = await db.all(
    `SELECT output_json FROM agent_outputs WHERE agent = 'judge'`,
  )
  let tradeSignals = 0, rejectSignals = 0, edgeSum = 0, edgeN = 0
  for (const r of judgeRows) {
    const j = safeJson(r.output_json)
    if (!j) continue
    if (j.decision === 'TRADE') {
      tradeSignals += 1
      if (typeof j.adjusted_edge === 'number') {
        edgeSum += j.adjusted_edge; edgeN += 1
      }
    } else if (j.decision === 'REJECT') {
      rejectSignals += 1
    }
  }

  const paper = await computeModeSummary('paper')
  const live = await computeModeSummary('live')

  // Calibration cells (predicted vs actual hit rate by probability band).
  paper.calibration = await computeCalibration('paper')

  // Live bankroll rollups.
  const liveBankroll = await computeBankrollRollup()
  Object.assign(live, liveBankroll)

  res.json({
    signalsEvaluated: tradeSignals + rejectSignals,
    tradeSignals,
    rejectSignals,
    avgEdgeAllSignals: edgeN ? roundTo(edgeSum / edgeN, 4) : 0,
    paper,
    live,
  })
}))


// ------------------------------------------------------------------
// GET /api/games/dates?mode=paper|live
// Distinct dates that have any Judge output (paper) or any trade (live).
// Descending so the UI's date pills land on today first.
// ------------------------------------------------------------------
router.get('/games/dates', wrap(async (req, res) => {
  const mode = req.query.mode === 'live' ? 'live' : 'paper'
  if (mode === 'live') {
    const rows = await db.all(
      `SELECT DISTINCT trade_date AS date FROM trades WHERE mode = 'live' ORDER BY trade_date DESC`,
    )
    return res.json(rows.map(r => r.date).filter(Boolean))
  }
  // Paper: any game that has a judge output counts, falling back to games table.
  const rows = await db.all(
    `SELECT DISTINCT g.date AS date FROM games g
     INNER JOIN agent_outputs a ON a.game_id = g.id AND a.agent = 'judge'
     ORDER BY g.date DESC`,
  )
  res.json(rows.map(r => r.date).filter(Boolean))
}))

// ------------------------------------------------------------------
// GET /api/games?date=YYYY-MM-DD&mode=paper|live
// Hydrated per-game cards: teams, venue, decision, trade details, all agent
// outputs, outcome (if settled).
// ------------------------------------------------------------------
router.get('/games', wrap(async (req, res) => {
  const date = req.query.date && req.query.date !== 'today' ? req.query.date : todayISO()
  const mode = req.query.mode === 'live' ? 'live' : 'paper'

  const games = await db.getGamesByDate(date)
  if (!games.length) return res.json([])

  const ids = games.map(g => g.id)
  const placeholders = ids.map(() => '?').join(',')

  const [agentRows, tradeRows, outcomeRows, venueRows] = await Promise.all([
    db.all(`SELECT game_id, agent, output_json FROM agent_outputs WHERE game_id IN (${placeholders})`, ids),
    db.all(
      `SELECT * FROM trades WHERE mode = ? AND game_id IN (${placeholders}) ORDER BY id ASC`,
      [mode, ...ids],
    ),
    db.all(
      `SELECT o.* FROM outcomes o
       INNER JOIN trades t ON t.id = o.trade_id
       WHERE t.mode = ? AND o.game_id IN (${placeholders})`,
      [mode, ...ids],
    ),
    db.all(`SELECT id, name FROM venues WHERE id IN (${placeholders})`, games.map(g => g.venue_id)),
  ])

  const agentsByGame = {}
  for (const r of agentRows) {
    (agentsByGame[r.game_id] ||= {})[r.agent] = safeJson(r.output_json)
  }
  const tradeByGame = {}
  for (const t of tradeRows) tradeByGame[t.game_id] = t   // one trade per game per mode
  const outcomeByTrade = {}
  for (const o of outcomeRows) outcomeByTrade[o.trade_id] = o
  const venueNameById = Object.fromEntries(venueRows.map(v => [v.id, v.name]))

  const out = games.map(g => {
    const agents = agentsByGame[g.id] || {}
    const judge = agents.judge || null
    const trade = tradeByGame[g.id] || null
    const outcome = trade ? outcomeByTrade[trade.id] || null : null

    return {
      game_id: g.id,
      date: g.date,
      game_time: g.game_time,
      status: g.status,
      teams: `${g.team_away} @ ${g.team_home}`,
      team_home: g.team_home,
      team_away: g.team_away,
      venue_id: g.venue_id,
      venue: venueNameById[g.venue_id] || g.venue_id,
      f5_line_open: g.f5_line_open,
      f5_line_current: g.f5_line_current,
      actual_f5_total: g.actual_f5_total,
      // Judge-sourced fields (may be null if signal run hasn't happened)
      decision: judge?.decision || null,
      rejection_reason: judge?.rejection_reason || null,
      side: judge?.recommended_side || null,
      line: judge?.line ?? g.f5_line_current ?? null,
      edge: judge?.adjusted_edge ?? null,
      raw_edge: judge?.raw_edge ?? null,
      modelProb: judge?.model_probability ?? null,
      marketProb: judge?.market_implied_probability ?? null,
      confidence: judge?.confidence_multiplier ?? null,
      explanation: judge?.explanation || null,
      agent_attribution: judge?.agent_attribution || null,
      agentOutputs: {
        scout: agents.scout || null,
        lineup: agents.lineup || null,
        park: agents.park || null,
        storm: agents.storm || null,
        market: agents.market || null,
        judge: agents.judge || null,
      },
      trade: trade ? {
        id: trade.id,
        mode: trade.mode,
        side: trade.side,
        line: trade.line,
        contract_price: trade.contract_price,
        contracts: trade.contracts,
        size: trade.position_size_usd,
        executed_at: trade.executed_at,
      } : null,
      outcome: outcome ? {
        result: outcome.result,
        pnl: outcome.pnl_usd,
        actualF5: outcome.actual_f5_total,
        settled_at: outcome.settled_at,
      } : null,
    }
  })

  res.json(out)
}))

// ------------------------------------------------------------------
// GET /api/game/:game_id — full detail (parsed agent JSON).
// ------------------------------------------------------------------
router.get('/game/:game_id', wrap(async (req, res) => {
  const g = await db.getGame(req.params.game_id)
  if (!g) return res.status(404).json({ error: 'game_not_found' })
  const [agentRows, projection, trade, venue] = await Promise.all([
    db.all(`SELECT agent, output_json FROM agent_outputs WHERE game_id = ?`, [g.id]),
    db.one(
      `SELECT * FROM projections WHERE game_id = ? ORDER BY created_at DESC LIMIT 1`,
      [g.id],
    ),
    db.one(
      `SELECT * FROM trades WHERE game_id = ? ORDER BY id DESC LIMIT 1`,
      [g.id],
    ),
    db.getVenue(g.venue_id),
  ])
  const agents = {}
  for (const r of agentRows) agents[r.agent] = safeJson(r.output_json)

  let outcome = null
  if (trade) {
    outcome = await db.one(`SELECT * FROM outcomes WHERE trade_id = ?`, [trade.id])
  }
  res.json({
    game: g,
    venue,
    agents,
    projection: projection ? {
      ...projection,
      feature_vector: safeJson(projection.feature_vector_json, {}),
      shap_values: safeJson(projection.shap_values_json, {}),
    } : null,
    trade,
    outcome,
  })
}))

// ------------------------------------------------------------------
// GET /api/trades?mode=paper|live&limit=50
// Recent trades joined with outcomes + primary driver.
// ------------------------------------------------------------------
router.get('/trades', wrap(async (req, res) => {
  const mode = req.query.mode === 'live' ? 'live' : 'paper'
  const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 50))
  const rows = await db.all(
    `SELECT t.*, o.result, o.pnl_usd, o.actual_f5_total, o.settled_at,
            g.team_home, g.team_away, g.game_time
     FROM trades t
     LEFT JOIN outcomes o ON o.trade_id = t.id
     LEFT JOIN games g ON g.id = t.game_id
     WHERE t.mode = ?
     ORDER BY t.created_at DESC
     LIMIT ?`,
    [mode, limit],
  )
  const out = rows.map(r => ({
    id: r.id,
    game_id: r.game_id,
    trade_date: r.trade_date,
    teams: r.team_home ? `${r.team_away} @ ${r.team_home}` : null,
    game_time: r.game_time,
    side: r.side,
    line: r.line,
    contract_price: r.contract_price,
    size: r.position_size_usd,
    edge: r.adjusted_edge,
    modelProb: r.model_probability,
    marketProb: r.market_implied_probability,
    confidence: r.confidence_multiplier,
    driver: r.primary_driver_agent,
    explanation: r.explanation,
    result: r.result,
    pnl: r.pnl_usd,
    actualF5: r.actual_f5_total,
    settled_at: r.settled_at,
  }))
  res.json(out)
}))

// ------------------------------------------------------------------
// GET /api/calibration?mode=paper|live
// ------------------------------------------------------------------
router.get('/calibration', wrap(async (req, res) => {
  const mode = req.query.mode === 'live' ? 'live' : 'paper'
  res.json(await computeCalibration(mode))
}))

// ------------------------------------------------------------------
// GET /api/agents/accuracy?mode=paper|live
// Directional accuracy per agent, computed server-side.
//
// Logic:
//   A trade settles WIN or LOSS with a known side (OVER/UNDER).
//   For each of the 6 agents we ask: "Did this agent's signal point in
//   the correct direction?" Correct direction means:
//
//     SCOUT:  quality_score (avg of home+away) > 4.0 → leans UNDER
//             (strong arms suppress runs). < 3.0 → leans OVER.
//             Directional-correct = (lean matches the winning side).
//
//     LINEUP: offensive_rating (avg of home+away) > 100 → leans OVER.
//             < 100 → leans UNDER. Match vs winning side.
//
//     PARK:   f5_factor > 1.0 → leans OVER.  < 1.0 → leans UNDER.
//
//     STORM:  weather_score > 0.1 → leans OVER.
//             < -0.1 → leans UNDER. (~0 is neutral.)
//
//     MARKET: synthesis.recommendation: 'proceed' agrees with the trade's
//             chosen side (market said "trust the model"), 'caution'/'reject'
//             disagrees. So correctness = (recommendation === 'proceed' AND
//             trade won) OR (recommendation !== 'proceed' AND trade lost).
//
//     JUDGE:  The judge made the decision — it's "correct" whenever the
//             trade won. (Useful as a sanity floor for the cohort.)
//
// "Neutral" leans (no clear signal) count as undetermined and are excluded
// from the agent's n. PUSH trades are excluded from every agent.
// ------------------------------------------------------------------
router.get('/agents/accuracy', wrap(async (req, res) => {
  const mode = req.query.mode === 'live' ? 'live' : 'paper'
  const trades = await db.all(
    `SELECT t.game_id, t.side, o.result
     FROM trades t INNER JOIN outcomes o ON o.trade_id = t.id
     WHERE t.mode = ? AND o.result IN ('WIN','LOSS')`,
    [mode],
  )
  if (!trades.length) {
    return res.json(['scout', 'lineup', 'park', 'storm', 'market', 'judge']
      .map(a => ({ agent: a, directionallyCorrect: 0, n: 0 })))
  }

  const ids = [...new Set(trades.map(t => t.game_id))]
  const placeholders = ids.map(() => '?').join(',')
  const rows = await db.all(
    `SELECT game_id, agent, output_json FROM agent_outputs WHERE game_id IN (${placeholders})`,
    ids,
  )
  const byGame = {}
  for (const r of rows) (byGame[r.game_id] ||= {})[r.agent] = safeJson(r.output_json)

  const tally = {
    scout:  { correct: 0, n: 0 },
    lineup: { correct: 0, n: 0 },
    park:   { correct: 0, n: 0 },
    storm:  { correct: 0, n: 0 },
    market: { correct: 0, n: 0 },
    judge:  { correct: 0, n: 0 },
  }

  for (const t of trades) {
    const ag = byGame[t.game_id] || {}
    const winSide = t.result === 'WIN' ? t.side : (t.side === 'OVER' ? 'UNDER' : 'OVER')

    // --- SCOUT ---
    if (ag.scout) {
      const h = ag.scout.pitcher_home?.quality_score
      const a = ag.scout.pitcher_away?.quality_score
      if (typeof h === 'number' && typeof a === 'number') {
        const avg = (h + a) / 2
        let lean = null
        if (avg > 4.0) lean = 'UNDER'
        else if (avg < 3.0) lean = 'OVER'
        if (lean) {
          tally.scout.n += 1
          if (lean === winSide) tally.scout.correct += 1
        }
      }
    }
    // --- LINEUP ---
    if (ag.lineup) {
      const h = ag.lineup.lineup_home?.offensive_rating
      const a = ag.lineup.lineup_away?.offensive_rating
      if (typeof h === 'number' && typeof a === 'number') {
        const avg = (h + a) / 2
        let lean = null
        if (avg > 103) lean = 'OVER'
        else if (avg < 97) lean = 'UNDER'
        if (lean) {
          tally.lineup.n += 1
          if (lean === winSide) tally.lineup.correct += 1
        }
      }
    }
    // --- PARK ---
    if (ag.park) {
      const f = ag.park.f5_factor ?? ag.park.run_factor
      if (typeof f === 'number') {
        let lean = null
        if (f > 1.03) lean = 'OVER'
        else if (f < 0.97) lean = 'UNDER'
        if (lean) {
          tally.park.n += 1
          if (lean === winSide) tally.park.correct += 1
        }
      }
    }
    // --- STORM ---
    if (ag.storm) {
      const ws = ag.storm.weather_score
      if (typeof ws === 'number') {
        let lean = null
        if (ws > 0.1) lean = 'OVER'
        else if (ws < -0.1) lean = 'UNDER'
        if (lean) {
          tally.storm.n += 1
          if (lean === winSide) tally.storm.correct += 1
        }
      }
    }
    // --- MARKET ---
    if (ag.market) {
      const rec = ag.market.synthesis?.recommendation
      if (rec) {
        tally.market.n += 1
        const agreed = rec === 'proceed'
        const tradeWon = t.result === 'WIN'
        if (agreed === tradeWon) tally.market.correct += 1
      }
    }
    // --- JUDGE --- (pulled the trigger — did the bet win?)
    tally.judge.n += 1
    if (t.result === 'WIN') tally.judge.correct += 1
  }

  const out = Object.entries(tally).map(([agent, v]) => ({
    agent,
    directionallyCorrect: v.n > 0 ? roundTo(v.correct / v.n, 4) : 0,
    n: v.n,
  }))
  res.json(out)
}))

// ------------------------------------------------------------------
// GET /api/performance/weekly?mode=paper|live
// ------------------------------------------------------------------
router.get('/performance/weekly', wrap(async (req, res) => {
  const mode = req.query.mode === 'live' ? 'live' : 'paper'
  const rows = await db.all(
    `SELECT t.trade_date, t.position_size_usd, o.result, o.pnl_usd
     FROM trades t LEFT JOIN outcomes o ON o.trade_id = t.id
     WHERE t.mode = ? ORDER BY t.trade_date ASC`,
    [mode],
  )
  if (!rows.length) return res.json([])

  // Group by ISO week (Mon-Sun).
  const weeks = {}
  for (const r of rows) {
    const d = new Date(r.trade_date + 'T12:00:00Z')
    const dow = (d.getUTCDay() + 6) % 7 // Mon=0
    const monday = new Date(d); monday.setUTCDate(d.getUTCDate() - dow)
    const sunday = new Date(monday); sunday.setUTCDate(monday.getUTCDate() + 6)
    const key = monday.toISOString().slice(0, 10)
    const label = `${fmtShort(monday)}-${fmtShort(sunday)}`
    const w = (weeks[key] ||= { week: label, start: key, trades: 0, wins: 0, losses: 0, pnl: 0, wagered: 0 })
    w.trades += 1
    w.wagered += Number(r.position_size_usd || 0)
    if (r.result === 'WIN') w.wins += 1
    else if (r.result === 'LOSS') w.losses += 1
    w.pnl += Number(r.pnl_usd || 0)
  }
  const sorted = Object.values(weeks).sort((a, b) => a.start.localeCompare(b.start))
  res.json(sorted.map(w => ({
    week: w.week,
    trades: w.trades,
    wins: w.wins,
    losses: w.losses,
    pnl: roundTo(w.pnl, 2),
    roi: w.wagered > 0 ? roundTo(w.pnl / w.wagered, 4) : 0,
  })))
}))


// ------------------------------------------------------------------
// GET /api/performance/monthly?mode=paper|live
// ------------------------------------------------------------------
router.get('/performance/monthly', wrap(async (req, res) => {
  const mode = req.query.mode === 'live' ? 'live' : 'paper'
  const rows = await db.all(
    `SELECT substr(t.trade_date,1,7) AS ym,
            COUNT(*)                                             AS trades,
            SUM(CASE WHEN o.result = 'WIN'  THEN 1 ELSE 0 END)   AS wins,
            SUM(CASE WHEN o.result = 'LOSS' THEN 1 ELSE 0 END)   AS losses,
            SUM(COALESCE(o.pnl_usd,0))                           AS pnl,
            SUM(t.position_size_usd)                             AS wagered
     FROM trades t LEFT JOIN outcomes o ON o.trade_id = t.id
     WHERE t.mode = ?
     GROUP BY ym
     ORDER BY ym ASC`,
    [mode],
  )
  const m = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  res.json(rows.map(r => {
    const [y, mo] = String(r.ym).split('-')
    const label = `${m[Number(mo) - 1] || mo} ${y}`
    const wins = Number(r.wins || 0)
    const losses = Number(r.losses || 0)
    const pnl = Number(r.pnl || 0)
    const wagered = Number(r.wagered || 0)
    return {
      month: label,
      trades: Number(r.trades || 0),
      wins, losses,
      winRate: roundTo(winRate(wins, losses), 4),
      pnl: roundTo(pnl, 2),
      roi: wagered > 0 ? roundTo(pnl / wagered, 4) : 0,
    }
  }))
}))

// ------------------------------------------------------------------
// GET /api/bankroll/history?mode=live
// One point per day: running bankroll + daily P&L.
// ------------------------------------------------------------------
router.get('/bankroll/history', wrap(async (req, res) => {
  const mode = req.query.mode === 'live' ? 'live' : 'paper'
  const startBankroll = Number(process.env.BANKROLL || 5000)
  const rows = await db.all(
    `SELECT t.trade_date, SUM(COALESCE(o.pnl_usd,0)) AS pnl
     FROM trades t INNER JOIN outcomes o ON o.trade_id = t.id
     WHERE t.mode = ?
     GROUP BY t.trade_date
     ORDER BY t.trade_date ASC`,
    [mode],
  )
  if (!rows.length) return res.json([])
  let running = startBankroll
  const series = []
  for (const r of rows) {
    const pnl = Number(r.pnl || 0)
    running += pnl
    series.push({
      date: r.trade_date,
      bankroll: roundTo(running, 2),
      pnl: roundTo(pnl, 2),
    })
  }
  res.json(series)
}))

// ------------------------------------------------------------------
// GET /api/backtest/models
// All trained model versions with key metrics.
// ------------------------------------------------------------------
router.get('/backtest/models', wrap(async (req, res) => {
  const rows = await db.all(
    `SELECT id, trained_at, train_seasons, model_type, brier_score, auc_roc,
            val_win_rate_55, val_win_rate_60, val_roi_gross, val_roi_net,
            is_active, feature_importance_json, calibration_json, ablation_json
     FROM model_versions ORDER BY trained_at DESC`,
  )
  res.json(rows.map(r => ({
    id: r.id,
    trained_at: r.trained_at,
    train_seasons: r.train_seasons,
    model_type: r.model_type || 'binary_classifier',
    brier_score: r.brier_score,
    auc_roc: r.auc_roc,
    val_win_rate_55: r.val_win_rate_55,
    val_win_rate_60: r.val_win_rate_60,
    val_roi_gross: r.val_roi_gross,
    val_roi_net: r.val_roi_net,
    is_active: r.is_active === 1,
    feature_importance: safeJson(r.feature_importance_json, []),
    calibration: safeJson(r.calibration_json, []),
    ablation: safeJson(r.ablation_json, []),
  })))
}))

// ------------------------------------------------------------------
// GET /api/backtest/summary
// Top-line numbers from the active model + historical game counts.
// ------------------------------------------------------------------
router.get('/backtest/summary', wrap(async (req, res) => {
  const model = await db.one(
    `SELECT * FROM model_versions WHERE is_active = 1 ORDER BY trained_at DESC LIMIT 1`,
  )
  const gameCounts = await db.all(
    `SELECT season, COUNT(*) as n FROM historical_games GROUP BY season ORDER BY season`,
  )
  const totalHistorical = gameCounts.reduce((s, r) => s + Number(r.n), 0)
  const hasMatrix = await db.one(
    `SELECT COUNT(*) as n FROM historical_games WHERE full_line_open IS NOT NULL`,
  ).catch(() => ({ n: 0 }))

  res.json({
    model: model ? {
      id: model.id,
      trained_at: model.trained_at,
      train_seasons: model.train_seasons,
      model_type: model.model_type || 'binary_classifier',
      brier_score: model.brier_score,
      auc_roc: model.auc_roc,
      val_win_rate_55: model.val_win_rate_55,
      val_win_rate_60: model.val_win_rate_60,
      val_roi_gross: model.val_roi_gross,
      val_roi_net: model.val_roi_net,
      feature_importance: safeJson(model.feature_importance_json, []).slice(0, 15),
      calibration: safeJson(model.calibration_json, []),
      ablation: safeJson(model.ablation_json, []),
    } : null,
    data: {
      historical_games: totalHistorical,
      games_with_lines: Number(hasMatrix?.n || 0),
      seasons: gameCounts.map(r => ({ season: r.season, games: r.n })),
    },
  })
}))

// ------------------------------------------------------------------
// GET /api/backtest/games?season=2025&page=1&limit=50
// Walk-forward backtest results — games with model predictions + outcomes.
// ------------------------------------------------------------------
router.get('/backtest/games', wrap(async (req, res) => {
  const season = req.query.season ? Number(req.query.season) : null
  const page = Math.max(1, Number(req.query.page || 1))
  const limit = Math.min(100, Number(req.query.limit || 50))
  const offset = (page - 1) * limit
  const sideFilter = req.query.side // OVER|UNDER|null
  const resultFilter = req.query.result // WIN|LOSS|PUSH|null

  let where = `hg.full_line_open IS NOT NULL`
  const params = []
  if (season) { where += ` AND hg.season = ?`; params.push(season) }

  const rows = await db.all(
    `SELECT hg.id, hg.date, hg.season, hg.team_home, hg.team_away,
            hg.full_line_open, hg.actual_runs_total,
            hg.home_pitcher_id, hg.away_pitcher_id,
            p.over_probability, p.projected_total, p.feature_vector_json, p.shap_values_json,
            p.model_version
     FROM historical_games hg
     LEFT JOIN projections p ON p.game_id = hg.id
     WHERE ${where}
     ORDER BY hg.date DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  )

  const total = await db.one(
    `SELECT COUNT(*) as n FROM historical_games hg WHERE ${where}`,
    params,
  )

  const games = rows.map(r => {
    const prob = r.over_probability
    const line = r.full_line_open
    const actual = r.actual_runs_total
    const side = prob != null ? (prob >= 0.5 ? 'OVER' : 'UNDER') : null
    let result = null
    if (actual != null && line != null && side) {
      if (actual > line) result = side === 'OVER' ? 'WIN' : 'LOSS'
      else if (actual < line) result = side === 'UNDER' ? 'WIN' : 'LOSS'
      else result = 'PUSH'
    }
    return {
      id: r.id,
      date: r.date,
      season: r.season,
      teams: `${r.team_away} @ ${r.team_home}`,
      line: line,
      actual: actual,
      over_probability: prob != null ? roundTo(prob, 4) : null,
      projected_total: r.projected_total,
      side,
      result,
      model_version: r.model_version,
    }
  }).filter(g => {
    if (sideFilter && g.side !== sideFilter) return false
    if (resultFilter && g.result !== resultFilter) return false
    return true
  })

  res.json({ games, total: Number(total?.n || 0), page, limit })
}))

// ------------------------------------------------------------------
// GET /api/backtest/performance?season=2025
// Aggregated walk-forward stats for a validation season.
// ------------------------------------------------------------------
router.get('/backtest/performance', wrap(async (req, res) => {
  const seasons = req.query.season
    ? [Number(req.query.season)]
    : [2023, 2024, 2025]

  const results = []
  for (const season of seasons) {
    const rows = await db.all(
      `SELECT hg.full_line_open, hg.actual_runs_total, p.over_probability
       FROM historical_games hg
       INNER JOIN projections p ON p.game_id = hg.id
       WHERE hg.season = ? AND hg.full_line_open IS NOT NULL AND hg.actual_runs_total IS NOT NULL`,
      [season],
    )

    if (!rows.length) { results.push({ season, n: 0 }); continue }

    let wins = 0, losses = 0, pushes = 0
    let wins55 = 0, n55 = 0, wins60 = 0, n60 = 0
    let wagered = 0, pnl = 0
    const BET = 100 // flat $100 simulation

    for (const r of rows) {
      const prob = Number(r.over_probability || 0.5)
      const line = Number(r.full_line_open)
      const actual = Number(r.actual_runs_total)
      const side = prob >= 0.5 ? 'OVER' : 'UNDER'
      const adjProb = side === 'OVER' ? prob : 1 - prob
      if (adjProb < 0.52) continue // below threshold — skip

      let result
      if (actual > line) result = side === 'OVER' ? 'WIN' : 'LOSS'
      else if (actual < line) result = side === 'UNDER' ? 'WIN' : 'LOSS'
      else result = 'PUSH'

      if (result === 'WIN') { wins++; wagered += BET; pnl += BET * 0.9 }
      else if (result === 'LOSS') { losses++; wagered += BET; pnl -= BET }
      else pushes++

      if (adjProb >= 0.55 && adjProb < 0.60) { n55++; if (result === 'WIN') wins55++ }
      if (adjProb >= 0.60) { n60++; if (result === 'WIN') wins60++ }
    }

    const total = wins + losses
    results.push({
      season,
      n: rows.length,
      traded: total,
      wins, losses, pushes,
      win_rate: total > 0 ? roundTo(wins / total, 4) : null,
      win_rate_55: n55 > 0 ? roundTo(wins55 / n55, 4) : null,
      n55,
      win_rate_60: n60 > 0 ? roundTo(wins60 / n60, 4) : null,
      n60,
      wagered: roundTo(wagered, 2),
      pnl: roundTo(pnl, 2),
      roi: wagered > 0 ? roundTo(pnl / wagered, 4) : null,
    })
  }

  res.json(results)
}))

// ------------------------------------------------------------------
// GET /api/backtest/convergence
// Convergence log stats — Kalshi price vs sportsbook at each window.
// ------------------------------------------------------------------
router.get('/backtest/convergence', wrap(async (req, res) => {
  const rows = await db.all(
    `SELECT COUNT(*) as n,
            AVG(ABS(kalshi_price_open - sportsbook_implied_open)) as avg_gap_open,
            AVG(ABS(kalshi_price_2hr - sportsbook_implied_2hr)) as avg_gap_2hr,
            AVG(ABS(kalshi_price_30min - sportsbook_implied_30min)) as avg_gap_30min,
            AVG(time_to_convergence_min) as avg_convergence_min
     FROM convergence_log
     WHERE kalshi_price_open IS NOT NULL`,
  )
  const recent = await db.all(
    `SELECT game_date, full_line, kalshi_price_open, sportsbook_implied_open,
            kalshi_price_2hr, sportsbook_implied_2hr,
            time_to_convergence_min, convergence_trigger
     FROM convergence_log
     ORDER BY game_date DESC LIMIT 20`,
  )
  res.json({
    summary: rows[0] || { n: 0 },
    recent,
  })
}))


// ------------------------------------------------------------------
// GET /api/ks/live?date=YYYY-MM-DD
// Real-time K counts + game state for pending bets.
// Called every 60 s by the dashboard during game hours.
// ------------------------------------------------------------------
router.get('/ks/live', wrap(async (req, res) => {
  const date = req.query.date || todayISO()

  const uf = userFilter(req)
  const pending = await db.all(
    `SELECT id, pitcher_id, pitcher_name, strike, side, market_mid, spread, bet_size
       FROM ks_bets WHERE bet_date = ? AND result IS NULL AND live_bet = 0 ${uf.clause}`,
    [date, ...uf.args],
  )
  if (!pending.length) return res.json({ date, has_live: false, pitchers: [] })

  const pitcherIds = new Set(pending.map(b => String(b.pitcher_id)).filter(Boolean))

  const sched = await mlbFetch(
    `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}&hydrate=linescore,probablePitcher`,
  )
  const games = sched?.dates?.[0]?.games || []

  const results = []

  for (const g of games) {
    const status = g.status?.abstractGameState   // Preview | Live | Final
    if (status === 'Preview') {
      // For pre-game: filter by probable pitcher to avoid unnecessary boxscore fetches
      const awayProb = String(g.teams?.away?.probablePitcher?.id || '')
      const homeProb = String(g.teams?.home?.probablePitcher?.id || '')
      if (!pitcherIds.has(awayProb) && !pitcherIds.has(homeProb)) continue
    }
    // For Live/Final: always check boxscore — MLB API often drops probablePitcher mid-game

    const gamePk = g.gamePk
    const bs     = await mlbFetch(`https://statsapi.mlb.com/api/v1/game/${gamePk}/boxscore`)
    if (!bs) continue

    const ls      = g.linescore
    const isFinal = status === 'Final'
    const detail  = g.status?.detailedState || status
    const inning  = isFinal ? 'Final' : (ls?.currentInningOrdinal || detail)
    const away    = g.teams?.away?.team?.abbreviation || 'AWAY'
    const home    = g.teams?.home?.team?.abbreviation || 'HOME'

    for (const side of ['home', 'away']) {
      const starter = extractStarterFromBoxscore(bs, side)
      if (!starter || !pitcherIds.has(starter.id)) continue

      const myBets = pending.filter(b => String(b.pitcher_id) === starter.id)

      // Auto-settle bets when game is final
      if (isFinal && myBets.length) {
        const FEE = 0.07
        const now = new Date().toISOString()
        for (const b of myBets) {
          const won  = b.side === 'YES' ? starter.ks >= b.strike : starter.ks < b.strike
          const mid  = (b.market_mid ?? 50) / 100
          const hs   = (b.spread ?? 4) / 200
          const fill = b.side === 'YES' ? mid + hs : (1 - mid) + hs
          const pnl  = won
            ? (b.bet_size ?? 100) * (1 - fill) * (1 - FEE)
            : -((b.bet_size ?? 100) * fill)
          await db.run(
            `UPDATE ks_bets SET actual_ks=?, result=?, settled_at=?, pnl=? WHERE id=? AND result IS NULL`,
            [starter.ks, won ? 'win' : 'loss', now, roundTo(pnl, 2), b.id],
          )
        }
      }

      results.push({
        pitcher_id:   starter.id,
        pitcher_name: starter.name,
        ks:           starter.ks,
        ip:           parseFloat(starter.ip.toFixed(1)),
        bf:           starter.bf,
        pitches:      starter.pitches,
        still_in:     starter.still_in,
        tto3:         starter.bf >= 18,
        game:         `${away}@${home}`,
        gamePk,
        game_status:  detail,
        inning,
        is_final:     isFinal,
        home_score:   ls?.teams?.home?.runs ?? null,
        away_score:   ls?.teams?.away?.runs ?? null,
        bet_statuses: myBets.map(b => ({
          id:     b.id,
          strike: b.strike,
          side:   b.side,
          ks:     starter.ks,
          needed: Math.max(0, b.strike - starter.ks),
        })),
      })
    }
  }

  res.json({ date, has_live: results.some(p => !p.is_final), pitchers: results })
}))

// ===========================================================================
// KS (Strikeout) betting routes — data from ks_bets + kalshi_ks_markets
// ===========================================================================

const STARTING_BANKROLL = Number(process.env.BANKROLL || 5000)


// ------------------------------------------------------------------
// GET /api/ks/balance
// Real Kalshi portfolio balance (what you could withdraw right now).
// ------------------------------------------------------------------
router.get('/ks/balance', wrap(async (req, res) => {
  try {
    const bal = await getKalshiBalance()
    res.json({ balance_cents: bal.balance_cents, balance_usd: bal.balance_usd })
  } catch (err) {
    res.status(502).json({ error: 'kalshi_unavailable', message: err.message })
  }
}))

// ------------------------------------------------------------------
// GET /api/ks/summary
// Today / week / month / YTD P&L + win rate + bankroll + pending count
// ------------------------------------------------------------------
router.get('/ks/summary', wrap(async (req, res) => {
  const today = todayISO()
  const now = new Date()
  const yearStart = `${now.getUTCFullYear()}-01-01`
  const weekAgo  = new Date(now.getTime() - 7  * 86400000).toISOString().slice(0, 10)
  const monthAgo = new Date(now.getTime() - 30 * 86400000).toISOString().slice(0, 10)

  const uf = userFilter(req)
  const [totals, pending, bankrollRow] = await Promise.all([
    db.one(`
      SELECT
        SUM(CASE WHEN bet_date = ?  AND result IS NOT NULL THEN COALESCE(pnl,0) ELSE 0 END) AS today_pnl,
        SUM(CASE WHEN bet_date >= ? AND result IS NOT NULL THEN COALESCE(pnl,0) ELSE 0 END) AS week_pnl,
        SUM(CASE WHEN bet_date >= ? AND result IS NOT NULL THEN COALESCE(pnl,0) ELSE 0 END) AS month_pnl,
        SUM(CASE WHEN bet_date >= ? AND result IS NOT NULL THEN COALESCE(pnl,0) ELSE 0 END) AS ytd_pnl,
        SUM(CASE WHEN result IS NOT NULL THEN COALESCE(pnl,0) ELSE 0 END)                   AS total_pnl,
        SUM(CASE WHEN result = 'win'  AND live_bet = 0 THEN 1 ELSE 0 END)                   AS wins,
        SUM(CASE WHEN result = 'loss' AND live_bet = 0 THEN 1 ELSE 0 END)                   AS losses,
        SUM(CASE WHEN live_bet = 0 AND result IS NOT NULL THEN 1 ELSE 0 END)                AS settled,
        COUNT(CASE WHEN live_bet = 0 THEN 1 END)                                            AS total_bets,
        AVG(CASE WHEN live_bet = 0 AND result IS NOT NULL THEN edge END)                    AS avg_edge
      FROM ks_bets
      WHERE live_bet = 0 AND paper = 0 ${uf.clause}
    `, [today, weekAgo, monthAgo, yearStart, ...uf.args]),
    db.one(`SELECT COUNT(*) AS n FROM ks_bets WHERE result IS NULL AND live_bet = 0 AND paper = 0 ${uf.clause}`, uf.args),
    db.one(`SELECT SUM(COALESCE(pnl,0)) AS total FROM ks_bets WHERE result IS NOT NULL AND live_bet = 0 AND paper = 0 ${uf.clause}`, uf.args),
  ])

  const wins   = Number(totals?.wins   || 0)
  const losses = Number(totals?.losses || 0)
  const total  = Number(bankrollRow?.total || 0)

  // Current streak + last 5
  const recentBets = await db.all(
    `SELECT result FROM ks_bets WHERE result IS NOT NULL AND live_bet = 0 AND paper = 0 ORDER BY settled_at DESC, id DESC LIMIT 10`
  )
  let streak = 0
  for (const r of recentBets) {
    if (r.result === 'win') {
      if (streak >= 0) streak++; else break
    } else if (r.result === 'loss') {
      if (streak <= 0) streak--; else break
    } else break
  }
  const last5 = recentBets.slice(0, 5)
  const last5W = last5.filter(r => r.result === 'win').length
  const last5L = last5.filter(r => r.result === 'loss').length

  // Fetch real Kalshi balance — this is ground truth (what you could withdraw)
  let kalshiBalance = null
  try {
    const kb = await getKalshiBalance()
    kalshiBalance = kb.balance_usd
  } catch { /* non-fatal — fall back to computed */ }

  // Live money P&L (real-money bets, all users)
  const liveTotals = await db.one(`
    SELECT
      SUM(CASE WHEN result IS NOT NULL THEN COALESCE(pnl,0) ELSE 0 END) AS total_pnl,
      SUM(CASE WHEN result = 'win'  THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN result = 'loss' THEN 1 ELSE 0 END) AS losses,
      SUM(CASE WHEN result IS NULL  THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN bet_date = ? AND result IS NOT NULL THEN COALESCE(pnl,0) ELSE 0 END) AS today_pnl
    FROM ks_bets WHERE live_bet = 0 AND paper = 0
  `, [today])

  res.json({
    today_pnl:  roundTo(Number(totals?.today_pnl  || 0), 2),
    week_pnl:   roundTo(Number(totals?.week_pnl   || 0), 2),
    month_pnl:  roundTo(Number(totals?.month_pnl  || 0), 2),
    ytd_pnl:    roundTo(Number(totals?.ytd_pnl    || 0), 2),
    total_pnl:  roundTo(Number(totals?.total_pnl  || 0), 2),
    wins,
    losses,
    win_rate:   wins + losses > 0 ? roundTo(wins / (wins + losses), 4) : 0,
    settled:    Number(totals?.settled    || 0),
    total_bets: Number(totals?.total_bets || 0),
    pending:    Number(pending?.n || 0),
    avg_edge:   totals?.avg_edge != null ? roundTo(totals.avg_edge, 4) : 0,
    bankroll:        roundTo(STARTING_BANKROLL + total, 2),
    kalshi_balance:  kalshiBalance,
    start_bankroll: STARTING_BANKROLL,
    current_streak: streak,
    last5: last5.length ? `${last5W}-${last5L}` : null,
    live_pnl:        roundTo(Number(liveTotals?.total_pnl || 0), 2),
    live_today_pnl:  roundTo(Number(liveTotals?.today_pnl || 0), 2),
    live_wins:       Number(liveTotals?.wins    || 0),
    live_losses:     Number(liveTotals?.losses  || 0),
    live_pending:    Number(liveTotals?.pending || 0),
    live_bankroll:   roundTo(110 + Number(liveTotals?.total_pnl || 0), 2),
  })
}))

// ------------------------------------------------------------------
// GET /api/ks/bettors
// Per-user bankroll, P&L, wagered — all active live bettors.
// ------------------------------------------------------------------
router.get('/ks/bettors', wrap(async (req, res) => {
  const today = todayISO()
  const bettors = await db.all(
    // id=1 is the legacy shadow paper account (Adam); exclude it but include all others (Isaiah, Adam-Live, etc.)
    `SELECT id, name, starting_bankroll, daily_risk_pct, paper, paper_temp, kalshi_key_id, kalshi_private_key FROM users WHERE active_bettor = 1 AND id != 1 ORDER BY id ASC`
  )

  const result = await Promise.all(bettors.map(async u => {
    const row = await db.one(`
      SELECT
        ROUND(SUM(CASE WHEN result IS NOT NULL THEN COALESCE(pnl,0) ELSE 0 END), 2)           AS total_pnl,
        ROUND(SUM(CASE WHEN result IS NOT NULL THEN COALESCE(capital_at_risk,0) ELSE 0 END),2) AS total_wagered,
        ROUND(SUM(CASE WHEN bet_date=? AND result IS NOT NULL THEN COALESCE(pnl,0) ELSE 0 END),2) AS today_pnl,
        ROUND(SUM(CASE WHEN bet_date=? AND result IS NOT NULL THEN COALESCE(capital_at_risk,0) ELSE 0 END),2) AS today_wagered,
        SUM(CASE WHEN result='win'  AND live_bet=0 THEN 1 ELSE 0 END) AS wins,
        SUM(CASE WHEN result='loss' AND live_bet=0 THEN 1 ELSE 0 END) AS losses,
        SUM(CASE WHEN result IS NULL AND live_bet=0 THEN 1 ELSE 0 END) AS pending
      FROM ks_bets WHERE user_id=? AND live_bet=0 AND paper=0
    `, [today, today, u.id])

    // Fetch live Kalshi balance using user's stored credentials (fall back to env vars for Adam-Live)
    let kalshiBalance = null
    try {
      const creds = u.kalshi_key_id
        ? { keyId: u.kalshi_key_id, privateKey: u.kalshi_private_key }
        : {}
      const kb = await getKalshiBalance(creds)
      kalshiBalance = kb.balance_usd
    } catch { /* non-fatal */ }

    return {
      id:              u.id,
      name:            u.name,
      start_bankroll:  Number(u.starting_bankroll || 1000),
      bankroll:        kalshiBalance ?? roundTo(Number(u.starting_bankroll || 1000) + Number(row?.total_pnl || 0), 2),
      kalshi_balance:  kalshiBalance,
      total_pnl:       roundTo(Number(row?.total_pnl     || 0), 2),
      total_wagered:   roundTo(Number(row?.total_wagered || 0), 2),
      today_pnl:       roundTo(Number(row?.today_pnl     || 0), 2),
      today_wagered:   roundTo(Number(row?.today_wagered || 0), 2),
      wins:            Number(row?.wins    || 0),
      losses:          Number(row?.losses  || 0),
      pending:         Number(row?.pending || 0),
      daily_risk_pct:  Number(u.daily_risk_pct || 0.3),
      paper:           u.paper === 1,
    }
  }))

  res.json(result)
}))

// GET /api/ks/live-bets?date=YYYY-MM-DD
// In-game (live_bet=1) bets for the day, grouped by pitcher.
// ------------------------------------------------------------------
router.get('/ks/live-bets', wrap(async (req, res) => {
  const date = req.query.date && req.query.date !== 'today' ? req.query.date : todayISO()
  const uf = userFilter(req)

  const bets = await db.all(`
    SELECT id, pitcher_name, strike, side, bet_size, market_mid, spread,
           result, pnl, logged_at,
           live_ks_at_bet, live_ip_at_bet, live_inning, live_score
    FROM ks_bets
    WHERE bet_date = ? AND live_bet = 1 ${uf.clause}
    ORDER BY pitcher_name ASC, strike ASC, logged_at DESC
  `, [date, ...uf.args])

  // Per pitcher/strike/side keep only the most recent bet (highest id)
  const bestMap = new Map()
  for (const b of bets) {
    const key = `${b.pitcher_name}|${b.strike}|${b.side}`
    if (!bestMap.has(key)) bestMap.set(key, b)
  }
  const deduped = [...bestMap.values()]

  const byPitcher = new Map()
  for (const b of deduped) {
    if (!byPitcher.has(b.pitcher_name)) byPitcher.set(b.pitcher_name, [])
    byPitcher.get(b.pitcher_name).push(b)
  }

  const pitchers = [...byPitcher.entries()].map(([name, pBets]) => ({
    pitcher_name: name,
    bets: pBets,
    wins:    pBets.filter(b => b.result === 'win').length,
    losses:  pBets.filter(b => b.result === 'loss').length,
    pending: pBets.filter(b => !b.result).length,
    pnl:     roundTo(pBets.reduce((s, b) => s + (b.pnl || 0), 0), 2),
  }))

  const totals = {
    bets:    deduped.length,
    wins:    deduped.filter(b => b.result === 'win').length,
    losses:  deduped.filter(b => b.result === 'loss').length,
    pending: deduped.filter(b => !b.result).length,
    pnl:     roundTo(deduped.reduce((s, b) => s + (b.pnl || 0), 0), 2),
  }

  res.json({ date, pitchers, totals })
}))

// GET /api/ks/dates
// Distinct bet_dates that have pre-game bets, most recent first.
// ------------------------------------------------------------------
router.get('/ks/dates', wrap(async (req, res) => {
  const uf = userFilter(req)
  const rows = await db.all(
    `SELECT DISTINCT bet_date FROM ks_bets WHERE live_bet = 0 ${uf.clause} ORDER BY bet_date DESC LIMIT 60`,
    uf.args,
  )
  res.json(rows.map(r => r.bet_date).filter(Boolean))
}))

// ------------------------------------------------------------------
// GET /api/ks/daily?date=YYYY-MM-DD
// All pre-game bets for a date, grouped by pitcher/game.
// ------------------------------------------------------------------
router.get('/ks/daily', wrap(async (req, res) => {
  const date = req.query.date && req.query.date !== 'today' ? req.query.date : todayISO()

  const uf = userFilter(req)
  const bets = await db.all(
    `SELECT id, bet_date, logged_at, pitcher_name, pitcher_id, team, game,
            strike, side, model_prob, market_mid, edge, lambda, actual_ks,
            result, pnl, bet_size, kelly_fraction, ticker, live_bet,
            park_factor, ump_factor, ump_name, velo_adj, bb_penalty,
            spread, k9_career, k9_season, k9_l5,
            savant_k_pct, savant_whiff, savant_fbv,
            weather_mult, velo_trend_mph, raw_model_prob,
            order_id, fill_price, filled_at, filled_contracts, order_status, paper
     FROM ks_bets
     WHERE bet_date = ? AND live_bet = 0 AND paper = 0 ${uf.clause}
     ORDER BY pitcher_name, strike ASC`,
    [date, ...uf.args],
  )

  // live bet details are now included in the main query (paper=0 already)
  const liveBets = bets

  const liveKey = b => `${b.pitcher_name}|${b.strike}|${b.side}`
  const liveMap = new Map()
  for (const lb of liveBets) liveMap.set(liveKey(lb), lb)

  // Group by pitcher/game
  const pitcherMap = new Map()
  for (const b of bets) {
    const key = `${b.pitcher_name}||${b.game || ''}`
    if (!pitcherMap.has(key)) {
      pitcherMap.set(key, {
        pitcher_name: b.pitcher_name,
        pitcher_id:   b.pitcher_id,
        team:         b.team,
        game:         b.game,
        lambda:       b.lambda,
        actual_ks:    b.actual_ks,
        bets: [],
      })
    }
    const grp = pitcherMap.get(key)
    if (b.actual_ks != null && grp.actual_ks == null) grp.actual_ks = b.actual_ks
    grp.bets.push({
      id:           b.id,
      strike:       b.strike,
      side:         b.side,
      model_prob:   b.model_prob != null ? roundTo(b.model_prob, 4) : null,
      market_mid:   b.market_mid,
      edge:         b.edge != null ? roundTo(b.edge, 4) : null,
      bet_size:     b.bet_size,
      kelly_fraction: b.kelly_fraction,
      result:       b.result,
      pnl:          b.pnl != null ? roundTo(b.pnl, 2) : null,
      ticker:       b.ticker,
      spread:       b.spread,
      lambda:         b.lambda,
      park_factor:    b.park_factor,
      ump_factor:     b.ump_factor,
      ump_name:       b.ump_name,
      weather_mult:   b.weather_mult,
      velo_trend_mph: b.velo_trend_mph,
      raw_model_prob: b.raw_model_prob != null ? roundTo(b.raw_model_prob, 4) : null,
      k9_season:      b.k9_season,
      savant_k_pct:   b.savant_k_pct,
      savant_whiff:   b.savant_whiff,
      savant_fbv:     b.savant_fbv,
      order_id:         b.order_id        ?? null,
      fill_price:       b.fill_price      ?? null,
      filled_at:        b.filled_at       ?? null,
      filled_contracts: b.filled_contracts ?? null,
      order_status:     b.order_status    ?? null,
      paper:            b.paper           ?? 1,
      live:             (() => {
        const lb = liveMap.get(`${b.pitcher_name}|${b.strike}|${b.side}`)
        if (!lb) return null
        return {
          bet_size:         lb.bet_size,
          fill_price:       lb.fill_price,
          filled_contracts: lb.filled_contracts,
          order_id:         lb.order_id,
          order_status:     lb.order_status,
          result:           lb.result,
          pnl:              lb.pnl != null ? roundTo(lb.pnl, 2) : null,
        }
      })(),
    })
  }

  const pitcherIdList = [...new Set([...pitcherMap.values()].map(g => g.pitcher_id).filter(Boolean))]

  // Fetch last 5 starts per pitcher for heat map + game times for sorting
  let recentStartsMap = {}, gameTimeMap = {}
  if (pitcherIdList.length) {
    const ph = pitcherIdList.map(() => '?').join(',')
    const [startRows, gameRows] = await Promise.all([
      db.all(
        `SELECT pitcher_id, game_date, ks FROM pitcher_recent_starts
         WHERE pitcher_id IN (${ph}) ORDER BY pitcher_id, game_date DESC`,
        pitcherIdList,
      ),
      db.all(
        `SELECT pitcher_home_id AS pid, game_time, status FROM games WHERE date = ? AND pitcher_home_id IN (${ph})
         UNION
         SELECT pitcher_away_id AS pid, game_time, status FROM games WHERE date = ? AND pitcher_away_id IN (${ph})`,
        [date, ...pitcherIdList, date, ...pitcherIdList],
      ),
    ])
    for (const r of startRows) {
      if (!recentStartsMap[r.pitcher_id]) recentStartsMap[r.pitcher_id] = []
      if (recentStartsMap[r.pitcher_id].length < 5) recentStartsMap[r.pitcher_id].push(r.ks)
    }
    for (const r of gameRows) {
      if (r.pid) gameTimeMap[r.pid] = { game_time: r.game_time, status: r.status }
    }
  }

  const pitchers = []
  let day_pnl = 0, day_wins = 0, day_losses = 0, day_pending = 0

  for (const [, grp] of pitcherMap) {
    let p_pnl = 0, p_wins = 0, p_losses = 0, p_pending = 0
    for (const b of grp.bets) {
      if (b.result === 'win')  { p_wins++;   p_pnl += Number(b.pnl || 0) }
      else if (b.result === 'loss') { p_losses++; p_pnl += Number(b.pnl || 0) }
      else p_pending++
    }
    day_pnl     += p_pnl
    day_wins    += p_wins
    day_losses  += p_losses
    day_pending += p_pending
    const gt = gameTimeMap[grp.pitcher_id] || {}
    pitchers.push({
      ...grp,
      game_time:   gt.game_time || null,
      game_status: gt.status    || null,
      pnl:         roundTo(p_pnl, 2),
      wins:        p_wins,
      losses:      p_losses,
      pending:     p_pending,
      recent_ks:   recentStartsMap[grp.pitcher_id] || [],
    })
  }

  // Sort: in_progress first, then by game_time ASC, then final (already done)
  pitchers.sort((a, b) => {
    const rank = s => s === 'in_progress' ? 0 : s === 'final' ? 2 : 1
    const dr = rank(a.game_status) - rank(b.game_status)
    if (dr !== 0) return dr
    if (a.game_time && b.game_time) return a.game_time.localeCompare(b.game_time)
    if (a.game_time) return -1
    if (b.game_time) return 1
    return a.pitcher_name.localeCompare(b.pitcher_name)
  })

  res.json({
    date,
    day_pnl:     roundTo(day_pnl, 2),
    day_wins,
    day_losses,
    day_pending,
    day_bets:    bets.length,
    pitchers,
  })
}))

// ------------------------------------------------------------------
// GET /api/ks/recent-starts/:pitcher_id
// Last 5 starts for a given pitcher (heat map data).
// ------------------------------------------------------------------
router.get('/ks/recent-starts/:pitcher_id', wrap(async (req, res) => {
  const rows = await db.all(
    `SELECT game_date, ks, ip, bf FROM pitcher_recent_starts
     WHERE pitcher_id = ?
     ORDER BY game_date DESC LIMIT 5`,
    [req.params.pitcher_id]
  )
  res.json(rows)
}))

// ------------------------------------------------------------------
// GET /api/ks/bankroll
// Running bankroll series (one point per day, pre-game bets only).
// Supports ?from=YYYY-MM-DD&to=YYYY-MM-DD&user_id=
// ------------------------------------------------------------------
router.get('/ks/bankroll', wrap(async (req, res) => {
  const { from, to, user_id } = req.query
  const clauses = ['result IS NOT NULL', 'live_bet = 0', 'paper = 0']
  const args = []
  if (user_id) { clauses.push('user_id = ?'); args.push(user_id) }
  if (from)    { clauses.push('bet_date >= ?'); args.push(from) }
  if (to)      { clauses.push('bet_date <= ?'); args.push(to) }
  const where = clauses.join(' AND ')

  // Always fetch all rows up to 'from' to compute correct starting bankroll
  let startingBalance = STARTING_BANKROLL
  if (from) {
    const prior = await db.all(
      `SELECT SUM(COALESCE(pnl,0)) AS prior_pnl FROM ks_bets WHERE result IS NOT NULL AND live_bet=0 AND paper=0 AND bet_date < ?`,
      [from]
    )
    startingBalance = STARTING_BANKROLL + Number(prior[0]?.prior_pnl || 0)
  }

  const rows = await db.all(
    `SELECT bet_date, SUM(COALESCE(pnl, 0)) AS day_pnl, COUNT(*) AS bets,
            SUM(CASE WHEN result='win'  THEN 1 ELSE 0 END) AS wins,
            SUM(CASE WHEN result='loss' THEN 1 ELSE 0 END) AS losses
     FROM ks_bets WHERE ${where}
     GROUP BY bet_date ORDER BY bet_date ASC`,
    args
  )
  let running = startingBalance
  const series = rows.map(r => {
    const pnl = Number(r.day_pnl || 0)
    running += pnl
    return {
      date:     r.bet_date,
      bankroll: roundTo(running, 2),
      pnl:      roundTo(pnl, 2),
      bets:     Number(r.bets || 0),
      wins:     Number(r.wins || 0),
      losses:   Number(r.losses || 0),
    }
  })
  res.json(series)
}))

// ------------------------------------------------------------------
// GET /api/ks/monthly
// ------------------------------------------------------------------
router.get('/ks/monthly', wrap(async (req, res) => {
  const { from, to, user_id } = req.query
  const clauses = ['live_bet = 0', 'result IS NOT NULL', 'paper = 0']
  const args = []
  if (user_id) { clauses.push('user_id = ?'); args.push(user_id) }
  if (from)    { clauses.push('bet_date >= ?'); args.push(from) }
  if (to)      { clauses.push('bet_date <= ?'); args.push(to) }
  const rows = await db.all(
    `SELECT substr(bet_date,1,7) AS ym,
            COUNT(*)                                             AS bets,
            SUM(CASE WHEN result='win'  THEN 1 ELSE 0 END)      AS wins,
            SUM(CASE WHEN result='loss' THEN 1 ELSE 0 END)      AS losses,
            SUM(COALESCE(pnl,0))                                AS pnl,
            SUM(COALESCE(capital_at_risk, bet_size))            AS wagered,
            AVG(CASE WHEN result IS NOT NULL THEN edge END)     AS avg_edge
     FROM ks_bets WHERE ${clauses.join(' AND ')}
     GROUP BY ym ORDER BY ym ASC`,
    args
  )
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  let running = STARTING_BANKROLL
  res.json(rows.map(r => {
    const wins    = Number(r.wins    || 0)
    const losses  = Number(r.losses  || 0)
    const pnl     = Number(r.pnl     || 0)
    const wagered = Number(r.wagered || 0)
    running += pnl
    const [y, mo] = String(r.ym).split('-')
    return {
      month:    `${months[Number(mo)-1] || mo} ${y}`,
      ym:       r.ym,
      bets:     Number(r.bets || 0),
      wins,     losses,
      win_rate: wins + losses > 0 ? roundTo(wins/(wins+losses), 4) : 0,
      pnl:      roundTo(pnl, 2),
      roi:      wagered > 0 ? roundTo(pnl/wagered, 4) : 0,
      avg_edge: r.avg_edge != null ? roundTo(r.avg_edge, 4) : 0,
      bankroll: roundTo(running, 2),
    }
  }))
}))

// ------------------------------------------------------------------
// GET /api/ks/weekly
// ------------------------------------------------------------------
router.get('/ks/weekly', wrap(async (req, res) => {
  const { from, to, user_id } = req.query
  const clauses = ['live_bet = 0', 'result IS NOT NULL', 'paper = 0']
  const args = []
  if (user_id) { clauses.push('user_id = ?'); args.push(user_id) }
  if (from)    { clauses.push('bet_date >= ?'); args.push(from) }
  if (to)      { clauses.push('bet_date <= ?'); args.push(to) }
  const rows = await db.all(
    `SELECT bet_date, COALESCE(pnl,0) AS pnl, result, bet_size
     FROM ks_bets WHERE ${clauses.join(' AND ')} ORDER BY bet_date ASC`,
    args
  )
  if (!rows.length) return res.json([])

  const weeks = {}
  for (const r of rows) {
    const d = new Date(r.bet_date + 'T12:00:00Z')
    const dow = (d.getUTCDay() + 6) % 7
    const monday = new Date(d); monday.setUTCDate(d.getUTCDate() - dow)
    const sunday = new Date(monday); sunday.setUTCDate(monday.getUTCDate() + 6)
    const key = monday.toISOString().slice(0, 10)
    const m = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
    const label = `${m[monday.getUTCMonth()]} ${monday.getUTCDate()}–${m[sunday.getUTCMonth()]} ${sunday.getUTCDate()}`
    const w = (weeks[key] ||= { week: label, start: key, bets:0, wins:0, losses:0, pnl:0, wagered:0 })
    w.bets    += 1
    w.wagered += Number(r.capital_at_risk || r.bet_size || 0)
    if (r.result === 'win')  w.wins++
    else if (r.result === 'loss') w.losses++
    w.pnl += Number(r.pnl || 0)
  }
  res.json(Object.values(weeks).sort((a,b) => a.start.localeCompare(b.start)).map(w => ({
    week:     w.week,
    bets:     w.bets,
    wins:     w.wins,
    losses:   w.losses,
    win_rate: w.wins+w.losses > 0 ? roundTo(w.wins/(w.wins+w.losses),4) : 0,
    pnl:      roundTo(w.pnl, 2),
    roi:      w.wagered > 0 ? roundTo(w.pnl/w.wagered, 4) : 0,
  })))
}))

// ------------------------------------------------------------------
// GET /api/ks/bets?page=1&limit=50&pitcher=&side=&result=&from=&to=
// ------------------------------------------------------------------
router.get('/ks/bets', wrap(async (req, res) => {
  const page   = Math.max(1, Number(req.query.page   || 1))
  const limit  = Math.min(200, Number(req.query.limit || 50))
  const offset = (page - 1) * limit

  let where = `live_bet = 0`
  const params = []
  if (req.query.pitcher) { where += ` AND pitcher_name LIKE ?`; params.push(`%${req.query.pitcher}%`) }
  if (req.query.side)    { where += ` AND side = ?`;    params.push(req.query.side.toUpperCase()) }
  if (req.query.result)  { where += ` AND result = ?`;  params.push(req.query.result.toLowerCase()) }
  if (req.query.from)    { where += ` AND bet_date >= ?`; params.push(req.query.from) }
  if (req.query.to)      { where += ` AND bet_date <= ?`; params.push(req.query.to) }

  const ALLOWED_SORT = new Set(['bet_date','pitcher_name','strike','side','actual_ks','result','pnl','bet_size','edge'])
  const sortCol = ALLOWED_SORT.has(req.query.sort) ? req.query.sort : 'bet_date'
  const sortDir = req.query.dir === 'asc' ? 'ASC' : 'DESC'
  const orderBy = sortCol === 'bet_date' ? `bet_date ${sortDir}, id ${sortDir}` : `${sortCol} ${sortDir}, bet_date DESC`

  const [rows, countRow] = await Promise.all([
    db.all(
      `SELECT id, bet_date, pitcher_name, team, game, strike, side,
              model_prob, market_mid, spread, edge, lambda, actual_ks, result, pnl, bet_size, capital_at_risk, ticker
       FROM ks_bets WHERE ${where}
       ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    ),
    db.one(`SELECT COUNT(*) AS n FROM ks_bets WHERE ${where}`, params),
  ])

  res.json({
    bets: rows.map(r => ({
      ...r,
      model_prob: r.model_prob != null ? roundTo(r.model_prob, 4) : null,
      edge:       r.edge       != null ? roundTo(r.edge, 4)       : null,
      pnl:        r.pnl        != null ? roundTo(r.pnl, 2)        : null,
    })),
    total: Number(countRow?.n || 0),
    page,
    limit,
    pages: Math.ceil(Number(countRow?.n || 0) / limit),
  })
}))

// ===========================================================================
// Users management
// ===========================================================================

// GET /api/meta — server start time (proxy for deploy time) + last data update
router.get('/meta', wrap(async (req, res) => {
  const today = todayISO()
  let lastDataUpdate = _lastDataUpdate
  if (!lastDataUpdate) {
    // Lazy init: find most recent write to today's bets
    const row = await db.one(
      `SELECT MAX(settled_at) as s, MAX(logged_at) as l FROM ks_bets WHERE bet_date=?`, [today],
    ).catch(() => null)
    lastDataUpdate = [row?.s, row?.l].filter(Boolean).sort().pop() ?? null
    if (lastDataUpdate) _lastDataUpdate = lastDataUpdate
  }
  res.json({ deploy_time: SERVER_START, last_data_update: lastDataUpdate })
}))

// GET /api/events — Server-Sent Events stream for real-time dashboard updates
router.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()

  _sseClients.add(res)
  res.write(': connected\n\n')

  const keepalive = setInterval(() => {
    try { res.write(': ping\n\n') } catch { clearInterval(keepalive); _sseClients.delete(res) }
  }, 25_000)

  req.on('close', () => {
    clearInterval(keepalive)
    _sseClients.delete(res)
  })
})

// GET /api/users — list all users with bettor profile (never returns private key)
router.get('/users', wrap(async (req, res) => {
  const rows = await db.all(`
    SELECT id, name, created_at,
           active_bettor, starting_bankroll, daily_risk_pct, paper,
           kalshi_key_id,
           CASE WHEN kalshi_private_key IS NOT NULL AND kalshi_private_key != '' THEN 1 ELSE 0 END AS has_kalshi_key,
           discord_webhook
    FROM users ORDER BY created_at ASC`)
  res.json(rows)
}))

// POST /api/users — add a user { name, pin }
router.post('/users', wrap(async (req, res) => {
  const { name, pin } = req.body || {}
  if (!name || !pin) return res.status(400).json({ error: 'name and pin required' })
  if (String(pin).length < 4) return res.status(400).json({ error: 'PIN must be at least 4 digits' })
  try {
    await db.run(`INSERT INTO users (name, pin) VALUES (?, ?)`, [String(name).trim(), String(pin).trim()])
    res.json({ ok: true })
  } catch (err) {
    if (err.message?.includes('UNIQUE')) return res.status(409).json({ error: 'Username already exists' })
    throw err
  }
}))

// PUT /api/users/:id — update bettor profile
router.put('/users/:id', wrap(async (req, res) => {
  const id = Number(req.params.id)
  if (!id) return res.status(400).json({ error: 'invalid id' })
  const {
    active_bettor, starting_bankroll, daily_risk_pct, paper,
    kalshi_key_id, kalshi_private_key, discord_webhook, pin,
  } = req.body || {}

  const sets = []
  const vals = []

  if (active_bettor     != null) { sets.push('active_bettor = ?');     vals.push(active_bettor     ? 1 : 0) }
  if (starting_bankroll != null) { sets.push('starting_bankroll = ?'); vals.push(Number(starting_bankroll)) }
  if (daily_risk_pct    != null) { sets.push('daily_risk_pct = ?');    vals.push(Number(daily_risk_pct)) }
  if (paper             != null) { sets.push('paper = ?');             vals.push(paper ? 1 : 0) }
  if (kalshi_key_id     != null) { sets.push('kalshi_key_id = ?');     vals.push(String(kalshi_key_id).trim() || null) }
  if (kalshi_private_key != null && String(kalshi_private_key).trim()) {
    sets.push('kalshi_private_key = ?')
    vals.push(String(kalshi_private_key).trim())
  }
  if (discord_webhook   != null) { sets.push('discord_webhook = ?');   vals.push(String(discord_webhook).trim() || null) }
  if (pin               != null) {
    if (String(pin).length < 4) return res.status(400).json({ error: 'PIN must be at least 4 digits' })
    sets.push('pin = ?'); vals.push(String(pin).trim())
  }

  if (!sets.length) return res.status(400).json({ error: 'nothing to update' })
  vals.push(id)
  await db.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, vals)
  res.json({ ok: true })
}))

// POST /api/users/:id/toggle-live — flip paper on/off for a bettor
router.post('/users/:id/toggle-live', wrap(async (req, res) => {
  const id = Number(req.params.id)
  if (!id) return res.status(400).json({ error: 'invalid id' })
  const user = await db.one(`SELECT paper FROM users WHERE id = ?`, [id])
  if (!user) return res.status(404).json({ error: 'not found' })
  const newPaper = user.paper === 0 ? 1 : 0
  await db.run(`UPDATE users SET paper = ?, paper_temp = 0 WHERE id = ?`, [newPaper, id])
  res.json({ ok: true, paper: newPaper, live: newPaper === 0 })
}))

// DELETE /api/users/:name — remove a user (can't remove yourself)
router.delete('/users/:name', wrap(async (req, res) => {
  const target = req.params.name
  if (req.session?.user?.name?.toLowerCase() === target.toLowerCase()) {
    return res.status(400).json({ error: "Can't remove your own account" })
  }
  await db.run(`DELETE FROM users WHERE name = ? COLLATE NOCASE`, [target])
  res.json({ ok: true })
}))

// ===========================================================================
// Analytics routes
// ===========================================================================

// ------------------------------------------------------------------
// GET /api/ks/stats — full performance statistics
// Supports ?from=YYYY-MM-DD&to=YYYY-MM-DD&user_id=
// ------------------------------------------------------------------
router.get('/ks/stats', wrap(async (req, res) => {
  const { from, to, user_id } = req.query
  const clauses = ['live_bet = 0', 'result IS NOT NULL', 'paper = 0']
  const args = []
  if (user_id) { clauses.push('user_id = ?'); args.push(user_id) }
  if (from)    { clauses.push('bet_date >= ?'); args.push(from) }
  if (to)      { clauses.push('bet_date <= ?'); args.push(to) }
  const rows = await db.all(
    `SELECT bet_date, result, pnl, bet_size, edge, model_prob, side
     FROM ks_bets WHERE ${clauses.join(' AND ')}
     ORDER BY bet_date ASC, id ASC`,
    args
  )
  if (!rows.length) {
    return res.json({
      empty: true, wins: 0, losses: 0, total_pnl: 0, total_wagered: 0,
      win_rate: 0, roi: 0, ev_per_bet: 0, max_drawdown: 0, max_drawdown_pct: 0,
      current_drawdown: 0, current_drawdown_pct: 0, longest_win_streak: 0,
      longest_loss_streak: 0, current_streak: 0, winning_days: 0,
      total_days: 0, winning_days_pct: 0, avg_edge_wins: null,
      avg_edge_losses: null, expected_wins: 0, actual_wins: 0,
      bankroll: STARTING_BANKROLL, start_bankroll: STARTING_BANKROLL,
    })
  }

  let totalPnl = 0, totalWagered = 0, wins = 0, losses = 0
  let edgeSumWins = 0, edgeNWins = 0, edgeSumLosses = 0, edgeNLosses = 0
  let expectedWins = 0
  let running = STARTING_BANKROLL, peak = STARTING_BANKROLL
  let maxDd = 0, streak = 0, maxWinStreak = 0, maxLossStreak = 0
  const dayPnl = {}

  for (const r of rows) {
    const pnl = Number(r.pnl || 0)
    totalPnl    += pnl
    totalWagered += Number(r.bet_size || 0)
    running     += pnl
    peak         = Math.max(peak, running)
    maxDd        = Math.min(maxDd, running - peak)
    dayPnl[r.bet_date] = (dayPnl[r.bet_date] || 0) + pnl

    const mp = Number(r.model_prob || 0.5)
    expectedWins += r.side === 'YES' ? mp : (1 - mp)

    if (r.result === 'win') {
      wins++
      if (r.edge != null) { edgeSumWins += Number(r.edge); edgeNWins++ }
      streak = streak >= 0 ? streak + 1 : 1
      maxWinStreak = Math.max(maxWinStreak, streak)
    } else {
      losses++
      if (r.edge != null) { edgeSumLosses += Number(r.edge); edgeNLosses++ }
      streak = streak <= 0 ? streak - 1 : -1
      maxLossStreak = Math.min(maxLossStreak, streak)
    }
  }

  const totalSettled  = wins + losses
  const totalDays     = Object.keys(dayPnl).length
  const winningDays   = Object.values(dayPnl).filter(v => v > 0).length
  const currentDd     = running - peak

  res.json({
    wins, losses,
    total_pnl:           roundTo(totalPnl, 2),
    total_wagered:       roundTo(totalWagered, 2),
    win_rate:            totalSettled > 0 ? roundTo(wins / totalSettled, 4) : 0,
    roi:                 totalWagered > 0 ? roundTo(totalPnl / totalWagered, 4) : 0,
    ev_per_bet:          totalSettled > 0 ? roundTo(totalPnl / totalSettled, 2) : 0,
    max_drawdown:        roundTo(maxDd, 2),
    max_drawdown_pct:    peak > 0 ? roundTo(maxDd / peak, 4) : 0,
    current_drawdown:    roundTo(currentDd, 2),
    current_drawdown_pct: peak > 0 ? roundTo(currentDd / peak, 4) : 0,
    longest_win_streak:  maxWinStreak,
    longest_loss_streak: Math.abs(maxLossStreak),
    current_streak:      streak,
    winning_days:        winningDays,
    total_days:          totalDays,
    winning_days_pct:    totalDays > 0 ? roundTo(winningDays / totalDays, 4) : 0,
    avg_edge_wins:       edgeNWins   > 0 ? roundTo(edgeSumWins   / edgeNWins,   4) : null,
    avg_edge_losses:     edgeNLosses > 0 ? roundTo(edgeSumLosses / edgeNLosses, 4) : null,
    expected_wins:       roundTo(expectedWins, 1),
    actual_wins:         wins,
    bankroll:            roundTo(running, 2),
    start_bankroll:      STARTING_BANKROLL,
  })
}))

// ------------------------------------------------------------------
// GET /api/ks/edge-breakdown — win rate + P&L by edge bucket / side / strike
// ------------------------------------------------------------------
router.get('/ks/edge-breakdown', wrap(async (req, res) => {
  const rows = await db.all(
    `SELECT result, pnl, bet_size, edge, side, strike
     FROM ks_bets WHERE live_bet = 0 AND result IS NOT NULL`,
  )

  const mk = () => ({ wins: 0, losses: 0, pnl: 0, wagered: 0 })
  const fin = (b, label) => {
    const total = b.wins + b.losses
    return {
      label,
      bets:     total,
      wins:     b.wins,
      losses:   b.losses,
      win_rate: total > 0 ? roundTo(b.wins / total, 4) : 0,
      pnl:      roundTo(b.pnl, 2),
      roi:      b.wagered > 0 ? roundTo(b.pnl / b.wagered, 4) : 0,
    }
  }

  const buckets = { '5–7¢': mk(), '7–10¢': mk(), '10¢+': mk() }
  const sides   = { YES: mk(), NO: mk() }
  const strikes = { '4+': mk(), '5+': mk(), '6+': mk(), '7+': mk(), '8+': mk() }

  for (const r of rows) {
    const edgeCents = Number(r.edge || 0) * 100
    const pnl       = Number(r.pnl || 0)
    const wagered   = Number(r.capital_at_risk || r.bet_size || 0)
    const win       = r.result === 'win'
    const bump      = b => { if (win) b.wins++; else b.losses++; b.pnl += pnl; b.wagered += wagered }

    if      (edgeCents < 7)  bump(buckets['5–7¢'])
    else if (edgeCents < 10) bump(buckets['7–10¢'])
    else                     bump(buckets['10¢+'])

    if (sides[r.side])         bump(sides[r.side])

    const sk = `${r.strike}+`
    if (strikes[sk])           bump(strikes[sk])
  }

  res.json({
    by_bucket: Object.entries(buckets).map(([k, v]) => fin(v, k)),
    by_side:   Object.entries(sides).map(([k, v])   => fin(v, k)),
    by_strike: Object.entries(strikes).map(([k, v]) => fin(v, k)),
  })
}))

// ------------------------------------------------------------------
// GET /api/ks/pitcher-leaderboard — top & bottom pitchers by P&L
// ------------------------------------------------------------------
router.get('/ks/pitcher-leaderboard', wrap(async (req, res) => {
  const rows = await db.all(
    `SELECT pitcher_name,
            COUNT(*)                                       AS bets,
            SUM(CASE WHEN result='win'  THEN 1 ELSE 0 END) AS wins,
            SUM(CASE WHEN result='loss' THEN 1 ELSE 0 END) AS losses,
            SUM(COALESCE(pnl,0))                           AS pnl,
            SUM(bet_size)                                  AS wagered
     FROM ks_bets WHERE live_bet = 0 AND result IS NOT NULL
     GROUP BY pitcher_name
     ORDER BY pnl DESC`,
  )
  const all = rows.map(r => {
    const wins = Number(r.wins || 0)
    const losses = Number(r.losses || 0)
    const pnl    = Number(r.pnl || 0)
    const wag    = Number(r.wagered || 0)
    return {
      pitcher:  r.pitcher_name,
      bets:     Number(r.bets || 0),
      wins, losses,
      win_rate: wins + losses > 0 ? roundTo(wins / (wins + losses), 4) : 0,
      pnl:      roundTo(pnl, 2),
      roi:      wag > 0 ? roundTo(pnl / wag, 4) : 0,
    }
  })
  res.json({ top: all.slice(0, 10), bottom: [...all].slice(-10).reverse() })
}))

// ------------------------------------------------------------------
// GET /api/ks/game-review?from=&to=&result=
// All bets grouped by date → game (pitcher), for the game review panel.
// ------------------------------------------------------------------
router.get('/ks/game-review', wrap(async (req, res) => {
  const { from, to, result } = req.query
  const conds = ['live_bet = 0']
  const vals  = []
  if (from)   { conds.push('bet_date >= ?'); vals.push(from) }
  if (to)     { conds.push('bet_date <= ?'); vals.push(to) }
  if (result === 'pending') { conds.push('result IS NULL') }
  else if (result)          { conds.push('result = ?'); vals.push(result) }

  const rows = await db.all(
    `SELECT bet_date, pitcher_name, pitcher_id, game, team,
            strike, side, edge, lambda, actual_ks, result, pnl, bet_size,
            savant_k_pct, savant_whiff, savant_fbv, opp_k_pct,
            park_factor, weather_mult, ump_factor, ump_name
     FROM ks_bets
     WHERE ${conds.join(' AND ')}
     ORDER BY bet_date DESC, pitcher_name ASC, strike ASC`,
    vals,
  )

  // Group by date → pitcher/game
  const byDate = {}
  for (const r of rows) {
    const d = r.bet_date
    if (!byDate[d]) byDate[d] = {}
    const key = `${r.pitcher_name}||${r.game}`
    if (!byDate[d][key]) {
      byDate[d][key] = {
        pitcher_name: r.pitcher_name,
        pitcher_id:   r.pitcher_id,
        game:         r.game,
        team:         r.team,
        lambda:       r.lambda,
        actual_ks:    r.actual_ks,
        savant_k_pct: r.savant_k_pct,
        savant_whiff: r.savant_whiff,
        savant_fbv:   r.savant_fbv,
        opp_k_pct:    r.opp_k_pct,
        park_factor:  r.park_factor,
        weather_mult: r.weather_mult,
        ump_factor:   r.ump_factor,
        ump_name:     r.ump_name,
        bets: [],
      }
    }
    byDate[d][key].bets.push({
      strike: r.strike,
      side:   r.side,
      edge:   r.edge,
      bet_size: r.bet_size,
      result: r.result,
      pnl:    r.pnl,
    })
  }

  // Flatten to array of { date, games: [...] }
  const dates = Object.keys(byDate).sort().reverse()
  const output = dates.map(date => {
    const games = Object.values(byDate[date]).map(g => {
      const settled  = g.bets.filter(b => b.result)
      const wins     = settled.filter(b => b.result === 'win').length
      const losses   = settled.filter(b => b.result === 'loss').length
      const pending  = g.bets.filter(b => !b.result).length
      const pnl      = settled.reduce((s, b) => s + Number(b.pnl || 0), 0)
      const lambda_err = g.actual_ks != null
        ? roundTo(Number(g.lambda || 0) - Number(g.actual_ks), 1)
        : null
      return { ...g, wins, losses, pending, pnl: roundTo(pnl, 2), lambda_err }
    })
    return { date, games }
  })

  res.json(output)
}))

// ------------------------------------------------------------------
// GET /api/ks/testing
// Edge calibration, lambda accuracy, and threshold simulation.
// ------------------------------------------------------------------
router.get('/ks/testing', wrap(async (req, res) => {
  const [calibRows, lambdaRows, allSettled] = await Promise.all([
    // Edge calibration: win rate by edge bucket (5¢ increments)
    db.all(`
      SELECT
        CAST(ROUND(edge / 0.05) * 0.05 * 100 AS INTEGER) AS bucket_cents,
        COUNT(*)                                           AS bets,
        SUM(CASE WHEN result='win'  THEN 1 ELSE 0 END)    AS wins,
        SUM(CASE WHEN result='loss' THEN 1 ELSE 0 END)    AS losses,
        SUM(COALESCE(pnl,0))                              AS pnl,
        AVG(edge)                                         AS avg_edge
      FROM ks_bets
      WHERE result IS NOT NULL AND live_bet = 0 AND edge IS NOT NULL
      GROUP BY bucket_cents
      ORDER BY bucket_cents ASC
    `),
    // Lambda accuracy: predicted vs actual Ks per pitcher
    db.all(`
      SELECT
        pitcher_name,
        AVG(lambda)     AS avg_lambda,
        AVG(actual_ks)  AS avg_actual,
        COUNT(*)        AS bets,
        SUM(CASE WHEN result='win'  THEN 1 ELSE 0 END) AS wins,
        SUM(CASE WHEN result='loss' THEN 1 ELSE 0 END) AS losses,
        SUM(COALESCE(pnl,0)) AS pnl
      FROM ks_bets
      WHERE result IS NOT NULL AND live_bet = 0 AND lambda IS NOT NULL AND actual_ks IS NOT NULL
      GROUP BY pitcher_name
      HAVING bets >= 3
      ORDER BY bets DESC
    `),
    // All settled bets for threshold simulation
    db.all(`
      SELECT edge, result, pnl, bet_size
      FROM ks_bets
      WHERE result IS NOT NULL AND live_bet = 0 AND edge IS NOT NULL
      ORDER BY edge ASC
    `),
  ])

  // Calibration: add win_rate, roi
  const calibration = calibRows.map(r => {
    const wins   = Number(r.wins   || 0)
    const losses = Number(r.losses || 0)
    const pnl    = Number(r.pnl   || 0)
    return {
      bucket_cents: Number(r.bucket_cents),
      bets:    Number(r.bets),
      wins, losses,
      win_rate: wins + losses > 0 ? roundTo(wins / (wins + losses), 4) : 0,
      pnl:      roundTo(pnl, 2),
    }
  })

  // Lambda accuracy + per-pitcher notes
  const lambda_accuracy = lambdaRows.map(r => {
    const wins      = Number(r.wins   || 0)
    const losses    = Number(r.losses || 0)
    const win_rate  = wins + losses > 0 ? roundTo(wins / (wins + losses), 4) : 0
    const avg_lambda = roundTo(Number(r.avg_lambda || 0), 2)
    const avg_actual = roundTo(Number(r.avg_actual || 0), 2)
    const lambda_err = roundTo(avg_lambda - avg_actual, 2)
    const bets = Number(r.bets)
    const pnl  = roundTo(Number(r.pnl || 0), 2)

    // Generate a plain-English note
    const notes = []
    if (lambda_err >= 2.5) {
      notes.push(`Model over-predicts by ${lambda_err}K avg — bets tend to be on inflated lines. Consider skipping or reducing bet size.`)
    } else if (lambda_err <= -2.5) {
      notes.push(`Model under-predicts by ${Math.abs(lambda_err)}K avg — actual Ks exceed expectation. Edge may be understated; consider increasing size.`)
    } else if (Math.abs(lambda_err) < 0.75) {
      notes.push(`λ is accurate (±${Math.abs(lambda_err)}K avg). Model well-calibrated for this pitcher.`)
    }

    if (win_rate <= 0.25 && bets >= 4) {
      notes.push(`Only ${Math.round(win_rate*100)}% win rate over ${bets} bets — strong flag to skip until model inputs are reviewed.`)
    } else if (win_rate === 1 && bets >= 3) {
      notes.push(`${bets} for ${bets} — perfect record. Could be small sample luck; continue with standard sizing.`)
    } else if (win_rate >= 0.75 && bets >= 4) {
      notes.push(`${Math.round(win_rate*100)}% win rate over ${bets} bets — one of the better-performing starters in the model.`)
    }

    if (pnl < -30 && bets >= 4) {
      notes.push(`Net -$${Math.abs(pnl).toFixed(0)} across ${bets} bets. Check if a specific strike range is dragging results.`)
    }

    return { pitcher: r.pitcher_name, avg_lambda, avg_actual, lambda_err, bets, wins, losses, win_rate, pnl, notes }
  })

  // Threshold simulation: for each edge threshold (4¢–20¢ in 1¢ steps)
  const thresholds = []
  for (let t = 4; t <= 20; t++) {
    const thresh  = t / 100
    const subset  = allSettled.filter(b => Number(b.edge) >= thresh)
    if (!subset.length) break
    const wins    = subset.filter(b => b.result === 'win').length
    const losses  = subset.filter(b => b.result === 'loss').length
    const pnl     = subset.reduce((s, b) => s + Number(b.pnl || 0), 0)
    const wagered = subset.reduce((s, b) => s + Number(b.capital_at_risk || b.bet_size || 0), 0)
    thresholds.push({
      threshold_cents: t,
      bets:    subset.length,
      wins, losses,
      win_rate: wins + losses > 0 ? roundTo(wins / (wins + losses), 4) : 0,
      pnl:      roundTo(pnl, 2),
      roi:      wagered > 0 ? roundTo(pnl / wagered, 4) : 0,
    })
  }

  // Overall model notes derived from calibration + thresholds
  const model_notes = []

  // Best ROI threshold
  const bestThresh = [...thresholds].sort((a, b) => b.roi - a.roi)[0]
  const currentThresh = thresholds.find(t => t.threshold_cents === 5)
  if (bestThresh && currentThresh && bestThresh.threshold_cents !== 5) {
    const dir = bestThresh.threshold_cents > 5 ? 'Raising' : 'Lowering'
    model_notes.push({
      level: bestThresh.roi > currentThresh.roi + 0.02 ? 'warn' : 'info',
      text: `${dir} the edge threshold to ${bestThresh.threshold_cents}¢ would improve ROI from ${(currentThresh.roi*100).toFixed(1)}% → ${(bestThresh.roi*100).toFixed(1)}% (${bestThresh.bets} bets).`,
    })
  }

  // Check if low-edge bets (5¢) are dragging results
  const lowEdge = calibration.find(c => c.bucket_cents === 5)
  const highEdge = calibration.filter(c => c.bucket_cents >= 15)
  const highEdgeWR = highEdge.length
    ? highEdge.reduce((s,c) => s + c.wins, 0) / highEdge.reduce((s,c) => s + c.wins + c.losses, 0)
    : null
  if (lowEdge && lowEdge.win_rate < 0.45 && lowEdge.bets >= 5) {
    model_notes.push({
      level: 'warn',
      text: `5¢ edge bets are only winning ${Math.round(lowEdge.win_rate*100)}% — close to break-even. These may not be real edge; consider a 7–8¢ floor.`,
    })
  }
  if (highEdgeWR != null && highEdgeWR >= 0.75) {
    const totalHigh = highEdge.reduce((s,c) => s + c.bets, 0)
    model_notes.push({
      level: 'good',
      text: `Bets with 15¢+ edge are winning at ${Math.round(highEdgeWR*100)}% (${totalHigh} bets). The model finds real edge at higher confidence levels.`,
    })
  }

  // Flag pitchers with bad λ + bad win rate
  const skipList = lambda_accuracy.filter(p => p.lambda_err >= 2 && p.win_rate <= 0.35 && p.bets >= 3)
  if (skipList.length) {
    model_notes.push({
      level: 'warn',
      text: `Pitchers to consider skipping (over-predicted λ + losing record): ${skipList.map(p => p.pitcher).join(', ')}.`,
    })
  }

  res.json({ calibration, lambda_accuracy, thresholds, model_notes })
}))

// GET /api/ks/kalshi-positions — live positions from Kalshi API
// Returns actual contracts held so the UI reflects real purchases.
router.get('/ks/kalshi-positions', wrap(async (req, res) => {
  const { user_id } = req.query
  // Look up Kalshi creds for this user
  let creds = {}
  if (user_id) {
    const u = await db.one(`SELECT kalshi_key_id, kalshi_private_key FROM users WHERE id = ?`, [user_id])
    if (u?.kalshi_key_id) creds = { keyId: u.kalshi_key_id, privateKey: u.kalshi_private_key }
  }
  const { default: axios } = await import('axios')
  const { getAuthHeaders } = await import('../lib/kalshi.js')
  const BASE = 'https://api.elections.kalshi.com/trade-api/v2'
  try {
    const headers = getAuthHeaders('GET', '/trade-api/v2/portfolio/positions', {}, creds)
    const r = await axios({ method: 'GET', url: BASE + '/portfolio/positions', params: { count_filter: 'position', limit: 100 }, headers, timeout: 10000 })
    const positions = r.data?.market_positions || []
    res.json(positions.map(p => ({
      ticker:    p.ticker,
      contracts: Math.round(Math.abs(Number(p.position_fp || 0))),
      side:      Number(p.position_fp) >= 0 ? 'YES' : 'NO',
      cost:      Number(p.market_exposure_dollars || 0),
      pnl:       Number(p.realized_pnl_dollars || 0),
    })))
  } catch (e) {
    console.error('[kalshi-positions] API error:', e.message)
    res.json([])
  }
}))

// GET /api/ks/market-prices?tickers=T1,T2,... — current Kalshi bid/ask for open positions
router.get('/ks/market-prices', wrap(async (req, res) => {
  const tickers = (req.query.tickers || '').split(',').map(t => t.trim()).filter(Boolean)
  if (!tickers.length) return res.json([])

  const { getAuthHeaders } = await import('../lib/kalshi.js')
  const { default: axios } = await import('axios')
  const BASE = 'https://api.elections.kalshi.com/trade-api/v2'

  const parseCents = v => {
    if (v == null) return null
    const n = typeof v === 'string' ? parseFloat(v) : Number(v)
    return Number.isFinite(n) ? Math.round(n * 100) : null
  }

  const results = await Promise.all(tickers.map(async ticker => {
    try {
      const path = `/trade-api/v2/markets/${ticker}`
      const headers = getAuthHeaders('GET', path)
      const r = await axios({ method: 'GET', url: BASE + `/markets/${ticker}`, headers, timeout: 8000 })
      const m = r.data?.market
      if (!m) return { ticker, error: 'not found' }
      const yes_bid = m.yes_bid != null ? m.yes_bid : parseCents(m.yes_bid_dollars)
      const yes_ask = m.yes_ask != null ? m.yes_ask : parseCents(m.yes_ask_dollars)
      const mid = (yes_bid != null && yes_ask != null) ? (yes_bid + yes_ask) / 2 : null
      return { ticker, status: m.status, result: m.result ?? null, yes_bid, yes_ask, mid, expiration_value: m.expiration_value ?? null }
    } catch (e) {
      return { ticker, error: e.message }
    }
  }))

  res.json(results)
}))

// POST /api/ks/auto-settle — settle bets whose Kalshi market has finalized
router.post('/ks/auto-settle', wrap(async (req, res) => {
  const { user_id } = req.body || {}
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })

  const clause = user_id ? 'bet_date = ? AND result IS NULL AND user_id = ?' : 'bet_date = ? AND result IS NULL'
  const args   = user_id ? [today, user_id] : [today]
  const pending = await db.all(`SELECT * FROM ks_bets WHERE ${clause}`, args)

  if (!pending.length) return res.json({ settled: 0, checked: 0 })

  const { getAuthHeaders } = await import('../lib/kalshi.js')
  const { default: axios } = await import('axios')
  const BASE = 'https://api.elections.kalshi.com/trade-api/v2'
  const KALSHI_FEE = 0.07
  const now = new Date().toISOString()
  let settled = 0

  for (const bet of pending) {
    if (!bet.ticker) continue
    try {
      const path = `/trade-api/v2/markets/${bet.ticker}`
      const headers = getAuthHeaders('GET', path)
      const r = await axios({ method: 'GET', url: BASE + `/markets/${bet.ticker}`, headers, timeout: 8000 })
      const m = r.data?.market
      if (!m || m.status !== 'finalized' || !m.result) continue

      const actualKs = m.expiration_value != null ? Number(m.expiration_value) : null
      const won = (bet.side === 'YES' && m.result === 'yes') || (bet.side === 'NO' && m.result === 'no')

      const spread      = bet.spread ?? 4
      const halfSpread  = spread / 2 / 100
      const mid         = bet.market_mid != null ? bet.market_mid / 100 : (bet.model_prob ?? 0.5)
      const fillFrac    = bet.side === 'YES' ? mid + halfSpread : (1 - mid) + halfSpread
      const pnl         = won
        ? bet.bet_size * (1 - fillFrac) * (1 - KALSHI_FEE)
        : -bet.bet_size * fillFrac

      await db.run(
        `UPDATE ks_bets SET actual_ks=?, result=?, settled_at=?, pnl=? WHERE id=?`,
        [actualKs, won ? 'win' : 'loss', now, Math.round(pnl * 100) / 100, bet.id],
      )
      settled++
    } catch (e) {
      console.error(`[auto-settle] ${bet.ticker}:`, e.message)
    }
  }

  res.json({ settled, checked: pending.length })
}))

// GET /api/agent/status — The Closer heartbeat
router.get('/agent/status', wrap(async (req, res) => {
  const rows = await db.all(`SELECT key, value, updated_at FROM agent_heartbeat WHERE key IN ('closer','closer_last_update')`)
  const byKey = {}
  for (const r of rows) {
    try { byKey[r.key] = { ...JSON.parse(r.value), updated_at: r.updated_at } } catch { byKey[r.key] = { updated_at: r.updated_at } }
  }
  res.json({
    heartbeat:   byKey['closer']             || null,
    last_update: byKey['closer_last_update'] || null,
  })
}))

export default router
