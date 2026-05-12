// lib/calibrationEngine.js — Weekly self-calibration engine.
// Reads resolved market_snapshots + ks_bets, learns correction factors,
// walk-forward validates, and promotes if Sharpe improves >= 3%.

import * as db from './db.js'
import { notifyAlert, getAllWebhooks } from './discord.js'
import { setRule, getAllRules, DEFAULTS } from './bettingRules.js'

const MIN_PROB_SAMPLES  = 30
const MIN_EDGE_SAMPLES  = 30
const MIN_PITCHER_BETS  = 10
const PROMOTE_THRESHOLD = 0.03  // 3% Sharpe improvement required
const PROB_WIDTH        = 0.05  // 5% probability buckets
const EDGE_WIDTH        = 0.02  // 2% edge buckets
const Z95               = 1.96

// ── Public API ───────────────────────────────────────────────────────��────────

export async function runCalibration({ trigger = 'cron', dryRun = false } = {}) {
  const runId = await db.run(
    `INSERT INTO calibration_runs (trigger, status) VALUES (?, 'running')`,
    [trigger],
  ).then(r => Number(r.lastInsertRowid)).catch(() => null)

  try {
    const samples = await loadResolvedSamples()

    if (samples.length < MIN_PROB_SAMPLES) {
      await finishRun(runId, 'skipped', { notes: `Only ${samples.length} resolved samples — need ${MIN_PROB_SAMPLES}` })
      return { runId, promoted: false, summary: 'skipped: insufficient data' }
    }

    const probBuckets  = computeProbBuckets(samples)
    const edgeBuckets  = computeEdgeBuckets(samples)
    const minEdge      = computeMinEdge(edgeBuckets)
    const pitchers     = computePitcherReliability(samples)

    // Walk-forward: train on all-but-last-2-weeks, test on last 2 weeks
    const sortedDates = [...new Set(samples.map(s => s.game_date))].sort()
    const cutoff = sortedDates[Math.max(0, sortedDates.length - 14)]
    const trainSet  = samples.filter(s => s.game_date < cutoff)
    const testSet   = samples.filter(s => s.game_date >= cutoff)

    let validation = { oldSharpe: null, newSharpe: null, deltaPct: null }
    if (testSet.length >= 20) {
      const oldParams = await loadActiveParams()
      const newProbMap = Object.fromEntries(probBuckets.map(b => [b.bucket_key, b.multiplier]))
      validation = walkForwardValidate(testSet, oldParams, newProbMap)
    }

    const shouldPromote = !dryRun
      && (validation.deltaPct == null || validation.deltaPct >= PROMOTE_THRESHOLD)
      && probBuckets.length > 0

    if (shouldPromote) {
      await promoteParams(runId, probBuckets, edgeBuckets, minEdge)
    }

    if (!dryRun) {
      await savePitcherCalibration(pitchers, runId)
    }

    const report = {
      samples: samples.length,
      probBuckets: probBuckets.length,
      edgeBuckets: edgeBuckets.length,
      pitchers: pitchers.length,
      minEdge,
      validation,
      promoted: shouldPromote,
      topPitchers:    pitchers.sort((a,b) => b.reliability - a.reliability).slice(0,3),
      bottomPitchers: pitchers.sort((a,b) => a.reliability - b.reliability).slice(0,3),
    }

    await finishRun(runId, 'success', {
      n_resolved_bets:        samples.length,
      date_range_start:       sortedDates[0],
      date_range_end:         sortedDates[sortedDates.length - 1],
      buckets_updated:        probBuckets.length,
      pitchers_scored:        pitchers.length,
      walkforward_old_sharpe: validation.oldSharpe,
      walkforward_new_sharpe: validation.newSharpe,
      walkforward_delta_pct:  validation.deltaPct,
      promoted:               shouldPromote ? 1 : 0,
      report_json:            JSON.stringify(report),
    })

    // Shadow analysis + rule calibration (fire-and-forget within the run)
    if (!dryRun) {
      await runRuleCalibration(runId).catch(err =>
        db.saveLog({ tag: 'CALIB_RULE_ERR', level: 'error', msg: err.message }).catch(() => {}),
      )
    }

    if (!dryRun) await notifyCalibration(report).catch(() => {})
    return { runId, promoted: shouldPromote, summary: report }

  } catch (err) {
    await finishRun(runId, 'error', { notes: err.message })
    throw err
  }
}

