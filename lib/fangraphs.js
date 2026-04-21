// lib/fangraphs.js — Fangraphs leaderboard scraper
//
// Fangraphs exposes leaderboard data on their frontend via a JSON endpoint
// used by the React app: /api/leaders/major-league/data. We hit it directly
// rather than screen-scraping the HTML; this is stable enough for daily use
// but we guard every access.

import { fetch } from './http.js'
import * as cheerio from 'cheerio'

const BASE = 'https://www.fangraphs.com'

/**
 * Pitcher leaderboard — FIP, xFIP, K%, BB%, GB%, F-Strike%, WHIP
 * stats=pit, group=pitcher, type=1 (standard)
 */
export async function fetchPitcherLeaderboard(season, { min_ip = 10 } = {}) {
  const res = await fetch('fangraphs.pitchers', {
    method: 'GET',
    url: `${BASE}/api/leaders/major-league/data`,
    params: {
      pos: 'all',
      stats: 'pit',
      lg: 'all',
      qual: min_ip,
      type: 8, // advanced pitching view (FIP, xFIP, K%, BB%, GB%)
      season,
      season1: season,
      month: 0,
      ind: 0,
    },
  })
  if (!res.ok) return {}
  const rows = res.data?.data || res.data || []
  const out = {}
  for (const r of rows) {
    const pid = String(r.xMLBAMID ?? r.playerid ?? r.MLBAMID ?? '')
    if (!pid) continue
    out[pid] = {
      player_id: pid,
      name: r.PlayerName || r.Name,
      team: r.TeamName || r.Team,
      ip: Number(r.IP) || 0,
      fip: Number(r.FIP) || null,
      xfip: Number(r.xFIP) || null,
      k_pct: asPct(r['K%']),
      bb_pct: asPct(r['BB%']),
      gb_pct: asPct(r['GB%']),
      fb_pct: asPct(r['FB%']),
      hr9: Number(r['HR/9']) || null,
      k9: Number(r['K/9']) || null,
      bb9: Number(r['BB/9']) || null,
      fstrike_pct: asPct(r['F-Strike%']),
      whip: Number(r.WHIP) || null,
      era: Number(r.ERA) || null,
      starts: Number(r.GS) || 0,
    }
  }
  return out
}

/**
 * Team offense leaderboard — wRC+, K%, ISO, BABIP
 * Fetched twice: vs LHP and vs RHP (Fangraphs split filter).
 */
export async function fetchTeamOffense(season, vsHand /* 'L' | 'R' */) {
  const res = await fetch(`fangraphs.team_offense_${vsHand}`, {
    method: 'GET',
    url: `${BASE}/api/leaders/splits/splits-leaders`,
    params: {
      splitArr: vsHand === 'L' ? 5 : 6, // 5=vs LHP, 6=vs RHP (historical split IDs)
      strgroup: 'season',
      statgroup: 2, // batters
      startDate: `${season}-03-01`,
      endDate: `${season}-11-01`,
      players: 0,
      filter: '',
      groupBy: 'team',
    },
  })
  if (!res.ok) return {}
  const rows = res.data?.data || res.data || []
  const out = {}
  for (const r of rows) {
    const team = (r.TeamName || r.Team || '').toUpperCase()
    if (!team) continue
    out[team] = {
      team,
      wrc_plus: Number(r['wRC+']) || null,
      k_pct: asPct(r['K%']),
      iso: Number(r.ISO) || null,
      babip: Number(r.BABIP) || null,
      hard_pct: asPct(r['Hard%']),
      woba: Number(r.wOBA) || null,
      pa: Number(r.PA) || 0,
    }
  }
  return out
}

/**
 * Pitcher splits vs LHB/RHB (career or season). Fangraphs exposes this via a
 * per-player splits page. Requires an extra round trip per pitcher so we only
 * call this for starters on the slate.
 */
export async function fetchPitcherPlatoonSplits(pitcherId, season) {
  const res = await fetch(`fangraphs.pitcher_splits`, {
    method: 'GET',
    url: `${BASE}/api/leaders/splits/splits-leaders`,
    params: {
      splitArr: '1,2', // vs RHB and LHB
      strgroup: 'season',
      statgroup: 1, // pitchers
      startDate: `${season}-03-01`,
      endDate: `${season}-11-01`,
      players: pitcherId,
      filter: '',
      groupBy: 'player',
    },
  })
  if (!res.ok) return { vs_lhb: null, vs_rhb: null }
  const rows = res.data?.data || res.data || []
  const out = { vs_lhb: null, vs_rhb: null }
  for (const r of rows) {
    const split = (r.Split || r.SplitName || '').toLowerCase()
    const rec = {
      era: Number(r.ERA) || null,
      fip: Number(r.FIP) || null,
      k_pct: asPct(r['K%']),
      bb_pct: asPct(r['BB%']),
      swstr_pct: asPct(r['SwStr%']),
    }
    if (split.includes('lhb') || split.includes('vs l')) out.vs_lhb = rec
    else if (split.includes('rhb') || split.includes('vs r')) out.vs_rhb = rec
  }
  return out
}

function asPct(v) {
  if (v == null || v === '') return null
  if (typeof v === 'string') {
    const n = Number(v.replace('%', ''))
    if (Number.isNaN(n)) return null
    return n > 1.5 ? n / 100 : n
  }
  const n = Number(v)
  if (Number.isNaN(n)) return null
  return n > 1.5 ? n / 100 : n
}

// Exported helper so tests can inspect Fangraphs' occasional HTML fallbacks
export function _parseFangraphsHtml(html) {
  const $ = cheerio.load(html)
  return $('table').length
}
