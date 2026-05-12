// scripts/oracle/buildMathParityFixtures.js
//
// Layer 1 Math — parity fixture harvester (Bite 2).
//
// Builds the reference dataset that gates Bite 3 (extraction). For each
// candidate (pitcher_id, bet_date) drawn from decision_pipeline:
//
//   1. Call harvestLayer1MathFixture() → captures raw inputs + computeLambdaBase output
//   2. Cross-check the harvest result against production's logged
//      decision_pipeline.lambda_calc_json values (lambda_base, p_k_blended,
//      velo_adj, bb_penalty, tto_penalty, expectedBF, avg_pitches, leash_flag,
//      tto_note, bf_source). Float tolerance 1e-12; exact match for strings/bools.
//   3. STRICT MODE (default): hard-fail on first mismatch.
//      ALLOW MODE (--allow-prod-mismatch): record fixture with
//      production_match=false + mismatch_fields.
//   4. Compute archetypeR(savant) → nb_r and prob_at_least_by_strike for K=3..12
//      using production-logged lambda_final as anchor.
//   5. Hash models/pk_ridge_weights.json for ML drift detection.
//   6. Classify into the first matching archetype that's not yet full.
//
// Target: 9 archetypes × 2 fixtures = 18. Walks candidates newest-first.
//
// Output: oracle/layers/1-math/parity-fixtures.json
//
// Usage:
//   node scripts/oracle/buildMathParityFixtures.js
//   node scripts/oracle/buildMathParityFixtures.js --since=2026-04-15
//   node scripts/oracle/buildMathParityFixtures.js --allow-prod-mismatch
//
// READ-ONLY against production DB. Imports strikeoutEdge.js (which now
// guards its main() so import doesn't auto-fire the pre-game pipeline).

import dotenv from 'dotenv'
import path from 'node:path'
import url from 'node:url'
import fs from 'node:fs/promises'
import crypto from 'node:crypto'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
dotenv.config({ path: path.resolve(__dirname, '../../.env') })

import * as db from '../../lib/db.js'
import { harvestLayer1MathFixture } from '../live/strikeoutEdge.js'
import { archetypeR, nbCDF, LEAGUE_PA_PER_IP } from '../../lib/strikeout-model.js'

// ────────────────────────────────────────────────────────────────────────
// CLI args + constants
// ────────────────────────────────────────────────────────────────────────

const cliArgs = process.argv.slice(2)
const ALLOW_PROD_MISMATCH = cliArgs.includes('--allow-prod-mismatch')
const SINCE_ARG = cliArgs.find(a => a.startsWith('--since=')) ?? '--since=2026-04-15'
const SINCE = SINCE_ARG.slice('--since='.length)
const TARGET_PER_ARCHETYPE = 2

const FLOAT_TOL = 1e-12
const STRIKES = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12]

const OUTPUT_PATH = path.resolve(__dirname, '../../oracle/layers/1-math/parity-fixtures.json')
const WEIGHTS_PATH = path.resolve(__dirname, '../../models/pk_ridge_weights.json')

// ────────────────────────────────────────────────────────────────────────
// Archetype classifiers
// ────────────────────────────────────────────────────────────────────────
//
// Each classifier receives:
//   - h: the harvest result (h.inputs, h.result, etc.)
//   - p: { modelInput } production-logged supplementary inputs
//
// Classifiers are matched in order; each fixture takes the FIRST archetype
// whose bucket isn't full and whose classifier returns true.