// ── Runtime helper: apply calibration correction to a raw model probability ──

let _cachedParams = null
let _cacheTs = 0
const CACHE_TTL = 5 * 60 * 1000

export async function applyCalibration(rawProb) {
  const now = Date.now()
  if (!_cachedParams || now - _cacheTs > CACHE_TTL) {
    _cachedParams = await loadActiveParams()
    _cacheTs = now
  }
  if (!_cachedParams || Object.keys(_cachedParams).length === 0) return rawProb
  const bucketLo = Math.floor(rawProb / PROB_WIDTH) * PROB_WIDTH
  const key = `${bucketLo.toFixed(2)}-${(bucketLo + PROB_WIDTH).toFixed(2)}`
  const mult = _cachedParams[key]
  if (mult == null) return rawProb
  return Math.min(0.99, Math.max(0.01, rawProb * mult))
}

// ── Internal helpers ──────────────────────────────────────────────────────────

async function loadResolvedSamples() {
  // One sample per (ticker, bet_id) — prefer bets we placed, fall back to pure snapshot rows
  const rows = await db.all(`
    SELECT
      s.id AS snap_id,
      s.model_prob,
      s.best_side,
      s.best_edge,
      s.yes_price,
      s.strike,
      s.pitcher_id,
      s.pitcher_name,
      s.game_date,
      s.actual_ks,
      s.bet_id,
      b.pnl,
      b.bet_size,
      b.fill_price,
      b.result
    FROM market_snapshots s
    LEFT JOIN ks_bets b ON s.bet_id = b.id AND b.paper = 0
    WHERE s.actual_ks IS NOT NULL
      AND s.model_prob IS NOT NULL
      AND s.best_side  IS NOT NULL
      AND s.qualified  = 1
    GROUP BY s.ticker, s.game_date
    HAVING s.captured_at = MAX(s.captured_at)
    ORDER BY s.game_date ASC
  `).catch(() => [])

  return rows.map(r => ({
    ...r,
    won: r.best_side === 'YES' ? r.actual_ks >= r.strike : r.actual_ks < r.strike,
    marketPrice: (r.yes_price ?? 50) / 100,
    expectedRoi: r.best_edge != null && r.yes_price != null
      ? r.best_edge / ((r.best_side === 'YES' ? r.yes_price : 100 - r.yes_price) / 100)
      : null,
  }))
}

function computeProbBuckets(samples, width = PROB_WIDTH) {
  const buckets = {}
  for (const s of samples) {
    const lo  = Math.floor(s.model_prob / width) * width
    const key = `${lo.toFixed(2)}-${(lo + width).toFixed(2)}`
    if (!buckets[key]) buckets[key] = { lo, hi: lo + width, probs: [], wins: 0, total: 0 }
    buckets[key].probs.push(s.model_prob)
    buckets[key].total++
    if (s.won) buckets[key].wins++
  }
  return Object.entries(buckets)
    .filter(([, b]) => b.total >= MIN_PROB_SAMPLES)
    .map(([key, b]) => {
      const predicted = b.probs.reduce((a, v) => a + v, 0) / b.probs.length
      const actual    = b.wins / b.total
      const ci        = wilsonCI(b.wins, b.total)
      return {
        param_type:  'prob_bucket',
        bucket_key:  key,
        bucket_lo:   b.lo,
        bucket_hi:   b.hi,
        predicted,
        actual,
        multiplier:  predicted > 0 ? actual / predicted : 1,
        sample_size: b.total,
        ci_low:      ci.lo,
        ci_high:     ci.hi,
        active:      1,
        model_version: 'v1',
      }
    })
}

