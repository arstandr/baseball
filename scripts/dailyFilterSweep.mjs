// Daily filter-sweep — tests upgraded-signal hypotheses against the cumulative
// fade fire history. Runs nightly alongside the daily progress report so we
// always know how each candidate refinement is performing.
//
// Compares the LIVE strategy's actual P&L vs what P&L would have been under:
//   - H-H: skip if avg_innings_l5 < 5
//   - H-I: skip if confidence ≤ 0.3
//   - H-H + H-I combined
//   - H-J: skip if swstr_pct < 0.18
//   - H-K: use production_model_prob instead of NB r=8 simple
//   - H-M: include park_k_factor adjustment
//   - All hypotheses combined
//
// Also posts daily report row to Discord if FADE_DISCORD_WEBHOOK is set.

import 'dotenv/config'
import { createClient } from '@libsql/client'

const FEE = 0.07
const STARTING_BANKROLL = 5000
const TEST_START = '2026-05-07'
const DISCORD_WEBHOOK = process.env.FADE_DISCORD_WEBHOOK || process.env.DISCORD_PERSONAL_WEBHOOK

const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })

// Pull every fade fire with joined intelligence
const fires = await db.execute(`
  SELECT b.id, b.bet_date, b.pitcher_name, b.strike, b.fill_price, b.filled_contracts,
         b.model_prob AS live_model_prob, b.edge AS live_edge, b.result, b.pnl, b.actual_ks,
         p.confidence, p.swstr_pct, p.avg_innings_l5,
         f.production_model_prob, f.park_k_factor
  FROM ks_bets b
  LEFT JOIN pitcher_signals p ON p.pitcher_id = b.pitcher_id AND p.signal_date = b.bet_date
  LEFT JOIN fade_paper_test_candidates f ON f.pitcher_id = b.pitcher_id AND f.target_date = b.bet_date AND f.strike = b.strike AND f.side = b.side
  WHERE b.strategy_mode = 'pregame_fade_yes'
    AND b.bet_date >= '${TEST_START}'
    AND b.result IN ('win', 'loss')
  ORDER BY b.bet_date, b.id
`)
console.log(`Fade fires (settled): ${fires.rows.length}`)

function evaluate(label, keepFn) {
  let pnl = 0, wins = 0, losses = 0, kept = 0
  for (const f of fires.rows) {
    if (!keepFn(f)) continue
    kept++
    if (f.result === 'win') { wins++; pnl += Number(f.pnl ?? 0) }
    else { losses++; pnl += Number(f.pnl ?? 0) }
  }
  const winPct = kept > 0 ? (wins / kept * 100).toFixed(1) : 0
  const bank = STARTING_BANKROLL + pnl
  const ret = (bank / STARTING_BANKROLL - 1) * 100
  return { label, kept, wins, losses, pnl, winPct, bank, ret }
}

// Helper functions for filter conditions
const passLiveBaseline = () => true  // already filtered at fire time
const passH_H = f => f.avg_innings_l5 == null || Number(f.avg_innings_l5) >= 5.0
const passH_I = f => f.confidence == null || Number(f.confidence) > 0.3
const passH_J = f => f.swstr_pct == null || Number(f.swstr_pct) >= 0.18
const passH_K = (f, threshold = 0.05) => {
  if (f.production_model_prob == null) return true
  const prodEdge = Number(f.production_model_prob) - Number(f.fill_price) / 100
  return prodEdge >= threshold
}
const passH_M_severe = f => f.park_k_factor == null || Number(f.park_k_factor) >= 0.95
const passH_N_strike = f => Number(f.strike) === 6 || Number(f.strike) >= 10  // skip middle 7-9
const passH_O_edgeCap = f => Number(f.edge ?? f.live_edge ?? 0) <= 0.20         // skip super-high edges
const passH_P_askCap = f => Number(f.fill_price) <= 25                          // tight ask cap

