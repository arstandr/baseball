// scripts/clv/clvReport.js — Closing Line Value analysis report.
//
// The single most important metric in this repo: if paper bets consistently
// beat the closing line, the model has real edge regardless of win/loss luck.
// Three weeks of CLV data is worth more than any backtest.
//
// Metrics produced:
//   - Total paper bets logged (with/without close price)
//   - Beat-the-line rate (% of bets with clv > 0) — target: > 50%
//   - Average CLV in cents
//   - CLV by signal tag (low_k_stack, hitter_park, etc.)
//   - Rolling 30-day CLV trend (weekly buckets)
//   - Win rate vs CLV rate (correlation sanity check)
//
// Usage:
//   node scripts/clv/clvReport.js [--since YYYY-MM-DD] [--series f5_total|full_total]

import 'dotenv/config'
import * as db from '../../lib/db.js'

// ── CLI args ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const sinceArg = args.includes('--since')  ? args[args.indexOf('--since')  + 1] : null
const seriesArg= args.includes('--series') ? args[args.indexOf('--series') + 1] : null

// Default: last 30 days
const SINCE = sinceArg || (() => {
  const d = new Date()
  d.setDate(d.getDate() - 30)
  return d.toISOString().slice(0, 10)
})()

// ── Formatting helpers ────────────────────────────────────────────────────

function pct(n, d) {
  if (!d) return 'n/a'
  return `${(100 * n / d).toFixed(1)}%`
}

function avg(nums) {
  if (!nums.length) return null
  return nums.reduce((a, b) => a + b, 0) / nums.length
}

function signStr(n) {
  if (n == null) return 'n/a'
  return (n >= 0 ? '+' : '') + n.toFixed(2)
}

function bar(rate, width = 20) {
  const filled = Math.round(rate * width)
  return '[' + '█'.repeat(filled) + '░'.repeat(width - filled) + ']'
}

// ── Report sections ───────────────────────────────────────────────────────

function sectionOverview(rows) {
  const settled   = rows.filter(r => r.clv != null)
  const beat      = settled.filter(r => r.clv > 0)
  const flat      = settled.filter(r => r.clv === 0)
  const lost      = settled.filter(r => r.clv < 0)
  const avgClv    = avg(settled.map(r => r.clv))
  const beatRate  = settled.length ? beat.length / settled.length : null

  console.log('═══════════════════════════════════════════════════')
  console.log('  CLV REPORT')
  console.log(`  Since: ${SINCE}${seriesArg ? ` | Series: ${seriesArg}` : ''}`)
  console.log('═══════════════════════════════════════════════════')
  console.log(`  Total paper bets logged : ${rows.length}`)
  console.log(`  With closing price      : ${settled.length}`)
  console.log(`  Pending close           : ${rows.length - settled.length}`)
  console.log()
  console.log('  ── Closing Line Value ──────────────────────────')
  if (!settled.length) {
    console.log('  No settled entries yet.')
    return
  }
  const rateFmt = beatRate != null ? `${(beatRate * 100).toFixed(1)}%` : 'n/a'
  console.log(`  Beat the line  : ${beat.length}/${settled.length} (${rateFmt})`)
  console.log(`  Flat (clv=0)   : ${flat.length}`)
  console.log(`  Behind the line: ${lost.length}`)
  console.log(`  Avg CLV        : ${signStr(avgClv)}¢`)
  if (beatRate != null) {
    const label = beatRate > 0.55 ? ' ← STRONG EDGE' : beatRate > 0.50 ? ' ← MARGINAL EDGE' : ' ← NO EDGE DETECTED'
    console.log(`  Beat rate      : ${bar(beatRate)} ${rateFmt}${label}`)
  }
}

function sectionBySide(rows) {
  const settled = rows.filter(r => r.clv != null)
  if (!settled.length) return

  console.log()
  console.log('  ── CLV by Side ─────────────────────────────────')
  for (const side of ['OVER', 'UNDER']) {
    const sub = settled.filter(r => r.side === side)
    if (!sub.length) continue
    const beat = sub.filter(r => r.clv > 0).length
    const a    = avg(sub.map(r => r.clv))
    console.log(`  ${side.padEnd(7)}: ${beat}/${sub.length} beat (${pct(beat, sub.length)}) | avg clv ${signStr(a)}¢`)
  }
}

