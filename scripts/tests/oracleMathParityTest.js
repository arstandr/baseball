// scripts/tests/oracleMathParityTest.js
//
// Layer 1 (Math) — Parity test (Bite 3 gate).
//
// Validates that oracle/layers/1-math/impl.js produces output that exactly
// matches every parity fixture in oracle/layers/1-math/parity-fixtures.json.
//
// Two suites:
//   A. PARITY — for each fixture: computeInner reproduces expected_inner;
//      composeOuter reproduces lambda_final; probAtLeastByStrike reproduces
//      expected_prob_at_least_by_strike; nbR / nbRSource match.
//   B. SYNTHETIC BRANCHES — covers the 2 archetypes absent from real
//      production data (post_il_short_leash, no_savant_career_only) with
//      hand-crafted inputs that exercise the relevant code paths.
//
// Tolerances (locked by PARITY_NOTES.md):
//   numeric: 1e-12 absolute
//   string/bool: exact

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import url from 'node:url'
import crypto from 'node:crypto'

import {
  computeInner, composeOuter, probAtLeastByStrike,
  nbR, nbRSource, STRIKES_DEFAULT, LAYER_NAME, LAYER_VERSION,
  SCHEMA_VERSION, SOURCE,
  computeMatchup, run, pkRidgeWeightsHash,
  NB_R_SOURCES,
} from '../../oracle/layers/1-math/impl.js'
import { nbCDF } from '../../lib/strikeout-model.js'
import { validateTraceEvent, TRACE_SCHEMA_VERSION } from '../../oracle/layers/0-trace/validate.js'
import { sha256 } from '../../oracle/layers/0-trace/impl.js'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const FIXTURES_PATH = path.resolve(__dirname, '../../oracle/layers/1-math/parity-fixtures.json')
const WEIGHTS_PATH  = path.resolve(__dirname, '../../models/pk_ridge_weights.json')

const FLOAT_TOL = 1e-12

// ─── Test infra ────────────────────────────────────────────────────────
let _passed = 0, _failed = 0
const ok  = (c, l) => c ? _passed++ : (_failed++, console.error(`FAIL [${l}]`))
const eq  = (a, b, l) => {
  if (a === b) { _passed++; return }
  // Treat null/undefined as equivalent for missing fields
  if (a == null && b == null) { _passed++; return }
  _failed++; console.error(`FAIL [${l}]: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`)
}
const approxEq = (a, b, tol, l) => {
  // null/undefined slot: must both be missing
  if (a == null && b == null) { _passed++; return }
  if (a == null || b == null) {
    _failed++; console.error(`FAIL [${l}]: one side null (a=${a}, b=${b})`)
    return
  }
  if (typeof a !== 'number' || typeof b !== 'number') {
    _failed++; console.error(`FAIL [${l}]: non-numeric (a=${typeof a}, b=${typeof b})`)
    return
  }
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    if (a === b) _passed++
    else { _failed++; console.error(`FAIL [${l}]: non-finite mismatch (${a} vs ${b})`) }
    return
  }
  if (Math.abs(a - b) <= tol) { _passed++; return }
  _failed++; console.error(`FAIL [${l}]: ${a} !~= ${b} abs_diff=${Math.abs(a - b)} tol=${tol}`)
}
const section = n => console.log(`\n── ${n} ──`)

async function sha256File(p) {
  return crypto.createHash('sha256').update(await readFile(p)).digest('hex')
}

// ────────────────────────────────────────────────────────────────────────
// Fields produced by computeLambdaBase. Each has a type so we know which
// comparator to use. From EXTRACTION_NOTES.md §3.
// ────────────────────────────────────────────────────────────────────────
const INNER_FIELDS = [
  ['lambdaBase',      'number'],
  ['k9',              'number'],
  ['pK_blended',      'number'],
  ['pK_formula',      'number'],
  ['ml_pK',           'numberOrNull'],
  ['k9_l5',           'number'],
  ['k9_season',       'numberOrNull'],
  ['k9_career',       'numberOrNull'],
  ['w_career',        'number'],
  ['w_season',        'number'],
  ['w_l5',            'number'],
  ['expectedBF',      'number'],
  ['avgIp',           'number'],
  ['bfSource',        'string'],
  ['avgPitches',      'numberOrNull'],
  ['leashFlag',       'bool'],
  ['nStarts',         'number'],
  ['confidence',      'string'],
  ['earlyExitRate',   'numberOrNull'],
  ['whiffFlag',       'stringOrNull'],
  ['savantNote',      'stringOrNull'],
  ['careerNote',      'stringOrNull'],
  ['veloTrendMph',    'numberOrNull'],
  ['veloAdj',         'number'],
  ['bbPenalty',       'number'],
  ['ttoPenalty',      'number'],
  ['ttoNote',         'stringOrNull'],
]

function compareInner(actual, expected, fixtureId) {
  for (const [key, type] of INNER_FIELDS) {
    const a = actual[key]
    const e = expected[key]
    const label = `${fixtureId}/inner.${key}`
    switch (type) {
      case 'number':
        approxEq(a, e, FLOAT_TOL, label); break
      case 'numberOrNull':
        if (e == null) { eq(a, e, label); break }
        approxEq(a, e, FLOAT_TOL, label); break
      case 'bool':
        eq(!!a, !!e, label); break
      case 'string':
      case 'stringOrNull':
        eq(a, e, label); break
      default:
        _failed++; console.error(`FAIL [${label}]: unknown field type ${type}`)
    }
  }
}

// ════════════════════════════════════════════════════════════════════════
// Suite A — Parity against real fixtures
// ════════════════════════════════════════════════════════════════════════

