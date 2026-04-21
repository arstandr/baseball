#!/usr/bin/env node
// cli.js — Commander entrypoint for MLBIE.

import { Command } from 'commander'
import 'dotenv/config'

import * as db from './lib/db.js'
import * as fetchPipeline from './pipeline/fetch.js'
import * as orchestrate from './pipeline/orchestrate.js'
import * as execute from './pipeline/execute.js'
import { buildFeatureVector } from './lib/features.js'
import { seedVenues } from './agents/park/index.js'
import { alertPaperSummary } from './lib/telegram.js'
import { predict, resolveActiveModelDir } from './lib/model.js'
import path from 'node:path'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const program = new Command()
program
  .name('mlbie')
  .description('MLB Betting Intelligence Engine')
  .version('0.1.0')

// ------------------------------------------------------------------
// migrate
// ------------------------------------------------------------------
program
  .command('migrate')
  .description('Run libSQL migrations (idempotent)')
  .action(async () => {
    const res = await db.migrate()
    await seedVenues()
    console.log(JSON.stringify({ ok: true, ...res }, null, 2))
    await db.close()
  })

// ------------------------------------------------------------------
// fetch
// ------------------------------------------------------------------
program
  .command('fetch')
  .description('Ingest all data sources for a date')
  .option('-d, --date <date>', 'Date (YYYY-MM-DD or "today")', 'today')
  .option('-t, --type <types>', 'Comma-separated types (schedule,starters,lines,lineups,weather,convergence)',
    'schedule,starters,lines')
  .action(async (opts) => {
    const types = opts.type.split(',').map(s => s.trim())
    const res = await fetchPipeline.fetch({ date: opts.date, types })
    console.log(JSON.stringify(res, null, 2))
    await db.close()
  })

// ------------------------------------------------------------------
// signal — compute features+projections for all games on a date
// ------------------------------------------------------------------
program
  .command('signal')
  .description('Run all agents + XGBoost projection for a date')
  .option('-d, --date <date>', 'Date', 'today')
  .option('-c, --concurrency <n>', 'Parallel game workers', '4')
  .action(async (opts) => {
    const date = opts.date === 'today' ? new Date().toISOString().slice(0, 10) : opts.date
    const games = await db.getGamesByDate(date)
    if (!games.length) {
      console.log(JSON.stringify({ ok: true, date, games: 0, message: 'run `mlbie fetch` first' }))
      await db.close()
      return
    }
    const results = await orchestrate.runSlate(games, {
      concurrency: Number(opts.concurrency),
    })
    const summary = results.map(r => ({
      game_id: r.game?.id,
      teams: `${r.game?.team_away} @ ${r.game?.team_home}`,
      decision: r.decision?.decision,
      adjusted_edge: r.decision?.adjusted_edge,
      side: r.decision?.recommended_side,
      size: r.decision?.position_size,
      reason: r.decision?.rejection_reason,
    }))
    console.log(JSON.stringify({ ok: true, date, results: summary }, null, 2))
    await db.close()
  })

// ------------------------------------------------------------------
// scan — list candidates above edge threshold
// ------------------------------------------------------------------
program
  .command('scan')
  .description('Find trade candidates above edge threshold')
  .option('-d, --date <date>', 'Date', 'today')
  .option('-t, --threshold <value>', 'Edge threshold', '0.06')
  .action(async (opts) => {
    const date = opts.date === 'today' ? new Date().toISOString().slice(0, 10) : opts.date
    const threshold = Number(opts.threshold)
    // Pull Judge outputs from agent_outputs
    const rows = await db.all(
      `SELECT game_id, output_json FROM agent_outputs
       WHERE agent = 'judge' AND game_id IN (
         SELECT id FROM games WHERE date = ?
       )`,
      [date],
    )
    const candidates = []
    for (const r of rows) {
      let out
      try { out = JSON.parse(r.output_json) } catch { continue }
      if (out.decision === 'TRADE' && out.adjusted_edge >= threshold) {
        candidates.push({
          game_id: out.game_id,
          side: out.recommended_side,
          edge: out.adjusted_edge,
          size: out.position_size,
          driver: out.agent_attribution?.primary_driver,
          explanation: out.explanation,
        })
      }
    }
    candidates.sort((a, b) => b.edge - a.edge)
    console.log(JSON.stringify({ ok: true, date, threshold, candidates }, null, 2))
    await db.close()
  })

