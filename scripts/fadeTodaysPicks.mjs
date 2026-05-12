// Run the IDEAL fade model on today's pitchers using captured market_snapshots
// data + MLB API for prior K rates. Shows what would have been fired and
// whether each bet would have won (for games already completed).

import 'dotenv/config'
import { createClient } from '@libsql/client'

const PAPER_BANKROLL = 5000
const SIZING_BASE_PCT = 0.01
const SIZING_EDGE_MAX = 5
const CAP_PER_BET = 200
const MIN_EDGE = 0.05
const MAX_ASK = 50
const MIN_STRIKE = 6
const NB_R = 8
const FEE = 0.07

const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })

function nbGEqN(lambda, r, n) {
  if (n <= 0) return 1
  const p = r / (r + lambda)
  let cum = Math.pow(p, r), term = cum
  for (let k = 1; k < n; k++) { term = term * (k + r - 1) / k * (1 - p); cum += term }
  return Math.max(0, Math.min(1, 1 - cum))
}
function parseIp(s) {
  if (s == null) return 0
  const [w, f] = String(s).split('.')
  return Number(w) + (Number(f || 0) / 3)
}

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
console.log(`Computing fade model picks for ${today}...\n`)

// Find every pitcher today via market_snapshots
const pitchers = await db.execute({
  sql: `SELECT DISTINCT pitcher_id, pitcher_name, game_id
        FROM market_snapshots WHERE game_date = ? AND ticker LIKE 'KXMLBKS-%'`,
  args: [today],
})

const picks = []
for (const p of pitchers.rows) {
  // Get prior K9 from MLB API
  const url = `https://statsapi.mlb.com/api/v1/people/${p.pitcher_id}/stats?stats=gameLog&season=2026&group=pitching`
  const res = await fetch(url).then(r => r.ok ? r.json() : null).catch(() => null)
  const splits = res?.stats?.[0]?.splits || []
  const games = splits.map(s => ({
    date: s.date, ks: Number(s.stat?.strikeOuts ?? 0),
    ip: parseIp(s.stat?.inningsPitched),
  })).filter(g => g.date && g.ip > 0)
  const prior = games.filter(g => g.date < today)
  if (prior.length === 0) continue
  const recent = prior.slice(-5)
  const totalK = recent.reduce((s, g) => s + g.ks, 0)
  const totalIp = recent.reduce((s, g) => s + g.ip, 0)
  if (totalIp <= 0) continue
  const k9 = totalK / totalIp * 9
  if (k9 < 4 || k9 > 18) continue
  const avgIp = totalIp / recent.length
  const lambda = k9 * avgIp / 9

  // Get pitcher's chain — use latest snapshot per strike before any settlement collapse
  const chain = await db.execute({
    sql: `SELECT ticker, strike, yes_bid, yes_ask, captured_at
          FROM market_snapshots
          WHERE pitcher_id = ? AND game_date = ?
            AND yes_bid IS NOT NULL AND yes_ask IS NOT NULL
            AND (yes_bid + yes_ask) > 2 AND (yes_bid + yes_ask) < 198
          ORDER BY captured_at DESC`,
    args: [p.pitcher_id, today],
  })
  const seen = new Map()
  for (const r of chain.rows) {
    const k = Number(r.strike)
    if (!seen.has(k)) seen.set(k, r)
  }
  if (seen.size < 4) continue

  // Find best YES candidate at strike ≥6
  let best = null
  for (const r of seen.values()) {
    const strike = Number(r.strike)
    if (strike < MIN_STRIKE) continue
    const yesAsk = Number(r.yes_ask)
    if (yesAsk > MAX_ASK || yesAsk < 3) continue
    const modelProb = nbGEqN(lambda, NB_R, strike)
    const edge = modelProb - yesAsk / 100
    if (edge < MIN_EDGE) continue
    if (!best || edge > best.edge) {
      best = { strike, yes_ask: yesAsk, yes_bid: Number(r.yes_bid), model_prob: modelProb, edge, ticker: r.ticker }
    }
  }
  if (!best) continue

  // Compute sizing
  const edgeMult = Math.min(SIZING_EDGE_MAX, 1 + (best.edge - MIN_EDGE) / MIN_EDGE)
  const stakeUsd = Math.min(CAP_PER_BET, PAPER_BANKROLL * SIZING_BASE_PCT * edgeMult)
  const contracts = Math.max(1, Math.floor(stakeUsd / (best.yes_ask / 100)))
  const stake = contracts * (best.yes_ask / 100)

  // Look up actual K (if game is settled, expirations are populated in market_snapshots actual_ks)
  const actualRow = await db.execute({
    sql: `SELECT MAX(actual_ks) AS k FROM market_snapshots
          WHERE pitcher_id = ? AND game_date = ? AND actual_ks IS NOT NULL`,
    args: [p.pitcher_id, today],
  })
  let actualK = actualRow.rows[0]?.k != null ? Number(actualRow.rows[0].k) : null

  // Fall back to MLB API for today's K count
  if (actualK == null) {
    const today_game = games.find(g => g.date === today)
    if (today_game) actualK = today_game.ks
  }

  let outcome = 'pending'
  let pnl = null
  if (actualK != null) {
    const won = actualK >= best.strike
    outcome = won ? 'WIN' : 'LOSS'
    pnl = won ? contracts * ((100 - best.yes_ask) / 100) * (1 - FEE) : -stake
  }

  picks.push({
    pitcher_name: p.pitcher_name,
    game_id: p.game_id,
    k9, lambda, n_prior: recent.length,
    strike: best.strike, ask: best.yes_ask, model_prob: best.model_prob, edge: best.edge,
    contracts, stake, edgeMult,
    actual_k: actualK, outcome, pnl,
  })
}

