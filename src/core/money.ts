/**
 * Money crosses every boundary as a decimal JSON number — `12.50` reads back as
 * `12.5`, and `0.1 + 0.2` is not `0.3` — so amounts are only ever compared as
 * integer minor units. Two decimal places, which holds for every ledger the
 * suites open.
 */
export function minorUnits(amount: number): number {
  return Math.round(amount * 100);
}

export function majorUnits(minor: number): number {
  return Number((minor / 100).toFixed(2));
}

/** The one display rule for a major-units amount: always two decimals. */
export function money(amount: number): string {
  return amount.toFixed(2);
}

/** A total the model reproduces to the cent, unless a caller states its own tolerance. */
export const MONEY_TOLERANCE = 0.01;

/** Compares in minor units, so `0.1 + 0.2` never fails to meet `0.3`. */
export function moneyMatches(got: number, want: number, tolerance = MONEY_TOLERANCE): boolean {
  return Math.abs(minorUnits(got) - minorUnits(want)) <= minorUnits(tolerance);
}
