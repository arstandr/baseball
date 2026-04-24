import express from 'express'
import * as db from '../../lib/db.js'
import { safeJson, roundTo, winRate, isoWeekGroup, wrap } from '../shared.js'

let computeModeSummary, computeCalibration, computeBankrollRollup, runningBankroll
try {
  const analytics = await import('../../lib/analytics.js')
  computeModeSummary    = analytics.computeModeSummary
  computeCalibration    = analytics.computeCalibration
  computeBankrollRollup = analytics.computeBankrollRollup
  runningBankroll       = analytics.runningBankroll
} catch { /* routes using these return gracefully */ }

const router = express.Router()

router.get('/summary', wrap(async (req, res) => {
  const [sigRows, edgeRows] = await Promise.all([
    db.all(
      `SELECT json_extract(output_json,'$.decision') AS decision, COUNT(*) AS n
       FROM agent_outputs WHERE agent = 'judge'
       GROUP BY decision`,
    ),
    db.all(
      `SELECT json_extract(output_json,'$.adjusted_edge') AS edge
       FROM agent_outputs
       WHERE agent = 'judge' AND json_extract(output_json,'$.decision') = 'TRADE'
         AND json_extract(output_json,'$.adjusted_edge') IS NOT NULL`,
    ),
  ])
  let tradeSignals = 0, rejectSignals = 0
  for (const r of sigRows) {
    if (r.decision === 'TRADE')  tradeSignals  = Number(r.n)
    if (r.decision === 'REJECT') rejectSignals = Number(r.n)
  }
  const edgeSum = edgeRows.reduce((s, r) => s + Number(r.edge || 0), 0)
  const edgeN   = edgeRows.length

  const paper = await computeModeSummary('paper')
  const live  = await computeModeSummary('live')

  paper.calibration = await computeCalibration('paper')

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

router.get('/games/dates', wrap(async (req, res) => {
  const mode = req.query.mode === 'live' ? 'live' : 'paper'
  if (mode === 'live') {
    const rows = await db.all(
      `SELECT DISTINCT trade_date AS date FROM trades WHERE mode = 'live' ORDER BY trade_date DESC`,
    )
    return res.json(rows.map(r => r.date).filter(Boolean))
  }
  const rows = await db.all(
    `SELECT DISTINCT g.date AS date FROM games g
     INNER JOIN agent_outputs a ON a.game_id = g.id AND a.agent = 'judge'
     ORDER BY g.date DESC`,
  )
  res.json(rows.map(r => r.date).filter(Boolean))
}))

router.get('/games', wrap(async (req, res) => {
  const date = req.query.date && req.query.date !== 'today'
    ? req.query.date
    : new Date().toLocaleString('sv-SE', { timeZone: 'America/New_York' }).slice(0, 10)
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
  for (const t of tradeRows) tradeByGame[t.game_id] = t
  const outcomeByTrade = {}
  for (const o of outcomeRows) outcomeByTrade[o.trade_id] = o
  const venueNameById = Object.fromEntries(venueRows.map(v => [v.id, v.name]))

  const out = games.map(g => {
    const agents  = agentsByGame[g.id] || {}
    const judge   = agents.judge || null
    const trade   = tradeByGame[g.id] || null
    const outcome = trade ? outcomeByTrade[trade.id] || null : null
    return {
      game_id: g.id, date: g.date, game_time: g.game_time, status: g.status,
      teams: `${g.team_away} @ ${g.team_home}`, team_home: g.team_home, team_away: g.team_away,
      venue_id: g.venue_id, venue: venueNameById[g.venue_id] || g.venue_id,
      f5_line_open: g.f5_line_open, f5_line_current: g.f5_line_current, actual_f5_total: g.actual_f5_total,
      decision: judge?.decision || null, rejection_reason: judge?.rejection_reason || null,
      side: judge?.recommended_side || null, line: judge?.line ?? g.f5_line_current ?? null,
      edge: judge?.adjusted_edge ?? null, raw_edge: judge?.raw_edge ?? null,
      modelProb: judge?.model_probability ?? null, marketProb: judge?.market_implied_probability ?? null,
      confidence: judge?.confidence_multiplier ?? null, explanation: judge?.explanation || null,
      agent_attribution: judge?.agent_attribution || null,
      agentOutputs: {
        scout: agents.scout || null, lineup: agents.lineup || null,
        park: agents.park || null, storm: agents.storm || null,
        market: agents.market || null, judge: agents.judge || null,
      },
      trade: trade ? {
        id: trade.id, mode: trade.mode, side: trade.side, line: trade.line,
        contract_price: trade.contract_price, contracts: trade.contracts,
        size: trade.position_size_usd, executed_at: trade.executed_at,
      } : null,
      outcome: outcome ? {
        result: outcome.result, pnl: outcome.pnl_usd,
        actualF5: outcome.actual_f5_total, settled_at: outcome.settled_at,
      } : null,
    }
  })
  res.json(out)
}))

router.get('/game/:game_id', wrap(async (req, res) => {
  const g = await db.getGame(req.params.game_id)
  if (!g) return res.status(404).json({ error: 'game_not_found' })
  const [agentRows, projection, trade, venue] = await Promise.all([
    db.all(`SELECT agent, output_json FROM agent_outputs WHERE game_id = ?`, [g.id]),
    db.one(`SELECT * FROM projections WHERE game_id = ? ORDER BY created_at DESC LIMIT 1`, [g.id]),
    db.one(`SELECT * FROM trades WHERE game_id = ? ORDER BY id DESC LIMIT 1`, [g.id]),
    db.getVenue(g.venue_id),
  ])
  const agents = {}
  for (const r of agentRows) agents[r.agent] = safeJson(r.output_json)
  let outcome = null
  if (trade) outcome = await db.one(`SELECT * FROM outcomes WHERE trade_id = ?`, [trade.id])
  res.json({
    game: g, venue, agents,
    projection: projection ? {
      ...projection,
      feature_vector: safeJson(projection.feature_vector_json, {}),
      shap_values:    safeJson(projection.shap_values_json, {}),
    } : null,
    trade, outcome,
  })
}))

router.get('/trades', wrap(async (req, res) => {
  const mode  = req.query.mode === 'live' ? 'live' : 'paper'
  const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 50))
  const rows  = await db.all(
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
  res.json(rows.map(r => ({
    id: r.id, game_id: r.game_id, trade_date: r.trade_date,
    teams: r.team_home ? `${r.team_away} @ ${r.team_home}` : null,
    game_time: r.game_time, side: r.side, line: r.line,
    contract_price: r.contract_price, size: r.position_size_usd,
    edge: r.adjusted_edge, modelProb: r.model_probability,
    marketProb: r.market_implied_probability, confidence: r.confidence_multiplier,
    driver: r.primary_driver_agent, explanation: r.explanation,
    result: r.result, pnl: r.pnl_usd, actualF5: r.actual_f5_total, settled_at: r.settled_at,
  })))
}))

router.get('/calibration', wrap(async (req, res) => {
  const mode = req.query.mode === 'live' ? 'live' : 'paper'
  res.json(await computeCalibration(mode))
}))

router.get('/agents/accuracy', wrap(async (req, res) => {
  const mode   = req.query.mode === 'live' ? 'live' : 'paper'
  const trades = await db.all(
    `SELECT t.game_id, t.side, o.result
     FROM trades t INNER JOIN outcomes o ON o.trade_id = t.id
     WHERE t.mode = ? AND o.result IN ('WIN','LOSS')`,
    [mode],
  )
  if (!trades.length) {
    return res.json(['scout','lineup','park','storm','market','judge']
      .map(a => ({ agent: a, directionallyCorrect: 0, n: 0 })))
  }
  const ids = [...new Set(trades.map(t => t.game_id))]
  const placeholders = ids.map(() => '?').join(',')
  const rows = await db.all(
    `SELECT game_id, agent, output_json FROM agent_outputs WHERE game_id IN (${placeholders})`, ids,
  )
  const byGame = {}
  for (const r of rows) (byGame[r.game_id] ||= {})[r.agent] = safeJson(r.output_json)

  const tally = {
    scout:  { correct: 0, n: 0 }, lineup: { correct: 0, n: 0 },
    park:   { correct: 0, n: 0 }, storm:  { correct: 0, n: 0 },
    market: { correct: 0, n: 0 }, judge:  { correct: 0, n: 0 },
  }
  for (const t of trades) {
    const ag      = byGame[t.game_id] || {}
    const winSide = t.result === 'WIN' ? t.side : (t.side === 'OVER' ? 'UNDER' : 'OVER')
    if (ag.scout) {
      const h = ag.scout.pitcher_home?.quality_score, a = ag.scout.pitcher_away?.quality_score
      if (typeof h === 'number' && typeof a === 'number') {
        const avg = (h + a) / 2
        const lean = avg > 4.0 ? 'UNDER' : avg < 3.0 ? 'OVER' : null
        if (lean) { tally.scout.n++; if (lean === winSide) tally.scout.correct++ }
      }
    }
    if (ag.lineup) {
      const h = ag.lineup.lineup_home?.offensive_rating, a = ag.lineup.lineup_away?.offensive_rating
      if (typeof h === 'number' && typeof a === 'number') {
        const avg = (h + a) / 2
        const lean = avg > 103 ? 'OVER' : avg < 97 ? 'UNDER' : null
        if (lean) { tally.lineup.n++; if (lean === winSide) tally.lineup.correct++ }
      }
    }
    if (ag.park) {
      const f = ag.park.f5_factor ?? ag.park.run_factor
      if (typeof f === 'number') {
        const lean = f > 1.03 ? 'OVER' : f < 0.97 ? 'UNDER' : null
        if (lean) { tally.park.n++; if (lean === winSide) tally.park.correct++ }
      }
    }
    if (ag.storm) {
      const ws = ag.storm.weather_score
      if (typeof ws === 'number') {
        const lean = ws > 0.1 ? 'OVER' : ws < -0.1 ? 'UNDER' : null
        if (lean) { tally.storm.n++; if (lean === winSide) tally.storm.correct++ }
      }
    }
    if (ag.market) {
      const rec = ag.market.synthesis?.recommendation
      if (rec) {
        tally.market.n++
        if ((rec === 'proceed') === (t.result === 'WIN')) tally.market.correct++
      }
    }
    tally.judge.n++
    if (t.result === 'WIN') tally.judge.correct++
  }
  res.json(Object.entries(tally).map(([agent, v]) => ({
    agent,
    directionallyCorrect: v.n > 0 ? roundTo(v.correct / v.n, 4) : 0,
    n: v.n,
  })))
}))

router.get('/performance/weekly', wrap(async (req, res) => {
  const mode = req.query.mode === 'live' ? 'live' : 'paper'
  const rows = await db.all(
    `SELECT t.trade_date, t.position_size_usd, o.result, o.pnl_usd
     FROM trades t LEFT JOIN outcomes o ON o.trade_id = t.id
     WHERE t.mode = ? ORDER BY t.trade_date ASC`,
    [mode],
  )
  if (!rows.length) return res.json([])
  const weeks = {}
  for (const r of rows) {
    const { key, label } = isoWeekGroup(r.trade_date)
    const w = (weeks[key] ||= { week: label, start: key, trades: 0, wins: 0, losses: 0, pnl: 0, wagered: 0 })
    w.trades++
    w.wagered += Number(r.position_size_usd || 0)
    if (r.result === 'WIN') w.wins++
    else if (r.result === 'LOSS') w.losses++
    w.pnl += Number(r.pnl_usd || 0)
  }
  res.json(Object.values(weeks).sort((a, b) => a.start.localeCompare(b.start)).map(w => ({
    week: w.week, trades: w.trades, wins: w.wins, losses: w.losses,
    pnl: roundTo(w.pnl, 2),
    roi: w.wagered > 0 ? roundTo(w.pnl / w.wagered, 4) : 0,
  })))
}))

router.get('/performance/monthly', wrap(async (req, res) => {
  const mode = req.query.mode === 'live' ? 'live' : 'paper'
  const rows = await db.all(
    `SELECT substr(t.trade_date,1,7) AS ym,
            COUNT(*)                                             AS trades,
            SUM(CASE WHEN o.result = 'WIN'  THEN 1 ELSE 0 END)  AS wins,
            SUM(CASE WHEN o.result = 'LOSS' THEN 1 ELSE 0 END)  AS losses,
            SUM(COALESCE(o.pnl_usd,0))                          AS pnl,
            SUM(t.position_size_usd)                            AS wagered
     FROM trades t LEFT JOIN outcomes o ON o.trade_id = t.id
     WHERE t.mode = ?
     GROUP BY ym ORDER BY ym ASC`,
    [mode],
  )
  const m = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  res.json(rows.map(r => {
    const [y, mo] = String(r.ym).split('-')
    const wins    = Number(r.wins    || 0)
    const losses  = Number(r.losses  || 0)
    const pnl     = Number(r.pnl     || 0)
    const wagered = Number(r.wagered || 0)
    return {
      month: `${m[Number(mo) - 1] || mo} ${y}`,
      trades: Number(r.trades || 0), wins, losses,
      winRate: roundTo(winRate(wins, losses), 4),
      pnl: roundTo(pnl, 2),
      roi: wagered > 0 ? roundTo(pnl / wagered, 4) : 0,
    }
  }))
}))

router.get('/bankroll/history', wrap(async (req, res) => {
  const mode          = req.query.mode === 'live' ? 'live' : 'paper'
  const startBankroll = Number(process.env.BANKROLL || 5000)
  const rows = await db.all(
    `SELECT t.trade_date, SUM(COALESCE(o.pnl_usd,0)) AS pnl
     FROM trades t INNER JOIN outcomes o ON o.trade_id = t.id
     WHERE t.mode = ?
     GROUP BY t.trade_date ORDER BY t.trade_date ASC`,
    [mode],
  )
  if (!rows.length) return res.json([])
  let running = startBankroll
  res.json(rows.map(r => {
    const pnl = Number(r.pnl || 0)
    running += pnl
    return { date: r.trade_date, bankroll: roundTo(running, 2), pnl: roundTo(pnl, 2) }
  }))
}))

router.get('/backtest/models', wrap(async (req, res) => {
  const rows = await db.all(
    `SELECT id, trained_at, train_seasons, model_type, brier_score, auc_roc,
            val_win_rate_55, val_win_rate_60, val_roi_gross, val_roi_net,
            is_active, feature_importance_json, calibration_json, ablation_json
     FROM model_versions ORDER BY trained_at DESC`,
  )
  res.json(rows.map(r => ({
    id: r.id, trained_at: r.trained_at, train_seasons: r.train_seasons,
    model_type: r.model_type || 'binary_classifier',
    brier_score: r.brier_score, auc_roc: r.auc_roc,
    val_win_rate_55: r.val_win_rate_55, val_win_rate_60: r.val_win_rate_60,
    val_roi_gross: r.val_roi_gross, val_roi_net: r.val_roi_net,
    is_active: r.is_active === 1,
    feature_importance: safeJson(r.feature_importance_json, []),
    calibration: safeJson(r.calibration_json, []),
    ablation: safeJson(r.ablation_json, []),
  })))
}))

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
      id: model.id, trained_at: model.trained_at, train_seasons: model.train_seasons,
      model_type: model.model_type || 'binary_classifier',
      brier_score: model.brier_score, auc_roc: model.auc_roc,
      val_win_rate_55: model.val_win_rate_55, val_win_rate_60: model.val_win_rate_60,
      val_roi_gross: model.val_roi_gross, val_roi_net: model.val_roi_net,
      feature_importance: safeJson(model.feature_importance_json, []).slice(0, 15),
      calibration: safeJson(model.calibration_json, []),
      ablation: safeJson(model.ablation_json, []),
    } : null,
    data: {
      historical_games:  totalHistorical,
      games_with_lines:  Number(hasMatrix?.n || 0),
      seasons:           gameCounts.map(r => ({ season: r.season, games: r.n })),
    },
  })
}))

