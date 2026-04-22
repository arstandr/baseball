import 'dotenv/config'
import * as db from '../../../lib/db.js'

await db.migrate()
const games = await db.all('SELECT * FROM nba_backtest_games WHERE vegas_line IS NOT NULL AND actual_total IS NOT NULL ORDER BY game_date ASC')

const SIGMA      = 18.1
const SIG_MARKET = 10
const MIN_EDGE   = 0.05
const OFFSETS    = [-15,-12,-9,-6,-3,0,3,6,9,12,15]
const START      = 5000

function normalCDF(z) {
  const t = 1/(1+0.2316419*Math.abs(z))
  const d = 0.3989423*Math.exp(-z*z/2)
  const p = d*t*(0.3193815+t*(-0.3565638+t*(1.7814779+t*(-1.8212560+t*1.3302744))))
  return z>0?1-p:p
}
function pOver(line,mu,sigma){ return 1-normalCDF((line-mu)/sigma) }

const byDate = {}
for (const g of games) {
  byDate[g.game_date] = byDate[g.game_date] || []
  byDate[g.game_date].push(g)
}

const scenarios = [
  { label: 'Conservative  ($50/bet flat)',  betSize: 50  },
  { label: 'Moderate     ($100/bet flat)',  betSize: 100 },
  { label: 'Aggressive   ($250/bet flat)',  betSize: 250 },
]

for (const sc of scenarios) {
  let bankroll = START
  let totalBets = 0, totalWins = 0, totalWagered = 0, peak = START, maxDD = 0
  const monthly = {}

  for (const [date, dayGames] of Object.entries(byDate).sort()) {
    const month = date.slice(0,7)
    if (!monthly[month]) monthly[month] = { pnl: 0, startBR: bankroll }
    let dayPnl = 0

    for (const game of dayGames) {
      for (const offset of OFFSETS) {
        const line      = game.vegas_line + offset
        const modelProb = pOver(line, game.vegas_line, SIGMA)
        const kalshiYes = pOver(line, game.vegas_line, SIG_MARKET)
        const kalshiNo  = 1 - kalshiYes
        const overEdge  = modelProb - kalshiYes
        const underEdge = (1-modelProb) - kalshiNo
        const edge      = Math.max(overEdge, underEdge)
        if (edge < MIN_EDGE) continue
        const side  = overEdge >= underEdge ? 'YES' : 'NO'
        const price = side==='YES' ? kalshiYes : kalshiNo
        const won   = side==='YES' ? game.actual_total > line : game.actual_total <= line
        const cost  = sc.betSize * price
        const pnl   = won ? sc.betSize * (1-price) : -cost
        dayPnl += pnl
        totalWagered += cost
        totalBets++
        if (won) totalWins++
      }
    }
    bankroll += dayPnl
    monthly[month].pnl += dayPnl
    monthly[month].endBR = bankroll
    if (bankroll > peak) peak = bankroll
    const dd = (peak - bankroll) / peak
    if (dd > maxDD) maxDD = dd
  }

  console.log(`\n${sc.label}`)
  console.log('─'.repeat(50))
  console.log('Month      |   P&L     |  Bankroll')
  console.log('-----------|-----------|----------')
  for (const [m, s] of Object.entries(monthly)) {
    const sign = s.pnl >= 0 ? '+' : ''
    const pnlStr = (sign + '$' + s.pnl.toFixed(0)).padStart(9)
    console.log(`${m}  | ${pnlStr} | $${String(s.endBR.toFixed(0)).padStart(8)}`)
  }
  const profit = bankroll - START
  const pct    = ((bankroll/START-1)*100).toFixed(0)
  console.log(`\n  Final:       $${bankroll.toFixed(2)}  (+$${profit.toFixed(2)} / +${pct}%)`)
  console.log(`  Win rate:    ${(totalWins/totalBets*100).toFixed(1)}% (${totalBets} bets)`)
  console.log(`  Max drawdown:${(maxDD*100).toFixed(1)}%`)
  console.log(`  Total risked:$${totalWagered.toFixed(0)}`)
}

await db.close()
