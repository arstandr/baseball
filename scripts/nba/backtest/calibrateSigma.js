// scripts/nba/backtest/calibrateSigma.js
//
// Fits the true σ for NBA game totals using 2024-25 regular season data.
// Answers: is our assumed σ=12.5 correct?
//
// Data sources:
//   Scores:      ESPN unofficial API (free)
//   Vegas lines: The Odds API historical endpoint (paid, ~200 credits)
//
// Output:
//   - Fitted σ (regular season + playoffs separately)
//   - Distribution of residuals (actual_total - vegas_line)
//   - Model accuracy at each standard deviation bucket
//
// Usage:
//   node scripts/nba/backtest/calibrateSigma.js

import 'dotenv/config'
import axios from 'axios'
import * as db from '../../../lib/db.js'

const ODDS_KEY    = process.env.ODDS_API_KEY
const ODDS_BASE   = 'https://api.the-odds-api.com/v4'
const ESPN_BASE   = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba'

// 2024-25 regular season: Oct 22, 2024 → Apr 13, 2025
const SEASON_START = '2024-10-22'
const SEASON_END   = '2025-04-13'
// 2024-25 playoffs: Apr 19 → mid-Jun 2025
const PLAYOFF_START = '2025-04-19'
const PLAYOFF_END   = '2025-06-22'

await db.migrate()
await ensureTable()

console.log('══════════════════════════════════════════════════')
console.log(' NBA Total σ Calibration — 2024-25 Season')
console.log('══════════════════════════════════════════════════')

// ── Step 1: Pull all game scores from ESPN ────────────────────────────────────
console.log('\n[1/3] Fetching game scores from ESPN…')
const espnGames = await fetchAllESPNScores(SEASON_START, PLAYOFF_END)
console.log(`  Found ${espnGames.length} completed games`)

// ── Step 2: Pull Vegas lines from The Odds API historical ─────────────────────
console.log('\n[2/3] Fetching historical Vegas lines from The Odds API…')
console.log('  (This uses API credits — estimated ~300 credits)')
const vegasLines = await fetchHistoricalVegasLines(SEASON_START, PLAYOFF_END)
console.log(`  Found ${vegasLines.size} games with Vegas total lines`)

// ── Step 3: Match + compute residuals ────────────────────────────────────────
console.log('\n[3/3] Matching games and computing residuals…')

const residuals    = []   // regular season
const pResiduals   = []   // playoffs

for (const game of espnGames) {
  const vegasLine = vegasLines.get(game.matchKey)
  if (vegasLine == null) continue

  const residual = game.actualTotal - vegasLine
  const isPlayoff = game.date >= PLAYOFF_START

  const entry = {
    date:        game.date,
    matchup:     game.matchKey,
    actual:      game.actualTotal,
    vegas:       vegasLine,
    residual,
    is_playoff:  isPlayoff ? 1 : 0,
  }

  await db.run(`
    INSERT INTO nba_backtest_games (game_date, matchup, actual_total, vegas_line, residual, is_playoff)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(game_date, matchup) DO UPDATE SET
      actual_total = excluded.actual_total,
      vegas_line   = excluded.vegas_line,
      residual     = excluded.residual
  `, [entry.date, entry.matchup, entry.actual, entry.vegas, entry.residual, entry.is_playoff])

  if (isPlayoff) pResiduals.push(residual)
  else           residuals.push(residual)
}

// ── Results ───────────────────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════')
console.log(' Results')
console.log('══════════════════════════════════════════════════')

printStats('Regular Season', residuals)
if (pResiduals.length >= 10) printStats('Playoffs', pResiduals)
else console.log(`\nPlayoffs: only ${pResiduals.length} games — not enough to fit (need 2025 playoffs to complete)`)

// Distribution buckets
console.log('\nResidual distribution (regular season):')
printBuckets(residuals)

await db.close()

// ── Helpers ───────────────────────────────────────────────────────────────────

