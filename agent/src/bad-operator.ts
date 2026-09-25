/**
 * Bad-operator test on devnet. Publishes a deliberately misbehaving agent and
 * checks that the protocol punishes both kinds of breach:
 *   A. draws a position and never settles      -> trader claims the reserved bond after the deadline
 *   B. draws a position and returns far too little -> the shortfall is slashed at settlement
 * Leaves the agent on-chain, paused, so the breach records stay visible on the site.
 *   npm run bad-operator
 */
import { LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { SOL_MINT, USDC_MINT } from "./config.js";
import { BN, agentPda, agentVaultPda, connection, positionPda, positionVaultPda, programFor, sys } from "./chain.js";
import { agentKeys, funderKey, keyFor } from "./keys.js";

const L = (sol: number) => Math.round(sol * LAMPORTS_PER_SOL);
const fmt = (n: number | BN) => (Number(n.toString()) / LAMPORTS_PER_SOL).toFixed(4);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => Math.floor(Date.now() / 1000);

const BOND = 0.3;
const PRINCIPAL = 0.1;
const RATIO_BPS = 5000; // 50% -> 0.05 SOL reserved per position
const DRAWDOWN_BPS = 2000; // floor = 80% of principal
const SHORT_DEADLINE = 90; // seconds; position A will be left to expire
const BAD_RETURN = 0.03; // position B returns 30%: shortfall 0.05 = the whole reservation

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
}

async function topUp(to: PublicKey, lamports: number) {
  const have = await connection.getBalance(to);
  if (have >= lamports) return;
  const funder = funderKey();
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: to, lamports: lamports - have }));
  await sendAndConfirmTransaction(connection, tx, [funder], { commitment: "confirmed" });
}

