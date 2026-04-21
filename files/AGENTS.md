# MLBIE — Agent Specifications

**Last updated**: April 15, 2026 (design session)
**Status**: Architecture updated — MEM added, bullpen sub-model upgraded, distribution model framing applied

---

## Overview

Seven agents, one orchestrator. Each agent owns a specific domain, runs independently, and outputs a structured JSON object consumed by the orchestrator and ultimately Judge.

Agents run in this sequence per game:
```
Park → Scout + Lineup + Bullpen (parallel) → Storm → Market → MEM → Judge
```

MEM is the execution gatekeeper. Judge only fires if MEM returns GREEN.

---

## Agent 1: Scout

**Domain**: Starting pitcher intelligence
**The most important agent. ~70% of predictive value lives here.**

### Inputs
- Pitcher ID (from game schedule)
- Baseball Savant Statcast data
- Fangraphs pitcher metrics
- Baseball-Reference game logs
- MLB injury report
- Beat writer RSS feeds (optional v2)

### XGBoost Features Computed

**Recency-weighted season metrics** (exponential decay, half-life 4 starts):
- FIP (Fielding Independent Pitching)
- xFIP (HR-normalized FIP)
- SwStr% (swinging strike rate) ← most important signal
- GB% (ground ball rate)
- Hard contact rate (exit velocity >95mph)
- K/9 (strikeouts per 9)
- BB/9 (walks per 9)
- F-Strike% (first pitch strike percentage)

**Last 5 starts specific**:
- Full-game ERA last 5 starts (era_l5)
- Average innings pitched (early exit indicator)
- Pitch count efficiency (pitches per out)
- Trend direction (improving / declining / stable)

**Times Through Order (TTO) penalty**:
- Career runs allowed per inning: 1st time through, 2nd time through, 3rd time through
- TTO penalty (2nd vs 1st) — traditional fatigue signal
- TTO3 penalty (3rd time through) — **key full-game metric**, heavily weighted
  High TTO3 → starter gets shelled in innings 6-7 before being pulled

**Venue history**:
- Career ERA at today's park
- Career SwStr% at today's park (some parks affect pitch movement)

**Rest and workload**:
- Days since last start
- Pitch count last start
- Season start number
- Rolling 21-day pitch count (cumulative fatigue)

**Platoon splits**:
- ERA / FIP vs LHB
- ERA / FIP vs RHB
- SwStr% vs LHB vs RHB

### Claude Haiku Layer — News Interpretation

**Trigger**: Run on every starter, every day.

**Prompt structure**:
```
Given the following MLB injury report and recent news for pitcher [NAME]:
[injury_report_text]
[recent_news_snippets]

Classify this pitcher's status for today's start:
- "none": No concerns, proceed normally
- "caution": Minor concern, reduce confidence by 20%, adjustment: [number]
- "disqualify": Do not trade this game

Output JSON only:
{"flag": "none|caution|disqualify", "adjustment": float, "reasoning": "one sentence", "confidence": float}
```

**Key patterns to detect**:
- "left [body part]" in injury context → caution/disqualify depending on severity
- "velocity down" / "stuff was flat" → caution, -0.2 adjustment
- "scratched" / "won't start" → disqualify immediately
- "threw a bullpen session" (day before) → caution, may affect stamina
- "limited in warmups" → disqualify

### Bullpen Sub-Model (feeds Bullpen Agent — see Agent 1b)

Scout signals when the starter is likely to exit early (high TTO3 penalty, low avg innings), which feeds directly into how Bullpen's availability engine weights the expected innings covered by relief. Scout and Bullpen are co-dependent — Scout drives expected starter duration; Bullpen covers the rest.