function sectionBySignalTag(rows) {
  const settled = rows.filter(r => r.clv != null && r.signal_tags)

  if (!settled.length) return

  // Expand tags
  const tagMap = {}
  for (const row of settled) {
    let tags = []
    try { tags = JSON.parse(row.signal_tags) } catch { continue }
    for (const tag of tags) {
      if (!tagMap[tag]) tagMap[tag] = []
      tagMap[tag].push(row.clv)
    }
  }

  const tagStats = Object.entries(tagMap)
    .filter(([, v]) => v.length >= 3)  // min 3 samples to show
    .map(([tag, clvs]) => ({
      tag,
      n: clvs.length,
      beat: clvs.filter(c => c > 0).length,
      avgClv: avg(clvs),
    }))
    .sort((a, b) => b.avgClv - a.avgClv)

  if (!tagStats.length) return

  console.log()
  console.log('  ── CLV by Signal Tag (min 3 samples) ───────────')
  console.log(`  ${'Tag'.padEnd(22)} ${'N'.padStart(4)} ${'Beat'.padStart(5)} ${'Avg CLV'.padStart(9)}`)
  console.log(`  ${'─'.repeat(22)} ${'─'.repeat(4)} ${'─'.repeat(5)} ${'─'.repeat(9)}`)
  for (const { tag, n, beat, avgClv } of tagStats) {
    const beatPct = `${(100 * beat / n).toFixed(0)}%`
    const flag = avgClv > 2 ? ' ←' : ''
    console.log(
      `  ${tag.slice(0, 22).padEnd(22)} ${String(n).padStart(4)} ${beatPct.padStart(5)} ${signStr(avgClv).padStart(9)}¢${flag}`,
    )
  }
}

function sectionRolling30Day(rows) {
  const settled = rows.filter(r => r.clv != null && r.game_date)
  if (settled.length < 5) return

  // Bucket by ISO week
  const weekMap = {}
  for (const row of settled) {
    const d = new Date(row.game_date)
    // ISO week key: year-Wnn
    const jan4 = new Date(d.getFullYear(), 0, 4)
    const weekNum = Math.ceil(((d - jan4) / 86400000 + jan4.getDay() + 1) / 7)
    const key = `${d.getFullYear()}-W${String(weekNum).padStart(2, '0')}`
    if (!weekMap[key]) weekMap[key] = []
    weekMap[key].push(row.clv)
  }

  const weeks = Object.entries(weekMap).sort((a, b) => a[0].localeCompare(b[0]))

  console.log()
  console.log('  ── Rolling CLV Trend (weekly buckets) ──────────')
  console.log(`  ${'Week'.padEnd(10)} ${'N'.padStart(4)} ${'Beat%'.padStart(6)} ${'Avg CLV'.padStart(9)}`)
  console.log(`  ${'─'.repeat(10)} ${'─'.repeat(4)} ${'─'.repeat(6)} ${'─'.repeat(9)}`)
  for (const [week, clvs] of weeks) {
    const beat    = clvs.filter(c => c > 0).length
    const beatPct = `${(100 * beat / clvs.length).toFixed(0)}%`
    const a       = avg(clvs)
    const trend   = a > 0 ? '↑' : a < 0 ? '↓' : '→'
    console.log(
      `  ${week.padEnd(10)} ${String(clvs.length).padStart(4)} ${beatPct.padStart(6)} ${signStr(a).padStart(9)}¢ ${trend}`,
    )
  }
}

function sectionWinVsCLV(rows) {
  const both = rows.filter(r => r.clv != null && r.result != null)
  if (both.length < 5) return

  const winsWithPosCLV   = both.filter(r => r.result === 1 && r.clv > 0).length
  const winsWithNegCLV   = both.filter(r => r.result === 1 && r.clv <= 0).length
  const lossesWithPosCLV = both.filter(r => r.result === 0 && r.clv > 0).length
  const lossesWithNegCLV = both.filter(r => r.result === 0 && r.clv <= 0).length
  const winRate = both.filter(r => r.result === 1).length / both.length
  const clvRate = both.filter(r => r.clv > 0).length / both.length

  console.log()
  console.log('  ── Win Rate vs CLV Rate (n=' + both.length + ') ───────────────')
  console.log(`  Win rate : ${(winRate * 100).toFixed(1)}%`)
  console.log(`  CLV rate : ${(clvRate * 100).toFixed(1)}%`)
  console.log()
  console.log('  Contingency table:')
  console.log(`              CLV+    CLV-`)
  console.log(`  WIN     :  ${String(winsWithPosCLV).padStart(4)}    ${String(winsWithNegCLV).padStart(4)}`)
  console.log(`  LOSS    :  ${String(lossesWithPosCLV).padStart(4)}    ${String(lossesWithNegCLV).padStart(4)}`)
  console.log()
  console.log('  If CLV+ bets win at higher rates than CLV- bets,')
  console.log('  market price movements ARE predictive (strong signal).')
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  await db.migrate()

  const rows = await db.getCLVEntries({ since: SINCE, series: seriesArg || undefined })

  if (!rows.length) {
    console.log(`[clvReport] no CLV entries since ${SINCE}`)
    await db.close()
    return
  }

  sectionOverview(rows)
  sectionBySide(rows)
  sectionBySignalTag(rows)
  sectionRolling30Day(rows)
  sectionWinVsCLV(rows)

  console.log()
  console.log('═══════════════════════════════════════════════════')
  await db.close()
}

main().catch(err => {
  console.error('[clvReport] fatal:', err.message)
  process.exit(1)
})
