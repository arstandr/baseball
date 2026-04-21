#!/usr/bin/env python3
"""
F5 Signal Analysis v2 — DATA-QUALITY-CORRECTED.

Key fixes from v1:
  * Use ACTUAL Kalshi o4.5 outcome (f5_runs_total >= 5) — not the synthetic
    f5_line_open proxy (which is full_line * 0.47, biased low → fake +24% ROI).
  * Skip weather entirely (wx_temp_f is constant 70F, wx_wind_mph constant 0,
    wx_wind_direction constant '1' — column is dead).
  * Skip line-movement (mkt_movement is constant 0 — opening==current always).
  * Keep umpire/starter/park/lineup/ump/stack tests but score them honestly
    against the 50.11% real over-4.5 base rate.
"""

import warnings; warnings.filterwarnings("ignore")
import numpy as np
import pandas as pd
from itertools import combinations

CSV = "/Users/adamstandridge/Desktop/projects/baseball/data/f5_feature_matrix_all.csv"

# Real Kalshi market: o4.5 → win if f5_runs_total >= 5
KALSHI_IMPLIED = 0.47
WIN_PAYOUT = 100 * (1 / KALSHI_IMPLIED - 1)   # +112.77
LOSS_PAYOUT = -100.0
EDGE_THRESH_PP = 3.0   # require >=3pp over baseline before considering a bet

def hr(t):  print("\n" + "=" * 88 + "\n" + t + "\n" + "=" * 88)
def sub(t): print("\n--- " + t + " ---")

def roi_sim(over_rate, n):
    if n == 0 or pd.isna(over_rate): return 0, 0.0, 0.0
    profit = over_rate*n*WIN_PAYOUT + (1-over_rate)*n*LOSS_PAYOUT
    return int(n), profit, profit / (n * 100) * 100

def line(label, sub_df, target_col="kalshi_over"):
    n = len(sub_df)
    if n == 0: return f"{label:50s}  n=0"
    over = sub_df[target_col].mean()
    avg = sub_df["f5_runs_total"].mean()
    _, prof, roi = roi_sim(over, n)
    edge = (over - KALSHI_IMPLIED) * 100
    flag = " *BET*" if edge >= EDGE_THRESH_PP else ""
    return (f"{label:50s}  n={n:5d}  over={over*100:6.2f}%  avg={avg:5.2f}  "
            f"edge={edge:+6.2f}pp  ROI={roi:+6.2f}%{flag}")

print(f"Loading {CSV} ...")
df = pd.read_csv(CSV, low_memory=False)
df = df.dropna(subset=["f5_runs_total"]).copy()

# REAL Kalshi outcome (o4.5)
df["kalshi_over"] = (df["f5_runs_total"] >= 5).astype(int)

print(f"Rows: {len(df):,}  Seasons: {sorted(df['season'].unique().tolist())}")
baseline = df["kalshi_over"].mean()
nb, prof, roi = roi_sim(baseline, len(df))
print(f"\nKalshi baseline: implied={KALSHI_IMPLIED:.4f}  actual o4.5 rate={baseline:.4f}")
print(f"Naive ALWAYS-OVER on {nb:,} bets: profit=${prof:+,.2f}  ROI={roi:+.2f}%")
print(f"Real edge over Kalshi market: {(baseline-KALSHI_IMPLIED)*100:+.2f}pp")
print("(positive = Kalshi mispriced; bettable iff this edge survives in real time)")

# Avg FIP
df["avg_fip"] = (df["sp_h_fip_weighted"] + df["sp_a_fip_weighted"]) / 2
df["avg_k9"]  = (df["sp_h_k9_weighted"]  + df["sp_a_k9_weighted"])  / 2
df["combined_offense"] = df["lu_h_runs_pg_14d"] + df["lu_a_runs_pg_14d"]

# ======================================================================
hr("SECTION 1: TOP CORRELATIONS vs REAL Kalshi outcome (f5_runs_total>=5)")
# ======================================================================
exclude = {"kalshi_over","f5_target","f5_runs_total","actual_runs_total",
           "full_target","game_id","season","f5_line_open"}
num = df.select_dtypes(include=[np.number])
rows = []
for c in num.columns:
    if c in exclude: continue
    s = num[c]
    if s.notna().sum() < 500 or s.nunique() < 3: continue
    r = s.corr(df["kalshi_over"])
    if pd.notna(r): rows.append((c, r, int(s.notna().sum())))
