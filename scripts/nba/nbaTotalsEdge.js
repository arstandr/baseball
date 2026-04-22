// scripts/nba/nbaTotalsEdge.js — NBA game totals edge finder.
//
// PRIMARY SIGNAL: Vegas consensus line (The Odds API — DK/FD/MGM).
//   Vegas sharp money is our best estimate of the true total. We don't try
//   to beat Vegas — we look for where Kalshi diverges from it.
//
// SECONDARY SIGNAL: Referee foul adjustment.
//   High-foul refs add ~2-4 pts to expected totals. Announced ~90 min
//   before tip-off; Kalshi is slower to price this in than sportsbooks.
//
// FALLBACK (no Vegas line): Team ratings model (OffRtg/DefRtg/Pace).
//   Used for testing when Vegas line isn't available yet.
//
// Model:
//   μ = vegas_line + ref_adj  (or ratings-based if no Vegas line)
//   σ = NBA_TOTAL_SIGMA (default 12.5, tune from historical data)
//   P(total > N) = 1 - Φ((N - μ) / σ)
//   edge = P(total > N) - kalshi_yes_price   (or NO side)
//
// Usage:
//   node scripts/nba/nbaTotalsEdge.js [--date YYYY-MM-DD] [--min-edge 0.05] [--json]

import 'dotenv/config'
import * as db from '../../lib/db.js'
import { getNBATotalMarkets } from '../../lib/kalshi.js'
import { fetchNBALines, matchNBAOddsToGames } from '../../lib/odds.js'
import { parseArgs } from '../../lib/cli-args.js'

const opts      = parseArgs({
  date:       { default: new Date().toISOString().slice(0, 10) },
  'min-edge': { type: 'number', default: 0.05 },
  json:       { type: 'boolean', default: false },
})
const TODAY     = opts.date
const MIN_EDGE  = opts['min-edge']
const JSON_OUT  = opts.json

// ── Tuning constants (env-overridable) ───────────────────────────────────────
const SIGMA         = Number(process.env.NBA_TOTAL_SIGMA    ?? 12.5)
const MIN_OI        = Number(process.env.MIN_MARKET_OI      ?? 200)
const RECENT_WEIGHT = Number(process.env.NBA_RECENT_WEIGHT  ?? 0.6)
const MAX_REF_ADJ   = Number(process.env.NBA_MAX_REF_ADJ    ?? 4.0)  // cap ref adjustment

await db.migrate()

// ── Load today's games ────────────────────────────────────────────────────────
const games = await db.all(
  `SELECT * FROM nba_games WHERE game_date = ? AND status != 'final'`, [TODAY])

if (!games.length) {
  if (!JSON_OUT) console.log(`[nba-totals] No games found for ${TODAY}. Run fetchNBASchedule.js first.`)
  if (JSON_OUT) process.stdout.write('[EDGES_JSON][][/EDGES_JSON]\n')
  process.exit(0)
}

// ── Pull Vegas lines ──────────────────────────────────────────────────────────
if (!JSON_OUT) console.log(`[nba-totals] Fetching Vegas lines from The Odds API…`)
const oddsResult = await fetchNBALines()
const vegasMap   = new Map()   // game.id → { total_line, over_prob }

if (oddsResult.ok) {
  const matched = matchNBAOddsToGames(oddsResult.games, games)
  for (const [gameId, oddsGame] of matched) {
    vegasMap.set(gameId, oddsGame)
  }
  if (!JSON_OUT) {
    console.log(`  Vegas lines found: ${vegasMap.size}/${games.length} games  (API credits remaining: ${oddsResult.remaining ?? '?'})`)
  }
} else {
  if (!JSON_OUT) console.warn(`  Vegas lines unavailable: ${oddsResult.error} — falling back to ratings model`)
}

// ── Load team ratings (fallback) ──────────────────────────────────────────────
const teams     = [...new Set(games.flatMap(g => [g.team_away, g.team_home]))]
const statsRows = await db.all(`
  SELECT * FROM nba_team_stats
  WHERE team_id IN (${teams.map(() => '?').join(',')})
    AND stat_date = (
      SELECT MAX(stat_date) FROM nba_team_stats s2
      WHERE s2.team_id = nba_team_stats.team_id
    )`, teams)

