import 'dotenv/config'
import { createClient } from '@libsql/client'
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
const r = await db.execute({
  sql: `SELECT pitcher_name, side, strike, ROUND(model_prob, 3) AS mp, market_mid, ROUND(edge, 3) AS edge,
               ROUND(k9_l5, 1) AS l5, ROUND(k9_career, 1) AS career, ROUND(k9_l5 - k9_career, 2) AS gap,
               strategy_mode, COUNT(*) AS n, ROUND(SUM(capital_at_risk), 2) AS risk
        FROM ks_bets
        WHERE bet_date = ? AND live_bet = 0
        GROUP BY pitcher_name, side, strike, strategy_mode
        ORDER BY pitcher_name, strike, side`,
  args: [today],
})
console.log(`Today's ks_bets distinct picks (${r.rows.length}):\n`)
console.log(`pitcher                  | side | K | mp    | mid | edge   | l5  | career | gap  | mode             | n  | risk`)
console.log(`-`.repeat(120))
for (const p of r.rows) {
  console.log(`${p.pitcher_name.padEnd(24)} | ${p.side.padEnd(4)} | ${String(p.strike).padEnd(1)} | ${String(p.mp).padEnd(5)} | ${String(p.market_mid).padEnd(3)} | ${String(p.edge).padStart(6)} | ${String(p.l5).padEnd(3)} | ${String(p.career).padEnd(6)} | ${String(p.gap).padEnd(4)} | ${p.strategy_mode.padEnd(16)} | ${String(p.n).padEnd(2)} | $${p.risk}`)
}

// Inversion eligibility check
console.log(`\n── Inversion eligibility (K5-7, l5-career gap≥0.5, mp≥0.5) ──`)
for (const p of r.rows) {
  if (p.side !== 'YES') continue
  const k = Number(p.strike)
  const inK = k >= 5 && k <= 7
  const inGap = p.gap >= 0.5 || (p.career === 0)
  const inMp = p.mp >= 0.5
  const eligible = inK && inGap && inMp
  console.log(`  ${p.pitcher_name.padEnd(24)} K${p.strike}  mp=${p.mp}  gap=${p.gap}  → ${eligible ? '✓ ELIGIBLE for inversion' : `✗ skip (${[!inK&&'K outside 5-7',!inGap&&'gap<0.5',!inMp&&'mp<0.5'].filter(Boolean).join(', ')})`}`)
}
