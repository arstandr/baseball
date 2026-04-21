// scripts/live/fetchUmpire.js — Fetch HP umpire for MLB games via Stats API.
//
// Uses MLB Stats API /schedule?gamePk=X&hydrate=officials to get the home plate
// umpire for each game. Returns a Map<gameId, { umpName, umpId }>.
//
// Called at startup in strikeoutEdge.js to apply ump K% adjustment factor.
//
// Usage (standalone):
//   node scripts/live/fetchUmpire.js [--date YYYY-MM-DD]

import 'dotenv/config'
import axios from 'axios'

const MLB_BASE = 'https://statsapi.mlb.com/api/v1'

/**
 * Fetch the home plate umpire for a single game.
 *
 * @param {number|string} gamePk - MLB game ID
 * @returns {Promise<{umpName: string|null, umpId: number|null}>}
 */
export async function fetchUmpireForGame(gamePk) {
  try {
    const res = await axios.get(`${MLB_BASE}/schedule`, {
      params: { gamePk, hydrate: 'officials', sportId: 1 },
      timeout: 10000,
      validateStatus: s => s >= 200 && s < 500,
    })
    if (res.status >= 400) return { umpName: null, umpId: null }

    const dates = res.data?.dates || []
    for (const d of dates) {
      for (const g of d.games || []) {
        const officials = g.officials || []
        const hp = officials.find(o =>
          o.officialType === 'Home Plate' ||
          o.officialType === 'HP' ||
          (o.officialType || '').toLowerCase().includes('home plate'),
        )
        if (hp) {
          return {
            umpName: hp.official?.fullName || null,
            umpId:   hp.official?.id       || null,
          }
        }
      }
    }
    return { umpName: null, umpId: null }
  } catch {
    return { umpName: null, umpId: null }
  }
}

/**
 * Fetch HP umpires for an array of game IDs concurrently.
 *
 * @param {Array<number|string>} gameIds
 * @returns {Promise<Map<string, {umpName: string|null, umpId: number|null}>>}
 */
export async function fetchUmpiresForGames(gameIds) {
  const results = await Promise.all(
    gameIds.map(id => fetchUmpireForGame(id).then(u => ({ id: String(id), ...u }))),
  )
  const map = new Map()
  for (const r of results) {
    map.set(r.id, { umpName: r.umpName, umpId: r.umpId })
  }
  return map
}

// ── Standalone run ────────────────────────────────────────────────────────────

if (process.argv[1]?.endsWith('fetchUmpire.js')) {
  const args    = process.argv.slice(2)
  const dateArg = args.includes('--date') ? args[args.indexOf('--date') + 1] : null
  const TODAY   = dateArg || new Date().toISOString().slice(0, 10)

  const { default: db } = await import('../../lib/db.js')
  await db.migrate()

  const games = await db.all(
    `SELECT id, team_home, team_away FROM games WHERE date = ?`,
    [TODAY],
  )

  if (!games.length) {
    console.log(`[ump] No games for ${TODAY}`)
    await db.close()
    process.exit(0)
  }

  console.log(`[ump] Fetching HP umpires for ${games.length} games on ${TODAY}…`)
  const umpMap = await fetchUmpiresForGames(games.map(g => g.id))

  for (const g of games) {
    const u = umpMap.get(String(g.id))
    const label = `${g.team_away}@${g.team_home}`
    console.log(`  ${label}: ${u?.umpName || '(not yet assigned)'} (id=${u?.umpId ?? 'n/a'})`)
  }

  await db.close()
}
