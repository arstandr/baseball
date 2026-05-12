# Other Kalshi Markets — Inventory & Priority Queue

**Surveyed 2026-05-11.** This documents everything beyond the closest-bucket crypto strategy that's worth considering, ranked by realistic potential.

## TL;DR — what to build after closest-bucket validates

| Priority | Strategy | Why | Realistic $/mo at $7K | Build effort |
|---|---|---|---|---|
| 1 | **KXAAAGASD (AAA gas prices)** | Highest model edge available — gas is physically constrained, retail doesn't use RBOB futures | **$1.5-4K** | 2-4 weeks |
| 2 | **KXWTI / KXBRENTD (oil daily)** | Real volume, non-HFT, modelable from NYMEX futures | $500-1.5K | 3-5 days each |
| 3 | KXBTC15M (15-min BTC binary) | $327K daily volume, possibly similar maker-lag mechanism | $1-3K | 3-5 days (different from closest-bucket) |
| 4 | Entertainment scraping (Spotify/Netflix daily) | Public data → near-100% accuracy possible | $300-600 combined | 1-2 days each |
| 5 | KXBTC/KXETH daily range | Same closest-bucket strategy at daily cadence — but edge likely WEAKER (makers have all day to reprice) | $300-800 | 2 days (port existing code) |

**Don't build any of these until closest-bucket has 30 days of clean paper-trade data confirming the edge.** If closest-bucket dies, oil/gas may face similar headwinds.

## Why AAA gas prices is the #1 follow-on (the thing I initially undersold)

KXAAAGASD: "Will average US gas prices be above $X.XX tomorrow?" — **$37K daily volume**, daily settle, Economics category.

The edge case:
- AAA's daily national average is just the mean of yesterday's retail prices at thousands of stations
- It moves 1-3¢/day, physically constrained
- It LAGS WTI/RBOB futures by 1-3 weeks (well-studied)
- The settlement number is largely determined the moment retail prices print at close of business yesterday
- **Retail betters use gut feel; a competent model using RBOB futures + lag + refinery margin data could be 85% accurate**

That's a potential 25-40% edge per contract — much bigger than the ~7-10% on crypto closest-bucket.

Realistic P&L (revised UPWARD from initial $500-2K estimate):
- $7K bankroll: $1.5-4K/month
- $30K bankroll: $6-15K/month
- Asymptotic ceiling: ~$15-21K/month (limited by total market flow)

Model inputs (all free public data):
- WTI front-month futures (CME)
- **RBOB gasoline futures (NYMEX)** — the direct wholesale-gas upstream
- EIA weekly refinery margin / crack spread data
- GasBuddy / OPIS / AAA state-level breakdowns

Caveats:
- Per-strike depth unknown (could be thin like crypto)
- ~4-6 actionable strikes per day max (one settle/day)
- Model construction requires domain knowledge (2-4 weeks)
- Only ~6 weeks of Kalshi history for backtest → limited statistical power
- Verify Kalshi energy-market rules apply

## Full Kalshi hourly inventory (surveyed 2026-05-11)

**Hourly markets with real volume:**

| Series | 24h vol | Structure | Verdict for closest-bucket |
|---|---|---|---|
| KXBTC15M | $327K | 15-min binary "BTC up?" | Different strategy needed |
| KXBTCD | $211K | Hourly directional above/below | Tested, sharp, no edge for our strategy |
| KXWTI (hourly variant) | $50K | Hourly oil directional | Different strategy (fair-value vs futures) |
| KXETH15M | $16K | 15-min ETH binary | Different strategy |
| KXETHD | $2K | Hourly ETH directional | Sharp |
| **KXBTC** | **$1-10K** | **Hourly range, ~188 buckets** | **✅ Currently trading** |
| KXNASDAQ100 | $570 | Hourly range, 30 buckets | Too thin to scale |
| KXSOLD | $47 | SOL directional | Tiny |
| KXINX (S&P) | $35 | Hourly range | Tiny |
| KXETH | $4-2.7K | Hourly ETH range | Currently dead-ish; ETH filter too strict |
| KXXRP, KXEURUSD | $0 | Hourly | No volume |

## Full Kalshi daily inventory (surveyed 2026-05-11) — non-weather

127 daily-frequency series exist (non-weather). Those with meaningful volume:

| Series | 24h vol | Category | Notes |
|---|---|---|---|
| KXBTCD | $163K | Crypto | BTC daily directional |
| **KXAAAGASD** | **$37K** | Economics | **US gas prices — see above, #1 priority** |
| KXSOLD | $20K | Crypto | SOL daily |
| KXETHD | $19K | Crypto | ETH daily directional |
| KXBTC | $10K | Crypto | BTC daily range |
| KXWTI | $9K | Commodities | WTI oil daily |
| KXINXU | $5K | Financials | S&P 500 daily |
| KXNATGASD | $4.5K | Commodities | Natural gas daily |
| KXBRENTD | $4K | Commodities | Brent crude daily |
| KXSILVERD | $4K | Commodities | Silver daily |
| KXETH | $2.7K | Crypto | ETH daily range |
| KXSHIBA | $2.6K | Crypto | Shiba Inu range |

Plus: KXLINK (Chainlink), KXAVAXD (Avalanche), KXLTC, KXXLM, KXBCH (alt-crypto range); KXNETFLIXRANKING, KXSPOTIFYD + variants (entertainment); KXAPPRANKFREE3 (app rankings); KXFULLLID* (White House press office timing); KXCS2MAP (Counter-Strike maps); KXTSA (TSA passenger counts); KXTRUF* (Truflation indices); KXFLIGHTLAX/JFK (airport delays); KXGOLD, KXCOPPERD (metals); KXJPY, KXGBP, KXUSDJPY (forex daily).

Survey data: `/tmp/kalshi_hourly_inventory.json`, `/tmp/kalshi_daily_inventory.json`

## Markets NOT worth pursuing (and why)

- **Stock indices (KXSPX, KXNDX, KXINX, KXNASDAQ100)** — already tested in crypto-arc, sharp, plus they get the discounted 0.035 taker fee tier (i.e., Kalshi flagged them as needing it because they're competitive)
- **Forex daily (KXEURUSD, KXJPY, KXGBP)** — zero or near-zero volume
- **Tennis** — ELO model loses to market (tested); favorite-shading sub-strat marginal (see 05_tennis_revisit.md)
- **Sports props in general** — Vegas covers majors, settlement is binary game outcome (no "closest to spot" mechanic), sharp
- **One-off / annual / monthly markets** — too infrequent for systematic trading; CPI/Fed are quarterly-ish at best
- **Daily alt-coin range (SHIBA, AVAX, LINK)** — same closest-bucket mechanic but daily cadence weakens the edge (makers have all day to reprice); volume thin ($500-2.6K)

## Polymarket — separate question, probably not the same edge

Polymarket BTC markets are mostly weekly/monthly, settle on Chainlink/UMA oracles, and many use CPMM/AMM pricing. **An AMM doesn't "forget to reprice" — its quote is mathematically defined by pool ratio.** No maker lag = no closest-bucket edge.

Polymarket's weekly/EOY BTC markets COULD support a different strategy (Deribit-IV-based fair value), but that's a 1-week build for an uncorrelated, slow-cadence strategy. Lower priority than the Kalshi follow-ons.

## Decision rule for adding strategies

Add a new strategy ONLY when:
1. Closest-bucket crypto has ≥30 days of paper trade confirming the edge (target: 60%+ win rate, +$0.02+ EV/contract)
2. AND it's live and stable for ≥30 more days at small size
3. THEN build the next one (AAA gas first, per priority above)
4. Each new strategy gets its own 30-day paper test before real capital

Rationale: don't dilute focus. Don't deploy capital on unvalidated strategies. The crypto closest-bucket validation is the critical path right now.

## If you (future Adam, or future Claude session) are reading this

The state of play as of 2026-05-11:
- ONE validated strategy: closest-bucket crypto (BTC + ETH), paper-trading live, day 1 of 30
- ONE marginal candidate: tennis B+C favorite-shading cells (needs separate paper test)
- ONE high-potential untested candidate: KXAAAGASD gas prices (needs model build + backtest)
- Everything else: tested-and-dead OR too-thin OR different-strategy-required

The crypto exploration is DONE (~50 hours of analysis, ~9 strategies tested, governance docs 00-05 capture it).

The next research/build phase, IF crypto validates, is: build the AAA gas prices model. Then maybe oil. Don't redo the crypto hunt — it's exhausted.
