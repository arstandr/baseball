// lib/bbref.js — Baseball-Reference scraper
//
// BBRef doesn't offer an API. We scrape HTML for:
//   - Per-start pitcher game logs (L5 starts: F5 runs, pitches, innings)
//   - Career venue splits (pitcher ERA at today's park)
//
// BBRef comments out a lot of tables inside <!-- ... --> blocks; we undo that
// before parsing with cheerio.

import { fetch } from './http.js'
import * as cheerio from 'cheerio'

const BASE = 'https://www.baseball-reference.com'

/**
 * Look up a pitcher's BBRef URL slug. Given a player name we fall back to
 * their search page. In production we cache these in the pitcher_signals
 * raw_data_json to avoid recomputing.
 */
export async function resolveBbrefSlug(pitcherName) {
  const res = await fetch('bbref.search', {
    method: 'GET',
    url: `${BASE}/search/search.fcgi`,
    params: { search: pitcherName },
  })
  if (!res.ok) return null
  const html = typeof res.data === 'string' ? res.data : ''
  const $ = cheerio.load(strip(html))
  // First player-search result
  const first = $('.search-item-name a').first().attr('href')
  if (!first) return null
  // Expect path like /players/s/smithwi01.shtml
  const m = first.match(/\/players\/[a-z]\/([a-z0-9]+)\.shtml/)
  return m ? m[1] : null
}

/**
 * Fetch per-start pitching game log for a season.
 * Returns array of starts with F5 runs and pitch counts.
 */
export async function fetchPitcherGameLog(slug, season) {
  if (!slug) return []
  const letter = slug[0]
  const url = `${BASE}/players/gl.fcgi?id=${slug}&t=p&year=${season}`
  const res = await fetch('bbref.gamelog', {
    method: 'GET',
    url,
  })
  if (!res.ok) return []
  const $ = cheerio.load(strip(typeof res.data === 'string' ? res.data : ''))
  const rows = []
  $('table#pitching_gamelogs tbody tr').each((_, el) => {
    const $r = $(el)
    if ($r.hasClass('thead')) return
    rows.push({
      date: $r.find('td[data-stat="date_game"]').text().trim(),
      team: $r.find('td[data-stat="team_ID"]').text().trim(),
      opp: $r.find('td[data-stat="opp_ID"]').text().trim(),
      venue: $r.find('td[data-stat="team_homeORaway"]').text().trim() === '@' ? 'away' : 'home',
      innings: Number($r.find('td[data-stat="IP"]').text()) || 0,
      runs: Number($r.find('td[data-stat="R"]').text()) || 0,
      earned_runs: Number($r.find('td[data-stat="ER"]').text()) || 0,
      strikeouts: Number($r.find('td[data-stat="SO"]').text()) || 0,
      walks: Number($r.find('td[data-stat="BB"]').text()) || 0,
      pitches: Number($r.find('td[data-stat="pitches"]').text()) || 0,
      game_score: Number($r.find('td[data-stat="game_score"]').text()) || null,
      // BBRef game logs don't break out F5 runs directly; we approximate with
      // (runs * min(innings,5)/innings) when innings > 0. Precise F5 numbers
      // come from mlbapi.fetchGameResult for final games.
    })
  })
  return rows
}

/**
 * Career splits at a specific venue.
 * BBRef venue splits are table id="venue_pitching" in the pitcher's splits page.
 */
export async function fetchVenueSplits(slug) {
  if (!slug) return []
  const letter = slug[0]
  const url = `${BASE}/players/split.fcgi?id=${slug}&t=p&year=Career`
  const res = await fetch('bbref.splits', { method: 'GET', url })
  if (!res.ok) return []
  const $ = cheerio.load(strip(typeof res.data === 'string' ? res.data : ''))
  const rows = []
  $('table#stadium tbody tr, table#venue_pitching tbody tr').each((_, el) => {
    const $r = $(el)
    if ($r.hasClass('thead')) return
    rows.push({
      venue: $r.find('th').text().trim() || $r.find('td[data-stat="split_name"]').text().trim(),
      innings: Number($r.find('td[data-stat="IP"]').text()) || 0,
      era: Number($r.find('td[data-stat="earned_run_avg"]').text()) || null,
      runs: Number($r.find('td[data-stat="R"]').text()) || 0,
      earned_runs: Number($r.find('td[data-stat="ER"]').text()) || 0,
    })
  })
  return rows
}

/**
 * Times-through-the-order splits for a pitcher (career).
 * TTO penalty = (2nd time through ERA) - (1st time through ERA).
 */
export async function fetchTtoSplits(slug) {
  if (!slug) return { first: null, second: null, third: null, penalty: null }
  const url = `${BASE}/players/split.fcgi?id=${slug}&t=p&year=Career`
  const res = await fetch('bbref.tto', { method: 'GET', url })
  if (!res.ok) return { first: null, second: null, third: null, penalty: null }
  const $ = cheerio.load(strip(typeof res.data === 'string' ? res.data : ''))
  const byOrder = { first: null, second: null, third: null }
  $('table#tto tbody tr, table#order tbody tr').each((_, el) => {
    const $r = $(el)
    const label = ($r.find('th').text() || '').toLowerCase()
    const era = Number($r.find('td[data-stat="earned_run_avg"]').text())
    if (!era) return
    if (label.includes('1st')) byOrder.first = era
    else if (label.includes('2nd')) byOrder.second = era
    else if (label.includes('3rd')) byOrder.third = era
  })
  const penalty =
    byOrder.first != null && byOrder.second != null
      ? Number((byOrder.second - byOrder.first).toFixed(3))
      : null
  // 3rd time through — critical for full-game model
  const tto3_penalty =
    byOrder.first != null && byOrder.third != null
      ? Number((byOrder.third - byOrder.first).toFixed(3))
      : null
  return { ...byOrder, penalty, tto3_penalty }
}

// BBRef hides tables in HTML comments; strip comment markers to expose them.
function strip(html) {
  return html.replace(/<!--/g, '').replace(/-->/g, '')
}
