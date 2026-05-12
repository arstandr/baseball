// Hypothesis Registry CLI + nightly evaluator.
//
// Subcommands:
//   register --code H-X --desc "..." --filter "<JS expr>" [--min-fires N] [--promote-roi 0.20] [--reject-roi -0.05]
//   list                              show all hypotheses with current stats
//   evaluate                          run nightly: score each active hypothesis
//   promote --code H-X                manually mark as promoted
//   reject --code H-X                 manually mark as rejected
//
// Filter logic is a JS expression evaluated against a fire row `f`. Examples:
//   "f.avg_innings_l5 == null || Number(f.avg_innings_l5) >= 5.0"
//   "Number(f.strike) === 6 || Number(f.strike) >= 10"
//   "Number(f.fill_price) <= 25"
//
// Each evaluation segments fires by registered_at:
//   - in-sample (informational): fires settled before hypothesis registered
//   - out-of-sample (binding): fires settled after registration
// Decisions only consider OUT-OF-SAMPLE results.

import 'dotenv/config'
import { createClient } from '@libsql/client'

const TEST_START = '2026-05-07'
const FEE = 0.07
const STARTING = 5000

const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })

function getArg(name) {
  const idx = process.argv.indexOf('--' + name)
  return idx > 0 ? process.argv[idx + 1] : null
}

const cmd = process.argv[2]

async function register() {
  const code = getArg('code'), desc = getArg('desc'), filter = getArg('filter')
  if (!code || !desc || !filter) {
    console.error('usage: register --code H-X --desc "..." --filter "<JS expr>"')
    process.exit(1)
  }
  const minFires = Number(getArg('min-fires') ?? 50)
  const promote = Number(getArg('promote-roi') ?? 0.20)
  const reject = Number(getArg('reject-roi') ?? -0.05)
  const target = getArg('target') ?? 'pregame_fade_yes'
  const by = getArg('by') ?? 'manual'

  // Validate filter expression compiles
  try { new Function('f', `return (${filter})`) }
  catch (err) { console.error(`Filter syntax error: ${err.message}`); process.exit(1) }

  await db.execute({
    sql: `INSERT INTO hypothesis_registry
      (code, description, filter_logic, strategy_target, registered_at, registered_by,
       min_fires_for_decision, promote_roi_threshold, reject_roi_threshold)
      VALUES (?, ?, ?, ?, datetime('now'), ?, ?, ?, ?)`,
    args: [code, desc, filter, target, by, minFires, promote, reject],
  })
  console.log(`✓ Registered ${code}`)
}

async function list() {
  const r = await db.execute(`SELECT * FROM hypothesis_registry ORDER BY registered_at DESC`)
  console.log(`code     status      registered                 description`)
  console.log('─'.repeat(110))
  for (const h of r.rows) {
    console.log(`${(h.code ?? '').padEnd(8)} ${(h.status ?? '').padEnd(11)} ${(h.registered_at ?? '').slice(0, 19)}  ${(h.description ?? '').slice(0, 60)}`)
  }
}