router.get('/backtest/games', wrap(async (req, res) => {
  const season       = req.query.season ? Number(req.query.season) : null
  const page         = Math.max(1, Number(req.query.page  || 1))
  const limit        = Math.min(100, Number(req.query.limit || 50))
  const offset       = (page - 1) * limit
  const sideFilter   = req.query.side
  const resultFilter = req.query.result

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
  const total = await db.one(`SELECT COUNT(*) as n FROM historical_games hg WHERE ${where}`, params)

  const games = rows.map(r => {
    const prob   = r.over_probability
    const line   = r.full_line_open
    const actual = r.actual_runs_total
    const side   = prob != null ? (prob >= 0.5 ? 'OVER' : 'UNDER') : null
    let result   = null
    if (actual != null && line != null && side) {
      if (actual > line) result = side === 'OVER' ? 'WIN' : 'LOSS'
      else if (actual < line) result = side === 'UNDER' ? 'WIN' : 'LOSS'
      else result = 'PUSH'
    }
    return {
      id: r.id, date: r.date, season: r.season,
      teams: `${r.team_away} @ ${r.team_home}`, line,
      actual, over_probability: prob != null ? roundTo(prob, 4) : null,
      projected_total: r.projected_total, side, result, model_version: r.model_version,
    }
  }).filter(g => {
    if (sideFilter   && g.side   !== sideFilter)   return false
    if (resultFilter && g.result !== resultFilter)  return false
    return true
  })
  res.json({ games, total: Number(total?.n || 0), page, limit })
}))

