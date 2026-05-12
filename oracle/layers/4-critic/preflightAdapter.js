// oracle/layers/4-critic/preflightAdapter.js
//
// L4.2 — Pure normalizer.
//
// Takes pre-fetched preflight context (from lib/preflightCheck pipeline)
// + Layer 1-3 chain summaries, and produces:
//   - a system prompt (role + JSON contract)
//   - a user prompt (compressed bet context + news + signals)
//   - a context hash (for cache key)
//
// No API calls. No I/O. No DB. Unit-testable.

import crypto from 'node:crypto'

export const PROMPT_VERSION = 'critic-v1'

// ─── Vocabularies (must match SPEC.md §5a) ────────────────────────
export const CONCERN_VOCAB = Object.freeze([
  'news_pitcher_injury',
  'news_pitcher_health_concern',
  'news_pitcher_dominance',
  'news_pitcher_recent_struggle',
  'news_opponent_lineup_weak',
  'news_opponent_lineup_strong',
  'news_opponent_lineup_unposted',
  'news_lineup_scratched',
  'weather_concern',
  'weather_favorable',
  'line_move_against_us',
  'line_move_with_us',
  'bullpen_overworked',
  'ump_change',
  'sharp_disagreement_dk',
  'generic_concern',
  'generic_positive',
])

// ─── System prompt ────────────────────────────────────────────────
export function buildSystemPrompt() {
  return `You are Critic, the news/context layer of a sports-betting decision system.

You evaluate a pre-game pitcher strikeout bet AFTER deterministic math/feasibility/trust layers have already produced a tentative decision. Your job is to vote:
- "skip"    : force decision to skip; structural concern (scratched starter, injury, severe weather)
- "concern" : downgrade fire→size_down due to mild concerns
- "proceed" : no change; nothing notable in context
- "boost"   : upgrade size_down→fire because external news genuinely supports the bet

Respond ONLY with strict JSON of this exact shape:
{
  "verdict":    "skip" | "concern" | "proceed" | "boost",
  "confidence": "low" | "medium" | "high",
  "concerns":   ["<vocab_term>", ...],
  "reason":     "<short string explaining the verdict, max 100 chars>"
}

Concern vocabulary (use ONLY these exact strings — no others):
${CONCERN_VOCAB.map(c => '  - ' + c).join('\n')}

Rules:
- "skip" should ONLY fire on hard concerns (scratched starter, injury report, severe weather risk)
- "boost" should ONLY fire when news genuinely supports the bet AND there's a positive concern
- When uncertain, vote "proceed"
- Do NOT invent news. Only react to what's in the prompt
- Keep concerns array short (≤ 4 items)`
}

// ─── Helpers ──────────────────────────────────────────────────────

function shortenNews(items, maxItems = 5, maxChars = 180) {
  if (!Array.isArray(items)) return []
  return items.slice(0, maxItems).map(s => {
    const str = String(s ?? '').replace(/\s+/g, ' ').trim()
    return str.length > maxChars ? str.slice(0, maxChars - 1) + '…' : str
  }).filter(Boolean)
}

function fmtPct(n) {
  if (!Number.isFinite(n)) return '—'
  return (n * 100).toFixed(1) + '%'
}

function fmtNum(n, d = 2) {
  return Number.isFinite(n) ? n.toFixed(d) : '—'
}

function lineupSummary(preflightContext) {
  const lp = preflightContext?.lineupStatus
  if (!lp) return 'unknown'
  const parts = []
  if (lp.scratch_alert) parts.push('SCRATCH_ALERT')
  if (lp.home_lineup_posted) parts.push('home_posted')
  if (lp.away_lineup_posted) parts.push('away_posted')
  if (!lp.home_lineup_posted && !lp.away_lineup_posted) parts.push('not_posted')
  return parts.join(', ')
}

