// Run news/preflight check for every scheduled starter today and persist
// results to pitcher_news_log. Called by cron at T-180, T-90, T-30 minutes
// before earliest game first pitch. Fade fire script reads this table to
// skip pitchers with 'skip' action.

import 'dotenv/config'
import { createClient } from '@libsql/client'
import { runPreflightCheck } from '../lib/preflightCheck.js'

const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
console.log(`[news-check] running for ${today}`)

// Eligible starters: every pitcher with a KS market today
const starters = await db.execute({
  sql: `SELECT DISTINCT pitcher_id, MAX(pitcher_name) AS pitcher_name,
               MAX(game_id) AS game_id, MAX(game_label) AS game_label
        FROM market_snapshots WHERE game_date = ? AND ticker LIKE 'KXMLBKS-%'
          AND pitcher_id IS NOT NULL GROUP BY pitcher_id`,
  args: [today],
})
console.log(`[news-check] ${starters.rows.length} starters to check`)
if (starters.rows.length === 0) process.exit(0)

const checkedAt = new Date().toISOString()
let skipCount = 0, boostCount = 0, proceedCount = 0, errorCount = 0

for (const s of starters.rows) {
  // Skip if already checked in last 30 min (rate-limit news API hits)
  const recent = await db.execute({
    sql: `SELECT id FROM pitcher_news_log WHERE pitcher_id = ? AND game_date = ?
          AND checked_at > datetime('now', '-30 minutes') LIMIT 1`,
    args: [s.pitcher_id, today],
  })
  if (recent.rows.length > 0) continue

  // Determine pitcher_side from game_label parsing — required by preflightCheck
  // Format example: "ARI@CHC" or "LAD@MIL" → home is the team after @
  const parts = (s.game_label ?? '').split('@')
  const home = parts[1]
  const away = parts[0]

  // Probable starter team: try fetching from MLB API or guess from market_snapshots
  // For now, default to 'home' (preflightCheck handles teamOf gracefully if wrong)
  let pitcherSide = 'home'  // best-effort default

  const entry = {
    pitcher_id: String(s.pitcher_id),
    pitcher_name: s.pitcher_name,
    game_id: s.game_id,
    game_label: s.game_label,
    pitcher_side: pitcherSide,
    game_time: today + 'T00:00:00Z',
  }

  try {
    const result = await runPreflightCheck(entry)
    await db.execute({
      sql: `INSERT OR REPLACE INTO pitcher_news_log
        (pitcher_id, pitcher_name, game_date, game_id, game_label,
         checked_at, action, reason, confidence, sources_json)
        VALUES (?,?,?,?,?,?,?,?,?,?)`,
      args: [
        s.pitcher_id, s.pitcher_name, today, s.game_id, s.game_label,
        checkedAt, result.action, result.reason ?? null,
        result.confidence ?? null,
        JSON.stringify(result.sources ?? []),
      ],
    })
    if (result.action === 'skip')   skipCount++
    if (result.action === 'boost')  boostCount++
    if (result.action === 'proceed') proceedCount++
    const flag = result.action === 'skip' ? '🔴' : result.action === 'boost' ? '🟢' : '⚪'
    console.log(`  ${flag} ${s.pitcher_name}: ${result.action} (${result.reason?.slice(0, 80) ?? '—'})`)
  } catch (err) {
    errorCount++
    console.error(`  [error] ${s.pitcher_name}: ${err.message}`)
  }
}

console.log(`\n[news-check] done — skip=${skipCount}, boost=${boostCount}, proceed=${proceedCount}, errors=${errorCount}`)
