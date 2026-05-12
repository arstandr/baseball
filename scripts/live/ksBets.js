// scripts/live/ksBets.js — Paper bet tracker for KXMLBKS strikeout markets.
//
// Two modes:
//   log   — record edge calls from strikeoutEdge.js output into ks_bets table
//   settle — fetch actual K totals from MLB API and mark bets won/lost
//   report — print P&L summary
//
// The table stores each edge call with the market price at time of call.
// After games finish, settle fills in actual_ks and result (win/loss).
//
// Usage:
//   node scripts/live/ksBets.js log    [--date YYYY-MM-DD] [--min-edge 0.05]
//   node scripts/live/ksBets.js settle [--date YYYY-MM-DD]
//   node scripts/live/ksBets.js report [--days 30]
//   node scripts/live/ksBets.js cancel-scratched [--date YYYY-MM-DD] [--dry-run]
//   node scripts/live/ksBets.js cancel-all       [--date YYYY-MM-DD]

import 'dotenv/config'
import * as db from '../../lib/db.js'
import { toKalshiAbbr, getAuthHeaders, placeOrder, cancelOrder, cancelAllOrders, getOrder, getBalance as getKalshiBalance, getSettlements, getFills, listOrders, getOrderbook, availableDepth } from '../../lib/kalshi.js'
import { mlbGet } from '../../lib/mlb-live.js'
import { notifyEdges, notifyDailyReport, getAllWebhooks } from '../../lib/discord.js'
import { parseArgs } from '../../lib/cli-args.js'
import { recordPipelineStep } from '../../lib/pipelineLog.js'
import { correlatedKellyDivide, opportunityDiscount } from '../../lib/kelly.js'
import { getRules as getBettingRules } from '../../lib/bettingRules.js'
import { getAvailablePool, addCommitted } from '../../lib/bankrollState.js'
import { STRATEGY_MODES, validateStrategyMode } from '../../lib/strategyMode.js'
import { checkAllCaps } from '../../lib/strategyCaps.js'
import { acquireBetLock, confirmBetPlaced, releaseBetLock } from '../../lib/betLock.js'

const MODE = process.argv[2] || 'report'

const opts = parseArgs({
  date:      { default: new Date().toISOString().slice(0, 10) },
  days:      { type: 'number', default: 30 },
  minEdge:   { flag: 'min-edge', type: 'number', default: 0.05 },
  betSize:   { flag: 'bet-size', type: 'number', default: 100 },
  riskPct:   { flag: 'risk-pct', type: 'number', default: null },
  maxRisk:   { flag: 'max-risk', type: 'number', default: null },  // pre-allocated budget cap for this pitcher (from daily_plan)
  dryRun:    { flag: 'dry-run', type: 'boolean', default: false },
  pitcherId: { flag: 'pitcher-id', default: null },
})

const TODAY    = opts.date
const daysArg  = opts.days
const minEdge  = opts.minEdge
const BET_SIZE = opts.betSize

// Portfolio risk cap: max % of bankroll to risk per day.
const DAILY_RISK_PCT = opts.riskPct != null
  ? opts.riskPct / 100
  : Number(process.env.DAILY_RISK_PCT || 0.20)
const STARTING_BANKROLL = Number(process.env.STARTING_BANKROLL || 5000)

const MLB_BASE    = 'https://statsapi.mlb.com/api/v1'
const KALSHI_BASE = 'https://api.elections.kalshi.com/trade-api/v2'

// ── Table setup ───────────────────────────────────────────────────────────────

async function ensureTable() {
  // CREATE TABLE is in db/schema.sql — run via db.migrate() before this is called.
  // These are safe no-ops on existing databases.
  await db.run(`CREATE INDEX IF NOT EXISTS idx_ks_bets_date      ON ks_bets(bet_date)`)
  await db.run(`CREATE INDEX IF NOT EXISTS idx_ks_bets_pitcher   ON ks_bets(pitcher_id)`)
  await db.run(`CREATE INDEX IF NOT EXISTS idx_ks_bets_result    ON ks_bets(result)`)
  await db.run(`CREATE INDEX IF NOT EXISTS idx_ks_bets_composite ON ks_bets(bet_date, live_bet, paper, user_id)`)

  // Backfill new columns for existing rows (safe no-ops if columns already exist)
  for (const col of [
    'park_factor REAL', 'weather_mult REAL', 'ump_factor REAL', 'ump_name TEXT',
    'velo_adj REAL', 'velo_trend_mph REAL', 'bb_penalty REAL', 'raw_adj_factor REAL', 'spread REAL',
    'raw_model_prob REAL',  // pre-shrinkage probability (honest calibration)
    'order_id TEXT',        // Kalshi order ID after placement
    'fill_price REAL',      // actual fill price in cents (e.g. 47 = 47¢)
    'filled_at TEXT',       // ISO timestamp when order was placed
    'filled_contracts INTEGER', // number of contracts placed
    'order_status TEXT',    // resting | filled | canceled
  ]) {
    try { await db.run(`ALTER TABLE ks_bets ADD COLUMN ${col}`) } catch {}
  }

  // 60/20/20 pool columns on users + daily_plan (safe no-ops if already exist)
  for (const col of ['pregame_risk_pct REAL', 'free_money_risk_pct REAL']) {
    try { await db.run(`ALTER TABLE users ADD COLUMN ${col}`) } catch {}
  }
  for (const col of ['pregame_pool REAL', 'live_pool REAL', 'free_money_pool REAL']) {
    try { await db.run(`ALTER TABLE daily_plan ADD COLUMN ${col}`) } catch {}
  }
  // Seed defaults for existing users that don't have pool pcts yet
  await db.run(`UPDATE users SET pregame_risk_pct = 0.60 WHERE pregame_risk_pct IS NULL`).catch(() => {})
  await db.run(`UPDATE users SET free_money_risk_pct = 0.20 WHERE free_money_risk_pct IS NULL`).catch(() => {})
  await db.run(`UPDATE users SET live_daily_risk_pct = 0.20 WHERE live_daily_risk_pct IS NULL OR live_daily_risk_pct < 0.20`).catch(() => {})
}

// ── LOG mode: run edge finder and record edges ────────────────────────────────

