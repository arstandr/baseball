// scripts/tests/oracleCriticTest.js
//
// L4.4 — Mock-Critic tests for Layer 4 (Critic) impl.js.
// No real API calls. All Sonnet/Haiku interactions are stubbed.

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import url from 'node:url'

import { computeMatchup } from '../../oracle/layers/1-math/impl.js'
import { run as pathRun }   from '../../oracle/layers/2-path/impl.js'
import { run as trustRun }  from '../../oracle/layers/3-trust/impl.js'
import {
  run as criticRun, SCHEMA_VERSION, LAYER_NAME, LAYER_VERSION, SOURCE,
  VERDICTS, CONCERN_VOCAB,
} from '../../oracle/layers/4-critic/impl.js'
import {
  buildSystemPrompt, buildUserPrompt, computeCacheKey,
  parseCriticResponse, PROMPT_VERSION,
} from '../../oracle/layers/4-critic/preflightAdapter.js'
import { validateTraceEvent } from '../../oracle/layers/0-trace/validate.js'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const L1_FIXTURES_PATH = path.resolve(__dirname, '../../oracle/layers/1-math/parity-fixtures.json')

const HEX64 = /^[a-f0-9]{64}$/

let _passed = 0, _failed = 0
const ok = (c, l) => c ? _passed++ : (_failed++, console.error(`FAIL [${l}]`))
const eq = (a, b, l) => {
  if (a === b) { _passed++; return }
  if (a == null && b == null) { _passed++; return }
  _failed++; console.error(`FAIL [${l}]: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`)
}
const throws = async (fn, l) => {
  let t = false; try { await fn() } catch { t = true }
  ok(t, l)
}
const section = (n) => console.log(`\n── ${n} ──`)

console.log('═══════════════════════════════════════════')
console.log('  Layer 4 (Critic) — Mock Test')
console.log('═══════════════════════════════════════════')

// ─── Fixtures + chain setup ────────────────────────────────────────
const l1 = JSON.parse(await readFile(L1_FIXTURES_PATH, 'utf-8'))
const f1 = l1.fixtures[0]
const oc = f1.expected_outer_chain_from_production
const env = computeMatchup(f1.inputs, {
  split_adj: oc.split_adj, opp_adj: oc.opp_adj, park_factor: oc.park_factor,
  weather_mult: oc.weather_mult, ump_factor: oc.ump_factor,
})
const baseCtx = {
  decision_id: 'critic-test', pitcher_id: f1.pitcher_id, pitcher_name: f1.pitcher_name,
  bet_date: f1.bet_date, strike: 6, side: 'YES',
}
const pathR  = await pathRun(env, baseCtx)
const trustR = await trustRun(env, pathR, baseCtx)

// Helper to build a stub criticClient that returns canned responses
function stubClient(responses) {
  let i = 0
  return {
    callCount: 0,
    classify: async function(args) {
      this.callCount++
      const r = responses[i] ?? responses[responses.length - 1]
      i++
      if (r === 'throw')   throw new Error('stub error')
      if (r === 'timeout') return new Promise(() => {})  // never resolve
      if (typeof r === 'string') return { content: r, model_used: 'stub-haiku', tokens_input: 100, tokens_output: 50, cost_usd: 0.001 }
      return { ...r, model_used: r.model_used ?? 'stub-haiku' }
    },
  }
}

