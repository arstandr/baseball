// scripts/live/oracleSimulator.js
//
// Test-mode Oracle simulator.
//
// Runs the full Oracle chain (L1 → L2 → L3 → L4 with real Haiku → L5 v0.2)
// on every settled placed pre-game bet from a target window, logging the
// would-have-been verdict to oracle/oracle-sim-<DATE>.jsonl + producing
// an end-of-run comparison report.
//
// PRODUCTION IS NOT TOUCHED. This is shadow-only. Real Kalshi numbers
// (market_mid, fill_price, spread) come from ks_bets. Real Haiku calls
// for Critic.
//
// Usage:
//   node scripts/live/oracleSimulator.js                    (today only)
//   node scripts/live/oracleSimulator.js --date 2026-04-30
//   node scripts/live/oracleSimulator.js --since 2026-04-30 --until 2026-05-01
//   node scripts/live/oracleSimulator.js --watch            (poll every 60s for new bets)

import 'dotenv/config'
import { writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import * as db from '../../lib/db.js'
import { parseArgs } from '../../lib/cli-args.js'

import { runOracleGate, gateStats } from './oracleGate.js'

const today = new Date().toISOString().slice(0, 10)
const opts = parseArgs({
  date:  { default: null },          // single-day mode
  since: { default: null },
  until: { default: null },
  watch: { type: 'boolean', default: false },
  bankroll: { type: 'number', default: 1000 },
})
const SINCE = opts.since ?? opts.date ?? today
const UNTIL = opts.until ?? opts.date ?? today
const WATCH = opts.watch
const BANKROLL = opts.bankroll

const LOG_DIR = path.resolve('oracle')
mkdirSync(LOG_DIR, { recursive: true })
const LOG_PATH = path.resolve(`${LOG_DIR}/oracle-sim-${today}.jsonl`)

console.log(`[oracleSimulator] window ${SINCE} → ${UNTIL}; watch=${WATCH}; bankroll=$${BANKROLL}`)
console.log(`[oracleSimulator] log: ${LOG_PATH}`)
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('[oracleSimulator] ANTHROPIC_API_KEY missing — Critic calls will fail open')
}

// Track which bet_ids we've already processed so --watch doesn't re-run.
const processedIds = new Set()

async function loadBetsToProcess() {
  return await db.all(`
    SELECT b.id AS bet_id, b.bet_date, b.pitcher_id, b.pitcher_name,
           b.strike, b.side, b.result, b.actual_ks, b.pnl, b.bet_size,
           b.fill_price, b.market_mid, b.spread, b.user_id, b.live_bet,
           b.order_status, b.logged_at, b.ticker
    FROM ks_bets b
    WHERE b.live_bet = 0
      AND b.bet_date BETWEEN ? AND ?
      AND b.market_mid IS NOT NULL
      AND b.strike IS NOT NULL
      AND b.side IS NOT NULL
    ORDER BY b.bet_date ASC, b.logged_at ASC, b.id ASC
  `, [SINCE, UNTIL])
}

async function processBet(bet) {
  if (processedIds.has(bet.bet_id)) return null
  processedIds.add(bet.bet_id)

  const t0 = Date.now()
  const gate = await runOracleGate({
    bet_date: bet.bet_date,
    pitcher_id: bet.pitcher_id,
    pitcher_name: bet.pitcher_name,
    strike: bet.strike,
    side: bet.side,
    market_mid: bet.market_mid,
    spread: bet.spread,
    bankroll: BANKROLL,
    bet_id: bet.bet_id,
    ticker: bet.ticker ?? null,
  })
  const elapsed = Date.now() - t0

  const record = {
    ts: new Date().toISOString(),
    bet_id: bet.bet_id,
    bet_date: bet.bet_date,
    pitcher_id: bet.pitcher_id,
    pitcher_name: bet.pitcher_name,
    strike: bet.strike,
    side: bet.side,
    user_id: bet.user_id,
    ticker: bet.ticker ?? null,
    market_mid: bet.market_mid,
    fill_price: bet.fill_price,
    bet_size: bet.bet_size,
    spread: bet.spread,
    production_result: bet.result ?? '(unsettled)',
    production_pnl: bet.pnl,
    production_actual_ks: bet.actual_ks,
    oracle_action: gate.action,
    oracle_baseline: gate.baseline,
    oracle: gate.oracle,
    oracle_error: gate.error,
    critic_reason_text: gate.oracle?.critic_reason_text ?? '',
    elapsed_ms: elapsed,
  }
  appendFileSync(LOG_PATH, JSON.stringify(record) + '\n', 'utf-8')

  // One-line console
  const tag = gate.action === 'skip' ? 'SKIP'
            : gate.action === 'size_down' ? 'SIZE_DOWN'
            : 'PASS'
  const cv = gate.oracle?.critic_verdict ?? '—'
  console.log(`[oracleSim] ${bet.bet_date} ${bet.pitcher_name} K${bet.strike}${bet.side} ` +
    `mid=${bet.market_mid}¢ → ${tag.padEnd(9)} (${gate.oracle?.reason ?? gate.error ?? '?'}; critic=${cv}) ` +
    `${elapsed}ms`)
  return record
}