function computeEdgeBuckets(samples, width = EDGE_WIDTH) {
  const betSamples = samples.filter(s => s.bet_id && s.pnl != null && s.bet_size > 0)
  const buckets = {}
  for (const s of betSamples) {
    const edge = s.best_edge ?? 0
    const lo   = Math.floor(edge / width) * width
    const key  = `${lo.toFixed(2)}-${(lo + width).toFixed(2)}`
    if (!buckets[key]) buckets[key] = { lo, hi: lo + width, pnl: 0, size: 0, total: 0, expectedRoi: [] }
    buckets[key].pnl   += s.pnl ?? 0
    buckets[key].size  += s.bet_size ?? 0
    buckets[key].total++
    if (s.expectedRoi != null) buckets[key].expectedRoi.push(s.expectedRoi)
  }
  return Object.entries(buckets)
    .filter(([, b]) => b.total >= MIN_EDGE_SAMPLES)
    .map(([key, b]) => {
      const actualRoi   = b.size > 0 ? b.pnl / b.size : null
      const expectedRoi = b.expectedRoi.length > 0
        ? b.expectedRoi.reduce((a, v) => a + v, 0) / b.expectedRoi.length
        : null
      return {
        param_type:   'edge_bucket',
        bucket_key:   key,
        bucket_lo:    b.lo,
        bucket_hi:    b.hi,
        actual_roi:   actualRoi,
        expected_roi: expectedRoi,
        sample_size:  b.total,
        active:       1,
        model_version: 'v1',
      }
    })
}

function computeMinEdge(edgeBuckets) {
  const profitable = edgeBuckets.filter(b => b.actual_roi != null && b.actual_roi >= 0)
  if (!profitable.length) return null
  return Math.min(...profitable.map(b => b.bucket_lo))
}

function computePitcherReliability(samples) {
  const map = {}
  for (const s of samples.filter(s => s.bet_id && s.pnl != null)) {
    const k = s.pitcher_id || s.pitcher_name
    if (!map[k]) map[k] = { pitcher_id: s.pitcher_id, pitcher_name: s.pitcher_name, pnl: 0, size: 0, edges: [], probs: [], dates: [], expectedRoi: [] }
    map[k].pnl  += s.pnl
    map[k].size += s.bet_size ?? 0
    map[k].edges.push(s.best_edge ?? 0)
    map[k].probs.push(s.model_prob)
    map[k].dates.push(s.game_date)
    if (s.expectedRoi != null) map[k].expectedRoi.push(s.expectedRoi)
  }
  return Object.values(map)
    .filter(p => p.edges.length >= MIN_PITCHER_BETS)
    .map(p => {
      const actualRoi   = p.size > 0 ? p.pnl / p.size : 0
      const expectedRoi = p.expectedRoi.length > 0
        ? p.expectedRoi.reduce((a, v) => a + v, 0) / p.expectedRoi.length
        : 0
      const reliability = expectedRoi !== 0 ? actualRoi / expectedRoi : 1
      return {
        pitcher_id:    p.pitcher_id,
        pitcher_name:  p.pitcher_name,
        n_bets:        p.edges.length,
        actual_roi:    actualRoi,
        expected_roi:  expectedRoi,
        reliability:   Math.min(3, Math.max(0, reliability)),
        avg_edge:      p.edges.reduce((a, v) => a + v, 0) / p.edges.length,
        avg_model_prob: p.probs.reduce((a, v) => a + v, 0) / p.probs.length,
        last_bet_date: [...p.dates].sort().pop(),
      }
    })
}

