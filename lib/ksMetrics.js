// lib/ksMetrics.js — Extracted computation helpers for ks-analytics routes.
//
// P&L sourcing rule (see feedback_pnl_always_kalshi.md):
//   - All-time P&L: users.kalshi_pnl (running total from Kalshi fills + settlements)
//   - Period P&L (today/week/month/ytd): daily_pnl_events.pnl_usd (settled Kalshi amounts)
//   - Fallback only: SUM(ks_bets.pnl) when daily_pnl_events has no rows for the period
//   - W/L/streak/drawdown: ks_bets (result + order tracking, not P&L amounts)

/**
 * Sequential pass over ordered bet rows — compute drawdown and streaks.
 * seqRows: [{ pnl, result }] ordered by bet_date ASC, id ASC
 */
export function computeStreakAndDrawdown(seqRows, startingBankroll = 1000) {
  let running = startingBankroll
  let peak = startingBankroll
  let maxDd = 0, streak = 0, maxWinStreak = 0, maxLossStreak = 0

  for (const r of seqRows) {
    running += Number(r.pnl || 0)
    peak     = Math.max(peak, running)
    maxDd    = Math.min(maxDd, running - peak)
    if (r.result === 'win') {
      streak = streak >= 0 ? streak + 1 : 1
      maxWinStreak = Math.max(maxWinStreak, streak)
    } else {
      streak = streak <= 0 ? streak - 1 : -1
      maxLossStreak = Math.min(maxLossStreak, streak)
    }
  }

  return {
    running,
    peak,
    maxDrawdown:      maxDd,
    currentDrawdown:  running - peak,
    currentStreak:    streak,
    longestWinStreak: maxWinStreak,
    longestLossStreak: Math.abs(maxLossStreak),
  }
}

/**
 * Compute current win/loss streak from an array of result strings (most recent first).
 */
export function computeCurrentStreak(resultsNewestFirst) {
  let streak = 0
  for (const result of resultsNewestFirst) {
    if (result === 'win')       { if (streak >= 0) streak++; else break }
    else if (result === 'loss') { if (streak <= 0) streak--; else break }
    else break
  }
  return streak
}

/**
 * Query P&L by period from daily_pnl_events (canonical Kalshi settlement amounts).
 * Returns { today, week, month, ytd } P&L sums from confirmed Kalshi settlements.
 * When userId is null returns totals across all users.
 */
export async function getPnlFromDailyEvents(db, { userId, today, weekAgo, monthAgo, yearStart }) {
  const uCond = userId ? `AND user_id = ${Number(userId)}` : ''
  const rows = await db.all(
    `SELECT
       SUM(CASE WHEN date = '${today}' THEN pnl_usd ELSE 0 END)      AS today_pnl,
       SUM(CASE WHEN date >= '${weekAgo}' THEN pnl_usd ELSE 0 END)   AS week_pnl,
       SUM(CASE WHEN date >= '${monthAgo}' THEN pnl_usd ELSE 0 END)  AS month_pnl,
       SUM(CASE WHEN date >= '${yearStart}' THEN pnl_usd ELSE 0 END) AS ytd_pnl,
       COUNT(*) AS event_count
     FROM daily_pnl_events WHERE 1=1 ${uCond}`,
  ).catch(() => [])
  const r = rows[0] || {}
  return {
    today_pnl:   Number(r.today_pnl  || 0),
    week_pnl:    Number(r.week_pnl   || 0),
    month_pnl:   Number(r.month_pnl  || 0),
    ytd_pnl:     Number(r.ytd_pnl    || 0),
    event_count: Number(r.event_count || 0),
  }
}

/**
 * Query aggregate W/L/edge stats from ks_bets.
 * Returns wins, losses, settled, total_bets, avg_edge, total_wagered, expected_wins.
 */
export async function getKsBetAggregates(db, { userId, from, to, liveBet = 0, paper = 0 } = {}) {
  const clauses = [`live_bet = ${liveBet}`, "result IN ('win','loss')", `paper = ${paper}`]
  const args = []
  if (userId) { clauses.push('user_id = ?'); args.push(userId) }
  if (from)   { clauses.push('bet_date >= ?'); args.push(from) }
  if (to)     { clauses.push('bet_date <= ?'); args.push(to) }
  const where = clauses.join(' AND ')

  const row = await db.one(
    `SELECT
       COUNT(CASE WHEN result='win'  THEN 1 END)                                              AS wins,
       COUNT(CASE WHEN result='loss' THEN 1 END)                                              AS losses,
       COUNT(*)                                                                                AS settled,
       COALESCE(SUM(bet_size), 0)                                                             AS total_wagered,
       COALESCE(SUM(CASE WHEN side='YES' THEN model_prob ELSE 1-model_prob END), 0)           AS expected_wins,
       AVG(CASE WHEN result='win'  AND edge IS NOT NULL THEN edge END)                        AS avg_edge_wins,
       AVG(CASE WHEN result='loss' AND edge IS NOT NULL THEN edge END)                        AS avg_edge_losses,
       AVG(CASE WHEN edge IS NOT NULL THEN edge END)                                          AS avg_edge
     FROM ks_bets WHERE ${where}`,
    args,
  ).catch(() => null)

  return {
    wins:           Number(row?.wins           || 0),
    losses:         Number(row?.losses         || 0),
    settled:        Number(row?.settled        || 0),
    total_wagered:  Number(row?.total_wagered  || 0),
    expected_wins:  Number(row?.expected_wins  || 0),
    avg_edge:       row?.avg_edge       != null ? Number(row.avg_edge)       : null,
    avg_edge_wins:  row?.avg_edge_wins  != null ? Number(row.avg_edge_wins)  : null,
    avg_edge_losses:row?.avg_edge_losses!= null ? Number(row.avg_edge_losses): null,
  }
}
