import { normalize, validate } from "@/lib/waitlist";
import { loadEntries, loadLatestSnapshot, saveEntry, storageConfigured, type Stored } from "@/lib/waitlistStore";

/**
 * POST: store a waitlist submission (encrypted, see lib/waitlistStore).
 * GET ?key=WAITLIST_ADMIN_KEY: export every submission as CSV.
 *     &snapshot=latest reads the newest daily snapshot instead of the live entries.
 */
export const runtime = "nodejs";

const recent = new Map<string, number[]>();

function rateLimited(ip: string) {
  const now = Date.now();
  const hits = (recent.get(ip) ?? []).filter((t) => now - t < 60_000);
  hits.push(now);
  recent.set(ip, hits);
  return hits.length > 5;
}

export async function POST(req: Request) {
  if (!storageConfigured()) {
    return Response.json({ error: "Waitlist storage is not configured." }, { status: 503 });
  }
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (rateLimited(ip)) return Response.json({ error: "Too many submissions. Try again in a minute." }, { status: 429 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid request." }, { status: 400 });
  }
  // Honeypot: real users never fill this hidden field.
  if (body && typeof body === "object" && (body as { website?: string }).website) {
    return Response.json({ ok: true });
  }
  const s = normalize(body);
  if (!s) return Response.json({ error: "Invalid request." }, { status: 400 });
  const problems = validate(s);
  if (problems.length) return Response.json({ error: problems.join(" ") }, { status: 400 });

  const id = crypto.randomUUID();
  const stored: Stored = { ...s, id, submittedAt: new Date().toISOString(), userAgent: req.headers.get("user-agent") ?? "" };
  await saveEntry(stored);
  return Response.json({ ok: true });
}

export async function GET(req: Request) {
  const key = new URL(req.url).searchParams.get("key");
  const expected = process.env.WAITLIST_ADMIN_KEY;
  if (!expected || !key || key !== expected) return new Response("Not found", { status: 404 });

  const fromSnapshot = new URL(req.url).searchParams.get("snapshot") === "latest";
  const rows: Stored[] = fromSnapshot ? ((await loadLatestSnapshot())?.entries ?? []) : await loadEntries();

  const cols: (keyof Stored)[] = [
    "submittedAt", "name", "email", "telegram", "location", "wallet", "tradesCrypto", "usedAgents", "wouldTrust",
    "allocation", "trustFactors", "collateralHelps", "testDevnet", "notes", "id",
  ];
  const esc = (v: unknown) => `"${String(Array.isArray(v) ? v.join("; ") : v ?? "").replace(/"/g, '""')}"`;
  const csv = [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
  return new Response(csv, {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="waitlist-${new Date().toISOString().slice(0, 10)}.csv"`, "Cache-Control": "no-store" },
  });
}