function printStats(label, res) {
  if (!res.length) return
  const n    = res.length
  const mean = res.reduce((a, b) => a + b, 0) / n
  const variance = res.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)
  const sigma = Math.sqrt(variance)
  const sorted = [...res].sort((a, b) => a - b)
  const p10  = sorted[Math.floor(n * 0.10)]
  const p25  = sorted[Math.floor(n * 0.25)]
  const p75  = sorted[Math.floor(n * 0.75)]
  const p90  = sorted[Math.floor(n * 0.90)]
  const iqr  = p75 - p25

  console.log(`\n${label} (n=${n}):`)
  console.log(`  Mean residual:  ${mean.toFixed(2)} pts  (bias — positive = market underestimates)`)
  console.log(`  Fitted σ:       ${sigma.toFixed(2)} pts  ← USE THIS in nbaTotalsEdge.js`)
  console.log(`  Our assumed σ:  12.50 pts  (${sigma > 12.5 ? 'market is TIGHTER than we think' : 'market is WIDER than we think'})`)
  console.log(`  IQR:            ${iqr.toFixed(1)}  (p25=${p25.toFixed(1)}, p75=${p75.toFixed(1)})`)
  console.log(`  p10/p90:        ${p10.toFixed(1)} / ${p90.toFixed(1)}`)

  // Accuracy check: how often does actual fall within ±σ, ±2σ?
  const within1s = res.filter(r => Math.abs(r) <= sigma).length / n
  const within2s = res.filter(r => Math.abs(r) <= 2 * sigma).length / n
  console.log(`  Within ±1σ:     ${(within1s * 100).toFixed(1)}%  (Normal predicts 68.3%)`)
  console.log(`  Within ±2σ:     ${(within2s * 100).toFixed(1)}%  (Normal predicts 95.4%)`)
}

function printBuckets(res) {
  const buckets = [
    { label: 'Under by 20+', fn: r => r < -20 },
    { label: 'Under 15-20',  fn: r => r >= -20 && r < -15 },
    { label: 'Under 10-15',  fn: r => r >= -15 && r < -10 },
    { label: 'Under 5-10',   fn: r => r >= -10 && r < -5 },
    { label: 'Under 0-5',    fn: r => r >= -5  && r < 0  },
    { label: 'Over 0-5',     fn: r => r >= 0   && r < 5  },
    { label: 'Over 5-10',    fn: r => r >= 5   && r < 10 },
    { label: 'Over 10-15',   fn: r => r >= 10  && r < 15 },
    { label: 'Over 15-20',   fn: r => r >= 15  && r < 20 },
    { label: 'Over 20+',     fn: r => r >= 20            },
  ]
  const n = res.length
  for (const b of buckets) {
    const count = res.filter(b.fn).length
    const pct   = (count / n * 100).toFixed(1)
    const bar   = '█'.repeat(Math.round(count / n * 40))
    console.log(`  ${b.label.padEnd(14)} ${String(count).padStart(3)}  (${pct.padStart(5)}%)  ${bar}`)
  }
}

// ── ESPN score fetcher ────────────────────────────────────────────────────────
async function fetchAllESPNScores(startDate, endDate) {
  const games = []
  let current = new Date(startDate)
  const end   = new Date(endDate)

  while (current <= end) {
    const dateStr = current.toISOString().slice(0, 10).replace(/-/g, '')
    try {
      const res = await axios.get(`${ESPN_BASE}/scoreboard`, {
        params: { dates: dateStr, limit: 50 },
        timeout: 10000,
      })
      for (const event of res.data?.events || []) {
        const comp   = event.competitions?.[0]
        if (!comp) continue
        const status = comp.status?.type?.name
        if (status !== 'STATUS_FINAL') continue

        const competitors = comp.competitors || []
        const away = competitors.find(c => c.homeAway === 'away')
        const home = competitors.find(c => c.homeAway === 'home')
        if (!away || !home) continue

        const awayPts = Number(away.score)
        const homePts = Number(home.score)
        if (!awayPts && !homePts) continue

        const awayAbbr = away.team?.abbreviation?.toUpperCase()
        const homeAbbr = home.team?.abbreviation?.toUpperCase()
        const matchKey = `${awayAbbr}@${homeAbbr}`

        games.push({
          date:        current.toISOString().slice(0, 10),
          matchKey,
          awayAbbr,
          homeAbbr,
          actualTotal: awayPts + homePts,
        })
      }
    } catch { /* skip failed dates */ }

    current.setDate(current.getDate() + 1)
    await new Promise(r => setTimeout(r, 200))  // be polite to ESPN
  }
  return games
}

