// One authority for the numbers both programs print: leaderboard.md is
// generated from these, and the dashboard reads the same figures, live and
// historical, through the same functions — so a run's cost or duration can
// never read differently in the two places.
//
// Free of `node:` imports, like everything else in shared/ — see
// vocabulary.ts for what a stray one costs the browser bundle.

function trimZero(text: string): string {
  return text.replace(/\.0$/, "");
}

/** Under 1000 verbatim; K/M above that, so the column stays narrow at any scale. */
export function tokens(value: number): string {
  const count = Math.round(value);
  if (count < 1_000) return String(count);
  if (count < 1_000_000) return `${trimZero((count / 1_000).toFixed(1))}K`;
  return `${trimZero((count / 1_000_000).toFixed(1))}M`;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** Drops the smaller unit once a bigger one is in play: "1h02m", never "1h02m03s". */
export function duration(ms: number): string {
  const totalSeconds = Math.round(ms / 1_000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  if (totalSeconds < 3_600) return `${Math.floor(totalSeconds / 60)}m${pad2(totalSeconds % 60)}s`;
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  return `${hours}h${pad2(minutes)}m`;
}

/** null is a cost nobody knows, which is not the same as free, so it never prints as a number. */
export function usd(value: number | null): string {
  return value === null ? "—" : `$${value.toFixed(4)}`;
}
