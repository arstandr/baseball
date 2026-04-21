#!/usr/bin/env python3
"""
F5 (First 5 Innings) Signal Analysis
Comprehensive exploitable-signal hunt for Kalshi F5 over/under betting.
"""

import os
import sys
import warnings
warnings.filterwarnings("ignore")

import numpy as np
import pandas as pd
from itertools import combinations

CSV = "/Users/adamstandridge/Desktop/projects/baseball/data/f5_feature_matrix_all.csv"

# ROI constants
KALSHI_IMPLIED = 0.47
WIN_PAYOUT = 100 * (1 / KALSHI_IMPLIED - 1)   # +112.77
LOSS_PAYOUT = -100.0
EDGE_THRESHOLD = 0.50  # bet when predicted prob > 50% (>=3pp above 47% baseline)

def hr(title):
    print("\n" + "=" * 88)
    print(title)
    print("=" * 88)

def sub(title):
    print("\n--- " + title + " ---")

def fmt_pct(x):
    return f"{x*100:6.2f}%" if pd.notna(x) else "  n/a "

def roi_sim(over_rate, n):
    """Bet $100 OVER at Kalshi 47% implied; returns (n_bets, profit, roi_pct)."""
    if n == 0 or pd.isna(over_rate):
        return 0, 0.0, 0.0
    wins  = over_rate * n
    losses = (1 - over_rate) * n
    profit = wins * WIN_PAYOUT + losses * LOSS_PAYOUT
    roi    = profit / (n * 100) * 100
    return int(n), profit, roi

def roi_row(label, sub_df, threshold_prob=None):
    """Helper: compute over rate + ROI on a sub-dataframe (always bet OVER)."""
    n = len(sub_df)
    if n == 0:
        return f"{label:50s}  n=0"
    over = sub_df["f5_target"].mean()
    avg_runs = sub_df["f5_runs_total"].mean()
    nb, profit, roi = roi_sim(over, n)
    edge = (over - KALSHI_IMPLIED) * 100
    return (f"{label:50s}  n={n:5d}  over={fmt_pct(over)}  "
            f"avg_runs={avg_runs:5.2f}  edge={edge:+6.2f}pp  "
            f"profit=${profit:+10.2f}  ROI={roi:+6.2f}%")

# ----------------------------------------------------------------------
print(f"Loading {CSV} ...")
df = pd.read_csv(CSV, low_memory=False)
print(f"Rows: {len(df):,}  Cols: {len(df.columns)}")
print(f"Date range: {df['date'].min()} -> {df['date'].max()}")
print(f"Seasons: {sorted(df['season'].dropna().unique().tolist())}")

# Drop rows missing the target — can't analyze without it
before = len(df)
df = df.dropna(subset=["f5_target", "f5_runs_total"]).copy()
print(f"After dropna(f5_target,f5_runs_total): {len(df):,} (dropped {before-len(df)})")

baseline_over = df["f5_target"].mean()
print(f"\nGlobal F5 over rate (vs f5_line_open): {fmt_pct(baseline_over)}")
print(f"Global avg f5_runs_total: {df['f5_runs_total'].mean():.3f}")
print(f"Kalshi implied (o4.5):    {fmt_pct(KALSHI_IMPLIED)}")
print(f"Bet payout: WIN=+${WIN_PAYOUT:.2f}  LOSS=${LOSS_PAYOUT:.2f}")

# ======================================================================
hr("SECTION 1: FEATURE CORRELATIONS (Pearson r vs f5_target)")
# ======================================================================
numeric = df.select_dtypes(include=[np.number]).copy()
exclude = {"f5_target", "f5_runs_total", "actual_runs_total", "full_target",
           "game_id", "season"}
feat_cols = [c for c in numeric.columns if c not in exclude]

corrs = []
for c in feat_cols:
    s = numeric[c]
    if s.notna().sum() < 200 or s.nunique() < 3:
        continue
    r = s.corr(df["f5_target"])
    if pd.notna(r):
        corrs.append((c, r, s.notna().sum()))

