// lib/preflightCheck.js — Pre-bet intelligence check for scheduled K-market bets.
//
// Architecture: two layers.
//
// Layer 1 — Code (deterministic, no AI cost):
//   • Hard skips: probable pitcher change, IL placement → return immediately
//   • Keyword classification: tag all RSS headlines SKIP/BOOST/NEUTRAL with source weight
//   • Numeric signals: K prop gap (model λ vs DK line), game total movement,
//     bullpen workload (last 2 days), weather, umpire re-confirmation
//   • Hard-rule skip on HIGH-confidence code signals → return, no Sonnet call
//
// Layer 2 — Sonnet (only for ambiguous/conflicting cases):
//   • Receives structured pre-classified JSON, not raw headlines
//   • Synthesizes conflicting signals into final proceed/skip/boost
//
// Returns: { action: 'proceed'|'skip'|'boost', reason, confidence, sources }

import { fetch as httpFetch } from './http.js'
import * as db from './db.js'
import { scoutKMarket } from './claude.js'
import { fetchRecentBullpenWorkload } from '../agents/bullpen/signals.js'
import { fetchGameWeather } from './weather.js'
import { fetchUmpireForGame } from '../scripts/live/fetchUmpire.js'
import { getUmpireFactor } from './umpireFactors.js'
import { VENUES } from '../agents/park/venues.js'

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

// ── Layer 1a: MLB API hard-skip checks ────────────────────────────────────────

async function checkCurrentProbable(pitcherId, gameId) {
  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&gamePk=${gameId}&hydrate=probablePitcher`
  const res = await httpFetch('preflight.probable', { method: 'GET', url })
  if (!res.ok) return { changed: false }
  const game = res.data?.dates?.[0]?.games?.[0]
  if (!game) return { changed: false }
  const pid = String(pitcherId)
  const homeProb = String(game.teams?.home?.probablePitcher?.id ?? '')
  const awayProb = String(game.teams?.away?.probablePitcher?.id ?? '')
  return { changed: homeProb !== pid && awayProb !== pid }
}

async function checkILStatus(pitcherId) {
  const today = new Date()
  const start = new Date(today - 2 * 86_400_000).toISOString().slice(0, 10)
  const end   = today.toISOString().slice(0, 10)
  const url   = `https://statsapi.mlb.com/api/v1/transactions?sportId=1&startDate=${start}&endDate=${end}&typeCode=IL`
  const res   = await httpFetch('preflight.il', { method: 'GET', url })
  if (!res.ok) return false
  return (res.data?.transactions || []).some(t => String(t.person?.id) === String(pitcherId))
}

// ── Layer 1b: K trend ─────────────────────────────────────────────────────────

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
  const avgK = last5.reduce((s, g) => s + g.ks, 0) / last5.length
  return `Last ${last5.length} starts: ${last5.map(g => g.ks + 'K').join(', ')} (avg ${avgK.toFixed(1)}K)`
}

// ── Layer 1c: RSS feed fetchers ───────────────────────────────────────────────

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

async function fetchESPNNews(pitcherName) {
  const url = 'https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/news?limit=100'
  const res = await httpFetch('preflight.espn', { method: 'GET', url })
  if (!res.ok) return []
  const cutoff   = Date.now() - 48 * 60 * 60 * 1000
  const nameParts = pitcherName.toLowerCase().split(' ')
  return (res.data?.articles || [])
    .filter(a => {
      const pub  = new Date(a.published || a.lastModified || 0).getTime()
      if (pub < cutoff) return false
      const text = ((a.headline || '') + ' ' + (a.description || '')).toLowerCase()
      return nameParts.every(p => text.includes(p))
    })
    .slice(0, 8)
    .map(a => a.headline?.trim())
    .filter(Boolean)
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
  return (await fetchRSS('preflight.mlbteam', `https://www.mlb.com/${slug}/feeds/news/rss.xml`, maxAgeMs)).slice(0, 4)
}

// ── Layer 1d: Keyword classifier ──────────────────────────────────────────────

