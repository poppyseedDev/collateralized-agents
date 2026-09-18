import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { list, put } from "@vercel/blob";
import { normalize, validate, type Submission } from "@/lib/waitlist";

/**
 * POST: store a waitlist submission in Vercel Blob, encrypted with a key
 * derived from WAITLIST_ADMIN_KEY, so a leaked blob URL exposes nothing.
 * GET ?key=WAITLIST_ADMIN_KEY: decrypt and export every submission as CSV.
 */
export const runtime = "nodejs";

const cipherKey = () => {
  const secret = process.env.WAITLIST_ADMIN_KEY;
  if (!secret) throw new Error("WAITLIST_ADMIN_KEY is not set");
  return createHash("sha256").update(secret).digest();
};

function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", cipherKey(), iv);
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString("base64");
}

function decrypt(b64: string): string {
  const buf = Buffer.from(b64, "base64");
  const d = createDecipheriv("aes-256-gcm", cipherKey(), buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8");
}

type Stored = Submission & { id: string; submittedAt: string; userAgent: string };

const PREFIX = "waitlist/";
const recent = new Map<string, number[]>();

function rateLimited(ip: string) {
  const now = Date.now();
  const hits = (recent.get(ip) ?? []).filter((t) => now - t < 60_000);
  hits.push(now);
  recent.set(ip, hits);
  return hits.length > 5;
}

export async function POST(req: Request) {
  if (!process.env.BLOB_READ_WRITE_TOKEN || !process.env.WAITLIST_ADMIN_KEY) {
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
  await put(`${PREFIX}${stored.submittedAt.slice(0, 10)}/${id}.enc`, encrypt(JSON.stringify(stored)), {
    access: "public", // the store is public; contents are encrypted and the path is unguessable
    contentType: "text/plain",
    addRandomSuffix: true,
  });
  return Response.json({ ok: true });
}

export async function GET(req: Request) {
  const key = new URL(req.url).searchParams.get("key");
  const expected = process.env.WAITLIST_ADMIN_KEY;
  if (!expected || !key || key !== expected) return new Response("Not found", { status: 404 });

  const rows: Stored[] = [];
  let cursor: string | undefined;
  do {
    const page = await list({ prefix: PREFIX, cursor, limit: 1000 });
    for (const b of page.blobs) {
      const res = await fetch(b.downloadUrl ?? b.url, { cache: "no-store" });
      if (!res.ok) continue;
      try {
        rows.push(JSON.parse(decrypt(await res.text())) as Stored);
      } catch {
        // skip anything that isn't one of our encrypted entries
      }
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  rows.sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));

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
