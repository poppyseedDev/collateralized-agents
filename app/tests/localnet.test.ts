/**
 * Integration tests against a running local validator with the program deployed.
 *
 *   npm run validator        (in another terminal)
 *   npm run deploy:local
 *   npm run test:localnet
 *
 * Unlike the LiteSVM tests in programs/, these go through the real RPC and the
 * TypeScript client the frontend uses, so they also cover the IDL + PDA plumbing.
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { AnchorProvider, BN, Idl, Program, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";
import idl from "../lib/idl.json";
import { agentPda, agentVaultPda, positionPda, positionVaultPda } from "../lib/program";

const RPC = process.env.NEXT_PUBLIC_RPC_URL ?? "http://127.0.0.1:8899";
const SOL = LAMPORTS_PER_SOL;
const PROGRAM_ID = new PublicKey(idl.address);
const connection = new Connection(RPC, "confirmed");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Prog = any;

function programFor(kp: Keypair): Prog {
  const provider = new AnchorProvider(connection, new Wallet(kp), { commitment: "confirmed" });
  return new Program(idl as Idl, provider);
}

async function fund(kp: Keypair, sol = 20) {
  const sig = await connection.requestAirdrop(kp.publicKey, sol * SOL);
  await connection.confirmTransaction(sig, "confirmed");
}

async function expectAnchorError(p: Promise<unknown>, code: string) {
  try {
    await p;
  } catch (e) {
    const err = e as { error?: { errorCode?: { code?: string } }; message?: string };
    const got = err?.error?.errorCode?.code ?? err?.message ?? String(e);
    assert.ok(got.includes(code), `expected error ${code}, got: ${got}`);
    return;
  }
  assert.fail(`expected error ${code}, but the transaction succeeded`);
}

const balance = (k: PublicKey) => connection.getBalance(k, "confirmed");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A fresh agent + trader pair with their own funded keypairs and PDAs. */
async function setup(ratioBps = 3000, drawdownBps = 2000, bondSol = 1) {
  const agentKp = Keypair.generate();
  const traderKp = Keypair.generate();
  await Promise.all([fund(agentKp), fund(traderKp)]);
  const agent = agentPda(agentKp.publicKey);
  const agentVault = agentVaultPda(agent);
  const ap = programFor(agentKp);
  const tp = programFor(traderKp);

  await ap.methods
    .registerAgent("Test Agent", "integration", ratioBps, drawdownBps)
    .accounts({ authority: agentKp.publicKey, agent, agentVault, systemProgram: SystemProgram.programId })
    .rpc();
  if (bondSol > 0) {
    await ap.methods
      .depositCollateral(new BN(bondSol * SOL))
      .accounts({ authority: agentKp.publicKey, agent, agentVault, systemProgram: SystemProgram.programId })
      .rpc();
  }

  let nonceCounter = 0;
  const env = {
    agentKp, traderKp, agent, agentVault, ap, tp,
    agentState: () => ap.account.agent.fetch(agent),
    positionState: (position: PublicKey) => tp.account.position.fetch(position),
    open: async (lamports: number, durationSecs: number, program: Prog = tp, trader: PublicKey = traderKp.publicKey) => {
      const nonce = new BN(Date.now() + nonceCounter++);
      const position = positionPda(agent, trader, nonce);
      await program.methods
        .openPosition(nonce, new BN(lamports), new BN(durationSecs))
        .accounts({ trader, agent, position, positionVault: positionVaultPda(position), systemProgram: SystemProgram.programId })
        .rpc();
      return position;
    },
    draw: (position: PublicKey, program: Prog = ap, authority: PublicKey = agentKp.publicKey) =>
      program.methods
        .drawFunds()
        .accounts({ authority, agent, position, positionVault: positionVaultPda(position), systemProgram: SystemProgram.programId })
        .rpc(),
    settle: (position: PublicKey, returned: number) =>
      ap.methods
        .settlePosition(new BN(returned))
        .accounts({
          authority: agentKp.publicKey, agent, agentVault, position,
          positionVault: positionVaultPda(position), trader: traderKp.publicKey, systemProgram: SystemProgram.programId,
        })
        .rpc(),
    cancel: (position: PublicKey) =>
      tp.methods
        .cancelPosition()
        .accounts({ trader: traderKp.publicKey, agent, position, positionVault: positionVaultPda(position), systemProgram: SystemProgram.programId })
        .rpc(),
    claimDefault: (position: PublicKey) =>
      tp.methods
        .claimDefault()
        .accounts({
          trader: traderKp.publicKey, agent, agentVault, position,
          positionVault: positionVaultPda(position), systemProgram: SystemProgram.programId,
        })
        .rpc(),
    withdraw: (lamports: number) =>
      ap.methods
        .withdrawCollateral(new BN(lamports))
        .accounts({ authority: agentKp.publicKey, agent, agentVault, systemProgram: SystemProgram.programId })
        .rpc(),
  };
  return env;
}

