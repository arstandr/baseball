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
  minHours:  { flag: 'min-hours', type: 'number', default: null },  // skip pitchers whose game starts within this many hours
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
const MIN_BET_FACE = 5   // don't log bets below $5 face value

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
    `SELECT id, name, starting_bankroll, daily_risk_pct, paper, kalshi_key_id, kalshi_private_key
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

  // Cap YES bets per pitcher at 3 (sorted highest edge first) to prevent
  // stacking losses on a single pitcher who underperforms.
  const MAX_YES_PER_PITCHER = 3
  const yesCounts = {}
  const deduped = [...bestByKey.values()].sort((a, b) => b._edgeVal - a._edgeVal)
  const withFill = deduped.filter(e => {
    if (e.side !== 'YES') return true
    yesCounts[e.pitcher] = (yesCounts[e.pitcher] || 0) + 1
    return yesCounts[e.pitcher] <= MAX_YES_PER_PITCHER
  })
  const yesCapRemoved = deduped.length - withFill.length
  if (yesCapRemoved > 0) console.log(`[ks-bets] Capped ${yesCapRemoved} YES bet(s) (max ${MAX_YES_PER_PITCHER} per pitcher)`)

  // ── Protection rules (A / D / E / F) ─────────────────────────────────────
  // Rule A: Ban NO bets where market_mid ≥ 65 AND model also thinks YES is favored (model_prob ≥ 0.50)
  //         Both market and model agree YES is likely — no conviction to bet NO.
  //         If model says NO wins outright (model_prob < 0.50), let it through regardless of market price.
  // Rule D: Ban YES bets where model_prob < 0.25 (matches YES_MIN_PROB upstream filter in strikeoutEdge.js)
  //         Exception: if edge ≥ 18¢, let it through — large edge overrides low-conviction
  // Rule E: Ban NO bets where market_mid < 15 — market already near-certain NO, no edge to capture
  // Rule F: Ban NO bets at strike ≤ 4 — Apr 2026: strike 3 NO 0% WR (-$53), strike 4 NO 27.8% WR (-$41)
  // Rule C (strike=3 skip) removed — live data shows K≤3 bets have 47% ROI
  const guardedEdges = withFill.filter(e => {
    if (e.side === 'NO' && (e.market_mid ?? 50) >= 65 && e.model_prob >= 0.50) return false  // Rule A
    if (e.side === 'YES' && e.model_prob < 0.25 && (e._edgeVal ?? e.edge ?? 0) < 0.18) return false  // Rule D (waived if edge ≥ 18¢)
    if (e.side === 'NO' && (e.market_mid ?? 50) < 15) return false                            // Rule E
    if (e.side === 'NO' && e.strike <= 4) return false                                         // Rule F
    return true
  })
  const guardsRemoved = withFill.length - guardedEdges.length
  if (guardsRemoved > 0) console.log(`[ks-bets] Protection rules A/D/E/F: removed ${guardsRemoved} bet(s)`)

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
        const reason = e.side === 'NO' ? 'rule_a' : 'rule_d'
        if (reason === 'rule_a') entry.dropped_rule_a.push({ strike: e.strike, side: e.side })
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
        inputs_count: entry.total_input,
        passed_count: allPassedPitcher.length,
      },
      summary: noPassedAtAll ? {
        final_action: 'filtered_out',
        skip_reason: entry.dropped_rule_a.length > 0 ? 'rule_a' : entry.dropped_rule_d.length > 0 ? 'rule_d' : 'yes_cap',
      } : {},
    }).catch(() => {})
  }

  // Side multipliers: NOs get 1.25x capital weight (structural edge, validated forward)
  // YES stays at 1.0x — don't reduce good YES bets, just overweight NOs
  // Re-evaluate after +300 bets before any further adjustment
  const NO_SIDE_MULT  = 1.25
  const YES_SIDE_MULT = 1.00
  const totalEdge = guardedEdges.reduce((s, e) => s + e._edgeVal * (e.side === 'NO' ? NO_SIDE_MULT : YES_SIDE_MULT), 0)

  // Portfolio-aware sizing: use daily_plan.total_edge_weighted as the denominator when available.
  // This prevents the first game of the day from absorbing the full budget assuming it's the only game.
  let denominatorEdge = totalEdge
  try {
    const plan = await db.one(`SELECT total_edge_weighted FROM daily_plan WHERE bet_date = ?`, [TODAY])
    if (plan?.total_edge_weighted > 0) {
      denominatorEdge = plan.total_edge_weighted
      console.log(`[ks-bets] Daily plan denominator: ${denominatorEdge.toFixed(3)} (local this run: ${totalEdge.toFixed(3)})`)
    }
  } catch { /* daily_plan not yet created — fall back to local totalEdge */ }

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
  const STAGGER_MS = 45_000   // 45s between users on live orders
  let logged = 0
  const _webhooksWithBets = []  // only bettors who actually logged bets get Discord

  const _betsPlacedByPitcher = new Map()

  for (let bi = 0; bi < bettors.length; bi++) {
    const bettor = bettors[bi]
    if (bi > 0) {
      console.log(`[ks-bets] Staggering ${STAGGER_MS / 1000}s before next user…`)
      await new Promise(r => setTimeout(r, STAGGER_MS))
    }

    const riskPct = bettor.daily_risk_pct ?? DAILY_RISK_PCT
    const isLive  = bettor.paper === 0

    // For live accounts, pull actual Kalshi balance as the bankroll source of truth.
    // This guarantees we never size bets beyond what's actually in the account.
    let bankroll
    if (isLive) {
      try {
        const creds = bettor.kalshi_key_id
          ? { keyId: bettor.kalshi_key_id, privateKey: bettor.kalshi_private_key }
          : {}
        const kb = await getKalshiBalance(creds)
        bankroll = kb.balance_usd
        console.log(`[ks-bets] ${bettor.name} · Kalshi portfolio: $${bankroll.toFixed(2)} (cash $${kb.cash_usd?.toFixed(2)} + exposure $${kb.exposure_usd?.toFixed(2)})`)
      } catch (err) {
        console.error(`[ks-bets] ${bettor.name} · Kalshi balance fetch failed: ${err.message} — skipping bets`)
        continue
      }
    } else {
      // Paper/shadow accounts use computed bankroll (no real money involved)
      const settledRow = await db.one(
        `SELECT SUM(pnl) as total FROM ks_bets WHERE result IN ('win','loss') AND bet_date < ? AND user_id = ?`,
        [TODAY, bettor.id],
      )
      bankroll = (bettor.starting_bankroll ?? STARTING_BANKROLL) + Number(settledRow?.total || 0)
    }

    const dailyBudget = bankroll * riskPct

    // If a pre-allocated budget was passed (--max-risk), use it as this pitcher's
    // spending envelope. This is set by the scheduler from bet_schedule.allocated_usd
    // so that the full-day slate budget is reserved upfront at 9am — evening games
    // can't be crowded out by afternoon games spending the shared pool first.
    // Falls back to dailyBudget minus already-spent for backward compatibility.
    let effectiveBudget
    if (opts.maxRisk != null && opts.maxRisk > 0) {
      effectiveBudget = opts.maxRisk
      console.log(`[ks-bets] ${bettor.name}: using pre-allocated budget $${effectiveBudget.toFixed(0)} (slate-aware)`)
    } else {
      const alreadySpent = await db.one(
        `SELECT COALESCE(SUM(capital_at_risk), 0) AS spent
           FROM ks_bets WHERE bet_date=? AND live_bet=0 AND user_id=?`,
        [TODAY, bettor.id],
      )
      const spentToday = Number(alreadySpent?.spent || 0)
      if (spentToday >= dailyBudget) {
        console.log(`[ks-bets] ${bettor.name}: daily budget $${dailyBudget.toFixed(0)} already fully deployed ($${spentToday.toFixed(0)} out) — skipping`)
        continue
      }
      effectiveBudget = dailyBudget - spentToday
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

    // Guard: if denominatorEdge is zero (no edges passed the filters, or
    // total_edge_weighted wasn't written yet), division would produce NaN
    // for every bet. Skip sizing entirely for this bettor/run.
    if (!denominatorEdge || denominatorEdge <= 0) {
      console.warn(`[ks-bets] denominatorEdge is zero — skipping bet sizing for ${bettor.name}`)
      continue
    }

    // Size each bet proportionally, then enforce hard budget cap by taking
    // highest-edge bets first and stopping once the budget is spent.
    const withFace = guardedEdges
      .map(e => {
        const sideMult      = e.side === 'NO' ? NO_SIDE_MULT : YES_SIDE_MULT
        const corrDiscount  = getCorrelationDiscount(e.game)
        const riskAlloc     = (e._edgeVal * sideMult / denominatorEdge) * dailyBudget * corrDiscount
        const faceValue = Math.round(riskAlloc / e._fill)
        const face = Math.max(faceValue, MIN_BET_FACE)
        return { ...e, _face: face, _actualRisk: face * e._fill }
      })
      .sort((a, b) => b._edgeVal - a._edgeVal)  // highest edge first

    let budgetLeft = effectiveBudget
    const sized = []
    for (const e of withFace) {
      if (budgetLeft <= 0) break
      // If the minimum floor would blow the remaining budget, skip
      if (e._actualRisk > budgetLeft + 1) continue
      sized.push(e)
      budgetLeft -= e._actualRisk
    }

    console.log(
      `\n[ks-bets] ${bettor.name} · Bankroll $${bankroll.toFixed(0)} · budget $${effectiveBudget.toFixed(0)} · ${sized.length} bets · ${isLive ? 'LIVE' : 'paper'}`,
    )

    const now = new Date().toISOString()
    let bettorLogged = 0, ordersPlaced = 0, ordersFailed = 0
    const creds = bettor.kalshi_key_id
      ? { keyId: bettor.kalshi_key_id, privateKey: bettor.kalshi_private_key }
      : {}

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

      // Skip pitchers whose game has already started per the games table
      if (e.pitcher_id) {
        const gameRow = await db.one(
          `SELECT status, game_time FROM games WHERE date=? AND (pitcher_home_id=? OR pitcher_away_id=?)`,
          [TODAY, String(e.pitcher_id), String(e.pitcher_id)],
        )
        if (gameRow && (gameRow.status === 'live' || gameRow.status === 'final')) {
          console.log(`  [skip] ${e.pitcher} — game already live/final (${gameRow.status})`)
          continue
        }
        // --min-hours: hourly pre-game check — skip pitchers inside the T-2.5h window
        if (opts.minHours != null && gameRow?.game_time) {
          const hoursToGame = (new Date(gameRow.game_time) - Date.now()) / 3_600_000
          if (hoursToGame < opts.minHours) {
            console.log(`  [skip] ${e.pitcher} — game in ${hoursToGame.toFixed(1)}h < ${opts.minHours}h min-hours window`)
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

      if (isLive && e.ticker && !existing?.order_id) {
        try {
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

          const result = await placeOrder(e.ticker, e.side.toLowerCase(), contracts, askCents, creds)
          const order  = result?.order ?? result

          const orderId     = order?.order_id    ?? null
          const fillPrice   = askCents  // taker fill IS the submitted ask; yes_price from response is complement for NO bets
          const filledConts = order?.filled_count ?? 0   // taker fills may be immediate
          const placedAt    = order?.created_time ?? new Date().toISOString()
          const status      = order?.status      ?? 'executed'

          await db.run(
            `UPDATE ks_bets SET order_id=?, fill_price=?, filled_at=?, filled_contracts=?, order_status=?, paper=0
             WHERE bet_date=? AND pitcher_name=? AND strike=? AND side=? AND live_bet=0
               AND (user_id=? OR (user_id IS NULL AND ? IS NULL))`,
            [orderId, fillPrice, placedAt, filledConts, status, TODAY, e.pitcher, e.strike, e.side, bettor.id, bettor.id],
          )
          ordersPlaced++
          console.log(`  [kalshi] TAKER  ${e.side} ${e.strike}+ ${e.pitcher.padEnd(24)} ${contracts}c @ ${askCents}¢  id=${orderId}`)
        } catch (err) {
          ordersFailed++
          console.error(`  [kalshi] FAILED  ${e.side} ${e.strike}+ ${e.pitcher}: ${err.message}`)
        }
      } else if (existing?.order_id) {
        console.log(`  [kalshi] SKIP    ${e.side} ${e.strike}+ ${e.pitcher} — already ordered`)
      }
    }

    const totalRisk = sized.reduce((s, e) => s + e._face * e._fill, 0)
    console.log(`[ks-bets] ${bettor.name}: logged ${bettorLogged} · orders ${ordersPlaced} placed / ${ordersFailed} failed · risk $${totalRisk.toFixed(0)} of $${bankroll.toFixed(0)} (${(totalRisk/bankroll*100).toFixed(1)}%)`)
    if (bettorLogged > 0 && bettor.discord_webhook) _webhooksWithBets.push(bettor.discord_webhook)
  }

  // Cache today's Kalshi open prices for real-price backtest
  try {
    const { default: { execSync } } = await import('child_process')
    execSync(`node scripts/live/backtestKalshi.js --cache --date ${TODAY}`, {
      cwd: process.cwd(), timeout: 30000, encoding: 'utf8',
    })
  } catch (err) {
    console.warn('[ks-bets] Price cache step failed (non-fatal):', err.message?.slice(0, 100))
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
      if (inserted?.changes ?? 1) {
        const gameET = gameTime.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' })
        console.log(`[build-schedule] ${pitcherName.padEnd(22)} (${side.padEnd(4)}) ${gameLabel}  → game ${gameET} ET (lineup-gated)`)
        added++
      } else {
        console.log(`[build-schedule] ${pitcherName} — already scheduled, skipping`)
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

// ── CANCEL-ALL mode ───────────────────────────────────────────────────────────

async function runCancelAll() {
  console.log(`[cancel-all] Cancelling ALL resting orders for ${TODAY}`)
  const users = await db.all(
    `SELECT id, name, kalshi_key_id, kalshi_private_key FROM users WHERE active_bettor=1 AND kalshi_key_id IS NOT NULL AND id != 1`,
  )
  for (const u of users) {
    const creds = { keyId: u.kalshi_key_id, privateKey: u.kalshi_private_key }
    const result = await cancelAllOrders({ status: 'resting' }, creds).catch(err => {
      console.error(`[cancel-all] ${u.name}: ${err.message}`)
      return { cancelled_count: 0 }
    })
    console.log(`[cancel-all] ${u.name}: cancelled ${result.cancelled_count} orders`)
  }
  await db.run(
    `UPDATE ks_bets SET order_status='cancelled', result='void', pnl=0, settled_at=?
      WHERE bet_date=? AND order_status IN ('resting','partial') AND result IS NULL AND paper=0`,
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

  // Protection rules A / D / E / F (mirrors logEdges filter — keeps denominator consistent)
  const guardedEdges = withFill.filter(e => {
    if (e.side === 'NO' && (e.market_mid ?? 50) >= 65 && e.model_prob >= 0.50) return false
    // B10: edge override — if _edgeVal >= 0.18, allow through even with low model_prob (mirrors logEdges)
    // Rule D threshold = 0.25, matching YES_MIN_PROB in strikeoutEdge.js upstream filter
    if (e.side === 'YES' && e.model_prob < 0.25 && (e._edgeVal ?? e.edge ?? 0) < 0.18) return false
    if (e.side === 'NO' && (e.market_mid ?? 50) < 15) return false
    if (e.side === 'NO' && e.strike <= 4) return false   // Rule F — matches logEdges filter
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

  // ── Backfill bet_schedule.allocated_usd for all pending entries ──────────────
  // Each pitcher gets a pre-reserved share of the daily budget proportional to
  // their edge weight. This prevents afternoon games from consuming the entire
  // budget before evening games with equal or better edges get a chance to fire.
  // Only updates PENDING rows — already-fired entries keep their original bet.
  try {
    await db.run(`ALTER TABLE bet_schedule ADD COLUMN allocated_usd REAL`).catch(() => {})

    // Get active bettors to compute their daily budgets
    const bettors = await db.all(`SELECT id, starting_bankroll, daily_risk_pct, paper FROM users WHERE active_bettor = 1`)
    for (const bettor of bettors) {
      const riskPct = bettor.daily_risk_pct ?? DAILY_RISK_PCT
      // Use starting_bankroll as proxy — real Kalshi balance pulled at fire time
      const bankroll = bettor.starting_bankroll ?? STARTING_BANKROLL
      const dailyBudget = bankroll * riskPct

      for (const [, p] of pitcherBreakdown) {
        const share = totalEdgeWeighted > 0 ? p.edge_weighted / totalEdgeWeighted : 1 / pitcherBreakdown.size
        const alloc = Math.round(share * dailyBudget * 100) / 100
        await db.run(
          `UPDATE bet_schedule SET allocated_usd = ?
           WHERE bet_date = ? AND pitcher_id = ? AND status = 'pending'`,
          [alloc, TODAY, p.pitcher_id],
        ).catch(() => {})
        console.log(`  ${p.pitcher_name.padEnd(28)} edge=${p.edge_weighted.toFixed(3)}  alloc=$${alloc.toFixed(0)} (${(share*100).toFixed(1)}%)`)
      }
    }
    console.log(`[plan] Allocations written to bet_schedule`)
  } catch (err) {
    console.warn(`[plan] Could not write allocations to bet_schedule: ${err.message}`)
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
  else if (MODE === 'cancel-scratched') { await runCancelScratched(); return db.close() }
  else if (MODE === 'cancel-all')       { await runCancelAll();       return db.close() }
  else {
    console.error(`Unknown mode: ${MODE}. Use log | settle | report | plan | build-schedule | cancel-scratched | cancel-all`)
    process.exit(1)
  }

  await db.close()
}

main().catch(err => {
  console.error('[ks-bets] fatal:', err.message)
  process.exit(1)
})
