// Shadow inversion audit — analytical-only rows that test what would happen
// at alternative gap thresholds (0.0, 0.2, 0.5) without placing real or paper
// orders. Production INVERT_L5_GAP_MIN stays at 0.5; this table just lets us
// see the counterfactual exposure and PnL.
//
// Two questions the data should answer:
//   1. Would lowering INVERT_L5_GAP_MIN produce signal or just dilution?
//      (compare median edge + ROI at 0.0 / 0.2 / 0.5)
//   2. Are real YES fires losing money specifically when the pitcher IS hot?
//      (i.e. should we BLOCK YES on hot streaks instead of inverting)
//
// Calibration buckets must stay in sync with scripts/live/ksBets.js
// _calibrateYesProb. If that table changes, mirror it here.

import * as db from './db.js'

export const SHADOW_THRESHOLDS = [0.0, 0.2, 0.5]
const SHADOW_BANKROLL = 1000          // reference bankroll for sizing — keeps shadow comparable across days regardless of real bettor balances
const SHADOW_KELLY_FRACTION = 0.25    // quarter Kelly to match production caution
const KALSHI_FEE_FRACTION = 0.07      // approximate per-contract fee, roughly Kalshi's 7% of mark price

function calibrateYesProb(p) {
  // Mirror of _calibrateYesProb in scripts/live/ksBets.js. Recalibrated
  // 2026-05-04 against new-engine selections after Rules 1-6.
  if (p < 0.42) return 0.53
  if (p < 0.52) return 0.33
  if (p < 0.65) return 0.39
  return 0.58
}

function buildShadowRow(c, threshold, betDate) {
  const yesMid     = Number(c.market_mid ?? 50)
  const spread     = Number(c.spread ?? 4)
  const halfSpread = spread / 2
  const origYesProb = Number(c.model_prob)
  const calYesProb  = calibrateYesProb(origYesProb)
  const noAskCents  = Math.min(99, Math.max(1, 100 - yesMid + halfSpread))
  const trueNoProb  = 1 - calYesProb
  const noEdge      = (yesMid / 100) - calYesProb
  const feePerContract = KALSHI_FEE_FRACTION * Math.min(noAskCents, 100 - noAskCents) / 100
  const feeAdjustedNoBreakeven = (noAskCents / 100) + feePerContract

  const k     = Number(c.strike)
  const l5    = Number(c.k9_l5 ?? 0)
  const career = Number(c.k9_career ?? 0)
  const gap   = career > 0 ? (l5 - career) : 0  // unknown career → treat as 0 gap (rookie / first-game pitcher)

  const inK   = k >= 5 && k <= 7
  const inGap = gap >= threshold
  const inMp  = origYesProb >= 0.50

  let wouldFire = false
  let skipReason = null
  if (!inK)        skipReason = `strike ${k} outside [5,7]`
  else if (!inGap) skipReason = `l5_gap ${gap.toFixed(2)} below ${threshold}`
  else if (!inMp)  skipReason = `model_prob ${origYesProb.toFixed(3)} < 0.50`
  else if (noEdge <= 0) skipReason = `negative no_edge ${noEdge.toFixed(3)}`
  else if (trueNoProb < feeAdjustedNoBreakeven) skipReason = `fee-adjusted breakeven not cleared`
  else wouldFire = true

  let proposedKellySize = 0
  if (wouldFire) {
    const noAsk = noAskCents / 100
    const b = (1 - noAsk) / noAsk          // profit per dollar at risk if NO wins
    const fullKelly = (b * trueNoProb - calYesProb) / b
    if (fullKelly > 0) {
      proposedKellySize = Math.round(fullKelly * SHADOW_KELLY_FRACTION * SHADOW_BANKROLL * 100) / 100
    } else {
      wouldFire = false
      skipReason = 'kelly fraction non-positive after fees'
    }
  }

  return {
    bet_date:     betDate,
    pitcher_id:   c.pitcher_id ? String(c.pitcher_id) : null,
    pitcher_name: c.pitcher,
    strike:       k,
    threshold,
    original_side: 'YES',
    ticker:       c.ticker ?? null,
    l5_k9:        l5,
    career_k9:    career,
    l5_gap:       Math.round(gap * 100) / 100,
    model_prob:   origYesProb,
    calibrated_yes_prob: calYesProb,
    yes_mid:      yesMid,
    spread,
    no_ask_reconstructed:      Math.round(noAskCents * 10) / 10,
    fee_adjusted_no_breakeven: Math.round(feeAdjustedNoBreakeven * 1000) / 1000,
    proposed_no_edge:          Math.round(noEdge * 1000) / 1000,
    proposed_kelly_size:       proposedKellySize,
    would_fire:                wouldFire ? 1 : 0,
    would_fire_reason:         wouldFire
      ? `gap=${gap.toFixed(2)}≥${threshold}, edge=${noEdge.toFixed(3)}, kelly=$${proposedKellySize}`
      : null,
    would_skip_reason:         skipReason,
    created_at:                new Date().toISOString(),
  }
}

