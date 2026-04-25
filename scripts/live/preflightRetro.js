// scripts/live/preflightRetro.js — Preflight retrospective report
//
// For each bet_schedule entry on a given date, determines whether the preflight
// decision (skip vs. fire) was correct in retrospect:
//   - skipped pitcher: would the planned bets have won or lost?
//   - fired pitcher:   did the actual bets net win or net loss?
//
// Writes preflight_outcome TEXT back to bet_schedule and prints a summary.
//
// Usage: node scripts/live/preflightRetro.js [--date YYYY-MM-DD]
//        node scripts/live/preflightRetro.js --all    (last 30 days)

import 'dotenv/config'
import * as db from '../../lib/db.js'
import { parseArgs } from '../../lib/cli-args.js'

const opts = parseArgs({
  date: { default: new Date().toISOString().slice(0, 10) },
  all:  { type: 'boolean', default: false },
})

async function processDate(date) {
  // Ensure preflight_outcome column exists (safe no-op if already present)
  await db.run(`ALTER TABLE bet_schedule ADD COLUMN preflight_outcome TEXT`).catch(() => {})

  const entries = await db.all(
    `SELECT bs.id, bs.pitcher_id, bs.pitcher_name, bs.game_id, bs.game_label,
            bs.status, bs.preflight, bs.preflight_outcome,
            dp.lambda, dp.edges_json, dp.bets_placed_json, dp.final_action, dp.skip_reason
     FROM bet_schedule bs
     LEFT JOIN decision_pipeline dp
           ON dp.bet_date = bs.bet_date AND dp.pitcher_id = bs.pitcher_id
     WHERE bs.bet_date = ?
     ORDER BY bs.id`,
    [date],
  )

  if (!entries.length) return []

  const results = []

  for (const entry of entries) {
    // Find actual K total for this pitcher on this date from settled bets
    const settledRow = await db.one(
      `SELECT actual_ks FROM ks_bets
       WHERE bet_date = ? AND pitcher_id = ? AND actual_ks IS NOT NULL
       ORDER BY actual_ks DESC LIMIT 1`,
      [date, entry.pitcher_id],
    )
    const actualKs = settledRow?.actual_ks ?? null
    const lambda = entry.lambda

    let outcome = null

    const isSkipped = entry.status === 'skipped' || entry.preflight === 'skip'
    const isFired   = entry.status === 'fired'

    if (isSkipped) {
      if (actualKs == null) {
        outcome = 'pending'
      } else {
        // Parse planned edges from decision_pipeline.edges_json
        let edges = []
        try { edges = JSON.parse(entry.edges_json || '[]') } catch {}
        const planned = edges.filter(e => e.passed)

        if (planned.length === 0 && lambda != null) {
          // No explicit edge data — use lambda proxy: NO bets around lambda win when actual < lambda
          outcome = actualKs < lambda ? 'would_win' : 'would_lose'
        } else if (planned.length === 0) {
          outcome = 'no_bets_planned'
        } else {
          let wins = 0
          let losses = 0
          for (const e of planned) {
            const strike = e.strike
            const side   = (e.side || '').toUpperCase()
            if (side === 'NO')  { actualKs < strike  ? wins++ : losses++ }
            else                { actualKs >= strike ? wins++ : losses++ }
          }
          if (wins > losses)        outcome = 'would_win'
          else if (losses > wins)   outcome = 'would_lose'
          else if (wins > 0)        outcome = 'mixed'
          else                      outcome = 'no_bets_planned'
        }
      }
    } else if (isFired) {
      const realBets = await db.all(
        `SELECT result FROM ks_bets
         WHERE bet_date = ? AND pitcher_id = ? AND live_bet = 0 AND paper = 0
           AND result IN ('win','loss')`,
        [date, entry.pitcher_id],
      )
      if (!realBets.length) {
        outcome = 'fired_no_fills'
      } else {
        const wins   = realBets.filter(b => b.result === 'win').length
        const losses = realBets.filter(b => b.result === 'loss').length
        if (wins > losses)      outcome = 'net_win'
        else if (losses > wins) outcome = 'net_loss'
        else                    outcome = 'break_even'
      }
    }

    if (outcome && outcome !== entry.preflight_outcome) {
      await db.run(
        `UPDATE bet_schedule SET preflight_outcome = ? WHERE id = ?`,
        [outcome, entry.id],
      )
    }

    results.push({ ...entry, actualKs, outcome: outcome ?? entry.preflight_outcome })
  }

  return results
}

