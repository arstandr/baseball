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

const FALLBACK_WEBHOOK = process.env.DISCORD_WEBHOOK_URL ||
  'https://discord.com/api/webhooks/1495964427382558740/e6Q7pZPQWSjghWSx9XYYeXWBVXIFV1kPvSG-lmE9YSDiRbnaABSLCvYTUUNLE_Feer6W'

// Send payload to one or more webhook URLs
async function send(payload, webhooks) {
  const urls = webhooks?.length ? webhooks : [FALLBACK_WEBHOOK]
  await Promise.all(urls.filter(Boolean).map(url =>
    axios.post(url, payload, { timeout: 8000 }).catch(() => {})
  ))
}

// Helper — fetch all active bettors' discord webhooks from DB
export async function getAllWebhooks(db) {
  try {
    const rows = await db.all(`SELECT discord_webhook FROM users WHERE active_bettor = 1 AND discord_webhook IS NOT NULL AND discord_webhook != ''`)
    return rows.map(r => r.discord_webhook)
  } catch { return [] }
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

export async function notifyEdges(edges, date, webhooks) {
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
  }, webhooks)
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

export async function notifyLineupRefresh(changes, date, webhooks) {
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
  }, webhooks)
}

// ── Live in-game bet ──────────────────────────────────────────────────────────

export async function notifyLiveBet({ pitcherName, strike, side, marketMid, edge, betSize, currentKs, currentIPraw, currentPitches, paper, betMode }, webhooks) {
  const liveTag  = paper ? '[PAPER]' : '[LIVE]'
  const isDead   = betMode === 'dead-path'
  const icon     = isDead ? '🔒' : '⚡'
  const modeDesc = isDead ? 'Dead-path NO' : `Live ${side}`
  const sideDesc = side === 'YES' ? `hit ${strike}+` : `stay under ${strike}+`
  await send({
    embeds: [{
      title:       `${icon} ${liveTag} In-game bet — ${pitcherName}`,
      description:
        `**${pitcherName}** ${strike}+ Ks · **${modeDesc}** @ ${marketMid.toFixed(0)}¢\n` +
        `Edge +${(edge*100).toFixed(1)}¢  ·  Bet $${betSize.toFixed(0)}\n` +
        `${currentKs}K · ${currentIPraw}IP · ${currentPitches}p · betting ${sideDesc}`,
      color: paper ? 0x95a5a6 : (isDead ? 0x3498db : 0xe74c3c),
    }],
  }, webhooks)
}

// ── Free money alert (pitcher pulled, outcome determined, stale market) ───────

export async function notifyFreeMoney({ pitcherName, strike, currentKs, yesPrice, contracts, initFilled, askCents, expectedProfit, game, paper }, webhooks) {
  const mode     = paper ? '[PAPER]' : '[LIVE]'
  const filled   = initFilled ?? contracts
  const fillLine = filled >= contracts
    ? `Filled **${filled}/${contracts}** contracts immediately`
    : filled > 0
      ? `⚠️ Partial fill — **${filled}/${contracts}** contracts (order resting for remainder)`
      : `⚠️ No immediate fill — order placed but resting (0/${contracts} contracts filled)`
  await send({
    embeds: [{
      title: `💰 FREE MONEY ${mode} — ${pitcherName}`,
      description:
        `**${pitcherName}** pulled with **${currentKs}K** — can't reach **${strike}+**\n` +
        `Kalshi still showing YES @ **${yesPrice}¢** — market hasn't repriced yet\n\n` +
        `Buying **${contracts} NO contracts @ ${askCents}¢**\n` +
        `${fillLine}\n` +
        `Expected profit: **+$${expectedProfit.toFixed(2)}**  |  ${game}`,
      color: paper ? 0x27ae60 : 0x00ff88,
      footer: { text: 'Taker order — outcome structurally determined' },
    }],
  }, webhooks)
}

// ── Crossed-YES alert (threshold already hit, Kalshi market lagged on YES) ────

