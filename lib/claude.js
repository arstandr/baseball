// lib/claude.js — Anthropic SDK wrapper with prompt caching
//
// Prompt-caching strategy:
//   * Scout news layer and Lineup change handler share a long system prompt
//     that is identical across every pitcher/team in a run. We mark it with
//     cache_control: { type: 'ephemeral' } so the second+ call in the day
//     pays only the cache-read cost.
//   * Market synthesis / Judge edge case are lower volume (once per game)
//     so caching helps less, but we still cache their instructions block.
//
// Returned shape: { text, raw, usage } — callers typically JSON.parse(text).

import Anthropic from '@anthropic-ai/sdk'
import 'dotenv/config'

// Model IDs exactly as specified in the build brief
export const MODELS = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6',
}

let _client = null
function client() {
  if (_client) return _client
  _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  return _client
}

/**
 * Low-level call. Prefer the higher-level helpers below.
 *
 * @param {object} opts
 * @param {string} opts.model                 - MODELS.haiku | MODELS.sonnet
 * @param {string|Array} opts.system          - string or content-block array
 * @param {Array}  opts.messages              - standard Messages API messages
 * @param {number} [opts.maxTokens=1024]
 * @param {number} [opts.temperature=0.0]     - deterministic by default
 * @param {boolean}[opts.cacheSystem=true]    - wrap system as ephemeral cache
 */
export async function call({
  model,
  system,
  messages,
  maxTokens = 1024,
  temperature = 0.0,
  cacheSystem = true,
}) {
  const c = client()
  let systemParam
  if (typeof system === 'string') {
    systemParam = cacheSystem
      ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
      : system
  } else if (Array.isArray(system)) {
    systemParam = system
  } else {
    systemParam = undefined
  }

  const response = await c.messages.create({
    model,
    max_tokens: maxTokens,
    temperature,
    ...(systemParam ? { system: systemParam } : {}),
    messages,
  })

  const text = response.content
    ?.filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n')
    ?.trim() ?? ''

  return { text, raw: response, usage: response.usage }
}

/**
 * Robust JSON extraction — Claude occasionally wraps JSON in a code fence or
 * preamble. This strips the fence and returns the parsed object. Throws on
 * unparseable output.
 */
export function extractJson(text) {
  if (!text) throw new Error('empty LLM response')
  // Direct parse first
  try {
    return JSON.parse(text)
  } catch {}
  // Strip ```json fences
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1])
    } catch {}
  }
  // First {...} or [...] block
  const braceMatch = text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/)
  if (braceMatch) {
    try {
      return JSON.parse(braceMatch[0])
    } catch (err) {
      throw new Error(`failed to parse JSON from LLM output: ${err.message}\n--- raw ---\n${text}`)
    }
  }
  throw new Error(`no JSON object found in LLM output:\n${text}`)
}

// ------------------------------------------------------------------
// Haiku: Scout news layer
// ------------------------------------------------------------------
const SCOUT_NEWS_SYSTEM = `You are the Scout news analyst for MLBIE, an MLB betting intelligence engine.
You read MLB injury reports and recent beat writer news about starting pitchers and classify them into one of three buckets that gate full-game run total trades.

Rules:
- "none"       -> no concerns; proceed normally
- "caution"    -> minor concern (velocity down, flat stuff, bullpen day prior, dealing with illness); reduce confidence
- "disqualify" -> scratched / limited warmups / serious body-part issue / placed on IL

Key patterns to detect:
- "left [body part]" / "right [body part]" in injury context -> caution or disqualify depending on severity
- "velocity down" / "stuff was flat" / "command issues" -> caution (~ -0.2 adjustment)
- "scratched" / "won't start" / "late scratch" -> disqualify immediately
- "threw a bullpen session (day before)" -> caution (may affect stamina)
- "limited in warmups" -> disqualify
- Routine roster news / contract talk / generic profile fluff -> none

Adjustment values (on a "runs" scale applied to pitcher quality):
- none:       0.0
- caution:    -0.1 to -0.3  (pick magnitude from severity; negative means worse pitcher)
- disqualify: irrelevant (hard stop) — return 0.0

Output VALID JSON only — no prose, no markdown, no code fences. Schema:
{"flag":"none|caution|disqualify","adjustment":number,"reasoning":"one sentence","confidence":number_0_to_1}`

/**
 * @param {object} args
 * @param {string} args.pitcherName
 * @param {string} args.injuryReport
 * @param {string[]} args.newsSnippets
 */
