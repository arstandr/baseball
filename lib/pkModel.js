// lib/pkModel.js — Ridge regression pK inference at runtime.
//
// Loads pre-trained weights from models/pk_ridge_weights.json and applies the
// same feature engineering as shadowTestPkModel.py engineer() → Ridge predict.
// Weights are trained by histBacktestPkModel.js (2022-2024 historical data).
// Retrain weekly: node scripts/live/histBacktestPkModel.js

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const WEIGHTS_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../models/pk_ridge_weights.json',
)

const LEAGUE_PA_PER_IP = 4.3
const LEAGUE_K_PCT     = 0.225
const LEAGUE_K9        = 8.8

let _model = null
let _loadAttempted = false

export function loadModel() {
  if (_loadAttempted) return _model
  _loadAttempted = true
  try {
    _model = JSON.parse(fs.readFileSync(WEIGHTS_PATH, 'utf8'))
    const age = (Date.now() - new Date(_model.trained_at).getTime()) / 86400000
    console.log(`[pk-model] Loaded ${_model.feature_names.length}-feature Ridge (cv_r²=${_model.cv_r2?.toFixed(3)}, trained ${age.toFixed(0)}d ago, ${_model.train_rows} rows)`)
  } catch (e) {
    console.log(`[pk-model] No weights file found (${WEIGHTS_PATH}): ${e.message}`)
    _model = null
  }
  return _model
}

// ── Feature engineering — mirrors shadowTestPkModel.py engineer() exactly ────
// All nulls left as-is; caller knows imputer will fill with training medians.
function buildFeatures(inp) {
  const {
    k9_l5, k9_career, k9_season,
    savant_k_pct, savant_whiff, savant_fbv, savant_gb_pct, savant_bb_pct,
    k_pct_vs_l, k_pct_vs_r,
    savant_ip = 0, savant_pa = 0,
    manager_leash_factor,
    expected_bf = 18,
    early_exit_rate_l5,
    bb9_l5,
    bb_penalty = 1.0,
    days_rest,
    w_season = 0, w_career = 0, w_l5 = 1,
    pK_blended_prod,
    // Context / multipliers (in-season only; null for historical mode)
    opp_k_pct, adj_factor, raw_adj_factor,
    park_factor, weather_mult, ump_factor, velo_adj,
  } = inp

  const k_pct_l5_d  = k9_l5    != null ? k9_l5    / (LEAGUE_PA_PER_IP * 9) : null
  const k_pct_car_d = k9_career != null ? k9_career / (LEAGUE_PA_PER_IP * 9) : null
  const k_pct_sea_d = k9_season != null ? k9_season / (LEAGUE_PA_PER_IP * 9) : null

  const best_kpct = savant_k_pct ?? k_pct_l5_d ?? LEAGUE_K_PCT

  const whiff = savant_whiff ?? null
  const fbv   = savant_fbv   ?? 93.0

  // Blend weights from IP (mirrors Python)
  const ip = savant_ip ?? 0
  const w_s_calc = Math.min(0.60, ip / 30)
  const w_c_calc = Math.max(0, 0.40 * (1 - ip / 40))
  const w_l_calc = Math.max(0, 1 - w_s_calc - w_c_calc)
  const w_tot    = Math.max(1e-6, w_s_calc + w_c_calc + w_l_calc)

  const prod_blend = pK_blended_prod ?? (
    (w_s_calc * best_kpct +
     w_c_calc * (k_pct_car_d ?? best_kpct) +
     w_l_calc * (k_pct_l5_d  ?? best_kpct)) / w_tot
  )

  return {
    k_pct_l5_derived:    k_pct_l5_d,
    savant_k_pct:        savant_k_pct ?? LEAGUE_K_PCT,
    k9_l5:               k9_l5 ?? (LEAGUE_K_PCT * LEAGUE_PA_PER_IP * 9),
    k9_career:           k9_career,
    k9_season:           k9_season,
    k_pct_vs_l:          k_pct_vs_l,
    k_pct_vs_r:          k_pct_vs_r,
    pK_split_diff:       (k_pct_vs_l ?? 0) - (k_pct_vs_r ?? 0),
    pK_l5_vs_savant:     (k_pct_l5_d ?? 0) - (savant_k_pct ?? 0),
    pK_career_vs_savant: (k_pct_car_d ?? 0) - (savant_k_pct ?? 0),
    savant_whiff:        whiff,
    savant_fbv:          fbv,
    whiff_x_fbv:         (whiff ?? 0) * fbv,
    savant_gb_pct:       savant_gb_pct,
    savant_bb_pct:       savant_bb_pct,
    bb9_l5:              bb9_l5,
    bb_penalty:          bb_penalty ?? 1.0,
    early_exit_rate_l5:  early_exit_rate_l5,
    manager_leash_factor: manager_leash_factor,
    log_expected_bf:     Math.log1p(expected_bf),
    log_ip_proxy:        Math.log1p(ip),
    savant_ip:           savant_ip,
    savant_pa:           savant_pa,
    days_rest:           days_rest,
    w_season:            w_s_calc,
    w_career:            w_c_calc,
    w_l5:                w_l_calc,
    pK_blended_prod:     prod_blend,
    opp_k_pct:           opp_k_pct ?? LEAGUE_K_PCT,
    adj_factor:          adj_factor ?? 1.0,
    raw_adj_factor:      raw_adj_factor ?? 1.0,
    park_factor:         park_factor ?? 1.0,
    weather_mult:        weather_mult ?? 1.0,
    ump_factor:          ump_factor ?? 1.0,
    velo_adj:            velo_adj ?? 1.0,
  }
}

// ── Inference: impute → scale → dot product → clip ────────────────────────────
export function predictPk(inp, model) {
  if (!model) return null
  const { feature_names, imputer_medians, scaler_mean, scaler_std, ridge_coef, ridge_intercept } = model

  const feats = buildFeatures(inp)

  let pred = ridge_intercept
  for (let i = 0; i < feature_names.length; i++) {
    const name = feature_names[i]
    const raw  = feats[name] ?? null
    const val  = raw != null && !Number.isNaN(raw) ? raw : imputer_medians[i]
    const scaled = (val - scaler_mean[i]) / scaler_std[i]
    pred += scaled * ridge_coef[i]
  }

  return Math.min(0.55, Math.max(0.05, pred))
}