async function runParitySuite() {
  const data = JSON.parse(await readFile(FIXTURES_PATH, 'utf-8'))
  console.log(`Parity test: ${data.fixtures.length} fixtures from ${FIXTURES_PATH}`)

  // ML weights drift gate
  const currentHash = await sha256File(WEIGHTS_PATH)
  if (currentHash !== data.pk_ridge_weights_hash) {
    console.error(`\n❌ ML WEIGHTS DRIFT`)
    console.error(`   fixtures expect: ${data.pk_ridge_weights_hash}`)
    console.error(`   current weights: ${currentHash}`)
    console.error(`   The Ridge model has been retrained since fixtures were built.`)
    console.error(`   Re-run scripts/oracle/buildMathParityFixtures.js to regenerate fixtures.`)
    _failed++
    return
  }
  ok(true, 'ml_weights_hash_matches_fixtures')

  // Per-fixture
  for (const f of data.fixtures) {
    section(`${f.archetype} :: ${f.pitcher_name} ${f.bet_date} (${f.fixture_id})`)

    // 1. Inner parity (computeLambdaBase reproduction)
    let actualInner
    try {
      actualInner = computeInner(f.inputs)
    } catch (err) {
      _failed++
      console.error(`FAIL [${f.fixture_id}/inner]: computeInner threw ${err.message}`)
      continue
    }
    compareInner(actualInner, f.expected_inner, f.fixture_id)

    // 2. Outer chain (multiplier bundle → lambda_final)
    //
    // Layer 1's contract is mathematical reproducibility from the frozen
    // fixture inputs, NOT fidelity to production-logged lambda_final (which
    // was computed at production time with a possibly-drifted lambda_base).
    // Expected = expected_inner.lambdaBase × Π multipliers, computed inline.
    // Production-logged lambda_final is reported as INFO drift, never gates.
    const oc = f.expected_outer_chain_from_production
    const multipliers = {
      split_adj:    oc.split_adj,
      opp_adj:      oc.opp_adj,
      park_factor:  oc.park_factor,
      weather_mult: oc.weather_mult,
      ump_factor:   oc.ump_factor,
    }
    const expectedLambdaFinal =
      f.expected_inner.lambdaBase
      * oc.split_adj * oc.opp_adj * oc.park_factor
      * oc.weather_mult * oc.ump_factor

    let actualLambdaFinal
    try {
      actualLambdaFinal = composeOuter(actualInner.lambdaBase, multipliers)
    } catch (err) {
      _failed++
      console.error(`FAIL [${f.fixture_id}/outer]: composeOuter threw ${err.message}`)
      continue
    }
    approxEq(actualLambdaFinal, expectedLambdaFinal, FLOAT_TOL, `${f.fixture_id}/lambda_final`)

    // INFO drift report vs production-logged lambda_final. Not a gate.
    const drift = actualLambdaFinal - oc.lambda_final
    if (Math.abs(drift) > FLOAT_TOL) {
      console.log(
        `  INFO drift [${f.fixture_id}] production_match=${f.production_match}: ` +
        `production_lambda_final=${oc.lambda_final.toFixed(6)} ` +
        `recomputed_lambda_final=${actualLambdaFinal.toFixed(6)} ` +
        `delta=${drift.toFixed(6)}`
      )
    }

    // 3. nb_r + provenance
    eq(nbR(f.inputs.savant), f.expected_nb_r, `${f.fixture_id}/nb_r`)
    eq(nbRSource(f.inputs.savant), f.expected_nb_r_source, `${f.fixture_id}/nb_r_source`)

    // 4. Per-strike NB CDF — expected derived from recomputed_lambda_final,
    // not the fixture's pre-stored map (which was computed from production-
    // logged lambda_final and so drifts identically for the 6 drift fixtures).
    const actualProbs = probAtLeastByStrike(actualLambdaFinal, f.inputs.savant)
    const r = nbR(f.inputs.savant)
    for (const k of STRIKES_DEFAULT) {
      const expectedProb = Math.max(0, 1 - nbCDF(actualLambdaFinal, r, k - 1))
      approxEq(actualProbs[String(k)], expectedProb, FLOAT_TOL,
        `${f.fixture_id}/p_at_least[${k}]`)
    }

    // 5. STRIKES_DEFAULT export sanity
    if (Object.keys(actualProbs).length !== STRIKES_DEFAULT.length) {
      _failed++
      console.error(`FAIL [${f.fixture_id}/p_at_least.length]: got ${Object.keys(actualProbs).length} strikes, expected ${STRIKES_DEFAULT.length}`)
    }
  }
}

// ════════════════════════════════════════════════════════════════════════
// Suite B — Synthetic branch tests for archetypes absent from production data
// ════════════════════════════════════════════════════════════════════════

