import { address, createKeyPairSignerFromBytes, type KeyPairSigner } from "@solana/kit";
import {
  setJitoTipSetting,
  setNativeMintWrappingStrategy,
  setPriorityFeeSetting,
  setRpc,
  swapInstructions,
  WhirlpoolDeployment,
} from "@orca-so/whirlpools";
import { rpcFromUrl } from "@orca-so/tx-sender";
import { fetchAllMaybeWhirlpool } from "@orca-so/whirlpools-client";
import { sqrtPriceToPrice } from "@orca-so/whirlpools-core";
import {
  ComputeBudgetProgram,
  PublicKey,
  SendTransactionError,
  Transaction,
  TransactionInstruction,
  type Keypair,
} from "@solana/web3.js";
import { utils } from "@coral-xyz/anchor";
import { AccountRole, type Instruction } from "@solana/kit";
import { connection, withFallback } from "./chain.js";
import { MAIN_POOL, POOLS, RPC_URL, SLIPPAGE_BPS, SOL_MINT, USDC_MINT } from "./config.js";

const deployment = WhirlpoolDeployment.devnet;
const SOL = address(SOL_MINT);
const USDC = address(USDC_MINT);
let rpc: ReturnType<typeof rpcFromUrl>;

export async function initOrca() {
  await setRpc(RPC_URL, { supportsPriorityFeePercentile: false });
  setPriorityFeeSetting({ type: "none" });
  // "seed" wraps SOL in an account derived from the owner, so no extra signer is needed.
  setNativeMintWrappingStrategy("seed");
  setJitoTipSetting({ type: "none" });
  rpc = rpcFromUrl(RPC_URL);
}

const keypairs = new Map<string, Keypair>();

export async function signerFor(kp: Keypair): Promise<KeyPairSigner> {
  keypairs.set(kp.publicKey.toBase58(), kp);
  return createKeyPairSignerFromBytes(kp.secretKey);
}

function toWeb3(ix: Instruction): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programAddress),
    keys: (ix.accounts ?? []).map((a) => ({
      pubkey: new PublicKey(a.address),
      isSigner: a.role === AccountRole.READONLY_SIGNER || a.role === AccountRole.WRITABLE_SIGNER,
      isWritable: a.role === AccountRole.WRITABLE || a.role === AccountRole.WRITABLE_SIGNER,
    })),
    data: Buffer.from(ix.data ?? new Uint8Array()),
  });
}

export type Pool = { address: string; price: number };

let poolCache: { at: number; pools: Pool[] } | null = null;

/** Initialized SOL/USDC pools with liquidity, price in USDC per SOL. Cached for 30s. */
export async function livePools(): Promise<Pool[]> {
  if (poolCache && Date.now() - poolCache.at < 30_000) return poolCache.pools;
  const accounts = await withRetry(() => fetchAllMaybeWhirlpool(rpc, POOLS.map((p) => address(p))));
  const live = accounts.flatMap((a) => {
    if (!a.exists || a.data.liquidity === 0n) return [];
    const w = a.data;
    const solIsA = w.tokenMintA === SOL;
    const raw = sqrtPriceToPrice(w.sqrtPrice, solIsA ? 9 : 6, solIsA ? 6 : 9);
    return [{ address: a.address as string, price: solIsA ? raw : 1 / raw }];
  });
  poolCache = { at: Date.now(), pools: live };
  return live;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retries calls that hit the public RPC's rate limit (HTTP 429). */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 6): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const msg = String((e as Error)?.message ?? e) + JSON.stringify((e as { context?: unknown })?.context ?? "");
      if (i >= attempts - 1 || !/429|Too Many Requests|rate limit/i.test(msg)) throw e;
      await sleep(1000 * 2 ** i);
    }
  }
}

export async function mainPrice(): Promise<number> {
  const pools = await livePools();
  const main = pools.find((p) => p.address === MAIN_POOL);
  if (!main) throw new Error("main pool not found");
  return main.price;
}

/** A priced swap: `out` is the estimate, `minOut` the least the swap may return (estimate less SLIPPAGE_BPS). */
export type Quote = { pool: string; mintIn: "SOL" | "USDC"; amountIn: bigint; out: bigint; minOut: bigint };

