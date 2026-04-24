// lib/model.js — Node -> Python XGBoost subprocess bridge
//
// Daemon mode (default): a single Python process is kept alive and reused
// across all predictions in the same Node process. Requests are serialized
// via a promise queue — no interleaving. Eliminates 50-200ms spawn overhead
// per prediction.
//
// One-shot fallback: callers that pass { daemon: false } get the old behavior
// (spawn → write → read → exit). Useful for batch scripts that run once.

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs/promises'
import 'dotenv/config'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PYTHON = process.env.PYTHON_BIN || 'python3'
const DEFAULT_MODEL_DIR = path.resolve(__dirname, '..', 'models', 'artifacts')

/**
 * Resolve the active model directory. Honors MODEL_VERSION env var if set,
 * otherwise picks the latest subdirectory of models/artifacts/.
 */
export async function resolveActiveModelDir() {
  const envVer = process.env.MODEL_VERSION
  if (envVer) return path.join(DEFAULT_MODEL_DIR, envVer)
  try {
    const entries = await fs.readdir(DEFAULT_MODEL_DIR, { withFileTypes: true })
    const dirs = entries.filter(e => e.isDirectory()).map(e => e.name).sort()
    if (!dirs.length) return null
    return path.join(DEFAULT_MODEL_DIR, dirs[dirs.length - 1])
  } catch {
    return null
  }
}

// ── Persistent daemon state ───────────────────────────────────────────────────

let _daemonProc   = null   // child_process.ChildProcess
let _daemonDir    = null   // model dir the daemon was started with
let _daemonRl     = null   // readline interface on daemon stdout
let _daemonReady  = false  // true once Python emits "READY" on stderr
let _serialQueue  = Promise.resolve()  // serialize all daemon calls

async function _ensureDaemon(dir) {
  if (_daemonProc && !_daemonProc.killed && _daemonDir === dir && _daemonReady) {
    return
  }
  // Kill stale daemon (wrong dir or crashed)
  if (_daemonProc && !_daemonProc.killed) _daemonProc.kill()
  _daemonProc  = null
  _daemonRl    = null
  _daemonReady = false
  _daemonDir   = dir

  const script = path.resolve(__dirname, '..', 'models', 'predict.py')
  _daemonProc = spawn(PYTHON, [script, '--daemon', dir], { stdio: ['pipe', 'pipe', 'pipe'] })

  _daemonRl = createInterface({ input: _daemonProc.stdout, crlfDelay: Infinity })
  _daemonProc.on('exit', () => { _daemonProc = null; _daemonReady = false })
  _daemonProc.on('error', () => { _daemonProc = null; _daemonReady = false })
  _daemonProc.stderr.on('data', d => {
    if (d.toString().includes('READY')) _daemonReady = true
  })

  // Wait for the model to load (READY signal) — up to 20s
  const deadline = Date.now() + 20_000
  while (!_daemonReady) {
    if (Date.now() > deadline) throw new Error('predict daemon failed to start within 20s')
    if (_daemonProc === null) throw new Error('predict daemon exited before READY')
    await new Promise(r => setTimeout(r, 50))
  }
}

async function _daemonPredict(features, dir) {
  await _ensureDaemon(dir)

  return new Promise((resolve, reject) => {
    // One-shot listener on the readline interface — next emitted line is our response
    const handler = line => {
      try {
        const result = JSON.parse(line)
        if (result?.error) reject(new Error(`predict.py: ${result.error}`))
        else resolve(result)
      } catch {
        reject(new Error(`predict daemon returned non-JSON: ${line}`))
      }
    }
    _daemonRl.once('line', handler)
    _daemonProc.stdin.write(JSON.stringify({ features }) + '\n')
  })
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Predict using the persistent daemon (default) or one-shot subprocess.
 *
 * @param {object|object[]} features
 * @param {object} [opts]
 * @param {string}  [opts.modelDir]  - override model directory
 * @param {boolean} [opts.daemon]    - false to use one-shot spawn (default: true)
 */
export function predict(features, { modelDir, daemon = true } = {}) {
  if (!daemon) return _predictOneShot(features, modelDir)

  // Serialize daemon calls — one at a time, no interleaving
  _serialQueue = _serialQueue.then(async () => {
    const dir = modelDir || (await resolveActiveModelDir())
    if (!dir) throw new Error('no model_dir — train a model first or set MODEL_VERSION')
    return _daemonPredict(features, dir)
  })
  return _serialQueue
}

function _predictOneShot(features, modelDir) {
  return new Promise(async (resolve, reject) => {
    const dir = modelDir || (await resolveActiveModelDir())
    if (!dir) return reject(new Error('no model_dir — train a model first or set MODEL_VERSION'))
    const script = path.resolve(__dirname, '..', 'models', 'predict.py')
    const proc = spawn(PYTHON, [script], { stdio: ['pipe', 'pipe', 'pipe'] })

    let out = ''
    let err = ''
    proc.stdout.on('data', d => { out += d.toString() })
    proc.stderr.on('data', d => { err += d.toString() })
    proc.on('error', reject)
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(`predict.py exited ${code}: ${err || '(no stderr)'}`))
      try { resolve(JSON.parse(out.trim())) }
      catch { reject(new Error(`predict.py returned non-JSON: ${out}`)) }
    })
    proc.stdin.write(JSON.stringify({ model_dir: dir, features }))
    proc.stdin.end()
  })
}

/**
 * Convenience: run predict + compute the implied probability + edge vs a market line.
 */
export async function predictGame({ features, marketImpliedOver, modelDir }) {
  const result = await predict(features, { modelDir })
  const over_probability = result.probability
  return {
    over_probability,
    projected_total: impliedTotalFromProbability(over_probability, features.mkt_current_line),
    edge: over_probability - (marketImpliedOver ?? 0.5),
    shap: result.shap,
  }
}

/**
 * Rough projected full-game total — inverse of the standard line-to-probability
 * mapping. We assume a linear sensitivity around the current line:
 *   projected_total ~ line + 2 * (prob_over - 0.5)
 * (Each 10% probability shift = 0.5 runs move — calibrated against historical
 * odds-movement data.)
 */
function impliedTotalFromProbability(prob, line) {
  if (line == null) return null
  return Number((line + 2 * (prob - 0.5)).toFixed(2))
}
