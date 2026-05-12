import express from 'express'
import * as db from '../../lib/db.js'
import { wrap } from '../shared.js'
import { getAllRules, setRule, resetRule } from '../../lib/bettingRules.js'
import { getShadowSummary } from '../../lib/calibrationEngine.js'

const router = express.Router()

// ── Calibration curve (predicted prob vs actual win rate) ─────────────────────
router.get('/ks/calibration/curve', wrap(async (req, res) => {
  const rows = await db.all(
    `SELECT bucket_key, predicted, actual, multiplier, sample_size, ci_low, ci_high
     FROM calibration_params WHERE active=1 AND param_type='prob_bucket' ORDER BY bucket_lo ASC`
  )
  res.json({ rows })
}))

// ── Edge quality (edge bucket vs actual ROI) ──────────────────────────────────
router.get('/ks/calibration/edge', wrap(async (req, res) => {
  const rows = await db.all(
    `SELECT bucket_key, bucket_lo, bucket_hi, expected_roi, actual_roi, sample_size
     FROM calibration_params WHERE active=1 AND param_type='edge_bucket' ORDER BY bucket_lo ASC`
  )
  const minEdge = await db.one(
    `SELECT bucket_lo FROM calibration_params WHERE active=1 AND param_type='min_edge' LIMIT 1`
  ).catch(() => null)
  res.json({ rows, minEdge: minEdge?.bucket_lo ?? null })
}))

// ── Pitcher reliability scores ────────────────────────────────────────────────
router.get('/ks/calibration/pitchers', wrap(async (req, res) => {
  const limit     = Math.min(parseInt(req.query.limit || '20', 10), 100)
  const direction = req.query.direction === 'bottom' ? 'ASC' : 'DESC'
  const rows = await db.all(`
    SELECT pc.pitcher_id, pc.pitcher_name, pc.n_bets, pc.actual_roi,
           pc.expected_roi, pc.reliability, pc.avg_edge, pc.last_bet_date
    FROM pitcher_calibration pc
    INNER JOIN (
      SELECT pitcher_id, MAX(run_id) AS latest_run
      FROM pitcher_calibration GROUP BY pitcher_id
    ) latest ON pc.pitcher_id = latest.pitcher_id AND pc.run_id = latest.latest_run
    ORDER BY pc.reliability ${direction}
    LIMIT ?
  `, [limit])
  res.json({ rows })
}))

// ── Calibration run history ───────────────────────────────────────────────────
router.get('/ks/calibration/runs', wrap(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '10', 10), 50)
  const rows  = await db.all(
    `SELECT id, started_at, finished_at, status, trigger, n_resolved_bets,
            buckets_updated, pitchers_scored, walkforward_delta_pct, promoted, notes
     FROM calibration_runs ORDER BY started_at DESC LIMIT ?`,
    [limit]
  )
  res.json({ rows })
}))

router.get('/ks/calibration/runs/:id', wrap(async (req, res) => {
  const row = await db.one(`SELECT * FROM calibration_runs WHERE id=?`, [req.params.id])
  if (!row) return res.status(404).json({ error: 'Not found' })
  if (row.report_json) row.report = JSON.parse(row.report_json)
  res.json({ run: row })
}))

// ── Manual calibration trigger ────────────────────────────────────────────────
router.post('/ks/calibration/run', wrap(async (req, res) => {
  const { runCalibration } = await import('../../lib/calibrationEngine.js')
  const result = await runCalibration({ trigger: 'manual', dryRun: req.body?.dry_run === true })
  res.json(result)
}))

// ── Snapshot collection health ────────────────────────────────────────────────
router.get('/ks/snapshots/stats', wrap(async (req, res) => {
  const [total, resolved, recent, byDate] = await Promise.all([
    db.one(`SELECT COUNT(*) AS n FROM market_snapshots`).catch(() => null),
    db.one(`SELECT COUNT(*) AS n FROM market_snapshots WHERE actual_ks IS NOT NULL`).catch(() => null),
    db.one(`SELECT COUNT(*) AS n FROM market_snapshots WHERE game_date >= date('now','-7 days')`).catch(() => null),
    db.all(`SELECT game_date, COUNT(*) AS n, COUNT(actual_ks) AS resolved
            FROM market_snapshots WHERE game_date >= date('now','-14 days')
            GROUP BY game_date ORDER BY game_date DESC`).catch(() => []),
  ])
  res.json({
    total:    total?.n    ?? 0,
    resolved: resolved?.n ?? 0,
    recent:   recent?.n   ?? 0,
    byDate,
  })
}))

// ── Backtest run ──────────────────────────────────────────────────────────────
router.post('/ks/backtest/run', wrap(async (req, res) => {
  const { runBacktest, runWalkForward } = await import('../../lib/backtester.js')
  const userId = req.session?.userId ?? null
  const config = req.body ?? {}
  const result = config.walkforward
    ? await runWalkForward(config, userId, config.walkForwardOpts)
    : await runBacktest(config, userId)
  res.json(result)
}))

