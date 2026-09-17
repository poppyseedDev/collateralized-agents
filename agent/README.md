# Agent runner

A small Node service that operates Collateralized Agents on devnet. Each agent
has its own key, posts its own collateral, and trades traders' SOL on Orca's
devnet SOL/USDC pools.

## What each agent does

1. **Draws** every new position on its agent, as long as the deadline is at least three minutes away.
2. **Trades** the position with its strategy, keeping a separate book of the SOL and USDC that belong to each position.
3. **Settles** before the deadline: sells any USDC back to SOL and returns the position's SOL through the program, so the usual fee and slash rules apply.

A position settles at whichever comes first: the agent's hold time after drawing, or a buffer of one to five minutes before the deadline.

| Agent | Collateral | Fee | Tolerance | Strategy |
|-------|-----------|-----|-----------|----------|
| Orca Pool Arbitrage | 50% | 25% | 5% | Sells SOL on the pool that pays the most USDC and buys it back on the pool that pays the most SOL, when the round trip gains at least 0.5%. Up to three round trips per position, half the position each time. |
| Orca Momentum | 30% | 15% | 15% | Moves 60% of a position into USDC when the main pool's price drops 0.3% below its 10-sample average, and back when it rises 0.3% above. |
| Half-Stable Rotator | 10% | 5% | 30% | Holds half of each position in USDC until settlement. |

Devnet prices are set by whoever trades there, not by a real market. The
arbitrage agent profits from the gaps between Orca's devnet pools, and those
gaps shrink as it trades.

## Accounting

The agent's wallet mixes its own SOL with every trader's principal. Each
position's book starts at its principal. Selling SOL subtracts exactly the
amount sold. Buying SOL adds the amount received, measured on-chain, with the
network fee added back. Network fees and token account rent are paid by the
agent, never charged to a position.

## Commands

```bash
cd agent
npm install
npm run setup                          # create keys, fund from ~/.config/solana/id.json, register, bond
npm start                              # run all agents (Ctrl+C stops after the current tick)
npm start -- orca-arb                  # run selected agents only
npm run seed-positions -- 0.2 2 3600   # test trader opens 2 × 0.2 SOL positions per agent for 1 hour
```

Environment variables:

| Variable | Default | Purpose |
|----------|---------|---------|
| `RPC_URL` | `https://api.devnet.solana.com` | Cluster RPC. A private devnet RPC avoids rate limits. |
| `POLL_MS` | `30000` | Time between ticks. |
| `FUNDER_KEYPAIR` | `~/.config/solana/id.json` | Wallet that funds agents and the test trader. |

Keys are written to `keys/` and per-agent state to `state/`. Both are
gitignored. Losing `keys/` means losing control of the agents and their
collateral; losing `state/` only resets the books, and open positions are
re-adopted on the next start.

## Limits

- The runner has to stay online. If it is down past a position's deadline, the trader can claim the agent's collateral.
- The public devnet RPC rate-limits bursts. The runner retries, but a private RPC is more reliable.
- Pool addresses are listed in `src/config.ts` to avoid a program-wide scan. Pools that lose liquidity are skipped.
- If a swap lands but its confirmation times out, the book misses that trade. The runner logs the error; check the agent's wallet against its books if that happens.
- The momentum signal reads the main pool's price, which only moves when someone trades it. On devnet it often stays flat, so the momentum agent may never trade.