// ------------------------------------------------------------------
// trade — log trades (paper) or execute (live)
// ------------------------------------------------------------------
program
  .command('trade')
  .description('Fire trades for TRADE-decision games on the slate')
  .option('-d, --date <date>', 'Date', 'today')
  .option('--dry-run', 'Paper mode — log only, no execution', false)
  .option('--execute', 'Live mode — dispatch to execution adapter', false)
  .action(async (opts) => {
    const date = opts.date === 'today' ? new Date().toISOString().slice(0, 10) : opts.date
    const mode = opts.execute ? execute.MODE_LIVE : execute.MODE_PAPER
    const games = await db.getGamesByDate(date)

    let signals = 0
    let tradesLogged = 0
    let edgeSum = 0
    for (const g of games) {
      const judgeOut = await db.getAgentOutput(g.id, 'judge')
      if (!judgeOut || judgeOut.decision !== 'TRADE') continue
      signals += 1
      const tradeId = await execute.logTrade({ game: g, decision: judgeOut, mode })
      if (!tradeId) continue
      tradesLogged += 1
      edgeSum += judgeOut.adjusted_edge || 0
      if (mode === execute.MODE_LIVE) {
        const res = await execute.executeLive({ tradeId, game: g, decision: judgeOut })
        console.log(`[live] trade ${tradeId}:`, res)
      }
    }
    if (mode === execute.MODE_PAPER) {
      await alertPaperSummary({
        date,
        signals_found: signals,
        trades_logged: tradesLogged,
        avg_edge: tradesLogged ? edgeSum / tradesLogged : 0,
      })
    }
    console.log(JSON.stringify({ ok: true, date, mode, signals, trades_logged: tradesLogged }, null, 2))
    await db.close()
  })

// ------------------------------------------------------------------
// settle — pull outcomes for every open trade
// ------------------------------------------------------------------
program
  .command('settle')
  .description('Settle full-game outcomes for any trades without an outcome row')
  .action(async () => {
    const settled = await execute.settlePending()
    console.log(JSON.stringify({ ok: true, settled: settled.length, detail: settled }, null, 2))
    await db.close()
  })

// ------------------------------------------------------------------
// report — daily P&L summary
// ------------------------------------------------------------------
program
  .command('report')
  .description('Daily P&L summary + Telegram push')
  .option('-d, --date <date>', 'Date', 'today')
  .option('--yesterday', 'Shortcut for yesterday\'s date', false)
  .option('--mode <mode>', 'paper|live', 'paper')
  .action(async (opts) => {
    let date = opts.date
    if (opts.yesterday || opts.date === 'yesterday') {
      date = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10)
    } else if (date === 'today') {
      date = new Date().toISOString().slice(0, 10)
    }
    const r = await execute.buildDailyReport({ date, mode: opts.mode })
    console.log(JSON.stringify(r, null, 2))
    await db.close()
  })