// ─── Section A — preflightAdapter pure helpers ─────────────────────
section('A — preflightAdapter')
{
  // System prompt mentions all vocab terms
  const sp = buildSystemPrompt()
  for (const term of CONCERN_VOCAB) {
    ok(sp.includes(term), `A system prompt contains vocab "${term}"`)
  }
  ok(sp.includes('"verdict"'),    'A system prompt mentions verdict field')
  ok(sp.includes('"confidence"'), 'A system prompt mentions confidence field')

  // User prompt structure
  const userP = buildUserPrompt({
    chainSummary: { feasibility: 'strong', trust_level: 'high', trust_score: 0.95, edge: 0.20, market_mid: 0.45, decision_so_far: 'fire' },
    preflightContext: {
      pitcherNews: ['Pitcher A reported feeling great', 'Recent K-rate up'],
      opponentNews: ['Hottest hitter day off'],
      lineupStatus: { home_lineup_posted: true, away_lineup_posted: true, scratch_alert: false },
      lineDelta: 0.5, lineDirection: { home: 1, away: -1 },
      weatherData: { summary: 'sunny', rainPct: 0.1 },
      bullpenData: { signal: 'rested', ip_2d: 2.5 },
      umpireData: { name: 'Jeff Doe', changed: false },
      kPropGap: 0.20,
    },
    betMeta: { pitcher_name: 'Test Pitcher', strike: 6, side: 'YES', bet_date: '2026-04-29' },
  })
  ok(userP.includes('Test Pitcher'),     'A user prompt has pitcher name')
  ok(userP.includes('K6 YES'),           'A user prompt has strike+side')
  ok(userP.includes('feeling great'),    'A user prompt has news')
  ok(userP.includes('feasibility'),      'A user prompt has chain summary')
  ok(userP.includes('Vote.'),            'A user prompt ends with Vote.')

  // computeCacheKey deterministic
  const ctxA = { home_lineup_posted: true, away_lineup_posted: false, scratch_alert: false }
  const ck1 = computeCacheKey({ pitcher_id: 'p1', bet_date: '2026-04-29',
    preflightContext: { lineupStatus: ctxA, lineDirection: { home: 0, away: 0 } } })
  const ck2 = computeCacheKey({ pitcher_id: 'p1', bet_date: '2026-04-29',
    preflightContext: { lineupStatus: ctxA, lineDirection: { home: 0, away: 0 } } })
  eq(ck1, ck2, 'A cache key deterministic')
  const ck3 = computeCacheKey({ pitcher_id: 'p1', bet_date: '2026-04-29',
    preflightContext: { lineupStatus: { ...ctxA, scratch_alert: true }, lineDirection: { home: 0, away: 0 } } })
  ok(ck3 !== ck1, 'A cache key changes when lineup state changes')
  ok(HEX64.test(ck1), 'A cache key is sha256 hex')

  // parseCriticResponse — happy path JSON
  const okJson = '{"verdict":"proceed","confidence":"high","concerns":[],"reason":"clean"}'
  const out1 = parseCriticResponse(okJson)
  ok(out1.ok, 'A parse happy path')
  eq(out1.parsed.verdict, 'proceed', 'A parsed verdict')

  // Fenced JSON
  const fenced = '```json\n{"verdict":"skip","confidence":"high","concerns":["news_lineup_scratched"],"reason":"x"}\n```'
  const out2 = parseCriticResponse(fenced)
  ok(out2.ok, 'A parse with code fences')
  eq(out2.parsed.verdict, 'skip', 'A fenced verdict')

  // Prefix prose
  const prose = 'Sure, here is my analysis. {"verdict":"concern","confidence":"medium","concerns":["weather_concern"],"reason":"rain risk"}'
  const out3 = parseCriticResponse(prose)
  ok(out3.ok, 'A parse with prefix prose')
  eq(out3.parsed.verdict, 'concern', 'A prose verdict')

  // Invalid verdict
  const bad = '{"verdict":"maybe","confidence":"high","concerns":[],"reason":"x"}'
  const out4 = parseCriticResponse(bad)
  ok(!out4.ok, 'A parse rejects bad verdict')

  // Concerns filtered to vocab
  const filt = '{"verdict":"concern","confidence":"high","concerns":["weather_concern","made_up_thing","news_pitcher_injury"],"reason":"x"}'
  const out5 = parseCriticResponse(filt)
  ok(out5.ok, 'A parse with mixed concerns')
  eq(out5.parsed.concerns.length, 2, 'A non-vocab concern filtered out')
  ok(out5.parsed.concerns.includes('weather_concern'), 'A vocab concern preserved')
}