corrs.sort(key=lambda x: abs(x[1]), reverse=True)
print(f"\nTop 25 features by |Pearson r| with f5_target:")
print(f"{'feature':45s}  {'r':>8s}  {'direction':>10s}  {'n':>7s}")
print("-" * 78)
for c, r, n in corrs[:25]:
    direction = "more runs" if r > 0 else "fewer runs"
    print(f"{c:45s}  {r:+8.4f}  {direction:>10s}  {n:7d}")

# ======================================================================
hr("SECTION 2: UMPIRE SIGNAL")
# ======================================================================
ump = df.dropna(subset=["ump_runs_pg"]).copy()
print(f"Games with umpire data: {len(ump):,}  ({len(ump)/len(df)*100:.1f}% of total)")
ump_avg_n = ump["ump_n_games"].mean() if "ump_n_games" in ump else float('nan')
print(f"Avg ump_n_games (history): {ump_avg_n:.1f}")

sub("Split by ump_runs_pg (median)")
med_runs = ump["ump_runs_pg"].median()
print(f"Median ump_runs_pg = {med_runs:.3f}")
hi  = ump[ump["ump_runs_pg"] >  med_runs]
lo  = ump[ump["ump_runs_pg"] <= med_runs]
print(roi_row(f"ump_runs_pg > {med_runs:.2f} (HIGH)", hi))
print(roi_row(f"ump_runs_pg <= {med_runs:.2f} (LOW)", lo))

sub("Split by ump_over_rate (median)")
med_or = ump["ump_over_rate"].median()
print(f"Median ump_over_rate = {med_or:.3f}")
hi2 = ump[ump["ump_over_rate"] >  med_or]
lo2 = ump[ump["ump_over_rate"] <= med_or]
print(roi_row(f"ump_over_rate > {med_or:.2f} (HIGH)", hi2))
print(roi_row(f"ump_over_rate <= {med_or:.2f} (LOW)", lo2))

sub("ROI sim: bet OVER when ump_runs_pg > 75th pct")
p75 = ump["ump_runs_pg"].quantile(0.75)
print(f"75th pct ump_runs_pg = {p75:.3f}")
top_ump = ump[ump["ump_runs_pg"] > p75]
print(roi_row(f"ump_runs_pg > {p75:.2f}", top_ump))

# Verdict
ump_hi_over = hi["f5_target"].mean()
ump_or_hi   = hi2["f5_target"].mean()
ump_p75_over = top_ump["f5_target"].mean()
edge1 = (ump_hi_over - KALSHI_IMPLIED) * 100
edge2 = (ump_or_hi - KALSHI_IMPLIED) * 100
edge3 = (ump_p75_over - KALSHI_IMPLIED) * 100
print(f"\nEdges vs 47% baseline: median-split runs/g={edge1:+.2f}pp, "
      f"over_rate split={edge2:+.2f}pp, p75={edge3:+.2f}pp")
verdict = ("MARGINAL — small but consistent edge" if max(edge1,edge2,edge3) > 1.5
           else "NOISE — sub-1pp edges are inside sampling error")
print(f"VERDICT (Umpire): {verdict}")

# ======================================================================
hr("SECTION 3: STARTER QUALITY BUCKETS")
# ======================================================================
df["avg_fip"] = (df["sp_h_fip_weighted"] + df["sp_a_fip_weighted"]) / 2
fip = df.dropna(subset=["avg_fip"])
print(f"Games with both starter FIPs: {len(fip):,}")

buckets = [
    ("<3.5 ELITE",     fip[fip["avg_fip"] <  3.5]),
    ("3.5-4.0 GOOD",   fip[(fip["avg_fip"] >= 3.5) & (fip["avg_fip"] < 4.0)]),
    ("4.0-4.5 AVG",    fip[(fip["avg_fip"] >= 4.0) & (fip["avg_fip"] < 4.5)]),
    ("4.5-5.0 BELOW",  fip[(fip["avg_fip"] >= 4.5) & (fip["avg_fip"] < 5.0)]),
    (">5.0 POOR",      fip[fip["avg_fip"] >= 5.0]),
]
sub("Avg starter FIP buckets")
for label, sd in buckets:
    print(roi_row(label, sd))