async function logEdges() {
  // Import edge finder logic inline by spawning it as a subprocess
  // to avoid circular dependency — capture JSON output
  const { default: { execSync } } = await import('child_process')
  console.log(`[ks-bets] Running edge finder for ${TODAY}…`)

  let edgesJson
  try {
    const out = execSync(
      `node scripts/live/strikeoutEdge.js --date ${TODAY} --min-edge ${minEdge} --json`,
      { cwd: process.cwd(), timeout: 120000, encoding: 'utf8' }
    )
    // Look for the JSON block at the end of output
    const jsonMatch = out.match(/\[EDGES_JSON\]([\s\S]+)\[\/EDGES_JSON\]/)
    if (!jsonMatch) {
      console.log('[ks-bets] No JSON block in edge output — add --json support to strikeoutEdge.js')
      console.log('[ks-bets] Raw output preview:\n', out.slice(-500))
      await db.close()
      return
    }
    edgesJson = JSON.parse(jsonMatch[1])
  } catch (err) {
    console.error('[ks-bets] Edge finder failed:', err.message)
    await db.close()
    return
  }

  // --pitcher-id: filter to a single starter (used by per-game polling job)
  if (opts.pitcherId) {
    const pid = String(opts.pitcherId)
    edgesJson = edgesJson.filter(e => e.pitcher_id && String(e.pitcher_id) === pid)
    if (!edgesJson.length) {
      console.log(`[ks-bets] No edges found for pitcher ${pid} — nothing to log`)
      // Write a pipeline entry so the cleanup SQL correctly marks bet_schedule as 'skipped'
      // instead of 'error'. Without this, missing K-prop data looks like a process crash.
      const schedRow = await db.one(
        `SELECT pitcher_name, game_id, game_label, game_time, pitcher_side FROM bet_schedule WHERE bet_date=? AND pitcher_id=?`,
        [TODAY, pid],
      ).catch(() => null)
      if (schedRow) {
        recordPipelineStep({
          bet_date: TODAY, pitcher_id: pid, pitcher_name: schedRow.pitcher_name,
          game_id: schedRow.game_id, game_label: schedRow.game_label,
          pitcher_side: schedRow.pitcher_side, game_time: schedRow.game_time,
          step: 'rule_filters',
          payload: { inputs_count: 0, passed_count: 0, note: 'no K-prop edge data from strikeoutEdge' },
          summary: { final_action: 'no_markets', skip_reason: 'no K-prop data', inputs_count: 0, passed_count: 0 },
        }).catch(() => {})
      }
      await db.close()
      return
    }
    console.log(`[ks-bets] Filtered to pitcher ${pid}: ${edgesJson.length} edges`)
  }

  if (!edgesJson.length) {
    console.log('[ks-bets] No edges to log')
    await db.close()
    return
  }

  // ── Load active bettors ───────────────────────────────────────────────────
  // Fall back to single-user env-based config if no active_bettor rows exist.
  let bettors = await db.all(
    `SELECT id, name, starting_bankroll, daily_risk_pct, pregame_risk_pct, live_daily_risk_pct, free_money_risk_pct,
            paper, kalshi_key_id, kalshi_private_key
     FROM users WHERE active_bettor = 1 ORDER BY id ASC`,
  )
  if (!bettors.length) {
    console.log('[ks-bets] No active bettors found — nothing to log')
    await db.close()
    return
  }

  // ── Capture opening balance snapshots before placing any bets ────────────
  // ET date (America/New_York) is the canonical date for all daily tracking.
  const etDate = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  for (const bettor of bettors) {
    if (!bettor.kalshi_key_id) continue
    try {
      const existing = await db.one(
        `SELECT id FROM balance_snapshots WHERE user_id = ? AND date = ?`,
        [bettor.id, etDate],
      )
      if (existing) {
        console.log(`[ks-bets] ${bettor.name} · opening snapshot already captured for ${etDate}`)
        continue
      }
      const creds = { keyId: bettor.kalshi_key_id, privateKey: bettor.kalshi_private_key }
      const kb = await getKalshiBalance(creds)
      await db.run(
        `INSERT OR IGNORE INTO balance_snapshots (user_id, date, balance_usd, cash_usd, exposure_usd, captured_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [bettor.id, etDate, kb.balance_usd, kb.cash_usd, kb.exposure_usd, new Date().toISOString()],
      )
      console.log(`[ks-bets] ${bettor.name} · opening snapshot captured: $${kb.balance_usd?.toFixed(2)} (cash $${kb.cash_usd?.toFixed(2)} + exposure $${kb.exposure_usd?.toFixed(2)})`)
    } catch (err) {
      console.error(`[ks-bets] ${bettor.name} · opening snapshot failed: ${err.message}`)
    }
  }

  // ── Pre-compute fill fractions (shared across all users) ──────────────────
  const rawEdges = edgesJson.map(e => {
    const mid    = (e.market_mid ?? 50) / 100
    const hs     = (e.spread     ??  4) / 200
    const fill   = e.side === 'YES' ? mid + hs : (1 - mid) + hs
    const edgeVal = Math.max(Number(e.edge) || 0, 0.001)
    return { ...e, _fill: fill, _edgeVal: edgeVal }
  })

  // Dedup hedges: if YES and NO both have edge at the same pitcher+threshold,
  // keep only the higher-edge side — betting both sides nets to near-zero after fees.
  const hedgeKey = e => `${e.pitcher}|${e.strike}`
  const bestByKey = new Map()
  for (const e of rawEdges) {
    const key = hedgeKey(e)
    if (!bestByKey.has(key) || e._edgeVal > bestByKey.get(key)._edgeVal) {
      bestByKey.set(key, e)
    }
  }
  const hedgesRemoved = rawEdges.length - bestByKey.size
  if (hedgesRemoved > 0) console.log(`[ks-bets] Removed ${hedgesRemoved} hedged opposite-side bet(s)`)

  // Read configurable thresholds from DB (10-min cached); fall back to hardcoded defaults
  // Must be read BEFORE YES cap so max_yes_per_pitcher rule is available.
  const _R = await getBettingRules().catch(() => ({}))
  const yesPregameMinProb   = _R.yes_pregame_min_prob    ?? 0.35
  const yesPregameMinProbHi = _R.yes_pregame_min_prob_hi ?? 0.65
  const yesPregameMaxMid    = _R.yes_pregame_max_mid     ?? 35
  const yesMaxStrikePg      = _R.yes_max_strike          ?? 6
  const noMaxStrikePg       = _R.no_max_strike           ?? 6
  const noMaxMidPg          = _R.no_max_market_mid       ?? 45
  const minBetFloor         = _R.min_bet_floor           ?? 8
  const MAX_YES_PER_PITCHER = _R.max_yes_per_pitcher     ?? 5
  // Rules 1-6 (deployed 2026-05-04 from data-driven backtest)
  const yesBlockK5          = (_R.yes_block_k5 ?? 0) >= 1                  // Rule 1: ban K5 YES
  const coldYesBlock        = (_R.cold_yes_block ?? 0) >= 1                // Rule 3: skip YES on cold pitchers
  const maxPctBankrollPerBet = Number(_R.max_pct_bankroll_per_bet ?? 0)    // Rule 4: per-bet bankroll cap
  const highConfThreshold   = Number(_R.high_conf_threshold ?? 0.65)       // Rule 6: above this, apply size haircut
  const highConfSizeHaircut = Number(_R.high_conf_size_haircut ?? 1)       // Rule 6 multiplier (1 = no haircut)
  // Strategy B (cross-strike arb) — deployed 2026-05-06 after POC validated 78% win rate
  const csEnabled              = (_R.cross_strike_enabled ?? 1) >= 1
  const csMaxPctBankroll       = Number(_R.cross_strike_max_pct_bankroll ?? 0.03)  // tighter than 4% main cap
  const csTailDollarCap        = Number(_R.cross_strike_tail_dollar_cap ?? 5)      // hard $ cap on tail bets (ask < 25¢)
  const csTailAskThreshold     = Number(_R.cross_strike_tail_ask_threshold ?? 25)  // ask < this triggers tail cap

  // Pitcher blocklist (Rule 5): pulled from pitcher_blocklist table at run time.
  // 5-min cached in module scope to avoid hammering the DB.
  let _pitcherBlocklist = new Set()
  try {
    const rows = await db.all(`SELECT pitcher_name FROM pitcher_blocklist`)
    _pitcherBlocklist = new Set(rows.map(r => r.pitcher_name))
    if (_pitcherBlocklist.size > 0) {
      console.log(`[ks-bets] Pitcher blocklist active: ${[..._pitcherBlocklist].join(', ')}`)
    }
  } catch { /* missing table — skip */ }

  // Cap YES bets per pitcher (sorted highest edge first) to prevent stacking losses.
  // Correlated Kelly already handles correlation math; this is a hard ceiling.
  const yesCounts = {}
  const deduped = [...bestByKey.values()].sort((a, b) => b._edgeVal - a._edgeVal)
  const withFill = deduped.filter(e => {
    if (e.side !== 'YES') return true
    yesCounts[e.pitcher] = (yesCounts[e.pitcher] || 0) + 1
    return yesCounts[e.pitcher] <= MAX_YES_PER_PITCHER
  })
  const yesCapRemoved = deduped.length - withFill.length
  if (yesCapRemoved > 0) console.log(`[ks-bets] Capped ${yesCapRemoved} YES bet(s) (max ${MAX_YES_PER_PITCHER} per pitcher)`)

  // ── Protection rules (A / D / E / F / I / K + strike/mid caps) ───────────
  // Rule A: Ban NO bets where market_mid ≥ 65 AND model also thinks YES is favored (model_prob ≥ 0.50)
  // Rule D: Ban YES bets where model_prob < 0.25 — Exception: edge ≥ 18¢ overrides
  // Rule E: Ban NO bets where market_mid < 15 — near-certain NO, no edge
  // Rule F: Ban NO bets at strike ≤ 4
  // Rule I: NO 7+ requires all: YES mid ≤ 35¢, model_prob < 0.18, edge ≥ 20¢
  // Rule K: Two-tier pre-game YES gate (replaces Rule J strike-only ban).
  //         Tier 1: ban YES if model_prob < yes_pregame_min_prob (default 0.35) — too low-confidence.
  //         Tier 2: ban YES if model_prob < yes_pregame_min_prob_hi (default 0.65) AND market_mid >
  //                 yes_pregame_max_mid (default 35¢) — medium-confidence bets need cheap fills.
  //         Allows high-strike YES when model is genuinely confident AND fill is cheap.
  // Strike caps: yes_max_strike / no_max_strike ban bets above the configured threshold.
  // NO mid cap:  no_max_market_mid bans NO when YES mid is too high (outcome too uncertain).
  let guardedEdges = withFill.filter(e => {
    // Cross-strike candidates (Strategy B) bypass most YES-side filters.
    // Math-based, not model-based, so YES-side biases (K5/K7 ban, cold-pitcher
    // block, model_prob thresholds) don't apply. Still respects pitcher_blocklist,
    // min_bet_floor, and per-bet sizing caps (those are risk discipline, not
    // strategy-specific). Cross-strike has its own filters added below.
    if (e.strategy_mode === 'pregame_cross_strike') {
      if (!csEnabled) return false
      if (_pitcherBlocklist.has(e.pitcher)) return false
      // All cross-strike-specific filters were already applied in
      // lib/crossStrikeCandidates.js → filterCandidates(). Just pass through.
      return true
    }

    // Rules 1-6 deployed 2026-05-04 (data-driven backtest, last 30 days)
    if (_pitcherBlocklist.has(e.pitcher)) return false                                            // Rule 5: blocklist
    if (e.side === 'YES' && yesBlockK5 && e.strike === 5) return false                            // Rule 1: ban K5 YES
    if (e.side === 'YES' && coldYesBlock                                                          // Rule 3: cold YES block
        && Number(e.k9_career ?? 0) > 0
        && Number(e.k9_l5 ?? 0) < Number(e.k9_career ?? 0)) return false
    // Pre-existing rules
    if (e.side === 'YES' && yesMaxStrikePg > 0 && e.strike > yesMaxStrikePg) return false       // yes_max_strike
    if (e.side === 'NO'  && noMaxStrikePg  > 0 && e.strike > noMaxStrikePg)  return false       // no_max_strike
    if (e.side === 'NO'  && noMaxMidPg     > 0 && (e.market_mid ?? 50) > noMaxMidPg) return false // no_max_mid
    if (e.side === 'NO'  && (e.market_mid ?? 50) >= 65 && e.model_prob >= 0.50) return false   // Rule A
    if (e.side === 'YES' && e.model_prob < 0.25 && (e._edgeVal ?? e.edge ?? 0) < 0.18) return false  // Rule D
    if (e.side === 'NO'  && (e.market_mid ?? 50) < 15) return false                             // Rule E
    if (e.side === 'NO'  && e.strike <= 4) return false                                          // Rule F
    if (e.side === 'YES' && (                                                                    // Rule K
      e.model_prob < yesPregameMinProb ||
      (e.model_prob < yesPregameMinProbHi && (e.market_mid ?? 50) > yesPregameMaxMid)
    )) return false
    if (e.side === 'NO'  && e.strike === 7 && (                                                  // Rule I
      (e.market_mid ?? 50) > 35 ||
      e.model_prob >= 0.18 ||
      (e._edgeVal ?? e.edge ?? 0) < 0.20
    )) return false
    return true
  })
  const guardsRemoved = withFill.length - guardedEdges.length
  if (guardsRemoved > 0) console.log(`[ks-bets] Protection rules A/D/E/F/G/H/I/K: removed ${guardsRemoved} bet(s)`)

  // ── Same-pitcher conflict guard ─────────────────────────────────────────
  // Block direct contradictions: YES at strike S and NO at strike ≤ S on the
  // same pitcher means we're betting against ourselves. Different strategies
  // can fire on the same pitcher at non-overlapping strikes (legitimate
  // "exactly K=N" positions), but YES K7 + NO K6 is impossible to both win.
  // Drop the smaller-edge side when conflicts detected.
  const beforeConflict = guardedEdges.length
  const byPitcher = new Map()
  for (const e of guardedEdges) {
    if (!byPitcher.has(e.pitcher)) byPitcher.set(e.pitcher, [])
    byPitcher.get(e.pitcher).push(e)
  }
  const dropSet = new Set()
  for (const [pitcher, edges] of byPitcher) {
    const yesEdges = edges.filter(e => e.side === 'YES')
    const noEdges  = edges.filter(e => e.side === 'NO')
    if (yesEdges.length === 0 || noEdges.length === 0) continue
    for (const yes of yesEdges) {
      for (const no of noEdges) {
        if (Number(no.strike) <= Number(yes.strike)) {
          // Direct contradiction. Keep the higher-edge side, drop the other.
          const yesEdge = Math.abs(Number(yes._edgeVal ?? yes.edge ?? 0))
          const noEdge  = Math.abs(Number(no._edgeVal ?? no.edge ?? 0))
          const drop = yesEdge >= noEdge ? no : yes
          dropSet.add(drop)
          console.warn(`[conflict] ${pitcher}: YES K${yes.strike} (${yesEdge.toFixed(3)}) + NO K${no.strike} (${noEdge.toFixed(3)}) → dropping ${drop.side} K${drop.strike}`)
        }
      }
    }
  }
  if (dropSet.size > 0) {
    guardedEdges = guardedEdges.filter(e => !dropSet.has(e))
    console.log(`[ks-bets] Same-pitcher conflict guard: removed ${beforeConflict - guardedEdges.length} bet(s)`)
  }

  // ── INVERSION (Apr 25-May 2 empirical: model is reliably wrong on YES side) ───
  // When INVERT_YES_TO_NO=true, every YES edge that passed the guards becomes a
  // NO bet at the same strike+price. The K model is treated as a candidate
  // detector; the inversion layer decides direction; Kelly handles only sizing.
  //
  // ARCHITECTURE: Kelly is side-agnostic — given (modelProb, marketPrice, side)
  // it computes probWin (= modelProb for YES, 1-modelProb for NO) and the
  // fee-adjusted edge. If the calibrated probability we pass doesn't justify
  // betting, Kelly correctly returns betSize=0 — that's the system working as
  // intended. We do NOT hack the calibration to force bets.
  //
  // CALIBRATION: PAV-monotonized empirical win rates from the 7-day backtest.
  // For each model-confidence bucket, we compute the actual fraction of YES
  // wins and pass that to Kelly. Buckets where the model was most anti-
  // calibrated (low and mid confidence) generate the strongest NO edges.
  const INVERT_YES_TO_NO = String(process.env.INVERT_YES_TO_NO ?? '').toLowerCase() === 'true'
  function _calibrateYesProb(p) {
    // RECALIBRATED 2026-05-04 against new engine's actual selections (Rules 1-6):
    // After applying K5/K7+ ban + cold-pitcher block + pitcher blocklist + sizing
    // caps, the surviving bets show a different calibration profile than the
    // original 305-bet population. Smaller sample (109 bets) but it's the
    // population the live engine will actually create going forward.
    //   model_prob bucket  → actual YES win (n)
    //   <0.42              → 53.3%   (n=15)  — outperforms claim by +17pp
    //   0.42-0.52          → 33.3%   (n=12)
    //   0.52-0.65          → 38.5%   (n=39)
    //   >=0.65             → 58.1%   (n=43)
    if (p < 0.42) return 0.53
    if (p < 0.52) return 0.33
    if (p < 0.65) return 0.39
    return 0.58
  }
  // Conditional inversion filters (May 2 realistic-pricing audit):
  //   strike ∈ [5, 7]               — K5/K6/K7 had ROI 18-50%; skip K3-4 thin, K8+ weak
  //   (k9_l5 - careerK9) ≥ 0.5      — RELATIVE hotness: pitcher running ≥0.5 K9 above his
  //                                    own career baseline. Replaces absolute 7-11 range
  //                                    so an ace's "cold" 8 K9 doesn't trip the filter.
  //   model_prob ≥ 0.50             — skip low-confidence (mid+ is where bias bites)
  // All four are env-tunable; defaults match the audit.
  const INVERT_STRIKE_MIN = Number(process.env.INVERT_STRIKE_MIN ?? 5)
  const INVERT_STRIKE_MAX = Number(process.env.INVERT_STRIKE_MAX ?? 7)
  const INVERT_L5_GAP_MIN = Number(process.env.INVERT_L5_GAP_MIN ?? 0.5)
  const INVERT_MODELP_MIN = Number(process.env.INVERT_MODELP_MIN ?? 0.50)

  function _shouldInvert(e) {
    if (e.side !== 'YES') return false
    const k = Number(e.strike)
    if (k < INVERT_STRIKE_MIN || k > INVERT_STRIKE_MAX) return false
    const l5 = Number(e.k9_l5 ?? 0)
    const career = Number(e.k9_career ?? 0)
    if (career > 0 && (l5 - career) < INVERT_L5_GAP_MIN) return false  // not relatively hot
    if (Number(e.model_prob) < INVERT_MODELP_MIN) return false
    return true
  }

  let invertedEdges = guardedEdges
  if (INVERT_YES_TO_NO) {
    invertedEdges = guardedEdges.map(e => {
      if (!_shouldInvert(e)) return e
      const yesMid = Number(e.market_mid ?? 50)
      const origYesProb = Number(e.model_prob)
      const calYesProb = _calibrateYesProb(origYesProb)
      // NO bet edge (YES-convention): market_yes_price - calibrated_yes_prob.
      const noEdge = (yesMid / 100) - calYesProb
      return {
        ...e,
        side: 'NO',
        model_prob: calYesProb,        // YES-frame; Kelly does probWin=1-modelProb
        raw_model_prob: calYesProb,
        // market_mid unchanged (still YES price) — Kelly handles the conversion
        edge: noEdge,
        edge_yes: undefined,
        edge_no: noEdge,
        best_edge: noEdge,
        _edgeVal: noEdge,
        _inverted: true,
        _original_yes_prob: origYesProb,
      }
    })
    const flipped = invertedEdges.filter(e => e._inverted).length
    const skipped = guardedEdges.filter(e => e.side === 'YES' && !invertedEdges.find(x => x === e)?._inverted).length
    console.log(`[ks-bets] INVERT_YES_TO_NO active (conditional: K${INVERT_STRIKE_MIN}-${INVERT_STRIKE_MAX}, l5_gap≥${INVERT_L5_GAP_MIN}, model_prob≥${INVERT_MODELP_MIN}) — flipped ${flipped} YES → NO, kept ${skipped} YES as-is`)
    guardedEdges = invertedEdges
  }

  // ── Shadow audit: record what would happen at gap thresholds 0.0/0.2/0.5
  // for every YES candidate, plus calibrated-YES selection at edge thresholds
  // 0.0/0.03/0.05. Analytical-only, no orders placed. See lib/shadowInversion.js.
  try {
    const { recordShadowCandidates, recordCalibratedYesCandidates } = await import('../../lib/shadowInversion.js')
    const shadowCount = await recordShadowCandidates({ betDate: TODAY, candidates: guardedEdges })
    const calCount    = await recordCalibratedYesCandidates({ betDate: TODAY, candidates: guardedEdges })
    if (shadowCount > 0 || calCount > 0) {
      console.log(`[shadow] recorded inversion=${shadowCount} cal_yes=${calCount} row(s) for ${TODAY}`)
    }
  } catch (err) {
    console.warn(`[shadow] record failed: ${err.message}`)
  }



  // ── Pipeline: emit rule_filters per pitcher ─────────────────────────────
  // Group edges by pitcher to record one pipeline row per pitcher
  const _ruleFiltersByPitcher = new Map()
  for (const e of (edgesJson || [])) {
    const pid = String(e.pitcher_id || e.pitcher)
    if (!_ruleFiltersByPitcher.has(pid)) {
      _ruleFiltersByPitcher.set(pid, {
        pitcher_name: e.pitcher,
        pitcher_id: pid,
        inputs: [],
        passed: [],
        dropped_yes_cap: [],
        dropped_rule_a: [],
        dropped_rule_d: [],
        dropped_rule_g: [],
        dropped_rule_h: [],
        dropped_rule_i: [],
        dropped_rule_k: [],
        total_input: 0,
      })
    }
    const entry = _ruleFiltersByPitcher.get(pid)
    entry.inputs.push({ strike: e.strike, side: e.side, edge: e.edge, model_prob: e.model_prob })
    entry.total_input++
  }
  for (const e of withFill) {
    const entry = _ruleFiltersByPitcher.get(String(e.pitcher_id || e.pitcher))
    if (entry) entry.passed.push({ strike: e.strike, side: e.side, edge: e.edge })
  }
  // Record drops for each pitcher
  for (const e of deduped) {
    if (!withFill.includes(e)) {
      const entry = _ruleFiltersByPitcher.get(String(e.pitcher_id || e.pitcher))
      if (entry) entry.dropped_yes_cap.push({ strike: e.strike, side: e.side })
    }
  }
  for (const e of withFill) {
    if (!guardedEdges.includes(e)) {
      const entry = _ruleFiltersByPitcher.get(String(e.pitcher_id || e.pitcher))
      if (entry) {
        let reason = 'rule_d'
        if (e.side === 'NO' && (e.market_mid ?? 50) >= 65 && e.model_prob >= 0.50) reason = 'rule_a'
        else if (e.side === 'YES' && (
          e.model_prob < yesPregameMinProb ||
          (e.model_prob < yesPregameMinProbHi && (e.market_mid ?? 50) > yesPregameMaxMid)
        )) reason = 'rule_k'
        else if (e.side === 'NO' && e.strike === 7) reason = 'rule_i'
        else if (e.side === 'NO') reason = 'rule_a'
        if (reason === 'rule_a') entry.dropped_rule_a.push({ strike: e.strike, side: e.side })
        else if (reason === 'rule_k') entry.dropped_rule_k.push({ strike: e.strike, side: e.side })
        else if (reason === 'rule_i') entry.dropped_rule_i.push({ strike: e.strike, side: e.side })
        else entry.dropped_rule_d.push({ strike: e.strike, side: e.side })
      }
    }
  }
  for (const [pid, entry] of _ruleFiltersByPitcher) {
    const allPassedPitcher = guardedEdges.filter(e => String(e.pitcher_id || e.pitcher) === pid)
    const noPassedAtAll = allPassedPitcher.length === 0 && entry.total_input > 0
    recordPipelineStep({
      bet_date: TODAY, pitcher_id: pid, pitcher_name: entry.pitcher_name,
      step: 'rule_filters',
      payload: {
        yes_per_pitcher_cap: { dropped: entry.dropped_yes_cap },
        rule_a_no_ban: { dropped: entry.dropped_rule_a },
        rule_d_yes_low_prob: { dropped: entry.dropped_rule_d },
        rule_g_yes_high_strike: { dropped: entry.dropped_rule_g },
        rule_h_yes7_edge: { dropped: entry.dropped_rule_h },
        rule_i_no7_conditions: { dropped: entry.dropped_rule_i },
        rule_k_pregame: { dropped: entry.dropped_rule_k },
        inputs_count: entry.total_input,
        passed_count: allPassedPitcher.length,
      },
      summary: noPassedAtAll ? {
        final_action: 'filtered_out',
        skip_reason: entry.dropped_rule_a.length > 0 ? 'rule_a'
          : entry.dropped_rule_k.length > 0 ? 'rule_k'
          : entry.dropped_rule_i.length > 0 ? 'rule_i'
          : entry.dropped_rule_d.length > 0 ? 'rule_d' : 'yes_cap',
      } : {},
    }).catch(() => {})
  }


  // ── Portfolio correlation discount ──────────────────────────────────────────
  // When multiple outdoor games share adverse weather or a K-suppressing umpire,
  // their outcomes are correlated. Treat them as a cluster and discount Kelly
  // fractions by 1/√N where N = number of correlated games.
  const weatherCorrelatedGames = new Set()
  const umpCorrelatedGames = new Set()
  try {
    // Count distinct outdoor games with weather_mult < 0.97 on today's slate
    const weatherRows = await db.all(
      `SELECT DISTINCT game, weather_mult FROM ks_bets
       WHERE bet_date = ? AND live_bet = 0 AND weather_mult IS NOT NULL AND weather_mult < 0.97`,
      [TODAY],
    )
    const weatherGameSet = new Set(weatherRows.map(r => r.game))
    if (weatherGameSet.size >= 3) {
      for (const r of weatherRows) weatherCorrelatedGames.add(r.game)
      console.log(`[ks-bets] Weather correlation: ${weatherGameSet.size} outdoor games with mult<0.97 → discount ${(1 / Math.sqrt(weatherGameSet.size)).toFixed(3)}`)
    }

    // K-suppressing umpires: same ump_factor < 0.94 across multiple games
    const umpRows = await db.all(
      `SELECT DISTINCT game, ump_factor, ump_name FROM ks_bets
       WHERE bet_date = ? AND live_bet = 0 AND ump_factor IS NOT NULL AND ump_factor < 0.94`,
      [TODAY],
    )
    for (const r of umpRows) umpCorrelatedGames.add(r.game)
  } catch { /* non-fatal */ }

  function getCorrelationDiscount(game) {
    const isWeather = weatherCorrelatedGames.has(game)
    const isUmp     = umpCorrelatedGames.has(game)
    const N = (isWeather ? weatherCorrelatedGames.size : 0) + (isUmp ? umpCorrelatedGames.size : 0)
    if (N < 2) return 1.0
    return 1 / Math.sqrt(N)
  }

  // ── Log bets for each bettor (staggered to avoid market impact) ───────────
  // Apr 28 — reduced from 45s to 2s. Original 45s caused the second user to consistently
  // get 0 fills on thin Kalshi books because the first user swept the displayed liquidity
  // and the orderbook had time to move/disappear before user 2's order hit. 2s is enough
  // for Kalshi's match engine to settle user 1's IOC + WS fill confirmation without
  // letting the orderbook materially shift.
  const STAGGER_MS = 2_000
  let logged = 0
  const _webhooksWithBets = []  // only bettors who actually logged bets get Discord

  const _betsPlacedByPitcher = new Map()

  // Apr 28 — parallel placement (Option B). Each user's order placement runs concurrently
  // via Promise.all. Both users hit Kalshi at roughly the same instant; matching engine
  // splits available depth fairly. Eliminates the "first user sweeps liquidity, second
  // user gets 0" pattern that was systematically screwing Adam-Live across multiple days.
  await Promise.all(bettors.map(async (bettor, bi) => {
   try {

    const pregameRiskPct = bettor.pregame_risk_pct ?? 0.60
    const isLive  = bettor.paper === 0
    // Paper-mode short-circuit at the lib/kalshi.js level: when set, every user
    // (paper OR live) routes through placeOrder, but the wrapper returns
    // synthetic fills instead of touching real Kalshi. Lets us shadow-test
    // paper users that would otherwise never reach the placement code.
    const _pmFlag = String(process.env.KALSHI_PAPER_MODE ?? '').toLowerCase()
    const isPaperMode = _pmFlag === 'true' || _pmFlag === '1' || _pmFlag === 'yes'
    // creds: only meaningful for live users with real keys. Default {} so the
    // paper-user path can still call placeOrder/getOrderbook (which work
    // anonymously or short-circuit to synthetic in paper mode).
    const creds = (bettor.kalshi_key_id)
      ? { keyId: bettor.kalshi_key_id, privateKey: bettor.kalshi_private_key }
      : {}

    // For live accounts, Kelly base = Kalshi balance minus capital already committed today by THIS user.
    // Per-user calculation from ks_bets — avoids shared bankroll_state contamination between users.
    let bankroll
    if (isLive) {
      try {
        const kb = await getKalshiBalance(creds)
        const kalshiBalance = kb.balance_usd
        const committedRow = await db.one(
          `SELECT COALESCE(SUM(capital_at_risk), 0) as c FROM ks_bets
           WHERE bet_date=? AND user_id=? AND result IS NULL AND paper=0
             AND order_status NOT IN ('cancelled','void')`,
          [TODAY, bettor.id],
        ).catch(() => ({ c: 0 }))
        const alreadyCommitted = committedRow?.c ?? 0
        const availPool = Math.max(0, kalshiBalance - alreadyCommitted)
        bankroll = availPool > 0 ? availPool : kalshiBalance
        console.log(`[ks-bets] ${bettor.name} · Kalshi: $${kalshiBalance.toFixed(2)} | committed: $${alreadyCommitted.toFixed(2)} | available: $${availPool.toFixed(2)} → Kelly base: $${bankroll.toFixed(2)}`)
      } catch (err) {
        console.error(`[ks-bets] ${bettor.name} · Kalshi balance fetch failed: ${err.message} — skipping bets`)
        return  // Apr 28: was 'continue' for the for-loop; now 'return' exits this map callback only
      }
    } else {
      // Paper/shadow accounts use computed bankroll (no real money involved)
      const settledRow = await db.one(
        `SELECT SUM(pnl) as total FROM ks_bets WHERE result IN ('win','loss') AND bet_date < ? AND user_id = ?`,
        [TODAY, bettor.id],
      )
      bankroll = (bettor.starting_bankroll ?? STARTING_BANKROLL) + Number(settledRow?.total || 0)
    }


    // Count existing YES bets per pitcher today for this user — cap re-runs from stacking
    const existingYesRows = await db.all(
      `SELECT pitcher_name, COUNT(*) AS cnt FROM ks_bets
         WHERE bet_date=? AND live_bet=0 AND side='YES' AND user_id=?
         GROUP BY pitcher_name`,
      [TODAY, bettor.id],
    )
    const existingYesCounts = {}
    for (const r of existingYesRows) existingYesCounts[r.pitcher_name] = r.cnt

    // ── Kelly-based sizing ────────────────────────────────────────────────────
    // Opportunity discount: reduces effective bankroll when many games remain,
    // Opportunity discount: use count of pitchers with actual edge in this run.
    // Raw pending-game count over-discounts on large slates where most games have no edge.
    // The portfolio cap is the primary total-exposure constraint; discount is a secondary lever.
    const edgePitcherCount  = new Set(guardedEdges.map(e => String(e.pitcher_id || e.pitcher))).size
    const effectiveCount    = Math.max(1, edgePitcherCount)

    const pregamePool       = bankroll * pregameRiskPct
    const discount          = opportunityDiscount(effectiveCount)
    const effectiveBankroll = pregamePool * discount
    const perPitcherCap     = pregamePool * 0.10

    console.log(`[ks-bets] ${bettor.name} · pre-game pool $${pregamePool.toFixed(0)} · discount ${discount.toFixed(2)} (${effectiveCount} edge pitchers) · effective $${effectiveBankroll.toFixed(0)}`)

    // Group edges by pitcher and apply correlated Kelly per group
    const edgesByPitcher = new Map()
    for (const e of guardedEdges) {
      const key = String(e.pitcher_id || e.pitcher)
      if (!edgesByPitcher.has(key)) edgesByPitcher.set(key, [])
      edgesByPitcher.get(key).push(e)
    }

    let sized = []
    for (const [, pitcherEdges] of edgesByPitcher) {
      const kellyInputs = pitcherEdges.map(e => ({
        modelProb:   e.model_prob,
        marketPrice: e.market_mid / 100,
        side:        e.side,
      }))
      const kellyResults = correlatedKellyDivide(kellyInputs, false, effectiveBankroll)

      const pitcherTotal = kellyResults.reduce((s, k) => s + (k?.betSize || 0), 0)
      const capScale = pitcherTotal > perPitcherCap ? perPitcherCap / pitcherTotal : 1.0

      for (let i = 0; i < pitcherEdges.length; i++) {
        const e = pitcherEdges[i]
        const k = kellyResults[i]
        if (!k || k.betSize <= 0) continue
        const corrDisc   = getCorrelationDiscount(e.game)
        let betDollars = k.betSize * capScale * corrDisc

        // Rule 6: high-confidence size haircut — calibration shows model_prob ≥ 0.65
        // bucket actual win rate is 48% (claim 75%, 27pp gap). Halve the size to
        // mitigate. Applies only to YES (the calibration is YES-frame).
        if (e.side === 'YES' && Number(e.model_prob ?? 0) >= highConfThreshold && highConfSizeHaircut < 1) {
          betDollars *= highConfSizeHaircut
        }

        // Rule 4: per-bet bankroll cap — D9-D10 sizing decile lost money.
        // Cap each bet at maxPctBankrollPerBet * RAW bankroll (Kalshi balance,
        // NOT effective bankroll which is post-discount). Using effective
        // would over-cap on busy days when discount is small. Default 4%:
        // Adam-Live $260 → $10 max, Isaiah $513 → $20 max.
        if (maxPctBankrollPerBet > 0 && bankroll > 0) {
          const perBetCap = maxPctBankrollPerBet * bankroll
          if (betDollars > perBetCap) betDollars = perBetCap
        }

        // Strategy B (cross-strike) — tighter cap to limit per-fire variance.
        // Math-based strategy with asymmetric payouts: tail bets at <25¢ ask
        // get hard $ cap to prevent one bad outcome wiping multiple wins.
        if (e.strategy_mode === 'pregame_cross_strike') {
          if (csMaxPctBankroll > 0 && bankroll > 0) {
            const csCap = csMaxPctBankroll * bankroll
            if (betDollars > csCap) betDollars = csCap
          }
          // Tail bet hard cap (ask < threshold cents)
          const askCents = e._ask_cents ?? Math.round(e._fill * 100)
          if (askCents < csTailAskThreshold && betDollars > csTailDollarCap) {
            betDollars = csTailDollarCap
          }
        }

        if (betDollars < 0.01) continue
        const face = Math.max(1, Math.round(betDollars / e._fill))
        sized.push({ ...e, _face: face, _actualRisk: face * e._fill, kelly_fraction: k.kellyFraction * capScale })
      }
    }
    sized.sort((a, b) => b._actualRisk - a._actualRisk)

    // Min bet floor: drop positions too small to be worth the execution overhead and fees.
    // A $3 bet at 47¢ (6 contracts) has $0.11 in Kalshi fees — ~4% friction on top of spread.
    const floorDropped = sized.filter(e => e._actualRisk < minBetFloor).length
    if (floorDropped > 0) console.log(`[ks-bets] Min bet floor $${minBetFloor}: dropped ${floorDropped} sub-floor bet(s)`)
    sized = sized.filter(e => e._actualRisk >= minBetFloor)

    // Portfolio-level cap: total pre-game risk cannot exceed the pre-game pool.
    // Kelly sizes bets independently per pitcher, but with many opportunities the
    // sum can exceed the pool ceiling. Scale everything down proportionally if needed.
    const rawPortfolioRisk = sized.reduce((s, e) => s + e._actualRisk, 0)
    if (rawPortfolioRisk > pregamePool) {
      const portfolioScale = pregamePool / rawPortfolioRisk
      console.log(`[ks-bets] ${bettor.name}: portfolio scale ×${portfolioScale.toFixed(3)} (total $${rawPortfolioRisk.toFixed(0)} → $${pregamePool.toFixed(0)} pool cap)`)
      for (const e of sized) {
        e._face        = Math.max(1, Math.round(e._face * portfolioScale))
        e._actualRisk  = e._face * e._fill
        e.kelly_fraction *= portfolioScale
      }
    }

    console.log(
      `\n[ks-bets] ${bettor.name} · Bankroll $${bankroll.toFixed(0)} · ${sized.length} bets · total risk $${sized.reduce((s,e)=>s+e._actualRisk,0).toFixed(0)} · ${isLive ? 'LIVE' : 'paper'}`,
    )

    // Pre-fire summary — opt-in via DISCORD_PREFIRE_REPORT_ENABLED. Posts to
    // Discord BEFORE the placement loop so the user can see what's about to
    // fire alongside calibrated-YES shadow context (would-skip / would-fire)
    // and the Civale-style risk flag (K≤5 + mp 0.50-0.60 + sized > $10).
    if (sized.length > 0) {
      try {
        const { notifyPrefireSummary } = await import('../../lib/cageAlerts.js')
        await notifyPrefireSummary({ bettorName: bettor.name, sized, betDate: TODAY }).catch(() => {})
      } catch { /* non-fatal — never block placement on Discord */ }
    }

    const now = new Date().toISOString()
    let bettorLogged = 0, ordersPlaced = 0, ordersFailed = 0

    for (const e of sized) {
      // Enforce per-pitcher YES cap accounting for bets already in DB from prior runs
      if (e.side === 'YES') {
        const alreadyYes = existingYesCounts[e.pitcher] || 0
        if (alreadyYes >= MAX_YES_PER_PITCHER) {
          console.log(`  [skip] ${e.pitcher} ${e.strike}+ YES — already have ${alreadyYes} YES bets (cap ${MAX_YES_PER_PITCHER})`)
          continue
        }
        existingYesCounts[e.pitcher] = alreadyYes + 1  // reserve slot for this bet
      }

      // Skip pitchers whose game has already started per the games table.
      // Hard guard: if game_time is more than 5 min in the future, ignore stale 'live' flags —
      // the MLB API occasionally returns 'live' during warmups hours before first pitch.
      if (e.pitcher_id) {
        const gameRow = await db.one(
          `SELECT status, game_time FROM games WHERE date=? AND (pitcher_home_id=? OR pitcher_away_id=?)`,
          [TODAY, String(e.pitcher_id), String(e.pitcher_id)],
        )
        if (gameRow && (gameRow.status === 'live' || gameRow.status === 'final')) {
          const _gt = gameRow.game_time && !String(gameRow.game_time).endsWith('Z') && !String(gameRow.game_time).includes('+')
            ? gameRow.game_time + 'Z' : gameRow.game_time
          const _gameMs = _gt ? new Date(_gt).getTime() : 0
          if (_gameMs > Date.now() + 5 * 60_000) {
            console.log(`  [guard] ${e.pitcher} — game shows ${gameRow.status} but starts in ${Math.round((_gameMs - Date.now()) / 60000)}min — proceeding`)
          } else {
            console.log(`  [skip] ${e.pitcher} — game already live/final (${gameRow.status})`)
            continue
          }
        }
      }

      // Fallback: skip if any settled bet exists for this pitcher today
      const alreadySettled = await db.one(
        `SELECT id FROM ks_bets WHERE bet_date=? AND pitcher_name=? AND live_bet=0 AND result IS NOT NULL
           AND (user_id=? OR (user_id IS NULL AND ? IS NULL))`,
        [TODAY, e.pitcher, bettor.id, bettor.id],
      )
      if (alreadySettled) {
        console.log(`  [skip] ${e.pitcher} — game already in progress (settled bet exists)`)
        continue
      }

      const existing = await db.one(
        `SELECT order_id FROM ks_bets
         WHERE bet_date=? AND pitcher_name=? AND strike=? AND side=? AND live_bet=0
           AND (user_id=? OR (user_id IS NULL AND ? IS NULL))`,
        [TODAY, e.pitcher, e.strike, e.side, bettor.id, bettor.id],
      )

      await db.upsert('ks_bets', {
        bet_date:        TODAY,
        logged_at:       now,
        user_id:         bettor.id,
        pitcher_id:      e.pitcher_id || null,
        pitcher_name:    e.pitcher,
        team:            e.team,
        game:            e.game,
        strike:          e.strike,
        side:            e.side,
        model_prob:      e.model_prob,
        market_mid:      e.market_mid,
        edge:            e.edge,
        lambda:          e.lambda,
        k9_career:       e.k9_career       ?? null,
        k9_season:       e.k9_season       ?? null,
        k9_l5:           e.k9_l5           ?? null,
        opp_k_pct:       e.opp_k_pct,
        adj_factor:      e.adj_factor,
        n_starts:        e.n_starts,
        confidence:      e.confidence,
        savant_k_pct:    e.savant_k_pct    ?? null,
        savant_whiff:    e.savant_whiff    ?? null,
        savant_fbv:      e.savant_fbv      ?? null,
        whiff_flag:      e.whiff_flag      ?? null,
        ticker:          e.ticker,
        bet_size:        e._face,
        kelly_fraction:  e.kelly_fraction  ?? null,
        raw_model_prob:  e.raw_model_prob  ?? null,
        capital_at_risk: Math.round(e._face * e._fill * 100) / 100,
        park_factor:     e.park_factor     ?? null,
        weather_mult:    e.weather_mult    ?? null,
        ump_factor:      e.ump_factor      ?? null,
        ump_name:        e.ump_name        ?? null,
        velo_adj:        e.velo_adj        ?? null,
        velo_trend_mph:  e.velo_trend_mph  ?? null,
        bb_penalty:      e.bb_penalty      ?? null,
        raw_adj_factor:  e.raw_adj_factor  ?? null,
        spread:          e.spread          ?? null,
        live_bet:        0,
        paper:           (isLive && !isPaperMode) ? 0 : 1,
        // Preserve strategy_mode if set by candidate generator (e.g. pregame_cross_strike).
        // Otherwise default to pregame_inversion if flipped, else pregame_normal.
        strategy_mode:   validateStrategyMode(
                           e.strategy_mode ??
                             (e._inverted ? STRATEGY_MODES.PREGAME_INVERSION : STRATEGY_MODES.PREGAME_NORMAL),
                           'ksBets:pregame_upsert'),
        strategy_submode: e.strategy_submode ?? (e._inverted ? 'inverted_'+e.side : null),
      }, ['bet_date', 'pitcher_name', 'strike', 'side', 'live_bet', 'user_id'])
      bettorLogged++
      logged++

      // Track for pipeline bets_placed emission
      {
        const pid = String(e.pitcher_id || e.pitcher)
        if (!_betsPlacedByPitcher.has(pid)) {
          _betsPlacedByPitcher.set(pid, { pitcher_name: e.pitcher, rows: [], total_risk: 0 })
        }
        const pbp = _betsPlacedByPitcher.get(pid)
        pbp.rows.push({
          strike: e.strike,
          side: e.side,
          bet_size: e._face,
          fill: e._fill,
          edge: e.edge,
          model_prob: e.model_prob,
          ticker: e.ticker ?? null,
        })
        pbp.total_risk += e._face * e._fill
      }

      if ((isLive || isPaperMode) && e.ticker && !existing?.order_id) {
        {
          const mid        = e.market_mid ?? 50
          const halfSpread = (e.spread ?? 4) / 2
          let askCents     = e.side === 'YES'
            ? Math.min(99, Math.round(mid + halfSpread))
            : Math.min(99, Math.round(100 - mid + halfSpread))
          // TAKER: hit the current ask immediately — no resting, no adverse selection
          // Orderbook depth check — cap contracts at available liquidity
          let contracts = Math.max(1, Math.round(e._face))

          // API-level dedup: check Kalshi for existing fills + resting orders on this ticker+side.
          // Catches cases where DB row was overwritten (multi-user schema collision) or script re-ran.
          // Skip for paper users in paper mode — they have no real-Kalshi state to dedupe against,
          // and these calls would either fail (no creds) or pollute the paper run with real fills.
          if (isLive && !isPaperMode) {
            try {
              const sideKey = e.side.toLowerCase()
              const [existingFills, restingOrders] = await Promise.all([
                getFills({ ticker: e.ticker, limit: 200 }, creds).catch(() => []),
                listOrders({ ticker: e.ticker, status: 'resting' }, creds).catch(() => []),
              ])
              const filledContracts = existingFills
                .filter(f => f.side === sideKey)
                .reduce((s, f) => s + Number(f.count_fp || 0), 0)
              const restingContracts = restingOrders
                .filter(o => o.side === sideKey)
                .reduce((s, o) => s + Number(o.remaining_count || o.count || 0), 0)
              if (filledContracts + restingContracts > 0) {
                console.log(`  [kalshi] SKIP    ${e.side} ${e.strike}+ ${e.pitcher} — already ${filledContracts} filled + ${restingContracts} resting on Kalshi`)
                continue
              }
            } catch { /* non-fatal — proceed with order */ }
          }
          try {
            const ob = await getOrderbook(e.ticker, 10, creds)
            if (ob) {
              // Use real best ask from orderbook instead of mid+halfSpread estimate
              if (e.side === 'YES' && ob.best_yes_ask != null) askCents = ob.best_yes_ask
              if (e.side === 'NO'  && ob.best_no_ask  != null) askCents = ob.best_no_ask
              // For maker orders: cap at depth available at the ask (what we'd need if jumped)
              const depth = availableDepth(ob, e.side.toLowerCase(), askCents)
              if (depth > 0 && contracts > depth) {
                console.log(`  [depth] ${e.pitcher} ${e.strike}+ ${e.side}: capping ${contracts}→${depth}c (only ${depth} available at ask)`)
                contracts = depth
              }
            }
          } catch { /* non-fatal — proceed with original sizing */ }

          // Acquire DB mutex before placing — prevents Railway+Closer double-betting same market.
          // INSERT OR IGNORE: first process wins, second sees acquired=false and skips.
          const lockAcquired = await acquireBetLock(TODAY, String(e.pitcher_id ?? e.pitcher), e.strike, e.side, bettor.id)
          if (!lockAcquired) {
            console.log(`  [lock] SKIP    ${e.side} ${e.strike}+ ${e.pitcher} — another process holds the lock`)
            continue
          }

          // ── Hard caps (Day 1 cage) ─────────────────────────────
          // Per-user inversion + live caps + global daily loss. Inversion bets get
          // strategy_mode='pregame_inversion'; non-inverted YES/NO get 'pregame_normal'
          // (capless tonight beyond the global $500 brake).
          {
            const capMode = e._inverted ? STRATEGY_MODES.PREGAME_INVERSION : STRATEGY_MODES.PREGAME_NORMAL
            const capCheck = await checkAllCaps({
              db,
              userId: bettor.id,
              pitcherId: String(e.pitcher_id || e.pitcher),
              betDate: TODAY,
              strategy_mode: capMode,
            })
            if (!capCheck.allowed) {
              console.log(`  [cap] SKIP    ${e.side} ${e.strike}+ ${e.pitcher} (${bettor.name}) — ${capCheck.reason}`)
              continue
            }
          }

          // ── Oracle gate ─────────────────────────────────────────
          // ORACLE_STAGE: 0=off (default; behaves as before)
          //               1=shadow (log only, no enforcement)
          //               2=skip-only veto
          //               3=skip + Critic concern downgrade (BOOST DISABLED:
          //                 if Critic boosted size_down→fire, revert to size_down)
          //               4=full ladder (skip + concern + BOOST upgrade)
          // FAIL OPEN on any error: production decides as before.
          const oracleStage = Number(process.env.ORACLE_STAGE ?? 0)
          if (oracleStage > 0) {
            try {
              const { runOracleGate } = await import('./oracleGate.js')
              const gate = await runOracleGate({
                bet_date:     TODAY,
                pitcher_id:   String(e.pitcher_id ?? e.pitcher),
                pitcher_name: e.pitcher,
                strike:       e.strike,
                side:         e.side,
                market_mid:   e.mid_cents ?? Math.round(askCents),
                spread:       e.spread_cents ?? null,
                bankroll:     1000,
                bet_id:       null,
                ticker:       e.ticker ?? null,
              })

              // Stage 3 vs 4: detect Critic boost. Boost upgrades size_down→fire.
              // Stage 3 reverts that back to size_down (keeps Critic conservative).
              // Stage 4 lets it stand.
              const criticApplied = gate.oracle?.critic_applied ?? []
              const boostUpgraded = criticApplied.includes('boost')
              let effectiveAction = gate.action
              let stage3RevertedBoost = false
              if (oracleStage === 3 && boostUpgraded) {
                effectiveAction = 'size_down'
                stage3RevertedBoost = true
              }

              const { appendFileSync, mkdirSync } = await import('node:fs')
              const path = await import('node:path')
              mkdirSync(path.resolve('oracle'), { recursive: true })
              appendFileSync(
                path.resolve(`oracle/oracle-sim-${TODAY}.jsonl`),
                JSON.stringify({
                  ts: new Date().toISOString(), source: 'ksBets_hook',
                  bet_date: TODAY, pitcher_id: String(e.pitcher_id ?? e.pitcher),
                  pitcher_name: e.pitcher, strike: e.strike, side: e.side,
                  ticker: e.ticker ?? null,
                  market_mid: askCents, oracle_action: gate.action,
                  effective_action: effectiveAction,
                  stage3_reverted_boost: stage3RevertedBoost,
                  oracle_baseline: gate.baseline, oracle: gate.oracle,
                  oracle_error: gate.error, elapsed_ms: gate.timing?.elapsed_ms,
                  stage_in_effect: oracleStage,
                  critic_reason_text: gate.oracle?.critic_reason_text ?? '',
                }) + '\n', 'utf-8',
              )

              // Persist trace to Turso so it survives Railway redeploys.
              // JSONL is on the ephemeral filesystem; oracle_bet_traces is durable.
              try {
                const decisionId = `ksbet-${TODAY}-${String(e.pitcher_id ?? e.pitcher)}-${e.strike}-${e.side}-${bettor.id}`
                const sizeUsd = Math.round((Math.max(1, Math.round(e._face)) * (askCents / 100)) * 100) / 100
                const traceMode = e._inverted ? STRATEGY_MODES.PREGAME_INVERSION : STRATEGY_MODES.PREGAME_NORMAL
                const traceSubmode = e._inverted ? 'inverted_'+e.side : null
                await db.run(
                  `INSERT OR REPLACE INTO oracle_bet_traces (
                     decision_id, system, pitcher_id, game_pk, market_ticker,
                     bet_date, strike, side, final_decision, final_size_usd,
                     would_have_executed, executed, bet_id, created_at,
                     strategy_mode, strategy_submode
                   ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                  [
                    decisionId,
                    `oracle_stage${oracleStage}_user${bettor.id}`,
                    String(e.pitcher_id ?? e.pitcher),
                    e.game_id ?? null,
                    e.ticker ?? null,
                    TODAY,
                    Number(e.strike),
                    e.side,
                    effectiveAction,
                    sizeUsd,
                    effectiveAction === 'pass' ? 1 : 0,
                    effectiveAction !== 'skip' ? 1 : 0,
                    null,
                    new Date().toISOString(),
                    validateStrategyMode(traceMode, 'oracle_bet_traces'),
                    traceSubmode,
                  ],
                )
              } catch (traceErr) {
                console.warn(`  [oracle] trace insert failed (non-fatal): ${traceErr.message}`)
              }

              const tag = effectiveAction === 'pass' && boostUpgraded && oracleStage === 4 ? 'BOOST→FIRE'
                       : effectiveAction.toUpperCase()
              console.log(`  [oracle:${oracleStage}] ${e.side} ${e.strike}+ ${e.pitcher} → ${tag} (${gate.oracle?.reason ?? gate.error ?? '?'})`)

              if (oracleStage >= 2 && effectiveAction === 'skip') {
                console.log(`  [oracle] ENFORCING SKIP for ${e.pitcher} ${e.strike}+ ${e.side}`)
                // Delete the speculative ks_bets row inserted at L597 so settlement
                // doesn't compute phantom P&L on a never-placed order.
                await db.run(
                  `DELETE FROM ks_bets WHERE bet_date=? AND pitcher_name=? AND strike=? AND side=?
                   AND user_id=? AND live_bet=0 AND order_id IS NULL`,
                  [TODAY, e.pitcher, e.strike, e.side, bettor.id],
                ).catch(err => console.warn(`  [oracle] skip-cleanup delete failed (non-fatal): ${err.message}`))
                continue
              }
              if (oracleStage >= 3 && effectiveAction === 'size_down') {
                const orig = contracts
                contracts = Math.max(1, Math.floor(contracts * 0.5))
                console.log(`  [oracle] ENFORCING SIZE_DOWN for ${e.pitcher} ${e.strike}+ ${e.side}: ${orig}→${contracts}c${stage3RevertedBoost ? ' (Stage 3 reverted boost)' : ''}`)
              }
              // Stage 4 + boost: effectiveAction='pass'; bet fires at full size
              // (already the default behavior)
            } catch (oracleErr) {
              console.error(`  [oracle] GATE ERROR (failing open): ${oracleErr.message}`)
            }
          }

          let orderId = null
          try {
            const result = await placeOrder(e.ticker, e.side.toLowerCase(), contracts, askCents, creds)
            const order  = result?.order ?? result

            orderId = order?.order_id    ?? null
            // Always store fill_price as YES price so best_case formula (profit = fill_price/100 for NO) is consistent.
            // For YES bets askCents IS the YES price. For NO bets askCents is the NO ask, so complement it.
            const fillPrice   = e.side === 'NO' ? (100 - askCents) : askCents
            let filledConts   = order?.filled_count ?? 0
            const placedAt    = order?.created_time ?? new Date().toISOString()

            // IOC simulation: Kalshi processes fills async — wait 2s then check order status.
            // If still unfilled, cancel (true taker: no resting orders). If filled, keep.
            if (orderId && filledConts < contracts) {
              await new Promise(r => setTimeout(r, 2000))
              const confirmed = await getOrder(orderId, creds).catch(() => null)
              filledConts = Math.round(parseFloat(confirmed?.fill_count_fp ?? confirmed?.filled_count ?? filledConts))
              if (filledConts < contracts) {
                await cancelOrder(orderId, creds).catch(() => {})
                console.log(`  [taker-IOC] ${e.pitcher} ${e.strike}+ ${e.side}: ${filledConts}/${contracts} filled — cancelled unfilled ${contracts - filledConts}c`)
              }
            }

            const status = filledConts >= contracts ? 'filled' : (filledConts > 0 ? 'partial' : 'cancelled')

            // paper flag: 0 only when this is a real-money fill (live user AND not paper-mode).
            const paperFlag = (isLive && !isPaperMode) ? 0 : 1
            await db.run(
              `UPDATE ks_bets SET order_id=?, fill_price=?, filled_at=?, filled_contracts=?, order_status=?, paper=?,
                 ticker=COALESCE(ticker, ?)
               WHERE bet_date=? AND pitcher_name=? AND strike=? AND side=? AND live_bet=0
                 AND (user_id=? OR (user_id IS NULL AND ? IS NULL))`,
              [orderId, fillPrice, placedAt, filledConts, status, paperFlag, e.ticker ?? null, TODAY, e.pitcher, e.strike, e.side, bettor.id, bettor.id],
            )

            // Confirm lock (sets bet_id so it's never swept as stale) and track committed capital.
            const betRow = await db.one(`SELECT id FROM ks_bets WHERE bet_date=? AND pitcher_name=? AND strike=? AND side=? AND live_bet=0 AND (user_id=? OR (user_id IS NULL AND ? IS NULL)) LIMIT 1`, [TODAY, e.pitcher, e.strike, e.side, bettor.id, bettor.id]).catch(() => null)
            await confirmBetPlaced(TODAY, String(e.pitcher_id ?? e.pitcher), e.strike, e.side, betRow?.id ?? orderId, bettor.id)
            const capitalAtRisk = Math.round(e._face * e._fill * 100) / 100
            await addCommitted(TODAY, capitalAtRisk)

            ordersPlaced++
            console.log(`  [kalshi] TAKER  ${e.side} ${e.strike}+ ${e.pitcher.padEnd(24)} ${contracts}c @ ${askCents}¢  id=${orderId}  committed=$${capitalAtRisk.toFixed(2)}`)

            // Calibrate-Kelly shadow: record what size Kelly WOULD have produced
            // if it had been fed calibrated_yes_prob instead of raw model_prob.
            // Same fire/skip decision (we keep the actual fire), just resized.
            if (e.side === 'YES' && betRow?.id) {
              try {
                const { recordCalibrateKellyShadow } = await import('../../lib/shadowInversion.js')
                await recordCalibrateKellyShadow({
                  ks_bet_id:      betRow.id,
                  betDate:        TODAY,
                  userId:         bettor.id,
                  pitcherName:    e.pitcher,
                  strike:         e.strike,
                  side:           e.side,
                  modelProb:      e.model_prob,
                  marketMid:      e.market_mid,
                  spread:         e.spread,
                  bankroll,
                  kellyFraction:  e.kelly_fraction ?? null,
                  capitalAtRisk,
                }).catch(() => {})
              } catch { /* non-fatal */ }
            }

            // ── Apr 29 — NO contra-test experiment ──────────────────────────────
            // See memory: project_baseball_contra_test_apr29.md  Decision: 2026-05-20.
            // Hypothesis: tail-strike NO is under-priced. Backtest 4/22-4/28 showed
            // +5.2% realized ROI on 207 inverted-fill NOs vs 1.2% YES baseline.
            // 1-contract NO at strikes 6/7/8 when implied NO ∈ [35,65]¢, Adam only.
            try {
              const eligibleStrike = [6, 7, 8].includes(e.strike)
              const impliedNo = 100 - askCents
              const inBand = impliedNo >= 35 && impliedNo <= 65
              if (
                bettor.id === 2 &&            // Adam only
                e.side === 'YES' &&
                filledConts > 0 &&            // parent YES actually filled
                eligibleStrike &&
                inBand
              ) {
                // Daily + per-pitcher caps
                const dailyCount = await db.one(
                  `SELECT COUNT(*) AS n FROM ks_bets
                   WHERE bet_date = ? AND user_id = ? AND bet_mode = 'contra-test'`,
                  [TODAY, bettor.id],
                ).catch(() => ({ n: 999 }))
                const pitcherCount = await db.one(
                  `SELECT COUNT(*) AS n FROM ks_bets
                   WHERE bet_date = ? AND user_id = ? AND bet_mode = 'contra-test' AND pitcher_id = ?`,
                  [TODAY, bettor.id, String(e.pitcher_id ?? '')],
                ).catch(() => ({ n: 999 }))

                if (dailyCount.n >= 5) {
                  console.log(`  [contra-test] SKIP — daily cap (5) reached`)
                } else if (pitcherCount.n >= 2) {
                  console.log(`  [contra-test] SKIP ${e.pitcher} ${e.strike}+ — pitcher cap (2) reached`)
                } else {
                  const ob2 = await getOrderbook(e.ticker, 5, creds).catch(() => null)
                  const noAskCents = ob2?.best_no_ask ?? (impliedNo + 2)
                  if (noAskCents < 35 || noAskCents > 70) {
                    console.log(`  [contra-test] SKIP ${e.pitcher} ${e.strike}+ — fresh no_ask ${noAskCents}¢ outside band`)
                  } else {
                    let contraOrderId = null, contraFilled = 0
                    try {
                      const cr = await placeOrder(e.ticker, 'no', 1, noAskCents, creds)
                      const o = cr?.order ?? cr
                      contraOrderId = o?.order_id ?? null
                      contraFilled  = Number(o?.filled_count ?? 0)
                      if (contraOrderId && contraFilled < 1) {
                        await new Promise(r => setTimeout(r, 2000))
                        const conf = await getOrder(contraOrderId, creds).catch(() => null)
                        contraFilled = Math.round(parseFloat(conf?.fill_count_fp ?? conf?.filled_count ?? contraFilled))
                        if (contraFilled < 1) await cancelOrder(contraOrderId, creds).catch(() => {})
                      }
                    } catch (cerr) {
                      console.log(`  [contra-test] FAIL ${e.pitcher} ${e.strike}+ NO @${noAskCents}¢ — ${cerr.message}`)
                    }
                    if (contraFilled >= 1) {
                      const contraStatus = 'filled'
                      // Insert ks_bets row tagged contra-test. fill_price stored as YES-equiv (100 - noAsk) for consistency with rest of system.
                      await db.upsert('ks_bets', {
                        bet_date:        TODAY,
                        logged_at:       new Date().toISOString(),
                        user_id:         bettor.id,
                        pitcher_id:      e.pitcher_id || null,
                        pitcher_name:    e.pitcher,
                        team:            e.team,
                        game:            e.game,
                        strike:          e.strike,
                        side:            'NO',
                        model_prob:      e.model_prob,
                        market_mid:      e.market_mid,
                        edge:            e.edge,
                        lambda:          e.lambda,
                        ticker:          e.ticker,
                        bet_size:        1,
                        capital_at_risk: Math.round(noAskCents) / 100,
                        bet_mode:        'contra-test',
                        order_id:        contraOrderId,
                        fill_price:      100 - noAskCents,
                        filled_at:       new Date().toISOString(),
                        filled_contracts: contraFilled,
                        order_status:    contraStatus,
                        live_bet:        0,
                        // Paper flag must respect KALSHI_PAPER_MODE — synthetic
                        // paper-prefix order_ids must NEVER be flagged paper=0
                        // (recon halt cascade: 2026-05-04 JR Ritchie incident).
                        paper:           (isLive && !isPaperMode) ? 0 : 1,
                        strategy_mode:   validateStrategyMode(STRATEGY_MODES.PREGAME_INVERSION, 'ksBets:contra_test'),
                        strategy_submode: 'contra_test_legacy',
                      }, ['bet_date', 'pitcher_name', 'strike', 'side', 'live_bet', 'user_id'])
                      console.log(`  [contra-test] PLACED  ${e.pitcher} ${e.strike}+ NO 1c @${noAskCents}¢ (parent YES @${askCents}¢, implied NO ${impliedNo}¢)`)
                    }
                  }
                }
              }
            } catch (cerr) {
              console.error(`  [contra-test] ERROR ${e.pitcher} ${e.strike}+: ${cerr.message}`)
            }
          } catch (err) {
            // Release lock on failure so other processes (or a retry) can place this bet
            await releaseBetLock(TODAY, String(e.pitcher_id ?? e.pitcher), e.strike, e.side, bettor.id)
            orderId = null
            ordersFailed++
            console.error(`  [kalshi] FAILED  ${e.side} ${e.strike}+ ${e.pitcher}: ${err.message}`)
          }
        }
      } else if (existing?.order_id) {
        console.log(`  [kalshi] SKIP    ${e.side} ${e.strike}+ ${e.pitcher} — already ordered`)
      }
    }

    const totalRisk = sized.reduce((s, e) => s + e._face * e._fill, 0)
    console.log(`[ks-bets] ${bettor.name}: logged ${bettorLogged} · orders ${ordersPlaced} placed / ${ordersFailed} failed · risk $${totalRisk.toFixed(0)} of $${bankroll.toFixed(0)} (${(totalRisk/bankroll*100).toFixed(1)}%)`)
    if (bettorLogged > 0 && bettor.discord_webhook) _webhooksWithBets.push(bettor.discord_webhook)
   } catch (err) {
     // Apr 28 — per-user error fence. Previously an exception thrown while processing
     // user N (e.g. Kalshi API timeout, DB write race, balance fetch fail after stagger)
     // killed the whole subprocess so user N+1 (Adam-Live often) never got a chance to
     // place orders. This caused chronic missed bets visible in the data:
     //   • Wrobleski 5+ Apr 26: Adam 0 vs Isaiah 84 (a winner Adam missed)
     //   • Tolle 6+/7+ Apr 28: Adam 0 vs Isaiah filled both
     //   • Messick 7+ Apr 27: Adam 0 vs Isaiah 24
     // Now we log the failure and continue to the next user.
     console.error(`[ks-bets] ${bettor.name} processing FAILED — ${err.message} — other users continue`)
     try { db.saveLog?.({ tag: 'BUG', level: 'error', msg: `ksBets per-user failure: ${bettor.name} — ${err.message}` })?.catch?.(() => {}) } catch {}
   }
  }))

  // Cache today's Kalshi open prices for real-price backtest
  try {
    const { default: { execSync } } = await import('child_process')
    execSync(`node scripts/live/backtestKalshi.js --cache --date ${TODAY}`, {
      cwd: process.cwd(), timeout: 30000, encoding: 'utf8',
    })
  } catch (err) {
    console.warn('[ks-bets] Price cache step failed (non-fatal):', err.message?.slice(0, 100))
  }

  // ── Pipeline: emit no_execution for pitchers whose edges passed filters but got no bets ──
  // Happens when: game already live/final at bet time, Kalshi order rejected, all skipped by per-pitcher cap.
  // Without this, the pipeline shows a 'rule_filters' step with no final_action — looks like a process crash.
  const pitchersWithPassedEdges = new Set(guardedEdges.map(e => String(e.pitcher_id || e.pitcher)))
  for (const pid of pitchersWithPassedEdges) {
    if (!_betsPlacedByPitcher.has(pid)) {
      const srcEdge = guardedEdges.find(e => String(e.pitcher_id || e.pitcher) === pid)
      recordPipelineStep({
        bet_date: TODAY, pitcher_id: pid, pitcher_name: srcEdge?.pitcher ?? pid,
        step: 'bets_placed',
        payload: {},
        summary: { final_action: 'no_execution', skip_reason: 'edge passed filters but no bet placed (game live/final or Kalshi error)' },
      }).catch(() => {})
    }
  }

  // ── Pipeline: emit bets_placed per pitcher ─────────────────────────────
  for (const [pid, pbp] of _betsPlacedByPitcher) {
    if (!pbp.rows.length) continue
    recordPipelineStep({
      bet_date: TODAY, pitcher_id: pid, pitcher_name: pbp.pitcher_name,
      step: 'bets_placed',
      payload: { rows: pbp.rows, total_risk_usd: Math.round(pbp.total_risk * 100) / 100 },
      summary: {
        n_bets_logged: pbp.rows.length,
        final_action: 'bet_placed',
        status: 'scheduled',
      },
    }).catch(() => {})
  }

  // Log model config for this run
  await db.run(
    `INSERT INTO model_config_log
       (run_date, edge_threshold, adj_threshold, shrink7, shrink8, shrink9,
        kelly_mult, max_bet_pct, min_bet, bb_penalty_on, no_cap_cents, bets_logged)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      TODAY,
      minEdge,
      0.28,   // ADJ_THRESHOLD — update manually when changed
      1.0, 1.0, 1.0,   // shrinkage removed — raw probability used directly
      Number(process.env.KELLY_MULT  || 0.25),
      Number(process.env.MAX_BET_PCT || 0.05),
      Number(process.env.MIN_BET     || 25),
      0,      // bb_penalty disabled
      80,     // NO cap at 80¢
      logged,
    ],
  )

  // Discord pick notifications suppressed — alerts fire only on confirmed fills/takers (T-120 check)
}

// ── BUILD-SCHEDULE mode: write lineup-gated entries for all of today's starters ────

async function buildSchedule() {
  const scheduledAt = new Date().toISOString()  // eligible immediately — lineup gate is the sole timing control

  const games = await db.all(
    `SELECT g.id, g.game_time, g.team_home, g.team_away, g.pitcher_home_id, g.pitcher_away_id
     FROM games g
     WHERE g.date = ? AND g.status NOT IN ('final','postponed')
       AND (g.pitcher_home_id IS NOT NULL OR g.pitcher_away_id IS NOT NULL)`,
    [TODAY],
  )

  if (!games.length) {
    console.log('[build-schedule] No games with probable starters found for', TODAY)
    await db.close()
    return
  }

  let added = 0
  for (const g of games) {
    const gameTime = new Date(g.game_time)
    if (isNaN(gameTime.getTime())) {
      console.log(`[build-schedule] Bad game_time for ${g.id}: ${g.game_time} — skipping`)
      continue
    }
    const gameLabel = `${g.team_away}@${g.team_home}`

    for (const [side, pitcherId] of [['home', g.pitcher_home_id], ['away', g.pitcher_away_id]]) {
      if (!pitcherId) continue

      const ps = await db.one(
        `SELECT player_name FROM pitcher_statcast WHERE player_id = ? ORDER BY fetch_date DESC LIMIT 1`,
        [pitcherId],
      )
      const pitcherName = ps?.player_name || `ID${pitcherId}`

      const inserted = await db.run(
        `INSERT OR IGNORE INTO bet_schedule
           (bet_date, game_id, game_label, pitcher_id, pitcher_name, pitcher_side, game_time, scheduled_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
        [TODAY, g.id, gameLabel, pitcherId, pitcherName, side, g.game_time, scheduledAt],
      )
      const gameET = gameTime.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' })
      if (inserted?.changes ?? 1) {
        console.log(`[build-schedule] ${pitcherName.padEnd(22)} (${side.padEnd(4)}) ${gameLabel}  → game ${gameET} ET (lineup-gated)`)
        added++
      } else {
        // Row already exists — if it errored (morning glitch), revive it to pending so it can fire
        const existing = await db.one(
          `SELECT status, preflight FROM bet_schedule WHERE bet_date=? AND game_id=? AND pitcher_id=?`,
          [TODAY, g.id, pitcherId],
        )
        // Revive error rows, and skipped rows where ksBets found no edge (preflight != 'skip').
        // Preflight-skipped rows are AI/market judgment calls — leave them terminal.
        const isError   = existing?.status === 'error'
        const isNoEdge  = existing?.status === 'skipped' && existing?.preflight !== 'skip'
        if (isError || isNoEdge) {
          const gameStarted = new Date(g.game_time) <= new Date()
          const existingBet = gameStarted ? null : await db.one(
            `SELECT id FROM ks_bets WHERE bet_date=? AND pitcher_id=? AND live_bet=0 AND paper=0 LIMIT 1`,
            [TODAY, pitcherId],
          ).catch(() => null)
          if (!gameStarted && !existingBet) {
            await db.run(
              `UPDATE bet_schedule SET status='pending', notes=NULL, fired_at=NULL, scheduled_at=?
               WHERE bet_date=? AND game_id=? AND pitcher_id=?`,
              [scheduledAt, TODAY, g.id, pitcherId],
            )
            console.log(`[build-schedule] ${pitcherName.padEnd(22)} (${side.padEnd(4)}) ${gameLabel}  → revived from ${existing.status} → game ${gameET} ET`)
            added++
          } else {
            console.log(`[build-schedule] ${pitcherName} — ${gameStarted ? 'game already started' : 'bet already placed'}, leaving ${existing.status}`)
          }
        } else {
          console.log(`[build-schedule] ${pitcherName} — already scheduled (${existing?.status}), skipping`)
        }
      }
    }
  }

  console.log(`\n[build-schedule] Done: ${added} new entries. Bets fire within 5min of lineup detection.`)
  await db.close()
}

