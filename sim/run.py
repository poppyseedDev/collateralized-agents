"""Proof of Agent — operator risk simulation.

Question: does an operator lose money on Proof of Agent for any reason other
than a genuinely bad strategy or dishonesty?

Method: run ordinary strategies over six years of real SOL/USD daily closes,
open a position at every possible start date, and settle each one through a
faithful port of the on-chain settlement maths. Report how often the bond gets
slashed, how much, and what the operator earns per unit of collateral.

    python3 sim/run.py            # full sweep, writes sim/results/
    python3 sim/run.py --quick    # fewer parameter points
"""

import argparse
import json
import os
import statistics
from collections import defaultdict

from fetch_prices import load
from protocol import (BPS as BPS_F, MAX_DRAWDOWN_BPS, MIN_COLLATERAL_RATIO_BPS, max_fee_bps,
                      required_collateral, settle)
from strategies import STRATEGIES, make_rng

HERE = os.path.dirname(os.path.abspath(__file__))
RESULTS = os.path.join(HERE, "results")

DURATIONS = [1, 3, 7, 14, 30, 60, 90]
DRAWDOWNS = [500, 1000, 1500, 2000, 2500, 3000, 4000, 5000]
RATIOS = [1000, 2000, 3000, 5000, 10000]
WARMUP = 30  # days of history the moving averages need before a position opens
PRINCIPAL = 100.0  # SOL; the maths is linear so the unit is arbitrary


def returns_for(history, key, duration):
    """SOL multiple returned for a position of `duration` days opened at every
    date in the series. Deterministic: the RNG is seeded per window."""
    _, fn, _ = STRATEGIES[key]
    out = []
    last = len(history) - 1
    for i0 in range(WARMUP, last - duration + 1):
        rng = make_rng(i0 * 7919 + duration)
        out.append(fn(history, i0, i0 + duration, rng))
    return out


def pct(values, q):
    if not values:
        return 0.0
    s = sorted(values)
    idx = min(len(s) - 1, max(0, int(round(q * (len(s) - 1)))))
    return s[idx]


