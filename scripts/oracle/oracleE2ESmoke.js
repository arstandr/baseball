// scripts/oracle/oracleE2ESmoke.js
//
// END-TO-END SMOKE TEST — full Oracle pipeline including REAL Critic.
//
// Picks a RANDOM fixture from Layer 1 parity-fixtures.json, picks a
// RANDOM (strike, side), generates randomized preflight context, and
// runs the full chain L1 → L2 → L3 → L4 (real Haiku) → L5.
//
// Cost: one real Haiku call (~$0.001-0.002).
//
// Run:
//   node scripts/oracle/oracleE2ESmoke.js
//   node scripts/oracle/oracleE2ESmoke.js --seed 42      (deterministic random)

import 'dotenv/config'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import url from 'node:url'

import Anthropic from '@anthropic-ai/sdk'

import { computeMatchup, STRIKES_DEFAULT } from '../../oracle/layers/1-math/impl.js'
import { run as pathRun }   from '../../oracle/layers/2-path/impl.js'
import { run as trustRun }  from '../../oracle/layers/3-trust/impl.js'
import { run as criticRun } from '../../oracle/layers/4-critic/impl.js'
import { run as judgeRun }  from '../../oracle/layers/5-judge/impl.js'
import { validateTraceEvent } from '../../oracle/layers/0-trace/validate.js'
import { parseArgs } from '../../lib/cli-args.js'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const L1_FIXTURES_PATH = path.resolve(__dirname, '../../oracle/layers/1-math/parity-fixtures.json')

// ─── Args + RNG ───────────────────────────────────────────────────
const opts = parseArgs({ seed: { type: 'number', default: null } })
const seed = opts.seed != null ? opts.seed : Math.floor(Math.random() * 1_000_000)
console.log(`[oracleE2ESmoke] seed=${seed}`)

// Mulberry32 PRNG (deterministic given seed)
function mulberry32(s) {
  return function() {
    s |= 0; s = s + 0x6D2B79F5 | 0
    let t = s
    t = Math.imul(t ^ t >>> 15, t | 1)
    t ^= t + Math.imul(t ^ t >>> 7, t | 61)
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}
const rand = mulberry32(seed)
const pick = (arr) => arr[Math.floor(rand() * arr.length)]
const randFloat = (lo, hi) => lo + rand() * (hi - lo)
const randInt   = (lo, hi) => Math.floor(randFloat(lo, hi + 1))

// ─── Anthropic client ──────────────────────────────────────────────
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY not set in env')
  process.exit(1)
}
const anth = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const HAIKU = 'claude-haiku-4-5-20251001'
const COST_INPUT_PER_M  = 0.25
const COST_OUTPUT_PER_M = 1.25

const criticClient = {
  classify: async ({ system, user, model, max_tokens }) => {
    const t0 = Date.now()
    const res = await anth.messages.create({
      model, max_tokens, system,
      messages: [{ role: 'user', content: user }],
    })
    const text = res.content?.map(c => c.type === 'text' ? c.text : '').join('') ?? ''
    const ti = res.usage?.input_tokens  ?? null
    const to = res.usage?.output_tokens ?? null
    const cost = (ti != null && to != null)
      ? (ti * COST_INPUT_PER_M + to * COST_OUTPUT_PER_M) / 1_000_000
      : null
    return {
      content: text, model_used: res.model ?? model,
      tokens_input: ti, tokens_output: to,
      cost_usd: cost, elapsed_ms: Date.now() - t0,
    }
  },
}

// ─── Pick random fixture + random strike/side ─────────────────────
const l1 = JSON.parse(await readFile(L1_FIXTURES_PATH, 'utf-8'))
const f1 = pick(l1.fixtures)
const strike = pick(STRIKES_DEFAULT)
const side   = pick(['YES', 'NO'])

console.log(`\n══ Fixture chosen ══`)
console.log(`  pitcher    : ${f1.pitcher_name}`)
console.log(`  bet_date   : ${f1.bet_date}`)
console.log(`  archetype  : ${f1.archetype}`)
console.log(`  bet        : K${strike} ${side}`)