// ── CANCEL helpers ────────────────────────────────────────────────────────────

async function cancelScratchedPitcherOrders(pitcherName, date, { reason = 'scratched', dryRun = false } = {}) {
  // Find all resting morning orders for this pitcher
  const rows = await db.all(
    `SELECT id, user_id, ticker, order_id, order_status, filled_contracts
       FROM ks_bets
      WHERE bet_date = ? AND pitcher_name = ?
        AND live_bet = 0 AND paper = 0
        AND order_id IS NOT NULL
        AND order_status IN ('resting', 'partial')
        AND result IS NULL`,
    [date, pitcherName],
  )
  if (!rows.length) {
    console.log(`[cancel] ${pitcherName}: no resting orders found`)
    return { pitcher: pitcherName, orders_found: 0, orders_cancelled: 0 }
  }

  // Group by user_id + ticker
  const byUserTicker = new Map()
  for (const r of rows) {
    const key = `${r.user_id}|${r.ticker}`
    if (!byUserTicker.has(key)) byUserTicker.set(key, { userId: r.user_id, ticker: r.ticker, ids: [] })
    byUserTicker.get(key).ids.push(r.id)
  }

  // Load creds for affected users
  const userIds = [...new Set(rows.map(r => r.user_id))]
  const users = await db.all(
    `SELECT id, name, kalshi_key_id, kalshi_private_key FROM users WHERE id IN (${userIds.map(() => '?').join(',')})`,
    userIds,
  )
  const credsMap = new Map(users.map(u => [u.id, u.kalshi_key_id ? { keyId: u.kalshi_key_id, privateKey: u.kalshi_private_key } : {}]))

  let totalCancelled = 0
  const allIds = []
  for (const { userId, ticker, ids } of byUserTicker.values()) {
    const creds = credsMap.get(userId) ?? {}
    console.log(`[cancel] ${pitcherName} (user ${userId}): ${dryRun ? '[DRY RUN] would cancel' : 'cancelling'} ${ids.length} orders on ${ticker}`)
    if (!dryRun) {
      try {
        const result = await cancelAllOrders({ ticker, status: 'resting' }, creds)
        totalCancelled += result.cancelled_count
        allIds.push(...ids)
      } catch (err) {
        console.error(`[cancel] cancelAllOrders failed for ${ticker}: ${err.message}`)
      }
    }
  }

  if (!dryRun && allIds.length) {
    // Partial fills: leave result=NULL so settleBets handles the filled portion
    // Full resting: mark void
    for (const id of allIds) {
      const row = rows.find(r => r.id === id)
      if (row?.filled_contracts > 0) {
        await db.run(`UPDATE ks_bets SET order_status='cancelled' WHERE id=?`, [id])
      } else {
        await db.run(
          `UPDATE ks_bets SET order_status='cancelled', result='void', pnl=0, settled_at=? WHERE id=?`,
          [new Date().toISOString(), id],
        )
      }
    }
    console.log(`[cancel] ${pitcherName}: cancelled ${totalCancelled} orders, marked ${allIds.length} DB rows`)
  }

  return { pitcher: pitcherName, orders_found: rows.length, orders_cancelled: totalCancelled }
}

