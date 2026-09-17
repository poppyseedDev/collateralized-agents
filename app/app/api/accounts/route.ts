import { Connection, PublicKey } from "@solana/web3.js";
import idl from "@/lib/idl.json";

/**
 * Returns every account owned by the program, base64-encoded.
 *
 * Browsers call this instead of `getProgramAccounts`, which public RPCs
 * rate-limit per IP. Responses are cached in memory and at Vercel's edge, so
 * all visitors share a few upstream calls per minute. If the RPC throttles or
 * fails, the last good snapshot is served instead of an error.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const RPC =
  process.env.RPC_URL ?? process.env.NEXT_PUBLIC_RPC_URL ?? "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey(idl.address);
const TTL_MS = 10_000;
const MIN_FRESH_GAP_MS = 2_000;

type Snapshot = { at: number; accounts: { pubkey: string; data: string }[] };
let cache: Snapshot | null = null;
let inflight: Promise<Snapshot> | null = null;

async function load(): Promise<Snapshot> {
  const conn = new Connection(RPC, "confirmed");
  const raw = await conn.getProgramAccounts(PROGRAM_ID, { commitment: "confirmed" });
  return {
    at: Date.now(),
    accounts: raw.map((a) => ({ pubkey: a.pubkey.toBase58(), data: a.account.data.toString("base64") })),
  };
}

export async function GET(req: Request) {
  const fresh = new URL(req.url).searchParams.has("fresh");
  const age = cache ? Date.now() - cache.at : Infinity;
  const wantReload = age > TTL_MS || (fresh && age > MIN_FRESH_GAP_MS);

  let stale = false;
  if (wantReload) {
    try {
      inflight ??= load().finally(() => (inflight = null));
      cache = await inflight;
    } catch (e) {
      if (!cache) {
        return Response.json({ error: (e as Error).message }, { status: 503, headers: { "Cache-Control": "no-store" } });
      }
      stale = true;
    }
  }

  return Response.json(
    { at: cache!.at, stale, accounts: cache!.accounts },
    {
      headers: {
        "Cache-Control": fresh ? "no-store" : "public, s-maxage=10, stale-while-revalidate=20",
      },
    },
  );
}
