// scripts/tests/oracleGatewayInProcessTest.js
//
// In-process modules: traceAdapter, deadLetter, halt.
// Run: node scripts/tests/oracleGatewayInProcessTest.js

import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { makeTraceAdapter } from '../../oracle/layers/6-gateway/traceAdapter.js'
import { makeDeadLetter } from '../../oracle/layers/6-gateway/deadLetter.js'
import { makeHaltState, HALT_AUTOCLEAR_THRESHOLD } from '../../oracle/layers/6-gateway/halt.js'

let _passed = 0, _failed = 0
const ok  = (c, l) => c ? _passed++ : (_failed++, console.error(`FAIL [${l}]`))
const eq  = (a, b, l) => a === b ? _passed++ : (_failed++, console.error(`FAIL [${l}]: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`))
const section = n => console.log(`\n── ${n} ──`)

// ════════════════════════════════════════════════════════════════════════
// traceAdapter
// ════════════════════════════════════════════════════════════════════════
section('traceAdapter — constructor validation')
{
  let threw = false
  try { makeTraceAdapter(null) } catch { threw = true }
  ok(threw, 'null traceModule throws')
}
{
  let threw = false
  try { makeTraceAdapter({ writeSync: () => {} }) } catch { threw = true }
  ok(threw, 'partial traceModule (no makeEvent) throws')
}

section('traceAdapter — forRequest injects per-request context')
{
  const calls = []
  const mock = {
    makeEvent: (p) => { calls.push(p); return { ...p, id: 'fake' } },
    writeSync: async () => {},
    writeAsync: async () => {},
  }
  const adapter = makeTraceAdapter(mock, { layerName: 'gateway', system: 'oracle' })
  const reqTrace = adapter.forRequest({
    headers: {
      'x-gateway-agent': 'closer-legacy',
      'x-gateway-agent-version': '0.7.3',
      'x-gateway-commit': 'a'.repeat(40),
    },
    body: { execution_mode: 'production' },
    requestId: 'req-1',
    runId: 'run-1',
  })
  const ev = reqTrace.makeEvent({
    decision_id: 'd-1',
    event_type: 'gateway_intent',
    decision: 'accept',
    pitcher_id: '0', pitcher_name: 'x', bet_date: '2026-04-30', strike: 0, side: 'YES',
  })
  eq(calls.length, 1, 'mock makeEvent called once')
  eq(calls[0].agent_id, 'closer-legacy', 'agent_id injected from header')
  eq(calls[0].agent_version, '0.7.3', 'agent_version injected')
  eq(calls[0].commit_hash, 'a'.repeat(40), 'commit_hash injected')
  eq(calls[0].mode, 'production', 'mode from body.execution_mode')
  eq(calls[0].layer_name, 'gateway', 'layer_name from staticContext')
  eq(calls[0].system, 'oracle', 'system from staticContext')
  eq(calls[0].request_id, 'req-1', 'request_id forwarded')
  eq(calls[0].run_id, 'run-1', 'run_id forwarded')
  eq(calls[0].event_type, 'gateway_intent', 'caller-supplied event_type wins')
  eq(calls[0].decision, 'accept', 'caller-supplied decision wins')
}

section('traceAdapter — caller fields override request context')
{
  const calls = []
  const mock = {
    makeEvent: (p) => { calls.push(p); return p },
    writeSync: async () => {}, writeAsync: async () => {},
  }
  const reqTrace = makeTraceAdapter(mock).forRequest({
    headers: { 'x-gateway-agent': 'closer-legacy', 'x-gateway-agent-version': '0.7.3', 'x-gateway-commit': 'a'.repeat(40) },
    body: { execution_mode: 'production' },
  })
  reqTrace.makeEvent({
    decision_id: 'd-1', event_type: 'x', decision: 'reject',
    mode: 'shadow',                          // override
    agent_id: 'gateway-probe-agent',         // override
  })
  eq(calls[0].mode, 'shadow', 'caller mode wins')
  eq(calls[0].agent_id, 'gateway-probe-agent', 'caller agent_id wins')
}

section('traceAdapter — defaults when headers missing')
{
  const calls = []
  const mock = { makeEvent: (p) => { calls.push(p); return p }, writeSync: async () => {}, writeAsync: async () => {} }
  const reqTrace = makeTraceAdapter(mock).forRequest({ headers: {}, body: {} })
  reqTrace.makeEvent({ decision_id: 'd-1', event_type: 'x', decision: 'reject' })
  ok(calls[0].agent_id, 'agent_id has fallback')
  eq(calls[0].mode, 'shadow', 'mode default = shadow when execution_mode absent')
}

section('traceAdapter — forSystem for non-request context')
{
  const calls = []
  const mock = { makeEvent: (p) => { calls.push(p); return p }, writeSync: async () => {}, writeAsync: async () => {} }
  const sys = makeTraceAdapter(mock).forSystem({ agent_id: 'gateway-probe-agent', mode: 'shadow' })
  sys.makeEvent({ decision_id: 'probe-1', event_type: 'health_check', decision: 'pass' })
  eq(calls[0].agent_id, 'gateway-probe-agent', 'system agent_id')
  eq(calls[0].mode, 'shadow', 'system mode')
  eq(calls[0].system, 'oracle', 'system staticContext')
}