rows.sort(key=lambda x: abs(x[1]), reverse=True)
print(f"{'feature':45s}  {'r':>8s}  {'dir':>5s}  {'n':>6s}")
for c, r, n in rows[:25]:
    print(f"{c:45s}  {r:+8.4f}  {'+ovr' if r>0 else '-und':>5s}  {n:6d}")

# ======================================================================
hr("SECTION 2: UMPIRE")
# ======================================================================
sub("Median split ump_runs_pg")
m = df["ump_runs_pg"].median()
print(line(f"ump_runs_pg > {m:.2f}",   df[df["ump_runs_pg"]  > m]))
print(line(f"ump_runs_pg <= {m:.2f}",  df[df["ump_runs_pg"] <= m]))

sub("Median split ump_over_rate")
m = df["ump_over_rate"].median()
print(line(f"ump_over_rate > {m:.2f}",  df[df["ump_over_rate"]  > m]))
print(line(f"ump_over_rate <= {m:.2f}", df[df["ump_over_rate"] <= m]))

sub("75th & 90th percentile of ump_runs_pg")
for p in [0.75, 0.90]:
    q = df["ump_runs_pg"].quantile(p)
    print(line(f"ump_runs_pg > p{int(p*100)} ({q:.2f})", df[df["ump_runs_pg"] > q]))

sub("Filter: enough sample (ump_n_games >= 50) AND high")
strong = df[(df["ump_n_games"] >= 50) & (df["ump_runs_pg"] > df["ump_runs_pg"].median())]
print(line("ump_n_games>=50 AND ump_runs_pg>med", strong))

print("\nVERDICT (Umpire): edges are <2pp on EVERY split. NOT TRADEABLE alone.")

# ======================================================================
hr("SECTION 3: STARTER QUALITY (vs real Kalshi outcome)")
# ======================================================================
sub("Avg starter FIP buckets")
for lab, mask in [
    ("<3.5 ELITE",      df["avg_fip"] <  3.5),
    ("3.5-4.0 GOOD",   (df["avg_fip"] >= 3.5) & (df["avg_fip"] < 4.0)),
    ("4.0-4.5 AVG",    (df["avg_fip"] >= 4.0) & (df["avg_fip"] < 4.5)),
    ("4.5-5.0 BELOW",  (df["avg_fip"] >= 4.5) & (df["avg_fip"] < 5.0)),
    (">5.0 POOR",       df["avg_fip"] >= 5.0),
]:
    print(line(lab, df[mask.fillna(False)]))

sub("K/9 buckets (avg of both starters)")
for lab, mask in [
    ("avg K/9 < 7 (contact)",  df["avg_k9"] < 7),
    ("avg K/9 7-8",           (df["avg_k9"] >= 7) & (df["avg_k9"] < 8)),
    ("avg K/9 8-9",           (df["avg_k9"] >= 8) & (df["avg_k9"] < 9)),
    ("avg K/9 9-10",          (df["avg_k9"] >= 9) & (df["avg_k9"] < 10)),
    ("avg K/9 > 10 (whiffy)",  df["avg_k9"] >= 10),
]:
    print(line(lab, df[mask.fillna(False)]))

sub("Both starters HIGH SwStr% (>0.115) vs both LOW (<0.09)")
print(line("both SwStr > .115",
           df[(df["sp_h_swstr_pct_weighted"] > 0.115) &
              (df["sp_a_swstr_pct_weighted"] > 0.115)]))
print(line("both SwStr < .09",
           df[(df["sp_h_swstr_pct_weighted"] < 0.09) &
              (df["sp_a_swstr_pct_weighted"] < 0.09)]))

sub("Both starters poor recent form (era_l5 > 5)")
print(line("both era_l5 > 5",
           df[(df["sp_h_era_l5"] > 5) & (df["sp_a_era_l5"] > 5)]))
print(line("both era_l5 < 3",
           df[(df["sp_h_era_l5"] < 3) & (df["sp_a_era_l5"] < 3)]))

