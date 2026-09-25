import { bearerToken, safeEqual } from "@/lib/auth";
import { clientIp, rateLimiter } from "@/lib/rateLimit";
import { lengthProblems, normalize, validate } from "@/lib/waitlist";
import { dedupeByEmail, loadEntries, loadLatestSnapshot, saveEntry, storageConfigured, type Stored } from "@/lib/waitlistStore";

/**
 * POST: store a waitlist submission (encrypted, see lib/waitlistStore). One entry per email;
 *       a resubmission replaces the earlier one.
 * GET with `Authorization: Bearer <token>`: export every submission as CSV, one row per email (latest wins).
 *     The token is WAITLIST_EXPORT_TOKEN when set, otherwise WAITLIST_ADMIN_KEY.
 *     `?key=<token>` is still accepted for older backup scripts; the header is preferred.
 *     &snapshot=latest reads the newest daily snapshot instead of the live entries.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 8 * 1024;
const limited = rateLimiter({ windowMs: 60_000, max: 5 });

/** The credential that unlocks the export. Rotatable; the encryption key is not. */
const exportToken = () => process.env.WAITLIST_EXPORT_TOKEN || process.env.WAITLIST_ADMIN_KEY;

export async function POST(req: Request) {
  if (!storageConfigured()) {
    return Response.json({ error: "Waitlist storage is not configured." }, { status: 503 });
  }
  if (limited(clientIp(req))) return Response.json({ error: "Too many submissions. Try again in a minute." }, { status: 429 });

  let body: unknown;
  try {
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) return Response.json({ error: "Submission is too large." }, { status: 413 });
    body = JSON.parse(text);
  } catch {
    return Response.json({ error: "Invalid request." }, { status: 400 });
  }
  // Honeypot: real users never fill this hidden field.
  if (body && typeof body === "object" && (body as { website?: string }).website) {
    return Response.json({ ok: true });
  }
  const tooLong = lengthProblems(body);
  if (tooLong.length) return Response.json({ error: tooLong.join(" ") }, { status: 400 });
  const s = normalize(body);
  if (!s) return Response.json({ error: "Invalid request." }, { status: 400 });
  const problems = validate(s);
  if (problems.length) return Response.json({ error: problems.join(" ") }, { status: 400 });

  const stored: Stored = {
    ...s,
    id: crypto.randomUUID(),
    submittedAt: new Date().toISOString(),
    userAgent: (req.headers.get("user-agent") ?? "").slice(0, 300),
  };
  try {
    await saveEntry(stored);
  } catch (e) {
    console.error("[waitlist] failed to save entry:", e);
    return Response.json({ error: "Could not save your submission. Please try again." }, { status: 500 });
  }
  return Response.json({ ok: true });
}

/** Quotes a CSV cell and defuses spreadsheet formulas (=, +, -, @, tab, CR at the start). */
function csvCell(v: unknown): string {
  let s = String(Array.isArray(v) ? v.join("; ") : v ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const given = bearerToken(req) ?? url.searchParams.get("key");
  if (!safeEqual(given, exportToken())) return new Response("Not found", { status: 404 });

  let rows: Stored[];
  try {
    const all = url.searchParams.get("snapshot") === "latest" ? ((await loadLatestSnapshot())?.entries ?? []) : await loadEntries();
    rows = dedupeByEmail(all);
  } catch (e) {
    console.error("[waitlist] EXPORT FAILED:", e);
    return Response.json({ error: "export failed", detail: (e as Error).message }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }

  const cols: (keyof Stored)[] = [
    "submittedAt", "name", "email", "telegram", "location", "wallet", "tradesCrypto", "usedAgents", "wouldTrust",
    "allocation", "trustFactors", "collateralHelps", "testDevnet", "notes", "id",
  ];
  const csv = [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\n");
  return new Response(csv, {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="waitlist-${new Date().toISOString().slice(0, 10)}.csv"`, "Cache-Control": "no-store" },
  });
}
