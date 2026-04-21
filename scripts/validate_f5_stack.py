"""
Rigorous validation of 3-flag F5 stack.
Brutal honesty. No cheerleading.
"""
import pandas as pd
import numpy as np
from scipy import stats
import sys

CSV = "/Users/adamstandridge/Desktop/projects/baseball/data/f5_feature_matrix_all.csv"

def wilson_ci(k, n, alpha=0.05):
    """Wilson score interval for a binomial proportion."""
    if n == 0:
        return (float('nan'), float('nan'))
    z = stats.norm.ppf(1 - alpha/2)
    p = k / n
    denom = 1 + z**2 / n
    center = (p + z**2 / (2*n)) / denom
    half = (z * np.sqrt(p*(1-p)/n + z**2/(4*n**2))) / denom
    return (center - half, center + half)

def flag_mask(df, open_air=True, low_k=True, high_total=True):
    m = pd.Series(True, index=df.index)
    if open_air:
        m &= (df['pk_is_dome'] != 1)
    if low_k:
        k9 = (df['sp_h_k9_weighted'] + df['sp_a_k9_weighted']) / 2.0
        m &= (k9 < 7.5)
    if high_total:
        m &= (df['full_line'] > 8.5)
    return m

def stack_mask(df, open_air, low_k, high_total):
    """Return mask applying the specified flags (True = apply the filter)."""
    m = pd.Series(True, index=df.index)
    if open_air:
        m &= (df['pk_is_dome'] != 1)
    if low_k:
        k9 = (df['sp_h_k9_weighted'] + df['sp_a_k9_weighted']) / 2.0
        m &= (k9 < 7.5)
    if high_total:
        m &= (df['full_line'] > 8.5)
    return m

def exclude_dome_mask(df):
    return df['pk_is_dome'] != 1

def report_block(name, sub):
    n = len(sub)
    if n == 0:
        print(f"  {name}: n=0")
        return None
    wins = int(sub['f5_target'].sum())
    rate = wins / n
    lo, hi = wilson_ci(wins, n)
    print(f"  {name}: n={n}, overs={wins}, over_rate={rate:.4f}, 95% CI=[{lo:.4f}, {hi:.4f}]")
    return {'n': n, 'wins': wins, 'rate': rate, 'ci_lo': lo, 'ci_hi': hi}

def per_season_table(df_sub, label):
    print(f"  Per-season breakdown for {label}:")
    rows = []
    rates = []
    for season, g in df_sub.groupby('season'):
        n = len(g)
        wins = int(g['f5_target'].sum())
        rate = wins / n if n else float('nan')
        lo, hi = wilson_ci(wins, n)
        rows.append((season, n, wins, rate, lo, hi))
        if n >= 10:
            rates.append(rate)
        print(f"    {season}: n={n}, overs={wins}, rate={rate:.4f}, CI=[{lo:.4f}, {hi:.4f}]")
    std = float(np.std(rates, ddof=0)) if len(rates) >= 2 else float('nan')
    print(f"    season-level std dev (n>=10): {std:.4f}")
    return rows, std

