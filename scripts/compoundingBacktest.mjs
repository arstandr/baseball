// Realistic compounding backtest of the validated strategy.
//
// Strategy under test (validated on 1,056 pitcher-games, 37 days):
//   - top-5 candidates per day, edge ≥5¢, ask ≤50¢, YES-only
//   - Daily P&L from extendedFadeBacktest.mjs at $50/bet flat
//
// What this script adds:
//   - Starting bankroll = $5,000
//   - Bet size = X% of CURRENT bankroll (compounding)
//   - Realistic max-bet cap: $200/bet (Kalshi depth constraint)
//   - Bankrupt threshold: $500 (strategy dies, can't size meaningfully)
//   - Multiple sizing variants compared
//
// Why per-day P&L scales linearly with bet size:
//   Original P&L = sum(win: $50*(100-ask)/ask*0.93) + sum(loss: -$50)
//   At bet size X: sum scales by X/$50. So per-day P&L × (today_bet_size / $50).

const STARTING = 5000
const REFERENCE_BET = 50           // What backtest used
const MAX_BET_CAP   = 200          // Realistic Kalshi depth ceiling per market
const BANKRUPT_AT   = 500          // Below this, we can't meaningfully size

// Daily P&L from extendedFadeBacktest.mjs validated config (top-5/day, edge≥5c, ask≤50c, YES)
const DAILY = [
  { date: '2026-03-31', n: 5, w: 1, pnl: -118 },
  { date: '2026-04-01', n: 5, w: 4, pnl:  747 },
  { date: '2026-04-03', n: 5, w: 0, pnl: -249 },
  { date: '2026-04-04', n: 5, w: 2, pnl:  346 },
  { date: '2026-04-05', n: 5, w: 0, pnl: -250 },
  { date: '2026-04-06', n: 5, w: 1, pnl: -130 },
  { date: '2026-04-07', n: 5, w: 2, pnl:  170 },
  { date: '2026-04-08', n: 5, w: 1, pnl: -148 },
  { date: '2026-04-09', n: 5, w: 1, pnl: -118 },
  { date: '2026-04-10', n: 5, w: 2, pnl:  283 },
  { date: '2026-04-11', n: 5, w: 2, pnl:  211 },
  { date: '2026-04-12', n: 5, w: 3, pnl:  249 },
  { date: '2026-04-13', n: 5, w: 1, pnl: -138 },
  { date: '2026-04-14', n: 5, w: 0, pnl: -250 },
  { date: '2026-04-15', n: 5, w: 2, pnl:   70 },
  { date: '2026-04-16', n: 4, w: 0, pnl: -200 },
  { date: '2026-04-17', n: 5, w: 2, pnl:  140 },
  { date: '2026-04-18', n: 5, w: 5, pnl: 1945 },
  { date: '2026-04-19', n: 5, w: 1, pnl:  -68 },
  { date: '2026-04-20', n: 5, w: 0, pnl: -250 },
  { date: '2026-04-21', n: 5, w: 0, pnl: -249 },
  { date: '2026-04-22', n: 5, w: 4, pnl: 1136 },
  { date: '2026-04-23', n: 5, w: 2, pnl:   39 },
  { date: '2026-04-24', n: 5, w: 0, pnl: -250 },
  { date: '2026-04-25', n: 5, w: 3, pnl:  300 },
  { date: '2026-04-26', n: 5, w: 5, pnl:  538 },
  { date: '2026-04-27', n: 5, w: 1, pnl: -136 },
  { date: '2026-04-28', n: 5, w: 0, pnl: -249 },
  { date: '2026-04-29', n: 5, w: 0, pnl: -250 },
  { date: '2026-04-30', n: 5, w: 4, pnl:  608 },
  { date: '2026-05-01', n: 5, w: 0, pnl: -250 },
  { date: '2026-05-02', n: 5, w: 2, pnl:   64 },
  { date: '2026-05-03', n: 5, w: 5, pnl: 1042 },
  { date: '2026-05-04', n: 5, w: 2, pnl:    2 },
  { date: '2026-05-05', n: 5, w: 0, pnl: -250 },
  { date: '2026-05-06', n: 5, w: 0, pnl: -249 },
]

function simulate(pctPerBet, opts = {}) {
  const { capPerBet = MAX_BET_CAP, ruinAt = BANKRUPT_AT } = opts
  let bankroll = STARTING
  let peak = bankroll
  let maxDD = 0, daysUnderwater = 0, currentUnderwater = 0
  let ruined = false
  const equity = [{ date: 'start', bankroll, dayPnl: 0, betSize: 0 }]

  for (const day of DAILY) {
    if (bankroll < ruinAt) { ruined = true; break }

    const wantBet = bankroll * pctPerBet / 100
    const betSize = Math.min(wantBet, capPerBet)
    // Scaling: if bet was $50 in backtest, and now we're betting $betSize, scale per-bet pnl by betSize/50
    // BUT: each day's pnl is sum of 5 bet pnl's at $50, so total pnl scales by same factor
    const scale = betSize / REFERENCE_BET
    const dayPnl = day.pnl * scale
    bankroll += dayPnl

    if (bankroll > peak) { peak = bankroll; currentUnderwater = 0 }
    else { currentUnderwater++ }
    if (currentUnderwater > daysUnderwater) daysUnderwater = currentUnderwater
    const dd = (peak - bankroll) / peak
    if (dd > maxDD) maxDD = dd

    equity.push({ date: day.date, bankroll, dayPnl, betSize, peak })
  }

  return { bankroll, peak, maxDD, daysUnderwater, ruined, equity }
}

