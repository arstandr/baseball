// scripts/live/eodReport.js — End-of-day intelligent report card.
//
// Queries today's settled bets + rolling model stats, calls Claude to generate
// a plain-English analysis (what worked, what didn't, what to adjust tomorrow),
// then posts it to Discord.
//
// Usage:
//   node scripts/live/eodReport.js [--date YYYY-MM-DD]
//
// Run after ksBets.js settle completes.

import 'dotenv/config'
import Anthropic from '@anthropic-ai/sdk'
import * as db from '../../lib/db.js'
import axios from 'axios'

const args   = process.argv.slice(2)
const dateArg = args.includes('--date') ? args[args.indexOf('--date') + 1] : null
const TODAY  = dateArg || new Date().toISOString().slice(0, 10)

const WEBHOOK = process.env.DISCORD_WEBHOOK_URL
const client  = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// ── helpers ───────────────────────────────────────────────────────────────────

function pnlSign(n) {
  return n >= 0 ? `+$${Math.abs(n).toFixed(2)}` : `-$${Math.abs(n).toFixed(2)}`
}

async function send(payload) {
  if (!WEBHOOK) { console.log('[eod] No Discord webhook — skipping'); return }
  try {
    await axios.post(WEBHOOK, payload, { timeout: 8000 })
  } catch (err) {
    console.warn('[eod] Discord send failed:', err.message)
  }
}

// ── data assembly ─────────────────────────────────────────────────────────────

async function gatherData() {
  await db.migrate()

  // Today's bets (all, including unsettled)
  const todayBets = await db.all(
    `SELECT * FROM ks_bets WHERE bet_date = ? ORDER BY edge DESC`,
    [TODAY],
  )

  // Last 30 days settled — for rolling stats
  const rollingBets = await db.all(
    `SELECT * FROM ks_bets WHERE result IS NOT NULL AND bet_date >= date(?, '-30 days') ORDER BY bet_date DESC`,
    [TODAY],
  )

  // Per-pitcher performance last 30 days
  const pitcherStats = await db.all(
    `SELECT pitcher_name,
            COUNT(*) as bets,
            SUM(CASE WHEN result='win' THEN 1 ELSE 0 END) as wins,
            SUM(pnl) as pnl,
            AVG(edge) as avg_edge,
            AVG(CASE WHEN result IS NOT NULL THEN ABS(actual_ks - strike) END) as avg_lambda_err
     FROM ks_bets
     WHERE result IS NOT NULL AND bet_date >= date(?, '-30 days')
     GROUP BY pitcher_name
     HAVING bets >= 2
     ORDER BY pnl DESC`,
    [TODAY],
  )

  // Side performance
  const sideStats = await db.all(
    `SELECT side,
            COUNT(*) as bets,
            SUM(CASE WHEN result='win' THEN 1 ELSE 0 END) as wins,
            SUM(pnl) as pnl,
            AVG(edge) as avg_edge
     FROM ks_bets
     WHERE result IS NOT NULL AND bet_date >= date(?, '-30 days')
     GROUP BY side`,
    [TODAY],
  )

  // Edge bucket performance (are bigger edges actually winning more?)
  const edgeBuckets = await db.all(
    `SELECT
       CASE
         WHEN edge < 0.06 THEN '5-6¢'
         WHEN edge < 0.08 THEN '6-8¢'
         WHEN edge < 0.10 THEN '8-10¢'
         ELSE '10¢+'
       END as bucket,
       COUNT(*) as bets,
       SUM(CASE WHEN result='win' THEN 1 ELSE 0 END) as wins,
       SUM(pnl) as pnl,
       AVG(edge) as avg_edge
     FROM ks_bets
     WHERE result IS NOT NULL AND bet_date >= date(?, '-30 days')
     GROUP BY bucket
     ORDER BY avg_edge`,
    [TODAY],
  )

  // Confidence level performance
  const confStats = await db.all(
    `SELECT
       CASE
         WHEN confidence LIKE '%high%' THEN 'high'
         WHEN confidence LIKE '%medium%' THEN 'medium'
         ELSE 'low'
       END as conf_level,
       COUNT(*) as bets,
       SUM(CASE WHEN result='win' THEN 1 ELSE 0 END) as wins,
       SUM(pnl) as pnl
     FROM ks_bets
     WHERE result IS NOT NULL AND bet_date >= date(?, '-30 days')
     GROUP BY conf_level`,
    [TODAY],
  )

  return { todayBets, rollingBets, pitcherStats, sideStats, edgeBuckets, confStats }
}

