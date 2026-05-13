# Kalshi Weather Strategy — Overview & Decisions Log

> **Self-sufficient entry point.** Reading this single file gives you everything you need: what's running, where, the strategy thesis, file paths, commands, pre-committed model, gates to act, and the decision log. The weather strategy is fundamentally different from anything else in this repo (it's a candidate market-making play, not pattern-finding) — every detail is documented so a fresh session can pick it up cold.

**Status as of 2026-05-13 22:50 UTC**: Phase 0 (data collection + model-vs-market validation) launched. Day 1 ran end-to-end; daily 4x collection + nightly settle scheduled via launchd. **No real money, no paper trader yet** — Phase 0 is observation-only for 14 days minimum before any strategy build.

## TL;DR — what this is and why

- **The thesis**: Kalshi's KXHIGH* daily city-high-temperature markets are the one remaining unexplored crypto-or-finance avenue that fits a retail $7K operator. Volume is real ($1.3-2M/24h combined across 6 cities, runs 365 days/year), HFT attention is lower than crypto/financial markets, and the fair-value model can be derived from **free public NOAA/NWS forecast data** that very few retail traders bother to assemble properly.
- **The strategy class is market-making**, not pattern-finding. Three pattern-finding strategies died in OOS testing in the prior session (v3 strikeout fade, KXBTCD directional, the two BTC/ETH shadow-tracker patterns). The repeated lesson is that small-sample patterns on Kalshi reliably fail forward. Market-making is structurally durable: you earn the spread for providing liquidity, not by predicting a specific outcome — failure modes are inventory and adverse selection, both manageable.
- **Edge source (the only thing that matters)**: our fair-value model must beat the market's pricing on average. If NWS-derived `P(actual_high > strike)` is systematically different from the market's implied probability, AND the model is closer to the realized truth, AND the gap exceeds the bid-ask spread + maker fee — there's a real edge. Phase 0 is the test of those three conditions.
- **Per-city, per-strike, both-sides** — every city is evaluated independently (one failing doesn't kill others). Every strike's edge is computed for BOTH the YES side (`model_P − yes_ask`) AND the NO side (`(1−model_P) − no_ask`). A strike can be tradable on either side; the strategy uses whichever is +EV.

## Why this isn't another pattern-finding trap

Same hard-rule logic from prior strategies applies here, with one structural difference:

| Failure mode | Pattern-finding (v3, KXBTCD, etc.) | Weather MM |
|---|---|---|
| Small-sample artifacts | THE failure mode — pattern fitting to a 30-90 day window | Less applicable — model is built from physics + public forecasts, not historical price patterns |
| Regime shifts | Kills any time-bounded pattern | Real but smaller — NWS forecast skill is stable across seasons within a city |
| Adverse selection | Not a directional concern | THE failure mode — informed counterparties pick off your quotes |
| HFT competition | Major on crypto/financial markets | Less on weather — boring market, less attention |
| Capacity ceiling | Often binding | Per-city per-day is modest (~2-3 tradable strikes); aggregated 6 cities × 365 days is meaningful |

The honest read: it's not bulletproof, just has a different failure profile. Phase 0 catches the model-quality issue early; later phases catch the adverse-selection issue.

## Phase 0 — five-phase plan (currently at Day 1)

Each phase is a gate. Failing any phase kills the strategy with maximum half-day of cost (until calendar-time phases).

### Phase 0 — Cheap validation (days 1–14, currently running)
**Gate**: per-city Brier skill score ≥ +0.1 vs Kalshi's market-implied probabilities on a held-out sample; market has tradable depth (≥100 contracts at the touch on at-least-2 strikes per city per day); model and market disagree enough to be worth quoting (per-strike edge >5¢ at least 1× per week per city).

Output: per-city green/red verdict. Greens proceed to Phase 1. Reds get killed without further investment.

### Phase 1 — Build the fair-value model (weeks 1–2 after Phase 0 green)
NOAA NDFD baseline + GFS/HRRR/ECMWF ensemble extraction. Train on 1 year of historical data, validate on 6 months never seen. Cross-city validation. Output: a P(high > threshold) function per city that beats NWS's deterministic guidance.

### Phase 2 — Maker-fill simulator (week 3)
Realistic fill rule (you fill at resting price only when public trades through, accounting for queue position) + adverse-selection model. Without this, backtests lie.

### Phase 3 — Strategy backtest (weeks 4–5)
6+ months of historical Kalshi weather candles, walk-forward, per-city per-season slices, fees modeled. Gate: net positive after fees in ≥2 separate 3-month windows, ROI > 5% per month on deployed capital.

### Phase 4 — Live shadow paper (weeks 6–10, calendar-time)
Quoter runs against live market, no orders placed, all simulated fills logged. Live results must be within 30% of backtest expectations.

### Phase 5 — Tiny live pilot (weeks 11–14, calendar-time)
$200–500 deployed, 1–2 contracts per quote. Net positive for ≥2 weeks before scaling.

**Total realistic time-to-decision**: ~3 months to know if this is real money or a dead end.

## Pre-committed model (Phase 0 — DO NOT CHANGE MID-TEST)

Locked 2026-05-13. Any change requires a versioned re-test from Phase 0 Day 1.

```
forecast_high = NWS NDFD point-forecast (daily max temp) for the market's settle date
                 pulled from api.weather.gov for each city's lat/lon
σ            = 3.5°F  (standard NWS 1-day-ahead daily-high forecast error)
P(actual_high > strike) = 1 − Φ((strike − forecast_high) / σ)

For range-bucket markets (B-prefix tickers):
  P(lo ≤ actual_high < hi) = Φ((hi − forecast_high)/σ) − Φ((lo − forecast_high)/σ)

For threshold markets (T-prefix tickers):
  P(actual_high > strike) = 1 − Φ((strike − forecast_high)/σ)

Edge per strike, both sides:
  yes_edge = model_P_yes − yes_ask
  no_edge  = (1 − model_P_yes) − no_ask
```

**Known model limitations** (to be addressed in v2 ONLY AFTER Phase 0 scoring):
1. Fixed σ ignores forecast-confidence variations (clear-sky vs storm-front days have very different uncertainty)
2. Doesn't use precipitation probability (rain caps the daily high)
3. Doesn't use NWS detailed-forecast text
4. Doesn't use GFS/ECMWF ensemble spread
5. Doesn't use station-specific climatology baselines
6. Doesn't use intraday observations as the day progresses (forecast revisions)

The current Day-1 test against the live market already surfaces strikes where the simple model says +47¢ YES edge on T63 (NYC, forecast 65°F, market says only 24% YES) — but NWS forecast text shows "Showers And Thunderstorms Likely" which makes the LOW market price defensible. The market may be pricing in the precip suppression of the high; our model isn't. **This is the kind of pattern v2 should incorporate AFTER Phase 0 scoring quantifies the impact.** Until then: log everything, don't tune.

## Cities (each evaluated independently)

| City | Series | Volume (24h, May 13) | Lat/Lon | Station | Notes |
|---|---|---:|---|---|---|
| NYC | `KXHIGHNY` | $266k | 40.78, -73.97 | KNYC (Central Park) | Highest pro attention; expect tightest market |
| LAX | `KXHIGHLAX` | $576k | 33.94, -118.41 | KLAX | Largest weather market on Kalshi |
| Chicago | `KXHIGHCHI` | $194k | 41.97, -87.91 | KORD | Higher daily variance; storms common |
| Miami | `KXHIGHMIA` | $155k | 25.80, -80.29 | KMIA | Tropical / convective regime |
| Austin | `KXHIGHAUS` | $88k | 30.19, -97.67 | KAUS | Smaller pond but Day 1 showed real divergence |
| Denver | `KXHIGHDEN` | $49k | 39.83, -104.66 | KDEN | Mountain effects; biggest forecast errors in winter |

**Each gets its own verdict.** One city failing doesn't kill the others. Aggregated across all 6, the strategy can have viable cities and dead cities — and the dollar capacity is the sum of viable.

## File map (everything lives in `/tmp/`)

| File | Purpose |
|---|---|
| `/tmp/weather_phase0_collect.py` | The collection script. Runs 4× daily via launchd; pulls NWS + Kalshi + station obs; logs raw |
| `/tmp/weather_phase0_settle.py` | The nightly settle script. Runs 1× daily; pulls realized highs + Kalshi resolutions |
| `/tmp/weather_phase0_log.jsonl` | Append-only raw log. One row per (snapshot, city, event, ticker). Contains everything: NWS forecast, multi-period adjacent forecasts, station obs, full Kalshi market record, model probs, both-side edges. |
| `/tmp/weather_phase0_settle.jsonl` | Append-only settle log. One row per (city, event) after settle date passes — joins all logged snapshots to realized high + Kalshi resolution. |
| `/tmp/weather_collect_cron.log` / `.err` | launchd stdout/stderr for the collector |
| `/tmp/weather_settle_cron.log` / `.err` | launchd stdout/stderr for the settler |
| `~/Library/LaunchAgents/com.weather.collect.plist` | launchd job — 4× daily collection |
| `~/Library/LaunchAgents/com.weather.settle.plist` | launchd job — 1× daily settle |

## launchd schedule

```
com.weather.collect (4× daily UTC):
  11:00 UTC  =  7am ET     (morning forecast, day-of trading begins)
  17:00 UTC  =  1pm ET     (midday update, market starts to converge)
  22:00 UTC  =  6pm ET     (late afternoon, post-peak, high mostly known)
  02:00 UTC  = 10pm ET     (pre-settle snapshot, final market state)

com.weather.settle (1× daily UTC):
  06:00 UTC  =  1-2am ET   (after all 6 cities' calendar-day highs determined)
```

Multiple snapshots per day intentionally — captures forecast revisions and market price evolution across the day. This is the "data nobody bothers to assemble" angle: we get 24+ data points per city per day instead of 1.

## Common commands cheat sheet

```bash
# Check if launchd jobs are loaded
launchctl list | grep weather

# Run a one-off collection (no schedule)
python3 /tmp/weather_phase0_collect.py manual

# Run a one-off settle pull
python3 /tmp/weather_phase0_settle.py

# View latest log entries
tail -f /tmp/weather_phase0_log.jsonl | head -5

# How many observations per city?
python3 -c "
import json
from collections import Counter
c = Counter(json.loads(l)['city'] for l in open('/tmp/weather_phase0_log.jsonl'))
for k,v in c.most_common(): print(f'  {k}: {v}')"

# How many settled events per city?
python3 -c "
import json
from collections import Counter
c = Counter(json.loads(l)['city'] for l in open('/tmp/weather_phase0_settle.jsonl'))
for k,v in c.most_common(): print(f'  {k}: {v}')" 2>/dev/null || echo "(no settles yet)"

# Disable everything
launchctl unload ~/Library/LaunchAgents/com.weather.collect.plist
launchctl unload ~/Library/LaunchAgents/com.weather.settle.plist
```

## Day 1 results (2026-05-13)

**Setup verified**:
- ✅ NWS API returning forecasts for all 6 cities
- ✅ Kalshi API returning market data for all 6 series
- ✅ Day-selection bug fixed — tomorrow's forecast (May 14) correctly matched to KXHIGHNY-26MAY14 market
- ✅ Station observations pulling correctly (KNYC, KLAX, KORD, KMIA, KAUS, KDEN)
- ✅ Per-strike YES/NO edge computation working on both threshold (T) and range-bucket (B) markets
- ✅ 72 rows logged across 6 cities × 2 events each on the manual test

**Notable signals on the first snapshot** (need 14 days + settlements before any are real evidence):

| City | Strike | Forecast | Market | Model | Side | Edge |
|---|---|---|---|---|---|---|
| NYC | T63 | 65°F (rain forecast) | yes_ask 24¢ | 72% YES | YES | +47.6¢ ⚠ but precip-aware market likely correct |
| LAX | T69.5 | 67°F | yes_ask 51¢ | 8.8% YES | NO | +41.2¢ |
| CHI | T62 | 66°F (Sunny) | yes_ask 8¢ | 87% YES | YES | +79.3¢ ⚠ very high — verify model |
| MIA | B92.5 | 90°F | yes_ask 45¢ | 8.8% YES | NO | +35.2¢ |
| AUS | T89 | 91°F | yes_ask 10¢ | 72% YES | YES | +61.6¢ |
| DEN | T83 | 86°F | yes_ask 6¢ | 80% YES | YES | +74.4¢ |

**Suspicions about Day 1**: NYC and CHI have HUGE apparent edges that probably reflect model deficiency (NYC: rain suppressing high; CHI: clear-sky may already be priced in). This is exactly what Phase 0 is for — measure whether the model is right or wrong, per-city, over 14+ days. **Do not trade on these. Just observe.**

## Bar to act (pre-committed 2026-05-13)

For each city independently, ALL must be true before building a paper trader for that city:

1. **n ≥ 50** scored (forecast, market_open_price, actual) tuples
2. **Brier skill score ≥ +0.10** vs market's implied probability on the same strikes (model is at least somewhat better than market at predicting outcomes)
3. **Edge signs are stable** — if YES is +EV at some strike on average, the SIGN of that edge should persist across at least 3 separate weekly windows
4. **Tradable depth** confirmed — at least 2 strikes per city per day with `ask_size ≥ 100 contracts` at our model's fair price
5. **Net positive after fees** in walk-forward simulation on the logged data

If a city passes all 5: build a per-city paper trader. If not: kill that city, others can still proceed.

## Hard rules (learned from prior session)

- **No model changes during Phase 0.** σ=3.5°F is locked. If we want to test a better model later, it gets a fresh Phase 0 from Day 1 with separate log files. **Log everything raw** so v2/v3 can be built without re-pulling.
- **No "the pattern is so strong, just go" shortcut.** Phase 0 is calendar-time-bound (14 days minimum to score). Three prior strategies died because in-sample looked great and forward didn't. No exceptions for this one.
- **Per-city independent verdicts.** Don't aggregate. NYC may be over-pro'd while AUS is loose; treat them separately.
- **Both YES and NO sides at every strike.** The strategy isn't "buy YES on cold days." It's "find the +EV side of each tradable strike." Could be either side, could be neither.
- **Capacity will surprise us in both directions.** Per-day per-city is small (~2-3 tradable strikes), but the data assembly itself may reveal more tradable structure than the initial scan suggested. Log everything; analyze later.

## Decision log

| Date | Decision | Reasoning |
|---|---|---|
| 2026-05-13 | Open Phase 0 — data collection only, no trading | Three pattern-finding strategies died this session; weather MM is the only remaining viable angle and structurally different (maker, not pattern-matcher). |
| 2026-05-13 | Pre-commit σ=3.5°F model and log raw everything | Discipline gate: model can't be tuned during Phase 0; v2 model gets a fresh Phase 0. Logging raw means v2 doesn't need a re-pull. |
| 2026-05-13 | Schedule 4× daily collection (11/17/22/02 UTC) + 1× nightly settle (06 UTC) | More snapshots than typical so v2 can analyze forecast revision dynamics. The "data nobody assembles" angle requires actually assembling more data than baseline. |
| 2026-05-13 | Each city gets its own pass/fail | Markets differ by city (volume, pro attention, weather regime). Aggregate verdict hides per-city signals. |
| 2026-05-13 | Bug fix: use NWS period matching event's settle date, not "next daytime period" | Day 1 v1 was using tomorrow's forecast for today's already-settled market, generating fake edges. Fixed in v2. |

## What's NOT happening yet (don't confuse with what IS)

- **No paper trader.** No quotes are being placed. No fills are being simulated. Phase 0 is *observation only*.
- **No live trader.** No real money. No Kalshi orders.
- **No model tuning.** σ=3.5°F is locked through Phase 0.
- **No filter changes** on the existing KXBTC closest-bucket trader (that's a separate system, separate governance at `docs/btcd-strategy/`).

## Failure modes to watch for

1. **Adverse selection**: the moment we DO build a quoter, anyone with a faster information source will pick off our quotes. NWS forecasts update on a schedule; if our quote doesn't update fast enough after a forecast revision, we get run over. Phase 4 (shadow paper) catches this.
2. **Forecast skill regression**: if NWS forecast accuracy drops in some city/season we haven't tested, our model breaks silently. Mitigated by per-city per-season validation in Phase 1.
3. **Kalshi rule change**: market settlement station or convention could change. Mitigated by logging raw Kalshi market records (we'd see the change).
4. **Data flow break**: NWS or Kalshi APIs change/break. Mitigated by storing raw responses and checking the cron logs (`/tmp/weather_collect_cron.log`).
5. **Sample-size impatience**: temptation to act on n=10 observations because they look great. The bar requires n≥50 per city. Resist.

## Related governance

- `docs/btcd-strategy/00_overview.md` — the KXBTC closest-bucket strategy + shadow tracker. Separate system, separate strategy class.
- `GOVERNANCE.md` — the baseball strikeout system (separate).

## Quick re-orientation if you forget everything

If you come back in 2 weeks and need to figure out what's going on:
1. **Read this file** (you are here).
2. `launchctl list | grep weather` — confirm jobs still running.
3. `wc -l /tmp/weather_phase0_log.jsonl /tmp/weather_phase0_settle.jsonl` — confirm data accumulating.
4. `tail -50 /tmp/weather_collect_cron.log` — confirm last run succeeded.
5. The "Bar to act" section above tells you the criteria for moving past Phase 0.