const statsMap = {}
for (const r of statsRows) {
  if (!statsMap[r.team_id]) statsMap[r.team_id] = {}
  statsMap[r.team_id][r.window] = r
}

// ── Load referee adjustments ──────────────────────────────────────────────────
const refRows = await db.all(
  `SELECT away_team, home_team, SUM(foul_adj) AS total_adj, COUNT(*) AS ref_count
   FROM nba_ref_assignments
   WHERE game_date = ?
   GROUP BY away_team, home_team`, [TODAY])

const refMap = new Map()   // 'AWAY@HOME' → total_adj
for (const r of refRows) {
  const adj = Math.max(-MAX_REF_ADJ, Math.min(MAX_REF_ADJ, r.total_adj ?? 0))
  refMap.set(`${r.away_team}@${r.home_team}`, adj)
}

// ── Main edge-finding loop ────────────────────────────────────────────────────
if (!JSON_OUT) {
  console.log(`\n[nba-totals] NBA Game Totals Edge Finder — ${TODAY}`)
  console.log(`  σ=${SIGMA}  min_edge=${MIN_EDGE}  min_OI=${MIN_OI}\n`)
}

const edges = []

for (const game of games) {
  const { id, team_away: away, team_home: home, kalshi_event } = game
  const key = `${away}@${home}`

  // ── Determine μ ────────────────────────────────────────────────────────────
  let mu, muSource

  const vegas = vegasMap.get(id)
  if (vegas?.total_line) {
    mu       = vegas.total_line
    muSource = `Vegas ${vegas.total_line} (${vegas.total_lines?.map(l => l.book).join('/')})`
  } else {
    // Ratings fallback
    const as = statsMap[away]
    const hs = statsMap[home]
    if (!as || !hs) {
      if (!JSON_OUT) console.log(`  [skip] ${key} — no Vegas line and no team stats`)
      continue
    }
    const pace    = (blend(as, 'pace') + blend(hs, 'pace')) / 2
    const awayPts = ((blend(as, 'off_rtg') + blend(hs, 'def_rtg')) / 2) * pace / 100
    const homePts = ((blend(hs, 'off_rtg') + blend(as, 'def_rtg')) / 2) * pace / 100 + 2.0
    mu       = awayPts + homePts
    muSource = `ratings (fallback) μ=${mu.toFixed(1)}`
  }

  // ── Referee adjustment ─────────────────────────────────────────────────────
  const refAdj = refMap.get(key) ?? 0
  const muAdj  = mu + refAdj
  const refNote = refAdj !== 0
    ? ` + ref_adj ${refAdj >= 0 ? '+' : ''}${refAdj.toFixed(1)}`
    : ''

  if (!JSON_OUT) {
    console.log(`  ${key}`)
    console.log(`    source: ${muSource}${refNote}  →  μ_adj=${muAdj.toFixed(1)}  σ=${SIGMA}`)
  }

  // ── Fetch Kalshi ladder ────────────────────────────────────────────────────
  const markets = await getNBATotalMarkets(away, home, TODAY)
  if (!markets.length) {
    if (!JSON_OUT) console.log(`    [skip] No Kalshi markets found`)
    continue
  }

  // ── Score each rung ────────────────────────────────────────────────────────
  let bestEdge = 0
  let best     = null

  for (const m of markets) {
    if (m.open_interest != null && m.open_interest < MIN_OI) continue

    const modelProb  = pOver(m.line, muAdj, SIGMA)
    const yesPrice   = (m.yes_ask ?? 50) / 100
    const noAsk      = (m.no_ask  ?? 50) / 100
    const overEdge   = modelProb - yesPrice
    const underEdge  = (1 - modelProb) - noAsk
    const edge       = Math.max(overEdge, underEdge)

    const vegasDiff = vegas?.total_line
      ? (m.line - vegas.total_line).toFixed(1)
      : null

    if (!JSON_OUT) {
      const oi      = m.open_interest ?? 0
      const vdStr   = vegasDiff != null ? `  Δvegas=${vegasDiff > 0 ? '+' : ''}${vegasDiff}` : ''
      const edgeStr = edge >= MIN_EDGE ? ` ← EDGE ${(edge*100).toFixed(1)}¢` : ''
      console.log(`    ${m.line}+: model=${(modelProb*100).toFixed(1)}%  yes=${m.yes_ask}¢  no=${m.no_ask}¢  over=${(overEdge*100).toFixed(1)}¢  under=${(underEdge*100).toFixed(1)}¢  OI=${oi}${vdStr}${edgeStr}`)
    }

    if (edge >= MIN_EDGE && edge > bestEdge) {
      bestEdge = edge
      best = {
        matchup:       key,
        team_away:     away,
        team_home:     home,
        game_date:     TODAY,
        kalshi_event:  kalshi_event,
        ticker:        m.ticker,
        line:          m.line,
        side:          overEdge >= underEdge ? 'YES' : 'NO',
        model_prob:    overEdge >= underEdge ? modelProb : 1 - modelProb,
        market_mid:    m.yes_bid != null
                         ? ((m.yes_ask ?? 50) + (m.yes_bid ?? 50)) / 2
                         : (m.yes_ask ?? 50),
        yes_ask:       m.yes_ask,
        no_ask:        m.no_ask,
        edge,
        mu:            muAdj,
        mu_raw:        mu,
        ref_adj:       refAdj,
        sigma:         SIGMA,
        vegas_line:    vegas?.total_line ?? null,
        vegas_diff:    vegas?.total_line != null ? m.line - vegas.total_line : null,
        open_interest: m.open_interest ?? 0,
        mu_source:     vegas?.total_line ? 'vegas' : 'ratings',
        model:         'nba_totals',
      }
    }
  }

  if (best) {
    edges.push(best)
    if (!JSON_OUT) {
      const vegasStr = best.vegas_line ? `  Vegas=${best.vegas_line}` : ''
      console.log(`    ✓ BEST: ${best.line}+ ${best.side}  edge +${(best.edge*100).toFixed(1)}¢${vegasStr}  Δ=${best.vegas_diff != null ? (best.vegas_diff >= 0 ? '+' : '') + best.vegas_diff.toFixed(1) : 'n/a'}`)
    }
  } else if (!JSON_OUT) {
    console.log(`    — no edge (min ${MIN_EDGE*100}¢)`)
  }

  if (!JSON_OUT) console.log()
}

