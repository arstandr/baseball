"""
Adversarial analysis of the F5 betting model.
GOAL: Disprove the edge. Find every flaw.
"""
import pandas as pd
import numpy as np
from scipy import stats

CSV = "/Users/adamstandridge/Desktop/projects/baseball/data/f5_feature_matrix_all.csv"

print("=" * 80)
print("ADVERSARIAL F5 MODEL ANALYSIS")
print("=" * 80)

df = pd.read_csv(CSV)
print(f"\nLoaded {len(df):,} rows")
print(f"Seasons: {sorted(df['season'].unique())}")

# ----- Basic sanity on the proxy -----
print("\n--- PROXY SANITY ---")
df = df.dropna(subset=['full_line', 'f5_runs_total', 'actual_runs_total', 'f5_line_open']).copy()
print(f"After dropna: {len(df):,} rows")
implied_ratio = df['f5_line_open'] / df['full_line']
print(f"Implied f5_line_open / full_line ratio in CSV:")
print(f"  mean  = {implied_ratio.mean():.4f}")
print(f"  median= {implied_ratio.median():.4f}")
print(f"  stdev = {implied_ratio.std():.4f}")

# Compute avg_k9 (needed for low_k filter)
df['avg_k9'] = (df['sp_h_k9_weighted'] + df['sp_a_k9_weighted']) / 2.0

# ----- Define the 3-flag stack masks -----
m_open_air  = (df['pk_is_dome'] != 1)
m_low_k     = (df['avg_k9'] < 7.5)
m_high_tot  = (df['full_line'] > 8.5)
stack_mask  = m_open_air & m_low_k & m_high_tot

def over_stats(mask, target_col):
    n = int(mask.sum())
    if n == 0:
        return n, np.nan, np.nan
    overs = int(df.loc[mask, target_col].sum())
    rate  = overs / n
    # Kalshi-style ROI: stake 1 at proxy odds implied by 0.47 ratio?
    # Problem description uses (1/0.47 - 1) as payout multiplier → so odds = (1-p)/p implied
    # Actually: breakeven formula in task: win_rate * (1/0.47 - 1) * 0.98 - (1-win_rate)*1.04 = 0
    # That's payout per $1 stake of (1/0.47 - 1) = 1.1277 ≈ -115 American odds
    # ROI at 4c spread + 2% fee:
    payout = (1/0.47 - 1) * 0.98  # fee on winnings
    loss   = 1.04                  # 4c spread eats $0.04 on loss
    roi    = rate * payout - (1 - rate) * loss
    return n, rate, roi

# ----- Baseline: CSV's own f5_target (proxy = 0.47) -----
print("\n" + "=" * 80)
print("BASELINE: CSV uses f5_line_open = full_line * 0.47")
print("=" * 80)
for label, mask in [
    ("ALL games", pd.Series(True, index=df.index)),
    ("3-flag stack (open_air + low_k + high_total)", stack_mask),
]:
    n, rate, roi = over_stats(mask, 'f5_target')
    print(f"{label:50s} n={n:5d}  over_rate={rate:.4f}  ROI={roi*100:+.2f}%")

# ==============================================================================
# ATTACK 1: PROXY LINE INFLATION
# ==============================================================================
print("\n" + "=" * 80)
print("ATTACK 1: PROXY LINE INFLATION (0.47 vs real market 0.529)")
print("=" * 80)
print("Recomputing f5_target with corrected ratios and comparing to baseline.")

for ratio_label, r in [("0.470 (CSV proxy)", 0.470),
                       ("0.467 (pitcher-friendly low-end)", 0.467),
                       ("0.529 (Kalshi median)", 0.529),
                       ("0.600 (low-total high-end)", 0.600)]:
    line_col = df['full_line'] * r
    target   = (df['f5_runs_total'] > line_col).astype(int)
    # For each game, compute push-adjusted over rate (strict > means pushes count as "not over")
    push     = (df['f5_runs_total'] == line_col).astype(int)
    # all games
    rate_all    = target.mean()
    # 3-flag stack
    n_stack     = int(stack_mask.sum())
    overs_stack = int(target[stack_mask].sum())
    rate_stack  = overs_stack / n_stack if n_stack else np.nan
    push_stack  = int(push[stack_mask].sum())
    # ROI using 0.47 payout assumption (because bettor still prices at 0.47-implied line)
    payout = (1/0.47 - 1) * 0.98
    roi    = rate_stack * payout - (1 - rate_stack) * 1.04
    print(f"ratio={ratio_label:35s}  all_over={rate_all:.4f}  "
          f"stack_n={n_stack}  stack_over={rate_stack:.4f}  pushes={push_stack}  ROI={roi*100:+.2f}%")

