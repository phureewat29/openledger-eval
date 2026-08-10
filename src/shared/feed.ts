import { tryExecute } from "../core/result.js";

// What a line of feed.ndjson is, and how to read one back. report/feed.ts
// writes these; reports-fs.ts and feed-tail.ts both parse them, one line at a
// time, from a file that is appended to while it is being read.
//
// Free of `node:` imports, like everything else in shared/ — see
// vocabulary.ts for what a stray one costs the browser bundle.

/** A list as well as a type, because the reader has to recognise a kind at runtime. */
export const FEED_KINDS = ["header", "run", "phase", "tool", "says", "note", "result"] as const;

export type FeedKind = (typeof FEED_KINDS)[number];

export interface FeedLine {
  at: string;
  /** Which cell is speaking: short model name, case id, and the trial past the first. */
  scope: string;
  kind: FeedKind;
  text: string;
}

function isFeedKind(value: unknown): value is FeedKind {
  return typeof value === "string" && (FEED_KINDS as readonly string[]).includes(value);
}

/**
 * Written by our own writer, but this file is also hand-edited and read while it
 * is being appended to, so a line reaches a renderer only once every field it
 * renders is known to be a string.
 */
export function parseFeedLine(line: string): FeedLine | null {
  const parsed = tryExecute(() => JSON.parse(line) as unknown);
  if (!parsed.ok || typeof parsed.value !== "object" || parsed.value === null) return null;

  const { at, scope, kind, text } = parsed.value as Record<string, unknown>;
  if (typeof at !== "string" || typeof scope !== "string" || typeof text !== "string") return null;
  return isFeedKind(kind) ? { at, scope, kind, text } : null;
}
