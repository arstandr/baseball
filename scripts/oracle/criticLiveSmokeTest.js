// scripts/oracle/criticLiveSmokeTest.js
//
// L4.7 — Live Critic smoke test. OPT-IN. Costs real Anthropic API
// money (small — ~$0.01 per call). NOT in CI.
//
// Run with explicit env flag:
//   ORACLE_CRITIC_LIVE=1 node scripts/oracle/criticLiveSmokeTest.js
//
// Without the flag the script exits early with instructions.

import 'dotenv/config'

if (process.env.ORACLE_CRITIC_LIVE !== '1') {
  console.log('Live Critic smoke test is OPT-IN.')
  console.log('Re-run with ORACLE_CRITIC_LIVE=1 to actually call Anthropic.')
  console.log('Estimated cost per call: ~$0.001-0.002 on Haiku.')
  process.exit(0)
}

const { default: Anthropic } = await import('@anthropic-ai/sdk')

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import url from 'node:url'

import { computeMatchup } from '../../oracle/layers/1-math/impl.js'
import { run as pathRun }   from '../../oracle/layers/2-path/impl.js'
import { run as trustRun }  from '../../oracle/layers/3-trust/impl.js'
import { run as criticRun } from '../../oracle/layers/4-critic/impl.js'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const L1_FIXTURES_PATH = path.resolve(__dirname, '../../oracle/layers/1-math/parity-fixtures.json')

const MODEL = 'claude-haiku-4-5-20251001'

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY not set in env')
  process.exit(1)
}

const anth = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// criticClient adapter: takes the Critic spec's classify shape and
// calls Anthropic Messages API. Returns { content, model_used,
// tokens_input, tokens_output, cost_usd }.
//
// Pricing (rough; Haiku 4.5 is ~$0.25/M input, ~$1.25/M output).
const COST_INPUT_PER_M  = 0.25
const COST_OUTPUT_PER_M = 1.25

const criticClient = {
  classify: async ({ system, user, model, max_tokens }) => {
    const t0 = Date.now()
    const res = await anth.messages.create({
      model,
      max_tokens,
      system,
      messages: [{ role: 'user', content: user }],
    })
    const text = res.content?.map(c => c.type === 'text' ? c.text : '').join('') ?? ''
    const tokensIn  = res.usage?.input_tokens  ?? null
    const tokensOut = res.usage?.output_tokens ?? null
    const cost = (tokensIn != null && tokensOut != null)
      ? (tokensIn * COST_INPUT_PER_M / 1_000_000) + (tokensOut * COST_OUTPUT_PER_M / 1_000_000)
      : null
    return {
      content: text,
      model_used: res.model ?? model,
      tokens_input: tokensIn,
      tokens_output: tokensOut,
      cost_usd: cost,
      elapsed_ms: Date.now() - t0,
    }
  },
}

// ─── Run a single fixture through the chain ──────────────────────
const l1 = JSON.parse(await readFile(L1_FIXTURES_PATH, 'utf-8'))
const f1 = l1.fixtures[0]
const oc = f1.expected_outer_chain_from_production
const env = computeMatchup(f1.inputs, {
  split_adj: oc.split_adj, opp_adj: oc.opp_adj, park_factor: oc.park_factor,
  weather_mult: oc.weather_mult, ump_factor: oc.ump_factor,
})

const baseCtx = {
  decision_id: 'live-smoke',
  pitcher_id: f1.pitcher_id, pitcher_name: f1.pitcher_name,
  bet_date: f1.bet_date, strike: 6, side: 'YES',
}

const pathR = await pathRun(env, baseCtx)
const trustR = await trustRun(env, pathR, baseCtx)

const preflightContext = {
  pitcherNews: [
    `${f1.pitcher_name} reported feeling strong heading into start`,
    `Coach said pitcher is on normal rest`,
    `Recent K-rate trending up over last 3 starts`,
  ],
  opponentNews: [
    'Opposing team has played 3 day games in last 5 days',
  ],
  lineupStatus: { home_lineup_posted: true, away_lineup_posted: true, scratch_alert: false },
  lineDirection: { home: 0, away: 1 },
  weatherData: { summary: 'partly cloudy 72F', rainPct: 0.05 },
  bullpenData: { signal: 'rested', ip_2d: 1.2 },
  umpireData: { name: 'Test Ump', changed: false },
  kPropGap: 0.30,
}

console.log(`Calling Haiku for fixture: ${f1.pitcher_name} K6 YES on ${f1.bet_date}`)
console.log(`Chain context: feasibility=${pathR.feasibility}, trust=${trustR.trust_level} (${trustR.trust_score.toFixed(3)})`)

const r = await criticRun(env, pathR, trustR, {
  ...baseCtx,
  market_mid: 0.50, edge: 0.20,
  preflightContext,
  criticClient,
})

console.log(`\n══ Live Critic verdict ══`)
console.log(`  verdict:       ${r.verdict}`)
console.log(`  confidence:    ${r.confidence}`)
console.log(`  concerns:      ${JSON.stringify(r.concerns)}`)
console.log(`  reason_code:   ${r.reason_code}`)
console.log(`  status:        ${r.status}`)
console.log(`  model_used:    ${r.model_used}`)
console.log(`  tokens_input:  ${r.tokens_input}`)
console.log(`  tokens_output: ${r.tokens_output}`)
console.log(`  cost_usd:      $${r.cost_usd?.toFixed(4) ?? '—'}`)

// Sanity assertions
if (!['skip','concern','proceed','boost'].includes(r.verdict)) {
  console.error('VERDICT INVALID; smoke FAILED')
  process.exit(1)
}
if (r.status !== 'ok') {
  console.error('STATUS NOT OK; smoke FAILED')
  process.exit(1)
}
console.log('\n✓ Smoke test passed: real Haiku call returned valid Critic verdict.')
