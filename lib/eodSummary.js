// Build the EOD summary payload consumed by lib/cageAlerts.js notifyEod.
// Splits the day's ks_bets activity into paper vs live, and within each
// breaks PnL by strategy_mode (pregame_normal, pregame_inversion, tier1/2/3).
// Designed to be called from the scheduler cron AND on-demand from an
// admin endpoint or CLI for testing.

import { all as dbAll, one as dbOne } from './db.js'
import {
  buildShadowReport, formatShadowDiscordLines,
  buildCalibratedYesReport, formatCalibratedYesDiscordLines,
  buildCalibrateKellyReport, formatCalibrateKellyDiscordLines,
  buildFullDistributionReport, formatFullDistributionDiscordLines,
} from './shadowInversion.js'
import { evaluateAllPending, formatPendingRuleLines } from './pendingRuleEvals.js'

const STRAT_PNL_SQL = (paper) => `
  SELECT
    COUNT(*) FILTER (WHERE order_id IS NOT NULL) AS fires,
    COUNT(*) FILTER (WHERE strategy_mode='pregame_cross_strike' AND order_id IS NOT NULL) AS cross_strike_fires,
    ROUND(SUM(pnl) FILTER (WHERE result IN ('win','loss')), 2) AS total_pnl,
    ROUND(SUM(pnl) FILTER (WHERE strategy_mode='pregame_inversion' AND result IN ('win','loss')), 2) AS inversion_pnl,
    ROUND(SUM(pnl) FILTER (WHERE strategy_mode='pregame_normal'    AND result IN ('win','loss')), 2) AS normal_pnl,
    ROUND(SUM(pnl) FILTER (WHERE strategy_mode='pregame_cross_strike' AND result IN ('win','loss')), 2) AS cross_strike_pnl,
    ROUND(SUM(pnl) FILTER (WHERE strategy_mode='tier1_confirmed_pull'  AND result IN ('win','loss')), 2) AS tier1_pnl,
    ROUND(SUM(pnl) FILTER (WHERE strategy_mode='tier2_dead_path'       AND result IN ('win','loss')), 2) AS tier2_pnl,
    ROUND(SUM(pnl) FILTER (WHERE strategy_mode='tier3_late_game_leash' AND result IN ('win','loss')), 2) AS tier3_pnl
  FROM ks_bets
  WHERE bet_date = ? AND paper = ${paper}
`

const TOP_RESULTS_SQL = (paper) => `
  SELECT pitcher_name, side, strike, strategy_mode, pnl, result
  FROM ks_bets
  WHERE bet_date = ? AND paper = ${paper} AND result IN ('win','loss')
  ORDER BY ABS(pnl) DESC
  LIMIT 6
`

function safeNum(n) { return Number.isFinite(Number(n)) ? Number(n) : 0 }

function rowToBucket(row) {
  if (!row) return null
  return {
    fires:              safeNum(row.fires),
    cross_strike_fires: safeNum(row.cross_strike_fires),
    total_pnl:          safeNum(row.total_pnl),
    inversion_pnl:      safeNum(row.inversion_pnl),
    normal_pnl:         safeNum(row.normal_pnl),
    cross_strike_pnl:   safeNum(row.cross_strike_pnl),
    tier1_pnl:          safeNum(row.tier1_pnl),
    tier2_pnl:          safeNum(row.tier2_pnl),
    tier3_pnl:          safeNum(row.tier3_pnl),
  }
}

function decideMode(live, paper) {
  const liveActive  = live  && live.fires  > 0
  const paperActive = paper && paper.fires > 0
  if (liveActive && paperActive) return 'mixed (live + paper)'
  if (liveActive)   return 'live (real money)'
  if (paperActive)  return 'paper (synthetic fills)'
  return 'no fires'
}

export async function buildEodSummary(date) {
  const liveRow  = await dbOne(STRAT_PNL_SQL(0), [date]).catch(() => null)
  const paperRow = await dbOne(STRAT_PNL_SQL(1), [date]).catch(() => null)
  const live  = rowToBucket(liveRow)  || { fires: 0 }
  const paper = rowToBucket(paperRow) || { fires: 0 }

  // Top winners/losers across whichever side actually fired
  const sourcePaper = paper.fires > 0 && live.fires === 0
  const topRows = await dbAll(TOP_RESULTS_SQL(sourcePaper ? 1 : 0), [date]).catch(() => [])
  const top_results = topRows.map(r => ({
    icon:  r.result === 'win' ? '✅' : '❌',
    label: `${r.pitcher_name} ${r.side}${r.strike}`,
    pnl:   safeNum(r.pnl),
  }))

  // Shadow inversion lines — survives errors silently so EOD always posts
  let shadow_lines = []
  try {
    const report = await buildShadowReport({ betDate: date })
    shadow_lines = formatShadowDiscordLines(report)
  } catch { /* shadow optional */ }

  // Calibrated-YES shadow lines — separate strategy, side-by-side comparison
  let calibrated_yes_lines = []
  try {
    const calReport = await buildCalibratedYesReport({ betDate: date })
    calibrated_yes_lines = formatCalibratedYesDiscordLines(calReport)
  } catch { /* shadow optional */ }

  // Calibrate-Kelly shadow lines — same fire decisions, calibrated sizing
  let calibrate_kelly_lines = []
  try {
    const ckReport = await buildCalibrateKellyReport({ betDate: date })
    calibrate_kelly_lines = formatCalibrateKellyDiscordLines(ckReport)
  } catch { /* shadow optional */ }

  // Full-distribution shadow lines — what blocked-by-filter candidates would have done
  let full_distribution_lines = []
  try {
    const fdReport = await buildFullDistributionReport({ betDate: date })
    full_distribution_lines = formatFullDistributionDiscordLines(fdReport)
  } catch { /* shadow optional */ }

  // Pending rule evaluations — update each candidate's running 14-day stats and report
  let pending_rule_lines = []
  try {
    await evaluateAllPending({ windowDays: 14 })
    pending_rule_lines = await formatPendingRuleLines()
  } catch { /* optional */ }

  return {
    mode: decideMode(live, paper),
    live,
    paper,
    top_results,
    shadow_lines,
    calibrated_yes_lines,
    calibrate_kelly_lines,
    full_distribution_lines,
    pending_rule_lines,
  }
}
