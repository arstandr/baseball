// lib/pipelineLog.js — Fire-and-forget pipeline step logger.
// All exports are silent — they never throw, never block the hot path.
import * as db from './db.js'

const STEP_COL = {
  model_input:  'model_input_json',
  lambda_calc:  'lambda_calc_json',
  edges:        'edges_json',
  rule_filters: 'rule_filters_json',
  preflight:    'preflight_json',
  bets_placed:  'bets_placed_json',
}

/**
 * Upsert one pipeline step for a pitcher+date.
 * Uses ON CONFLICT ... DO UPDATE so absent fields are preserved across calls.
 *
 * @param {object} opts
 * @param {string} opts.bet_date      YYYY-MM-DD
 * @param {string} opts.pitcher_id    MLB pitcher ID
 * @param {string} opts.pitcher_name
 * @param {string} [opts.game_id]
 * @param {string} [opts.game_label]
 * @param {string} [opts.pitcher_side]
 * @param {string} [opts.game_time]
 * @param {string} opts.step          model_input | lambda_calc | edges | rule_filters | preflight | bets_placed
 * @param {object} opts.payload       step-specific data object (will be JSON.stringify'd)
 * @param {object} [opts.summary]     flat column updates: { n_markets, n_edges, best_edge, lambda, confidence,
 *                                      final_action, status, skip_reason, n_bets_logged }
 */
export async function recordPipelineStep({
  bet_date, pitcher_id, pitcher_name,
  game_id = null, game_label = null, pitcher_side = null, game_time = null,
  step, payload, summary = {},
}) {
  try {
    const col = STEP_COL[step]
    if (!col) return  // unknown step — ignore silently

    const payloadJson = JSON.stringify(payload ?? {})

    // Build the SET clause dynamically — only update columns that are non-null in summary
    // so earlier steps don't get wiped by later steps that omit those fields.
    const summaryKeys = ['n_markets','n_edges','best_edge','lambda','confidence',
                         'final_action','status','skip_reason','n_bets_logged']
    const setClauses = [`${col} = excluded.${col}`, 'updated_at = datetime(\'now\')']
    for (const k of summaryKeys) {
      if (summary[k] != null) setClauses.push(`${k} = excluded.${k}`)
    }

    await db.run(
      `INSERT INTO decision_pipeline
         (bet_date, pitcher_id, pitcher_name, game_id, game_label, pitcher_side, game_time,
          ${col},
          n_markets, n_edges, best_edge, lambda, confidence, final_action, status, skip_reason, n_bets_logged,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(bet_date, pitcher_id) DO UPDATE SET ${setClauses.join(', ')}`,
      [
        bet_date, String(pitcher_id), pitcher_name, game_id, game_label, pitcher_side, game_time,
        payloadJson,
        summary.n_markets    ?? null,
        summary.n_edges      ?? null,
        summary.best_edge    ?? null,
        summary.lambda       ?? null,
        summary.confidence   ?? null,
        summary.final_action ?? null,
        summary.status       ?? 'processed',  // NOT NULL — default to 'processed' when omitted
        summary.skip_reason  ?? null,
        summary.n_bets_logged ?? null,
      ],
    )
  } catch (err) {
    // Swallow all errors — pipeline logging must never crash the betting pipeline
    console.warn(`[pipeline] recordPipelineStep failed (${step} for ${pitcher_name}): ${err.message}`)
  }
}
