import 'dotenv/config'
import { createClient } from '@libsql/client'
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })
const r = await db.execute(`SELECT id, paper, order_id, ticker, filled_contracts, order_status, result FROM ks_bets WHERE id IN (9589,9590,9591,9599,9600,9602,9605)`)
for (const b of r.rows) {
  console.log(`#${b.id} paper=${b.paper} order=${b.order_id} ticker=${b.ticker} contracts=${b.filled_contracts} status=${b.order_status} result=${b.result}`)
}
