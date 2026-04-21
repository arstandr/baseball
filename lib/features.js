// lib/features.js — feature-vector assembly for the XGBoost model.
//
// Full-game totals model (DEC-016). 99 features across groups A-J.
// Produces the exact feature dict the Python model expects.

/**
 * Build the full feature vector from agent outputs. Every feature defaults
 * to a neutral value so missing data never crashes the model.
 *
 * Groups:
 *   A: sp_h_* (SP home) 19 features
 *   B: sp_a_* (SP away) 19 features
 *   C: lu_h_* (Lineup home) 11 features
 *   D: lu_a_* (Lineup away) 11 features
 *   E: pk_*   (Park) 6 features
 *   F: wx_*   (Weather) 7 features
 *   G: mkt_*  (Market) 6 features
 *   H: ix_*   (Interactions) 6 features
 *   I: bp_*   (Bullpen) 10 features (5 home + 5 away)
 *   J: ump_*  (Umpire) 4 features
 * Total: ~99 features
 */
export function buildFeatureVector(scout, lineup, park, storm, market, bullpen, umpire) {
  const sp_h = scout?.pitcher_home?.features || {}
  const sp_a = scout?.pitcher_away?.features || {}
  const lu_h = lineup?.lineup_home?.features || {}
  const lu_a = lineup?.lineup_away?.features || {}
  const bp_h = bullpen?.bullpen_home || {}
  const bp_a = bullpen?.bullpen_away || {}
  const ump = umpire || {}

  const feat = {
    // ---- Group A: SP Home (sp_h_) ----
    sp_h_fip_weighted: sp_h.fip_weighted ?? 4.10,
    sp_h_xfip_weighted: sp_h.xfip_weighted ?? 4.10,
    sp_h_swstr_pct_weighted: sp_h.swstr_pct ?? 0.11,
    sp_h_gb_pct_weighted: sp_h.gb_pct ?? 0.43,
    sp_h_hard_contact_weighted: sp_h.hard_contact_pct ?? 0.36,
    sp_h_k9_weighted: sp_h.k9 ?? sp_h.k9_l5 ?? 8.8,
    sp_h_bb9_weighted: sp_h.bb9 ?? sp_h.bb9_l5 ?? 3.2,
    sp_h_fstrike_pct: sp_h.fstrike_pct ?? 0.60,
    sp_h_tto_penalty: sp_h.tto_penalty ?? 0.35,
    sp_h_tto3_penalty: sp_h.tto3_penalty ?? 0.90, // 3rd time through (full-game critical)
    sp_h_era_l5: sp_h.era_l5 ?? 4.3,
    sp_h_era_f5_l5: sp_h.era_f5_l5 ?? sp_h.era_l5 ?? 4.3,
    sp_h_early_exit_rate_l5: sp_h.early_exit_rate_l5 ?? 0.29,
    sp_h_innings_l5: sp_h.avg_innings_l5 ?? 5.5,
    sp_h_pitch_efficiency_l5: sp_h.pitch_efficiency_l5 ?? 5.8,
    sp_h_days_rest: sp_h.days_rest ?? 5,
    sp_h_season_start_num: sp_h.season_start_num ?? 10,
    sp_h_venue_era_career: sp_h.venue_era_career ?? 4.3,
    sp_h_confidence: scout?.pitcher_home?.confidence ?? 0.5,
    sp_h_vs_lhb_fip: sp_h.vs_lhb_fip ?? 4.10,
    sp_h_vs_rhb_fip: sp_h.vs_rhb_fip ?? 4.10,
    sp_h_news_adjustment: scout?.pitcher_home?.news_adjustment ?? 0,

    // ---- Group B: SP Away (sp_a_) ----
    sp_a_fip_weighted: sp_a.fip_weighted ?? 4.10,
    sp_a_xfip_weighted: sp_a.xfip_weighted ?? 4.10,
    sp_a_swstr_pct_weighted: sp_a.swstr_pct ?? 0.11,
    sp_a_gb_pct_weighted: sp_a.gb_pct ?? 0.43,
    sp_a_hard_contact_weighted: sp_a.hard_contact_pct ?? 0.36,
    sp_a_k9_weighted: sp_a.k9 ?? sp_a.k9_l5 ?? 8.8,
    sp_a_bb9_weighted: sp_a.bb9 ?? sp_a.bb9_l5 ?? 3.2,
    sp_a_fstrike_pct: sp_a.fstrike_pct ?? 0.60,
    sp_a_tto_penalty: sp_a.tto_penalty ?? 0.35,
    sp_a_tto3_penalty: sp_a.tto3_penalty ?? 0.90,
    sp_a_era_l5: sp_a.era_l5 ?? 4.3,
    sp_a_era_f5_l5: sp_a.era_f5_l5 ?? sp_a.era_l5 ?? 4.3,
    sp_a_early_exit_rate_l5: sp_a.early_exit_rate_l5 ?? 0.29,
    sp_a_innings_l5: sp_a.avg_innings_l5 ?? 5.5,
    sp_a_pitch_efficiency_l5: sp_a.pitch_efficiency_l5 ?? 5.8,
    sp_a_days_rest: sp_a.days_rest ?? 5,
    sp_a_season_start_num: sp_a.season_start_num ?? 10,
    sp_a_venue_era_career: sp_a.venue_era_career ?? 4.3,
    sp_a_confidence: scout?.pitcher_away?.confidence ?? 0.5,
    sp_a_vs_lhb_fip: sp_a.vs_lhb_fip ?? 4.10,
    sp_a_vs_rhb_fip: sp_a.vs_rhb_fip ?? 4.10,
    sp_a_news_adjustment: scout?.pitcher_away?.news_adjustment ?? 0,

    // ---- Group C: Lineup Home (lu_h_) ----
    lu_h_wrc_plus_vs_hand_14d: lu_h.wrc_plus_14d ?? 100,
    lu_h_wrc_plus_vs_hand_30d: lu_h.wrc_plus_30d ?? 100,
    lu_h_k_pct_vs_hand_14d: lu_h.k_pct_14d ?? 0.22,
    lu_h_hard_contact_14d: lu_h.hard_contact_14d ?? 0.36,
    lu_h_iso_vs_hand_14d: lu_h.iso_14d ?? 0.155,
    lu_h_runs_pg_14d: lu_h.runs_pg_14d ?? 4.5,                 // full-game runs per game
    lu_h_lob_pct_14d: lu_h.lob_pct_14d ?? 0.72,                // stranded runners
    lu_h_top6_weighted_ops: lu_h.top6_weighted_ops ?? 0.740,
    lu_h_change_adjustment: lu_h.change_adjustment ?? 0,
    lu_h_schedule_fatigue: lu_h.schedule_fatigue ?? 0,
    lu_h_home_away_split: 1,

    // ---- Group D: Lineup Away (lu_a_) ----
    lu_a_wrc_plus_vs_hand_14d: lu_a.wrc_plus_14d ?? 100,
    lu_a_wrc_plus_vs_hand_30d: lu_a.wrc_plus_30d ?? 100,
    lu_a_k_pct_vs_hand_14d: lu_a.k_pct_14d ?? 0.22,
    lu_a_hard_contact_14d: lu_a.hard_contact_14d ?? 0.36,
    lu_a_iso_vs_hand_14d: lu_a.iso_14d ?? 0.155,
    lu_a_runs_pg_14d: lu_a.runs_pg_14d ?? 4.5,
    lu_a_lob_pct_14d: lu_a.lob_pct_14d ?? 0.72,
    lu_a_top6_weighted_ops: lu_a.top6_weighted_ops ?? 0.740,
    lu_a_change_adjustment: lu_a.change_adjustment ?? 0,
    lu_a_schedule_fatigue: lu_a.schedule_fatigue ?? 0,
    lu_a_home_away_split: 0,

    // ---- Group E: Park (pk_) ----
    pk_run_factor: park?.run_factor ?? 1.0,
    pk_hr_factor: park?.hr_factor ?? 1.0,
    pk_f5_factor: park?.f5_factor ?? 1.0,                      // retained as secondary signal
    pk_altitude: park?.altitude_feet ?? 0,
    pk_is_dome: park?.roof === 'dome' ? 1 : 0,
    pk_surface: park?.surface === 'turf' ? 1 : 0,

    // ---- Group F: Weather (wx_) ----
    wx_temp_f: storm?.temp_f ?? 70,
    wx_temp_category: encodeTempCategory(storm?.temp_category),
    wx_wind_mph: storm?.wind_mph ?? 0,
    wx_wind_direction: encodeWindDirection(storm?.wind_direction_relative),
    wx_wind_speed_x_direction:
      (storm?.wind_mph ?? 0) * encodeWindDirectionSigned(storm?.wind_direction_relative),
    wx_humidity: storm?.humidity_pct ?? 0.5,
    wx_precip_prob: storm?.precip_probability ?? 0,

    // ---- Group G: Market (mkt_) — full-game totals (7-10 range) ----
    mkt_opening_line: market?.opening_line ?? 8.5,
    mkt_current_line: market?.current_line ?? 8.5,
    mkt_movement: market?.movement ?? 0,
    mkt_efficiency_score: market?.efficiency_score ?? 1.0,
    mkt_platform_gap: market?.platform_gap ?? 0,
    mkt_time_to_game_hrs: hoursUntil(market?.game_time) ?? 2,

    // ---- Group H: Interactions (ix_) ----
    ix_sp_h_swstr_x_lu_a_k_pct:
      (sp_h.swstr_pct ?? 0.11) * (lu_a.k_pct_14d ?? 0.22),
    ix_sp_a_swstr_x_lu_h_k_pct:
      (sp_a.swstr_pct ?? 0.11) * (lu_h.k_pct_14d ?? 0.22),
    ix_pk_factor_x_wx_temp:
      (park?.run_factor ?? 1.0) * Math.max(0, ((storm?.temp_f ?? 70) - 50) / 30),
    ix_wx_wind_out_x_sp_gb_rate:
      encodeWindDirectionSigned(storm?.wind_direction_relative) *
      (storm?.wind_mph ?? 0) *
      (((sp_h.gb_pct ?? 0.43) + (sp_a.gb_pct ?? 0.43)) / 2),
    // ix_both_sp_quality now weights TTO3 penalty heavily (full-game risk)
    ix_both_sp_quality:
      ((sp_h.fip_weighted ?? 4.10) + (sp_a.fip_weighted ?? 4.10)) / 2 +
      0.5 * (((sp_h.tto3_penalty ?? 0.90) + (sp_a.tto3_penalty ?? 0.90)) / 2),
    ix_lu_offense_vs_sp_quality:
      ((lu_h.wrc_plus_14d ?? 100) + (lu_a.wrc_plus_14d ?? 100)) / 2 /
      Math.max(0.1, ((sp_h.fip_weighted ?? 4.10) + (sp_a.fip_weighted ?? 4.10)) / 2),

    // ---- Group I: Bullpen (bp_) — NEW for full-game ----
    bp_h_era_14d: bp_h.era_14d ?? 4.20,
    bp_h_whip_14d: bp_h.whip_14d ?? 1.30,
    bp_h_k_pct_14d: bp_h.k_pct_14d ?? 0.24,
    bp_h_hr_per_9_14d: bp_h.hr_per_9_14d ?? 1.15,
    bp_h_inherited_score_pct: bp_h.inherited_score_pct ?? 0.33,
    bp_a_era_14d: bp_a.era_14d ?? 4.20,
    bp_a_whip_14d: bp_a.whip_14d ?? 1.30,
    bp_a_k_pct_14d: bp_a.k_pct_14d ?? 0.24,
    bp_a_hr_per_9_14d: bp_a.hr_per_9_14d ?? 1.15,
    bp_a_inherited_score_pct: bp_a.inherited_score_pct ?? 0.33,

    // ---- Group J: Umpire (ump_) ----
    // Home plate umpire career metrics (as-of game date, no lookahead).
    // League avg: ~9.0 runs/game, 0.50 over rate.
    // ump_run_impact > 0 = umpire tends to call high-scoring games.
    ump_runs_pg: ump.runs_pg ?? 9.0,
    ump_over_rate: ump.over_rate ?? 0.50,
    ump_n_games: Math.min(ump.n_games ?? 0, 500),     // cap to prevent outlier encoding
    ump_run_impact: (ump.runs_pg ?? 9.0) - 9.0,       // signed deviation from league avg
  }

  return feat
}

function encodeTempCategory(cat) {
  return { cold: 0, cool: 1, warm: 2, hot: 3 }[cat] ?? 2
}
function encodeWindDirection(dir) {
  return { in: 0, crosswind: 1, out: 2 }[dir] ?? 1
}
function encodeWindDirectionSigned(dir) {
  return { in: -1, crosswind: 0, out: 1 }[dir] ?? 0
}
function hoursUntil(iso) {
  if (!iso) return null
  const d = new Date(iso).getTime()
  if (!d) return null
  return Math.max(0, Number(((d - Date.now()) / (3600 * 1000)).toFixed(2)))
}
