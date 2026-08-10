import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { readJsonFile } from "../core/fs.js";
import { tryExecute, type Result } from "../core/result.js";
import type { Benchmark } from "../report/benchmark.js";
import type { LiveDoc } from "../report/live.js";
import { readRecordFile } from "../report/read.js";
import { summarise, type RunRecord, type RunSummary } from "../report/record.js";
import { isVersionOne } from "../report/schema.js";
import { readBenchmarkFile } from "../report/write.js";
import { parseFeedLine, type FeedLine } from "../shared/feed.js";
import { BENCHMARK_FILE, FEED_FILE, LIVE_FILE, RUNS_DIR } from "../shared/paths.js";
import { ITERATION_SLUG_RE } from "../shared/vocabulary.js";

// Every read the dashboard makes, fresh per request: no cache, no watcher. A
// reports tree is written by another process and edited by hand, so each read
// returns a Result and a half-written directory can never take the server down.

export interface IterationSummary {
  slug: string;
  hasBenchmark: boolean;
  hasLive: boolean;
}

export interface LiveSnapshot {
  slug: string;
  doc: LiveDoc;
}

/** `model` is the directory name (a model slug), which is also what the run URL carries. */
export interface RunGroup {
  model: string;
  suite: string;
  stems: string[];
}

/** `archive/` and any hand-made directory fail this, so neither can ever be addressed as an iteration. */
function isIterationSlug(name: string): boolean {
  return ITERATION_SLUG_RE.test(name);
}

function readEntries(dir: string): Result<Dirent[]> {
  const entries = tryExecute(() => readdirSync(dir, { withFileTypes: true }));
  if (!entries.ok) return { ok: false, error: `cannot read ${dir}: ${entries.error}` };
  return { ok: true, value: entries.value };
}

function subdirs(dir: string): Result<string[]> {
  const entries = readEntries(dir);
  if (!entries.ok) return entries;
  const names = entries.value.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  return { ok: true, value: names.toSorted() };
}

function summarize(reportsRoot: string, slug: string): IterationSummary {
  const dir = join(reportsRoot, slug);
  return {
    slug,
    hasBenchmark: existsSync(join(dir, BENCHMARK_FILE)),
    hasLive: existsSync(join(dir, LIVE_FILE)),
  };
}

/** Newest first: the slug sorts chronologically, so a plain reverse string sort is the ordering. */
export function listIterations(reportsRoot: string): Result<IterationSummary[]> {
  if (!existsSync(reportsRoot)) return { ok: true, value: [] };

  const names = subdirs(reportsRoot);
  if (!names.ok) return names;

  const slugs = names.value.filter(isIterationSlug).toSorted((a, b) => b.localeCompare(a));
  return { ok: true, value: slugs.map((slug) => summarize(reportsRoot, slug)) };
}

export function findIteration(reportsRoot: string, slug: string): Result<IterationSummary | null> {
  const iterations = listIterations(reportsRoot);
  if (!iterations.ok) return iterations;
  return { ok: true, value: iterations.value.find((iteration) => iteration.slug === slug) ?? null };
}

/**
 * `schemaVersion` is the whole contract: a v1 document may carry fields this
 * build never heard of, and the guard admits it so renderers read only the
 * fields they know. This cast is the one place a document's shape is
 * trusted; nothing downstream re-validates.
 */
function readDoc<T>(reportsRoot: string, slug: string, file: string): Result<T> {
  if (!isIterationSlug(slug)) return { ok: false, error: `not an iteration: ${slug}` };

  const path = join(reportsRoot, slug, file);
  const json = readJsonFile(path);
  if (!json.ok) return json;

  if (!isVersionOne(json.value)) return { ok: false, error: `${path}: not a schemaVersion 1 document` };
  return { ok: true, value: json.value as T };
}

export function readBenchmark(reportsRoot: string, slug: string): Result<Benchmark> {
  if (!isIterationSlug(slug)) return { ok: false, error: `not an iteration: ${slug}` };
  return readBenchmarkFile(join(reportsRoot, slug, BENCHMARK_FILE));
}

export function readLive(reportsRoot: string, slug: string): Result<LiveDoc> {
  return readDoc<LiveDoc>(reportsRoot, slug, LIVE_FILE);
}

/**
 * null when no iteration has a live.json at all, or the newest one could not
 * be read — both read as the live panel's "no runs yet" state.
 */
export function newestLive(reportsRoot: string): LiveSnapshot | null {
  const iterations = listIterations(reportsRoot);
  if (!iterations.ok) return null;

  const newest = iterations.value.find((iteration) => iteration.hasLive);
  if (!newest) return null;

  const doc = readLive(reportsRoot, newest.slug);
  return doc.ok ? { slug: newest.slug, doc: doc.value } : null;
}

/** More lines than any page shows, and a bounded read whatever a long matrix appended. */
const FEED_TAIL_BYTES = 64 * 1_024;

/** `fromStart` is false when bytes were skipped, which is what makes the first line suspect. */
interface Tail {
  text: string;
  fromStart: boolean;
}