async function main() {
  await db.migrate()

  const dates = opts.all
    ? (await db.all(
        `SELECT DISTINCT bet_date FROM bet_schedule
         WHERE bet_date >= date('now', '-30 days')
         ORDER BY bet_date DESC`,
      )).map(r => r.bet_date)
    : [opts.date]

  let totalSkipped = 0, skipCorrect = 0, skipWouldWin = 0, skipPending = 0
  let totalFired   = 0, firedWin = 0, firedLoss = 0

  for (const date of dates) {
    const rows = await processDate(date)
    if (!rows.length) continue

    if (dates.length > 1) console.log(`\n── ${date} ─────────────────────────────────`)

    const skipped = rows.filter(r => r.status === 'skipped' || r.preflight === 'skip')
    const fired   = rows.filter(r => r.status === 'fired')

    if (skipped.length) {
      console.log(`\nSKIPPED (${skipped.length}):`)
      for (const r of skipped) {
        const ksStr = r.actualKs != null ? `actual=${r.actualKs}K` : 'unsettled'
        console.log(`  ${r.pitcher_name.padEnd(26)} ${(r.game_label||'').padEnd(15)} λ=${(r.lambda??'?').toString().padEnd(5)} ${ksStr.padEnd(12)} → ${r.outcome ?? '(pending)'}`)
      }
    }

    if (fired.length) {
      console.log(`\nFIRED (${fired.length}):`)
      for (const r of fired) {
        const ksStr = r.actualKs != null ? `actual=${r.actualKs}K` : 'unsettled'
        console.log(`  ${r.pitcher_name.padEnd(26)} ${(r.game_label||'').padEnd(15)} λ=${(r.lambda??'?').toString().padEnd(5)} ${ksStr.padEnd(12)} → ${r.outcome ?? '(pending)'}`)
      }
    }

    for (const r of skipped) {
      totalSkipped++
      if (r.outcome === 'pending' || !r.outcome) skipPending++
      else if (r.outcome === 'would_win')  skipWouldWin++
      else if (r.outcome === 'would_lose') skipCorrect++
    }
    for (const r of fired) {
      totalFired++
      if (r.outcome === 'net_win')  firedWin++
      if (r.outcome === 'net_loss') firedLoss++
    }
  }

  const settled = totalSkipped - skipPending
  console.log(`\n${'═'.repeat(55)}`)
  console.log(`PREFLIGHT RETROSPECTIVE  ${opts.all ? '(last 30 days)' : opts.date}`)
  console.log(`${'═'.repeat(55)}`)
  console.log(`Scheduled: ${totalSkipped + totalFired}  Fired: ${totalFired}  Skipped: ${totalSkipped}`)
  if (settled > 0) {
    const skipAccuracy = (skipCorrect / settled * 100).toFixed(0)
    const missedUpside = skipWouldWin
    console.log(`\nSkip accuracy:  ${skipCorrect}/${settled} (${skipAccuracy}%) — correctly avoided losers`)
    console.log(`Missed upside:  ${missedUpside} skips would have WON — opportunity cost`)
  }
  if (totalFired > 0) {
    const firedSettled = firedWin + firedLoss
    const fireRate = firedSettled > 0 ? (firedWin / firedSettled * 100).toFixed(0) : '?'
    console.log(`\nFire win rate:  ${firedWin}/${firedSettled} (${fireRate}%)`)
  }
  if (skipPending > 0) console.log(`\nPending (not yet settled): ${skipPending}`)
  console.log('')

  await db.close()
}

main().catch(err => { console.error(err); process.exit(1) })
