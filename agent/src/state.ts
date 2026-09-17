import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("../state/", import.meta.url));

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
};

export type AgentState = {
  books: Record<string, Book>;
  prices: number[];
  history: { position: string; principal: string; returned: string; at: number }[];
};

const empty = (): AgentState => ({ books: {}, prices: [], history: [] });

export function loadState(id: string): AgentState {
  const path = `${dir}${id}.json`;
  if (!existsSync(path)) return empty();
  return { ...empty(), ...JSON.parse(readFileSync(path, "utf8")) };
}

export function saveState(id: string, s: AgentState) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}${id}.json`, JSON.stringify(s, null, 2));
}
