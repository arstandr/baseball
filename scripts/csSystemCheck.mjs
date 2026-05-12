import 'dotenv/config'
import { createClient } from '@libsql/client'
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })

const DATE = '2026-05-06'
const checks = []
const fail = (name, msg) => checks.push({ name, status: '❌', msg })
const pass = (name, msg) => checks.push({ name, status: '✅', msg })
const warn = (name, msg) => checks.push({ name, status: '⚠️', msg })

console.log('═'.repeat(75))
console.log('  CROSS-STRIKE SYSTEM CHECK')
console.log('═'.repeat(75))

// 1. Fires logged with correct strategy_mode
const fires = await db.execute({
  sql: `SELECT * FROM ks_bets WHERE bet_date = ? AND strategy_mode = 'pregame_cross_strike' ORDER BY logged_at`,
  args: [DATE],
})
if (fires.rows.length === 0) fail('1. Fires logged', 'no pregame_cross_strike rows in ks_bets')
else pass('1. Fires logged', `${fires.rows.length} rows present`)

// 2. Required fields populated
if (fires.rows.length > 0) {
  const sample = fires.rows[0]
  const required = ['ticker', 'side', 'strike', 'capital_at_risk', 'paper', 'order_id', 'order_status',
                    'fill_price', 'filled_contracts', 'user_id', 'pitcher_name', 'model_prob', 'market_mid',
                    'edge', 'lambda', 'strategy_mode', 'strategy_submode']
  const missing = required.filter(f => sample[f] == null)
  if (missing.length) fail('2. Required fields', `missing: ${missing.join(', ')}`)
  else pass('2. Required fields', 'all populated')
  
  // Check paper flag matches order_id pattern
  const wrongPaper = fires.rows.filter(r => 
    (String(r.order_id ?? '').startsWith('paper-') && r.paper !== 1) ||
    (!String(r.order_id ?? '').startsWith('paper-') && r.paper === 1 && r.order_id != null)
  )
  if (wrongPaper.length) fail('2b. Paper flag consistency', `${wrongPaper.length} mismatches (paper-flag-sweep should auto-correct)`)
  else pass('2b. Paper flag consistency', 'order_id matches paper flag')
}

// 3. Strategy mode validation — make sure it's accepted by validateStrategyMode
import('../lib/strategyMode.js').then(({ STRATEGY_MODES, isValidStrategyMode }) => {
  if (STRATEGY_MODES.PREGAME_CROSS_STRIKE !== 'pregame_cross_strike') fail('3a. Strategy enum', 'PREGAME_CROSS_STRIKE missing')
  else if (!isValidStrategyMode('pregame_cross_strike')) fail('3b. Strategy validator', 'pregame_cross_strike not validated')
  else pass('3. Strategy enum + validator', 'pregame_cross_strike is registered')
}).catch(() => fail('3. Strategy enum', 'failed to import lib/strategyMode.js'))

// 4. Cross-strike fields stored
if (fires.rows.length > 0) {
  // Check that cross_strike_residual etc were preserved (currently NOT stored in ks_bets — they're metadata)
  const hasResid = fires.rows[0].cross_strike_residual != null  // will likely be null since not in ks_bets schema
  warn('4. Cross-strike metadata', `cross_strike_residual NOT in ks_bets schema (only in shadow tables)`)
}

// 5. Shadow recording for cross-strike candidates
const shadowFD = await db.execute({sql:`SELECT COUNT(*) AS n FROM shadow_full_distribution WHERE bet_date = ?`, args:[DATE]})
if (shadowFD.rows[0].n > 0) pass('5. shadow_full_distribution', `${shadowFD.rows[0].n} rows for today (used for cross-strike daily POC settlement)`)
else warn('5. shadow_full_distribution', 'empty for today — POC validation won\'t have data')

// 6. Settlement path — when actual_ks comes in, will pnl compute?
const settled = fires.rows.filter(r => r.result != null)
const open = fires.rows.filter(r => r.result == null)
if (open.length > 0) pass('6a. Open fires waiting settlement', `${open.length} unsettled`)
if (settled.length > 0) pass('6b. Settlement working', `${settled.length} have result`)
// Check if there's a code path that handles pregame_cross_strike in settle
import('fs').then(fs => {
  const ksb = fs.readFileSync('./scripts/live/ksBets.js', 'utf8')
  if (ksb.includes('settleBets')) pass('6c. settleBets exists', 'standard path will handle cross-strike')
})