// Record one shadow row per (candidate × threshold) for every YES candidate.
// Called from ksBets.js after the production inversion logic, but BEFORE
// sizing/placement — we want to see all candidates regardless of whether
// production fires.
export async function recordShadowCandidates({ betDate, candidates }) {
  if (!candidates?.length) return 0
  let count = 0
  for (const c of candidates) {
    if (c.side !== 'YES' && c._inverted !== true) continue
    // For inverted candidates the side has already been flipped to NO; reconstruct
    // the original YES context from _original_yes_prob if present.
    const candidateForShadow = c._inverted
      ? { ...c, side: 'YES', model_prob: c._original_yes_prob ?? c.model_prob }
      : c
    for (const t of SHADOW_THRESHOLDS) {
      const row = buildShadowRow(candidateForShadow, t, betDate)
      try {
        await db.run(
          `INSERT INTO shadow_inversion
             (bet_date, pitcher_id, pitcher_name, strike, threshold, original_side, ticker,
              l5_k9, career_k9, l5_gap, model_prob, calibrated_yes_prob,
              yes_mid, spread, no_ask_reconstructed, fee_adjusted_no_breakeven,
              proposed_no_edge, proposed_kelly_size,
              would_fire, would_fire_reason, would_skip_reason, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(bet_date, pitcher_name, strike, threshold) DO UPDATE SET
             model_prob          = excluded.model_prob,
             calibrated_yes_prob = excluded.calibrated_yes_prob,
             yes_mid             = excluded.yes_mid,
             spread              = excluded.spread,
             no_ask_reconstructed= excluded.no_ask_reconstructed,
             fee_adjusted_no_breakeven = excluded.fee_adjusted_no_breakeven,
             proposed_no_edge    = excluded.proposed_no_edge,
             proposed_kelly_size = excluded.proposed_kelly_size,
             would_fire          = excluded.would_fire,
             would_fire_reason   = excluded.would_fire_reason,
             would_skip_reason   = excluded.would_skip_reason`,
          [row.bet_date, row.pitcher_id, row.pitcher_name, row.strike, row.threshold, row.original_side, row.ticker,
           row.l5_k9, row.career_k9, row.l5_gap, row.model_prob, row.calibrated_yes_prob,
           row.yes_mid, row.spread, row.no_ask_reconstructed, row.fee_adjusted_no_breakeven,
           row.proposed_no_edge, row.proposed_kelly_size,
           row.would_fire, row.would_fire_reason, row.would_skip_reason, row.created_at],
        )
        count++
      } catch (err) {
        console.warn(`[shadow] insert failed for ${row.pitcher_name} K${row.strike} @ ${t}: ${err.message}`)
      }
    }
  }
  return count
}

// After the production settle path populates ks_bets.actual_ks, walk every
// unsettled shadow row and compute the shadow PnL using actual_ks.
// NO bet wins when actual_ks < strike, loses when actual_ks >= strike.
export async function settleShadowDay({ betDate }) {
  const rows = await db.all(
    `SELECT id, pitcher_name, strike, no_ask_reconstructed, proposed_kelly_size, would_fire
     FROM shadow_inversion
     WHERE bet_date = ? AND result IS NULL`,
    [betDate],
  ).catch(() => [])
  if (!rows.length) return 0

  const ksRows = await db.all(
    `SELECT pitcher_name, MAX(actual_ks) AS actual_ks
     FROM ks_bets WHERE bet_date = ? AND actual_ks IS NOT NULL
     GROUP BY pitcher_name`,
    [betDate],
  ).catch(() => [])
  const actualKsByPitcher = new Map(ksRows.map(r => [r.pitcher_name, r.actual_ks]))

  let updated = 0
  for (const r of rows) {
    const actualKs = actualKsByPitcher.get(r.pitcher_name)
    if (actualKs == null) continue

    let result, shadowPnl = 0
    if (r.would_fire) {
      const noAsk = (r.no_ask_reconstructed ?? 50) / 100
      if (actualKs < r.strike) {
        // NO won: collect (1 - noAsk)/noAsk per dollar risked, minus fees
        const profitFraction = (1 - noAsk) / noAsk * (1 - KALSHI_FEE_FRACTION)
        result = 'win'
        shadowPnl = Math.round((r.proposed_kelly_size ?? 0) * profitFraction * 100) / 100
      } else {
        result = 'loss'
        shadowPnl = -(r.proposed_kelly_size ?? 0)
      }
    } else {
      result = 'no_fire'
      shadowPnl = 0
    }

    await db.run(
      `UPDATE shadow_inversion
       SET actual_ks = ?, result = ?, shadow_pnl = ?, settled_at = ?
       WHERE id = ?`,
      [actualKs, result, shadowPnl, new Date().toISOString(), r.id],
    ).catch(() => {})
    updated++
  }
  return updated
}

function median(arr) {
  if (!arr.length) return null
  const s = [...arr].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}
function quantile(arr, q) {
  if (!arr.length) return null
  const s = [...arr].sort((a, b) => a - b)
  const idx = Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))
  return s[idx]
}