if (!JSON_OUT) {
  console.log(`[nba-totals] ${edges.length} edge(s) found.`)
  if (edges.length) {
    console.log()
    for (const e of edges) {
      const src = e.mu_source === 'vegas' ? `Vegas=${e.vegas_line} Δ=${e.vegas_diff >= 0 ? '+' : ''}${e.vegas_diff?.toFixed(1)}` : 'ratings fallback'
      console.log(`  ${e.matchup}  ${e.line}+ ${e.side}  edge +${(e.edge*100).toFixed(1)}¢  [${src}]`)
    }
  }
} else {
  process.stdout.write(`[EDGES_JSON]${JSON.stringify(edges)}[/EDGES_JSON]\n`)
}

await db.close()

// ── Math ──────────────────────────────────────────────────────────────────────

function pOver(line, mu, sigma) {
  return 1 - normalCDF((line - mu) / sigma)
}

function normalCDF(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z))
  const d = 0.3989423 * Math.exp(-z * z / 2)
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.7814779 + t * (-1.8212560 + t * 1.3302744))))
  return z > 0 ? 1 - p : p
}

function blend(stats, field) {
  const season = stats?.season?.[field]
  const last10 = stats?.last10?.[field]
  if (season == null && last10 == null) return null
  if (season == null) return last10
  if (last10 == null) return season
  return season * (1 - RECENT_WEIGHT) + last10 * RECENT_WEIGHT
}
