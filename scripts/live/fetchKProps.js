// scripts/live/fetchKProps.js — Fetch DK/FD pitcher K prop lines and store to DB.
//
// Called by dailyRun.sh in morning run and --lineups mode so preflight always
// has a reasonably fresh K prop line to compare against our model's λ.
//
// Usage:
//   node scripts/live/fetchKProps.js [--date YYYY-MM-DD]

import 'dotenv/config'
import { fetchKProps } from '../../lib/odds.js'
import * as db from '../../lib/db.js'
import { parseArgs } from '../../lib/cli-args.js'

const opts  = parseArgs({ date: { default: new Date().toISOString().slice(0, 10) } })
const TODAY = opts.date

const result = await fetchKProps()

if (!result.ok) {
  console.warn(`[k-props] Odds API unavailable: ${result.error} — skipping`)
  await db.close()
  process.exit(0)
}

if (!result.props.size) {
  console.log(`[k-props] No K prop lines found for ${TODAY}`)
  await db.close()
  process.exit(0)
}

let upserted = 0
for (const [nameLower, prop] of result.props) {
  // Restore title-case for storage (e.g. "gerrit cole" → "Gerrit Cole")
  const pitcherName = nameLower.replace(/\b\w/g, c => c.toUpperCase())
  await db.run(
    `INSERT INTO dk_k_props (prop_date, pitcher_name, dk_line, over_price, book, fetched_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(prop_date, pitcher_name) DO UPDATE SET
       dk_line    = excluded.dk_line,
       over_price = excluded.over_price,
       book       = excluded.book,
       fetched_at = excluded.fetched_at`,
    [TODAY, pitcherName, prop.line, prop.overPrice ?? null, prop.book ?? null],
  )
  upserted++
}

console.log(`[k-props] ${upserted} pitcher K prop lines stored for ${TODAY}  (API credits remaining: ${result.remaining ?? '?'})`)
await db.close()