# Delta: 0.47 baseline vs 0.529 corrected
r_base = 0.47
r_real = 0.529
t_base = (df['f5_runs_total'] > df['full_line'] * r_base).astype(int)
t_real = (df['f5_runs_total'] > df['full_line'] * r_real).astype(int)
print(f"\nDELTA on 3-flag stack:")
print(f"  over_rate at 0.47  = {t_base[stack_mask].mean():.4f}  ({int(t_base[stack_mask].sum())}/{int(stack_mask.sum())})")
print(f"  over_rate at 0.529 = {t_real[stack_mask].mean():.4f}  ({int(t_real[stack_mask].sum())}/{int(stack_mask.sum())})")
print(f"  DROP in rate  = {(t_base[stack_mask].mean() - t_real[stack_mask].mean())*100:+.2f} pp")

# ROI at correct line, correct pricing (Kalshi pays the real line, not the proxy line)
# If the market prices F5 at 0.529, payout implied is (1/0.529 - 1)
payout_real = (1/0.529 - 1) * 0.98
roi_real = t_real[stack_mask].mean() * payout_real - (1 - t_real[stack_mask].mean()) * 1.04
print(f"  ROI at 0.529 with correct Kalshi payout ({payout_real:.4f} on win, -1.04 on loss): {roi_real*100:+.2f}%")

# High-total bucket specifically: is median ratio really 0.529 there?
print(f"\nFor full_line > 8.5 bucket specifically:")
hi = df[df['full_line'] > 8.5]
print(f"  n = {len(hi):,}")
print(f"  mean full_line = {hi['full_line'].mean():.3f}")
print(f"  if real ratio is 0.529, implied F5 line mean = {hi['full_line'].mean() * 0.529:.3f}")
print(f"  CSV proxy F5 line mean = {hi['full_line'].mean() * 0.47:.3f}")
print(f"  Actual mean f5_runs_total in this bucket = {hi['f5_runs_total'].mean():.3f}")

# ==============================================================================
# ATTACK 2: CIRCULAR FEATURE CONTAMINATION
# ==============================================================================
print("\n" + "=" * 80)
print("ATTACK 2: CIRCULAR FEATURE CONTAMINATION (full_line is in the target)")
print("=" * 80)

corr = df[['full_line', 'f5_runs_total', 'actual_runs_total']].corr()
print("Correlations:")
print(corr.round(4))

# Remove high_total filter
mask_no_hi = m_open_air & m_low_k
n, rate, roi = over_stats(mask_no_hi, 'f5_target')
print(f"\nOpen-air + low_k (no high_total filter): n={n}  over_rate={rate:.4f}  ROI={roi*100:+.2f}%")
# And with corrected 0.529 target
t_real = (df['f5_runs_total'] > df['full_line'] * 0.529).astype(int)
rate_c = t_real[mask_no_hi].mean()
roi_c  = rate_c * payout_real - (1 - rate_c) * 1.04
print(f"  Same mask at 0.529 line: over_rate={rate_c:.4f}  ROI={roi_c*100:+.2f}%")

# Slice: within high_total, does full_line correlate with over_rate?
print("\nWithin 3-flag stack, does full_line bucket matter?")
for lo, hi_v in [(8.5, 9.0), (9.0, 9.5), (9.5, 10.0), (10.0, 12.0)]:
    m = stack_mask & (df['full_line'] >= lo) & (df['full_line'] < hi_v)
    n = int(m.sum())
    if n == 0: continue
    r47 = df.loc[m, 'f5_target'].mean()
    r529 = t_real[m].mean()
    print(f"  full_line [{lo:.1f},{hi_v:.1f}) n={n:4d}  over@0.47={r47:.4f}  over@0.529={r529:.4f}")

