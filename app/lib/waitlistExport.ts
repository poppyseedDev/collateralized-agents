import { EMPTY, type Submission } from "./waitlist";
import type { Stored } from "./waitlistStore";

/**
 * Groups waitlist entries for the export. Emails are unverified, so the first submission per email
 * is the canonical row; later submissions that change anything are listed as updates, never applied.
 */

export type ExportRow = { entry: Stored; updates: Stored[] };

const FIELDS = (Object.keys(EMPTY) as (keyof Submission)[]).filter((k) => k !== "email");
const text = (v: unknown) => (Array.isArray(v) ? v.join(", ") : String(v ?? ""));

/** Fields where `b` differs from `a`, ignoring email case and metadata (id, time, user agent). */
export function changedFields(a: Stored, b: Stored): (keyof Submission)[] {
  return FIELDS.filter((k) => text(a[k]) !== text(b[k]));
}

/**
 * One row per email (case-insensitive), oldest first. The earliest submission is canonical;
 * later ones that differ from it, and from every earlier update, become `updates`.
 */
export function groupByEmail(rows: Stored[]): ExportRow[] {
  const sorted = [...rows].sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
  const groups = new Map<string, ExportRow>();
  for (const r of sorted) {
    const k = (r.email ?? "").trim().toLowerCase() || `id:${r.id}`;
    const g = groups.get(k);
    if (!g) groups.set(k, { entry: r, updates: [] });
    else if ([g.entry, ...g.updates].every((seen) => changedFields(seen, r).length > 0)) g.updates.push(r);
  }
  return [...groups.values()];
}

/** One-line summary of the updates for a CSV cell: `<time>: field=value; ... | <time>: ...`. */
export function describeUpdates({ entry, updates }: ExportRow): string {
  return updates
    .map((u) => `${u.submittedAt}: ${changedFields(entry, u).map((k) => `${k}=${text(u[k])}`).join("; ")}`)
    .join(" | ")
    .replace(/[\r\n]+/g, " "); // keep one line per row; the backup script counts lines
}
