// scripts/oracle/buildTrustParityFixtures.js
//
// Layer 3 (Trust) parity fixture generator.
//
// Reads Layer 2's parity-fixtures.json (280 rows) and joins each with
// the source Layer 1 fixture's confidence string + dk_blend status to
// derive Trust inputs. Produces 280 Trust fixture rows.

import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import url from 'node:url'

import { scoreTrust, parseConfidence, HELPER_VERSION } from '../../oracle/layers/3-trust/trustScore.js'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const L2_FIXTURES_PATH = path.resolve(__dirname, '../../oracle/layers/2-path/parity-fixtures.json')
const L1_FIXTURES_PATH = path.resolve(__dirname, '../../oracle/layers/1-math/parity-fixtures.json')
const OUTPUT_PATH      = path.resolve(__dirname, '../../oracle/layers/3-trust/parity-fixtures.json')

const l2 = JSON.parse(await readFile(L2_FIXTURES_PATH, 'utf-8'))
const l1 = JSON.parse(await readFile(L1_FIXTURES_PATH, 'utf-8'))
const l1ById = new Map(l1.fixtures.map(f => [f.fixture_id, f]))

console.log(`[buildTrustParityFixtures] L2 fixtures: ${l2.fixtures.length}; L1 fixtures: ${l1.fixtures.length}`)

const fixtures = []
const byLevel  = { high: 0, medium: 0, low: 0 }
const byReason = {}

for (const f2 of l2.fixtures) {
  const f1 = l1ById.get(f2.source_layer1_fixture_id)
  if (!f1) {
    console.error(`Missing Layer 1 fixture: ${f2.source_layer1_fixture_id}`)
    continue
  }
  const confidence = parseConfidence(f1.expected_inner.confidence)
  const dk_blend_applied = false   // Layer 1 fixtures predate DK blend

  const input = {
    feasibility:       f2.expected.feasibility,
    bf_source_tier:    f2.inputs.bf_source_tier,
    confidence,
    dk_blend_applied,
  }
  const result = scoreTrust(input)

  fixtures.push({
    fixture_id:                `${f2.fixture_id}_trust`,
    source_layer2_fixture_id:  f2.fixture_id,
    source_layer1_fixture_id:  f2.source_layer1_fixture_id,
    pitcher_id:                f2.pitcher_id,
    pitcher_name:              f2.pitcher_name,
    bet_date:                  f2.bet_date,
    archetype:                 f2.archetype,
    strike:                    f2.strike,
    side:                      f2.side,

    inputs: {
      feasibility:       input.feasibility,
      bf_source_tier:    input.bf_source_tier,
      confidence:        input.confidence,
      dk_blend_applied:  input.dk_blend_applied,
      raw_confidence:    f1.expected_inner.confidence,
    },

    expected: {
      trust_score:        result.trust_score,
      trust_level:        result.trust_level,
      feasibility_factor: result.feasibility_factor,
      bf_source_factor:   result.bf_source_factor,
      confidence_factor:  result.confidence_factor,
      dk_blend_factor:    result.dk_blend_factor,
      reason_code:        result.reason_code,
      reason_codes:       result.reason_codes,
    },
  })
  byLevel[result.trust_level]++
  byReason[result.reason_code] = (byReason[result.reason_code] || 0) + 1
}

const out = {
  schema_version:         '1.0.0',
  generated_at:           new Date().toISOString(),
  source:                 'oracle/layers/3-trust/trustScore.js',
  trust_version:          HELPER_VERSION,
  layer2_fixtures_source: 'oracle/layers/2-path/parity-fixtures.json',
  layer1_fixtures_source: 'oracle/layers/1-math/parity-fixtures.json',
  pk_ridge_weights_hash:  l1.pk_ridge_weights_hash,
  total_fixtures:         fixtures.length,
  by_level:               byLevel,
  by_reason:              byReason,
  fixtures,
}

await writeFile(OUTPUT_PATH, JSON.stringify(out, null, 2), 'utf-8')

console.log(`[buildTrustParityFixtures] wrote ${fixtures.length} fixtures to ${OUTPUT_PATH}`)
console.log('\nDistribution by trust_level:')
for (const [k, n] of Object.entries(byLevel)) console.log(`  ${k.padEnd(8)}  ${n}`)
console.log('\nDistribution by reason_code:')
const sorted = Object.entries(byReason).sort((a,b) => b[1]-a[1])
for (const [r, n] of sorted) console.log(`  ${r.padEnd(34)}  ${n}`)