sub("Both starters HIGH K/9 (>9) vs both LOW (<7)")
both_hi_k = df[(df["sp_h_k9_weighted"] > 9) & (df["sp_a_k9_weighted"] > 9)]
both_lo_k = df[(df["sp_h_k9_weighted"] < 7) & (df["sp_a_k9_weighted"] < 7)]
print(roi_row("both K/9 > 9 (whiffy)",   both_hi_k))
print(roi_row("both K/9 < 7 (contact)",  both_lo_k))

sub("Both starters HIGH SwStr% (>0.115) vs both LOW (<0.09)")
both_hi_sw = df[(df["sp_h_swstr_pct_weighted"] > 0.115) &
                (df["sp_a_swstr_pct_weighted"] > 0.115)]
both_lo_sw = df[(df["sp_h_swstr_pct_weighted"] < 0.09) &
                (df["sp_a_swstr_pct_weighted"] < 0.09)]
print(roi_row("both SwStr > .115 (nasty)", both_hi_sw))
print(roi_row("both SwStr < .09 (hittable)", both_lo_sw))

poor_over = buckets[4][1]["f5_target"].mean() if len(buckets[4][1]) else 0
elite_over = buckets[0][1]["f5_target"].mean() if len(buckets[0][1]) else 0
print(f"\nElite-FIP over% = {fmt_pct(elite_over)} | Poor-FIP over% = {fmt_pct(poor_over)}")
spread = (poor_over - elite_over) * 100
print(f"Spread elite -> poor = {spread:+.2f}pp")
print("VERDICT (Starter quality): "
      + ("REAL & TRADEABLE — clear monotonic spread" if abs(spread) > 8
         else "MILD — directional but limited edge"))

# ======================================================================
hr("SECTION 4: PARK SIGNAL")
# ======================================================================
park = df.dropna(subset=["pk_f5_factor"])
print(f"Games with park factor: {len(park):,}")

sub("By pk_f5_factor")
print(roi_row("pk_f5_factor < 0.95 (pitcher park)",
              park[park["pk_f5_factor"] < 0.95]))
print(roi_row("pk_f5_factor 0.95-1.05 (neutral)",
              park[(park["pk_f5_factor"] >= 0.95) & (park["pk_f5_factor"] <= 1.05)]))
print(roi_row("pk_f5_factor > 1.05 (hitter park)",
              park[park["pk_f5_factor"] > 1.05]))

sub("By altitude")
alt = df.dropna(subset=["pk_altitude"])
print(roi_row("altitude < 500ft (sea level)",   alt[alt["pk_altitude"] <  500]))
print(roi_row("altitude 500-3000ft (moderate)", alt[(alt["pk_altitude"] >= 500) & (alt["pk_altitude"] < 3000)]))
print(roi_row("altitude > 3000ft (Coors)",      alt[alt["pk_altitude"] >= 3000]))

sub("By dome")
print(roi_row("dome (pk_is_dome=1)",   df[df["pk_is_dome"] == 1]))
print(roi_row("open (pk_is_dome=0)",   df[df["pk_is_dome"] == 0]))

coors_over = alt[alt["pk_altitude"] >= 3000]["f5_target"].mean()
hpark_over = park[park["pk_f5_factor"] > 1.05]["f5_target"].mean()
print(f"\nCoors over% = {fmt_pct(coors_over)} | Hitter park over% = {fmt_pct(hpark_over)}")
print("VERDICT (Parks): "
      + ("Coors is a paint-by-numbers OVER bet; mild hitter-park lift elsewhere"
         if coors_over > 0.55 else "PARK ALONE TOO WEAK — combine with other flags"))

# ======================================================================
hr("SECTION 5: WEATHER")
# ======================================================================
wx = df.dropna(subset=["wx_temp_f"])
print(f"Games with weather: {len(wx):,}")

sub("Temperature buckets")
print(roi_row("cold <50F",         wx[wx["wx_temp_f"] <  50]))
print(roi_row("cool 50-65F",       wx[(wx["wx_temp_f"] >= 50) & (wx["wx_temp_f"] < 65)]))
print(roi_row("warm 65-80F",       wx[(wx["wx_temp_f"] >= 65) & (wx["wx_temp_f"] < 80)]))
print(roi_row("hot >80F",          wx[wx["wx_temp_f"] >= 80]))