// Single-day shadow report. Returns per-threshold stats and YES-hot buckets.
export async function buildShadowReport({ betDate }) {
  const thresholds = []
  for (const t of SHADOW_THRESHOLDS) {
    const all = await db.all(
      `SELECT proposed_no_edge, proposed_kelly_size, shadow_pnl, would_fire, result, pitcher_name
       FROM shadow_inversion WHERE bet_date = ? AND threshold = ?`,
      [betDate, t],
    ).catch(() => [])

    const fires    = all.filter(r => r.would_fire === 1)
    const fireEdges = fires.map(r => Number(r.proposed_no_edge))
    const wins     = fires.filter(r => r.result === 'win').length
    const losses   = fires.filter(r => r.result === 'loss').length
    const totalPnl = fires.reduce((s, r) => s + Number(r.shadow_pnl ?? 0), 0)
    const totalRisk = fires.reduce((s, r) => s + Number(r.proposed_kelly_size ?? 0), 0)
    const distinctPitchers = new Set(fires.map(r => r.pitcher_name)).size
    const concentration = fires.reduce((m, r) => {
      m.set(r.pitcher_name, (m.get(r.pitcher_name) ?? 0) + 1)
      return m
    }, new Map())
    const maxConcentration = [...concentration.values()].reduce((a, b) => Math.max(a, b), 0)

    thresholds.push({
      threshold:    t,
      candidates:   all.length,
      would_fire:   fires.length,
      avg_edge:     fireEdges.length ? Math.round((fireEdges.reduce((s, x) => s + x, 0) / fireEdges.length) * 1000) / 1000 : null,
      median_edge:  fireEdges.length ? Math.round(median(fireEdges) * 1000) / 1000 : null,
      p25_edge:     fireEdges.length ? Math.round(quantile(fireEdges, 0.25) * 1000) / 1000 : null,
      p75_edge:     fireEdges.length ? Math.round(quantile(fireEdges, 0.75) * 1000) / 1000 : null,
      kelly_zero:   all.filter(r => r.would_fire === 0 && r.proposed_kelly_size === 0).length,
      wins, losses,
      total_pnl:    Math.round(totalPnl * 100) / 100,
      total_risk:   Math.round(totalRisk * 100) / 100,
      roi_pct:      totalRisk > 0 ? Math.round((totalPnl / totalRisk) * 1000) / 10 : null,
      distinct_pitchers:   distinctPitchers,
      max_concentration:   maxConcentration,
    })
  }

  // YES-hot audit: aggregate real YES fires by gap bucket.
  // CASE expression must stay sortable (string buckets sort wrong by default).
  const yesHotRows = await db.all(
    `SELECT
       CASE
         WHEN (k9_l5 - k9_career) < 0 THEN '<0'
         WHEN (k9_l5 - k9_career) < 0.2 THEN '0.0-0.2'
         WHEN (k9_l5 - k9_career) < 0.5 THEN '0.2-0.5'
         ELSE '0.5+'
       END AS bucket,
       COUNT(*) AS n,
       SUM(CASE WHEN result='win' THEN 1 ELSE 0 END) AS wins,
       SUM(CASE WHEN result='loss' THEN 1 ELSE 0 END) AS losses,
       ROUND(SUM(pnl), 2) AS pnl,
       ROUND(SUM(capital_at_risk), 2) AS risk,
       ROUND(AVG(model_prob), 3) AS avg_mp,
       ROUND(AVG(market_mid), 1) AS avg_mid
     FROM ks_bets
     WHERE bet_date = ? AND live_bet = 0 AND side = 'YES'
       AND k9_l5 IS NOT NULL AND k9_career IS NOT NULL AND k9_career > 0
     GROUP BY bucket`,
    [betDate],
  ).catch(() => [])
  const order = { '<0': 0, '0.0-0.2': 1, '0.2-0.5': 2, '0.5+': 3 }
  yesHotRows.sort((a, b) => (order[a.bucket] ?? 99) - (order[b.bucket] ?? 99))
  for (const r of yesHotRows) {
    r.win_rate    = r.n > 0 ? Math.round((r.wins / r.n) * 1000) / 10 : null
    r.roi_pct     = r.risk > 0 ? Math.round((r.pnl / r.risk) * 1000) / 10 : null
    r.calibrated_yes_prob = calibrateYesProb(Number(r.avg_mp))
  }

  return {
    date:    betDate,
    thresholds,
    yes_hot: yesHotRows,
  }
}

// Compact one-line summary for Discord EOD post.
export function formatShadowDiscordLines(report) {
  const lines = []
  for (const t of report.thresholds) {
    const fired = `${t.would_fire} fires`
    const pnl   = `${t.total_pnl >= 0 ? '+' : ''}$${t.total_pnl.toFixed(2)}`
    const med   = t.median_edge != null ? `med edge ${(t.median_edge * 100).toFixed(0)}¢` : 'no fires'
    lines.push(`gap≥${t.threshold}: ${fired}, ${pnl}, ${med}`)
  }
  // YES-hot summary: highlight the >=0.5 bucket since that's the danger zone
  const hot = report.yes_hot.find(b => b.bucket === '0.5+')
  if (hot) {
    const sign = hot.pnl >= 0 ? '+' : ''
    lines.push(`YES-hot gap≥0.5: ${hot.n} real YES, ${sign}$${hot.pnl.toFixed(2)} (win ${hot.win_rate}%)`)
  }
  return lines
}

// ── Calibrated-YES shadow ─────────────────────────────────────────────────────
// Question this answers: would calibrated-YES selection (fire YES only when
// calibrated_yes_prob beats yes_ask + fees by some margin) outperform raw-YES
// firing? Same plumbing pattern as inversion shadow: record per candidate ×
// edge_threshold, settle when ks_bets has actual_ks, report alongside.

