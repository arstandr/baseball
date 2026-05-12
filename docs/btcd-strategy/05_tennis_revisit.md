# Tennis revisit — Sub-stratification + Mirror-market tests (2026-05-11)

After the initial tennis ELO test came back NO-GO, ran two follow-up tests to ensure nothing was missed.

## Summary verdict

| Test | Status | Notes |
|---|---|---|
| Test 1: Favorite-shading sub-stratification | **Marginal SOFT-GO with strict guardrails** | Cells B+C only, paper test required |
| Test 3: Mirror-market parity | **DEAD** | HFTs clear violations within 1¢ |

## Test 1: Favorite-shading sub-stratification

### What it found

Within the population of moderate favorites (yes_mid ∈ 0.60-0.80), three sub-populations show positive edge that clears the deploy threshold (P05 EV ≥ +$0.02 after fees):

| Cell | Definition | n | Realized | Implied | Net EV/contract | Notes |
|---|---|---|---|---|---|---|
| A | yes_mid 0.75-0.80 + Hard court | 52 | 90.4% | 77.1% | +$0.108 | ⚠️ Severe overfit (early-half +22.9pp, late-half +3.7pp) |
| **B** | rank gap 30-100 + spread 2-4c | 55 | 85.5% | 70.0% | +$0.129 | ✅ Cross-validates cleanly in both halves |
| **C** | spread ≤2c + yes_mid 0.65-0.70 | 53 | 83.0% | 67.5% | +$0.134 | ✅ Cross-validates, possibly strengthening |

Union B+C (n≈108): mean EV +$0.13/contract, bootstrap 95% CI roughly [+$0.04, +$0.22].

### The killer caveat: multi-hypothesis correction

- 104 cells tested
- Bonferroni threshold: p < 0.00048
- **Zero cells survive Bonferroni**
- **Zero cells survive Benjamini-Hochberg FDR at q=0.10**

The 3 cells passing the deploy threshold have raw p ∈ [0.012, 0.023]. With 104 tests, you'd expect ~5 cells with p<0.05 by pure chance. Three of them clearing the threshold is suggestive but not definitive.

### Late-half P05 collapses

Full window union: bootstrap P05 = +$0.07/contract (cleanly deployable)
Late half only: bootstrap P05 = +$0.004/contract (essentially breakeven)

This is the pattern of an apparent edge that's half-real, half-overfit. Realistic expected EV is roughly mean/2 ≈ +$0.06/contract, not +$0.13.

### Realistic monthly P&L if deployed

At $25/bet on $7K bankroll, B+C cells only:
- ~25 bets/month
- Mean-case: +$300-400/month
- Realistic blend: **+$100-250/month**
- Bear case (it's noise): −$50/month

### Deploy plan (only after closest-bucket validates)

Phase 0 — paper test for 8 weeks BEFORE any real capital:
- Run B and C cells only (skip A — overfit)
- $25 nominal stake per bet
- Track rolling 30-bet realized win rate
- Kill switch: if rolling 30-bet realized win rate < (implied + 5pp), halt

Phase 1 — live deploy at half-stake ($25/bet, ~$315 max monthly exposure)
- Only after 8 weeks paper test passes
- Re-evaluate every 30 days

Realistic 12-month outcome IF edge holds:
- ~$1,500-3,000 incremental profit on top of closest-bucket strategy
- ~5-10% additional monthly P&L vs closest-bucket alone

### Files

- `/tmp/tennis_substrat.py` — re-runnable stratification analysis
- `/tmp/tennis_substrat_results.json` — 104-cell grid output, deployable cells, cross-val, union strategy
- `/tmp/tennis_substrat_run.log` — printed report per cell
- `/tmp/tennis_player_matches.json` — Sackmann round/surface/rank lookup
- `/tmp/tennis_enriched_fav.json` — enriched favorite-shading band data

## Test 3: Mirror-market parity arb — DEAD

### What was tested

For each ATP Challenger event, both markets ("Will Player A win" + "Will Player B win") should sum to ~$1.00. Looked for violations:
- sum_asks < $1.00 → buy YES on both, free arb
- sum_bids > $1.00 → buy NO on both, free arb

### Results

- 2,466 paired events analyzed (Mar 9 - May 11)
- Median sum_mids: **1.0000** (data is clean, pairing correct)
- Raw violations (gap > 0 cents): 35 events (1.4%)
- Net-positive after fees: **1 event**, $0.00 net P&L
- Capturable arbs (positive AND meaningful liquidity): **0**

### Why it's dead

1. Kalshi's market makers keep both sides at parity ±1 tick on balanced strikes
2. The $0.01 minimum tick = roughly the fee cost on either side
3. When sum_asks drops to $0.99, displayed depth on the thin side is <5 contracts (HFT peel-back, not real liquidity)
4. By the time you'd try to capture, the gap closes

### Files

- `/tmp/tennis_mirror_data.json` — 2,466 paired T-30 quotes
- `/tmp/tennis_mirror_results.json` — distribution stats, top-50 candidates
- `/tmp/tennis_mirror_test.py` — reusable analysis
- `/tmp/tennis_mirror_fetch.py`, `/tmp/tennis_mirror_markets.py`, `/tmp/tennis_mirror_pull.py` — fetch pipeline

## Tennis verdict overall

Of all 7 strategy variants tested on Kalshi tennis:
- 5 dead (ELO model, ATP main tour, multiple sub-strategies, mirror-market parity, etc.)
- 1 marginal (Cells B+C favorite-shading)
- 1 untested (live in-play tennis) — requires separate infrastructure, deferred

**Tennis adds at most +$100-250/month to the closest-bucket strategy IF the marginal sub-stratification edge holds in paper testing.** Not worth pursuing until closest-bucket is validated (30-day paper trade) and deployed.

## Priority queue

1. **Now**: closest-bucket paper trade continues (PID 76909). Day-30 review around June 10.
2. **Day 30 of closest-bucket**: if it passes gates, deploy at small size. Tennis remains untested.
3. **Day 60 of closest-bucket** (if live and working): begin tennis B+C paper test, 8 weeks
4. **Day 120 of closest-bucket** (if tennis paper passes): deploy tennis live at $25/bet

This is the realistic timeline. Don't compress it.
