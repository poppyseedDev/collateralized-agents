/**
 * For each configured agent: creates an operator key and a trading key, funds
 * them from the deploy wallet, creates the agent as a draft with its published
 * terms, deposits the bond, binds the trading key, and publishes.
 * Safe to re-run: every step is skipped once done.
 *   npm run setup
 */
import { BN } from "@coral-xyz/anchor";
import { LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { AGENTS, SOL_MINT, USDC_MINT } from "./config.js";
import { agentPda, agentVaultPda, connection, programFor, sys } from "./chain.js";
import { agentKeys, funderKey } from "./keys.js";

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
    const { operator: kp, executor } = agentKeys(a.id, true);
    const program = programFor(kp);
    const agent = agentPda(kp.publicKey, a.agentId);
    const agentVault = agentVaultPda(agent);
    const opAccounts = { operator: kp.publicKey, agent, agentVault, systemProgram: sys };
    let acc = await program.account.agent.fetchNullable(agent);
    const bonded = acc ? acc.totalCollateral.toNumber() : 0;
    const needBond = Math.max(0, L(a.bondSol) - bonded);

    const sentOp = await topUp(kp.publicKey, needBond + L(0.03));
    const sentEx = await topUp(executor.publicKey, L(a.gasSol));
    if (sentOp || sentEx) console.log(`${a.id}: funded operator ${sentOp / LAMPORTS_PER_SOL} SOL, trading key ${sentEx / LAMPORTS_PER_SOL} SOL`);

    if (!acc) {
      const terms = {
        collateralRatioBps: a.collateralRatioBps,
        feeBps: a.feeBps,
        maxDrawdownBps: a.toleranceBps,
        minDurationSecs: new BN(a.minDurationSecs),
        maxDurationSecs: new BN(a.maxDurationSecs),
        allowedAssets: [new PublicKey(SOL_MINT), new PublicKey(USDC_MINT)],
        rules: a.rules,
      };
      await program.methods.createAgent(new BN(a.agentId), a.name, a.description, terms).accounts(opAccounts).rpc();
      console.log(`${a.id}: created draft ${agent.toBase58()}`);
    }
    if (needBond > 0) {
      await program.methods.depositCollateral(new BN(needBond)).accounts(opAccounts).rpc();
    }
    acc = await program.account.agent.fetch(agent);
    if (!acc.executor.equals(executor.publicKey)) {
      await program.methods.setExecutor(executor.publicKey).accounts({ operator: kp.publicKey, agent }).rpc();
      console.log(`${a.id}: bound trading key ${executor.publicKey.toBase58()}`);
    }
    if (Object.keys(acc.status)[0] === "draft") {
      await program.methods.publishAgent().accounts({ operator: kp.publicKey, agent }).rpc();
      console.log(`${a.id}: published`);
    }
    acc = await program.account.agent.fetch(agent);
    console.log(
      `${a.id.padEnd(14)} ${Object.keys(acc.status)[0]}  ratio ${a.collateralRatioBps / 100}%  fee ${acc.terms.feeBps / 100}%  bond ${acc.totalCollateral.toNumber() / LAMPORTS_PER_SOL} SOL  operator ${kp.publicKey.toBase58()}`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