export const CALIBRATED_YES_EDGE_THRESHOLDS = [0.0, 0.03, 0.05]

function buildCalibratedYesRow(c, edgeThreshold, betDate) {
  const yesMid     = Number(c.market_mid ?? 50)
  const spread     = Number(c.spread ?? 4)
  const halfSpread = spread / 2
  const yesAskCents = Math.min(99, Math.max(1, yesMid + halfSpread))
  const rawProb    = Number(c.model_prob)
  const calProb    = calibrateYesProb(rawProb)
  const feePerContract = KALSHI_FEE_FRACTION * Math.min(yesAskCents, 100 - yesAskCents) / 100
  const feeAdjustedYesBreakeven = (yesAskCents / 100) + feePerContract

  const rawEdge        = rawProb - (yesMid / 100)
  const calibratedEdge = calProb - (yesAskCents / 100)
  const feeAdjustedEdge = calProb - feeAdjustedYesBreakeven

  const k = Number(c.strike)
  // YES range slightly wider than inversion's [5,7] — high-strike YES is plausible
  // when calibration is the gate, so allow [5,9].
  const inK = k >= 5 && k <= 9

  let wouldFire = false
  let skipReason = null
  if (!inK)                                       skipReason = `strike ${k} outside [5,9]`
  else if (calProb <= 0)                          skipReason = 'calibrated prob non-positive'
  else if (feeAdjustedEdge < edgeThreshold)       skipReason = `fee-adjusted edge ${feeAdjustedEdge.toFixed(3)} < ${edgeThreshold}`
  else wouldFire = true

  let proposedKellySize = 0
  if (wouldFire) {
    const yesAsk = yesAskCents / 100
    const b = (1 - yesAsk) / yesAsk     // profit per dollar at risk if YES wins
    const fullKelly = (b * calProb - (1 - calProb)) / b
    if (fullKelly > 0) {
      proposedKellySize = Math.round(fullKelly * SHADOW_KELLY_FRACTION * SHADOW_BANKROLL * 100) / 100
    } else {
      wouldFire = false
      skipReason = 'kelly fraction non-positive after fees'
    }
  }

  return {
    bet_date:     betDate,
    pitcher_id:   c.pitcher_id ? String(c.pitcher_id) : null,
    pitcher_name: c.pitcher,
    strike:       k,
    edge_threshold: edgeThreshold,
    ticker:       c.ticker ?? null,
    raw_model_prob:      rawProb,
    calibrated_yes_prob: calProb,
    yes_mid:             yesMid,
    spread,
    yes_ask:             Math.round(yesAskCents * 10) / 10,
    fee_adjusted_yes_breakeven:    Math.round(feeAdjustedYesBreakeven * 1000) / 1000,
    raw_edge:                      Math.round(rawEdge * 1000) / 1000,
    calibrated_edge:               Math.round(calibratedEdge * 1000) / 1000,
    fee_adjusted_calibrated_edge:  Math.round(feeAdjustedEdge * 1000) / 1000,
    would_fire:           wouldFire ? 1 : 0,
    would_fire_reason:    wouldFire
      ? `cal_prob=${calProb.toFixed(2)} clears yes_ask+fees by ${(feeAdjustedEdge * 100).toFixed(1)}¢, kelly=$${proposedKellySize}`
      : null,
    would_skip_reason:    skipReason,
    proposed_kelly_size:  proposedKellySize,
    created_at:           new Date().toISOString(),
  }
}

export async function recordCalibratedYesCandidates({ betDate, candidates }) {
  if (!candidates?.length) return 0
  let count = 0
  for (const c of candidates) {
    if (c.side !== 'YES' && c._inverted !== true) continue
    const candidateForShadow = c._inverted
      ? { ...c, side: 'YES', model_prob: c._original_yes_prob ?? c.model_prob }
      : c
    for (const t of CALIBRATED_YES_EDGE_THRESHOLDS) {
      const row = buildCalibratedYesRow(candidateForShadow, t, betDate)
      try {
        await db.run(
          `INSERT INTO shadow_calibrated_yes
             (bet_date, pitcher_id, pitcher_name, strike, edge_threshold, ticker,
              raw_model_prob, calibrated_yes_prob, yes_mid, spread, yes_ask,
              fee_adjusted_yes_breakeven, raw_edge, calibrated_edge, fee_adjusted_calibrated_edge,
              would_fire, would_fire_reason, would_skip_reason, proposed_kelly_size, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(bet_date, pitcher_name, strike, edge_threshold) DO UPDATE SET
             raw_model_prob              = excluded.raw_model_prob,
             calibrated_yes_prob         = excluded.calibrated_yes_prob,
             yes_mid                     = excluded.yes_mid,
             spread                      = excluded.spread,
             yes_ask                     = excluded.yes_ask,
             fee_adjusted_yes_breakeven  = excluded.fee_adjusted_yes_breakeven,
             raw_edge                    = excluded.raw_edge,
             calibrated_edge             = excluded.calibrated_edge,
             fee_adjusted_calibrated_edge= excluded.fee_adjusted_calibrated_edge,
             would_fire                  = excluded.would_fire,
             would_fire_reason           = excluded.would_fire_reason,
             would_skip_reason           = excluded.would_skip_reason,
             proposed_kelly_size         = excluded.proposed_kelly_size`,
          [row.bet_date, row.pitcher_id, row.pitcher_name, row.strike, row.edge_threshold, row.ticker,
           row.raw_model_prob, row.calibrated_yes_prob, row.yes_mid, row.spread, row.yes_ask,
           row.fee_adjusted_yes_breakeven, row.raw_edge, row.calibrated_edge, row.fee_adjusted_calibrated_edge,
           row.would_fire, row.would_fire_reason, row.would_skip_reason, row.proposed_kelly_size, row.created_at],
        )
        count++
      } catch (err) {
        console.warn(`[shadow-cal-yes] insert failed for ${row.pitcher_name} K${row.strike} @ ${t}: ${err.message}`)
      }
    }
  }
  return count
}

