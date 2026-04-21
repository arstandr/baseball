// pipeline/orchestrate.js — per-game agent coordination.
// Implements the agent sequence from AGENTS.md §Orchestrator, plus the
// new Bullpen agent (Group I) for full-game totals.

import * as park from '../agents/park/index.js'
import * as scout from '../agents/scout/index.js'
import * as lineup from '../agents/lineup/index.js'
import * as storm from '../agents/storm/index.js'
import * as market from '../agents/market/index.js'
import * as judge from '../agents/judge/index.js'
import * as bullpen from '../agents/bullpen/index.js'
import { buildFeatureVector } from '../lib/features.js'
import { predict, resolveActiveModelDir } from '../lib/model.js'
import { saveProjection } from '../lib/db.js'
import pLimit from 'p-limit'

/**
 * Run the full agent pipeline for one game. Returns the Judge decision with
 * full context attached.
 */
export async function runGame(game, options = {}) {
  // 1. Park (static)
  const parkOut = await park.run(game)

  // 2. Scout + Lineup + Bullpen (parallel where safe)
  //    Scout is sequential with Lineup because Lineup needs Scout.hand.
  //    Bullpen is fully independent so it runs in parallel with the rest.
  const scoutPromise = scout.run(game)
  const bullpenPromise = bullpen.run(game)

  const scoutOut = await scoutPromise
  const lineupOut = await lineup.run(game, scoutOut)
  const bullpenOut = await bullpenPromise

  // 3. Storm
  const stormOut = await storm.run(game, parkOut)

  // 4. Raw market
  const marketRaw = await market.fetchLines(game)

  // 5. XGBoost projection (full feature vector includes bullpen group I)
  const features = buildFeatureVector(scoutOut, lineupOut, parkOut, stormOut, marketRaw, bullpenOut)
  let projection = null
  try {
    const modelDir = options.modelVersion
      ? `models/artifacts/${options.modelVersion}`
      : await resolveActiveModelDir()
    if (modelDir) {
      const predRes = await predict(features, { modelDir })
      projection = {
        over_probability: predRes.probability,
        projected_total: marketRaw?.current_line != null
          ? Number((marketRaw.current_line + 2 * (predRes.probability - 0.5)).toFixed(2))
          : null,
        confidence_interval_low: Math.max(0, predRes.probability - 0.05),
        confidence_interval_high: Math.min(1, predRes.probability + 0.05),
        shap: predRes.shap,
        edge: predRes.probability - (marketRaw?.over_price ?? 0.5),
        model_dir: modelDir,
      }
      await saveProjection({
        game_id: game.id,
        model_version: modelDir.split('/').pop(),
        projected_total: projection.projected_total,
        over_probability: projection.over_probability,
        confidence_interval_low: projection.confidence_interval_low,
        confidence_interval_high: projection.confidence_interval_high,
        feature_vector_json: JSON.stringify(features),
        shap_values_json: JSON.stringify(predRes.shap || {}),
      })
    } else {
      projection = {
        over_probability: 0.5,
        projected_total: marketRaw?.current_line ?? 8.5,
        _note: 'no trained model found; neutral projection',
      }
    }
  } catch (err) {
    projection = {
      over_probability: 0.5,
      projected_total: marketRaw?.current_line ?? 8.5,
      _error: err.message,
    }
  }

  // 6. Market synthesis (Claude Sonnet)
  const marketOut = await market.synthesize(marketRaw, projection, {
    scout: scoutOut,
    lineup: lineupOut,
    park: parkOut,
    storm: stormOut,
    bullpen: bullpenOut,
  })

  // 7. Judge (final decision)
  const decision = await judge.decide({
    game,
    scout: scoutOut,
    lineup: lineupOut,
    park: parkOut,
    storm: stormOut,
    market: marketOut,
    bullpen: bullpenOut,
    projection,
    bankroll: options.bankroll,
  })

  return {
    game,
    scout: scoutOut,
    lineup: lineupOut,
    park: parkOut,
    storm: stormOut,
    market: marketOut,
    bullpen: bullpenOut,
    projection,
    decision,
  }
}

/**
 * Run the orchestrator for an entire slate of games.
 */
export async function runSlate(games, options = {}) {
  const limit = pLimit(options.concurrency ?? 4)
  const results = await Promise.all(
    games.map(g => limit(async () => {
      try {
        return await runGame(g, options)
      } catch (err) {
        return { game: g, error: err.message, decision: { decision: 'ERROR', rejection_reason: err.message } }
      }
    })),
  )
  return results
}
