// oracle/layers/6-gateway/hmac.js
//
// HMAC sign + verify for Gateway requests.
//
// Signature scheme (locked spec v1.0 §2):
//   bodySha256       = sha256_hex(rawBody)
//   signaturePayload = `${timestamp}.${nonce}.${bodySha256}`
//   signature        = hex(HMAC_SHA256(secret_for_agent, signaturePayload))
//
// Server recomputes bodySha256 from raw bytes received and compares to the
// header BEFORE recomputing the signature. This isolates JSON-serialization
// bugs from auth bugs.
//
// Constant-time comparison via crypto.timingSafeEqual to avoid timing attacks.

import crypto from 'node:crypto'

export const TIMESTAMP_SKEW_MS = 30_000
export const NONCE_TTL_MS = 60_000

export function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex')
}

export function makeSignaturePayload(timestamp, nonce, bodySha256) {
  return `${timestamp}.${nonce}.${bodySha256}`
}

export function sign({ secret, timestamp, nonce, bodySha256 }) {
  if (!secret) throw new Error('sign: missing secret')
  if (timestamp == null || nonce == null || bodySha256 == null) {
    throw new Error('sign: missing timestamp/nonce/bodySha256')
  }
  const payload = makeSignaturePayload(timestamp, nonce, bodySha256)
  return crypto.createHmac('sha256', secret).update(payload).digest('hex')
}

export function verifySignature({ secret, timestamp, nonce, bodySha256, signature }) {
  if (!secret || !signature || timestamp == null || !nonce || !bodySha256) return false
  if (typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature)) return false
  const expected = sign({ secret, timestamp, nonce, bodySha256 })
  try {
    const a = Buffer.from(expected, 'hex')
    const b = Buffer.from(signature, 'hex')
    if (a.length !== b.length) return false
    return crypto.timingSafeEqual(a, b)
  } catch {
    return false
  }
}

export function isTimestampFresh(timestamp, now = Date.now(), skewMs = TIMESTAMP_SKEW_MS) {
  const ts = Number(timestamp)
  if (!Number.isFinite(ts)) return false
  return Math.abs(now - ts) <= skewMs
}

export function checkBodyHash(rawBody, headerSha256) {
  if (typeof headerSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(headerSha256)) return false
  const computed = sha256Hex(rawBody)
  return computed === headerSha256
}