export async function settleCalibratedYesDay({ betDate }) {
  const rows = await db.all(
    `SELECT id, pitcher_name, strike, yes_ask, proposed_kelly_size, would_fire
     FROM shadow_calibrated_yes
     WHERE bet_date = ? AND result IS NULL`,
    [betDate],
  ).catch(() => [])
  if (!rows.length) return 0

  const ksRows = await db.all(
    `SELECT pitcher_name, MAX(actual_ks) AS actual_ks
     FROM ks_bets WHERE bet_date = ? AND actual_ks IS NOT NULL
     GROUP BY pitcher_name`,
    [betDate],
  ).catch(() => [])
  const actualKsByPitcher = new Map(ksRows.map(r => [r.pitcher_name, r.actual_ks]))

  let updated = 0
  for (const r of rows) {
    const actualKs = actualKsByPitcher.get(r.pitcher_name)
    if (actualKs == null) continue

    let result, shadowPnl = 0
    if (r.would_fire) {
      const yesAsk = (r.yes_ask ?? 50) / 100
      // YES wins when actual_ks ≥ strike
      if (actualKs >= r.strike) {
        const profitFraction = (1 - yesAsk) / yesAsk * (1 - KALSHI_FEE_FRACTION)
        result = 'win'
        shadowPnl = Math.round((r.proposed_kelly_size ?? 0) * profitFraction * 100) / 100
      } else {
        result = 'loss'
        shadowPnl = -(r.proposed_kelly_size ?? 0)
      }
    } else {
      result = 'no_fire'
      shadowPnl = 0
    }

    await db.run(
      `UPDATE shadow_calibrated_yes
       SET actual_ks = ?, result = ?, shadow_pnl = ?, settled_at = ?
       WHERE id = ?`,
      [actualKs, result, shadowPnl, new Date().toISOString(), r.id],
    ).catch(() => {})
    updated++
  }
  return updated
}

export async function buildCalibratedYesReport({ betDate }) {
  const thresholds = []
  for (const t of CALIBRATED_YES_EDGE_THRESHOLDS) {
    const all = await db.all(
      `SELECT calibrated_edge, fee_adjusted_calibrated_edge, proposed_kelly_size, shadow_pnl, would_fire, result, pitcher_name
       FROM shadow_calibrated_yes WHERE bet_date = ? AND edge_threshold = ?`,
      [betDate, t],
    ).catch(() => [])

    const fires    = all.filter(r => r.would_fire === 1)
    const fireEdges = fires.map(r => Number(r.fee_adjusted_calibrated_edge))
    const wins     = fires.filter(r => r.result === 'win').length
    const losses   = fires.filter(r => r.result === 'loss').length
    const totalPnl = fires.reduce((s, r) => s + Number(r.shadow_pnl ?? 0), 0)
    const totalRisk = fires.reduce((s, r) => s + Number(r.proposed_kelly_size ?? 0), 0)
    const distinctPitchers = new Set(fires.map(r => r.pitcher_name)).size

    thresholds.push({
      edge_threshold: t,
      candidates:     all.length,
      would_fire:     fires.length,
      avg_edge:       fireEdges.length ? Math.round((fireEdges.reduce((s, x) => s + x, 0) / fireEdges.length) * 1000) / 1000 : null,
      median_edge:    fireEdges.length ? Math.round(median(fireEdges) * 1000) / 1000 : null,
      p25_edge:       fireEdges.length ? Math.round(quantile(fireEdges, 0.25) * 1000) / 1000 : null,
      p75_edge:       fireEdges.length ? Math.round(quantile(fireEdges, 0.75) * 1000) / 1000 : null,
      wins, losses,
      total_pnl:      Math.round(totalPnl * 100) / 100,
      total_risk:     Math.round(totalRisk * 100) / 100,
      roi_pct:        totalRisk > 0 ? Math.round((totalPnl / totalRisk) * 1000) / 10 : null,
      distinct_pitchers: distinctPitchers,
    })
  }
  return { date: betDate, thresholds }
}

export function formatCalibratedYesDiscordLines(report) {
  const lines = []
  for (const t of report.thresholds) {
    const fired = `${t.would_fire} fires`
    const pnl   = `${t.total_pnl >= 0 ? '+' : ''}$${t.total_pnl.toFixed(2)}`
    const med   = t.median_edge != null ? `med edge ${(t.median_edge * 100).toFixed(1)}¢` : 'no fires'
    lines.push(`edge≥${t.edge_threshold}: ${fired}, ${pnl}, ${med}`)
  }
  return lines
}

