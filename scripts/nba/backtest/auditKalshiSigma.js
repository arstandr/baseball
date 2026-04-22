// scripts/nba/backtest/auditKalshiSigma.js
// Pulls live Kalshi prices for today's NBA total markets and measures
// what σ Kalshi is implicitly using. Compares to our fitted σ=18.1.

import 'dotenv/config'
import * as db from '../../../lib/db.js'
import { getNBATotalMarkets } from '../../../lib/kalshi.js'
import * as odds from '../../../lib/odds.js'

await db.migrate()

function normalCDF(z) {
  const t = 1/(1+0.2316419*Math.abs(z))
  const d = 0.3989423*Math.exp(-z*z/2)
  const p = d*t*(0.3193815+t*(-0.3565638+t*(1.7814779+t*(-1.8212560+t*1.3302744))))
  return z>0?1-p:p
}
function pOver(line, mu, sigma) { return 1 - normalCDF((line - mu) / sigma) }

// Binary search: find σ such that pOver(line, mu, σ) = targetProb
function solveForSigma(line, mu, targetProb) {
  let lo = 1, hi = 60
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    if (pOver(line, mu, mid) > targetProb) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

const TODAY = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
const games = await db.all(`SELECT * FROM nba_games WHERE game_date = ? AND status != 'final'`, [TODAY])

if (!games.length) {
  console.log('No NBA games found for today. Run fetchNBASchedule.js first.')
  process.exit(0)
}

// Get Vegas lines
const nbaOddsResult = await odds.fetchNBALines()
const matched = odds.matchNBAOddsToGames(nbaOddsResult.games || [], games)

console.log('══════════════════════════════════════════════════')
console.log(` Kalshi σ Audit — ${TODAY}`)
console.log(' True σ (fitted from 2024-25 season): 18.1 pts')
console.log('══════════════════════════════════════════════════\n')

const sigmaReadings = []

for (const game of games) {
  const vegasLine = matched.get(game.id)?.total_line
  const away = game.team_away, home = game.team_home

  console.log(`── ${away}@${home}  (Vegas: ${vegasLine ?? 'N/A'}) ──`)

  let markets
  try {
    markets = await getNBATotalMarkets(away, home, TODAY)
  } catch (err) {
    console.log(`  Error fetching markets: ${err.message}`)
    continue
  }

  if (!markets?.length) { console.log('  No markets found\n'); continue }

  if (!vegasLine) { console.log('  No Vegas line — skipping σ calc\n'); continue }

  console.log(`  ${'Line'.padEnd(8)} ${'Kalshi YES'.padEnd(12)} ${'Kalshi NO'.padEnd(12)} ${'Model(18.1)'.padEnd(12)} ${'Edge(YES)'.padEnd(10)} ${'Edge(NO)'.padEnd(10)} Implied σ`)
  console.log(`  ${'─'.repeat(86)}`)

  for (const m of markets.sort((a,b) => a.line - b.line)) {
    const line       = m.line
    // Use mid price (avg of bid/ask) in cents → convert to 0-1
    const yesMid = m.yes_ask != null && m.yes_bid != null ? (m.yes_ask + m.yes_bid) / 2
                 : m.yes_ask ?? m.yes_bid ?? null
    const noMid  = m.no_ask  != null && m.no_bid  != null ? (m.no_ask  + m.no_bid)  / 2
                 : m.no_ask  ?? m.no_bid  ?? null
    if (yesMid == null || noMid == null) continue
    const kalshiYes  = yesMid / 100
    const kalshiNo   = noMid  / 100
    const modelProb  = pOver(line, vegasLine, 18.1)
    const edgeYes    = modelProb - kalshiYes
    const edgeNo     = (1 - modelProb) - kalshiNo

    // Implied σ from mid price (average of YES bid/ask)
    const impliedSig = solveForSigma(line, vegasLine, kalshiYes)
    sigmaReadings.push({ game: `${away}@${home}`, line, vegasLine, kalshiYes, modelProb, impliedSig })

    const flag = Math.abs(edgeYes) >= 0.05 || Math.abs(edgeNo) >= 0.05 ? ' ←' : ''
    const oi   = m.open_interest != null ? ` OI=${m.open_interest}` : ''
    console.log(
      `  ${String(line).padEnd(8)} ` +
      `${yesMid.toFixed(0).padStart(4)}¢        ` +
      `${noMid.toFixed(0).padStart(4)}¢        ` +
      `${(modelProb*100).toFixed(1).padStart(5)}%       ` +
      `${(edgeYes >= 0 ? '+' : '') + (edgeYes*100).toFixed(1)}¢      `.padEnd(10) +
      `${(edgeNo  >= 0 ? '+' : '') + (edgeNo *100).toFixed(1)}¢      `.padEnd(10) +
      `σ=${impliedSig.toFixed(1)}${oi}${flag}`
    )
  }
  console.log()
}

// Summary
if (sigmaReadings.length) {
  const avgSig = sigmaReadings.reduce((s,r) => s + r.impliedSig, 0) / sigmaReadings.length
  const medSig = [...sigmaReadings].sort((a,b) => a.impliedSig - b.impliedSig)[Math.floor(sigmaReadings.length/2)]?.impliedSig
  const edges  = sigmaReadings.map(r => r.modelProb - r.kalshiYes)
  const avgEdge = edges.reduce((s,e) => s + e, 0) / edges.length

  console.log('══════════════════════════════════════════════════')
  console.log(' Summary')
  console.log('══════════════════════════════════════════════════')
  console.log(`  Data points:      ${sigmaReadings.length} Kalshi markets`)
  console.log(`  Avg implied σ:    ${avgSig.toFixed(1)} pts`)
  console.log(`  Median implied σ: ${medSig.toFixed(1)} pts`)
  console.log(`  True σ (fitted):  18.1 pts`)
  console.log(`  Avg edge (YES):   ${(avgEdge*100).toFixed(1)}¢`)
  console.log()
  if (avgSig < 15) {
    console.log('  ✓ Kalshi IS using tighter tails than reality → edge exists')
    console.log(`  → σ_market to use in backtestTotals.js: ${avgSig.toFixed(1)}`)
  } else if (avgSig > 17) {
    console.log('  ✗ Kalshi is pricing close to true σ → little or no systematic edge')
  } else {
    console.log(`  ~ Marginal gap: Kalshi σ≈${avgSig.toFixed(1)} vs true 18.1 — small edge possible`)
  }
}

await db.close()