### Output Schema
```json
{
  "agent": "scout",
  "game_id": "string",
  "generated_at": "ISO timestamp",
  "pitcher_home": {
    "id": "string",
    "name": "string",
    "hand": "R|L",
    "quality_score": 4.2,
    "confidence": 0.78,
    "sample_size_starts": 8,
    "key_signals": ["SwStr% 12.1% (low)", "TTO3 penalty 1.8 (high)", "GB% 38% (low)"],
    "news_flag": "none|caution|disqualify",
    "news_adjustment": 0.0,
    "news_reasoning": "string",
    "features": { ... }
  },
  "pitcher_away": { ... }
}
```

### Validation Target
Scout quality scores should predict full-game runs allowed with r² > 0.20.
Baseline (raw ERA alone) expected r² ~0.12.
If Scout doesn't beat ERA, rebuild before proceeding.

---

## Agent 1b: Bullpen

**Domain**: Relief pitcher availability and quality
**Required for full-game totals. Innings 6-9 are bullpen innings.**

### Why This Exists

Static bullpen ERA is nearly useless for a single game. Full-game totals are heavily influenced by which specific relievers are available, who is fatigued, and how the manager uses the pen. A team's top two relievers being unavailable changes the expected run total significantly. This agent quantifies that.

### Per-Reliever Daily Tracking

```
skill_estimate:
  k_bb_pct (K% minus BB% — best single reliever metric)
  xfip or siera
  gb_pct
  hr_suppression_rate

recent_usage:
  pitches_yesterday
  pitches_2_days_ago
  pitches_3_days_ago
  back_to_back_flag
  back_to_back_to_back_flag
  high_leverage_yesterday (leverage index > 1.5)

availability_score:
  probability reliever is available today
  probability reliever is used given game state
  expected quality if used
```

### Game-Level Aggregation

```
expected_bullpen_runs_prevented
bullpen_collapse_risk (tail factor — what if top 2 guys unavailable)
available_innings_quality_weighted
```

### Manager Behavior Model (V2)

```
manager_id → historical patterns:
  usage_rate_in_close_games
  back_to_back_tolerance
  rest_day_patterns
  high_leverage_threshold (when does closer enter)
```

V1 uses rolling team-level 14-day aggregate stats. V2 adds per-reliever availability.

### Data Source
MLB Stats API game logs (pitcher appearances, pitch counts) — free.
Per-pitcher data: Baseball Savant + FanGraphs reliever leaderboard.

### XGBoost Features (Group I — `bp_` prefix)
```
bp_h_era_14d              # Home bullpen ERA, rolling 14 days
bp_h_whip_14d             # Home bullpen WHIP, rolling 14 days
bp_h_k_pct_14d            # Home bullpen K%, rolling 14 days
bp_h_hr_per_9_14d         # Home bullpen HR/9, rolling 14 days
bp_h_inherited_score_pct  # % of inherited runners that scored (leverage management)
bp_a_era_14d              # Away equivalents
bp_a_whip_14d
bp_a_k_pct_14d
bp_a_hr_per_9_14d
bp_a_inherited_score_pct
```

### Judge Integration
Hard disqualifier: Both bullpens ERA > 6.0 over rolling 14 days → elevated variance flag → REJECT.

---

## Agent 2: Lineup

**Domain**: Offensive intelligence — both batting orders

### Inputs
- Team ID (home and away)
- Fangraphs team offensive metrics
- Daily confirmed lineup (Rotowire / MLB.com)
- Scout output (pitcher handedness — needed for splits)

### XGBoost Features Computed

**Team offensive metrics** (split by opposing pitcher handedness):
- wRC+ vs LHP / vs RHP: 14-day and 30-day windows
- K% vs LHP / vs RHP: 14-day
- Hard contact rate vs LHP / vs RHP: 14-day
- ISO (isolated power) vs LHP / vs RHP: 14-day
- BABIP vs LHP / vs RHP (contact quality)

**Full-game specific metrics**:
- Runs scored per game: last 14 days (full-game, not F5)
- LOB% (left on base percentage) — high LOB% teams underperform their offensive stats in scoring
- Scoring rate innings 1-5 vs innings 6-9 (identifies teams that score early vs rely on late-game offense)

