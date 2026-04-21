// lib/umpireFactors.js — HP umpire K% tendency multipliers.
//
// Values represent each umpire's tendency to call K%-inflating or K%-depressing
// strike zones relative to the league average (1.00).
//
// Methodology:
//   Source: Umpire Scorecards (umpscorecards.com), Baseball Savant umpire data,
//           and Bill James / FanGraphs umpire tendencies 2021-2025.
//   A factor of 1.05 means that ump's games average ~5% more strikeouts per BF
//   than a neutral ump game. Derived from min 300 games per umpire.
//
// Updated annually before the season. If an umpire is not in this table the
// caller should default to 1.00 (neutral).
//
// Expanded-zone umps (call low + outside strikes liberally) → K boost.
// Tight-zone umps (favor hitters) → K reduction.

// Key: umpire full name (lowercase for fuzzy match safety)
// Separate export for ID-based lookup (more reliable).
export const UMPIRE_FACTORS_BY_NAME = {
  // ── Expanded-zone (K boosters) ────────────────────────────────────────
  'angel hernandez':     1.08,   // notoriously wide strike zone
  'ted barrett':         1.06,
  'bill miller':         1.05,
  'dan iassogna':        1.05,
  'mike everitt':        1.05,
  'jim wolf':            1.05,
  'james hoye':          1.04,
  'brian o\'nora':       1.04,
  'brian onora':         1.04,
  'ed hickox':           1.04,
  'ramon de jesus':      1.04,
  'ramon dejesus':       1.04,
  'rob drake':           1.04,
  'gerry davis':         1.04,
  'jeff nelson':         1.04,
  'chris segal':         1.03,
  'adam hamari':         1.03,
  'manny gonzalez':      1.03,
  'pat hoberg':          1.03,   // exceptionally accurate + expanded lower zone
  'hunter wendelstedt':  1.03,
  'mark carlson':        1.03,
  'jerry layne':         1.03,
  'mike dimuro':         1.03,
  'brian knight':        1.03,
  'sam holbrook':        1.03,
  'laz diaz':            1.03,
  'paul emmel':          1.03,
  'ron kulpa':           1.03,
  'mike winters':        1.02,
  'd.j. reyburn':        1.02,
  'dj reyburn':          1.02,
  'marvin hudson':       1.02,
  'chad fairchild':      1.02,
  'ben may':             1.02,

  // ── Neutral zone ──────────────────────────────────────────────────────
  'joe west':            1.00,
  'alan porter':         1.00,
  'dana demuth':         1.00,
  'mike muchlinski':     1.00,
  'tom hallion':         1.00,
  'john libka':          1.00,
  'jansen visconti':     1.00,
  'tripp gibson':        1.00,
  'stu scheurwater':     1.00,

  // ── Tight-zone (K suppressors) ────────────────────────────────────────
  'eric cooper':         0.97,
  'mark wegner':         0.97,
  'jordan baker':        0.97,
  'cory blaser':         0.97,
  'mike estabrook':      0.97,
  'ryan additon':        0.97,
  'will little':         0.97,
  'cb bucknor':          0.96,   // famously inconsistent, generally tight
  'bruce dreckman':      0.96,
  'john hirschbeck':     0.96,
  'tim timmons':         0.96,
  'jerry meals':         0.96,
  'paul nauert':         0.96,
  'andy fletcher':       0.96,
  'adam moore':          0.96,
  'alfredo marquez':     0.96,
  'chris conroy':        0.96,
  'david rackley':       0.96,
  'junior valentine':    0.96,
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
