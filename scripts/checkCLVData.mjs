import 'dotenv/config'
import { createClient } from '@libsql/client'
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })

const cols = await db.execute(`PRAGMA table_info(ks_bets)`)
const colNames = cols.rows.map(c => c.name)
const clvCols = colNames.filter(c => c.toLowerCase().includes('closing') || c.toLowerCase().includes('clv'))
console.log('CLV-related columns in ks_bets:', clvCols)

// Sample row with closing data
const r = await db.execute(`SELECT id, pitcher_name, side, strike, fill_price, closing_line_cents, clv_cents FROM ks_bets WHERE closing_line_cents IS NOT NULL ORDER BY id DESC LIMIT 5`)
console.log('\nLast 5 with closing data:')
for (const b of r.rows) console.log(`  #${b.id} ${b.pitcher_name} ${b.side}${b.strike} fill=${b.fill_price}¢ close=${b.closing_line_cents}¢ clv=${b.clv_cents}¢`)

// Coverage check
const cov = await db.execute(`
  SELECT bet_date, COUNT(*) AS total, SUM(CASE WHEN closing_line_cents IS NOT NULL THEN 1 ELSE 0 END) AS with_close
  FROM ks_bets WHERE bet_date >= date('now','-14 days') AND order_id IS NOT NULL
  GROUP BY bet_date ORDER BY bet_date DESC
`)
console.log('\nClosing-line coverage by date:')
for (const r of cov.rows) console.log(`  ${r.bet_date}: ${r.with_close}/${r.total} have closing line`)
