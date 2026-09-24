"""Download real SOL/USD daily candles and cache them as CSV.

Source: Binance public klines endpoint (no API key required).
Usage: python3 sim/fetch_prices.py [--symbol SOLUSDT] [--interval 1d]
"""

import argparse
import csv
import json
import os
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
BASE = "https://api.binance.com/api/v3/klines"


def fetch(symbol: str, interval: str, start_ms: int, limit: int = 1000):
    url = f"{BASE}?symbol={symbol}&interval={interval}&startTime={start_ms}&limit={limit}"
    req = urllib.request.Request(url, headers={"User-Agent": "proof-of-agent-sim/1.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode())


def download(symbol: str, interval: str) -> str:
    rows = []
    start = 0  # Binance clamps to the first listed candle
    while True:
        batch = fetch(symbol, interval, start)
        if not batch:
            break
        rows.extend(batch)
        if len(batch) < 1000:
            break
        start = batch[-1][0] + 1
        time.sleep(0.25)

    os.makedirs(DATA, exist_ok=True)
    path = os.path.join(DATA, f"{symbol.lower()}_{interval}.csv")
    with open(path, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["open_time_ms", "date", "open", "high", "low", "close", "volume"])
        for r in rows:
            date = time.strftime("%Y-%m-%d", time.gmtime(r[0] / 1000))
            w.writerow([r[0], date, r[1], r[2], r[3], r[4], r[5]])
    return path


def load(symbol: str = "SOLUSDT", interval: str = "1d"):
    """Return (dates, closes) from the cached CSV, downloading it if missing."""
    path = os.path.join(DATA, f"{symbol.lower()}_{interval}.csv")
    if not os.path.exists(path):
        download(symbol, interval)
    dates, closes = [], []
    with open(path) as fh:
        for row in csv.DictReader(fh):
            dates.append(row["date"])
            closes.append(float(row["close"]))
    return dates, closes


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--symbol", default="SOLUSDT")
    ap.add_argument("--interval", default="1d")
    args = ap.parse_args()
    p = download(args.symbol, args.interval)
    d, c = load(args.symbol, args.interval)
    print(f"wrote {p}")
    print(f"{len(c)} candles, {d[0]} -> {d[-1]}, ${c[0]:.2f} -> ${c[-1]:.2f}")
