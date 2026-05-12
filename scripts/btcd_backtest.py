#!/usr/bin/env python3
"""
btcd_backtest.py — Kalshi KXBTCD / KXETHD hourly strategy backtester.

Strategy (decision at T-60min, i.e. when each hourly market opens):
  - BUY NO  when yes_mid in [0.55, 0.70)  (research: ~62.6% NO win rate)
  - BUY YES when yes_mid in [0.70, 0.80)  (research: ~87.5% YES win rate)

Settlement: 60-second TWAP of CF Benchmarks BTC/ETH Real-Time Index at hour top.
Input rows are observed AFTER settlement, so `result` is known — but the code
only consumes `result` AFTER it has committed to a decision based on T-60
quotes. This is the firewall against lookahead bias.

DESIGN RULES (enforced strictly — see code for citations):
  1. No lookahead: decision uses only yes_bid / yes_ask / yes_mid at T-60.
     `result` is only read inside the P&L block, never inside the gate.
  2. No cherry picking: every market whose yes_mid lands in a band gets a
     logged decision. Skips carry an explicit reason; no silent drops.
  3. Realistic fills: NO fill cost = (1 - yes_bid) + slippage; YES = yes_ask +
     slippage. Slippage default 0 because we already use ask-side prices.
  4. Realistic fees: Kalshi standard approx is 0.07 * P * (1-P), per contract,
     rounded up to the nearest cent, $0.01 minimum per round trip.
  5. Chronological compounding: trades processed in close_ts order; bankroll
     updates as we go.

Usage:
  python3 btcd_backtest.py --input /tmp/btcd_samples.json
  python3 btcd_backtest.py --self-test
"""

from __future__ import annotations
import argparse
import json
import math
import os
import re
import sys
import datetime as dt
from collections import defaultdict
from typing import Any, Dict, List, Optional, Tuple

# ---------------------------------------------------------------------------
# Empirical win rates from prior research — used ONLY for the
# expected-EV guard. They are NOT used to influence sizing per-trade beyond
# the EV gate. If the user wants a stricter / looser guard they can adjust.
# ---------------------------------------------------------------------------
EMPIRICAL_NO_WIN_RATE = 0.626   # NO band [0.55, 0.70)
EMPIRICAL_YES_WIN_RATE = 0.875  # YES band [0.70, 0.80)

NO_BAND = (0.55, 0.70)   # half-open: [low, high)
YES_BAND = (0.70, 0.80)  # half-open

MONTHS = {"JAN": 1, "FEB": 2, "MAR": 3, "APR": 4, "MAY": 5, "JUN": 6,
          "JUL": 7, "AUG": 8, "SEP": 9, "OCT": 10, "NOV": 11, "DEC": 12}
EVENT_RE = re.compile(r"KX(BTCD|ETHD)-(\d{2})([A-Z]{3})(\d{2})(\d{2})")


