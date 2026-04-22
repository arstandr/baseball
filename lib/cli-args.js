// lib/cli-args.js — Shared CLI argument parser for scripts.
//
// Replaces the duplicated process.argv parsing block that appears in every
// scripts/live/*.js file.
//
// Usage:
//   import { parseArgs } from '../../lib/cli-args.js'
//   const opts = parseArgs({
//     date:     { default: new Date().toISOString().slice(0,10) },
//     days:     { type: 'number', default: 30 },
//     verbose:  { type: 'boolean' },
//     minEdge:  { flag: 'min-edge', type: 'number', default: 0.05 },
//   })
//
// Schema fields:
//   flag    — CLI flag name (default: same as key with camelCase → kebab-case)
//   type    — 'string' (default) | 'number' | 'boolean'
//   default — value when flag is absent

function camelToKebab(str) {
  return str.replace(/([A-Z])/g, '-$1').toLowerCase()
}

export function parseArgs(schema) {
  const argv = process.argv.slice(2)
  const result = {}

  for (const [key, opts] of Object.entries(schema)) {
    const flag = opts.flag || camelToKebab(key)
    const type = opts.type || 'string'

    if (type === 'boolean') {
      result[key] = argv.includes(`--${flag}`)
    } else {
      const idx = argv.indexOf(`--${flag}`)
      const raw = idx >= 0 ? argv[idx + 1] : null
      if (raw == null) {
        result[key] = opts.default !== undefined ? opts.default : null
      } else {
        result[key] = type === 'number' ? Number(raw) : raw
      }
    }
  }

  return result
}