// ─── Section B — impl.js envelope shape (with stub) ────────────────
section('B — Critic impl envelope shape')
{
  const stub = stubClient([
    JSON.stringify({ verdict: 'proceed', confidence: 'high', concerns: [], reason: 'clean' }),
  ])
  const r = await criticRun(env, pathR, trustR, {
    ...baseCtx,
    preflightContext: { pitcherNews: [], opponentNews: [], lineupStatus: {} },
    criticClient: stub,
  })
  eq(r.schema_version, SCHEMA_VERSION,         'B schema_version')
  eq(r.layer,          'critic',                'B layer')
  eq(r.layer_version,  LAYER_VERSION,           'B layer_version')
  eq(r.source,         SOURCE,                  'B source')
  ok(typeof r.run_id === 'string' && r.run_id.length === 36, 'B run_id is uuid')
  ok(HEX64.test(r.inputs_hash),  'B inputs_hash is sha256 hex')
  ok(HEX64.test(r.output_hash),  'B output_hash is sha256 hex')
  eq(r.matchup_output_hash, env.output_hash,    'B matchup hash linked')
  eq(r.path_output_hash,    pathR.output_hash,  'B path hash linked')
  eq(r.trust_output_hash,   trustR.output_hash, 'B trust hash linked')
  eq(r.verdict, 'proceed',                       'B verdict=proceed (stub)')
  eq(r.status,  'ok',                            'B status=ok')
  eq(r.cache_hit, false,                         'B cache_hit=false (no cache)')
  eq(r.model_used, 'stub-haiku',                 'B model_used echoed')
  eq(stub.callCount, 1,                          'B classify called once')
}

// ─── Section C — All four verdicts via stub ────────────────────────
section('C — verdict round-trip')
{
  const verdicts = ['skip', 'concern', 'proceed', 'boost']
  for (const v of verdicts) {
    const stub = stubClient([
      JSON.stringify({ verdict: v, confidence: 'medium', concerns: ['generic_concern'], reason: 'test' }),
    ])
    const r = await criticRun(env, pathR, trustR, {
      ...baseCtx,
      decision_id: `c-${v}`,
      preflightContext: { pitcherNews: [] },
      criticClient: stub,
    })
    eq(r.verdict, v, `C verdict=${v}`)
    eq(r.status, 'ok', `C verdict=${v} status=ok`)
  }
}

// ─── Section D — Cache hit path ────────────────────────────────────
section('D — cache hit')
{
  const stub = stubClient([JSON.stringify({ verdict: 'proceed', confidence: 'high', concerns: [], reason: 'r' })])
  const cacheStore = new Map()
  const cache = {
    get: async (k) => cacheStore.get(k) ?? null,
    set: async (k, v) => { cacheStore.set(k, v) },
  }
  // First call → API; cache populated
  const r1 = await criticRun(env, pathR, trustR, {
    ...baseCtx, decision_id: 'd1',
    preflightContext: { pitcherNews: ['x'] },
    criticClient: stub, cache,
  })
  eq(r1.cache_hit, false, 'D first call cache miss')
  eq(stub.callCount, 1, 'D API called once')
  // Second call (same context) → cache hit
  const r2 = await criticRun(env, pathR, trustR, {
    ...baseCtx, decision_id: 'd2',
    preflightContext: { pitcherNews: ['x'] },
    criticClient: stub, cache,
  })
  eq(r2.cache_hit, true,    'D second call cache hit')
  eq(r2.model_used, 'cache', 'D model_used=cache')
  eq(stub.callCount, 1,      'D API not called second time')
}

