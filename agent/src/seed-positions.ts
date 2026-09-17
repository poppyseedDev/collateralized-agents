/**
 * Opens demo positions from a test trader wallet so the agents have capital
 * to trade and build a track record.
 *   npm run seed-positions -- [solPerPosition=0.2] [positionsPerAgent=1] [durationSecs=3600]
 */
import { BN } from "@coral-xyz/anchor";
import { LAMPORTS_PER_SOL, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { AGENTS } from "./config.js";
import { agentPda, connection, positionPda, positionVaultPda, programFor, sys } from "./chain.js";
import { agentKeys, funderKey, keyFor } from "./keys.js";

async function main() {
  const [solArg, countArg, durArg] = process.argv.slice(2);
  const sol = Number(solArg ?? 0.2);
  const count = Number(countArg ?? 1);
  const duration = Number(durArg ?? 3600);
  const trader = keyFor("trader", true);
  const need = Math.round((sol * count * AGENTS.length + 0.05) * LAMPORTS_PER_SOL);
  const have = await connection.getBalance(trader.publicKey);
  if (have < need) {
    const funder = funderKey();
    const tx = new Transaction().add(
      SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: trader.publicKey, lamports: need - have }),
    );
    await sendAndConfirmTransaction(connection, tx, [funder], { commitment: "confirmed" });
    console.log(`funded trader with ${(need - have) / LAMPORTS_PER_SOL} SOL`);
  }
  const program = programFor(trader);
  for (const a of AGENTS) {
    const agent = agentPda(agentKeys(a.id).operator.publicKey, a.agentId);
    for (let i = 0; i < count; i++) {
      const nonce = new BN(Date.now());
      const position = positionPda(agent, trader.publicKey, nonce);
      const sig = await program.methods
        .openPosition(nonce, new BN(Math.round(sol * LAMPORTS_PER_SOL)), new BN(duration))
        .accounts({ trader: trader.publicKey, agent, position, positionVault: positionVaultPda(position), systemProgram: sys })
        .rpc();
      console.log(`${a.id}: opened ${sol} SOL for ${duration}s`, position.toBase58(), sig);
    }
  }
  console.log("trader", trader.publicKey.toBase58(), (await connection.getBalance(trader.publicKey)) / LAMPORTS_PER_SOL, "SOL left");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
