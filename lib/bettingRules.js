// lib/bettingRules.js — Runtime betting rule constants with DB persistence.
// liveMonitor reads these every tick (10-min TTL cache). calibrationEngine
// writes updates; seedDefaults() ensures rows exist on first startup.

import * as db from './db.js'

const TTL_MS = 10 * 60 * 1000   // 10 minutes

// DEFAULTS: every rule that liveMonitor or calibrationEngine can read.
// key → { value, label, description }
export const DEFAULTS = {
  // Strike bounds — YES and NO banned above these thresholds
  yes_max_strike:        { value: 6,    label: 'YES max strike',        description: 'Ban YES bets above this K threshold (0 = no ban)' },
  no_max_strike:         { value: 6,    label: 'NO max strike',         description: 'Ban NO bets above this K threshold (0 = no ban)' },
  // NO market-mid cap — reject NO when market mid > this value (¢)
  no_max_market_mid:     { value: 45,   label: 'NO max market mid (¢)', description: 'Skip NO bets when the YES mid exceeds this price (i.e. NO costs less than 100-this)' },
  // Minimum model probability for YES entries
  yes_min_prob:          { value: 0.60, label: 'YES min prob',          description: 'Minimum model probability to consider a YES entry' },
  yes_min_prob_momentum: { value: 0.55, label: 'YES min prob (momentum)', description: 'Minimum model probability for YES on K-momentum tick' },
  // Minimum edge for YES entries
  yes_min_edge_base:     { value: 0.12, label: 'YES min edge (base)',   description: 'Minimum YES edge for normal (non-momentum) entries' },
  yes_min_edge_momentum: { value: 0.10, label: 'YES min edge (momentum)', description: 'Minimum YES edge on K-momentum tick' },
  yes_min_edge_full_conv:{ value: 0.20, label: 'YES min edge (full-conv)', description: 'Minimum edge when model prob ≥ yes_full_conv_prob' },
  yes_full_conv_prob:    { value: 0.75, label: 'YES full-conv prob',    description: 'Model probability threshold for "full conviction" sizing' },
  // NO filters
  no_max_model_prob:     { value: 0.15, label: 'NO max model prob',     description: 'Skip NO when model prob ≥ this (pitcher too likely to hit)' },
  no_max_ask_cents:      { value: 55,   label: 'NO max ask (¢)',        description: 'Max acceptable ask cents for a NO buy (100 − yes_bid)' },
  no_min_edge:           { value: 0.15, label: 'NO min edge',           description: 'Minimum edge for a NO entry' },
  // Live-edge gate
  live_edge_min:         { value: 0.08, label: 'Live edge min',         description: 'Absolute minimum edge for any live bet' },
  // Pre-game Rule K — YES probability gates (replaces Rule J strike-only ban)
  yes_pregame_min_prob:    { value: 0.35, label: 'YES pre-game min prob (Rule K)',                 description: 'Ban YES pre-game bets below this model probability' },
  yes_pregame_min_prob_hi: { value: 0.65, label: 'YES pre-game min prob, expensive fill (Rule K)', description: 'Ban YES pre-game below this prob when market mid exceeds yes_pregame_max_mid' },
  yes_pregame_max_mid:     { value: 35,   label: 'YES pre-game max mid (¢) (Rule K)',              description: 'Market mid threshold above which the hi-prob gate applies (¢)' },
  // Structural-edge taker caps (free money, dead-path, pulled)
  pulled_cap_usd:          { value: 10,   label: 'Pulled cap USD',              description: 'Max USD risk per taker order on a pulled pitcher (per strike threshold)' },
  pulled_cap_confirmed_usd:{ value: 60,   label: 'Pulled cap USD (confirmed)',  description: 'Per-threshold cap when pull is two-tier confirmed (reliever on mound or substitution event). Higher than pulled_cap_usd because structural certainty is higher.' },
  free_money_pitcher_cap:  { value: 60,   label: 'Free money pitcher cap USD',  description: 'Total free-money budget per pitcher across all thresholds (game_reserves ceiling). Raised from 30→60 to allow meaningful sizing on confirmed structural outcomes.' },
  dead_path_cap_usd:       { value: 10,   label: 'Dead-path cap USD',           description: 'Max USD risk per dead-path NO taker order' },
  crossed_yes_max_ask:     { value: 35,   label: 'Crossed-YES max ask (¢)',     description: 'Max ¢ to pay for YES when threshold already crossed (Kalshi lag play). At 35¢ you net ~57¢/contract after fees — catches more of Kalshi\'s repricing lag.' },
  // Blowout NO signal thresholds
  blowout_deficit:         { value: 5,    label: 'Blowout deficit (runs)',      description: 'Min run deficit for blowout NO signal (team losing by this many)' },
  blowout_inning:          { value: 6,    label: 'Blowout inning gate',         description: 'Min inning for blowout NO signal to trigger' },
  blowout_k_gap:           { value: 3,    label: 'Blowout K gap',               description: 'Min remaining K gap required for blowout NO to be structurally meaningful' },
  // Pull risk thresholds
  pull_pitch_count:        { value: 80,   label: 'Pull pitch count',            description: 'Pitch count at which pull risk becomes real (queue management active above this). Lowered 85→80 to widen hedge detection window.' },
  pull_min_ip:             { value: 4,    label: 'Pull min IP',                 description: 'Minimum IP pitched before pull-risk tracking and queue management activates' },
  // Order queue management
  queue_amend_cents:       { value: 1,    label: 'Queue amend cents',           description: '¢ improvement applied when amending a resting maker order up the queue' },
  // Bet sizing floor and pregame YES cap
  min_bet_floor:           { value: 8,    label: 'Min bet floor (USD)',         description: 'Minimum bet size in USD after Kelly sizing — bets below this are dropped to avoid noise trades with high fee-to-profit ratio' },
  max_yes_per_pitcher:     { value: 5,    label: 'Max YES bets per pitcher',    description: 'Maximum YES threshold bets per pitcher in a single pregame run (correlated Kelly already handles correlation — this is a hard ceiling)' },
  // Live Bayesian model
  live_bayesian_weight_cap:{ value: 0.75, label: 'Live Bayesian weight cap',   description: 'Maximum weight given to live observed K% in the Bayesian blend. Raised from 0.50→0.75 so deep-in-game evidence has more influence.' },
}

