// Harvest pitcher K outcomes from MLB Stats API for every pitcher seen in
// market_snapshots that is missing from pitcher_recent_starts. Closes the
// outcome gap for non-bet pitchers — without this, ~20 pitcher-days/day of
// market data can't be used for cross-strike or other backtests.
//
// Usage:
//   node scripts/harvestOutcomes.mjs              # backfill since 2026-04-28
//   node scripts/harvestOutcomes.mjs 2026-05-06   # specific date only
//
// Idempotent: skips pitchers already in pitcher_recent_starts.

import 'dotenv/config'
import { createClient } from '@libsql/client'

const ARG_DATE = process.argv[2]
const SEASON = 2026
const REQUEST_DELAY_MS = 200

const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })

// Find pitcher-days in market_snapshots that have no row in pitcher_recent_starts
const dateFilter = ARG_DATE ? `AND ms.game_date = '${ARG_DATE}'` : `AND ms.game_date >= '2026-04-28'`
const missing = await db.execute(`
  SELECT ms.pitcher_id, ms.game_date, MAX(ms.game_id) AS game_id, MAX(ms.pitcher_name) AS pitcher_name
  FROM market_snapshots ms
  WHERE ms.pitcher_id IS NOT NULL ${dateFilter}
    AND NOT EXISTS (
      SELECT 1 FROM pitcher_recent_starts prs
      WHERE prs.pitcher_id = ms.pitcher_id AND prs.game_date = ms.game_date
    )
  GROUP BY ms.pitcher_id, ms.game_date
  ORDER BY ms.game_date, ms.pitcher_id
`)
console.log(`${missing.rows.length} pitcher-days missing outcomes`)
if (missing.rows.length === 0) process.exit(0)

// One gameLog fetch per pitcher_id covers all of their games for the season,
// so cache by pitcher_id to avoid hammering the MLB API.
const gameLogCache = new Map()
async function getGameLog(pitcherId) {
  if (gameLogCache.has(pitcherId)) return gameLogCache.get(pitcherId)
  const url = `https://statsapi.mlb.com/api/v1/people/${pitcherId}/stats?stats=gameLog&season=${SEASON}&group=pitching`
  const res = await fetch(url).then(r => r.ok ? r.json() : null).catch(() => null)
  const splits = res?.stats?.[0]?.splits || []
  gameLogCache.set(pitcherId, splits)
  return splits
}

// IP comes back as "5.2" meaning 5⅔ innings. Convert to decimal for storage.
function parseIp(ipStr) {
  if (ipStr == null) return null
  const s = String(ipStr)
  const [whole, frac] = s.split('.')
  return Number(whole) + (Number(frac || 0) / 3)
}

let inserted = 0, skipped = 0, errored = 0
let processedPitchers = 0
const fetchDate = new Date().toISOString().slice(0, 10)

const uniquePitchers = [...new Set(missing.rows.map(r => String(r.pitcher_id)))]
console.log(`${uniquePitchers.length} unique pitchers to fetch from MLB API\n`)

for (const pitcherId of uniquePitchers) {
  processedPitchers++
  const splits = await getGameLog(pitcherId).catch(err => { console.warn(`  fetch failed for ${pitcherId}: ${err.message}`); return null })
  if (!splits) { errored++; continue }
  await new Promise(r => setTimeout(r, REQUEST_DELAY_MS))

  // Find missing rows for this pitcher
  const myMissing = missing.rows.filter(r => String(r.pitcher_id) === pitcherId)
  for (const m of myMissing) {
    const split = splits.find(s => s.date === m.game_date)
    if (!split) { skipped++; continue }
    const stat = split.stat || {}
    try {
      await db.execute({
        sql: `INSERT OR IGNORE INTO pitcher_recent_starts
              (pitcher_id, game_id, game_date, season, ip, bf, ks, pitches, bb, fetch_date)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          String(pitcherId),
          m.game_id ? String(m.game_id) : (split.game?.gamePk ? String(split.game.gamePk) : null),
          m.game_date,
          SEASON,
          parseIp(stat.inningsPitched),
          stat.battersFaced ?? null,
          stat.strikeOuts ?? 0,
          stat.numberOfPitches ?? null,
          stat.baseOnBalls ?? null,
          fetchDate,
        ],
      })
      inserted++
    } catch (err) {
      console.warn(`  insert failed ${pitcherId}/${m.game_date}: ${err.message}`)
      errored++
    }
  }
  if (processedPitchers % 25 === 0) console.log(`  [progress] ${processedPitchers}/${uniquePitchers.length} pitchers, ${inserted} rows written`)
}

console.log(`\nInserted: ${inserted}`)
console.log(`Skipped (no game log entry): ${skipped}`)
console.log(`Errored: ${errored}`)
