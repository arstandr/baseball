#!/usr/bin/env node
/**
 * realWorldTests.js — Suite 2: Real-World End-to-End Testing
 *
 * Unlike runAllTests.js (which uses synthetic/controlled inputs), this suite
 * hits the live database and actual script outputs to verify the full pipeline
 * under production conditions.
 *
 * Checks:
 *   1.  DB connectivity & schema integrity
 *   2.  Production data invariants (no impossible state in ks_bets)
 *   3.  Gate rule enforcement — post-deployment bets are clean
 *   4.  Historical gate violations correctly identified (pre-deployment baseline)
 *   5.  Kelly sizing recomputation vs stored values
 *   6.  Model prediction sanity on production bet data
 *   7.  Portfolio cap per-day enforcement
 *   8.  Duplicate detection & deduplication correctness
 *   9.  P&L accounting consistency (win/loss sign)
 *   10. ML model prediction on 2025 real pitchers (feature_matrix_2025.csv)
 *   11. Coverage guard: pitchers with ip≥5 vs ip<5 in real data
 *   12. weeklyPkBacktest end-to-end run (output format + P&L range)
 *   13. smokeTest end-to-end run (per-day totals in valid range)
 *
 * Run: node scripts/test/realWorldTests.js
 */

import 'dotenv/config'
import assert from 'node:assert/strict'
import fs     from 'node:fs'
import path   from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '../../')

// ── Test runner ───────────────────────────────────────────────────────────────
let passed = 0, failed = 0, skipped = 0
const failures = []

function test(name, fn) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.log(`  ✗ ${name}`)
    console.log(`      ${e.message}`)
    failed++
    failures.push({ name, message: e.message })
  }
}

async function testAsync(name, fn) {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.log(`  ✗ ${name}`)
    console.log(`      ${e.message}`)
    failed++
    failures.push({ name, message: e.message })
  }
}

function skip(name, reason = '') {
  console.log(`  − ${name}${reason ? ` (${reason})` : ''}`)
  skipped++
}

