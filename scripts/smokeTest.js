// scripts/smokeTest.js
// Smoke-tests the new Kelly sizing system against this week's raw model data.
// Read-only — touches no DB rows.
//
// Usage: node scripts/smokeTest.js [--date YYYY-MM-DD]

import 'dotenv/config'
import * as db from '../lib/db.js'
import { kellySizing, correlatedKellyDivide, opportunityDiscount } from '../lib/kelly.js'

const BANKROLL        = 1237   // ~current live balance (use actual or env override)
const PREGAME_PCT     = 0.60
const PREGAME_POOL    = BANKROLL * PREGAME_PCT
const PER_PITCHER_CAP = PREGAME_POOL * 0.10

// Protection rules (mirrors logEdges guards)
const YES_MIN_PROB    = 0.25
const MIN_EDGE        = 0.10

function applyRules(e) {
  if (e.side === 'NO' && (e.market_mid ?? 50) >= 65 && e.model_prob >= 0.50) return false  // Rule A
  if (e.side === 'YES' && e.model_prob < YES_MIN_PROB && (e.edge ?? 0) < 0.18) return false // Rule D
  if (e.side === 'NO' && (e.market_mid ?? 50) < 15) return false                             // Rule E
  if (e.side === 'NO' && e.strike <= 4) return false                                          // Rule F
  return true
}

async function simulateDay(date, pendingGames) {
  // Pull raw model edges from ks_bets — baseball only (excludes NBA bets via model filter)
  const rawEdges = await db.all(
    `SELECT DISTINCT pitcher_id, pitcher_name, team, game, strike, side,
            model_prob, market_mid, edge, kelly_fraction, capital_at_risk
     FROM ks_bets
     WHERE bet_date=? AND live_bet=0 AND (model IS NULL OR model='mlb_strikeouts')
     ORDER BY pitcher_name, strike`,
    [date],
  )

  if (!rawEdges.length) {
    console.log(`\n${date}: No model data available`)
    return null
  }

  // Apply fill price: YES fill = market_mid/100, NO fill = (100-market_mid)/100
  const withFill = rawEdges.map(e => ({
    ...e,
    _fill: e.side === 'YES' ? e.market_mid / 100 : (100 - e.market_mid) / 100,
  }))

  // Dedup: best edge per pitcher+strike key
  const bestByKey = new Map()
  for (const e of withFill) {
    const key = `${e.pitcher_id}|${e.strike}|${e.side}`
    if (!bestByKey.has(key) || e.edge > bestByKey.get(key).edge) bestByKey.set(key, e)
  }

  // Apply protection rules
  const guardedEdges = [...bestByKey.values()].filter(applyRules)

  // Opportunity discount
  const discount         = opportunityDiscount(pendingGames)
  const effectiveBankroll = PREGAME_POOL * discount

  // Group by pitcher, run correlated Kelly
  const edgesByPitcher = new Map()
  for (const e of guardedEdges) {
    const key = String(e.pitcher_id || e.pitcher_name)
    if (!edgesByPitcher.has(key)) edgesByPitcher.set(key, [])
    edgesByPitcher.get(key).push(e)
  }

  let totalRisk = 0
  let totalBets = 0
  const pitcherResults = []

  for (const [, pitcherEdges] of edgesByPitcher) {
    const kellyInputs = pitcherEdges.map(e => ({
      modelProb:   e.model_prob,
      marketPrice: e.market_mid / 100,
      side:        e.side,
    }))
    const kellyResults = correlatedKellyDivide(kellyInputs, false, effectiveBankroll)

    const pitcherTotal = kellyResults.reduce((s, k) => s + (k?.betSize || 0), 0)
    const capScale     = pitcherTotal > PER_PITCHER_CAP ? PER_PITCHER_CAP / pitcherTotal : 1.0

    const bets = []
    for (let i = 0; i < pitcherEdges.length; i++) {
      const e = pitcherEdges[i]
      const k = kellyResults[i]
      if (!k || k.betSize <= 0) continue
      const betDollars = k.betSize * capScale
      if (betDollars < 0.01) continue
      const face      = Math.max(1, Math.round(betDollars / e._fill))
      const actualRisk = face * e._fill
      bets.push({
        strike: e.strike, side: e.side,
        edge: e.edge, model_prob: e.model_prob, market_mid: e.market_mid,
        betDollars, face, actualRisk,
        kellyFraction: k.kellyFraction * capScale,
        fullKelly: k.fullKelly,
        rationale: k.rationale,
      })
      totalRisk += actualRisk
      totalBets++
    }

    if (bets.length) {
      pitcherResults.push({
        name: pitcherEdges[0].pitcher_name,
        capScale,
        bets,
        pitcherTotal: bets.reduce((s, b) => s + b.actualRisk, 0),
      })
    }
  }

  // Portfolio-level cap: total cannot exceed the pre-game pool
  const rawPortfolioRisk = pitcherResults.reduce((s, p) => s + p.pitcherTotal, 0)
  let portfolioScale = 1.0
  if (rawPortfolioRisk > PREGAME_POOL) {
    portfolioScale = PREGAME_POOL / rawPortfolioRisk
    for (const p of pitcherResults) {
      for (const b of p.bets) {
        b.betDollars  *= portfolioScale
        b.face         = Math.max(1, Math.round(b.betDollars / (b.market_mid / 100)))
        b.actualRisk  *= portfolioScale
        b.kellyFraction *= portfolioScale
      }
      p.pitcherTotal *= portfolioScale
    }
  }

  pitcherResults.sort((a, b) => b.pitcherTotal - a.pitcherTotal)

  const finalRisk = pitcherResults.reduce((s, p) => s + p.pitcherTotal, 0)
  const finalBets = pitcherResults.reduce((s, p) => s + p.bets.length, 0)
  return { date, guardedEdges: guardedEdges.length, discount, effectiveBankroll, totalRisk: finalRisk, totalBets: finalBets, portfolioScale, pitcherResults }
}

