// Backfill fade_paper_test_candidates with joined intelligence we already have.
// Hits: pitcher_signals, pitcher_edge_cache, weather, parkFactors, umpireFactors.

import 'dotenv/config'
import { createClient } from '@libsql/client'
import { getParkFactor } from '../lib/parkFactors.js'
import { getUmpireFactor } from '../lib/umpireFactors.js'

const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })

// Ensure schema has the columns we need (some may be added)
const cols = await db.execute('PRAGMA table_info(fade_paper_test_candidates)')
const colNames = new Set(cols.rows.map(r => r.name))
const ensureCol = async (name, type) => {
  if (!colNames.has(name)) {
    await db.execute(`ALTER TABLE fade_paper_test_candidates ADD COLUMN ${name} ${type}`)
    console.log(`  added column: ${name}`)
  }
}
await ensureCol('confidence', 'REAL')
await ensureCol('production_model_prob', 'REAL')
await ensureCol('production_edge_yes', 'REAL')
await ensureCol('swstr_pct', 'REAL')
await ensureCol('fstrike_pct', 'REAL')
await ensureCol('bb9', 'REAL')
await ensureCol('era_l5', 'REAL')
await ensureCol('pitch_efficiency_l5', 'REAL')
await ensureCol('tto3_penalty', 'REAL')
await ensureCol('fip_weighted', 'REAL')

console.log('\nBackfilling intelligence joins...')

// Pull all candidates needing backfill
const cands = await db.execute(`
  SELECT id, target_date, pitcher_id, strike, side, ticker
  FROM fade_paper_test_candidates
  WHERE confidence IS NULL OR production_model_prob IS NULL
`)
console.log(`${cands.rows.length} candidate rows to backfill`)

let updated = 0
for (const c of cands.rows) {
  // Pitcher signals join
  const ps = await db.execute({
    sql: `SELECT confidence, swstr_pct, avg_innings_l5, fstrike_pct, bb9, era_l5,
                 pitch_efficiency_l5, tto3_penalty, fip_weighted, hand, days_rest, season_start_num
          FROM pitcher_signals WHERE pitcher_id = ? AND signal_date = ? LIMIT 1`,
    args: [c.pitcher_id, c.target_date],
  })
  const sig = ps.rows[0]

  // Production engine model_prob
  let prodProb = null, prodEdge = null
  const ec = await db.execute({
    sql: `SELECT edges_json FROM pitcher_edge_cache WHERE pitcher_id = ? AND bet_date = ? LIMIT 1`,
    args: [c.pitcher_id, c.target_date],
  })
  if (ec.rows[0]?.edges_json) {
    try {
      const edges = JSON.parse(ec.rows[0].edges_json)
      const match = edges.find(e => Number(e.strike) === Number(c.strike))
      if (match) {
        prodProb = Number(match.model_prob)
        prodEdge = c.side === 'YES' ? Number(match.edge_yes) : Number(match.edge_no)
      }
    } catch {}
  }

  await db.execute({
    sql: `UPDATE fade_paper_test_candidates SET
            confidence = ?,
            production_model_prob = ?,
            production_edge_yes = ?,
            swstr_pct = ?,
            fstrike_pct = ?,
            bb9 = ?,
            era_l5 = ?,
            pitch_efficiency_l5 = ?,
            tto3_penalty = ?,
            fip_weighted = ?,
            hand = ?,
            days_rest = ?,
            season_start_num = ?,
            avg_ip_l5 = COALESCE(?, avg_ip_l5)
          WHERE id = ?`,
    args: [
      sig?.confidence ?? null,
      prodProb,
      prodEdge,
      sig?.swstr_pct ?? null,
      sig?.fstrike_pct ?? null,
      sig?.bb9 ?? null,
      sig?.era_l5 ?? null,
      sig?.pitch_efficiency_l5 ?? null,
      sig?.tto3_penalty ?? null,
      sig?.fip_weighted ?? null,
      sig?.hand ?? null,
      sig?.days_rest ?? null,
      sig?.season_start_num ?? null,
      sig?.avg_innings_l5 ?? null,
      c.id,
    ],
  })
  updated++
  if (updated % 200 === 0) console.log(`  [${updated}/${cands.rows.length}]`)
}

console.log(`\nUpdated ${updated} rows`)

// Park, ump, weather backfill — these need the game's home team / venue
// We'll pull from market_snapshots which has game_id, then join to MLB schedule for venue + ump
console.log('\nBackfilling park/ump/weather (where available)...')
const games = await db.execute(`
  SELECT DISTINCT target_date, ticker
  FROM fade_paper_test_candidates
  WHERE park IS NULL AND ticker IS NOT NULL
`)
let parksDone = 0
for (const g of games.rows) {
  // Extract home team abbrev from ticker: KXMLBKS-{date}{HHMM}{AWAY}{HOME}-...
  const m = /^KXMLBKS-\d{2}[A-Z]{3}\d{2}\d{4}([A-Z]+?)(LAA|LAD|NYY|NYM|CWS|SDP|SD|SF|TBR|TB|WSH|ARI|AZ|ATL|BAL|BOS|CHC|CIN|CLE|COL|DET|HOU|KC|MIA|MIL|MIN|OAK|PHI|PIT|SEA|STL|TEX|TOR|ATH)/.exec(g.ticker)
  if (!m) continue
  const home = m[2] === 'AZ' ? 'ARI' : m[2] === 'TB' ? 'TBR' : m[2] === 'SD' ? 'SDP' : m[2]
  const parkFactor = getParkFactor(home)
  if (parkFactor != null) {
    await db.execute({
      sql: `UPDATE fade_paper_test_candidates SET park = ?, park_k_factor = ? WHERE ticker = ?`,
      args: [home, parkFactor, g.ticker],
    })
    parksDone++
  }
}
console.log(`Park backfill: ${parksDone} tickers`)

// Coverage report
const cov = await db.execute(`
  SELECT
    COUNT(*) AS total,
    SUM(CASE WHEN confidence IS NOT NULL THEN 1 ELSE 0 END) AS w_conf,
    SUM(CASE WHEN production_model_prob IS NOT NULL THEN 1 ELSE 0 END) AS w_prod,
    SUM(CASE WHEN park_k_factor IS NOT NULL THEN 1 ELSE 0 END) AS w_park,
    SUM(CASE WHEN swstr_pct IS NOT NULL THEN 1 ELSE 0 END) AS w_swstr,
    SUM(CASE WHEN avg_ip_l5 IS NOT NULL THEN 1 ELSE 0 END) AS w_ipl5
  FROM fade_paper_test_candidates
`)
const c = cov.rows[0]
console.log(`\nCoverage: ${c.total} total candidates`)
console.log(`  confidence: ${c.w_conf}`)
console.log(`  production_model_prob: ${c.w_prod}`)
console.log(`  park_k_factor: ${c.w_park}`)
console.log(`  swstr_pct: ${c.w_swstr}`)
console.log(`  avg_ip_l5: ${c.w_ipl5}`)
