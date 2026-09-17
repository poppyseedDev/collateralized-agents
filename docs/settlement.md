# Settlement and slashing

This page explains how a position closes, when an agent's collateral is used,
and how much of it goes to the trader. The first part describes what the
program does today. The second part describes planned extensions and is marked
as such.

## Terms

| Term | Meaning | On-chain field |
|------|---------|----------------|
| Operator | Wallet that creates and manages the agent, publishes its terms, and owns its collateral. | `Agent.operator` |
| Trading key | Wallet the operator binds to draw and settle positions. Defaults to the operator. | `Agent.executor` |
| Principal | SOL the trader deposited into the position. | `Position.principal` |
| Collateral ratio | Share of the principal the agent must lock as a guarantee. 10% to 100%. | `Agent.terms.collateral_ratio_bps` |
| Locked bond | `principal × collateral ratio`, rounded up. Reserved from the agent's collateral vault for this position only. | `Position.locked_collateral` |
| Tolerance | How much worse than holding SOL the agent may do before its bond pays the trader. Called *max drawdown* in the code. Up to 50%. | `Agent.terms.max_drawdown_bps` |
| Returned | SOL the agent sends back when it settles. | `Position.returned` |
| Performance fee | Share of profit paid to the operator. Chosen by the operator, capped at half the collateral ratio. | `Agent.terms.fee_bps` |
| Trading window | Shortest and longest deadline a trader may choose. | `Agent.terms.min_duration_secs`, `max_duration_secs` |
| Breach | A settlement below the floor, or a missed deadline. | `Position.breach`, `Agent.breach_count` |

The position snapshots the fee and tolerance when it opens. Published terms
cannot change in any case.

## Publishing an agent (live)

An agent is created as a **draft**. While it is a draft, the operator can edit
its name, description and every term: collateral ratio, fee, maximum drawdown,
trading window, allowed assets (up to eight mints) and plain-language rules
(up to 512 characters, stored on-chain). Traders cannot allocate to a draft.

`publish_agent` requires a collateral deposit, validates the terms again, and
moves the agent to **active**. From then on the terms are permanent. The
operator can pause and resume new positions, deposit and withdraw free
collateral, and bind a different trading key. To change terms, the operator
creates a new agent; one operator can run many, each with its own `agent_id`.

Allowed assets and rules are disclosure: the program stores and shows them,
but does not check which trades an agent makes.

## The rule (live)

```
floor = principal × (1 − tolerance)
slash = min(locked_bond, max(0, floor − returned))
fee   = profit × fee_bps          only when returned > principal
```

- **Profit.** The operator receives its fee on the profit. The trader receives the rest. The bond is untouched.
- **Loss within tolerance.** The trader absorbs the loss. The agent earns no fee. The bond is untouched.
- **Loss beyond tolerance.** A breach. The part below the floor is paid from the agent's locked bond to the trader, up to the full locked amount.
- **Loss beyond the bond.** Anything below `floor − locked_bond` is the trader's loss. A higher collateral ratio shrinks this gap, which is why it earns a higher fee.

In every case the locked bond is released back to the agent's free collateral, minus any slash.

### Why market drops are not slashed

Positions are denominated in SOL. A fall in SOL's dollar price does not reduce
the number of lamports in a position. An agent that returns the same SOL it
received has matched the market, even if SOL lost half its dollar value.
The only way to return fewer lamports is to trade worse than simply holding
SOL.

The rule therefore means *"slash only when the strategy underperformed holding
SOL by more than the tolerance"*. It needs no price oracle.

### Worked example

10 SOL principal, 30% collateral ratio (3 SOL locked, 15% fee), 10% tolerance
(floor 9 SOL).

| Agent returns | Slash | Agent fee | Trader receives | What happened |
|---------------|-------|-----------|-----------------|---------------|
| 12 SOL | 0 | 0.3 SOL | 11.7 SOL | Profit of 2 SOL, 15% to the agent. |
| 10 SOL, SOL's dollar price fell 40% | 0 | 0 | 10 SOL | The market fell; the strategy did not lose. |
| 9.5 SOL | 0 | 0 | 9.5 SOL | Small loss inside the tolerance. |
| 8 SOL | 1 SOL | 0 | 9 SOL | 1 SOL below the floor, paid from the bond. |
| 5 SOL | 3 SOL | 0 | 8 SOL | 4 SOL below the floor, capped at the 3 SOL bond. |

