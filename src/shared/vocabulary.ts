import type { LiveItemState } from "../report/live-item.js";
import type { LiveStateKind } from "./payloads.js";

// The words and marks a run's states are shown in, the suites a run can
// select, and the rule for turning a model id into a path segment. Both
// programs need these, so they live where both can reach them.
//
// This file must stay free of `node:` imports and of any value import that
// reaches one. It is bundled into the browser, where a single `node:fs` in the
// graph is a white screen — and `vite build` exits 0 on it, so nothing catches
// that but running the page. `import type` is erased and is always safe.

/**
 * The one authority on which suites exist. src/suites/registry.test.ts is what
 * enforces that every id here has a runnable suite behind it.
 */
export type SuiteId = "ingest" | "record" | "query";

export const SUITE_IDS: SuiteId[] = ["ingest", "record", "query"];

/** The check a value crossing a boundary — a query string, a POST body — passes before it is trusted as one of these. */
export function isSuiteId(value: string): value is SuiteId {
  return (SUITE_IDS as string[]).includes(value);
}

export const TERMINAL_STATES: LiveItemState[] = ["graded", "endpoint_error", "sandbox_error"];

/** Finished one way or another — scored or failed — so there is nothing left to run for this cell. */
export function isTerminal(state: LiveItemState): boolean {
  return TERMINAL_STATES.includes(state);
}

/** What a reader is told a state means. The raw names live on as data, never as prose. */
export const STATE_LEGEND: Record<LiveItemState, { label: string; meaning: string }> = {
  pending: { label: "Waiting", meaning: "Not started yet" },
  running: { label: "In flight", meaning: "The model is working on it now" },
  graded: { label: "Scored", meaning: "Finished and checked against the expected answer" },
  endpoint_error: { label: "Model error", meaning: "The model's API failed, so it was not scored" },
  sandbox_error: { label: "Harness error", meaning: "Our setup failed, so it was not scored" },
};

/**
 * What a reader is told the whole run — not one cell of it — is doing. A chip
 * reads `.label`; a site writing its own sentence around the state stays free
 * to, since a full sentence and a chip's word are different enough asks that
 * forcing one template over both would read worse than either alone.
 */
export const RUN_STATE_LEGEND: Record<LiveStateKind, { label: string; meaning: string }> = {
  none: { label: "No runs yet", meaning: "Nothing has been launched" },
  starting: { label: "Starting", meaning: "Packing a workspace before the matrix begins" },
  failed: { label: "Launch failed", meaning: "The runner exited before anything could run" },
  "running-fresh": { label: "Running", meaning: "The matrix is in flight" },
  "running-paused": { label: "Paused", meaning: "Frozen where it stood, until resumed" },
  "running-stale": { label: "No heartbeat", meaning: "Stopped writing progress without finishing" },
  done: { label: "Finished", meaning: "The matrix ran to completion" },
};

export type GradeShade = "full" | "partial" | "empty";

/** passRate === null has nothing better to say yet, so it reads as a full pass rather than a failure. */
export function gradeShade(passRate: number | null): GradeShade {
  if (passRate === 0) return "empty";
  if (passRate !== null && passRate < 1) return "partial";
  return "full";
}

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
