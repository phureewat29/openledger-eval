import type { SuiteId } from "../config.js";
import { countChecks } from "../suites/types.js";
import type { RunSummary, TerminalState } from "./record.js";

// What one cell of the matrix is, and the single way a finished run becomes one.
//
// Apart from live.ts because that file writes live.json and so imports node:fs,
// which the browser cannot follow. The grid is drawn from a run in flight and
// from a run on disk by the same component, and it could only be true that both
// mean the same thing by the two sharing this projection — which, until this
// module existed, they did not: the runner had one copy and the report page
// another, field for field.

export type LiveItemState = "pending" | "running" | TerminalState;

/** One plan cell's current status, addressed by (model, suite, caseId, trial). */
export interface LiveItem {
  model: string;
  suite: SuiteId;
  caseId: string;
  trial: number;
  state: LiveItemState;
  /** Set once state reaches "graded"; null before that and for the other terminal states. */
  passRate: number | null;
  /** Set once the item leaves "running"; null before that. */
  durationMs: number | null;
  /** Counted as countChecks counts, so a passed check means the same here as in a grade. */
  checksPassed?: number;
  checksTotal?: number;
}

export type ItemKey = Pick<LiveItem, "model" | "suite" | "caseId" | "trial">;

export function keyOfRecord(record: RunSummary): ItemKey {
  return { model: record.model, suite: record.suite, caseId: record.caseId, trial: record.trial };
}

export function isSameItem(item: ItemKey, key: ItemKey): boolean {
  return (
    item.model === key.model &&
    item.suite === key.suite &&
    item.caseId === key.caseId &&
    item.trial === key.trial
  );
}

export function pendingItem(key: ItemKey): LiveItem {
  return { ...key, state: "pending", passRate: null, durationMs: null };
}

/** Absent rather than zero when a run carried no grade: nothing was checked, and 0/0 reads as a score. */
function checkFields(record: RunSummary): Pick<LiveItem, "checksPassed" | "checksTotal"> {
  if (!record.grade) return {};
  const { passed, total } = countChecks(record.grade.assertions);
  return { checksPassed: passed, checksTotal: total };
}

/** A finished run as its cell draws it, wherever that cell is being drawn. */
export function liveItemOf(record: RunSummary): LiveItem {
  return {
    ...keyOfRecord(record),
    state: record.state,
    passRate: record.grade?.passRate ?? null,
    durationMs: record.metrics.durationMs,
    ...checkFields(record),
  };
}
