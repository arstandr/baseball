// lib/parkFactors.js — Park K-rate multipliers by home team abbreviation.
//
// Values represent how much a park inflates or depresses pitcher strikeout rate
// relative to a neutral park (1.00). Derived from multi-year park factor research
// (Baseball Prospectus + FanGraphs park factors, 2021-2025 average for K%).
//
// Key drivers:
//   - Altitude (Coors Field): thin air = less pitch movement, hitters make
//     more contact → K-rate suppressor. Factor ≈ 0.92.
//   - Pitcher-friendly parks (Petco, Oracle, Tropicana): bigger foul territory,
//     heavier air, or deep dimensions discourage hacking → K-rate boosters.
//   - Hitter-friendly parks (Yankee Stadium, Great American): small dimensions
//     incentivise aggressive swings → K-rate slight boost.
//   - Dome / climate-controlled parks: neutral-to-slight K boost (consistent
//     conditions, clean spin on breaking balls).
//
// Sources:
//   Baseball Prospectus 3-year park factors (K%), FanGraphs park factors
//   https://www.fangraphs.com/guts.aspx?type=pf&teamid=&season=2024
//   https://www.baseballprospectus.com/statistics/sortable/pf/

export const PARK_FACTORS = {
  // National League
  ARI:  1.02,   // Chase Field (retractable dome, warm; slight K boost)
  ATL:  1.01,   // Truist Park
  CHC:  0.99,   // Wrigley Field (wind often out in summer suppresses K%)
  CIN:  1.02,   // Great American Ball Park (hitter friendly → aggressive swings)
  COL:  0.92,   // Coors Field — altitude, thin air, less break; biggest suppressor
  LAD:  1.02,   // Dodger Stadium (large foul territory, pitching-friendly)
  MIA:  1.03,   // loanDepot Park (retractable dome, humid; K booster)
  MIL:  1.01,   // American Family Field (retractable dome)
  NYM:  1.01,   // Citi Field (large park; slight pitcher advantage)
  PHI:  1.02,   // Citizens Bank Park
  PIT:  0.99,   // PNC Park
  SD:   1.06,   // Petco Park — marine layer, heavy air; best K boost
  SF:   1.04,   // Oracle Park (marine layer, large foul territory)
  STL:  1.00,   // Busch Stadium (neutral)
  WSH:  1.01,   // Nationals Park
  WAS:  1.01,   // alias

  // American League
  BAL:  1.01,   // Camden Yards
  BOS:  0.98,   // Fenway Park (short LF wall → opposite-field contact)
  CHW:  1.01,   // Guaranteed Rate Field
  CWS:  1.01,   // alias
  CLE:  1.01,   // Progressive Field (cool lake effect; slight K boost)
  DET:  1.01,   // Comerica Park (large outfield; pitcher-friendly)
  HOU:  1.03,   // Minute Maid Park (retractable roof, generally closed)
  KC:   1.00,   // Kauffman Stadium (neutral, spacious)
  LAA:  1.01,   // Angel Stadium
  MIN:  1.02,   // Target Field (cold early season; dome-era K habit)
  NYY:  1.04,   // Yankee Stadium (short porch incentivises pull-swing aggression)
  OAK:  1.02,   // Oakland Coliseum (large foul territory)
  ATH:  1.02,   // Athletics (Oakland/Sacramento alias)
  SEA:  1.04,   // T-Mobile Park (retractable roof, generally closed)
  TB:   1.03,   // Tropicana Field (dome, large foul territory)
  TEX:  1.02,   // Globe Life Field (retractable roof, climate-controlled)
  TOR:  1.02,   // Rogers Centre (dome)
}

/**
 * Return the park K-rate multiplier for the given home team abbreviation.
 * Unknown teams return 1.0 (neutral).
 *
 * @param {string} homeTeam - MLB team abbreviation (e.g. 'COL', 'SD', 'NYY')
 * @returns {number} multiplier (e.g. 0.92 for COL, 1.06 for SD)
 */
export function getParkFactor(homeTeam) {
  if (!homeTeam) return 1.0
  return PARK_FACTORS[homeTeam.toUpperCase()] ?? 1.0
}

// Park RUN-rate multipliers (independent of K factor). Used for F5 totals and
// game totals models. 1.00 = neutral. Sources: Statcast park factors 2021-2025,
// FanGraphs (https://www.fangraphs.com/guts.aspx?type=pf), Baseball Savant
// (https://baseballsavant.mlb.com/leaderboard/statcast-park-factors).
//
// Direction: higher value = more runs scored at this park.
//   - Coors Field is the extreme outlier (~1.20)
//   - Marine-layer parks suppress run scoring (SF, SD, SEA)
//   - Hitter-friendly parks with short porches inflate (BOS, CIN, NYY)
export const PARK_RUN_FACTORS = {
  // National League
  ARI:  1.04,   // Chase — warm, dry, retractable roof typically open
  ATL:  1.01,   // Truist — neutral-to-slight hitter
  CHC:  1.02,   // Wrigley — wind-dependent; small avg lift in 5/4 month sample
  CIN:  1.07,   // Great American — small dimensions, hitter haven
  COL:  1.20,   // Coors — altitude, biggest run inflator in MLB
  LAD:  0.98,   // Dodger Stadium — pitcher-friendly large foul territory
  MIA:  0.95,   // loanDepot — humid, big OF, suppresses runs
  MIL:  1.00,   // American Family — neutral
  NYM:  0.97,   // Citi — big OF, slight pitcher edge
  PHI:  1.04,   // Citizens Bank — short porch right
  PIT:  0.97,   // PNC — pitcher park (Allegheny breeze, deep RF)
  SD:   0.95,   // Petco — marine layer, heavy air
  SF:   0.93,   // Oracle — marine layer + big foul territory
  STL:  1.00,   // Busch — neutral
  WSH:  1.01,
  WAS:  1.01,

  // American League
  BAL:  1.05,   // Camden — short porch, warm
  BOS:  1.08,   // Fenway — Green Monster boosts hit total
  CHW:  1.02,   // Rate Field — slight hitter
  CWS:  1.02,
  CLE:  0.97,   // Progressive — cool, large OF
  DET:  0.97,   // Comerica — deep OF
  HOU:  1.01,   // Minute Maid — short LF porch but generally roof closed
  KC:   0.98,   // Kauffman — huge OF, neutral-to-pitcher
  LAA:  0.99,   // Angel Stadium — slight pitcher
  MIN:  0.99,   // Target — slight pitcher (cold early season)
  NYY:  1.04,   // Yankee Stadium — short RF porch
  OAK:  0.95,   // Coliseum — huge foul territory
  ATH:  0.95,
  SEA:  0.95,   // T-Mobile — marine, cool
  TB:   0.96,   // Tropicana — dome, large foul territory
  TEX:  1.05,   // Globe Life — warm, hitter-friendly dimensions
  TOR:  1.00,   // Rogers Centre — neutral
}

/**
 * Return the park RUN multiplier for the given home team abbreviation. Used
 * for run-totals modeling (F5 + full game). Independent of K factor.
 *
 * @param {string} homeTeam - MLB team abbreviation
 * @returns {number} multiplier (e.g. 1.20 for COL, 0.93 for SF)
 */
export function getParkRunFactor(homeTeam) {
  if (!homeTeam) return 1.0
  return PARK_RUN_FACTORS[homeTeam.toUpperCase()] ?? 1.0
}