const SKIP_PATTERNS = [
  { re: /pitch.?count.?(limit|cap|restriction)/i,   conf: 'high'   },
  { re: /innings?.?(limit|cap|restriction)/i,        conf: 'high'   },
  { re: /limited to \d+\s*pitch/i,                  conf: 'high'   },
  { re: /on an?\s+innings?\s+limit/i,                conf: 'high'   },
  { re: /won'?t\s+(go|pitch)\s+(past|more than)/i,  conf: 'high'   },
  { re: /bullpen day/i,                              conf: 'high'   },
  { re: /opener/i,                                   conf: 'high'   },
  { re: /scratched/i,                                conf: 'high'   },
  { re: /\belbow\b.*(tight|sore|concern|strain)/i,  conf: 'high'   },
  { re: /\bshoulder\b.*(tight|sore|concern)/i,      conf: 'high'   },
  { re: /\bblister\b/i,                              conf: 'high'   },
  { re: /\bforearm\b.*(tight|sore|strain)/i,        conf: 'high'   },
  { re: /not.{0,15}stretched/i,                     conf: 'medium' },
  { re: /day.to.day/i,                              conf: 'medium' },
  { re: /questionable to start/i,                   conf: 'medium' },
  { re: /pitch count concern/i,                     conf: 'medium' },
]

const BOOST_PATTERNS = [
  { re: /sharp.{0,20}(bullpen|warm.?up|stuff)/i,   conf: 'medium' },
  { re: /\bdealing\b/i,                             conf: 'medium' },
  { re: /velocity.{0,10}(up|tick|gain)/i,           conf: 'medium' },
  { re: /\bvelo\b.{0,10}(up|tick)/i,                conf: 'medium' },
  { re: /9[789]\s*mph/i,                            conf: 'medium' },
  { re: /excellent.{0,15}command/i,                 conf: 'medium' },
  { re: /electric.{0,15}stuff/i,                    conf: 'medium' },
]

// Source confidence weight for classification
function sourceWeight(source) {
  if (['rotowire', 'mlb_official', 'espn'].includes(source)) return 'high'
  if (source === 'google_news') return 'low'
  return 'medium'
}

function classifyHeadlines(headlines) {
  const results = []
  for (const { text, source } of headlines) {
    const sw   = sourceWeight(source)
    let signal = 'neutral'
    let conf   = 'low'

    for (const { re, conf: patternConf } of SKIP_PATTERNS) {
      if (re.test(text)) {
        signal = 'skip'
        // Effective confidence: pattern confidence, but capped by source weight
        conf   = sw === 'low' && patternConf === 'high' ? 'medium' : patternConf
        break
      }
    }
    if (signal === 'neutral') {
      for (const { re, conf: patternConf } of BOOST_PATTERNS) {
        if (re.test(text)) {
          signal = 'boost'
          conf   = sw === 'low' ? 'low' : patternConf
          break
        }
      }
    }

    results.push({ text, source, sourceWeight: sw, signal, conf })
  }
  return results
}

// ── Layer 1e: Numeric signal computations ─────────────────────────────────────

async function getKPropGap(pitcherName, gameDate) {
  try {
    const row = await db.one(
      `SELECT dk_line FROM dk_k_props WHERE prop_date = ? AND pitcher_name LIKE ? LIMIT 1`,
      [gameDate, `%${pitcherName.split(' ').pop()}%`],
    )
    if (!row) return null
    // Look up our model's average lambda for this pitcher today across all bets
    const bets = await db.all(
      `SELECT lambda, strike FROM ks_bets WHERE bet_date = ? AND pitcher_name LIKE ? AND lambda IS NOT NULL`,
      [gameDate, `%${pitcherName.split(' ').pop()}%`],
    )
    if (!bets.length) return { dkLine: row.dk_line, modelLambda: null, gap: null }
    const avgLambda = bets.reduce((s, b) => s + b.lambda, 0) / bets.length
    return {
      dkLine:      row.dk_line,
      modelLambda: Number(avgLambda.toFixed(1)),
      gap:         Number((avgLambda - row.dk_line).toFixed(1)),
    }
  } catch {
    return null
  }
}

async function getLineDelta(gameId) {
  try {
    const row = await db.one(
      `SELECT full_line_open, full_line_current FROM games WHERE id = ?`,
      [gameId],
    )
    if (!row?.full_line_open || !row?.full_line_current) return null
    return Number((row.full_line_current - row.full_line_open).toFixed(1))
  } catch {
    return null
  }
}

async function getWeatherSummary(gameId, gameTime) {
  try {
    const gameRow = await db.one(`SELECT venue_id FROM games WHERE id = ?`, [gameId])
    if (!gameRow?.venue_id) return null
    const venue = VENUES.find(v => String(v.id) === String(gameRow.venue_id) || v.team === gameRow.venue_id)
    if (!venue || venue.roof_type === 'dome') return 'dome — weather irrelevant'
    const w = await fetchGameWeather({ lat: venue.lat, lng: venue.lng, gameTime })
    if (!w.ok) return null
    const parts = []
    if (w.temp_f != null)              parts.push(`${Math.round(w.temp_f)}°F`)
    if (w.wind_mph != null)            parts.push(`wind ${Math.round(w.wind_mph)} mph`)
    if (w.precip_probability != null)  parts.push(`rain ${Math.round(w.precip_probability * 100)}%`)
    if (w.conditions)                  parts.push(w.conditions)
    return { summary: parts.join(', '), rainPct: w.precip_probability ?? 0, windMph: w.wind_mph ?? 0 }
  } catch {
    return null
  }
}

async function checkUmpireChange(gameId, pitcherName) {
  try {
    const { umpName, umpId } = await fetchUmpireForGame(gameId)
    if (!umpName) return { changed: false, umpName: null }
    // Look up what ump factor was used in our edge calc (stored in strikeout model output)
    // As a proxy: if the umpire factor is notably different from neutral (1.0), flag it
    const factor = getUmpireFactor(umpName)
    return { changed: false, umpName, factor }
  } catch {
    return { changed: false }
  }
}

async function getOpponentTeamId(gameId, pitcherSide) {
  try {
    const row = await db.one(`SELECT team_home, team_away FROM games WHERE id = ?`, [gameId])
    if (!row) return null
    return pitcherSide === 'home' ? row.team_away : row.team_home
  } catch {
    return null
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function runPreflightCheck(entry) {
  const { pitcher_id, pitcher_name, game_id, game_label, pitcher_side, game_time } = entry
  const gameDate     = (game_time || '').slice(0, 10) || new Date().toISOString().slice(0, 10)
  const pitcherTeam  = teamOf(game_label, pitcher_side)
  const opponentAbbr = teamOf(game_label, pitcher_side === 'home' ? 'away' : 'home')
  const opponentName = TEAM_NAMES[opponentAbbr] || opponentAbbr || ''

  // ── Hard-skip checks (parallel, no AI) ──
  const [probCheck, onIL] = await Promise.all([
    checkCurrentProbable(pitcher_id, game_id),
    checkILStatus(pitcher_id),
  ])
  if (probCheck.changed) return { action: 'skip', reason: `${pitcher_name} no longer listed as probable starter for ${game_label}`, confidence: 1.0, sources: [] }
  if (onIL)              return { action: 'skip', reason: `${pitcher_name} appears in recent IL transactions`, confidence: 1.0, sources: [] }

  // ── All remaining data in parallel ──
  const pitcherQuery  = `"${pitcher_name}" (pitcher OR "pitch count" OR "innings limit" OR blister OR elbow OR shoulder OR scratched OR limited OR IL)`
  const opponentQuery = opponentName ? `"${opponentName}" (lineup OR scratched OR "rest day" OR injured OR "out of lineup")` : null

  const opponentTeamId = await getOpponentTeamId(game_id, pitcher_side)

  const [
    kTrend, espnSnippets, googlePitcher, rotoSnippets, pitcherTeamNews,
    opponentTeamNews, googleOpponent,
    kPropData, lineDelta, bullpenData, weatherData, umpireData,
  ] = await Promise.all([
    getRecentKTrend(pitcher_id),
    fetchESPNNews(pitcher_name),
    fetchGoogleNews(pitcherQuery),
    fetchRotowireNews(pitcher_name),
    fetchMLBTeamNews(pitcherTeam),
    fetchMLBTeamNews(opponentAbbr),
    opponentQuery ? fetchGoogleNews(opponentQuery) : Promise.resolve([]),
    getKPropGap(pitcher_name, gameDate),
    getLineDelta(game_id),
    opponentTeamId ? fetchRecentBullpenWorkload(opponentTeamId, gameDate) : Promise.resolve(null),
    getWeatherSummary(game_id, game_time),
    checkUmpireChange(game_id, pitcher_name),
  ])

  // ── Keyword classification on all pitcher headlines ──
  const allPitcherRaw = [
    ...espnSnippets.map(t   => ({ text: t, source: 'espn' })),
    ...googlePitcher.map(t  => ({ text: t, source: 'google_news' })),
    ...rotoSnippets.map(t   => ({ text: t, source: 'rotowire' })),
    ...pitcherTeamNews.map(t => ({ text: t, source: 'mlb_official' })),
  ]
  // Deduplicate by text
  const seen = new Set()
  const dedupedRaw = allPitcherRaw.filter(({ text }) => {
    const k = text.toLowerCase().slice(0, 60)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  const classified = classifyHeadlines(dedupedRaw)

  const skipSignals  = classified.filter(s => s.signal === 'skip')
  const boostSignals = classified.filter(s => s.signal === 'boost')
  const neutralFlags = classified.filter(s => s.signal === 'neutral' && s.text.length > 0).slice(0, 3)

  // ── Hard-rule skip on HIGH-confidence code signals (no Sonnet call) ──
  const hardCodeSkip = skipSignals.find(s =>
    s.conf === 'high' && (s.sourceWeight === 'high' || s.sourceWeight === 'medium')
  )
  if (hardCodeSkip) {
    return {
      action:     'skip',
      reason:     `${hardCodeSkip.text} (${hardCodeSkip.source}, HIGH confidence)`,
      confidence: 0.95,
      sources:    [hardCodeSkip.text],
    }
  }

  // K prop hard skip: if gap is -2.0 or worse (DK disagrees by 2+ Ks), skip without Sonnet
  if (kPropData?.gap != null && kPropData.gap <= -2.0) {
    return {
      action:     'skip',
      reason:     `K prop gap ${kPropData.gap.toFixed(1)}: model λ=${kPropData.modelLambda} vs DK line=${kPropData.dkLine} — sharp market disagrees significantly`,
      confidence: 0.90,
      sources:    [],
    }
  }

  // ── Rain delay hard skip: >70% rain probability ──
  if (weatherData?.rainPct > 0.70) {
    return {
      action:     'skip',
      reason:     `${Math.round(weatherData.rainPct * 100)}% rain probability — significant delay/cancellation risk`,
      confidence: 0.85,
      sources:    [],
    }
  }

  // ── Build opponent news for Sonnet context ──
  const opponentNews = [...new Set([...googleOpponent, ...opponentTeamNews])].slice(0, 5)

  // ── Layer 2: Sonnet synthesis ──
  const result = await scoutKMarket({
    pitcherName:  pitcher_name,
    gameLabel:    game_label,
    kTrend:       kTrend ?? '(unavailable)',
    skipSignals:  skipSignals.map(s => `[${s.conf.toUpperCase()}/${s.sourceWeight}] ${s.text}`),
    boostSignals: boostSignals.map(s => `[${s.conf.toUpperCase()}/${s.sourceWeight}] ${s.text}`),
    neutralFlags: neutralFlags.map(s => s.text),
    kPropGap:     kPropData?.gap ?? null,
    lineDelta,
    bullpenIp2d:  bullpenData?.ip_2d ?? null,
    bullpenSignal: bullpenData?.signal ?? null,
    weatherSummary: typeof weatherData === 'object' ? weatherData?.summary : weatherData,
    umpireChanged: umpireData?.changed ?? false,
    opponentNews,
  })

  // Attach top sources for Discord notification
  const topSources = skipSignals.slice(0, 2).map(s => s.text)
    .concat(boostSignals.slice(0, 1).map(s => s.text))
    .slice(0, 3)

  // Return full classified headline list so pipeline UI can show what was found
  return { ...result, sources: topSources, headlines: classified }
}