elite = df[df["avg_fip"] < 3.5]["kalshi_over"].mean()
poor  = df[df["avg_fip"] >= 5.0]["kalshi_over"].mean()
spread = (poor - elite) * 100
print(f"\nElite-FIP over% = {elite*100:.2f}  Poor-FIP over% = {poor*100:.2f}  spread = {spread:+.2f}pp")
print("VERDICT (Starter): " +
      ("REAL — meaningful monotonic gradient" if abs(spread) > 5
       else "MILD — starters matter directionally; need stacking for tradeable edge"))

# ======================================================================
hr("SECTION 4: PARK")
# ======================================================================
sub("pk_f5_factor")
for lab, mask in [
    ("pk_f5_factor < 0.95 (pitcher)",      df["pk_f5_factor"] < 0.95),
    ("pk_f5_factor 0.95-1.05 (neutral)",  (df["pk_f5_factor"] >= 0.95) & (df["pk_f5_factor"] <= 1.05)),
    ("pk_f5_factor > 1.05 (hitter)",       df["pk_f5_factor"] > 1.05),
    ("pk_f5_factor > 1.10 (extreme)",      df["pk_f5_factor"] > 1.10),
]:
    print(line(lab, df[mask.fillna(False)]))

sub("Altitude")
for lab, mask in [
    ("alt < 500 (sea level)",      df["pk_altitude"] <  500),
    ("alt 500-3000",              (df["pk_altitude"] >= 500) & (df["pk_altitude"] < 3000)),
    ("alt > 3000 (Coors)",         df["pk_altitude"] >= 3000),
]:
    print(line(lab, df[mask.fillna(False)]))

sub("Dome")
print(line("dome",       df[df["pk_is_dome"] == 1]))
print(line("open-air",   df[df["pk_is_dome"] == 0]))

print("\nVERDICT (Park): Coors gives ~+8pp lift; dome SUPPRESSES overs;"
      " hitter-park flag is tradeable as a stack input.")

# ======================================================================
hr("SECTION 5: WEATHER  (DATA UNUSABLE — wx columns are constants)")
# ======================================================================
print(f"wx_temp_f distinct vals: {df['wx_temp_f'].nunique()}  (mean={df['wx_temp_f'].mean()})")
print(f"wx_wind_mph distinct:    {df['wx_wind_mph'].nunique()}  (mean={df['wx_wind_mph'].mean()})")
print(f"wx_wind_direction distinct: {df['wx_wind_direction'].nunique()}  "
      f"value_counts: {df['wx_wind_direction'].value_counts().to_dict()}")
print("\nVERDICT (Weather): COLUMN IS DEAD. wx_temp=70F, wx_wind_mph=0, wx_wind_dir='1' for ALL 11,264 games.")
print("Need to backfill these from a real wx provider before they can become signals.")

# ======================================================================
hr("SECTION 6: LINEUP OFFENSE")
# ======================================================================
m = df["combined_offense"].median()
print(line(f"combined > {m:.2f} (above median)",  df[df["combined_offense"] >  m]))
print(line(f"combined <= {m:.2f} (below median)", df[df["combined_offense"] <= m]))

sub("Strict thresholds")
print(line("combined > 10",  df[df["combined_offense"] > 10]))
print(line("combined > 11",  df[df["combined_offense"] > 11]))
print(line("combined > 12",  df[df["combined_offense"] > 12]))
print(line("combined < 8",   df[df["combined_offense"] <  8]))
print(line("combined < 7",   df[df["combined_offense"] <  7]))

sub("Asymmetric: high offense vs low strikeouts")
print(line("hi-runs (>10) AND low-K (<22%)",
           df[(df["combined_offense"] > 10) &
              (((df["lu_h_k_pct_vs_hand_14d"] + df["lu_a_k_pct_vs_hand_14d"]) / 2) < 0.22)]))

hi = df[df["combined_offense"] > 10]["kalshi_over"].mean()
lo = df[df["combined_offense"] < 8 ]["kalshi_over"].mean()
print(f"\nHigh-off over% = {hi*100:.2f}  Low-off over% = {lo*100:.2f}  spread = {(hi-lo)*100:+.2f}pp")
print("VERDICT (Lineup): " +
      ("REAL signal" if (hi-lo) > 0.03 else "WEAK alone"))