// Helper for streak analysis
function maxConsecutive(predicate) {
  let cur = 0, max = 0
  for (const d of DAILY) {
    if (predicate(d)) { cur++; if (cur > max) max = cur }
    else cur = 0
  }
  return max
}

console.log('═══════════════════════════════════════════════════════════════════════════════════')
console.log('  COMPOUNDING BACKTEST — $5,000 starting, top-5/day strategy, 36 trading days')
console.log('═══════════════════════════════════════════════════════════════════════════════════\n')

// Sample stats
const totalPnlFlat = DAILY.reduce((s,d)=> s+d.pnl, 0)
const winDays = DAILY.filter(d => d.pnl > 0).length
const losingStreak = maxConsecutive(d => d.pnl < 0)
const winningStreak = maxConsecutive(d => d.pnl > 0)
const zeroDays = DAILY.filter(d => d.w === 0).length
console.log(`Sample: ${DAILY.length} days, ${winDays}W/${DAILY.length-winDays}L (${(winDays/DAILY.length*100).toFixed(0)}%), ${zeroDays} zero-win days`)
console.log(`Streaks: longest losing=${losingStreak} days, longest winning=${winningStreak} days`)
console.log(`Flat-$50 P&L: +$${totalPnlFlat.toFixed(0)} over 36 days = $${(totalPnlFlat/36).toFixed(0)}/day average\n`)

// Sweep
console.log('Sizing sweep (with $200/bet realistic cap):')
console.log('size%  final   return  peak    maxDD   underwater  ruined?')
console.log('─'.repeat(70))
const variants = [0.5, 1, 1.5, 2, 3, 4, 5, 7.5, 10, 15, 20]
const results = {}
for (const pct of variants) {
  const r = simulate(pct)
  results[pct] = r
  const ret = ((r.bankroll / STARTING - 1) * 100)
  console.log(`${pct.toFixed(1).padStart(4)}%  $${r.bankroll.toFixed(0).padStart(6)}  ${(ret>=0?'+':'')}${ret.toFixed(1).padStart(6)}%  $${r.peak.toFixed(0).padStart(5)}  ${(r.maxDD*100).toFixed(1).padStart(5)}%  ${String(r.daysUnderwater).padStart(3)} days  ${r.ruined ? 'YES (mid-run)' : 'no'}`)
}

console.log('\nSame sweep without bet cap (academic — for reference):')
console.log('size%  final     return     peak      maxDD   ruined?')
console.log('─'.repeat(60))
for (const pct of variants) {
  const r = simulate(pct, { capPerBet: 1e9 })
  const ret = ((r.bankroll / STARTING - 1) * 100)
  console.log(`${pct.toFixed(1).padStart(4)}%  $${r.bankroll.toFixed(0).padStart(7)}  ${(ret>=0?'+':'')}${ret.toFixed(1).padStart(7)}%  $${r.peak.toFixed(0).padStart(7)}  ${(r.maxDD*100).toFixed(1).padStart(5)}%  ${r.ruined ? 'YES' : 'no'}`)
}

// Equity curve for the optimal sizing (with cap)
const optimalPct = Object.entries(results)
  .filter(([_, r]) => !r.ruined)
  .sort((a, b) => b[1].bankroll - a[1].bankroll)[0]?.[0]
console.log(`\nEquity curve at ${optimalPct}% per bet (best non-ruin variant):`)
console.log('date         bankroll    dayPnl    betSize  peak       drawdown')
console.log('─'.repeat(70))
const opt = results[optimalPct]
for (const e of opt.equity) {
  if (e.date === 'start') {
    console.log(`${e.date.padEnd(11)}  $${e.bankroll.toFixed(0).padStart(7)}      —          —     $${e.bankroll.toFixed(0).padStart(7)}    0%`)
    continue
  }
  const dd = ((e.peak - e.bankroll) / e.peak * 100)
  console.log(`${e.date}  $${e.bankroll.toFixed(0).padStart(7)}  ${e.dayPnl >= 0 ? '+' : ''}$${e.dayPnl.toFixed(0).padStart(5)}    $${e.betSize.toFixed(0).padStart(4)}   $${e.peak.toFixed(0).padStart(7)}    ${dd.toFixed(1).padStart(4)}%`)
}

// Annualized projection
console.log('\n══ Annualized projection ══')
console.log('Assumes pattern continues. 162-game MLB season, ~165 trading days.')
console.log()
console.log('size%  36-day return  pessimistic 165-day  optimistic 165-day')
console.log('─'.repeat(70))
for (const pct of [1, 2, 3, 5]) {
  const r = simulate(pct)
  if (r.ruined) { console.log(`${pct}% — RUINED`); continue }
  const r36 = r.bankroll / STARTING
  // Pessimistic: same compound rate but cap-constrained at scale
  const dailyRate = Math.pow(r36, 1/DAILY.length)
  const pess165 = STARTING * Math.pow(dailyRate, 165) * 0.6  // 40% haircut for variance + cap
  const opt165 = STARTING * Math.pow(dailyRate, 165) * 0.85  // 15% haircut
  console.log(`${pct}%   $${(r.bankroll-STARTING).toFixed(0).padStart(5)} (${((r36-1)*100).toFixed(0).padStart(3)}%)  $${(pess165-STARTING).toFixed(0).padStart(7)} (${((pess165/STARTING-1)*100).toFixed(0)}%)  $${(opt165-STARTING).toFixed(0).padStart(7)} (${((opt165/STARTING-1)*100).toFixed(0)}%)`)
}
