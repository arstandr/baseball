// lib/preflightCheck.js — Pre-bet intelligence check for scheduled K-market bets.
//
// Runs right before firePendingBets() places a bet (~T-2.5h).
// Pulls signals in parallel, feeds them to Claude Haiku,
// and returns: { action: 'proceed'|'skip'|'boost', reason, confidence, sources }
//
// Data sources:
//   1. MLB API — confirm pitcher is still the probable starter
//   2. MLB API — last 5 game-log starts (K trend)
//   3. ESPN MLB news feed — pitcher name mentions (last 48h)
//   4. MLB API — IL transactions (today ± 2 days)
//   5. Google News RSS — pitcher risk/boost keywords (last 6h)
//   6. Rotowire MLB RSS — pitcher-filtered player news (last 6h)
//   7. MLB.com team RSS — pitcher's team + opponent team (last 6h)
//   8. Google News RSS — opponent lineup news (last 6h)

import { fetch as httpFetch } from './http.js'
import { scoutKMarket } from './claude.js'

// ── Team maps ─────────────────────────────────────────────────────────────────

const TEAM_NAMES = {
  NYY: 'Yankees',   NYM: 'Mets',        BOS: 'Red Sox',     TOR: 'Blue Jays',
  BAL: 'Orioles',   TB:  'Rays',        TBR: 'Rays',        CLE: 'Guardians',
  MIN: 'Twins',     CWS: 'White Sox',   CHW: 'White Sox',   KC:  'Royals',
  KCR: 'Royals',    DET: 'Tigers',      HOU: 'Astros',      LAA: 'Angels',
  SEA: 'Mariners',  OAK: 'Athletics',   ATH: 'Athletics',   TEX: 'Rangers',
  ATL: 'Braves',    MIA: 'Marlins',     PHI: 'Phillies',    WSH: 'Nationals',
  WAS: 'Nationals', CHC: 'Cubs',        MIL: 'Brewers',     STL: 'Cardinals',
  CIN: 'Reds',      PIT: 'Pirates',     LAD: 'Dodgers',     SF:  'Giants',
  SFG: 'Giants',    SD:  'Padres',      SDP: 'Padres',      COL: 'Rockies',
  ARI: 'Diamondbacks', AZ: 'Diamondbacks',
}

const TEAM_SLUGS = {
  NYY: 'yankees',   NYM: 'mets',        BOS: 'red-sox',     TOR: 'blue-jays',
  BAL: 'orioles',   TB:  'rays',        TBR: 'rays',        CLE: 'guardians',
  MIN: 'twins',     CWS: 'white-sox',   CHW: 'white-sox',   KC:  'royals',
  KCR: 'royals',    DET: 'tigers',      HOU: 'astros',      LAA: 'angels',
  SEA: 'mariners',  OAK: 'athletics',   ATH: 'athletics',   TEX: 'rangers',
  ATL: 'braves',    MIA: 'marlins',     PHI: 'phillies',    WSH: 'nationals',
  WAS: 'nationals', CHC: 'cubs',        MIL: 'brewers',     STL: 'cardinals',
  CIN: 'reds',      PIT: 'pirates',     LAD: 'dodgers',     SF:  'giants',
  SFG: 'giants',    SD:  'padres',      SDP: 'padres',      COL: 'rockies',
  ARI: 'd-backs',   AZ:  'd-backs',
}

function teamOf(gameLabel, side) {
  const [away, home] = (gameLabel || '').split('@')
  return (side === 'home' ? home : away)?.trim()
}

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

// ── 5–8. RSS helpers ──────────────────────────────────────────────────────────

function parseRSS(xml, maxAgeMs = 6 * 60 * 60 * 1000) {
  const cutoff = Date.now() - maxAgeMs
  const items  = []
  const re     = /<item>([\s\S]*?)<\/item>/g
  let m
  while ((m = re.exec(xml)) !== null) {
    const block   = m[1]
    const title   = block.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/)?.[1]
                 ?? block.match(/<title>([\s\S]*?)<\/title>/)?.[1]
    const pubDate = block.match(/<pubDate>(.*?)<\/pubDate>/)?.[1]
    if (!title) continue
    if (pubDate) {
      const ts = new Date(pubDate).getTime()
      if (!isNaN(ts) && ts < cutoff) continue
    }
    items.push(title.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim())
  }
  return items
}