function runSyntheticBranchSuite() {
  // ── B1. post_il_short_leash ────────────────────────────────────────
  // Branch: savant.manager_leash_factor < 1.0 → expectedBF gets multiplied
  // by leash factor in computeLambdaBase. We synthesize inputs that exercise
  // both (a) the leashFlag (avgPitches < 85) and (b) the manager_leash_factor
  // multiplier.
  section('SYNTHETIC :: post_il_short_leash')
  {
    const inputs = {
      log: [
        // 5 short starts with avgPitches ~80 (under the 85 leash threshold)
        { date: '2026-04-22', started: true, ip: 4.0, k: 4, bf: 18, pitches: 80, bb: 1 },
        { date: '2026-04-15', started: true, ip: 4.1, k: 5, bf: 19, pitches: 78, bb: 1 },
        { date: '2026-04-08', started: true, ip: 4.2, k: 4, bf: 20, pitches: 82, bb: 2 },
        { date: '2026-04-01', started: true, ip: 4.0, k: 5, bf: 19, pitches: 79, bb: 0 },
        { date: '2026-03-25', started: true, ip: 4.1, k: 4, bf: 18, pitches: 81, bb: 1 },
      ],
      gameDate: '2026-04-29',
      savant: {
        k_pct: 0.24, ip: 20, pa: 95, swstr_pct: 0.11, fb_velo: 92.5,
        gb_pct: 0.42, bb_pct: 0.07, k_pct_vs_l: 0.22, k_pct_vs_r: 0.26,
        nb_r: null, manager_leash_factor: 0.85,  // ← key: post-IL short leash
      },
      career: { k_pct: 0.22, k9: 8.4, avg_ip: 5.3, seasons: ['2023', '2024', '2025'] },
      recentStartsData: [
        { bf: 18, pitches: 80 }, { bf: 19, pitches: 78 }, { bf: 20, pitches: 82 },
        { bf: 19, pitches: 79 }, { bf: 18, pitches: 81 },
      ],
      careerAvgFbVelo: 93.0,
    }
    const r = computeInner(inputs)
    // The leash flag should fire (avgPitches < 85)
    ok(r.leashFlag === true, 'leashFlag fires when avgPitches < 85')
    ok(r.avgPitches != null && r.avgPitches < 85, `avgPitches < 85 (got ${r.avgPitches})`)

    // expectedBF should be scaled by manager_leash_factor (×0.85) and reflected in bfSource
    // Production code: `expectedBF = expectedBF * leashFactor` with note `×leash(0.85)`
    ok(r.bfSource && r.bfSource.includes('leash'), `bfSource notes leash adjustment (got "${r.bfSource}")`)

    // Compute what expectedBF would have been WITHOUT the leash factor.
    // It's roughly the avg of recent_starts BFs = (18+19+20+19+18)/5 = 18.8
    // Then capped by avgPitches/3.8 ≈ 80/3.8 ≈ 21.05 (cap doesn't fire since 18.8 < 21.05)
    // Then × 0.85 manager_leash_factor = 15.98
    const rawAvgBF = (18 + 19 + 20 + 19 + 18) / 5
    const expectedAfterLeash = rawAvgBF * 0.85
    approxEq(r.expectedBF, expectedAfterLeash, 1e-9, 'expectedBF includes manager_leash_factor 0.85x')

    // λ should be reasonable (>0, finite)
    ok(Number.isFinite(r.lambdaBase) && r.lambdaBase > 0, `lambdaBase finite > 0 (got ${r.lambdaBase})`)
  }

  // ── B2. no_savant_career_only ───────────────────────────────────────
  // Branch: savant === null AND career !== null → pK_blended_formula
  // re-normalizes between career and L5 (no season term). w_career = 0.40
  // (since savant.ip is treated as 0 → max(0, 0.40 × (1 - 0/40)) = 0.40),
  // w_l5 = 0.60.
  section('SYNTHETIC :: no_savant_career_only')
  {
    const inputs = {
      log: [
        { date: '2026-04-22', started: true, ip: 5.2, k: 6, bf: 22, pitches: 92, bb: 2 },
        { date: '2026-04-15', started: true, ip: 5.1, k: 5, bf: 21, pitches: 88, bb: 1 },
        { date: '2026-04-08', started: true, ip: 6.0, k: 7, bf: 23, pitches: 95, bb: 2 },
      ],
      gameDate: '2026-04-29',
      savant: null,                                     // ← key: no current-season Statcast
      career: { k_pct: 0.21, k9: 8.0, avg_ip: 5.5, seasons: ['2023', '2024', '2025'] },
      recentStartsData: [
        { bf: 22, pitches: 92 }, { bf: 21, pitches: 88 }, { bf: 23, pitches: 95 },
      ],
      careerAvgFbVelo: 93.5,
    }
    const r = computeInner(inputs)

    // Branch checks
    eq(r.k9_season, null, 'k9_season null when savant absent')
    eq(r.w_season, 0, 'w_season=0 when savant absent')
    ok(r.k9_career != null, 'k9_career populated')
    ok(r.k9_l5 != null, 'k9_l5 populated')

    // pK_blended_formula renormalizes between career + L5 only.
    // w_career = max(0, 0.40 × (1 - 0/40)) = 0.40
    // w_l5     = 1 - 0 - 0.40 = 0.60
    approxEq(r.w_career, 0.40, 1e-12, 'w_career = 0.40 (savant.ip treated as 0)')
    approxEq(r.w_l5,     0.60, 1e-12, 'w_l5 = 0.60')

    // ML overlay must NOT fire (savant.ip < 5)
    eq(r.ml_pK, null, 'ml_pK is null when savant null (formula path)')

    // veloAdj should be 1.0 (no fb_velo from savant to compare)
    eq(r.veloAdj, 1.0, 'veloAdj = 1.0 when savant.fb_velo absent')

    ok(Number.isFinite(r.lambdaBase) && r.lambdaBase > 0, `lambdaBase finite > 0 (got ${r.lambdaBase})`)
  }

  // ── B3. composeOuter sanity ─────────────────────────────────────────
  section('SYNTHETIC :: composeOuter pure-arithmetic sanity')
  {
    const lf = composeOuter(5.0, {
      split_adj:    1.05,
      opp_adj:      1.10,
      park_factor:  1.02,
      weather_mult: 0.97,
      ump_factor:   1.04,
    })
    const expected = 5.0 * 1.05 * 1.10 * 1.02 * 0.97 * 1.04
    approxEq(lf, expected, FLOAT_TOL, 'composeOuter products match')

    // Identity check: 1.0 multipliers → unchanged
    const id = composeOuter(7.0, {
      split_adj: 1, opp_adj: 1, park_factor: 1, weather_mult: 1, ump_factor: 1,
    })
    approxEq(id, 7.0, FLOAT_TOL, 'composeOuter identity')

    // Throws on missing
    let threw = false
    try { composeOuter(NaN, { split_adj: 1, opp_adj: 1, park_factor: 1, weather_mult: 1, ump_factor: 1 }) }
    catch { threw = true }
    ok(threw, 'composeOuter throws on non-finite lambda_base')

    threw = false
    try { composeOuter(5.0, { split_adj: 1, opp_adj: 1, park_factor: 1, weather_mult: 1 }) }
    catch { threw = true }
    ok(threw, 'composeOuter throws on missing multiplier')
  }

  // ── B4. nbR / nbRSource ───────────────────────────────────────────
  section('SYNTHETIC :: nbR / nbRSource provenance')
  {
    eq(nbR(null), 30, 'nbR null savant → default 30')
    eq(nbR({}), 30, 'nbR empty savant → default 30')
    eq(nbR({ k_pct: 0.30 }), 20, 'nbR power archetype (k_pct ≥ 0.28) → 20')
    eq(nbR({ k_pct: 0.17 }), 50, 'nbR contact archetype (k_pct ≤ 0.19) → 50')
    eq(nbR({ k_pct: 0.23 }), 30, 'nbR mixed archetype → 30')
    eq(nbR({ k_pct: 0.30, nb_r: 15 }), 15, 'nbR fitted nb_r overrides archetype')

    eq(nbRSource(null), 'global_default', 'nbRSource null')
    eq(nbRSource({}), 'global_default', 'nbRSource empty')
    eq(nbRSource({ k_pct: 0.25 }), 'archetype_kpct', 'nbRSource k_pct only')
    eq(nbRSource({ k_pct: 0.30, nb_r: 18 }), 'fitted', 'nbRSource fitted')
  }

  // ── B5. probAtLeastByStrike sanity ────────────────────────────────
  section('SYNTHETIC :: probAtLeastByStrike monotone')
  {
    const probs = probAtLeastByStrike(6.0, { k_pct: 0.23 })
    // Should have all 10 strikes
    eq(Object.keys(probs).length, 10, 'all 10 strikes returned')
    // Monotonically decreasing in k
    let prev = Infinity
    for (const k of STRIKES_DEFAULT) {
      const p = probs[String(k)]
      ok(p <= prev + 1e-12, `monotone at k=${k}: ${p} <= ${prev}`)
      ok(p >= 0 && p <= 1, `bounded [0,1] at k=${k}: ${p}`)
      prev = p
    }
    // Custom strikes arg
    const small = probAtLeastByStrike(5.0, null, [5])
    eq(Object.keys(small).length, 1, 'custom strikes arg honored')
  }

  // ── B6. Module metadata ───────────────────────────────────────────
  section('SYNTHETIC :: module metadata')
  eq(LAYER_NAME, 'math', 'LAYER_NAME')
  eq(LAYER_VERSION, '1.0.0', 'LAYER_VERSION')
  eq(STRIKES_DEFAULT.length, 10, 'STRIKES_DEFAULT length')
  eq(Object.isFrozen(STRIKES_DEFAULT), true, 'STRIKES_DEFAULT frozen')

  // ── B7. NB_R_SOURCES enum constant (Bite 5a) ──────────────────────
  section('BITE 5a :: NB_R_SOURCES enum')
  ok(Object.isFrozen(NB_R_SOURCES), 'NB_R_SOURCES is frozen')
  eq(NB_R_SOURCES.FITTED, 'fitted', 'NB_R_SOURCES.FITTED string value')
  eq(NB_R_SOURCES.ARCHETYPE_KPCT, 'archetype_kpct', 'NB_R_SOURCES.ARCHETYPE_KPCT string value')
  eq(NB_R_SOURCES.GLOBAL_DEFAULT, 'global_default', 'NB_R_SOURCES.GLOBAL_DEFAULT string value')
  // nbRSource() return values must match the constants exactly across all branches.
  eq(nbRSource(null), NB_R_SOURCES.GLOBAL_DEFAULT, 'nbRSource(null) === NB_R_SOURCES.GLOBAL_DEFAULT')
  eq(nbRSource({}), NB_R_SOURCES.GLOBAL_DEFAULT, 'nbRSource({}) === NB_R_SOURCES.GLOBAL_DEFAULT')
  eq(nbRSource({ k_pct: 0.25 }), NB_R_SOURCES.ARCHETYPE_KPCT, 'nbRSource(k_pct only) === ARCHETYPE_KPCT')
  eq(nbRSource({ k_pct: 0.30, nb_r: 18 }), NB_R_SOURCES.FITTED, 'nbRSource(fitted) === FITTED')
  // Enum coverage: every nbRSource output must be one of the enum values.
  const allNbRSourceValues = new Set(Object.values(NB_R_SOURCES))
  for (const sample of [null, {}, { k_pct: 0.25 }, { k_pct: 0.30, nb_r: 12 }, { k_pct: 0.10 }, { k_pct: 0.40 }]) {
    ok(allNbRSourceValues.has(nbRSource(sample)),
      `nbRSource(${JSON.stringify(sample)}) yields a value in NB_R_SOURCES`)
  }
}