const ARCHETYPES = [
  {
    id: 'high_k_ace',
    desc: 'savant.ip≥30 AND k_pct≥0.28 — full Statcast, ML overlay active, tight tail',
    classify: (h) => h.inputs.savant
      && Number(h.inputs.savant.ip) >= 30
      && Number(h.inputs.savant.k_pct) >= 0.28,
  },
  {
    id: 'low_k_control',
    desc: 'savant.ip≥30 AND k_pct≤0.19 — control pitcher, wider tail',
    classify: (h) => h.inputs.savant
      && Number(h.inputs.savant.ip) >= 30
      && Number(h.inputs.savant.k_pct) <= 0.19,
  },
  {
    id: 'mixed_k',
    desc: 'savant.ip≥30 AND k_pct ∈ (0.19, 0.28) — median archetype, default r=30',
    classify: (h) => h.inputs.savant
      && Number(h.inputs.savant.ip) >= 30
      && Number(h.inputs.savant.k_pct) > 0.19
      && Number(h.inputs.savant.k_pct) < 0.28,
  },
  {
    id: 'rookie_thin',
    desc: 'savant null OR savant.ip<5 — formula path forced (no ML overlay)',
    classify: (h) => !h.inputs.savant || Number(h.inputs.savant.ip ?? 0) < 5,
  },
  {
    id: 'post_il_short_leash',
    desc: 'savant.manager_leash_factor<0.95 — pulled-early pattern',
    classify: (h) => h.inputs.savant
      && h.inputs.savant.manager_leash_factor != null
      && Number(h.inputs.savant.manager_leash_factor) < 0.95,
  },
  {
    id: 'no_savant_career_only',
    desc: 'savant null AND career not null — career-anchor branch',
    classify: (h) => !h.inputs.savant && !!h.inputs.career,
  },
  {
    id: 'lineup_posted',
    desc: "model_input.opp_kpct_source begins with 'lineup' — slot-weighted opp K%",
    classify: (h, p) => typeof p.modelInput?.opp_kpct_source === 'string'
      && p.modelInput.opp_kpct_source.startsWith('lineup'),
  },
  {
    id: 'lineup_absent',
    desc: 'opp_kpct_source from db/mlb_api/league_avg — non-lineup fallback',
    classify: (h, p) => typeof p.modelInput?.opp_kpct_source === 'string'
      && !p.modelInput.opp_kpct_source.startsWith('lineup'),
  },
  {
    id: 'l5_spike_regressed',
    desc: 'L5 regression cap fired (rawK9 from logs > careerK9 × 1.25)',
    classify: (h) => detectL5RegressionCap(h),
  },
]

// Replicates the regression-cap gate from computeLambdaBase line 502-525.
// Returns true iff the cap actually fired for this pitcher's last-5 starts.
// Receives a fixture object (built by buildFixtureFromCandidate) where the
// computeLambdaBase return is stored under `expected_inner`, not `result`.
function detectL5RegressionCap(fixture) {
  const log = fixture.inputs?.log ?? []
  const cutoff = new Date(fixture.inputs?.gameDate ?? 0).getTime()
  const last5 = log
    .filter(r => r.started && r.ip >= 0.1 && new Date(r.date).getTime() < cutoff)
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, 5)
  if (last5.length === 0) return false
  const totalBF = last5.reduce((s, r) => s + (r.bf || 0), 0)
  const totalK  = last5.reduce((s, r) => s + (r.k  || 0), 0)
  if (totalBF <= 0) return false
  const rawPK = totalK / totalBF
  const rawK9 = rawPK * LEAGUE_PA_PER_IP * 9
  const careerK9 = fixture.expected_inner?.k9_career
  return Number.isFinite(careerK9) && careerK9 > 0 && rawK9 > careerK9 * 1.25
}

// ────────────────────────────────────────────────────────────────────────
// Cross-check: harvest result vs production-logged values
// ────────────────────────────────────────────────────────────────────────

function approxEq(a, b, tol = FLOAT_TOL) {
  if (a == null && b == null) return true
  if (a == null || b == null) return false
  if (typeof a !== 'number' || typeof b !== 'number') return a === b
  if (!Number.isFinite(a) || !Number.isFinite(b)) return a === b
  return Math.abs(a - b) <= tol
}

// Maps harvest.result fields to production-logged JSON keys.
// `loc` is which production JSON the field comes from: 'lambda' or 'model_input'.
const NUMERIC_PAIRS = [
  { hKey: 'lambdaBase',  pKey: 'lambda_base',  loc: 'lambda' },
  { hKey: 'pK_blended',  pKey: 'p_k_blended',  loc: 'lambda' },
  { hKey: 'veloAdj',     pKey: 'velo_adj',     loc: 'lambda' },
  { hKey: 'bbPenalty',   pKey: 'bb_penalty',   loc: 'lambda' },
  { hKey: 'ttoPenalty',  pKey: 'tto_penalty',  loc: 'lambda' },
  { hKey: 'expectedBF',  pKey: 'expected_bf',  loc: 'model_input' },
  { hKey: 'avgPitches',  pKey: 'avg_pitches',  loc: 'lambda' },
]

