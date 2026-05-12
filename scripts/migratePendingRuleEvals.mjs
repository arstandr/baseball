// pending_rule_evaluations — tracks rule changes we considered but deferred,
// along with their hypothesis, evaluation criteria, and current shadow data.
// Updated daily by the EOD cron via lib/pendingRuleEvals.js.

import 'dotenv/config'
import { createClient } from '@libsql/client'
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })

await db.execute(`
  CREATE TABLE IF NOT EXISTS pending_rule_evaluations (
    rule_name TEXT PRIMARY KEY,
    hypothesis TEXT,
    eval_method TEXT,
    min_sample_size INTEGER,
    min_pnl_signal REAL,
    current_sample INTEGER DEFAULT 0,
    current_pnl REAL DEFAULT 0,
    current_roi REAL DEFAULT 0,
    decision_status TEXT DEFAULT 'collecting',
    notes TEXT,
    created_at TEXT NOT NULL,
    last_evaluated_at TEXT
  )
`)

// Seed initial 3 candidates
const seeds = [
  {
    rule_name: 'lift_rule_f_no_k3_k4',
    hypothesis: 'Removing the hardcoded ban on NO bets at strike ≤ 4 will capture profitable K3/K4 NO bets. Historical 30d data showed K3 NO +$264 (17 bets) and K4 NO +$210 (32 bets) under prior rule conditions.',
    eval_method: 'Query shadow_full_distribution rows where side=NO AND strike IN (3,4) AND proposed_kelly_size > 0. Track win rate and shadow_pnl over rolling 14-day window.',
    min_sample_size: 30,
    min_pnl_signal: 50,
    notes: 'Caveat: historical data was under different rule mix; prospective validation needed.',
  },
  {
    rule_name: 'lower_no_min_edge_to_0_12',
    hypothesis: 'Lowering no_min_edge from 0.15 to 0.12 (matching YES) will unblock NO opportunities with 12-15% calibrated edge. NO already wins 32% ROI vs YES 5.9%, so more NO volume should improve aggregate.',
    eval_method: 'Query shadow_full_distribution rows where side=NO AND calibrated_edge BETWEEN 0.12 AND 0.15. Settle them via actual_ks. Track win rate and shadow_pnl.',
    min_sample_size: 25,
    min_pnl_signal: 30,
    notes: 'Risk: lower edge threshold lets more noise through. Need positive shadow ROI before deploying.',
  },
  {
    rule_name: 'lower_yes_pregame_min_prob_below_0_45',
    hypothesis: 'Recalibrated <0.42 bucket showed 53% actual win rate (n=15) — outperforms claim by 17pp. Lowering yes_pregame_min_prob from 0.45 to 0.40 may capture under-priced YES at high strikes.',
    eval_method: 'Query shadow_full_distribution rows where side=YES AND raw_model_prob BETWEEN 0.40 AND 0.45 AND calibrated_edge > 0.05. Settle and track outcomes.',
    min_sample_size: 30,
    min_pnl_signal: 40,
    notes: 'Sample size of n=15 in calibration recompute is small. Need 30+ prospectively.',
  },
]

for (const s of seeds) {
  await db.execute({
    sql: `INSERT INTO pending_rule_evaluations
            (rule_name, hypothesis, eval_method, min_sample_size, min_pnl_signal, notes, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(rule_name) DO UPDATE SET
            hypothesis = excluded.hypothesis,
            eval_method = excluded.eval_method,
            min_sample_size = excluded.min_sample_size,
            min_pnl_signal = excluded.min_pnl_signal,
            notes = excluded.notes`,
    args: [s.rule_name, s.hypothesis, s.eval_method, s.min_sample_size, s.min_pnl_signal, s.notes, new Date().toISOString()],
  })
}

const r = await db.execute(`SELECT rule_name, decision_status, current_sample, current_pnl FROM pending_rule_evaluations ORDER BY rule_name`)
console.log('✓ pending_rule_evaluations table ready')
for (const row of r.rows) {
  console.log(`  ${row.rule_name.padEnd(40)} status=${row.decision_status} n=${row.current_sample} pnl=$${row.current_pnl}`)
}