// ── Calibrate-Kelly shadow ───────────────────────────────────────────────────
// Question this answers: would feeding calibrated_yes_prob into Kelly (instead
// of raw model_prob) have improved sizing? One row per actual YES fire — same
// fire/skip decision, same outcome, just resized. At settle, alt-PnL uses the
// same actual_ks but applies it to the calibrated size.
//
// Yesterday's pattern: Civale at $35 raw vs ~$15 calibrated would have cut a
// $35 loss to a $15 loss; -$7 day → +$13 day.

export async function recordCalibrateKellyShadow({ ks_bet_id, betDate, userId, pitcherName, strike, side, modelProb, marketMid, spread, bankroll, kellyFraction, capitalAtRisk }) {
  if (side !== 'YES') return null
  const halfSpread = Number(spread ?? 4) / 2
  const yesAskCents = Math.min(99, Math.max(1, Number(marketMid ?? 50) + halfSpread))
  const yesAsk = yesAskCents / 100
  const calProb = calibrateYesProb(Number(modelProb))

  // Calibrated Kelly with same fee/spread assumption — quarter-Kelly to match
  // production posture (production also uses fractional-Kelly via capScale).
  const b = (1 - yesAsk) / yesAsk
  const fullKelly = (b * calProb - (1 - calProb)) / b
  let calibratedKellyFraction = 0
  let calibratedSize = 0
  if (fullKelly > 0) {
    calibratedKellyFraction = Math.max(0, fullKelly * SHADOW_KELLY_FRACTION)
    calibratedSize = Math.round(calibratedKellyFraction * Number(bankroll ?? SHADOW_BANKROLL) * 100) / 100
  }

  try {
    await db.run(
      `INSERT INTO shadow_calibrate_kelly
         (ks_bet_id, bet_date, user_id, pitcher_name, strike, side,
          bankroll_used, raw_model_prob, calibrated_yes_prob, yes_ask,
          raw_kelly_fraction, raw_size,
          calibrated_kelly_fraction, calibrated_size, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(ks_bet_id) DO UPDATE SET
         raw_model_prob              = excluded.raw_model_prob,
         calibrated_yes_prob         = excluded.calibrated_yes_prob,
         yes_ask                     = excluded.yes_ask,
         raw_kelly_fraction          = excluded.raw_kelly_fraction,
         raw_size                    = excluded.raw_size,
         calibrated_kelly_fraction   = excluded.calibrated_kelly_fraction,
         calibrated_size             = excluded.calibrated_size`,
      [ks_bet_id, betDate, userId, pitcherName, strike, side,
       bankroll, modelProb, calProb, yesAsk,
       kellyFraction, capitalAtRisk,
       calibratedKellyFraction, calibratedSize, new Date().toISOString()],
    )
  } catch (err) {
    console.warn(`[shadow-calK] insert failed for ks_bet_id=${ks_bet_id}: ${err.message}`)
  }
  return { calibratedKellyFraction, calibratedSize }
}

export async function settleCalibrateKellyDay({ betDate }) {
  const rows = await db.all(
    `SELECT s.ks_bet_id, s.calibrated_size, s.yes_ask, b.actual_ks, b.result, b.pnl AS raw_pnl, s.strike
     FROM shadow_calibrate_kelly s
     JOIN ks_bets b ON b.id = s.ks_bet_id
     WHERE s.bet_date = ? AND s.result IS NULL AND b.result IS NOT NULL`,
    [betDate],
  ).catch(() => [])
  if (!rows.length) return 0

  let updated = 0
  for (const r of rows) {
    const actualKs = r.actual_ks
    const yesAsk = Number(r.yes_ask ?? 0.5)
    const calSize = Number(r.calibrated_size ?? 0)
    let calPnl = 0
    if (calSize <= 0) {
      // calibrate-Kelly said skip → no exposure → 0 pnl
      calPnl = 0
    } else if (r.result === 'win') {
      // YES won at the same outcome — calibrated bet wins same proportion
      const profitFraction = (1 - yesAsk) / yesAsk * (1 - KALSHI_FEE_FRACTION)
      calPnl = Math.round(calSize * profitFraction * 100) / 100
    } else if (r.result === 'loss') {
      calPnl = -calSize
    } else {
      calPnl = 0
    }
    await db.run(
      `UPDATE shadow_calibrate_kelly
       SET actual_ks = ?, result = ?, raw_pnl = ?, calibrated_pnl = ?, settled_at = ?
       WHERE ks_bet_id = ?`,
      [actualKs, r.result, Number(r.raw_pnl ?? 0), calPnl, new Date().toISOString(), r.ks_bet_id],
    ).catch(() => {})
    updated++
  }
  return updated
}