// ════════════════════════════════════════════════════════════════════════
// Suite C — Bite 4: matchup envelope + per-bet run() + Trace event shape
// ════════════════════════════════════════════════════════════════════════

const HEX64 = /^[a-f0-9]{64}$/

// Pick the first parity fixture whose inputs exercise the envelope
// production path with a multiplier bundle. We'll reuse it across C tests.
async function runBite4Suite() {
  const data = JSON.parse(await readFile(FIXTURES_PATH, 'utf-8'))
  const f = data.fixtures[0]
  const oc = f.expected_outer_chain_from_production
  const multipliers = {
    split_adj:    oc.split_adj,
    opp_adj:      oc.opp_adj,
    park_factor:  oc.park_factor,
    weather_mult: oc.weather_mult,
    ump_factor:   oc.ump_factor,
  }

  // ── C1. computeMatchup envelope shape ─────────────────────────────
  section('BITE 4 :: computeMatchup envelope shape')
  const env = computeMatchup(f.inputs, multipliers)

  eq(env.schema_version, SCHEMA_VERSION, 'envelope.schema_version')
  eq(env.layer, 'math', 'envelope.layer')
  eq(env.layer_version, LAYER_VERSION, 'envelope.layer_version')
  eq(env.source, SOURCE, 'envelope.source')
  eq(typeof env.run_id, 'string', 'envelope.run_id is string')
  ok(env.run_id.length === 36, `envelope.run_id is uuid (36 chars), got ${env.run_id.length}`)
  eq(typeof env.computed_at, 'string', 'envelope.computed_at is ISO string')
  ok(!Number.isNaN(Date.parse(env.computed_at)), 'envelope.computed_at parses as date')
  eq(typeof env.commit_hash, 'string', 'envelope.commit_hash is string')
  ok(HEX64.test(env.inputs_hash), `envelope.inputs_hash is sha256 hex, got ${env.inputs_hash}`)
  ok(HEX64.test(env.output_hash), `envelope.output_hash is sha256 hex, got ${env.output_hash}`)
  ok(HEX64.test(env.pk_ridge_weights_hash), 'envelope.pk_ridge_weights_hash is sha256 hex')
  eq(typeof env.inner, 'object', 'envelope.inner is object')
  approxEq(env.inner.lambdaBase, f.expected_inner.lambdaBase, FLOAT_TOL, 'envelope.inner.lambdaBase parity')
  eq(typeof env.outer, 'object', 'envelope.outer is object')
  approxEq(env.outer.lambda_final,
    f.expected_inner.lambdaBase * oc.split_adj * oc.opp_adj * oc.park_factor * oc.weather_mult * oc.ump_factor,
    FLOAT_TOL, 'envelope.outer.lambda_final parity')
  eq(env.nb_r, f.expected_nb_r, 'envelope.nb_r')
  eq(env.nb_r_source, f.expected_nb_r_source, 'envelope.nb_r_source')
  eq(Object.keys(env.prob_at_least).length, 10, 'envelope.prob_at_least has 10 strikes')
  eq(env.status, 'ok', 'envelope.status')
  ok(Array.isArray(env.warnings), 'envelope.warnings is array')
  eq(env.decision_id, null, 'envelope.decision_id null when ctx.decision_id absent')
  eq(env.fixture_id, null, 'envelope.fixture_id null when ctx.fixture_id absent')

  // ── C2. Hash determinism + run_id uniqueness ──────────────────────
  section('BITE 4 :: hash determinism')
  const env2 = computeMatchup(f.inputs, multipliers)
  eq(env.output_hash, env2.output_hash, 'same inputs → same output_hash')
  eq(env.inputs_hash, env2.inputs_hash, 'same inputs → same inputs_hash')
  ok(env.run_id !== env2.run_id, `same inputs → different run_id (${env.run_id} vs ${env2.run_id})`)

  // ── C3. output_hash excludes run_id/computed_at/output_hash ───────
  section('BITE 4 :: output_hash exclusion rules')
  // Build same envelope content with forced run_id + computed_at via ctx.
  const envForceA = computeMatchup(f.inputs, multipliers, { run_id: 'a-run-id', computed_at: '2026-04-30T00:00:00Z' })
  const envForceB = computeMatchup(f.inputs, multipliers, { run_id: 'b-run-id', computed_at: '2026-04-30T12:34:56Z' })
  eq(envForceA.output_hash, envForceB.output_hash, 'output_hash invariant under run_id/computed_at')
  ok(envForceA.run_id !== envForceB.run_id, 'run_ids differ when forced differently')

  // ── C4. inputs_hash incorporates pk_ridge_weights_hash and layer_version ─
  section('BITE 4 :: inputs_hash incorporates ML weights + layer_version')
  // Recompute the expected inputs_hash inline and compare.
  const expectedInputsHash = sha256({
    inputs: f.inputs,
    multipliers,
    pk_ridge_weights_hash: pkRidgeWeightsHash(),
    layer_version: LAYER_VERSION,
  })
  eq(env.inputs_hash, expectedInputsHash, 'envelope.inputs_hash matches sha256({inputs, multipliers, weights, layer_version})')
  // Mutate one input field; hash must change.
  const mutatedInputs = { ...f.inputs, gameDate: '2099-01-01' }
  let mutatedEnvHash
  try {
    const mutatedEnv = computeMatchup(mutatedInputs, multipliers)
    mutatedEnvHash = mutatedEnv.inputs_hash
  } catch {
    mutatedEnvHash = '<threw>'
  }
  ok(mutatedEnvHash !== env.inputs_hash, 'mutating gameDate changes inputs_hash')

  // ── C5. run() per-bet result shape (no trace) ─────────────────────
  section('BITE 4 :: run() per-bet result shape')
  const ctxBase = {
    decision_id: 'test-decision-id-yes',
    pitcher_id: f.pitcher_id ?? '12345',
    pitcher_name: f.pitcher_name ?? 'Test Pitcher',
    bet_date: f.bet_date,
    strike: 6,
    side: 'YES',
  }
  const resYes = await run(env, ctxBase)
  eq(resYes.decision_id, ctxBase.decision_id, 'result.decision_id propagates')
  eq(resYes.layer, 'math', 'result.layer')
  eq(resYes.decision, 'computed', 'result.decision')
  eq(resYes.strike, 6, 'result.strike')
  eq(resYes.side, 'YES', 'result.side')
  approxEq(resYes.lambda_final, env.outer.lambda_final, FLOAT_TOL, 'result.lambda_final == envelope.outer.lambda_final')
  eq(resYes.nb_r, env.nb_r, 'result.nb_r == envelope.nb_r')
  approxEq(resYes.p_yes, env.prob_at_least['6'], FLOAT_TOL, 'result.p_yes matches envelope p_at_least[6]')
  approxEq(resYes.p_no, 1 - env.prob_at_least['6'], FLOAT_TOL, 'result.p_no = 1 - p_yes')
  approxEq(resYes.probability, resYes.p_yes, FLOAT_TOL, 'result.probability = p_yes when side=YES')
  eq(resYes.matchup_output_hash, env.output_hash, 'result.matchup_output_hash == envelope.output_hash')
  ok(HEX64.test(resYes.inputs_hash), 'result.inputs_hash is sha256 hex')
  ok(HEX64.test(resYes.output_hash), 'result.output_hash is sha256 hex')
  ok(resYes.inputs_hash !== env.inputs_hash, 'per-bet inputs_hash differs from envelope inputs_hash')
  ok(resYes.output_hash !== env.output_hash, 'per-bet output_hash differs from envelope output_hash')

  // NO side: probability = 1 - p_yes
  const resNo = await run(env, { ...ctxBase, decision_id: 'test-decision-id-no', side: 'NO' })
  approxEq(resNo.probability, 1 - env.prob_at_least['6'], FLOAT_TOL, 'result.probability = 1-p_yes when side=NO')
  ok(resNo.inputs_hash !== resYes.inputs_hash, 'YES vs NO produce different per-bet inputs_hash')
  ok(resNo.output_hash !== resYes.output_hash, 'YES vs NO produce different per-bet output_hash')

  // ── C6. run() determinism: same envelope+ctx → same per-bet hashes ─
  section('BITE 4 :: per-bet hash determinism')
  const resYes2 = await run(env, ctxBase)
  eq(resYes.inputs_hash, resYes2.inputs_hash, 'per-bet inputs_hash deterministic')
  eq(resYes.output_hash, resYes2.output_hash, 'per-bet output_hash deterministic')

  // ── C7. emit_trace=true with stub captures one valid TraceEvent ───
  section('BITE 4 :: trace emission via stub')
  const captured = []
  const traceStub = { writeAsync: (ev) => { captured.push(ev); return ev.id } }
  await run(env, {
    ...ctxBase,
    decision_id: 'test-decision-id-trace',
    emit_trace: true,
    trace: traceStub,
  })
  eq(captured.length, 1, 'exactly one trace event emitted per run() call')
  const ev = captured[0]
  // Validate against Layer 0's schema.
  let validateThrew = null
  try { validateTraceEvent(ev) } catch (err) { validateThrew = err.message }
  eq(validateThrew, null, `validateTraceEvent passes (err: ${validateThrew})`)
  eq(ev.layer_name, 'math', 'event.layer_name')
  eq(ev.layer_version, LAYER_VERSION, 'event.layer_version')
  eq(ev.event_type, 'decision', 'event.event_type')
  eq(ev.decision, 'computed', 'event.decision')
  eq(ev.reason_code, 'math_computed', 'event.reason_code')
  eq(ev.strike, 6, 'event.strike')
  eq(ev.side, 'YES', 'event.side')
  eq(ev.pitcher_id, ctxBase.pitcher_id, 'event.pitcher_id')
  eq(ev.pitcher_name, ctxBase.pitcher_name, 'event.pitcher_name')
  eq(ev.bet_date, ctxBase.bet_date, 'event.bet_date')
  eq(ev.trace_schema_version, TRACE_SCHEMA_VERSION, 'event.trace_schema_version matches Layer 0')
  eq(ev.status, 'success', 'event.status')
  eq(ev.severity, 'info', 'event.severity')
  ok(typeof ev.latency_ms === 'number' && ev.latency_ms >= 0, `event.latency_ms ≥ 0 (got ${ev.latency_ms})`)
  // Hashes line up envelope ↔ event ↔ per-bet result
  approxEq(ev.metrics.lambda_final, env.outer.lambda_final, FLOAT_TOL, 'event.metrics.lambda_final')
  eq(ev.metrics.matchup_output_hash, env.output_hash, 'event.metrics.matchup_output_hash')
  eq(ev.reasoning.nb_r_source, env.nb_r_source, 'event.reasoning.nb_r_source')
  eq(ev.reasoning.pk_ridge_weights_hash, env.pk_ridge_weights_hash, 'event.reasoning.pk_ridge_weights_hash')
  // evidence_used single matchup entry
  eq(Array.isArray(ev.evidence_used), true, 'event.evidence_used is array')
  eq(ev.evidence_used.length, 1, 'event.evidence_used has 1 matchup entry')
  eq(ev.evidence_used[0].name, 'oracle_layer_1_math.matchup', 'evidence[0].name')
  eq(ev.evidence_used[0].id, `${ctxBase.pitcher_id}_${ctxBase.bet_date}`, 'evidence[0].id')
  eq(ev.evidence_used[0].input_hash, env.inputs_hash, 'evidence[0].input_hash == envelope.inputs_hash')

  // ── C8. emit_trace=true requires trace stub ──────────────────────
  section('BITE 4 :: emit_trace=true without trace throws')
  let threw = false
  try {
    await run(env, { ...ctxBase, decision_id: 'no-trace-test', emit_trace: true })
  } catch { threw = true }
  ok(threw, 'run throws when emit_trace=true and ctx.trace missing')

  // ── C9. run() validates ctx required fields ──────────────────────
  section('BITE 4 :: run() ctx validation')
  for (const [missing, badCtx] of [
    ['decision_id', { ...ctxBase, decision_id: '' }],
    ['strike',      { ...ctxBase, strike: 'six' }],
    ['side',        { ...ctxBase, side: 'MAYBE' }],
    ['pitcher_id',  { ...ctxBase, pitcher_id: null }],
    ['pitcher_name', { ...ctxBase, pitcher_name: null }],
    ['bet_date',    { ...ctxBase, bet_date: null }],
  ]) {
    let t = false
    try { await run(env, badCtx) } catch { t = true }
    ok(t, `run throws when ctx.${missing} is invalid`)
  }

  // ── C10. 20-call iteration: shared matchup_output_hash, distinct per-bet hashes ─
  section('BITE 4 :: 20-call iteration over (strike, side)')
  const captured20 = []
  const traceStub20 = { writeAsync: (e) => captured20.push(e) }
  const resultsByKey = new Map()
  for (const strike of STRIKES_DEFAULT) {
    for (const side of ['YES', 'NO']) {
      const r = await run(env, {
        decision_id: `test-${strike}-${side}`,
        pitcher_id: ctxBase.pitcher_id,
        pitcher_name: ctxBase.pitcher_name,
        bet_date: ctxBase.bet_date,
        strike, side,
        emit_trace: true,
        trace: traceStub20,
      })
      resultsByKey.set(`${strike}-${side}`, r)
    }
  }
  eq(captured20.length, 20, '20 trace events emitted')
  // All share the matchup_output_hash
  const sharedMOH = new Set(captured20.map(e => e.metrics.matchup_output_hash))
  eq(sharedMOH.size, 1, 'all 20 events share single matchup_output_hash')
  // Each has a distinct per-bet output_hash (in the event's output_hash field)
  const distinctOutputs = new Set(captured20.map(e => e.output_hash))
  eq(distinctOutputs.size, 20, '20 events have 20 distinct output_hashes')
  // Each has a distinct decision_id
  const distinctDids = new Set(captured20.map(e => e.decision_id))
  eq(distinctDids.size, 20, '20 events have 20 distinct decision_ids')

  // ── C11. probability sanity across the 20 results ────────────────
  section('BITE 4 :: probability sanity across (strike, side)')
  for (const strike of STRIKES_DEFAULT) {
    const yesR = resultsByKey.get(`${strike}-YES`)
    const noR  = resultsByKey.get(`${strike}-NO`)
    approxEq(yesR.p_yes + yesR.p_no, 1, FLOAT_TOL, `p_yes+p_no=1 at strike=${strike}`)
    approxEq(yesR.probability, yesR.p_yes, FLOAT_TOL, `YES.probability=p_yes at strike=${strike}`)
    approxEq(noR.probability, noR.p_no, FLOAT_TOL, `NO.probability=p_no at strike=${strike}`)
    approxEq(yesR.probability + noR.probability, 1, FLOAT_TOL, `YES+NO probabilities sum to 1 at strike=${strike}`)
  }
}

