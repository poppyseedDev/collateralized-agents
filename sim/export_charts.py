"""Chart data for the simulation report page.

Everything here is derived from the same runs that produce the summary tables,
so the charts and the numbers can never disagree.

    python3 sim/run.py && python3 sim/export_charts.py
"""

import json
import os

from fetch_prices import load
from protocol import BPS, max_fee_bps
from run import DRAWDOWNS, DURATIONS, RATIOS, WARMUP, returns_for
from strategies import STRATEGIES, make_rng, trace

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.abspath(os.path.join(HERE, "..", "app", "lib", "simulationCharts.json"))

ORDER = ["hold", "momentum", "mean_reversion", "coinflip", "overtrader",
         "leveraged_chaser", "dishonest"]
# Equity curves and histograms are drawn for the strategies that actually trade.
CURVE_KEYS = ["hold", "momentum", "mean_reversion", "coinflip", "overtrader"]
HIST_DURATION = 30
HIST_BINS = 48
HIST_LO, HIST_HI = 0.4, 1.8   # SOL multiple range the histogram covers
CURVE_POINTS = 320


def r(x, n=4):
    return round(x, n)


def downsample(series, n):
    """Keep n evenly spaced points, always including the last one."""
    if len(series) <= n:
        return list(series)
    step = (len(series) - 1) / (n - 1)
    return [series[min(len(series) - 1, round(i * step))] for i in range(n)]


def histogram(values, lo=HIST_LO, hi=HIST_HI, bins=HIST_BINS):
    """Share of positions in each bin, plus the mass outside the range."""
    counts = [0] * bins
    under = over = 0
    width = (hi - lo) / bins
    for v in values:
        if v < lo:
            under += 1
        elif v >= hi:
            over += 1
        else:
            counts[min(bins - 1, int((v - lo) / width))] += 1
    n = len(values) or 1
    return {
        "lo": lo,
        "hi": hi,
        "bins": [r(c / n, 5) for c in counts],
        "under": r(under / n, 5),
        "over": r(over / n, 5),
    }


def main():
    dates, closes = load()

    # 1. The price the whole simulation runs on.
    idx = list(range(len(closes)))
    keep = downsample(idx, CURVE_POINTS)
    price = {
        "dates": [dates[i] for i in keep],
        "close": [r(closes[i], 2) for i in keep],
    }

    # 2. SOL-denominated equity curves over the whole history. This is the
    #    chart that shows why sitting in USDC costs SOL.
    curves = {}
    for key in CURVE_KEYS:
        path = trace(key, closes, WARMUP, len(closes) - 1, make_rng(11))
        pick = downsample(list(range(len(path))), CURVE_POINTS)
        base = closes[WARMUP]
        # The same position valued two ways. The protocol settles in SOL, so
        # the SOL line is what decides a breach; the dollar line is what an
        # operator's own dashboard would show them.
        curves[key] = {
            "dates": [dates[WARMUP + i] for i in pick],
            "sol": [r(path[i], 4) for i in pick],
            "usd": [r(path[i] * closes[WARMUP + i] / base, 4) for i in pick],
        }

    # 3. Distribution of what each strategy hands back at settlement.
    hist = {}
    for key in ORDER:
        ms = returns_for(closes, key, HIST_DURATION)
        hist[key] = histogram(ms)
        hist[key]["median"] = r(sorted(ms)[len(ms) // 2])

    # 4. Breach rate and operator return against drawdown tolerance, for every
    #    position length, at a 30% ratio. Drives the two line charts.
    ratio_bps = 3000
    fee_bps = max_fee_bps(ratio_bps)
    ratio = ratio_bps / BPS
    lines = {}
    for key in ORDER:
        per_duration = {}
        for d in DURATIONS:
            ms = returns_for(closes, key, d)
            n = len(ms) or 1
            gross = sum(max(0.0, m - 1.0) for m in ms) / n
            fee_per_bond = gross * fee_bps / BPS / ratio
            breach, apr = [], []
            for dd in DRAWDOWNS:
                tol = dd / BPS
                slash = sum(min(max(0.0, (1.0 - m) - tol), ratio) for m in ms) / n
                breach.append(r(sum(1 for m in ms if (1.0 - m) > tol) / n))
                net = fee_per_bond - slash / ratio
                apr.append(r(((1 + net) ** (365 / d) - 1) if net > -1 else -1.0, 3))
            per_duration[str(d)] = {"breach": breach, "apr": apr}
        lines[key] = per_duration

    out = {
        "meta": {
            "firstDate": dates[0],
            "lastDate": dates[-1],
            "candles": len(closes),
            "histDuration": HIST_DURATION,
            "ratioBps": ratio_bps,
            "feeBps": fee_bps,
            "drawdowns": DRAWDOWNS,
            "durations": DURATIONS,
            "curveKeys": CURVE_KEYS,
            "order": ORDER,
            "labels": {k: STRATEGIES[k][0] for k in ORDER},
        },
        "price": price,
        "curves": curves,
        "histogram": hist,
        "lines": lines,
    }
    with open(WEB, "w") as fh:
        json.dump(out, fh, separators=(",", ":"))
    print(f"wrote {WEB} ({os.path.getsize(WEB)/1024:.0f} KB)")


if __name__ == "__main__":
    main()