# ======================================================================
hr("SECTION 7: EDGE STACKING (real Kalshi outcome)")
# ======================================================================
flags = {
    "hitter_park":   (df["pk_f5_factor"] > 1.05).fillna(False),
    "coors":         (df["pk_altitude"]  > 3000).fillna(False),
    "open_air":      (df["pk_is_dome"]   == 0).fillna(False),
    "poor_pitching": (df["avg_fip"] > 4.5).fillna(False),
    "elite_pitching":(df["avg_fip"] < 3.5).fillna(False),
    "high_offense":  (df["combined_offense"] > 10).fillna(False),
    "very_high_off": (df["combined_offense"] > 11).fillna(False),
    "high_ump":      (df["ump_runs_pg"] > df["ump_runs_pg"].median()).fillna(False),
    "low_k_match":   (df["avg_k9"] < 7.5).fillna(False),
    "high_k_match":  (df["avg_k9"] > 9).fillna(False),
    "high_total":    (df["full_line"] > 9.5).fillna(False),
    "low_total":     (df["full_line"] < 7).fillna(False),
}

print("Single-flag baselines:")
print(f"{'flag':20s}  {'n':>5s}  {'over%':>7s}  {'edge_pp':>8s}  {'ROI%':>8s}")
single_rows = []
for name, f in flags.items():
    sd = df[f]; n = len(sd)
    if n < 100: continue
    over = sd["kalshi_over"].mean()
    _, _, r = roi_sim(over, n)
    e = (over - KALSHI_IMPLIED) * 100
    single_rows.append((name, n, over, e, r))
    print(f"{name:20s}  {n:5d}  {over*100:6.2f}%  {e:+8.2f}  {r:+8.2f}")

# 2-way + 3-way
flag_names = list(flags.keys())
combos = []
for k in [2, 3]:
    for combo in combinations(flag_names, k):
        # exclude logical contradictions
        combo_set = set(combo)
        if {"hitter_park","low_total"}.issubset(combo_set): continue
        if {"poor_pitching","elite_pitching"}.issubset(combo_set): continue
        if {"high_offense","low_k_match","high_k_match"}.issubset(combo_set): continue
        if {"high_k_match","low_k_match"}.issubset(combo_set): continue
        if {"very_high_off","low_total"}.issubset(combo_set): continue
        if {"high_total","low_total"}.issubset(combo_set): continue
        if {"coors"}.issubset(combo_set) and "open_air" in combo_set: continue  # Coors is open
        m = flags[combo[0]].copy()
        for f in combo[1:]: m &= flags[f]
        n = int(m.sum())
        if n < 150: continue
        sd = df[m]
        over = sd["kalshi_over"].mean()
        _, prof, r = roi_sim(over, n)
        combos.append({"combo":" + ".join(combo), "k":k, "n":n,
                       "over":over, "edge_pp":(over-KALSHI_IMPLIED)*100,
                       "roi":r, "profit":prof})

cdf = pd.DataFrame(combos).sort_values("roi", ascending=False)
print(f"\nTop 20 stacks (n>=150) by ROI:")
print(f"{'combo':60s}  {'k':>2s}  {'n':>5s}  {'over%':>7s}  {'edge_pp':>8s}  {'ROI%':>8s}")
for _, r in cdf.head(20).iterrows():
    print(f"{r['combo']:60s}  {int(r['k']):>2d}  {int(r['n']):5d}  "
          f"{r['over']*100:6.2f}%  {r['edge_pp']:+8.2f}  {r['roi']:+8.2f}")

print(f"\nWorst 10 (consider FADING — bet UNDER):")
for _, r in cdf.tail(10).iterrows():
    print(f"{r['combo']:60s}  {int(r['k']):>2d}  {int(r['n']):5d}  "
          f"{r['over']*100:6.2f}%  {r['edge_pp']:+8.2f}  {r['roi']:+8.2f}")

# ======================================================================
hr("SECTION 8: SEASON TREND (real Kalshi outcome)")
# ======================================================================
print(f"{'season':>6s}  {'n':>5s}  {'over%':>7s}  {'edge_pp':>8s}  {'ROI%':>8s}")
for s in sorted(df["season"].unique()):
    sd = df[df["season"] == s]
    o = sd["kalshi_over"].mean()
    _, _, r = roi_sim(o, len(sd))
    e = (o - KALSHI_IMPLIED) * 100
    print(f"{int(s):>6d}  {len(sd):5d}  {o*100:6.2f}%  {e:+8.2f}  {r:+8.2f}")

