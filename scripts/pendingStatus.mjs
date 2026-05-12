import 'dotenv/config'
import { createClient } from '@libsql/client'
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })
const r = await db.execute(`SELECT rule_name, current_sample, min_sample_size, current_pnl, current_roi, decision_status, last_evaluated_at FROM pending_rule_evaluations ORDER BY rule_name`)
for (const row of r.rows) {
  const evalStr = row.last_evaluated_at ? row.last_evaluated_at.slice(11,19)+'Z' : 'never'
  console.log(`  ${row.rule_name.padEnd(40)} status=${row.decision_status} n=${row.current_sample}/${row.min_sample_size} pnl=${row.current_pnl >= 0 ? '+' : ''}$${row.current_pnl} eval=${evalStr}`)
}
