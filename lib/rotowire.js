// lib/rotowire.js — confirmed lineup scraper
//
// Rotowire posts confirmed lineups ~2 hours before first pitch. We parse
// the public HTML page; no auth required. MLB.com is a secondary source
// we fall back to via mlbapi.fetchLineup().

import { fetch } from './http.js'
import * as cheerio from 'cheerio'

const BASE = 'https://www.rotowire.com'

/**
 * Scrape Rotowire's daily lineups for the given date.
 * Returns a map: { [teamAbbr]: { confirmed: bool, lineup: [{name, pos, handedness}] } }
 */
export async function fetchConfirmedLineups(date) {
  const res = await fetch('rotowire.lineups', {
    method: 'GET',
    url: `${BASE}/baseball/daily-lineups.php`,
    params: { date },
  })
  if (!res.ok) return {}
  const html = typeof res.data === 'string' ? res.data : ''
  const $ = cheerio.load(html)
  const out = {}

  $('.lineup').each((_, el) => {
    const $card = $(el)
    const visiting = parseTeamBlock($card.find('.lineup__team--visiting, .is-visit'), $)
    const home = parseTeamBlock($card.find('.lineup__team--home, .is-home'), $)
    if (visiting?.team) out[visiting.team] = visiting
    if (home?.team) out[home.team] = home
  })

  return out
}

function parseTeamBlock($block, $) {
  if (!$block || !$block.length) return null
  const team = ($block.find('.lineup__abbr').first().text() || '').trim().toUpperCase()
  if (!team) return null
  const confirmed = $block.find('.lineup__status--confirmed, .is-confirmed').length > 0
  const lineup = []
  $block.find('.lineup__list .lineup__player').each((i, li) => {
    const $p = $(li)
    const name = ($p.find('.lineup__player-name, a').first().text() || '').trim()
    if (!name) return
    const pos = ($p.find('.lineup__pos, .pos').first().text() || '').trim()
    const hand = ($p.find('.lineup__bats, .bats').first().text() || '').trim()
    lineup.push({ order: i + 1, name, pos, handedness: hand || null })
  })
  return { team, confirmed, lineup }
}

/**
 * Expected (typical) lineup — used as the baseline to diff against when the
 * confirmed lineup drops. Rotowire shows "expected" batting orders a day
 * ahead; we cache per team.
 */
export async function fetchExpectedLineups(date) {
  const res = await fetch('rotowire.expected', {
    method: 'GET',
    url: `${BASE}/baseball/daily-lineups.php`,
    params: { date, expected: 1 },
  })
  if (!res.ok) return {}
  // Reuse the same selectors — expected markup mirrors confirmed
  return fetchConfirmedLineups(date)
}