async function evaluate() {
  // Load all settled fade fires with joined intelligence
  const fires = await db.execute(`
    SELECT b.id, b.bet_date, b.pitcher_name, b.strike, b.fill_price, b.filled_contracts,
           b.edge AS live_edge, b.model_prob, b.result, b.pnl, b.actual_ks, b.filled_at,
           p.confidence, p.swstr_pct, p.avg_innings_l5, p.fstrike_pct, p.bb9, p.era_l5, p.hand,
           f.production_model_prob, f.park_k_factor, f.park
    FROM ks_bets b
    LEFT JOIN pitcher_signals p ON p.pitcher_id = b.pitcher_id AND p.signal_date = b.bet_date
    LEFT JOIN fade_paper_test_candidates f ON f.pitcher_id = b.pitcher_id AND f.target_date = b.bet_date AND f.strike = b.strike
    WHERE b.strategy_mode = 'pregame_fade_yes' AND b.bet_date >= '${TEST_START}'
      AND b.result IN ('win', 'loss')
  `)
  console.log(`Evaluating ${fires.rows.length} settled fires`)

  const hyps = await db.execute(`SELECT * FROM hypothesis_registry WHERE status IN ('proposed','active')`)
  console.log(`${hyps.rows.length} active hypotheses\n`)

  const evaluatedAt = new Date().toISOString()

  console.log('code     in-sample fires/wins/pnl              out-of-sample fires/wins/pnl/roi')
  console.log('─'.repeat(110))

  for (const h of hyps.rows) {
    let filterFn
    try { filterFn = new Function('f', `return (${h.filter_logic})`) }
    catch (err) { console.error(`  ${h.code}: filter syntax error: ${err.message}`); continue }

    const inSample = []  // settled BEFORE hypothesis registered
    const outSample = [] // settled AFTER hypothesis registered
    for (const f of fires.rows) {
      let pass
      try { pass = filterFn(f) } catch { continue }
      if (!pass) continue
      const filledAt = f.filled_at ?? `${f.bet_date}T12:00:00.000Z`
      if (filledAt < h.registered_at) inSample.push(f)
      else outSample.push(f)
    }

    function summarize(arr) {
      const w = arr.filter(f => f.result === 'win').length
      const l = arr.filter(f => f.result === 'loss').length
      const pnl = arr.reduce((s, f) => s + Number(f.pnl ?? 0), 0)
      const stake = arr.reduce((s, f) => s + Number(f.filled_contracts) * Number(f.fill_price) / 100, 0)
      const roi = stake > 0 ? pnl / stake : 0
      const winPct = arr.length > 0 ? w / arr.length : 0
      return { n: arr.length, w, l, pnl, stake, roi, winPct }
    }
    const is = summarize(inSample)
    const oos = summarize(outSample)

    // Save results
    await db.execute({
      sql: `INSERT OR REPLACE INTO hypothesis_results
        (hypothesis_code, evaluated_at, sample_partition, n_fires, wins, losses, pnl, stake, roi_pct, win_pct)
        VALUES (?,?,?,?,?,?,?,?,?,?)`,
      args: [h.code, evaluatedAt, 'in_sample', is.n, is.w, is.l, is.pnl, is.stake, is.roi*100, is.winPct*100],
    })
    await db.execute({
      sql: `INSERT OR REPLACE INTO hypothesis_results
        (hypothesis_code, evaluated_at, sample_partition, n_fires, wins, losses, pnl, stake, roi_pct, win_pct)
        VALUES (?,?,?,?,?,?,?,?,?,?)`,
      args: [h.code, evaluatedAt, 'out_of_sample', oos.n, oos.w, oos.l, oos.pnl, oos.stake, oos.roi*100, oos.winPct*100],
    })

    // Auto-flag if OOS hits decision threshold
    let flag = ''
    if (oos.n >= h.min_fires_for_decision) {
      if (oos.roi >= h.promote_roi_threshold) flag = '🟢 PROMOTE-READY'
      else if (oos.roi <= h.reject_roi_threshold) flag = '🔴 REJECT-READY'
      else flag = '⏸  CONTINUE'
    } else {
      flag = `⏳ N=${oos.n}/${h.min_fires_for_decision}`
    }

    const isStr = `${is.n}f ${is.w}W ${is.pnl >= 0 ? '+' : ''}$${is.pnl.toFixed(0)}`
    const oosStr = `${oos.n}f ${oos.w}W ${oos.pnl >= 0 ? '+' : ''}$${oos.pnl.toFixed(0)} ROI=${(oos.roi * 100).toFixed(0)}%`
    console.log(`${h.code.padEnd(8)} ${isStr.padEnd(36)} ${oosStr.padEnd(35)} ${flag}`)
  }
}

if (cmd === 'register') await register()
else if (cmd === 'list') await list()
else if (cmd === 'evaluate') await evaluate()
else {
  console.log('Usage:')
  console.log('  hypothesisRegistry.mjs register --code H-X --desc "..." --filter "..."')
  console.log('  hypothesisRegistry.mjs list')
  console.log('  hypothesisRegistry.mjs evaluate')
}
