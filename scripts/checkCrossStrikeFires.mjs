import 'dotenv/config'
import { createClient } from '@libsql/client'
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })

// Did any cross-strike candidates fire today?
const r = await db.execute(`SELECT COUNT(*) AS n FROM ks_bets WHERE bet_date='2026-05-06' AND strategy_mode='pregame_cross_strike'`)
console.log(`pregame_cross_strike fires today: ${r.rows[0].n}`)

// What strategy_modes ARE firing?
const modes = await db.execute(`SELECT strategy_mode, COUNT(*) AS n FROM ks_bets WHERE bet_date='2026-05-06' GROUP BY strategy_mode`)
console.log('\nAll strategy_modes today:')
for (const m of modes.rows) console.log(`  ${m.strategy_mode ?? 'null'}: ${m.n}`)

// Trigger fresh strikeoutEdge run with verbose output
console.log('\n── Run strikeoutEdge directly to see what happens ──')