async function fetchRSS(source, url, maxAgeMs) {
  const res = await httpFetch(source, { method: 'GET', url, responseType: 'text' })
  if (!res.ok || typeof res.data !== 'string') return []
  return parseRSS(res.data, maxAgeMs)
}

async function fetchGoogleNews(query, maxAgeMs = 6 * 60 * 60 * 1000) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`
  return (await fetchRSS('preflight.gnews', url, maxAgeMs)).slice(0, 6)
}

async function fetchRotowireNews(pitcherName, maxAgeMs = 6 * 60 * 60 * 1000) {
  const items = await fetchRSS('preflight.rotowire', 'https://www.rotowire.com/baseball/rss-news.php', maxAgeMs)
  const parts = pitcherName.toLowerCase().split(' ')
  return items.filter(h => parts.every(p => h.toLowerCase().includes(p))).slice(0, 4)
}

async function fetchMLBTeamNews(teamAbbr, maxAgeMs = 6 * 60 * 60 * 1000) {
  const slug = TEAM_SLUGS[teamAbbr]
  if (!slug) return []
  const url = `https://www.mlb.com/${slug}/feeds/news/rss.xml`
  return (await fetchRSS('preflight.mlbteam', url, maxAgeMs)).slice(0, 4)
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
  const { pitcher_id, pitcher_name, game_id, game_label, pitcher_side } = entry

  const pitcherTeam  = teamOf(game_label, pitcher_side)
  const opponentAbbr = teamOf(game_label, pitcher_side === 'home' ? 'away' : 'home')
  const opponentName = TEAM_NAMES[opponentAbbr] || opponentAbbr || ''

  const pitcherQuery  = `"${pitcher_name}" (pitcher OR "pitch count" OR "innings limit" OR blister OR elbow OR shoulder OR scratched OR limited OR IL)`
  const opponentQuery = opponentName ? `"${opponentName}" (lineup OR scratched OR "rest day" OR injured OR "out of lineup" OR "day to day")` : null

  // Fetch all signals in parallel
  const [
    probCheck, recentKs, espnSnippets, onIL,
    googlePitcher, rotoSnippets, pitcherTeamNews,
    opponentTeamNews, googleOpponent,
  ] = await Promise.all([
    checkCurrentProbable(pitcher_id, game_id),
    getRecentKTrend(pitcher_id),
    fetchESPNNews(pitcher_name),
    checkILStatus(pitcher_id),
    fetchGoogleNews(pitcherQuery),
    fetchRotowireNews(pitcher_name),
    fetchMLBTeamNews(pitcherTeam),
    fetchMLBTeamNews(opponentAbbr),
    opponentQuery ? fetchGoogleNews(opponentQuery) : Promise.resolve([]),
  ])

  // Hard skip: pitcher no longer probable — skip AI call, no cost
  if (probCheck.changed) {
    return { action: 'skip', reason: `${pitcher_name} no longer listed as probable starter for ${game_label}`, confidence: 1.0, sources: [] }
  }

  // Hard skip: pitcher placed on IL
  if (onIL) {
    return { action: 'skip', reason: `${pitcher_name} appears in recent IL transactions`, confidence: 1.0, sources: [] }
  }

  // Deduplicate and merge pitcher news across all sources
  const pitcherNews  = [...new Set([...espnSnippets, ...googlePitcher, ...rotoSnippets, ...pitcherTeamNews])].slice(0, 10)
  const opponentNews = [...new Set([...googleOpponent, ...opponentTeamNews])].slice(0, 6)

  const result = await scoutKMarket({
    pitcherName:   pitcher_name,
    gameLabel:     game_label,
    newsSnippets:  pitcherNews,
    recentKContext: recentKs?.summary ?? '(no 2026 start data found)',
    lineupContext: opponentNews.length
      ? opponentNews.map((s, i) => `${i + 1}. ${s}`).join('\n')
      : '(no opponent news found)',
  })

  // Attach top sources so Discord notification can show what triggered the decision
  return { ...result, sources: pitcherNews.slice(0, 3) }
}
