import { readdirSync } from "node:fs";
import { join } from "node:path";
import { readJsonFile } from "../core/fs.js";
import { tryExecute, type Result } from "../core/result.js";
import { RUNS_DIR } from "../shared/paths.js";
import type { RunRecord } from "./record.js";

// Reading back what a report left on disk. The runner needs this to merge a
// rerun into an iteration it did not itself produce, and the dashboard needs it
// to render one; both go through the same guard, so a record either program
// trusts is a record the other trusts too.

/**
 * A run's .json is a RunRecord and carries no schemaVersion to trust, so the
 * guard is structural: the fields every reader takes without asking first.
 */
export function isRunRecord(value: unknown): value is RunRecord {
  if (typeof value !== "object" || value === null) return false;
  const { model, suite, caseId, state, metrics, events } = value as Partial<RunRecord>;
  return (
    typeof model === "string" &&
    typeof suite === "string" &&
    typeof caseId === "string" &&
    typeof state === "string" &&
    typeof metrics === "object" &&
    metrics !== null &&
    Array.isArray(events)
  );
}

export function readRecordFile(path: string): Result<RunRecord> {
  const json = readJsonFile(path);
  if (!json.ok) return json;

  if (!isRunRecord(json.value)) return { ok: false, error: `${path}: not a run record` };
  return { ok: true, value: json.value };
}

/**
 * `unreadable` rather than a silent drop. These records are about to be merged
 * into a benchmark, and a file this cannot parse is a paid run that would leave
 * the leaderboard without anyone noticing it had gone.
 */
export interface ReportRecords {
  records: RunRecord[];
  unreadable: string[];
}

function jsonFilesUnder(dir: string): string[] {
  const entries = tryExecute(() => readdirSync(dir, { withFileTypes: true }));
  if (!entries.ok) return [];
  return entries.value.flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return jsonFilesUnder(path);
    return entry.isFile() && entry.name.endsWith(".json") ? [path] : [];
  });
}

/**
 * Every run record an existing report holds, found by walking runs/ rather than
 * by replanning it: a report is the authority on what it contains, and a plan
 * built from today's flags knows nothing about the cells it is merging beside.
 */
export function readReportRecords(reportDir: string): ReportRecords {
  const records: RunRecord[] = [];
  const unreadable: string[] = [];
  for (const path of jsonFilesUnder(join(reportDir, RUNS_DIR))) {
    const record = readRecordFile(path);
    if (record.ok) records.push(record.value);
    else unreadable.push(record.error);
  }
  return { records, unreadable };
}
