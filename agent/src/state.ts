import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const stateDir = process.env.STATE_DIR
  ? `${process.env.STATE_DIR.replace(/\/$/, "")}/`
  : fileURLToPath(new URL("../state/", import.meta.url));

/** A swap that was signed and may have been sent, but whose result is not in the book yet. */
export type PendingSwap = {
  sig: string;
  lastValidBlockHeight: number;
  side: "SOL" | "USDC";
  in: string;
  pool: string;
  at: number;
  /** Count a strategy cycle once this swap lands. */
  bumpCycle?: boolean;
};

/**
 * Per-position book: the agent's wallet mixes its own SOL with every trader's
 * principal, so each position tracks the SOL and USDC that belong to it.
 */
export type Book = {
  principal: string;
  sol: string;
  usdc: string;
  drawnAt: number;
  settleAt: number;
  deadline: number;
  cycles: number;
  trades: { at: number; side: "SOL->USDC" | "USDC->SOL"; in: string; out: string; pool: string; sig: string }[];
  /** Set before a swap is sent, cleared once it has landed (and been booked) or can no longer land. */
  pending?: PendingSwap | null;
};

/** A main-pool price and when it was read (cluster seconds). */
export type PriceSample = { at: number; price: number };

export type AgentState = {
  books: Record<string, Book>;
  prices: PriceSample[];
  history: { position: string; principal: string; returned: string; at: number }[];
};

const empty = (): AgentState => ({ books: {}, prices: [], history: [] });

function parse(path: string): AgentState {
  const s: AgentState = { ...empty(), ...JSON.parse(readFileSync(path, "utf8")) };
  // Samples saved before they carried a time are plain numbers: load them as stale.
  s.prices = s.prices.map((p: PriceSample | number) => (typeof p === "number" ? { at: 0, price: p } : p));
  return s;
}

export const loadState = (id: string): AgentState => loadStateFrom(id).state;

/**
 * Loads an agent's state. A file that does not parse is moved aside to
 * `<id>.json.corrupt-<ts>` and the last good copy (`<id>.json.bak`) is used
 * instead, so a bad write cannot crash-loop the runner. `fromBackup` says the
 * backup was used: it is one save behind, so it can miss a swap.
 */
export function loadStateFrom(id: string): { state: AgentState; fromBackup: boolean } {
  const path = `${stateDir}${id}.json`;
  const bak = `${path}.bak`;
  if (!existsSync(path)) return { state: empty(), fromBackup: false };
  try {
    return { state: parse(path), fromBackup: false };
  } catch (e) {
    const aside = `${path}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    renameSync(path, aside);
    console.error(`ALERT [${id}] state file did not parse (${(e as Error).message}); moved it to ${aside}`);
    if (existsSync(bak)) {
      try {
        const s = parse(bak);
        console.error(`ALERT [${id}] resuming from backup ${bak}; books may miss the last few changes, check the wallet`);
        return { state: s, fromBackup: true };
      } catch (e2) {
        console.error(`ALERT [${id}] backup ${bak} did not parse either (${(e2 as Error).message})`);
      }
    }
    console.error(`ALERT [${id}] starting with empty books; trading positions will be re-adopted from chain`);
    return { state: empty(), fromBackup: false };
  }
}

/** Writes to a temp file, fsyncs, keeps the previous version as `.bak`, then renames over the original. */
export function writeAtomic(path: string, data: string) {
  const tmp = `${path}.tmp-${process.pid}`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (existsSync(path)) copyFileSync(path, `${path}.bak`);
  renameSync(tmp, path);
}

export function saveState(id: string, s: AgentState) {
  mkdirSync(stateDir, { recursive: true });
  writeAtomic(`${stateDir}${id}.json`, JSON.stringify(s, null, 2));
}