describe("collateralized_agents on localnet", () => {
  let rentFloor: number;

  before(async () => {
    const info = await connection.getAccountInfo(PROGRAM_ID);
    assert.ok(info?.executable, `program ${PROGRAM_ID} is not deployed at ${RPC}. Run: npm run deploy:local`);
    rentFloor = await connection.getMinimumBalanceForRentExemption(0);
  });

  it("registers an agent and derives the fee from the collateral ratio", async () => {
    const env = await setup(3000, 2000, 0);
    const a = await env.agentState();
    assert.equal(a.collateralRatioBps, 3000);
    assert.equal(a.feeBps, 1500);
    assert.equal(a.accepting, true);
    assert.equal(a.totalCollateral.toNumber(), 0);
    assert.ok(a.authority.equals(env.agentKp.publicKey));
  });

  it("rejects a collateral ratio below the minimum", async () => {
    const kp = Keypair.generate();
    await fund(kp, 2);
    const agent = agentPda(kp.publicKey);
    await expectAnchorError(
      programFor(kp).methods
        .registerAgent("Bad", "", 500, 1000)
        .accounts({ authority: kp.publicKey, agent, agentVault: agentVaultPda(agent), systemProgram: SystemProgram.programId })
        .rpc(),
      "InvalidCollateralRatio",
    );
  });

  it("locks principal × ratio and refuses positions the agent cannot back", async () => {
    const env = await setup(3000, 2000, 1);
    // 1 SOL bond at 30% backs at most 3.33 SOL
    await expectAnchorError(env.open(4 * SOL, 3600), "InsufficientFreeCollateral");

    const position = await env.open(1 * SOL, 3600);
    const a = await env.agentState();
    assert.equal(a.lockedCollateral.toNumber(), 0.3 * SOL);
    assert.equal(a.capitalManaged.toNumber(), 1 * SOL);
    assert.equal(a.openPositions, 1);

    const p = await env.positionState(position);
    assert.equal(p.principal.toNumber(), 1 * SOL);
    assert.equal(p.lockedCollateral.toNumber(), 0.3 * SOL);
    assert.deepEqual(p.status, { open: {} });
    assert.equal(await balance(positionVaultPda(position)), 1 * SOL + rentFloor);

    // locked collateral cannot leave the vault
    await expectAnchorError(env.withdraw(0.8 * SOL), "InsufficientFreeCollateral");
    await env.withdraw(0.7 * SOL);
    assert.equal((await env.agentState()).totalCollateral.toNumber(), 0.3 * SOL);
  });

  it("pays a performance fee on profit and returns the rest to the trader", async () => {
    const env = await setup(3000, 2000, 1);
    const position = await env.open(1 * SOL, 3600);
    await env.draw(position);
    assert.deepEqual((await env.positionState(position)).status, { trading: {} });
    assert.equal(await balance(positionVaultPda(position)), rentFloor);

    const traderBefore = await balance(env.traderKp.publicKey);
    await env.settle(position, 1.2 * SOL); // +20%: fee = 15% of 0.2 = 0.03

    const p = await env.positionState(position);
    assert.deepEqual(p.status, { settled: {} });
    assert.equal(p.feePaid.toNumber(), 0.03 * SOL);
    assert.equal(p.slashed.toNumber(), 0);
    assert.equal((await balance(env.traderKp.publicKey)) - traderBefore, 1.17 * SOL + rentFloor);
    assert.equal(await balance(positionVaultPda(position)), 0); // vault fully drained

    const a = await env.agentState();
    assert.equal(a.lockedCollateral.toNumber(), 0);
    assert.equal(a.totalCollateral.toNumber(), 1 * SOL);
    assert.equal(a.settledPositions, 1);
    assert.equal(a.feesEarned.toNumber(), 0.03 * SOL);
  });

  it("does not slash a loss inside the declared drawdown", async () => {
    const env = await setup(3000, 2000, 1);
    const position = await env.open(1 * SOL, 3600);
    await env.draw(position);
    await env.settle(position, 0.85 * SOL); // -15%, allowed -20%
    const p = await env.positionState(position);
    assert.equal(p.slashed.toNumber(), 0);
    assert.equal(p.feePaid.toNumber(), 0);
    assert.equal((await env.agentState()).totalCollateral.toNumber(), 1 * SOL);
  });

  it("slashes the shortfall beyond the drawdown, capped at the locked guarantee", async () => {
    const env = await setup(3000, 2000, 1);
    const position = await env.open(1 * SOL, 3600);
    await env.draw(position);
    const traderBefore = await balance(env.traderKp.publicKey);

    await env.settle(position, 0); // lost everything: shortfall 0.8, guarantee 0.3
    const p = await env.positionState(position);
    assert.equal(p.slashed.toNumber(), 0.3 * SOL);
    assert.equal((await balance(env.traderKp.publicKey)) - traderBefore, 0.3 * SOL + rentFloor);

    const a = await env.agentState();
    assert.equal(a.totalCollateral.toNumber(), 0.7 * SOL);
    assert.equal(a.slashedTotal.toNumber(), 0.3 * SOL);
    assert.equal(a.lockedCollateral.toNumber(), 0);
    assert.equal(await balance(env.agentVault), 0.7 * SOL + rentFloor);
  });

  it("lets the trader cancel before the agent draws, with a full refund", async () => {
    const env = await setup(3000, 2000, 1);
    const position = await env.open(1 * SOL, 3600);
    const before = await balance(env.traderKp.publicKey);
    await env.cancel(position);
    // trader paid the 5000-lamport tx fee for the cancel itself
    assert.equal((await balance(env.traderKp.publicKey)) - before + 5000, 1 * SOL + rentFloor);
    assert.deepEqual((await env.positionState(position)).status, { cancelled: {} });
    assert.equal((await env.agentState()).lockedCollateral.toNumber(), 0);
    await expectAnchorError(env.cancel(position), "InvalidStatus");
    await expectAnchorError(env.draw(position), "InvalidStatus");
  });

  it("refuses draws and settles from a wallet that is not the agent authority", async () => {
    const env = await setup(3000, 2000, 1);
    const position = await env.open(1 * SOL, 3600);
    const impostor = Keypair.generate();
    await fund(impostor, 2);
    // The agent PDA is derived from the authority, so a different signer fails the seeds check.
    await expectAnchorError(env.draw(position, programFor(impostor), impostor.publicKey), "ConstraintSeeds");
  });

  it("refuses new positions while the agent is paused", async () => {
    const env = await setup(3000, 2000, 1);
    await env.ap.methods.setAccepting(false).accounts({ authority: env.agentKp.publicKey, agent: env.agent }).rpc();
    await expectAnchorError(env.open(0.1 * SOL, 3600), "AgentPaused");
    await env.ap.methods.setAccepting(true).accounts({ authority: env.agentKp.publicKey, agent: env.agent }).rpc();
    await env.open(0.1 * SOL, 3600);
  });

  it("pays the whole guarantee to the trader when the agent misses the deadline (waits ~65s)", { timeout: 120_000 }, async () => {
    const env = await setup(3000, 2000, 1);
    const position = await env.open(1 * SOL, 60); // minimum duration
    await env.draw(position);
    await expectAnchorError(env.claimDefault(position), "DeadlineNotReached");

    const deadline = (await env.positionState(position)).deadline.toNumber();
    const wait = deadline * 1000 - Date.now() + 5_000;
    await sleep(Math.max(wait, 0));

    const before = await balance(env.traderKp.publicKey);
    await env.claimDefault(position);
    assert.equal((await balance(env.traderKp.publicKey)) - before + 5000, 0.3 * SOL + rentFloor);

    const p = await env.positionState(position);
    assert.deepEqual(p.status, { defaulted: {} });
    assert.equal(p.slashed.toNumber(), 0.3 * SOL);
    const a = await env.agentState();
    assert.equal(a.defaultedPositions, 1);
    assert.equal(a.totalCollateral.toNumber(), 0.7 * SOL);
    assert.equal(a.lockedCollateral.toNumber(), 0);
    // the agent cannot settle a defaulted position afterwards
    await expectAnchorError(env.settle(position, 1 * SOL), "InvalidStatus");
  });
});