// ─── Section E — Fail-open paths ───────────────────────────────────
section('E — fail-open behavior')
{
  // E1: criticClient missing
  const r1 = await criticRun(env, pathR, trustR, {
    ...baseCtx, decision_id: 'e1',
    preflightContext: {},
  })
  eq(r1.verdict, 'proceed',         'E1 missing client → verdict=proceed')
  eq(r1.status,  'unavailable',      'E1 status=unavailable')
  eq(r1.reason_code, 'critic_unavailable', 'E1 reason=critic_unavailable')

  // E2: client throws
  const stubThrow = stubClient(['throw'])
  const r2 = await criticRun(env, pathR, trustR, {
    ...baseCtx, decision_id: 'e2',
    preflightContext: {}, criticClient: stubThrow,
  })
  eq(r2.verdict, 'proceed',          'E2 client throw → verdict=proceed')
  eq(r2.status,  'unavailable',       'E2 status=unavailable')

  // E3: parse error (returns garbage)
  const stubGarbage = stubClient(['this is not json at all'])
  const r3 = await criticRun(env, pathR, trustR, {
    ...baseCtx, decision_id: 'e3',
    preflightContext: {}, criticClient: stubGarbage,
  })
  eq(r3.verdict, 'proceed',           'E3 parse error → verdict=proceed')
  eq(r3.status,  'parse_error',        'E3 status=parse_error')
  eq(r3.reason_code, 'critic_parse_error', 'E3 reason=critic_parse_error')

  // E4: prompt too large
  const stub = stubClient(['{"verdict":"proceed","confidence":"low","concerns":[],"reason":"r"}'])
  const r4 = await criticRun(env, pathR, trustR, {
    ...baseCtx, decision_id: 'e4',
    preflightContext: {}, criticClient: stub,
    max_input_tokens: 1,    // force too-large
  })
  eq(r4.verdict, 'proceed',           'E4 too large → verdict=proceed')
  eq(r4.status,  'too_large',          'E4 status=too_large')
  eq(stub.callCount, 0,                'E4 client never called')

  // E5: timeout
  const stubSlow = stubClient(['timeout'])
  const r5 = await criticRun(env, pathR, trustR, {
    ...baseCtx, decision_id: 'e5',
    preflightContext: {}, criticClient: stubSlow, timeout_ms: 50,
  })
  eq(r5.verdict, 'proceed',           'E5 timeout → verdict=proceed')
  eq(r5.status,  'timeout',            'E5 status=timeout')
  eq(r5.reason_code, 'critic_timeout', 'E5 reason=critic_timeout')
}

// ─── Section F — Trace event integration ───────────────────────────
section('F — Trace integration')
{
  const stub = stubClient([JSON.stringify({ verdict: 'concern', confidence: 'medium', concerns: ['weather_concern'], reason: 'r' })])
  const captured = []
  const traceStub = { writeAsync: (ev) => captured.push(ev) }
  await criticRun(env, pathR, trustR, {
    ...baseCtx, decision_id: 'f1',
    preflightContext: { pitcherNews: [] }, criticClient: stub,
    emit_trace: true, trace: traceStub,
  })
  eq(captured.length, 1, 'F single trace event')
  let validateThrew = null
  try { validateTraceEvent(captured[0]) } catch (e) { validateThrew = e.message }
  eq(validateThrew, null, 'F validateTraceEvent passes')
  eq(captured[0].layer_name, 'critic',  'F event.layer_name')
  eq(captured[0].decision,   'concern', 'F event.decision=concern')
  eq(captured[0].evidence_used.length, 4, 'F evidence has 4 entries (L1+L2+L3+preflight)')

  // Fail-open path emits warn-severity event
  const stubBad = stubClient(['throw'])
  const captured2 = []
  await criticRun(env, pathR, trustR, {
    ...baseCtx, decision_id: 'f2',
    preflightContext: {}, criticClient: stubBad,
    emit_trace: true, trace: { writeAsync: (ev) => captured2.push(ev) },
  })
  eq(captured2.length, 1, 'F fail-open event emitted')
  eq(captured2[0].severity, 'warn', 'F fail-open event severity=warn')
}

// ─── Section G — ctx validation ────────────────────────────────────
section('G — ctx validation')
{
  await throws(() => criticRun(env, pathR, trustR, { ...baseCtx, decision_id: '' }), 'G empty decision_id throws')
  await throws(() => criticRun(env, pathR, trustR, { ...baseCtx, strike: 'six' }),   'G non-integer strike throws')
  await throws(() => criticRun(env, pathR, trustR, { ...baseCtx, side: 'X' }),       'G bad side throws')
}

console.log(`\n═══════════════════════════════════════════`)
console.log(`  ${_passed} passed, ${_failed} failed`)
console.log('═══════════════════════════════════════════')
process.exit(_failed > 0 ? 1 : 0)
