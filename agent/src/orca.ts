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
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  type Keypair,
} from "@solana/web3.js";
import { AccountRole, type Instruction } from "@solana/kit";
import { connection } from "./chain.js";
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

type Quote = { pool: string; out: bigint };

async function quote(pool: string, mintIn: "SOL" | "USDC", amountIn: bigint, signer: KeyPairSigner): Promise<Quote> {
  const { quote } = await withRetry(() => swapInstructions(
    rpc,
    { inputAmount: amountIn, mint: mintIn === "SOL" ? SOL : USDC },
    address(pool),
    { slippageToleranceBps: SLIPPAGE_BPS, signer, whirlpoolDeployment: deployment },
  ));
  return { pool, out: quote.tokenEstOut };
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

async function usdcBalance(owner: string): Promise<bigint> {
  const res = await withRetry(() =>
    rpc.getTokenAccountsByOwner(address(owner), { mint: USDC }, { encoding: "jsonParsed" }).send(),
  );
  return res.value.reduce(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (n, a: any) => n + BigInt(a.account.data.parsed.info.tokenAmount.amount),
    0n,
  );
}

/**
 * Executes an exact-in swap and returns the balance changes.
 * Selling SOL is booked as exactly `-amountIn`, so one-time account rent is not
 * charged to a position. Buying SOL is measured on-chain, excluding the network fee.
 * Sent through web3.js, which retries rate-limited requests before they reach the cluster.
 */
export async function swapExactIn(
  pool: string,
  mintIn: "SOL" | "USDC",
  amountIn: bigint,
  signer: KeyPairSigner,
): Promise<SwapResult> {
  const { instructions } = await withRetry(() =>
    swapInstructions(
      rpc,
      { inputAmount: amountIn, mint: mintIn === "SOL" ? SOL : USDC },
      address(pool),
      { slippageToleranceBps: SLIPPAGE_BPS, signer, whirlpoolDeployment: deployment },
    ),
  );
  const payer = keypairs.get(signer.address);
  if (!payer) throw new Error("unknown signer; create it with signerFor()");
  const tx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
    .add(...instructions.map(toWeb3));

  const usdcBefore = await usdcBalance(signer.address);
  const signature = await sendAndConfirmTransaction(connection, tx, [payer], { commitment: "confirmed" });
  const usdcAfter = await usdcBalance(signer.address);

  let solDelta = -amountIn;
  if (mintIn === "USDC") {
    solDelta = 0n;
    for (let i = 0; i < 10; i++) {
      const info = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      if (info?.meta) {
        solDelta = BigInt(info.meta.postBalances[0] - info.meta.preBalances[0] + info.meta.fee);
        break;
      }
      await sleep(1500);
    }
  }
  return { signature, solDelta, usdcDelta: usdcAfter - usdcBefore };
}