section('traceAdapter — writeSync/writeAsync pass through unchanged')
{
  const calls = { sync: [], async: [] }
  const mock = {
    makeEvent: (p) => p,
    writeSync: async (e) => { calls.sync.push(e) },
    writeAsync: async (e) => { calls.async.push(e) },
  }
  const t = makeTraceAdapter(mock).forRequest({ headers: {}, body: {} })
  await t.writeSync({ id: 's1' })
  await t.writeAsync({ id: 'a1' })
  eq(calls.sync[0].id, 's1', 'writeSync passthrough')
  eq(calls.async[0].id, 'a1', 'writeAsync passthrough')
}

// ════════════════════════════════════════════════════════════════════════
// deadLetter
// ════════════════════════════════════════════════════════════════════════
section('deadLetter — init creates dirs + sentinel')
const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ogw-dl-'))
{
  const base = path.join(tmpRoot, 'run1')
  const dl = makeDeadLetter({ basePath: base, commitHash: 'sha1' })
  const r = await dl.init()
  eq(r.had_prior_sentinel, false, 'first init has no prior sentinel')
  eq(r.current_commit, 'sha1', 'current commit recorded')
  const s = await dl.peekVolumeStatus()
  eq(s.sentinel_present, true, 'sentinel present after init')
  eq(s.sentinel_value.includes('sha1'), true, 'sentinel value contains commit')
}
{
  // Re-init with a different commit; should detect prior sentinel
  const base = path.join(tmpRoot, 'run1')
  const dl2 = makeDeadLetter({ basePath: base, commitHash: 'sha2' })
  const r = await dl2.init()
  eq(r.had_prior_sentinel, true, 'second init detects prior sentinel')
  ok(r.prior_value.includes('sha1'), 'prior sentinel had old commit')
}

section('deadLetter — write appends JSONL + fsyncs')
{
  const base = path.join(tmpRoot, 'run2')
  const dl = makeDeadLetter({ basePath: base, commitHash: 'sha3', now: () => Date.parse('2026-04-30T10:00:00Z') })
  await dl.init()
  await dl.write({ kind: 'post_exchange_trace_failure', decision_id: 'd-1', error: 'boom' })
  await dl.write({ kind: 'post_exchange_trace_failure', decision_id: 'd-2', error: 'boom2' })
  const file = path.join(base, 'gateway-2026-04-30.jsonl')
  const raw = await fs.readFile(file, 'utf-8')
  const lines = raw.split('\n').filter(l => l.trim())
  eq(lines.length, 2, 'two lines written')
  const parsed = lines.map(JSON.parse)
  eq(parsed[0].decision_id, 'd-1', 'first record')
  eq(parsed[1].decision_id, 'd-2', 'second record')
  eq(parsed[0].commit_hash, 'sha3', 'commit_hash recorded')
  ok(parsed[0]._written_at, '_written_at recorded')
}

section('deadLetter — replay reads pending lines')
{
  const base = path.join(tmpRoot, 'run3')
  const dl = makeDeadLetter({ basePath: base, commitHash: 'shaR' })
  await dl.init()
  await dl.write({ kind: 'a', decision_id: 'd-1' })
  await dl.write({ kind: 'b', decision_id: 'd-2' })
  const recs = await dl.replay()
  eq(recs.length, 2, 'replay returns 2 records')
  eq(recs[0].decision_id, 'd-1', 'first record decision_id')
  ok(recs[0]._file.includes('gateway-'), 'replay attaches _file')
}

section('deadLetter — markProcessed renames the file')
{
  const base = path.join(tmpRoot, 'run3')
  const dl = makeDeadLetter({ basePath: base })
  const before = await fs.readdir(base)
  const jsonl = before.find(f => f.endsWith('.jsonl'))
  ok(jsonl, 'jsonl file exists pre-mark')
  await dl.markProcessed(path.join(base, jsonl))
  const after = await fs.readdir(base)
  ok(!after.includes(jsonl), 'jsonl renamed away')
  ok(after.some(f => f.endsWith('.processed')), '.processed file present')
}

section('deadLetter — markProcessed rejects paths outside basePath')
{
  const dl = makeDeadLetter({ basePath: path.join(tmpRoot, 'run3') })
  let threw = false
  try { await dl.markProcessed('/etc/passwd') } catch { threw = true }
  ok(threw, 'rejects outside basePath')
}

section('deadLetter — probe round-trip')
{
  const base = path.join(tmpRoot, 'run4')
  const dl = makeDeadLetter({ basePath: base, commitHash: 'shaP' })
  await dl.init()
  const r = await dl.probe()
  eq(r.ok, true, 'probe ok=true on healthy disk')
  // Probe file should be cleaned up
  const files = await fs.readdir(base)
  const probeFiles = files.filter(f => f.startsWith('.probe-'))
  eq(probeFiles.length, 0, 'probe file deleted after roundtrip')
}

