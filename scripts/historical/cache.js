// scripts/historical/cache.js — JSON-file disk cache for historical fetchers.
//
// Every external API call should round-trip through `getCached()` so we
// don't re-pay for credits during iterative development / reruns.

import fs from 'node:fs/promises'
import fssync from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
export const CACHE_ROOT = path.resolve(__dirname, 'cache')

export function cachePath(namespace, id) {
  // Basic safety: normalise id -> filename-safe token
  const safe = String(id).replace(/[^a-zA-Z0-9._-]+/g, '_')
  return path.join(CACHE_ROOT, namespace, `${safe}.json`)
}

export async function readCache(namespace, id) {
  const p = cachePath(namespace, id)
  try {
    const raw = await fs.readFile(p, 'utf-8')
    return JSON.parse(raw)
  } catch (err) {
    if (err.code === 'ENOENT') return null
    return null
  }
}

export async function writeCache(namespace, id, data) {
  const p = cachePath(namespace, id)
  await fs.mkdir(path.dirname(p), { recursive: true })
  await fs.writeFile(p, JSON.stringify(data, null, 0), 'utf-8')
}

export function hasCache(namespace, id) {
  try {
    return fssync.existsSync(cachePath(namespace, id))
  } catch {
    return false
  }
}

/**
 * Convenience wrapper: fetch via `loader()` if not in cache, else return cached.
 */
export async function getCached(namespace, id, loader, { force = false } = {}) {
  if (!force) {
    const hit = await readCache(namespace, id)
    if (hit !== null) return hit
  }
  const fresh = await loader()
  if (fresh !== null && fresh !== undefined) {
    await writeCache(namespace, id, fresh)
  }
  return fresh
}

export function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}