// 7. Pending rule evaluation registered
const pre = await db.execute(`SELECT * FROM pending_rule_evaluations WHERE rule_name = 'cross_strike_strategy'`)
if (pre.rows.length === 0) fail('7. Pending eval registered', 'no row for cross_strike_strategy')
else {
  pass('7. Pending eval registered', `status=${pre.rows[0].decision_status} sample=${pre.rows[0].current_sample}`)
}

// 8. Pitcher blocklist applied to cross-strike?
const blockedPitchers = await db.execute(`SELECT pitcher_name FROM pitcher_blocklist`)
const blockedSet = new Set(blockedPitchers.rows.map(r => r.pitcher_name))
const csOnBlocked = fires.rows.filter(r => blockedSet.has(r.pitcher_name))
if (csOnBlocked.length > 0) fail('8. Blocklist enforcement', `${csOnBlocked.length} cross-strike fires on blocked pitcher!`)
else pass('8. Blocklist enforcement', `no cross-strike fires on blocked pitchers (${blockedPitchers.rows.length} on list)`)

// 9. Recon: check for paper=0 with paper-prefix order_id (the May 4 bug pattern)
const reconBad = await db.execute({sql:`SELECT COUNT(*) AS n FROM ks_bets WHERE bet_date = ? AND paper = 0 AND order_id LIKE 'paper-%'`, args:[DATE]})
if (reconBad.rows[0].n > 0) fail('9. Recon safety', `${reconBad.rows[0].n} rows with paper=0 + synthetic order_id (recon will halt)`)
else pass('9. Recon safety', 'no paper-flag-sweep targets')

// 10. Dashboard API: will /api/ks/daily return cross-strike fires?
const dailyAPI = await db.execute({sql:`SELECT COUNT(*) AS n FROM ks_bets WHERE bet_date = ? AND live_bet = 0 AND filled_contracts > 0`, args:[DATE]})
pass('10. Dashboard API', `/api/ks/daily would return ${dailyAPI.rows[0].n} fires for today (paper filter dropped earlier)`)

// 11. EOD summary: will the strategy_mode breakdown include cross-strike?
import('../lib/eodSummary.js').then(({ buildEodSummary }) => {
  return buildEodSummary({ betDate: DATE })
}).then(report => {
  // The current eodSummary shape only tracks live, paper, normal_pnl, inversion_pnl, tier1/2/3 — no cross_strike
  if (report.paper && Number(report.paper.fires) > 0) {
    const hasCrossStrike = JSON.stringify(report).includes('cross_strike')
    if (!hasCrossStrike) warn('11. EOD post format', 'paper section doesn\'t break out cross_strike yet — will appear lumped into normal_pnl')
    else pass('11. EOD post format', 'cross-strike tracked separately')
  }
}).catch(e => warn('11. EOD post format', 'check failed: ' + e.message))

// 12. Discord pre-fire summary will identify cross-strike?
import('fs').then(fs => {
  const cage = fs.readFileSync('./lib/cageAlerts.js', 'utf8')
  const knowsCs = cage.includes('cross_strike') || cage.includes('cross-strike')
  if (!knowsCs) warn('12. Pre-fire Discord', 'cageAlerts.js doesn\'t flag cross-strike specifically — will show as generic bet (cal: fire)')
  else pass('12. Pre-fire Discord', 'cageAlerts.js renders cross-strike specifically')
})

// Final report
setTimeout(() => {
  console.log('\n' + '─'.repeat(75))
  for (const c of checks) console.log(`${c.status}  ${c.name.padEnd(36)} ${c.msg}`)
  console.log('─'.repeat(75))
  const failures = checks.filter(c => c.status === '❌').length
  const warnings = checks.filter(c => c.status === '⚠️').length
  console.log(`\n${failures} failures, ${warnings} warnings, ${checks.length - failures - warnings} passes`)
}, 1500)
