import { groupBy, mean, meanBy, sum, sumBy } from "es-toolkit";
import type { SkippedModel } from "../model/capabilities.js";
import type { SuiteId } from "../shared/vocabulary.js";
import type { CaseGrade } from "../suites/types.js";
import type { RunIdentity, RunRecord, TerminalState } from "./record.js";
import { SCHEMA_VERSION } from "./schema.js";
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
  /**
   * How a rerun merged into this report differs from what the rest of it was
   * measured against, or null while every run agrees. A merge across builds is
   * allowed — a rerun always lands in the report it came from — so this is what
   * stops the difference being silent.
   */
  buildDrift: string | null;
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

/** null the moment one value is unknown: a partial sum would understate the total silently. */
export function sumOrNull(values: (number | null)[]): number | null {
  const known: number[] = [];
  for (const value of values) {
    if (value === null) return null;
    known.push(value);
  }
  return sum(known);
}

function totalCost(graded: GradedRecord[]): number | null {
  return sumOrNull(graded.map((record) => record.costUsd));
}

/** meanBy on an empty array is NaN; every average in a BenchmarkEntry reads as 0 with nothing graded instead. */
function meanOrZero(graded: GradedRecord[], selector: (record: GradedRecord) => number): number {
  return graded.length === 0 ? 0 : meanBy(graded, selector);
}

function buildEntry(records: RunRecord[], trials: number): BenchmarkEntry {
  const { model, suite } = records[0]!;
  const graded = records.filter(isGraded);
  return {
    model,
    suite,
    trials,
    cases: caseTotals(records),
    meanPassRate: meanOrZero(graded, (record) => record.grade.passRate),
    stddevPassRate: sampleStddev(graded.map((record) => record.grade.passRate)),
    avgDurationMs: meanOrZero(graded, (record) => record.metrics.durationMs),
    avgTokens: {
      in: meanOrZero(graded, (record) => record.metrics.tokensIn),
      out: meanOrZero(graded, (record) => record.metrics.tokensOut),
    },
    avgToolCalls: meanOrZero(graded, (record) => record.metrics.toolCalls),
    totalCostUsd: totalCost(graded),
    terminal: tallyStates(records),
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
  buildDrift: string | null = null,
): Benchmark {
  // One group per (model, suite) pair the matrix actually ran.
  const groups = Object.values(groupBy(records, (record) => `${record.model} ${record.suite}`));
  const entries = groups.map((group) => buildEntry(group, config.trials)).toSorted(byRank(config.suites));
  return { schemaVersion: SCHEMA_VERSION, identity, config, entries, skippedModels, buildDrift };
}
