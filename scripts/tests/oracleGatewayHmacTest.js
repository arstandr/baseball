// scripts/tests/oracleGatewayHmacTest.js
// Tests for oracle/layers/6-gateway/hmac.js + killswitchCache.js

import {
  sha256Hex,
  sign,
  verifySignature,
  makeSignaturePayload,
  isTimestampFresh,
  checkBodyHash,
  TIMESTAMP_SKEW_MS,
  NONCE_TTL_MS,
} from '../../oracle/layers/6-gateway/hmac.js'

import {
  makeKillswitchCache,
  normalize,
  KILLSWITCH_TTL_MS,
} from '../../oracle/layers/6-gateway/killswitchCache.js'

let _passed = 0, _failed = 0
const ok  = (c, l) => c ? _passed++ : (_failed++, console.error(`FAIL [${l}]`))
const eq  = (a, b, l) => a === b ? _passed++ : (_failed++, console.error(`FAIL [${l}]: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`))
const not = (c, l) => !c ? _passed++ : (_failed++, console.error(`FAIL [${l}]: expected falsy`))
const section = n => console.log(`\n── ${n} ──`)

// ─── sha256Hex ───────────────────────────────────────────────────────────
section('sha256Hex')
eq(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'empty string')
eq(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 'abc')
eq(sha256Hex(Buffer.from('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 'buffer abc')
ok(sha256Hex('').length === 64, 'always 64 hex chars')

// ─── makeSignaturePayload + sign ────────────────────────────────────────
section('sign + verifySignature')
const SECRET = 'super-secret-test-key'
const ts = 1714499000000
const nonce = '11111111-2222-3333-4444-555555555555'
const body = '{"hello":"world"}'
const bodyHash = sha256Hex(body)
const sig = sign({ secret: SECRET, timestamp: ts, nonce, bodySha256: bodyHash })
ok(/^[a-f0-9]{64}$/.test(sig), 'signature is 64 hex chars')
ok(verifySignature({ secret: SECRET, timestamp: ts, nonce, bodySha256: bodyHash, signature: sig }), 'valid signature verifies')

// payload format
eq(makeSignaturePayload(ts, nonce, bodyHash), `${ts}.${nonce}.${bodyHash}`, 'payload format')

// ─── verifySignature — negative cases ────────────────────────────────
section('verifySignature negative cases')
not(verifySignature({ secret: 'wrong-secret', timestamp: ts, nonce, bodySha256: bodyHash, signature: sig }), 'wrong secret rejected')
not(verifySignature({ secret: SECRET, timestamp: ts + 1, nonce, bodySha256: bodyHash, signature: sig }), 'wrong timestamp rejected')
not(verifySignature({ secret: SECRET, timestamp: ts, nonce: 'other-nonce', bodySha256: bodyHash, signature: sig }), 'wrong nonce rejected')
not(verifySignature({ secret: SECRET, timestamp: ts, nonce, bodySha256: 'a'.repeat(64), signature: sig }), 'wrong body hash rejected')
not(verifySignature({ secret: SECRET, timestamp: ts, nonce, bodySha256: bodyHash, signature: 'b'.repeat(64) }), 'flipped sig rejected')
not(verifySignature({ secret: SECRET, timestamp: ts, nonce, bodySha256: bodyHash, signature: 'too-short' }), 'malformed sig rejected')
not(verifySignature({ secret: SECRET, timestamp: ts, nonce, bodySha256: bodyHash, signature: '' }), 'empty sig rejected')
not(verifySignature({ secret: '', timestamp: ts, nonce, bodySha256: bodyHash, signature: sig }), 'empty secret rejected')

// constant-time-ish: verifying a one-bit-flipped signature still returns false (not throws)
{
  const flipped = sig.slice(0, -1) + (sig.slice(-1) === 'a' ? 'b' : 'a')
  not(verifySignature({ secret: SECRET, timestamp: ts, nonce, bodySha256: bodyHash, signature: flipped }), 'one-bit-flip rejected')
}

// sign throws on missing args
let threw = false
try { sign({ timestamp: ts, nonce, bodySha256: bodyHash }) } catch { threw = true }
ok(threw, 'sign throws without secret')
threw = false
try { sign({ secret: SECRET, nonce, bodySha256: bodyHash }) } catch { threw = true }
ok(threw, 'sign throws without timestamp')

// ─── isTimestampFresh ────────────────────────────────────────────────
section('isTimestampFresh')
const NOW = 1714499000000
ok(isTimestampFresh(NOW, NOW), 'same ts is fresh')
ok(isTimestampFresh(NOW - 29_000, NOW), '29s old is fresh')
ok(isTimestampFresh(NOW - 30_000, NOW), 'exactly 30s is fresh (boundary)')
not(isTimestampFresh(NOW - 31_000, NOW), '31s old not fresh')
ok(isTimestampFresh(NOW + 25_000, NOW), '25s in future is fresh (clock skew)')
not(isTimestampFresh(NOW + 31_000, NOW), '31s in future not fresh')
not(isTimestampFresh('not-a-number', NOW), 'non-numeric not fresh')
not(isTimestampFresh(undefined, NOW), 'undefined not fresh')
eq(TIMESTAMP_SKEW_MS, 30_000, 'TIMESTAMP_SKEW_MS = 30s')
eq(NONCE_TTL_MS, 60_000, 'NONCE_TTL_MS = 60s')

// ─── checkBodyHash ────────────────────────────────────────────────────
section('checkBodyHash')
ok(checkBodyHash('abc', sha256Hex('abc')), 'matching body hash')
not(checkBodyHash('abc', sha256Hex('xyz')), 'mismatched body hash')
not(checkBodyHash('abc', 'invalid-hex'), 'malformed header rejected')
not(checkBodyHash('abc', undefined), 'missing header rejected')
not(checkBodyHash('abc', 'A'.repeat(64)), 'uppercase hex rejected')  // we lowercased

// ─── killswitchCache.normalize ────────────────────────────────────────
section('normalize — defaults when row absent')
{
  const snap = normalize([])
  eq(snap.gateway_kill_all, false, 'default kill_all=false')
  eq(snap.gateway_kill_agent.length, 0, 'default kill_agent=[]')
  eq(Object.keys(snap.min_version_by_agent).length, 0, 'default min_version={}')
}

section('normalize — primitives + JSON')
{
  const snap = normalize([
    { key: 'gateway_kill_all', value: 'true' },
    { key: 'gateway_kill_agent', value: '["closer-legacy"]' },
    { key: 'min_version_by_agent', value: '{"closer-legacy":"0.7.3"}' },
    { key: 'monitor_only_stale_agent', value: '{"closer-legacy":true}' },
    { key: 'daily_loss_limit_by_account', value: '{"adam":250,"isaiah":500}' },
  ])
  eq(snap.gateway_kill_all, true, 'kill_all=true')
  eq(snap.gateway_kill_agent[0], 'closer-legacy', 'kill_agent has closer-legacy')
  eq(snap.min_version_by_agent['closer-legacy'], '0.7.3', 'min_version parsed')
  eq(snap.monitor_only_stale_agent['closer-legacy'], true, 'monitor_only parsed')
  eq(snap.daily_loss_limit_by_account.adam, 250, 'adam loss limit')
  ok(typeof snap._fetchedAt === 'number', 'fetchedAt is number')
}

section('normalize — corrupt JSON falls back to default')
{
  const snap = normalize([{ key: 'gateway_kill_agent', value: 'not-json[]' }])
  eq(snap.gateway_kill_agent.length, 0, 'corrupt JSON falls back to []')
}

// ─── killswitchCache TTL behavior ────────────────────────────────────
section('cache: TTL respected, fetcher called once within TTL')
{
  let fetchCount = 0
  let nowVal = 1_000_000
  const cache = makeKillswitchCache({
    fetcher: async () => { fetchCount++; return [{ key: 'gateway_kill_all', value: 'false' }] },
    ttlMs: 1000,
    now: () => nowVal,
  })
  await cache.get()
  await cache.get()
  await cache.get()
  eq(fetchCount, 1, 'within TTL: one fetch')
  nowVal += 999
  await cache.get()
  eq(fetchCount, 1, '999ms later still cached')
  nowVal += 2  // 1001ms total → expired
  await cache.get()
  eq(fetchCount, 2, 'after TTL expiry: refetch')
}

section('cache: invalidate forces refetch')
{
  let fetchCount = 0
  const cache = makeKillswitchCache({
    fetcher: async () => { fetchCount++; return [] },
    ttlMs: 100_000,
  })
  await cache.get()
  await cache.get()
  eq(fetchCount, 1, 'two reads, one fetch')
  cache.invalidate()
  await cache.get()
  eq(fetchCount, 2, 'invalidate forces refetch')
}

section('cache: concurrent requests share single fetcher call')
{
  let fetchCount = 0
  const cache = makeKillswitchCache({
    fetcher: async () => { fetchCount++; await new Promise(r => setTimeout(r, 10)); return [] },
  })
  const results = await Promise.all([cache.get(), cache.get(), cache.get(), cache.get(), cache.get()])
  eq(fetchCount, 1, '5 concurrent gets → 1 fetch')
  ok(results.every(r => r === results[0]), 'all return same snapshot')
}

section('cache: peek returns null before first load')
{
  const cache = makeKillswitchCache({ fetcher: async () => [] })
  eq(cache.peek(), null, 'peek before load = null')
  await cache.get()
  ok(cache.peek() !== null, 'peek after load = snapshot')
}

section('cache: missing fetcher throws')
{
  let threw = false
  try { makeKillswitchCache() } catch { threw = true }
  ok(threw, 'no fetcher → throws')
}

eq(KILLSWITCH_TTL_MS, 1000, 'KILLSWITCH_TTL_MS = 1s')

// ─── Summary ───────────────────────────────────────────────────────────
console.log(`\n${_passed} passed, ${_failed} failed`)
process.exit(_failed > 0 ? 1 : 0)