// ------------------------------------------------------------------
// analyze — feature importance / SHAP / drift
// ------------------------------------------------------------------
program
  .command('analyze')
  .description('Model analysis: feature importance, SHAP for a game, drift')
  .option('--feature-importance', 'Print global feature importance')
  .option('--shap', 'Print SHAP for a specific game')
  .option('-g, --game <id>', 'Game id (for --shap)')
  .option('--drift', 'Feature drift report')
  .option('-w, --window <w>', 'Drift window, e.g. 60d', '60d')
  .action(async (opts) => {
    const dir = await resolveActiveModelDir()
    if (!dir) {
      console.log(JSON.stringify({ ok: false, error: 'no trained model' }))
      await db.close()
      return
    }
    if (opts.featureImportance) {
      const raw = await fs.readFile(path.join(dir, 'feature_importance.json'), 'utf-8')
      console.log(raw)
    }
    if (opts.shap) {
      if (!opts.game) {
        console.error('--shap requires --game <id>')
        process.exit(2)
      }
      const proj = await db.one(
        `SELECT feature_vector_json, shap_values_json FROM projections WHERE game_id = ? ORDER BY created_at DESC LIMIT 1`,
        [opts.game],
      )
      if (!proj) {
        console.log(JSON.stringify({ ok: false, error: 'no projection for that game' }))
      } else {
        console.log(
          JSON.stringify(
            { shap: JSON.parse(proj.shap_values_json || '{}'), features: JSON.parse(proj.feature_vector_json || '{}') },
            null,
            2,
          ),
        )
      }
    }
    if (opts.drift) {
      // Drift placeholder: show difference between current model's feature
      // importance and the previous version's.
      const parent = path.dirname(dir)
      const entries = (await fs.readdir(parent)).sort()
      if (entries.length < 2) {
        console.log(JSON.stringify({ ok: false, error: 'need >= 2 model versions for drift' }))
      } else {
        const cur = JSON.parse(await fs.readFile(path.join(parent, entries[entries.length - 1], 'feature_importance.json'), 'utf-8'))
        const prev = JSON.parse(await fs.readFile(path.join(parent, entries[entries.length - 2], 'feature_importance.json'), 'utf-8'))
        const drift = {}
        for (const [k, cv] of Object.entries(cur)) {
          const pv = prev[k] || 0
          drift[k] = {
            baseline: pv,
            current: cv,
            pct_change: pv ? (cv - pv) / pv : null,
          }
        }
        const sorted = Object.fromEntries(
          Object.entries(drift).sort((a, b) => Math.abs(b[1].pct_change ?? 0) - Math.abs(a[1].pct_change ?? 0)).slice(0, 30),
        )
        console.log(JSON.stringify({ window: opts.window, drift: sorted }, null, 2))
      }
    }
    await db.close()
  })

// ------------------------------------------------------------------
// backtest — run orchestrator over a historical season
// ------------------------------------------------------------------
program
  .command('backtest')
  .description('Replay the orchestrator on historical games for a season')
  .option('-s, --season <season>', 'Season (e.g. 2024)', '2024')
  .option('--mode <mode>', 'full or f5', 'full')
  .action(async (opts) => {
    const season = Number(opts.season)
    const games = await db.all(
      `SELECT * FROM games WHERE season = ? AND status = 'final' ORDER BY game_time ASC`,
      [season],
    )
    if (!games.length) {
      console.log(JSON.stringify({ ok: false, error: `no games found for season ${season}` }))
      await db.close()
      return
    }
    const results = await orchestrate.runSlate(games, { concurrency: 2 })
    // Backtest-specific aggregations
    let wins = 0, losses = 0, pushes = 0, pnl = 0, nTrades = 0
    for (const r of results) {
      if (r.decision?.decision !== 'TRADE') continue
      const actual = opts.mode === 'f5'
        ? r.game.f5_runs_total
        : r.game.actual_runs_total
      if (actual == null) continue
      const line = r.decision.line
      let outcome = 'PUSH'
      if (actual > line) outcome = r.decision.recommended_side === 'OVER' ? 'WIN' : 'LOSS'
      else if (actual < line) outcome = r.decision.recommended_side === 'OVER' ? 'LOSS' : 'WIN'
      nTrades += 1
      if (outcome === 'WIN') {
        wins += 1
        pnl += r.decision.position_size * (1 / Math.max(r.decision.contract_price, 0.01) - 1)
      } else if (outcome === 'LOSS') {
        losses += 1
        pnl -= r.decision.position_size
      } else {
        pushes += 1
      }
    }
    console.log(JSON.stringify({
      season,
      games: games.length,
      trades: nTrades,
      wins,
      losses,
      pushes,
      win_rate: nTrades ? (wins / (wins + losses || 1)) : 0,
      pnl: Number(pnl.toFixed(2)),
      roi: nTrades ? Number((pnl / nTrades / 100).toFixed(4)) : 0,
    }, null, 2))
    await db.close()
  })

