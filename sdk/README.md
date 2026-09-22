# @proofofagent/operator

Run any trading bot as a Proof of Agent operator. The bot keeps running on your
own server with your own strategy; this package handles the four things the
protocol needs from you: publishing terms, posting collateral, drawing each
position's funds, and settling before the deadline.

It talks to the on-chain program through its public interface only
(`idl/proof_of_agent.json`, program `49aHwbzdT1iN8WYWdUZxrGoZpjSryyugMm4q9VTjXgSr`
on devnet). No account with us is needed.

## How an agent works

1. You publish an agent: collateral ratio, fee, max drawdown, deadline window,
   allowed assets, and your rules in plain language. Terms are permanent once
   published.
2. You deposit SOL collateral. Capacity is collateral ÷ ratio.
3. Traders allocate SOL to your agent for a deadline inside your window. The
   program reserves `principal × ratio` of your collateral for each position.
4. Your bot draws the SOL, trades, and returns SOL before the deadline.
5. Settlement: profit pays your fee; a loss inside your max drawdown is the
   trader's; a loss beyond it, or a missed deadline, is a **breach** paid from
   your reserved collateral.

Everything is in SOL. A fall in SOL's price is not a loss; returning fewer SOL
than the floor is.

## Two keys

- **Operator key**: creates the agent, owns the collateral, receives fees.
  Keep it offline.
- **Trading key**: bound to the agent, can only draw and settle. Give this one
  to your bot. Keep only working balances in it.

## Quick start (devnet)

```bash
npm install
npm run poa -- keygen --out operator.json
npm run poa -- keygen --out trading.json
# fund both on devnet, then:
export POA_RPC_URL=https://api.devnet.solana.com
npm run poa -- agent create --key operator.json --name "My Bot" --ratio 30 --fee 10 --drawdown 15 \
  --min-hours 1 --max-days 7 --assets SOL,DEVUSDC --rules "What the bot does, in plain words."
npm run poa -- agent deposit --key operator.json --agent <AGENT> --sol 1
npm run poa -- agent bind    --key operator.json --agent <AGENT> --trading-key <TRADING_PUBKEY>
npm run poa -- agent publish --key operator.json --agent <AGENT>
npm run poa -- agent status  --agent <AGENT>
```

Then run the runner next to your bot:

```bash
npm run poa -- run --key trading.json --agent <AGENT> --hook ./my-bot.sh --hold-min 60 --buffer-min 10
```

## The runner

`poa run` polls the chain. When a trader opens a position it draws the SOL
into the trading wallet and starts your **hook** command with:

| Variable | Meaning |
|---|---|
| `POA_POSITION` | position address |
| `POA_PRINCIPAL_SOL`, `POA_PRINCIPAL_LAMPORTS` | what was drawn |
| `POA_DEADLINE` | unix time the trader may claim your collateral |
| `POA_SETTLE_BY` | unix time the runner will settle, hook or no hook |
| `POA_WALLET` | trading wallet address |
| `POA_RPC_URL` | RPC in use |
| `POA_PAPER` | `1` in paper mode |

It settles when the hook exits, or at `--hold-min` after drawing, or
`--buffer-min` before the deadline, whichever comes first. If the hook is
still running it gets `SIGTERM`, then `SIGKILL` five seconds later. **A missed
deadline costs you the whole reserved collateral, so the runner never waits
for the hook.**

Settlement amount = principal + change in the trading wallet's SOL balance
since the draw. So:

- Use a **dedicated trading wallet**. Anything else that lands in it during a
  position is counted as that position's result (we learned this the hard way:
  leftover USDC from a failed cycle got swept into the next position's profit).
- **End in SOL.** Tokens still held at settlement are not counted, and the
  position looks like a loss.
- Network fees and token-account rent come out of the result.

One position trades at a time; others wait in the open state. `--paper` runs
the hook with `POA_PAPER=1` and settles exactly the principal.
`--notify "cmd"` runs a command on `settled`, `settle-soon`, `adopted` and
`error` events with `POA_EVENT` and `POA_MESSAGE`. State lives in
`.poa/state.json`; a restart resumes an open position.

## Example: Hummingbot

`hooks/hummingbot-orca.sh` drives an unmodified Hummingbot Gateway: it sells
part of the principal into USDC on Orca, holds, and sells the USDC back before
the runner settles. Point `GATEWAY_URL`, `GATEWAY_NETWORK`, `POOL` and the two
mints at your setup, and add the trading key to the Gateway with
`POST /wallet/add`.

Tested on devnet with Gateway 2.17: a first cycle broke its terms (the buy-back
used the wrong side and left half the position in USDC), was recorded as a
breach, and paid the trader from collateral; the corrected cycle settled at a
profit with the fee paid to the operator.

## Limits of this version

- Positions and collateral are SOL only.
- The program does not see your trades. Only the draw, the settlement amount
  and any breach are on-chain.
- Devnet has no real prices; the only liquid pools are Orca's test pools.
