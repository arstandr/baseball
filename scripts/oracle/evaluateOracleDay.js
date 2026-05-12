// scripts/oracle/evaluateOracleDay.js
//
// End-of-day evaluation for the Oracle: takes the day's
// oracle-sim-<DATE>.jsonl + ks_bets settlements + pitcher_recent_starts
// (for Oracle-blocked bets that never landed in ks_bets) and answers:
//
//   Q1. P&L by Oracle decision class (pass / size_down / skip)
//   Q2. Win rate by class
//   Q3. Critic effectiveness (skip-only, concern-flag, boost — and
//       what % of each turned out to be the right call)
//   Q4. Per-bucket breakdown (feasibility × trust_level × baseline)
//   Q5. CLV — if closing-lines-<DATE>.csv exists, did the line move with
//       us or against us on bets the Oracle skipped?
//   Q6. Edge cases: fail-opens, gate errors, slow calls (>2s)
//   Q7. Latency / cost summary
//
// Usage:
//   node scripts/oracle/evaluateOracleDay.js                 (today)
//   node scripts/oracle/evaluateOracleDay.js --date 2026-04-30
//
// Output:
//   oracle/oracle-eval-<DATE>.md   (human report)
//   oracle/oracle-eval-<DATE>.csv  (per-row joined data for ad-hoc)

import 'dotenv/config'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'

import * as db from '../../lib/db.js'
import { parseArgs } from '../../lib/cli-args.js'

const today = new Date().toISOString().slice(0, 10)
const opts = parseArgs({
  date:    { default: today },
  outdir:  { default: 'oracle' },
})
const DATE = opts.date
const OUT = path.resolve(opts.outdir)

const LOG_PATH = path.resolve(`${opts.outdir}/oracle-sim-${DATE}.jsonl`)
const CLV_PATH = path.resolve(`${opts.outdir}/closing-lines-${DATE}.csv`)
const MD_PATH  = path.resolve(`${opts.outdir}/oracle-eval-${DATE}.md`)
const CSV_PATH = path.resolve(`${opts.outdir}/oracle-eval-${DATE}.csv`)

if (!existsSync(LOG_PATH)) {
  console.error(`[evaluateOracleDay] no log at ${LOG_PATH}`)
  process.exit(1)
}