export async function scoutNewsClassify({ pitcherName, injuryReport, newsSnippets }) {
  const user = `Pitcher: ${pitcherName}

Injury report:
${injuryReport || '(no entries)'}

Recent news snippets:
${(newsSnippets || []).map((s, i) => `${i + 1}. ${s}`).join('\n') || '(no news)'}

Classify status and output JSON only.`
  const { text } = await call({
    model: MODELS.haiku,
    system: SCOUT_NEWS_SYSTEM,
    messages: [{ role: 'user', content: user }],
    maxTokens: 400,
  })
  return extractJson(text)
}

// ------------------------------------------------------------------
// Haiku: Lineup change handler
// ------------------------------------------------------------------
const LINEUP_CHANGE_SYSTEM = `You are the Lineup change analyst for MLBIE.
You compare an expected MLB batting order to the confirmed order (posted 2 hours before first pitch) and report whether meaningful changes occurred that would weaken (or strengthen) the offense for full-game run total scoring.

Definitions:
- "key hitters" = batters who would ordinarily bat 1-6 on a team's healthy lineup, or any batter with season wRC+ >= 120.
- "scratched" = not in the confirmed lineup at all.
- A reorder that moves a weak hitter out of the top 6 has a small positive effect (~0.05); moving a key hitter DOWN from the top 6 is negative.
- adjustment_factor is a fractional offensive rating multiplier delta, roughly:
    0.0  -> no meaningful change
   -0.10 -> one key hitter scratched OR multiple order changes
   -0.20 -> two key hitters scratched / star slugger out
    0.05 -> minor positive (rested regular returning)

Output VALID JSON only. Schema:
{"changes_detected":boolean,"key_players_scratched":[string],"adjustment_factor":number,"reasoning":"one sentence"}`

export async function lineupChangeClassify({ team, expectedLineup, actualLineup }) {
  const user = `Team: ${team}

Expected lineup (from season patterns):
${(expectedLineup || []).map((p, i) => `${i + 1}. ${p.name} (${p.pos || ''}, wRC+ ${p.wrc ?? '?'})`).join('\n') || '(unknown)'}

Confirmed lineup:
${(actualLineup || []).map((p, i) => `${i + 1}. ${p.name} (${p.pos || ''})`).join('\n') || '(not yet posted)'}

Identify any meaningful changes and output JSON only.`
  const { text } = await call({
    model: MODELS.haiku,
    system: LINEUP_CHANGE_SYSTEM,
    messages: [{ role: 'user', content: user }],
    maxTokens: 400,
  })
  return extractJson(text)
}

// ------------------------------------------------------------------
// Sonnet: Market synthesis
// ------------------------------------------------------------------
const MARKET_SYNTHESIS_SYSTEM = `You are the Market Synthesis agent for MLBIE.
You receive compact summaries from all upstream agents (Scout, Lineup, Park, Storm, raw Market) plus the XGBoost projection, and produce a coherence check + plain-English synthesis for the Judge agent.

Your job is NOT to second-guess the numerical model. It is to:
1. Surface anything unusual that the feature vector may not capture (rare schedule quirks, conflicting qualitative signals, data freshness concerns).
2. Report whether the signals are ALIGNED (all pointing the same way), MIXED (some for/some against), or CONTRADICTORY (strong signals pointing opposite ways).
3. Recommend proceed / caution / reject.

Reject is reserved for situations like:
- Multiple agents failed (low data confidence on both pitchers, stale line, weather flagged).
- Qualitative signal strongly contradicts the projection AND the edge is marginal.

Output VALID JSON only. Schema:
{"unusual_flags":[string],"signal_coherence":"aligned|mixed|contradictory","confidence_check":"pass|warn|fail","synthesis":"2-3 sentences plain English","recommendation":"proceed|caution|reject"}`

export async function marketSynthesize({ scout, lineup, park, storm, market, projection }) {
  const user = `Scout summary:
Home SP: ${scout?.pitcher_home?.name} — quality ${scout?.pitcher_home?.quality_score?.toFixed?.(2)}, news ${scout?.pitcher_home?.news_flag}, conf ${scout?.pitcher_home?.confidence}, signals [${(scout?.pitcher_home?.key_signals || []).join('; ')}]
Away SP: ${scout?.pitcher_away?.name} — quality ${scout?.pitcher_away?.quality_score?.toFixed?.(2)}, news ${scout?.pitcher_away?.news_flag}, conf ${scout?.pitcher_away?.confidence}, signals [${(scout?.pitcher_away?.key_signals || []).join('; ')}]

Lineup summary:
Home: off ${lineup?.lineup_home?.offensive_rating}, K% ${lineup?.lineup_home?.k_pct}, changes ${lineup?.lineup_home?.changes_detected}
Away: off ${lineup?.lineup_away?.offensive_rating}, K% ${lineup?.lineup_away?.k_pct}, changes ${lineup?.lineup_away?.changes_detected}

Park: ${park?.venue_name} run_factor ${park?.run_factor}, roof ${park?.roof}, alt ${park?.altitude_feet}ft

Storm: ${storm?.dome ? 'dome' : `temp ${storm?.temp_f}F (${storm?.temp_category}), wind ${storm?.wind_mph}mph ${storm?.wind_direction_relative}, precip ${storm?.precip_probability}`}, weather_score ${storm?.weather_score}, disqualify ${storm?.disqualify}

Market: open ${market?.opening_line}, current ${market?.current_line}, movement ${market?.movement?.toFixed?.(2)}, efficiency ${market?.efficiency_score}, platform_gap ${market?.platform_gap?.toFixed?.(2)}

Model projection: full-game total ${projection?.projected_total?.toFixed?.(2)}, P(over) ${projection?.over_probability?.toFixed?.(3)}, edge vs market ${projection?.edge?.toFixed?.(3)}

Analyse coherence and output JSON only.`
  const { text } = await call({
    model: MODELS.sonnet,
    system: MARKET_SYNTHESIS_SYSTEM,
    messages: [{ role: 'user', content: user }],
    maxTokens: 700,
  })
  return extractJson(text)
}