def summarise(multiples, drawdown_bps, ratio_bps, fee_bps, duration_days):
    locked = required_collateral(PRINCIPAL, ratio_bps)
    breaches = 0
    slashes, fees, trader_rets, op_pnls = [], [], [], []
    for m in multiples:
        s = settle(PRINCIPAL, m * PRINCIPAL, fee_bps, drawdown_bps, locked)
        if s.breached:
            breaches += 1
        slashes.append(s.slash)
        fees.append(s.fee)
        trader_rets.append(s.trader_return)
        op_pnls.append(s.operator_pnl)
    n = len(multiples) or 1
    mean_op = sum(op_pnls) / n
    per_position = mean_op / locked if locked else 0.0
    return {
        "positions": len(multiples),
        "breach_rate": breaches / n,
        "mean_slash_pct_of_bond": (sum(slashes) / n) / locked if locked else 0.0,
        "mean_fee_pct_of_principal": (sum(fees) / n) / PRINCIPAL,
        "mean_operator_pnl_pct_of_bond": mean_op / locked if locked else 0.0,
        "operator_apr_on_bond": ((1 + per_position) ** (365 / duration_days) - 1)
        if per_position > -1 else -1.0,
        "operator_profitable": mean_op > 0,
        "mean_trader_return": sum(trader_rets) / n,
        "median_trader_return": statistics.median(trader_rets) if trader_rets else 0.0,
        "p05_trader_return": pct(trader_rets, 0.05),
        "worst_trader_return": min(trader_rets) if trader_rets else 0.0,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--quick", action="store_true")
    args = ap.parse_args()

    durations = [7, 30] if args.quick else DURATIONS
    drawdowns = [1000, 2000, 3000] if args.quick else DRAWDOWNS
    ratios = [3000] if args.quick else RATIOS

    dates, closes = load()
    print(f"SOL/USD daily closes: {len(closes)} candles, {dates[0]} -> {dates[-1]}")
    print(f"price {closes[0]:.2f} -> {closes[-1]:.2f}\n")

    multiples = defaultdict(dict)
    for key in STRATEGIES:
        for d in durations:
            multiples[key][d] = returns_for(closes, key, d)

    sweep = []
    for key, (label, _, blurb) in STRATEGIES.items():
        for d in durations:
            ms = multiples[key][d]
            row_base = {
                "strategy": key,
                "label": label,
                "description": blurb,
                "duration_days": d,
                "median_sol_multiple": statistics.median(ms) if ms else 0.0,
                "mean_sol_multiple": sum(ms) / len(ms) if ms else 0.0,
                "p05_sol_multiple": pct(ms, 0.05),
            }
            for dd in drawdowns:
                for r in ratios:
                    fee = max_fee_bps(r)
                    row = dict(row_base)
                    row.update({
                        "drawdown_bps": dd,
                        "ratio_bps": r,
                        "fee_bps": fee,
                    })
                    row.update(summarise(ms, dd, r, fee, d))
                    sweep.append(row)

    os.makedirs(RESULTS, exist_ok=True)
    meta = {
        "source": "Binance SOLUSDT daily closes",
        "first_date": dates[0],
        "last_date": dates[-1],
        "candles": len(closes),
        "warmup_days": WARMUP,
        "swap_cost_bps": 15,
        "principal_sol": PRINCIPAL,
        "durations": durations,
        "drawdowns_bps": drawdowns,
        "ratios_bps": ratios,
    }
    with open(os.path.join(RESULTS, "sweep.json"), "w") as fh:
        json.dump({"meta": meta, "rows": sweep}, fh, indent=1)

    utilised = utilisation_sweep(multiples, durations, drawdowns, ratios)
    with open(os.path.join(RESULTS, "utilisation.json"), "w") as fh:
        json.dump({"meta": meta, "rows": utilised}, fh, indent=1)

    safe = safe_terms(sweep, durations, drawdowns, ratio_bps=3000)
    with open(os.path.join(RESULTS, "safe_terms.json"), "w") as fh:
        json.dump({"meta": meta, "rows": safe}, fh, indent=1)

    report(sweep, meta, durations)
    report_safe(safe, durations)
    return sweep, meta, multiples, durations


def utilisation_sweep(multiples, durations, drawdowns, ratios):
    """Operator economics per SOL of bond with the bond fully deployed.

    A bond of 1 SOL at ratio r backs 1/r SOL of trader capital, so fee income
    and slash risk are both scaled by 1/r. This is the view that matters to an
    operator deciding how much collateral to post.
    """
    out = []
    for key, (label, _, blurb) in STRATEGIES.items():
        for d in durations:
            ms = multiples[key][d]
            n = len(ms) or 1
            gross_profit = sum(max(0.0, m - 1.0) for m in ms) / n
            for ratio_bps in ratios:
                ratio = ratio_bps / BPS_F
                fee_bps = max_fee_bps(ratio_bps)
                capital = 1.0 / ratio  # per SOL of bond
                for dd in drawdowns:
                    tol = dd / BPS_F
                    slash = sum(min(max(0.0, (1.0 - m) - tol), ratio) for m in ms) / n
                    fee = gross_profit * fee_bps / BPS_F
                    net = capital * (fee - slash)
                    apr = ((1 + net) ** (365 / d) - 1) if net > -1 else -1.0
                    out.append({
                        "strategy": key,
                        "label": label,
                        "duration_days": d,
                        "ratio_bps": ratio_bps,
                        "fee_bps": fee_bps,
                        "drawdown_bps": dd,
                        "capital_per_bond": capital,
                        "fee_per_bond": capital * fee,
                        "slash_per_bond": capital * slash,
                        "net_per_bond": net,
                        "apr_on_bond": apr,
                    })
    return out


def safe_terms(sweep, durations, drawdowns, ratio_bps=3000):
    """For each strategy and position length, the tightest drawdown tolerance
    at which the operator still expects to make money. This is the number an
    operator actually needs before publishing terms."""
    index = {(r["strategy"], r["duration_days"], r["drawdown_bps"]): r
             for r in sweep if r["ratio_bps"] == ratio_bps}
    out = []
    for key, (label, _, blurb) in STRATEGIES.items():
        for d in durations:
            chosen = None
            for dd in sorted(drawdowns):
                row = index.get((key, d, dd))
                if row and row["mean_operator_pnl_pct_of_bond"] >= 0:
                    chosen = row
                    break
            out.append({
                "strategy": key,
                "label": label,
                "description": blurb,
                "duration_days": d,
                "ratio_bps": ratio_bps,
                "safe_drawdown_bps": chosen["drawdown_bps"] if chosen else None,
                "breach_rate_at_safe": chosen["breach_rate"] if chosen else None,
                "operator_pnl_at_safe": chosen["mean_operator_pnl_pct_of_bond"] if chosen else None,
                "trader_return_at_safe": chosen["mean_trader_return"] if chosen else None,
                "viable": chosen is not None,
            })
    return out


def report_safe(safe, durations):
    print("\n\nTightest drawdown tolerance an operator can publish and still profit")
    print("(30% collateral ratio, 15% fee on profit; '-' = never profitable "
          "at any tolerance the program allows)")
    header = f"{'strategy':<20}" + "".join(f"{str(d)+'d':>8}" for d in durations)
    print(header)
    print("-" * len(header))
    by = {}
    for r in safe:
        by[(r["strategy"], r["duration_days"])] = r
    seen = []
    for r in safe:
        if r["strategy"] in seen:
            continue
        seen.append(r["strategy"])
        cells = ""
        for d in durations:
            row = by[(r["strategy"], d)]
            cells += (f"{row['safe_drawdown_bps']//100:>7}%" if row["viable"] else f"{'-':>8}")
        print(f"{r['label']:<20}{cells}")


def report(sweep, meta, durations):
    """Print the headline answer at the terms a sane agent would publish."""
    d, dd, r = 30, 2000, 3000
    if d not in durations:
        d = durations[0]
    print(f"Terms: {d}-day position, {dd/100:.0f}% drawdown tolerance, "
          f"{r/100:.0f}% collateral ratio, {max_fee_bps(r)/100:.0f}% fee on profit")
    print(f"{'strategy':<20} {'breach':>8} {'slash/bond':>11} "
          f"{'fee/principal':>13} {'op PnL/bond':>12} {'trader':>9}")
    print("-" * 80)
    for row in sweep:
        if row["duration_days"] == d and row["drawdown_bps"] == dd and row["ratio_bps"] == r:
            print(f"{row['label']:<20} {row['breach_rate']*100:>7.1f}% "
                  f"{row['mean_slash_pct_of_bond']*100:>10.2f}% "
                  f"{row['mean_fee_pct_of_principal']*100:>12.2f}% "
                  f"{row['mean_operator_pnl_pct_of_bond']*100:>11.2f}% "
                  f"{row['mean_trader_return']*100:>8.2f}%")


if __name__ == "__main__":
    main()