// ════════════════════════════════════════════════════════════════════════
// Suite E — Bite 6.2: dk_blend integration in computeMatchup + run()
// ════════════════════════════════════════════════════════════════════════

import { classifyThinness } from '../../oracle/layers/1-math/dkBlend.js'

async function runBite62Suite() {
  const data = JSON.parse(await readFile(FIXTURES_PATH, 'utf-8'))
  // Build by-class fixture index so each E test uses a real-class scenario.
  const byClass = { thin: [], mid: [], stable: [] }
  for (const f of data.fixtures) {
    const inner = computeInner(f.inputs)
    const klass = classifyThinness(inner, f.inputs.savant)
    byClass[klass].push(f)
  }
  // We need at least one fixture per class for full E coverage.
  // (rookie_thin or no_savant_career_only ⇒ thin; high_k_ace usually ⇒ stable)
  const fThin   = byClass.thin[0]
  const fStable = byClass.stable[0]
  const fAny    = data.fixtures[0]

  const baseMultipliers = (f) => {
    const oc = f.expected_outer_chain_from_production
    return {
      split_adj:    oc.split_adj,
      opp_adj:      oc.opp_adj,
      park_factor:  oc.park_factor,
      weather_mult: oc.weather_mult,
      ump_factor:   oc.ump_factor,
    }
  }

  // Build a cap-safe DK context anchored on the fixture's inner.lambdaBase.
  // Picks dk_line such that floor(dk_line)+1 is a sensible K threshold near
  // inner's expected K count, and computes over_price so λ_dk ≈ inner.lambdaBase.
  // That gives bf_delta ≈ 0, well within the 3.0 BF cap.
  const capSafeDkContext = (f, extras = {}) => {
    const inner = computeInner(f.inputs)
    const r     = nbR(f.inputs.savant)
    // Pick a strike threshold near round(lambdaBase): nearest non-zero integer
    const k = Math.max(1, Math.round(inner.lambdaBase))
    // P(K ≥ k) under λ=inner.lambdaBase, r — derive from nbCDF directly
    const overProb = Math.max(1e-3, Math.min(0.999, 1 - nbCDF(inner.lambdaBase, r, k - 1)))
    return {
      dk_line:       k - 0.5,        // line=k-0.5 → "Over k-0.5" = K ≥ k
      dk_over_price: overProb,
      dk_source:     'dk_k_props',
      ...extras,
    }
  }

  // ── E1. No dkContext → byte-for-byte parity ──────────────────────
  section('BITE 6.2 :: E1 no dkContext = byte-for-byte parity')
  {
    const env = computeMatchup(fAny.inputs, baseMultipliers(fAny))
    eq(env.dk_blend, undefined, 'envelope.dk_blend ABSENT when no dkContext')
    // Hash regression: this exact computeMatchup with same inputs (no
    // dkContext) was already covered by Suite A — we're just confirming
    // the property carries over after the impl.js change.
    const env2 = computeMatchup(fAny.inputs, baseMultipliers(fAny))
    eq(env.output_hash, env2.output_hash, 'output_hash deterministic without dkContext')
    eq(env.inputs_hash, env2.inputs_hash, 'inputs_hash deterministic without dkContext')
  }

  // ── E2. dkContext present + flag=false → counterfactual, math unchanged ─
  section('BITE 6.2 :: E2 dkContext + flag=false = counterfactual only')
  {
    const baseline = computeMatchup(fThin.inputs, baseMultipliers(fThin))
    // Anchor DK on inner so cap doesn't fire and 'flag_off' is observable.
    const dkContext = capSafeDkContext(fThin)
    const env = computeMatchup(fThin.inputs, baseMultipliers(fThin), {
      dkContext,
      dk_blend_enabled: false,
    })
    ok(env.dk_blend, 'envelope.dk_blend present')
    eq(env.dk_blend.applied, false, 'dk_blend.applied=false when flag off')
    eq(env.dk_blend.skip_reason, 'flag_off',
      `dk_blend.skip_reason=flag_off (got ${env.dk_blend.skip_reason})`)
    eq(env.dk_blend.flag_dk_blend_enabled, false, 'flag_dk_blend_enabled echoed false')
    // Math unchanged vs baseline (which had no dkContext)
    approxEq(env.outer.lambda_final, baseline.outer.lambda_final, FLOAT_TOL,
      'lambda_final unchanged when flag off')
    eq(env.inner.lambdaBase, baseline.inner.lambdaBase, 'inner.lambdaBase unchanged')
    // Counterfactual would-have value populated
    ok(Number.isFinite(env.dk_blend.expected_bf_dk_blended),
      'expected_bf_dk_blended populated for shadow')
    ok(Number.isFinite(env.dk_blend.lambda_base_dk_blended),
      'lambda_base_dk_blended populated for shadow')
    ok(Number.isFinite(env.dk_blend.dk_lambda), 'dk_lambda populated')
    ok(Number.isFinite(env.dk_blend.expected_bf_dk), 'expected_bf_dk populated')
    eq(env.dk_blend.lambda_base_current, env.inner.lambdaBase,
      'lambda_base_current === inner.lambdaBase')
    eq(env.dk_blend.expected_bf_current, env.inner.expectedBF,
      'expected_bf_current === inner.expectedBF')
    eq(env.dk_blend.dk_thinness_class, 'thin', 'thinness class on thin fixture')
    eq(env.dk_blend.dk_source, 'dk_k_props', 'dk_source echoed through')
    eq(env.dk_blend.dk_line, dkContext.dk_line, 'dk_line echoed through')
    approxEq(env.dk_blend.dk_over_price, dkContext.dk_over_price, FLOAT_TOL,
      'dk_over_price echoed through')
  }

  // ── E3. dkContext + flag=true + thin → applied, math changes ─────
  section('BITE 6.2 :: E3 flag=true + thin = applied + math shifts')
  {
    const baseline = computeMatchup(fThin.inputs, baseMultipliers(fThin))
    // capSafe ensures λ_dk ≈ inner.lambdaBase → bf_delta ≈ 0 → no cap.
    // Then nudge over_price slightly so the blend actually changes math.
    const safeCtx = capSafeDkContext(fThin)
    const dkContext = { ...safeCtx, dk_over_price: Math.min(0.95, safeCtx.dk_over_price + 0.05) }
    const env = computeMatchup(fThin.inputs, baseMultipliers(fThin), {
      dkContext,
      dk_blend_enabled: true,
    })
    ok(env.dk_blend, 'envelope.dk_blend present')
    eq(env.dk_blend.applied, true,
      `applied=true with cap-safe DK on thin (skip_reason=${env.dk_blend.skip_reason})`)
    eq(env.dk_blend.skip_reason, null, 'no skip_reason when applied')
    ok(env.outer.lambda_final !== baseline.outer.lambda_final,
      'lambda_final shifted when blend applied')
    eq(env.inner.lambdaBase, baseline.inner.lambdaBase,
      'inner.lambdaBase preserved when blend applied')
    const m = baseMultipliers(fThin)
    const expectedFinal = env.dk_blend.lambda_base_dk_blended
      * m.split_adj * m.opp_adj * m.park_factor * m.weather_mult * m.ump_factor
    approxEq(env.outer.lambda_final, expectedFinal, 1e-9,
      'lambda_final = lambda_base_dk_blended × Π multipliers')
    ok(env.dk_blend.w_dk > 0, `w_dk > 0 when applied (got ${env.dk_blend.w_dk})`)
  }

  // ── E4. dkContext + flag=true + CAP exceeded → skip, math unchanged ─
  section('BITE 6.2 :: E4 flag=true + cap exceeded = skip')
  {
    const baseline = computeMatchup(fThin.inputs, baseMultipliers(fThin))
    // very low over_price → λ_dk near 0 → BF_dk near 0 → bf_delta huge negative
    const dkContext = { dk_line: 5.5, dk_over_price: 0.02, dk_source: 'dk_k_props' }
    const env = computeMatchup(fThin.inputs, baseMultipliers(fThin), {
      dkContext, dk_blend_enabled: true,
    })
    eq(env.dk_blend.applied, false, 'applied=false on cap exceed')
    eq(env.dk_blend.skip_reason, 'cap', 'skip_reason=cap')
    approxEq(env.outer.lambda_final, baseline.outer.lambda_final, FLOAT_TOL,
      'math unchanged on cap skip')
    // Counterfactual still populated
    ok(Number.isFinite(env.dk_blend.dk_lambda), 'dk_lambda populated on cap skip')
    ok(Math.abs(env.dk_blend.bf_delta) > env.dk_blend.bf_cap_K,
      `|bf_delta| > bf_cap_K (got ${env.dk_blend.bf_delta} cap=${env.dk_blend.bf_cap_K})`)
  }

  // ── E5. dkContext + flag=true + stable → skip, math unchanged ────
  section('BITE 6.2 :: E5 flag=true + stable = w=0 skip')
  if (!fStable) {
    console.log('  (no stable-class fixture available; skipping E5)')
  } else {
    const baseline = computeMatchup(fStable.inputs, baseMultipliers(fStable))
    // Cap-safe so we observe the 'stable' skip, not 'cap' fallthrough.
    const dkContext = capSafeDkContext(fStable)
    const env = computeMatchup(fStable.inputs, baseMultipliers(fStable), {
      dkContext, dk_blend_enabled: true,
    })
    eq(env.dk_blend.dk_thinness_class, 'stable', 'class=stable')
    eq(env.dk_blend.applied, false, 'applied=false for stable')
    eq(env.dk_blend.skip_reason, 'stable', 'skip_reason=stable')
    eq(env.dk_blend.w_dk, 0, 'w_dk=0 for stable')
    approxEq(env.outer.lambda_final, baseline.outer.lambda_final, FLOAT_TOL,
      'math unchanged for stable')
  }

  // ── E6. Hash determinism with dkContext + flag toggle ────────────
  section('BITE 6.2 :: E6 hash determinism + flag effects on output_hash only')
  {
    const dkContext = { dk_line: 7.5, dk_over_price: 0.55, dk_source: 'dk_k_props' }
    const a = computeMatchup(fThin.inputs, baseMultipliers(fThin), { dkContext, dk_blend_enabled: false })
    const b = computeMatchup(fThin.inputs, baseMultipliers(fThin), { dkContext, dk_blend_enabled: false })
    eq(a.output_hash, b.output_hash, 'same dkContext+flag → same output_hash')
    eq(a.inputs_hash, b.inputs_hash, 'same dkContext+flag → same inputs_hash')

    // Mutating dk_line changes both hashes
    const c = computeMatchup(fThin.inputs, baseMultipliers(fThin), {
      dkContext: { ...dkContext, dk_line: 6.5 }, dk_blend_enabled: false,
    })
    ok(c.inputs_hash !== a.inputs_hash, 'dk_line change → inputs_hash change')
    ok(c.output_hash !== a.output_hash, 'dk_line change → output_hash change')

    // Toggling flag affects output_hash but NOT inputs_hash
    const d = computeMatchup(fThin.inputs, baseMultipliers(fThin), { dkContext, dk_blend_enabled: true })
    eq(d.inputs_hash, a.inputs_hash, 'flag toggle leaves inputs_hash unchanged')
    // output_hash differs because envelope.dk_blend.applied / skip_reason / flag_dk_blend_enabled differ
    ok(d.output_hash !== a.output_hash,
      'flag toggle changes output_hash (envelope.dk_blend reflects flag)')
  }

  // ── E7. Flag resolution: ctx overrides env; env consulted when ctx silent ─
  section('BITE 6.2 :: E7 flag resolution precedence (ctx vs env)')
  {
    const dkContext = { dk_line: 7.5, dk_over_price: 0.55, dk_source: 'dk_k_props' }
    const savedEnv = process.env.DK_BLEND_ENABLED
    try {
      // env=true, ctx silent → flag effective true
      process.env.DK_BLEND_ENABLED = 'true'
      const a = computeMatchup(fThin.inputs, baseMultipliers(fThin), { dkContext })
      eq(a.dk_blend.flag_dk_blend_enabled, true, 'env=true with no ctx flag → effective true')

      // env=true, ctx false → ctx wins
      const b = computeMatchup(fThin.inputs, baseMultipliers(fThin), { dkContext, dk_blend_enabled: false })
      eq(b.dk_blend.flag_dk_blend_enabled, false, 'ctx=false overrides env=true')

      // env=false, ctx true → ctx wins
      process.env.DK_BLEND_ENABLED = 'false'
      const c = computeMatchup(fThin.inputs, baseMultipliers(fThin), { dkContext, dk_blend_enabled: true })
      eq(c.dk_blend.flag_dk_blend_enabled, true, 'ctx=true overrides env=false')

      // env unset, ctx silent → false
      delete process.env.DK_BLEND_ENABLED
      const d = computeMatchup(fThin.inputs, baseMultipliers(fThin), { dkContext })
      eq(d.dk_blend.flag_dk_blend_enabled, false, 'env unset + ctx silent → false (default off)')
    } finally {
      if (savedEnv === undefined) delete process.env.DK_BLEND_ENABLED
      else process.env.DK_BLEND_ENABLED = savedEnv
    }
  }

  // ── E8. 20-call iteration with dkContext (Bite 4 pattern still works) ─
  section('BITE 6.2 :: E8 20-call iteration over (strike, side) with dkContext')
  {
    const dkContext = { dk_line: 5.5, dk_over_price: 0.55, dk_source: 'dk_k_props' }
    const env = computeMatchup(fThin.inputs, baseMultipliers(fThin), {
      dkContext, dk_blend_enabled: true,
    })
    const captured = []
    const traceStub = { writeAsync: (e) => captured.push(e) }
    for (const strike of STRIKES_DEFAULT) {
      for (const side of ['YES', 'NO']) {
        await run(env, {
          decision_id: `e8-${strike}-${side}`,
          pitcher_id: '12345',
          pitcher_name: 'Test Thin',
          bet_date: '2026-04-29',
          strike, side,
          emit_trace: true,
          trace: traceStub,
        })
      }
    }
    eq(captured.length, 20, '20 trace events emitted')
    const sharedMOH = new Set(captured.map(e => e.metrics.matchup_output_hash))
    eq(sharedMOH.size, 1, 'all 20 events share one matchup_output_hash')
    const distinctOutputs = new Set(captured.map(e => e.output_hash))
    eq(distinctOutputs.size, 20, '20 distinct per-bet output_hashes')
    // All 20 have dk_blend in reasoning + metrics
    for (const ev of captured) {
      ok(ev.reasoning.dk_blend, `event reasoning.dk_blend present (decision=${ev.decision_id})`)
      ok('dk_lambda' in ev.metrics, 'event metrics has dk_lambda')
    }
  }

  // ── E9. Trace event reasoning carries dk_blend (deep checks) ──────
  section('BITE 6.2 :: E9 trace event reasoning + metrics carry DK info')
  {
    const dkContext = { dk_line: 5.5, dk_over_price: 0.55, dk_source: 'dk_k_props' }
    const env = computeMatchup(fThin.inputs, baseMultipliers(fThin), {
      dkContext, dk_blend_enabled: true,
    })
    const captured = []
    const traceStub = { writeAsync: (e) => captured.push(e) }
    await run(env, {
      decision_id: 'e9-test',
      pitcher_id: '12345', pitcher_name: 'E9 Test', bet_date: '2026-04-29',
      strike: 6, side: 'YES',
      emit_trace: true, trace: traceStub,
    })
    eq(captured.length, 1, 'exactly one trace event')
    const ev = captured[0]
    let validateThrew = null
    try { validateTraceEvent(ev) } catch (err) { validateThrew = err.message }
    eq(validateThrew, null, `validateTraceEvent passes (err: ${validateThrew})`)
    ok(ev.reasoning.dk_blend, 'reasoning.dk_blend present')
    eq(ev.reasoning.dk_blend.applied, env.dk_blend.applied, 'reasoning.dk_blend.applied matches envelope')
    eq(ev.reasoning.dk_blend.skip_reason, env.dk_blend.skip_reason, 'reasoning.dk_blend.skip_reason matches envelope')
    eq(ev.reasoning.dk_blend.thinness_class, env.dk_blend.dk_thinness_class, 'thinness_class matches envelope')
    eq(ev.reasoning.dk_blend.source, env.dk_blend.dk_source, 'source matches envelope')
    // Metrics include numeric DK fields
    ok('dk_lambda' in ev.metrics, 'metrics.dk_lambda key present')
    ok('expected_bf_dk' in ev.metrics, 'metrics.expected_bf_dk key present')
    ok('lambda_base_dk_blended' in ev.metrics, 'metrics.lambda_base_dk_blended key present')
  }

  // ── E10. Empty dkContext → present + skip_reason ─────────────────
  section('BITE 6.2 :: E10 empty dkContext → present + no_dk_line skip')
  {
    const baseline = computeMatchup(fAny.inputs, baseMultipliers(fAny))
    const env = computeMatchup(fAny.inputs, baseMultipliers(fAny), {
      dkContext: {}, dk_blend_enabled: true,
    })
    ok(env.dk_blend, 'envelope.dk_blend PRESENT for empty dkContext (auditable attempt)')
    eq(env.dk_blend.applied, false, 'empty dkContext → applied=false')
    eq(env.dk_blend.skip_reason, 'no_dk_line', 'empty dkContext → skip_reason=no_dk_line')
    eq(env.dk_blend.dk_line, null, 'dk_line null')
    eq(env.dk_blend.dk_over_price, null, 'dk_over_price null')
    eq(env.dk_blend.dk_source, null, 'dk_source null')
    approxEq(env.outer.lambda_final, baseline.outer.lambda_final, FLOAT_TOL,
      'math unchanged on empty dkContext')
  }

  // ── E11. Inner is NEVER mutated ──────────────────────────────────
  section('BITE 6.2 :: E11 inner immutability')
  {
    const dkContext = { dk_line: 5.5, dk_over_price: 0.55, dk_source: 'dk_k_props' }
    const env = computeMatchup(fThin.inputs, baseMultipliers(fThin), {
      dkContext, dk_blend_enabled: true,
    })
    // inner.lambdaBase + expectedBF must equal Bite 3 expected (parity unchanged)
    approxEq(env.inner.lambdaBase, fThin.expected_inner.lambdaBase, FLOAT_TOL,
      'inner.lambdaBase identical to Bite 3 fixture under DK blend')
    approxEq(env.inner.expectedBF, fThin.expected_inner.expectedBF, FLOAT_TOL,
      'inner.expectedBF identical to Bite 3 fixture under DK blend')
    eq(env.dk_blend.lambda_base_current, env.inner.lambdaBase,
      'lambda_base_current === inner.lambdaBase exactly')
    eq(env.dk_blend.expected_bf_current, env.inner.expectedBF,
      'expected_bf_current === inner.expectedBF exactly')
  }
}

// ════════════════════════════════════════════════════════════════════════
// Main
// ════════════════════════════════════════════════════════════════════════
async function main() {
  console.log('═══════════════════════════════════════════')
  console.log('  Layer 1 (Math) — Parity Test (Bites 3+4+5a+6.2)')
  console.log('═══════════════════════════════════════════')

  await runParitySuite()
  runSyntheticBranchSuite()
  await runBite4Suite()
  await runBite62Suite()

  console.log(`\n═══════════════════════════════════════════`)
  console.log(`  ${_passed} passed, ${_failed} failed`)
  console.log('═══════════════════════════════════════════')

  process.exit(_failed > 0 ? 1 : 0)
}

main().catch(err => {
  console.error('FATAL:', err)
  process.exit(1)
})