// ------------------------------------------------------------------
// Sonnet: Judge edge case handler
// ------------------------------------------------------------------
const JUDGE_EDGECASE_SYSTEM = `You are the Judge edge-case handler for MLBIE.
You are invoked ONLY when the rules-based Judge encounters a situation it cannot fully quantify — doubleheader game 2, makeup game, postseason, rain delay impact on full-game total, weather outside the training distribution, etc.

Respond conservatively. When in doubt, reduce position size rather than force a reject, but REJECT when the situation clearly falls outside the model's training distribution.

Output VALID JSON only. Schema:
{"action":"proceed|reduce|reject","size_reduction_pct":number_0_to_100,"reasoning":"string"}`

export async function judgeEdgeCase({ situation, context }) {
  const user = `Situation: ${situation}

Full agent/context dump:
${JSON.stringify(context, null, 2)}

Recommend proceed / reduce / reject, JSON only.`
  const { text } = await call({
    model: MODELS.sonnet,
    system: JUDGE_EDGECASE_SYSTEM,
    messages: [{ role: 'user', content: user }],
    maxTokens: 500,
  })
  return extractJson(text)
}

// ------------------------------------------------------------------
// Haiku: Pre-bet K-market preflight — runs ~2.5h before first pitch
// ------------------------------------------------------------------
const SCOUT_K_MARKET_SYSTEM = `You are a pre-bet intelligence filter for a Kalshi MLB strikeout market betting system.
You run 2.5 hours before first pitch and review the latest available data on a starting pitcher.

Return one of three actions:

"skip" — Do NOT place the bet. Evidence required:
  - Pitcher scratched or no longer the probable starter
  - Pitch count limit announced (e.g. "will be limited", "on a pitch count", "won't go past X pitches")
  - Active arm, shoulder, or elbow concern (not just general soreness)
  - Bullpen day / opener announced for this game
  - Pitcher recently placed on IL or listed as questionable to start

"boost" — Place the bet. Confirmed edge beyond what the model priced. Evidence required:
  - 2 or more expected top-6 opposing batters confirmed scratched from the lineup
  - Pitcher's last 3+ starts show significantly more Ks than season average (hot streak)
  - Opposing lineup severely depleted with AAA call-ups or platoon guys
  - Any concrete signal the market likely has not repriced yet

"proceed" — Place the bet as planned. Use when:
  - No news, or only routine/irrelevant news found
  - Minor context (travel day, general fatigue talk, nothing specific)

Rules:
  - Absence of news is NOT a reason to skip. Default to proceed.
  - "boost" requires specific, concrete evidence — not vague optimism.
  - Only "skip" on clear disqualifying evidence, not general doubt.

Output VALID JSON only — no prose, no code fences.
Schema: {"action":"proceed|skip|boost","reason":"one specific sentence — cite the actual evidence","confidence":0.0-1.0}`

export async function scoutKMarket({ pitcherName, gameLabel, newsSnippets, recentKContext, lineupContext }) {
  const user = `Pitcher: ${pitcherName}
Game: ${gameLabel}

Recent K trend (last starts): ${recentKContext}

Opposing lineup status: ${lineupContext}

News headlines (last 48h):
${(newsSnippets || []).map((s, i) => `${i + 1}. ${s}`).join('\n') || '(no news found)'}

Classify and return JSON only.`
  const { text } = await call({
    model: MODELS.haiku,
    system: SCOUT_K_MARKET_SYSTEM,
    messages: [{ role: 'user', content: user }],
    maxTokens: 150,
    cacheSystem: true,
  })
  return extractJson(text)
}