# ---------------------------------------------------------------------------
# Hand-crafted fixture — used by --self-test. Crafted so we can predict P&L
# without running the engine: 5 NO winners + 1 NO loser + 2 YES winners + 1
# YES loser + 1 spread-too-wide skip + 1 below-band skip.
# ---------------------------------------------------------------------------
__TEST_FIXTURE__: List[Dict[str, Any]] = [
    # NO band winners (yes_mid 0.60, result=no → NO ticket pays $1)
    {"event": "KXBTCD-26JAN0101", "ticker": "T1", "strike": 100.0,
     "yes_bid": 0.58, "yes_ask": 0.62, "yes_mid": 0.60, "result": "no", "exp_val": 99.0},
    {"event": "KXBTCD-26JAN0102", "ticker": "T2", "strike": 100.0,
     "yes_bid": 0.60, "yes_ask": 0.64, "yes_mid": 0.62, "result": "no", "exp_val": 99.0},
    {"event": "KXBTCD-26JAN0103", "ticker": "T3", "strike": 100.0,
     "yes_bid": 0.55, "yes_ask": 0.59, "yes_mid": 0.57, "result": "no", "exp_val": 99.0},
    {"event": "KXBTCD-26JAN0104", "ticker": "T4", "strike": 100.0,
     "yes_bid": 0.63, "yes_ask": 0.67, "yes_mid": 0.65, "result": "no", "exp_val": 99.0},
    {"event": "KXBTCD-26JAN0105", "ticker": "T5", "strike": 100.0,
     "yes_bid": 0.55, "yes_ask": 0.58, "yes_mid": 0.565, "result": "no", "exp_val": 99.0},
    # NO band loser
    {"event": "KXBTCD-26JAN0106", "ticker": "T6", "strike": 100.0,
     "yes_bid": 0.60, "yes_ask": 0.63, "yes_mid": 0.615, "result": "yes", "exp_val": 101.0},
    # YES band winners
    {"event": "KXBTCD-26JAN0107", "ticker": "T7", "strike": 100.0,
     "yes_bid": 0.72, "yes_ask": 0.75, "yes_mid": 0.735, "result": "yes", "exp_val": 102.0},
    {"event": "KXBTCD-26JAN0108", "ticker": "T8", "strike": 100.0,
     "yes_bid": 0.74, "yes_ask": 0.77, "yes_mid": 0.755, "result": "yes", "exp_val": 102.0},
    # YES band loser
    {"event": "KXBTCD-26JAN0109", "ticker": "T9", "strike": 100.0,
     "yes_bid": 0.70, "yes_ask": 0.74, "yes_mid": 0.72, "result": "no", "exp_val": 99.0},
    # Spread-too-wide skip (10c spread > 5c gate)
    {"event": "KXBTCD-26JAN0110", "ticker": "T10", "strike": 100.0,
     "yes_bid": 0.55, "yes_ask": 0.65, "yes_mid": 0.60, "result": "no", "exp_val": 99.0},
    # Below band (no decision)
    {"event": "KXBTCD-26JAN0111", "ticker": "T11", "strike": 100.0,
     "yes_bid": 0.30, "yes_ask": 0.34, "yes_mid": 0.32, "result": "no", "exp_val": 95.0},
]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def parse_event_close_ts(event_ticker: str) -> Optional[int]:
    """Derive UTC close timestamp from event ticker like 'KXBTCD-26MAY1017'.
    Format: KX{SERIES}-YYMMMDDHH (YY=2-digit year, MMM=mon abbrev,
    DD=day, HH=close hour UTC). Returns unix seconds or None on parse fail."""
    m = EVENT_RE.match(event_ticker or "")
    if not m:
        return None
    _, yy, mon, dd, hh = m.groups()
    if mon not in MONTHS:
        return None
    try:
        when = dt.datetime(2000 + int(yy), MONTHS[mon], int(dd),
                           int(hh), 0, tzinfo=dt.timezone.utc)
        return int(when.timestamp())
    except ValueError:
        return None


def kalshi_fee_per_contract(yes_mid: float) -> float:
    """Kalshi published per-contract fee approximation:
       fee = ceil( 0.07 * P * (1-P) * 100 ) / 100
    Minimum $0.01 per contract per side."""
    raw = 0.07 * yes_mid * (1.0 - yes_mid)
    fee = math.ceil(raw * 100.0) / 100.0
    return max(fee, 0.01)


def ceil_to_cent(x: float) -> float:
    return math.ceil(x * 100.0) / 100.0


def normalize_row(row: Dict[str, Any]) -> Dict[str, Any]:
    """Make the input row uniform.

    The user explicitly says: if the existing fixture lacks yes_bid/yes_ask,
    approximate as open_yes - 0.01 / open_yes + 0.01. We mark approximation in
    the row so the summary flags it."""
    out = dict(row)
    out["_approximate_quotes"] = False
    if "yes_mid" not in out:
        if "open_yes" in out:
            out["yes_mid"] = out["open_yes"]
        elif "yes_bid" in out and "yes_ask" in out:
            out["yes_mid"] = (out["yes_bid"] + out["yes_ask"]) / 2.0
    if "yes_bid" not in out or "yes_ask" not in out:
        base = out.get("yes_mid", out.get("open_yes"))
        if base is None:
            return out  # unusable; caller will skip
        out["yes_bid"] = max(0.01, round(base - 0.01, 4))
        out["yes_ask"] = min(0.99, round(base + 0.01, 4))
        out["_approximate_quotes"] = True
    if "spread" not in out:
        out["spread"] = round(out["yes_ask"] - out["yes_bid"], 4)
    if "close_ts" not in out:
        out["close_ts"] = parse_event_close_ts(out.get("event", ""))
    return out


# ---------------------------------------------------------------------------
# Decision gate — pure function of T-60 quotes. NO `result` access.
# ---------------------------------------------------------------------------
def decide_side(yes_mid: float) -> Optional[str]:
    if NO_BAND[0] <= yes_mid < NO_BAND[1]:
        return "NO"
    if YES_BAND[0] <= yes_mid < YES_BAND[1]:
        return "YES"
    return None