export async function notifyCrossedYes({ pitcherName, strike, currentKs, yesAskCents, contracts, initFilled, expectedProfit, game, paper }, webhooks) {
  const mode     = paper ? '[PAPER]' : '[LIVE]'
  const filled   = initFilled ?? contracts
  const fillLine = filled >= contracts
    ? `Filled **${filled}/${contracts}** contracts immediately`
    : filled > 0
      ? `⚠️ Partial fill — **${filled}/${contracts}** contracts (order resting for remainder)`
      : `⚠️ No immediate fill — order placed but resting (0/${contracts} contracts filled)`
  await send({
    embeds: [{
      title: `🟢 CROSSED-YES ${mode} — ${pitcherName}`,
      description:
        `**${pitcherName}** already has **${currentKs}K** — threshold **${strike}+** is crossed\n` +
        `Kalshi YES still asking **${yesAskCents}¢** — market hasn't repriced yet\n\n` +
        `Buying **${contracts} YES contracts @ ${yesAskCents}¢**\n` +
        `${fillLine}\n` +
        `Expected profit: **+$${expectedProfit.toFixed(2)}**  |  ${game}`,
      color: paper ? 0x27ae60 : 0x00ff88,
      footer: { text: 'Taker order — outcome structurally determined (YES)' },
    }],
  }, webhooks)
}

// ── Blowout alert (large deficit late in game, pull structurally likely) ───────

export async function notifyBlowout({ pitcherName, strike, currentKs, scoreDiff, currentInn, contracts, initFilled, askCents, expectedProfit, game, paper }, webhooks) {
  const mode     = paper ? '[PAPER]' : '[LIVE]'
  const diffStr  = scoreDiff < 0 ? `down ${Math.abs(scoreDiff)}` : `up ${scoreDiff}`
  const filled   = initFilled ?? contracts
  const fillLine = filled >= contracts
    ? `Filled **${filled}/${contracts}** contracts immediately`
    : filled > 0
      ? `⚠️ Partial fill — **${filled}/${contracts}** contracts (order resting for remainder)`
      : `⚠️ No immediate fill — order placed but resting (0/${contracts} contracts filled)`
  await send({
    embeds: [{
      title: `🏳️ BLOWOUT ${mode} — ${pitcherName}`,
      description:
        `**${pitcherName}** in blowout (${diffStr} runs, inning ${currentInn}) — pull likely\n` +
        `${currentKs}K so far, needs **${strike - currentKs} more** to cover **${strike}+** — structurally unlikely\n\n` +
        `Buying **${contracts} NO contracts @ ${askCents}¢**\n` +
        `${fillLine}\n` +
        `Expected profit: **+$${expectedProfit.toFixed(2)}**  |  ${game}`,
      color: paper ? 0x27ae60 : 0x00ff88,
      footer: { text: 'Taker order — blowout structural edge' },
    }],
  }, webhooks)
}

// ── Pull-hedge alert (portfolio insurance on losing YES position) ─────────────

export async function notifyHedge({ pitcherName, strike, currentKs, currentIPraw, currentInning,
  yesContracts, yesFillCents, hedgeContracts, hedgeAskCents, hedgeCost, game, paper }, webhooks) {
  const mode       = paper ? '[PAPER]' : '[LIVE]'
  const yesLoss    = yesContracts * (yesFillCents / 100)
  const hedgeProfit = hedgeContracts * ((100 - hedgeAskCents) / 100) * 0.93
  const offsetPct  = yesLoss > 0 ? Math.min(100, Math.round((hedgeProfit / yesLoss) * 100)) : 0
  await send({
    embeds: [{
      title: `🛡️ HEDGE ${mode} — ${pitcherName}`,
      description:
        `**Losing wager:** ${yesContracts}c YES @ ${yesFillCents}¢ = **$${yesLoss.toFixed(2)} at risk**\n` +
        `**Why losing:** ${pitcherName} pulled at **${currentKs}K / ${currentIPraw}IP** (inn ${currentInning}) — can't reach ${strike}+\n\n` +
        `**Hedge:** Bought **${hedgeContracts} NO contracts @ ${hedgeAskCents}¢** = $${hedgeCost.toFixed(2)} cost\n` +
        `**Offsets:** ~**$${hedgeProfit.toFixed(2)}** profit if NO wins — covers **${offsetPct}%** of YES loss\n` +
        `${game}`,
      color: paper ? 0x95a5a6 : 0xf39c12,
      footer: { text: 'Hedge confirmed — Kalshi fill received' },
    }],
  }, webhooks)
}