async function main() {
  await db.migrate()

  const BANKROLL_FMT = `$${BANKROLL.toFixed(0)}`
  const days = [
    { date: '2026-04-21', pending: 15 },
    { date: '2026-04-22', pending: 8  },
    { date: '2026-04-23', pending: 9  },
    { date: '2026-04-24', pending: 7  },
    { date: '2026-04-25', pending: 14 },
    { date: '2026-04-26', pending: 16 },
  ]

  console.log(`\n${'='.repeat(80)}`)
  console.log(` KELLY SIZING SMOKE TEST — Bankroll ${BANKROLL_FMT} · Pre-game pool $${PREGAME_POOL.toFixed(0)} (60%)`)
  console.log(` Per-pitcher hard cap: $${PER_PITCHER_CAP.toFixed(0)} (10% of pre-game pool)`)
  console.log('='.repeat(80))

  let grandTotalRisk = 0
  let grandTotalBets = 0

  for (const { date, pending } of days) {
    const result = await simulateDay(date, pending)
    if (!result) continue

    const { guardedEdges, discount, effectiveBankroll, totalRisk, totalBets, portfolioScale, pitcherResults } = result
    grandTotalRisk += totalRisk
    grandTotalBets += totalBets

    const scaleNote = portfolioScale < 1.0 ? ` [portfolio scale ×${portfolioScale.toFixed(3)}]` : ''
    console.log(`\n┌─ ${date} ─────────────────────────────────────────────────────────────`)
    console.log(`│  Edges: ${guardedEdges} after filters · Pending games: ${pending} → discount ${discount.toFixed(2)}x → effective bankroll $${effectiveBankroll.toFixed(0)}`)
    console.log(`│  Total bets: ${totalBets} · Total risk: $${totalRisk.toFixed(2)} (${((totalRisk/PREGAME_POOL)*100).toFixed(1)}% of pre-game pool)${scaleNote}`)
    console.log('│')

    for (const p of pitcherResults) {
      const capNote = p.capScale < 1.0 ? ` [per-pitcher capped ×${p.capScale.toFixed(2)}]` : ''
      console.log(`│  ${p.name.padEnd(30)} total: $${p.pitcherTotal.toFixed(2)}${capNote}`)
      for (const b of p.bets) {
        const kelly_pct = (b.kellyFraction * 100).toFixed(2)
        const full_pct  = (b.fullKelly * 100).toFixed(2)
        console.log(`│    ${b.strike}+${b.side.padEnd(4)} edge=${b.edge?.toFixed(3)} mkt=${String(b.market_mid).padEnd(5)} mp=${b.model_prob?.toFixed(3)} │ Kelly: full=${full_pct}% → sized=${kelly_pct}% → $${b.betDollars.toFixed(2)} → ${b.face} contracts @ $${b.actualRisk.toFixed(2)} risk`)
      }
    }
    console.log('└' + '─'.repeat(79))
  }

  console.log(`\n${'='.repeat(80)}`)
  console.log(` WEEK TOTAL: ${grandTotalBets} bets · $${grandTotalRisk.toFixed(2)} deployed`)
  console.log(` Pre-game pool: $${PREGAME_POOL.toFixed(0)} · Max possible deploy: $${(PREGAME_POOL * 6).toFixed(0)} (6 days)`)
  console.log('='.repeat(80))

  await db.close()
}

main().catch(err => {
  console.error('smoke test fatal:', err.message)
  process.exit(1)
})
