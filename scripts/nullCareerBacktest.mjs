import 'dotenv/config'
import { createClient } from '@libsql/client'
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })

// Run the existing rule backtest but ALSO block when k9_career IS NULL or 0
const PITCHER_BLOCKLIST = new Set([
  'José Soriano', 'Cristopher Sánchez', 'J.T. Ginn', 'Anthony Kay', 'Matthew Boyd',
])
const SIZE_CAP_PCT = 0.04
const HIGH_CONF_THRESH = 0.65
const HIGH_CONF_HAIRCUT = 0.5
const REFERENCE_BANKROLL = 773

const all = await db.execute(`
  SELECT id, bet_date, pitcher_name, side, strike, model_prob, k9_l5, k9_career,
         capital_at_risk, pnl, result, market_mid
  FROM ks_bets
  WHERE bet_date >= date('now','-30 days') AND live_bet = 0 AND result IN ('win','loss')
    AND capital_at_risk > 0
`)
const rows = all.rows.map(r => ({
  ...r,
  capital_at_risk: Number(r.capital_at_risk),
  pnl: Number(r.pnl ?? 0),
  model_prob: Number(r.model_prob ?? 0),
  strike: Number(r.strike),
  k9_l5: Number(r.k9_l5 ?? 0),
  k9_career: r.k9_career == null ? null : Number(r.k9_career),
}))

function applyEngine(r, withNullCareerBlock = false) {
  if (PITCHER_BLOCKLIST.has(r.pitcher_name)) return { keep: false }
  if (r.side === 'YES' && (r.strike === 5 || r.strike >= 7)) return { keep: false }
  // Cold pitcher block (existing): only if career > 0
  if (r.side === 'YES' && r.k9_career != null && r.k9_career > 0 && r.k9_l5 < r.k9_career) return { keep: false }
  // NEW: null-career block
  if (withNullCareerBlock && r.side === 'YES' && (r.k9_career == null || r.k9_career === 0)) return { keep: false }
  if (r.side === 'NO' && Number(r.market_mid) > 65) return { keep: false }
  // Sizing
  let cap = r.capital_at_risk, pnl = r.pnl
  if (r.side === 'YES' && r.model_prob >= HIGH_CONF_THRESH) { cap *= HIGH_CONF_HAIRCUT; pnl *= HIGH_CONF_HAIRCUT }
  const perBetCap = SIZE_CAP_PCT * REFERENCE_BANKROLL
  if (cap > perBetCap) { const f = perBetCap / cap; cap *= f; pnl *= f }
  return { keep: true, cap, pnl }
}

let oldKeep = 0, oldPnl = 0, oldRisk = 0
let newKeep = 0, newPnl = 0, newRisk = 0
let blockedByNullCareer = 0, blockedNullCareerPnl = 0
for (const r of rows) {
  const oldR = applyEngine(r, false)
  const newR = applyEngine(r, true)
  if (oldR.keep) { oldKeep++; oldPnl += oldR.pnl; oldRisk += oldR.cap }
  if (newR.keep) { newKeep++; newPnl += newR.pnl; newRisk += newR.cap }
  if (oldR.keep && !newR.keep) {
    blockedByNullCareer++
    blockedNullCareerPnl += oldR.pnl
  }
}

console.log('30-day backtest comparison:\n')
console.log('Engine without null-career block (current deployed):')
console.log(`  ${oldKeep} bets · P&L $${oldPnl.toFixed(2)} on $${oldRisk.toFixed(2)} risk · ROI ${(oldPnl/oldRisk*100).toFixed(1)}%\n`)

console.log('Engine WITH null-career block (proposed addition):')
console.log(`  ${newKeep} bets · P&L $${newPnl.toFixed(2)} on $${newRisk.toFixed(2)} risk · ROI ${(newPnl/newRisk*100).toFixed(1)}%\n`)

console.log(`Net change:`)
console.log(`  ${blockedByNullCareer} bets removed (those with null/zero career)`)
console.log(`  Their P&L was $${blockedNullCareerPnl.toFixed(2)} (sum of what they would have produced)`)
console.log(`  Swing: ${(newPnl - oldPnl) >= 0 ? '+' : ''}$${(newPnl - oldPnl).toFixed(2)} over 30 days`)