const build = (pool: string, mintIn: "SOL" | "USDC", amountIn: bigint, signer: KeyPairSigner, slippageBps: number) =>
  withRetry(() =>
    swapInstructions(
      rpc,
      { inputAmount: amountIn, mint: mintIn === "SOL" ? SOL : USDC },
      address(pool),
      { slippageToleranceBps: slippageBps, signer, whirlpoolDeployment: deployment },
    ),
  );

export async function quote(pool: string, mintIn: "SOL" | "USDC", amountIn: bigint, signer: KeyPairSigner): Promise<Quote> {
  const { quote: q } = await build(pool, mintIn, amountIn, signer, SLIPPAGE_BPS);
  return { pool, mintIn, amountIn, out: q.tokenEstOut, minOut: q.tokenMinOut };
}

/** Best pool to sell `amountIn` of `mintIn`, by estimated output. */
export async function bestQuote(mintIn: "SOL" | "USDC", amountIn: bigint, signer: KeyPairSigner): Promise<Quote> {
  const pools = await livePools();
  const ok: Quote[] = [];
  const errors: string[] = [];
  // Sequential: the public devnet RPC rate-limits bursts.
  for (const p of pools) {
    try {
      const q = await quote(p.address, mintIn, amountIn, signer);
      if (q.out > 0n) ok.push(q);
    } catch (e) {
      errors.push(`${p.address.slice(0, 6)}: ${(e as Error).message.slice(0, 80)}`);
    }
    await sleep(150);
  }
  if (!ok.length) throw new Error(`no pool can fill this swap (${errors.join("; ")})`);
  return ok.reduce((a, b) => (b.out > a.out ? b : a));
}

export type SwapResult = { signature: string; solDelta: bigint; usdcDelta: bigint };

/** The swap is signed and about to be sent; persist this before sending so a lost confirmation can be recovered. */
export type Signed = { signature: string; lastValidBlockHeight: number };

/** Thrown when a signed swap may still land: keep it pending and resolve it on a later tick. */
export class SwapInFlight extends Error {}

type Meta = {
  fee: number;
  preBalances: number[];
  postBalances: number[];
  preTokenBalances?: { owner?: string; mint: string; uiTokenAmount: { amount: string } }[] | null;
  postTokenBalances?: { owner?: string; mint: string; uiTokenAmount: { amount: string } }[] | null;
};

/**
 * Balance changes of a landed swap, from its transaction meta.
 * Selling SOL is booked as exactly `-amountIn`, so one-time account rent is not
 * charged to a position. Buying SOL is measured on-chain, excluding the network fee.
 * USDC is measured from the owner's token balances before and after.
 */
function deltasFromMeta(meta: Meta, owner: string, mintIn: "SOL" | "USDC", amountIn: bigint) {
  const usdcOf = (bs: Meta["preTokenBalances"]) =>
    (bs ?? []).filter((b) => b.owner === owner && b.mint === USDC_MINT).reduce((n, b) => n + BigInt(b.uiTokenAmount.amount), 0n);
  const usdcDelta = usdcOf(meta.postTokenBalances) - usdcOf(meta.preTokenBalances);
  const solDelta = mintIn === "SOL" ? -amountIn : BigInt(meta.postBalances[0] - meta.preBalances[0] + meta.fee);
  return { solDelta, usdcDelta };
}

/** Meta of a landed transaction, retried briefly because RPC nodes index it with a small delay. Null if not found. */
async function fetchMeta(signature: string): Promise<{ meta: Meta; err: unknown } | null> {
  for (let i = 0; i < 10; i++) {
    const info = await withFallback("getTransaction", (c) =>
      c.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }),
    );
    if (info?.meta) return { meta: info.meta as Meta, err: info.meta.err };
    await sleep(1500);
  }
  return null;
}

/**
 * Executes an exact-in swap on `pool` and returns the balance changes.
 *
 * The on-chain minimum output is at least `minOut` (from the quote the decision was
 * based on); without it, the fresh quote's own minimum is used. The transaction is
 * signed first and `onSigned` is awaited before it is sent, so the caller can record
 * it. If the outcome is unknown when this returns (send or confirmation failed, or the
 * landed transaction's meta is not available), it throws `SwapInFlight`; resolve it
 * later with `resolveSwap`. Any other error means nothing was sent.
 */