// ------------------------------------------------------------------
// f5-analyze — shell out to scripts/historical/analyzeF5.js
// ------------------------------------------------------------------
program
  .command('f5-analyze')
  .description('Run F5 analysis via scripts/historical/analyzeF5.js')
  .option('--season <season>', 'Season or range (e.g. 2024 or 2020-2024)')
  .option('--line <line>', 'F5 line value to analyze against')
  .action((opts) => {
    const args = [path.resolve(__dirname, 'scripts', 'historical', 'analyzeF5.js')]
    if (opts.season) args.push('--season', opts.season)
    if (opts.line) args.push('--line', opts.line)
    const proc = spawn(process.execPath, args, { stdio: 'inherit' })
    proc.on('close', code => process.exit(code))
  })

// ------------------------------------------------------------------
// train — shell out to Python
// ------------------------------------------------------------------
program
  .command('train')
  .description('Train the XGBoost model (calls models/train.py)')
  .requiredOption('--csv <path>', 'Feature matrix CSV')
  .option('--version <id>', 'Model version id')
  .action((opts) => {
    const pythonBin = process.env.PYTHON_BIN || 'python3'
    const args = [path.resolve(__dirname, 'models', 'train.py'), '--csv', opts.csv]
    if (opts.version) args.push('--version', opts.version)
    const proc = spawn(pythonBin, args, { stdio: 'inherit' })
    proc.on('close', code => process.exit(code))
  })

// ------------------------------------------------------------------
// evaluate — shell out to Python
// ------------------------------------------------------------------
program
  .command('evaluate')
  .description('Evaluate a trained model (calls models/evaluate.py)')
  .requiredOption('--model-dir <path>', 'Path to trained model directory')
  .requiredOption('--predictions-csv <path>', 'Predictions CSV')
  .option('--baseline-dir <path>', 'Baseline model dir for drift')
  .action((opts) => {
    const pythonBin = process.env.PYTHON_BIN || 'python3'
    const args = [
      path.resolve(__dirname, 'models', 'evaluate.py'),
      '--model-dir', opts.modelDir,
      '--predictions-csv', opts.predictionsCsv,
    ]
    if (opts.baselineDir) args.push('--baseline-dir', opts.baselineDir)
    const proc = spawn(pythonBin, args, { stdio: 'inherit' })
    proc.on('close', code => process.exit(code))
  })

