// Manual EOD report — preview or push to Discord.
//
// Preview only:
//   node scripts/eodReport.mjs                # today (ET)
//   node scripts/eodReport.mjs 2026-05-03     # specific date
//
// Push to Discord (uses cage webhook):
//   node scripts/eodReport.mjs --push
//   node scripts/eodReport.mjs 2026-05-03 --push

import 'dotenv/config'
import { buildEodSummary } from '../lib/eodSummary.js'
import { notifyEod } from '../lib/cageAlerts.js'

const args = process.argv.slice(2)
const push = args.includes('--push')
const date = args.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a)) ||
             new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })

const summary = await buildEodSummary(date)
console.log('── EOD Summary for', date, '──')
console.log(JSON.stringify(summary, null, 2))

if (push) {
  // Force the opt-in for one-shot CLI runs so the post lands regardless of ENV state.
  process.env.DISCORD_DAILY_REPORT_ENABLED = 'true'
  const result = await notifyEod({ date, summary })
  console.log('Discord post result:', result)
}