**Batting order quality**:
- Weighted OPS of batters 1-6
- Weighted wRC+ of batters 1-6
- Best hitter position (1-3 vs 4-6)

**Schedule context**:
- Games in last 7 days (schedule fatigue)
- Day game after night game flag
- Travel days (cross-timezone)
- Home vs away split

### Claude Haiku Layer — Lineup Change Handler

**Trigger**: Run 2 hours before each game after confirmed lineup posted.

**Prompt structure**:
```
The expected lineup for [TEAM] today was:
[expected_lineup]

The confirmed lineup is:
[actual_lineup]

Identify any meaningful changes (scratched regulars, order changes for key hitters).
Output JSON:
{
  "changes_detected": boolean,
  "key_players_scratched": ["string"],
  "adjustment_factor": float,  // 0.0 = no change, -0.2 = key hitter out
  "reasoning": "string"
}
```

### Output Schema
```json
{
  "agent": "lineup",
  "game_id": "string",
  "generated_at": "ISO timestamp",
  "lineup_home": {
    "team": "string",
    "vs_handedness": "R|L",
    "offensive_rating": 108,
    "k_pct": 0.22,
    "runs_pg_14d": 4.8,
    "lob_pct": 0.71,
    "changes_detected": false,
    "key_players_scratched": [],
    "adjustment_factor": 0.0,
    "key_signals": ["strong vs RHP wRC+ 112", "low K% 21%"],
    "features": { ... }
  },
  "lineup_away": { ... }
}
```

---

## Agent 3: Park

**Domain**: Venue factors — static and semi-static

**Simplest agent. No AI layer. Update weekly.**

### Inputs
- Venue ID (from game schedule)
- Park factor database (pre-built, all 30 stadiums)

### Data Per Venue
- Run park factor (3-year rolling average)
- HR park factor
- Stadium GPS coordinates (lat/long for weather API)
- Stadium orientation in degrees from north (for wind direction encoding)
- Dimensions: LF line, RF line, CF, wall heights
- Roof type: open, retractable, dome
- Surface: grass, turf
- Altitude (feet above sea level — Coors effect)

### Output Schema
```json
{
  "agent": "park",
  "venue_id": "string",
  "venue_name": "string",
  "run_factor": 1.08,
  "hr_factor": 1.12,
  "altitude_feet": 5200,
  "roof": "open|retractable|dome",
  "orientation_degrees": 42,
  "coordinates": { "lat": 41.948, "lng": -87.655 }
}
```

---

## Agent 4: Storm

**Domain**: Weather intelligence

**No AI layer. Rules-based interpretation of OpenWeather data.**

### Inputs
- Venue coordinates (from Park agent)
- Game time (for forecast window)
- OpenWeather API forecast

### Features Computed

**Temperature encoding**:
```
hot:  80°F+     → adjustment: 0.0 (neutral baseline)
warm: 65-79°F   → adjustment: 0.0
cool: 50-64°F   → adjustment: -0.2
cold: <50°F     → adjustment: -0.4
```

**Wind encoding**:
- Get wind bearing in degrees from OpenWeather
- Get park orientation from Park agent
- Compute wind direction relative to outfield:
  ```
  out_bearing = (park_orientation + 180) % 360
  relative_angle = (wind_bearing - out_bearing + 360) % 360
  if 0-45 or 315-360: direction = "out"
  if 135-225: direction = "in"
  else: direction = "crosswind"
  ```
- Wind adjustment:
  ```
  out + >10mph: +0.4 to +0.8 (scales with speed)
  in + >10mph: -0.3 to -0.6
  crosswind: ±0.1 (minor effect)
  <10mph: ~0.0
  ```