router.get('/backtest/performance', wrap(async (req, res) => {
  const seasons = req.query.season ? [Number(req.query.season)] : [2023, 2024, 2025]
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
    const BET = 100
    for (const r of rows) {
      const prob    = Number(r.over_probability || 0.5)
      const line    = Number(r.full_line_open)
      const actual  = Number(r.actual_runs_total)
      const side    = prob >= 0.5 ? 'OVER' : 'UNDER'
      const adjProb = side === 'OVER' ? prob : 1 - prob
      if (adjProb < 0.52) continue
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
      season, n: rows.length, traded: total, wins, losses, pushes,
      win_rate:    total > 0 ? roundTo(wins / total, 4) : null,
      win_rate_55: n55   > 0 ? roundTo(wins55 / n55, 4) : null, n55,
      win_rate_60: n60   > 0 ? roundTo(wins60 / n60, 4) : null, n60,
      wagered: roundTo(wagered, 2), pnl: roundTo(pnl, 2),
      roi: wagered > 0 ? roundTo(pnl / wagered, 4) : null,
    })
  }
  res.json(results)
}))

router.get('/backtest/convergence', wrap(async (req, res) => {
  const rows = await db.all(
    `SELECT COUNT(*) as n,
            AVG(ABS(kalshi_price_open - sportsbook_implied_open)) as avg_gap_open,
            AVG(ABS(kalshi_price_2hr - sportsbook_implied_2hr)) as avg_gap_2hr,
            AVG(ABS(kalshi_price_30min - sportsbook_implied_30min)) as avg_gap_30min,
            AVG(time_to_convergence_min) as avg_convergence_min
     FROM convergence_log WHERE kalshi_price_open IS NOT NULL`,
  )
  const recent = await db.all(
    `SELECT game_date, full_line, kalshi_price_open, sportsbook_implied_open,
            kalshi_price_2hr, sportsbook_implied_2hr,
            time_to_convergence_min, convergence_trigger
     FROM convergence_log ORDER BY game_date DESC LIMIT 20`,
  )
  res.json({ summary: rows[0] || { n: 0 }, recent })
}))

export default router