// ── SETTLE mode: look up actual Ks and mark results ──────────────────────────

async function isGameFinal(gamePk) {
  const data = await mlbGet(`${MLB_BASE}/schedule`, { params: { gamePk, sportId: 1 } })
  return data?.dates?.[0]?.games?.[0]?.status?.abstractGameState === 'Final'
}

async function fetchActualKs(pitcherId, pitcherName, gameDate, { requireFinal = true } = {}) {
  try {
    const games = await db.all(
      `SELECT id, pitcher_home_id, pitcher_away_id FROM games WHERE date = ?`,
      [gameDate],
    )

    for (const g of games) {
      const final = await isGameFinal(g.id)
      if (!final && requireFinal) continue

      // Determine side using pitcher_id (exact match, no name guessing)
      const side = g.pitcher_home_id === pitcherId ? 'home'
                 : g.pitcher_away_id === pitcherId ? 'away' : null
      if (!side) continue

      try {
        const box = await mlbGet(`${MLB_BASE}/game/${g.id}/boxscore`)
        const playerStats = box?.teams?.[side]?.players || {}

        // Look up by exact player ID first
        const player = playerStats[`ID${pitcherId}`]
        if (player) {
          const ks = player.stats?.pitching?.strikeOuts
          if (ks != null) return { ks: Number(ks), final }
        }

        // Fallback: name match (handles edge cases where box score ID differs)
        const pitchers = box.data?.teams?.[side]?.pitchers || []
        const lastName = pitcherName.split(' ').pop()?.toLowerCase() || ''
        for (const pid of pitchers) {
          const p = playerStats[`ID${pid}`]
          if (!p) continue
          if ((p.person?.fullName || '').toLowerCase().includes(lastName)) {
            const ks = p.stats?.pitching?.strikeOuts
            if (ks != null) return { ks: Number(ks), final }
          }
        }
      } catch { continue }
    }
  } catch {}
  return null
}