**Precipitation logic**:
```
precip_prob < 20%: clear
precip_prob 20-40%: flag = "monitor"
precip_prob > 40% AND timing overlaps game window: DISQUALIFY
dome venues: ignore all weather signals
```

### Output Schema
```json
{
  "agent": "storm",
  "game_id": "string",
  "venue_id": "string",
  "first_pitch_time": "ISO timestamp",
  "temp_f": 62,
  "temp_category": "cool",
  "temp_adjustment": -0.2,
  "wind_mph": 12,
  "wind_bearing_degrees": 225,
  "wind_direction_relative": "out",
  "wind_adjustment": 0.4,
  "humidity_pct": 0.58,
  "precip_probability": 0.15,
  "precip_timing": "after_game",
  "dome": false,
  "disqualify": false,
  "disqualify_reason": null,
  "weather_score": 0.2,
  "last_updated": "ISO timestamp"
}
```

---

## Agent 5: Market

**Domain**: Baseball probability context — line movement and sportsbook consensus

**Note**: Market tells you what the probability looks like from a betting market perspective. It does NOT decide whether to execute. That is MEM's job (Agent 6).

### Inputs
- Game ID
- The Odds API: opening line, current line, movement history, sharp sportsbook prices
- Kalshi current contract price

### Rules-Based Analysis

**Line movement signals**:
```
movement = current_line - opening_line

if abs(movement) > 0.5:  DISQUALIFY (sharp money found it first)
if abs(movement) 0.3-0.5: efficiency penalty 0.7x
if abs(movement) 0.1-0.3: efficiency penalty 0.9x
if abs(movement) < 0.1:  efficiency 1.0x (stale/confirmed line)
```

**Consensus Gap (Kalshi vs sharp sportsbook)**:
```
gap_consensus = kalshi_implied_prob - sportsbook_implied_prob

Positive: Kalshi is overpricing the over → over is less attractive
Negative: Kalshi is underpricing the over → potential over edge
If model disagrees with BOTH Kalshi AND sportsbooks → model is likely wrong
```

**Reverse line movement** (sharp signal):
```
if public_pct_on_over > 65% AND line moves toward under:
  sharp_signal = "under" (sharps taking the other side of public)
```

**Market efficiency score**:
```
efficiency_score = 1.0
if movement > threshold: efficiency_score *= 0.7
if time_since_movement < 2hr: efficiency_score *= 0.85
if sharp_signal detected: efficiency_score *= 0.6
```

### Claude Sonnet Layer — Cross-Signal Synthesis

**Trigger**: After model projection complete, before MEM.

**Input**: All agent outputs + model projection

**Prompt**:
```
You are reviewing a baseball full-game total prediction. Given these agent outputs:

Scout: [scout_output_summary]
Lineup: [lineup_output_summary]
Park: [park_output_summary]
Storm: [storm_output_summary]
Market: [market_output_summary]
Model projection: [projection] (edge: [edge])

1. Does anything unusual stand out that the numerical model might miss?
2. Are the signals coherent or contradictory?
3. Confidence assessment: HIGH / MEDIUM / LOW

Output JSON only:
{
  "unusual_flags": ["string"],
  "signal_coherence": "aligned|mixed|contradictory",
  "confidence_check": "pass|warn|fail",
  "synthesis": "2-3 sentence plain English explanation",
  "recommendation": "proceed|caution|reject"
}
```

### Output Schema
```json
{
  "agent": "market",
  "game_id": "string",
  "opening_line": 8.5,
  "current_line": 8.5,
  "movement": 0.0,
  "movement_direction": "none",
  "sharp_signal": null,
  "efficiency_score": 1.0,
  "kalshi_implied_prob": 0.52,
  "sportsbook_implied_prob": 0.50,
  "gap_consensus": 0.02,
  "platform_gap": 0.0,
  "disqualify": false,
  "synthesis": {
    "unusual_flags": [],
    "signal_coherence": "aligned",
    "confidence_check": "pass",
    "synthesis": "string",
    "recommendation": "proceed"
  }
}
```

