// Settle yesterday's cross-strike POC predictions by pulling actual_ks from
// MLB Stats API boxscores. Independent of our internal settlement path.

import 'dotenv/config'
import { createClient } from '@libsql/client'
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })

const DATE = '2026-05-05'
const FEE_FRACTION = 0.07

async function fetchPitcherKs(date) {
  // 1. Get all gamePks for the date
  const schedRes = await fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}`)
  const schedData = await schedRes.json()
  const gamePks = []
  for (const day of schedData.dates ?? []) {
    for (const g of day.games ?? []) {
      if (g.status?.abstractGameState === 'Final') gamePks.push(g.gamePk)
    }
  }
  console.log(`  Found ${gamePks.length} final games on ${date}`)

  // 2. Fetch boxscore per game (parallel)
  const boxscores = await Promise.all(gamePks.map(async pk => {
    const r = await fetch(`https://statsapi.mlb.com/api/v1/game/${pk}/boxscore`).catch(() => null)
    return r?.ok ? await r.json() : null
  }))

  // 3. Extract pitcher → Ks mapping
  const pitcherKs = new Map()
  for (const bs of boxscores) {
    if (!bs) continue
    for (const teamSide of ['home', 'away']) {
      const players = bs.teams?.[teamSide]?.players ?? {}
      for (const playerKey of Object.keys(players)) {
        const p = players[playerKey]
        const pos = p.position?.code ?? p.position?.abbreviation
        const ks = p.stats?.pitching?.strikeOuts
        const ipRaw = p.stats?.pitching?.inningsPitched
        if (ks == null || ipRaw == null) continue
        const ip = parseFloat(ipRaw)
        if (ip <= 0) continue
        const name = p.person?.fullName
        if (!name) continue
        const existing = pitcherKs.get(name)
        if (!existing || ip > existing.ip) {
          pitcherKs.set(name, { ks, ip })
        }
      }
    }
  }
  return pitcherKs
}

const pitcherKs = await fetchPitcherKs(DATE)
console.log(`Fetched ${pitcherKs.size} pitchers from MLB API for ${DATE}`)

const poc = await db.execute({
  sql: `SELECT id, pitcher_name, strike, side, residual, ask_cents, fit_lambda, engine_lambda
        FROM crossstrike_poc_predictions WHERE bet_date = ? ORDER BY pitcher_name, strike`,
  args: [DATE],
})

console.log(`POC predictions: ${poc.rows.length}\n`)
let settled = 0, wins = 0, losses = 0, totalPnl = 0, totalRiskPerBet = 0
const detail = []

for (const p of poc.rows) {
  const found = pitcherKs.get(p.pitcher_name)
  if (!found) {
    console.log(`  ⏳ ${p.pitcher_name.padEnd(22)} K${p.strike} ${p.side}  → DID NOT PITCH on ${DATE}`)
    continue
  }
  const actualKs = found.ks
  const won = p.side === 'YES' ? actualKs >= p.strike : actualKs < p.strike
  const askPrice = Number(p.ask_cents) / 100
  if (askPrice <= 0 || askPrice >= 1) continue

  const grossProfit = won ? (1 - askPrice) / askPrice : -1
  const fee = won ? FEE_FRACTION * Math.min(askPrice, 1 - askPrice) : 0
  const pnl = grossProfit - (won ? fee : 0)

  settled++
  if (won) wins++; else losses++
  totalPnl += pnl
  totalRiskPerBet += 1

  await db.execute({
    sql: `UPDATE crossstrike_poc_predictions SET actual_ks=?, won=?, pnl=?, settled_at=? WHERE id=?`,
    args: [actualKs, won ? 1 : 0, pnl, new Date().toISOString(), p.id],
  }).catch(() => {})

  const pnlStr = pnl >= 0 ? '+$' + pnl.toFixed(3) : '-$' + Math.abs(pnl).toFixed(3)
  const sign = Number(p.residual) >= 0 ? '+' : ''
  detail.push({
    won, pnl,
    line: `  ${won ? '✓' : '✗'} ${p.pitcher_name.padEnd(22)} K${p.strike} ${p.side.padEnd(3)} resid=${sign}${Number(p.residual).toFixed(3)} ask=${p.ask_cents}¢ → K=${actualKs} (${found.ip} IP) ${pnlStr}`,
  })
}

console.log(detail.map(d => d.line).join('\n'))

console.log('\n══════════════════════════════════════════════════════════════════')
console.log('  POC SETTLEMENT RESULTS')
console.log('══════════════════════════════════════════════════════════════════')
console.log(`  Settled: ${settled} of ${poc.rows.length}`)
if (settled > 0) {
  const winRate = (wins / settled * 100).toFixed(1)
  console.log(`  Wins: ${wins}, Losses: ${losses}`)
  console.log(`  Win rate: ${winRate}%`)
  console.log(`  P&L (per $1 normalized bet): ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`)
  console.log(`  ROI per fire: ${(totalPnl / settled * 100).toFixed(1)}%`)
  console.log(`\n  Verdict:`)
  if (winRate >= 60) console.log(`  ✓ STRONG SIGNAL — commit to building Strategy B`)
  else if (winRate >= 40) console.log(`  ⚠ AMBIGUOUS — collect 7 more days before deciding`)
  else console.log(`  ✗ POC DID NOT VALIDATE — save the build time`)
}