const EXACT_PAIRS = [
  { hKey: 'ttoNote',   pKey: 'tto_note',   loc: 'lambda' },
  { hKey: 'leashFlag', pKey: 'leash_flag', loc: 'lambda' },
  { hKey: 'bfSource',  pKey: 'bf_source',  loc: 'model_input' },
]

function crossCheck(harvest, prodLambda, prodModelInput) {
  const mismatches = []

  for (const { hKey, pKey, loc } of NUMERIC_PAIRS) {
    const hVal = harvest.result[hKey]
    const pVal = (loc === 'model_input') ? prodModelInput?.[pKey] : prodLambda?.[pKey]
    if (!approxEq(hVal, pVal)) {
      mismatches.push({
        field: hKey,
        production_logged_as: pKey,
        expected: pVal,
        actual: hVal,
        abs_diff: (typeof hVal === 'number' && typeof pVal === 'number')
          ? Math.abs(hVal - pVal) : null,
      })
    }
  }

  for (const { hKey, pKey, loc } of EXACT_PAIRS) {
    const hVal = harvest.result[hKey]
    const pVal = (loc === 'model_input') ? prodModelInput?.[pKey] : prodLambda?.[pKey]
    // leash_flag may come back as 0/1 from JSON; normalize to bool
    const hNorm = (hKey === 'leashFlag') ? !!hVal : hVal
    const pNorm = (pKey === 'leash_flag') ? !!pVal : pVal
    if (hNorm !== pNorm) {
      mismatches.push({ field: hKey, production_logged_as: pKey, expected: pVal, actual: hVal })
    }
  }

  return { match: mismatches.length === 0, mismatch_fields: mismatches }
}

// ────────────────────────────────────────────────────────────────────────
// Per-fixture builder
// ────────────────────────────────────────────────────────────────────────

