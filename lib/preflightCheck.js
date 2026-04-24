// lib/preflightCheck.js — Pre-bet intelligence check for scheduled K-market bets.
//
// Runs right before firePendingBets() places a bet (~T-2.5h).
// Pulls three data signals in parallel, feeds them to Claude Haiku,
// and returns: { action: 'proceed'|'skip'|'boost', reason, confidence }
//
// Data sources:
//   1. MLB API — confirm pitcher is still the probable starter
//   2. MLB API — last 5 game-log starts (K trend)
//   3. ESPN MLB news feed — filter for pitcher name mentions (last 48h)
//   4. MLB API — check for IL transactions (today ± 2 days)

import { fetch as httpFetch } from './http.js'
import { scoutKMarket } from './claude.js'

// ── 1. Probable pitcher check ─────────────────────────────────────────────────

async function checkCurrentProbable(pitcherId, gameId) {
  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&gamePk=${gameId}&hydrate=probablePitcher`
  const res = await httpFetch('preflight.probable', { method: 'GET', url })
  if (!res.ok) return { changed: false, detail: 'api_unavailable' }
  const game = res.data?.dates?.[0]?.games?.[0]
  if (!game) return { changed: false, detail: 'game_not_found' }
  const pid = String(pitcherId)
  const homeProb = String(game.teams?.home?.probablePitcher?.id ?? '')
  const awayProb = String(game.teams?.away?.probablePitcher?.id ?? '')
  return { changed: homeProb !== pid && awayProb !== pid }
}

// ── 2. Recent K trend (last 5 starts via MLB Stats API game log) ──────────────

async function getRecentKTrend(pitcherId) {
  const url = `https://statsapi.mlb.com/api/v1/people/${pitcherId}/stats?stats=gameLog&season=2026&group=pitching`
  const res = await httpFetch('preflight.gamelog', { method: 'GET', url })
  if (!res.ok) return null
  const splits = res.data?.stats?.[0]?.splits || []
  if (!splits.length) return null
  const last5 = splits.slice(-5).map(s => ({
    date:    s.date,
    ks:      s.stat?.strikeOuts ?? 0,
    ip:      s.stat?.inningsPitched ?? '0.0',
    pitches: s.stat?.numberOfPitches ?? null,
  }))
  const avgK = last5.reduce((sum, g) => sum + g.ks, 0) / last5.length
  return {
    last5,
    avgK:    Math.round(avgK * 10) / 10,
    summary: `Last ${last5.length} starts: ${last5.map(g => g.ks + 'K').join(', ')} (avg ${Math.round(avgK * 10) / 10}K)`,
  }
}

// ── 3. ESPN MLB news (last 48h, filtered for pitcher name) ────────────────────

async function fetchESPNNews(pitcherName) {
  const url = 'https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/news?limit=100'
  const res = await httpFetch('preflight.espn', { method: 'GET', url })
  if (!res.ok) return []

  const cutoff = Date.now() - 48 * 60 * 60 * 1000
  const articles = res.data?.articles || []
  const nameParts = pitcherName.toLowerCase().split(' ')

  return articles
    .filter(a => {
      const published = new Date(a.published || a.lastModified || 0).getTime()
      if (published < cutoff) return false
      const text = ((a.headline || '') + ' ' + (a.description || '')).toLowerCase()
      return nameParts.every(part => text.includes(part))
    })
    .slice(0, 8)
    .map(a => a.headline?.trim())
    .filter(Boolean)
}

// ── 4. IL transaction check (today ± 2 days) ─────────────────────────────────

async function checkILStatus(pitcherId) {
  const today = new Date()
  const start = new Date(today - 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const end   = today.toISOString().slice(0, 10)
  const url   = `https://statsapi.mlb.com/api/v1/transactions?sportId=1&startDate=${start}&endDate=${end}&typeCode=IL`
  const res   = await httpFetch('preflight.il', { method: 'GET', url })
  if (!res.ok) return false
  const transactions = res.data?.transactions || []
  return transactions.some(t => String(t.person?.id) === String(pitcherId))
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function runPreflightCheck(entry) {
  const { pitcher_id, pitcher_name, game_id, game_label } = entry

  // Fetch all signals in parallel (5-10s total)
  const [probCheck, recentKs, newsSnippets, onIL] = await Promise.all([
    checkCurrentProbable(pitcher_id, game_id),
    getRecentKTrend(pitcher_id),
    fetchESPNNews(pitcher_name),
    checkILStatus(pitcher_id),
  ])

  // Hard skip: pitcher no longer probable (ML API confirmed) — skip AI call, no cost
  if (probCheck.changed) {
    return {
      action:     'skip',
      reason:     `${pitcher_name} no longer listed as probable starter for ${game_label}`,
      confidence: 1.0,
    }
  }

  // Hard skip: pitcher placed on IL today or yesterday
  if (onIL) {
    return {
      action:     'skip',
      reason:     `${pitcher_name} appears in recent IL transactions`,
      confidence: 1.0,
    }
  }

  // Build readable context strings for Claude
  const recentKContext = recentKs?.summary ?? '(no 2026 start data found)'
  const newsContext    = newsSnippets.length
    ? newsSnippets.map((s, i) => `${i + 1}. ${s}`).join('\n')
    : '(no recent news found)'

  return scoutKMarket({
    pitcherName:    pitcher_name,
    gameLabel:      game_label,
    newsSnippets,
    recentKContext,
    lineupContext:  '(lineup not yet confirmed at T-2.5h)',
  })
}