async function settleBets() {
  const open = await db.all(
    `SELECT * FROM ks_bets WHERE bet_date = ? AND result IS NULL`,
    [TODAY],
  )

  if (!open.length) {
    console.log(`[ks-bets] No open bets for ${TODAY}`)
    await db.close()
    return
  }

  console.log(`[ks-bets] Settling ${open.length} open bets for ${TODAY}`)

  // Pre-load user credentials for Kalshi settlement lookups
  const userRows = await db.all(`SELECT id, kalshi_key_id, kalshi_private_key FROM users WHERE kalshi_key_id IS NOT NULL`)
  const userCreds = new Map(userRows.map(u => [u.id, { keyId: u.kalshi_key_id, privateKey: u.kalshi_private_key }]))

  // Pre-fetch Kalshi settlements for each user keyed by ticker
  // settlements[userId][ticker] = profit_loss_cents
  const kalshiSettlements = new Map()
  for (const [userId, creds] of userCreds) {
    try {
      const { settlements } = await getSettlements({ limit: 200 }, creds)
      const byTicker = new Map(settlements.map(s => [s.ticker, s]))
      kalshiSettlements.set(userId, byTicker)
      console.log(`[ks-bets] Loaded ${settlements.length} Kalshi settlements for user ${userId}`)
    } catch (err) {
      console.warn(`[ks-bets] Could not fetch Kalshi settlements for user ${userId}: ${err.message}`)
    }
  }

  // ── Sync resting order statuses from Kalshi before settling ─────────────────
  // Maker orders placed at T-2.5h may still be resting, partially filled, or cancelled.
  // Pull live status so P&L calculations use actual fill price and contract count.
  const restingBets = open.filter(b => b.order_status === 'resting' && b.order_id && b.user_id)
  if (restingBets.length) {
    console.log(`[ks-bets] Syncing ${restingBets.length} resting order(s) with Kalshi…`)
    for (const bet of restingBets) {
      const creds = userCreds.get(bet.user_id)
      if (!creds) continue
      try {
        const order = await getOrder(bet.order_id, creds)
        if (!order) continue
        const newStatus   = order.status         ?? bet.order_status
        const filledConts = order.filled_count   ?? bet.filled_contracts
        const fillPrice   = order.yes_price ?? order.no_price ?? bet.fill_price
        if (newStatus !== bet.order_status || filledConts !== bet.filled_contracts) {
          await db.run(
            `UPDATE ks_bets SET order_status=?, filled_contracts=?, fill_price=COALESCE(?,fill_price) WHERE id=?`,
            [newStatus, filledConts, fillPrice ?? null, bet.id],
          )
          console.log(`  sync ${bet.pitcher_name} ${bet.strike}+ ${bet.side}: ${bet.order_status}→${newStatus} (${filledConts} filled @ ${fillPrice ?? '?'}¢)`)
          bet.order_status     = newStatus
          bet.filled_contracts = filledConts
          if (fillPrice != null) bet.fill_price = fillPrice
        }
      } catch (err) {
        console.warn(`  ${bet.pitcher_name} order sync failed: ${err.message}`)
      }
    }
  }

  // Check for postponed games — void those bets rather than leaving them open forever
  const postponed = await db.all(
    `SELECT pitcher_home_id, pitcher_away_id FROM games WHERE date = ? AND status = 'postponed'`,
    [TODAY],
  )
  const postponedPitcherIds = new Set(postponed.flatMap(g => [g.pitcher_home_id, g.pitcher_away_id].filter(Boolean)))

  // Group by pitcher_id to avoid redundant box score fetches
  // requireFinal=false so we can resolve guaranteed YES wins mid-game
  const pitcherKs = new Map()
  for (const bet of open) {
    const key = bet.pitcher_id || bet.pitcher_name
    if (!pitcherKs.has(key)) {
      if (postponedPitcherIds.has(bet.pitcher_id)) {
        pitcherKs.set(key, 'postponed')
        console.log(`  ${bet.pitcher_name}: POSTPONED — voiding bet`)
      } else {
        const result = await fetchActualKs(bet.pitcher_id, bet.pitcher_name, bet.bet_date, { requireFinal: false })
        pitcherKs.set(key, result)
        if (result) console.log(`  ${bet.pitcher_name}: ${result.ks} Ks${result.final ? '' : ' (in progress)'}`)
        else        console.log(`  ${bet.pitcher_name}: no data yet`)
      }
    }
  }

  const now = new Date().toISOString()
  let wins = 0, losses = 0, unknown = 0, voided = 0

  for (const bet of open) {
    const key  = bet.pitcher_id || bet.pitcher_name
    const data = pitcherKs.get(key)

    if (data === 'postponed') {
      await db.run(`UPDATE ks_bets SET result='void', settled_at=?, pnl=0 WHERE id=?`, [now, bet.id])
      voided++
      continue
    }
    if (!data) { unknown++; continue }

    const actualKs = data.ks
    const hit = actualKs >= bet.strike

    // Mid-game: only settle bets that are already guaranteed
    // YES bets that crossed threshold are locked wins (Ks never decrease)
    // NO bets and uncrossed YES bets need a final box score
    if (!data.final) {
      if (bet.side === 'YES' && hit) {
        // guaranteed win — settle now
      } else {
        unknown++; continue
      }
    }

    const won = bet.side === 'YES' ? hit : !hit

    // P&L: use Kalshi's actual settlement revenue minus our cost basis (most accurate).
    // Kalshi revenue = gross payout (contracts × $1 for wins, $0 for losses).
    // profit_loss is always 0 in their API — use revenue instead.
    let pnl
    const userSettlements = kalshiSettlements.get(bet.user_id)
    const kalshiRecord    = bet.ticker ? userSettlements?.get(bet.ticker) : null
    const fillPrice       = bet.fill_price ?? bet.market_mid ?? 50  // cents
    let contracts
    if (bet.filled_contracts != null) {
      contracts = bet.filled_contracts
    } else if (bet.capital_at_risk != null && fillPrice > 0) {
      contracts = Math.max(1, Math.round((bet.capital_at_risk * 100) / fillPrice))
    } else {
      contracts = Math.max(1, Math.round((bet.bet_size || 100) * 100 / Math.max(1, fillPrice)))
      console.warn(`[ks-bets] ${bet.pitcher_name} ${bet.strike}+ ${bet.side}: contract count estimated from bet_size`)
    }
    if (kalshiRecord?.revenue != null) {
      const revenue   = kalshiRecord.revenue / 100               // dollars
      const costBasis = contracts * (fillPrice / 100)            // dollars
      pnl = revenue - costBasis
      console.log(`  [kalshi-pnl] ${bet.pitcher_name} ${bet.strike}+ ${bet.side}: revenue=$${revenue.toFixed(2)} cost=$${costBasis.toFixed(2)} pnl=$${pnl.toFixed(2)}`)
    } else {
      const fillFraction = fillPrice / 100
      const KALSHI_FEE   = 0.07
      pnl = won
        ? contracts * (1 - fillFraction) * (1 - KALSHI_FEE * fillFraction)
        : -contracts * fillFraction
    }

    await db.run(
      `UPDATE ks_bets SET actual_ks=?, result=?, settled_at=?, pnl=? WHERE id=?`,
      [actualKs, won ? 'win' : 'loss', now, Math.round(pnl * 100) / 100, bet.id],
    )
    if (won) wins++; else losses++
  }

  console.log(`[ks-bets] Settled: ${wins} wins, ${losses} losses, ${unknown} pending, ${voided} voided (postponed)`)

  // Restore temp-paper users to live once all their pending bets are settled
  const tempPaperUsers = await db.all(`SELECT id, name FROM users WHERE paper_temp=1 AND paper=1`)
  for (const u of tempPaperUsers) {
    const pending = await db.one(
      `SELECT COUNT(*) AS n FROM ks_bets WHERE user_id=? AND result IS NULL AND live_bet=0`,
      [u.id],
    )
    if (Number(pending?.n) === 0) {
      await db.run(`UPDATE users SET paper=0, paper_temp=0 WHERE id=?`, [u.id])
      console.log(`[ks-bets] ${u.name} restored to live mode (all bets settled)`)
    }
  }

  // Backfill outcomes into Kalshi price cache
  try {
    const { default: { execSync } } = await import('child_process')
    execSync(`node scripts/live/backtestKalshi.js --settle --date ${TODAY}`, {
      cwd: process.cwd(), timeout: 20000, encoding: 'utf8',
    })
  } catch (err) {
    console.warn('[ks-bets] Cache settle step failed (non-fatal):', err.message?.slice(0, 100))
  }

  // Discord end-of-day report
  // P7: exclude paper bets from daily + season totals (paper = 0 OR paper IS NULL = real-money only)
  const allSettled = await db.all(`SELECT * FROM ks_bets WHERE bet_date = ? AND result IN ('win','loss') AND live_bet = 0 AND (paper = 0 OR paper IS NULL)`, [TODAY])
  const season = await db.all(
    `SELECT SUM(pnl) as pnl, COUNT(*) as n, SUM(CASE WHEN result='win' THEN 1 ELSE 0 END) as w, SUM(bet_size) as wagered FROM ks_bets WHERE result IN ('win','loss') AND live_bet = 0 AND (paper = 0 OR paper IS NULL)`,
  )
  const sp = season[0] || {}

  // P&L sourcing: for live users, prefer Kalshi's authoritative figures.
  // ks_bets.pnl is used only as the paper fallback.
  let seasonPnl = sp.pnl || 0
  let dayPnl    = allSettled.reduce((s, b) => s + (b.pnl || 0), 0)
  try {
    const liveUser = await db.one(
      `SELECT id, kalshi_pnl FROM users WHERE active_bettor=1 AND paper=0 AND kalshi_key_id IS NOT NULL ORDER BY id LIMIT 1`,
    )
    if (liveUser?.kalshi_pnl != null) {
      seasonPnl = Number(liveUser.kalshi_pnl)
      const dayRow = await db.one(
        `SELECT COALESCE(SUM(pnl_usd), 0) AS pnl FROM daily_pnl_events WHERE user_id=? AND date=?`,
        [liveUser.id, TODAY],
      )
      if (dayRow?.pnl != null) dayPnl = Number(dayRow.pnl)
    }
  } catch { /* fall back to ks_bets sums */ }

  await notifyDailyReport({
    date:         TODAY,
    bets:         allSettled,
    dayPnl,
    seasonPnl,
    seasonW:      sp.w       || 0,
    seasonL:      (sp.n || 0) - (sp.w || 0),
    totalWagered: sp.wagered || 0,
  }, await getAllWebhooks(db))

  // Settle all four shadow tables now that ks_bets has actual_ks populated.
  try {
    const { settleShadowDay, settleCalibratedYesDay, settleCalibrateKellyDay, settleFullDistributionDay } = await import('../../lib/shadowInversion.js')
    const invUpdated = await settleShadowDay({ betDate: TODAY })
    const calUpdated = await settleCalibratedYesDay({ betDate: TODAY })
    const kelUpdated = await settleCalibrateKellyDay({ betDate: TODAY })
    const fdUpdated  = await settleFullDistributionDay({ betDate: TODAY })
    if (invUpdated > 0 || calUpdated > 0 || kelUpdated > 0 || fdUpdated > 0) {
      console.log(`[shadow] settled inversion=${invUpdated} cal_yes=${calUpdated} cal_kelly=${kelUpdated} full_dist=${fdUpdated} row(s) for ${TODAY}`)
    }
  } catch (err) {
    console.warn(`[shadow] settle failed: ${err.message}`)
  }
}

