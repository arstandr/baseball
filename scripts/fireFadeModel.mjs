// Fire the IDEAL fade model for the paper test.
//
// Architecture:
//   - Runs from scheduler at T-60 minutes per game (or batch invocation)
//   - For each scheduled probable starter, computes lambda via NB r=8 from K9_l5
//   - Filters: edge ≥5¢, ask ≤50¢, strike ≥6, YES-only
//   - Per-pitcher cap = 1 (best edge strike only)
//   - No daily fire cap (fire all qualifying candidates)
//   - Sizing: edge-weighted (1×–5×) on 1% paper bankroll base, $200/bet cap
//   - Fires via existing ksBets.js logBet flow → ks_bets row with strategy_mode='pregame_fade_yes'
//   - Logs to fade_paper_test_candidates with hypothetical multi-sizing P&L
//   - Posts Discord alert per fire (who, why, expected outcome)
//
// Usage:
//   node scripts/fireFadeModel.mjs                    # fire for all today's eligible games
//   node scripts/fireFadeModel.mjs --pitcher-id 1234  # fire for one pitcher
//   node scripts/fireFadeModel.mjs --dry-run          # log candidates, don't fire

import 'dotenv/config'
import { createClient } from '@libsql/client'
import { placeOrder, getOrderbook, authedRequest } from '../lib/kalshi.js'
import { STRATEGY_MODES, validateStrategyMode } from '../lib/strategyMode.js'

const ARG_DRY = process.argv.includes('--dry-run')
const ARG_PITCHER_IDX = process.argv.indexOf('--pitcher-id')
const ARG_PITCHER = ARG_PITCHER_IDX > 0 ? process.argv[ARG_PITCHER_IDX + 1] : null

const PAPER_BANKROLL_DEFAULT = 5000
const SIZING_BASE_PCT = 0.01     // 1% baseline
const SIZING_EDGE_MAX_MULT = 5   // up to 5× on biggest edges
const CAP_PER_BET = 200
const MIN_EDGE = 0.05
const MAX_EDGE = 0.20  // skip suspicious huge edges (likely market knows something)
const MAX_ASK = 50
const MIN_STRIKE = 6
const NB_DISPERSION = 8
const FEE = 0.07
// Liquidity cap: never bet more than this fraction of the market's 24h volume.
// Keeps paper-mode fills realistic — real fills face orderbook depth limits.
const MAX_PCT_OF_VOLUME = 0.10
const MIN_FILLABLE_CONTRACTS = 50  // skip if even this much would exceed liquidity
const DISCORD_WEBHOOK = process.env.FADE_DISCORD_WEBHOOK || process.env.DISCORD_PERSONAL_WEBHOOK

// ─── Strategy variant ───────────────────────────────────────────────────────
// 2026-05-12 out-of-sample test (scripts/v3HistoricalTest.mjs, Mar 31–May 6, the
// 858-record window v3's filters were NOT designed on):
//   v1 (best-edge strike ≥6, no v3 filters)  baseline
//   v1 + H-H (avg_innings_l5 ≥ 5)             −$42k vs v1   ← FAILED
//   v1 + skip K=7-9 (K=6 / K≥10 only)         −$57k vs v1   ← FAILED
//   v1 + H-I (confidence > 0.3)               +$1.2k vs v1  ← neutral/positive, KEEP
//   v3 (all of the above)                     −$68k vs v1   ← the May 7-10 +59% lift was overfit
// → default reverted to 'v1h' = v1 + H-I (+ news-check + the 5-20¢ edge band, both
//   kept since neither was in the OOS comparison and both are sound). News-check and
//   H-I are unconditional. Set FADE_VARIANT=v3 to restore the full promoted-v3 filter
//   set (H-H skip + K=6/K≥10-only candidate selection + per-pitcher cap 2).
const FADE_VARIANT = (process.env.FADE_VARIANT || 'v1h').toLowerCase()
const V3 = FADE_VARIANT === 'v3'

const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })

