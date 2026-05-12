import 'dotenv/config'
import { createClient } from '@libsql/client'
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })
const r = await db.execute(`SELECT id, paper, order_id, ticker, side, strike, filled_contracts, order_status, result, logged_at, strategy_mode FROM ks_bets WHERE id = 9640`)
console.log(r.rows[0])
