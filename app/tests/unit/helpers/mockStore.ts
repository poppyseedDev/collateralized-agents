/**
 * Replaces lib/waitlistStore with an in-memory mock. Import it (after ./stubs) before any route
 * that uses the store; imports are hoisted, so the stub must live in its own module.
 */
import { stubFile } from "./stubs";
import type { Stored } from "@/lib/waitlistStore";

export const store = {
  configured: true,
  entries: [] as Stored[],
  snapshot: null as { entries: Stored[]; pathname: string } | null,
  saved: [] as Stored[],
  snapshots: 0,
  failSave: false,
  failLoad: false,
  reset() {
    Object.assign(this, { configured: true, entries: [], snapshot: null, saved: [], snapshots: 0, failSave: false, failLoad: false });
  },
};

stubFile("@/lib/waitlistStore", {
  storageConfigured: () => store.configured,
  saveEntry: async (s: Stored) => {
    if (store.failSave) throw new Error("blob down");
    store.saved.push(s);
  },
  loadEntries: async () => {
    if (store.failLoad) throw new Error("could not download 1 of 2 waitlist entries");
    return store.entries;
  },
  loadLatestSnapshot: async () => store.snapshot,
  dedupeByEmail: (rows: Stored[]) => rows,
  writeSnapshot: async () => {
    if (store.failLoad) throw new Error("could not download 1 of 2 waitlist entries");
    store.snapshots++;
    return { count: store.entries.length, pathname: "waitlist-snapshots/test.enc" };
  },
});
