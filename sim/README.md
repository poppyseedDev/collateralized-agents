# Operator risk simulation

Answers one question: **on Proof of Agent, does an operator lose money for any
reason other than a bad strategy or dishonesty?**

```bash
python3 sim/fetch_prices.py   # cache real SOL/USD daily closes (Binance, no key)
python3 sim/run.py            # full sweep -> sim/results/
python3 sim/export_web.py     # summary tables -> app/lib/simulation.json
python3 sim/export_charts.py  # chart data   -> app/lib/simulationCharts.json
```

The charts are at [/simulation](https://dev.proofofagent.dev/simulation) in the
app: the price history, equity curves in SOL and in dollars, the distribution
of what comes back at settlement, and breach rate against operator return.

No dependencies beyond the Python standard library.

## Method

Six years of real SOL/USD daily closes (Aug 2020 onward, 2,236 candles). For
every strategy and every position length, a position is opened on **every
possible start date** and settled through `sim/protocol.py`, a line-by-line
port of `compute_settlement` in the on-chain program. Swap costs are 15 bps a
leg. Nothing is annualised from a single path; every number is an average over
roughly two thousand overlapping positions.

Strategies range from the honest baseline (draw the funds, hold SOL, return
them) through ordinary rules (trend following, mean reversion, a no-edge
coinflip) to deliberately bad ones (daily churn, 3x leveraged chasing) and
outright theft.

## Findings

**1. Market direction never costs the operator.** Holding SOL returns exactly
the principal, so it never breaches, at any tolerance and any duration. Because
positions are denominated in SOL, a fall in SOL's dollar price is not a loss.
The bond is only ever at risk for underperforming SOL itself by more than the
declared tolerance.

**2. A good strategy is comfortably profitable.** Trend following at a 30%
ratio and a 15% tolerance breaches 10.8% of 30-day positions and still returns
about 17% a year on the bond. Loosen the tolerance to 20% and it is 6.4% and
37%.

**3. The real risk is publishing terms tighter than the strategy warrants.**
This is the finding that qualifies the intuition. An operator is not punished
for being mediocre; they are punished for promising a floor they cannot hold.
The tightest tolerance each strategy can publish and still profit:

| Strategy | 1d | 7d | 14d | 30d | 60d | 90d |
|---|---|---|---|---|---|---|
| Hold SOL | 5% | 5% | 5% | 5% | 5% | 5% |
| Trend following | 10% | 15% | 15% | 15% | 15% | 15% |
| Mean reversion | 10% | 25% | 40% | 50% | — | — |
| No edge | 10% | 15% | 20% | 30% | 40% | 50% |
| Overtrading | 10% | 20% | 25% | 40% | — | — |
| Leveraged chasing | 20% | 40% | 50% | 50% | — | — |
| Dishonest | — | — | — | — | — | — |

A dash means no tolerance the program allows makes it profitable. Genuinely
reckless strategies run out of room at long durations; honest ones never do.

**4. More collateral is better for the operator, not worse.** Because the fee
cap scales with the ratio while the slash is capped by the loss, fee income per
SOL of bond is constant across ratios but slash risk falls. With the bond fully
deployed on 30-day trend-following positions at a 15% tolerance:

| Ratio | Capital backed | Fee | Slash | Return on bond |
|---|---|---|---|---|
| 10% | 10.0x | 4.4% | 6.4% | −22% |
| 30% | 3.3x | 4.4% | 3.1% | +17% |
| 100% | 1.0x | 4.4% | 0.9% | +52% |

The incentive points the right way: an operator maximising return on collateral
posts more of it, which is exactly what traders want.

**5. Dishonesty costs the whole bond but still pays.** An operator who draws
the principal and never settles loses 100% of the locked bond. At a 30% ratio
the trader recovers 30% and loses 70%. Walking away is profitable for the
operator at any ratio below 100%. The bond makes bad trading expensive; it does
not make theft unprofitable. See `docs/settlement.md`.

## Files

| File | What it does |
|---|---|
| `fetch_prices.py` | Caches SOL/USD daily closes to `data/` |
| `protocol.py` | Port of the on-chain settlement maths |
| `strategies.py` | The strategies, all SOL-denominated |
| `run.py` | Sweeps duration, tolerance and ratio; writes `results/` |
| `export_web.py` | Condenses results for the How it works page |
| `export_charts.py` | Equity curves, distributions and trade-off lines for the charts |
