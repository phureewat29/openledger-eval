import { groupBy } from "es-toolkit";
import type { AssertionResult } from "../suites/types.js";
import type { RunRecord } from "./record.js";

// Why a model's cases failed, rather than how many did. A leaderboard row of
// 1/11 says nothing about what the other ten runs missed; this names it.

export interface FailureCount {
  id: string;
  label: string;
  /** Runs in which that check failed. */
  runs: number;
}

/** An `na` check had nothing to judge, so it is not a failure and never counts as one. */
function failedChecks(record: RunRecord): AssertionResult[] {
  return (record.grade?.assertions ?? []).filter((check) => !check.passed && check.na !== true);
}

/**
 * The checks that failed in the most runs, worst first and capped at `limit`.
 * A grade carries each check id once, so a run counts once per check it failed.
 */
export function topFailures(records: RunRecord[], limit: number): FailureCount[] {
  const failed = records.flatMap(failedChecks);
  return Object.entries(groupBy(failed, (check) => check.id))
    .map(([id, checks]) => ({ id, label: checks[0]?.label ?? id, runs: checks.length }))
    .toSorted((a, b) => b.runs - a.runs || a.id.localeCompare(b.id))
    .slice(0, limit);
}