# Is the edge explained by "games score more than proxy predicts"?
print("\nFor high_total games: mean f5_runs_total vs proxy F5 line:")
hi_stack = df[stack_mask]
print(f"  mean f5_runs_total = {hi_stack['f5_runs_total'].mean():.3f}")
print(f"  mean proxy  (0.47) = {(hi_stack['full_line']*0.47).mean():.3f}")
print(f"  mean real   (0.529)= {(hi_stack['full_line']*0.529).mean():.3f}")
print(f"  => proxy underpredicts by {hi_stack['f5_runs_total'].mean() - (hi_stack['full_line']*0.47).mean():+.3f} runs")
print(f"  => real underpredicts by  {hi_stack['f5_runs_total'].mean() - (hi_stack['full_line']*0.529).mean():+.3f} runs")

# ==============================================================================
# ATTACK 3: MARKET EFFICIENCY + FRICTION
# ==============================================================================
print("\n" + "=" * 80)
print("ATTACK 3: MARKET EFFICIENCY / FRICTION (4c spread + 2% fee)")
print("=" * 80)

# User's formula: win_rate * (1/0.47 - 1) * 0.98 - (1 - win_rate) * 1.04 = 0
# p * 1.1277 * 0.98 = (1 - p) * 1.04
# p * 1.10514 = 1.04 - 1.04 p
# p * (1.10514 + 1.04) = 1.04
# p = 1.04 / 2.14514 = 0.4848
p_break_047 = 1.04 / ((1/0.47 - 1) * 0.98 + 1.04)
print(f"Break-even @ 0.47 implied payout, 4c spread + 2% fee: {p_break_047*100:.2f}%")

# But REAL Kalshi line is 0.529, so real payout:
p_break_real = 1.04 / ((1/0.529 - 1) * 0.98 + 1.04)
print(f"Break-even @ 0.529 implied payout, 4c spread + 2% fee: {p_break_real*100:.2f}%")
print("  (This is the rate you need vs the TRUE Kalshi line at 4.5 for a 8.5 FG total.)")

# Stat sig test on 58.35% vs breakevens
n_stack = int(stack_mask.sum())
overs_stack_047 = int(df.loc[stack_mask, 'f5_target'].sum())
obs_rate = overs_stack_047 / n_stack
# One-sided binomial test vs break-evens
from scipy.stats import binomtest
bt1 = binomtest(overs_stack_047, n_stack, p=p_break_047, alternative='greater')
bt2 = binomtest(overs_stack_047, n_stack, p=p_break_real, alternative='greater')
# 95% CI
ci_lo, ci_hi = stats.binom.interval(0.95, n_stack, obs_rate)
print(f"\n3-flag stack (CSV proxy): {overs_stack_047}/{n_stack} = {obs_rate:.4f}")
print(f"  One-sided binomial p-value vs {p_break_047*100:.2f}% (proxy-line BE): {bt1.pvalue:.4f}")
print(f"  One-sided binomial p-value vs {p_break_real*100:.2f}% (real-line BE):  {bt2.pvalue:.4f}")

# And the version that matters: if you bet it but Kalshi prices at 0.529, you only win when f5_runs > full_line*0.529
overs_stack_real = int(t_real[stack_mask].sum())
real_rate = overs_stack_real / n_stack
bt3 = binomtest(overs_stack_real, n_stack, p=p_break_real, alternative='greater')
print(f"\n3-flag stack (REAL line 0.529): {overs_stack_real}/{n_stack} = {real_rate:.4f}")
print(f"  One-sided p-value vs real BE {p_break_real*100:.2f}%: {bt3.pvalue:.4f}")
roi_real_stack = real_rate * (1/0.529 - 1) * 0.98 - (1 - real_rate) * 1.04
print(f"  ROI at real line + friction: {roi_real_stack*100:+.2f}%")