function walkForwardValidate(testSamples, oldProbMap, newProbMap) {
  if (testSamples.length < 20) return { oldSharpe: null, newSharpe: null, deltaPct: null }

  const simulate = (samples, probMap) => {
    const dailyPnl = {}
    for (const s of samples) {
      if (!s.bet_id || s.pnl == null) continue
      const rawProb = s.model_prob
      const lo  = Math.floor(rawProb / PROB_WIDTH) * PROB_WIDTH
      const key = `${lo.toFixed(2)}-${(lo + PROB_WIDTH).toFixed(2)}`
      const mult = probMap?.[key] ?? 1
      const adjProb = Math.min(0.99, Math.max(0.01, rawProb * mult))
      // Scale pnl by (adjProb/rawProb) to simulate effect of corrected sizing
      const scaledPnl = rawProb > 0 ? s.pnl * (adjProb / rawProb) : s.pnl
      dailyPnl[s.game_date] = (dailyPnl[s.game_date] ?? 0) + scaledPnl
    }
    return Object.values(dailyPnl)
  }

  const oldDaily = simulate(testSamples, oldProbMap)
  const newDaily = simulate(testSamples, newProbMap)

  return {
    oldSharpe: sharpe(oldDaily),
    newSharpe: sharpe(newDaily),
    deltaPct:  oldDaily.length > 0 && sharpe(oldDaily) !== 0
      ? (sharpe(newDaily) - sharpe(oldDaily)) / Math.abs(sharpe(oldDaily))
      : null,
  }
}

async function loadActiveParams() {
  const rows = await db.all(
    `SELECT bucket_key, multiplier FROM calibration_params WHERE active = 1 AND param_type = 'prob_bucket'`,
  ).catch(() => [])
  return Object.fromEntries(rows.map(r => [r.bucket_key, r.multiplier]))
}

async function promoteParams(runId, probBuckets, edgeBuckets, minEdge) {
  await db.run(`UPDATE calibration_params SET active = 0 WHERE param_type IN ('prob_bucket','edge_bucket','min_edge')`).catch(() => {})
  const now = new Date().toISOString()
  for (const b of [...probBuckets, ...edgeBuckets]) {
    await db.run(`
      INSERT INTO calibration_params
        (param_type, bucket_key, bucket_lo, bucket_hi, predicted, actual, multiplier,
         sample_size, expected_roi, actual_roi, ci_low, ci_high, active, model_version, run_id, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,'v1',?,?)
      ON CONFLICT(param_type, bucket_key, model_version) DO UPDATE SET
        multiplier=excluded.multiplier, actual=excluded.actual, sample_size=excluded.sample_size,
        actual_roi=excluded.actual_roi, ci_low=excluded.ci_low, ci_high=excluded.ci_high,
        active=1, run_id=excluded.run_id, created_at=excluded.created_at
    `, [
      b.param_type, b.bucket_key, b.bucket_lo ?? null, b.bucket_hi ?? null,
      b.predicted ?? null, b.actual ?? null, b.multiplier ?? null,
      b.sample_size, b.expected_roi ?? null, b.actual_roi ?? null,
      b.ci_low ?? null, b.ci_high ?? null, runId, now,
    ]).catch(() => {})
  }
  if (minEdge != null) {
    await db.run(`
      INSERT INTO calibration_params (param_type, bucket_key, bucket_lo, sample_size, active, model_version, run_id, created_at)
      VALUES ('min_edge','threshold',?,0,1,'v1',?,?)
      ON CONFLICT(param_type, bucket_key, model_version) DO UPDATE SET bucket_lo=excluded.bucket_lo, active=1, run_id=excluded.run_id
    `, [minEdge, runId, now]).catch(() => {})
  }
}

