import { hasBearer } from "@/lib/auth";
import { storageConfigured, writeSnapshot } from "@/lib/waitlistStore";

/**
 * Daily snapshot of every waitlist entry into one encrypted file.
 * Called by Vercel Cron, which sends `Authorization: Bearer $CRON_SECRET`.
 * Any failure returns a non-200 status so it shows up as a failed cron run.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!hasBearer(req, process.env.CRON_SECRET)) return new Response("Not found", { status: 404 });
  if (!storageConfigured()) {
    console.error("[waitlist-backup] FAILED: storage not configured (BLOB_READ_WRITE_TOKEN or WAITLIST_ADMIN_KEY missing)");
    return Response.json({ error: "storage not configured" }, { status: 503 });
  }
  try {
    const { count, pathname } = await writeSnapshot();
    console.log(`[waitlist-backup] ok: ${count} entries -> ${pathname}`);
    return Response.json({ ok: true, count, pathname });
  } catch (e) {
    console.error("[waitlist-backup] SNAPSHOT FAILED:", e);
    return Response.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