// ─── Random preflight context ─────────────────────────────────────
// Generate a believable but synthetic preflight context.
const newsBank = [
  `${f1.pitcher_name} threw bullpen yesterday, reported feeling good`,
  `${f1.pitcher_name} mentioned slight tightness in shoulder pre-game`,
  `${f1.pitcher_name}'s last 3 starts: 8K, 5K, 9K`,
  `${f1.pitcher_name} on normal 5-day rest`,
  `Manager praised ${f1.pitcher_name}'s recent command`,
  `${f1.pitcher_name} working on new changeup this season`,
  `${f1.pitcher_name} struggled in first inning of last start`,
]
const opponentBank = [
  'Opponent has top-of-order regulars expected in lineup',
  'Opposing team has played 4 day games in last 6 days',
  'Opponent rest day yesterday',
  'Star hitter day-to-day with quad strain',
  'Opponent K-rate trending up vs righties last 2 weeks',
]
const weatherBank = [
  { summary: 'partly cloudy 72F, 6mph wind out to LF', rainPct: 0.05 },
  { summary: 'cloudy 65F, 12mph wind in from RF', rainPct: 0.20 },
  { summary: 'sunny 88F, 4mph crosswind', rainPct: 0.00 },
  { summary: 'overcast 58F, light rain possible', rainPct: 0.45 },
  { summary: 'dome / climate-controlled', rainPct: 0.00 },
]
const preflightContext = {
  pitcherNews: [pick(newsBank), pick(newsBank), pick(newsBank)].filter((v,i,a) => a.indexOf(v) === i),
  opponentNews: [pick(opponentBank), pick(opponentBank)].filter((v,i,a) => a.indexOf(v) === i),
  lineupStatus: {
    home_lineup_posted: rand() > 0.3,
    away_lineup_posted: rand() > 0.3,
    scratch_alert:      rand() < 0.05,
  },
  lineDirection: { home: pick([-1, 0, 0, 0, 1]), away: pick([-1, 0, 0, 0, 1]) },
  lineDelta:     randInt(-1, 1),
  weatherData:   pick(weatherBank),
  bullpenData:   { signal: pick(['rested','normal','tired','overworked']), ip_2d: randFloat(0, 6) },
  umpireData:    { name: pick(['Joe West','Angel Hernandez','Test Ump','Pat Hoberg','Junior Valentine']),
                   changed: rand() < 0.05 },
  kPropGap:      randFloat(-0.6, 0.6),
}
console.log(`\n══ Random preflight context ══`)
console.log(JSON.stringify(preflightContext, null, 2))

// ─── Build envelope from fixture ──────────────────────────────────
const oc = f1.expected_outer_chain_from_production
const env = computeMatchup(f1.inputs, {
  split_adj: oc.split_adj, opp_adj: oc.opp_adj, park_factor: oc.park_factor,
  weather_mult: oc.weather_mult, ump_factor: oc.ump_factor,
})

// Derive a plausible market_mid from the prob, with a random gap
const probYesAtStrike = env.prob_at_least[String(strike)]
const probSide = side === 'YES' ? probYesAtStrike : 1 - probYesAtStrike
// Random market mid: 0.05–0.20 below probSide (favorable edge most times)
const marketMid = Math.max(0.05, Math.min(0.95, probSide - randFloat(0.05, 0.30)))
const spread = randFloat(0.01, 0.06)  // 1-6 cents in fraction
const bankroll = 1000

const baseCtx = {
  decision_id: `e2e-${seed}`,
  pitcher_id: f1.pitcher_id, pitcher_name: f1.pitcher_name,
  bet_date: f1.bet_date, strike, side,
}

console.log(`\n══ Layer 1 (Math) — envelope built ══`)
console.log(`  output_hash:     ${env.output_hash.slice(0, 16)}…`)
console.log(`  inner.expectedBF:${env.inner.expectedBF?.toFixed(2)}`)
console.log(`  inner.pK_blended:${env.inner.pK_blended?.toFixed(4)}`)
console.log(`  outer.lambda_final: ${env.outer.lambda_final.toFixed(3)}`)
console.log(`  prob_at_least[${strike}]: ${probYesAtStrike.toFixed(4)}`)
console.log(`  → prob_side(${side}): ${probSide.toFixed(4)}`)

// ─── Layer 2 (Path) ───────────────────────────────────────────────
const pathR = await pathRun(env, baseCtx)
console.log(`\n══ Layer 2 (Path) ══`)
console.log(`  feasibility:      ${pathR.feasibility}`)
console.log(`  reason_code:      ${pathR.reason_code}`)
console.log(`  required_bf:      ${pathR.required_bf?.toFixed(2)}`)
console.log(`  expected_bf:      ${pathR.expected_bf?.toFixed(2)}`)
console.log(`  bf_gap_ratio:     ${pathR.bf_gap_ratio?.toFixed(3)}`)
console.log(`  workload_signal:  ${pathR.workload_signal}`)

// ─── Layer 3 (Trust) ──────────────────────────────────────────────
const trustR = await trustRun(env, pathR, baseCtx)
console.log(`\n══ Layer 3 (Trust) ══`)
console.log(`  trust_score:      ${trustR.trust_score.toFixed(3)}`)
console.log(`  trust_level:      ${trustR.trust_level}`)
console.log(`  reason_code:      ${trustR.reason_code}`)
console.log(`  factors: feasibility=${trustR.feasibility_factor}, bf_source=${trustR.bf_source_factor}, confidence=${trustR.confidence_factor}`)