// ── Scratch alert (pre-game scratch detected, open YES positions hedged) ───────

export async function notifyScratch({ pitcherName, game, marketCount, paper }, webhooks) {
  const mode = paper ? '[PAPER]' : '[LIVE]'
  await send({
    embeds: [{
      title: `🚫 SCRATCH ${mode} — ${pitcherName}`,
      description:
        `**${pitcherName}** scratched — never appeared in the game\n` +
        `${marketCount} open YES position${marketCount !== 1 ? 's' : ''} being hedged with NO takers\n` +
        `${game}`,
      color: paper ? 0x95a5a6 : 0xe67e22,
      footer: { text: 'Scratch confirmed — 2-poll pattern, reliever on mound' },
    }],
  }, webhooks)
}

// ── K-delta alert (per-K updates after we hold a live position) ───────────────
// Fires every time the strikeout count changes for a pitcher we have live exposure on.

export async function notifyKDelta({ pitcherName, prevKs, currentKs, currentIPraw, currentPitches, currentInning, openStrikes, coveredStrikes, game }, webhooks) {
  const arrow = `${prevKs}→${currentKs}K`
  const inn   = currentInning ? `${currentInning} · ` : ''
  const lines = []
  if (coveredStrikes?.length) lines.push(`✅ Covered: ${coveredStrikes.map(s => `${s}+`).join(', ')}`)
  if (openStrikes?.length)    lines.push(`⏳ Still open: ${openStrikes.map(s => `${s}+`).join(', ')}`)
  await send({
    embeds: [{
      title: `⚡ ${pitcherName} ${arrow}`,
      description:
        `${inn}${currentIPraw ?? '?'}IP · ${currentPitches ?? '?'} pitches\n` +
        `${game ?? ''}` +
        (lines.length ? `\n${lines.join('  |  ')}` : ''),
      color: 0x3498db,
    }],
  }, webhooks)
}

// ── One away alert ────────────────────────────────────────────────────────────

export async function notifyOneAway({ pitcherName, strike, pnl, currentKs, game }, webhooks) {
  await send({
    embeds: [{
      title: `🔥 ONE AWAY`,
      description:
        `**${pitcherName}** has **${currentKs}K** — needs just **1 more** to cover ${strike}+ YES\n` +
        `${game}  |  Worth **+${pnlSign(pnl)}** if he gets it`,
      color: 0xf39c12,
    }],
  }, webhooks)
}

// ── Cover alert ───────────────────────────────────────────────────────────────

export async function notifyCovered({ pitcherName, strike, side, pnl, currentKs, game }, webhooks) {
  await send({
    embeds: [{
      title: `✅ COVERED`,
      description:
        `**${pitcherName}** hit **${currentKs}K** (needed ${strike}+)\n` +
        `${game}  |  ${side} bet  |  **${pnlSign(pnl)} locked**`,
      color: 0x2ecc71,
    }],
  }, webhooks)
}

// ── Dead bet alert ────────────────────────────────────────────────────────────

export async function notifyDead({ pitcherName, strike, side, pnl, currentKs, currentIPraw, game, reason }, webhooks) {
  await send({
    embeds: [{
      title: `❌ DEAD`,
      description:
        `**${pitcherName}** done at **${currentKs}K** / ${currentIPraw}IP\n` +
        `Needed ${strike}+ ${side}  |  ${reason || 'starter pulled'}  |  **${pnlSign(pnl)}**\n` +
        `${game}`,
      color: 0xe74c3c,
    }],
  }, webhooks)
}

// ── Per-game result ───────────────────────────────────────────────────────────

export async function notifyGameResult({ game, bets, gamePnl }, webhooks) {
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
  }, webhooks)
}

// ── Generic alert ────────────────────────────────────────────────────────────

export async function notifyAlert({ title, description, color = 0xe74c3c }, webhooks) {
  await send({ embeds: [{ title, description, color }] }, webhooks)
}

// ── Preflight skip / boost ────────────────────────────────────────────────────