picks.sort((a, b) => b.edge - a.edge)

console.log('═══ Today\'s Fade Model Picks ═══\n')
console.log(`pitcher                     K≥  ask  edge   model%  size      mult  actualK  result    pnl`)
console.log('─'.repeat(105))
let totalStake = 0, totalPnl = 0, wins = 0, losses = 0, pending = 0
for (const p of picks) {
  const status = p.outcome === 'WIN' ? '✅ WIN' : p.outcome === 'LOSS' ? '❌ LOSS' : '⏳ pending'
  const pnlStr = p.pnl != null ? `${p.pnl >= 0 ? '+' : ''}$${p.pnl.toFixed(2)}` : '—'
  console.log(`  ${(p.pitcher_name ?? '?').padEnd(26)}  ${String(p.strike).padStart(2)}  ${String(p.ask).padStart(3)}¢  +${(p.edge * 100).toFixed(1).padStart(4)}¢  ${(p.model_prob * 100).toFixed(0).padStart(4)}%  $${p.stake.toFixed(0).padStart(4)}/${String(p.contracts).padStart(3)}c  ${p.edgeMult.toFixed(1)}×    ${p.actual_k != null ? String(p.actual_k).padStart(2) : '—'.padStart(2)}    ${status.padEnd(10)} ${pnlStr}`)
  totalStake += p.stake
  if (p.outcome === 'WIN') wins++
  else if (p.outcome === 'LOSS') losses++
  else pending++
  if (p.pnl != null) totalPnl += p.pnl
}

console.log()
console.log(`Picks: ${picks.length}  ·  Settled: ${wins + losses}  ·  W/L: ${wins}/${losses}  ·  Pending: ${pending}`)
if (wins + losses > 0) {
  console.log(`Win rate: ${(wins / (wins + losses) * 100).toFixed(1)}%`)
  console.log(`Total staked: $${totalStake.toFixed(2)}`)
  console.log(`Total P&L: ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`)
  console.log(`Bankroll: $${(PAPER_BANKROLL + totalPnl).toFixed(2)} (${totalPnl >= 0 ? '+' : ''}${(totalPnl / PAPER_BANKROLL * 100).toFixed(1)}%)`)
}
