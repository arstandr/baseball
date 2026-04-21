// scripts/live/askChatGPT.js — Send our strikeout model to ChatGPT for analysis + improvement ideas.
//
// Loads live context from the DB (recent bets, model params, pitcher examples) and
// asks GPT-4o to critique the approach and suggest concrete improvements.
//
// Usage:
//   node scripts/live/askChatGPT.js
//   node scripts/live/askChatGPT.js --focus "IP estimation"
//   node scripts/live/askChatGPT.js --model gpt-4o-mini   (cheaper, faster)

import 'dotenv/config'
import axios from 'axios'
import * as db from '../../lib/db.js'

const args      = process.argv.slice(2)
const FOCUS     = args.includes('--focus') ? args[args.indexOf('--focus') + 1] : null
const GPT_MODEL = args.includes('--model') ? args[args.indexOf('--model') + 1] : 'gpt-4o'
const API_KEY   = process.env.OPENAI_API_KEY

if (!API_KEY) {
  console.error('[askChatGPT] Missing OPENAI_API_KEY in .env — add it and re-run.')
  process.exit(1)
}

// ── Load DB context ────────────────────────────────────────────────────────────

async function loadContext() {
  await db.migrate()

  const settled = await db.all(`
    SELECT pitcher_name, strike, side, model_prob, market_mid, edge,
           lambda, k9_l5, k9_season, k9_career, opp_k_pct, adj_factor,
           savant_k_pct, savant_whiff, savant_fbv, whiff_flag,
           actual_ks, result, pnl
    FROM ks_bets WHERE result IS NOT NULL
    ORDER BY bet_date DESC LIMIT 40
  `, [])

  const open = await db.all(`
    SELECT pitcher_name, strike, side, model_prob, market_mid, edge,
           lambda, k9_l5, k9_season, k9_career, opp_k_pct, adj_factor,
           savant_k_pct, savant_whiff, savant_fbv, confidence
    FROM ks_bets WHERE result IS NULL
    ORDER BY edge DESC LIMIT 20
  `, [])

  const stats = await db.all(`
    SELECT
      COUNT(*) as n,
      SUM(CASE WHEN result='win' THEN 1 ELSE 0 END) as wins,
      AVG(edge) as avg_edge,
      SUM(pnl) as total_pnl,
      AVG(model_prob) as avg_model_prob,
      AVG(market_mid / 100.0) as avg_market_price
    FROM ks_bets WHERE result IS NOT NULL
  `, [])

  await db.close()
  return { settled, open, stats: stats[0] }
}

// ── Build prompt ───────────────────────────────────────────────────────────────