def trade_cost(side: str, yes_bid: float, yes_ask: float, slippage: float) -> float:
    """Cost per contract for an immediate fill.

    NO contract pays $1 if result==no; price = (1 - yes_bid). We add slippage
    to reflect that aggressive fills sometimes walk one tick. YES = yes_ask +
    slippage. Floors at 0.01 and caps at 0.99 to stay within Kalshi tick range.
    """
    if side == "NO":
        c = (1.0 - yes_bid) + slippage
    else:
        c = yes_ask + slippage
    return min(0.99, max(0.01, c))


def expected_value_per_contract(side: str, cost: float, fee: float) -> float:
    """Empirical-rate EV per $1-payoff contract, net of round-trip fee. We
    fee both sides — entry fee + winning-settlement fee — because Kalshi
    charges on both. Losers don't pay the second fee but conservative."""
    p_win = EMPIRICAL_NO_WIN_RATE if side == "NO" else EMPIRICAL_YES_WIN_RATE
    # Win: receive $1, pay entry cost + entry fee + settle fee.
    # Lose: receive $0, pay entry cost + entry fee.
    return p_win * (1.0 - cost - 2 * fee) + (1 - p_win) * (-(cost + fee))


# ---------------------------------------------------------------------------
# Engine
# ---------------------------------------------------------------------------
def run_backtest(rows: List[Dict[str, Any]], cfg: argparse.Namespace) -> Dict[str, Any]:
    # 1. Normalize + filter unusable rows
    norm: List[Dict[str, Any]] = []
    approx_count = 0
    for r in rows:
        n = normalize_row(r)
        if n.get("yes_mid") is None or n.get("close_ts") is None or n.get("result") not in ("yes", "no"):
            continue
        if n.get("_approximate_quotes"):
            approx_count += 1
        norm.append(n)
    norm.sort(key=lambda x: x["close_ts"])  # chronological — protects compounding

    bankroll = float(cfg.start_bankroll)
    peak_bankroll = bankroll
    max_dd_pct = 0.0
    trades: List[Dict[str, Any]] = []
    skips: List[Dict[str, Any]] = []

    # Per-day tracking for daily-loss cap + daily summary
    daily_start_bankroll: Dict[str, float] = {}
    daily_halted: Dict[str, bool] = {}
    daily_pnl: Dict[str, Dict[str, Any]] = defaultdict(
        lambda: {"pnl": 0.0, "trades": 0, "wins": 0, "ending_balance": 0.0})

    # Per-event cap counter
    event_trade_count: Dict[str, int] = defaultdict(int)

    # Open exposure — for this backtest, exposure resolves at close_ts
    # of the same row, so we treat it as instantaneous: each new trade
    # checks bankroll exposure vs cap before committing.
    open_exposure = 0.0  # dollars currently at risk

    # Calibration buckets — observed yes rate per yes_mid decile. Built from
    # ALL decisions in band, not just those traded — so this is the true
    # decision-time calibration, NOT a lookback.
    calib_buckets: Dict[str, Dict[str, Any]] = defaultdict(
        lambda: {"n": 0, "sum_implied": 0.0, "yes_count": 0})

    total_fees = 0.0
    realized_returns: List[float] = []  # for daily Sharpe later

    for r in norm:
        ts = r["close_ts"]
        day = dt.datetime.fromtimestamp(ts, tz=dt.timezone.utc).strftime("%Y-%m-%d")
        if day not in daily_start_bankroll:
            daily_start_bankroll[day] = bankroll
            daily_halted[day] = False
            # close yesterday's ending_balance retroactively when we hit a new day
            # (final day handled after loop)
        yes_mid = float(r["yes_mid"])
        side = decide_side(yes_mid)

        # Calibration: record every in-band signal, traded or not
        if side is not None:
            bucket = f"{int(yes_mid * 100) // 5 * 5:02d}-{(int(yes_mid * 100) // 5 * 5) + 5:02d}c"
            cb = calib_buckets[bucket]
            cb["n"] += 1
            cb["sum_implied"] += yes_mid
            cb["yes_count"] += (1 if r["result"] == "yes" else 0)

        if side is None:
            continue  # no decision band; not even a "skip" — just not a signal

        # Honor --no-only by treating YES band as skipped, with reason
        if cfg.no_only and side == "YES":
            skips.append({"ts": ts, "event": r["event"], "ticker": r["ticker"],
                          "side": side, "yes_mid": yes_mid, "reason": "no_only_flag"})
            continue

        # --- Guard 0: optional spread filter (user-tunable, default OFF=0) ---
        spread_cents = round(r["spread"] * 100, 2)
        if cfg.min_spread_cents > 0 and spread_cents > cfg.min_spread_cents:
            skips.append({"ts": ts, "event": r["event"], "ticker": r["ticker"],
                          "side": side, "yes_mid": yes_mid, "reason": "spread_filter_user"})
            continue

        # --- Guard 1: spread > 5c ---
        if cfg.spread_cap_cents > 0 and spread_cents > cfg.spread_cap_cents:
            skips.append({"ts": ts, "event": r["event"], "ticker": r["ticker"],
                          "side": side, "yes_mid": yes_mid, "reason": "spread_too_wide"})
            continue

        # --- Guard 2: daily loss cap ---
        if daily_halted[day]:
            skips.append({"ts": ts, "event": r["event"], "ticker": r["ticker"],
                          "side": side, "yes_mid": yes_mid, "reason": "daily_loss_cap"})
            continue

        # --- Guard 3: event-cap (max 2 strikes per event) ---
        if event_trade_count[r["event"]] >= cfg.max_strikes_per_event:
            skips.append({"ts": ts, "event": r["event"], "ticker": r["ticker"],
                          "side": side, "yes_mid": yes_mid, "reason": "event_cap"})
            continue

        # --- Sizing inputs ---
        cost = trade_cost(side, r["yes_bid"], r["yes_ask"], cfg.slippage)
        fee = kalshi_fee_per_contract(yes_mid)
        ev_per_contract = expected_value_per_contract(side, cost, fee)

        # --- Guard 4: negative EV after fees ---
        if ev_per_contract <= 0:
            skips.append({"ts": ts, "event": r["event"], "ticker": r["ticker"],
                          "side": side, "yes_mid": yes_mid,
                          "reason": "negative_ev_after_fees"})
            continue

        budget = min(bankroll * cfg.sizing_pct, cfg.max_per_trade)
        per_contract_outlay = cost + fee
        contracts = int(budget // per_contract_outlay) if per_contract_outlay > 0 else 0
        if contracts < 1:
            skips.append({"ts": ts, "event": r["event"], "ticker": r["ticker"],
                          "side": side, "yes_mid": yes_mid, "reason": "below_min_size"})
            continue

        total_outlay = contracts * per_contract_outlay
        # --- Guard 5: exposure cap (this trade's outlay vs bankroll) ---
        if (open_exposure + total_outlay) > bankroll * cfg.exposure_cap_pct:
            skips.append({"ts": ts, "event": r["event"], "ticker": r["ticker"],
                          "side": side, "yes_mid": yes_mid, "reason": "exposure_cap"})
            continue

        # ====================================================================
        # COMMIT — past this line we are placing the order. Only NOW may we
        # read `result` to determine the payout. This is the firewall.
        # ====================================================================
        won = (side == "NO" and r["result"] == "no") or (side == "YES" and r["result"] == "yes")
        # Payout: $1 per contract if won, $0 if lost. Winners pay a settle fee.
        gross_payout = contracts * (1.0 if won else 0.0)
        settle_fee = contracts * fee if won else 0.0
        total_entry_fee = contracts * fee
        realized_pnl = gross_payout - (contracts * cost) - total_entry_fee - settle_fee

        bankroll += realized_pnl
        total_fees += total_entry_fee + settle_fee
        event_trade_count[r["event"]] += 1
        realized_returns.append(realized_pnl / max(1.0, daily_start_bankroll[day]))

        trades.append({
            "ts": ts, "date": day, "event": r["event"], "ticker": r["ticker"],
            "side": side, "yes_mid": yes_mid, "yes_bid": r["yes_bid"], "yes_ask": r["yes_ask"],
            "spread_cents": spread_cents, "contracts": contracts,
            "cost_per_contract": round(cost, 4),
            "fee_per_contract": round(fee, 4),
            "total_cost": round(contracts * cost, 4),
            "total_fee": round(total_entry_fee + settle_fee, 4),
            "expected_ev": round(ev_per_contract * contracts, 4),
            "won": won, "payout": round(gross_payout, 2),
            "realized_pnl": round(realized_pnl, 4),
            "bankroll_after": round(bankroll, 4),
            "approximate_quotes": r.get("_approximate_quotes", False),
        })

        daily_pnl[day]["pnl"] += realized_pnl
        daily_pnl[day]["trades"] += 1
        daily_pnl[day]["wins"] += int(won)
        daily_pnl[day]["ending_balance"] = bankroll

        # Drawdown tracking
        if bankroll > peak_bankroll:
            peak_bankroll = bankroll
        dd = (peak_bankroll - bankroll) / peak_bankroll if peak_bankroll > 0 else 0
        if dd > max_dd_pct:
            max_dd_pct = dd

        # Daily loss cap check
        day_loss_pct = (daily_start_bankroll[day] - bankroll) / daily_start_bankroll[day]
        if day_loss_pct >= cfg.daily_loss_cap_pct:
            daily_halted[day] = True

    # ----- Build summary -----
    wins = sum(1 for t in trades if t["won"])
    losses = len(trades) - wins
    win_rate = (wins / len(trades)) if trades else 0.0
    pnl = bankroll - cfg.start_bankroll
    pnl_pct = pnl / cfg.start_bankroll if cfg.start_bankroll > 0 else 0
    days_traded = sum(1 for d in daily_pnl.values() if d["trades"] > 0)
    # Sharpe: mean(daily returns) / std * sqrt(252). Use only days with trades.
    daily_returns = [
        d["pnl"] / daily_start_bankroll[date]
        for date, d in daily_pnl.items() if d["trades"] > 0
    ]
    sharpe = 0.0
    if len(daily_returns) > 1:
        mean = sum(daily_returns) / len(daily_returns)
        var = sum((x - mean) ** 2 for x in daily_returns) / (len(daily_returns) - 1)
        sd = math.sqrt(var)
        sharpe = (mean / sd) * math.sqrt(252) if sd > 0 else 0.0

    calibration = {}
    for bucket, c in sorted(calib_buckets.items()):
        if c["n"] == 0:
            continue
        avg_imp = c["sum_implied"] / c["n"]
        realized = c["yes_count"] / c["n"]
        calibration[bucket] = {"n": c["n"], "avg_implied": round(avg_imp, 4),
                               "realized_yes_rate": round(realized, 4),
                               "gap": round(realized - avg_imp, 4)}

    daily_list = []
    for date in sorted(daily_pnl.keys()):
        d = daily_pnl[date]
        if d["trades"] == 0:
            continue
        daily_list.append({"date": date, "pnl": round(d["pnl"], 4),
                           "ending_balance": round(d["ending_balance"], 4),
                           "trades": d["trades"],
                           "win_rate": round(d["wins"] / d["trades"], 4)})

    result = {
        "summary": {
            "start_bankroll": cfg.start_bankroll,
            "end_bankroll": round(bankroll, 4),
            "pnl": round(pnl, 4),
            "pnl_pct": round(pnl_pct, 6),
            "total_trades": len(trades),
            "wins": wins, "losses": losses,
            "win_rate": round(win_rate, 4),
            "total_fees": round(total_fees, 4),
            "max_drawdown_pct": round(max_dd_pct, 6),
            "days_traded": days_traded,
            "sharpe_annualized": round(sharpe, 4),
            "approximate_quotes_used": approx_count,
            "rows_in": len(rows), "rows_used": len(norm),
            "skipped_signals": len(skips),
        },
        "daily_pnl": daily_list,
        "trades": trades,
        "skips": skips,
        "calibration": calibration,
        "config": vars(cfg),
    }
    return result


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__.split("\n")[1] if __doc__ else "")
    p.add_argument("--input", help="Path to samples JSON (list of dicts).")
    p.add_argument("--start-bankroll", type=float, default=7000.0)
    p.add_argument("--sizing-pct", type=float, default=0.02,
                   help="Fraction of bankroll budgeted per trade (cap).")
    p.add_argument("--max-per-trade", type=float, default=500.0,
                   help="Hard $ cap on per-trade outlay.")
    p.add_argument("--slippage", type=float, default=0.0,
                   help="Extra cents/contract added to fill price.")
    p.add_argument("--no-only", action="store_true",
                   help="Disable YES band; only buy NO.")
    p.add_argument("--min-spread-cents", type=float, default=0.0,
                   help="If >0, skip strikes with spread > N cents.")
    p.add_argument("--spread-cap-cents", type=float, default=5.0,
                   help="Hard skip if spread > this (default Kalshi-typical 5c).")
    p.add_argument("--daily-loss-cap-pct", type=float, default=0.10)
    p.add_argument("--exposure-cap-pct", type=float, default=0.20)
    p.add_argument("--max-strikes-per-event", type=int, default=2)
    p.add_argument("--out", default="/tmp/backtest_result.json")
    p.add_argument("--self-test", action="store_true",
                   help="Run on built-in fixture and print expected vs actual.")
    p.add_argument("--quiet", action="store_true",
                   help="Suppress stdout summary.")
    return p