// ── Claude analysis ───────────────────────────────────────────────────────────

async function analyzeWithClaude(data) {
  const { todayBets, rollingBets, pitcherStats, sideStats, edgeBuckets, confStats } = data

  const todaySettled = todayBets.filter(b => b.result != null)
  const todayWins    = todaySettled.filter(b => b.result === 'win')
  const todayPnl     = todaySettled.reduce((s, b) => s + (b.pnl || 0), 0)

  const seasonW      = rollingBets.filter(b => b.result === 'win').length
  const seasonL      = rollingBets.filter(b => b.result === 'loss').length
  const seasonPnl    = rollingBets.reduce((s, b) => s + (b.pnl || 0), 0)
  const seasonWagered = rollingBets.reduce((s, b) => s + (b.bet_size || 0), 0)

  const prompt = `You are the analyst for a baseball strikeout prop betting system called Money Tree 2.0.

Today is ${TODAY}. Here is today's betting summary and 30-day rolling performance data.

## TODAY (${TODAY})
${todaySettled.length === 0 ? 'No settled bets today.' : todaySettled.map(b =>
  `- ${b.pitcher_name} ${b.strike}+ Ks ${b.side} @ ${b.market_mid}¢: ${b.result.toUpperCase()} (actual: ${b.actual_ks}K, model: ${(b.model_prob*100).toFixed(0)}%, edge: ${(b.edge*100).toFixed(1)}¢, bet: $${b.bet_size}, P&L: ${pnlSign(b.pnl)})`
).join('\n')}

Today: ${todayWins.length}W / ${todaySettled.length - todayWins.length}L  ${pnlSign(todayPnl)}
${todayBets.filter(b => !b.result).length > 0 ? `Unsettled: ${todayBets.filter(b => !b.result).length} bets still pending` : ''}

## 30-DAY ROLLING (${seasonW}W / ${seasonL}L)
P&L: ${pnlSign(seasonPnl)}  |  Win rate: ${((seasonW/(seasonW+seasonL))*100).toFixed(1)}%  |  ROI: ${seasonWagered > 0 ? ((seasonPnl/seasonWagered)*100).toFixed(1) : 'n/a'}%

## EDGE BUCKET PERFORMANCE (30 days)
${edgeBuckets.map(b => `- ${b.bucket}: ${b.wins}W/${b.bets - b.wins}L (${((b.wins/b.bets)*100).toFixed(0)}% WR)  ${pnlSign(b.pnl)}`).join('\n')}

## CONFIDENCE LEVEL PERFORMANCE (30 days)
${confStats.map(c => `- ${c.conf_level}: ${c.wins}W/${c.bets - c.wins}L (${((c.wins/c.bets)*100).toFixed(0)}% WR)  ${pnlSign(c.pnl)}`).join('\n')}

## SIDE PERFORMANCE (30 days)
${sideStats.map(s => `- ${s.side}: ${s.wins}W/${s.bets - s.wins}L (${((s.wins/s.bets)*100).toFixed(0)}% WR)  avg edge ${(s.avg_edge*100).toFixed(1)}¢  ${pnlSign(s.pnl)}`).join('\n')}

## TOP PITCHERS BY P&L (30 days, 2+ bets)
${pitcherStats.slice(0, 8).map(p => `- ${p.pitcher_name}: ${p.wins}W/${p.bets - p.wins}L  ${pnlSign(p.pnl)}  avg edge ${(p.avg_edge*100).toFixed(1)}¢`).join('\n')}

## WORST PITCHERS BY P&L (30 days, 2+ bets)
${[...pitcherStats].sort((a,b) => a.pnl - b.pnl).slice(0, 5).map(p => `- ${p.pitcher_name}: ${p.wins}W/${p.bets - p.wins}L  ${pnlSign(p.pnl)}  avg edge ${(p.avg_edge*100).toFixed(1)}¢`).join('\n')}

---

Write a concise end-of-day report in three sections using plain text (no markdown headers, no bullet points — use short paragraphs):

1. **WHAT WORKED TODAY**: What did the model get right? Which bets/pitchers hit and why the model's edge was justified. If nothing hit, say so honestly.

2. **WHAT DIDN'T WORK**: Be specific. Which bets missed, what the model predicted vs what happened, and any patterns in the misses (e.g. was it always the high-threshold bets, always NO bets, always specific pitcher types).

3. **TOMORROW'S ADJUSTMENTS**: Based on today AND the 30-day trends, what is one concrete thing to watch or adjust? Don't suggest vague things like "be more selective" — be specific (e.g. "YES bets at 8¢+ edge are at 62% WR vs 41% for 5-6¢, consider raising the threshold", or "we're 3-9 on NO bets, check if the NO pricing model needs recalibration").

Keep it under 200 words total. Be direct, like a quant analyst talking to a trader.`

  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 400,
    messages: [{ role: 'user', content: prompt }],
  })

  return msg.content[0].text
}