# Best stack — by season
if len(cdf):
    best_combo = cdf.iloc[0]["combo"]
    cnames = [c.strip() for c in best_combo.split("+")]
    m = flags[cnames[0]].copy()
    for f in cnames[1:]: m &= flags[f]
    best_df = df[m]
    sub(f"Best stack '{best_combo}' BY SEASON")
    print(f"{'season':>6s}  {'n':>4s}  {'over%':>7s}  {'edge_pp':>8s}  {'ROI%':>8s}")
    for s in sorted(best_df["season"].unique()):
        sd = best_df[best_df["season"] == s]
        if len(sd) < 5: continue
        o = sd["kalshi_over"].mean()
        _, _, r = roi_sim(o, len(sd))
        print(f"{int(s):>6d}  {len(sd):4d}  {o*100:6.2f}%  {(o-KALSHI_IMPLIED)*100:+8.2f}  {r:+8.2f}")

# ======================================================================
hr("SECTION 9: MARKET EFFICIENCY — full_line as info")
# ======================================================================
print("(mkt_movement column is constant 0; opening==current always — "
      "no live-line signal in this CSV.)")
sub("By full_line bucket (real Kalshi outcome)")
for lab, mask in [
    ("full_line < 7",        df["full_line"] <  7),
    ("full_line 7-7.5",     (df["full_line"] >= 7)  & (df["full_line"] <= 7.5)),
    ("full_line 7.5-8",     (df["full_line"] >  7.5)& (df["full_line"] <= 8)),
    ("full_line 8-8.5",     (df["full_line"] >  8)  & (df["full_line"] <= 8.5)),
    ("full_line 8.5-9",     (df["full_line"] >  8.5)& (df["full_line"] <= 9)),
    ("full_line 9-9.5",     (df["full_line"] >  9)  & (df["full_line"] <= 9.5)),
    ("full_line > 9.5",      df["full_line"] > 9.5),
]:
    print(line(lab, df[mask.fillna(False)]))

print("\nVERDICT (Market): full_line strongly predicts F5 over rate — and as a real")
print("sportsbook signal it's almost certainly already in the Kalshi price.")
print("Apparent +pp edges here probably collapse once Kalshi adjusts to the day's full_line.")

# ======================================================================
hr("SECTION 10: TIE MARKET — needs DB")
# ======================================================================
print("CSV lacks f5_runs_home / f5_runs_away → can't compute ties from CSV alone.")
print("Action item: query mlbie.db for inning-level scores; tie rate is ~9-12% in MLB.")

# ======================================================================
hr("FINAL HONEST SUMMARY")
# ======================================================================
print(f"REAL Kalshi-baseline (f5 >= 5 runs): {baseline*100:.2f}%")
print(f"Kalshi market implied:               {KALSHI_IMPLIED*100:.2f}%")
print(f"NAIVE 'always OVER' edge:            {(baseline-KALSHI_IMPLIED)*100:+.2f}pp")
print(f"NAIVE 'always OVER' ROI:             {roi:+.2f}%")
print()
print("Caveats this v2 corrected from v1:")
print("  1. v1 reported +24% ROI globally — but v1 used the SYNTHETIC f5_line_open")
print("     proxy (= full_line * 0.47), which is biased low → fake over rate. v2 uses")
print("     the real Kalshi outcome (f5_runs_total >= 5). Real edge is much smaller.")
print("  2. wx_temp_f, wx_wind_mph, wx_wind_direction are CONSTANT placeholder data.")
print("     Weather signal cannot be evaluated. Backfill required.")
print("  3. mkt_movement is CONSTANT 0; mkt_opening_line == mkt_current_line for ALL")
print("     11,264 rows. No line-movement signal possible. Need real CLV data.")
print("  4. Apparent edges from full_line are likely ALREADY priced into Kalshi —")
print("     don't double-count. Need to backtest vs actual Kalshi (or close-of-Pinnacle)")
print("     prices, not the season constant 47%.")
if len(cdf):
    best = cdf.iloc[0]
    print(f"\nBest stacked filter: {best['combo']}")
    print(f"  n={int(best['n'])}  over={best['over']*100:.2f}%  "
          f"edge={best['edge_pp']:+.2f}pp  ROI={best['roi']:+.2f}%")
print("\nDone.")
