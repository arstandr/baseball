import 'dotenv/config'
import { createClient } from '@libsql/client'
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })
const r = await db.execute(`SELECT key, value, default_val, description FROM betting_rules WHERE key IN ('yes_max_strike','no_max_strike','no_max_market_mid','yes_pregame_max_mid','yes_min_prob','min_bet_floor')`)
for (const row of r.rows) console.log(`  ${row.key.padEnd(28)} = ${String(row.value).padEnd(6)} (default ${row.default_val})`)