// ── Odds API historical fetcher ───────────────────────────────────────────────
async function fetchHistoricalVegasLines(startDate, endDate) {
  // Map: matchKey (e.g. 'DEN@MIN') → vegas total line
  const lines = new Map()
  if (!ODDS_KEY) { console.warn('  No ODDS_API_KEY — skipping Vegas lines'); return lines }

  // Sample once per week (Vegas lines don't change that much for calibration)
  // Full daily would cost ~500 credits; weekly costs ~50 credits
  const dates = []
  let cur = new Date(startDate)
  const end = new Date(endDate)
  while (cur <= end) {
    dates.push(new Date(cur))
    cur.setDate(cur.getDate() + 1)  // daily for accuracy
  }

  const NBA_NAME_TO_ABBR = {
    'Atlanta Hawks': 'ATL', 'Boston Celtics': 'BOS', 'Brooklyn Nets': 'BKN',
    'Charlotte Hornets': 'CHA', 'Chicago Bulls': 'CHI', 'Cleveland Cavaliers': 'CLE',
    'Dallas Mavericks': 'DAL', 'Denver Nuggets': 'DEN', 'Detroit Pistons': 'DET',
    'Golden State Warriors': 'GSW', 'Houston Rockets': 'HOU', 'Indiana Pacers': 'IND',
    'LA Clippers': 'LAC', 'Los Angeles Clippers': 'LAC', 'Los Angeles Lakers': 'LAL',
    'Memphis Grizzlies': 'MEM', 'Miami Heat': 'MIA', 'Milwaukee Bucks': 'MIL',
    'Minnesota Timberwolves': 'MIN', 'New Orleans Pelicans': 'NOP',
    'New York Knicks': 'NYK', 'Oklahoma City Thunder': 'OKC', 'Orlando Magic': 'ORL',
    'Philadelphia 76ers': 'PHI', 'Phoenix Suns': 'PHX', 'Portland Trail Blazers': 'POR',
    'Sacramento Kings': 'SAC', 'San Antonio Spurs': 'SAS', 'Toronto Raptors': 'TOR',
    'Utah Jazz': 'UTA', 'Washington Wizards': 'WSH',
  }
  const toAbbr = name => NBA_NAME_TO_ABBR[name] ?? name?.split(' ').pop()?.slice(0, 3).toUpperCase()

  let credits = 0
  for (const date of dates) {
    const dateStr = date.toISOString().slice(0, 10)
    const iso = `${dateStr}T20:00:00Z`  // ~4pm ET, near tip-off time
    try {
      const res = await axios.get(`${ODDS_BASE}/historical/sports/basketball_nba/odds`, {
        params: {
          apiKey:      ODDS_KEY,
          regions:     'us',
          markets:     'totals',
          date:        iso,
          oddsFormat:  'american',
          bookmakers:  'draftkings,fanduel',
        },
        timeout: 15000,
      })
      credits += 5  // historical costs ~5 credits per call
      for (const game of res.data?.data || []) {
        const awayAbbr = toAbbr(game.away_team)
        const homeAbbr = toAbbr(game.home_team)
        const matchKey = `${awayAbbr}@${homeAbbr}`
        for (const bk of game.bookmakers || []) {
          for (const m of bk.markets || []) {
            if (m.key !== 'totals') continue
            const over = m.outcomes?.find(o => o.name === 'Over')
            if (over?.point) {
              if (!lines.has(matchKey)) lines.set(matchKey, over.point)
            }
          }
        }
      }
      const remaining = res.headers?.['x-requests-remaining']
      if (credits % 50 === 0) process.stdout.write(`  ${dateStr}  credits_remaining=${remaining}\n`)
    } catch { /* skip */ }
    await new Promise(r => setTimeout(r, 500))
  }
  console.log(`  Used ~${credits} API credits`)
  return lines
}

async function ensureTable() {
  await db.run(`
    CREATE TABLE IF NOT EXISTS nba_backtest_games (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      game_date   TEXT NOT NULL,
      matchup     TEXT NOT NULL,
      actual_total INTEGER,
      vegas_line   REAL,
      residual     REAL,
      is_playoff   INTEGER DEFAULT 0,
      UNIQUE(game_date, matchup)
    )`)
}