async function savePitcherCalibration(pitchers, runId) {
  const now = new Date().toISOString()
  for (const p of pitchers) {
    await db.run(`
      INSERT INTO pitcher_calibration
        (pitcher_id, pitcher_name, n_bets, win_rate, expected_roi, actual_roi,
         reliability, avg_edge, avg_model_prob, last_bet_date, run_id, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(pitcher_id, run_id) DO UPDATE SET
        n_bets=excluded.n_bets, actual_roi=excluded.actual_roi,
        reliability=excluded.reliability, updated_at=excluded.updated_at
    `, [
      p.pitcher_id, p.pitcher_name, p.n_bets, null,
      p.expected_roi, p.actual_roi, p.reliability,
      p.avg_edge, p.avg_model_prob, p.last_bet_date, runId, now,
    ]).catch(() => {})
  }
}

async function finishRun(runId, status, fields = {}) {
  if (!runId) return
  const sets = Object.entries({ finished_at: new Date().toISOString(), status, ...fields })
    .map(([k]) => `${k}=?`).join(',')
  const vals = Object.values({ finished_at: new Date().toISOString(), status, ...fields })
  await db.run(`UPDATE calibration_runs SET ${sets} WHERE id=?`, [...vals, runId]).catch(() => {})
}

async function notifyCalibration(report) {
  const webhooks = await getAllWebhooks(db).catch(() => [])
  if (!webhooks.length) return
  const promoted = report.promoted ? '✅ Promoted' : '⏸ Not promoted (insufficient improvement)'
  const delta    = report.validation?.deltaPct != null
    ? `${(report.validation.deltaPct * 100).toFixed(1)}%`
    : 'N/A'
  await notifyAlert({
    title:       `📊 Calibration Update`,
    description: [
      `**${report.samples}** resolved bets · **${report.probBuckets}** buckets updated · **${report.pitchers}** pitchers scored`,
      `Walk-forward Sharpe delta: **${delta}**`,
      promoted,
      report.topPitchers?.length ? `Top: ${report.topPitchers.map(p => `${p.pitcher_name} (${p.reliability.toFixed(2)}×)`).join(', ')}` : '',
    ].filter(Boolean).join('\n'),
    color: report.promoted ? 0x2ecc71 : 0x95a5a6,
  }, webhooks)
}

function sharpe(daily) {
  if (!daily.length) return 0
  const mean = daily.reduce((a, v) => a + v, 0) / daily.length
  const variance = daily.reduce((a, v) => a + (v - mean) ** 2, 0) / daily.length
  const std = Math.sqrt(variance)
  return std === 0 ? 0 : mean / std
}

function wilsonCI(wins, n) {
  if (n === 0) return { lo: 0, hi: 1 }
  const p = wins / n
  const z2n = (Z95 * Z95) / n
  const center = (p + z2n / 2) / (1 + z2n)
  const margin = (Z95 * Math.sqrt((p * (1 - p) + z2n / 4) / n)) / (1 + z2n)
  return { lo: Math.max(0, center - margin), hi: Math.min(1, center + margin) }
}

// ── Shadow analysis + rule calibration ────────────────────────────────────────
// Evaluates phantom P&L for banned/rejected bets using proxy fill prices from
// qualified bets of the same (strike, side). Adjusts yes_max_strike and
// no_max_market_mid rules based on observed win rates vs break-even.

const MIN_SHADOW_SAMPLES = 8  // minimum rejected snapshots to draw a conclusion
const SHADOW_LOOKBACK_DAYS = 60