// ── REPORT mode ───────────────────────────────────────────────────────────────

async function report() {
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - daysArg)
  const since = cutoff.toISOString().slice(0, 10)

  // P7: exclude paper bets from report figures (real-money only)
  const bets = await db.all(
    `SELECT * FROM ks_bets WHERE bet_date >= ? AND live_bet = 0 AND (paper = 0 OR paper IS NULL) ORDER BY bet_date DESC, edge DESC`,
    [since],
  )

  if (!bets.length) {
    console.log(`[ks-bets] No bets found since ${since}`)
    await db.close()
    return
  }

  const settled   = bets.filter(b => b.result != null)
  const wins      = settled.filter(b => b.result === 'win')
  const totalPnl  = settled.reduce((s, b) => s + (b.pnl || 0), 0)
  const avgEdge   = bets.reduce((s, b) => s + b.edge, 0) / bets.length
  const winRate   = settled.length > 0 ? wins.length / settled.length : null

  console.log(`\n══ KS BETS REPORT (last ${daysArg} days) ══`)
  console.log(`  Total bets:  ${bets.length} (${settled.length} settled, ${bets.length - settled.length} open)`)
  console.log(`  Win rate:    ${winRate != null ? (winRate*100).toFixed(1)+'%' : 'n/a'} (${wins.length}W / ${settled.length - wins.length}L)`)
  console.log(`  Total P&L:   $${totalPnl.toFixed(2)}`)
  console.log(`  Avg edge:    ${(avgEdge*100).toFixed(1)}¢`)
  console.log(`  Avg bet:     $${(bets[0]?.bet_size || 100).toFixed(0)}`)
  console.log(`  EV/bet:      $${settled.length > 0 ? (totalPnl / settled.length).toFixed(2) : 'n/a'}`)

  // By confidence tier
  const tiers = {}
  for (const b of settled) {
    const tier = b.confidence?.includes('high') ? 'high' : b.confidence?.includes('medium') ? 'medium' : 'low'
    if (!tiers[tier]) tiers[tier] = { n: 0, wins: 0, pnl: 0 }
    tiers[tier].n++
    if (b.result === 'win') tiers[tier].wins++
    tiers[tier].pnl += b.pnl || 0
  }
  console.log('\n  By confidence:')
  for (const [tier, t] of Object.entries(tiers)) {
    console.log(`    ${tier.padEnd(8)}: ${t.wins}W/${t.n - t.wins}L  P&L=$${t.pnl.toFixed(2)}  WR=${(t.wins/t.n*100).toFixed(0)}%`)
  }

  // By whiff flag
  const flagged   = settled.filter(b => b.whiff_flag)
  const unflagged = settled.filter(b => !b.whiff_flag)
  if (flagged.length) {
    const fPnl = flagged.reduce((s,b)=>s+(b.pnl||0),0)
    const uPnl = unflagged.reduce((s,b)=>s+(b.pnl||0),0)
    console.log('\n  Whiff flag analysis:')
    console.log(`    Flagged ⚑:   ${flagged.filter(b=>b.result==='win').length}W/${flagged.length} P&L=$${fPnl.toFixed(2)}`)
    console.log(`    Clean:        ${unflagged.filter(b=>b.result==='win').length}W/${unflagged.length} P&L=$${uPnl.toFixed(2)}`)
  }

  // Recent bets list
  console.log('\n  Recent settled bets:')
  for (const b of settled.slice(0, 20)) {
    const resultStr = b.result === 'win' ? '✓' : '✗'
    console.log(
      `  ${resultStr} ${b.bet_date} ${b.pitcher_name.padEnd(22)} ${b.strike}+Ks ${b.side.padEnd(3)}` +
      `  model=${(b.model_prob*100).toFixed(0)}%` +
      `  mid=${b.market_mid != null ? b.market_mid.toFixed(0)+'¢' : '?'}` +
      `  edge=${(b.edge*100).toFixed(1)}¢` +
      `  actual=${b.actual_ks ?? '?'}Ks` +
      `  P&L=$${b.pnl?.toFixed(2) ?? '?'}` +
      `${b.whiff_flag ? ' ⚑' : ''}`
    )
  }
}

