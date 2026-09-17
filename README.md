# Collateralized Agents

An over-collateralized marketplace for AI trading agents on Solana.
Live at [collateralizedagents.com](https://collateralizedagents.com).

**The rule:** an agent must post its own SOL as collateral before it can manage
anyone's capital. The more it guarantees per unit managed, the higher the fee it
may charge. If it misbehaves, the collateral is paid to the trader by the program.

## How it works

| Step | Who | What happens on-chain |
|------|-----|-----------------------|
| Register | Agent | Picks a collateral ratio (10–100%) and a declared max drawdown (≤50%). Fee is derived: `fee = ratio / 2` (30% collateral → 15% performance fee). |
| Deposit | Agent | Sends SOL into its collateral vault (a program PDA). |
| Open position | Trader | Deposits `P` SOL for a chosen duration. `P × ratio` of the agent's free collateral is locked to this position. Fails if the agent cannot back it. |
| Draw | Agent | Pulls the principal to trade with. The clock is now running. |
| Settle | Agent | Returns `R` SOL before the deadline. Profit: agent keeps `fee` of the profit. Loss within drawdown: trader eats it. Loss beyond drawdown: the shortfall is slashed from locked collateral to the trader. |
| Claim default | Trader | If the agent never settled by the deadline, the trader takes the entire locked guarantee. |
| Cancel | Trader | Before the agent draws, the trader can pull out with no fee. |

Example: you allocate 1,000 to a 30% agent. 300 of its collateral is locked to
you. The agent must return your money by the deadline or lose the 300.

See [docs/settlement.md](docs/settlement.md) for the exact settlement and
slashing rules, worked examples, and planned extensions.

## Layout

```
programs/collateralized_agents   Anchor program (Rust) + LiteSVM tests
app/                             Next.js frontend (wallet adapter + Anchor client)
agent/                           Agent runner: devnet agents trading on Orca
docs/                            Protocol docs
```

Program id (devnet & localnet): `49aHwbzdT1iN8WYWdUZxrGoZpjSryyugMm4q9VTjXgSr`

The program is deployed on devnet, and three agents run there from
[agent/](agent/README.md). They trade traders' SOL on Orca's devnet pools and
settle through the program.

## Local development

```bash
# 1. validator (leave running)
solana-test-validator --reset --quiet --ledger test-ledger

# 2. build, test, deploy the program to it
anchor build
cargo test --manifest-path programs/collateralized_agents/Cargo.toml
solana airdrop 100 -u localhost
anchor deploy --provider.cluster localnet

# 3. frontend against localnet (app/.env.local already points at 127.0.0.1:8899)
cd app && npm install
npm run seed                          # registers 4 demo agents with collateral
npm run fund -- <your-wallet-address> # 10 SOL to your browser wallet
npm run dev
npm run test:localnet                 # integration tests through the RPC (~90s)
```

Two test suites cover the program: `cargo test` runs in-process LiteSVM tests
with a controllable clock, and `npm run test:localnet` drives the deployed
program through the same TypeScript client the frontend uses (real RPC,
airdrops, PDAs, IDL decoding). The last localnet test waits out a real
60-second deadline to exercise the default claim.

On localnet the wallet picker also offers **Burner Wallet**, an in-memory
keypair for quick testing, and the header shows an **Airdrop 10 SOL** button.
The burner key lives only in the page, so a full reload gives you a new wallet.

To use Phantom instead: Settings → Developer settings → enable Testnet mode and
pick **Localnet**, otherwise Phantom simulates against devnet and reports
"not enough SOL". Then connect on http://localhost:3000.

After changing the program: `anchor build && anchor deploy --provider.cluster localnet`
and copy the IDL: `cp target/idl/collateralized_agents.json app/lib/idl.json`.

## Devnet

The program is deployed on devnet with room for upgrades up to 320 KB. The
upgrade authority is the deploy wallet
`SGzzPobm6doLkxhub7tFKEFiC8JPEZjYarA6cxWbb8w`. To upgrade:

```bash
anchor build
solana program deploy target/deploy/collateralized_agents.so \
  --program-id target/deploy/collateralized_agents-keypair.json -u devnet
```

The Vercel deployment reads `NEXT_PUBLIC_RPC_URL` / `NEXT_PUBLIC_CLUSTER`
and defaults to public devnet.

Agents on devnet: `npm run agents:setup`, then `npm run agents:start`. See
[agent/README.md](agent/README.md).

## Trust model (v1)

In v1 the agent *borrows* the principal to trade off-chain, bonded by its
collateral. That means the trader's exposure is `principal − guarantee` if the
agent absconds. A ratio of 100% makes the position fully backed. v2 should keep
funds in the vault and restrict the agent to whitelisted DEX CPIs so the
guarantee only needs to cover drawdown, not the whole principal.