export async function runShadowAnalysis() {
  const cutoff = new Date(Date.now() - SHADOW_LOOKBACK_DAYS * 86400_000)
    .toISOString().slice(0, 10)

  // Load all rejected (non-qualified) resolved snapshots
  const rejected = await db.all(`
    SELECT
      s.strike,
      s.best_side,
      s.yes_price,
      s.no_price,
      s.actual_ks,
      s.reject_reason,
      s.game_date
    FROM market_snapshots s
    WHERE s.qualified = 0
      AND s.actual_ks IS NOT NULL
      AND s.reject_reason IS NOT NULL
      AND s.reject_reason != 'already_covered'
      AND s.game_date >= ?
    ORDER BY s.game_date
  `, [cutoff]).catch(() => [])

  if (!rejected.length) return []

  // Compute proxy fill price for each (strike, side) from qualified bets
  const proxyPrices = await db.all(`
    SELECT
      s.strike,
      b.side,
      AVG(b.fill_price) AS avg_fill_price,
      COUNT(*) AS n
    FROM market_snapshots s
    JOIN ks_bets b ON s.bet_id = b.id AND b.paper = 0 AND b.result IS NOT NULL
    WHERE s.game_date >= ?
    GROUP BY s.strike, b.side
    HAVING n >= 3
  `, [cutoff]).catch(() => [])

  const proxyMap = new Map()
  for (const r of proxyPrices) proxyMap.set(`${r.strike}-${r.side}`, r.avg_fill_price)

  // Group by (strike, side, reject_reason_category) and compute phantom P&L
  const groups = {}
  for (const r of rejected) {
    const side    = r.best_side
    const strike  = r.strike
    const won     = side === 'YES' ? r.actual_ks >= strike : r.actual_ks < strike
    const key     = `${strike}-${side}`
    const fillFrac = (proxyMap.get(key) ?? (side === 'YES' ? (r.yes_price ?? 50) : (r.no_price ?? 50))) / 100
    const pnlWin  = side === 'YES' ? (1 - fillFrac) * 0.93 : fillFrac * 0.93
    const pnlLoss = side === 'YES' ? -fillFrac : -(1 - fillFrac)
    const pnl     = won ? pnlWin : pnlLoss

    const cat = _categorizeReject(r.reject_reason)
    const gKey = `${cat}:${strike}:${side}`
    if (!groups[gKey]) groups[gKey] = { cat, strike, side, wins: 0, total: 0, pnl: 0, rejectReason: r.reject_reason }
    groups[gKey].wins  += won ? 1 : 0
    groups[gKey].total += 1
    groups[gKey].pnl   += pnl
  }

  return Object.values(groups).map(g => ({
    ...g,
    winRate:    g.wins / g.total,
    avgPnl:     g.pnl / g.total,
    breakEven:  g.side === 'YES'
      ? (proxyMap.get(`${g.strike}-YES`) ?? 50) / 100
      : 1 - (proxyMap.get(`${g.strike}-NO`) ?? 50) / 100,
  }))
}

function _categorizeReject(reason) {
  if (!reason) return 'unknown'
  if (reason.startsWith('yes_strike_ban')) return 'yes_strike_ban'
  if (reason.startsWith('no_strike_ban'))  return 'no_strike_ban'
  if (reason.startsWith('no_mid_cap'))     return 'no_mid_cap'
  if (reason.startsWith('yes_low_prob'))   return 'yes_low_prob'
  if (reason.startsWith('yes_low_edge'))   return 'yes_low_edge'
  if (reason.startsWith('no_high_prob'))   return 'no_high_prob'
  if (reason.startsWith('no_high_ask'))    return 'no_high_ask'
  if (reason.startsWith('no_low_edge'))    return 'no_low_edge'
  if (reason === 'illiquid')               return 'illiquid'
  return 'other'
}