// ─── Probability functions ──────────────────────────────────────────────────
function nbGEqN(lambda, r, n) {
  if (n <= 0) return 1
  const p = r / (r + lambda)
  let cum = Math.pow(p, r), term = cum
  for (let k = 1; k < n; k++) { term = term * (k + r - 1) / k * (1 - p); cum += term }
  return Math.max(0, Math.min(1, 1 - cum))
}
function poissonGEqN(lambda, n) {
  if (n <= 0) return 1
  let cum = Math.exp(-lambda), term = cum
  for (let k = 1; k < n; k++) { term = term * lambda / k; cum += term }
  return Math.max(0, Math.min(1, 1 - cum))
}

function parseIp(s) {
  if (s == null) return 0
  const [w, f] = String(s).split('.')
  return Number(w) + (Number(f || 0) / 3)
}

async function fetchPitcherGameLog(pitcherId) {
  const url = `https://statsapi.mlb.com/api/v1/people/${pitcherId}/stats?stats=gameLog&season=2026&group=pitching`
  const res = await fetch(url).then(r => r.ok ? r.json() : null).catch(() => null)
  const splits = res?.stats?.[0]?.splits || []
  return splits.map(s => ({
    date: s.date,
    ks: Number(s.stat?.strikeOuts ?? 0),
    ip: parseIp(s.stat?.inningsPitched),
    bf: Number(s.stat?.battersFaced ?? 0),
  })).filter(g => g.date && g.ip > 0)
}

function computeLambda(priorStarts, window = 5) {
  if (priorStarts.length === 0) return null
  const recent = priorStarts.slice(-window)
  const totalK = recent.reduce((s, g) => s + g.ks, 0)
  const totalIp = recent.reduce((s, g) => s + g.ip, 0)
  if (totalIp <= 0) return null
  const k9 = totalK / totalIp * 9
  const avgIp = totalIp / recent.length
  if (k9 < 4 || k9 > 18) return null
  return { lambda: k9 * avgIp / 9, k9, avgIp, n: recent.length }
}

// Sizing variants for parallel tracking
function sizingVariants(askCents, edge, bankroll) {
  const baseUsd = bankroll * SIZING_BASE_PCT
  const edgeMult = Math.min(SIZING_EDGE_MAX_MULT, Math.max(1, 1 + (edge - MIN_EDGE) / MIN_EDGE))
  return {
    flat_1pct:     Math.min(CAP_PER_BET, Math.max(1, baseUsd)),
    flat_2pct:     Math.min(CAP_PER_BET, Math.max(1, bankroll * 0.02)),
    flat_3pct:     Math.min(CAP_PER_BET, Math.max(1, bankroll * 0.03)),
    edge_weighted: Math.min(CAP_PER_BET, Math.max(1, baseUsd * edgeMult)),
    fixed_50:      Math.min(CAP_PER_BET, 50),
    fixed_100:     Math.min(CAP_PER_BET, 100),
  }
}

function computeContractsAndStake(usd, askCents) {
  const contracts = Math.max(1, Math.floor(usd / (askCents / 100)))
  return { contracts, stake: contracts * (askCents / 100) }
}

// ─── Discover today's pitchers + their KS markets ───────────────────────────
async function loadEligibleStarters() {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  // Source starters from market_snapshots — captures every pitcher with an
  // active KXMLBKS market today, regardless of whether the production pipeline
  // has scheduled them in ks_bets yet.
  const ms = await db.execute({
    sql: `SELECT pitcher_id, MAX(pitcher_name) AS pitcher_name,
                 MAX(game_id) AS game_id, MAX(game_label) AS game_label
          FROM market_snapshots
          WHERE game_date = ? AND ticker LIKE 'KXMLBKS-%'
            AND pitcher_id IS NOT NULL
          GROUP BY pitcher_id`,
    args: [today],
  })
  const starters = []
  for (const r of ms.rows) {
    const pid = String(r.pitcher_id)
    if (ARG_PITCHER && pid !== String(ARG_PITCHER)) continue
    starters.push({
      pitcher_id: pid,
      pitcher_name: r.pitcher_name,
      game_label: r.game_label,
    })
  }
  return { today, starters }
}