---

## Agent 6: MEM — Market Efficiency Monitor

**Domain**: Execution timing — is the edge actionable RIGHT NOW?
**The gatekeeper between probability estimation and trade execution.**

### Why This Exists

A valid edge in the model does not automatically mean a valid trade. Kalshi full-game total contracts converge toward sharp sportsbook consensus prices. The window for exploitable mispricing is minutes to a couple of hours. Without MEM, the system fires trades into already-corrected prices. MEM detects the window and its decay speed and either green-lights or blocks execution.

### The Five Metrics

**1. Price Gap (raw edge)**
```
edge_raw = model_probability - kalshi_implied_probability
```

**2. Consensus Gap (Kalshi vs sharp sportsbook)**
```
gap_consensus = kalshi_implied_prob - sportsbook_implied_prob
```
Tells you: is Kalshi lagging the sharp market, or is your model the outlier?
If your model disagrees with both Kalshi AND sportsbooks — your model is probably wrong.

**3. Convergence Velocity (THE most important metric)**
```
velocity = (current_price - price_15min_ago) / minutes_elapsed
```
Fast movement = edge is dying, do not enter.
Flat or slow = inefficiency may persist, potential entry.

**4. Liquidity Score**
```
liquidity_score = orderbook_depth / bid_ask_spread
```
Low liquidity = fills won't happen at your price = fake edge.

**5. Time-to-First-Pitch Decay**
Edge survival probability drops as game approaches. Lineups lock, weather stabilizes, sharp money finishes entering.

### Trade Quality Score (TQS)

```javascript
TQS =
  (edge_raw * W1) +
  (gap_consensus * W2) -
  (Math.abs(velocity) * W3) +
  (liquidity_score * W4) -
  (time_decay_penalty * W5)
```

Weights calibrated from convergence data once sufficient history accumulates (see DATA.md convergence tracking schema). Initial weights are:
```
W1 = 0.35  (model edge — important but not decisive alone)
W2 = 0.25  (Kalshi lagging sharp consensus — strong signal)
W3 = 0.20  (velocity penalty — fast convergence kills trade)
W4 = 0.10  (liquidity — gate condition more than continuous score)
W5 = 0.10  (time decay — late market discount)
```

### Traffic Light Decision

```
GREEN  — Trade immediately
  edge_raw > threshold AND
  gap_consensus > 0 (Kalshi lagging sharp market) AND
  velocity LOW (market not correcting fast) AND
  liquidity acceptable AND
  sufficient time before first pitch (>90 min unless news event)

YELLOW — Wait or pass
  edge exists BUT velocity is high (market correcting fast)
  → monitor, check again in 10 minutes, or skip

RED    — Do not trade
  liquidity too thin OR
  price already converged OR
  < 90 minutes to first pitch (unless sudden news event) OR
  model is only disagreement vs both Kalshi and sportsbooks
```

### Trading Window Rules

```
EARLY  (open → 6hr pre-game)
  Highest mispricing, lowest liquidity
  Small sizing only, early signals (weather, pitching mismatch)
  MEM: requires gap_consensus > 0 to GREEN (sportsbooks must also be lagging)

PRIMARY (6hr → 90min pre-game)  ← main trading window
  Best balance of inefficiency + liquidity
  Full sizing per Judge/Kelly

LATE   (< 90min)
  Only trade sudden news events (SP scratch, weather shift, lineup change)
  Velocity check relaxed: market may not have caught up yet
  Liquidity check tightened: must confirm fills are possible
```

### What to Log on Every Trade AND Non-Trade