section('deadLetter — probe returns error when basePath unwritable')
{
  // Use a path that doesn't exist AND can't be created (under /etc which is read-only for non-root on macOS)
  const dl = makeDeadLetter({ basePath: '/etc/nonexistent-readonly/dl' })
  const r = await dl.probe()
  eq(r.ok, false, 'probe ok=false on unwritable basePath')
  ok(r.error, 'probe carries error')
}

section('deadLetter — write throws if disk fail (covered indirectly via probe)')
// Actual disk-fail test is covered by F26 in orchestrator test (which mocks dl.write to throw).

// ════════════════════════════════════════════════════════════════════════
// halt
// ════════════════════════════════════════════════════════════════════════
section('halt — initial state')
{
  const halt = makeHaltState()
  eq(halt.isHalted(), false, 'not halted initially')
  const s = halt.peekStatus()
  eq(s.blind, null, 'blind=null initially')
  eq(s.consecutiveProbeSuccesses, 0, 'counter=0')
}

section('halt — setBlind activates halt')
{
  const halt = makeHaltState({ now: () => 1000 })
  halt.setBlind({ reason: 'GATEWAY_BLIND', detail: 'trace+dl both failed' })
  eq(halt.isHalted(), true, 'halted=true after setBlind')
  const s = halt.peekStatus()
  eq(s.blind.reason, 'GATEWAY_BLIND', 'reason recorded')
  eq(s.blind.at, 1000, 'at recorded')
}

section('halt — setBlind while already blind is idempotent (no reset)')
{
  let t = 1000
  const halt = makeHaltState({ now: () => t })
  halt.setBlind({ reason: 'A', detail: 'first' })
  t = 2000
  halt.setBlind({ reason: 'B', detail: 'second' })
  const s = halt.peekStatus()
  eq(s.blind.reason, 'A', 'first blind retained')
  eq(s.blind.at, 1000, 'at preserved on re-entry')
  // audit captures the re-entry
  ok(halt._peekAudit().some(a => a.action === 'blind_reentry'), 'reentry audited')
}

section('halt — auto-clear after 2 consecutive probe successes')
{
  const cleared = []
  const halt = makeHaltState({ onClear: e => cleared.push(e) })
  halt.setBlind({ reason: 'GATEWAY_BLIND' })
  let r = halt.recordProbeResult(true)
  eq(r.cleared, false, 'first success: not yet cleared')
  eq(r.consecutive, 1, 'consecutive=1')
  r = halt.recordProbeResult(true)
  eq(r.cleared, true, 'second success: cleared')
  eq(r.trigger, 'auto_clear', 'trigger=auto_clear')
  eq(halt.isHalted(), false, 'isHalted false post-clear')
  eq(cleared.length, 1, 'onClear callback fired once')
  eq(cleared[0].trigger, 'auto_clear', 'callback got auto_clear trigger')
}

section('halt — single probe fail resets counter')
{
  const halt = makeHaltState()
  halt.setBlind({ reason: 'GATEWAY_BLIND' })
  halt.recordProbeResult(true)
  halt.recordProbeResult(false)
  const s = halt.peekStatus()
  eq(s.consecutiveProbeSuccesses, 0, 'counter reset on fail')
  eq(halt.isHalted(), true, 'still halted')
  // need 2 trues again
  halt.recordProbeResult(true)
  const r = halt.recordProbeResult(true)
  eq(r.cleared, true, 'cleared after 2 trues post-reset')
}

section('halt — markUnhalt clears regardless of probe state')
{
  const cleared = []
  const halt = makeHaltState({ onClear: e => cleared.push(e) })
  halt.setBlind({ reason: 'GATEWAY_BLIND' })
  const r = halt.markUnhalt('adam', 'manual override')
  eq(r.cleared, true, 'manual unhalt clears')
  eq(r.trigger, 'manual_unhalt', 'trigger=manual_unhalt')
  eq(halt.isHalted(), false, 'no longer halted')
  eq(cleared[0].by, 'adam', 'callback got by')
  eq(cleared[0].reason, 'manual override', 'callback got reason')
}

section('halt — markUnhalt is no-op when not halted')
{
  const halt = makeHaltState()
  const r = halt.markUnhalt('adam')
  eq(r.cleared, false, 'no-op when not halted')
  eq(r.reason, 'not_halted', 'reason=not_halted')
}

section('halt — recordProbeResult while not halted just tracks counter')
{
  const halt = makeHaltState()
  let r = halt.recordProbeResult(true)
  eq(r.cleared, false, 'never cleared if not halted')
  eq(r.reason, 'not_halted', 'reason=not_halted')
  eq(halt.peekStatus().lastProbeResult, true, 'lastProbeResult recorded')
}

section('halt — HALT_AUTOCLEAR_THRESHOLD exported')
eq(HALT_AUTOCLEAR_THRESHOLD, 2, 'threshold exported = 2')

// ─── Cleanup ──────────────────────────────────────────────────────────
console.log(`\n${_passed} passed, ${_failed} failed`)
await fs.rm(tmpRoot, { recursive: true, force: true })
process.exit(_failed > 0 ? 1 : 0)