// ─── User prompt ──────────────────────────────────────────────────
export function buildUserPrompt({ chainSummary, preflightContext, betMeta }) {
  const lines = []
  lines.push(`BET: ${betMeta.pitcher_name} K${betMeta.strike} ${betMeta.side} on ${betMeta.bet_date}`)
  lines.push(`CHAIN VERDICT (deterministic, before your vote):`)
  lines.push(`  feasibility = ${chainSummary.feasibility}`)
  lines.push(`  trust       = ${chainSummary.trust_level} (score ${fmtNum(chainSummary.trust_score, 3)})`)
  lines.push(`  edge        = ${fmtPct(chainSummary.edge)}`)
  lines.push(`  market_mid  = ${fmtPct(chainSummary.market_mid)}`)
  lines.push(`  decision    = ${chainSummary.decision_so_far}`)
  lines.push('')

  const pitcherNews = shortenNews(preflightContext?.pitcherNews, 5)
  lines.push('PITCHER NEWS (recent):')
  if (pitcherNews.length) for (const n of pitcherNews) lines.push(`  - ${n}`)
  else                    lines.push('  (none)')
  lines.push('')

  const opponentNews = shortenNews(preflightContext?.opponentNews, 3)
  lines.push('OPPONENT TEAM NEWS:')
  if (opponentNews.length) for (const n of opponentNews) lines.push(`  - ${n}`)
  else                     lines.push('  (none)')
  lines.push('')

  lines.push(`LINEUP: ${lineupSummary(preflightContext)}`)
  if (preflightContext?.lineDelta != null) {
    lines.push(`LINE DIRECTION: ${preflightContext.lineDelta > 0 ? `+${preflightContext.lineDelta}` : preflightContext.lineDelta} (>0 = total moved toward our model)`)
  }
  if (preflightContext?.weatherData) {
    const w = preflightContext.weatherData
    const sum = typeof w === 'string' ? w : (w.summary ?? '')
    const rain = typeof w === 'object' ? w.rainPct : null
    lines.push(`WEATHER: ${sum || 'unknown'}${Number.isFinite(rain) ? ` (rain ${fmtPct(rain)})` : ''}`)
  }
  if (preflightContext?.bullpenData) {
    lines.push(`BULLPEN: ${preflightContext.bullpenData.signal ?? 'unknown'} (IP_2d=${fmtNum(preflightContext.bullpenData.ip_2d, 1)})`)
  }
  if (preflightContext?.umpireData) {
    lines.push(`UMP: ${preflightContext.umpireData.name ?? 'unknown'}${preflightContext.umpireData.changed ? ' (CHANGED)' : ''}`)
  }
  if (preflightContext?.kPropGap != null) {
    lines.push(`DK_GAP_vs_MODEL: ${fmtNum(preflightContext.kPropGap, 2)} K (negative = DK higher than model)`)
  }
  lines.push('')
  lines.push('Vote.')

  return lines.join('\n')
}

// ─── Cache key + context hash ─────────────────────────────────────
export function computeCacheKey({ pitcher_id, bet_date, preflightContext }) {
  const lp = preflightContext?.lineupStatus ?? {}
  const lineupStateHash = crypto.createHash('sha256').update(JSON.stringify({
    home_lineup_posted: !!lp.home_lineup_posted,
    away_lineup_posted: !!lp.away_lineup_posted,
    scratch_alert:      !!lp.scratch_alert,
  })).digest('hex').slice(0, 16)
  const lineDirection = preflightContext?.lineDirection ?? null
  const lineDirectionHash = crypto.createHash('sha256').update(JSON.stringify(lineDirection))
    .digest('hex').slice(0, 16)
  const key = crypto.createHash('sha256').update(JSON.stringify({
    pitcher_id, bet_date, lineupStateHash, lineDirectionHash,
    prompt_version: PROMPT_VERSION,
  })).digest('hex')
  return key
}

// ─── Parse Critic response (handles common LLM output mistakes) ───
//
// The Critic call (real or mocked) is expected to return strict JSON.
// In practice, models sometimes wrap in code fences or add prefix
// commentary. parseCriticResponse handles that defensively.
//
// Returns { ok, parsed?, error? } — ok=false → caller fails open.
export function parseCriticResponse(raw) {
  if (typeof raw !== 'string') return { ok: false, error: 'response_not_string' }
  let s = raw.trim()
  // Strip ```json … ``` fences
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) s = fence[1].trim()
  // Strip leading prose; find first { ... last }
  const first = s.indexOf('{')
  const last  = s.lastIndexOf('}')
  if (first < 0 || last < first) return { ok: false, error: 'no_json_object' }
  const blob = s.slice(first, last + 1)
  let obj
  try { obj = JSON.parse(blob) } catch (err) { return { ok: false, error: 'json_parse: ' + err.message } }

  const validVerdicts = new Set(['skip', 'concern', 'proceed', 'boost'])
  const validConfidence = new Set(['low', 'medium', 'high'])
  if (!validVerdicts.has(obj.verdict))     return { ok: false, error: 'bad_verdict' }
  if (!validConfidence.has(obj.confidence)) return { ok: false, error: 'bad_confidence' }
  if (!Array.isArray(obj.concerns))         return { ok: false, error: 'concerns_not_array' }

  // Filter concerns to vocabulary; keep order, dedupe, cap at 8
  const seen = new Set()
  const concerns = []
  const vocab = new Set(CONCERN_VOCAB)
  for (const c of obj.concerns) {
    if (typeof c !== 'string') continue
    if (!vocab.has(c)) continue
    if (seen.has(c)) continue
    seen.add(c)
    concerns.push(c)
    if (concerns.length >= 8) break
  }
  const reason = typeof obj.reason === 'string' ? obj.reason.slice(0, 200) : ''

  return {
    ok: true,
    parsed: { verdict: obj.verdict, confidence: obj.confidence, concerns, reason },
  }
}

export const ADAPTER_VERSION = '1.0.0'
