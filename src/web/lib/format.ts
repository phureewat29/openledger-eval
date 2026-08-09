import type { LiveDoc, LiveItem } from "../../report/live.js";
import { TERMINAL_STATES } from "../../shared/vocabulary.js";

// Every number the chrome prints. Kept apart from the components so the same
// figure reads the same way wherever it appears.

/** The shared list, not a copy of it: a fourth state added to the union must reach here too. */
function isTerminal(item: LiveItem): boolean {
  return TERMINAL_STATES.includes(item.state);
}

export function duration(ms: number): string {
  const total = Math.round(ms / 1_000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes === 0) return `${seconds}s`;
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return `${minutes}m${String(seconds).padStart(2, "0")}s`;
  return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}

export function tokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${Math.round(count / 1_000)}k`;
  return String(count);
}

export function usd(amount: number | null): string {
  return amount === null ? "—" : `$${amount.toFixed(2)}`;
}

export function bytes(count: number): string {
  if (count >= 1_000_000_000) return `${(count / 1_000_000_000).toFixed(1)} GB`;
  if (count >= 1_000_000) return `${Math.round(count / 1_000_000)} MB`;
  return `${Math.round(count / 1_000)} kB`;
}

/** The vendor prefix is the same for every model in a row; the name after it is not. */
export function shortModel(id: string): string {
  return id.slice(id.lastIndexOf("/") + 1);
}

export function progressOf(doc: LiveDoc | null): { done: number; total: number; percent: number } {
  const items = doc?.items ?? [];
  const done = items.filter(isTerminal).length;
  const percent = items.length === 0 ? 0 : Math.round((done / items.length) * 100);
  return { done, total: items.length, percent };
}

/** Elapsed since the run began, from the document's own clock rather than the reader's. */
export function elapsedOf(doc: LiveDoc | null, now: number): number {
  if (doc === null) return 0;
  const end = doc.status === "done" ? Date.parse(doc.updatedAt) : now;
  return Math.max(0, end - Date.parse(doc.startedAt));
}