async function buildFixtureFromCandidate(row, mlMeta) {
  const harvest = await harvestLayer1MathFixture({
    pitcher_id: row.pitcher_id,
    bet_date: row.bet_date,
  })

  const prodLambda    = JSON.parse(row.lambda_calc_json ?? '{}')
  const prodModelInput = JSON.parse(row.model_input_json ?? '{}')

  const cross = crossCheck(harvest, prodLambda, prodModelInput)

  if (!cross.match && !ALLOW_PROD_MISMATCH) {
    const detail = cross.mismatch_fields.map(m =>
      `  ${m.field} (logged as ${m.production_logged_as}): expected=${JSON.stringify(m.expected)} actual=${JSON.stringify(m.actual)}` +
      (m.abs_diff != null ? ` abs_diff=${m.abs_diff}` : '')
    ).join('\n')
    const err = new Error(
      `Cross-check failed for pitcher_id=${row.pitcher_id} bet_date=${row.bet_date}\n${detail}\n\n` +
      `Use --allow-prod-mismatch to record this fixture with production_match=false.`
    )
    err.crossCheckFailed = true
    throw err
  }

  const nb_r = archetypeR(harvest.inputs.savant)
  const nb_r_source =
    harvest.inputs.savant?.nb_r != null     ? 'fitted'
    : harvest.inputs.savant?.k_pct != null  ? 'archetype_kpct'
    : 'global_default'

  // Use production-logged lambda_final as the anchor for per-strike probabilities.
  // Layer 1 v1.0 must reproduce lambda_final from lambda_base × outer chain;
  // when it does, the per-strike probs computed here will match Layer 1's.
  const lambdaFinal = prodLambda.lambda_final
  const probAtLeastByStrike = {}
  for (const k of STRIKES) {
    probAtLeastByStrike[String(k)] =
      Number.isFinite(lambdaFinal)
        ? Math.max(0, 1 - nbCDF(lambdaFinal, nb_r, k - 1))
        : null
  }

  return {
    fixture_id: `${row.pitcher_id}_${row.bet_date}`,
    fixture_built_at: new Date().toISOString(),
    source: 'decision_pipeline_plus_harvest_helper',
    production_row_id: Number(row.id),
    production_match: cross.match,
    mismatch_reason: cross.match ? null : 'data_drift_likely',
    mismatch_fields: cross.mismatch_fields,

    // ML versioning — fail parity test if hash drifts
    pk_ridge_weights_hash: mlMeta.hash,
    pk_ridge_weights_trained_at: mlMeta.trained_at,

    // Pitcher / game metadata
    pitcher_id:    String(row.pitcher_id),
    pitcher_name:  row.pitcher_name,
    bet_date:      row.bet_date,
    game_id:       row.game_id,
    game_label:    row.game_label,
    pitcher_side:  row.pitcher_side,

    // Layer 1 inputs (replayable)
    inputs: {
      log:              harvest.inputs.log,
      gameDate:         harvest.inputs.gameDate,
      savant:           harvest.inputs.savant,
      career:           harvest.inputs.career,
      recentStartsData: harvest.inputs.recentStartsData,
      careerAvgFbVelo:  harvest.inputs.careerAvgFbVelo,
    },
    snapshot_taken_at: harvest.snapshot_taken_at,

    // Inner expected output (computeLambdaBase return — Layer 1 v1.0 must match exactly)
    expected_inner: harvest.result,

    // Outer chain — production-logged values (NOT recomputed by harvester).
    // Layer 1 v1.0's outer chain implementation must reproduce lambda_final
    // when given expected_inner.lambdaBase + these multiplier inputs.
    expected_outer_chain_from_production: {
      split_adj:       prodLambda.split_adj,
      opp_adj:         prodLambda.opp_adj,
      raw_adj_factor:  prodLambda.raw_adj_factor,
      park_factor:     prodLambda.park_factor,
      park_team:       prodLambda.park_team,
      weather_mult:    prodLambda.weather_mult,
      weather_note:    prodLambda.weather_note,
      ump_factor:      prodLambda.ump_factor,
      ump_name:        prodLambda.ump_name,
      lambda_final:    prodLambda.lambda_final,
    },

    // Per-strike (Layer 1 owns this math)
    expected_nb_r:        nb_r,
    expected_nb_r_source: nb_r_source,
    expected_prob_at_least_by_strike: probAtLeastByStrike,

    // Production-logged supplementary inputs (for diagnostic context only)
    production_model_input: {
      opp_team:        prodModelInput.opp_team,
      opp_k_pct:       prodModelInput.opp_k_pct,
      opp_kpct_source: prodModelInput.opp_kpct_source,
      hand:            prodModelInput.hand,
      n_starts:        prodModelInput.n_starts,
      bf_source:       prodModelInput.bf_source,
      confidence:      prodModelInput.confidence,
      velo_trend_mph:  prodModelInput.velo_trend_mph,
    },
  }
}

// ────────────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────────────

async function sha256File(filepath) {
  return crypto.createHash('sha256').update(await fs.readFile(filepath)).digest('hex')
}

async function loadMlMeta() {
  const hash = await sha256File(WEIGHTS_PATH)
  const obj  = JSON.parse(await fs.readFile(WEIGHTS_PATH, 'utf-8'))
  return { hash, trained_at: obj.trained_at }
}