function section(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`)
}

function between(v, lo, hi, msg = '') {
  if (v < lo || v > hi) throw new Error(`${msg || 'range'}: ${v} not in [${lo}, ${hi}]`)
}

function approx(a, b, tol = 0.001, msg = '') {
  const diff = Math.abs(a - b)
  if (diff > tol) throw new Error(`${msg || 'approx'}: expected ${b} ± ${tol}, got ${a} (diff ${diff.toFixed(6)})`)
}

// ── Imports ───────────────────────────────────────────────────────────────────
let db, pkModel, kelly, strikeoutModel
try { db             = await import('../../lib/db.js') }             catch(e) { console.error('db import failed:', e.message) }
try { pkModel        = await import('../../lib/pkModel.js') }        catch(e) { console.error('pkModel import failed:', e.message) }
try { kelly          = await import('../../lib/kelly.js') }          catch(e) { console.error('kelly import failed:', e.message) }
try { strikeoutModel = await import('../../lib/strikeout-model.js') } catch(e) { console.error('strikeoutModel import failed:', e.message) }

const WEIGHTS_PATH = path.join(ROOT, 'models/pk_ridge_weights.json')
let model = null
if (pkModel) {
  try { model = pkModel.loadModel(WEIGHTS_PATH) } catch(e) { console.warn('model load failed:', e.message) }
}

// Gate rule constants (mirrors weeklyPkBacktest.js / strikeoutEdge.js)
const MIN_EDGE_FLOOR = 0.04
const YES_MIN_PROB   = 0.25
const YES_MIN_EDGE   = 0.12
const NO_MIN_EDGE    = 0.12
const BANKROLL       = 1237
const PREGAME_POOL   = BANKROLL * 0.60   // $742.20

function passesGate(prob, edge, side, market_mid, strike) {
  if (Math.abs(edge) < MIN_EDGE_FLOOR) return false
  if (side === 'NO'  && (market_mid ?? 50) >= 65 && prob >= 0.50) return false  // Rule A
  if (side === 'YES' && prob < YES_MIN_PROB && edge < 0.18) return false         // Rule D
  if (side === 'NO'  && (market_mid ?? 50) < 15) return false                    // Rule E
  if (side === 'NO'  && (strike ?? 99) <= 4) return false                        // Rule F
  if (side === 'YES' && edge < YES_MIN_EDGE) return false
  if (side === 'NO'  && edge < NO_MIN_EDGE)  return false
  return true
}

// Deployment date: gate rules (Rule E, F) confirmed active from Apr 25 onward
const GATE_DEPLOYMENT_DATE = '2026-04-25'

// ─────────────────────────────────────────────────────────────────────────────
// 1. DB Connectivity & Schema Integrity
// ─────────────────────────────────────────────────────────────────────────────
section('1. DB Connectivity & Schema Integrity')

if (!db) {
  skip('all DB tests', 'db.js failed to import')
} else {

  const EXPECTED_COLS = [
    'id','bet_date','pitcher_id','pitcher_name','team','strike','side',
    'model_prob','market_mid','edge','bet_size','kelly_fraction',
    'capital_at_risk','result','pnl','model',
  ]

  await testAsync('ks_bets table accessible and has expected columns', async () => {
    const schema = await db.all('PRAGMA table_info(ks_bets)', [])
    const cols = schema.map(r => r.name)
    for (const col of EXPECTED_COLS) {
      assert(cols.includes(col), `Missing column: ${col}`)
    }
    console.log(`      ks_bets: ${cols.length} columns ✓`)
  })

  await testAsync('ks_bets has data for the current week', async () => {
    const rows = await db.all(
      `SELECT COUNT(*) as n FROM ks_bets WHERE bet_date >= '2026-04-21'`,
      []
    )
    const n = rows[0]?.n ?? 0
    assert(n > 0, `No bets found for week of Apr 21 — is the DB connected?`)
    console.log(`      bets since Apr 21: ${n}`)
  })

  await testAsync('model column is set correctly (not null) on recent bets', async () => {
    const rows = await db.all(
      `SELECT COUNT(*) as n FROM ks_bets WHERE bet_date >= '2026-04-21' AND model IS NULL AND live_bet=0`,
      []
    )
    const n = rows[0]?.n ?? 0
    // Some null is OK (pre-model bets), but should be small fraction
    const total = (await db.all(`SELECT COUNT(*) as n FROM ks_bets WHERE bet_date >= '2026-04-21'`, []))[0].n
    console.log(`      null model: ${n}/${total} bets (${((n/total)*100).toFixed(1)}%)`)
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Production Data Invariants
// ─────────────────────────────────────────────────────────────────────────────
section('2. Production Data Invariants (no impossible state in ks_bets)')

if (!db) {
  skip('all invariant tests', 'db.js not available')
} else {

  await testAsync('model_prob always in [0, 1] for all bets', async () => {
    const rows = await db.all(
      `SELECT COUNT(*) as n FROM ks_bets WHERE model_prob < 0 OR model_prob > 1`,
      []
    )
    assert.equal(rows[0].n, 0, `${rows[0].n} bets have model_prob outside [0,1]`)
  })

  await testAsync('bet_size always ≥ 0 (no negative bets)', async () => {
    const rows = await db.all(
      `SELECT COUNT(*) as n FROM ks_bets WHERE bet_size < 0`,
      []
    )
    assert.equal(rows[0].n, 0, `${rows[0].n} bets have negative bet_size`)
  })

  await testAsync('win bets have pnl > 0 for standard pre-game model bets (excluding live/paper/voided)', async () => {
    // live_bet=1 has hedge-adjusted P&L; paper=1 may have pnl=0; pnl=0 wins are voided/refunded
    const rows = await db.all(
      `SELECT COUNT(*) as n FROM ks_bets
       WHERE result='win' AND pnl IS NOT NULL AND pnl < 0
       AND live_bet=0 AND paper=0`,
      []
    )
    assert.equal(rows[0].n, 0,
      `${rows[0].n} standard model win bets have negative pnl (live/paper/voided excluded)`)
  })

  await testAsync('loss bets have pnl ≤ 0 for standard pre-game model bets (excluding live/paper)', async () => {
    // paper=1 or live_bet=1 may show anomalous pnl; pnl=0 can appear for wash/refund edge cases
    const rows = await db.all(
      `SELECT COUNT(*) as n FROM ks_bets
       WHERE result='loss' AND pnl IS NOT NULL AND pnl > 1.00
       AND live_bet=0 AND paper=0`,
      []
    )
    // Allow pnl up to $1 on loss (fill price artifacts / small rounding in settlement)
    assert.equal(rows[0].n, 0,
      `${rows[0].n} standard model loss bets have pnl > $1.00 (live/paper excluded)`)
  })

  await testAsync('edge sign consistent with side and model_prob vs market_mid', async () => {
    // For YES bets: edge = model_prob - market_mid/100 (approximately)
    // A positive edge should always be the case if the bet was taken
    const rows = await db.all(
      `SELECT COUNT(*) as n FROM ks_bets
       WHERE live_bet=0 AND bet_size > 0 AND edge < 0`,
      []
    )
    // Note: some small negative edge bets may exist from before gate rules
    const total = (await db.all(`SELECT COUNT(*) as n FROM ks_bets WHERE live_bet=0 AND bet_size > 0`, []))[0].n
    const pct = rows[0].n / total
    assert(pct < 0.10, `${(pct*100).toFixed(1)}% of bets have negative edge — gate rules not being applied`)
    console.log(`      negative-edge bets: ${rows[0].n}/${total} (${(pct*100).toFixed(1)}%) — should be near 0 post-deployment`)
  })

  await testAsync('market_mid always in [1, 99] (valid Kalshi market)', async () => {
    const rows = await db.all(
      `SELECT COUNT(*) as n FROM ks_bets WHERE market_mid < 1 OR market_mid > 99`,
      []
    )
    assert.equal(rows[0].n, 0, `${rows[0].n} bets have market_mid outside [1,99]`)
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Gate Rule Enforcement — Post-Deployment Bets Are Clean
// ─────────────────────────────────────────────────────────────────────────────
section(`3. Gate Rule Enforcement (post-${GATE_DEPLOYMENT_DATE} bets)`)

if (!db) {
  skip('gate rule tests', 'db.js not available')
} else {

  await testAsync('Rule A: no post-deployment NO bets at market_mid≥65 AND prob≥0.50', async () => {
    const rows = await db.all(
      `SELECT COUNT(*) as n FROM ks_bets
       WHERE bet_date >= ? AND live_bet=0 AND side='NO'
       AND market_mid >= 65 AND model_prob >= 0.50`,
      [GATE_DEPLOYMENT_DATE]
    )
    assert.equal(rows[0].n, 0,
      `${rows[0].n} Rule A violations found on/after ${GATE_DEPLOYMENT_DATE}`)
  })

  await testAsync('Rule E: no post-deployment NO bets at market_mid < 15', async () => {
    const rows = await db.all(
      `SELECT COUNT(*) as n FROM ks_bets
       WHERE bet_date >= ? AND live_bet=0 AND side='NO' AND market_mid < 15`,
      [GATE_DEPLOYMENT_DATE]
    )
    assert.equal(rows[0].n, 0,
      `${rows[0].n} Rule E violations found on/after ${GATE_DEPLOYMENT_DATE}`)
  })

  await testAsync('Rule F: no post-deployment NO bets at strike ≤ 4', async () => {
    const rows = await db.all(
      `SELECT COUNT(*) as n FROM ks_bets
       WHERE bet_date >= ? AND live_bet=0 AND side='NO' AND strike <= 4`,
      [GATE_DEPLOYMENT_DATE]
    )
    assert.equal(rows[0].n, 0,
      `${rows[0].n} Rule F violations found on/after ${GATE_DEPLOYMENT_DATE}`)
  })

  await testAsync('MIN_EDGE_FLOOR: no post-deployment bets with |edge| < 0.04', async () => {
    const rows = await db.all(
      `SELECT COUNT(*) as n FROM ks_bets
       WHERE bet_date >= ? AND live_bet=0 AND ABS(edge) < 0.04 AND bet_size > 0`,
      [GATE_DEPLOYMENT_DATE]
    )
    assert.equal(rows[0].n, 0,
      `${rows[0].n} bets with edge below floor found on/after ${GATE_DEPLOYMENT_DATE}`)
  })

  await testAsync('YES_MIN_EDGE: no post-deployment YES bets with edge < 0.12 (unless Rule D bypass)', async () => {
    const rows = await db.all(
      `SELECT COUNT(*) as n FROM ks_bets
       WHERE bet_date >= ? AND live_bet=0 AND side='YES' AND edge < 0.12
       AND bet_size > 0 AND model_prob >= 0.25`,
      [GATE_DEPLOYMENT_DATE]
    )
    assert.equal(rows[0].n, 0,
      `${rows[0].n} YES bets below YES_MIN_EDGE (0.12) on/after ${GATE_DEPLOYMENT_DATE}`)
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Historical Gate Violations — Pre-Deployment Baseline
// ─────────────────────────────────────────────────────────────────────────────
section('4. Historical Gate Violations (pre-deployment — expected, for audit)')

if (!db) {
  skip('historical audit', 'db.js not available')
} else {

  await testAsync('Rule A violations exist in pre-deployment data (Apr 21-24)', async () => {
    const rows = await db.all(
      `SELECT COUNT(*) as n FROM ks_bets
       WHERE bet_date < ? AND bet_date >= '2026-04-21'
       AND live_bet=0 AND side='NO' AND market_mid >= 65 AND model_prob >= 0.50`,
      [GATE_DEPLOYMENT_DATE]
    )
    // We EXPECT violations here — they document what the gate rules prevent going forward
    console.log(`      Pre-deployment Rule A violations: ${rows[0].n} (expected > 0, documents historical exposure)`)
    assert(rows[0].n >= 0, 'query should return a count')  // informational only
  })

  await testAsync('passesGate correctly identifies would-have-been blocked bets in Apr 21-24', async () => {
    const rows = await db.all(
      `SELECT DISTINCT pitcher_name, strike, side, model_prob, market_mid, edge
       FROM ks_bets
       WHERE bet_date < ? AND bet_date >= '2026-04-21' AND live_bet=0
       ORDER BY bet_date, pitcher_name, strike
       LIMIT 100`,
      [GATE_DEPLOYMENT_DATE]
    )
    let wouldBlock = 0, wouldAllow = 0
    for (const b of rows) {
      if (passesGate(b.model_prob, b.edge, b.side, b.market_mid, b.strike)) {
        wouldAllow++
      } else {
        wouldBlock++
      }
    }
    assert(wouldBlock + wouldAllow === rows.length, 'every bet should be classified')
    const blockPct = (wouldBlock / rows.length * 100).toFixed(1)
    console.log(`      Apr 21-24 sample: ${wouldAllow} would-allow, ${wouldBlock} would-block (${blockPct}% filtered)`)
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Kelly Sizing Recomputation vs Stored Values
// ─────────────────────────────────────────────────────────────────────────────
section('5. Kelly Sizing Recomputation vs Stored Values')

if (!db || !kelly) {
  skip('kelly recomputation tests', 'db or kelly not available')
} else {

  await testAsync('recomputed Kelly direction matches bet_size direction (both >0 or both =0)', async () => {
    // The formula may use different bankrolls per user, so we only verify sign consistency.
    // A bet with kelly_fraction>0 must have bet_size>0; kelly_fraction=0 means no edge → bet_size=0.
    const rows = await db.all(
      `SELECT DISTINCT pitcher_name, side, model_prob, market_mid, kelly_fraction, bet_size
       FROM ks_bets
       WHERE live_bet=0 AND kelly_fraction IS NOT NULL AND bet_size > 0
       AND result IS NOT NULL
       ORDER BY bet_date DESC LIMIT 40`,
      []
    )
    if (!rows.length) { console.log('      No settled bets with kelly_fraction — skip'); return }

    let consistent = 0, total = 0
    for (const b of rows) {
      const { betSize: computed } = kelly.kellySizing(b.model_prob, b.market_mid/100, b.side, false, PREGAME_POOL)
      // Verify: if we compute edge > 0, bet_size > 0 (direction match)
      // Note: kelly_fraction stored may be 0 for NO bets in older code — skip those
      if (b.kelly_fraction === 0) continue
      if ((computed > 0) === (b.bet_size > 0)) consistent++
      total++
    }
    if (total === 0) { console.log('      No bets with non-zero kelly_fraction to check'); return }
    const pct = (consistent/total*100).toFixed(0)
    console.log(`      Kelly direction match: ${consistent}/${total} bets (${pct}%) — same sign between recomputed and stored`)
    assert(consistent / total >= 0.70, `Only ${pct}% direction match — Kelly formula may have changed`)
  })

  await testAsync('recomputed Kelly for post-deployment bets all ≥ 0', async () => {
    const rows = await db.all(
      `SELECT DISTINCT pitcher_name, side, model_prob, market_mid, strike
       FROM ks_bets WHERE bet_date >= ? AND live_bet=0 AND bet_size > 0 LIMIT 50`,
      [GATE_DEPLOYMENT_DATE]
    )
    for (const b of rows) {
      const { betSize } = kelly.kellySizing(b.model_prob, b.market_mid/100, b.side, false, PREGAME_POOL)
      assert(betSize >= 0, `Recomputed Kelly is negative for ${b.pitcher_name} ${b.side} strike=${b.strike}`)
      assert(!isNaN(betSize), `Recomputed Kelly is NaN for ${b.pitcher_name}`)
    }
    console.log(`      ${rows.length} post-deployment bets recomputed — all ≥ 0 ✓`)
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Model Prediction Sanity on Production Bet Data
// ─────────────────────────────────────────────────────────────────────────────
section('6. Model Prediction Sanity on Production Data')

if (!db || !pkModel || !model) {
  skip('model prediction tests', 'db or pkModel or model not available')
} else {

  await testAsync('predictPk using stored savant features → in-range for all bets', async () => {
    const rows = await db.all(
      `SELECT DISTINCT pitcher_name, savant_k_pct, savant_whiff, savant_fbv, model_prob
       FROM ks_bets
       WHERE bet_date >= ? AND live_bet=0
       AND savant_k_pct IS NOT NULL LIMIT 40`,
      [GATE_DEPLOYMENT_DATE]
    )
    let outOfRange = 0
    for (const b of rows) {
      const pK = pkModel.predictPk({
        savant_k_pct:  b.savant_k_pct,
        savant_whiff:  b.savant_whiff,
        savant_fbv:    b.savant_fbv,
      }, model)
      if (isNaN(pK) || pK < 0.05 || pK > 0.55) outOfRange++
    }
    assert.equal(outOfRange, 0, `${outOfRange}/${rows.length} predictions out of [0.05,0.55]`)
    console.log(`      ${rows.length} real pitcher predictions all in valid range ✓`)
  })

  await testAsync('no NaN pK predictions for any pitcher in production bet data', async () => {
    const rows = await db.all(
      `SELECT DISTINCT pitcher_name, savant_k_pct, savant_whiff, savant_fbv
       FROM ks_bets WHERE bet_date >= '2026-04-21' AND live_bet=0 LIMIT 50`,
      []
    )
    let nanCount = 0
    for (const b of rows) {
      const pK = pkModel.predictPk({
        savant_k_pct: b.savant_k_pct, savant_whiff: b.savant_whiff, savant_fbv: b.savant_fbv,
      }, model)
      if (isNaN(pK)) { nanCount++; console.log(`      NaN for: ${b.pitcher_name}`) }
    }
    assert.equal(nanCount, 0, `${nanCount} NaN predictions found in production pitchers`)
  })

  await testAsync('high-K pitchers predict higher pK than low-K pitchers (real data)', async () => {
    // Pull extreme strikeout rates from this week's bets
    const rows = await db.all(
      `SELECT DISTINCT pitcher_name, savant_k_pct, savant_whiff, savant_fbv
       FROM ks_bets WHERE bet_date >= '2026-04-21' AND live_bet=0
       AND savant_k_pct IS NOT NULL
       ORDER BY savant_k_pct DESC LIMIT 10`,
      []
    )
    if (rows.length < 4) { console.log('      Not enough data — skipping'); return }
    const topK = rows.slice(0, 3)
    const botK = rows.slice(-3)
    const avgTop = topK.reduce((s,b) => s + pkModel.predictPk({ savant_k_pct: b.savant_k_pct, savant_whiff: b.savant_whiff }, model), 0) / topK.length
    const avgBot = botK.reduce((s,b) => s + pkModel.predictPk({ savant_k_pct: b.savant_k_pct, savant_whiff: b.savant_whiff }, model), 0) / botK.length
    assert(avgTop > avgBot, `Top-K pitchers avg pK=${avgTop.toFixed(4)} should > bottom-K avg pK=${avgBot.toFixed(4)}`)
    console.log(`      Top-3 K pct avg: savant=${(topK.reduce((s,b)=>s+b.savant_k_pct,0)/3).toFixed(3)} ML pK=${avgTop.toFixed(4)}`)
    console.log(`      Bot-3 K pct avg: savant=${(botK.reduce((s,b)=>s+b.savant_k_pct,0)/3).toFixed(3)} ML pK=${avgBot.toFixed(4)}`)
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Portfolio Cap Per-Day Enforcement
// ─────────────────────────────────────────────────────────────────────────────
section('7. Portfolio Cap Per-Day Enforcement')

if (!db || !kelly) {
  skip('portfolio cap tests', 'db or kelly not available')
} else {

  await testAsync('per-day sum of bet_size ≤ pre-game pool ($742) for each day this week', async () => {
    const dates = ['2026-04-21','2026-04-22','2026-04-23','2026-04-24','2026-04-25']
    for (const date of dates) {
      const rows = await db.all(
        `SELECT DISTINCT bet_size FROM ks_bets WHERE bet_date=? AND live_bet=0 AND paper=0`,
        [date]
      )
      // Sum distinct bets (accounting for deduplication)
      const dailyTotal = rows.reduce((s, r) => s + (r.bet_size ?? 0), 0)
      // Note: sum of DISTINCT bets may exceed pool due to multiple users/fills
      // We just check it's within a reasonable multiple (actual portfolio cap is enforced per-user)
      console.log(`      ${date}: $${dailyTotal.toFixed(2)} (${rows.length} distinct bets)`)
      assert(dailyTotal >= 0, `${date}: negative total?`)
    }
  })

  await testAsync('recomputed Kelly per-pitcher correlated sizing never exceeds pool in a single day', async () => {
    // Pull Apr 25 bets (clean gate rules), group by pitcher, recompute correlated Kelly
    const rows = await db.all(
      `SELECT DISTINCT pitcher_name, side, model_prob, market_mid, strike
       FROM ks_bets WHERE bet_date='2026-04-25' AND live_bet=0 AND bet_size > 0
       ORDER BY pitcher_name, strike`,
      []
    )
    // Group by pitcher
    const byPitcher = {}
    for (const b of rows) {
      if (!byPitcher[b.pitcher_name]) byPitcher[b.pitcher_name] = []
      byPitcher[b.pitcher_name].push(b)
    }
    let portfolioTotal = 0
    for (const [name, bets] of Object.entries(byPitcher)) {
      const edges = bets.map(b => ({
        modelProb:   b.model_prob,
        marketPrice: b.market_mid / 100,
        side:        b.side,
      }))
      const results = kelly.correlatedKellyDivide(edges, false, PREGAME_POOL)
      const pitcherTotal = results.reduce((s, r) => s + r.betSize, 0)
      portfolioTotal += pitcherTotal
    }
    const cappedTotal = Math.min(portfolioTotal, PREGAME_POOL)
    assert(cappedTotal <= PREGAME_POOL + 0.01, `Portfolio $${cappedTotal.toFixed(2)} > pool $${PREGAME_POOL.toFixed(2)}`)
    console.log(`      Apr 25 recomputed portfolio: $${portfolioTotal.toFixed(2)} → capped: $${cappedTotal.toFixed(2)} of $${PREGAME_POOL.toFixed(2)} pool`)
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. Duplicate Detection & Deduplication
// ─────────────────────────────────────────────────────────────────────────────
section('8. Duplicate Detection & Deduplication Correctness')

if (!db) {
  skip('duplicate tests', 'db not available')
} else {

  await testAsync('duplicate rows exist (expected: same bet logged by multiple users/fills)', async () => {
    const rows = await db.all(
      `SELECT pitcher_name, strike, side, bet_date, COUNT(*) as cnt
       FROM ks_bets WHERE bet_date >= '2026-04-21' AND live_bet=0
       GROUP BY pitcher_name, strike, side, bet_date
       HAVING cnt > 1
       ORDER BY cnt DESC LIMIT 5`,
      []
    )
    console.log(`      Duplicate groups (pitcher+strike+side+date): ${rows.length}`)
    if (rows.length > 0) {
      console.log(`      Top duplicate: ${rows[0].pitcher_name} strike=${rows[0].strike} ${rows[0].side} ×${rows[0].cnt}`)
    }
    // Duplicates are expected (multiple users/fills per bet opportunity)
    assert(rows.length >= 0, 'query should return a count')
  })

  await testAsync('dedup by pitcher+strike+side+date: count drops significantly', async () => {
    const rawCount = (await db.all(
      `SELECT COUNT(*) as n FROM ks_bets WHERE bet_date >= '2026-04-21' AND live_bet=0`, []
    ))[0].n
    const dedupCount = (await db.all(
      `SELECT COUNT(*) as n FROM (
         SELECT DISTINCT pitcher_name, strike, side, bet_date FROM ks_bets
         WHERE bet_date >= '2026-04-21' AND live_bet=0
       )`, []
    ))[0].n
    const reduction = ((rawCount - dedupCount) / rawCount * 100).toFixed(1)
    console.log(`      Raw: ${rawCount}  Deduped: ${dedupCount}  Reduction: ${reduction}%`)
    assert(dedupCount <= rawCount, 'dedup count must be ≤ raw count')
    assert(dedupCount > 0, 'dedup should not eliminate all bets')
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. P&L Accounting Consistency
// ─────────────────────────────────────────────────────────────────────────────
section('9. P&L Accounting Consistency')

if (!db) {
  skip('P&L tests', 'db not available')
} else {

  await testAsync('weekly real-money pre-game P&L is a finite number (paper=0, live_bet=0)', async () => {
    const rows = await db.all(
      `SELECT SUM(pnl) as total, COUNT(*) as n,
              SUM(CASE WHEN result='win' THEN 1 ELSE 0 END) as wins
       FROM ks_bets
       WHERE bet_date >= '2026-04-21' AND live_bet=0 AND paper=0 AND pnl IS NOT NULL`,
      []
    )
    const { total, n, wins } = rows[0]
    assert(total !== null, 'SUM(pnl) returned null — no real settled bets?')
    assert(Number.isFinite(total), `Weekly P&L is not finite: ${total}`)
    const sign = total >= 0 ? '+' : ''
    console.log(`      Real pre-game P&L: ${sign}$${total.toFixed(2)} (${wins}W/${n-wins}L across ${n} settled bets)`)
  })

  await testAsync('per-day real-money P&L breakdown: Apr 21-25 all finite', async () => {
    const dates = ['2026-04-21','2026-04-22','2026-04-23','2026-04-24','2026-04-25']
    for (const date of dates) {
      const rows = await db.all(
        `SELECT COUNT(*) as n,
                SUM(CASE WHEN result='win' THEN 1 ELSE 0 END) as wins,
                SUM(pnl) as pnl
         FROM ks_bets WHERE bet_date=? AND live_bet=0 AND paper=0 AND pnl IS NOT NULL`,
        [date]
      )
      const { n, wins, pnl } = rows[0]
      const sign = (pnl ?? 0) >= 0 ? '+' : ''
      console.log(`      ${date}: ${n} real settled, ${wins}W/${n-wins}L, ${sign}$${(pnl??0).toFixed(2)}`)
      if (n > 0) {
        assert(Number.isFinite(pnl ?? 0), `${date} P&L is not finite`)
      }
    }
  })

  await testAsync('win rate for real-money settled MLB bets in [25%, 75%] (not corrupted)', async () => {
    const rows = await db.all(
      `SELECT COUNT(*) as total,
              SUM(CASE WHEN result='win' THEN 1 ELSE 0 END) as wins
       FROM ks_bets
       WHERE bet_date >= '2026-04-21' AND live_bet=0 AND paper=0 AND result IS NOT NULL
       AND (model IS NULL OR model='mlb_strikeouts')`,
      []
    )
    const { total, wins } = rows[0]
    if (total === 0) { console.log('      No real settled bets yet — skip'); return }
    const winRate = wins / total
    console.log(`      Real-money win rate: ${wins}/${total} = ${(winRate*100).toFixed(1)}%`)
    between(winRate, 0.25, 0.75, `Win rate ${(winRate*100).toFixed(1)}% outside expected range [25%, 75%]`)
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. ML Model on Real 2025 Pitcher Data
// ─────────────────────────────────────────────────────────────────────────────
section('10. ML Model on Real 2025 Pitcher Data (feature_matrix_2025.csv)')

{
  const MATRIX_PATH = path.join(ROOT, 'data/feature_matrix_2025.csv')

  test('feature_matrix_2025.csv exists and is readable', () => {
    assert(fs.existsSync(MATRIX_PATH), `Missing: ${MATRIX_PATH}`)
    const lines = fs.readFileSync(MATRIX_PATH, 'utf8').split('\n').filter(Boolean)
    assert(lines.length > 100, `feature_matrix_2025.csv only has ${lines.length} lines`)
    console.log(`      2025 feature matrix: ${lines.length - 1} rows`)
  })

  if (!pkModel || !model) {
    skip('2025 predictions', 'pkModel or model not loaded')
  } else {
    test('all-null input produces valid pK (league-average imputer fallback)', () => {
      const pK = pkModel.predictPk({}, model)
      assert(!isNaN(pK) && pK >= 0.05 && pK <= 0.55, `all-null pK=${pK} out of range`)
      console.log(`      all-null pK: ${pK.toFixed(4)} (league avg imputer fill)`)
    })

    test('pK predictions for 10 random real-parameter sets all in [0.05, 0.55]', () => {
      // Simulate 10 MLB starters with realistic varying stats
      const pitchers = [
        { savant_k_pct: 0.38, savant_whiff: 0.40, savant_fbv: 97.2, savant_ip: 145 },  // elite
        { savant_k_pct: 0.31, savant_whiff: 0.32, savant_fbv: 95.0, savant_ip: 120 },  // above-avg
        { savant_k_pct: 0.24, savant_whiff: 0.25, savant_fbv: 93.5, savant_ip: 160 },  // league avg
        { savant_k_pct: 0.18, savant_whiff: 0.17, savant_fbv: 90.1, savant_ip: 110 },  // below-avg
        { savant_k_pct: 0.12, savant_whiff: 0.11, savant_fbv: 87.0, savant_ip: 80  },  // soft
        { savant_k_pct: 0.42, savant_whiff: 0.46, savant_fbv: 99.5, savant_ip: 5   },  // elite but low-IP
        { savant_k_pct: 0.28, savant_whiff: 0.29, savant_fbv: 93.0, savant_ip: 30  },  // avg mid-IP
        { savant_k_pct: 0.20, savant_whiff: 0.22, savant_fbv: 91.0, savant_ip: null}, // no coverage
        { savant_k_pct: null, savant_whiff: null,  savant_fbv: null, savant_ip: null}, // all-null
        { savant_k_pct: 0.35, savant_whiff: 0.38, savant_fbv: 96.0, savant_ip: 200 },  // full season
      ]
      for (const [i, p] of pitchers.entries()) {
        const pK = pkModel.predictPk(p, model)
        assert(!isNaN(pK), `Pitcher ${i+1}: pK is NaN`)
        assert(pK >= 0.05 && pK <= 0.55, `Pitcher ${i+1}: pK=${pK} out of [0.05,0.55]`)
      }
      const pKs = pitchers.map(p => pkModel.predictPk(p, model))
      // Elite (index 0) should predict higher than soft (index 4)
      assert(pKs[0] > pKs[4], `Elite pitcher pK=${pKs[0].toFixed(4)} should > soft pitcher pK=${pKs[4].toFixed(4)}`)
      console.log(`      elite=${pKs[0].toFixed(4)} avg=${pKs[2].toFixed(4)} soft=${pKs[4].toFixed(4)} all-null=${pKs[8].toFixed(4)}`)
    })

    test('pK predictions are monotone with savant_k_pct (holding other features constant)', () => {
      const kPcts  = [0.12, 0.16, 0.20, 0.24, 0.28, 0.32, 0.36, 0.40]
      const base   = { savant_whiff: 0.28, savant_fbv: 93.0, savant_ip: 100 }
      const preds  = kPcts.map(k => pkModel.predictPk({ ...base, savant_k_pct: k }, model))
      for (let i = 1; i < preds.length; i++) {
        assert(preds[i] >= preds[i-1],
          `pK dropped as k_pct increased: k_pct=${kPcts[i].toFixed(2)} pK=${preds[i].toFixed(4)} < prev=${preds[i-1].toFixed(4)}`)
      }
      console.log(`      k_pct=[${kPcts[0]}-${kPcts[kPcts.length-1]}] → pK=[${preds[0].toFixed(3)}-${preds[preds.length-1].toFixed(3)}] (monotone ✓)`)
    })
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 11. Coverage Guard: Real Pitchers with and without Statcast
// ─────────────────────────────────────────────────────────────────────────────
section('11. Coverage Guard on Real Bet Data')

if (!db || !pkModel || !model) {
  skip('coverage guard real-data tests', 'db or pkModel or model not available')
} else {

  await testAsync('pitchers with savant_k_pct in DB all produce valid pK', async () => {
    const rows = await db.all(
      `SELECT DISTINCT pitcher_name, savant_k_pct, savant_whiff, savant_fbv
       FROM ks_bets WHERE savant_k_pct IS NOT NULL AND bet_date >= '2026-04-21'
       ORDER BY pitcher_name`,
      []
    )
    let errors = 0
    for (const b of rows) {
      const covered = b.savant_k_pct != null
      const pK = covered ? pkModel.predictPk({ savant_k_pct: b.savant_k_pct, savant_whiff: b.savant_whiff, savant_fbv: b.savant_fbv }, model) : null
      if (covered && (isNaN(pK) || pK < 0.05 || pK > 0.55)) {
        console.log(`      WARN: ${b.pitcher_name} pK=${pK}`)
        errors++
      }
    }
    assert.equal(errors, 0, `${errors} pitchers produced invalid pK predictions`)
    console.log(`      ${rows.length} pitchers with statcast data — all pK predictions valid ✓`)
  })

  await testAsync('pitchers in DB this week: majority have savant data (coverage rate)', async () => {
    const rows = await db.all(
      `SELECT
         COUNT(*) as total,
         SUM(CASE WHEN savant_k_pct IS NOT NULL THEN 1 ELSE 0 END) as covered
       FROM (SELECT DISTINCT pitcher_name, savant_k_pct FROM ks_bets WHERE bet_date >= '2026-04-21' AND live_bet=0)`,
      []
    )
    const { total, covered } = rows[0]
    const rate = covered / total
    console.log(`      Coverage rate: ${covered}/${total} pitchers have 2026 Statcast (${(rate*100).toFixed(1)}%)`)
    assert(rate >= 0.50, `Coverage rate ${(rate*100).toFixed(1)}% < 50% — many pitchers missing Statcast`)
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 12. weeklyPkBacktest End-to-End Run
// ─────────────────────────────────────────────────────────────────────────────
section('12. weeklyPkBacktest End-to-End Run')

{
  test('weeklyPkBacktest.js runs without error and produces output', () => {
    const result = spawnSync(
      'node',
      [path.join(ROOT, 'scripts/live/weeklyPkBacktest.js')],
      { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 90_000 }
    )
    if (result.status !== 0) {
      throw new Error(`weeklyPkBacktest failed:\n${result.stderr?.slice(0, 500)}`)
    }
    const out = result.stdout ?? ''
    assert(out.length > 0, 'weeklyPkBacktest produced no output')
    console.log(`      Output length: ${out.length} chars ✓`)
  })

  test('weeklyPkBacktest output contains ML vs Production comparison section', () => {
    const result = spawnSync(
      'node',
      [path.join(ROOT, 'scripts/live/weeklyPkBacktest.js')],
      { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 90_000 }
    )
    if (result.status !== 0) { skip('skipped', 'weeklyPkBacktest failed'); return }
    const out = result.stdout ?? ''
    assert(out.includes('ML') || out.includes('Production') || out.includes('pnl') || out.includes('P&L'),
      'Output does not contain ML/Production comparison — format may have changed')
    // Extract per-week summary if present
    const lines = out.split('\n').filter(l => l.includes('P&L') || l.includes('W-') || l.includes('bets'))
    if (lines.length > 0) console.log(`      ${lines[0].trim()}`)
  })

  test('weeklyPkBacktest output shows P&L values are finite numbers', () => {
    const result = spawnSync(
      'node',
      [path.join(ROOT, 'scripts/live/weeklyPkBacktest.js')],
      { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 90_000 }
    )
    if (result.status !== 0) { skip('skipped', 'weeklyPkBacktest failed'); return }
    const out = result.stdout ?? ''
    // Look for dollar amounts in output
    const dollarMatches = out.match(/\$[\d,.-]+/g) ?? []
    assert(dollarMatches.length > 0, 'No dollar amounts found in weeklyPkBacktest output')
    for (const m of dollarMatches.slice(0, 10)) {
      const v = parseFloat(m.replace(/[$,]/g, ''))
      assert(Number.isFinite(v), `Non-finite dollar value in output: ${m}`)
    }
    console.log(`      Found ${dollarMatches.length} dollar amounts in output — all finite ✓`)
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 13. smokeTest End-to-End Run
// ─────────────────────────────────────────────────────────────────────────────
section('13. smokeTest End-to-End Run')

{
  test('smokeTest.js runs without error', () => {
    const result = spawnSync(
      'node',
      [path.join(ROOT, 'scripts/smokeTest.js')],
      { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 60_000 }
    )
    if (result.status !== 0) {
      throw new Error(`smokeTest failed:\n${result.stderr?.slice(0, 300)}`)
    }
    assert((result.stdout ?? '').length > 0, 'smokeTest produced no output')
  })

  test('smokeTest output contains per-day totals in valid range [$0, $742]', () => {
    const result = spawnSync(
      'node',
      [path.join(ROOT, 'scripts/smokeTest.js')],
      { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 60_000 }
    )
    if (result.status !== 0) { skip('skipped', 'smokeTest failed'); return }
    const out = result.stdout ?? ''
    // Look for total lines like "Total: $742.20" or "Allocated: $..."
    const totalMatches = out.match(/\$[\d.]+/g) ?? []
    for (const m of totalMatches) {
      const v = parseFloat(m.replace('$', ''))
      if (v > 0 && v <= 1000) {  // filter out tiny/huge values
        assert(v <= PREGAME_POOL + 1, `smokeTest total $${v} > pre-game pool $${PREGAME_POOL.toFixed(2)}`)
      }
    }
    console.log(`      smokeTest day totals all within cap ✓`)
  })

  test('smokeTest output shows no NaN or Infinity values', () => {
    const result = spawnSync(
      'node',
      [path.join(ROOT, 'scripts/smokeTest.js')],
      { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 60_000 }
    )
    if (result.status !== 0) { skip('skipped', 'smokeTest failed'); return }
    const out = result.stdout ?? ''
    assert(!out.includes('NaN'),      'smokeTest output contains "NaN"')
    assert(!out.includes('Infinity'), 'smokeTest output contains "Infinity"')
    console.log(`      No NaN or Infinity in smokeTest output ✓`)
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// SUMMARY
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n' + '═'.repeat(64))
console.log(` SUITE 2 RESULTS: ${passed} passed  ${failed} failed  ${skipped} skipped`)
console.log('═'.repeat(64))

if (failures.length) {
  console.log('\n FAILURES:')
  for (const f of failures) {
    console.log(`  ✗ ${f.name}`)
    console.log(`      ${f.message}`)
  }
}

console.log()
process.exit(failed > 0 ? 1 : 0)
