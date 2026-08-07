/**
 * oled's side of the contract: the exit codes its reporter uses, and the
 * flags the host appends to every call.
 */

/** Mirrors `EXIT` in oled's `src/cli/output.ts`. */
export const EXIT = {
  OK: 0,
  GENERIC: 1,
  USAGE: 2,
  NOT_READY: 3,
  INPUT_REQUIRED: 4,
  NOT_FOUND: 5,
  INVALID: 6,
  PARTIAL: 7,
} as const;

/** PARTIAL did some of the work: like OK, its output is there to be read. */
export function carriesOutput(exitCode: number | null): boolean {
  return exitCode === EXIT.OK || exitCode === EXIT.PARTIAL;
}

/** Appended to every call, so the model never has to ask for them. */
export const HOST_APPENDED_FLAGS = ["--json"];

/** Reverse lookup for diagnostics and reports: `exitName(2)` → `"USAGE"`. */
export function exitName(code: number): string {
  const entry = (Object.entries(EXIT) as [string, number][]).find(([, value]) => value === code);
  return entry ? entry[0] : `UNKNOWN(${code})`;
}
