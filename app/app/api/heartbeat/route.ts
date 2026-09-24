import { head, put } from "@vercel/blob";

/**
 * Liveness of the agent runners. The runner POSTs every tick with the shared
 * secret; the site GETs it to show whether agents are online.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PATH = "status/heartbeat.json";
type Beat = { at: string; agents: string[]; note?: string };
let cached: Beat | null = null;

export async function POST(req: Request) {
  const secret = process.env.HEARTBEAT_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) return new Response("Not found", { status: 404 });
  const body = (await req.json().catch(() => ({}))) as Partial<Beat>;
  cached = { at: new Date().toISOString(), agents: Array.isArray(body.agents) ? body.agents.slice(0, 20) : [], note: body.note?.slice(0, 200) };
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    await put(PATH, JSON.stringify(cached), { access: "public", contentType: "application/json", addRandomSuffix: false, cacheControlMaxAge: 0 }).catch(() => {});
  }
  return Response.json({ ok: true });
}

export async function GET() {
  let beat = cached;
  if (!beat && process.env.BLOB_READ_WRITE_TOKEN) {
    const meta = await head(PATH).catch(() => null);
    if (meta) beat = (await fetch(meta.downloadUrl ?? meta.url, { cache: "no-store" }).then((r) => r.json()).catch(() => null)) as Beat | null;
  }
  const ageSec = beat ? Math.round((Date.now() - new Date(beat.at).getTime()) / 1000) : null;
  return Response.json({ online: ageSec !== null && ageSec < 300, ageSec, at: beat?.at ?? null, agents: beat?.agents ?? [] }, { headers: { "Cache-Control": "no-store" } });
}