function buildPrompt(ctx, focus) {
  const { settled, open, stats } = ctx
  const wr = stats.wins && stats.n ? ((stats.wins / stats.n) * 100).toFixed(1) : 'n/a'

  const settledRows = settled.map(b =>
    `${b.pitcher_name} | ${b.strike}+Ks ${b.side} | model=${(b.model_prob*100).toFixed(0)}% ` +
    `mkt=${b.market_mid != null ? b.market_mid.toFixed(0)+'¢' : '?'} ` +
    `edge=${(b.edge*100).toFixed(1)}¢ | λ=${b.lambda?.toFixed(2)} ` +
    `k9_l5=${b.k9_l5?.toFixed(1)} k9_savant=${b.k9_season?.toFixed(1)} k9_career=${b.k9_career?.toFixed(1)} ` +
    `opp_adj=${b.adj_factor?.toFixed(3)} whiff=${b.savant_whiff?.toFixed(3) ?? 'n/a'} ` +
    `fbv=${b.savant_fbv ?? 'n/a'} | actual=${b.actual_ks ?? '?'}Ks → ${b.result} P&L=$${b.pnl?.toFixed(2) ?? '?'}`
  ).join('\n')

  const openRows = open.slice(0, 10).map(b =>
    `${b.pitcher_name} | ${b.strike}+Ks ${b.side} | model=${(b.model_prob*100).toFixed(0)}% ` +
    `mkt=${b.market_mid != null ? b.market_mid.toFixed(0)+'¢' : '?'} ` +
    `edge=${(b.edge*100).toFixed(1)}¢ | λ=${b.lambda?.toFixed(2)} ` +
    `k9_l5=${b.k9_l5?.toFixed(1)} k9_savant=${b.k9_season?.toFixed(1)} k9_career=${b.k9_career?.toFixed(1)} ` +
    `opp_adj=${b.adj_factor?.toFixed(3)} whiff=${b.savant_whiff?.toFixed(3) ?? 'n/a'} fbv=${b.savant_fbv ?? 'n/a'}`
  ).join('\n')

  const focusClause = focus
    ? `\n\nThe user specifically wants you to focus extra attention on: **${focus}**\n`
    : ''

  return `You are an expert sports betting modeler and statistician. I'm building a pre-game MLB strikeout over/under model that prices Kalshi KXMLBKS markets. Here is a complete description of the current approach, along with live bet data. Please critique the model, identify the most likely sources of mispricing, and give me 5-8 concrete, actionable improvements ranked by expected impact.

---

## MODEL OVERVIEW

**Goal:** Predict P(pitcher total Ks ≥ N) for a given starting pitcher on a given day, then compare to Kalshi market prices to find +EV edges.

**Distribution:** Negative Binomial with fixed dispersion r=30 (calibrated from ~4,255 MLB starts). NB is used instead of Poisson to allow for over-dispersion (high-K guys vary more than Poisson predicts).

**λ computation (three-way blend):**
The key parameter λ (expected total Ks for the start) is built as:
  k9 = (w_career × k9_career + w_season × k9_savant + w_l5 × k9_l5) / (w_career + w_season + w_l5)
  λ = (k9 / 9) × avg_ip × opp_adj_factor

Where:
- **k9_career** = weighted average K/9 across 2023-2025 seasons (weights: 2025=0.50, 2024=0.30, 2023=0.20), derived from Baseball Savant career K% × PA/IP × 9. Career data comes from internal historical_pitcher_stats table.
- **k9_savant** = 2026 season K/9 implied from Baseball Savant Statcast: savant_k_pct × league_PA_per_IP × 9. Updated daily from the Savant CSV leaderboard.
- **k9_l5** = last-5-starts K/9 from game logs in our DB (or career K/9 if no 2026 starts yet)
- **w_career** = max(0, 0.40 × (1 − ip_2026/40))  → starts at 40%, fades to 0 by 40 IP
- **w_season** = min(0.60, ip_2026/50)              → starts at 0%, grows to 60% by 50 IP
- **w_l5**     = 1 − w_career − w_season             → remainder, always ≥ 0
- **avg_ip** = career average IP/start (from historical table, default 5.2 if missing)

**Opponent adjustment:**
  opp_adj_factor = opp_team_k_pct / league_avg_k_pct (0.22)
  opp_team_k_pct = live 2026 team K% vs the pitcher's hand (R or L), platoon splits from MLB API
  This multiplicatively scales λ up or down based on how much the opposing lineup strikes out.

**Whiff signal (from Baseball Savant):**
  k_implied_from_whiff = savant_whiff_pct × (league_K_pct / league_whiff_pct) = savant_whiff × 0.88
  A "whiff_flag" fires if |k_implied_from_whiff - savant_k_pct| > 0.04 AND implied < savant (K% may regress down).

**In-game model (inGameEdge.js):**
  k9_live = (actual_Ks / IP) × 9
  k9_blended = min(0.75, IP/3) × k9_live + (1 - weight) × prior_k9
  TTO3 penalty: k9 × 0.85 once pitcher faces 18+ batters
  λ_remaining = k9_adj / 9 × ip_remaining
  P(total≥N) = P(remaining ≥ N − current_Ks) using same NB

**Edge filter:** Edge = model_prob − market_ask_price (for YES) or (1−model_prob) − market_ask_price (for NO). Flag if > 5¢.

---

## LIVE BET DATA

**Overall stats (settled bets only):**
  Total settled: ${stats.n} | Wins: ${stats.wins} | Win rate: ${wr}% | Total P&L: $${stats.total_pnl?.toFixed(2)} | Avg edge called: ${(stats.avg_edge*100).toFixed(1)}¢ | Avg model prob: ${(stats.avg_model_prob*100).toFixed(1)}% | Avg market price: ${(stats.avg_market_price*100).toFixed(1)}¢

**Settled bets (most recent 40):**
${settledRows || '(none yet)'}

**Top open bets today (not yet settled):**
${openRows}

---

## KEY OBSERVATIONS SO FAR

1. The biggest edge calls today are mostly **NO** bets at near-zero market prices (1-3¢), meaning Kalshi is pricing these outcomes as near-certain. When our model disagrees strongly, it implies the market may be systematically underpricing tail risk.
2. **Sonny Gray** was flagged strongly (λ=3.84 vs market implying ~7+ Ks) — he ended with 2 Ks in 2.2 IP. The career-weight anchor (k9_career=10.9) was dragging λ upward from his real 2026 K rate (k9_season=4.87, 12.5% K%). This was actually a model miss in the positive direction — the model still produced correct NO edges because the market was even MORE wrong.
3. **Jack Flaherty** was flagged for YES 6-10+ Ks (λ=6.31) — he got 3 Ks in 3.1 IP. Another case where the pitcher underperformed λ, but YES bets lost.
4. The **opponent adjustment** multiplier can swing ±40%+ depending on team K%. This is a major lever.
5. We are using avg_ip=5.2 as a fixed default when career avg_ip is unknown — this is probably wrong for many pitchers.
${focusClause}
---

## YOUR TASK

Given all of the above:

1. **Critique the model** — what are the 3 biggest structural weaknesses?
2. **Identify the most likely sources of systematic edge** — where is Kalshi mispricing these markets and why?
3. **Give 5-8 concrete improvements**, ranked by expected impact, each with:
   - What to change
   - Why it should help
   - How hard it is to implement (easy/medium/hard)
4. **Comment on the NB r=30 calibration** — is this a reasonable dispersion parameter for MLB starters?
5. **One big idea** we haven't thought of yet.

Be specific and quantitative where possible. Assume we have access to Baseball Savant, MLB Stats API, and our own historical game log DB.`
}

