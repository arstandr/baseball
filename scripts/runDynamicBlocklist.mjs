// CLI for the dynamic blocklist evaluator. Run as a daily cron AND manually.
//
// Dry run (preview):  node scripts/runDynamicBlocklist.mjs
// Apply changes:       node scripts/runDynamicBlocklist.mjs --apply

import 'dotenv/config'
import { evaluateBlocklist } from '../lib/dynamicBlocklist.js'

const apply = process.argv.includes('--apply')
const result = await evaluateBlocklist({ dryRun: !apply })

console.log(`Mode: ${apply ? 'APPLY' : 'DRY RUN'}`)
console.log(`\nWould add (${result.adds.length}):`)
for (const a of result.adds) console.log(`  + ${a.pitcher} — ${a.reason}`)
console.log(`\nWould remove (${result.removes.length}):`)
for (const r of result.removes) console.log(`  - ${r.pitcher} — ${r.reason}`)
if (!apply && (result.adds.length || result.removes.length)) {
  console.log(`\nRe-run with --apply to commit changes.`)
}
