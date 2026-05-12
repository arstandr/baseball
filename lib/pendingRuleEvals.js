// Daily evaluator for pending_rule_evaluations. For each candidate rule,
// query the relevant shadow data, update its accumulated sample/PnL/ROI,
// and flip status to 'ready_to_deploy' or 'rejected' once threshold hit.
//
// Called from EOD path so each day's settlement updates the running totals.

import * as db from './db.js'

// Each candidate rule has an evaluator that returns {sample, wins, pnl, risk}
// from the shadow tables, scoped to the trailing window.
const EVALUATORS = {
  lift_rule_f_no_k3_k4: async (windowStart) => {
    const rows = await db.all(
      `SELECT shadow_pnl, proposed_kelly_size, result
       FROM shadow_full_distribution
       WHERE bet_date >= ? AND side = 'NO' AND strike IN (3, 4)
         AND proposed_kelly_size > 0 AND result IS NOT NULL`,
      [windowStart],
    ).catch(() => [])
    return aggregate(rows)
  },

  lower_no_min_edge_to_0_12: async (windowStart) => {
    const rows = await db.all(
      `SELECT shadow_pnl, proposed_kelly_size, result
       FROM shadow_full_distribution
       WHERE bet_date >= ? AND side = 'NO'
         AND calibrated_edge >= 0.12 AND calibrated_edge < 0.15
         AND proposed_kelly_size > 0 AND result IS NOT NULL`,
      [windowStart],
    ).catch(() => [])
    return aggregate(rows)
  },

  lower_yes_pregame_min_prob_below_0_45: async (windowStart) => {
    const rows = await db.all(
      `SELECT shadow_pnl, proposed_kelly_size, result
       FROM shadow_full_distribution
       WHERE bet_date >= ? AND side = 'YES'
         AND raw_model_prob >= 0.40 AND raw_model_prob < 0.45
         AND calibrated_edge > 0.05
         AND proposed_kelly_size > 0 AND result IS NOT NULL`,
      [windowStart],
    ).catch(() => [])
    return aggregate(rows)
  },

  cross_strike_strategy: async (windowStart) => {
    // Real bets fired with strategy_mode='pregame_cross_strike' (paper or live)
    const rows = await db.all(
      `SELECT pnl AS shadow_pnl, capital_at_risk AS proposed_kelly_size, result
       FROM ks_bets
       WHERE bet_date >= ? AND strategy_mode = 'pregame_cross_strike'
         AND result IN ('win','loss')`,
      [windowStart],
    ).catch(() => [])
    return aggregate(rows)
  },
}

function aggregate(rows) {
  const sample = rows.length
  const wins = rows.filter(r => r.result === 'win').length
  const pnl = rows.reduce((s, r) => s + Number(r.shadow_pnl ?? 0), 0)
  const risk = rows.reduce((s, r) => s + Number(r.proposed_kelly_size ?? 0), 0)
  return { sample, wins, pnl, risk, roi: risk > 0 ? pnl / risk : 0 }
}

// Run all evaluators against the trailing 14-day window and update the table.
export async function evaluateAllPending({ windowDays = 14 } = {}) {
  const cutoff = new Date(Date.now() - windowDays * 86400_000).toISOString().slice(0, 10)

  const candidates = await db.all(`SELECT rule_name, min_sample_size, min_pnl_signal, decision_status FROM pending_rule_evaluations`).catch(() => [])
  const results = []
  for (const c of candidates) {
    const evaluator = EVALUATORS[c.rule_name]
    if (!evaluator) continue
    const stats = await evaluator(cutoff)

    // Decision logic: once sample threshold hit, classify
    let newStatus = c.decision_status
    if (c.decision_status === 'collecting' && stats.sample >= Number(c.min_sample_size)) {
      newStatus = stats.pnl >= Number(c.min_pnl_signal) ? 'ready_to_deploy' : 'rejected'
    }

    await db.run(
      `UPDATE pending_rule_evaluations
       SET current_sample = ?, current_pnl = ?, current_roi = ?, decision_status = ?, last_evaluated_at = ?
       WHERE rule_name = ?`,
      [stats.sample, Math.round(stats.pnl * 100) / 100, Math.round(stats.roi * 1000) / 1000, newStatus, new Date().toISOString(), c.rule_name],
    ).catch(() => {})

    results.push({ rule: c.rule_name, ...stats, status: newStatus })
  }
  return results
}

// One-line-per-rule Discord summary
export async function formatPendingRuleLines() {
  const rows = await db.all(`SELECT rule_name, current_sample, current_pnl, current_roi, decision_status, min_sample_size FROM pending_rule_evaluations`).catch(() => [])
  const lines = []
  for (const r of rows) {
    const pnlStr = (r.current_pnl >= 0 ? '+' : '') + '$' + Number(r.current_pnl ?? 0).toFixed(2)
    const roiStr = r.current_roi != null ? `${(Number(r.current_roi) * 100).toFixed(1)}%` : '—'
    const progress = `${r.current_sample}/${r.min_sample_size}`
    const statusEmoji = r.decision_status === 'ready_to_deploy' ? '✅'
                      : r.decision_status === 'rejected'       ? '❌'
                      : '⏳'
    lines.push(`${statusEmoji} ${r.rule_name}: ${progress} bets, ${pnlStr}, ROI ${roiStr}`)
  }
  return lines
}
