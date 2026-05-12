// scripts/oracle/buildPathParityFixtures.js
//
// Bite L2.3 — Path parity fixture generator.
//
// Reads Layer 1's parity-fixtures.json (the 14 frozen archetype rows)
// and expands each into 10 strikes × 2 sides = 20 Layer 2 fixture
// rows, for a total of 280. Each row records the inputs that would
// be fed to feasibility.js along with the expected output.
//
// Determinism: same Layer 1 fixtures + same feasibility.js =
// byte-identical Layer 2 fixtures. No DB. No live data.
//
// Usage:
//   node scripts/oracle/buildPathParityFixtures.js
//
// Output: oracle/layers/2-path/parity-fixtures.json

import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import url from 'node:url'

import { classifyYes, classifyNo, HELPER_VERSION } from '../../oracle/layers/2-path/feasibility.js'
// bfSourceTier lives in dkBlend.js (Bite 6.1 helper).
import { bfSourceTier } from '../../oracle/layers/1-math/dkBlend.js'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const LAYER1_FIXTURES_PATH = path.resolve(__dirname, '../../oracle/layers/1-math/parity-fixtures.json')
const OUTPUT_PATH          = path.resolve(__dirname, '../../oracle/layers/2-path/parity-fixtures.json')

const STRIKES = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
const SIDES   = ['YES', 'NO']

// ─── Load Layer 1 fixtures ────────────────────────────────────────
const l1Raw = await readFile(LAYER1_FIXTURES_PATH, 'utf-8')
const l1    = JSON.parse(l1Raw)
console.log(`[buildPathParityFixtures] Loaded ${l1.fixtures.length} Layer 1 fixtures`)
console.log(`[buildPathParityFixtures] pk_ridge_weights_hash: ${l1.pk_ridge_weights_hash}`)

// ─── Generate ─────────────────────────────────────────────────────
const fixtures = []
const byArchetype  = {}
const byFeasibility = { strong: 0, viable: 0, fragile: 0, dead: 0 }
const byReason      = {}

for (const f1 of l1.fixtures) {
  const inner = f1.expected_inner
  const oc    = f1.expected_outer_chain_from_production

  // Layer 2 uses recomputed lambda_final = inner.lambdaBase × Π multipliers
  // (matches Bite 3 parity test convention; ignores production drift).
  const lambdaFinal = inner.lambdaBase
    * oc.split_adj * oc.opp_adj * oc.park_factor
    * oc.weather_mult * oc.ump_factor

  // Map raw bfSource string → tier (used by classifyYes/classifyNo)
  const tier = bfSourceTier(inner.bfSource)

  for (const strike of STRIKES) {
    for (const side of SIDES) {
      // Build the input that L2.4's run() will pass to feasibility.js.
      const input = {
        strike,
        expected_bf:      inner.expectedBF,
        pK_blended:       inner.pK_blended,
        lambda_final:     lambdaFinal,
        bf_source_tier:   tier,
        avg_pitches:      inner.avgPitches,
        leash_flag:       !!inner.leashFlag,
        dk_blend_applied: false,            // Layer 1 fixtures predate DK blend
      }

      const result = side === 'YES' ? classifyYes(input) : classifyNo(input)

      const fixtureId = `${f1.fixture_id}_${strike}_${side}`
      fixtures.push({
        fixture_id:                 fixtureId,
        source_layer1_fixture_id:   f1.fixture_id,
        pitcher_id:                 f1.pitcher_id,
        pitcher_name:               f1.pitcher_name,
        bet_date:                   f1.bet_date,
        archetype:                  f1.archetype,
        strike,
        side,

        inputs: {
          expected_bf:      input.expected_bf,
          pK_blended:       input.pK_blended,
          lambda_final:     input.lambda_final,
          bf_source_tier:   input.bf_source_tier,
          avg_pitches:      input.avg_pitches,
          leash_flag:       input.leash_flag,
          dk_blend_applied: input.dk_blend_applied,
          raw_bf_source:    inner.bfSource,
        },

        expected: {
          feasibility:        result.feasibility,
          reason_code:        result.reason_code,
          secondary_reasons:  result.secondary_reasons,
          required_bf:        result.required_bf,
          required_bf_outer:  result.required_bf_outer,
          bf_gap:             result.bf_gap,
          bf_gap_ratio:       result.bf_gap_ratio,
          bf_ceiling:         result.bf_ceiling,
          required_pk:        result.required_pk,
          gap_under:          result.gap_under,
        },
      })

      byArchetype[f1.archetype] = (byArchetype[f1.archetype] || 0) + 1
      byFeasibility[result.feasibility]++
      byReason[result.reason_code] = (byReason[result.reason_code] || 0) + 1
    }
  }
}

const out = {
  schema_version:          '1.0.0',
  generated_at:            new Date().toISOString(),
  source:                  'oracle/layers/2-path/feasibility.js',
  feasibility_version:     HELPER_VERSION,
  layer1_fixtures_source:  'oracle/layers/1-math/parity-fixtures.json',
  pk_ridge_weights_hash:   l1.pk_ridge_weights_hash,
  total_fixtures:          fixtures.length,
  by_archetype:            byArchetype,
  by_feasibility:          byFeasibility,
  by_reason:               byReason,
  fixtures,
}

await writeFile(OUTPUT_PATH, JSON.stringify(out, null, 2), 'utf-8')

console.log(`[buildPathParityFixtures] wrote ${fixtures.length} fixtures to ${OUTPUT_PATH}`)
console.log('\nDistribution by feasibility:')
for (const [f, n] of Object.entries(byFeasibility)) console.log(`  ${f.padEnd(8)}  ${n}`)
console.log('\nDistribution by reason_code:')
const sorted = Object.entries(byReason).sort((a, b) => b[1] - a[1])
for (const [r, n] of sorted) console.log(`  ${r.padEnd(34)}  ${n}`)
console.log('\nDistribution by archetype × strikes×sides:')
for (const [a, n] of Object.entries(byArchetype)) console.log(`  ${a.padEnd(28)}  ${n}`)