// ── CANCEL-SCRATCHED mode ─────────────────────────────────────────────────────

async function runCancelScratched() {
  const dryRun = opts.dryRun ?? false
  console.log(`[cancel-scratched] Checking for scratched pitchers on ${TODAY}${dryRun ? ' (DRY RUN)' : ''}`)

  // Get pitchers we bet on today
  const betPitchers = await db.all(
    `SELECT DISTINCT pitcher_name, pitcher_id FROM ks_bets
      WHERE bet_date=? AND live_bet=0 AND paper=0
        AND order_status IN ('resting','partial') AND result IS NULL`,
    [TODAY],
  )
  if (!betPitchers.length) {
    console.log('[cancel-scratched] No open resting orders today')
    return
  }

  // Check current MLB probable pitchers
  const schedData = await mlbGet(`${MLB_BASE}/schedule`, {
    params: { sportId: 1, date: TODAY, hydrate: 'probablePitcher', language: 'en' },
  })
  const games = schedData?.dates?.[0]?.games || []

  const currentPitcherIds = new Set()
  for (const g of games) {
    const hp = g.teams?.home?.probablePitcher?.id
    const ap = g.teams?.away?.probablePitcher?.id
    if (hp) currentPitcherIds.add(String(hp))
    if (ap) currentPitcherIds.add(String(ap))
  }

  let anyCancelled = false
  for (const { pitcher_name, pitcher_id } of betPitchers) {
    if (!pitcher_id || currentPitcherIds.has(String(pitcher_id))) continue
    console.log(`[cancel-scratched] ${pitcher_name} (${pitcher_id}) no longer probable — cancelling`)
    const summary = await cancelScratchedPitcherOrders(pitcher_name, TODAY, { dryRun })
    if (summary.orders_cancelled > 0) anyCancelled = true
  }

  if (anyCancelled) {
    const webhooks = await getAllWebhooks(db)
    await notifyEdges([{ text: `⚠️ Pitcher scratched — resting orders cancelled` }], webhooks).catch(() => {})
  }
  if (!anyCancelled && !dryRun) console.log('[cancel-scratched] No scratched pitchers found')
}

// ── TOP-UP mode ───────────────────────────────────────────────────────────────
// Every 5 min: for every pre-game bet where filled_contracts < bet_size (the original Kelly
// target), check if the edge still exists at the current ask. If yes, buy the remaining
// contracts as a taker, cancel any unfilled remainder immediately. Stops at T-5 to game.