const fmt$  = n => (n == null ? '—' : `$${Number(n).toFixed(2)}`)
const fmtPct = (a, b) => (b > 0 ? `${(100 * a / b).toFixed(1)}%` : '—')
const safe  = s => String(s ?? '').replace(/[",\n]/g, ' ')

// ── 1. Load JSONL ─────────────────────────────────────────────────
console.log(`[eval] loading ${LOG_PATH}`)
const records = []
for (const line of readFileSync(LOG_PATH, 'utf-8').split('\n')) {
  if (!line.trim()) continue
  try { records.push(JSON.parse(line)) } catch { /* skip */ }
}
console.log(`[eval] ${records.length} JSONL records`)

// ── 2. Load ks_bets for the date ──────────────────────────────────
const betRows = await db.all(`
  SELECT id AS bet_id, bet_date, pitcher_id, pitcher_name, strike, side, ticker,
         result, actual_ks, pnl, bet_size, fill_price, market_mid, spread,
         user_id, live_bet, order_status
  FROM ks_bets
  WHERE bet_date = ? AND live_bet = 0
`, [DATE])
const ksBetById = new Map()
const ksBetByKey = new Map()  // for hook-source records that lack bet_id
for (const r of betRows) {
  ksBetById.set(r.bet_id, r)
  const key = `${String(r.pitcher_id)}|${r.strike}|${r.side}|${r.user_id ?? ''}`
  ksBetByKey.set(key, r)
}
console.log(`[eval] ${betRows.length} ks_bets for ${DATE}`)

// ── 3. Load pitcher actual_ks for any pitcher Oracle saw (for blocked bets) ─
const allPids = [...new Set(records.map(r => String(r.pitcher_id)))]
const recentRows = allPids.length === 0 ? [] : await db.all(
  `SELECT pitcher_id, game_date, ks
   FROM pitcher_recent_starts
   WHERE pitcher_id IN (${allPids.map(() => '?').join(',')}) AND game_date = ?`,
  [...allPids, DATE],
)
const ksByPitcher = new Map()
for (const r of recentRows) ksByPitcher.set(String(r.pitcher_id), Number(r.ks))
console.log(`[eval] ${recentRows.length} pitcher_recent_starts rows for ${DATE}`)

// ── 4. Load CLV snapshot if present ───────────────────────────────
const clvByBetTicker = new Map()
if (existsSync(CLV_PATH)) {
  const lines = readFileSync(CLV_PATH, 'utf-8').split('\n').filter(Boolean)
  const header = lines[0].split(',')
  const ix = c => header.indexOf(c)
  for (const line of lines.slice(1)) {
    const c = line.split(',')
    const key = `${c[ix('bet_id')] || ''}|${c[ix('ticker')] || ''}`
    clvByBetTicker.set(key, {
      yes_bid:  Number(c[ix('close_yes_bid')]) || null,
      yes_ask:  Number(c[ix('close_yes_ask')]) || null,
      no_bid:   Number(c[ix('close_no_bid')])  || null,
      no_ask:   Number(c[ix('close_no_ask')])  || null,
      mid_yes:  Number(c[ix('close_mid_yes')]) || null,
      mid_no:   Number(c[ix('close_mid_no')])  || null,
    })
  }
  console.log(`[eval] CLV snapshot: ${clvByBetTicker.size} rows`)
} else {
  console.log(`[eval] (no CLV snapshot at ${CLV_PATH})`)
}

// ── 5. Build joined per-record analysis ────────────────────────────
function settledOutcome(rec) {
  // Returns { actual_ks, won, source }
  // Prefer ks_bets row; fall back to pitcher_recent_starts + strike rule.
  if (rec.bet_id != null) {
    const b = ksBetById.get(rec.bet_id)
    if (b && b.actual_ks != null) {
      const won = b.result === 'win' ? 1 : (b.result === 'loss' ? 0 : null)
      return { actual_ks: b.actual_ks, won, source: 'ks_bets' }
    }
  }
  const ks = ksByPitcher.get(String(rec.pitcher_id))
  if (ks == null) return { actual_ks: null, won: null, source: null }
  // YES strike+ wins iff actual >= strike; NO strike+ wins iff actual < strike
  const won = rec.side === 'YES' ? (ks >= Number(rec.strike) ? 1 : 0)
                                  : (ks <  Number(rec.strike) ? 1 : 0)
  return { actual_ks: ks, won, source: 'pitcher_recent_starts' }
}

function counterfactualPnl(rec, won, fillPrice, betSize) {
  // For Oracle-skipped bets that production WOULD have placed:
  // best estimate of P&L is from ks_bets if it ran;
  // for hook-source skips, we won't have fill_price, so estimate using market_mid.
  if (won == null) return null
  const f = (fillPrice ?? rec.market_mid) / 100
  const size = betSize ?? 10  // default $10 stake
  if (won === 1) {
    return size * (1 - f) / f * 0.97  // 3% Kalshi fee buffer
  }
  return -size
}

const joined = []
for (const r of records) {
  const action = r.effective_action ?? r.oracle_action ?? 'pass'
  const out = settledOutcome(r)
  const fromKs = r.bet_id != null ? ksBetById.get(r.bet_id) : null
  const cf = counterfactualPnl(r, out.won, fromKs?.fill_price, fromKs?.bet_size)
  // Production P&L: only meaningful if bet was actually placed (production path)
  const prodPnl = (r.source === 'ksBets_hook' && action === 'skip')
    ? null   // Oracle blocked it — there's no prod P&L
    : (fromKs?.pnl ?? r.production_pnl ?? null)
  // Oracle P&L: skip→0, pass→prodPnl, size_down→half
  let oraclePnl = null
  if (action === 'skip') oraclePnl = 0
  else if (action === 'size_down') oraclePnl = (prodPnl ?? cf ?? 0) * 0.5
  else oraclePnl = prodPnl ?? cf

  // CLV
  const ticker = r.ticker
  const clv = ticker ? clvByBetTicker.get(`${r.bet_id ?? ''}|${ticker}`) : null

  joined.push({
    bet_id: r.bet_id ?? null,
    source: r.source ?? 'simulator',
    pitcher_id: r.pitcher_id,
    pitcher_name: r.pitcher_name,
    strike: r.strike,
    side: r.side,
    ticker: ticker ?? null,
    market_mid: r.market_mid,
    feasibility: r.oracle?.feasibility ?? null,
    trust_level: r.oracle?.trust_level ?? null,
    trust_score: r.oracle?.trust_score ?? null,
    judge_baseline: r.oracle_baseline?.decision ?? null,
    critic_verdict: r.oracle?.critic_verdict ?? null,
    critic_concerns: (r.oracle?.critic_concerns ?? []).join('|'),
    critic_applied: (r.oracle?.critic_applied ?? []).join('|'),
    critic_reason_text: (r.critic_reason_text ?? r.oracle?.critic_reason_text ?? '').slice(0, 200),
    judge_decision: r.oracle?.decision ?? null,
    edge: r.oracle?.edge ?? null,
    threshold: r.oracle?.threshold ?? null,
    oracle_action: r.oracle_action,
    effective_action: action,
    actual_ks: out.actual_ks,
    won: out.won,
    outcome_source: out.source,
    production_pnl: prodPnl,
    oracle_pnl: oraclePnl,
    delta_pnl: (oraclePnl ?? 0) - (prodPnl ?? 0),
    elapsed_ms: r.elapsed_ms ?? null,
    error: r.oracle_error ?? null,
    close_mid_yes: clv?.mid_yes ?? null,
    close_mid_no:  clv?.mid_no ?? null,
  })
}

// ── 6. Aggregations ───────────────────────────────────────────────
const byClass = { pass: [], size_down: [], skip: [] }
for (const j of joined) {
  if (byClass[j.effective_action]) byClass[j.effective_action].push(j)
}

function rollup(rows) {
  const settled = rows.filter(j => j.won != null)
  const wins = settled.filter(j => j.won === 1).length
  const losses = settled.filter(j => j.won === 0).length
  const prodPnl = settled.reduce((s, j) => s + (Number(j.production_pnl) || 0), 0)
  const orPnl   = settled.reduce((s, j) => s + (Number(j.oracle_pnl)     || 0), 0)
  return {
    n: rows.length, settled: settled.length, wins, losses,
    win_rate: fmtPct(wins, settled.length),
    production_pnl: prodPnl, oracle_pnl: orPnl, delta: orPnl - prodPnl,
  }
}

const passR = rollup(byClass.pass)
const sdR   = rollup(byClass.size_down)
const skR   = rollup(byClass.skip)
const totalR = rollup(joined)

// Critic effectiveness — per-verdict win-rate of the underlying production pick
const verdictGroups = {}
for (const j of joined) {
  const v = j.critic_verdict ?? 'none'
  if (!verdictGroups[v]) verdictGroups[v] = []
  verdictGroups[v].push(j)
}

// Per-bucket: feasibility × trust_level
const bucketGroups = {}
for (const j of joined) {
  const key = `${j.feasibility ?? '—'} × ${j.trust_level ?? '—'}`
  if (!bucketGroups[key]) bucketGroups[key] = []
  bucketGroups[key].push(j)
}

// Edge cases
const errors = joined.filter(j => j.error)
const slow = joined.filter(j => j.elapsed_ms != null && j.elapsed_ms > 2000)

// CLV — for skipped bets only, did the line move toward us (good skip) or away (bad skip)?
const skippedWithClv = byClass.skip.filter(j => j.close_mid_yes != null && j.market_mid != null)
let clvLineMoves = 0  // count of skips where market_mid moved the wrong way (against the bet)
let clvLineMovesTotal = 0
for (const j of skippedWithClv) {
  const start = Number(j.market_mid)        // YES cents at decision
  const close = Number(j.close_mid_yes)     // YES cents at close
  if (!Number.isFinite(start) || !Number.isFinite(close)) continue
  clvLineMovesTotal++
  // If side=YES, "good skip" means YES line FELL (we'd have lost edge)
  // If side=NO,  "good skip" means YES line ROSE (NO got worse)
  if ((j.side === 'YES' && close < start) || (j.side === 'NO' && close > start)) clvLineMoves++
}

// Latency / cost
const elapsed = joined.map(j => j.elapsed_ms).filter(n => Number.isFinite(n))
elapsed.sort((a, b) => a - b)
const p = pct => elapsed.length ? elapsed[Math.floor(elapsed.length * pct)] : null
const latencyP50 = p(0.50)
const latencyP90 = p(0.90)
const latencyP99 = p(0.99)

// ── 7. Markdown report ────────────────────────────────────────────
const md = []
md.push(`# Oracle End-of-Day Eval — ${DATE}`)
md.push('')
md.push(`Generated: ${new Date().toISOString()}`)
md.push(`Records: ${joined.length} (${byClass.pass.length} pass, ${byClass.size_down.length} size_down, ${byClass.skip.length} skip)`)
md.push(`ks_bets joined: ${betRows.length}`)
md.push(`Pitcher actuals available: ${recentRows.length}`)
md.push(`CLV snapshot: ${clvByBetTicker.size > 0 ? `present (${clvByBetTicker.size} rows)` : 'absent'}`)
md.push('')
md.push('## Q1–Q2: P&L and Win-Rate by Oracle Class')
md.push('')
md.push('| class | n | settled | wins | losses | win_rate | production_pnl | oracle_pnl | Δ |')
md.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|')
for (const [k, r] of [['pass', passR], ['size_down', sdR], ['skip', skR], ['ALL', totalR]]) {
  md.push(`| ${k} | ${r.n} | ${r.settled} | ${r.wins} | ${r.losses} | ${r.win_rate} | ${fmt$(r.production_pnl)} | ${fmt$(r.oracle_pnl)} | ${fmt$(r.delta)} |`)
}
md.push('')
md.push('## Q3: Critic Effectiveness (per verdict)')
md.push('')
md.push('| verdict | n | settled | win_rate of underlying pick | applied | reason_text sample |')
md.push('|---|---:|---:|---:|---|---|')
for (const [v, rows] of Object.entries(verdictGroups).sort((a, b) => b[1].length - a[1].length)) {
  const settled = rows.filter(j => j.won != null)
  const wins = settled.filter(j => j.won === 1).length
  const sample = (rows.find(r => r.critic_reason_text)?.critic_reason_text ?? '').slice(0, 80).replace(/\|/g, '/')
  const applied = [...new Set(rows.flatMap(r => (r.critic_applied || '').split('|').filter(Boolean)))].join('+') || '—'
  md.push(`| ${v} | ${rows.length} | ${settled.length} | ${fmtPct(wins, settled.length)} | ${applied} | ${sample} |`)
}
md.push('')
md.push('## Q4: Per-bucket breakdown (feasibility × trust_level)')
md.push('')
md.push('| bucket | n | pass | sd | skip | settled | win_rate | Δ pnl |')
md.push('|---|---:|---:|---:|---:|---:|---:|---:|')
for (const [k, rows] of Object.entries(bucketGroups).sort((a, b) => b[1].length - a[1].length)) {
  const r = rollup(rows)
  const counts = rows.reduce((a, j) => { a[j.effective_action] = (a[j.effective_action] || 0) + 1; return a }, {})
  md.push(`| ${k} | ${rows.length} | ${counts.pass || 0} | ${counts.size_down || 0} | ${counts.skip || 0} | ${r.settled} | ${r.win_rate} | ${fmt$(r.delta)} |`)
}
md.push('')
md.push('## Q5: CLV (Closing Line Value) on skipped bets')
md.push('')
if (clvByBetTicker.size === 0) {
  md.push('_(No CLV snapshot — run scripts/live/captureClosingLines.js at slate close.)_')
} else {
  md.push(`- Skipped bets with CLV data: **${skippedWithClv.length}** of ${byClass.skip.length}`)
  md.push(`- Skips where line moved **AGAINST** the original bet (good skip): **${clvLineMoves}** / ${clvLineMovesTotal} (${fmtPct(clvLineMoves, clvLineMovesTotal)})`)
  md.push('')
  md.push('| pitcher | strike | side | market_mid → close_yes_mid | direction |')
  md.push('|---|---:|---|---|---|')
  for (const j of skippedWithClv.slice(0, 25)) {
    const dir = (j.side === 'YES' && j.close_mid_yes < j.market_mid) || (j.side === 'NO' && j.close_mid_yes > j.market_mid) ? 'GOOD' : 'BAD'
    md.push(`| ${j.pitcher_name} | ${j.strike} | ${j.side} | ${j.market_mid}¢ → ${j.close_mid_yes?.toFixed(1)}¢ | ${dir} |`)
  }
}
md.push('')
md.push('## Q6: Edge cases')
md.push('')
md.push(`- Fail-opens / errors: **${errors.length}**`)
for (const e of errors.slice(0, 10)) md.push(`  - ${e.pitcher_name} ${e.strike}${e.side}: ${e.error}`)
md.push(`- Slow calls (>2s): **${slow.length}**`)
md.push('')
md.push('## Q7: Latency / cost')
md.push('')
md.push(`- p50: ${latencyP50}ms · p90: ${latencyP90}ms · p99: ${latencyP99}ms`)
md.push('')
md.push('---')
md.push('')
md.push(`Per-row CSV: \`${path.basename(CSV_PATH)}\``)

writeFileSync(MD_PATH, md.join('\n') + '\n', 'utf-8')
console.log(`[eval] wrote ${MD_PATH}`)

// ── 8. CSV dump ───────────────────────────────────────────────────
const csvCols = [
  'bet_id','source','pitcher_id','pitcher_name','strike','side','ticker','market_mid',
  'feasibility','trust_level','trust_score','judge_baseline','critic_verdict','critic_concerns','critic_applied','critic_reason_text',
  'judge_decision','edge','threshold','oracle_action','effective_action',
  'actual_ks','won','outcome_source','production_pnl','oracle_pnl','delta_pnl',
  'elapsed_ms','error','close_mid_yes','close_mid_no',
]
const csvLines = [csvCols.join(',')]
for (const j of joined) {
  csvLines.push(csvCols.map(c => safe(j[c])).join(','))
}
writeFileSync(CSV_PATH, csvLines.join('\n') + '\n', 'utf-8')
console.log(`[eval] wrote ${CSV_PATH}`)

await db.close()
console.log('[eval] done')