# ==============================================================================
# ATTACK 4: DOME FILTER IS DOING ALL THE WORK
# ==============================================================================
print("\n" + "=" * 80)
print("ATTACK 4: DOME FILTER — is the edge just about line-setting asymmetry?")
print("=" * 80)

# All data, split by dome vs open-air
dome = df[df['pk_is_dome'] == 1]
air  = df[df['pk_is_dome'] != 1]
print(f"Dome games: {len(dome):,}")
print(f"Open-air:   {len(air):,}")

def slice_stats(d):
    t047  = (d['f5_runs_total'] > d['full_line'] * 0.47).astype(int).mean()
    t529  = (d['f5_runs_total'] > d['full_line'] * 0.529).astype(int).mean()
    mean_runs = d['f5_runs_total'].mean()
    mean_line = d['full_line'].mean()
    return t047, t529, mean_runs, mean_line

d_r047, d_r529, d_runs, d_line = slice_stats(dome)
a_r047, a_r529, a_runs, a_line = slice_stats(air)
print(f"\n                        over@0.47  over@0.529  mean_f5_runs  mean_full_line")
print(f"  Dome (all):             {d_r047:.4f}      {d_r529:.4f}        {d_runs:.3f}         {d_line:.3f}")
print(f"  Open-air (all):         {a_r047:.4f}      {a_r529:.4f}        {a_runs:.3f}         {a_line:.3f}")

# Now apply low_k + high_total to each side
for name, d in [("Dome", dome), ("Open-air", air)]:
    m = (d['avg_k9' if 'avg_k9' in d.columns else 'sp_h_k9_weighted'] < 7.5) if 'avg_k9' in d.columns else None
    # recompute avg_k9 for the slice
    ak = (d['sp_h_k9_weighted'] + d['sp_a_k9_weighted']) / 2.0
    m = (ak < 7.5) & (d['full_line'] > 8.5)
    t047 = (d.loc[m, 'f5_runs_total'] > d.loc[m, 'full_line'] * 0.47).astype(int)
    t529 = (d.loc[m, 'f5_runs_total'] > d.loc[m, 'full_line'] * 0.529).astype(int)
    n = int(m.sum())
    if n:
        print(f"  {name} + low_k + high_total  n={n:4d}  over@0.47={t047.mean():.4f}  over@0.529={t529.mean():.4f}")

# Hypothesis: market sets dome lines higher because dome runs are more predictable
# Check: within same full_line bucket, is f5_runs_total different?
print("\nLine-controlled comparison (same full_line bucket, dome vs open-air):")
for lo, hi_v in [(7.5, 8.5), (8.5, 9.5), (9.5, 12.0)]:
    d = dome[(dome['full_line'] >= lo) & (dome['full_line'] < hi_v)]
    a = air[(air['full_line']  >= lo) & (air['full_line']  < hi_v)]
    print(f"  full_line [{lo:.1f},{hi_v:.1f}) "
          f"dome n={len(d):4d} mean_f5_runs={d['f5_runs_total'].mean():.3f} "
          f"| air n={len(a):4d} mean_f5_runs={a['f5_runs_total'].mean():.3f} "
          f"| diff={a['f5_runs_total'].mean()-d['f5_runs_total'].mean():+.3f}")

# ==============================================================================
# BONUS: split by season to test regime consistency
# ==============================================================================
print("\n" + "=" * 80)
print("BONUS: Season-by-season (3-flag stack using CSV proxy and real line)")
print("=" * 80)
t_real_all = (df['f5_runs_total'] > df['full_line'] * 0.529).astype(int)
for s in sorted(df['season'].unique()):
    m = stack_mask & (df['season'] == s)
    n = int(m.sum())
    if n == 0: continue
    r047 = df.loc[m, 'f5_target'].mean()
    r529 = t_real_all[m].mean()
    roi_real_s = r529 * (1/0.529 - 1) * 0.98 - (1 - r529) * 1.04
    print(f"  {s}: n={n:3d}  over@0.47={r047:.4f}  over@0.529={r529:.4f}  ROI_real={roi_real_s*100:+.2f}%")

print("\n" + "=" * 80)
print("DONE")
print("=" * 80)