sub("Wind direction")
if "wx_wind_direction" in df.columns:
    for wd in ["out", "in", "crosswind", "calm", "varied"]:
        s = df[df["wx_wind_direction"].astype(str).str.lower() == wd]
        if len(s):
            print(roi_row(f"wind={wd}", s))
    # Print whatever distinct values exist for transparency
    vc = df["wx_wind_direction"].astype(str).str.lower().value_counts().head(10)
    print(f"\nWind direction distribution (top 10): {vc.to_dict()}")

sub("Wind speed × out-direction (>10 mph blowing OUT)")
out_strong = df[(df["wx_wind_direction"].astype(str).str.lower() == "out") &
                (df["wx_wind_mph"] > 10)]
in_strong  = df[(df["wx_wind_direction"].astype(str).str.lower() == "in") &
                (df["wx_wind_mph"] > 10)]
print(roi_row("wind OUT > 10 mph", out_strong))
print(roi_row("wind IN  > 10 mph", in_strong))

hot_over = wx[wx["wx_temp_f"] >= 80]["f5_target"].mean()
out_over = out_strong["f5_target"].mean() if len(out_strong) else float('nan')
print(f"\nHot (>80F) over% = {fmt_pct(hot_over)} | Wind-out>10 over% = {fmt_pct(out_over)}")
weather_edge = max(
    (hot_over - KALSHI_IMPLIED) if pd.notna(hot_over) else -1,
    (out_over - KALSHI_IMPLIED) if pd.notna(out_over) else -1,
)
print("VERDICT (Weather): "
      + ("REAL — hot & wind-out lift over rate" if weather_edge > 0.03
         else "MARGINAL — small directional effect, needs stacking"))

# ======================================================================
hr("SECTION 6: LINEUP OFFENSE")
# ======================================================================
lu = df.dropna(subset=["lu_h_runs_pg_14d", "lu_a_runs_pg_14d"]).copy()
lu["combined_offense"] = lu["lu_h_runs_pg_14d"] + lu["lu_a_runs_pg_14d"]
print(f"Games with both lineup runs/g: {len(lu):,}")

med = lu["combined_offense"].median()
print(f"Median combined offense (runs/g 14d): {med:.2f}")
print(roi_row(f"combined > {med:.2f}",  lu[lu["combined_offense"] >  med]))
print(roi_row(f"combined <= {med:.2f}", lu[lu["combined_offense"] <= med]))

sub("Strict thresholds")
print(roi_row("combined > 10 (high)",  lu[lu["combined_offense"] > 10]))
print(roi_row("combined < 8 (low)",    lu[lu["combined_offense"] <  8]))
print(roi_row("combined > 11",         lu[lu["combined_offense"] > 11]))

hi_off = lu[lu["combined_offense"] > 10]["f5_target"].mean()
lo_off = lu[lu["combined_offense"] < 8]["f5_target"].mean()
print(f"\nHigh offense over% = {fmt_pct(hi_off)} | Low offense over% = {fmt_pct(lo_off)}")
print("VERDICT (Lineup offense): "
      + ("REAL — recent run-scoring is a clean filter" if (hi_off - lo_off) > 0.03
         else "WEAK — recent runs/g is barely informative alone"))

# ======================================================================
hr("SECTION 7: EDGE STACKING — FILTER COMBINATIONS")
# ======================================================================

# Build all flags (NaN -> False so we never silently miss data)
flags = {}
flags["hitter_park"]   = (df["pk_f5_factor"]  > 1.05).fillna(False)
flags["poor_pitching"] = (((df["sp_h_fip_weighted"] + df["sp_a_fip_weighted"]) / 2) > 4.5).fillna(False)
flags["hot_weather"]   = (df["wx_temp_f"]     > 75).fillna(False)
flags["high_offense"]  = ((df["lu_h_runs_pg_14d"] + df["lu_a_runs_pg_14d"]) > 10).fillna(False)
ump_med = df["ump_runs_pg"].median()
flags["high_ump"]      = (df["ump_runs_pg"]   > ump_med).fillna(False)
flags["wind_out"]      = (df["wx_wind_direction"].astype(str).str.lower() == "out")
flags["low_k_matchup"] = (((df["sp_h_k9_weighted"] + df["sp_a_k9_weighted"]) / 2) < 7.5).fillna(False)