/** fstat on the open descriptor, so the size read from and the bytes read are the same file. */
function readTail(path: string, maxBytes: number): Result<Tail> {
  const read = tryExecute(() => {
    const fd = openSync(path, "r");
    try {
      const { size } = fstatSync(fd);
      if (size === 0) return { text: "", fromStart: true };

      const offset = Math.max(0, size - maxBytes);
      const buffer = Buffer.alloc(size - offset);
      const bytes = readSync(fd, buffer, 0, buffer.length, offset);
      return { text: buffer.subarray(0, bytes).toString("utf8"), fromStart: offset === 0 };
    } finally {
      closeSync(fd);
    }
  });
  if (!read.ok) return { ok: false, error: `cannot read ${path}: ${read.error}` };
  return read;
}

/**
 * The last `maxLines` of one iteration's feed, oldest first. A missing file is an
 * empty feed and not an error: a run that has not written its first line, and
 * every report directory from before the feed existed, both look like this.
 */
export function readFeedTail(reportsRoot: string, slug: string, maxLines: number): Result<FeedLine[]> {
  if (!isIterationSlug(slug)) return { ok: false, error: `not an iteration: ${slug}` };

  const path = join(reportsRoot, slug, FEED_FILE);
  if (!existsSync(path)) return { ok: true, value: [] };

  const tail = readTail(path, FEED_TAIL_BYTES);
  if (!tail.ok) return tail;

  // A read that began mid-file began mid-line: the parse would drop that line
  // anyway, and dropping it here is the reason rather than the accident.
  const lines = tail.value.text.split("\n");
  const whole = tail.value.fromStart ? lines : lines.slice(1);
  const parsed = whole.map(parseFeedLine).filter((line) => line !== null);
  return { ok: true, value: parsed.slice(-maxLines) };
}

/** One group per model and suite that actually left markdown behind; an iteration with no runs yields none. */
export function listRunFiles(reportsRoot: string, slug: string): Result<RunGroup[]> {
  if (!isIterationSlug(slug)) return { ok: false, error: `not an iteration: ${slug}` };

  const runsDir = join(reportsRoot, slug, RUNS_DIR);
  if (!existsSync(runsDir)) return { ok: true, value: [] };

  const models = subdirs(runsDir);
  if (!models.ok) return models;

  const groups: RunGroup[] = [];
  for (const model of models.value) {
    const suites = subdirs(join(runsDir, model));
    if (!suites.ok) return suites;

    for (const suite of suites.value) {
      const files = readEntries(join(runsDir, model, suite));
      if (!files.ok) return files;

      // Discovered by the .json rather than the .md beside it: the record is the
      // richer of the two and the only one a run is required to leave. The
      // markdown is a convenience that is on its way out, and globbing it would
      // make every run vanish from this listing the day it stops being written.
      const stems = files.value
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => entry.name.slice(0, -".json".length))
        .toSorted();
      if (stems.length > 0) groups.push({ model, suite, stems });
    }
  }
  return { ok: true, value: groups };
}

/**
 * Admits `name` only when readdir of `dir` returned exactly that entry, and
 * joins the string readdir gave back. URL input is compared, never joined, so
 * no encoding of `..` or a separator can reach the filesystem.
 */
function childOf(dir: string, name: string): Result<string> {
  const entries = readEntries(dir);
  if (!entries.ok) return entries;

  const match = entries.value.find((entry) => entry.name === name);
  if (!match) return { ok: false, error: `no ${name} under ${dir}` };
  return { ok: true, value: join(dir, match.name) };
}

/** Every name in the path is checked against readdir, one level at a time. */
function resolveRunFile(
  reportsRoot: string,
  slug: string,
  model: string,
  suite: string,
  file: string,
): Result<string> {
  if (!isIterationSlug(slug)) return { ok: false, error: `not an iteration: ${slug}` };

  const modelDir = childOf(join(reportsRoot, slug, RUNS_DIR), model);
  if (!modelDir.ok) return modelDir;

  const suiteDir = childOf(modelDir.value, suite);
  if (!suiteDir.ok) return suiteDir;

  return childOf(suiteDir.value, file);
}

/** The record behind one run file, transcript included; the sheet for one open run is its only reader. */
export function readRunRecord(
  reportsRoot: string,
  slug: string,
  model: string,
  suite: string,
  stem: string,
): Result<RunRecord> {
  const path = resolveRunFile(reportsRoot, slug, model, suite, `${stem}.json`);
  if (!path.ok) return path;
  return readRecordFile(path.value);
}

/** One run file, with the record behind it when it could be read. */
export interface LoadedRun extends Omit<RunGroup, "stems"> {
  stem: string;
  /** null when the .json is missing or unreadable. */
  record: RunSummary | null;
}

/**
 * Every run file of one iteration, transcripts left behind: carrying every
 * event here would make this the heaviest response the server sends, and none
 * of a grid, a leaderboard or a failure tally look at one. The sheet for a
 * single open run reads its events through `readRunRecord`.
 *
 * An unreadable record is carried as null rather than dropped: the run happened,
 * and its cell must still lead to whatever the run left behind.
 */
export function listRunRecords(reportsRoot: string, slug: string): Result<LoadedRun[]> {
  const groups = listRunFiles(reportsRoot, slug);
  if (!groups.ok) return groups;

  const runs = groups.value.flatMap((group) =>
    group.stems.map((stem) => {
      const record = readRunRecord(reportsRoot, slug, group.model, group.suite, stem);
      return {
        model: group.model,
        suite: group.suite,
        stem,
        record: record.ok ? summarise(record.value) : null,
      };
    }),
  );
  return { ok: true, value: runs };
}