async function main() {
  console.log(`[harvest] mode: ${ALLOW_PROD_MISMATCH ? 'ALLOW_MISMATCH' : 'STRICT'}`)
  console.log(`[harvest] candidate window: bet_date >= ${SINCE}`)
  console.log(`[harvest] target per archetype: ${TARGET_PER_ARCHETYPE}`)

  const mlMeta = await loadMlMeta()
  console.log(`[harvest] pk_ridge_weights hash: ${mlMeta.hash.slice(0, 12)}... trained_at=${mlMeta.trained_at}`)

  const candidates = await db.all(
    `SELECT id, bet_date, pitcher_id, pitcher_name, game_id, game_label, pitcher_side,
            lambda_calc_json, model_input_json
       FROM decision_pipeline
      WHERE lambda_calc_json IS NOT NULL
        AND model_input_json IS NOT NULL
        AND bet_date >= ?
      ORDER BY bet_date DESC, pitcher_id ASC`,
    [SINCE],
  )
  console.log(`[harvest] candidates: ${candidates.length}`)
  if (candidates.length === 0) {
    throw new Error('No candidates found in decision_pipeline. Check SINCE filter.')
  }

  const archetypeBuckets = new Map(ARCHETYPES.map(a => [a.id, []]))
  const skipReasons = []

  for (const cand of candidates) {
    const allFull = ARCHETYPES.every(a => archetypeBuckets.get(a.id).length >= TARGET_PER_ARCHETYPE)
    if (allFull) break

    let fixture
    try {
      fixture = await buildFixtureFromCandidate(cand, mlMeta)
    } catch (err) {
      // STRICT: any cross-check failure is a hard fail. Don't continue silently.
      if (err.crossCheckFailed && !ALLOW_PROD_MISMATCH) {
        console.error(`[harvest] HARD FAIL — first cross-check failure:\n${err.message}`)
        throw err
      }
      // Other errors (DB problems, missing data, etc.): log and skip this candidate.
      // These are NOT cross-check failures — they're data-availability issues.
      const reason = err.message?.slice(0, 200) ?? 'unknown'
      skipReasons.push({ pitcher_id: cand.pitcher_id, bet_date: cand.bet_date, reason })
      console.warn(`[harvest] skip ${cand.pitcher_name} ${cand.bet_date}: ${reason}`)
      continue
    }

    // Classify into the first matching archetype with room
    let assigned = null
    for (const arch of ARCHETYPES) {
      const bucket = archetypeBuckets.get(arch.id)
      if (bucket.length >= TARGET_PER_ARCHETYPE) continue
      const ctx = { modelInput: fixture.production_model_input }
      if (arch.classify(fixture, ctx)) {
        bucket.push({ ...fixture, archetype: arch.id })
        assigned = arch.id
        break
      }
    }
    if (assigned) {
      console.log(`[harvest]   ✓ ${assigned.padEnd(28)} ${cand.pitcher_name} ${cand.bet_date}`)
    }
  }

  // Coverage report
  const coverage = ARCHETYPES.map(a => ({
    id:      a.id,
    desc:    a.desc,
    count:   archetypeBuckets.get(a.id).length,
    target:  TARGET_PER_ARCHETYPE,
    partial: archetypeBuckets.get(a.id).length < TARGET_PER_ARCHETYPE,
  }))

  console.log('\n[harvest] coverage:')
  for (const c of coverage) {
    const status = c.partial ? '⚠ partial' : '✓'
    console.log(`  ${status.padEnd(11)} ${c.id.padEnd(28)} ${c.count}/${c.target}`)
  }

  const allFixtures = []
  for (const a of ARCHETYPES) allFixtures.push(...archetypeBuckets.get(a.id))

  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true })
  const output = {
    schema_version:  '1.0.0',
    generated_at:    new Date().toISOString(),
    pk_ridge_weights_hash:        mlMeta.hash,
    pk_ridge_weights_trained_at:  mlMeta.trained_at,
    cross_check_mode: ALLOW_PROD_MISMATCH ? 'allow_mismatch' : 'strict',
    since_filter:    SINCE,
    target_per_archetype: TARGET_PER_ARCHETYPE,
    coverage,
    skip_count:      skipReasons.length,
    skip_reasons:    skipReasons.slice(0, 25),  // first 25 for diagnostic
    archetypes_targeted: ARCHETYPES.map(a => ({ id: a.id, desc: a.desc })),
    fixtures: allFixtures,
  }
  await fs.writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2))

  console.log(`\n[harvest] wrote ${OUTPUT_PATH}`)
  console.log(`[harvest] total fixtures: ${allFixtures.length}`)
  console.log(`[harvest] candidates skipped: ${skipReasons.length}`)

  const partials = coverage.filter(c => c.partial)
  if (partials.length > 0) {
    console.log(`\n[harvest] WARN: ${partials.length} archetype(s) have partial coverage.`)
    console.log('  Options:')
    console.log('    (a) widen --since window to find more candidates')
    console.log('    (b) accept partial coverage if archetype is rare')
  }
}

main().catch(err => {
  console.error('[harvest] FATAL:', err.message)
  if (err.stack) console.error(err.stack)
  process.exit(1)
})