def print_summary(result: Dict[str, Any]) -> None:
    s = result["summary"]
    print()
    print("=" * 72)
    print(f"KALSHI KXBTCD/KXETHD BACKTEST")
    print("=" * 72)
    if s.get("approximate_quotes_used"):
        print(f"!! APPROXIMATE QUOTES USED on {s['approximate_quotes_used']} rows")
        print(f"   (yes_bid/yes_ask synthesized from open_yes ± 1c) !!")
    print(f"Rows in: {s['rows_in']}  used: {s['rows_used']}  skipped: {s['skipped_signals']}")
    print(f"Days traded: {s['days_traded']}")
    print("-" * 72)
    print(f"Start bankroll    : ${s['start_bankroll']:>12,.2f}")
    print(f"End bankroll      : ${s['end_bankroll']:>12,.2f}")
    print(f"P&L               : ${s['pnl']:>12,.2f}  ({s['pnl_pct']*100:+.2f}%)")
    print(f"Total trades      : {s['total_trades']:>13}")
    print(f"Wins / Losses     : {s['wins']:>6} / {s['losses']:>6}")
    print(f"Win rate          : {s['win_rate']*100:>12.2f}%")
    print(f"Total fees paid   : ${s['total_fees']:>12,.2f}")
    print(f"Max drawdown      : {s['max_drawdown_pct']*100:>12.2f}%")
    print(f"Sharpe (annual)   : {s['sharpe_annualized']:>13.2f}")
    print("-" * 72)
    print("Skip reasons:")
    skip_counts: Dict[str, int] = defaultdict(int)
    for sk in result["skips"]:
        skip_counts[sk["reason"]] += 1
    for reason, n in sorted(skip_counts.items(), key=lambda kv: -kv[1]):
        print(f"  {reason:<30} {n:>6}")
    print("-" * 72)
    print("Calibration (yes_mid bucket → realized yes-rate):")
    for bucket, c in result["calibration"].items():
        print(f"  {bucket}  n={c['n']:>5}  avg_implied={c['avg_implied']:.3f}  "
              f"realized={c['realized_yes_rate']:.3f}  gap={c['gap']:+.3f}")
    print("=" * 72)