def main():
    print("=" * 80)
    print("F5 3-FLAG STACK — RIGOROUS VALIDATION")
    print("=" * 80)

    df = pd.read_csv(CSV)
    print(f"Total rows loaded: {len(df)}")
    print(f"Columns present: {len(df.columns)}")

    # Drop rows missing essential fields.
    needed = ['f5_target', 'f5_runs_total', 'f5_line_open', 'full_line',
              'pk_is_dome', 'sp_h_k9_weighted', 'sp_a_k9_weighted', 'season']
    missing = [c for c in needed if c not in df.columns]
    if missing:
        print(f"!!! MISSING COLUMNS: {missing}")
        sys.exit(1)

    before = len(df)
    df = df.dropna(subset=needed).copy()
    print(f"After dropna on essentials: {len(df)} (dropped {before - len(df)})")
    df['season'] = df['season'].astype(int)
    if 'date' in df.columns:
        df['date'] = pd.to_datetime(df['date'], errors='coerce')

    # ---------- Q1 ----------
    print("\n" + "=" * 80)
    print("Q1: 3-FLAG STACK SAMPLE SIZE & CONSISTENCY")
    print("=" * 80)
    mask3 = stack_mask(df, True, True, True)
    d3 = df[mask3].copy()
    n3 = len(d3)
    wins3 = int(d3['f5_target'].sum())
    rate3 = wins3 / n3 if n3 else float('nan')
    lo3, hi3 = wilson_ci(wins3, n3)
    print(f"Total 3-flag n (all 5 seasons): {n3}")
    print(f"Overs: {wins3}")
    print(f"Overall over rate: {rate3:.4f}")
    print(f"95% Wilson CI: [{lo3:.4f}, {hi3:.4f}]")

    _, std3 = per_season_table(d3, "3-flag stack")

    flags_q1 = []
    if n3 < 200:
        flags_q1.append("NOISE — insufficient sample (n<200)")
    if not np.isnan(std3) and std3 > 0.08:
        flags_q1.append("INCONSISTENT — time-bomb risk (season std >0.08)")
    print(f"Q1 flags: {flags_q1 if flags_q1 else 'none'}")

    # ---------- Q2 ----------
    print("\n" + "=" * 80)
    print("Q2: 2-FLAG SUBSTACKS")
    print("=" * 80)
    subsets = [
        ("open_air + low_k  (no high_total)", stack_mask(df, True, True, False)),
        ("open_air + high_total (no low_k)", stack_mask(df, True, False, True)),
        ("low_k + high_total (domes included)", stack_mask(df, False, True, True)),
    ]
    sub_results = {}
    for name, m in subsets:
        print(f"\n[{name}]")
        sub = df[m]
        r = report_block("all-seasons", sub)
        _, sd = per_season_table(sub, name)
        sub_results[name] = {'overall': r, 'season_std': sd}

    # Verdict: are all subsets positive over 50%? (Positive means over_rate > 0.50,
    # which, at 1/0.47 payoff, breaks even at 47%, so >0.50 = clearly positive.)
    verdict_parts = []
    all_pos = True
    for name, res in sub_results.items():
        r = res['overall']
        if r is None:
            all_pos = False
            verdict_parts.append(f"{name}: EMPTY")
        else:
            pos = r['rate'] > 0.50
            be  = r['rate'] > 0.47
            verdict_parts.append(f"{name}: rate={r['rate']:.4f} (>0.50? {pos}) (breakeven>0.47? {be})")
            if not be:
                all_pos = False
    print("\nQ2 VERDICT:")
    for v in verdict_parts:
        print(f"  {v}")
    print(f"  All subsets above breakeven (0.47)? {all_pos}")
    if all_pos:
        print("  -> 3-flag stack is NOT obviously an overfit artifact; underlying flags carry signal.")
    else:
        print("  -> 3-flag stack appears to amplify weak/inconsistent subsets: OVERFIT RISK.")

    # ---------- Q3 ----------
    print("\n" + "=" * 80)
    print("Q3: OUT-OF-SAMPLE HOLDOUT (train 2021-2023, test 2024)")
    print("=" * 80)
    train = df[df['season'].isin([2021, 2022, 2023])]
    hold  = df[df['season'] == 2024]
    print(f"Train rows: {len(train)}   Holdout (2024) rows: {len(hold)}")

    # "Train" here means measure rates on the train set to verify the filter is positive,
    # then apply it verbatim to holdout (the filter rule itself is fixed).
    tr_mask = stack_mask(train, True, True, True)
    tr_sub = train[tr_mask]
    n_tr = len(tr_sub); w_tr = int(tr_sub['f5_target'].sum())
    rate_tr = w_tr / n_tr if n_tr else float('nan')
    lo_tr, hi_tr = wilson_ci(w_tr, n_tr)
    print(f"Train (2021-2023) 3-flag: n={n_tr}, overs={w_tr}, rate={rate_tr:.4f}, CI=[{lo_tr:.4f},{hi_tr:.4f}]")

    hd_mask = stack_mask(hold, True, True, True)
    hd_sub = hold[hd_mask]
    n_hd = len(hd_sub); w_hd = int(hd_sub['f5_target'].sum())
    rate_hd = w_hd / n_hd if n_hd else float('nan')
    lo_hd, hi_hd = wilson_ci(w_hd, n_hd)
    print(f"Holdout (2024) 3-flag:    n={n_hd}, overs={w_hd}, rate={rate_hd:.4f}, CI=[{lo_hd:.4f},{hi_hd:.4f}]")

    if np.isnan(rate_tr) or np.isnan(rate_hd):
        q3_verdict = "INSUFFICIENT DATA"
    elif rate_hd < 0.47:
        q3_verdict = "FAILED — holdout below breakeven. Strategy does NOT generalize."
    elif rate_hd < rate_tr - 0.05:
        q3_verdict = "SHRINKAGE — holdout >5 pp below train. Regression to mean likely."
    elif rate_hd >= 0.50:
        q3_verdict = "HELD UP — holdout >50%, signal survives."
    else:
        q3_verdict = "MARGINAL — holdout positive but thin."
    print(f"Q3 VERDICT: {q3_verdict}")

    # ---------- Q4 ----------
    print("\n" + "=" * 80)
    print("Q4: FEE-ADJUSTED ROI")
    print("=" * 80)
    # Payout mechanics:
    #   Proxy line = full_line * 0.47 and f5_line_open is set that way,
    #   so the implied "price" of the Over contract is 0.47 (pays $1 total,
    #   net win = (1/0.47 - 1) = 1.128 per $1 staked).
    # Gross:
    p = rate3
    if np.isnan(p):
        print("  Cannot compute — no 3-flag sample.")
    else:
        gross_win = (1/0.47 - 1)               # ≈ 1.12766
        gross_loss = -1.0
        gross_roi = p * gross_win + (1 - p) * gross_loss
        # Net with fees:
        net_win = (1/0.47 - 1) * (1 - 0.02)    # 2% taker on winnings
        net_loss = -1.0 - 0.025                # 2.5¢ spread on loss too (round-trip friction)
        net_roi = p * net_win + (1 - p) * net_loss

        # Breakeven probability under net payout:
        # p* such that p*net_win + (1-p*)net_loss = 0
        p_star = (-net_loss) / (net_win - net_loss)
        print(f"  Over rate used: {p:.4f}")
        print(f"  Gross win per $1: {gross_win:.5f}")
        print(f"  Net   win per $1: {net_win:.5f}  (after 2% taker)")
        print(f"  Gross loss: {gross_loss}")
        print(f"  Net   loss: {net_loss}   (after 2.5¢ spread)")
        print(f"  GROSS ROI: {gross_roi*100:.2f}%")
        print(f"  NET   ROI: {net_roi*100:.2f}%")
        print(f"  Fee-inclusive breakeven over rate: {p_star:.4f}")
        if net_roi > 0:
            print(f"  -> Net ROI still POSITIVE after fees.")
        else:
            print(f"  -> Net ROI NEGATIVE after fees. Dead strategy at these frictions.")

    # ---------- Q5 ----------
    print("\n" + "=" * 80)
    print("Q5: OPPORTUNITY FREQUENCY")
    print("=" * 80)
    if 'date' not in df.columns:
        print("  No date column — skipping.")
    else:
        total_games = len(df)
        total_days = df['date'].dt.date.nunique()
        q_games = len(d3)
        q_days = d3['date'].dt.date.nunique() if q_games else 0
        pct_games = (q_games / total_games) * 100 if total_games else 0
        avg_per_day = q_games / q_days if q_days else 0
        avg_per_all_days = q_games / total_days if total_days else 0
        print(f"  Total games in dataset: {total_games}")
        print(f"  Total unique game-days: {total_days}")
        print(f"  Qualifying 3-flag games: {q_games}")
        print(f"  Unique game-days with >=1 qualifier: {q_days}")
        print(f"  % of all games that qualify: {pct_games:.2f}%")
        print(f"  Avg qualifying games per qualifying day: {avg_per_day:.2f}")
        print(f"  Avg qualifying games per ALL days in season(s): {avg_per_all_days:.2f}")
        # Daily vs weekly context:
        if avg_per_all_days >= 1.0:
            print("  -> Daily-operation frequency (>=1 qualifier/day on average).")
        elif avg_per_all_days >= 0.3:
            print("  -> Near-daily: roughly 1 qualifier every 3 days.")
        else:
            print("  -> Weekly-scale signal: sparse opportunities.")

    # ---------- Q6 ----------
    print("\n" + "=" * 80)
    print("Q6: SEASON-STABILITY TABLE (n, over_rate, gross ROI, net ROI)")
    print("=" * 80)
    season_rows = []
    for season, g in d3.groupby('season'):
        n = len(g); wins = int(g['f5_target'].sum())
        if n == 0: continue
        ps = wins / n
        gross_roi_s = ps * (1/0.47 - 1) + (1 - ps) * (-1.0)
        net_roi_s = ps * ((1/0.47 - 1) * (1 - 0.02)) + (1 - ps) * (-1.025)
        season_rows.append((season, n, wins, ps, gross_roi_s, net_roi_s))
        print(f"  {season}: n={n:3d} overs={wins:3d} rate={ps:.4f}  gross ROI={gross_roi_s*100:+.2f}%  net ROI={net_roi_s*100:+.2f}%")
    any_losing = any(r[5] < -0.05 for r in season_rows)
    if any_losing:
        print("  FLAG: at least one season has net ROI < -5%. Losing-season risk is real.")
    else:
        print("  No season has net ROI < -5%.")

    # ---------- Q7 ----------
    print("\n" + "=" * 80)
    print("Q7: EDGE BREAKDOWN BY full_line BUCKET (within 3-flag stack)")
    print("=" * 80)
    # Re-apply only open_air + low_k, then bucket by full_line, so the high_total flag
    # isn't doing the slicing implicitly.
    base_mask = stack_mask(df, True, True, False)  # open_air + low_k, any total
    base = df[base_mask].copy()
    buckets = [('<7.5', base['full_line'] < 7.5),
               ('7.5-8.5', (base['full_line'] >= 7.5) & (base['full_line'] <= 8.5)),
               ('8.5-9.5', (base['full_line'] > 8.5) & (base['full_line'] <= 9.5)),
               ('>9.5', base['full_line'] > 9.5)]
    for label, bm in buckets:
        sub = base[bm]
        n = len(sub); wins = int(sub['f5_target'].sum())
        if n == 0:
            print(f"  full_line {label}: n=0")
            continue
        p = wins / n
        lo, hi = wilson_ci(wins, n)
        gross_roi_b = p * (1/0.47 - 1) + (1 - p) * (-1.0)
        net_roi_b = p * ((1/0.47 - 1) * (1 - 0.02)) + (1 - p) * (-1.025)
        print(f"  full_line {label}: n={n:4d}  over_rate={p:.4f}  CI=[{lo:.4f},{hi:.4f}]  grossROI={gross_roi_b*100:+.2f}%  netROI={net_roi_b*100:+.2f}%")

    # Also: proxy bias check. Is there a systematic relationship between full_line
    # and the ratio f5_runs_total / full_line within the 3-flag stack?
    if n3 > 50:
        ratio = d3['f5_runs_total'] / d3['full_line']
        corr, pval = stats.pearsonr(d3['full_line'], ratio)
        print(f"\n  Within 3-flag stack: corr(full_line, F5_runs/full_line) = {corr:.4f} (p={pval:.4f})")
        print(f"  If strongly positive -> proxy line 0.47 *understates* the true F5 line for high totals,")
        print(f"  meaning the backtest Over wins are inflated versus real markets.")

    # ---------- FINAL VERDICT ----------
    print("\n" + "=" * 80)
    print("FINAL VERDICT")
    print("=" * 80)
    verdicts = {}
    verdicts['sample_ok'] = n3 >= 300
    verdicts['consistent'] = (not np.isnan(std3)) and std3 < 0.07
    verdicts['oos'] = (not np.isnan(rate_hd)) and rate_hd >= 0.47
    # Net ROI sign:
    if not np.isnan(rate3):
        net_roi_all = rate3 * ((1/0.47 - 1) * (1 - 0.02)) + (1 - rate3) * (-1.025)
    else:
        net_roi_all = float('nan')
    verdicts['fees_ok'] = (not np.isnan(net_roi_all)) and net_roi_all > 0

    print(f"  Sample size ok (n>=300)?            {verdicts['sample_ok']}  (n={n3})")
    print(f"  Season-consistent (std<0.07)?       {verdicts['consistent']}  (std={std3:.4f})" if not np.isnan(std3) else f"  Season-consistent: n/a")
    print(f"  Survives out-of-sample (2024)?      {verdicts['oos']}  (2024 rate={rate_hd:.4f})" if not np.isnan(rate_hd) else f"  OOS: insufficient")
    print(f"  Survives fees (net ROI > 0)?        {verdicts['fees_ok']}  (net ROI={net_roi_all*100:+.2f}%)")
    print(f"  Realistic expected net ROI per bet: {net_roi_all*100:+.2f}%")

    passes = sum(1 for v in verdicts.values() if v)
    print(f"\n  Checks passed: {passes}/4")
    if passes == 4:
        rec = "GO — all four guardrails pass. Bet small until live sample confirms."
    elif passes == 3 and verdicts['fees_ok'] and verdicts['oos']:
        rec = "MARGINAL GO — core signals pass but one guardrail is weak. Half-size stakes."
    elif passes >= 2 and verdicts['oos']:
        rec = "NEEDS MORE DATA — OOS holds but size/consistency not there yet."
    else:
        rec = "NO GO — fails core checks (likely fees or OOS)."
    print(f"  RECOMMENDATION: {rec}")

if __name__ == "__main__":
    main()
