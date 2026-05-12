import { generateCrossStrikeCandidates } from '../lib/crossStrikeCandidates.js'
// Synthetic Bryce Elder yesterday: K7 at 20¢, K8 at 12¢, etc.
const markets = [
  { strike: 4, ticker: 'X', yes_bid: 88, yes_ask: 92, market_mid: 90 },
  { strike: 5, ticker: 'X', yes_bid: 75, yes_ask: 79, market_mid: 77 },
  { strike: 6, ticker: 'X', yes_bid: 50, yes_ask: 54, market_mid: 52 },
  { strike: 7, ticker: 'X', yes_bid: 18, yes_ask: 22, market_mid: 20 },
  { strike: 8, ticker: 'X', yes_bid: 10, yes_ask: 14, market_mid: 12 },
  { strike: 9, ticker: 'X', yes_bid: 4,  yes_ask: 8,  market_mid: 6 },
]
const cands = generateCrossStrikeCandidates(markets)
console.log(`Found ${cands.length} candidates from synthetic Bryce Elder profile:`)
for (const c of cands) {
  console.log(`  K${c.strike} ${c.side} resid=${c.cross_strike_residual.toFixed(3)} ask=${c.ask_cents}¢ fit_λ=${c.cross_strike_fit_lambda.toFixed(2)} quality=${c.cross_strike_fit_quality}`)
}