// ─── Pull live KS market chain for a pitcher ────────────────────────────────
async function loadLiveKsChain(pitcherId, today) {
  // Get tickers for this pitcher today from market_snapshots
  const r = await db.execute({
    sql: `SELECT DISTINCT ticker, strike FROM market_snapshots
          WHERE pitcher_id = ? AND game_date = ? AND ticker LIKE 'KXMLBKS-%'`,
    args: [pitcherId, today],
  })
  const ladder = []
  for (const row of r.rows) {
    // Pull live orderbook
    const ob = await getOrderbook(row.ticker, 5).catch(() => null)
    if (!ob || ob.best_yes_ask == null) continue
    ladder.push({
      strike: Number(row.strike),
      ticker: row.ticker,
      yes_bid: ob.best_yes_bid ?? 0,
      yes_ask: ob.best_yes_ask,
      no_bid:  ob.best_no_bid ?? 0,
      no_ask:  ob.best_no_ask ?? 100,
    })
  }
  return ladder.sort((a, b) => a.strike - b.strike)
}

async function postDiscord(content) {
  if (!DISCORD_WEBHOOK) return
  await fetch(DISCORD_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  }).catch(() => {})
}

// ─── Main pipeline ──────────────────────────────────────────────────────────
async function getPaperBankroll() {
  // Compute current paper bankroll = $5K + cumulative pnl from pregame_fade_yes paper rows
  const r = await db.execute(`
    SELECT COALESCE(SUM(pnl), 0) AS total
    FROM ks_bets WHERE strategy_mode = 'pregame_fade_yes' AND paper = 1 AND result IN ('win','loss')
  `)
  return PAPER_BANKROLL_DEFAULT + Number(r.rows[0].total ?? 0)
}