async function runRuleCalibration(runId) {
  const shadowGroups = await runShadowAnalysis()
  if (!shadowGroups.length) return

  const currentRules = await getAllRules()
  const ruleMap = Object.fromEntries(currentRules.map(r => [r.key, r]))
  const changes  = []

  // ── yes_max_strike: should we relax the ban? ──
  // If shadow YES bets at strike = yes_max_strike+1 are winning ≥ break-even, relax by 1
  // If we have no bets at yes_max_strike (banned) but shadow shows positive → keep ban
  const yesBanRule  = ruleMap['yes_max_strike']
  const curYesBan   = yesBanRule?.value ?? 6
  const yesBanned   = shadowGroups.filter(g => g.cat === 'yes_strike_ban' && g.total >= MIN_SHADOW_SAMPLES)

  for (const g of yesBanned) {
    if (g.strike === curYesBan + 1) {
      if (g.winRate >= g.breakEven + 0.05 && g.avgPnl > 0) {
        // Shadow bets winning → relax the ban by 1
        const newVal = curYesBan + 1
        await setRule('yes_max_strike', newVal, 'calibration')
        changes.push({ key: 'yes_max_strike', old: curYesBan, new: newVal, reason: `Shadow ${g.total} YES ${g.strike}+: ${(g.winRate*100).toFixed(1)}% WR > ${(g.breakEven*100).toFixed(1)}% break-even`, direction: 'relax' })
      }
      // If shadow shows losing, confirm the ban
      if (g.winRate < g.breakEven - 0.05 || g.avgPnl < 0) {
        changes.push({ key: 'yes_max_strike', old: curYesBan, new: curYesBan, reason: `Ban confirmed: Shadow ${g.total} YES ${g.strike}+: ${(g.winRate*100).toFixed(1)}% WR < ${(g.breakEven*100).toFixed(1)}% break-even`, direction: 'confirm' })
      }
    }
  }

  // ── no_max_market_mid: should we tighten or relax? ──
  const noMidRule  = ruleMap['no_max_market_mid']
  const curNoMid   = noMidRule?.value ?? 45
  const noMidBanned = shadowGroups.filter(g => g.cat === 'no_mid_cap' && g.total >= MIN_SHADOW_SAMPLES)

  for (const g of noMidBanned) {
    if (g.winRate >= g.breakEven + 0.05 && g.avgPnl > 0) {
      // Banned NOs are actually winning → relax the cap (allow slightly higher mid)
      const newVal = Math.min(curNoMid + 5, 65)  // cap at 65¢
      await setRule('no_max_market_mid', newVal, 'calibration')
      changes.push({ key: 'no_max_market_mid', old: curNoMid, new: newVal, reason: `Shadow ${g.total} NO mid-cap bets winning ${(g.winRate*100).toFixed(1)}%`, direction: 'relax' })
    }
    if (g.winRate < g.breakEven - 0.05 && g.avgPnl < 0) {
      // Banned NOs are losing → tighten the cap
      const newVal = Math.max(curNoMid - 5, 25)  // floor at 25¢
      await setRule('no_max_market_mid', newVal, 'calibration')
      changes.push({ key: 'no_max_market_mid', old: curNoMid, new: newVal, reason: `Shadow ${g.total} NO mid-cap bets losing ${(g.winRate*100).toFixed(1)}%`, direction: 'tighten' })
    }
  }

  // Write feed entries for each change / confirmation
  for (const c of changes) {
    const tag  = c.direction === 'confirm' ? 'RULE_CONFIRM' : 'RULE_CHANGE'
    const def  = DEFAULTS[c.key]
    const label = def?.label ?? c.key
    const msg  = c.direction === 'confirm'
      ? `Rule confirmed: ${label} stays at ${c.new} — ${c.reason}`
      : `Rule updated: ${label} ${c.old} → ${c.new} — ${c.reason}`
    await db.saveLog({ tag, level: 'info', msg, runId }).catch(() => {})
  }

  // If nothing happened but we have shadow data, emit a RULE_WATCH entry
  if (!changes.length && shadowGroups.length) {
    const summary = shadowGroups.slice(0, 3).map(g =>
      `${g.side} ${g.strike}+ (${g.total}n, ${(g.winRate*100).toFixed(0)}% WR)`
    ).join(', ')
    await db.saveLog({
      tag: 'RULE_WATCH', level: 'info',
      msg: `Shadow analysis: watching ${shadowGroups.length} rule groups — ${summary}`,
      runId,
    }).catch(() => {})
  }
}

export async function getShadowSummary() {
  return runShadowAnalysis()
}