// ------------------------------------------------------------------
// historical — fetch historical data + build feature matrix
// ------------------------------------------------------------------
program
  .command('historical')
  .description('Historical data pipeline: fetch games, odds, pitcher/team/bullpen stats; build feature matrix')
  .option('--season <range>', 'Season or range (e.g. "2020" or "2020-2025")')
  .option('--stage <stage>', 'Stage to run: all | games | odds | pitchers | team-offense | bullpen | umpires | build-umpire-stats | build-matrix | validate', 'all')
  .option('--build-matrix', 'Shortcut for --stage build-matrix', false)
  .option('--validate', 'Shortcut for --stage validate', false)
  .option('--skip-weather', 'Skip weather fetch during matrix build', false)
  .action(async (opts) => {
    const stage = opts.buildMatrix ? 'build-matrix' : opts.validate ? 'validate' : opts.stage
    const seasons = parseSeasons(opts.season)

    // Ensure schema migrated before touching historical_* tables
    await db.migrate()

    if (stage === 'validate') {
      const { validate } = await import('./scripts/historical/validate.js')
      const report = await validate()
      console.log(JSON.stringify(report, null, 2))
      await db.close()
      return
    }

    if (stage === 'build-matrix') {
      const { buildAll } = await import('./scripts/historical/buildFeatureMatrix.js')
      const r = await buildAll({ seasons, skipWeather: opts.skipWeather })
      console.log(JSON.stringify({ ok: true, ...r }, null, 2))
      await db.close()
      return
    }

    if (stage === 'build-umpire-stats') {
      const { buildAllUmpireStats } = await import('./scripts/historical/buildUmpireStats.js')
      const r = await buildAllUmpireStats()
      console.log(JSON.stringify({ ok: true, ...r }, null, 2))
      await db.close()
      return
    }

    if (!seasons.length) {
      console.error('historical: --season required for fetch stages')
      process.exit(2)
    }

    const runStage = stage === 'all'
    const out = { stages: {} }

    if (runStage || stage === 'games') {
      const { ingestRange } = await import('./scripts/historical/fetchGames.js')
      out.stages.games = await ingestRange(seasons[0], seasons[seasons.length - 1])
    }
    if (runStage || stage === 'odds') {
      const { ingestSeason } = await import('./scripts/historical/fetchOdds.js')
      out.stages.odds = []
      for (const s of seasons) {
        out.stages.odds.push({ season: s, result: await ingestSeason(s) })
      }
    }
    if (runStage || stage === 'pitchers') {
      const { ingestSeason } = await import('./scripts/historical/fetchPitcherStats.js')
      out.stages.pitchers = []
      for (const s of seasons) out.stages.pitchers.push(await ingestSeason(s))
    }
    if (runStage || stage === 'team-offense') {
      const { ingestSeason } = await import('./scripts/historical/fetchTeamOffense.js')
      out.stages.team_offense = []
      for (const s of seasons) out.stages.team_offense.push(await ingestSeason(s))
    }
    if (runStage || stage === 'bullpen') {
      const { ingestSeason } = await import('./scripts/historical/fetchBullpen.js')
      out.stages.bullpen = []
      for (const s of seasons) out.stages.bullpen.push(await ingestSeason(s))
    }
    if (runStage || stage === 'umpires') {
      const { ingestUmpiresForSeason } = await import('./scripts/historical/fetchUmpires.js')
      out.stages.umpires = []
      for (const s of seasons) out.stages.umpires.push(await ingestUmpiresForSeason(s))
    }
    if (runStage || stage === 'build-umpire-stats') {
      const { buildAllUmpireStats } = await import('./scripts/historical/buildUmpireStats.js')
      out.stages.umpire_stats = await buildAllUmpireStats()
    }
    if (runStage) {
      const { buildAll } = await import('./scripts/historical/buildFeatureMatrix.js')
      out.stages.matrix = await buildAll({ seasons, skipWeather: opts.skipWeather })
    }
    console.log(JSON.stringify({ ok: true, ...out }, null, 2))
    await db.close()
  })

function parseSeasons(value) {
  if (!value) return []
  if (String(value).includes('-')) {
    const [a, b] = String(value).split('-').map(s => Number(s.trim()))
    if (!Number.isFinite(a) || !Number.isFinite(b)) return []
    const out = []
    for (let y = a; y <= b; y++) out.push(y)
    return out
  }
  const n = Number(value)
  return Number.isFinite(n) ? [n] : []
}

// ------------------------------------------------------------------
// serve — launch the web dashboard (Express + Google OAuth)
// ------------------------------------------------------------------
program
  .command('serve')
  .description('Start the MLBIE web dashboard')
  .option('-p, --port <port>', 'Port (default: env PORT or 3000)')
  .action(async (opts) => {
    if (opts.port) process.env.PORT = String(opts.port)
    const { startServer } = await import('./server/index.js')
    startServer()
    // Intentionally do NOT close the DB — the HTTP server needs it live.
  })

// ------------------------------------------------------------------
// Parse
// ------------------------------------------------------------------
program.parseAsync(process.argv).catch(async err => {
  console.error('[cli] error:', err.stack || err.message)
  await db.close().catch(() => {})
  process.exit(1)
})