print("Single-flag baselines (n, over%, edge_pp, ROI%):")
print(f"{'flag':22s}  {'n':>5s}  {'over%':>8s}  {'edge_pp':>8s}  {'ROI%':>8s}")
print("-" * 60)
for name, f in flags.items():
    sub_df = df[f]
    n = len(sub_df)
    if n:
        over = sub_df["f5_target"].mean()
        _, _, roi = roi_sim(over, n)
        print(f"{name:22s}  {n:5d}  {fmt_pct(over)}  "
              f"{(over-KALSHI_IMPLIED)*100:+8.2f}  {roi:+8.2f}")

# 2-way + 3-way combos
combos = []
flag_names = list(flags.keys())

for a, b in combinations(flag_names, 2):
    mask = flags[a] & flags[b]
    n = mask.sum()
    if n >= 150:
        sub_df = df[mask]
        over = sub_df["f5_target"].mean()
        _, profit, roi = roi_sim(over, n)
        combos.append({
            "combo": f"{a} + {b}",
            "k": 2,
            "n": int(n),
            "over_rate": over,
            "edge_pp": (over - KALSHI_IMPLIED) * 100,
            "ROI_pct": roi,
            "profit": profit,
        })

for a, b, c in combinations(flag_names, 3):
    mask = flags[a] & flags[b] & flags[c]
    n = mask.sum()
    if n >= 150:
        sub_df = df[mask]
        over = sub_df["f5_target"].mean()
        _, profit, roi = roi_sim(over, n)
        combos.append({
            "combo": f"{a} + {b} + {c}",
            "k": 3,
            "n": int(n),
            "over_rate": over,
            "edge_pp": (over - KALSHI_IMPLIED) * 100,
            "ROI_pct": roi,
            "profit": profit,
        })

combos_df = pd.DataFrame(combos).sort_values("ROI_pct", ascending=False)
print(f"\nAll combos with n>=150 sorted by ROI (top 20):")
print(f"{'combo':55s}  {'k':>2s}  {'n':>5s}  {'over%':>8s}  {'edge_pp':>8s}  {'ROI%':>8s}")
print("-" * 100)
for _, r in combos_df.head(20).iterrows():
    print(f"{r['combo']:55s}  {int(r['k']):>2d}  {int(r['n']):5d}  "
          f"{r['over_rate']*100:6.2f}%  {r['edge_pp']:+8.2f}  {r['ROI_pct']:+8.2f}")

print(f"\nWorst 5 (avoid these — fade-OVER candidates):")
for _, r in combos_df.tail(5).iterrows():
    print(f"{r['combo']:55s}  {int(r['k']):>2d}  {int(r['n']):5d}  "
          f"{r['over_rate']*100:6.2f}%  {r['edge_pp']:+8.2f}  {r['ROI_pct']:+8.2f}")

best = combos_df.head(1).iloc[0] if len(combos_df) else None
if best is not None:
    print(f"\nBEST stack: {best['combo']}  n={int(best['n'])}  "
          f"over={best['over_rate']*100:.2f}%  edge={best['edge_pp']:+.2f}pp  "
          f"ROI={best['ROI_pct']:+.2f}%")

# ======================================================================
hr("SECTION 8: SEASON ROI TREND")
# ======================================================================
print(f"{'season':>6s}  {'n':>5s}  {'over%':>8s}  {'edge_vs_47':>10s}  {'ROI%':>8s}")
print("-" * 50)
season_rows = []
for s in sorted(df["season"].dropna().unique()):
    sd = df[df["season"] == s]
    over = sd["f5_target"].mean()
    n, profit, roi = roi_sim(over, len(sd))
    edge = (over - KALSHI_IMPLIED) * 100
    season_rows.append((s, n, over, edge, roi))
    print(f"{int(s):>6d}  {n:5d}  {fmt_pct(over)}  {edge:+10.2f}  {roi:+8.2f}")

edges = [r[3] for r in season_rows]
print(f"\nMean edge: {np.mean(edges):+.2f}pp | StdDev: {np.std(edges):.2f}pp")
print(f"Min/Max:  {min(edges):+.2f}pp / {max(edges):+.2f}pp")
neg_yrs = sum(1 for e in edges if e < 0)
print("VERDICT (Season trend): "
      + (f"INCONSISTENT — {neg_yrs}/{len(edges)} seasons negative" if neg_yrs >= 2
         else "CONSISTENT — every year had positive raw edge"))

