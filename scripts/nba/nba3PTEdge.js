// scripts/nba/nba3PTEdge.js — Find edges on Kalshi NBA 3PT markets.
//
// Model: P(player makes N+ threes) using Poisson(λ)
//   λ = adj_3PA × blended_3P%
//   adj_3PA = season_3PA
//             × opp_defense_multiplier   (how many 3s this defense allows vs league avg)
//             × recency_blend            (last-5 vs season trend)
//
// Compares model probability to Kalshi mid price → edge in cents.
//
// Usage:
//   node scripts/nba/nba3PTEdge.js [--date YYYY-MM-DD] [--min-edge 0.05]

import 'dotenv/config'
import * as db from '../../lib/db.js'
import { listMarkets } from '../../lib/kalshi.js'
import { parseArgs } from '../../lib/cli-args.js'

const opts     = parseArgs({ date: { default: new Date().toISOString().slice(0,10) }, 'min-edge': { type: 'number', default: 0.05 } })
const TODAY    = opts.date
const MIN_EDGE = opts['min-edge']

await db.migrate()

// ── Poisson helpers ──────────────────────────────────────────────────────────

function poissonPMF(k, lambda) {
  if (lambda <= 0) return k === 0 ? 1 : 0
  let logP = -lambda + k * Math.log(lambda)
  for (let i = 1; i <= k; i++) logP -= Math.log(i)
  return Math.exp(logP)
}

function poissonCDF(n, lambda) {
  let sum = 0
  for (let k = 0; k <= n; k++) sum += poissonPMF(k, lambda)
  return Math.min(sum, 1)
}

function pAtLeast(n, lambda) {
  return 1 - poissonCDF(n - 1, lambda)
}

// ── Load DB stats ─────────────────────────────────────────────────────────────

const seasonStats = await db.all(
  `SELECT * FROM nba_player_3pt_stats WHERE stat_date = ? AND window = 'season'`, [TODAY]
)
const last5Stats = await db.all(
  `SELECT * FROM nba_player_3pt_stats WHERE stat_date = ? AND window = 'last5'`, [TODAY]
)
const oppDefense = await db.all(
  `SELECT * FROM nba_opp_3pt_defense WHERE stat_date = ?`, [TODAY]
)

if (!seasonStats.length) {
  console.log('[3pt-edge] No player stats found for today. Run fetchNBA3PTStats.js first.')
  process.exit(0)
}

// Index by player_id and name
const seasonByName = {}
const last5ByName  = {}
for (const r of seasonStats) seasonByName[r.player_name.toLowerCase()] = r
for (const r of last5Stats)  last5ByName[r.player_name.toLowerCase()]  = r

const oppByTeam = {}
for (const r of oppDefense) oppByTeam[r.team_id] = r

// League avg 3PA allowed (to normalize opponent defense)
const leagueAvg3PA = oppDefense.length
  ? oppDefense.reduce((s,r) => s + (r.opp_fg3a_pg || 0), 0) / oppDefense.length
  : 35.0

// ── Fetch today's Kalshi 3PT markets ─────────────────────────────────────────

const res = await listMarkets({ seriesTicker: 'KXNBA3PT', status: 'open', limit: 200 })
const allMarkets = res?.markets || []

// Filter to today's games only
const dateCode = (() => {
  const d = new Date(TODAY + 'T12:00:00Z')
  const yy  = String(d.getUTCFullYear()).slice(-2)
  const mmm = d.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' }).toUpperCase()
  const dd  = String(d.getUTCDate()).padStart(2, '0')
  return `${yy}${mmm}${dd}`
})()

const todayMarkets = allMarkets.filter(m => m.event_ticker?.includes(dateCode))

if (!todayMarkets.length) {
  console.log(`[3pt-edge] No 3PT markets found for ${TODAY} (code ${dateCode}).`)
  await db.close()
  process.exit(0)
}

// Group markets by player code
const byPlayer = {}
for (const m of todayMarkets) {
  const parts     = m.ticker.split('-')
  const playerCode = parts[2]
  const threshold  = Number(parts[3])
  const playerName = (m.title || '').split(':')[0].trim()
  // Infer defending team: game is AWAY@HOME, player is on one team
  // Event ticker: KXNBA3PT-26APR22ORLDET → game code ORLDET
  const gameCode  = parts[1].slice(4)  // strip date prefix e.g. '26APR22' → 'ORLDET'
  const awayCode  = gameCode.slice(0, 3)
  const homeCode  = gameCode.slice(3)
  const playerTeam = playerCode.slice(0, 3)
  const defTeam    = playerTeam === awayCode ? homeCode : awayCode

  if (!byPlayer[playerCode]) byPlayer[playerCode] = { playerName, playerTeam, defTeam, markets: [] }
  const yesMid = m.yes_ask_dollars && m.yes_bid_dollars
    ? (parseFloat(m.yes_ask_dollars) + parseFloat(m.yes_bid_dollars)) / 2 * 100
    : null
  const noMid  = m.no_ask_dollars && m.no_bid_dollars
    ? (parseFloat(m.no_ask_dollars)  + parseFloat(m.no_bid_dollars))  / 2 * 100
    : null
  const spread = m.yes_ask_dollars && m.yes_bid_dollars
    ? (parseFloat(m.yes_ask_dollars) - parseFloat(m.yes_bid_dollars)) * 100
    : null
  const vol = parseFloat(m.volume_fp || 0)
  const oi  = parseFloat(m.open_interest_fp || 0)

  if (yesMid != null) byPlayer[playerCode].markets.push({ threshold, yesMid, noMid, spread, vol, oi })
}