const variants = [
  evaluate('LIVE (v3 active filters)',             passLiveBaseline),
  evaluate('H-H only: skip ipL5 < 5',              f => passH_H(f)),
  evaluate('H-I only: skip confidence ≤ 0.3',      f => passH_I(f)),
  evaluate('H-J only: skip swstr < 18%',           f => passH_J(f)),
  evaluate('H-N only: skip K=7-9',                 f => passH_N_strike(f)),
  evaluate('H-O only: skip edge > 20c',            f => passH_O_edgeCap(f)),
  evaluate('H-P only: skip ask > 25c',             f => passH_P_askCap(f)),
  evaluate('v2 (H-H + H-I)',                       f => passH_H(f) && passH_I(f)),
  evaluate('v3 (v2 + H-N strike skip)',            f => passH_H(f) && passH_I(f) && passH_N_strike(f)),
  evaluate('v3 + H-O (edge ≤20c)',                 f => passH_H(f) && passH_I(f) && passH_N_strike(f) && passH_O_edgeCap(f)),
  evaluate('v3 + H-P (ask ≤25c)',                  f => passH_H(f) && passH_I(f) && passH_N_strike(f) && passH_P_askCap(f)),
  evaluate('v3 + H-O + H-P',                       f => passH_H(f) && passH_I(f) && passH_N_strike(f) && passH_O_edgeCap(f) && passH_P_askCap(f)),
  evaluate('ALL filters (kitchen sink)',           f => passH_H(f) && passH_I(f) && passH_J(f) && passH_K(f) && passH_M_severe(f) && passH_N_strike(f) && passH_O_edgeCap(f) && passH_P_askCap(f)),
]

console.log('\n═══ DAILY FILTER SWEEP ═══')
console.log(`Test start: ${TEST_START}  ·  Fires evaluated: ${fires.rows.length}`)
console.log()
console.log('config'.padEnd(40) + 'kept   W/L     P&L       bankroll    return')
console.log('─'.repeat(90))
for (const v of variants) {
  const wl = `${v.wins}/${v.losses}`
  console.log(`  ${v.label.padEnd(40)} ${String(v.kept).padStart(3)}    ${wl.padEnd(8)} ${(v.pnl >= 0 ? '+' : '') + '$' + v.pnl.toFixed(0).padStart(5)}    $${v.bank.toFixed(0).padStart(5)}     ${(v.ret >= 0 ? '+' : '') + v.ret.toFixed(1).padStart(5)}%`)
}

// Best non-baseline
const live = variants[0]
const best = variants.slice(1).reduce((b, v) => v.pnl > b.pnl ? v : b)
const delta = best.pnl - live.pnl
console.log()
console.log(`Best filter: ${best.label}`)
console.log(`Delta vs live: ${delta >= 0 ? '+' : ''}$${delta.toFixed(0)} (${((best.bank - live.bank) / live.bank * 100).toFixed(1)}% bankroll improvement)`)

// Discord
if (DISCORD_WEBHOOK) {
  const lines = [
    `🔬 **Fade Filter Sweep** (cumulative since ${TEST_START}, n=${fires.rows.length} settled)`,
    `LIVE baseline: ${live.pnl >= 0 ? '+' : ''}$${live.pnl.toFixed(0)} (${live.ret.toFixed(1)}% return)`,
    `Best alternative: ${best.label} → ${best.pnl >= 0 ? '+' : ''}$${best.pnl.toFixed(0)} (${best.ret.toFixed(1)}%)`,
    `Delta: ${delta >= 0 ? '+' : ''}$${delta.toFixed(0)}`,
    '',
    'All variants:',
    ...variants.map(v => `  ${v.label}: kept ${v.kept}, ${v.pnl >= 0 ? '+' : ''}$${v.pnl.toFixed(0)} (${v.ret.toFixed(1)}%)`),
  ]
  await fetch(DISCORD_WEBHOOK, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: lines.join('\n') }),
  }).catch(() => {})
}
