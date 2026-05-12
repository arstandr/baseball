// oracle/layers/6-gateway/deadLetter.js
//
// Append-only JSONL dead-letter store on persistent disk.
// Used when a post-exchange Trace writeSync fails — the order is real, but
// the ledger gap must be recoverable.
//
// Spec contract:
//   - One JSON object per line
//   - fsync after each write so a crash doesn't lose the line
//   - Replay-on-startup reads + returns pending records (operator decides
//     when to mark them processed)
//   - Probe writes a synthetic line, fsyncs, reads back, deletes — used by
//     the GATEWAY_BLIND auto-clear path
//   - Sentinel file at <basePath>/.gateway_sentinel records the running
//     commit_hash on startup; absence on next start = volume not persistent
//
// Default basePath: /data/oracle/dead-letter
// V2 cutover prerequisite: Railway persistent volume mounted at /data
//
// API:
//   const dl = makeDeadLetter({ basePath, now, commitHash })
//   await dl.init()                          → ensure dirs + sentinel
//   await dl.write(record)                   → append + fsync (throws on fail)
//   await dl.probe()                         → { ok: true } | { ok: false, error }
//   const pending = await dl.replay()        → array of records still in files
//   await dl.markProcessed(file)             → rename to .processed
//   const status = await dl.peekVolumeStatus()

import fs from 'node:fs/promises'
import fssync from 'node:fs'
import path from 'node:path'

const DEFAULT_BASE = '/data/oracle/dead-letter'

function fileNameFor(now) {
  const d = new Date(now).toISOString().slice(0, 10)
  return `gateway-${d}.jsonl`
}

export function makeDeadLetter(opts = {}) {
  const basePath  = opts.basePath  ?? DEFAULT_BASE
  const now       = opts.now       ?? (() => Date.now())
  const commit    = opts.commitHash ?? process.env.COMMIT_HASH ?? 'unknown'

  let _initialized = false

  async function ensureDir() {
    await fs.mkdir(basePath, { recursive: true })
  }

  async function readSentinel() {
    try {
      return (await fs.readFile(path.join(basePath, '.gateway_sentinel'), 'utf-8')).trim()
    } catch (err) {
      if (err.code === 'ENOENT') return null
      throw err
    }
  }

  async function writeSentinel() {
    const file = path.join(basePath, '.gateway_sentinel')
    const tmp = file + '.tmp'
    await fs.writeFile(tmp, `${commit}\n${new Date(now()).toISOString()}\n`)
    await fs.rename(tmp, file)
  }

  // ── init: create dirs, write sentinel, return whether prior sentinel existed ──
  async function init() {
    await ensureDir()
    const prior = await readSentinel()
    await writeSentinel()
    _initialized = true
    return {
      base_path: basePath,
      had_prior_sentinel: prior != null,
      prior_value: prior,
      current_commit: commit,
    }
  }

  // ── write: append one JSON line + fsync ─────────────────────────────────
  async function write(record) {
    if (!_initialized) await ensureDir()
    const file = path.join(basePath, fileNameFor(now()))
    const line = JSON.stringify({
      _written_at: new Date(now()).toISOString(),
      commit_hash: commit,
      ...record,
    }) + '\n'

    // Open with O_APPEND, write, fsync, close.
    let fh
    try {
      fh = await fs.open(file, 'a')
      await fh.write(line)
      await fh.sync()
    } finally {
      if (fh) await fh.close().catch(() => {})
    }
  }

  // ── probe: synthetic write+read+delete to confirm volume health ─────────
  async function probe() {
    try {
      if (!_initialized) await ensureDir()
      const file = path.join(basePath, `.probe-${now()}.jsonl`)
      const payload = JSON.stringify({ probe: true, at: new Date(now()).toISOString() }) + '\n'
      let fh
      try {
        fh = await fs.open(file, 'w')
        await fh.write(payload)
        await fh.sync()
      } finally {
        if (fh) await fh.close().catch(() => {})
      }
      const back = await fs.readFile(file, 'utf-8')
      await fs.unlink(file).catch(() => {})
      if (back !== payload) {
        return { ok: false, error: 'roundtrip_content_mismatch' }
      }
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err.message?.slice(0, 200) ?? 'unknown' }
    }
  }

  // ── replay: read all *.jsonl files (not .processed), return parsed lines ─
  async function replay() {
    try { await ensureDir() } catch { /* ignore */ }
    const dirents = await fs.readdir(basePath, { withFileTypes: true }).catch(() => [])
    const files = dirents
      .filter(d => d.isFile() && d.name.endsWith('.jsonl') && !d.name.startsWith('.probe-'))
      .map(d => path.join(basePath, d.name))
      .sort()

    const records = []
    for (const f of files) {
      const raw = await fs.readFile(f, 'utf-8').catch(() => '')
      const lines = raw.split('\n').filter(l => l.trim())
      for (const line of lines) {
        try {
          records.push({ _file: f, ...JSON.parse(line) })
        } catch {
          records.push({ _file: f, _parse_failed: true, _raw: line.slice(0, 500) })
        }
      }
    }
    return records
  }

  async function markProcessed(file) {
    if (!file.startsWith(basePath)) {
      throw new Error('markProcessed: file outside basePath')
    }
    const newName = file + '.processed'
    await fs.rename(file, newName)
  }

  async function peekVolumeStatus() {
    try {
      const prior = await readSentinel()
      const stat = await fs.stat(basePath)
      return {
        base_path: basePath,
        exists: true,
        sentinel_present: prior != null,
        sentinel_value: prior,
        current_commit: commit,
        is_directory: stat.isDirectory(),
      }
    } catch (err) {
      return { base_path: basePath, exists: false, error: err.message }
    }
  }

  return { init, write, probe, replay, markProcessed, peekVolumeStatus }
}
