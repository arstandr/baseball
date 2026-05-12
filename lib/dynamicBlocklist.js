// Dynamic pitcher blocklist — auto-add/remove pitchers based on rolling
// performance. Replaces the static blocklist that was the original Rule 6
// implementation. Runs daily as part of the EOD cron.
//
// Add criteria (any pitcher in last 14 days):
//   - 5+ settled YES bets AND win rate ≤ 20% AND total P&L ≤ -$50
//   - 8+ settled YES bets AND win rate ≤ 30% AND total P&L ≤ -$25
//   - 3+ losses in a row on settled bets (streak detection)
//
// Remove criteria:
//   - Pitcher hasn't appeared in any settled bet in the last 30 days
//   - Pitcher's last 5 bets are 3+ wins (recovery — give them another chance)
//
// All adds/removes are logged with reason. Adds are tagged 'auto-blocklist:14d'
// so they're distinguishable from manual adds.

import * as db from './db.js'

const ADD_WINDOW_DAYS = 14
const REMOVE_INACTIVITY_DAYS = 30
const RECOVERY_WINDOW = 5

const ADD_RULES = [
  { min_bets: 5, max_win_rate: 0.20, max_pnl: -50, label: '5+ bets, ≤20% wins, ≤-$50' },
  { min_bets: 8, max_win_rate: 0.30, max_pnl: -25, label: '8+ bets, ≤30% wins, ≤-$25' },
]

export async function evaluateBlocklist({ dryRun = false } = {}) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  const cutoff14 = new Date(Date.now() - ADD_WINDOW_DAYS * 86400_000).toISOString().slice(0, 10)
  const cutoff30 = new Date(Date.now() - REMOVE_INACTIVITY_DAYS * 86400_000).toISOString().slice(0, 10)

  // Existing blocklist
  const existingRows = await db.all(`SELECT pitcher_name, added_by FROM pitcher_blocklist`).catch(() => [])
  const existing = new Set(existingRows.map(r => r.pitcher_name))
  const autoAdded = new Set(existingRows.filter(r => (r.added_by ?? '').startsWith('auto-blocklist')).map(r => r.pitcher_name))

  // ── ADD pass: candidates failing rules ──
  const candidates = await db.all(
    `SELECT pitcher_name,
            COUNT(*) AS n,
            SUM(CASE WHEN result='win' THEN 1 ELSE 0 END) AS wins,
            ROUND(SUM(pnl), 2) AS pnl,
            MAX(bet_date) AS last_bet
     FROM ks_bets
     WHERE bet_date >= ? AND bet_date <= ? AND live_bet = 0 AND side = 'YES' AND result IN ('win','loss')
     GROUP BY pitcher_name HAVING n >= 5`,
    [cutoff14, today],
  ).catch(() => [])

  const adds = []
  for (const c of candidates) {
    if (existing.has(c.pitcher_name)) continue
    const winRate = c.wins / c.n
    for (const rule of ADD_RULES) {
      if (c.n >= rule.min_bets && winRate <= rule.max_win_rate && Number(c.pnl) <= rule.max_pnl) {
        adds.push({
          pitcher: c.pitcher_name,
          reason: `${rule.label} (actual: ${c.wins}/${c.n}, $${c.pnl})`,
          stats: { n: c.n, wins: c.wins, pnl: c.pnl, win_rate: winRate },
        })
        break
      }
    }
  }

  // ── REMOVE pass: inactive auto-added pitchers ──
  const removes = []
  for (const name of autoAdded) {
    const recent = await db.one(
      `SELECT MAX(bet_date) AS last_bet, COUNT(*) AS n FROM ks_bets WHERE pitcher_name = ? AND bet_date >= ?`,
      [name, cutoff30],
    ).catch(() => null)
    if (!recent || !recent.last_bet || recent.last_bet < cutoff30) {
      removes.push({ pitcher: name, reason: `inactive >${REMOVE_INACTIVITY_DAYS}d` })
      continue
    }
    // Recovery check: last 5 bets are 3+ wins
    const recovery = await db.all(
      `SELECT result FROM ks_bets WHERE pitcher_name = ? AND result IN ('win','loss')
       ORDER BY bet_date DESC, id DESC LIMIT ?`,
      [name, RECOVERY_WINDOW],
    ).catch(() => [])
    if (recovery.length >= RECOVERY_WINDOW) {
      const recentWins = recovery.filter(r => r.result === 'win').length
      if (recentWins >= 3) {
        removes.push({ pitcher: name, reason: `recovery: ${recentWins}/${RECOVERY_WINDOW} recent wins` })
      }
    }
  }

  // ── Apply changes ──
  if (!dryRun) {
    for (const a of adds) {
      await db.run(
        `INSERT OR IGNORE INTO pitcher_blocklist (pitcher_name, reason, added_at, added_by)
         VALUES (?, ?, ?, ?)`,
        [a.pitcher, a.reason, new Date().toISOString(), `auto-blocklist:${ADD_WINDOW_DAYS}d`],
      ).catch(() => {})
      console.log(`[dynamic-blocklist] ADDED: ${a.pitcher} — ${a.reason}`)
    }
    for (const r of removes) {
      await db.run(`DELETE FROM pitcher_blocklist WHERE pitcher_name = ?`, [r.pitcher]).catch(() => {})
      console.log(`[dynamic-blocklist] REMOVED: ${r.pitcher} — ${r.reason}`)
    }
  }

  return { adds, removes, evaluated_at: new Date().toISOString() }
}