async function runOnce() {
  const bets = await loadBetsToProcess()
  console.log(`[oracleSim] found ${bets.length} bets in window; ${bets.filter(b => !processedIds.has(b.bet_id)).length} new`)
  let n = 0
  for (const bet of bets) {
    const rec = await processBet(bet)
    if (rec) n++
  }
  return n
}

// ─── Initial run ─────────────────────────────────────────────────
const initialN = await runOnce()
const stats0 = gateStats()
console.log(`[oracleSim] initial pass: ${initialN} new bets processed; ` +
            `critic_calls=${stats0.critic_calls} cost=$${stats0.critic_cost_usd.toFixed(4)} cache=${stats0.cache_size}`)

// ─── Watch loop ──────────────────────────────────────────────────
if (WATCH) {
  console.log('[oracleSim] entering watch mode (polling every 60s)')
  while (true) {
    await new Promise(r => setTimeout(r, 60_000))
    try {
      const n = await runOnce()
      if (n > 0) {
        const s = gateStats()
        console.log(`[oracleSim] +${n} new bets; cost=$${s.critic_cost_usd.toFixed(4)} cache=${s.cache_size}`)
      }
    } catch (err) {
      console.error('[oracleSim] watch iteration error:', err.message)
    }
  }
}

// ─── End-of-run summary (non-watch mode) ─────────────────────────
if (!WATCH) {
  // Aggregate results from the log file we just wrote
  const allRecords = []
  if (existsSync(LOG_PATH)) {
    const raw = await import('node:fs').then(fs => fs.readFileSync(LOG_PATH, 'utf-8'))
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try { allRecords.push(JSON.parse(line)) } catch { /* skip */ }
    }
  }

  const settled = allRecords.filter(r => ['win','loss','void'].includes(r.production_result))
  const counters = { pass: 0, skip: 0, size_down: 0, errors: 0 }
  let prodPnl = 0
  let oraclePnl = 0
  for (const r of settled) {
    counters[r.oracle_action] = (counters[r.oracle_action] ?? 0) + 1
    if (r.oracle_error) counters.errors++
    const pnl = Number(r.production_pnl) || 0
    prodPnl += pnl
    if (r.oracle_action === 'pass')         oraclePnl += pnl
    else if (r.oracle_action === 'size_down') oraclePnl += pnl * 0.5
    // skip → 0
  }

  const finalStats = gateStats()
  console.log('\n═══════════════════════════════════════════')
  console.log('  ORACLE SIMULATOR — END OF RUN')
  console.log('═══════════════════════════════════════════')
  console.log(`Window:                   ${SINCE} → ${UNTIL}`)
  console.log(`Total bets processed:     ${allRecords.length}`)
  console.log(`Settled bets:             ${settled.length}`)
  console.log(``)
  console.log(`Oracle decisions:`)
  console.log(`  pass (production fires) ${counters.pass}`)
  console.log(`  skip                    ${counters.skip}`)
  console.log(`  size_down               ${counters.size_down}`)
  console.log(`  fail-open errors        ${counters.errors}`)
  console.log(``)
  console.log(`P&L on settled bets:`)
  console.log(`  Production:             $${prodPnl.toFixed(2)}`)
  console.log(`  Oracle (fixed-size):    $${oraclePnl.toFixed(2)}`)
  console.log(`  Δ:                      $${(oraclePnl - prodPnl).toFixed(2)}`)
  console.log(``)
  console.log(`Critic stats:`)
  console.log(`  API calls:              ${finalStats.critic_calls}`)
  console.log(`  Total cost:             $${finalStats.critic_cost_usd.toFixed(4)}`)
  console.log(`  Cache size:             ${finalStats.cache_size}`)
  console.log(``)
  console.log(`Log file: ${LOG_PATH}`)
}

await db.close()
