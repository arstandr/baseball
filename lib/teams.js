// lib/teams.js — Canonical team abbreviation maps used across the codebase.
// Single source of truth imported by lib/kalshi.js and lib/preflightCheck.js.

// MLB team abbreviation → Kalshi ticker abbreviation
export const TEAM_TO_KALSHI = {
  // AL East
  BAL: 'BAL', BOS: 'BOS', NYY: 'NYY', TB: 'TB', TOR: 'TOR',
  // AL Central
  CWS: 'CWS', CLE: 'CLE', DET: 'DET', KC: 'KC', MIN: 'MIN',
  // AL West
  HOU: 'HOU', LAA: 'LAA', OAK: 'ATH', SEA: 'SEA', TEX: 'TEX', ATH: 'ATH',
  // NL East
  ATL: 'ATL', MIA: 'MIA', NYM: 'NYM', PHI: 'PHI', WSH: 'WSH',
  // NL Central
  CHC: 'CHC', CIN: 'CIN', MIL: 'MIL', PIT: 'PIT', STL: 'STL',
  // NL West
  ARI: 'AZ', COL: 'COL', LAD: 'LAD', SD: 'SD', SF: 'SF',
  // Aliases seen across different APIs
  CHW: 'CWS', WAS: 'WSH', KCR: 'KC', SFG: 'SF', SDP: 'SD', TBR: 'TB',
  AZ: 'AZ',
}

// MLB team abbreviation → full name (for RSS/news matching)
export const TEAM_NAMES = {
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

// MLB team abbreviation → URL slug (for ESPN/CBS team pages)
export const TEAM_SLUGS = {
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

// NBA team abbreviation → Kalshi ticker abbreviation
export const NBA_TEAM_TO_KALSHI = {
  ATL: 'ATL', BOS: 'BOS', BKN: 'BKN', CHA: 'CHA', CHI: 'CHI',
  CLE: 'CLE', DAL: 'DAL', DEN: 'DEN', DET: 'DET', GSW: 'GS',
  HOU: 'HOU', IND: 'IND', LAC: 'LAC', LAL: 'LAL', MEM: 'MEM',
  MIA: 'MIA', MIL: 'MIL', MIN: 'MIN', NOP: 'NO',  NYK: 'NYK',
  OKC: 'OKC', ORL: 'ORL', PHI: 'PHI', PHX: 'PHX', POR: 'POR',
  SAC: 'SAC', SAS: 'SAS', TOR: 'TOR', UTA: 'UTA', WSH: 'WSH',
  // Aliases
  GS: 'GS', NO: 'NO', NY: 'NYK',
}