async function main() {
  const { operator, executor } = agentKeys("breach-demo", true);
  const trader = keyFor("trader", true);
  await topUp(operator.publicKey, L(BOND + 0.05));
  await topUp(executor.publicKey, L(0.05));
  await topUp(trader.publicKey, L(2 * PRINCIPAL + 0.05));

  const op = programFor(operator);
  const ex = programFor(executor);
  const tp = programFor(trader);
  const agent = agentPda(operator.publicKey, 1);
  const agentVault = agentVaultPda(agent);
  const opAccounts = { operator: operator.publicKey, agent, agentVault, systemProgram: sys };

  // ---- publish a misbehaving agent (idempotent) ----
  let acc = await op.account.agent.fetchNullable(agent);
  if (!acc) {
    await op.methods
      .createAgent(new BN(1), "Breach Demo (test)", "Deliberately misbehaves so you can see the bond pay out", {
        collateralRatioBps: RATIO_BPS,
        feeBps: 1000,
        maxDrawdownBps: DRAWDOWN_BPS,
        minDurationSecs: new BN(60),
        maxDurationSecs: new BN(3600),
        allowedAssets: [new PublicKey(SOL_MINT), new PublicKey(USDC_MINT)],
        rules: "Test agent operated by the Proof of Agent team. It intentionally breaks its terms: one position is never settled, another returns far below the floor. Do not allocate to it.",
      })
      .accounts(opAccounts)
      .rpc();
    console.log("created", agent.toBase58());
  }
  acc = await op.account.agent.fetch(agent);
  if (acc.totalCollateral.toNumber() < L(BOND)) {
    await op.methods.depositCollateral(new BN(L(BOND) - acc.totalCollateral.toNumber())).accounts(opAccounts).rpc();
  }
  if (!acc.executor.equals(executor.publicKey)) {
    await op.methods.setExecutor(executor.publicKey).accounts({ operator: operator.publicKey, agent }).rpc();
  }
  acc = await op.account.agent.fetch(agent);
  if (Object.keys(acc.status)[0] === "draft") {
    await op.methods.publishAgent().accounts({ operator: operator.publicKey, agent }).rpc();
  }
  if (Object.keys(acc.status)[0] === "paused") {
    await op.methods.setAccepting(true).accounts({ operator: operator.publicKey, agent }).rpc();
  }
  const before = await op.account.agent.fetch(agent);
  console.log(`agent ${agent.toBase58()}: bond ${fmt(before.totalCollateral)} SOL, breaches so far ${before.breachCount}`);

  // ---- trader opens two positions ----
  const open = async (durationSecs: number) => {
    const nonce = new BN(Date.now());
    const position = positionPda(agent, trader.publicKey, nonce);
    await tp.methods
      .openPosition(nonce, new BN(L(PRINCIPAL)), new BN(durationSecs))
      .accounts({ trader: trader.publicKey, agent, position, positionVault: positionVaultPda(position), systemProgram: sys })
      .rpc();
    return position;
  };
  const posA = await open(SHORT_DEADLINE);
  const posB = await open(3600);
  const afterOpen = await op.account.agent.fetch(agent);
  check("opening two positions reserves 2 x 0.05 SOL of bond", afterOpen.lockedCollateral.toNumber() - before.lockedCollateral.toNumber() === 2 * L(PRINCIPAL * RATIO_BPS / 10_000), `locked ${fmt(afterOpen.lockedCollateral)}`);

  // ---- the trading key draws both ----
  const draw = (position: PublicKey) =>
    ex.methods.drawFunds().accounts({ executor: executor.publicKey, agent, position, positionVault: positionVaultPda(position), systemProgram: sys }).rpc();
  const exBefore = await connection.getBalance(executor.publicKey);
  await draw(posA);
  await draw(posB);
  const exAfter = await connection.getBalance(executor.publicKey);
  check("trading key received both principals", exAfter - exBefore >= 2 * L(PRINCIPAL) - 20_000, `+${fmt(exAfter - exBefore)} SOL`);

  // ---- B: settle far below the floor ----
  const traderBeforeB = await connection.getBalance(trader.publicKey);
  await ex.methods
    .settlePosition(new BN(L(BAD_RETURN)))
    .accounts({ executor: executor.publicKey, operator: operator.publicKey, agent, agentVault, position: posB, positionVault: positionVaultPda(posB), trader: trader.publicKey, systemProgram: sys })
    .rpc();
  const pB = await tp.account.position.fetch(posB);
  const traderAfterB = await connection.getBalance(trader.publicKey);
  const reserved = L(PRINCIPAL * RATIO_BPS / 10_000);
  check("B is recorded as a drawdown breach", Object.keys(pB.breach)[0] === "drawdown", JSON.stringify(pB.breach));
  check("B slashed the whole reservation", pB.slashed.toNumber() === reserved, `slashed ${fmt(pB.slashed)}`);
  check("B paid the trader returned + slash + rent", traderAfterB - traderBeforeB >= L(BAD_RETURN) + reserved, `+${fmt(traderAfterB - traderBeforeB)} SOL`);
  check("B charged no fee", pB.feePaid.toNumber() === 0);

  // ---- A: never settle; wait out the deadline, trader claims ----
  const pA0 = await tp.account.position.fetch(posA);
  const deadline = pA0.deadline.toNumber();
  const earlyClaim = tp.methods
    .claimDefault()
    .accounts({ trader: trader.publicKey, agent, agentVault, position: posA, positionVault: positionVaultPda(posA), systemProgram: sys })
    .rpc();
  check("claiming A before the deadline is refused", await earlyClaim.then(() => false, (e: Error) => /DeadlineNotReached/.test(String(e))));
  const wait = deadline - now() + 8;
  console.log(`waiting ${Math.max(wait, 0)}s for A's deadline…`);
  await sleep(Math.max(wait, 0) * 1000);
  const traderBeforeA = await connection.getBalance(trader.publicKey);
  await tp.methods
    .claimDefault()
    .accounts({ trader: trader.publicKey, agent, agentVault, position: posA, positionVault: positionVaultPda(posA), systemProgram: sys })
    .rpc();
  const pA = await tp.account.position.fetch(posA);
  const traderAfterA = await connection.getBalance(trader.publicKey);
  check("A is recorded as a missed-deadline breach", Object.keys(pA.breach)[0] === "missedDeadline", JSON.stringify(pA.breach));
  check("A is defaulted and paid the whole reservation", Object.keys(pA.status)[0] === "defaulted" && pA.slashed.toNumber() === reserved, `slashed ${fmt(pA.slashed)}`);
  check("A's claim reached the trader", traderAfterA - traderBeforeA >= reserved - 10_000, `+${fmt(traderAfterA - traderBeforeA)} SOL`);
  const lateSettle = ex.methods
    .settlePosition(new BN(L(PRINCIPAL)))
    .accounts({ executor: executor.publicKey, operator: operator.publicKey, agent, agentVault, position: posA, positionVault: positionVaultPda(posA), trader: trader.publicKey, systemProgram: sys })
    .rpc();
  check("agent cannot settle A after the default", await lateSettle.then(() => false, (e: Error) => /InvalidStatus/.test(String(e))));

  // ---- agent-level records ----
  const after = await op.account.agent.fetch(agent);
  check("agent breach count went up by 2", after.breachCount - before.breachCount === 2, `now ${after.breachCount}`);
  check("agent bond shrank by both slashes", before.totalCollateral.toNumber() - after.totalCollateral.toNumber() === 2 * reserved, `${fmt(before.totalCollateral)} -> ${fmt(after.totalCollateral)}`);
  check("nothing stays reserved", after.lockedCollateral.toNumber() === before.lockedCollateral.toNumber());
  check("operator earned no fees", after.feesEarned.toNumber() === before.feesEarned.toNumber());

  // leave it visible but closed to new positions
  await op.methods.setAccepting(false).accounts({ operator: operator.publicKey, agent }).rpc();
  console.log(`\nagent paused. view: https://dev.proofofagent.dev/agents/${agent.toBase58()}`);
  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