# ======================================================================
hr("SECTION 9: MARKET EFFICIENCY CHECK")
# ======================================================================
mk = df.dropna(subset=["mkt_movement"])
print(f"Games with line movement data: {len(mk):,}")

sub("By line movement direction")
print(roi_row("mkt_movement >  0.25 (line UP)",     mk[mk["mkt_movement"] >  0.25]))
print(roi_row("mkt_movement -0.25..+0.25 (flat)",   mk[(mk["mkt_movement"] >= -0.25) & (mk["mkt_movement"] <= 0.25)]))
print(roi_row("mkt_movement < -0.25 (line DOWN)",   mk[mk["mkt_movement"] < -0.25]))

sub("By full-line opening level")
fl = df.dropna(subset=["full_line"])
print(roi_row("full_line < 7 (low total)",          fl[fl["full_line"] <  7]))
print(roi_row("full_line 7-8.5 (normal)",           fl[(fl["full_line"] >= 7) & (fl["full_line"] <= 8.5)]))
print(roi_row("full_line 8.5-9.5 (juiced)",         fl[(fl["full_line"] >  8.5) & (fl["full_line"] <= 9.5)]))
print(roi_row("full_line > 9.5 (very juiced)",      fl[fl["full_line"] >  9.5]))

up_over   = mk[mk["mkt_movement"] >  0.25]["f5_target"].mean() if len(mk) else float('nan')
down_over = mk[mk["mkt_movement"] < -0.25]["f5_target"].mean() if len(mk) else float('nan')
hi_total_over = fl[fl["full_line"] > 9.5]["f5_target"].mean() if len(fl) else float('nan')
lo_total_over = fl[fl["full_line"] < 7]["f5_target"].mean() if len(fl) else float('nan')

print(f"\nLine UP over%   = {fmt_pct(up_over)} | DOWN over% = {fmt_pct(down_over)}")
print(f"High total over% = {fmt_pct(hi_total_over)} | Low total over% = {fmt_pct(lo_total_over)}")
spread_total = ((hi_total_over - lo_total_over) * 100) if pd.notna(hi_total_over) and pd.notna(lo_total_over) else 0
print(f"Total-level spread (hi - lo): {spread_total:+.2f}pp")
print("VERDICT (Market): "
      + ("MOSTLY EFFICIENT — line level barely shifts F5 over rate"
         if abs(spread_total) < 6
         else "INEFFICIENT — line level still leaks information"))

# ======================================================================
hr("SECTION 10: TIE MARKET (CSV-only estimate)")
# ======================================================================
print("CSV does not contain f5_runs_home / f5_runs_away — can't compute true ties.")
print("Best we can do: distribution of f5_runs_total parity, which is a loose proxy.")
even = (df["f5_runs_total"] % 2 == 0).mean()
print(f"P(f5_runs_total even) = {even*100:.2f}%  (NOT the tie rate; both teams could split odds)")
print("Skipped: needs DB join with f5_runs_home + f5_runs_away.")
print("VERDICT (Tie market): NEEDS DB QUERY — see /db/mlbie.db for inning-level scores.")

# ======================================================================
hr("FINAL SUMMARY")
# ======================================================================
print(f"Global baseline over rate: {fmt_pct(baseline_over)}  (vs Kalshi implied {fmt_pct(KALSHI_IMPLIED)})")
print(f"Global edge vs market: {(baseline_over - KALSHI_IMPLIED)*100:+.2f}pp")
nb_global, prof_global, roi_global = roi_sim(baseline_over, len(df))
print(f"Naive 'always OVER' across {nb_global:,} bets: profit=${prof_global:+,.2f}  ROI={roi_global:+.2f}%")

if best is not None:
    print(f"\nBest stacked filter: {best['combo']}")
    print(f"  n={int(best['n'])}  over%={best['over_rate']*100:.2f}%  "
          f"edge={best['edge_pp']:+.2f}pp  ROI={best['ROI_pct']:+.2f}%")
print("\nDone.")
