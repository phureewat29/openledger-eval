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
