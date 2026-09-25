import { Connection, PublicKey } from "@solana/web3.js";
import idl from "@/lib/idl.json";

/**
 * Returns every account owned by the program, base64-encoded.
 *
 * Browsers call this instead of `getProgramAccounts`, which public RPCs
 * rate-limit per IP. Responses are cached in memory and at Vercel's edge, so
 * all visitors share a few upstream calls per minute. If the RPC throttles or
 * fails, the last good snapshot is served instead of an error.
 *
 * After a transaction the client passes `?fresh&minSlot=<slot it confirmed in>`: the route reloads
 * until the snapshot is at least that recent (a few tries, since load-balanced RPC nodes can lag).
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const RPC =
  process.env.RPC_URL ?? process.env.NEXT_PUBLIC_RPC_URL ?? "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey(idl.address);
const TTL_MS = 10_000;
const MIN_FRESH_GAP_MS = 2_000;
const MIN_SLOT_TRIES = 4;
const MIN_SLOT_RETRY_MS = 500;

type Snapshot = { at: number; slot: number; accounts: { pubkey: string; data: string }[] };
let cache: Snapshot | null = null;
let inflight: Promise<Snapshot> | null = null;

async function load(): Promise<Snapshot> {
  const conn = new Connection(RPC, "confirmed");
  const { context, value } = await conn.getProgramAccounts(PROGRAM_ID, { commitment: "confirmed", withContext: true });
  return {
    at: Date.now(),
    slot: context.slot,
    accounts: value.map((a) => ({ pubkey: a.pubkey.toBase58(), data: a.account.data.toString("base64") })),
  };
}

/** Loads once, sharing a load already in flight. */
function reload(): Promise<Snapshot> {
  inflight ??= load().finally(() => (inflight = null));
  return inflight;
}

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const fresh = params.has("fresh");
  const minSlot = Number(params.get("minSlot")) || 0;
  const age = cache ? Date.now() - cache.at : Infinity;
  const behind = () => !cache || cache.slot < minSlot;
  const wantReload = age > TTL_MS || (fresh && age > MIN_FRESH_GAP_MS) || behind();

  let stale = false;
  if (wantReload) {
    try {
      for (let i = 0; i < MIN_SLOT_TRIES; i++) {
        if (i > 0) await new Promise((r) => setTimeout(r, MIN_SLOT_RETRY_MS));
        const snap = await reload();
        if (!cache || snap.slot >= cache.slot) cache = snap; // never step back to a lagging node's view
        if (!behind()) break;
      }
    } catch (e) {
      if (!cache) {
        return Response.json({ error: (e as Error).message }, { status: 503, headers: { "Cache-Control": "no-store" } });
      }
      stale = true;
    }
  }

  return Response.json(
    { at: cache!.at, slot: cache!.slot, stale, accounts: cache!.accounts },
    {
      headers: {
        "Cache-Control": fresh || minSlot ? "no-store" : "public, s-maxage=10, stale-while-revalidate=20",
      },
    },
  );
}
