/**
 * SOL amount helpers for form inputs. Pure and locale-independent: `<input type="number">` values
 * always use "." as the decimal separator, whatever the user's locale.
 */

import { BN } from "@coral-xyz/anchor";

const LAMPORTS_PER_SOL = 1_000_000_000;

/**
 * A lamport amount as a u64 instruction argument. Throws on negative, fractional or unsafe
 * values: borsh's u64 encoder drops the sign, so -0.5 SOL would be sent as 0.5 SOL.
 */
export function u64(lamports: number): BN {
  if (!Number.isSafeInteger(lamports) || lamports < 0) throw new Error(`Invalid amount: ${lamports} lamports`);
  return new BN(lamports);
}

/** SOL to lamports, rounded to the nearest lamport. */
export const toLamports = (solAmount: number) => Math.round(solAmount * LAMPORTS_PER_SOL);

/** The lamports typed into an amount input, or 0 when it isn't a finite number. */
export function parseSolInput(text: string): number {
  const value = parseFloat(text);
  return toLamports(Number.isFinite(value) ? value : 0);
}

/**
 * The lamports typed into an amount input where 0 is a valid answer (like "SOL to return"),
 * or null when the text is empty, not a number, or negative. A u64 argument would silently
 * drop the sign of a negative amount.
 */
export function parseNonNegativeSolInput(text: string): number | null {
  if (!text.trim()) return null;
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0) return null;
  const lamports = toLamports(value);
  return Number.isSafeInteger(lamports) ? lamports : null;
}

/**
 * Lamports as an input value with `digits` decimals, rounded down so a "Max" button never
 * fills in more than is available.
 */
export function lamportsToInput(lamports: number, digits = 3): string {
  const step = LAMPORTS_PER_SOL / 10 ** digits;
  return (Math.floor(lamports / step) / 10 ** digits).toFixed(digits);
}
