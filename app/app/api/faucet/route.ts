import { del, head, list, put } from "@vercel/blob";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { clientIp, rateLimiter } from "@/lib/rateLimit";

/**
 * Devnet faucet for testers: sends a small amount of devnet SOL to a wallet,
 * once per wallet, from a dedicated faucet key. Never enabled on mainnet.
 *
 * Guards, in order: devnet-only (checked against the RPC's genesis hash), per-IP rate limit,
 * one payout per wallet (a Blob marker claimed before sending), and a global daily cap.
 *
 * TODO: add a captcha (e.g. Cloudflare Turnstile or hCaptcha) once one is set up. The per-IP limit
 * is per serverless instance, so a determined script can still cycle wallets up to the daily cap.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RPC = process.env.RPC_URL ?? process.env.NEXT_PUBLIC_RPC_URL ?? "https://api.devnet.solana.com";
const CLUSTER = process.env.NEXT_PUBLIC_CLUSTER ?? "devnet";
const AMOUNT = 0.2 * LAMPORTS_PER_SOL;
const RESERVE = 0.05 * LAMPORTS_PER_SOL;
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const DAILY_CAP_LAMPORTS = (() => {
  const v = Number(process.env.FAUCET_DAILY_CAP_SOL);
  return Math.floor((Number.isFinite(v) && v >= 0 && process.env.FAUCET_DAILY_CAP_SOL ? v : 20) * LAMPORTS_PER_SOL);
})();
const MAX_DROPS_PER_DAY = Math.floor(DAILY_CAP_LAMPORTS / AMOUNT);

const WALLET_PREFIX = "faucet/";
const DAY_PREFIX = "faucet-daily/";
const limited = rateLimiter({ windowMs: 3_600_000, max: 3 });

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

// ---------- cluster guard ----------

const isLocalRpc = () => {
  try {
    const h = new URL(RPC).hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]";
  } catch {
    return false;
  }
};

let clusterCheck: Promise<boolean> | null = null;
/**
 * True only when the RPC really is devnet (by genesis hash), or a local validator in development.
 * NEXT_PUBLIC_CLUSTER alone isn't trusted: a mainnet RPC_URL with the default cluster would pass it.
 */
function onDevnet(): Promise<boolean> {
  if (CLUSTER === "localnet") return Promise.resolve(isLocalRpc() && process.env.NODE_ENV !== "production");
  if (CLUSTER !== "devnet") return Promise.resolve(false);
  clusterCheck ??= new Connection(RPC, "confirmed")
    .getGenesisHash()
    .then((h) => h === DEVNET_GENESIS)
    .catch(() => {
      clusterCheck = null; // don't cache a network failure
      return false;
    });
  return clusterCheck;
}

// ---------- config ----------

function faucetKeypair(): Keypair | null {
  const key = process.env.FAUCET_KEYPAIR;
  if (!key) return null;
  try {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(key)));
  } catch {
    console.error("[faucet] FAUCET_KEYPAIR is not a valid JSON secret key");
    return null;
  }
}

/** Once-per-wallet and the daily cap both need Blob storage, so the faucet stays off without it. */
const storageConfigured = () => !!process.env.BLOB_READ_WRITE_TOKEN;

const today = () => new Date().toISOString().slice(0, 10);

