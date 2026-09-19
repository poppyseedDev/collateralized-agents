import "server-only";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { list, put } from "@vercel/blob";
import type { Submission } from "./waitlist";

/** Server-side storage for waitlist entries: encrypted files in Vercel Blob, plus daily snapshots. */

export type Stored = Submission & { id: string; submittedAt: string; userAgent: string };

export const ENTRY_PREFIX = "waitlist/";
export const SNAPSHOT_PREFIX = "waitlist-snapshots/";

const cipherKey = () => {
  const secret = process.env.WAITLIST_ADMIN_KEY;
  if (!secret) throw new Error("WAITLIST_ADMIN_KEY is not set");
  return createHash("sha256").update(secret).digest();
};

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

export async function saveEntry(stored: Stored) {
  await put(`${ENTRY_PREFIX}${stored.submittedAt.slice(0, 10)}/${stored.id}.enc`, encrypt(JSON.stringify(stored)), {
    access: "public", // the store is public; contents are encrypted and the path is unguessable
    contentType: "text/plain",
    addRandomSuffix: true,
  });
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

/** Every live entry, oldest first. */
export async function loadEntries(): Promise<Stored[]> {
  const rows: Stored[] = [];
  for (const b of await listAll(ENTRY_PREFIX)) {
    const res = await fetch(b.downloadUrl ?? b.url, { cache: "no-store" });
    if (!res.ok) continue;
    try {
      rows.push(JSON.parse(decrypt(await res.text())) as Stored);
    } catch {
      // skip anything that isn't one of our encrypted entries
    }
  }
  return rows.sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
}

/** Writes one encrypted file holding every entry. Returns the entry count. */
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
  const res = await fetch(snaps[0].downloadUrl ?? snaps[0].url, { cache: "no-store" });
  return { entries: JSON.parse(decrypt(await res.text())) as Stored[], pathname: snaps[0].pathname };
}
