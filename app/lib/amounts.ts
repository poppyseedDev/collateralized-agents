/**
 * SOL amount helpers for form inputs. Pure and locale-independent: `<input type="number">` values
 * always use "." as the decimal separator, whatever the user's locale.
 */

const LAMPORTS_PER_SOL = 1_000_000_000;

/** SOL to lamports, rounded to the nearest lamport. */
export const toLamports = (solAmount: number) => Math.round(solAmount * LAMPORTS_PER_SOL);

/** The lamports typed into an amount input, or 0 when it isn't a finite number. */
export function parseSolInput(text: string): number {
  const value = parseFloat(text);
  return toLamports(Number.isFinite(value) ? value : 0);
}

/**
 * Lamports as an input value with `digits` decimals, rounded down so a "Max" button never
 * fills in more than is available.
 */
export function lamportsToInput(lamports: number, digits = 3): string {
  const step = LAMPORTS_PER_SOL / 10 ** digits;
  return (Math.floor(lamports / step) / 10 ** digits).toFixed(digits);
}
