import 'dotenv/config'
import * as db from '../../lib/db.js'

// Load settled pre-game bets with component probabilities and actual outcomes
// We need: model_prob (final blended), raw_model_prob, and ideally the components
// Since we store model_prob but not components, we use it as-is and look at
// whether different edge thresholds or shrinkage factors improve calibration.

async function main() {
  await db.migrate()

  const bets = await db.all(
    `SELECT model_prob, raw_model_prob, result, edge, strike, side,
            k9_career, k9_season, k9_l5, n_starts, lambda
     FROM ks_bets
     WHERE result NOT IN ('void') AND result IS NOT NULL
       AND live_bet = 0 AND model_prob IS NOT NULL
     ORDER BY bet_date ASC`,
  )

  if (bets.length < 30) {
    console.log(`Only ${bets.length} settled bets — need at least 30 for calibration`)
    await db.close()
    return
  }

  console.log(`\nCalibration analysis on ${bets.length} settled pre-game bets\n`)

  // ── 1. Calibration by probability bucket ──
  const buckets = [
    { lo: 0.50, hi: 0.55, label: '50-55%' },
    { lo: 0.55, hi: 0.60, label: '55-60%' },
    { lo: 0.60, hi: 0.65, label: '60-65%' },
    { lo: 0.65, hi: 0.70, label: '65-70%' },
    { lo: 0.70, hi: 0.75, label: '70-75%' },
    { lo: 0.75, hi: 0.80, label: '75-80%' },
    { lo: 0.80, hi: 1.01, label: '80%+'  },
  ]

  console.log('Calibration by model probability bucket:')
  console.log(`${'Bucket'.padEnd(10)} ${'N'.padStart(5)} ${'WinRate'.padStart(9)} ${'Expected'.padStart(10)} ${'Error'.padStart(8)} ${'Brier'.padStart(8)}`)
  console.log('-'.repeat(54))

  let totalBrier = 0, totalN = 0
  for (const b of buckets) {
    const inBucket = bets.filter(x => x.model_prob >= b.lo && x.model_prob < b.hi)
    if (!inBucket.length) continue
    const wins = inBucket.filter(x => x.result === 'win').length
    const winRate = wins / inBucket.length
    const expected = (b.lo + Math.min(b.hi, 1.0)) / 2
    const error = winRate - expected
    const brier = inBucket.reduce((s, x) => s + (x.result === 'win' ? 1 : 0) * Math.pow(1 - x.model_prob, 2) + (x.result === 'loss' ? 1 : 0) * Math.pow(x.model_prob, 2), 0) / inBucket.length
    totalBrier += brier * inBucket.length
    totalN += inBucket.length
    const errStr = (error >= 0 ? '+' : '') + (error * 100).toFixed(1) + '%'
    console.log(`${b.label.padEnd(10)} ${String(inBucket.length).padStart(5)} ${(winRate*100).toFixed(1).padStart(8)}% ${(expected*100).toFixed(1).padStart(9)}% ${errStr.padStart(8)} ${brier.toFixed(3).padStart(8)}`)
  }
  console.log('-'.repeat(54))
  console.log(`${'TOTAL'.padEnd(10)} ${String(totalN).padStart(5)}` + ' '.repeat(19) + `Overall Brier: ${(totalBrier/totalN).toFixed(4)}`)

  // ── 2. Calibration by bet mode ──
  console.log('\nWin rate by bet mode:')
  const byMode = {}
  for (const b of bets) {
    const m = b.bet_mode || 'normal'
    if (!byMode[m]) byMode[m] = { wins: 0, total: 0 }
    byMode[m].total++
    if (b.result === 'win') byMode[m].wins++
  }
  for (const [mode, s] of Object.entries(byMode)) {
    console.log(`  ${mode.padEnd(15)} ${s.wins}W/${s.total} (${(s.wins/s.total*100).toFixed(1)}%)`)
  }

  // ── 3. Win rate by side ──
  console.log('\nWin rate by side:')
  for (const side of ['YES', 'NO']) {
    const s = bets.filter(b => b.side === side)
    const wins = s.filter(b => b.result === 'win').length
    if (!s.length) continue
    console.log(`  ${side}: ${wins}W/${s.length} (${(wins/s.length*100).toFixed(1)}%)`)
  }

  // ── 4. Win rate by strike threshold ──
  console.log('\nWin rate by strike threshold:')
  const byStrike = {}
  for (const b of bets) {
    if (!byStrike[b.strike]) byStrike[b.strike] = { wins: 0, total: 0 }
    byStrike[b.strike].total++
    if (b.result === 'win') byStrike[b.strike].wins++
  }
  for (const strike of Object.keys(byStrike).sort((a,b) => Number(a)-Number(b))) {
    const s = byStrike[strike]
    console.log(`  ${strike}+: ${s.wins}W/${s.total} (${(s.wins/s.total*100).toFixed(1)}%)`)
  }

  // ── 5. Blend weight grid search ──
  // We have k9_career, k9_season, k9_l5 fields — use them to simulate different blends
  // and compute which blend would have produced better-calibrated model_probs.
  // NOTE: this is an approximation since we don't have the full model pipeline here.
  // We estimate: if actual win rate in 60-65% bucket is 52%, model is overconfident by ~8%.
  // Recommendation based on calibration error direction.
  console.log('\nCalibration diagnosis:')
  const overconfident = []
  const underconfident = []
  for (const b of buckets) {
    const inBucket = bets.filter(x => x.model_prob >= b.lo && x.model_prob < b.hi)
    if (inBucket.length < 5) continue
    const wins = inBucket.filter(x => x.result === 'win').length
    const winRate = wins / inBucket.length
    const expected = (b.lo + Math.min(b.hi, 1.0)) / 2
    if (winRate < expected - 0.05) overconfident.push(b.label)
    if (winRate > expected + 0.05) underconfident.push(b.label)
  }
  if (overconfident.length) console.log(`  ⚠ OVERCONFIDENT (winning less than predicted): ${overconfident.join(', ')}`)
  if (underconfident.length) console.log(`  ⚠ UNDERCONFIDENT (winning more than predicted): ${underconfident.join(', ')}`)
  if (!overconfident.length && !underconfident.length) console.log('  ✓ Model appears well-calibrated across buckets')

  console.log('\nRecommendation: Run this report weekly. Adjust SHRINK_TOWARD_MEAN in strikeoutEdge.js')
  console.log('if systematic over/under-confidence emerges. Need 100+ bets per bucket for significance.')

  await db.close()
}

main().catch(err => { console.error(err.message); process.exit(1) })
