# Proof of Agent

An over-collateralized marketplace for AI trading agents on Solana.
Public one-pager and waitlist at [proofofagent.dev](https://proofofagent.dev); the app runs at [dev.proofofagent.dev](https://dev.proofofagent.dev). Both come from the same Next.js deployment; `app/proxy.ts` routes by host.

**The rule:** an agent must post its own SOL as collateral before it can manage
anyone's capital. The more it guarantees per unit managed, the higher the fee it
may charge. If it misbehaves, the collateral is paid to the trader by the program.

## How it works

| Step | Who | What happens on-chain |
|------|-----|-----------------------|
| Create | Operator | Creates a draft agent with its terms: collateral ratio (10–100%), fee (capped at ratio / 2), max drawdown (≤50%), trading window, allowed assets, and plain-language rules. Terms are editable while it is a draft. |
| Deposit | Operator | Sends SOL into the agent's collateral vault (a program PDA). |
| Bind key | Operator | Optionally binds a trading key that may draw and settle, and nothing else. |
| Publish | Operator | Requires collateral. Terms become permanent and traders can allocate. |
| Open position | Trader | Deposits `P` SOL with a deadline inside the agent's window. `P × ratio` of the agent's free collateral is locked to this position. Fails if the agent cannot back it. |
| Draw | Trading key | Pulls the principal to trade with. The clock is now running. |
| Settle | Trading key | Returns `R` SOL before the deadline. Profit: the operator earns `fee` of the profit. Loss within drawdown: trader takes it. Loss beyond drawdown: a breach; the shortfall is paid from locked collateral to the trader. |
| Claim default | Trader | If the agent never settled by the deadline, the trader takes the entire locked guarantee and a breach is recorded. |
| Cancel | Trader | Before the agent draws, the trader can pull out with no fee. |

Example: you allocate 1,000 to a 30% agent. The protocol reserves 300 of the
agent's collateral as your guarantee. The collateral stays in the protocol's
vault and is paid to you only if the agent breaks its mandate or misses the
deadline.

See [docs/settlement.md](docs/settlement.md) for the exact settlement and
slashing rules, worked examples, and planned extensions. The same material is
on the site under **How it works**.

## Layout

```
programs/proof_of_agent   Anchor program (Rust) + LiteSVM tests
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
cargo test --manifest-path programs/proof_of_agent/Cargo.toml
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
and copy the IDL: `cp target/idl/proof_of_agent.json app/lib/idl.json`.

## Devnet

The program is deployed on devnet with room for upgrades up to 320 KB. The
upgrade authority is the deploy wallet
`SGzzPobm6doLkxhub7tFKEFiC8JPEZjYarA6cxWbb8w`. To upgrade:

```bash
anchor build
solana program deploy target/deploy/proof_of_agent.so \
  --program-id target/deploy/proof_of_agent-keypair.json -u devnet
```

The Vercel deployment reads `NEXT_PUBLIC_RPC_URL` / `NEXT_PUBLIC_CLUSTER`
and defaults to public devnet.

Agents on devnet: `npm run agents:setup`, then `npm run agents:start`. See
[agent/README.md](agent/README.md).

## Waitlist

The one-pager at proofofagent.dev (`app/(landing)`) collects retail sign-ups. Submissions are stored in the Vercel Blob
store `proof-of-agent-waitlist`, encrypted with a key derived from the
`WAITLIST_ADMIN_KEY` environment variable. Export them as CSV:

```
https://proofofagent.dev/api/waitlist?key=<WAITLIST_ADMIN_KEY>
```

The key is set on Vercel and in `app/.env.local`. Anyone with it can read the
list, so treat it like a password.

## Trust model (v1)

In v1 the agent *borrows* the principal to trade off-chain, bonded by its
collateral. That means the trader's exposure is `principal − guarantee` if the
agent absconds. A ratio of 100% makes the position fully backed. v2 should keep
funds in the vault and restrict the agent to whitelisted DEX CPIs so the
guarantee only needs to cover drawdown, not the whole principal.
