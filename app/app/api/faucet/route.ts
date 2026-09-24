import { head, put } from "@vercel/blob";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";

/**
 * Devnet faucet for testers: sends a small amount of devnet SOL to a wallet,
 * once per wallet, from a dedicated faucet key. Never enabled on mainnet.
 */
export const runtime = "nodejs";

const RPC = process.env.RPC_URL ?? process.env.NEXT_PUBLIC_RPC_URL ?? "https://api.devnet.solana.com";
const CLUSTER = process.env.NEXT_PUBLIC_CLUSTER ?? "devnet";
const AMOUNT = 0.2 * LAMPORTS_PER_SOL;
const RESERVE = 0.05 * LAMPORTS_PER_SOL;
const recent = new Map<string, number[]>();

function limited(ip: string) {
  const now = Date.now();
  const hits = (recent.get(ip) ?? []).filter((t) => now - t < 3_600_000);
  hits.push(now);
  recent.set(ip, hits);
  return hits.length > 3;
}

export async function GET() {
  const key = process.env.FAUCET_KEYPAIR;
  if (CLUSTER !== "devnet" || !key) return Response.json({ enabled: false });
  try {
    const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(key)));
    const balance = await new Connection(RPC, "confirmed").getBalance(kp.publicKey);
    return Response.json({ enabled: true, amountSol: AMOUNT / LAMPORTS_PER_SOL, remainingDrops: Math.max(0, Math.floor((balance - RESERVE) / AMOUNT)) });
  } catch {
    return Response.json({ enabled: false });
  }
}

export async function POST(req: Request) {
  const key = process.env.FAUCET_KEYPAIR;
  if (CLUSTER !== "devnet" || !key) return Response.json({ error: "Faucet is only available on devnet." }, { status: 404 });
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (limited(ip)) return Response.json({ error: "Too many requests. Try again in an hour." }, { status: 429 });

  let address: PublicKey;
  try {
    const body = (await req.json()) as { address?: string };
    address = new PublicKey(body.address ?? "");
  } catch {
    return Response.json({ error: "Send a valid Solana address." }, { status: 400 });
  }

  const marker = `faucet/${address.toBase58()}.json`;
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    const already = await head(marker).catch(() => null);
    if (already) return Response.json({ error: "This wallet already received devnet SOL from us. Use faucet.solana.com for more." }, { status: 409 });
  }

  const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(key)));
  const connection = new Connection(RPC, "confirmed");
  const balance = await connection.getBalance(kp.publicKey);
  if (balance < AMOUNT + RESERVE) return Response.json({ error: "The faucet is empty right now. Use faucet.solana.com." }, { status: 503 });

  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: address, lamports: AMOUNT }));
  const sig = await sendAndConfirmTransaction(connection, tx, [kp], { commitment: "confirmed" });
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    await put(marker, JSON.stringify({ address: address.toBase58(), sig, at: new Date().toISOString() }), { access: "public", contentType: "application/json", addRandomSuffix: false });
  }
  return Response.json({ ok: true, sig, amountSol: AMOUNT / LAMPORTS_PER_SOL });
}
