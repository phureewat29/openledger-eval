import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { modelSlug } from "../config.js";
import { tryExecute, type Result } from "../core/result.js";
import type { Benchmark } from "./benchmark.js";
import { runFileStem, type RunRecord, type TerminalState } from "./record.js";

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** Local time to the minute: the directory name is what an operator reads back. */
export function timestampSlug(date: Date): string {
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    `${pad(date.getHours())}${pad(date.getMinutes())}`,
  ].join("-");
}

export function createReportDir(reportsRoot: string, startedAt: Date): Result<string> {
  const dir = join(reportsRoot, timestampSlug(startedAt));
  const made = tryExecute(() => mkdirSync(dir, { recursive: true }));
  if (!made.ok) return { ok: false, error: `cannot create ${dir}: ${made.error}` };
  return { ok: true, value: dir };
}

/** The benchmark an existing report already holds, which is what a merge measures itself against. */
export function readBenchmark(reportDir: string): Result<Benchmark> {
  const path = join(reportDir, "benchmark.json");
  const text = tryExecute(() => readFileSync(path, "utf8"));
  if (!text.ok) return { ok: false, error: `cannot read ${path}: ${text.error}` };

  const json = tryExecute(() => JSON.parse(text.value) as Benchmark);
  if (!json.ok) return { ok: false, error: `${path} is not JSON: ${json.error}` };
  return json;
}

/**
 * Where this invocation writes: a new directory of its own, or an existing
 * iteration named by --into. Merging demands a report that has already been
 * scored, because its benchmark is where the identity a merge must match is
 * pinned — an unscored directory has nothing to hold a rerun to.
 */
export function resolveReportDir(
  reportsRoot: string,
  startedAt: Date,
  into: string | null,
): Result<{ dir: string; prior: Benchmark | null }> {
  if (into === null) {
    const dir = createReportDir(reportsRoot, startedAt);
    return dir.ok ? { ok: true, value: { dir: dir.value, prior: null } } : dir;
  }

  const dir = join(reportsRoot, into);
  if (!existsSync(dir)) return { ok: false, error: `no iteration ${into} under ${reportsRoot}` };

  const prior = readBenchmark(dir);
  if (!prior.ok) return { ok: false, error: `cannot merge into ${into}: ${prior.error}` };
  return { ok: true, value: { dir, prior: prior.value } };
}

function writeJson(path: string, value: unknown): Result<string> {
  const written = tryExecute(() => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  });
  if (!written.ok) return { ok: false, error: `cannot write ${path}: ${written.error}` };
  return { ok: true, value: path };
}

function writeText(path: string, text: string): Result<string> {
  const written = tryExecute(() => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${text}\n`);
  });
  if (!written.ok) return { ok: false, error: `cannot write ${path}: ${written.error}` };
  return { ok: true, value: path };
}

/** Writes the record's .json beside a rendered .md of the same stem. */
export function writeRunFiles(
  reportDir: string,
  record: RunRecord,
  trials: number,
): Result<string> {
  const file = runFileStem(record.caseId, record.trial, trials);
  const stem = join(reportDir, "runs", modelSlug(record.model), record.suite, file);

  // The record is the whole of what a run leaves. A rendered markdown copy sat
  // beside it for a while, but every fact in it was already here and nothing
  // committed it, so it was one more file to write and keep in step.
  return writeJson(`${stem}.json`, record);
}

const NO_STATES: Record<TerminalState, number> = {
  graded: 0,
  endpoint_error: 0,
  sandbox_error: 0,
};

export function tallyStates(records: RunRecord[]): Record<TerminalState, number> {
  const states = { ...NO_STATES };
  for (const record of records) states[record.state] += 1;
  return states;
}

export function writeBenchmark(reportDir: string, benchmark: Benchmark): Result<string> {
  return writeJson(join(reportDir, "benchmark.json"), benchmark);
}

export function writeLeaderboard(reportDir: string, markdown: string): Result<string> {
  return writeText(join(reportDir, "leaderboard.md"), markdown);
}
