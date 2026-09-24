"""Condense the sweep into the JSON the How it works page reads.

    python3 sim/run.py && python3 sim/export_web.py
"""

import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
RESULTS = os.path.join(HERE, "results")
WEB = os.path.abspath(os.path.join(HERE, "..", "app", "lib", "simulation.json"))

# Ordered for display: honest baseline first, dishonest last.
ORDER = ["hold", "momentum", "mean_reversion", "coinflip", "overtrader",
         "leveraged_chaser", "dishonest"]
KIND = {
    "hold": "baseline",
    "momentum": "ordinary",
    "mean_reversion": "ordinary",
    "coinflip": "ordinary",
    "overtrader": "bad",
    "leveraged_chaser": "bad",
    "dishonest": "dishonest",
}


def r4(x):
    return None if x is None else round(x, 4)


def main():
    sweep = json.load(open(os.path.join(RESULTS, "sweep.json")))
    util = json.load(open(os.path.join(RESULTS, "utilisation.json")))
    safe = json.load(open(os.path.join(RESULTS, "safe_terms.json")))
    meta = sweep["meta"]

    apr = {(r["strategy"], r["duration_days"], r["drawdown_bps"], r["ratio_bps"]):
           r["apr_on_bond"] for r in util["rows"]}

    strategies, seen = [], set()
    for row in sweep["rows"]:
        k = row["strategy"]
        if k in seen:
            continue
        seen.add(k)
        strategies.append({
            "key": k,
            "label": row["label"],
            "description": row["description"],
            "kind": KIND.get(k, "ordinary"),
        })
    strategies.sort(key=lambda s: ORDER.index(s["key"]) if s["key"] in ORDER else 99)

    # Packed as parallel flat arrays, ordered strategy -> duration ->
    # drawdown -> ratio, so the payload stays small enough to ship to the
    # browser. The page rebuilds the index from meta.
    order = {}
    n = 0
    for st in strategies:
        for d in meta["durations"]:
            for dd in meta["drawdowns_bps"]:
                for rt in meta["ratios_bps"]:
                    order[(st["key"], d, dd, rt)] = n
                    n += 1
    breach = [0.0] * n
    slash = [0.0] * n
    trader = [0.0] * n
    aprs = [0.0] * n
    for row in sweep["rows"]:
        k = (row["strategy"], row["duration_days"],
             row["drawdown_bps"], row["ratio_bps"])
        i = order.get(k)
        if i is None:
            continue
        breach[i] = r4(row["breach_rate"])
        slash[i] = r4(row["mean_slash_pct_of_bond"])
        trader[i] = r4(row["mean_trader_return"])
        aprs[i] = r4(apr.get(k)) or 0.0

    safe_rows = [{
        "strategy": s["strategy"],
        "duration_days": s["duration_days"],
        "safe_drawdown_bps": s["safe_drawdown_bps"],
    } for s in safe["rows"]]

    out = {
        "meta": {
            "source": meta["source"],
            "firstDate": meta["first_date"],
            "lastDate": meta["last_date"],
            "candles": meta["candles"],
            "swapCostBps": meta["swap_cost_bps"],
            "durations": meta["durations"],
            "drawdowns": meta["drawdowns_bps"],
            "ratios": meta["ratios_bps"],
            "positionsPerCell": max(
                row["positions"] for row in sweep["rows"]),
        },
        "strategies": strategies,
        "safeDrawdown": safe_rows,
        "cells": {
            "breach": breach,
            "slash": slash,
            "trader": trader,
            "apr": aprs,
        },
    }
    os.makedirs(os.path.dirname(WEB), exist_ok=True)
    with open(WEB, "w") as fh:
        json.dump(out, fh, separators=(",", ":"))
    size = os.path.getsize(WEB) / 1024
    print(f"wrote {WEB} ({size:.0f} KB, {n} cells)")


if __name__ == "__main__":
    main()