async function main() {
  const { today, starters } = await loadEligibleStarters()
  console.log(`[fade-model] ${today}: ${starters.length} starter(s) eligible`)
  if (starters.length === 0) return

  const bankroll = await getPaperBankroll()
  console.log(`[fade-model] paper bankroll = $${bankroll.toFixed(0)}`)

  for (const p of starters) {
    // Per-pitcher cap. v3: 2 (one K=6 + one K≥10) — skip only if BOTH already fired.
    // v1h: 1 (best-edge strike ≥6) — skip if any fade row already exists today.
    const existing = await db.execute({
      sql: `SELECT strike FROM ks_bets WHERE pitcher_id = ? AND bet_date = ? AND strategy_mode = 'pregame_fade_yes'`,
      args: [p.pitcher_id, today],
    })
    const firedFavorite = existing.rows.some(r => Number(r.strike) === 6)
    const firedTail = existing.rows.some(r => Number(r.strike) >= 10)
    if (V3) {
      if (firedFavorite && firedTail) {
        console.log(`  [skip] ${p.pitcher_name} — already fired both K=6 and K≥10 today`)
        continue
      }
    } else if (existing.rows.length > 0) {
      console.log(`  [skip] ${p.pitcher_name} — fade bet already fired today`)
      continue
    }

    // ── Filters ──────────────────────────────────────────────────
    // H-I (confidence > 0.3) and the news-check are UNCONDITIONAL (both variants).
    // H-H (avg_innings_l5 ≥ 5) and the K=6/K≥10-only strike filter are v3-only —
    // both failed the 2026-05-12 OOS test (see FADE_VARIANT note at top).
    const sigRow = await db.execute({
      sql: `SELECT avg_innings_l5, confidence FROM pitcher_signals WHERE pitcher_id = ? AND signal_date = ? LIMIT 1`,
      args: [p.pitcher_id, today],
    })
    const sig = sigRow.rows[0]
    if (V3 && sig?.avg_innings_l5 != null && Number(sig.avg_innings_l5) < 5.0) {
      console.log(`  [skip-H-H] ${p.pitcher_name} — avg_innings_l5=${Number(sig.avg_innings_l5).toFixed(1)} < 5.0`)
      continue
    }
    if (sig?.confidence != null && Number(sig.confidence) <= 0.3) {
      console.log(`  [skip-H-I] ${p.pitcher_name} — confidence=${sig.confidence} ≤ 0.3`)
      continue
    }

    // News-check filter (H-T): skip if any 'skip' action in recent news_log
    const newsRow = await db.execute({
      sql: `SELECT action, reason, confidence FROM pitcher_news_log
            WHERE pitcher_id = ? AND game_date = ?
            ORDER BY checked_at DESC LIMIT 1`,
      args: [p.pitcher_id, today],
    })
    const news = newsRow.rows[0]
    if (news?.action === 'skip' && Number(news.confidence) >= 0.7) {
      console.log(`  [skip-NEWS] ${p.pitcher_name} — ${news.reason}`)
      continue
    }
    // (Lineup gate considered and rejected 2026-05-10: user prefers pre-lineup
    //  mispricing — wider markets, less-informed prices. News check covers
    //  scratch detection at 9/12/15/18 ET windows.)

    // Load pitcher's prior starts via MLB API
    const log = await fetchPitcherGameLog(p.pitcher_id).catch(() => [])
    const prior = log.filter(g => g.date < today)
    if (prior.length === 0) {
      console.log(`  [skip] ${p.pitcher_name} — no prior starts`)
      continue
    }
    const lam = computeLambda(prior, 5)
    if (!lam) {
      console.log(`  [skip] ${p.pitcher_name} — lambda out of bounds (k9=${(prior.slice(-5).reduce((s,g)=>s+g.ks,0) / Math.max(0.001, prior.slice(-5).reduce((s,g)=>s+g.ip,0)) * 9).toFixed(1)})`)
      continue
    }

    // ── Lineup-aware lambda adjustment ──────────────────────────────
    // If opposing lineup is posted, multiply lambda by (lineup_k_pct /
    // league_avg). High-K opposing lineup → higher expected K total.
    // Low-K opposing lineup → lower. Only applies when 8+ batters confirmed.
    let lineupAdjusted = false, lineupKPct = null
    try {
      const gameId = await db.execute({
        sql: `SELECT MAX(game_id) AS gid FROM market_snapshots WHERE pitcher_id = ? AND game_date = ?`,
        args: [p.pitcher_id, today],
      }).then(r => r.rows[0]?.gid)
      if (gameId) {
        const handRow = await db.execute({
          sql: `SELECT hand FROM pitcher_signals WHERE pitcher_id = ? AND signal_date = ? LIMIT 1`,
          args: [p.pitcher_id, today],
        })
        const pitcherHand = handRow.rows[0]?.hand ?? 'R'
        const lineup = await db.execute({
          sql: `SELECT lineup_k_pct, batter_count FROM game_lineups
                WHERE game_id = ? AND vs_hand = ? AND batter_count >= 8
                ORDER BY fetch_date DESC LIMIT 1`,
          args: [String(gameId), pitcherHand],
        })
        const lk = lineup.rows[0]
        if (lk?.lineup_k_pct != null) {
          lineupKPct = Number(lk.lineup_k_pct)
          const LEAGUE_AVG_K_PCT = 0.22
          const adj = lineupKPct / LEAGUE_AVG_K_PCT
          // Cap adjustment at ±15% to avoid extreme outliers
          const capped = Math.max(0.85, Math.min(1.15, adj))
          lam.lambda *= capped
          lineupAdjusted = true
        }
      }
    } catch { /* non-fatal */ }
    if (lineupAdjusted) {
      console.log(`  [lineup-adj] ${p.pitcher_name} — opp_k_pct=${(lineupKPct*100).toFixed(1)}%, λ adjusted to ${lam.lambda.toFixed(2)}`)
    }

    // Load live KS chain
    const chain = await loadLiveKsChain(p.pitcher_id, today)
    if (chain.length < 4) {
      console.log(`  [skip] ${p.pitcher_name} — chain too thin (${chain.length} strikes)`)
      continue
    }

    // Candidate selection. Edge band: 5¢ ≤ edge ≤ 20¢ (skip suspicious huge edges).
    //   v3:  best K=6 and best K≥10 separately (per-pitcher cap 2) — strike filter FAILED OOS.
    //   v1h: single best-edge candidate across all strikes ≥ MIN_STRIKE (per-pitcher cap 1).
    let candidates = []
    if (V3) {
      let bestFavorite = null   // best K=6
      let bestTail = null        // best K≥10
      for (const c of chain) {
        if (c.yes_ask > MAX_ASK || c.yes_ask < 3) continue
        const modelProb = nbGEqN(lam.lambda, NB_DISPERSION, c.strike)
        const edge = modelProb - c.yes_ask / 100
        if (edge < MIN_EDGE || edge > MAX_EDGE) continue
        if (Number(c.strike) === 6) {
          if (!bestFavorite || edge > bestFavorite.edge) bestFavorite = { ...c, model_prob: modelProb, edge }
        } else if (Number(c.strike) >= 10) {
          if (!bestTail || edge > bestTail.edge) bestTail = { ...c, model_prob: modelProb, edge }
        }
      }
      candidates = [bestFavorite, bestTail].filter(Boolean)
    } else {
      let best = null
      for (const c of chain) {
        if (c.yes_ask > MAX_ASK || c.yes_ask < 3) continue
        if (Number(c.strike) < MIN_STRIKE) continue
        const modelProb = nbGEqN(lam.lambda, NB_DISPERSION, c.strike)
        const edge = modelProb - c.yes_ask / 100
        if (edge < MIN_EDGE || edge > MAX_EDGE) continue
        if (!best || edge > best.edge) best = { ...c, model_prob: modelProb, edge }
      }
      candidates = best ? [best] : []
    }
    if (candidates.length === 0) {
      console.log(`  [skip] ${p.pitcher_name} — no qualifying strike (λ=${lam.lambda.toFixed(2)}, k9=${lam.k9.toFixed(1)})`)
      continue
    }

    // Fire each qualifying candidate, respecting per-class cap (v3) / single cap (v1h)
    for (const best of candidates) {
      const isFavorite = Number(best.strike) === 6
      const isTail = Number(best.strike) >= 10
      if (V3 && isFavorite && firedFavorite) { console.log(`  [skip] ${p.pitcher_name} K=6 already fired today`); continue }
      if (V3 && isTail && firedTail)         { console.log(`  [skip] ${p.pitcher_name} K≥${best.strike} (tail) already fired today`); continue }

    // Sizing variants
    const sizings = sizingVariants(best.yes_ask, best.edge, bankroll)
    const primarySize = sizings.edge_weighted
    let { contracts, stake } = computeContractsAndStake(primarySize, best.yes_ask)

    // Liquidity cap: fetch market's 24h volume, cap contracts at MAX_PCT_OF_VOLUME of it
    let liquidityCapApplied = false
    let totalContractsToday = null
    let yesAskSizeAtFire = null, yesBidSizeAtFire = null, askAtFire = best.yes_ask
    try {
      const md = await authedRequest('GET', `/markets/${best.ticker}`).catch(() => null)
      const vol24Usd = parseFloat(md?.market?.volume_24h_fp ?? 0)
      totalContractsToday = vol24Usd > 0 ? Math.floor(vol24Usd / (best.yes_ask / 100)) : null
      yesAskSizeAtFire = md?.market?.yes_ask_size_fp ? parseFloat(md.market.yes_ask_size_fp) : null
      yesBidSizeAtFire = md?.market?.yes_bid_size_fp ? parseFloat(md.market.yes_bid_size_fp) : null
      const liveAsk = md?.market?.yes_ask_dollars ? parseFloat(md.market.yes_ask_dollars) * 100 : null
      if (liveAsk != null) askAtFire = Math.round(liveAsk)
      if (totalContractsToday != null) {
        const maxByLiquidity = Math.floor(totalContractsToday * MAX_PCT_OF_VOLUME)
        if (maxByLiquidity < MIN_FILLABLE_CONTRACTS) {
          console.log(`  [skip] ${p.pitcher_name} K≥${best.strike} — market too thin (max fillable ${maxByLiquidity} < ${MIN_FILLABLE_CONTRACTS})`)
          continue
        }
        if (contracts > maxByLiquidity) {
          console.log(`  [liquidity-cap] ${p.pitcher_name} K≥${best.strike}: capping ${contracts}c → ${maxByLiquidity}c (10% of ${totalContractsToday}c daily volume)`)
          contracts = maxByLiquidity
          stake = contracts * (best.yes_ask / 100)
          liquidityCapApplied = true
        }
      }
    } catch { /* non-fatal — proceed with original sizing */ }

    console.log(`  [FIRE] ${p.pitcher_name} K≥${best.strike} YES @ ${best.yes_ask}¢  edge=+${(best.edge*100).toFixed(1)}¢  size=$${stake.toFixed(0)} (${contracts}c × ${best.yes_ask}¢)${liquidityCapApplied ? ' [liquidity-capped]' : ''}  λ=${lam.lambda.toFixed(2)} k9=${lam.k9.toFixed(1)}`)

    if (ARG_DRY) continue

    // Place order via Kalshi (paper mode = synthetic fill)
    let placeResult = null
    try {
      placeResult = await placeOrder(best.ticker, 'yes', contracts, best.yes_ask, {}, 'buy', {
        type: 'limit',
        client_order_id: `fade-${p.pitcher_id}-${best.strike}-${Date.now()}`.slice(0, 36),
      })
    } catch (err) {
      console.error(`  [error] place failed for ${p.pitcher_name}: ${err.message}`)
      continue
    }

    // Insert ks_bets row
    const orderId = placeResult?.order?.order_id ?? `paper-fade-${Date.now()}-${p.pitcher_id}`
    const fillPrice = placeResult?.order?.fill_price ?? best.yes_ask
    await db.execute({
      sql: `INSERT INTO ks_bets (
        bet_date, pitcher_id, pitcher_name, game,
        side, strike, ticker, fill_price, filled_contracts, order_id,
        strategy_mode, paper, model_prob, market_mid, edge, kelly_fraction,
        ask_at_fire_cents, depth_at_fire,
        order_status, logged_at, filled_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`,
      args: [
        today, p.pitcher_id, p.pitcher_name, p.game_label,
        'YES', best.strike, best.ticker, fillPrice, contracts, orderId,
        validateStrategyMode(STRATEGY_MODES.PREGAME_FADE_YES), 1,
        best.model_prob, (best.yes_bid + best.yes_ask) / 2, best.edge,
        SIZING_BASE_PCT * (1 + (best.edge - MIN_EDGE) / MIN_EDGE),
        askAtFire, yesAskSizeAtFire,
        'filled',
      ],
    })

    // Build hypothetical sizing P&L map (for daily reporting)
    const sizingsJson = {}
    for (const [variant, usd] of Object.entries(sizings)) {
      const c = computeContractsAndStake(usd, best.yes_ask)
      sizingsJson[variant] = { stake: c.stake, contracts: c.contracts }
    }

    // Discord alert
    const reasonLines = [
      `🎯 **PAPER FIRE** — ${p.pitcher_name} (${p.game_label})`,
      `K≥${best.strike} YES @ ${best.yes_ask}¢`,
      `Edge: +${(best.edge * 100).toFixed(1)}¢ (model ${(best.model_prob * 100).toFixed(0)}% vs market ${best.yes_ask}%)`,
      `λ = ${lam.lambda.toFixed(2)} (NB r=8 from K9_l5=${lam.k9.toFixed(1)} over ${lam.n} starts)`,
      `Stake: $${stake.toFixed(2)} (${contracts} contracts, edge-weighted ${((1+(best.edge-MIN_EDGE)/MIN_EDGE)).toFixed(1)}×)`,
      `Bankroll: $${bankroll.toFixed(0)}`,
    ]
    await postDiscord(reasonLines.join('\n'))

    // Insert/update fade_paper_test_candidates row
    await db.execute({
      sql: `INSERT OR REPLACE INTO fade_paper_test_candidates (
        evaluated_at, target_date, pitcher_id, pitcher_name, game_label, ticker,
        strike, side, yes_bid, yes_ask, market_mid, ask_cents,
        k9_l5, avg_ip_l5, prior_starts_count,
        lambdas_json, model_probs_json, edges_json,
        ks_bet_id, fired_actual, ask_at_fire_cents, fill_price_cents
      ) VALUES (datetime('now'),?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        today, p.pitcher_id, p.pitcher_name, p.game_label, best.ticker,
        best.strike, 'YES', best.yes_bid, best.yes_ask,
        (best.yes_bid + best.yes_ask) / 2, best.yes_ask,
        lam.k9, lam.avgIp, lam.n,
        JSON.stringify({ nb8_l5: lam.lambda, k9_l5: lam.k9 }),
        JSON.stringify({ nb8_l5: best.model_prob }),
        JSON.stringify({ nb8_l5: best.edge }),
        null, 1, best.yes_ask, fillPrice,
      ],
    })
    } // end candidates loop
  }

  console.log(`[fade-model] done`)
}

main().catch(err => {
  console.error('[fade-model] fatal:', err.message, err.stack)
  process.exit(1)
})