export async function swapExactIn(
  pool: string,
  mintIn: "SOL" | "USDC",
  amountIn: bigint,
  signer: KeyPairSigner,
  onSigned: (s: Signed) => void | Promise<void>,
  minOut?: bigint,
): Promise<SwapResult> {
  let built = await build(pool, mintIn, amountIn, signer, SLIPPAGE_BPS);
  if (minOut !== undefined && built.quote.tokenMinOut < minOut) {
    const est = built.quote.tokenEstOut;
    if (est < minOut) {
      throw new Error(`price moved: pool quotes ${est} now, below the minimum ${minOut} from the evaluated quote`);
    }
    // Tighten slippage so the on-chain threshold is still at least minOut.
    const bps = Number(((est - minOut) * 10_000n) / est);
    built = await build(pool, mintIn, amountIn, signer, bps);
    if (built.quote.tokenMinOut < minOut) {
      throw new Error(`price moved: minimum output ${built.quote.tokenMinOut} is below ${minOut} from the evaluated quote`);
    }
  }
  const payer = keypairs.get(signer.address);
  if (!payer) throw new Error("unknown signer; create it with signerFor()");
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: payer.publicKey, blockhash, lastValidBlockHeight })
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
    .add(...built.instructions.map(toWeb3));
  tx.sign(payer);
  const signature = utils.bytes.bs58.encode(tx.signature!);
  await onSigned({ signature, lastValidBlockHeight });

  try {
    await connection.sendRawTransaction(tx.serialize(), { preflightCommitment: "confirmed", maxRetries: 5 });
  } catch (e) {
    // The RPC answered with an error (e.g. preflight failed), so it did not forward the transaction.
    if (e instanceof SendTransactionError) throw new SwapRejected((e as Error).message);
    throw new SwapInFlight(`send failed, outcome unknown: ${(e as Error).message}`);
  }
  try {
    const res = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
    if (res.value.err) throw new SwapRejected(`swap ${signature} failed on-chain: ${JSON.stringify(res.value.err)}`);
  } catch (e) {
    if (e instanceof SwapRejected) throw e;
    throw new SwapInFlight(`confirmation failed, outcome unknown: ${(e as Error).message}`);
  }
  const got = await fetchMeta(signature);
  if (!got) throw new SwapInFlight(`swap ${signature} confirmed but its transaction meta is not available yet`);
  return { signature, ...deltasFromMeta(got.meta, signer.address, mintIn, amountIn) };
}

/** The swap did not and cannot land: clear it and book nothing. */
export class SwapRejected extends Error {}

export type Resolution =
  | { state: "landed"; result: SwapResult }
  | { state: "failed"; reason: string }
  | { state: "pending"; reason: string };

/** Works out what happened to a swap that was signed on an earlier tick. */
export async function resolveSwap(
  p: { sig: string; lastValidBlockHeight: number; side: "SOL" | "USDC"; in: string },
  owner: string,
): Promise<Resolution> {
  const st = await withFallback("getSignatureStatuses", (c) =>
    c.getSignatureStatuses([p.sig], { searchTransactionHistory: true }),
  );
  const s = st.value[0];
  if (s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) {
    if (s.err) return { state: "failed", reason: `failed on-chain: ${JSON.stringify(s.err)}` };
    const got = await fetchMeta(p.sig);
    if (!got) return { state: "pending", reason: "landed, transaction meta not available yet" };
    return { state: "landed", result: { signature: p.sig, ...deltasFromMeta(got.meta, owner, p.side, BigInt(p.in)) } };
  }
  if (s) return { state: "pending", reason: `status ${s.confirmationStatus ?? "processed"}` };
  const height = await withFallback("getBlockHeight", (c) => c.getBlockHeight("confirmed"));
  if (height <= p.lastValidBlockHeight) return { state: "pending", reason: `not seen yet; blockhash valid for ${p.lastValidBlockHeight - height} more blocks` };
  // Expired: it can no longer land. Check once more that it did not land in the meantime.
  const got = await fetchMeta(p.sig).catch(() => null);
  if (got && !got.err) return { state: "landed", result: { signature: p.sig, ...deltasFromMeta(got.meta, owner, p.side, BigInt(p.in)) } };
  return { state: "failed", reason: "blockhash expired without the swap landing" };
}