// Dedup posts to once-per-pitcher-per-action-per-day. Each pitcher has multiple
// bet_schedule rows (one per strike threshold) and the scheduler can re-evaluate
// on retries — without this, the same pitcher's ADVANTAGE/SKIPPED can fire 3+
// times per day. Keyed by ET date so the set self-resets at midnight; restart
// also clears it. Memory growth is bounded (≤ ~30 pitchers × 2 actions per day).
const _preflightAlertsToday = new Set()
function _etDateForDedup() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
}

export async function notifyPreflightResult({ pitcherName, action, reason, game, sources }, webhooks) {
  if (action === 'proceed') return  // no noise for routine proceeds

  const dedupKey = `${_etDateForDedup()}|${pitcherName}|${action}`
  if (_preflightAlertsToday.has(dedupKey)) return
  _preflightAlertsToday.add(dedupKey)

  const isSkip     = action === 'skip'
  const sourceBlock = sources?.length
    ? '\n\n**Found:**\n' + sources.slice(0, 3).map(s => `• ${s}`).join('\n')
    : ''
  await send({
    embeds: [{
      title:       isSkip ? `🚫 SKIPPED — ${pitcherName}` : `⚡ ADVANTAGE — ${pitcherName}`,
      description: `${game}\n${reason}${sourceBlock}`,
      color:       isSkip ? 0xe74c3c : 0xa78bfa,
    }],
  }, webhooks)
}

// ── End-of-day report card ────────────────────────────────────────────────────

export async function notifyDailyReport({ date, bets, dayPnl, seasonPnl, seasonW, seasonL, totalWagered }, webhooks) {
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
  }, webhooks)
}

// ── DraftKings parlay alerts ──────────────────────────────────────────────────

export async function notifyParlay(parlay, webhooks) {
  if (!parlay?.legs?.length) return
  const nums    = ['①', '②', '③']
  const legLines = parlay.legs.map((l, i) => {
    const prop = l.dkLine ? `OVER ${l.dkLine} Ks` : `YES ${l.strike}+ Ks`
    const odds = l.dkOdds ? `  **${l.dkOdds}**` : ''
    const bk   = l.book && l.book !== 'draftkings' ? ` _(${l.book})_` : ''
    return `${nums[i]} **${l.pitcherName}** — ${prop}${odds}${bk}  _model ${Math.round(l.modelProb * 100)}%_`
  })
  const hitPct  = `${Math.round(parlay.combinedProb * 100)}%`
  const oddsStr = parlay.parlayOdds ? `2-leg payout: **${parlay.parlayOdds}**` : 'Check DK for combined odds'
  await send({
    embeds: [{
      title:       '🎲 PARLAY — Model Lock',
      description: legLines.join('\n') + `\n\n${oddsStr}`,
      color:       0x9b59b6,
      footer:      { text: `Hit probability: ${hitPct} · Place manually on DraftKings · ${parlay.date}` },
    }],
  }, webhooks)
}

export async function notifyCertaintyParlay(parlay, webhooks) {
  if (!parlay?.legs?.length) return
  const nums     = ['①', '②', '③']
  const legLines = parlay.legs.map((l, i) =>
    `${nums[i]} **${l.pitcherName}** ${l.strike}+ Ks — already has **${l.currentKs} Ks** ✅`
  )
  await send({
    embeds: [{
      title:       '🔒 CERTAINTY PARLAY — Place Now',
      description: legLines.join('\n') + '\n\n⚡ Both thresholds already hit — place on DK immediately before settlement.',
      color:       0x1abc9c,
      footer:      { text: `~${Math.round(parlay.combinedProb * 100)}% combined hit probability · DraftKings` },
    }],
  }, webhooks)
}

// ── Live-cage critical / silent alerts ────────────────────────────────────────
// Implementations live in lib/cageAlerts.js; re-exported here so consumers that
// already use lib/discord.js as their notification hub pick them up without an
// extra import. See lib/cageAlerts.js for full docs and ALERT_LEVELS.
export {
  ALERT_LEVELS,
  postWebhook,
  alertHalt,
  alertReconciliationMismatch,
  alertTraceOrphan,
  alertCommitMismatch,
  alertHeartbeatLost,
  notifyFire,
  notifyEod,
  notifyHeartbeatOk,
} from './cageAlerts.js'