```json
{
  "timestamp": "ISO",
  "kalshi_price": 0.52,
  "sportsbook_implied": 0.50,
  "model_probability": 0.58,
  "edge_raw": 0.06,
  "gap_consensus": 0.02,
  "velocity": 0.001,
  "liquidity_score": 4.2,
  "minutes_to_game": 187,
  "tqs": 0.71,
  "decision": "GREEN|YELLOW|RED",
  "decision_reason": "string",
  "traded": true,
  "trade_id": "integer or null"
}
```

**This log is the convergence dataset.** It becomes the most valuable data you accumulate.

### V2 Upgrade: Edge Half-Life Model

Once sufficient convergence data accumulates (target: 500 entries):
- "When I detect a 6% edge at 3 hours pre-game, how long does it last on average?"
- Output: expected minutes until convergence, probability edge still exists in 15/30/60 min
- Turns timing into a quantifiable, learnable signal

### Output Schema
```json
{
  "agent": "mem",
  "game_id": "string",
  "evaluated_at": "ISO timestamp",
  "edge_raw": 0.06,
  "gap_consensus": 0.02,
  "velocity": 0.0012,
  "liquidity_score": 4.2,
  "minutes_to_game": 187,
  "time_window": "PRIMARY",
  "tqs": 0.71,
  "decision": "GREEN|YELLOW|RED",
  "decision_reason": "string"
}
```

---

## Agent 7: Judge

**Domain**: Final decision — disqualification + edge calculation + position sizing

**This agent makes the go/no-go call. It does not predict. It decides.**
**It only runs if MEM returns GREEN.**

### Hard Disqualifiers (ANY triggers rejection — no exceptions)

```javascript
const disqualifiers = [
  storm.disqualify === true,
  scout.pitcher_home.news_flag === 'disqualify',
  scout.pitcher_away.news_flag === 'disqualify',
  market.disqualify === true,
  Math.abs(market.movement) > 0.5,
  starter_days_rest < 4,
  scout.pitcher_home.confidence < 0.4,
  scout.pitcher_away.confidence < 0.4,
  market.synthesis.recommendation === 'reject',
  mem.decision !== 'GREEN',
  // Model is only outlier: model disagrees with both Kalshi and sportsbooks
  (market.gap_consensus === 0 && edge_raw < 0.02)
]
```

### Confidence Modifiers (reduce position size, don't reject)

```javascript
let confidence_multiplier = 1.0

if (scout.pitcher_home.news_flag === 'caution') confidence_multiplier *= 0.8
if (scout.pitcher_away.news_flag === 'caution') confidence_multiplier *= 0.8
if (lineup.home.changes_detected) confidence_multiplier *= 0.85
if (lineup.away.changes_detected) confidence_multiplier *= 0.85
if (scout.pitcher_home.confidence < 0.65) confidence_multiplier *= 0.75
if (market.synthesis.recommendation === 'caution') confidence_multiplier *= 0.7
if (storm.precip_probability > 0.2) confidence_multiplier *= 0.9

// Floor: never let cascading penalties push multiplier below 0.5
confidence_multiplier = Math.max(0.5, confidence_multiplier)
```

### Edge Calculation

```javascript
function calculateEdge(model_probability, market_implied_prob, market_efficiency) {
  const raw_edge = model_probability - market_implied_prob
  const adjusted_edge = raw_edge * market_efficiency
  return adjusted_edge
}
```

### Position Sizing (Kelly with hard limits)

```javascript
function positionSize(edge, confidence, bankroll, MIN_BET=25, MAX_PCT=0.03) {
  if (edge <= 0) return 0

  // Phase 1: quarter-Kelly (first 200 live trades)
  // Phase 2: half-Kelly (after calibration confirmed)
  const KELLY_MULT = process.env.KELLY_MULTIPLIER
    ? Number(process.env.KELLY_MULTIPLIER)
    : 0.25

  const kelly_fraction = (edge / (1 - edge)) * KELLY_MULT
  const adjusted_fraction = kelly_fraction * confidence

  const raw_size = bankroll * adjusted_fraction
  const max_size = bankroll * MAX_PCT

  return Math.round(Math.min(max_size, Math.max(MIN_BET, raw_size)))
}
```

