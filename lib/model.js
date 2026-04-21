// lib/model.js — Node -> Python XGBoost subprocess bridge
//
// Writes JSON to stdin and reads JSON from stdout. Handles both single-row
// predictions (normal pipeline) and batch predictions (backtest).

import { spawn } from 'node:child_process'
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

/**
 * Run the Python predict.py bridge.
 *
 * @param {object|object[]} features - a single feature dict or array for batch.
 * @param {object} [opts]
 * @param {string} [opts.modelDir]  - override model directory
 * @returns {Promise<object|object[]>} — { probability, shap } (array if batch)
 */
export function predict(features, { modelDir } = {}) {
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
      if (code !== 0) {
        return reject(new Error(`predict.py exited ${code}: ${err || '(no stderr)'}`))
      }
      try {
        resolve(JSON.parse(out.trim()))
      } catch (e) {
        reject(new Error(`predict.py returned non-JSON: ${out}\nstderr: ${err}`))
      }
    })

    const payload = JSON.stringify({ model_dir: dir, features })
    proc.stdin.write(payload)
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