// ── Call OpenAI ────────────────────────────────────────────────────────────────

async function askGPT(prompt) {
  console.log(`[askChatGPT] Sending to ${GPT_MODEL}…\n`)
  const res = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: GPT_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.4,
      max_tokens: 2500,
    },
    {
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 60000,
    }
  )
  return res.data?.choices?.[0]?.message?.content || '(no response)'
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const ctx    = await loadContext()
  const prompt = buildPrompt(ctx, FOCUS)

  console.log('═══════════════════════════════════════════════════════')
  console.log(' KXMLBKS Model — ChatGPT Analysis Request')
  console.log(`═══════════════════════════════════════════════════════`)
  console.log(`  Settled bets in DB: ${ctx.stats.n}`)
  console.log(`  Open bets today:    ${ctx.open.length}`)
  console.log(`  Model: ${GPT_MODEL}`)
  if (FOCUS) console.log(`  Focus: ${FOCUS}`)
  console.log()

  const response = await askGPT(prompt)

  console.log('═══════════════════════════════════════════════════════')
  console.log(' GPT-4o Response:')
  console.log('═══════════════════════════════════════════════════════\n')
  console.log(response)
  console.log()
}

main().catch(err => {
  if (err.response?.data) {
    console.error('[askChatGPT] API error:', JSON.stringify(err.response.data, null, 2))
  } else {
    console.error('[askChatGPT] fatal:', err.message)
  }
  process.exit(1)
})
