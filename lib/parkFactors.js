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
