import type { SuiteId } from "../config.js";
import type { Benchmark } from "../report/benchmark.js";
import { isRunningFresh, type LiveDoc } from "../report/live.js";
import { TERMINAL_STATES } from "../shared/vocabulary.js";
import { readBenchmark, readLive, type IterationSummary } from "./reports-fs.js";

// One line's worth of every iteration on disk, so the list of them can be read
// instead of merely navigated. A slug and a date say nothing about which run is
// worth opening; what a reader is actually scanning for is how big it was, how
// it went, and what it cost.

export type IterationStatus = "running" | "crashed" | "done" | "unknown";

export interface ModelScore {
  model: string;
  passRate: number;
}

export interface IterationDigest {
  slug: string;
  hasBenchmark: boolean;
  status: IterationStatus;
  startedAt: string | null;
  /** Wall time from the run's own clock; null while it is still going. */
  durationMs: number | null;
  suites: SuiteId[];
  models: number;
  runs: number;
  /** Runs that reached a terminal state, which while running is the progress. */
  finished: number;
  /** Mean over graded runs, 0..1; null when nothing has been scored. */
  meanPassRate: number | null;
  best: ModelScore | null;
  worst: ModelScore | null;
  costUsd: number | null;
}

/**
 * `hasBenchmark` outranks the document's own status. A run stopped with a signal
 * never reaches `finalize`, so its live.json says `running` for ever — but the
 * benchmark beside it proves the matrix got far enough to score itself.
 */
function statusOf(summary: IterationSummary, doc: LiveDoc | null, now: Date): IterationStatus {
  if (summary.hasBenchmark) return "done";
  if (doc === null) return "unknown";
  if (doc.status === "done") return "done";
  return isRunningFresh(doc, now) ? "running" : "crashed";
}

/** Per model rather than per entry: a model runs every suite, and a row is about the model. */
function scoresByModel(benchmark: Benchmark): ModelScore[] {
  const totals = new Map<string, { sum: number; count: number }>();
  for (const entry of benchmark.entries) {
    const held = totals.get(entry.model) ?? { sum: 0, count: 0 };
    totals.set(entry.model, { sum: held.sum + entry.meanPassRate, count: held.count + 1 });
  }
  return [...totals]
    .map(([model, { sum, count }]) => ({ model, passRate: sum / count }))
    .toSorted((a, b) => b.passRate - a.passRate);
}

/** null the moment one run's cost is unknown: a partial sum understates the bill silently. */
function costOf(benchmark: Benchmark): number | null {
  let total = 0;
  for (const entry of benchmark.entries) {
    if (entry.totalCostUsd === null) return null;
    total += entry.totalCostUsd;
  }
  return total;
}

function fromBenchmark(benchmark: Benchmark): Pick<
  IterationDigest,
  "suites" | "models" | "runs" | "finished" | "meanPassRate" | "best" | "worst" | "costUsd" | "startedAt"
> {
  const scores = scoresByModel(benchmark);
  const runs = benchmark.entries.reduce((total, entry) => total + entry.cases.total, 0);
  const rated = benchmark.entries.filter((entry) => entry.cases.total > 0);
  const mean =
    rated.length === 0 ? null : rated.reduce((total, entry) => total + entry.meanPassRate, 0) / rated.length;

  return {
    startedAt: benchmark.identity.startedAt,
    suites: benchmark.config.suites,
    models: new Set(benchmark.entries.map((entry) => entry.model)).size,
    runs,
    finished: runs,
    meanPassRate: mean,
    best: scores[0] ?? null,
    worst: scores.length > 1 ? (scores.at(-1) ?? null) : null,
    costUsd: costOf(benchmark),
  };
}

/** A run still going has no benchmark, so everything comes off the plan it is working through. */
function fromLive(doc: LiveDoc): Pick<
  IterationDigest,
  "suites" | "models" | "runs" | "finished" | "meanPassRate" | "best" | "worst" | "costUsd" | "startedAt"
> {
  const graded = doc.items.filter((item) => item.state === "graded" && item.passRate !== null);
  return {
    startedAt: doc.startedAt,
    suites: doc.config.suites,
    models: new Set(doc.items.map((item) => item.model)).size,
    runs: doc.items.length,
    finished: doc.items.filter((item) => TERMINAL_STATES.includes(item.state)).length,
    meanPassRate:
      graded.length === 0 ? null : graded.reduce((total, item) => total + (item.passRate ?? 0), 0) / graded.length,
    best: null,
    worst: null,
    // live.json carries no cost; showing zero would read as free.
    costUsd: null,
  };
}

const EMPTY = {
  startedAt: null,
  suites: [] as SuiteId[],
  models: 0,
  runs: 0,
  finished: 0,
  meanPassRate: null,
  best: null,
  worst: null,
  costUsd: null,
};

export function digestOf(reportsRoot: string, summary: IterationSummary, now: Date): IterationDigest {
  const live = summary.hasLive ? readLive(reportsRoot, summary.slug) : null;
  const doc = live?.ok === true ? live.value : null;
  const benchmark = summary.hasBenchmark ? readBenchmark(reportsRoot, summary.slug) : null;

  const body =
    benchmark?.ok === true ? fromBenchmark(benchmark.value) : doc !== null ? fromLive(doc) : EMPTY;

  return {
    slug: summary.slug,
    hasBenchmark: summary.hasBenchmark,
    status: statusOf(summary, doc, now),
    durationMs:
      doc === null || doc.status !== "done" ? null : Math.max(0, Date.parse(doc.updatedAt) - Date.parse(doc.startedAt)),
    ...body,
  };
}
