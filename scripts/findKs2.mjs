import 'dotenv/config'
import { createClient } from '@libsql/client'
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })

const km = await db.execute(`PRAGMA table_info(kalshi_ks_markets)`)
console.log('kalshi_ks_markets cols:', km.rows.map(r => r.name).join(', '))

const sample = await db.execute(`SELECT * FROM kalshi_ks_markets WHERE actual_ks IS NOT NULL ORDER BY ROWID DESC LIMIT 3`)
console.log('\nSample row:')
if (sample.rows[0]) {
  for (const k of Object.keys(sample.rows[0])) console.log(`  ${k}: ${sample.rows[0][k]}`)
}

const may5 = await db.execute(`SELECT ticker, strike, actual_ks FROM kalshi_ks_markets WHERE ticker LIKE 'KXMLBKS-26MAY05%' AND actual_ks IS NOT NULL`)
console.log(`\n2026-05-05 settled markets: ${may5.rows.length}`)

// Build pitcher_id-strike → actual_ks map from ticker
const pitcherKsMap = new Map()
for (const r of may5.rows) {
  // Format: KXMLBKS-YYMMMDD-AAATTT-AAAPNAME[\d+]-K
  // e.g. KXMLBKS-26MAY051940LANYM-LAYAMAMOTO61-7 or similar
  const parts = r.ticker.split('-')
  // parts[2] is the team-pitcher segment, e.g. "LAYAMAMOTO61"
  // Strip digits at end to get pitcher abbreviation
  const pitcherSegment = parts[2] ?? ''
  const pitcherCode = pitcherSegment.replace(/\d+$/, '')
  if (!pitcherKsMap.has(pitcherCode)) pitcherKsMap.set(pitcherCode, r.actual_ks)
}
console.log(`Distinct pitchers in kalshi_ks_markets: ${pitcherKsMap.size}`)
console.log('Sample:', [...pitcherKsMap.entries()].slice(0, 5))
