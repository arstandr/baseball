// lib/discord.js — Discord webhook notifications for MLBIE
//
// Sends alerts to a configured Discord webhook. All functions are fire-and-forget
// (non-blocking) so a Discord failure never breaks the trading pipeline.
//
// Message types:
//   notifyEdges(edges)          — morning edge picks (one embed per pick)
//   notifyLineupRefresh(edges)  — lineup refresh with changed edges
//   notifyLiveBet(bet)          — live in-game paper/real bet placed
//   notifyCovered(bet)          — bet covered mid-game
//   notifyDead(bet)             — bet dead (starter pulled, can't hit threshold)
//   notifyGameResult(game)      — per-game P&L when game goes Final
//   notifyDailyReport(stats)    — end-of-night report card

import axios from 'axios'
import 'dotenv/config'

const WEBHOOK = process.env.DISCORD_WEBHOOK_URL ||
  'https://discord.com/api/webhooks/1495964427382558740/e6Q7pZPQWSjghWSx9XYYeXWBVXIFV1kPvSG-lmE9YSDiRbnaABSLCvYTUUNLE_Feer6W'

async function send(payload) {
  if (!WEBHOOK) return
  try {
    await axios.post(WEBHOOK, payload, { timeout: 8000 })
  } catch { /* never block trading on Discord failure */ }
}

function edgeLine(e) {
  const conf = e.confidence?.includes('high') ? '🔥' : e.confidence?.includes('medium') ? '⚡' : '•'
  const whiff = e.whiff_flag ? ' ⚑' : ''
  return `${conf} **${e.pitcher}** ${e.strike}+ Ks **${e.side}** @ ${e.market_mid?.toFixed(0) ?? '?'}¢  edge +${(e.edge * 100).toFixed(1)}¢  bet $${e.bet_size ?? 100}${whiff}`
}

function pnlSign(n) {
  return n >= 0 ? `+$${n.toFixed(2)}` : `-$${Math.abs(n).toFixed(2)}`
}

// ── Morning edge picks ────────────────────────────────────────────────────────

export async function notifyEdges(edges, date) {
  if (!edges.length) return

  const lines = edges.map(e => {
    const why = buildWhy(e)
    return `${edgeLine(e)}\n↳ ${why}`
  })

  await send({
    embeds: [{
      title: `🎯 MLBIE Picks — ${date}`,
      description: lines.join('\n\n'),
      color: 0x2ecc71,
      footer: { text: `${edges.length} edges | min edge ${(Math.min(...edges.map(e => e.edge)) * 100).toFixed(1)}¢` },
    }],
  })
}

function buildWhy(e) {
  const parts = []
  if (e.k9_l5)    parts.push(`L5 avg ${e.k9_l5.toFixed(1)} K/9`)
  if (e.k9_season) parts.push(`season ${e.k9_season.toFixed(1)} K/9`)
  if (e.opp_k_pct) parts.push(`opp K% ${(e.opp_k_pct * 100).toFixed(1)}%`)
  if (e.savant_whiff) parts.push(`whiff ${(e.savant_whiff * 100).toFixed(1)}%`)
  if (e.leash_flag) parts.push(`⚠️ leash (<85p avg)`)
  return parts.join(' · ') || 'model edge'
}

// ── Lineup refresh ────────────────────────────────────────────────────────────

export async function notifyLineupRefresh(changes, date) {
  if (!changes.length) return

  const lines = changes.map(c => {
    const dir = c.newEdge > c.oldEdge ? '📈' : '📉'
    return `${dir} **${c.pitcher}** ${c.strike}+ ${c.side}  edge ${(c.oldEdge*100).toFixed(1)}¢ → ${(c.newEdge*100).toFixed(1)}¢  lineup K% ${(c.lineupKpct*100).toFixed(1)}%`
  })

  await send({
    embeds: [{
      title: `🔄 Lineup Refresh — ${date}`,
      description: lines.join('\n'),
      color: 0x3498db,
    }],
  })
}

