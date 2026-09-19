import { storageConfigured, writeSnapshot } from "@/lib/waitlistStore";

/**
 * Daily snapshot of every waitlist entry into one encrypted file.
 * Called by Vercel Cron, which sends `Authorization: Bearer $CRON_SECRET`.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("Not found", { status: 404 });
  }
  if (!storageConfigured()) return Response.json({ error: "storage not configured" }, { status: 503 });
  const { count, pathname } = await writeSnapshot();
  return Response.json({ ok: true, count, pathname });
}