// Global rules cache (keyed 'global')
// Per-user rules cache (keyed by user_id number)
const _cache    = new Map()   // userId | 'global' → { map, ts }

export async function seedDefaults() {
  const existing = await db.all(`SELECT key FROM betting_rules`).catch(() => [])
  const existingKeys = new Set(existing.map(r => r.key))
  const toInsert = Object.entries(DEFAULTS).filter(([k]) => !existingKeys.has(k))
  for (const [key, def] of toInsert) {
    await db.run(
      `INSERT OR IGNORE INTO betting_rules (key, value, default_val, label, description)
       VALUES (?, ?, ?, ?, ?)`,
      [key, def.value, def.value, def.label, def.description],
    ).catch(() => {})
  }
  // Migrate stale default values — only touches rows that still have the old default
  // so any manual tuning (user changed the value away from the old default) is preserved.
  await db.run(`UPDATE betting_rules SET value=35, default_val=35 WHERE key='crossed_yes_max_ask' AND value=20`).catch(() => {})
  await db.run(`UPDATE betting_rules SET value=80, default_val=80 WHERE key='pull_pitch_count'    AND value=85`).catch(() => {})
}

// getRules(userId?) — returns merged rules map.
// When userId is provided, user-specific rows from user_betting_rules shadow global defaults.
// userId=null/undefined → global rules only.
export async function getRules(userId) {
  const cacheKey = userId != null ? Number(userId) : 'global'
  const cached   = _cache.get(cacheKey)
  if (cached && (Date.now() - cached.ts) < TTL_MS) return cached.map

  // Global rules
  const globalRows = await db.all(`SELECT key, value FROM betting_rules`).catch(() => [])
  const map = { ...Object.fromEntries(Object.entries(DEFAULTS).map(([k, d]) => [k, d.value])) }
  for (const r of globalRows) map[r.key] = r.value

  // Per-user overrides (if userId supplied and user_betting_rules table exists)
  if (userId != null) {
    const userRows = await db.all(
      `SELECT key, value FROM user_betting_rules WHERE user_id = ?`, [Number(userId)],
    ).catch(() => [])
    for (const r of userRows) map[r.key] = r.value
  }

  _cache.set(cacheKey, { map, ts: Date.now() })
  return map
}

export async function getRule(key, userId) {
  const rules = await getRules(userId)
  return rules[key] ?? DEFAULTS[key]?.value ?? null
}

// setRule — if userId provided, writes to user_betting_rules; otherwise global betting_rules.
export async function setRule(key, value, updatedBy = 'system', userId = null) {
  if (!(key in DEFAULTS)) throw new Error(`Unknown rule: ${key}`)
  if (userId != null) {
    await db.run(
      `INSERT INTO user_betting_rules (user_id, key, value, updated_at, updated_by)
       VALUES (?, ?, ?, datetime('now'), ?)
       ON CONFLICT(user_id, key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
      [Number(userId), key, value, updatedBy],
    )
  } else {
    await db.run(
      `INSERT INTO betting_rules (key, value, default_val, label, description, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, datetime('now'), ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
      [key, value, DEFAULTS[key].value, DEFAULTS[key].label, DEFAULTS[key].description, updatedBy],
    )
  }
  invalidateCache(userId)
}

export async function resetRule(key, userId = null) {
  const def = DEFAULTS[key]
  if (!def) throw new Error(`Unknown rule: ${key}`)
  if (userId != null) {
    await db.run(
      `DELETE FROM user_betting_rules WHERE user_id = ? AND key = ?`, [Number(userId), key],
    )
  } else {
    await db.run(
      `UPDATE betting_rules SET value = default_val, updated_at = datetime('now'), updated_by = 'reset' WHERE key = ?`,
      [key],
    )
  }
  invalidateCache(userId)
}

export function invalidateCache(userId) {
  if (userId != null) {
    _cache.delete(Number(userId))
  } else {
    _cache.clear()
  }
}

// getAllRules(userId?) — returns full rule list with metadata.
// When userId is provided, user-specific overrides shadow global rows.
export async function getAllRules(userId) {
  const globalRows = await db.all(
    `SELECT key, value, default_val, label, description, updated_at, updated_by FROM betting_rules`,
  ).catch(() => [])
  const map = {}
  for (const [key, def] of Object.entries(DEFAULTS)) {
    map[key] = { key, value: def.value, default_val: def.value, label: def.label, description: def.description, updated_at: null, updated_by: 'default', user_override: false }
  }
  for (const r of globalRows) map[r.key] = { ...r, user_override: false }

  if (userId != null) {
    const userRows = await db.all(
      `SELECT key, value, updated_at, updated_by FROM user_betting_rules WHERE user_id = ?`, [Number(userId)],
    ).catch(() => [])
    for (const r of userRows) {
      if (map[r.key]) {
        map[r.key] = { ...map[r.key], value: r.value, updated_at: r.updated_at, updated_by: r.updated_by, user_override: true }
      }
    }
  }
  return Object.values(map)
}
