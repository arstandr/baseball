import 'dotenv/config'
import { createClient } from '@libsql/client'
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })

await db.execute({
  sql: `INSERT INTO pending_rule_evaluations
          (rule_name, hypothesis, eval_method, min_sample_size, min_pnl_signal, notes, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(rule_name) DO UPDATE SET
          hypothesis = excluded.hypothesis, eval_method = excluded.eval_method`,
  args: [
    'cross_strike_strategy',
    'Cross-strike arbitrage produces ≥55% win rate and ≥30% ROI on math-based mispricing detection. Validated by 18-bet POC on 2026-05-05 at 78% / 62%.',
    'Query ks_bets WHERE strategy_mode = pregame_cross_strike, settled bets, last 14 days. Track win rate + ROI.',
    30, 50,
    'Production gate: 100 settled bets at ≥55% win rate triggers production deploy decision. <40% triggers rollback.',
    new Date().toISOString(),
  ],
})
console.log('✓ cross_strike_strategy pending eval registered')
