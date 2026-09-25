/** Shared shape and validation for waitlist submissions (client and server). */

export const ALLOCATIONS = ["Under $100", "$100 – $1,000", "$1,000 – $10,000", "Over $10,000", "Not sure yet"] as const;
export const TRUST_FACTORS = [
  "Track record",
  "Agent posts a bond",
  "Capital protection",
  "Transparent strategy",
  "On-chain history",
] as const;
export const YES_NO = ["Yes", "No"] as const;
export const YES_NO_MAYBE = ["Yes", "No", "Maybe"] as const;

export type Submission = {
  name: string;
  email: string;
  telegram: string;
  location: string;
  wallet: string;
  tradesCrypto: (typeof YES_NO)[number] | "";
  usedAgents: (typeof YES_NO)[number] | "";
  wouldTrust: (typeof YES_NO_MAYBE)[number] | "";
  allocation: (typeof ALLOCATIONS)[number] | "";
  trustFactors: (typeof TRUST_FACTORS)[number][];
  collateralHelps: (typeof YES_NO_MAYBE)[number] | "";
  testDevnet: (typeof YES_NO)[number] | "";
  notes: string;
};

export const EMPTY: Submission = {
  name: "",
  email: "",
  telegram: "",
  location: "",
  wallet: "",
  tradesCrypto: "",
  usedAgents: "",
  wouldTrust: "",
  allocation: "",
  trustFactors: [],
  collateralHelps: "",
  testDevnet: "",
  notes: "",
};

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Longest accepted value per free-text field. Longer input is rejected, not truncated. */
export const MAX_LEN = { name: 80, email: 120, telegram: 64, location: 80, wallet: 64, notes: 1000 } as const;
const LABEL: Record<keyof typeof MAX_LEN, string> = {
  name: "Name", email: "Email", telegram: "Telegram handle", location: "Location", wallet: "Wallet address", notes: "Notes",
};

/** Problems with the raw request body's field lengths and types, before normalizing. */
export function lengthProblems(raw: unknown): string[] {
  if (!raw || typeof raw !== "object") return [];
  const r = raw as Record<string, unknown>;
  const out: string[] = [];
  for (const k of Object.keys(MAX_LEN) as (keyof typeof MAX_LEN)[]) {
    const v = r[k];
    if (v === undefined || v === null) continue;
    if (typeof v !== "string") out.push(`${LABEL[k]} must be text.`);
    else if (v.trim().length > MAX_LEN[k]) out.push(`${LABEL[k]} is too long (max ${MAX_LEN[k]} characters).`);
  }
  if (r.trustFactors !== undefined && (!Array.isArray(r.trustFactors) || r.trustFactors.length > TRUST_FACTORS.length)) {
    out.push("Invalid trust factors.");
  }
  return out;
}

/** Returns a list of problems; empty means valid. */
export function validate(s: Submission): string[] {
  const out: string[] = [];
  if (!s.name.trim()) out.push("Name is required.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.email.trim())) out.push("Enter a valid email.");
  if (!s.telegram.trim()) out.push("Telegram handle is required.");
  if (!s.wallet.trim()) out.push("Solana wallet address is required.");
  else if (!BASE58.test(s.wallet.trim())) out.push("Wallet address doesn't look like a Solana address.");
  if (!s.wouldTrust) out.push("Tell us whether you'd trust an agent to trade for you.");
  if (!s.allocation) out.push("Pick a rough allocation.");
  for (const k of Object.keys(MAX_LEN) as (keyof typeof MAX_LEN)[]) {
    if (s[k].length > MAX_LEN[k]) out.push(`${LABEL[k]} is too long (max ${MAX_LEN[k]} characters).`);
  }
  return out;
}

/** Trims and whitelists values so nothing unexpected is stored. */
export function normalize(raw: unknown): Submission | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const str = (k: string, max = 200) => (typeof r[k] === "string" ? (r[k] as string).trim().slice(0, max) : "");
  const pick = <T extends readonly string[]>(k: string, list: T) =>
    (list.includes(str(k)) ? str(k) : "") as T[number] | "";
  const factors = Array.isArray(r.trustFactors)
    ? (r.trustFactors.filter((f): f is (typeof TRUST_FACTORS)[number] => TRUST_FACTORS.includes(f as never)))
    : [];
  return {
    name: str("name", MAX_LEN.name),
    email: str("email", MAX_LEN.email).toLowerCase(),
    telegram: str("telegram", MAX_LEN.telegram).replace(/^@/, ""),
    location: str("location", MAX_LEN.location),
    wallet: str("wallet", MAX_LEN.wallet),
    tradesCrypto: pick("tradesCrypto", YES_NO),
    usedAgents: pick("usedAgents", YES_NO),
    wouldTrust: pick("wouldTrust", YES_NO_MAYBE),
    allocation: pick("allocation", ALLOCATIONS),
    trustFactors: [...new Set(factors)],
    collateralHelps: pick("collateralHelps", YES_NO_MAYBE),
    testDevnet: pick("testDevnet", YES_NO),
    notes: str("notes", MAX_LEN.notes),
  };
}