export async function buildCalibrateKellyReport({ betDate }) {
  const rows = await db.all(
    `SELECT pitcher_name, strike, user_id, raw_size, calibrated_size,
            raw_pnl, calibrated_pnl, result
     FROM shadow_calibrate_kelly
     WHERE bet_date = ?`,
    [betDate],
  ).catch(() => [])

  const settled = rows.filter(r => r.result != null)
  const skippedByCal = rows.filter(r => Number(r.calibrated_size) === 0).length

  const totalRawSize  = rows.reduce((s, r) => s + Number(r.raw_size ?? 0), 0)
  const totalCalSize  = rows.reduce((s, r) => s + Number(r.calibrated_size ?? 0), 0)
  const totalRawPnl   = settled.reduce((s, r) => s + Number(r.raw_pnl ?? 0), 0)
  const totalCalPnl   = settled.reduce((s, r) => s + Number(r.calibrated_pnl ?? 0), 0)

  return {
    date:             betDate,
    fires:            rows.length,
    settled:          settled.length,
    skipped_by_cal:   skippedByCal,
    total_raw_size:   Math.round(totalRawSize * 100) / 100,
    total_cal_size:   Math.round(totalCalSize * 100) / 100,
    size_reduction_pct: totalRawSize > 0 ? Math.round((1 - totalCalSize / totalRawSize) * 1000) / 10 : null,
    total_raw_pnl:    Math.round(totalRawPnl * 100) / 100,
    total_cal_pnl:    Math.round(totalCalPnl * 100) / 100,
    swing:            Math.round((totalCalPnl - totalRawPnl) * 100) / 100,
    rows,
  }
}

export function formatCalibrateKellyDiscordLines(report) {
  if (report.fires === 0) return []
  const lines = []
  const sizeRed = report.size_reduction_pct != null ? ` (${report.size_reduction_pct}% smaller)` : ''
  lines.push(`raw: $${report.total_raw_size.toFixed(0)} risk → ${report.total_raw_pnl >= 0 ? '+' : ''}$${report.total_raw_pnl.toFixed(2)}`)
  lines.push(`cal-Kelly: $${report.total_cal_size.toFixed(0)} risk${sizeRed} → ${report.total_cal_pnl >= 0 ? '+' : ''}$${report.total_cal_pnl.toFixed(2)}`)
  const swingSign = report.swing >= 0 ? '+' : ''
  lines.push(`swing: ${swingSign}$${report.swing.toFixed(2)} (${report.skipped_by_cal} of ${report.fires} would have been zero-sized)`)
  return lines
}

// ── Full-distribution shadow ─────────────────────────────────────────────────
// One row per (pitcher × strike × side) the model can score. Captures
// whether production filters allowed the bet, the calibrated edge, and the
// actual outcome — so we can answer: of the candidates currently blocked,
// how many had positive calibrated edge and what would PnL have been?
//
// Settle math:
//   YES wins when actual_ks >= strike
//   NO  wins when actual_ks <  strike
//   Otherwise loses (we treat exact-match as YES win per Kalshi convention).

export async function recordFullDistribution({
  betDate, pitcherId, pitcherName, strike, side, ticker,
  lambda, pitcherNbR, rawModelProb,
  yesBid, yesAsk, noBid, noAsk, marketMid, spread,
  productionAllowed, productionFilterReason,
}) {
  const calProb = calibrateYesProb(Number(rawModelProb))
  const yesAskFrac = Number(yesAsk ?? 50) / 100
  const noAskFrac  = Number(noAsk ?? 50) / 100
  const trueProbForSide = side === 'YES' ? calProb : (1 - calProb)
  const askForSide = side === 'YES' ? yesAskFrac : noAskFrac

  const rawEdge = side === 'YES'
    ? Number(rawModelProb) - yesAskFrac
    : (1 - Number(rawModelProb)) - noAskFrac
  const calibratedEdge = trueProbForSide - askForSide

  // Kelly size on calibrated edge — only fires if edge > 3% after fees
  const FEE = 0.07
  const feePerContract = FEE * Math.min(askForSide, 1 - askForSide)
  const feeAdjustedEdge = trueProbForSide - askForSide - feePerContract
  let proposedKellySize = 0
  if (feeAdjustedEdge > 0.03 && askForSide > 0 && askForSide < 1) {
    const b = (1 - askForSide) / askForSide
    const fullKelly = (b * trueProbForSide - (1 - trueProbForSide)) / b
    if (fullKelly > 0) {
      proposedKellySize = Math.round(fullKelly * SHADOW_KELLY_FRACTION * SHADOW_BANKROLL * 100) / 100
    }
  }

  try {
    await db.run(
      `INSERT INTO shadow_full_distribution
         (bet_date, pitcher_id, pitcher_name, strike, side, ticker,
          lambda, pitcher_nb_r, raw_model_prob, calibrated_yes_prob,
          yes_bid, yes_ask, no_bid, no_ask, market_mid, spread,
          raw_edge, calibrated_edge,
          production_allowed, production_filter_reason, proposed_kelly_size,
          created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(bet_date, pitcher_name, strike, side) DO UPDATE SET
         raw_model_prob          = excluded.raw_model_prob,
         calibrated_yes_prob     = excluded.calibrated_yes_prob,
         yes_bid                 = excluded.yes_bid,
         yes_ask                 = excluded.yes_ask,
         no_bid                  = excluded.no_bid,
         no_ask                  = excluded.no_ask,
         market_mid              = excluded.market_mid,
         spread                  = excluded.spread,
         raw_edge                = excluded.raw_edge,
         calibrated_edge         = excluded.calibrated_edge,
         production_allowed      = excluded.production_allowed,
         production_filter_reason= excluded.production_filter_reason,
         proposed_kelly_size     = excluded.proposed_kelly_size`,
      [betDate, pitcherId ? String(pitcherId) : null, pitcherName, strike, side, ticker ?? null,
       lambda, pitcherNbR, rawModelProb, calProb,
       yesBid, yesAsk, noBid, noAsk, marketMid, spread,
       Math.round(rawEdge * 1000) / 1000, Math.round(calibratedEdge * 1000) / 1000,
       productionAllowed ? 1 : 0, productionFilterReason ?? null, proposedKellySize,
       new Date().toISOString()],
    )
  } catch (err) {
    console.warn(`[shadow-fd] insert failed for ${pitcherName} K${strike} ${side}: ${err.message}`)
  }
}

