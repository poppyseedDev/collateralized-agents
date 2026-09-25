import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dir = process.env.STATE_DIR
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

export type AgentState = {
  books: Record<string, Book>;
  prices: number[];
  history: { position: string; principal: string; returned: string; at: number }[];
};

const empty = (): AgentState => ({ books: {}, prices: [], history: [] });

const parse = (path: string): AgentState => ({ ...empty(), ...JSON.parse(readFileSync(path, "utf8")) });

/**
 * Loads an agent's state. A file that does not parse is moved aside to
 * `<id>.json.corrupt-<ts>` and the last good copy (`<id>.json.bak`) is used
 * instead, so a bad write cannot crash-loop the runner.
 */
export function loadState(id: string): AgentState {
  const path = `${dir}${id}.json`;
  const bak = `${path}.bak`;
  if (!existsSync(path)) return empty();
  try {
    return parse(path);
  } catch (e) {
    const aside = `${path}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    renameSync(path, aside);
    console.error(`ALERT [${id}] state file did not parse (${(e as Error).message}); moved it to ${aside}`);
    if (existsSync(bak)) {
      try {
        const s = parse(bak);
        console.error(`ALERT [${id}] resuming from backup ${bak}; books may miss the last few changes, check the wallet`);
        return s;
      } catch (e2) {
        console.error(`ALERT [${id}] backup ${bak} did not parse either (${(e2 as Error).message})`);
      }
    }
    console.error(`ALERT [${id}] starting with empty books; trading positions will be re-adopted from chain`);
    return empty();
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
  mkdirSync(dir, { recursive: true });
  writeAtomic(`${dir}${id}.json`, JSON.stringify(s, null, 2));
}