// ── Live in-game bet ──────────────────────────────────────────────────────────

export async function notifyLiveBet({ pitcherName, strike, side, marketMid, edge, betSize, currentKs, currentIPraw, currentPitches, paper }) {
  const mode = paper ? '[PAPER]' : '[LIVE]'
  await send({
    embeds: [{
      title: `⚡ ${mode} Live Signal`,
      description:
        `**${pitcherName}** ${strike}+ Ks **${side}** @ ${marketMid.toFixed(0)}¢\n` +
        `Edge +${(edge*100).toFixed(1)}¢  |  Bet $${betSize}\n` +
        `Currently: ${currentKs}K · ${currentIPraw}IP · ${currentPitches}p`,
      color: paper ? 0x95a5a6 : 0xe74c3c,
    }],
  })
}

// ── Cover alert ───────────────────────────────────────────────────────────────

export async function notifyCovered({ pitcherName, strike, side, pnl, currentKs, game }) {
  await send({
    embeds: [{
      title: `✅ COVERED`,
      description:
        `**${pitcherName}** hit **${currentKs}K** (needed ${strike}+)\n` +
        `${game}  |  ${side} bet  |  **${pnlSign(pnl)} locked**`,
      color: 0x2ecc71,
    }],
  })
}

// ── Dead bet alert ────────────────────────────────────────────────────────────

export async function notifyDead({ pitcherName, strike, side, pnl, currentKs, currentIPraw, game, reason }) {
  await send({
    embeds: [{
      title: `❌ DEAD`,
      description:
        `**${pitcherName}** done at **${currentKs}K** / ${currentIPraw}IP\n` +
        `Needed ${strike}+ ${side}  |  ${reason || 'starter pulled'}  |  **${pnlSign(pnl)}**\n` +
        `${game}`,
      color: 0xe74c3c,
    }],
  })
}

// ── Per-game result ───────────────────────────────────────────────────────────

export async function notifyGameResult({ game, bets, gamePnl }) {
  const lines = bets.map(b => {
    const icon = b.result === 'win' ? '✅' : '❌'
    return `${icon} ${b.pitcher_name} ${b.strike}+ ${b.side}  actual ${b.actual_ks}K  ${pnlSign(b.pnl)}`
  })

  await send({
    embeds: [{
      title: `📋 ${game} — Final`,
      description: lines.join('\n') + `\n\n**Game P&L: ${pnlSign(gamePnl)}**`,
      color: gamePnl >= 0 ? 0x2ecc71 : 0xe74c3c,
    }],
  })
}

// ── End-of-day report card ────────────────────────────────────────────────────

export async function notifyDailyReport({ date, bets, dayPnl, seasonPnl, seasonW, seasonL, totalWagered }) {
  const settled = bets.filter(b => b.result != null)
  const wins = settled.filter(b => b.result === 'win')

  const lines = settled.map(b => {
    const icon = b.result === 'win' ? '✅' : '❌'
    return `${icon} ${b.pitcher_name} ${b.strike}+  ${b.actual_ks}K  ${pnlSign(b.pnl)}`
  })

  const roi = totalWagered > 0 ? ((seasonPnl / totalWagered) * 100).toFixed(1) : '0.0'

  await send({
    embeds: [{
      title: `📊 ${date} Report Card`,
      description:
        lines.join('\n') +
        `\n\n**Today: ${wins.length}W/${settled.length - wins.length}L  ${pnlSign(dayPnl)}**\n` +
        `Season: ${seasonW}W/${seasonL}L  ${pnlSign(seasonPnl)}  ROI ${roi}%`,
      color: dayPnl >= 0 ? 0x2ecc71 : 0xe74c3c,
      footer: { text: `$${totalWagered.toFixed(0)} total wagered season` },
    }],
  })
}