// ── Discord post ──────────────────────────────────────────────────────────────

async function postReport(data, analysis) {
  const { todayBets, rollingBets } = data

  const todaySettled = todayBets.filter(b => b.result != null)
  const todayWins    = todaySettled.filter(b => b.result === 'win')
  const todayPnl     = todaySettled.reduce((s, b) => s + (b.pnl || 0), 0)
  const seasonPnl    = rollingBets.reduce((s, b) => s + (b.pnl || 0), 0)
  const seasonW      = rollingBets.filter(b => b.result === 'win').length
  const seasonL      = rollingBets.filter(b => b.result === 'loss').length

  const betLines = todaySettled.map(b => {
    const icon = b.result === 'win' ? '✅' : '❌'
    return `${icon} ${b.pitcher_name} ${b.strike}+ ${b.side}  ${b.actual_ks}K  ${pnlSign(b.pnl)}`
  }).join('\n') || 'No settled bets.'

  const color = todayPnl >= 0 ? 0x2ecc71 : 0xe74c3c

  await send({
    embeds: [
      {
        title: `📊 ${TODAY} — End of Day`,
        description: betLines,
        color,
        fields: [
          {
            name: 'Today',
            value: `${todayWins.length}W / ${todaySettled.length - todayWins.length}L  **${pnlSign(todayPnl)}**`,
            inline: true,
          },
          {
            name: '30-Day',
            value: `${seasonW}W / ${seasonL}L  **${pnlSign(seasonPnl)}**`,
            inline: true,
          },
        ],
      },
      {
        title: '🤖 Model Analysis',
        description: analysis,
        color: 0x3498db,
        footer: { text: 'Money Tree 2.0 · claude-haiku-4-5' },
      },
    ],
  })

  console.log('[eod] Report posted to Discord.')
  console.log('\n── Analysis ──\n' + analysis)
}

// ── main ──────────────────────────────────────────────────────────────────────

try {
  console.log(`[eod] Generating end-of-day report for ${TODAY}…`)
  const data     = await gatherData()
  const analysis = await analyzeWithClaude(data)
  await postReport(data, analysis)
  await db.close()
} catch (err) {
  console.error('[eod] Error:', err.message)
  process.exit(1)
}