export async function settleFullDistributionDay({ betDate }) {
  const rows = await db.all(
    `SELECT id, pitcher_name, strike, side, yes_ask, no_ask, proposed_kelly_size
     FROM shadow_full_distribution
     WHERE bet_date = ? AND result IS NULL`,
    [betDate],
  ).catch(() => [])
  if (!rows.length) return 0

  const ksRows = await db.all(
    `SELECT pitcher_name, MAX(actual_ks) AS actual_ks
     FROM ks_bets WHERE bet_date = ? AND actual_ks IS NOT NULL
     GROUP BY pitcher_name`,
    [betDate],
  ).catch(() => [])
  const actualKsByPitcher = new Map(ksRows.map(r => [r.pitcher_name, r.actual_ks]))

  let updated = 0
  for (const r of rows) {
    const actualKs = actualKsByPitcher.get(r.pitcher_name)
    if (actualKs == null) continue

    const sideWon = r.side === 'YES' ? actualKs >= r.strike : actualKs < r.strike
    const result = sideWon ? 'win' : 'loss'

    let shadowPnl = 0
    if (Number(r.proposed_kelly_size) > 0) {
      const askFrac = (r.side === 'YES' ? Number(r.yes_ask ?? 50) : Number(r.no_ask ?? 50)) / 100
      if (sideWon) {
        const profitFraction = (1 - askFrac) / askFrac * (1 - KALSHI_FEE_FRACTION)
        shadowPnl = Math.round(Number(r.proposed_kelly_size) * profitFraction * 100) / 100
      } else {
        shadowPnl = -Number(r.proposed_kelly_size)
      }
    }

    await db.run(
      `UPDATE shadow_full_distribution
       SET actual_ks = ?, result = ?, shadow_pnl = ?, settled_at = ?
       WHERE id = ?`,
      [actualKs, result, shadowPnl, new Date().toISOString(), r.id],
    ).catch(() => {})
    updated++
  }
  return updated
}

export async function buildFullDistributionReport({ betDate }) {
  const rows = await db.all(
    `SELECT pitcher_name, strike, side, calibrated_edge, proposed_kelly_size,
            production_allowed, production_filter_reason, result, shadow_pnl,
            actual_ks
     FROM shadow_full_distribution
     WHERE bet_date = ?`,
    [betDate],
  ).catch(() => [])

  const settled = rows.filter(r => r.result != null)
  const blocked = rows.filter(r => r.production_allowed === 0)
  const blockedWithEdge = blocked.filter(r => Number(r.proposed_kelly_size) > 0)
  const blockedSettled = blockedWithEdge.filter(r => r.result != null)

  const totalBlockedPnl = blockedSettled.reduce((s, r) => s + Number(r.shadow_pnl ?? 0), 0)
  const totalBlockedRisk = blockedSettled.reduce((s, r) => s + Number(r.proposed_kelly_size ?? 0), 0)

  // Per-strike-side breakdown of blocked-with-edge
  const breakdown = new Map()
  for (const r of blockedWithEdge) {
    const key = `${r.side}${r.strike}`
    const prev = breakdown.get(key) ?? { side: r.side, strike: r.strike, n: 0, fires: 0, wins: 0, losses: 0, pnl: 0, risk: 0 }
    prev.n++
    if (r.result === 'win') prev.wins++
    if (r.result === 'loss') prev.losses++
    prev.pnl += Number(r.shadow_pnl ?? 0)
    prev.risk += Number(r.proposed_kelly_size ?? 0)
    breakdown.set(key, prev)
  }

  return {
    date: betDate,
    total_candidates:           rows.length,
    settled:                    settled.length,
    production_blocked:         blocked.length,
    blocked_with_positive_edge: blockedWithEdge.length,
    blocked_settled:            blockedSettled.length,
    blocked_total_pnl:          Math.round(totalBlockedPnl * 100) / 100,
    blocked_total_risk:         Math.round(totalBlockedRisk * 100) / 100,
    blocked_breakdown:          [...breakdown.values()].sort((a, b) => a.side.localeCompare(b.side) || a.strike - b.strike),
  }
}

export function formatFullDistributionDiscordLines(report) {
  if (report.blocked_with_positive_edge === 0) return []
  const lines = []
  const pnl = report.blocked_total_pnl
  const risk = report.blocked_total_risk
  const roi = risk > 0 ? Math.round((pnl / risk) * 1000) / 10 : null
  lines.push(`${report.blocked_with_positive_edge} candidates blocked WITH positive calibrated edge`)
  if (report.blocked_settled > 0) {
    lines.push(`Of those, ${report.blocked_settled} settled → ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} on $${risk.toFixed(2)} risk${roi != null ? ` (${roi}% ROI)` : ''}`)
  }
  return lines
}
