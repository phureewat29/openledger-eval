import type { LiveDoc } from "../../report/live.js";
import { isTerminal } from "../../shared/vocabulary.js";

// The chrome's own helpers — figures shared/format.ts has no reason to know
// about, because nothing outside the dashboard ever prints them.

export function bytes(count: number): string {
  if (count >= 1_000_000_000) return `${(count / 1_000_000_000).toFixed(1)} GB`;
  if (count >= 1_000_000) return `${Math.round(count / 1_000_000)} MB`;
  return `${Math.round(count / 1_000)} kB`;
}

/** The vendor prefix is the same for every model in a row; the name after it is not. */
export function shortModel(id: string): string {
  return id.slice(id.lastIndexOf("/") + 1);
}

/** "1 run" / "2 runs" — every place that counts something out loud reads its plural from here. */
export function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export function progressOf(doc: LiveDoc | null): { done: number; total: number; percent: number } {
  const items = doc?.items ?? [];
  const done = items.filter((item) => isTerminal(item.state)).length;
  const percent = items.length === 0 ? 0 : Math.round((done / items.length) * 100);
  return { done, total: items.length, percent };
}

/** Elapsed since the run began, from the document's own clock rather than the reader's. */
export function elapsedOf(doc: LiveDoc | null, now: number): number {
  if (doc === null) return 0;
  const end = doc.status === "done" ? Date.parse(doc.updatedAt) : now;
  return Math.max(0, end - Date.parse(doc.startedAt));
}

/** How many cells are mid-flight, which is exactly what a freeze would catch. */
export function inFlight(doc: LiveDoc | null): number {
  return doc?.items.filter((item) => item.state === "running").length ?? 0;
}
