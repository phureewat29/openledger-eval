import { groupBy, mean, meanBy, sum, sumBy } from "es-toolkit";
import type { SuiteId } from "../config.js";
import type { SkippedModel } from "../model/capabilities.js";
import type { CaseGrade } from "../suites/types.js";
import type { RunIdentity, RunRecord, TerminalState } from "./record.js";
import { tallyStates } from "./write.js";

// Aggregates the matrix's raw RunRecords into one ranked entry per model and
// suite; everything downstream reads from this alone.

/** What was asked for, echoed onto the benchmark so a report explains itself without the invocation's argv. */
export interface ConfigEcho {
  suites: SuiteId[];
  trials: number;
  concurrency: number;
  modelsRequested: string[];
}

export interface BenchmarkEntry {
  model: string;
  suite: SuiteId;
  /** Planned per case, from config - not a count of runs that actually landed. */
  trials: number;
  /** Distinct case ids; a case counts as passed only once every graded trial of it did. */
  cases: { passed: number; total: number };
  /** Mean of grade.passRate over graded runs; 0 when none graded. */
  meanPassRate: number;
  /** Sample stddev over the same values; null under two graded runs. */
  stddevPassRate: number | null;
  avgDurationMs: number;
  avgTokens: { in: number; out: number };
  avgToolCalls: number;
  /** Sum over graded runs; null unless every graded run priced. */
  totalCostUsd: number | null;
  terminal: Record<TerminalState, number>;
}

export interface Benchmark {
  schemaVersion: 1;
  identity: RunIdentity;
  config: ConfigEcho;
  entries: BenchmarkEntry[];
  skippedModels: SkippedModel[];
}

interface RunGroup {
  model: string;
  suite: SuiteId;
  records: RunRecord[];
}

/** One group per (model, suite) pair the matrix actually ran. */
function groupRuns(records: RunRecord[]): RunGroup[] {
  const byKey = new Map<string, RunGroup>();
  for (const record of records) {
    const key = `${record.model} ${record.suite}`;
    const group = byKey.get(key);
    if (group) group.records.push(record);
    else byKey.set(key, { model: record.model, suite: record.suite, records: [record] });
  }
  return [...byKey.values()];
}

type GradedRecord = RunRecord & { grade: CaseGrade };

function isGraded(record: RunRecord): record is GradedRecord {
  return record.state === "graded" && record.grade !== null;
}

/** A case passes only if every graded trial of it did; zero graded trials passes nothing. */
function caseTotals(records: RunRecord[]): { passed: number; total: number } {
  const byCase = Object.values(groupBy(records, (record) => record.caseId));
  const passed = byCase.filter((trials) => {
    const graded = trials.filter(isGraded);
    return graded.length > 0 && graded.every((record) => record.grade.passed);
  });
  return { passed: passed.length, total: byCase.length };
}

/** Sample stddev (n-1): population variance would understate spread from this few trials. */
function sampleStddev(values: number[]): number | null {
  if (values.length < 2) return null;
  const avg = mean(values);
  return Math.sqrt(sumBy(values, (value) => (value - avg) ** 2) / (values.length - 1));
}

/** null once any graded run's cost is unknown: a partial sum would understate the total silently. */
function totalCost(graded: GradedRecord[]): number | null {
  const costs: number[] = [];
  for (const record of graded) {
    if (record.costUsd === null) return null;
    costs.push(record.costUsd);
  }
  return sum(costs);
}

/** meanBy on an empty array is NaN; every average in a BenchmarkEntry reads as 0 with nothing graded instead. */
function meanOrZero(graded: GradedRecord[], selector: (record: GradedRecord) => number): number {
  return graded.length === 0 ? 0 : meanBy(graded, selector);
}

function buildEntry(group: RunGroup, trials: number): BenchmarkEntry {
  const graded = group.records.filter(isGraded);
  return {
    model: group.model,
    suite: group.suite,
    trials,
    cases: caseTotals(group.records),
    meanPassRate: meanOrZero(graded, (record) => record.grade.passRate),
    stddevPassRate: sampleStddev(graded.map((record) => record.grade.passRate)),
    avgDurationMs: meanOrZero(graded, (record) => record.metrics.durationMs),
    avgTokens: {
      in: meanOrZero(graded, (record) => record.metrics.tokensIn),
      out: meanOrZero(graded, (record) => record.metrics.tokensOut),
    },
    avgToolCalls: meanOrZero(graded, (record) => record.metrics.toolCalls),
    totalCostUsd: totalCost(graded),
    terminal: tallyStates(group.records),
  };
}

function byRank(suiteOrder: SuiteId[]): (a: BenchmarkEntry, b: BenchmarkEntry) => number {
  return (a, b) =>
    suiteOrder.indexOf(a.suite) - suiteOrder.indexOf(b.suite) ||
    b.meanPassRate - a.meanPassRate ||
    a.avgTokens.in + a.avgTokens.out - (b.avgTokens.in + b.avgTokens.out) ||
    a.model.localeCompare(b.model);
}

export function buildBenchmark(
  records: RunRecord[],
  identity: RunIdentity,
  config: ConfigEcho,
  skippedModels: SkippedModel[],
): Benchmark {
  const entries = groupRuns(records)
    .map((group) => buildEntry(group, config.trials))
    .toSorted(byRank(config.suites));
  return { schemaVersion: 1, identity, config, entries, skippedModels };
}