### Edge Threshold

Default: only trade when adjusted_edge > 0.06 (6% gross edge over market).

Net durable edge after fees + spread + slippage is expected to be 2-4%. Half-Kelly on 2-3% net edge produces much smaller position sizes than half-Kelly on 6% gross — this is correct and deliberate.

This threshold can be adjusted based on backtested results. Start conservative.

### Claude Sonnet Edge Case Handler

**Trigger**: Only when Judge encounters unusual situation not covered by rules.

**Examples**:
- Doubleheader game 2 (pitch count / fatigue different from normal)
- Makeup game (scheduling anomalies)
- Playoff game (different pitcher usage patterns)
- Rain delay impact on full-game total validity
- Weather pattern outside model's training distribution

### Output Schema
```json
{
  "agent": "judge",
  "game_id": "string",
  "decision": "TRADE|REJECT",
  "rejection_reason": null,
  "raw_edge": 0.09,
  "adjusted_edge": 0.077,
  "market_efficiency": 0.85,
  "confidence_multiplier": 0.92,
  "model_probability": 0.59,
  "market_implied_probability": 0.50,
  "recommended_side": "OVER",
  "position_size": 75,
  "bankroll": 5000,
  "tqs": 0.71,
  "agent_attribution": {
    "primary_driver": "scout",
    "supporting": ["lineup", "storm"],
    "neutral": ["park"],
    "opposing": []
  },
  "explanation": "string (plain English, 2-3 sentences)"
}
```

---

## Orchestrator

**Coordinates all agents. Has no opinion of its own.**

### Run Sequence

```javascript
async function runGame(game_id, options) {
  // 1. Park (static — fast)
  const park = await agents.park.run(game.venue_id)

  // 2. Scout + Lineup + Bullpen (parallel — all need time)
  const [scout, lineup, bullpen] = await Promise.all([
    agents.scout.run(game.pitcher_home, game.pitcher_away),
    agents.lineup.run(game.team_home, game.team_away, scout_hand_hint),
    agents.bullpen.run(game.team_home, game.team_away)
  ])

  // 3. Storm (needs park coordinates)
  const storm = await agents.storm.run(game.game_time, park.coordinates)

  // 4. Market (needs game context)
  const market_raw = await agents.market.fetchLines(game_id)

  // 5. Distribution model projection (needs all agent feature outputs)
  const projection = await model.predict(buildFeatureVector(scout, lineup, bullpen, park, storm))

  // 6. Market synthesis (needs projection + all agents)
  const market = await agents.market.synthesize(market_raw, projection, {scout, lineup, bullpen, park, storm})

  // 7. MEM — is it actionable right now?
  const mem = await agents.mem.evaluate({
    game_id,
    model_probability: projection.over_probability,
    market,
    minutes_to_game: minutesUntilGame(game.game_time)
  })

  // 8. Judge — only runs if MEM is GREEN
  if (mem.decision === 'RED') {
    await db.logDecision(game_id, { decision: 'REJECT', rejection_reason: 'MEM_RED', mem }, ...)
    return { decision: 'REJECT', reason: 'MEM_RED' }
  }

  const decision = await agents.judge.decide({
    game, scout, lineup, bullpen, park, storm, market, mem, projection
  })

  // 9. Log everything (including non-trades — critical for convergence dataset)
  await db.logDecision(game_id, decision, {scout, lineup, bullpen, park, storm, market, mem, projection})

  // 10. Execute if approved and --execute flag
  if (decision.decision === 'TRADE' && options.execute) {
    await execute.trade(decision)
  }

  return decision
}
```

### Logging Rule

Every run — trade OR no-trade — logs the full MEM output. This data becomes the convergence dataset that trains the edge half-life model in V2. Non-trades are as valuable as trades.
