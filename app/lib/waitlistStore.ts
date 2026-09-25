import "server-only";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { head, list, put } from "@vercel/blob";
import type { Submission } from "./waitlist";

/**
 * Server-side storage for waitlist entries: encrypted files in Vercel Blob, plus daily snapshots.
 *
 * Layout (all under the public store, contents AES-256-GCM encrypted):
 *   waitlist/<YYYY-MM-DD>/<uuid>-<suffix>.enc     entries written before email dedup (read-only now)
 *   waitlist/by-email/<hmac>.enc                  the first submission per email; never overwritten
 *   waitlist/by-email/<hmac>/<stamp>-<uuid>.enc   later submissions from the same email, kept apart
 *   waitlist-snapshots/<stamp>-<suffix>.enc       daily snapshot of every entry
 *
 * The encryption key is derived from WAITLIST_ADMIN_KEY. Changing that variable makes every
 * existing entry and snapshot unreadable, so it must never be rotated. Rotate WAITLIST_EXPORT_TOKEN instead.
 */

export type Stored = Submission & { id: string; submittedAt: string; userAgent: string };

export const ENTRY_PREFIX = "waitlist/";
export const SNAPSHOT_PREFIX = "waitlist-snapshots/";
export const BY_EMAIL_PREFIX = `${ENTRY_PREFIX}by-email/`;
/** How many blobs are downloaded at once. */
const DOWNLOAD_CONCURRENCY = 8;

const cipherKey = () => {
  const secret = process.env.WAITLIST_ADMIN_KEY;
  if (!secret) throw new Error("WAITLIST_ADMIN_KEY is not set");
  return createHash("sha256").update(secret).digest();
};

/**
 * Pathname-safe id for an email. Keyed with a subkey of the cipher key, so the public
 * pathname reveals nothing and nobody without WAITLIST_ADMIN_KEY can compute it.
 */
export function emailId(email: string): string {
  const subkey = createHmac("sha256", cipherKey()).update("waitlist-email-index-v1").digest();
  return createHmac("sha256", subkey).update(email.trim().toLowerCase(), "utf8").digest("hex");
}

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", cipherKey(), iv);
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString("base64");
}

export function decrypt(b64: string): string {
  const buf = Buffer.from(b64, "base64");
  const d = createDecipheriv("aes-256-gcm", cipherKey(), buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8");
}

export const storageConfigured = () => !!process.env.BLOB_READ_WRITE_TOKEN && !!process.env.WAITLIST_ADMIN_KEY;

/**
 * Stores an entry. The first submission per email is kept as is; emails are unverified, so a later
 * one (possibly from someone else) goes beside it and the export shows it as an update.
 */
export async function saveEntry(stored: Stored) {
  const id = emailId(stored.email);
  const body = encrypt(JSON.stringify(stored));
  // The store is public; contents are encrypted and the path is unguessable.
  const opts = { access: "public", contentType: "text/plain", addRandomSuffix: false, allowOverwrite: false } as const;
  const first = `${BY_EMAIL_PREFIX}${id}.enc`;
  try {
    await put(first, body, opts);
  } catch (e) {
    // The put fails when the email already has an entry; any other failure is rethrown.
    if (!(await head(first).catch(() => null))) throw e;
    const stamp = stored.submittedAt.replace(/[:.]/g, "-");
    await put(`${BY_EMAIL_PREFIX}${id}/${stamp}-${stored.id}.enc`, body, opts);
  }
}

async function listAll(prefix: string) {
  const blobs = [];
  let cursor: string | undefined;
  do {
    const page = await list({ prefix, cursor, limit: 1000 });
    blobs.push(...page.blobs);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return blobs;
}

/** Runs `fn` over `items` with at most `limit` calls in flight, keeping order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function download(url: string, attempts = 3): Promise<string> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (res.ok) return await res.text();
      last = new Error(`HTTP ${res.status}`);
      if (res.status === 404) break;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 250 * (i + 1)));
  }
  throw last instanceof Error ? last : new Error(String(last));
}

/**
 * Every stored entry (old date-path files, first and later per-email files), oldest first, not grouped.
 * Throws if any file can't be downloaded, so a backup or export is never silently partial.
 * Files that download but don't decrypt are skipped with a warning.
 */
export async function loadEntries(): Promise<Stored[]> {
  const blobs = await listAll(ENTRY_PREFIX);
  const failed: string[] = [];
  const results = await mapLimit(blobs, DOWNLOAD_CONCURRENCY, async (b) => {
    let text: string;
    try {
      text = await download(b.downloadUrl ?? b.url);
    } catch (e) {
      failed.push(`${b.pathname}: ${(e as Error).message}`);
      return null;
    }
    try {
      return JSON.parse(decrypt(text)) as Stored;
    } catch {
      console.warn(`[waitlist] skipping ${b.pathname}: not a readable entry`);
      return null;
    }
  });
  if (failed.length) {
    throw new Error(`could not download ${failed.length} of ${blobs.length} waitlist entries (${failed.slice(0, 3).join("; ")})`);
  }
  const rows = results.filter((r): r is Stored => r !== null);
  return rows.sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
}

/** Writes one encrypted file holding every stored entry (not deduplicated). Returns the entry count. */
export async function writeSnapshot(): Promise<{ count: number; pathname: string }> {
  const entries = await loadEntries();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const { pathname } = await put(`${SNAPSHOT_PREFIX}${stamp}.enc`, encrypt(JSON.stringify(entries)), {
    access: "public",
    contentType: "text/plain",
    addRandomSuffix: true,
  });
  return { count: entries.length, pathname };
}

/** Entries from the newest snapshot, for recovery if live entries are lost. */
export async function loadLatestSnapshot(): Promise<{ entries: Stored[]; pathname: string } | null> {
  const snaps = (await listAll(SNAPSHOT_PREFIX)).sort((a, b) => b.pathname.localeCompare(a.pathname));
  if (!snaps.length) return null;
  const text = await download(snaps[0].downloadUrl ?? snaps[0].url);
  return { entries: JSON.parse(decrypt(text)) as Stored[], pathname: snaps[0].pathname };
}
