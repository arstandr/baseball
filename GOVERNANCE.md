# MLBIE — MLB Strikeout Edge Model Governance

**Last updated: 2026-05-15 (evening) — FINAL VARIANT DECISION: `FADE_VARIANT=v1h` set on Railway, backed by the corrected 19-day ladder replay (M+K+L fixes). The strategy is being run as paper-only primary test going forward; if it stabilizes positive over a 28-day window the question of going live re-opens. Permanent backtest tool committed at `scripts/replayFadeMultiVariant.mjs`; weekly Sunday 6am ET cron auto-replays the rolling 28-day window and posts to Discord. Validation invariant ratified: NO variant change without ≥14 days of ladder-replay evidence showing ≥+$800 P&L advantage. See "Step G v2 — FADE-CORRECT REPLAY" subsection.**

**Last updated: 2026-05-15 (morning) — FADE_VARIANT flipped back to v1h on Railway after 3 days of v3 paper losses (Tue −$310, Wed −$724, Thu −$584 = −$1,618 / −31% drawdown on $5,198 starting paper bankroll). Diagnostic confirmed v3 implementation matches its spec — the strategy itself is failing, not the code. Root cause is structural: the fade model fires on a single feature (k9_l5 × innings) while ignoring the entire Statcast / park / weather / umpire / velo signal stack that the codebase already collects. K≥10 tail bucket is the disaster zone (0W/15L Wed+Thu combined, CI rejects 22% model claim). See "2026-05-15 v3 Post-Mortem & Save Plan" section below.**

**Last updated: 2026-05-12 — fade model v3 promotion REVERTED to v1+H-I after the true out-of-sample test (every v3 filter except H-I destroyed EV vs v1; May 7-10 +59% lift was overfit). Added per-strike / per-ask P&L buckets to the daily fade report. Bankroll now compounds day-to-day (initBankrollState rollover). Fixed postGameAttribution `mode`-column crash and the scheduler postponement-cancel column-name bug. Base bankroll reset to $5,000 + prior-day P&L.**

---

## 2026-05-15 v3 Post-Mortem & Save Plan

### The 3-day damage

| Date | n | W-L | Win% | P&L | Note |
|---|---|---|---|---|---|
| Tue 5/12 | 21 | 8-13 | 38% | **−$310.28** | v3 active despite OOS kill from same morning |
| Wed 5/13 | 43 | 19-24 | 44% | **−$724.17** | K≥10 0W/8L = −$534.49 |
| Thu 5/14 | 13 | 3-10 | 23% | **−$584.04** | K≥10 0W/7L = −$495.01 |
| **Total** | **77** | **30-47** | **39%** | **−$1,618.49** | **−31% drawdown on $5,198 paper bankroll** |

Thursday by strike bucket:
- K=6: 3W/3L, −$85.04 (basically breakeven)
- K=10: 0W/6L, **−$495.01**
- K=11: 0W/1L, −$3.99

Wed+Thu combined K≥10: 0W/15L. 95% CI for true hit rate = [0%, 22%]. Model claimed 22%. CI now tight enough to **reject the model's claim — the K≥10 model is systematically biased high.**

### Diagnostic — what we did wrong

**(1) Code is correct, policy was wrong.** Read `scripts/fireFadeModel.mjs` line-by-line vs commit `e28ce861` v3 spec. Implementation matches exactly: v3 = v1 + H-H (avg_innings_l5 ≥ 5) + skip K=7-9 + per-pitcher cap 2. v3 IS doing what v3 was designed to do. The bug is that we re-enabled v3 (commit `cb1477e4`, May 12 9:29am) the same morning the OOS test (commit `e28ce861`, 8:54am) said v3 lost −$68k vs v1 on 858 records. Rationale at the time: "K=7-9 was bleeding in May 7-11 paper, v3 skips that, no-cost to gather more v3 data." This was 5 days of post-hoc regime chasing — exactly what the OOS test was designed to filter out.

**(2) The model fires on 1 feature out of 10+ available.** `computeLambda` in `fireFadeModel.mjs`:
```javascript
function computeLambda(priorStarts, window = 5) {
  const k9 = totalK / totalIp * 9
  const avgIp = totalIp / recent.length
  return { lambda: k9 * avgIp / 9, k9, avgIp, n: recent.length }
}
```
That's the entire model input. Nothing about opponent, park, weather, umpire, velo, whiff%, FBV. The negative-binomial dispersion is a hard-coded constant `NB_DISPERSION = 8`.

**(3) Massive signal stack is collected and ignored.**

| Signal | Where collected | Used by fade? |
|---|---|---|
| Statcast K% (`savant_k_pct`) | `lib/pkModel.js` + `lib/savant.js` | **NO** |
| Whiff% (`savant_whiff`) | `lib/pkModel.js` | **NO** |
| Fastball velo (`savant_fbv`) | `lib/pkModel.js` | **NO** |
| Opponent K% (`opp_k_pct`) | `lib/pkModel.js` | **NO** |
| Park factor (`park_factor`) | `lib/parkFactors.js` | **NO** |
| Weather mult (`weather_mult`) | weather agent | **NO** |
| Umpire factor (`ump_factor`) | umpire agent | **NO** |
| Velocity trend (`velo_adj`, `velo_trend_mph`) | scouting agent | **NO** |
| 99-feature ridge regression (`lib/pkModel.js`) | exists, weights file exists | **only in tests** |
| Calibration multipliers (`calibrationEngine.js`) | **358 resolved samples, 4 buckets produced via cron** | **NOT applied at fire time** |

`grep -rn "pkModel" lib/ scripts/` confirms `lib/pkModel.js` is imported **only by `scripts/test/realWorldTests.js`**. The production fade pipeline doesn't call it. `grep -n "calibrat" scripts/fireFadeModel.mjs` returns zero results — calibration runs successfully on cron but the firing code never reads the produced buckets.

The bet INSERT in `fireFadeModel.mjs` (line 458) also doesn't write Statcast/park/weather/ump columns to `ks_bets`, which is why Thursday's 13 rows are 100% NULL on those fields. Coverage trend over the last 3 weeks shows enrichment is also degrading on the few paths that do populate it.

### Action plan (priority order)

| # | Fix | Status | Effort | Expected impact |
|---|---|---|---|---|
| **A** | **Set `FADE_VARIANT=v1h`** on Railway worker | ✅ **DONE 2026-05-15** (verified via `railway variables`) | 30s | Eliminates the −$495/day K≥10 bleed immediately. v1h fires single best-edge strike per pitcher, doesn't force a tail fire. |
| **B** | **Wire `pkModel.predictPk()` into `fireFadeModel.mjs`** — replace `computeLambda` 1-feature output with a pkModel call that uses Statcast K%, whiff, FBV, opp K%, park, weather. Existing model + weights file already exist; just not wired. | PENDING | 1-2 hours | Probability estimates use 10× more signal. Tail predictions should compress toward realized rates. |
| **C** | **Apply calibration at fire time.** Before computing `edge = model_prob − ask`, look up the bucket multiplier from `calibration_params` and adjust `model_prob`. Engine already produces walk-forward-validated multipliers (358 resolved samples, 4 promoted buckets); we just don't consume them. | PENDING | 1-2 hours | Probabilities get self-correcting on actual market outcomes. Especially helpful for the K≥10 tail where the engine has been watching the misses. |
| **D** | **Populate enrichment columns on `ks_bets` INSERT** (savant_k_pct, savant_whiff, park_factor, weather_mult, ump_factor, velo_adj) so post-hoc bucket analysis works. | PENDING | 30 min | Operational only — but without this, future audits stay blind. |
| **E** | **Backtest the week with each variant.** Replay `fade_fire_snapshots` for May 12-14 under v3 (baseline), v1h, v1h + pkModel, v1h + pkModel + calibration. Decide whether B+C go to prod based on backtest delta. | PENDING (next session) | 2-3 hours | Decision gate — only ship B+C if replay shows clear improvement on this week's actual snapshots. |

### Validation invariants

Before any of B/C/D ship to prod:
1. **Replay must beat v3 on Tue+Wed+Thu** by at least +$800 (50% of the −$1,618 lost) on the same `fade_fire_snapshots` ladder.
2. **K≥10 bucket must show ≥1 win or be skipped entirely** in the replay set — current 0/15 is the kill criterion.
3. **No "we'll see if it works in paper"** override of failed replay — that's the policy mistake that caused the −$1,618.

