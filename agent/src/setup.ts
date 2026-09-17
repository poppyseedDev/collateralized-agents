/**
 * Creates agent keys, funds them from the deploy wallet, registers each agent
 * on-chain, and tops its collateral up to the configured bond.
 *   npm run setup
 */
import { BN } from "@coral-xyz/anchor";
import { LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { AGENTS } from "./config.js";
import { agentPda, agentVaultPda, connection, programFor, sys } from "./chain.js";
import { funderKey, keyFor } from "./keys.js";

const L = (sol: number) => Math.round(sol * LAMPORTS_PER_SOL);

async function topUp(to: PublicKey, targetLamports: number) {
  const have = await connection.getBalance(to);
  if (have >= targetLamports) return 0;
  const funder = funderKey();
  const amount = targetLamports - have;
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: to, lamports: amount }));
  await sendAndConfirmTransaction(connection, tx, [funder], { commitment: "confirmed" });
  return amount;
}

async function main() {
  const funder = funderKey();
  console.log("funder", funder.publicKey.toBase58(), (await connection.getBalance(funder.publicKey)) / LAMPORTS_PER_SOL, "SOL");

  for (const a of AGENTS) {
    const kp = keyFor(a.id, true);
    const program = programFor(kp);
    const agent = agentPda(kp.publicKey);
    const agentVault = agentVaultPda(agent);
    let acc = await program.account.agent.fetchNullable(agent);
    const bonded = acc ? acc.totalCollateral.toNumber() : 0;
    const needBond = Math.max(0, L(a.bondSol) - bonded);

    const sent = await topUp(kp.publicKey, needBond + L(a.gasSol));
    if (sent) console.log(`${a.id}: funded ${sent / LAMPORTS_PER_SOL} SOL`);

    if (!acc) {
      await program.methods
        .registerAgent(a.name, a.description, a.collateralRatioBps, a.toleranceBps)
        .accounts({ authority: kp.publicKey, agent, agentVault, systemProgram: sys })
        .rpc();
      console.log(`${a.id}: registered ${agent.toBase58()}`);
    }
    if (needBond > 0) {
      await program.methods
        .depositCollateral(new BN(needBond))
        .accounts({ authority: kp.publicKey, agent, agentVault, systemProgram: sys })
        .rpc();
    }
    acc = await program.account.agent.fetch(agent);
    console.log(
      `${a.id.padEnd(14)} ratio ${a.collateralRatioBps / 100}%  fee ${acc.feeBps / 100}%  bond ${acc.totalCollateral.toNumber() / LAMPORTS_PER_SOL} SOL  wallet ${(await connection.getBalance(kp.publicKey)) / LAMPORTS_PER_SOL} SOL  authority ${kp.publicKey.toBase58()}`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