// ─── Layer 4 (Critic) — REAL Haiku call ───────────────────────────
console.log(`\n══ Layer 4 (Critic) — calling real Haiku ══`)
const criticT0 = Date.now()
const critic = await criticRun(env, pathR, trustR, {
  ...baseCtx,
  market_mid: marketMid,
  edge: probSide - marketMid,
  preflightContext,
  criticClient,
  layer3JudgeBaseDecision: '(see Judge below)',
})
const criticElapsed = Date.now() - criticT0
console.log(`  status:           ${critic.status}`)
console.log(`  verdict:          ${critic.verdict}`)
console.log(`  confidence:       ${critic.confidence}`)
console.log(`  concerns:         ${JSON.stringify(critic.concerns)}`)
console.log(`  reason_code:      ${critic.reason_code}`)
console.log(`  model_used:       ${critic.model_used}`)
console.log(`  tokens_input:     ${critic.tokens_input}`)
console.log(`  tokens_output:    ${critic.tokens_output}`)
console.log(`  cost_usd:         $${critic.cost_usd?.toFixed(4) ?? '—'}`)
console.log(`  elapsed_ms:       ${criticElapsed}`)

// ─── Layer 5 (Judge v0.2) — with Critic ──────────────────────────
const judgeR = await judgeRun(env, pathR, trustR, {
  ...baseCtx,
  market_mid: marketMid,
  spread,
  bankroll,
  criticResult: critic,
})
console.log(`\n══ Layer 5 (Judge v0.2 with Critic) ══`)
console.log(`  baseline_decision: ${judgeR.baseline_decision} (${judgeR.baseline_reason})`)
console.log(`  critic_verdict:    ${judgeR.critic_verdict}`)
console.log(`  critic_applied:    ${JSON.stringify(judgeR.critic_applied)}`)
console.log(`  FINAL DECISION:    ${judgeR.decision.toUpperCase()}`)
console.log(`  reason_code:       ${judgeR.reason_code}`)
console.log(`  edge:              ${(judgeR.edge*100).toFixed(2)}¢`)
console.log(`  threshold:         ${(judgeR.threshold*100).toFixed(2)}¢`)
console.log(`  prob_side:         ${judgeR.prob_side?.toFixed(4)}`)
console.log(`  market_mid:        ${(judgeR.market_mid*100).toFixed(2)}¢`)
console.log(`  spread:            ${(judgeR.spread*100).toFixed(2)}¢`)
console.log(`  kelly_raw:         ${judgeR.kelly_raw?.toFixed(4)}`)
console.log(`  kelly_eff:         ${judgeR.kelly_eff?.toFixed(4)}`)
console.log(`  size_usd:          $${judgeR.size_usd?.toFixed(2)}`)

// ─── Validate Trace events for the chain ──────────────────────────
console.log(`\n══ Trace event validation (full chain emit) ══`)
const captured = []
const traceStub = { writeAsync: (ev) => captured.push(ev) }
const tCtx = { ...baseCtx, decision_id: `e2e-${seed}-trace`, emit_trace: true, trace: traceStub }
const path2  = await pathRun(env, tCtx)
const trust2 = await trustRun(env, path2, tCtx)
const critic2 = await criticRun(env, path2, trust2, {
  ...tCtx,
  market_mid: marketMid,
  edge: probSide - marketMid,
  preflightContext,
  criticClient,
  layer3JudgeBaseDecision: judgeR.baseline_decision,
})
const judge2 = await judgeRun(env, path2, trust2, {
  ...tCtx,
  market_mid: marketMid, spread, bankroll,
  criticResult: critic2,
})
let validateErrs = 0
for (const ev of captured) {
  try { validateTraceEvent(ev) } catch (e) { validateErrs++; console.error(`  invalid: ${e.message}`) }
}
console.log(`  Captured ${captured.length} trace events (path, trust, critic, judge)`)
console.log(`  Layer 0 validateTraceEvent errors: ${validateErrs}`)
console.log(`  Layers represented: ${captured.map(e => e.layer_name).join(' → ')}`)

// ─── Summary ──────────────────────────────────────────────────────
console.log(`\n═══════════════════════════════════════════`)
console.log(`  ORACLE E2E SMOKE — RESULT`)
console.log(`═══════════════════════════════════════════`)
const ok = (
  ['strong','viable','fragile','dead'].includes(pathR.feasibility) &&
  ['high','medium','low'].includes(trustR.trust_level) &&
  ['skip','concern','proceed','boost'].includes(critic.verdict) &&
  ['fire','skip','size_down'].includes(judgeR.decision) &&
  validateErrs === 0 &&
  critic.status === 'ok'
)
console.log(`  ${ok ? '✓ PASSED' : '✗ FAILED'}`)
console.log(`  L1 lambda_final → ${env.outer.lambda_final.toFixed(2)}`)
console.log(`  L2 ${pathR.feasibility} (${pathR.reason_code})`)
console.log(`  L3 ${trustR.trust_level} (score ${trustR.trust_score.toFixed(2)})`)
console.log(`  L4 ${critic.verdict} (concerns: ${critic.concerns.join(', ') || 'none'})`)
console.log(`  L5 ${judgeR.decision.toUpperCase()} (${judgeR.reason_code}, $${judgeR.size_usd.toFixed(2)})`)
console.log(`  Total cost: $${(critic.cost_usd ?? 0).toFixed(4)} (one Haiku call)`)
console.log(`  All trace events validate: ${validateErrs === 0 ? 'yes' : 'NO'}`)
console.log(`  Seed used: ${seed} (re-run with --seed ${seed} to reproduce)`)

process.exit(ok ? 0 : 1)