async function countToday(): Promise<number> {
  let n = 0;
  let cursor: string | undefined;
  do {
    const page = await list({ prefix: `${DAY_PREFIX}${today()}/`, cursor, limit: 1000 });
    n += page.blobs.length;
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return n;
}

/** Creates `pathname` only if it doesn't exist yet. Returns false if it was already there. */
async function claim(pathname: string, body: string): Promise<boolean> {
  try {
    await put(pathname, body, { access: "public", contentType: "application/json", addRandomSuffix: false, allowOverwrite: false });
    return true;
  } catch (e) {
    // The put fails when the blob exists; any other failure is rethrown.
    if (await head(pathname).catch(() => null)) return false;
    throw e;
  }
}

// ---------- routes ----------

export async function GET() {
  try {
    const kp = faucetKeypair();
    if (!kp || !storageConfigured() || !(await onDevnet())) return json({ enabled: false });
    const balance = await new Connection(RPC, "confirmed").getBalance(kp.publicKey);
    const leftToday = Math.max(0, MAX_DROPS_PER_DAY - (await countToday()));
    return json({
      enabled: true,
      amountSol: AMOUNT / LAMPORTS_PER_SOL,
      remainingDrops: Math.min(leftToday, Math.max(0, Math.floor((balance - RESERVE) / AMOUNT))),
    });
  } catch (e) {
    console.error("[faucet] status check failed:", e);
    return json({ enabled: false });
  }
}

export async function POST(req: Request) {
  try {
    return await drip(req);
  } catch (e) {
    console.error("[faucet] unexpected error:", e);
    return json({ error: "The faucet hit an error. Try again, or use faucet.solana.com." }, 500);
  }
}

async function drip(req: Request): Promise<Response> {
  const kp = faucetKeypair();
  if (!kp || !storageConfigured() || !(await onDevnet())) return json({ error: "Faucet is only available on devnet." }, 404);
  if (limited(clientIp(req))) return json({ error: "Too many requests. Try again in an hour." }, 429);

  let address: PublicKey;
  try {
    const body = (await req.json()) as { address?: string };
    address = new PublicKey(body.address ?? "");
  } catch {
    return json({ error: "Send a valid Solana address." }, 400);
  }
  const addr = address.toBase58();

  const connection = new Connection(RPC, "confirmed");
  const balance = await connection.getBalance(kp.publicKey);
  if (balance < AMOUNT + RESERVE) return json({ error: "The faucet is empty right now. Use faucet.solana.com." }, 503);
  if ((await countToday()) >= MAX_DROPS_PER_DAY) {
    return json({ error: "Today's faucet budget is used up. Try again tomorrow or use faucet.solana.com." }, 503);
  }

  // Claim the wallet before sending, so concurrent requests for the same wallet can't all pass.
  const walletMarker = `${WALLET_PREFIX}${addr}.json`;
  const claimedAt = new Date().toISOString();
  if (!(await claim(walletMarker, JSON.stringify({ address: addr, at: claimedAt, state: "claimed" })))) {
    return json({ error: "This wallet already received devnet SOL from us. Use faucet.solana.com for more." }, 409);
  }

  // Count this payout toward today's cap, then re-check: if concurrent requests pushed the day over, back out.
  const dayMarker = `${DAY_PREFIX}${today()}/${addr}.json`;
  const release = () => del([walletMarker, dayMarker]).catch((e) => console.error("[faucet] could not release markers:", e));
  await put(dayMarker, JSON.stringify({ address: addr, at: claimedAt, lamports: AMOUNT }), {
    access: "public", contentType: "application/json", addRandomSuffix: false, allowOverwrite: true,
  });
  if ((await countToday()) > MAX_DROPS_PER_DAY) {
    await release();
    return json({ error: "Today's faucet budget is used up. Try again tomorrow or use faucet.solana.com." }, 503);
  }

  // Send. If the transaction never reached the network, release the claim so the wallet can retry.
  // If it was sent but confirmation is uncertain, keep the claim: a double payout is worse than a retry.
  let sig: string;
  try {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    const tx = new Transaction({ feePayer: kp.publicKey, blockhash, lastValidBlockHeight }).add(
      SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: address, lamports: AMOUNT }),
    );
    tx.sign(kp);
    sig = await connection.sendRawTransaction(tx.serialize());
    try {
      const res = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
      if (res.value.err) {
        await release();
        console.error("[faucet] transfer failed on chain:", sig, res.value.err);
        return json({ error: "The transfer failed. Try again, or use faucet.solana.com." }, 502);
      }
    } catch (e) {
      console.error("[faucet] could not confirm transfer; keeping the claim:", sig, e);
      return json({ error: "Sent, but confirmation timed out. Check your balance in a minute.", sig }, 504);
    }
  } catch (e) {
    await release();
    console.error("[faucet] could not send transfer:", e);
    return json({ error: "Could not send devnet SOL right now. Try again, or use faucet.solana.com." }, 502);
  }

  await put(walletMarker, JSON.stringify({ address: addr, sig, at: new Date().toISOString(), state: "sent" }), {
    access: "public", contentType: "application/json", addRandomSuffix: false, allowOverwrite: true,
  }).catch((e) => console.error("[faucet] could not record signature:", e));
  return json({ ok: true, sig, amountSol: AMOUNT / LAMPORTS_PER_SOL });
}
