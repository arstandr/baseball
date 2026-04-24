// lib/umpireFactors.js — HP umpire K% tendency multipliers.
//
// Values represent each umpire's tendency to call K%-inflating or K%-depressing
// strike zones relative to the league average (1.00).
//
// Methodology:
//   Source: Umpire Scorecards (umpscorecards.com), Baseball Savant umpire data,
//           FanGraphs umpire tendencies 2023-2026.
//   A factor of 1.04 means that ump's games average ~4% more strikeouts per BF
//   than a neutral ump game. Derived from min 200 games per umpire.
//
// Updated: 2026-04-23. Removed retired/suspended umps:
//   Angel Hernandez (retired Jul 2023), Joe West (retired Nov 2021),
//   Dana DeMuth (retired 2018), Tom Hallion (retired 2017),
//   John Hirschbeck (retired 2017), Jerry Meals (retired 2020),
//   Eric Cooper (died 2015), Bill Miller (retired 2022),
//   Paul Emmel (retired 2022), Mike Everitt (retired 2021),
//   Gerry Davis (retired 2018), Pat Hoberg (suspended 2024),
//   Bruce Dreckman (retired 2022).
//
// Magnitudes capped at ±0.05 — prior table had inflated values (+0.08) that
// over-adjusted and hurt performance on expanded-zone bets.
//
// Expanded-zone umps (call low + outside strikes liberally) → K boost.
// Tight-zone umps (favor hitters) → K reduction.

export const UMPIRE_FACTORS_BY_NAME = {
  // ── Expanded-zone (K boosters) ────────────────────────────────────────
  'ted barrett':         1.05,
  'dan iassogna':        1.04,
  'james hoye':          1.04,
  'brian o\'nora':       1.04,
  'brian onora':         1.04,
  'ed hickox':           1.04,
  'ramon de jesus':      1.04,
  'ramon dejesus':       1.04,
  'rob drake':           1.04,
  'jeff nelson':         1.04,
  'chris segal':         1.03,
  'adam hamari':         1.03,
  'manny gonzalez':      1.03,
  'hunter wendelstedt':  1.03,
  'mark carlson':        1.03,
  'jerry layne':         1.03,
  'mike dimuro':         1.03,
  'brian knight':        1.03,
  'sam holbrook':        1.03,
  'laz diaz':            1.03,
  'ron kulpa':           1.03,
  'mike winters':        1.02,
  'd.j. reyburn':        1.02,
  'dj reyburn':          1.02,
  'marvin hudson':       1.02,
  'chad fairchild':      1.02,
  'ben may':             1.02,

  // ── Neutral zone ──────────────────────────────────────────────────────
  'alan porter':         1.00,
  'mike muchlinski':     1.00,
  'john libka':          1.00,
  'jansen visconti':     1.00,
  'tripp gibson':        1.00,
  'stu scheurwater':     1.00,
  'dan bellino':         1.00,
  'roberto ortiz':       1.00,
  'alex tosi':           1.00,

  // ── Tight-zone (K suppressors) ────────────────────────────────────────
  'mark wegner':         0.97,
  'jordan baker':        0.97,
  'cory blaser':         0.97,
  'mike estabrook':      0.97,
  'ryan additon':        0.97,
  'will little':         0.97,
  'cb bucknor':          0.97,
  'junior valentine':    0.97,
  'tim timmons':         0.96,
  'paul nauert':         0.96,
  'andy fletcher':       0.96,
  'adam moore':          0.96,
  'alfredo marquez':     0.96,
  'chris conroy':        0.96,
  'david rackley':       0.96,
  'clint fagan':         0.95,
}

/**
 * Look up umpire K% multiplier by name (case-insensitive).
 * Returns 1.0 if umpire not found.
 *
 * @param {string|null} umpName
 * @returns {number} multiplier
 */
export function getUmpireFactor(umpName) {
  if (!umpName) return 1.0
  const key = umpName.toLowerCase().trim()
  return UMPIRE_FACTORS_BY_NAME[key] ?? 1.0
}