### Files referenced
- Diagnostic queries: `/tmp/turso_signals2.json` (signal-coverage by day), `/tmp/turso_q2.json` (Thursday bet detail), `/tmp/turso_q3.json` (per-bet replay)
- Code paths: `scripts/fireFadeModel.mjs` (fire logic + INSERT statement), `lib/pkModel.js` (unused ridge regression), `lib/calibrationEngine.js` (unused multiplier source)
- Snapshot table: `fade_fire_snapshots` (every strike's ladder at fire time — replay fuel)
- Killed-then-revived commit chain: `e28ce861` (revert to v1h) → `cb1477e4` (re-set v3 in prod)

### Step E — Replay backtest result (2026-05-15)

Replayed 465 fade_fire_snapshots rows × 61 pitcher-days across May 12-14 under 3 variants. Outcomes from `ks_bets.actual_ks` (44 settled pitcher-days). $100 stake per fire.

| Variant | Fires | W-L | Win% | P&L | K=6 W-L | K≥10 W-L |
|---|---|---|---|---|---|---|
| **v3 (baseline)** | 14 | 3-11 | 21.4% | **−$716.58** | 3-3 | 0-8 |
| **v1h** | 18 | 2-15 | 11.8% | **−$1,181.73** | 2-12 | 0-3 |
| **v1h + pkLight** | 17 | 0-11 | 0.0% | **−$1,100.00** | 0-10 | 0-1 |

**All three variants lose money on this week's data.** None pass the validation invariants:
- Invariant 1 (beat v3 by ≥+$800): v1h Δ=**−$465 ⚠**, pkLight Δ=**−$383 ⚠**. Both **fail**.
- Invariant 2 (K≥10 ≥1 win or skip-entirely): v1h 0-3, pkLight 0-1. Both **fail**.

(`calibration_params` table has 0 rows despite `calibration_runs` reporting "promoted" buckets — separate plumbing bug. Variant 4 "v1h+pkModel+calibration" therefore collapses to v1h+pkLight and was not separately scored.)

**Critical re-read of the diagnostic.** The original hypothesis was "K≥10 tail is the bleed; fix it and the strategy survives." The replay rejects this. v1h reduces K≥10 fires from 8→3 but **also picks DIFFERENT K=6 bets that lose worse than v3's K=6 bets** (2-12 vs 3-3). The K=6 bucket itself is wrong this week, not just the tail. Switching variants doesn't fix a model that's broken on its primary strike too.

**Replay vs reality discrepancy.** The actual ks_bets P&L for May 12-14 was −$1,618 (77 bets), while v3 replay shows −$716 (14 fires) over the same window. Difference is due to (a) actual_ks coverage only spans 44 of 61 pitcher-days, (b) actual sizing varied while replay uses flat $100, (c) some pitchers had bets that fired outside the fade_fire_snapshots ladder. Direction is consistent (v3 loses); absolute magnitude differs.

### Step E → Decision

**B (wire pkModel) and C (wire calibration) are NOT shipped to prod.** Per the validation invariants I baked into this section, the gate did not clear. Shipping anyway would repeat the May 12 mistake of overriding a failed test with "we'll see in paper."

Three deeper conclusions:

1. **One week is not the full picture.** 3-day replay = ~14-18 fires per variant, way under any statistical bar. We need to extend the replay to all of May (or April + May) to get a defensible read on which variant is actually best. Step E should be re-run on a 4-week window before any prod change.

2. **The model is broken on K=6 too, not just K≥10.** The "save the strategy by fixing the tail" thesis is partially wrong. The 3-day v3 K=6 line (3-3) looks fine, but v1h's K=6 (2-12) suggests K=6 fires v3 didn't make are also losers. The fade model has structural issues across the strike range, not isolated to the tail.

3. **A is still the right move regardless.** FADE_VARIANT=v1h prevents the forced K≥10 fires. Even if v1h has its own problems, those problems can be capped at one bet per pitcher, while v3's per-pitcher cap of 2 with forced tail compounds losses by ~2×. The flip is defensive damage control, not a save — the actual save needs a longer replay window + the pkModel/calibration plumbing properly wired and tested on month-scale data.

### Step E → Updated action plan

| # | Fix | Status | Note |
|---|---|---|---|
| A | `FADE_VARIANT=v1h` | ✅ DONE | Stops the forced K≥10 tail. Still bleeds on K=6, but caps damage. |
| B | Wire pkModel into fireFadeModel | **HOLD** | Replay failed validation gate. Re-run on 4-week window before re-considering. |
| C | Wire calibration at fire | **BLOCKED** | `calibration_params` is empty — calibrationEngine has a write-path bug to fix first. |
| D | Populate enrichment columns on INSERT | **STILL VALUABLE** | Unblocks future post-hoc audits. 30 min. Do regardless. |
| **E2** | **Re-run replay on April + May window** (~4 weeks, hundreds of fires) | **NEW** | Statistical bar before any model change. Should write `scripts/replayFadeMultiVariant.mjs` as a permanent backtest tool. |
| **F** | **Pause fade firing entirely until E2 completes** | **DECISION POINT** | v1h still losing this week (−$1,182 in replay). May not be worth running even v1h until the model is fundamentally upgraded. Bankroll already −31% drawdown; one more bad week and the paper experiment becomes unrepresentative of any future-real-bankroll behavior. |

### Files referenced (Step E)
- `/tmp/replay_week.py` — the 3-variant replay tool (reusable; param the date window for E2)
- `/tmp/replay_week_results.json` — raw fire-by-fire output from this run
- `/tmp/replay_week_run.log` — formatted summary

### Step E2 — 4-week replay (2026-05-15, same day)

Extended the replay to the full pregame_fade_yes bet history. `fade_fire_snapshots` only goes back to May 12 (added that day per commit `a5ca026e`), so for the longer window we replay using actual ks_bets rows + their `actual_ks` outcomes, applying each variant's filters to determine which bets would have fired. The fade strategy only started firing May 7, so "4-week" is really 8 days (May 7-14).

**Universe:** 106 settled `pregame_fade_yes` bets, May 7-14. Actual recorded P&L = **−$895.74** (18W-88L, 17%).

| Variant | Fires | W-L | Win% | Synth P&L | K=6 W-L | K=7-9 | K≥10 W-L |
|---|---|---|---|---|---|---|---|
| **v3** | 61 | 16-45 | 26.2% | **+$1,113.36** ✓ POSITIVE | 14-16 | 0-0 (skipped) | 2-29 |
| v1h | 90 | 17-73 | 18.9% | −$666.08 | 13-18 | 2-29 | 2-26 |
| pkLight | 24 | 2-22 | 8.3% | −$1,733.33 | 2-5 | 0-9 | 0-8 |

Validation invariants on the 8-day window:
- **Beat v3 by ≥+$800: BOTH FAIL.** v1h is **−$1,779 worse** than v3. pkLight is **−$2,847 worse**. v3 IS the best variant on this window.
- K≥10 ≥1 win or skip entirely: v3 2-29 PASSES (2 wins exist), v1h 2-26 PASSES, pkLight 0-8 FAILS.

**Week-by-week breakdown — the regime story:**

| Week | v3 fires | v3 W-L | v3 P&L | v1h fires | v1h W-L | v1h P&L |
|---|---|---|---|---|---|---|
| Wk-19 (May 7-11) | 15 | 5-10 | **+$2,777** | 50 | 7-43 | +$610 |
| Wk-20 (May 12-14) | 46 | 11-35 | **−$1,664** | 40 | 10-30 | −$1,276 |
| **Total** | **61** | **16-45** | **+$1,113** | **90** | **17-73** | **−$666** |

**v3 had an outstanding Wk-19 (+$2,777, including K≥10 tail hits worth ~$700 each on 5-7c asks) then collapsed in Wk-20.** v1h was up small in Wk-19, down big in Wk-20. The pattern is identical-shape but v3 has higher amplitude in both directions.

The OOS test on May 12 already warned this exact thing — *"May 7-10 +59% lift was overfit."* Wk-19 is precisely that overfit window. So one defensible reading is **v3 is going to keep losing** and Wk-19 was the regression-from-the-mean we should have ignored. Another defensible reading is **the strategy IS positive EV but mid-May randomly handed us a bad 3-day cluster.** Neither can be statistically resolved with 8 days of data.

**The pkLight variant is broken.** Hand-coded coefficient priors (swstr_pct +0.05/0.02, era_l5 fatigue × 0.02, tto3_penalty × 0.05) clearly aren't predictive — pkLight win rate is 8.3% vs market ask implying ~17%. Either the priors are pointed the wrong way or the features themselves don't help during this regime. The real `lib/pkModel.js` ridge regression might do better (it has trained coefficients), but my hand-rolled proxy doesn't.

### Step E2 → Updated decision

**The decision to flip `FADE_VARIANT=v1h` based on 3 days of data was premature.** The 8-day picture shows v3 +$1,113 vs v1h −$666 — v3 is materially better on the longer window. The Wed+Thu disaster was inside a larger pattern where v3 was still the winner.

But — and this matters — both v3 and v1h were profitable in Wk-19 and unprofitable in Wk-20. **Whatever changed on/around May 12 hit both variants.** Switching variants doesn't fix the underlying issue.

| Action | Recommendation | Reason |
|---|---|---|
| Keep `FADE_VARIANT=v1h` | **PROVISIONAL HOLD** | v1h's lower amplitude is defensive damage control during the regime we don't yet understand. If Wk-21 returns to Wk-19 character, revert to v3. |
| Pause fade firing entirely | **NOT YET** | Wk-19 was real (+$2,777). Need to see if it returns. |
| Re-write step E with proper ladder | DONE for May 12-14 | Cannot extend to April — no `fade_fire_snapshots` rows |
| Build `scripts/replayFadeMultiVariant.mjs` | RECOMMENDED | Move `/tmp/replay_4week.py` into the repo as permanent backtest tool |
| Diagnose what changed May 12 | **NEW PRIORITY** | Look at: market mid distribution, pitcher cohort K-rates, market depth, news events, weather. Something shifted. |
| Fix `calibration_params` write path | **STILL VALUABLE** | calibrationEngine reports promoted buckets but the params table is empty. Plumbing bug. |

### Bottom-line message
After 8 days of data: v3 = best variant ($+1,113), v1h = middle ($-666), pkLight = worst ($-1,733). One week of unrepresentative losses caused us to switch off the best variant. The model isn't catastrophically broken — it just had a hard 3 days inside a profitable 8-day stretch. **Keep v1h for now as defense, watch Wk-21, and decide based on whether the recent regime persists or reverts.**

### Files referenced (Step E2)
- `/tmp/replay_4week.py` — fade-strategy-aware replay (filter-only, no ladder needed)
- `/tmp/replay_4week_results.json` — raw fire-by-fire output
- `/tmp/replay_4week_run.log` — formatted summary

---

### Step F — Wk-19 vs Wk-20 diagnostic (2026-05-15)

Compared every feature we have across the 106 settled fade bets, Wk-19 (May 7-11) vs Wk-20 (May 12-14). **The real story isn't a market regime shift — it's the v3 strike-filter change firing 2× more K≥10 bets per day.**

**Strike distribution collapsed when v3 was enabled May 12:**

| Strike | Wk-19 fires | Wk-20 fires | Shift |
|---|---|---|---|
| K=6 | 12 (19%) | 23 (54%) | ↑↑↑ |
| **K=7-9** | **37 (59%)** | **0 (0%)** | ↓↓↓ |
| K=10 | 10 (16%) | 15 (35%) | ↑↑↑ |
| K=11-13 | 4 (6%) | 5 (12%) | ↑ |

v3 filter skips K=7-9 (by design). Wk-19 was a different variant — every K=7-9 in Wk-19 is a bet v3 would have refused. Below is the per-bucket P&L breakdown that drives this:

**Per-bucket P&L by week:**

| Bucket | Wk-19 W-L | Wk-19 P&L | Wk-20 W-L | Wk-20 P&L |
|---|---|---|---|---|
| K=6 | 6-6 (50%) | **+$1,092** | 8-15 (35%) | −$157 |
| K=7-9 | 2-35 (5%) | **−$2,367** | 0-0 (n/a) | $0 |
| K≥10 | 2-12 (14%) | **+$1,378** | 0-20 (0%) | **−$2,000** |

**Without the K=7-9 bleed Wk-19 would have been +$2,470.** v3's "skip K=7-9" filter is actually correct — that's why total v3 P&L is +$1,113 over 8 days.

But Wk-20's K≥10 disaster (0-20) is the new problem. **It's not that K≥10 became unprofitable per-bet** (Wk-19 was 2-12 too, 14% win rate). It's that v3 fires K≥10 at 2× the daily rate (7/day in Wk-20 vs 3/day in Wk-19), and the 2 home-run tail wins from Wk-19 (Imanaga K=10→10, deGrom K=10→10) just didn't repeat in Wk-20.

**Pitcher cohort barely changed**: K9 career (Wk-19: 9.42, Wk-20: 9.36), swstr% (0.265 vs 0.267), xFIP (3.84 vs 3.75), avg IP L5 (5.44 vs 5.59) all within noise. The model is firing on essentially the same pitcher quality.

**What did change**: mean fill price doubled (11.9¢ → 21.9¢), model_prob went up 30% (0.250 → 0.325), confidence went up 10% (0.774 → 0.856). **The model became more confident and more expensive per bet during Wk-20** — yet realized K's slightly DECREASED (5.38 → 5.02 avg). So the increased model confidence was unwarranted.

**One specific data point**: Wk-20 K≥10 included Skenes K=12 (actual 10 — 1 K short of cashing), Misiorowski K=12 (actual 10 — 1 K short), Ohtani K=10 (actual 8), Yamamoto K=10 (actual 8), Sale K=10 (actual 8). 5 of the 20 K≥10 losses were pitchers reaching 8-10 K's — close calls. With slightly better timing on K-thresholds, several would have flipped. **This is bad-luck-on-top-of-aggression, not the model being structurally wrong.**

### Step F → Action taken
- **Reverted `FADE_VARIANT=v3` on Railway** (verified). v3 is the +$1,113 variant over 8 days; switching to v1h was based on too small a sample.
- The fade_fire_snapshots logging continues regardless of variant — captures the full strike ladder per pitcher so any variant can be replayed later. **No additional logging needed for "collect all data across the board."** This is already in place.

### "How far back can we reliably backtest?" — honest data depth audit

| Source | Date range | Days | Usable for? | Notes |
|---|---|---|---|---|
| `fade_fire_snapshots` | May 12 → May 14 | 3 | True replay (ladder) | Only data with the full rejected-strike ladder at fire time. |
| `ks_bets pregame_fade_yes` | May 7 → May 14 | 8 | Filter-replay on actual fires | What I used for Step E2. Can't see what v1h would have fired DIFFERENTLY. |
| `market_snapshots` | **Apr 27 → May 15** | **19** | True replay (1.75M rows, 178 pitchers, all strikes) | **THE BIG ONE.** Yes_bid/yes_ask/strike per pitcher per game day. Can synthesize fade ladder for any pitcher who had a market. |
| `pitcher_signals` | Apr 23 → May 14 | 22 | Feature vector for replay | Aligns with market_snapshots window. |
| `pitcher_recent_starts` | Mar 25 → May 14 | 184 records | K-outcome resolution | Realized K counts. Goes further back than fires. |
| `ks_bets all (with actual_ks)` | Apr 20 → May 14 | 25 | Outcome verification | All strategies settled. |
| `historical_pitcher_stats` | **2022-04-07 → 2025-09-28** | 730 | Prior-season baselines | Career K-rates for cold-start pitchers — does NOT include 2026 in-season market data. |
| `kalshi_price_snapshots` | (empty) | 0 | — | Table exists but unpopulated. |

**Honest floor: April 27, 2026.** From that date forward we have the FULL ladder (`market_snapshots`) + features (`pitcher_signals`) + outcomes (`ks_bets` + `pitcher_recent_starts`) — enough to do a clean replay of any variant on any historical day.

That's **19 days** of replay-grade data. With ~4 fires/day (v3) or ~8 fires/day (v1h), that's:
- v3: ~76 fires in 19 days — barely statistically meaningful for distinguishing variants
- v1h: ~150 fires in 19 days — sufficient for ±5pp win-rate detection
- Combined comparison across both: enough to detect a ≥$1000 P&L difference at p<0.05

**Pre-April-27**: We do NOT have intraday market_snapshot data. The OOS test that killed v3 (`scripts/v3HistoricalTest.mjs`, "Mar 31 - May 6, 858 records") used some other reconstruction method — likely synthesizing the ladder from `historical_pitcher_stats` + a market-price model. That's still useful for sanity checks but it's reconstructed, not actual market quotes — "BS-flavor" relative to April 27+.

### Step F → Updated action plan

| # | Action | Status | Note |
|---|---|---|---|
| **G** | Build proper ladder-replay using `market_snapshots` over Apr 27 - May 15 | **NEXT** | This is the real backtest. ~19 days × ~10 fires/day × 3 variants = ~600 replay rows. Should clearly differentiate v3 vs v1h vs pkLight statistically. |
| **H** | Diagnose K≥10 daily-rate anomaly | NEW | Why does v3 fire 7 K≥10/day in Wk-20 vs 3/day in Wk-19? Is it a pitcher-pool issue (more high-K9 pitchers starting?) or a confidence-threshold drift? Bears on whether v3 fires too eagerly. |
| **I** | Move replay scripts into repo as permanent tools | RECOMMENDED | `scripts/replayFadeMultiVariant.mjs` (from /tmp/replay_4week.py + market_snapshots ladder integration). |
| **J** | Fix `calibration_params` write-path | STILL VALUABLE | Engine reports promoted buckets but params table is empty. |

### Files referenced (Step F)
- `/tmp/diagnose_may12_shift.py` — Wk-19 vs Wk-20 feature diff
- `/tmp/diagnose_may12_run.log` — formatted output

---

### Step G — 19-day ladder replay using market_snapshots (2026-05-15)

This is the proper backtest. Pulled the earliest-captured ladder per (pitcher × game_date × strike) from `market_snapshots` over Apr 27 - May 15 = **452 pitcher-days, 1,833 strike rows, 437 outcomes available** (via `pitcher_recent_starts` + `ks_bets` fallback). Each variant picks its own candidates from the FULL ladder — not just bets v1h or v3 happened to fire in production.

**Results (the definitive numbers):**

| Variant | Fires | W-L | Win% | P&L (19d) | K=6 W-L | K=7-9 W-L | K≥10 W-L |
|---|---|---|---|---|---|---|---|
| v3 | 155 | 34-117 | 22.5% | **−$709** | 30-44 | 0-0 (skipped) | 4-73 |
| **v1h** | **266** | **57-179** | **24.2%** | **+$5,422** ✓✓ | 25-53 | **31-105** | 1-21 |
| pkLight | 173 | 32-137 | 18.9% | **+$4,027** ✓ | 10-26 | 20-96 | 2-15 |

**Validation invariants (must beat v3 by ≥+$800):**
- v1h: Δ = **+$6,131** ✓✓✓ **PASSES BY 7.7×**
- pkLight: Δ = **+$4,736** ✓ PASSES BY 5.9×

**Week-by-week:**

| Week | v3 | v1h | pkLight |
|---|---|---|---|
| Wk-18 (Apr 27 - May 3) | +$47 | +$159 | +$1,089 |
| Wk-19 (May 4 - May 10) | +$1,024 | **+$5,924** | +$5,613 |
| Wk-20 (May 11 - May 15) | −$1,780 | −$662 | −$2,674 |

**v1h's K=7-9 bucket is where the money is.** 31 wins on 136 fires (23% — basically the same rate as K=6 at 32%), but at lower ask prices (~10-15¢) so each win pays ~$700-1000 vs K=6 wins paying ~$200-300. v3's "skip K=7-9" filter is THROWING AWAY THIS WHOLE PROFIT POOL.

### Why the 8-day replay (Step E2) was misleading

Step E2 used `ks_bets pregame_fade_yes` records (actual fires) and re-applied each variant's filter to them. But the actual fires came from production runs where the variant was set to (mostly) v1h. v3's filter then REJECTS most of those (because v3 demands K=6 OR K≥10) — only the K=6 fires pass through. Those K=6 fires happened to do OK in Wk-19, so v3 looked artificially profitable.

The 19-day market_snapshots replay lets each variant pick from the FULL ladder (every strike), so v3 doesn't get to cherry-pick from v1h's already-filtered choices. **That's the apples-to-apples comparison the 8-day version couldn't do**, and it reverses the verdict completely.

### Strike distribution comparison

| Variant | K=6 | K=7 | K=8 | K=9 | K=10 | K=11 | K=12+ |
|---|---|---|---|---|---|---|---|
| v3 | **74** | 0 | 0 | 0 | 63 | 10 | 4 |
| v1h | 78 | 62 | 47 | 27 | 11 | 7 | 4 |
| pkLight | 36 | 48 | 45 | 23 | 13 | 3 | 1 |

v3 fires 63 K=10 bets over 19 days vs v1h's 11. **v3 force-fires the tail 6× more often** because each pitcher whose K≥10 has any edge gets a tail fire, regardless of whether the K≥10 is actually the BEST option. v1h fires K≥10 only when it's the single-best edge across all strikes. K≥10 wins are rare (1-21 for v1h, 4-73 for v3) so firing it less often is correct.

### Step G → Action taken
- **Reverted `FADE_VARIANT=v1h` on Railway** (verified). This time it's based on real 19-day evidence, not 3 days.
- The variant flip in Step F (v3) was based on biased ks_bets-filter analysis. The actual ladder replay says v1h has been the better variant the whole time.

### Step G → Net learning across this entire 2026-05-15 investigation

1. **The K≥10 tail isn't profitable enough to force-fire.** Across 19 days v3 fired 73 K≥10 losses to win 4 — even with payouts of 7-15× on each win, P&L on the bucket is −$2,800. v1h's "fire K≥10 only when it's the single best edge" is correct.

2. **The K=7-9 bucket is the silent winner.** v3's strike filter throws away this whole pool. Over 19 days v1h's K=7-9 made 31W of 136 fires; even at 23% hit rate the lower ask prices (~10-15¢) make the wins large enough that the bucket is net positive.

3. **The 8-day analysis was statistically underpowered AND structurally biased.** It used post-filter data, not pre-filter ladder. The 19-day market_snapshots replay should be the standard for any future variant decision.

4. **Wk-20 was bad for ALL variants** (v3 −$1,780, v1h −$662, pkLight −$2,674). The market got harder mid-May for everyone. But v1h lost the LEAST — its broader strike selection and single-best-edge picking is more robust to regime shifts.

5. **`pkLight` is competitive but worse than v1h.** My hand-coded multi-feature lambda (k9, swstr, era, tto3) added +$4,027 vs v3 but didn't beat v1h's +$5,422. The features aren't worthless, but the coefficients need to be learned (= use the actual `lib/pkModel.js` ridge regression, not my hand-coded proxy) for it to add value over v1h's simpler approach.

### Step G → Updated action plan

| # | Action | Status | Note |
|---|---|---|---|
| **A** | `FADE_VARIANT=v1h` | ✅ DONE (final this time) | Backed by 19-day ladder replay, +$5,422 vs v3 −$709. |
| **B** | Wire `pkModel.predictPk` into fire pipeline | DEFER | pkLight beat v3 but didn't beat v1h. Real pkModel (trained ridge) might help but needs careful validation. |
| **D** | Populate enrichment columns on `ks_bets` INSERT | STILL VALUABLE | 30-min fix. |
| **G** | **Move `replay_19day.py` → repo as `scripts/replayFadeMultiVariant.mjs`** | NEXT | Permanent backtest tool. Should run weekly. |
| **H** | Diagnose what hit ALL variants in Wk-20 | LOWER PRIORITY | v1h survived best; market may revert. |
| **J** | Fix `calibration_params` write-path bug | STILL OPEN | Engine reports promoted buckets but params table empty. |

### Files referenced (Step G)
- `/tmp/replay_19day.py` — proper market_snapshots ladder replay (the canonical backtest tool)
- `/tmp/replay_19day_results.json` — fire-by-fire output across all 3 variants
- `/tmp/replay_19day_run.log` — formatted summary

---

### Step G — Max-Think Evaluation (stress-tested 2026-05-15)

Before declaring v1h the right answer, ran 6 stress tests on the Step G result.

#### What survived scrutiny

**1. Statistical significance: 99.1% confident v1h > v3.**
Bootstrap (N=5,000, sampling 17 days with replacement) on the v1h − v3 daily-P&L delta:
- Point estimate: **+$6,131**
- Bootstrap mean: +$6,120 (matches → no estimator bias)
- 90% CI: [+$1,403, +$11,872]
- 95% CI: [+$655, +$13,192]
- **P(v1h > v3) = 99.1%**
- **P(v1h beats v3 by ≥$800) = 97.1%**

Even at the conservative 95% lower bound (+$655), the directional claim is firm. The validation invariant from earlier governance ("beat v3 by ≥+$800") passes at 97% confidence — not 50/50 noise.

**2. v1h's profit isn't from one lucky day.**
Best 3 days = $5,509, total = $5,422. Removing the best day → v1h still +$2,883. Removing the worst day → +$6,692. Multiple positive-edge days, not a single tail.
Contrast: **pkLight's +$4,027 collapses to −$270 if May 8 is removed.** pkLight depends on one outlier day. v1h doesn't. (Yellow flag for pkLight, not v1h.)

**3. K=7-9 winners are well-distributed.**
31 K=7-9 wins across 10+ days (max 4 in a day). Strike split: 20×K=7, 8×K=8, 3×K=9. Ask price range 4-42¢, median 22¢.
- Gross from wins: +$15,095
- Losses (105 × $100): −$10,500
- **Net K=7-9 bucket: +$4,595**

This bucket — which v3 entirely throws away — is the real source of v1h's edge.

**4. Outcome coverage is fine.**
- v3: 151/155 (97.4%) settled
- v1h: 236/266 (88.7%) settled — the 30 missing are mostly today (5/15 fires not yet resolved) + a few pitchers who didn't pitch.
- pkLight: 169/173 (97.7%) settled

If anything, this UNDER-counts v1h (it has more unrealized fires). Not a methodology bias.

#### What I'm not certain about (honest caveats)

**1. Single-pitcher concentration is real.**
Pitcher 663362 alone contributed +$2,400 on a single fire = **44% of v1h's net P&L**. Total positive contributions = +$18,195; total negative = −$12,773. The strategy is "lottery ticket" by nature — wins at 4-7¢ asks pay 13-25× stake. **The +$5,422 contains a few lucky low-ask hits.** Real-world variance week-to-week will be wide. Annualizing this is fraught.

**2. Bootstrap CI is wide ($655 to $13,192 at 95%).**
17 days is a small sample for bootstrap. The DIRECTIONAL claim (v1h beats v3) is robust at 99% probability. The MAGNITUDE claim (specifically $5,422) is uncertain. Real performance could be anywhere in the bootstrap range. Don't extrapolate this as "$5k per 19 days = $7k/month."

**3. Methodology gaps not modeled:**
- **Fire-time snapshot = MIN(captured_at) per strike.** This is the EARLIEST snapshot per pitcher-strike-day. If the earliest snapshot has stale opening prices that wouldn't have been actually offered at the fade-cron fire time (~9am ET), the replay may benefit from optical prices. Should re-run using a specific hour (e.g., 9-10am ET range) and confirm.
- **No liquidity cap modeled.** Production has `MAX_PCT_OF_VOLUME = 10%`. Low-ask K=7-9 markets often have thin depth — a 4¢ ask might have only $50-200 of size available. My replay assumes infinite liquidity. Real-world fills would be smaller, especially on the highest-payout wins, compressing absolute returns.
- **Flat $100 stake vs production edge-weighted sizing.** The comparison BETWEEN variants is still apples-to-apples, but absolute P&L is illustrative only.
- **`market_snapshots.model_prob` source not verified.** I assumed this is the same probability the fade pipeline would compute. If it's from a different model (e.g., XGBoost full-game in `features.js`), edges would differ. Should grep code to confirm.

**4. v3's K≥10 might be unlucky, not structurally wrong.**
v3 K≥10 was 4-73 (5% win rate). v1h K≥10 was 1-21 (5%) — identical rate, just way fewer fires. If the true K≥10 rate is ~10-15% (matches the model's claim), the 5% realized rate is at the bottom of a ~17% CI. Could easily revert.
**However**: even if K≥10 reverts to 12% hit, v3's "force a K≥10 fire per pitcher" is firing 6× more often than v1h. The bucket would need to be HUGELY positive-EV to overcome the v1h advantage from K=7-9. So even with mean-reversion on K≥10, v1h likely still wins.

#### Verdict: keep v1h, but with eyes open

| Item | Strength | Action |
|---|---|---|
| Directional verdict v1h > v3 | **STRONG** (99% confidence, robust to most stress tests) | `FADE_VARIANT=v1h` is the right setting. |
| Absolute P&L magnitude | **WEAK** (single-pitcher concentration, wide CI, methodology gaps) | Don't promise $5k/19 days in production. Realistic expectation = positive-EV with high variance. |
| K=7-9 bucket profitability | **MODERATE** (well-distributed wins, but small sample) | Watch the bucket weekly. If it goes 5-50 over the next 4 weeks, re-evaluate. |
| K≥10 unfavorable | **MODERATE** (5% rate vs 12% claim, but n=22-73) | Hold v1h's "single best edge" selection; don't force tail. |
| Step G replay tool | **PERMANENT** | Move `replay_19day.py` → `scripts/replayFadeMultiVariant.mjs`. Run weekly on rolling 28-day window. |

#### Remaining work (post-evaluation)

| # | Action | Priority |
|---|---|---|
| K | Re-run Step G with snapshot picked from specific hour (e.g., 09:00-10:00 ET) | Should match the actual fade-cron fire time. If results hold, even more confident. |
| L | Add liquidity-cap proxy to replay (use `volume` from market_snapshots to cap stake) | More realistic absolute returns. |
| M | Verify `market_snapshots.model_prob` source — grep code paths | Could invalidate everything if it's from a different model. |
| N | Move `replay_19day.py` → repo as permanent script | Backtest infra. |
| O | Re-run Step G weekly on rolling 28-day window | Watch for variant-change signals before fires occur. |

### Files referenced (Step G evaluation)
- `/tmp/stress_test_g.py` — six-test stress evaluation
- `/tmp/stress_test_g_run.log` — bootstrap, concentration, and worst-day output

---

### Step G v2 — FADE-CORRECT REPLAY (M+K+L fixes, 2026-05-15 evening)

The original Step G replay was approximate. The max-think evaluation flagged 3 specific concerns; all 3 are now fixed and the replay re-run. **The directional verdict holds — v1h still beats v3 — but the magnitude is smaller and more honest.**

#### Fixes applied

**M-fix: model_prob source mismatch.**
The replay was using `market_snapshots.model_prob`, which is computed by `scripts/live/strikeoutEdge.js` using `archetypeR(savant)` — a pitcher-specific NB dispersion of **20-50** (closer to Poisson, thinner tails). The actual fade pipeline (`scripts/fireFadeModel.mjs`) uses a hardcoded **NB_R = 8** (much fatter tails). This means market_snapshots' model_probs UNDERSTATE the fade model's bullishness on K≥10 strikes.

The v2 replay recomputes model_prob from scratch using fade's exact math: `lambda = k9_l5 × avg_ip_l5 / 9` from the last 5 starts in `pitcher_recent_starts`, then `nbGeq(lambda, 8, strike)`. This is identically what `fireFadeModel.mjs` would have computed at fire time.

**K-fix: snapshot timing.**
Original replay used `MIN(captured_at)` per (pitcher, day, strike) = earliest snapshot, which could be hours before the fade cron fires. v2 restricts to snapshots captured in **09:00-11:00 ET** (= 13:00-15:00 UTC), matching the actual fade-cron fire window.

**L-fix: liquidity cap.**
Production has `MAX_PCT_OF_VOLUME = 10%` — bets can't exceed 10% of the market's 24h volume in contracts. v2 caps each fire's stake at `min($100, 0.10 × volume × ask_dec)`. This compresses the upside of low-ask wins (where 4¢ asks pay 24× but may only have $50-200 of size).

#### Step G v2 results (April 27 - May 15, 19 days)

| Variant | Fires | W-L | Win% | P&L | Total stake | Liq-capped | K=6 W-L | K=7-9 W-L | K≥10 W-L |
|---|---|---|---|---|---|---|---|---|---|
| v3 | 102 | 18-84 | 17.6% | **−$1,212** | $4,927 | 57/102 (56%) | 14-31 | 0-0 (skipped) | 4-53 |
| **v1h** | **163** | **21-127** | 14.2% | **+$1,279** | $7,450 | 91/163 (56%) | 5-16 | 13-88 | 3-23 |
| pkLight | 156 | 28-125 | 18.3% | **−$19** | $9,936 | 62/156 (40%) | 9-25 | 18-88 | 1-12 |

**Validation invariants (must beat v3 by ≥+$800):**
- **v1h Δ = +$2,492 ✓** (still passes the gate by 3.1×, vs Step G v1's 7.7×)
- **pkLight Δ = +$1,193 ✓** (now near break-even; the hand-coded coefficients aren't adding clear value)

#### What the M-fix changed

The model_prob correction shrunk EVERY variant's win rate (Step G v1 v1h was 24%; v2 v1h is 14%). That's because:
- Fade's r=8 produces FATTER TAILS than market_snapshots' r=20-50
- model_prob for K=8-10 strikes is meaningfully HIGHER under r=8
- Bigger model_probs → bigger edges → more fires → many of those new fires are losers because the realized K rates aren't actually as fat-tailed as r=8 implies

**This says fade's r=8 may itself be too generous to the tail.** NB_R=8 was calibrated on older data; current pitcher distributions may have thinner tails. A future improvement (separate from the variant question) is to re-calibrate NB_R against the 2026 season data — there's a comment in `lib/strikeout-model.js` that says NB_R should be recalibrated yearly.

#### What survived the corrections

- **Directional verdict**: v1h > v3 still holds with corrected math.
- **K≥10 still bad for everyone**: v3 = 4-53 (7%), v1h = 3-23 (12%), pkLight = 1-12 (8%). All three variants would prefer to fire LESS in the tail. v3's force-fire of K≥10 is still the largest single drag.
- **Week-by-week shape preserved**: Wk-19 was the best week for all variants, Wk-20 was bad for all. v1h's Wk-19 P&L = +$2,137, v1h's Wk-20 = −$802. Still net positive across 19 days.

#### What got worse than I thought

- **Original "K=7-9 is the silent winner" finding was overstated.** With fade's correct r=8 math, K=7-9 wins drop from 31-105 (23%) to 13-88 (13%) — closer to K≥10's hit rate. The bucket is still less bad than the tail (because asks are lower so liquidity caps bite less) but it's not the +$4,595 cash cow I claimed.
- **pkLight is now nearly break-even** (−$19 over 19 days). The +$4,027 from Step G v1 was an artifact of using inflated model_probs from a different model. With fade-correct math, pkLight is competitive with v3 but not v1h.

### Step G v2 → Permanent infrastructure

**`scripts/replayFadeMultiVariant.mjs` committed** to the repo. CLI:
```
node scripts/replayFadeMultiVariant.mjs                          # rolling 28-day window
node scripts/replayFadeMultiVariant.mjs --from YYYY-MM-DD --to YYYY-MM-DD
node scripts/replayFadeMultiVariant.mjs --discord                # post summary
node scripts/replayFadeMultiVariant.mjs --json /tmp/out.json     # dump full results
```

**Cron added to `server/scheduler.js`**:
```
0 6 * * 0  (Sundays 6:00 AM ET)  → replayFadeMultiVariant.mjs --discord
```
Every Sunday morning we get an automated 28-day rolling backtest of all 3 variants posted to Discord. If a variant change is on the table, we have ladder data ready.

### Step G v2 → Validation invariants (ratified)

**Before any FADE_VARIANT change in production**:
1. Replay window ≥ 14 days
2. Candidate variant must beat the active variant by ≥+$800 P&L
3. Bootstrap on daily P&L delta must show P(positive) ≥ 95%
4. K≥10 bucket: either ≥1 win OR completely skipped in the candidate variant
5. Replay must use the M+K+L corrected methodology (fade's NB(8) math, 09:00-11:00 ET snapshots, 10% liquidity cap)

**The −$1,618 paper loss this week was the direct consequence of overriding these invariants** (specifically, flipping FADE_VARIANT=v3 on May 12 against an OOS test that said v3 loses). Going forward, no overrides.

### Final action plan status

| # | Action | Status |
|---|---|---|
| A | `FADE_VARIANT=v1h` | ✅ DONE |
| B | Wire `pkModel.predictPk` | DEFER (pkLight beat v3 but not v1h with corrected math) |
| C | Wire calibration at fire | BLOCKED — `calibration_params` table is empty (separate bug to fix) |
| D | Populate enrichment columns on `ks_bets` INSERT | OPEN — 30 min, valuable for future audits |
| **K** | Re-run Step G with 09:00-11:00 ET window | ✅ DONE |
| **L** | Liquidity-cap proxy | ✅ DONE |
| **M** | Verify model_prob source | ✅ DONE — was using wrong NB dispersion; replay now corrects this |
| **N** | Move replay to repo | ✅ DONE — `scripts/replayFadeMultiVariant.mjs` |
| **O** | Weekly Sunday 6am cron | ✅ DONE — added to `server/scheduler.js` |

### Files referenced (Step G v2)
- `/tmp/replay_19day_v2.py` — corrected Python replay (canonical reference)
- `/tmp/replay_19day_v2_results.json` — raw fire-by-fire output
- `/tmp/replay_19day_v2_run.log` — formatted summary
- `scripts/replayFadeMultiVariant.mjs` — production .mjs version, committed to repo
- `server/scheduler.js` — weekly Sunday 6am ET cron entry

### Bottom-line learning from this entire 2026-05-15 investigation

The variant decision flipped THREE times in one day (v3 → v1h → v3 → v1h) as evidence accumulated:
1. **3-day filter analysis** said v1h beats v3 → flipped to v1h
2. **8-day filter analysis** said v3 beats v1h → flipped back to v3
3. **19-day ladder replay** said v1h beats v3 → flipped to v1h (final)

The lesson: **filter-on-actual-fires creates structural bias** because actual fires were chosen by whatever variant was active. The 8-day result that fooled us came from re-applying v3's filter to v1h's choices, which cherry-picked v1h's K=6 fires that happened to do well. The market_snapshots ladder replay gives each variant access to its own full candidate set, which is the only fair comparison.

**Going forward**: any variant decision must run on the market_snapshots ladder over ≥14 days, with bootstrap CI on the delta, before changing FADE_VARIANT in production. The cost of policy decisions made on biased samples is exactly the −$1,618 we burned this week.

---

## System Overview

MLBIE (MLB Innings/Batters Edge) is a quantitative edge-finding system for
Kalshi `KXMLBKS` strikeout proposition markets. It computes a pitcher's
expected strikeout count (λ) using a multi-source blended model, compares that
to Kalshi YES/NO prices, and sizes bets using a correlated quarter-Kelly
criterion.

Two betting pipelines share one `ks_bets` database table:

| Pipeline | Script | Trigger | Mode |
|----------|--------|---------|------|
| **Morning picks** | `scripts/live/ksBets.js` | ~9am + ~12:30pm refresh | Pre-game |
| **The Closer** | `scripts/live/liveMonitor.js` | Continuous during games (Windows machine) | In-game |

Edge generation for morning picks flows through `scripts/live/strikeoutEdge.js`.
The Closer uses a live model (`computeLiveModel`) that re-computes λ_remaining
using real-time pitch count, innings pitched, and batters faced.

---

## Model Architecture

### Core Formula

```
λ = E[BF] × pK_blended × lineup_adj × park_factor × weather_mult × ump_factor × velo_adj

P(K ≥ n) = 1 - NB_CDF(λ, r=30, k=n-1)
```

### Component Breakdown

#### pK_blended — Three-Way K% Blend

A weighted blend of three K% signals, each measured in per-BF space:

| Signal | Description | Weight formula |
|--------|-------------|----------------|
| `pK_career` | Multi-year weighted average K% from `historical_pitcher_stats` (2023=0.20, 2024=0.30, 2025=0.50) | `w_career = max(0, 0.40 × (1 - ip_2026/40))` — fades to zero by 40 IP |
| `pK_season` | 2026 Savant K% from `pitcher_statcast` | `w_season = min(0.60, ip_2026/50)` — grows to 0.60 by 50 IP |
| `pK_l5` | Last-5-starts K/BF ratio from game log | `w_l5 = 1 - w_career - w_season` |

**Why BF not K/9?** K/9 confounds K-rate with innings pitched. A pitcher who
gets pulled at 5 IP after 8 Ks has an excellent K-rate (K/BF) but ordinary
K/9 because innings are truncated. We model expected strikeouts as
`E[BF] × pK_blended`, so all math is in batters-faced space.

**Why three-way blend?** Career weight provides a stable anchor early in the
season (low IP, high variance). Season (Savant) weight grows as we accumulate
reliable data. L5 captures recent form. Each source dominates at the
appropriate sample-size regime.

#### E[BF] — Expected Batters Faced

Priority order:
1. `pitcher_recent_starts` table (last 3-5 starts, actual BF recorded)
2. Game log last-5 BF average (if `pitcher_recent_starts` unavailable)
3. Career avg IP × LEAGUE_PA_PER_IP (fallback)

**Leash flag**: if avg pitch count < 85 over recent starts, the pitcher is
likely being managed aggressively and E[BF] may be optimistic. Flagged in
output as `⚠leash`.

#### lineup_adj — Opponent Quality Adjustment

`lineup_adj = lineup_k_pct / LEAGUE_K_PCT`

Priority:
1. Official 9-man lineup from `game_lineups` (posted ~3-4 PM ET game day) —
   per-batter K% splits vs RHP/LHP fetched from MLB Stats API and
   **position-weighted by batting order** (see Batting Order Weighting below)
2. `historical_team_offense` table (14-day rolling K% by hand split)
3. MLB API season team hitting stats
4. League average (0.22)

#### park_factor — Park K-Rate Multiplier

Source: `lib/parkFactors.js`. Research-based multipliers derived from
Baseball Prospectus and FanGraphs 3-year park factors for K%. Applied to λ
after all other adjustments.

Notable values: COL=0.92 (thin air, least break), SD=1.06 (Petco marine
layer, heaviest air), NYY=1.04 (aggressive pull-swing culture).

Dome teams have factors between 1.01-1.03 (climate-controlled conditions
favor clean pitch spin).

#### weather_mult — Game-Day Weather Adjustment

Applied for outdoor parks only. Dome/retractable-roof teams are excluded.
Multipliers stack (all can apply simultaneously):

| Condition | Multiplier | Rationale |
|-----------|-----------|-----------|
| Wind > 15 mph | ×0.97 | Crosswinds make it harder to locate/spin breaking balls |
| Temp < 45°F | ×0.96 | Cold reduces grip and pitch spin rate |
| Humidity > 80% | ×1.02 | Heavy humid air increases ball-bat resistance slightly |

Weather fetched concurrently at startup via `lib/weather.js` (OpenWeather
5-day forecast, 3-hour blocks — picks the block closest to first pitch).

#### ump_factor — HP Umpire Tendencies

Source: `lib/umpireFactors.js`. Multipliers from Umpire Scorecards /
Baseball Savant umpire data (2023-2026, min 200 games).

**Updated 2026-04-23:** 13 retired/suspended/deceased umps removed:
Angel Hernandez (retired Jul 2023), Joe West (retired Nov 2021),
Dana DeMuth (retired 2018), Tom Hallion (retired 2017),
John Hirschbeck (retired 2017), Jerry Meals (retired 2020),
Eric Cooper (died 2015), Bill Miller (retired 2022),
Paul Emmel (retired 2022), Mike Everitt (retired 2021),
Gerry Davis (retired 2018), Pat Hoberg (suspended 2024),
Bruce Dreckman (retired 2022).

**Magnitude cap: ±0.05.** Prior table had values up to ±0.08 which
over-adjusted and produced negative ROI on expanded-zone bets in live trading.

Expanded-zone example: Ted Barrett (1.05), Dan Iassogna (1.04).
Tight-zone example: Clint Fagan (0.95), CB Bucknor (0.97).

HP ump fetched via `scripts/live/fetchUmpire.js` → MLB Stats API
`/schedule?gamePk=X&hydrate=officials`. All game umps fetched concurrently at
startup. Unknown umps default to 1.00.

**Review ump table annually before Opening Day.**

#### velo_adj — Velocity Trend Signal

Compares current season `fb_velo` (Savant) to career average (2023-2025
average from `pitcher_statcast`):

| Delta | Multiplier | Flag |
|-------|-----------|------|
| > +1.0 mph | ×1.03 | `velo-up` — more velocity = more swing-and-miss |
| < -1.5 mph | ×0.96 | `velo-down` — velocity loss = contact regression |
| Within range | ×1.00 | No adjustment |

Applied inside `computeLambdaBase` before returning λ_base, so it scales the
K% estimate directly rather than being a post-hoc multiplier.

#### Batting Order Position Weighting

Batting order positions weight by expected plate appearances in a typical
5-6 IP start. Weights [1.0, 0.97, 0.95, 0.93, 0.92, 0.91, 0.88, 0.86, 0.84]
for positions 1-9, re-normalized to sum to 1. A leadoff hitter facing an
ace starter gets roughly 3 PAs; the cleanup hitter in position 4 gets ~2.8;
the #9 hitter may only see 2.5 PAs.

#### NB(λ, r=30) Distribution

**Why Negative Binomial, not Poisson?** Pitcher strikeout counts have more
variance than a Poisson process because of game-to-game heterogeneity (stuff,
command, opponent). Calibration from 4,255 starts (2023-2025): actual
variance/Poisson_variance ≈ 1.17, implying dispersion parameter
r = mean_λ / (variance_ratio - 1) ≈ 30.

At r=30, the NB is nearly Poisson for low λ but meaningfully wider-tailed
for high λ. This is appropriate since upside outcomes (8+ Ks) are
systematically underpriced in Poisson-based models.

**No shrinkage applied to upper-tail probabilities.** A shrinkage block
(×0.93-0.97 for K≥7-9) was removed 2026-04-23 after live data showed the
model *under*-predicts the upper tail: K≥7+ bets won at 44-45% when the
raw model predicted 30-40%. The shrinkage was making predictions worse.
Use raw `pAtLeast(lambda, n)` output directly.

Re-run calibration yearly: `backtest.js` produces calibration plots.

---

## Calibration Results

**2024 out-of-sample holdout** (not used in model fitting):
- Model probabilities vs realized outcomes by 10% bucket: within 2% across all
  buckets
- Brier score: 0.183 (vs Kalshi implied: 0.197, ~7% improvement)
- P(K≥5) bucket (most liquid): model 48.2%, realized 47.8% over 612 starts
- P(K≥7) bucket: model 31.4%, realized 32.1% over 612 starts

**2025 in-season ongoing**: re-run `backtest.js --season 2025` weekly.

---

## Live Performance — Apr 2026

### Morning bets (live, real Kalshi money — both accounts)

| Date | Bets | Capital at Risk | P&L | Win Rate | Notes |
|------|------|-----------------|-----|----------|-------|
| Apr 22 | 47 | $707 | -$174 | 43% | Old sizing system |
| Apr 23 | 28 | $542 | +$114 | 54% | Old sizing system |
| Apr 24 | ~28 | ~$523 | — | — | Old sizing system |
| Apr 25 | 28 | $550 | — | — | **Kelly system live** |

### Kelly vs. Old System — Apr 22–25 Retrospective

Smoke test: ran the full Kelly pipeline against all this week's live transactions.

| System | Bets | Risk | P&L | ROI |
|--------|------|------|-----|-----|
| Old (edge-weighted flat budget) | 87 | $2,269 | +$878 | 38.7% |
| Kelly (quarter-Kelly, NO bug fixed) | 72 | $1,274 | +$952 | 74.7% |

Kelly made **$74 more** on **$995 less capital**. ROI nearly doubles.
Apr 22 was the sharpest divergence: old system -$288, Kelly system +$152. Rule A alone
blocked ~$178 in Eduardo Rodriguez NO bet losses (mkt=78, mp=0.518 → no conviction).

### In-game bets — The Closer (paper simulation through Apr 23)

Simulation uses unique positions only (duplicates from the logging bug excluded).
2× sizing applied to all edge ≥ 15¢ bets per the live rule.

| Date | Unique Bets | Simulated P&L | Win Rate | Notes |
|------|-------------|---------------|----------|-------|
| Apr 21 | 185 | +$4,980 | 61% | Best day: Jacob Lopez 1K, Simeon Woods Richardson 2K |
| Apr 22 | 7 | -$149 | — | Small slate; Tyler Mahle 5NO cost $130 |
| Apr 23 | 43 | -$58 | — | Joe Ryan only 2Ks; deGrom open bets unsettled |

**Key findings from in-game simulation:**
- **Best segment: NO at high market_mid (70-90¢)** — 109% ROI. Market over-prices favorites; cheap NOs with huge upside.
- **2× sizing on edge ≥ 15¢ bets added +$1,909** vs flat-size across 100 bets.
- **In-game win rate (61%) beats morning (43-54%)** because The Closer only fires at ≥75% model_prob YES or ≤15% model_prob NO with ≥15-20¢ edge.

---

## The Closer — In-Game System

### Overview

`scripts/live/liveMonitor.js` runs continuously on a dedicated Windows machine
during MLB games. Every 20 seconds it:
1. Fetches live box score (MLB API) for each game with active K-prop bets
2. Updates a live model (`computeLiveModel`) using current K count, IP, pitches, BF
3. Computes updated P(K≥n) for all remaining thresholds
4. Compares against current Kalshi prices — fires only on high-conviction edges
5. Manages resting orders (queue position, amend, cancel+retake)
6. Settles bets at game-end using Kalshi's actual revenue data

### Entry Filters (both must pass)

| Side | Model Prob | Edge Floor | Notes |
|------|-----------|------------|-------|
| YES | ≥ 75% | ≥ 20¢ (or halfSpread + 4¢) | High-conviction only |
| NO | ≤ 15% | ≥ 15¢ (or halfSpread + 4¢) | Pitcher must be clearly under-performing |

Additional guards: min 6 BF faced, min 3rd inning, skip pitchers already pulled.

### Sizing

Correlated Kelly across all qualifying thresholds per pitcher (same as morning).
**High-edge multiplier: 2× bet size when edge ≥ 15¢** (validated +$1,909 on
100 bets in Apr 21-23 simulation). Budget cap: 20% of live Kalshi balance per
session.

### Order Execution — Maker First

1. **Initial placement:** Maker at `ask - 1¢` (fetch real ask from orderbook;
   fall back to `mid + 2¢` if unavailable). 75% fee discount vs taker.
2. **Queue management** (when pitcher hits 85+ pitches AND 4+ IP):
   - Queue ≤ 10: leave it
   - Queue ≤ 30: amend to `ask - 1¢` (improve position without losing slot)
   - Queue > 30: cancel + taker at `ask + 1¢`
3. **Pre-game resting orders** (morning bets, T-45 min before first pitch):
   - If filled: done
   - If unfilled: cancel + taker at `ask + 1¢` if edge still holds

### Settlement

- **YES wins:** Settled immediately when `actual_ks >= strike` (covered)
- **YES losses:** Settled when starter is pulled with `actual_ks < strike` and `IP ≥ 3`
- **NO bets (both wins and losses):** Settled at game-end only via
  `settleAndNotifyGame()` using Kalshi's actual settlement revenue.
  **No mid-game early settlement for NO bets** — box scores can briefly lag
  and an early loss lock is permanent and irreversible.

### Duplicate Prevention

The Closer uses a two-layer dedup:
1. **Application-level:** `executeBet` queries for an existing row before
   inserting. Returns immediately if found.
2. **DB-level:** `upsert('ks_bets', ..., ['bet_date', 'pitcher_name', 'strike', 'side', 'live_bet'])`
   conflict keys match the actual `UNIQUE` constraint. **Do not add `user_id`
   to the conflict key list** — the table's UNIQUE constraint does not include
   it, and SQLite would silently insert duplicates if the keys don't match.

---

## Kelly Sizing System Architecture (live as of 2026-04-25)

### Sizing Flow (ksBets.js)

1. Run `strikeoutEdge.js` → raw edges as JSON
2. Dedup hedges (keep highest-edge side at each pitcher+strike key)
3. Cap YES bets per pitcher at 3 (sorted by edge descending)
4. Apply protection rules A/D/E/F
5. Count pending games in `bet_schedule` → `opportunityDiscount()`
6. `pregamePool = bankroll × pregameRiskPct`
7. `effectiveBankroll = pregamePool × discount`
8. `perPitcherCap = pregamePool × 0.10`
9. Group edges by pitcher → `correlatedKellyDivide()` per group
10. Apply per-pitcher cap scale
11. Portfolio cap: if total > pregamePool → scale all bets down proportionally
12. For each sized bet: upsert to `ks_bets`, place Kalshi taker order

### Key Constants (.env)

| Constant | Value | Effect |
|----------|-------|--------|
| `KELLY_MULT` | 0.25 | Quarter-Kelly multiplier |
| `MAX_BET_PCT` | 0.05 | 5% of effectiveBankroll per-bet cap |
| `PER_PITCHER_CAP` | pregamePool × 0.10 | ~$74/pitcher ceiling |
| `PORTFOLIO_CAP` | pregamePool | ~$742/day absolute ceiling |

At current bankroll ($1,237): individual bets range $4–$24. Full Kelly fractions
of 25-75% are common — the discount + cap compress these to 2-12% sized fractions.

### NO-Bet Probability Convention (CRITICAL)

`modelProb` in this codebase is **always P(YES wins)** — i.e., P(pitcher reaches
the threshold). Kelly formula must account for this:

```js
// Correct (lib/kelly.js as of 2026-04-25):
const probWin = side === 'YES' ? modelProb : (1 - modelProb)
const feeEdge = probWin * winPerUnit - (1 - probWin) * losePerUnit
```

The bug before Apr 25 used `modelProb` directly for NO bets, giving P(win) ≈ 0.18
for a strong NO (where the actual P(win) was 0.82). All NO bets returned `betSize=0`.
Any code that calls `kellySizing()` or `correlatedKellyDivide()` with NO bets
depends on this convention — never change `modelProb` to mean P(NO wins).

### correlatedKellyDivide() — Pitcher Correlation Fix

When a pitcher has edges at 5+, 6+, 7+ Ks simultaneously, these bets are
near-perfectly correlated (same outcome pays all YES bets below it). Sizing each
at full Kelly would 3-4× actual exposure.

Fix: **total exposure = max single-threshold Kelly**, allocated proportionally
within that cap. YES and NO bet groups are sized independently (uncorrelated
across sides).

### Smoke Test Results — Week of Apr 21-25 ($1,237 bankroll)

| Day | Edges | Kelly bets | Deployed | % of pool |
|-----|-------|-----------|----------|-----------|
| Apr 21 | 76 | 76 | $742 | 100% (scaled ×0.846) |
| Apr 22 | 39 | 39 | $699 | 94% |
| Apr 23 | 16 | 16 | $302 | 41% (light slate) |
| Apr 24 | 28 | 28 | $523 | 71% |
| Apr 25 | 28 | 28 | $550 | 74% |
| **Week** | **187** | **187** | **$2,816** | — |

### What to Watch When Reviewing Edge System Changes

1. `model_prob` must remain P(YES wins = pitcher reaches threshold). Kelly depends on this.
2. If the `edge` field calculation changes, re-verify rules A/D/E/F thresholds.
3. Run `node scripts/smokeTest.js` after any model change — verify sizing stays in $4-$24/bet, total ≤ $742/day.
4. NO bets need `model_prob` LOW (e.g., 0.15-0.45) for Kelly to correctly size them as high-conviction NO positions.
5. Full Kelly fractions of 50-75% on individual bets are normal given strong edges — cap and quarter-Kelly compress to safe sizes.

---

## Kelly Sizing Rationale

**Quarter-Kelly (KELLY_MULT = 0.25)**
Full Kelly maximizes long-run growth but produces drawdowns that are
psychologically unsustainable and practically dangerous when model estimates
have error. Quarter-Kelly gives ~56% of the geometric growth rate at roughly
1/4 the variance.

**Why not half-Kelly?** Model error. Our K% estimates have roughly ±2-3%
standard error. When you propagate that through pAtLeast() for a 7+ threshold,
the pricing error on the probability is often larger than the market edge. A
0.25 multiplier provides adequate buffer.

**MAX_BET_PCT = 5% of bankroll** per single bet (cap). This prevents the
Kelly formula from sizing very large bets on high-probability markets where
the formula legitimately suggests large fractions.

---

## Budget Structure (as of 2026-04-25)

Bankroll is split into three pools at the user level (`users` table columns):

| Pool | Column | Default | Daily role |
|------|--------|---------|-----------|
| Pre-game | `pregame_risk_pct` | 0.60 | Morning ksBets.js runs |
| Live (in-game) | `live_daily_risk_pct` | 0.20 | The Closer / liveMonitor.js |
| Free money | `free_money_risk_pct` | 0.20 | Kalshi promo / bonus bets |

**Key formulas (ksBets.js)**:
```
pregamePool       = bankroll × pregame_risk_pct  (~$742 at $1,237)
effectiveBankroll = pregamePool × opportunityDiscount(remaining_games)
perPitcherCap     = pregamePool × 0.10           (~$74/pitcher)
portfolioCap      = pregamePool                  (absolute daily ceiling)
MAX_BET_PCT = 0.05 of effectiveBankroll          (~$24 per bet)
```

**`opportunityDiscount(remaining)`** — scales down effective bankroll to
preserve capital for later high-edge games:
```
remaining >= 7 → 0.65×   (most common — large slate)
remaining >= 4 → 0.80×
remaining >= 2 → 0.90×
remaining  = 1 → 1.00×
```
`remaining` = count of `bet_schedule` rows with `status='pending' AND game_time > now`.
Buffer: +2 added before noon ET, +1 before 3pm ET.

**At current bankroll ($1,237)**:
- pregamePool = $742/day max
- effectiveBankroll ≈ $482 on a large slate (0.65× discount)
- Per-bet cap ≈ $24.10 (5% × $482)
- Per-pitcher cap ≈ $74

Running ksBets.js twice (9am + 12:30pm refresh) is safe — portfolio cap
enforced on total capital deployed that day, not per-run.

---

## Risk Management

### Protection Rules — ksBets.js pre-game (as of 2026-04-25)

| Rule | Condition | Rationale |
|------|-----------|-----------|
| **A** | Ban NO bets where `market_mid ≥ 65 AND model_prob ≥ 0.50` | Both market and model say YES is favored — no conviction for NO. Single biggest loss-preventer: blocked ~$178 in Eduardo Rodriguez losses Apr 22. |
| **D** | Ban YES bets where `model_prob < 0.25 AND edge < 0.18` | Low-prob YES with thin edge. Waived if edge ≥ 18¢ (strong signal despite low absolute prob). |
| **E** | Ban NO bets where `market_mid < 15` | Market near-certain NO already — no exploitable edge to capture. |
| **F** | Ban NO bets where `strike ≤ 4` | Apr 2026 live data: strike=3 NO at 0% WR, strike=4 NO at 27.8% WR. Structurally bad segment. |

Removed: **B** (per-pitcher CAR cap — cut too much upside), **C** (strike=3 skip — 47% ROI in live data, was costing money).

**Rule A history**: The original GOVERNANCE.md condition was `model_prob ≤ 0.75` (wrong direction). The correct condition deployed in code is `model_prob ≥ 0.50` — banning NO bets where BOTH market AND model agree YES is favored. If model says NO wins outright (`model_prob < 0.50`), the bet passes regardless of market price.

### Risk Rules — liveMonitor.js (in-game)

### Daily Loss Limit

Automated — `DAILY_LOSS_LIMIT` env var (default $500). Tracked in `_dailyLoss`
variable in `liveMonitor.js`. Live trading stops immediately when hit.

Rule E extends this: -15% net drawdown halt also stops new bets. Whichever
triggers first wins.

### Correlated Kelly (Pitcher-Level Cap)

When multiple K-prop thresholds have edge for the same pitcher, total
exposure = max single-threshold Kelly. Implementation in
`correlatedKellyDivide()` in `lib/kelly.js`. This prevents 3-4× over-exposure
to one pitcher outcome.

### Spread Test Gate

Markets with wide spreads (typically thin liquidity) require larger raw edges
to qualify. Formula: `edge > spread/2 + 4¢`. A 12¢ spread market requires a
10¢ raw edge to qualify; a 4¢ spread market requires only a 6¢ raw edge.

### Lock Detection

Markets where `yes_ask >= 99¢` or `yes_bid <= 1¢` with `yes_ask <= 2¢` are
treated as resolved/locked and skipped. These are in-game markets that have
already settled.

### Leash Flag

When a pitcher's recent average pitch count < 85, they are flagged `⚠leash`.
These bets should be sized more conservatively since the E[BF] estimate may be
high if the team is actively managing their starter's workload.

---

## Deploy Process

The project runs on Railway via direct upload (`railway up`), **not** via a GitHub-connected deploy.

### Standard deploy command

```bash
railway variables set COMMIT_SHA=$(git rev-parse --short HEAD) && railway up --detach
```

**Why the variable set:** `liveMonitor.js` writes `process.env.COMMIT_SHA` into the heartbeat so the dashboard can display the running commit next to "THE CLOSER". Railway's built-in `${{RAILWAY_GIT_COMMIT_SHA}}` reference only resolves for git-connected deploys — it stays blank with `railway up`. Setting it manually before each deploy keeps the Closer status header accurate.

**Never `git push` as part of a deploy.** Git commits are separate operations, done only when explicitly requested.

---

## Code Structure — Shared Libraries

As of April 21, 2026 all shared logic is extracted into `lib/`. Scripts must
import from there; no duplication allowed.

| Module | What it provides |
|--------|-----------------|
| `lib/strikeout-model.js` | `NB_R`, `LEAGUE_*` constants, `nbCDF`, `pAtLeast`, `ipToDecimal` |
| `lib/cli-args.js` | `parseArgs(schema)` — unified CLI flag parser (type-safe, camelCase) |
| `lib/utils.js` | `safeJson`, `todayISO`, `roundTo`, `winRate`, `fmtShort` |
| `lib/analytics.js` | `computeModeSummary`, `computeCalibration`, `computeBankrollRollup`, `runningBankroll` |
| `lib/mlb-live.js` | `mlbFetch` (25s TTL cache), `extractStarterFromBoxscore` |
| `lib/db.js` | Turso/libSQL client |
| `lib/kalshi.js` | Full Kalshi REST + WS client: `getAuthHeaders`, `placeOrder`, `getOrderbook`, `amendOrder`, `cancelAllOrders`, `getSettlements` etc. |
| `lib/kelly.js` | `kellySizing`, `correlatedKellyDivide`, `capitalAtRisk` |
| `lib/parkFactors.js` | Park K-rate multipliers |
| `lib/umpireFactors.js` | HP umpire K% multipliers (updated 2026-04-23) |
| `lib/weather.js` | Game-day weather multipliers |
| `lib/kalshiWs.js` | WebSocket fill stream daemon |
| `lib/wsFillApplier.js` | WS event → DB update |
| `lib/sseBus.js` | Server-Sent Events bus for dashboard real-time updates |

---

## Known Bugs Fixed — 2026-05-12

### 1. Bankroll did not compound — `morning_bankroll` reset to a static value every day
`lib/bankrollState.js` → `initBankrollState()` seeded the daily `bankroll_state` row from
(live Kalshi balance) → `users.starting_bankroll` → `STARTING_BANKROLL` env. In paper mode
there is no live balance, so every day's `morning_bankroll` snapped back to the static
fallback (it had been frozen at $513.54 since May 3) — green/red nights never carried forward,
because `realized_pnl` is only written by `addRealized()` on `paper=0` settlements and paper
P&L lives only in `ks_bets.pnl`.

**Fix:** when no live balance is available, `initBankrollState()` now rolls forward from the
prior `bankroll_state` row: `new morning_bankroll = prev.morning_bankroll + SUM(ks_bets.pnl)`
for the prior `bet_date` (settled, non-void). Falls back to `users.starting_bankroll` then
`STARTING_BANKROLL` env only if there is no prior day. Logs a `[bankrollState] rollover …` line.
`INSERT OR IGNORE` semantics are unchanged, so a redeploy mid-day never overwrites the day's
anchor — the rollover only sets the value when a brand-new day's row is first created (server
start / the 1:03am ET cron). Live mode is unchanged: it still prefers the real Kalshi balance.

> Manual override: to force a specific morning bankroll, `UPDATE bankroll_state SET
> morning_bankroll=?, available_pool=? + realized_pnl - committed_capital WHERE bet_date=?`
> (and optionally `users.starting_bankroll` for the fallback). The next day will then compound
> off that value. (Done 2026-05-12: base reset to $5,000 + prior-day P&L = $5,198.67.)

### 2. `postGameAttribution.js` crashed every cycle on nonexistent `ks_bets.mode` column
The attribution/calibration job `SELECT`ed `mode` from `ks_bets` — that column doesn't exist
(the columns are `bet_mode` and `live_bet`; `mode` was never referenced anywhere else in the
file). Result: `[attribution] fatal: no such column: mode` on every run, so per-pitcher λ
accuracy / prob-calibration logging and the `runCalibration()` trigger never executed.

**Fix:** removed `mode` from the SELECT list. (The `(paper = 0 OR paper IS NULL)` filter is
left as-is — in pure paper mode this still produces "No settled bets"; broadening it would
change which bets feed `runCalibration()`, out of scope for the crash fix.)

### 3. Postponement-cancel query referenced wrong `games` column names
`server/scheduler.js` 4pm/5pm ET postponement passes queried `games.home_pitcher_id` /
`games.away_pitcher_id` — the actual columns are `pitcher_home_id` / `pitcher_away_id` (the
`home_pitcher_id`/`away_pitcher_id` names live on the `game_pulse` table, not `games`). Result:
`[scheduler] postponement cancel error: no such column: g.home_pitcher_id` — non-fatal (the
inner UPDATE has its own `.catch`), but pending bets for postponed games were never cancelled.

**Fix:** `g.home_pitcher_id` → `g.pitcher_home_id`, `g.away_pitcher_id` → `g.pitcher_away_id`
(matches the correct usage already in `ksBets.js:1618`).

---

## Known Bugs Fixed — 2026-04-25

### 1. Kelly NO-bet formula — all NO bets returned betSize=0

**Bug**: `kellySizing()` computed `feeEdge = modelProb × winPerUnit - (1-modelProb) × losePerUnit`
for ALL bets. Since `modelProb` is always P(YES wins), for NO bets P(win) = `1-modelProb`.
Using `modelProb` directly gave P(win) ≈ 0.18 for a strong NO bet (where P(win) should
be 0.82), so `feeEdge` was deeply negative and `betSize` returned 0 for every NO bet.

**Fix** (`lib/kelly.js`):
```js
const probWin = side === 'YES' ? modelProb : (1 - modelProb)
const feeEdge = probWin * winPerUnit - (1 - probWin) * losePerUnit
```

**Impact**: Before fix, the Kelly system never placed any NO bets. All NO bets in the
DB from Apr 21-24 (kf=0.00%) were placed by the old edge-weighted system. After fix,
NO bets get proper Kelly fractions (typically 2-12% sized Kelly after discounts).

### 2. scheduler.js stale cleanup — all bet_schedule rows marked 'error' on Railway redeploy

**Bug**: On startup, the cleanup marked ALL 'fired' rows older than 4h as `status='error'`
unconditionally. When Railway redeployed mid-day, all 30+ 'fired' rows (successfully
placed bets from 8:35 AM) got marked 'error', making the dashboard look broken when
54 real bets with real Kalshi order IDs existed.

**Fix**: Two-query cleanup distinguishes placed vs. unplaced bets:
```sql
-- Rows with matching ks_bets → mark done (bets were placed, just status update was lost)
UPDATE bet_schedule SET status='done' WHERE status='fired' AND fired_at < ?
  AND EXISTS (SELECT 1 FROM ks_bets k WHERE k.bet_date = bet_schedule.bet_date
              AND k.pitcher_id = bet_schedule.pitcher_id AND k.live_bet = 0)

-- Rows without matching ks_bets → mark error (process truly never completed)
UPDATE bet_schedule SET status='error' WHERE status='fired' AND fired_at < ?
  AND NOT EXISTS (SELECT 1 FROM ks_bets k WHERE k.bet_date = bet_schedule.bet_date
                  AND k.pitcher_id = bet_schedule.pitcher_id AND k.live_bet = 0)
```

Also fixed: the `status='done'` update after successful bet placement was
fire-and-forget (unawaited). Now `await`ed so the status persists before the
next iteration.

---

## Known Bugs Fixed — 2026-04-23

Seven bugs identified and fixed from analysis of all historical transactions:

1. **Shrinkage removed** — `strikeoutEdge.js` was discounting raw model probability
   by 7% at K≥7, 5% at K≥8, 3% at K≥9. Live data showed the opposite: the model
   under-predicts the upper tail. Removed; raw `pAtLeast()` used directly.

2. **Rule C removed** — K=3 markets had 47% ROI in live data. Skipping them was
   costing money. Filter removed from `ksBets.js`.

3. **Duplicate logging (upsert conflict key mismatch)** — `db.upsert()` was called
   with conflict keys `['bet_date', 'pitcher_name', 'strike', 'side', 'live_bet', 'user_id']`
   but the table's UNIQUE constraint is on the first 5 columns only (no `user_id`).
   SQLite requires conflict keys to exactly match an existing constraint — if they
   don't match, it inserts a fresh row on every call. This produced 33× duplicate
   rows for deGrom K≥8 YES on Apr 23. Fixed: `user_id` removed from conflict keys
   in both `ksBets.js` and `liveMonitor.js`.

4. **NO bet mid-game lock** — `liveMonitor.js` was settling NO bets as losses the
   moment `currentKs >= bet.strike` mid-game. Box scores can briefly lag or correct,
   and this lock was permanent (no reverse path). Removed; NO bets now settle only
   at game-end via `settleAndNotifyGame()` using Kalshi's actual revenue data.

5. **filled_contracts falsy-zero** — `bet.filled_contracts ?? fallback` treated
   `filled_contracts = 0` as falsy and used the wrong fallback for P&L math.
   Fixed to `bet.filled_contracts != null ? bet.filled_contracts : fallback`.
   Applied in `ksBets.js`, `liveMonitor.js` (cover and dead settlement blocks,
   and `settleAndNotifyGame`).

6. **2× sizing for edge ≥ 15¢ in-game bets** — Historical simulation showed
   +$1,909 gain across 100 bets (Apr 21-23) by doubling position when edge ≥ 15¢.
   Implemented in `liveMonitor.js executeBet` as `edgeMult = q.edge >= 0.15 ? 2 : 1`.

7. **Umpire table stale** — 13 retired/suspended/deceased umps removed. Magnitude
   cap reduced to ±0.05 (was ±0.08, causing negative ROI on expanded-zone bets).

---

## The 8 Improvements

### 1. Park Factors (`lib/parkFactors.js`)
**What**: K-rate multiplier by home team, applied to λ.
**Why**: Park environment has a material effect on pitcher K-rate independent
of the pitcher and opponent. Coors Field thin air measurably reduces pitch
break (0.92×), while Petco Park's heavy marine air adds ~6% K-rate (1.06×).
Ignoring park in a K-prop model means systematically overpricing K-heavy
pitchers at Coors and underpricing at Petco.

### 2. Correlated Kelly Fix (`lib/kelly.js` — `correlatedKellyDivide`)
**What**: When a pitcher has edges at 5+, 6+, 7+ Ks simultaneously, treat all
bets as one correlated unit (total exposure = max single-threshold Kelly).
**Why**: These bets have near-perfect positive correlation — if the pitcher
throws 8K, every YES bet below 8 wins. Sizing each at full Kelly would 3-4×
the actual capital exposure for a single pitcher outcome. The correlated fix
caps total exposure at max single-threshold Kelly and divides proportionally.

### 3. Spread-Adjusted Edge Threshold
**What**: `edge > spread/2 + MIN_EDGE_FLOOR (4¢)` instead of flat 5¢.
**Why**: A 10¢ spread market has a 5¢ half-spread "no man's land" around the
mid. A model edge of 5¢ in that market is entirely within the vig band. The
new formula requires clearance above the half-spread, so we only flag genuine
directional edges.

### 4. Weather Adjustment
**What**: Wind, temperature, and humidity multipliers applied to λ for outdoor
parks.
**Why**: Cold temperatures reduce spin rate (less break on sliders/curves →
fewer Ks). Strong winds disrupt pitch location. High humidity is slightly
favorable for whiff. Real effect sizes are small (2-4%) but systematic.

### 5. Umpire K% Adjustment (`lib/umpireFactors.js`)
**What**: HP umpire K-rate multiplier applied to λ. Fetched live from MLB Stats
API at startup.
**Why**: Umpire zone tendencies are among the most predictable game-day
factors. Consistent, empirically documented tendencies that the market often
doesn't fully price in.

### 6. Batting Order Position Weighting
**What**: Lineup K% weighted by expected plate appearances per batting order
position, rather than equal-weight average.
**Why**: A pitcher facing a lineup where the top 3 (who get the most PAs) are
high-K batters is meaningfully more dangerous than one where only the 8-9
slots are high-K.

### 7. Velocity Trend Signal
**What**: Compare current-season fb_velo to career average (2023-2025). Apply
1.03× boost for velo up >1 mph; 0.96× penalty for down >1.5 mph.
**Why**: Velocity is the leading indicator of stuff. When a pitcher gains
velocity, swing-and-miss tends to follow weeks later.

### 8. In-Game Live Model (The Closer)
**What**: Re-computes λ_remaining every 20 seconds using actual game state
(current Ks, IP, pitches thrown, BF). Only bets at ≥75% model_prob YES or
≤15% model_prob NO with ≥15-20¢ edge.
**Why**: Kalshi's in-game prices update slowly relative to actual game state.
A pitcher with 6 Ks through 4 innings will have K≥8 YES mis-priced for
several minutes while our live model already shows 80%+ probability. This
is the highest-ROI segment of the entire system.

---

## Improvement Roadmap

### Near-Term
- ~~**Kelly sizing for morning bets**~~: **DONE 2026-04-25** — `ksBets.js` now uses full Kelly pipeline with `correlatedKellyDivide()`, per-pitcher cap, portfolio cap, and opportunity discount. NO-bet formula bug also fixed.
- **lineup_source flag**: add `lineup_source` column to `ks_bets` to track
  whether each bet used posted lineups vs historical fallback. Needed to
  separate performance by lineup quality.
- **Platoon adjustment within lineup**: current implementation averages K% for
  the pitcher's hand; a deeper model would track which batters will actually
  face the pitcher in the first 2-3 times through the order.
- **Starter vs bullpen usage model**: some teams increasingly use starters as
  "bulk" 4-inning openers; a pitch-count survival model would give better E[BF].

### Medium-Term
- **Calibration refresh**: re-run r parameter calibration annually with newest
  season data; r=30 was calibrated on 2023-2025.
- **Umpire table refresh**: update `lib/umpireFactors.js` with new umps and
  refresh existing factors with 2025+ data annually before Opening Day.
- **Home/Away split for pitcher**: some pitchers have material home/away K%
  differences independent of park factors (comfort, travel fatigue).
- **Days of rest adjustment**: pitchers on normal rest (4-5 days) vs short rest
  vs extended rest have documented performance differences.

### Long-Term
- **Opposing lineup vs pitcher history**: some batters have strong individual
  matchup K% vs specific pitchers independent of platoon split.
- **Weather sub-conditions**: precipitation probability as a K-rate suppressor.
- **Market microstructure model**: model the true execution price accounting for
  fill probability at different price levels rather than using ask-1¢ flat.

---

## Known Limitations

1. **Career velocity requires 2023-2025 Savant data** — rookies and pitchers
   with limited MLB history will have no career velo baseline; velo_adj = 1.0.

2. **Umpire assignments not posted until day-of** — if running the model early
   (before ~11 AM ET), ump assignments may not be in the MLB API yet. The
   model defaults to 1.0 and logs "ump=TBD". Re-run after assignments post.

3. **Weather requires `OPENWEATHER_API_KEY`** — without it, weather_mult = 1.0
   silently. Set in `.env`.

4. **Lineup K% requires lineups to post** — official batting orders typically
   appear 3-4 hours before first pitch. Early-morning runs fall back to
   `historical_team_offense`. Run `fetchLineups.js` again after lineups post.

5. **Park factors are static 3-year averages** — they don't capture year-to-year
   park condition changes (fence moved, new humidor). Review annually.

6. **Correlated Kelly only handles intra-pitcher correlation** — cross-pitcher
   correlated exposure (two pitchers in the same game) is not modeled.

7. **NB r=30 calibrated on 2023-2025** — as pitch design, analytics, and
   bullpen usage evolve, the variance structure of starter K-counts may shift.
   Re-calibrate annually via `backtest.js`.

8. **In-game confidence = data completeness, not prediction quality** —
   the `confidence` label (`high/medium/low`) reflects how many starts are
   in the dataset, NOT how accurate the model is for that pitcher. Do not use
   confidence as a bet filter. Morning-bet `high` confidence showed 0% WR in
   early live data — the label is informational only.

---

# Strategy Registry & Paper Testing — May 2026

This section catalogues every strategy variant tried since the Kelly system went
live (Apr 25). Each entry covers: hypothesis, backtest setup, results, current
status, and decision history. Updated 2026-05-07.

## Active Strategies (currently firing)

### `pregame_normal` — Original Kelly K-prop bets
- **Status**: Live, real money (paper mode active currently per May 1 incident posture)
- **Description**: Production model from Apr 25 GOVERNANCE — 10-feature lambda
  (K9_career/season/L5, opp K%, park, weather, ump, TTO, velo, Savant) +
  NB r=30 distribution + Kelly sizing.
- **Recent performance**: Backtest of last 9 days Apr 28 → May 6 showed
  **+0.40¢ avg CLV across 112 fires** with 22.3% beat-rate. Marginal/flat.
  Per-bet ROI essentially zero.
- **Conclusion**: Edge has compressed. Not unprofitable but not the breakthrough.
- **Open question**: Is over-engineering (10 features) hurting vs simpler K9-only?

### `pregame_cross_strike` — Strategy B (intra-pitcher math arb)
- **Status**: Live, paper mode, validated initial signal
- **Hypothesis**: For a single pitcher's strike chain (5+, 6+, 7+, ...), the
  market-implied probabilities should lie on a smooth Poisson distribution.
  Strikes that deviate by 4-20¢ from the fit are mispriced; bet the cheap side.
- **Module**: `lib/crossStrikeCandidates.js`. Pure math, no pitcher data.
- **POC validation (May 5, 18 bets)**: 14W/4L = 78% win rate, +62% ROI.
- **Wide backtest (May 6, 75 fires across Apr 28 → May 5)**:
  - Win rate: 45.3% (regression from POC)
  - ROI: -15.9%
  - Most fires at high asks (>65¢) where fee math is hostile
  - One bad day (May 3) was 9 fires, all losses
- **Filter sweep findings**:
  - `resid≥6c`: 20 fires, 65% win, -8% ROI (best filter)
  - `resid≥8 + NO + ask≤75`: 13 fires, 77% win, +2.5% ROI per bet
  - Other filters didn't improve materially
- **CLV signal (May 6)**: 6 fires, +2.33¢ avg CLV, 100% beat the close.
  Strong CLV signal but P&L lagging.
- **Live config (betting_rules)**:
  - `cross_strike_enabled = 1`
  - `cross_strike_min_residual = 0.04`
  - `cross_strike_max_residual = 0.20`
  - `cross_strike_max_per_pitcher = 2`
  - `cross_strike_max_pct_bankroll = 0.03`
  - `cross_strike_tail_dollar_cap = 5`
  - `cross_strike_tail_ask_threshold = 25`
- **Decision**: Keep running, collect data via `shadow_cross_strike` table.
  No filter changes during paper test (preserve full candidate distribution).

### `pregame_fade_yes` — fade model  (⚠️ v3 REVERTED to v1+H-I on 2026-05-12 after OOS test)

> **2026-05-12 — v3 promotion reverted.** The true out-of-sample test
> (`scripts/v3HistoricalTest.mjs`, Mar 31–May 6, the 858-record window v3's filters
> were *not* designed on) showed every v3 filter except H-I **destroys** EV vs v1:
> H-H cost ~$42k, the K=6/K≥10-only strike filter ~$57k, v3 overall ~$68k vs v1.
> Only H-I (confidence > 0.3) was OOS-neutral/positive. **Conclusion: the May 7-10
> +59% lift was overfit to a 4-day sample.** `scripts/fireFadeModel.mjs` now defaults
> to `FADE_VARIANT='v1h'` = v1 (best-edge strike ≥6, per-pitcher cap 1) + H-I +
> news-check + the 5-20¢ edge band. Set `FADE_VARIANT=v3` (env var, no deploy needed)
> to restore the full promoted-v3 filter set — the v3 code path is preserved, just
> not the default.
>
> Also added 2026-05-12 to `scripts/fadeTestProgress.mjs`: per-strike-bucket breakdown
> (K=6 favorite-fade / K=7-9 mid / K≥10 tail) and per-ask-price breakdown — because
> K=6 and K≥10 are different products and the real edge may just be cheap tails.
> First read of those buckets on the May 7-11 paper sample: **K=6 +$642 (+58% ROI),
> K=7-9 −$2,279 (−91% ROI, the bulk of fires), K≥10 +$2,313 (+361% ROI).** Net +$676
> is K=6 + tail convexity *minus* a bleeding mid-strike bucket — watch K=7-9 under v1h.
>
> **Current prod state (2026-05-12 PM):** `FADE_VARIANT=v3` IS set on the worker
> (Railway env var) per operator decision — weighting the recent regime where K=7-9
> bled (−$2,279 / −91% ROI in the May 7-11 paper sample, which v3's strike filter
> skips) over the OOS test's verdict (which was built on the older Mar 31–May 6 data).
> It's paper-only, so this is a no-cost way to keep gathering v3-vs-v1h data; the
> per-strike/per-ask buckets in the 11:55pm fade report show both side by side, and
> `fireFadeModel.mjs` now logs every fire-time ladder to `fade_fire_snapshots` so any
> variant can be replayed cleanly once ~2-3 weeks of rows accumulate. Flip back with
> `FADE_VARIANT=v1h` (or delete the var — v1h is the code default).
>
> Everything below describes the v3 config as it stood when promoted; kept for history.

- **Status (pre-2026-05-12)**: Active paper test Day 5+. **THE PRIMARY VALIDATION TARGET.**
- **v3 cutover**: 2026-05-11 first fire (next morning).
- **Version history**:
  - v1 (5/7-5/10 morning): no filter, edge≥5c, ask≤50c, strike≥6
  - v2 (5/10 morning-evening, ~1 day): added H-H + H-I (avg_innings_l5≥5, confidence>0.3)
  - **v3 (5/10 evening onward)**: v2 + skip K=7,8,9 (only fire K=6 or K≥10)
- **Why v3 promoted same day as v2**: empirical evidence on 90-fire sample
  (Days 1-4 with duplication, ~45 unique) showed strike filter delivers an
  additional +$2,044 NET vs v2 ($2,181 saved on losses, only $137 forfeited).
  Strike 7-9 had **1 win in 31 fires (3.2% win rate)** — clearly market
  efficiency concentrates in the bell-curve middle. Same-day promotion
  justified by structural strength of the signal.
- **Hypothesis**: Public over-bets favorites' YES at low strikes. Markets
  systematically underprice high-K pitchers' tail strikes (7+, 8+, 9+).
  Buying YES at 15-40¢ asks pays 4-8× when pitchers deliver. ~32-38% win rate
  with that asymmetric payoff = +50-100% per-bet ROI.
- **Validation source**: 37-day extended backtest, Mar 31 → May 6, 1,056
  pitcher-games via Kalshi candle history + MLB game logs.
  - TRAIN half (18 days, Mar 31 → Apr 17): 80 fires, +74% ROI, $5K → $16,495 (+230%)
  - TEST half (19 days, Apr 18 → May 6, lock-box never tuned on): **95 fires, +127% ROI, $5K → $29,030 (+481%)**
  - Max drawdown: 6.6% (test) / 13.1% (train)
- **Configuration (v3 LOCKED 2026-05-10 evening)**:
  - **Model**: Negative Binomial r=8, lambda = K9_l5 × avgIP_l5 / 9
  - **Filter**: YES-only, edge ≥5¢, ask ≤50¢
  - **NEW v3 filter — STRIKE**: only fire K=6 OR K≥10 (skip 7,8,9)
  - **Per-pitcher cap = 1**
  - **v2 filter (still active) — H-H**: skip if `pitcher_signals.avg_innings_l5 < 5.0`
  - **v2 filter (still active) — H-I**: skip if `pitcher_signals.confidence ≤ 0.3`
  - **Sizing**: 1% bankroll base × edge multiplier (1×–5×), $200/bet hard cap
  - **Volume cap**: 10% of 24h volume (deployed 2026-05-08)
  - **No top-N daily cap** (fire all qualifying candidates)
- **Hypothesis sweep results (TRAIN-only Δ ROI vs baseline)**:
  | tweak | Δ ROI | kept? |
  |---|---|---|
  | per-pitcher cap=1 | +31% | YES (the breakthrough) |
  | strike ≥6 floor | +19% | YES |
  | NB r=8 distribution | +17% | YES |
  | edge-weighted sizing 5× | +6% ROI / +56% return | YES |
  | edge ≥12c | +7% | NO (raised regret of skipping good fires) |
  | ask ≤30c | +29% (alone, redundant) | NO (subsumed by strike≥6) |
  | window 7/10 | 0% | NO (no signal) |
  | skip rookies (<3 starts) | -25% | NO (HURTS — rookies are valuable longshots) |
  | top-1 per day | -6% | NO |
  | top-3 per day | -23% | NO |
  | stop-loss 2-day streak | -12% | NO |
- **Compounding simulation, $5K starting bankroll**:
  | sizing | 36-day final | return | max DD |
  |---|---|---|---|
  | 1% | $9,744 | +95% | 12% |
  | 2% | $15,767 | +215% | 21% |
  | 3% | $19,377 | +288% | 27% |
  | 5% | $21,352 | +327% | 24% |
- **Realistic deflated forecast (after slippage, selection bias, liquidity caps)**:
  - 36 days: $5K → $15-22K (50% of backtest)
  - 165-day MLB season: $5K → $50-150K
- **Today's hypothetical Day-0 (May 6, retroactive on real markets)**: 6 fires,
  0/6 settled, 1 pending. -$990 hypothetical, -19.8% bankroll. **Validated
  variance is real — backtest had 24% zero-win days.** Edges were 30+¢ on
  multiple losers (Schultz, McCullers, Wheeler), suggesting markets had
  private info on pitch-count limits / rookie status that our model lacks.
- **Live system**:
  - Fire script: `scripts/fireFadeModel.mjs` (every 30 min, 11 AM – 11 PM ET)
  - Strategy mode: `pregame_fade_yes` added to `lib/strategyMode.js`
  - Discord alert per fire (pitcher, strike, edge, sizing rationale)
  - Comprehensive shadow log: `scripts/logFadeShadow.mjs` (1:40 AM ET nightly)
  - Daily progress to Discord: `scripts/fadeTestProgress.mjs` (11:55 PM ET)
  - Site panel: `/api/ks/fade-test` + `fade-test-panel` div in `index.html`
- **Decision gates**:
  - **Day 7 (May 13)**: sanity check — win rate ≥25%, direction positive
  - **Day 14 (May 20)**: real-money go/no-go — ROI within 50% of +127% test backtest
  - **Day 30 (June 5)**: scale-up — ROI within 75%, ready for full sizing

## Active Shadow Loggers (data-only, no firing)

These accumulate candidate data nightly so future model variants can be
backtested as a single SQL query against the captured data.

### `shadow_cross_strike`
- **Started**: 2026-05-06
- **Coverage**: Apr 28 → today (1,113 candidate rows, 911 settled)
- **Cron**: 1:30 AM ET daily (`scripts/logCrossStrikeShadow.mjs`)
- **What it captures**: Every Cross-Strike candidate (whether fired or not)
  with full Poisson + NB fits, residual, market data, would_fire flag,
  filter reason, outcome. Lets us run any new filter sweep instantly.

### `shadow_cross_strike_total`
- **Started**: 2026-05-06
- **Coverage**: Apr 28 → today (1,180 candidate rows)
- **Cron**: 1:35 AM ET daily (`scripts/logCrossStrikeTotalShadow.mjs`)
- **What it captures**: Cross-Strike math applied to KXMLBTOTAL (game total
  runs) ladders — same Poisson-residual logic on a different market.
- **Findings so far**: 76% win rate but most fires at high asks (>65¢);
  filtered ROI marginal (+2.5% on 13 fires with strict filter).
  **Decided not worth firing** but worth the passive data capture.

### `fade_paper_test_candidates` (NEW 2026-05-07)
- **Coverage**: Apr 28+ via backfill once `logFadeShadow.mjs` runs
- **Cron**: 1:40 AM ET daily (`scripts/logFadeShadow.mjs`)
- **What it captures**: For every starter every day, every strike, every side:
  - Full strike chain (yes_bid/ask/no_bid/no_ask/market_mid/spread)
  - K9 across 6 windows (l3, l5, l7, l10, season, career)
  - Lambda + model_prob + edge under 6 model variants:
    - `poisson_l5` (current production approximation)
    - `nb8_l5` (THE IDEAL — what we fire on)
    - `nb10_l5`, `nb12_l5` (dispersion variants)
    - `nb8_l10` (longer-window variant)
    - `poisson_career` (alternative anchor)
  - `would_fire` flag per filter config + specific block reason
  - Outcome (actual K, IP, BF) joined from `pitcher_recent_starts`
  - Cross-link to actual ks_bets row when fired
  - Pre-computed `won_under_ideal` and `pnl_at_default_size` for fast queries
- **Schema columns left null on backfill** (require live joins): `hand`,
  `days_rest`, `season_start_num`, `opp_k_pct`, `ump_name`, `ump_k_factor`,
  `temp_f`, `wind_dir`, `wind_speed`, `pitcher_team_won`. The IDEAL config
  doesn't use these — they're future enrichment.

## Retired / Killed Strategies

### `pregame_inversion` — Bet against model when ace is overpriced
- **Hypothesis**: When KS market overpays on ace YES (public bias), bet NO.
  Same direction as Cross-Strike's NO arm but at a different filter.
- **History**:
  - Apr 27 onward: live in production
  - Backtest Apr 28 → May 5: 8 fires, -0.94¢ avg CLV, 37.5% beat rate
  - Inverted-K cross-market test (May 6): -43.7% ROI on 35 fires (failed)
- **Status**: **Functionally retired**. Still live in production but
  generating ~0 fires under current filters. CLV signal trending negative.
  Will not be promoted to main strategy.
- **Decision (2026-05-06)**: User explicitly rejected lowering inversion
  gate to create more volume. Decided to track via shadow audits only.

### Cross-market K↔TOTAL (inverted framing)
- **Hypothesis (May 6)**: TOTAL market is smarter than KS market (more depth,
  tighter spreads). Use TOTAL-implied per-pitcher runs to derive expected K
  rate, compare to KS market mid, bet KS where divergence is large.
- **Backtest (35 fires)**: 22.9% win rate, **-43.7% ROI**. FAILED.
- **Why it failed**: TOTAL reflects offense quality more than pitcher quality.
  50/50 starter-runs split is too crude. KS market actually had better K
  predictions than TOTAL-derived K rates in the validation window.
- **Status**: **DEAD**. No further work unless a sophisticated runs-allocation
  model (with bullpen ERA, opp offense, park) gets built first.

### Cross-Strike-Total firing (Strategy on KXMLBTOTAL ladder)
- **Hypothesis (May 6)**: Apply Cross-Strike math to game total runs ladder.
  TOTAL ladder has 5× depth and 6× tighter spreads vs KS — less competition,
  bigger edge per bet.
- **Backtest (46 fires across 23 games)**: 76% win rate, -4.4% ROI baseline.
  Filtered to 13 fires (resid≥8 + NO + ask≤75): 77% win, +2.5% per-bet ROI.
- **Status**: **Not worth firing** at +2.5% ROI on small sample. User said
  "not worth it for 2.5% roi". Shadow data still being collected nightly.
- **Will revisit if**: shadow data shows a stronger filter combination after
  more samples accumulate.

### Single-Pick (top-1/day fade)
- **Hypothesis**: Pick the SINGLE biggest mispricing per day, bet ONE strike
  with high conviction. Backtest on first attempt: 7 fires, 43% win, +32% ROI.
- **Status**: **Subsumed by `pregame_fade_yes`**. The full backtest revealed
  that top-5/day with per-pitcher cap=1 outperforms top-1/day (because more
  diversification across pitchers). The "concentrated single pick" intuition
  was right in spirit (one strike per pitcher) but wrong in concentration
  (we want 5 different pitchers, not 1).

## Data Infrastructure Built (May 1 → May 7)

### Tables
| table | rows | purpose |
|---|---|---|
| `market_snapshots` | 670K+ | Per-strike bid/ask/mid/volume, every poll, all pitchers |
| `pitcher_recent_starts` | 859 (was 676) | Outcomes for every starter — backfilled to close gap |
| `pitcher_edge_cache` | 230 | Per-pitcher daily edge calc with `edges_json` |
| `shadow_cross_strike` | 1,113 | Cross-strike candidate registry |
| `shadow_cross_strike_total` | 1,180 | Cross-strike-on-TOTAL candidate registry |
| `fade_paper_test_candidates` | (NEW 2026-05-07) | Comprehensive fade-model multi-variant log |
| `closing_line_cents` / `clv_cents` cols on `ks_bets` | per-fire | CLV writeback (sharpness metric) |

### Cron Schedule (current state)
| time (ET) | what | script |
|---|---|---|
| 11:00 PM | EOD report (existing) | scheduler.js inline |
| **11:45 PM** | **CLV writeback (NEW May 6)** | `scripts/backtestCLV.mjs` |
| 11:55 PM | Fade test daily progress | `scripts/fadeTestProgress.mjs` |
| 1:15 AM | Outcome harvest (NEW May 6) | `scripts/harvestOutcomes.mjs` |
| 1:30 AM | Cross-strike shadow log (NEW May 6) | `scripts/logCrossStrikeShadow.mjs` |
| 1:35 AM | Cross-strike-total shadow (NEW May 6) | `scripts/logCrossStrikeTotalShadow.mjs` |
| **1:40 AM** | **Fade comprehensive shadow (NEW May 7)** | `scripts/logFadeShadow.mjs` |
| 11:00 PM cron | Dynamic blocklist eval (existing) | `lib/dynamicBlocklist.js` |
| every */30 11-23 | **Fade fire (NEW May 7)** | `scripts/fireFadeModel.mjs` |

### One-time builds
- **`buildRawBacktestData.mjs`** (May 6) — pulls ALL settled KXMLBKS markets
  via Kalshi `/markets?status=settled` paginated, then candle history per
  market via `/series/{KXMLBKS}/markets/{ticker}/candlesticks`. Caches MLB
  game logs + candle data to disk. **858 records persisted to
  `.rawBacktestData.json`** covering 37 days (Mar 31 → May 6). Reusable for
  any future modeling experiment without re-pulling external data.

## Backtests Run (chronological)

| date | what | result | decision |
|---|---|---|---|
| 2026-05-05 | Cross-Strike POC (May 4-5, 18 bets) | 78% win, +62% ROI | Promote to live, paper |
| 2026-05-06 | Cross-Strike wide backtest (75 fires, 9 days) | 45% win, -16% ROI | Variance — keep collecting |
| 2026-05-06 | Cross-Strike filter sweep | resid≥6 = best filter | Don't change rules during paper test |
| 2026-05-06 | Cross-Strike-Total backtest (46 fires, 23 games) | 76% win, -4.4% ROI | Don't fire; passive shadow only |
| 2026-05-06 | Cross-Strike-Total filter sweep | resid≥8+NO+ask≤75 = +2.5% ROI on 13 fires | Marginal, not worth firing |
| 2026-05-06 | Cross-market K↔TOTAL | 53% direction correct, fails on big divergences | Direction was wrong; TOTAL is smarter |
| 2026-05-06 | Inverted-K (TOTAL → KS) | 22.9% win, -43.7% ROI | DEAD |
| 2026-05-06 | CLV writeback + backtest (151 historical fires) | pregame_normal: +0.40¢ avg CLV / 22% beat. live: +4.48¢ / 33% beat | Confirms current strategies are flat or marginally sharp |
| 2026-05-07 | Single-Pick Public Fade (small backtest) | 25 fires, 40% win, +110% ROI on small sample | Promising — extend |
| 2026-05-07 | **Extended Fade backtest (1,056 pitcher-games, 37 days)** | **TRAIN +74% ROI / TEST +127% ROI** | **PROMOTE: launch paper test** |
| 2026-05-07 | Hypothesis sweep on extended data | per_pitcher_cap=1, strike≥6, NB r=8 are real wins | Lock these into IDEAL config |
| 2026-05-07 | Compounding simulation ($5K, multiple sizings) | 3% per bet sweet spot, +288% over 36 days | 3% per bet for paper test |

## Bug Fixes (May 1 → May 7)

### `lib/kalshi.js` `getOrderbook` — silent null bids (FIXED 2026-05-06)
- **Bug**: Kalshi API now returns `orderbook_fp` shape with `yes_dollars`/`no_dollars`
  keys; old code parsed `orderbook.yes`/`no` and silently returned null bids.
- **Impact**: `availableDepth()` returned 0 for ALL markets. Liquidity-capture
  feature in ksBets.js:927 (post-only depth check) silently no-op'd.
  liveMonitor.js:830 in-game depth cap also silent no-op.
- **Fix**: Detect `orderbook_fp` shape, parse `yes_dollars` array, convert
  dollar amounts to contract counts (qty / price = contracts).

### Paper-flag bug (RECURRING, fixed twice in May)
- **Pattern**: Synthetic paper-XXX rows getting flagged `paper=0` by various
  startup/cleanup paths.
- **Fix locations**:
  - May 1: server/index.js startup backfill `WHERE order_id IS NULL OR order_id NOT LIKE 'paper-%'`
  - May 3: scripts/live/ksBets.js contra-test path hardcoded paper:0 → conditional
- **Hardening**: Added paper-flag-sweep cron (every minute, auto-corrects)

### Cross-strike `strategy_mode` propagation (FIXED 2026-05-06)
- Upsert was hardcoding `validateStrategyMode(e._inverted ? PREGAME_INVERSION : PREGAME_NORMAL)`
- Cross-strike candidates losing their `pregame_cross_strike` mode
- Fix: `validateStrategyMode(e.strategy_mode ?? (e._inverted ? ... : ...))`

### Various Cross-Strike model bugs (FIXED 2026-05-06 in same session)
- `gameLabel` undefined → renamed `_gameLabel`
- `oppKPct` typo → `oppKpct`
- `starts.length` undefined → use destructured `nStarts`
- `careerK9` undefined in scope → use `k9_career`
- `model_prob = c.cross_strike_market_prob` (Kelly produced 0 size) →
  changed to `c.cross_strike_fit_prob` (correct conviction)

## Key Decisions Log (chronological, May)

| date | decision | rationale |
|---|---|---|
| May 1 | Paper-mode incident → live trading paused, $27.33 loss | Wrapper `lib/kalshi.js` was uncommitted; Railway ran old code |
| May 3 | Recon watchdog deployed (5-min cron) | Detect Kalshi/DB mismatch automatically |
| May 5 | Cross-Strike promoted to live (paper) | POC results too strong to leave on shelf |
| May 6 | Don't lower inversion gate | User: "would not lower the real-money gate tonight just to create inversion volume" |
| May 6 | CLV / outcome harvest infrastructure | Need sharpness measurement for any strategy |
| May 6 | Cross-Strike-Total: collect data passively only | +2.5% ROI not worth firing complexity |
| May 7 | IDEAL fade config locked: NB r=8, K9_l5, strike≥6, per-pitcher cap=1, edge-weighted | Best out-of-sample TEST result on 37-day backtest |
| May 7 | Paper test, NO real money for 14 days | Day-14 (May 20) is decision gate |
| May 7 | NO daily fire cap (user request) | Fire all qualifying candidates; per-pitcher cap=1 still applies |
| May 7 | Multiple-sizing tracking | Log hypothetical P&L under 6 sizings (1%/2%/3% flat, edge-weighted, fixed $50/$100) |
| May 7 | NO kill switch (user request) | Don't auto-pause on bad streak |
| May 8 | Volume cap deployed (10% of 24h vol) | Realistic execution sizing; eliminates inflated paper P&L |
| May 8 | Day 1 retroactive cap | Updated 5 of 9 Day 1 fires to capped sizes; bankroll $5,659 → $6,110 |
| May 9 | Cross-strike-total declared not-worth-firing | +2.5% ROI on tiny sample; shadow data only |
| May 10 | **H-H + H-I promoted to live as v2 fade filter** | 4-day evidence: +$1,083 vs unfiltered baseline. v2 active 2026-05-11 first fire. All other variants continue tracked via nightly filter sweep. |
| May 10 | Day-14 decision criteria locked | See "What We're Looking For" section. ROI ≥15%, win rate ≥25%, drawdown <35% required for any real-money deployment |
| **May 10 evening** | **H-N (strike filter K=6 OR K≥10) PROMOTED to v3** | Same-day as v2 due to overwhelming empirical signal: K=7-9 had 1W/30L in 4 days (3.2% win rate, -$2,044 net). v3 = v2 + skip K=7-9. v2 effectively ran for one fire-cycle. Structural rationale: market efficiency concentrates in bell-curve middle. |
| May 11 | **Settlement-frontrun strategy KILLED** | 174-game backtest (`scripts/settlementFrontrunBacktest.mjs`): mean gross edge at +30s post-substitution = 0.01¢, 99.2% of strikes at ≤0¢. Kalshi MMs already move on the same upstream signals (broadcast video, bullpen warming) before MLB Stats API publishes the sub event. No captureable window. Do not rebuild on feed/live signal. |
| May 11 | **F5 adjacent market test started (data collection only)** | New market avenue (KXMLBF5TOTAL first-5-innings total runs). 174-game Kalshi backtest showed marginal NO-side edge at wing strikes (≥5.5, ≥6.5) but small sample. Analytical model upgrade test (v2: NB(r=4) + park run factor + per-team bullpen ERA + weather, 8,557 games 2021-2024) FAILED to improve Brier — features add ~0pp. Sportsbook lines are sharp; Kalshi-specific edge needs Kalshi-specific data. Started 10-min snapshot capture cron. **No real money. No live bets. Forward data only.** Day-14 decision: 2026-05-25. |

## What We're Looking For — Decision Criteria (added 2026-05-10)

The fade v2 paper test runs through **2026-05-20 (Day 14 from launch)**. At that
point we make a decision about deploying real money. Specific criteria:

### Tier 1 — Required for ANY real-money decision
1. **Win rate ≥ 25%** on v2 fires across the test window
2. **Per-bet ROI ≥ +15%** (deflated forward expectation; backtest was +50-100%)
3. **Max drawdown < 35%** of starting bankroll at any point
4. **No structural failure** — strategy works through varied weather/parks/league trends

### Tier 2 — Required for FULL-SIZE deployment (else half-size)
5. **Cumulative bankroll ≥ +30%** by Day 14 ($5,000 → $6,500+)
6. **No more than 4 consecutive zero-win days**
7. **CLV positive** averaged across all fires (we beat the closing line)

### Tier 3 — Stretch goals (would justify aggressive scaling)
8. Cumulative ≥ +60% by Day 14 ($5,000 → $8,000+)
9. Win rate ≥ 32% (matches backtest expectation)
10. At least one alternate filter combination that beats v2 by another +20%
    (suggests further refinement headroom)

### What we're NOT requiring
- Specific number of fires per day — varies with slate quality
- Particular pitcher mix — variance is fine
- Any single big winner — strategy is structurally about asymmetric payoffs

### Tracking infrastructure (active)
- **Daily filter sweep** (`scripts/dailyFilterSweep.mjs`, 12 AM ET cron) compares
  v2 LIVE vs all alternative filter combos. Discord post nightly.
- **Comprehensive shadow log** (`fade_paper_test_candidates`) captures every
  candidate (fired or not) under 6+ model variants. Day 14 sweep will be a
  single SQL query.
- **CLV writeback** populates `closing_line_cents` and `clv_cents` on every fire.
- **Outcome harvest** (1:15 AM ET) ensures `pitcher_recent_starts` has every
  starter's K count by next morning.
- **Intel backfill** (12:30 AM ET) refreshes pitcher_signals + pitcher_edge_cache
  joins on shadow log so filter tests have current data.

---

## F5 Adjacent Market Test (started 2026-05-11)

**Status: data collection only — NO live bets, NO real money. Decision date 2026-05-25 (14 days forward).**

### Question
Does Kalshi's `KXMLBF5TOTAL` market (first-5-innings total runs, 7 strikes per
game: >0.5 … >6.5) contain an exploitable mispricing on the wing strikes
(>5.5, >6.5) that our analytical run model can capture?

### What's already been investigated and ruled out
- **Settlement-frontrun on `KXMLBKS`** (buy NO above final-K after starter pull):
  killed 2026-05-11. Market closes the gap within 30s of the MLB Stats API
  sub-event; mean post-sub edge = 0.01¢. (See `scripts/settlementFrontrunBacktest.mjs`.)
- **Analytical model improvement** (NB(r=4) + park run factor + per-team
  bullpen ERA + weather) on 8,557-game historical dataset: Brier scores
  essentially unchanged vs starters-only baseline (Δ < 0.001). Features add
  no signal on F5 lines. Sportsbook lines are sharp.
  (See `scripts/f5BacktestV2.mjs`, `/tmp/f5_v2_summary.txt`.)

### What we're testing now
- **Kalshi-specific spread**, not model quality. Hypothesis: Kalshi NO ask on
  wing strikes (>5.5, >6.5) is systematically tighter than fair value because
  liquidity concentrates on the main line.
- v1 Kalshi 14-day backtest (`scripts/f5Backtest.mjs`): NO @ edge ≥10% returned
  +3.2% net ROI on 265 bets across 154 games (Apr 27 – May 10). Promising but
  small sample, within-game correlation inflates effective N.

### Active collection
- **Cron**: `*/10 10-23 * * * America/New_York` runs `scripts/captureF5Snapshots.mjs`.
- **Table**: `f5_market_snapshots` (schema in `db/schema.sql`). One row per
  (ticker × poll). Captures yes_bid, yes_ask, volume_24h, open_interest,
  spread, market status.
- **No bets fired.** Production cron is read-only on Kalshi.

### Day-14 decision (2026-05-25)
Re-run the wing-strike NO edge analysis on the Kalshi-specific forward data:
- If NO @ edge≥10% net ROI ≥ +5% over ≥150 bets → build live system with
  small caps ($50/bet) and the same paper-test framework as fade v3.
- If +0–5% → keep collecting, extend test window 14 more days.
- If ≤0% → kill the strategy, redirect data table to whatever's next.

### What success looks like (and what failure looks like)
- **Success**: forward Kalshi data confirms wing-strike NO mispricing is
  structural (not a 14-day artifact).
- **Failure**: the v1 +3.2% was sampling noise OR the mispricing existed
  briefly and has since been arbed out by MMs.

## Open Hypotheses (to test against shadow data over coming weeks)

These are NOT being applied to the live IDEAL config. They will be tested
retrospectively against `fade_paper_test_candidates` once enough data accrues.

### H-A: Cap max edge at ~20-25¢
- **Why**: Today's 6 losing fires all had edges > 30¢. The market often has
  private info (pitch-count limits, rookie status) we don't. Filtering out
  super-high edges may improve win rate.
- **Test**: SQL query against `fade_paper_test_candidates` once N≥100 fires.

### H-B: K9 from career-anchored Bayesian shrinkage
- **Why**: K9_l5 has high variance (5 starts can swing K9 by ±2 from luck).
  Shrinking toward career K9 may improve lambda accuracy.
- **Test**: Add `k9_bayesian` variant to next shadow logger run.

### H-C: Park-adjusted strike floor
- **Why**: Coors games (high run, possibly low K) might benefit from strike ≥7
  vs Petco games at strike ≥6.
- **Test**: Once park_k_factor backfilled into shadow rows, run filter sweep.

### H-D: Multi-day rolling streak rules
- **Why**: Stop-loss after 2 consecutive losing days HURT in backtest (-12% ROI).
  But what about after 3 days? 4 days? Variable streak threshold.
- **Test**: Run streak-rule sweep on shadow data.

### H-E: NO-side fade (currently disabled)
- **Why**: We tested NO-side and found it -100% on small sample (4 fires).
  But that was at our specific filter set. Different filter (e.g., low ask,
  high market_mid YES) might work.
- **Test**: NO-side variant with focused filter on shadow data.

### H-F: Cross-game correlation hedging
- **Why**: Same-day games are correlated (weather, league-wide K trend).
  Fading a TOTAL UNDER on a same-day high-K-correlation game might reduce variance.
- **Test**: Backtest correlated portfolios on extended data.

### H-G: Time-of-fire window
- **Why**: We fire at T-60. Closing line vs T-60 line might differ 1-3¢.
  Maybe T-30 is better (closer to true close, but markets thinner).
- **Test**: Run fire script at multiple time points, compare CLV.

### H-H: Skip pitchers with avg_innings_l5 < 5.0  ✅ PROMOTED TO LIVE 2026-05-11
**Promoted to live filter on 2026-05-11.** Empirical evidence below; the v2
fade fire script applies this rule before generating any candidate. Continued
tracking of "what if we hadn't applied this" via the nightly filter sweep so
we know if the signal stays valid.


- **Why**: The fade model assumes pitchers go 5+ IP (lambda = K9_l5 × avgIP_l5 / 9).
  When a pitcher has been getting pulled early in recent starts, that lambda
  overstates expected K count. The pitcher exits before reaching the strike.
- **Source**: `pitcher_signals.avg_innings_l5` — already computed daily by
  production engine. Available BEFORE fire time. No future knowledge.
- **Empirical evidence (2026-05-07 → 2026-05-09, n=36 settled fade fires)**:
  - **All 4 winners had avg_innings_l5 ≥ 5.0** (Imanaga 6.2, Burrows 5.3, Vásquez 5.3, Holmes 5.9)
  - **10 losers had avg_innings_l5 < 5.0** — all lost when pitchers got pulled
    early (Painter 4.6→pulled 3.2IP, Strider 3.1→pulled 1IP, Freeland 4.0→4IP at Coors, Yesavage 4.5, Liberatore 4.9, Gore 4.5, Mlodzinski 4.7, Dollander 4.8, Rocker 4.6, Prielipp 4.7)
  - Counterfactual: skipping these 10 fires = **+$702 P&L improvement**, 0 wins forfeited
  - Net P&L on 36 fires: **$98 → $800 (8× improvement)**
- **Test on Day 14**: Run `WHERE avg_innings_l5 ≥ 5` filter against
  `fade_paper_test_candidates` shadow data once N ≥ 100 fires.
- **Confidence**: HIGH — small sample but clean separation (0 winners would be killed).

### H-I: Skip pitchers with production-engine confidence ≤ 0.3  ✅ PROMOTED TO LIVE 2026-05-11
**Promoted to live filter on 2026-05-11.** Empirical evidence below; v2 fade
fire script applies this rule before generating any candidate. Continued
tracking of "what if we hadn't applied this" via the nightly filter sweep.

### H-V: Lineup-aware lambda adjustment  ✅ ACTIVE 2026-05-10 EVENING
**Continue firing pre-lineup, but enhance lambda when opposing lineup posts.**
- **Why both**: Pre-lineup markets are wider/more mispriced (less informed
  trader flow). Capturing pre-lineup mispricing has real value. After
  lineups post, ALSO re-evaluate with lineup data — if a pitcher we missed
  pre-lineup now has edge with K-prone opposing lineup, fire then.
- **Implementation**: When loading lambda from K9_l5, query `game_lineups`
  for opposing team's lineup_k_pct (matching pitcher's hand). If posted
  with batter_count ≥ 8, multiply lambda by `(lineup_k_pct / 0.22)` (clamped
  to [0.85, 1.15]). No-op if lineup not posted.
- **Two implicit passes via existing 30-min cron**:
  1. Early-day fire on probable + raw lambda (capture pre-lineup mispricing)
  2. Post-lineup-post fire with adjusted lambda (catches new candidates that
     didn't qualify pre-lineup, OR pushes marginal fires below threshold)
- **Per-pitcher cap=1 prevents double-firing** on same pitcher.
- **Smoke-test**: today, Bubba Chandler had +5.9¢ edge pre-lineup. Post-lineup,
  opp K%=20.5% (K-resistant) reduces λ from 4.20 → 3.91, edge falls below
  threshold, auto-skipped. Lineup data corrected a marginal fire.

### H-T: News-wire pre-game injury / scratch / opener detection  ✅ ACTIVE 2026-05-10
**Persistent integration of preflightCheck.js news pipeline to fade fire.**
- **Source**: `runPreflightCheck()` in `lib/preflightCheck.js` (already existed,
  used by production engine). Pulls ESPN/Google News/Rotowire/MLB.com team
  feeds + Sonnet AI synthesis. Returns `{action, reason, confidence, sources}`.
- **Persistence layer** (NEW 2026-05-10): `pitcher_news_log` table stores
  every result. `scripts/runDailyNewsCheck.mjs` runs preflightCheck for every
  scheduled starter and persists output.
- **Cron schedule**: 9 AM, 12 PM, 3 PM, 6 PM ET (catches news drops at
  multiple pre-game windows).
- **Fade fire integration**: at fire time, queries `pitcher_news_log` for
  latest action. Skips pitcher if `action='skip' AND confidence ≥ 0.7`.
- **Smoke-test result (2026-05-10 evening)**:
  - 26 starters checked
  - 3 SKIPs: Bassitt (no longer probable), Rodón (IL), Akin (confirmed opener)
  - 1 BOOST: Severino (K prop gap +1.6)
  - 22 PROCEED
- **Why useful**: catches issues H-H + H-I miss (e.g., a pitcher with normal
  ipL5 who's just been scratched, or a pitcher being used as opener today
  for the first time).

### H-N: Strike floor K=6 OR K≥10 (skip middle 7,8,9)  ✅ PROMOTED TO LIVE 2026-05-10 EVENING
**Promoted same day as v2 — promoted to v3.** Why same-day:
empirical strength of signal was overwhelming.
- **Why**: middle strikes (7-9) are where market efficiency concentrates
  because the bell curve of pitcher K-counts peaks at 5-7 K. Edge lives
  at the extremes: K=6 (favorite-side, public underprices probability) and
  K≥10 (lottery longshot, market discounts ace overperformance).
- **Empirical evidence (Days 1-4, 31 K=7-9 fires)**:
  - **1 win in 31 K=7-9 fires (3.2% win rate)** — Davis Martin K≥8 was the only winner
  - Net K=7-9 P&L: **-$2,044** (saved $2,181 in losses, forfeited $137 in wins)
  - K=6 P&L: positive (Burrows, Vásquez, Holmes wins)
  - K≥10 P&L: hugely positive (Imanaga +$1,620, deGrom +$1,105)
- **v2 + skip K=7-9 hypothetical bankroll: $8,752 (+75% from $5K start)**
- **Same-day promotion justification**: signal strength + structural reasoning
  (market efficiency concentrates in middle strikes — well-documented
  microstructure effect — not just sample-size luck).
- **Continued tracking**: nightly filter sweep tests "what if we hadn't applied this"


- **Why**: `pitcher_signals.confidence` is the production engine's own quality
  score for its lambda estimate. Low confidence = unreliable input data
  (rookies, limited starts, news flags). Engine already knows it's guessing.
- **Source**: `pitcher_signals.confidence` (0.0 to 0.9 typical range).
- **Empirical evidence (n=36 fade fires)**:
  - **0 winners had confidence ≤ 0.3** (all winners 0.75-0.9)
  - 2 losers had confidence ≤ 0.3: **Canning (-$200), Strider (-$14)**
  - Counterfactual: skipping = **+$214 P&L improvement**, 0 wins forfeited
- **Combined with H-H**: skip if (avg_innings_l5 < 5 OR confidence ≤ 0.3) →
  net P&L on 36 fires: **$98 → $1,012 (10× improvement)**
- **Confidence**: HIGH — overlaps partially with H-H (Strider hit both filters)
  but Canning was a unique loss caught only by confidence filter.

### H-J: Use swstr_pct as quality-of-stuff filter
- **Why**: Swinging-strike rate is a leading indicator of K rate. When a
  pitcher's swstr% drops dramatically below career, their stuff is gone (could
  be injury, mechanics, fatigue). Strider had swstr=11% on 2026-05-09 (career
  ~30%) — clear "stuff is gone" signal that production engine flags but our
  fade model ignores.
- **Source**: `pitcher_signals.swstr_pct` (per-pitch swing-and-miss rate).
- **Empirical evidence**: n=1 confirmed loser (Strider) had swstr=11% vs typical
  22-31% across our sample. Insufficient sample to validate.
- **Test on Day 14**: filter swstr_pct < 0.18 (or career delta), check P&L.
- **Confidence**: MEDIUM — single-sample observation, plausible mechanism.

### H-K: Pull production-engine model probability from `pitcher_edge_cache`
- **Why**: Production engine's full lambda includes TTO, park, weather, ump,
  opp K%, velocity, batting order weighting. Stored per pitcher-day in
  `pitcher_edge_cache.edges_json`. Our simplified fade model recomputes a
  crude lambda; could instead use production's lambda directly when available.
- **Test**: For each fade candidate, look up production's `model_prob` for
  same (pitcher, strike, date). Compare edge under simple-model vs production-
  model. Backtest on shadow data.
- **Confidence**: MEDIUM — could be redundant if simple model is already good
  enough, or could lift ROI if production features add real signal.

### H-L: Per-pitcher cap = 2 (cascade strikes when pitcher overperforms)
- **Why**: When a pitcher has 10+ K, MULTIPLE strike levels win simultaneously.
  Per-pitcher cap = 1 forfeits cascade wins. Imanaga K≥9 was a non-fired
  shadow-log winner that would have paid +$311 on top of K≥10's +$1,620.
  Misiorowski's 11K had 5 winning lower strikes we didn't fire on.
- **Empirical**: Imanaga +$311, Misiorowski +$0 (we fired K≥12 only — losing).
- **Test**: Sweep cap=1/2/3 against shadow data on Day 14. Trade-off: cap>1
  amplifies wins on overperformers but also amplifies losses on underperformers
  (correlated bets all lose together).
- **Confidence**: MEDIUM — clean upside on hit days, unknown downside on miss days.

### H-M: Park K-factor adjustment
- **Why**: Coors deflates K rate (~0.92×), Petco inflates (~1.06×). Freeland
  at Coors on 2026-05-09 went 4K in 6IP — model expected more given his K9_l5.
- **Source**: `lib/parkFactors.js` already imported by production engine.
- **Test**: Apply park multiplier to fade lambda; backtest.
- **Confidence**: MEDIUM — known structural signal, untested in fade context.

## Day 1-3 Live Performance Log

Maintained daily — adds new row each game-day during paper test.

| date | day | fires | W | L | P&L | bankroll | cum return |
|---|---|---|---|---|---|---|---|
| 2026-05-07 | 1 | 9 | 1 | 8 | +$1,110 (uncapped) → +$1,110 (capped retroactive) | $6,110 | +22.2% |
| 2026-05-08 | 2 | 17 | 1 | 16 | -$562 | $5,548 | +11.0% |
| 2026-05-09 | 3 | 16 | 2 | ~10 | -$174 (in progress) | ~$5,375 | +7.5% |

**Cumulative through 3 days**: 42 fires, 4 wins (9.5%), +$374 P&L, +7.5% cumulative bankroll.

Win rate (~9.5%) running well below backtest's 32-38% expectation. Asymmetric
payoff structure carrying the cumulative line: 4 longshot wins (Imanaga +$1620,
Vásquez +$309, Burrows +$495, Holmes +$44) covered the 38 losses (~$2,094 total).

## Risk Posture (current)

- **Real money**: paused. Last live bet 2026-05-01 (paper-mode incident),
  $27.33 lost. All Kalshi credentials backed up to `~/.config/baseball-secrets/`.
- **Paper mode**: active for ALL strategies including the new IDEAL fade test.
  `KALSHI_PAPER_MODE=true` on Railway env.
- **Bankroll caps active**: pregame_pool 60%, live 20%, free-money 20%.
  Per-pitcher cap $74 at $1,237 bankroll. Quarter-Kelly multiplier.
- **Halt conditions**: daily loss limit $500, drawdown -15% halt, system_flags
  manual halt, Kalshi API outage halt.
- **No real money until**: Day 14 of fade paper test (May 20) AND user explicit
  approval. Even then: half-stakes for first 30 days.

## Brother's Plain-English Summary

> We built a betting model for MLB pitcher strikeouts on Kalshi. It buys cheap
> "longshot" bets when our math says a pitcher will K more than the market thinks.
> Most lose; the wins pay 4-5x. Running on $5,000 of paper money for 14 days to
> verify before risking real. Backtest math says $5K could grow to $50-150K by
> end of MLB season if live results match.

## Backtest Snapshot

> Backtested across 37 days and 1,056 pitcher-games (Mar 31 – May 6) with no
> future-knowledge cheating: ideal config went $5,000 → $29,030 (+481%) on the
> held-out test half and +230% on training half, with 32-38% win rate and 6.6%
> max drawdown. Breakthrough was capping bets to one strike per pitcher (not
> five), which turned correlated bets into truly independent ones — drawdown
> 24% → 7%, win rate 29% → 38%. After honest deflation for slippage,
> selection bias, and liquidity caps, realistic forward expectation is +50-100%
> over 14 days and $50K-$150K by season's end on a $5K starting bankroll.

**Important: the +481%/+230% numbers above are from the ORIGINAL ideal (v1)
backtest, not v3.** v3's filters (H-H + H-I + H-N) were designed AFTER seeing
May 7-10 paper-test data and have *not* been validated out-of-sample.

---

## In-Sample vs Out-of-Sample — v3 reality check (clarified 2026-05-11)

When discussing "v3 backtested at +$2,971" — that figure is **in-sample**:
- The +$2,971 is what v3 *would have generated* if applied retroactively to
  May 7-10 (the same window v3's filters were tuned against).
- This is the value v3's filter design maximized — by construction it must
  look good on this window.
- Source: `scripts/v3HistoricalTest.mjs:149` literally says: *"If v3 lift ≤ 0
  ⟹ the +$2,971 on May 7-10 was overfitting."*

Three numbers people may confuse:

| label | what it is | value |
|---|---|---|
| **v1 backtest (Mar 31 – May 6)** | True OOS for v1 only — 37-day held-out | $5k → $29,030 (+481%) |
| **v3 in-sample fit (May 7-10)** | Retroactive v3 on the data it was tuned on | +$2,971 |
| **v3 true OOS (Mar 31 – May 6)** | What v3 would do on data it never saw | **NEVER RUN** |
| **Actual ks_bets fires (May 7-11)** | Real paper fires: mix of v1/v2 (May 7-9) + v3 (May 10pm onward) | +$477 |

The actual fires are +$477 (not $2,971) because most fires May 7-9 were v2,
not v3 — v3 only went live evening of May 10. The +$2,971 figure is what v3
would have made if it had been live the whole time AND if those filters
weren't tuned on that exact window.

Need to actually run `scripts/v3HistoricalTest.mjs` against Mar 31 – May 6
records to validate v3 has real signal. Until then, treat any v3 forward
projection with skepticism.

---

## Monthly P&L Projection on $7k bankroll (added 2026-05-11)

Anchored on the in-sample +$2,971 over 4 days = $743/day; scaled to $7k
bankroll (1.4× the $5k test) and 30 days. Compounded (1.34%/day compounded
over 30 days) adds ~$300 vs flat-stake because **sizing is volume-capped on
the wing strikes, not bankroll-capped** — so most of the compounding benefit
is eaten by the 10% volume gate on tail strikes.

| scenario | monthly P&L | bankroll end | rationale |
|---|---|---|---|
| In-sample extrapolation (no deflation) | +$11,500 | $18,500 | Naive: assume v3 maintains $743/day, with mild compounding |
| In-sample × 0.5 (mild overfit deflation) | +$5,300 | $12,300 | Half-credit to filter signal |
| **In-sample × 0.3 (honest base case)** | **+$3,100** | **$10,100** | Standard backtest → forward deflation factor |
| Worst plausible (v3 has no real lift) | $0 | $7,000 | If v3 was overfitting; only v1 baseline edge remains |

**Standard deviation of monthly P&L: roughly $3,500** based on first-5-days
daily P&L variance of ±$650. Realistic monthly outcome range for a single
month: −$1,500 to +$5,500 even if expected return is positive.

**Caveats that matter more than the point estimate:**
- v3 has not been tested out-of-sample. The +$2,971 is in-sample.
- Win rate is 12.3% over 57 settled fires — below the 25% Day-14 criterion.
- One outlier day (May 7 +$1,110) is carrying the cumulative; without it
  current actual is −$633.
- Volume caps prevent linear bankroll-to-size scaling on illiquid tail
  strikes; real compounding benefit is small.

**Conclusion**: best honest guess is **+$2,000 to +$4,000/month on $7k**, with
meaningful chance of net-negative for any single month even if strategy is
real. To narrow the range, run the v3 OOS test on Mar 31 – May 6.
