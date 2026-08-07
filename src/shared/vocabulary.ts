import type { LiveItemState } from "../report/live.js";

// The words and marks a run's states are shown in, and the rule for turning a
// model id into a path segment. Both programs need these, so they live where
// both can reach them.
//
// This file must stay free of `node:` imports and of any value import that
// reaches one. It is bundled into the browser, where a single `node:fs` in the
// graph is a white screen — and `vite build` exits 0 on it, so nothing catches
// that but running the page. `import type` is erased and is always safe.

export const LIVE_STATES: LiveItemState[] = [
  "pending",
  "running",
  "graded",
  "endpoint_error",
  "sandbox_error",
];

export const TERMINAL_STATES: LiveItemState[] = ["graded", "endpoint_error", "sandbox_error"];

/** What a reader is told a state means. The raw names live on as data, never as prose. */
export const STATE_LEGEND: Record<LiveItemState, { label: string; meaning: string }> = {
  pending: { label: "Waiting", meaning: "Not started yet" },
  running: { label: "In flight", meaning: "The model is working on it now" },
  graded: { label: "Scored", meaning: "Finished and checked against the expected answer" },
  endpoint_error: { label: "Model error", meaning: "The model's API failed, so it was not scored" },
  sandbox_error: { label: "Harness error", meaning: "Our setup failed, so it was not scored" },
};

export type GradeShade = "full" | "partial" | "empty";

/** passRate === null has nothing better to say yet, so it reads as a full pass rather than a failure. */
export function gradeShade(passRate: number | null): GradeShade {
  if (passRate === 0) return "empty";
  if (passRate !== null && passRate < 1) return "partial";
  return "full";
}

export const GRADE_GLYPH: Record<GradeShade, string> = { full: "█", partial: "▓", empty: "░" };

/** The grade lives in the shade, so the shades need saying out loud as much as the states do. */
export const GRADE_LEGEND: [GradeShade, string][] = [
  ["full", "Every check passed"],
  ["partial", "Some checks passed"],
  ["empty", "No check passed"],
];

/**
 * One token per live state; a graded token is shaded further by its own pass
 * rate. Used where a cell has no room for its counts — a tally, a legend — and
 * as the fallback for a record too old to carry them.
 */
export const STATE_GLYPH: Record<LiveItemState, (passRate: number | null) => string> = {
  pending: () => "·",
  running: () => "▸",
  graded: (passRate) => GRADE_GLYPH[gradeShade(passRate)],
  endpoint_error: () => "!",
  sandbox_error: () => "✕",
};

/**
 * `YYYY-MM-DD-HHmm`, the shape `timestampSlug` writes and the only directory
 * name under reports/ that names an iteration. One authority, because a slug
 * arrives from three directions — a URL path, a websocket param and `--into` —
 * and each of them joins it onto a path.
 */
export const ITERATION_SLUG_RE = /^\d{4}-\d{2}-\d{2}-\d{4}$/;

/**
 * A model id as a path segment. One-way and lossy on purpose — `a/b` and `a-b`
 * both land on `a-b` — so nothing ever tries to invert it: the real id is read
 * back from the run record, never from the directory name.
 */
export function modelSlug(model: string): string {
  return (
    model
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "model"
  );
}