// ── Backtest run history ──────────────────────────────────────────────────────
router.get('/ks/backtest/runs', wrap(async (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit || '20', 10), 100)
  const userId = req.session?.userId ?? null
  const rows   = await db.all(`
    SELECT id, created_at, label, date_start, date_end,
           total_bets, win_rate, roi, total_pnl, sharpe, max_drawdown, status
    FROM backtest_runs
    WHERE (? IS NULL OR user_id=?)
    ORDER BY created_at DESC LIMIT ?
  `, [userId, userId, limit])
  res.json({ rows })
}))

router.get('/ks/backtest/runs/:id', wrap(async (req, res) => {
  const row = await db.one(`SELECT * FROM backtest_runs WHERE id=?`, [req.params.id])
  if (!row) return res.status(404).json({ error: 'Not found' })
  for (const f of ['config_json','summary_json','equity_curve_json','per_pitcher_json','per_strike_json','calibration_json','walkforward_json']) {
    if (row[f]) { row[f.replace('_json','')] = JSON.parse(row[f]); delete row[f] }
  }
  res.json({ run: row })
}))

// ── Betting rules ─────────────────────────────────────────────────────────────
router.get('/ks/rules', wrap(async (_req, res) => {
  const rules = await getAllRules()
  res.json({ rules })
}))

router.post('/ks/rules/:key', wrap(async (req, res) => {
  const { key } = req.params
  const { value } = req.body
  if (value == null || isNaN(Number(value))) return res.status(400).json({ error: 'value required' })
  await setRule(key, Number(value), req.user?.name ?? 'manual')
  res.json({ ok: true })
}))

router.post('/ks/rules/:key/reset', wrap(async (req, res) => {
  const { key } = req.params
  await resetRule(key)
  res.json({ ok: true })
}))

// ── Item 8: Per-threshold reliability audit ───────────────────────────────────
// Groups settled pre-game bets by (strike, side). Compares avg model_prob to
// actual win rate. Flags groups with ≥5 bets where |gap| > 10%.
router.get('/ks/calibration/reliability-by-strike', wrap(async (_req, res) => {
  const rows = await db.all(`
    SELECT
      strike,
      side,
      COUNT(*) AS bets,
      ROUND(AVG(model_prob), 4) AS avg_model_prob,
      ROUND(AVG(CASE WHEN result='win' THEN 1.0 ELSE 0.0 END), 4) AS actual_win_rate,
      ROUND(AVG(model_prob) - AVG(CASE WHEN result='win' THEN 1.0 ELSE 0.0 END), 4) AS prob_gap,
      ROUND(SUM(COALESCE(pnl,0)), 2) AS pnl,
      ROUND(AVG(edge), 4) AS avg_edge
    FROM ks_bets
    WHERE result IN ('win','loss') AND live_bet=0 AND paper=0 AND model_prob IS NOT NULL
    GROUP BY strike, side
    HAVING bets >= 3
    ORDER BY strike ASC, side ASC
  `)
  res.json({
    rows: rows.map(r => ({
      ...r,
      flagged: Number(r.bets) >= 5 && Math.abs(Number(r.prob_gap)) > 0.10,
    })),
  })
}))

// ── Item 8: Preflight effect on outcomes ──────────────────────────────────────
// Shows win rate and ROI split by whether Claude boosted, cleared, or would have skipped.
// Joins ks_bets (outcome) with decision_pipeline (preflight_json).
router.get('/ks/calibration/preflight-effect', wrap(async (_req, res) => {
  const rows = await db.all(`
    SELECT
      COALESCE(JSON_EXTRACT(dp.preflight_json, '$.action'), 'unknown') AS preflight_action,
      COUNT(k.id) AS bets,
      SUM(CASE WHEN k.result='win'  THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN k.result='loss' THEN 1 ELSE 0 END) AS losses,
      ROUND(SUM(COALESCE(k.pnl,0)), 2) AS pnl,
      ROUND(SUM(COALESCE(k.capital_at_risk, k.bet_size, 0)), 2) AS wagered,
      ROUND(AVG(k.edge), 4) AS avg_edge
    FROM ks_bets k
    JOIN decision_pipeline dp
      ON dp.bet_date = k.bet_date
     AND dp.pitcher_id = CAST(k.pitcher_id AS TEXT)
    WHERE k.result IN ('win','loss') AND k.live_bet=0 AND k.paper=0
    GROUP BY preflight_action
    ORDER BY bets DESC
  `)
  res.json({
    rows: rows.map(r => {
      const wins    = Number(r.wins   || 0)
      const losses  = Number(r.losses || 0)
      const wagered = Number(r.wagered || 0)
      const pnl     = Number(r.pnl    || 0)
      return {
        preflight_action: r.preflight_action,
        bets:     Number(r.bets || 0),
        wins, losses,
        win_rate: wins + losses > 0 ? Math.round(wins / (wins + losses) * 1000) / 1000 : 0,
        pnl,
        roi:      wagered > 0 ? Math.round(pnl / wagered * 1000) / 1000 : 0,
        avg_edge: r.avg_edge,
      }
    }),
  })
}))

// ── Shadow analysis ───────────────────────────────────────────────────────────
router.get('/ks/calibration/shadow', wrap(async (_req, res) => {
  const groups = await getShadowSummary()
  res.json({ groups })
}))

export default router