async function runTopUp() {
  const now    = Date.now()
  const isLive = process.env.LIVE_TRADING === 'true'

  // Find base rows where total filled across all rows < original Kelly target.
  // bet_mode='normal' rows are the original bets — topup rows are additional fills.
  // Pull strategy_mode so the topup row can inherit the parent's bucket for caps.
  const candidates = await db.all(`
    SELECT b.id, b.user_id, b.pitcher_name, b.pitcher_id, b.strike, b.side, b.ticker, b.bet_size, b.strategy_mode
    FROM ks_bets b
    WHERE b.bet_date=? AND b.live_bet=0 AND b.result IS NULL
      AND b.bet_mode='normal'
      AND b.bet_size > 0
      AND (
        SELECT COALESCE(SUM(filled_contracts), 0) FROM ks_bets
        WHERE bet_date=b.bet_date AND user_id=b.user_id AND pitcher_id=b.pitcher_id
          AND strike=b.strike AND side=b.side AND live_bet=0
      ) < b.bet_size
    ORDER BY b.user_id, b.pitcher_name, b.strike
  `, [TODAY])

  if (!candidates.length) { console.log('[topup] no unfilled positions'); return }

  // Load edge cache — one row per pitcher, edges_json has per-strike model_prob
  const edgeRows = await db.all(
    `SELECT pitcher_id, edges_json FROM pitcher_edge_cache WHERE bet_date=?`, [TODAY],
  )
  const edgeMap = new Map()  // pitcher_id → Map(strike → { model_prob, edge_yes })
  for (const row of edgeRows) {
    try {
      const edges = JSON.parse(row.edges_json ?? '[]')
      const byStrike = new Map(edges.map(e => [e.strike, e]))
      edgeMap.set(String(row.pitcher_id), byStrike)
    } catch { /* skip malformed */ }
  }

  // Load game times for game-start guard
  const games = await db.all(
    `SELECT pitcher_name, game_time FROM bet_schedule WHERE bet_date=?`, [TODAY],
  )
  const gameTimeMap = new Map(games.map(g => [g.pitcher_name, g.game_time]))

  // Load creds for all candidate users
  const userIds = [...new Set(candidates.map(c => c.user_id))]
  const userRows = await db.all(
    `SELECT id, name, kalshi_key_id, kalshi_private_key FROM users WHERE id IN (${userIds.map(() => '?').join(',')}) AND kalshi_key_id IS NOT NULL`,
    userIds,
  )
  const credsMap = new Map(userRows.map(u => [u.id, { name: u.name, keyId: u.kalshi_key_id, privateKey: u.kalshi_private_key }]))

  for (const bet of candidates) {
    const u = credsMap.get(bet.user_id)
    if (!u?.keyId) continue  // no Kalshi creds = can't place real orders

    // Game-start guard: stop topping up within 5 min of first pitch
    const rawGt = gameTimeMap.get(bet.pitcher_name)
    if (rawGt) {
      const gtMs = new Date(!String(rawGt).endsWith('Z') ? rawGt + 'Z' : rawGt).getTime()
      const minsToGame = (gtMs - now) / 60000
      if (minsToGame <= 5) {
        console.log(`[topup] ${bet.pitcher_name} ${bet.strike}+ — T-${minsToGame.toFixed(0)}min, too close to game`)
        continue
      }
    }

    // Edge still there? Pull from pitcher_edge_cache (updated every 10 min by edge rescan).
    const pitcherEdges = edgeMap.get(String(bet.pitcher_id))
    const edgeEntry    = pitcherEdges?.get(bet.strike)
    const modelProb    = edgeEntry?.model_prob
    const edgeYes      = edgeEntry?.edge_yes ?? edgeEntry?.best_edge
    if (!modelProb) { console.log(`[topup] ${bet.pitcher_name} ${bet.strike}+ — no model_prob in cache, skipping`); continue }
    if ((edgeYes ?? 0) < 0.03) { console.log(`[topup] ${bet.pitcher_name} ${bet.strike}+ — edge ${((edgeYes ?? 0)*100).toFixed(1)}¢ below floor`); continue }

    // How many more contracts do we need?
    const totalFilled = await db.one(
      `SELECT COALESCE(SUM(filled_contracts), 0) as n FROM ks_bets
       WHERE bet_date=? AND user_id=? AND pitcher_id=? AND strike=? AND side=? AND live_bet=0 AND paper=0`,
      [TODAY, bet.user_id, bet.pitcher_id, bet.strike, bet.side],
    )
    const remaining = bet.bet_size - (totalFilled?.n ?? 0)
    if (remaining <= 0) continue

    const creds = { keyId: u.keyId, privateKey: u.privateKey }

    // Current orderbook — verify ask price gives positive edge
    const ob = await getOrderbook(bet.ticker, 10, creds).catch(() => null)
    if (!ob) { console.log(`[topup] ${bet.pitcher_name} ${bet.strike}+ — no orderbook`); continue }

    const askCents = bet.side === 'YES' ? ob.best_yes_ask : ob.best_no_ask
    if (!askCents) { console.log(`[topup] ${bet.pitcher_name} ${bet.strike}+ — no ask (no liquidity)`); continue }

    // Edge check at current ask price
    if (askCents / 100 >= modelProb) {
      console.log(`[topup] ${bet.pitcher_name} ${bet.strike}+ ${bet.side} — edge gone (ask ${askCents}¢ ≥ model ${(modelProb*100).toFixed(0)}¢)`)
      continue
    }

    // Cancel any resting orders so we can re-place at the current ask.
    // Orders are placed at the ask (taker intent) but Kalshi may leave unfilled remainder resting.
    // The top-up replaces them every cycle with a fresh order at the live ask price.
    const resting = await listOrders({ ticker: bet.ticker, status: 'resting' }, creds).catch(() => [])
    const restingOrders = resting.filter(o => o.side === bet.side.toLowerCase())
    if (restingOrders.length > 0) {
      for (const ro of restingOrders) {
        await cancelOrder(ro.order_id, creds).catch(() => {})
      }
      const restingCount = restingOrders.reduce((s, o) => s + Number(o.remaining_count || 0), 0)
      console.log(`[topup] ${bet.pitcher_name} ${bet.strike}+ — cancelled ${restingCount} resting contracts, replacing at current ask`)
    }

    // Cap at available depth
    let contracts = remaining
    const depth = availableDepth(ob, bet.side.toLowerCase(), askCents)
    if (depth > 0 && contracts > depth) {
      console.log(`[topup] ${bet.pitcher_name} ${bet.strike}+ depth cap ${contracts}→${depth}c`)
      contracts = depth
    }
    if (contracts <= 0) continue

    const edgeCents = (modelProb - askCents / 100) * 100
    console.log(`[topup] ${u.name} ${bet.pitcher_name} ${bet.strike}+ ${bet.side} — ${remaining} remaining, edge +${edgeCents.toFixed(1)}¢ @ ${askCents}¢`)

    if (!isLive) {
      console.log(`  [topup PAPER] would buy ${contracts}c @ ${askCents}¢`)
      continue
    }

    try {
      const result = await placeOrder(bet.ticker, bet.side.toLowerCase(), contracts, askCents, creds)
      const order = result?.order ?? result
      const orderId = order?.order_id ?? null
      let filledConts = Math.round(parseFloat(order?.filled_count ?? order?.fill_count_fp ?? '0'))

      // IOC simulation: wait 2s for Kalshi async fill processing, then cancel unfilled remainder
      if (orderId && filledConts < contracts) {
        await new Promise(r => setTimeout(r, 2000))
        const confirmed = await getOrder(orderId, creds).catch(() => null)
        filledConts = Math.round(parseFloat(confirmed?.fill_count_fp ?? confirmed?.filled_count ?? filledConts))
        if (filledConts < contracts) {
          await cancelOrder(orderId, creds).catch(() => {})
          console.log(`  [topup-IOC] ${filledConts}/${contracts} filled — cancelled resting ${contracts - filledConts}c`)
        }
      }

      if (filledConts > 0) {
        const fillPrice = bet.side === 'NO' ? (100 - askCents) : askCents
        // Topup inherits parent's strategy_mode for cap accounting. Day 1 safety:
        // if parent strategy_mode is unknown/missing, REJECT the topup.
        const parentMode = bet.strategy_mode
        if (!parentMode) {
          console.log(`  [topup] REJECT — parent ks_bets row ${bet.id} has no strategy_mode (likely legacy); skipping topup`)
          continue
        }
        try { validateStrategyMode(parentMode, 'ksBets:topup_parent') } catch (verr) {
          console.log(`  [topup] REJECT — parent strategy_mode invalid (${parentMode}): ${verr.message}`)
          continue
        }
        await db.run(
          `INSERT INTO ks_bets (bet_date, logged_at, user_id, pitcher_id, pitcher_name, strike, side,
             live_bet, paper, order_id, ticker, fill_price, filled_at, filled_contracts, order_status,
             bet_size, market_mid, bet_mode, strategy_mode, strategy_submode)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, 'filled', ?, ?, 'topup', ?, ?)`,
          [TODAY, new Date().toISOString(), bet.user_id, bet.pitcher_id, bet.pitcher_name,
           bet.strike, bet.side, orderId, bet.ticker, fillPrice, new Date().toISOString(),
           filledConts, filledConts, Math.round(askCents), parentMode, 'topup_'+parentMode],
        )
        await addCommitted(TODAY, filledConts * (askCents / 100))
        const newTotal = (totalFilled?.n ?? 0) + filledConts
        console.log(`  [topup] ✓ ${u.name} ${bet.pitcher_name} ${bet.strike}+ ${bet.side}: +${filledConts}c @ ${askCents}¢ — ${newTotal}/${bet.bet_size} total`)
      } else {
        console.log(`  [topup] ${u.name} ${bet.pitcher_name} ${bet.strike}+ — 0 fills at ask`)
      }
    } catch (err) {
      console.error(`  [topup] FAILED ${bet.pitcher_name} ${bet.strike}+ ${bet.side}: ${err.message}`)
    }
  }

  console.log('[topup] done')
}

// ── CANCEL-ALL mode ───────────────────────────────────────────────────────────

async function runCancelAll() {
  console.log(`[cancel-all] Cancelling ALL resting orders for ${TODAY}`)
  const users = await db.all(
    `SELECT id, name, kalshi_key_id, kalshi_private_key FROM users WHERE active_bettor=1 AND kalshi_key_id IS NOT NULL AND is_system_admin = 0`,
  )
  for (const u of users) {
    const creds = { keyId: u.kalshi_key_id, privateKey: u.kalshi_private_key }
    const result = await cancelAllOrders({ status: 'resting' }, creds).catch(err => {
      console.error(`[cancel-all] ${u.name}: ${err.message}`)
      return { cancelled_count: 0 }
    })
    console.log(`[cancel-all] ${u.name}: cancelled ${result.cancelled_count} orders`)
  }
  // Only void rows with no real fills — never void a bet that partially or fully filled.
  await db.run(
    `UPDATE ks_bets SET order_status='cancelled', result='void', pnl=0, settled_at=?
      WHERE bet_date=? AND order_status IN ('resting','partial') AND result IS NULL AND paper=0
        AND (filled_contracts IS NULL OR filled_contracts = 0)`,
    [new Date().toISOString(), TODAY],
  )
  console.log('[cancel-all] Done')
}

// ── PLAN mode: morning portfolio scan for full-day sizing ─────────────────────
// Runs once at 10am ET and again after 3:30pm lineup refresh.
// Applies the same filter stack as logEdges() across ALL of today's pitchers,
// then stores total_edge_weighted in daily_plan so each T-2.5h call can size
// its bets as a proportional share of the day's total budget rather than
// assuming it's the only game being wagered.

async function planPortfolio() {
  console.log(`[plan] Morning portfolio scan for ${TODAY}…`)

  let edgesJson
  try {
    const { default: { execSync } } = await import('child_process')
    const out = execSync(
      `node scripts/live/strikeoutEdge.js --date ${TODAY} --min-edge ${minEdge} --json`,
      { cwd: process.cwd(), timeout: 120000, encoding: 'utf8' },
    )
    const m = out.match(/\[EDGES_JSON\]([\s\S]+)\[\/EDGES_JSON\]/)
    if (!m) {
      console.log('[plan] No EDGES_JSON block found — skipping plan')
      return
    }
    edgesJson = JSON.parse(m[1])
  } catch (err) {
    console.error('[plan] Edge finder failed:', err.message)
    return
  }

  if (!edgesJson.length) {
    console.log('[plan] No edges found for today — daily_plan not written')
    return
  }

  // Apply the same filter stack as logEdges() ──────────────────────────────
  const rawEdges = edgesJson.map(e => {
    const mid    = (e.market_mid ?? 50) / 100
    const hs     = (e.spread ?? 4) / 200
    const fill   = e.side === 'YES' ? mid + hs : (1 - mid) + hs
    const edgeVal = Math.max(Number(e.edge) || 0, 0.001)
    return { ...e, _fill: fill, _edgeVal: edgeVal }
  })

  // Dedup hedges
  const bestByKey = new Map()
  for (const e of rawEdges) {
    const key = `${e.pitcher}|${e.strike}`
    if (!bestByKey.has(key) || e._edgeVal > bestByKey.get(key)._edgeVal) bestByKey.set(key, e)
  }

  // YES cap per pitcher
  const MAX_YES_PER_PITCHER = 3
  const yesCounts = {}
  const deduped = [...bestByKey.values()].sort((a, b) => b._edgeVal - a._edgeVal)
  const withFill = deduped.filter(e => {
    if (e.side !== 'YES') return true
    yesCounts[e.pitcher] = (yesCounts[e.pitcher] || 0) + 1
    return yesCounts[e.pitcher] <= MAX_YES_PER_PITCHER
  })

  // Read configurable Rule K thresholds (mirrors logEdges — keeps denominator consistent)
  const _Rp = await getBettingRules().catch(() => ({}))
  const yesPregameMinProb   = _Rp.yes_pregame_min_prob    ?? 0.45
  const yesPregameMinProbHi = _Rp.yes_pregame_min_prob_hi ?? 0.65
  const yesPregameMaxMid    = _Rp.yes_pregame_max_mid     ?? 35

  // Protection rules A / D / E / F / G / H / I / K (mirrors logEdges filter — keeps denominator consistent)
  const guardedEdges = withFill.filter(e => {
    if (e.side === 'NO'  && (e.market_mid ?? 50) >= 65 && e.model_prob >= 0.50) return false   // Rule A
    if (e.side === 'YES' && e.model_prob < 0.25 && (e._edgeVal ?? e.edge ?? 0) < 0.18) return false  // Rule D
    if (e.side === 'NO'  && (e.market_mid ?? 50) < 15) return false                             // Rule E
    if (e.side === 'NO'  && e.strike <= 4) return false                                          // Rule F
    if (e.side === 'YES' && (                                                                    // Rule K
      e.model_prob < yesPregameMinProb ||
      (e.model_prob < yesPregameMinProbHi && (e.market_mid ?? 50) > yesPregameMaxMid)
    )) return false
    if (e.side === 'NO'  && e.strike === 7 && (                                                  // Rule I
      (e.market_mid ?? 50) > 35 ||
      e.model_prob >= 0.18 ||
      (e._edgeVal ?? e.edge ?? 0) < 0.20
    )) return false
    return true
  })

  const NO_SIDE_MULT  = 1.25
  const YES_SIDE_MULT = 1.00

  const pitcherBreakdown = new Map()
  let totalEdgeWeighted = 0
  for (const e of guardedEdges) {
    const sideMult = e.side === 'NO' ? NO_SIDE_MULT : YES_SIDE_MULT
    const weighted = e._edgeVal * sideMult
    totalEdgeWeighted += weighted
    const key = String(e.pitcher_id || e.pitcher)
    if (!pitcherBreakdown.has(key)) {
      pitcherBreakdown.set(key, { pitcher_id: key, pitcher_name: e.pitcher, edge_weighted: 0 })
    }
    pitcherBreakdown.get(key).edge_weighted += weighted
  }

  const pitchersJson = JSON.stringify([...pitcherBreakdown.values()])
  const now = new Date().toISOString()

  // P2: ON CONFLICT ... DO UPDATE already handles re-runs (10am → 3:30pm) correctly —
  // total_edge_weighted is always overwritten so afternoon bets use the correct denominator.
  // No early-return guard exists, so planPortfolio always re-runs with fresh edge weights.
  await db.run(
    `INSERT INTO daily_plan (bet_date, total_edge_weighted, pitcher_count, pitchers_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(bet_date) DO UPDATE SET
       total_edge_weighted = excluded.total_edge_weighted,
       pitcher_count       = excluded.pitcher_count,
       pitchers_json       = excluded.pitchers_json,
       updated_at          = excluded.updated_at`,
    [TODAY, totalEdgeWeighted, pitcherBreakdown.size, pitchersJson, now, now],
  )

  console.log(`[plan] ${TODAY}: ${pitcherBreakdown.size} pitchers · total_edge_weighted=${totalEdgeWeighted.toFixed(3)}`)
  for (const [, p] of pitcherBreakdown) {
    console.log(`  ${p.pitcher_name.padEnd(28)} edge=${p.edge_weighted.toFixed(3)}`)
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  await db.migrate()
  await ensureTable()

  if (MODE === 'log')             await logEdges()
  else if (MODE === 'settle')          await settleBets()
  else if (MODE === 'report')          await report()
  else if (MODE === 'plan')            { await planPortfolio(); return db.close() }
  else if (MODE === 'build-schedule')  { await buildSchedule(); return }
  else if (MODE === 'topup')           { await runTopUp();       return db.close() }
  else if (MODE === 'cancel-scratched') { await runCancelScratched(); return db.close() }
  else if (MODE === 'cancel-all')       { await runCancelAll();       return db.close() }
  else {
    console.error(`Unknown mode: ${MODE}. Use log | settle | report | plan | build-schedule | topup | cancel-scratched | cancel-all`)
    process.exit(1)
  }

  await db.close()
}

main().catch(err => {
  console.error('[ks-bets] fatal:', err.message)
  process.exit(1)
})