The trader also gets back the position vault's rent deposit (about
0.00089 SOL) when the position closes.

## Position lifecycle (live)

| From | Action | Who | Condition | Result |
|------|--------|-----|-----------|--------|
| — | `open_position` | Trader | Agent is active, deadline inside the published window, enough free collateral | Principal moves into the position vault. Bond is reserved. |
| Open | `draw_funds` | Trading key or operator | Before the deadline | Principal moves to the trading key. Status becomes Trading. |
| Open | `cancel_position` | Trader | Any time | Full refund. Bond released. No fee. |
| Open | `settle_position` | Trading key or operator | Any time | Treated as returning the full principal, so no fee and no slash. Used to decline a position. |
| Trading | `settle_position` | Trading key or operator | No deadline check | The rule above applies to the SOL sent. A slash records a drawdown breach. |
| Trading | `claim_default` | Trader | At or after the deadline | The whole locked bond goes to the trader. Status becomes Defaulted and a missed-deadline breach is recorded. |

### Missed deadline

While a position is Trading, the agent holds the principal. If it has not
settled by the deadline, the trader can call `claim_default` and receive the
entire locked bond, whatever the market did.

Settlement itself has no deadline check. An agent that is late can still
settle normally until the trader claims the default. Whichever transaction
lands first decides the outcome.

### What the bond does not cover

In the current version the agent takes custody of the principal. If an agent
never returns it, the trader recovers only the locked bond, so the trader's
maximum loss is `principal − locked_bond`. A 100% collateral ratio makes a
position fully backed.

## Planned extensions

None of the following is implemented yet.

### Vault custody

Funds stay in the position vault, and the agent can only trade them through a
program instruction that calls Jupiter. Settlement then reads the vault's real
balance instead of trusting the amount the agent sends. After the deadline,
anyone can unwind the vault into the deposit token and settle. Because the
agent can no longer keep the principal, a missed deadline would carry a
smaller fixed penalty instead of the whole bond.

### USDC deposits and a benchmark

Once positions can hold USDC, a fall in SOL's price would show up as a loss.
Each agent would declare a benchmark at registration, such as SOL for a SOL
trading strategy or none for a stablecoin strategy. The rule gains one term:

```
benchmark_return = price_at_settlement / price_at_open − 1
floor            = principal × (1 + benchmark_return) × (1 − tolerance)
slash            = min(locked_bond, max(0, floor − vault_value))
```

With no benchmark, `benchmark_return` is zero and the rule is the same as
today. Prices would come from an oracle such as Pyth, using its moving-average
price at both ends so a single trade cannot move the settlement price.

Example: 1,000 USDC, SOL benchmark, 5% tolerance, 300 USDC locked.

| SOL move | Vault at settlement | Floor | Slash |
|----------|---------------------|-------|-------|
| −20% | 820 | 760 | 0 |
| −20% | 700 | 760 | 60 |
| +20% | 1,050 | 1,140 | 90 |
| +10% | 1,250 | 1,045 | 0 |

The fee would only be paid when the vault ends above the principal and there
is no slash.

### Declared rules

Agents would publish their trading rules in a machine-readable on-chain
account: allowed tokens, maximum slippage, maximum share of the vault in one
token, stop-loss level, and maximum trades per day.

- **Rules the program can check before a trade** are enforced directly. A trade that breaks them is rejected, so no dispute is needed.
- **Rules that can only be checked afterwards** go through a challenge. Anyone can point to the offending transactions and post a small deposit. The agent has a window to dispute. An undisputed claim is executed by the program. A disputed one goes to an independent judge. A false claim forfeits the deposit.

A proven violation suspends the agent and slashes its bond whether or not the
position lost money, so an agent cannot break rules and keep the upside.
Affected traders are compensated up to their loss before any remainder goes
to the treasury. Rules that cannot be checked, such as "uses AI", are left to
reputation.

### Smoothing out bad luck

A single short position is noisy. SOL moves roughly 10% in a typical week.
Instead of slashing each position on its own, the program could accumulate an
agent's shortfalls across positions and slash only when the total over several
positions crosses a threshold. That separates a bad strategy from a bad week.

### Reputation

Each settlement or default could post a score to the Solana Agent Registry,
so an agent's track record is public and portable beyond this app.
