// Detect cases where multiple strategies are firing on the SAME pitcher with conflicting positions.
// Looks at today's fires + identifies pitchers with cross-strategy opposite-side bets.
import 'dotenv/config'
import { createClient } from '@libsql/client'
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })

const r = await db.execute({
  sql: `SELECT pitcher_name, strike, side, strategy_mode, capital_at_risk, user_id
        FROM ks_bets WHERE bet_date = ? AND order_id IS NOT NULL AND live_bet = 0
        ORDER BY pitcher_name, strike, side`,
  args: [today],
})

// Group by pitcher
const byPitcher = new Map()
for (const b of r.rows) {
  if (!byPitcher.has(b.pitcher_name)) byPitcher.set(b.pitcher_name, [])
  byPitcher.get(b.pitcher_name).push(b)
}

// Find conflicts: same pitcher with both YES and NO across strategies, OR opposite-side bets at adjacent strikes
const conflicts = []
for (const [pitcher, bets] of byPitcher) {
  if (bets.length < 2) continue
  const yesStrikes = bets.filter(b => b.side === 'YES').map(b => b.strike)
  const noStrikes = bets.filter(b => b.side === 'NO').map(b => b.strike)
  if (yesStrikes.length > 0 && noStrikes.length > 0) {
    // Cross-side bets on same pitcher
    const minNo = Math.min(...noStrikes)
    const maxYes = Math.max(...yesStrikes)
    if (minNo <= maxYes + 1) {
      // YES K6 + NO K6 = direct contradiction
      // YES K7 + NO K6 = "K=6 only" specific bet (legitimate)
      // YES K6 + NO K7 = "K6+ but not K7+" — can't both win
      conflicts.push({ pitcher, yesStrikes, noStrikes,
        type: minNo <= maxYes ? 'CONTRADICTION (both can\'t win)' : 'tight straddle' })
    }
  }
}

console.log(`Today's fires: ${r.rows.length} across ${byPitcher.size} pitchers\n`)
if (conflicts.length === 0) {
  console.log('✓ No same-pitcher cross-strategy conflicts detected today')
} else {
  console.log(`⚠️  ${conflicts.length} conflict(s) detected:`)
  for (const c of conflicts) {
    console.log(`  ${c.pitcher}: YES @${c.yesStrikes.join(',')} + NO @${c.noStrikes.join(',')} → ${c.type}`)
  }
}

// Show net exposure per pitcher
console.log('\n── Net exposure per pitcher ──')
for (const [pitcher, bets] of [...byPitcher.entries()].sort()) {
  if (bets.length === 1) continue
  const yesRisk = bets.filter(b => b.side === 'YES').reduce((s,b) => s + Number(b.capital_at_risk ?? 0), 0)
  const noRisk = bets.filter(b => b.side === 'NO').reduce((s,b) => s + Number(b.capital_at_risk ?? 0), 0)
  const modes = [...new Set(bets.map(b => b.strategy_mode))]
  console.log(`  ${pitcher.padEnd(22)}  ${bets.length} bets  YES=$${yesRisk.toFixed(2)}  NO=$${noRisk.toFixed(2)}  modes: ${modes.join(', ')}`)
}
