/**
 * Seed a local validator with demo agents so the ledger has something to show.
 *   npm run seed                     -> 3 agents
 *   npm run fund -- <wallet-address> -> airdrop 10 SOL to your browser wallet
 */
import { AnchorProvider, BN, Idl, Program, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";
import idl from "../lib/idl.json";

const RPC = process.env.NEXT_PUBLIC_RPC_URL ?? "http://127.0.0.1:8899";
const PROGRAM_ID = new PublicKey(idl.address);

const AGENTS = [
  { name: "Momentum Bot", strategy: "SOL/USDC 4h momentum, trend-following", ratio: 3000, drawdown: 2000, bond: 20 },
  { name: "Basis Harvester", strategy: "Perp funding-rate carry, delta neutral", ratio: 7500, drawdown: 1000, bond: 45 },
  { name: "Degen Sniper", strategy: "New-launch sniping, high variance", ratio: 1000, drawdown: 5000, bond: 4 },
  { name: "Vault Keeper", strategy: "Fully bonded LST yield rotation", ratio: 10000, drawdown: 500, bond: 60 },
];

async function main() {
  const connection = new Connection(RPC, "confirmed");
  const [, , cmd, arg] = process.argv;

  if (cmd === "fund") {
    const to = new PublicKey(arg);
    const sig = await connection.requestAirdrop(to, 10 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, "confirmed");
    console.log(`funded ${to.toBase58()} with 10 SOL`);
    return;
  }

  for (const a of AGENTS) {
    const authority = Keypair.generate();
    const sig = await connection.requestAirdrop(authority.publicKey, (a.bond + 2) * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, "confirmed");

    const provider = new AnchorProvider(connection, new Wallet(authority), { commitment: "confirmed" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const program = new Program(idl as Idl, provider) as any;
    const agent = PublicKey.findProgramAddressSync([Buffer.from("agent"), authority.publicKey.toBuffer()], PROGRAM_ID)[0];
    const agentVault = PublicKey.findProgramAddressSync([Buffer.from("agent_vault"), agent.toBuffer()], PROGRAM_ID)[0];

    await program.methods
      .registerAgent(a.name, a.strategy, a.ratio, a.drawdown)
      .accounts({ authority: authority.publicKey, agent, agentVault, systemProgram: SystemProgram.programId })
      .rpc();
    await program.methods
      .depositCollateral(new BN(a.bond * LAMPORTS_PER_SOL))
      .accounts({ authority: authority.publicKey, agent, agentVault, systemProgram: SystemProgram.programId })
      .rpc();
    console.log(`${a.name.padEnd(16)} ratio ${a.ratio / 100}%  bond ${a.bond} SOL  authority ${authority.publicKey.toBase58()}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
