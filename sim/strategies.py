"""SOL-denominated trading strategies.

A strategy takes a window of SOL/USD closes and returns the SOL multiple it
ends with, starting from 1.0 SOL. Because Proof of Agent positions are
denominated in SOL, a strategy that sits in USDC while SOL rises *loses* SOL
even though it gained dollars. That asymmetry is the point of the simulation.

`history` is the full close series and `i0`/`i1` index the position window, so
signals may look back before the position opened (as a live bot would).
"""

import random

SWAP_COST = 0.0015  # 15 bps per leg: DEX fee + slippage on a liquid SOL pair


def _walk(history, i0, i1, want_sol, cost=SWAP_COST, record=None):
    """Run a daily in-SOL / in-USDC schedule and return the final SOL multiple.

    want_sol(t) -> bool decides the exposure held over day t -> t+1.
    If `record` is a list, the SOL-denominated value is appended for each day,
    which is what the equity-curve charts draw.
    """
    sol = 1.0          # SOL held while in SOL
    usd = 0.0          # USD held while in USDC
    in_sol = True
    for t in range(i0, i1):
        target = want_sol(t)
        if target != in_sol:
            p = history[t]
            if in_sol:
                usd = sol * p * (1 - cost)
                sol = 0.0
            else:
                sol = usd / p * (1 - cost)
                usd = 0.0
            in_sol = target
        if record is not None:
            record.append(sol if in_sol else usd / history[t])
    if not in_sol:  # must end in SOL to settle
        sol = usd / history[i1] * (1 - cost)
    if record is not None:
        record.append(sol)
    return sol


def hold(history, i0, i1, rng):
    """Do nothing. Always returns exactly the principal: the honest baseline."""
    return 1.0


_SMA_CACHE = {}


def _sma_series(history, n):
    """Trailing simple moving average for every index, via prefix sums."""
    key = (id(history), len(history), n)
    hit = _SMA_CACHE.get(key)
    if hit is not None:
        return hit
    prefix = [0.0]
    for v in history:
        prefix.append(prefix[-1] + v)
    out = []
    for t in range(len(history)):
        lo = max(0, t - n + 1)
        out.append((prefix[t + 1] - prefix[lo]) / (t + 1 - lo))
    _SMA_CACHE[key] = out
    return out


def _sma(history, t, n):
    return _sma_series(history, n)[t]


def momentum(history, i0, i1, rng, fast=10, slow=30):
    """Classic trend following: hold SOL above the slow average, else USDC."""
    return _walk(history, i0, i1, lambda t: _sma(history, t, fast) >= _sma(history, t, slow))


def mean_reversion(history, i0, i1, rng, n=20):
    """Buy the dip: hold SOL when price is below its average."""
    return _walk(history, i0, i1, lambda t: history[t] < _sma(history, t, n))


def coinflip(history, i0, i1, rng):
    """No edge at all. Random daily exposure, paying real swap costs."""
    return _walk(history, i0, i1, lambda t: rng.random() < 0.5)


def overtrader(history, i0, i1, rng):
    """A genuinely bad strategy: churns every day and eats the spread."""
    state = {"v": True}

    def want(t):
        state["v"] = not state["v"]
        return state["v"]

    return _walk(history, i0, i1, want, cost=SWAP_COST * 2)


def leveraged_chaser(history, i0, i1, rng, leverage=3.0):
    """A bad strategy with real downside: 3x the daily move of a late-entry
    momentum rule. Wipeouts are floored at zero, as a liquidation would be."""
    sol = 1.0
    for t in range(i0, i1):
        if t == 0:
            continue
        move = history[t] / history[t - 1] - 1.0
        signal = 1.0 if history[t - 1] >= _sma(history, t - 1, 5) else -1.0
        # Returns are measured in SOL, so the SOL-neutral position is 1x long.
        exposure = 1.0 + leverage * signal
        sol *= max(0.0, 1.0 + (exposure - 1.0) * move - SWAP_COST)
        if sol <= 0:
            return 0.0
    return sol


def dishonest(history, i0, i1, rng):
    """Draws the principal and returns nothing."""
    return 0.0


def trace(key, history, i0, i1, rng):
    """SOL-denominated value for each day of a window, starting at 1.0 SOL.

    Used for the equity-curve chart. Mirrors the strategy functions exactly.
    """
    n = i1 - i0 + 1
    if key == "hold":
        return [1.0] * n
    if key == "dishonest":
        return [1.0] * (n - 1) + [0.0]
    if key == "leveraged_chaser":
        out, sol = [1.0], 1.0
        for t in range(i0 + 1, i1 + 1):
            move = history[t] / history[t - 1] - 1.0
            signal = 1.0 if history[t - 1] >= _sma(history, t - 1, 5) else -1.0
            exposure = 1.0 + 3.0 * signal
            sol = max(0.0, sol * (1.0 + (exposure - 1.0) * move - SWAP_COST))
            out.append(sol)
        return out[:n] + [out[-1]] * max(0, n - len(out))

    rec = []
    cost = SWAP_COST * 2 if key == "overtrader" else SWAP_COST
    if key == "momentum":
        want = lambda t: _sma(history, t, 10) >= _sma(history, t, 30)
    elif key == "mean_reversion":
        want = lambda t: history[t] < _sma(history, t, 20)
    elif key == "coinflip":
        want = lambda t: rng.random() < 0.5
    elif key == "overtrader":
        state = {"v": True}

        def want(t):
            state["v"] = not state["v"]
            return state["v"]
    else:
        raise ValueError(f"unknown strategy {key}")
    _walk(history, i0, i1, want, cost=cost, record=rec)
    return rec


STRATEGIES = {
    "hold": ("Hold SOL", hold,
             "Draw the funds, do nothing, return them. The honest baseline."),
    "momentum": ("Trend following", momentum,
                 "Hold SOL above its 30-day average, rotate to USDC below it."),
    "mean_reversion": ("Mean reversion", mean_reversion,
                       "Hold SOL when it trades below its 20-day average."),
    "coinflip": ("No edge", coinflip,
                 "Random daily exposure. No skill, but real swap costs."),
    "overtrader": ("Overtrading", overtrader,
                   "Switches every single day and pays the spread each time."),
    "leveraged_chaser": ("Leveraged chasing", leveraged_chaser,
                         "3x leveraged momentum. A genuinely reckless strategy."),
    "dishonest": ("Dishonest", dishonest,
                  "Draws the principal and never returns it."),
}


def make_rng(seed: int) -> random.Random:
    return random.Random(seed)