def main(argv: Optional[List[str]] = None) -> int:
    parser = build_parser()
    cfg = parser.parse_args(argv)

    if cfg.self_test:
        result = run_backtest(__TEST_FIXTURE__, cfg)
        # Hand-checked expectations for the fixture: 8 trades attempted (1
        # spread-skipped, 1 below-band non-signal). Trades: 6 NO + 2 YES if EV
        # gate passes; we just sanity-check counts and a positive P&L.
        s = result["summary"]
        print("[self-test] trades_attempted_in_band =", s["total_trades"] + sum(
            1 for sk in result["skips"] if sk["reason"] in
            ("spread_too_wide", "negative_ev_after_fees", "below_min_size",
             "exposure_cap", "daily_loss_cap", "event_cap", "spread_filter_user",
             "no_only_flag")))
        print("[self-test] trades_taken =", s["total_trades"])
        print("[self-test] wins / losses =", s["wins"], "/", s["losses"])
        print("[self-test] end_bankroll =", s["end_bankroll"])
        print("[self-test] PASS expected: positive PnL because fixture is "
              "deliberately winner-heavy.")
        ok = (s["total_trades"] >= 5 and s["pnl"] > 0)
        print("[self-test] RESULT:", "PASS" if ok else "FAIL")
        return 0 if ok else 1

    if not cfg.input or not os.path.exists(cfg.input):
        parser.print_help()
        print("\nERROR: --input PATH required and must exist.", file=sys.stderr)
        print(f"Got: {cfg.input!r}", file=sys.stderr)
        return 2

    with open(cfg.input) as f:
        rows = json.load(f)
    if not isinstance(rows, list):
        print("ERROR: input JSON must be a list of dicts.", file=sys.stderr)
        return 2

    result = run_backtest(rows, cfg)
    with open(cfg.out, "w") as f:
        json.dump(result, f, indent=2, default=str)

    if not cfg.quiet:
        print_summary(result)
        print(f"\nFull result written to: {cfg.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