// ── Compute edges ─────────────────────────────────────────────────────────────

const edges = []
let playersProcessed = 0

for (const [code, info] of Object.entries(byPlayer)) {
  const nameLower = info.playerName.toLowerCase()
  const season    = seasonByName[nameLower]
  const last5     = last5ByName[nameLower]

  if (!season || !season.fg3a_pg || season.fg3a_pg < 0.5) continue  // skip non-shooters

  const opp = oppByTeam[info.defTeam]

  // Opponent defense multiplier (how much this defense inflates/deflates 3PA)
  const oppMult = opp?.opp_fg3a_pg ? opp.opp_fg3a_pg / leagueAvg3PA : 1.0

  // Recency blend: weight last-5 at 40% if available and meaningful
  const hasLast5 = last5?.fg3a_pg != null && (last5.gp || 0) >= 2
  const adj3PA   = hasLast5
    ? season.fg3a_pg * 0.6 + last5.fg3a_pg * 0.4
    : season.fg3a_pg

  // Shooting % blend
  const adj3Pct  = hasLast5 && last5.fg3_pct != null
    ? (season.fg3_pct || 0.35) * 0.7 + last5.fg3_pct * 0.3
    : (season.fg3_pct || 0.35)

  // Adjusted lambda (expected 3PT makes)
  const lambda = adj3PA * oppMult * adj3Pct

  playersProcessed++

  for (const mkt of info.markets.sort((a,b) => a.threshold - b.threshold)) {
    const { threshold, yesMid, noMid, spread, vol, oi } = mkt
    if (vol < 50) continue  // skip illiquid lines

    const modelProb  = pAtLeast(threshold, lambda)
    const kalshiProb = yesMid / 100
    const edgeYes    = modelProb - kalshiProb
    const edgeNo     = (1 - modelProb) - (noMid / 100)
    const edge       = Math.max(edgeYes, edgeNo)

    if (Math.abs(edge) < MIN_EDGE) continue

    const side = edgeYes >= edgeNo ? 'YES' : 'NO'
    edges.push({
      player:      info.playerName,
      team:        info.playerTeam,
      defTeam:     info.defTeam,
      threshold,
      side,
      edge:        Math.abs(edge),
      edgeYes,
      edgeNo,
      modelProb,
      kalshiProb,
      yesMid,
      noMid,
      spread,
      vol,
      oi,
      lambda:      Math.round(lambda * 100) / 100,
      adj3PA:      Math.round(adj3PA * oppMult * 100) / 100,
      adj3Pct:     Math.round(adj3Pct * 1000) / 1000,
      oppMult:     Math.round(oppMult * 100) / 100,
      last5_3PA:   last5?.fg3a_pg ?? null,
      season_3PA:  season.fg3a_pg,
      ticker:      `KXNBA3PT-${dateCode}${info.playerTeam}${info.defTeam.slice(0,3)}-...`, // approx
    })
  }
}

// ── Output ────────────────────────────────────────────────────────────────────

const sorted = edges.sort((a,b) => b.edge - a.edge)

console.log(`[3pt-edge] ${TODAY} | ${playersProcessed} players | league avg 3PA allowed: ${leagueAvg3PA.toFixed(1)}\n`)

if (!sorted.length) {
  console.log('[3pt-edge] No edges found.')
  await db.close()
  process.exit(0)
}

console.log('Player'.padEnd(22) + 'Line  Side  Edge   Model  Kalshi  Spread  Vol     OI      λ    opp×  l5_3PA  s_3PA  3P%')
console.log('─'.repeat(130))

for (const e of sorted) {
  const flag = e.edge >= 0.08 ? ' ← STRONG' : e.edge >= 0.06 ? ' ←' : ''
  console.log(
    e.player.padEnd(22) +
    String(e.threshold + '+').padEnd(6) +
    e.side.padEnd(6) +
    (e.edge * 100).toFixed(1).padStart(5) + '¢  ' +
    (e.modelProb * 100).toFixed(1).padStart(5) + '%  ' +
    (e.kalshiProb * 100).toFixed(1).padStart(5) + '¢  ' +
    (e.spread ?? 0).toFixed(0).padStart(4) + '¢  ' +
    String(Math.round(e.vol)).padStart(6) + '  ' +
    String(Math.round(e.oi)).padStart(6) + '  ' +
    String(e.lambda).padStart(4) + '  ' +
    String(e.oppMult).padStart(4) + '×  ' +
    (e.last5_3PA != null ? e.last5_3PA.toFixed(1) : ' — ').padStart(6) + '  ' +
    e.season_3PA.toFixed(1).padStart(5) + '  ' +
    (e.adj3Pct * 100).toFixed(0) + '%' +
    flag
  )
}

console.log(`\n[3pt-edge] ${sorted.length} edges found (min ${(MIN_EDGE*100).toFixed(0)}¢)`)

// Output JSON for consumption by nbaBets.js
if (process.stdout.isTTY === false || process.env.JSON_OUTPUT) {
  process.stdout.write('\n__EDGES_JSON__\n' + JSON.stringify(sorted) + '\n')
}

await db.close()
